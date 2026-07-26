require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const icons = require('./icons');

const app = express();
const PORT = process.env.PORT || 80;

const SONIOX_API_KEY = process.env.SONIOX_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const APP_PASSWORD = process.env.APP_PASSWORD;

const SONIOX_BASE = 'https://api.soniox.com';
const SONIOX_MODEL = 'stt-async-v5';
// Cantonese has no ISO code in Soniox's supported list; 'zh' covers Chinese.
const LANGUAGE_HINTS = ['en', 'ms', 'zh'];

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(express.json({ limit: '10mb' }));

// ---------- PWA assets: served before the auth gate ----------
// Icons and the manifest must be fetchable without credentials, otherwise the
// install prompt and home-screen icon silently fail behind Basic auth. These
// contain no private data.
const ICON_ROUTES = {
  '/icon-192.png': icons.icon_192,
  '/icon-512.png': icons.icon_512,
  '/icon-maskable-512.png': icons.icon_maskable_512,
  '/apple-touch-icon.png': icons.apple_touch,
  '/apple-touch-icon-precomposed.png': icons.apple_touch,
  '/favicon.ico': icons.apple_touch,
};

app.get(Object.keys(ICON_ROUTES), (req, res) => {
  res.type('image/png');
  res.set('Cache-Control', 'public, max-age=604800');
  res.send(ICON_ROUTES[req.path]);
});

app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json');
  res.sendFile(path.join(__dirname, 'public', 'manifest.webmanifest'));
});

// Service worker script fetches don't reliably carry Basic-auth credentials, so
// serve it before the gate too. It contains no secrets.
app.get('/sw.js', (req, res) => {
  res.type('application/javascript');
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// ---------- Simple shared-password gate (skipped if APP_PASSWORD unset) ----------
app.use((req, res, next) => {
  if (!APP_PASSWORD) return next();
  const hdr = req.headers.authorization || '';
  if (hdr.startsWith('Basic ')) {
    const decoded = Buffer.from(hdr.slice(6), 'base64').toString('utf8');
    const pass = decoded.slice(decoded.indexOf(':') + 1);
    if (pass === APP_PASSWORD) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Meeting Notes"');
  return res.status(401).send('Authentication required');
});

const upload = multer({
  dest: UPLOAD_DIR,
  limits: { fileSize: 300 * 1024 * 1024 }, // 300MB ceiling per file
});

// ---------- Explicit page route (declared before express.static) ----------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- Soniox helpers ----------
async function sonioxFetch(endpoint, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(`${SONIOX_BASE}${endpoint}`, {
    method,
    headers: { Authorization: `Bearer ${SONIOX_API_KEY}`, ...headers },
    body,
  });
  if (!res.ok) {
    throw new Error(`Soniox ${method} ${endpoint} failed (${res.status}): ${await res.text()}`);
  }
  return method === 'DELETE' ? null : res.json();
}

async function sonioxUploadFile(filePath, filename) {
  const form = new FormData();
  form.append('file', new Blob([fs.readFileSync(filePath)]), filename);
  const res = await sonioxFetch('/v1/files', { method: 'POST', body: form });
  return res.id;
}

async function sonioxCreateTranscription(fileId) {
  const res = await sonioxFetch('/v1/transcriptions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: SONIOX_MODEL,
      file_id: fileId,
      language_hints: LANGUAGE_HINTS,
      enable_language_identification: true,
      enable_speaker_diarization: true,
    }),
  });
  return res.id;
}

async function sonioxWaitUntilComplete(transcriptionId, maxWaitMs = 30 * 60 * 1000) {
  const started = Date.now();
  while (Date.now() - started < maxWaitMs) {
    const data = await sonioxFetch(`/v1/transcriptions/${transcriptionId}`);
    if (data.status === 'completed') return;
    if (data.status === 'error') {
      throw new Error(`Soniox transcription error: ${data.error_message || 'unknown'}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('Soniox transcription timed out');
}

// The REST /transcript endpoint returns `tokens`, not a flat `text` field.
function renderTokens(tokens) {
  const parts = [];
  let currentSpeaker = null;
  let currentLanguage = null;

  for (const token of tokens || []) {
    let text = token.text;
    const { speaker, language } = token;

    if (speaker !== undefined && speaker !== null && speaker !== currentSpeaker) {
      if (currentSpeaker !== null) parts.push('\n\n');
      currentSpeaker = speaker;
      currentLanguage = null;
      parts.push(`Speaker ${currentSpeaker}:`);
    }
    if (language !== undefined && language !== null && language !== currentLanguage) {
      currentLanguage = language;
      parts.push(`\n[${currentLanguage}] `);
      text = (text || '').trimStart();
    }
    parts.push(text || '');
  }
  return parts.join('').trim();
}

async function sonioxGetTranscript(transcriptionId) {
  const data = await sonioxFetch(`/v1/transcriptions/${transcriptionId}/transcript`);
  // Prefer rendered tokens (keeps speaker + language labels); fall back to any flat text.
  const rendered = renderTokens(data.tokens);
  return rendered || data.text || '';
}

async function sonioxCleanup(transcriptionId, fileId) {
  // Best-effort: don't let cleanup failures mask a successful transcription.
  if (transcriptionId) {
    try { await sonioxFetch(`/v1/transcriptions/${transcriptionId}`, { method: 'DELETE' }); }
    catch (e) { console.error('Soniox transcription cleanup failed:', e.message); }
  }
  if (fileId) {
    try { await sonioxFetch(`/v1/files/${fileId}`, { method: 'DELETE' }); }
    catch (e) { console.error('Soniox file cleanup failed:', e.message); }
  }
}

// ---------- Claude: clean up transcript + attachments into markdown ----------
async function claudeStructureNotes(rawTranscript, attachments) {
  const today = new Date().toISOString().slice(0, 10);

  const content = [
    {
      type: 'text',
      text: `You are cleaning up a raw speech-to-text transcript from a Malaysian business meeting. The speech mixes English, Bahasa Melayu, Mandarin and Cantonese, sometimes within a single sentence. The transcript is machine-generated and will contain errors, especially on proper nouns, company names, and code-switched phrases. Speaker labels and [language] tags were added by the transcription engine and may themselves be wrong.

Your task:
1. Correct obvious transcription errors using context. Where a term is garbled and you cannot infer it confidently, mark it [UNCLEAR] rather than guessing.
2. Preserve the original language mix. Do not translate everything into English; keep phrases in the language they were said, adding a short English gloss in brackets only where it aids comprehension.
3. Output a markdown meeting record using exactly this template:

### ${today} — <Meeting type> (<attendees>)
- Context:
- What they need:
- Signals: budget / timeline / decision-maker
- Our angle: (products/services that fit)
- Agreed next step:
- Proposal due:

Rules for the template: use ${today} as the date unless the transcript clearly states another date. If meeting type, attendees, or any field is not evident from the material, write [NOT STATED] — never invent names, numbers, or commitments. If attached images or PDFs contain relevant context (whiteboard notes, a deck, a business card), fold that into the appropriate field.

Output only the markdown record, with no preamble.

Raw transcript:
${rawTranscript}`,
    },
  ];

  for (const att of attachments) {
    if (att.mimetype === 'application/pdf') {
      content.push({
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: att.base64 },
      });
    } else if (att.mimetype.startsWith('image/')) {
      content.push({
        type: 'image',
        source: { type: 'base64', media_type: att.mimetype, data: att.base64 },
      });
    }
  }

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-5',
    max_tokens: 2000,
    messages: [{ role: 'user', content }],
  });

  return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

// ---------- Route: process recording + attachments ----------
app.post(
  '/api/process',
  upload.fields([{ name: 'audio', maxCount: 1 }, { name: 'attachments', maxCount: 10 }]),
  async (req, res) => {
    const tempPaths = [];
    let sonioxFileId = null;
    let transcriptionId = null;

    try {
      if (!SONIOX_API_KEY) throw new Error('SONIOX_API_KEY is not configured on the server');
      if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured on the server');

      const audioFile = req.files && req.files.audio && req.files.audio[0];
      if (!audioFile) return res.status(400).json({ error: 'No audio file provided' });

      tempPaths.push(audioFile.path);
      const attachmentFiles = (req.files && req.files.attachments) || [];
      attachmentFiles.forEach((f) => tempPaths.push(f.path));

      sonioxFileId = await sonioxUploadFile(audioFile.path, audioFile.originalname || 'recording');
      transcriptionId = await sonioxCreateTranscription(sonioxFileId);
      await sonioxWaitUntilComplete(transcriptionId);
      const rawTranscript = await sonioxGetTranscript(transcriptionId);

      if (!rawTranscript.trim()) {
        throw new Error('Transcription returned no speech — check the recording actually has audio');
      }

      const attachments = attachmentFiles.map((f) => ({
        mimetype: f.mimetype,
        base64: fs.readFileSync(f.path).toString('base64'),
      }));

      const markdown = await claudeStructureNotes(rawTranscript, attachments);

      res.json({ rawTranscript, markdown });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    } finally {
      // Always clean up local temp files and remote Soniox artifacts.
      for (const p of tempPaths) {
        try { if (fs.existsSync(p)) fs.unlinkSync(p); }
        catch (e) { console.error('Temp file cleanup failed:', e.message); }
      }
      sonioxCleanup(transcriptionId, sonioxFileId);
    }
  }
);

// ---------- Route: send finalized markdown to Telegram ----------
// Sent as a document: sidesteps the 4096-char message cap and Markdown parse errors
// that '###' headers and stray '_' / '*' characters reliably trigger.
app.post('/api/send-telegram', async (req, res) => {
  try {
    const { markdown } = req.body;
    if (!markdown || !markdown.trim()) {
      return res.status(400).json({ error: 'No markdown provided' });
    }
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      return res.status(500).json({
        error: 'Telegram not configured yet — set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env',
      });
    }

    const filename = `meeting-notes-${new Date().toISOString().slice(0, 10)}.md`;
    const form = new FormData();
    form.append('chat_id', TELEGRAM_CHAT_ID);
    form.append('caption', 'New meeting record (reviewed)');
    form.append('document', new Blob([markdown], { type: 'text/markdown' }), filename);

    const tgRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`, {
      method: 'POST',
      body: form,
    });
    if (!tgRes.ok) {
      throw new Error(`Telegram send failed (${tgRes.status}): ${await tgRes.text()}`);
    }

    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Health check ----------
app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    soniox: !!SONIOX_API_KEY,
    anthropic: !!ANTHROPIC_API_KEY,
    telegram: !!(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID),
  });
});

// Multer / generic error handler (e.g. file too large)
app.use((err, req, res, next) => {
  console.error(err);
  const msg = err.code === 'LIMIT_FILE_SIZE' ? 'File too large (max 300MB)' : err.message;
  res.status(400).json({ error: msg });
});

// Static assets AFTER explicit routes
app.use(express.static(path.join(__dirname, 'public')));

const server = app.listen(PORT, () =>
  console.log(`Meeting notes app listening on port ${PORT}`)
);
// Transcribing a long meeting can exceed Node's 5-minute default request timeout.
server.requestTimeout = 45 * 60 * 1000;
server.headersTimeout = 46 * 60 * 1000;
