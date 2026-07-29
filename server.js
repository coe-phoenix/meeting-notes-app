require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');
const icons = require('./icons');
const jobs = require('./db');

const app = express();
const PORT = process.env.PORT || 80;

const SONIOX_API_KEY = process.env.SONIOX_API_KEY;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const APP_PASSWORD = process.env.APP_PASSWORD;
// Live-recording segment length (minutes). Configurable so it can be tuned per
// deployment without touching the client. Falls back to 5 if unset/invalid.
const SEGMENT_MINUTES = parseFloat(process.env.SEGMENT_MINUTES) > 0
  ? parseFloat(process.env.SEGMENT_MINUTES)
  : 5;

const SONIOX_BASE = 'https://api.soniox.com';
const SONIOX_MODEL = 'stt-async-v5';
// Cantonese has no ISO code in Soniox's supported list; 'zh' covers Chinese.
const LANGUAGE_HINTS = ['en', 'ms', 'zh'];

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Internal-only store for per-session raw transcripts. It lives OUTSIDE public/
// and every route that touches it sits behind the password gate, so segment
// transcripts are never publicly reachable.
const SESSIONS_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

// Resolve a session's storage dir, rejecting anything that isn't a plain id
// (guards against path traversal via a crafted sessionId).
function sessionDir(id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{8,64}$/i.test(id)) {
    throw new Error('Invalid session id');
  }
  return path.join(SESSIONS_DIR, id);
}

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

// ---------- Duration from Soniox tokens (Phase 3 will use full timestamps) ----------
function tokensDurationMinutes(tokens) {
  let maxEnd = 0;
  for (const t of tokens || []) {
    const end = t.end_ms != null ? t.end_ms
      : (t.start_ms != null && t.duration_ms != null ? t.start_ms + t.duration_ms : null);
    if (end != null && end > maxEnd) maxEnd = end;
  }
  return maxEnd > 0 ? +(maxEnd / 60000).toFixed(2) : null;
}

// Transcribe a whole audio file end-to-end, returning rendered text + duration.
// Soniox artifacts are always cleaned up, success or failure.
async function transcribeFile(filePath, originalName) {
  let fileId = null;
  let transcriptionId = null;
  try {
    fileId = await sonioxUploadFile(filePath, originalName || 'recording');
    transcriptionId = await sonioxCreateTranscription(fileId);
    await sonioxWaitUntilComplete(transcriptionId);
    const data = await sonioxFetch(`/v1/transcriptions/${transcriptionId}/transcript`);
    const text = renderTokens(data.tokens) || data.text || '';
    return { text, durationMinutes: tokensDurationMinutes(data.tokens) };
  } finally {
    sonioxCleanup(transcriptionId, fileId);
  }
}

// ---------- Job processing pipeline (Phase 2) ----------
// Idempotent: always re-runs from the stored audio file, so a retry (or a
// boot-time re-queue of a stranded job) is safe.
async function processJob(job) {
  if (!SONIOX_API_KEY) throw new Error('SONIOX_API_KEY is not configured on the server');
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured on the server');
  if (!job.audio_path || !fs.existsSync(job.audio_path)) {
    throw new Error('Audio file for this job is missing');
  }

  jobs.updateJob(job.id, { status: 'transcribing', error: null });
  const { text, durationMinutes } = await transcribeFile(job.audio_path, job.original_name);
  if (!text.trim()) {
    throw new Error('Transcription returned no speech — check the recording actually has audio');
  }
  jobs.updateJob(job.id, {
    status: 'summarising',
    raw_transcript: text,
    duration_minutes: durationMinutes,
  });

  const markdown = await claudeStructureNotes(text, []);
  jobs.updateJob(job.id, { status: 'ready', markdown });
}

// ---------- In-process serial worker ----------
// One job at a time keeps API usage predictable and avoids hammering Soniox.
// The queue is just "the oldest job in status=uploaded"; pumpQueue drains it.
let workerBusy = false;
function pumpQueue() {
  if (workerBusy) return;
  const job = jobs.nextQueuedJob();
  if (!job) return;
  workerBusy = true;
  processJob(job)
    .then(() => { console.log(`Job ${job.id} ready`); })
    .catch((err) => {
      console.error(`Job ${job.id} failed:`, err.message);
      jobs.updateJob(job.id, { status: 'failed', error: err.message });
    })
    .finally(() => {
      workerBusy = false;
      setImmediate(pumpQueue); // pick up the next queued job, if any
    });
}

// ---------- Resumable chunked upload (Phase 2) ----------
// A 90-min recording on hotel Wi-Fi dies as a single POST. Split it: the client
// PUTs fixed-size chunks (resumable/idempotent by index), then asks the server
// to assemble, verify total size, and enqueue a job.
const UPLOAD_TMP = path.join(UPLOAD_DIR, 'tmp');
if (!fs.existsSync(UPLOAD_TMP)) fs.mkdirSync(UPLOAD_TMP, { recursive: true });

function uploadTmpDir(id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{8,64}$/i.test(id)) throw new Error('Invalid upload id');
  return path.join(UPLOAD_TMP, id);
}

function extFromName(name, mime) {
  const fromName = name && path.extname(name);
  if (fromName) return fromName;
  if (mime && mime.includes('mp4')) return '.m4a';
  if (mime && mime.includes('ogg')) return '.ogg';
  if (mime && mime.includes('webm')) return '.webm';
  if (mime && mime.includes('wav')) return '.wav';
  if (mime && mime.includes('mpeg')) return '.mp3';
  return '.audio';
}

// Init an upload: returns an id the client uses for every chunk PUT.
app.post('/api/uploads', (req, res) => {
  try {
    const { filename, size, mime } = req.body || {};
    const id = crypto.randomUUID();
    const dir = uploadTmpDir(id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
      filename: filename || 'recording', size: size || null, mime: mime || null,
    }));
    res.json({ uploadId: id });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// Report which chunk indices the server already has (drives resume-after-failure).
app.get('/api/uploads/:id', (req, res) => {
  try {
    const dir = uploadTmpDir(req.params.id);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Unknown upload' });
    const received = fs.readdirSync(dir)
      .filter((f) => /^\d+\.part$/.test(f))
      .map((f) => parseInt(f, 10))
      .sort((a, b) => a - b);
    res.json({ uploadId: req.params.id, received });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Store one chunk. Raw body; idempotent — re-PUTting an index just overwrites it.
app.put('/api/uploads/:id/:index',
  express.raw({ type: '*/*', limit: 25 * 1024 * 1024 }),
  (req, res) => {
    try {
      const dir = uploadTmpDir(req.params.id);
      if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Unknown upload' });
      const index = parseInt(req.params.index, 10);
      if (!Number.isInteger(index) || index < 0) return res.status(400).json({ error: 'Bad chunk index' });
      if (!req.body || !req.body.length) return res.status(400).json({ error: 'Empty chunk' });
      fs.writeFileSync(path.join(dir, `${index}.part`), req.body);
      res.json({ ok: true, index });
    } catch (err) {
      console.error(err);
      res.status(400).json({ error: err.message });
    }
  }
);

// Assemble chunks in order, verify size, create + enqueue a job, drop the parts.
app.post('/api/uploads/:id/complete', (req, res) => {
  try {
    const dir = uploadTmpDir(req.params.id);
    if (!fs.existsSync(dir)) return res.status(404).json({ error: 'Unknown upload' });

    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    const { totalChunks } = req.body || {};
    const parts = fs.readdirSync(dir)
      .filter((f) => /^\d+\.part$/.test(f))
      .map((f) => parseInt(f, 10))
      .sort((a, b) => a - b);

    if (totalChunks != null && parts.length !== totalChunks) {
      return res.status(400).json({
        error: `Missing chunks: have ${parts.length} of ${totalChunks}`,
        received: parts,
      });
    }
    // Contiguity check: indices must be 0..n-1 with no gaps.
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] !== i) return res.status(400).json({ error: `Chunk gap at index ${i}`, received: parts });
    }

    const jobId = crypto.randomUUID();
    const finalPath = path.join(UPLOAD_DIR, `${jobId}${extFromName(meta.filename, meta.mime)}`);
    const out = fs.openSync(finalPath, 'w');
    try {
      for (const i of parts) {
        fs.writeSync(out, fs.readFileSync(path.join(dir, `${i}.part`)));
      }
    } finally {
      fs.closeSync(out);
    }

    const size = fs.statSync(finalPath).size;
    if (meta.size != null && size !== meta.size) {
      fs.unlinkSync(finalPath);
      return res.status(400).json({ error: `Size mismatch: assembled ${size}, expected ${meta.size}` });
    }

    fs.rmSync(dir, { recursive: true, force: true });

    const job = jobs.createJob({
      id: jobId,
      original_name: meta.filename,
      mime: meta.mime,
      size_bytes: size,
      source: 'upload',
      status: 'uploaded',
      audio_path: finalPath,
    });
    setImmediate(pumpQueue);
    res.json({ jobId: job.id, status: job.status });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// ---------- Jobs API (Phase 2) ----------
function publicJob(j, { full = false } = {}) {
  if (!j) return null;
  const base = {
    id: j.id,
    originalName: j.original_name,
    status: j.status,
    error: j.error,
    durationMinutes: j.duration_minutes,
    sizeBytes: j.size_bytes,
    source: j.source,
    createdAt: j.created_at,
    updatedAt: j.updated_at,
    hasAudio: !!(j.audio_path && fs.existsSync(j.audio_path)),
  };
  if (full) {
    base.rawTranscript = j.raw_transcript || '';
    base.markdown = j.markdown || '';
  }
  return base;
}

app.get('/api/jobs', (req, res) => {
  res.json({ jobs: jobs.listJobs().map((j) => publicJob(j)) });
});

app.get('/api/jobs/:id', (req, res) => {
  const j = jobs.getJob(req.params.id);
  if (!j) return res.status(404).json({ error: 'Job not found' });
  res.json({ job: publicJob(j, { full: true }) });
});

// Persist an edited summary (so downloads / Telegram use the reviewed version).
app.put('/api/jobs/:id/markdown', (req, res) => {
  const j = jobs.getJob(req.params.id);
  if (!j) return res.status(404).json({ error: 'Job not found' });
  const { markdown } = req.body || {};
  if (typeof markdown !== 'string') return res.status(400).json({ error: 'markdown must be a string' });
  jobs.updateJob(j.id, { markdown });
  res.json({ ok: true });
});

// Retry a failed job. Idempotent processing means we just re-queue it.
app.post('/api/jobs/:id/retry', (req, res) => {
  const j = jobs.getJob(req.params.id);
  if (!j) return res.status(404).json({ error: 'Job not found' });
  if (j.status !== 'failed') return res.status(400).json({ error: `Job is '${j.status}', not failed` });
  jobs.updateJob(j.id, { status: 'uploaded', error: null });
  setImmediate(pumpQueue);
  res.json({ ok: true });
});

function sendDownload(res, filename, mime, body) {
  res.set('Content-Type', mime);
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(body);
}

app.get('/api/jobs/:id/download/summary.md', (req, res) => {
  const j = jobs.getJob(req.params.id);
  if (!j || !j.markdown) return res.status(404).json({ error: 'Summary not ready' });
  const date = new Date(j.created_at).toISOString().slice(0, 10);
  sendDownload(res, `${date}-meeting-summary.md`, 'text/markdown', j.markdown);
});

app.get('/api/jobs/:id/download/transcript.txt', (req, res) => {
  const j = jobs.getJob(req.params.id);
  if (!j || !j.raw_transcript) return res.status(404).json({ error: 'Transcript not ready' });
  const date = new Date(j.created_at).toISOString().slice(0, 10);
  sendDownload(res, `${date}-transcript-raw.txt`, 'text/plain', j.raw_transcript);
});

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

// Client-readable runtime config (behind the auth gate). Lets the UI pick up the
// segment interval from .env without hardcoding it.
app.get('/api/config', (req, res) => {
  res.json({ segmentMinutes: SEGMENT_MINUTES, segmentMs: Math.round(SEGMENT_MINUTES * 60 * 1000) });
});

// ---------- Live-recording session routes (segment pipeline) ----------
// Long meetings are recorded in ~5-minute segments. Each segment is transcribed
// as it arrives and its raw text is stashed server-side; on stop we assemble the
// full transcript and hand it to Claude once.

// Start a session: mint an id and create its internal transcript directory.
app.post('/api/session/start', (req, res) => {
  try {
    const sessionId = crypto.randomUUID();
    fs.mkdirSync(sessionDir(sessionId), { recursive: true });
    res.json({ sessionId });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Resume a crashed session during client-side recovery. The client persists its
// audio chunks in IndexedDB along with the original sessionId; if the process
// restarted (or the transcript dir was otherwise lost) the dir may be gone, so
// recreate it. Any segment transcripts that DID survive on disk are preserved
// and stitched together with the re-transcribed leftovers on finalize.
app.post('/api/session/resume', (req, res) => {
  try {
    const { sessionId } = req.body || {};
    const dir = sessionDir(sessionId); // throws on a malformed id
    const existed = fs.existsSync(dir);
    if (!existed) fs.mkdirSync(dir, { recursive: true });
    res.json({ sessionId, existed });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// Transcribe a single segment and append its raw text to the session store.
app.post('/api/transcribe-chunk', upload.single('audio'), async (req, res) => {
  let sonioxFileId = null;
  let transcriptionId = null;
  let tempPath = null;

  try {
    if (!SONIOX_API_KEY) throw new Error('SONIOX_API_KEY is not configured on the server');

    const dir = sessionDir(req.body.sessionId);
    if (!fs.existsSync(dir)) throw new Error('Unknown or expired session');

    const segment = req.file;
    if (!segment) return res.status(400).json({ error: 'No audio segment provided' });
    tempPath = segment.path;

    sonioxFileId = await sonioxUploadFile(segment.path, segment.originalname || 'segment');
    transcriptionId = await sonioxCreateTranscription(sonioxFileId);
    await sonioxWaitUntilComplete(transcriptionId);
    const rawText = await sonioxGetTranscript(transcriptionId);

    // Index-named files keep segments in order regardless of which transcription
    // finishes first, and avoid concurrent-append races.
    const index = String(Math.max(0, parseInt(req.body.index, 10) || 0)).padStart(6, '0');
    fs.writeFileSync(path.join(dir, `${index}.txt`), rawText);

    res.json({ ok: true, text: rawText });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    if (tempPath) {
      try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); }
      catch (e) { console.error('Segment temp cleanup failed:', e.message); }
    }
    sonioxCleanup(transcriptionId, sonioxFileId);
  }
});

// Finalize: stitch the stored segments together and structure with Claude.
app.post('/api/finalize', upload.fields([{ name: 'attachments', maxCount: 10 }]), async (req, res) => {
  const tempPaths = [];
  let dir = null;

  try {
    if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured on the server');

    dir = sessionDir(req.body.sessionId);
    if (!fs.existsSync(dir)) throw new Error('Unknown or expired session');

    const rawTranscript = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.txt'))
      .sort()
      .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
      .join('\n\n')
      .trim();

    if (!rawTranscript) {
      throw new Error('No transcript captured for this session — check the recording had audio');
    }

    const attachmentFiles = (req.files && req.files.attachments) || [];
    attachmentFiles.forEach((f) => tempPaths.push(f.path));
    const attachments = attachmentFiles.map((f) => ({
      mimetype: f.mimetype,
      base64: fs.readFileSync(f.path).toString('base64'),
    }));

    const markdown = await claudeStructureNotes(rawTranscript, attachments);

    // Record the finished live session as a job so it appears in history and is
    // downloadable later — the review flow below is unchanged.
    let jobId = null;
    try {
      const job = jobs.createJob({
        original_name: `live-${new Date().toISOString().slice(0, 16).replace(':', '')}`,
        source: 'live',
        status: 'ready',
        raw_transcript: rawTranscript,
        markdown,
      });
      jobId = job.id;
    } catch (e) {
      console.error('Could not record live job:', e.message);
    }

    res.json({ rawTranscript, markdown, jobId });

    // Purge the internal transcript store only after a successful structure,
    // so a Claude failure leaves the transcript intact for a retry.
    try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); }
    catch (e) { console.error('Session cleanup failed:', e.message); }
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  } finally {
    for (const p of tempPaths) {
      try { if (fs.existsSync(p)) fs.unlinkSync(p); }
      catch (e) { console.error('Attachment temp cleanup failed:', e.message); }
    }
  }
});

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

const server = app.listen(PORT, () => {
  console.log(`Meeting notes app listening on port ${PORT}`);
  // Survive restarts: re-queue any job stranded mid-run by a crash/pm2 restart,
  // then start draining the queue.
  const requeued = jobs.resetStuckJobs();
  if (requeued) console.log(`Re-queued ${requeued} interrupted job(s) after restart`);
  setImmediate(pumpQueue);
});
// Transcribing a long meeting can exceed Node's 5-minute default request timeout.
server.requestTimeout = 45 * 60 * 1000;
server.headersTimeout = 46 * 60 * 1000;
