require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const os = require('os');
const Anthropic = require('@anthropic-ai/sdk');
const archiver = require('archiver');
const icons = require('./icons');
const jobs = require('./db');
const prompts = require('./prompts');
const auth = require('./auth');
const gemini = require('./gemini');
const cs = require('./cryptostore');
const ratelimit = require('./ratelimit');
const pipeline = require('./pipeline');
const github = require('./github');
const mcpoauth = require('./mcpoauth');
const mcpclient = require('./mcpclient');
const sshdeploy = require('./sshdeploy');

const execFileP = promisify(execFile);

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
// Auto-delete jobs (and their audio) this many days after creation. Surfaced in
// the UI so the retention window is a visible trust feature, not a surprise.
const RETENTION_DAYS = parseFloat(process.env.RETENTION_DAYS) > 0
  ? parseFloat(process.env.RETENTION_DAYS)
  : 30;
// Per-user transcribed-minutes cap per calendar month. 0 (default) = unlimited;
// enforced only when > 0 (and only meaningful with AUTH=magic). Soniox + Claude
// both bill per-minute, so this is the cost guardrail.
const QUOTA_MINUTES = parseFloat(process.env.QUOTA_MINUTES) > 0
  ? parseFloat(process.env.QUOTA_MINUTES)
  : 0;
// Phase 5.5 — public-launch guardrails.
// Shorter retention ceiling for a public/multi-tenant deployment (auth on). The
// effective retention is min(RETENTION_DAYS, PUBLIC_RETENTION_DAYS) when auth is on.
const PUBLIC_RETENTION_DAYS = parseFloat(process.env.PUBLIC_RETENTION_DAYS) > 0
  ? parseFloat(process.env.PUBLIC_RETENTION_DAYS)
  : 14;
// Uploads allowed per user (or IP) per hour — throttles scripted abuse before it
// costs anything. 0 = disabled.
const UPLOAD_RATE_PER_HOUR = parseFloat(process.env.UPLOAD_RATE_PER_HOUR) >= 0
  ? parseFloat(process.env.UPLOAD_RATE_PER_HOUR)
  : 60;

const SONIOX_BASE = 'https://api.soniox.com';
const SONIOX_MODEL = 'stt-async-v5';
// Cantonese has no ISO code in Soniox's supported list; 'zh' covers Chinese.
const LANGUAGE_HINTS = ['en', 'ms', 'zh'];

// Second transcription provider. Model name is configurable so it can track
// Gemini's current audio-capable models without a code change.
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// Admin AI-pipeline (generate a POC from meeting minutes → GitHub PR).
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER || ''; // optional org/user; else the token's user
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/$/, ''); // used for the MCP OAuth redirect

// The UI masks providers as "Model 1" / "Model 2". Keep the mapping server-side.
const MODEL_TO_PROVIDER = { model1: 'soniox', model2: 'gemini' };
const PROVIDER_TO_MODEL = { soniox: 'model1', gemini: 'model2' };
function providerAvailable(p) {
  return p === 'soniox' ? !!SONIOX_API_KEY : p === 'gemini' ? !!GEMINI_API_KEY : false;
}
// Accepts a masked model id ('model1'/'model2'), a raw provider, or nothing.
function resolveProvider(model) {
  if (MODEL_TO_PROVIDER[model]) return MODEL_TO_PROVIDER[model];
  if (model === 'soniox' || model === 'gemini') return model;
  return 'soniox';
}

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

// ---------- Access control ----------
// Two mutually-exclusive modes:
//  • AUTH=magic  → per-user passwordless auth (auth.js): cookie sessions, each
//    job tied to a user_id. Replaces the shared password entirely.
//  • otherwise   → the legacy shared-password Basic-auth gate (single 'local'
//    user), skipped when APP_PASSWORD is unset.
if (auth.enabled) {
  auth.attach(app, jobs);
} else {
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
}

// The owning user for the current request. With auth off, everything belongs to
// a single implicit 'local' user (preserves pre-Phase-5 single-user behaviour).
function currentUserId(req) {
  return auth.enabled && req.user ? req.user.id : 'local';
}

// Start-of-current-calendar-month timestamp (for monthly quota windows).
function monthStartMs() {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}

// Current month's used minutes and the cap. minutesLimit 0 => unlimited.
function quotaFor(userId) {
  const used = jobs.usageMinutesSince(userId, monthStartMs());
  return { minutesUsed: +used.toFixed(2), minutesLimit: QUOTA_MINUTES };
}
function quotaExceeded(userId) {
  return QUOTA_MINUTES > 0 && jobs.usageMinutesSince(userId, monthStartMs()) >= QUOTA_MINUTES;
}
function quotaMessage(userId) {
  const { minutesUsed, minutesLimit } = quotaFor(userId);
  return `Monthly limit reached — you've used ${Math.floor(minutesUsed)} of ${minutesLimit} transcribed minutes this month. It resets on the 1st.`;
}
// Guard a job-creating route; returns true and sends 429 if the caller is capped.
function blockedByQuota(req, res) {
  const uid = currentUserId(req);
  if (quotaExceeded(uid)) { res.status(429).json({ error: quotaMessage(uid) }); return true; }
  return false;
}

// Rate-limit the upload endpoints per user (IP fallback), independent of the
// minutes quota. Keyed so a burst of tiny uploads is throttled before any cost.
function rateLimitUploads(req, res, next) {
  const key = auth.enabled && req.user ? `u:${req.user.id}` : `ip:${req.ip}`;
  const r = ratelimit.check(`upload:${key}`, UPLOAD_RATE_PER_HOUR, 60 * 60 * 1000);
  if (!r.ok) {
    res.set('Retry-After', String(r.retryAfterSec));
    return res.status(429).json({ error: `Too many uploads — try again in ${Math.ceil(r.retryAfterSec / 60)} min.` });
  }
  next();
}

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

// Format a millisecond offset as mm:ss (or h:mm:ss past an hour).
function fmtTimestamp(ms) {
  if (ms == null || !isFinite(ms)) return '00:00';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(h > 0 ? m : m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// The REST /transcript endpoint returns `tokens`, not a flat `text` field.
// Each speaker turn is prefixed with a [mm:ss] timestamp so the transcript is
// self-verifying and the summary can cite back into the audio (Phase 3).
function renderTokens(tokens) {
  const parts = [];
  let currentSpeaker = null;
  let currentLanguage = null;

  for (const token of tokens || []) {
    let text = token.text;
    const { speaker, language } = token;
    const startMs = token.start_ms != null ? token.start_ms : null;

    if (speaker !== undefined && speaker !== null && speaker !== currentSpeaker) {
      if (currentSpeaker !== null) parts.push('\n\n');
      currentSpeaker = speaker;
      currentLanguage = null;
      const ts = startMs != null ? ` [${fmtTimestamp(startMs)}]` : '';
      parts.push(`Speaker ${currentSpeaker}${ts}:`);
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

// The Claude passes (clean → structure → faithfulness audit) and their prompts
// live in ./prompts.js so the eval harness shares exactly the same logic.

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

// Audio duration via ffprobe — the provider-agnostic fallback for quota/usage
// (Soniox derives it from tokens; Gemini doesn't report it).
async function ffprobeDurationMinutes(filePath) {
  try {
    const { stdout } = await execFileP('ffprobe', [
      '-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nokey=1:noprint_wrappers=1', filePath,
    ]);
    const secs = parseFloat(String(stdout).trim());
    return isFinite(secs) && secs > 0 ? +(secs / 60).toFixed(2) : null;
  } catch (e) {
    console.error('ffprobe duration failed:', e.message);
    return null;
  }
}

// Transcribe a whole audio file end-to-end, returning rendered text + duration.
// `provider` selects the engine ('soniox' default, or 'gemini'). Both return the
// same rendered shape so the rest of the pipeline doesn't care which ran.
async function transcribeFile(filePath, originalName, provider = 'soniox') {
  if (provider === 'gemini') {
    // Gemini's supported audio formats don't reliably include webm/m4a, so
    // transcode to mp3 first (ffmpeg is already a hard dependency).
    const tmpMp3 = path.join(UPLOAD_DIR, `gem-${crypto.randomUUID()}.mp3`);
    try {
      await ffmpegToMp3(filePath, tmpMp3);
      const text = await gemini.transcribeAudio(tmpMp3, 'audio/mp3', { apiKey: GEMINI_API_KEY, model: GEMINI_MODEL });
      return { text, durationMinutes: await ffprobeDurationMinutes(filePath) };
    } finally {
      try { if (fs.existsSync(tmpMp3)) fs.unlinkSync(tmpMp3); } catch { /* ignore */ }
    }
  }

  // Default: Soniox. Artifacts are always cleaned up, success or failure.
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

// ---------- ffmpeg helpers (Phase 3) ----------
// Concatenate same-codec segment files into one. Segments come from a single
// MediaRecorder session so they share codec/container; the concat demuxer with
// stream copy is lossless and fast. Falls back to a re-encode if copy fails
// (e.g. a truncated final segment left behind by a crash).
async function ffmpegConcat(segmentPaths, outPath) {
  const listFile = path.join(os.tmpdir(), `concat-${crypto.randomUUID()}.txt`);
  const list = segmentPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  fs.writeFileSync(listFile, list);
  const ext = path.extname(outPath).toLowerCase();
  const reencodeCodec = ext === '.m4a' || ext === '.mp4' ? 'aac' : 'libopus';
  try {
    try {
      await execFileP('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outPath]);
    } catch (e) {
      console.warn('ffmpeg concat copy failed, re-encoding:', e.message);
      await execFileP('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:a', reencodeCodec, outPath]);
    }
  } finally {
    try { fs.unlinkSync(listFile); } catch { /* ignore */ }
  }
  return outPath;
}

// Transcode any audio file to a compatibility mp3 (the convenience download).
async function ffmpegToMp3(inPath, outPath) {
  await execFileP('ffmpeg', ['-y', '-i', inPath, '-vn', '-acodec', 'libmp3lame', '-q:a', '4', outPath]);
  return outPath;
}

// ---------- Per-job attachment store (images/PDFs folded into the summary) ----------
// Queued jobs process asynchronously, so attachments captured at finalize time
// are stashed on disk beside the job and read back when the worker runs.
function jobAttachmentsDir(jobId) {
  if (typeof jobId !== 'string' || !/^[a-f0-9-]{8,64}$/i.test(jobId)) throw new Error('Invalid job id');
  return path.join(UPLOAD_DIR, `${jobId}-attachments`);
}

function readJobAttachments(job) {
  const jobId = typeof job === 'string' ? job : job.id;
  const encrypted = typeof job === 'object' && job.encrypted;
  let dir;
  try { dir = jobAttachmentsDir(jobId); } catch { return []; }
  if (!fs.existsSync(dir)) return [];
  let meta;
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); }
  catch { return []; }
  const dek = encrypted ? dekFor(job.user_id) : null;
  return meta.map((m) => {
    let buf = fs.readFileSync(path.join(dir, m.file));
    if (encrypted) buf = cs.decrypt(dek, buf);
    return { mimetype: m.mimetype, base64: buf.toString('base64') };
  });
}

// ---------- Encryption at rest (Phase 5.5) ----------
// Per-user data key (unwrapped Buffer), or null when encryption is disabled.
// Lazily creates + persists a wrapped key the first time a user needs one.
function dekFor(userId) {
  if (!cs.enabled) return null;
  const uid = userId || 'local';
  let row = jobs.getDataKey(uid);
  if (!row) row = jobs.saveDataKey(uid, cs.wrapKey(cs.newDataKey()));
  return cs.unwrapKey(row.wrapped);
}
// Decrypt a job's stored text column (raw/cleaned/markdown/faithfulness). Plain
// (legacy / flag-off) jobs pass through untouched.
function decJobText(job, val) {
  if (!job.encrypted || val == null) return val;
  return cs.decryptText(dekFor(job.user_id), val);
}

// ---------- Job processing pipeline (Phase 2 + Phase 3 layers) ----------
// Idempotent: always re-runs from the stored audio file, so a retry (or a
// boot-time re-queue of a stranded job) is safe. Produces the three layers in
// order — raw (from Soniox), cleaned (Claude pass 1), summary (Claude pass 2) —
// and never overwrites the raw layer.
async function processJob(job) {
  const provider = job.stt_provider || 'soniox';
  if (provider === 'soniox' && !SONIOX_API_KEY) throw new Error('SONIOX_API_KEY is not configured on the server');
  if (provider === 'gemini' && !GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not configured on the server');
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not configured on the server');
  if (!job.audio_path || !fs.existsSync(job.audio_path)) {
    throw new Error('Audio file for this job is missing');
  }

  // Encryption at rest: the STT engines + ffprobe need plaintext, so decrypt the
  // stored audio to a short-lived temp file for the duration of transcription.
  const dek = job.encrypted ? dekFor(job.user_id) : null;
  if (job.encrypted && !dek) throw new Error('Job is encrypted but the server master key is unavailable');
  const encText = (s) => (job.encrypted ? cs.encryptText(dek, s) : s);

  jobs.updateJob(job.id, { status: 'transcribing', error: null });
  let audioForStt = job.audio_path;
  let tmpPlain = null;
  if (job.encrypted) { tmpPlain = cs.decryptToTemp(dek, job.audio_path, path.extname(job.audio_path)); audioForStt = tmpPlain; }
  let text, durationMinutes;
  try {
    const result = await transcribeFile(audioForStt, job.original_name, provider);
    text = result.text;
    // Fall back to ffprobe when the provider didn't report a duration (quota/usage).
    durationMinutes = result.durationMinutes;
    if (durationMinutes == null) durationMinutes = await ffprobeDurationMinutes(audioForStt);
  } finally {
    if (tmpPlain) { try { fs.unlinkSync(tmpPlain); } catch { /* ignore */ } }
  }
  if (!text.trim()) {
    throw new Error('Transcription returned no speech — check the recording actually has audio');
  }
  // Raw layer: stored once and never overwritten from here on.
  jobs.updateJob(job.id, {
    status: 'summarising',
    raw_transcript: encText(text),
    duration_minutes: durationMinutes,
  });

  // Quota ledger: record the transcribed minutes once per job (guard against a
  // retry / boot re-queue double-counting). Kept separate from the job so it
  // survives retention deletion.
  if (durationMinutes && !jobs.hasUsageForJob(job.id)) {
    jobs.addUsage({ user_id: job.user_id, job_id: job.id, minutes: durationMinutes });
  }

  // Cleaned layer: STT-error-corrected but nothing removed. If cleaning fails we
  // fall back to summarising the raw layer rather than failing the whole job.
  let cleaned = '';
  try {
    cleaned = await prompts.cleanTranscript(anthropic, text);
    if (cleaned) jobs.updateJob(job.id, { cleaned_transcript: encText(cleaned) });
  } catch (e) {
    console.error(`Job ${job.id} transcript-clean pass failed, using raw:`, e.message);
  }

  // Summary layer: built from the cleaned transcript (or raw if cleaning failed).
  const summaryBasis = cleaned || text;
  const attachments = readJobAttachments(job);
  const markdown = await prompts.structureNotes(anthropic, summaryBasis, attachments);

  // Faithfulness audit (Phase 4): a second model pass checks the summary makes no
  // claim the transcript doesn't support. Non-fatal — a job is still 'ready' even
  // if the audit itself errors; the stored result just records that.
  let faithfulness = null;
  try {
    faithfulness = await prompts.faithfulnessCheck(anthropic, summaryBasis, markdown);
  } catch (e) {
    console.error(`Job ${job.id} faithfulness audit failed:`, e.message);
    faithfulness = { version: prompts.FAITHFULNESS_PROMPT_VERSION, error: e.message };
  }
  jobs.updateJob(job.id, { status: 'ready', markdown: encText(markdown), faithfulness: encText(JSON.stringify(faithfulness)) });
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
app.post('/api/uploads', rateLimitUploads, (req, res) => {
  try {
    if (blockedByQuota(req, res)) return;
    const { filename, size, mime, model, consent } = req.body || {};
    const id = crypto.randomUUID();
    const dir = uploadTmpDir(id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
      filename: filename || 'recording', size: size || null, mime: mime || null,
      provider: resolveProvider(model),
      consentAt: consent === true || consent === '1' ? Date.now() : null,
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

    const size = fs.statSync(finalPath).size; // plaintext size (verify before encrypting)
    if (meta.size != null && size !== meta.size) {
      fs.unlinkSync(finalPath);
      return res.status(400).json({ error: `Size mismatch: assembled ${size}, expected ${meta.size}` });
    }

    fs.rmSync(dir, { recursive: true, force: true });

    // Encrypt the assembled audio at rest (if enabled), after the size check.
    const uid = currentUserId(req);
    if (cs.enabled) cs.encryptFileInPlace(dekFor(uid), finalPath);

    const job = jobs.createJob({
      id: jobId,
      user_id: uid,
      original_name: meta.filename,
      mime: meta.mime,
      size_bytes: size,
      source: 'upload',
      status: 'uploaded',
      audio_path: finalPath,
      stt_provider: resolveProvider(meta.provider),
      encrypted: cs.enabled ? 1 : 0,
      upload_consent_at: meta.consentAt || null,
    });
    setImmediate(pumpQueue);
    res.json({ jobId: job.id, status: job.status });
  } catch (err) {
    console.error(err);
    res.status(400).json({ error: err.message });
  }
});

// ---------- Jobs API (Phase 2 + Phase 3) ----------
// Effective retention: a public deployment (auth on) is capped at the shorter
// PUBLIC_RETENTION_DAYS; a single-user internal box uses RETENTION_DAYS.
const RETENTION_DAYS_EFFECTIVE = auth.enabled ? Math.min(RETENTION_DAYS, PUBLIC_RETENTION_DAYS) : RETENTION_DAYS;
const RETENTION_MS = RETENTION_DAYS_EFFECTIVE * 24 * 60 * 60 * 1000;

function parseJsonOrNull(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

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
    hasCleaned: !!j.cleaned_transcript,
    // Masked transcription model used ('model1'/'model2').
    model: PROVIDER_TO_MODEL[j.stt_provider] || 'model1',
    // When this job (and its files) will be auto-deleted by the retention sweep.
    expiresAt: j.created_at + RETENTION_MS,
  };
  if (full) {
    base.rawTranscript = decJobText(j, j.raw_transcript) || '';
    base.cleanedTranscript = decJobText(j, j.cleaned_transcript) || '';
    base.markdown = decJobText(j, j.markdown) || '';
    base.faithfulness = parseJsonOrNull(decJobText(j, j.faithfulness));
  }
  return base;
}

// Fetch a job only if it belongs to the caller; otherwise 404 (don't reveal that
// another user's job exists). Enforces per-user isolation on every job route.
function ownedJob(req, res, id) {
  const j = jobs.getJob(id);
  if (!j || j.user_id !== currentUserId(req)) { res.status(404).json({ error: 'Job not found' }); return null; }
  return j;
}

app.get('/api/jobs', (req, res) => {
  res.json({ jobs: jobs.listJobs(currentUserId(req)).map((j) => publicJob(j)) });
});

app.get('/api/jobs/:id', (req, res) => {
  const j = ownedJob(req, res, req.params.id);
  if (!j) return;
  res.json({ job: publicJob(j, { full: true }) });
});

// Persist an edited summary (so downloads / Telegram use the reviewed version).
app.put('/api/jobs/:id/markdown', (req, res) => {
  const j = ownedJob(req, res, req.params.id);
  if (!j) return;
  const { markdown } = req.body || {};
  if (typeof markdown !== 'string') return res.status(400).json({ error: 'markdown must be a string' });
  jobs.updateJob(j.id, { markdown });
  res.json({ ok: true });
});

// Retry a failed job. Idempotent processing means we just re-queue it.
app.post('/api/jobs/:id/retry', (req, res) => {
  const j = ownedJob(req, res, req.params.id);
  if (!j) return;
  if (j.status !== 'failed') return res.status(400).json({ error: `Job is '${j.status}', not failed` });
  jobs.updateJob(j.id, { status: 'uploaded', error: null });
  setImmediate(pumpQueue);
  res.json({ ok: true });
});

// Remove a job and everything it owns on disk (audio, cached mp3, attachments).
function deleteJobFiles(j) {
  const targets = [];
  if (j.audio_path) targets.push(j.audio_path);
  targets.push(mp3PathFor(j)); // cached convenience copy, if any
  for (const p of targets) {
    try { if (p && fs.existsSync(p)) fs.unlinkSync(p); }
    catch (e) { console.error('File delete failed:', e.message); }
  }
  try {
    const adir = jobAttachmentsDir(j.id);
    if (fs.existsSync(adir)) fs.rmSync(adir, { recursive: true, force: true });
  } catch (e) { console.error('Attachment delete failed:', e.message); }
}

// Manual "delete now" — the per-job counterpart to the retention sweep.
app.delete('/api/jobs/:id', (req, res) => {
  const j = ownedJob(req, res, req.params.id);
  if (!j) return;
  deleteJobFiles(j);
  jobs.deleteJob(j.id);
  res.json({ ok: true });
});

function sendDownload(res, filename, mime, body) {
  res.set('Content-Type', mime);
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(body);
}

function jobDate(j) { return new Date(j.created_at).toISOString().slice(0, 10); }

function mp3PathFor(j) { return path.join(UPLOAD_DIR, `${j.id}.mp3`); }

// Return a PLAINTEXT copy of a job's stored audio for serving/transcoding.
// Encrypted jobs get a short-lived temp; callers MUST call cleanup() when done.
function plaintextAudio(j) {
  if (!j.audio_path || !fs.existsSync(j.audio_path)) throw new Error('Audio not available');
  if (!j.encrypted) return { path: j.audio_path, cleanup() {} };
  const tmp = cs.decryptToTemp(dekFor(j.user_id), j.audio_path, path.extname(j.audio_path));
  return { path: tmp, cleanup() { try { fs.unlinkSync(tmp); } catch { /* ignore */ } } };
}

// Return a PLAINTEXT mp3 to serve; caches the (possibly-encrypted) mp3 beside the
// job so the transcode happens once. Returns { path, cleanup }.
async function plaintextMp3(j) {
  if (!j.audio_path || !fs.existsSync(j.audio_path)) throw new Error('Audio not available');
  const isMp3 = path.extname(j.audio_path).toLowerCase() === '.mp3';
  if (isMp3) return plaintextAudio(j); // original already mp3 (decrypts if needed)

  const cache = mp3PathFor(j);
  if (!fs.existsSync(cache)) {
    const src = plaintextAudio(j);
    try {
      await ffmpegToMp3(src.path, cache);
      if (j.encrypted) cs.encryptFileInPlace(dekFor(j.user_id), cache);
    } finally { src.cleanup(); }
  }
  if (!j.encrypted) return { path: cache, cleanup() {} };
  const tmp = cs.decryptToTemp(dekFor(j.user_id), cache, '.mp3');
  return { path: tmp, cleanup() { try { fs.unlinkSync(tmp); } catch { /* ignore */ } } };
}

app.get('/api/jobs/:id/download/summary.md', (req, res) => {
  const j = ownedJob(req, res, req.params.id);
  if (!j) return;
  if (!j.markdown) return res.status(404).json({ error: 'Summary not ready' });
  sendDownload(res, `${jobDate(j)}-meeting-summary.md`, 'text/markdown', decJobText(j, j.markdown));
});

// Raw layer: exactly what the engine heard (speaker + language + [mm:ss] tags).
app.get('/api/jobs/:id/download/transcript.txt', (req, res) => {
  const j = ownedJob(req, res, req.params.id);
  if (!j) return;
  if (!j.raw_transcript) return res.status(404).json({ error: 'Transcript not ready' });
  sendDownload(res, `${jobDate(j)}-transcript-raw.txt`, 'text/plain', decJobText(j, j.raw_transcript));
});

// Cleaned layer: STT errors fixed, nothing removed, [UNCLEAR] markers preserved.
app.get('/api/jobs/:id/download/transcript-cleaned.txt', (req, res) => {
  const j = ownedJob(req, res, req.params.id);
  if (!j) return;
  if (!j.cleaned_transcript) return res.status(404).json({ error: 'Cleaned transcript not available' });
  sendDownload(res, `${jobDate(j)}-transcript-cleaned.txt`, 'text/plain', decJobText(j, j.cleaned_transcript));
});

// Bit-exact original audio (true raw). For uploads this is the file as sent; for
// live recordings it's the losslessly-concatenated recording.
app.get('/api/jobs/:id/download/audio', (req, res) => {
  const j = ownedJob(req, res, req.params.id);
  if (!j) return;
  try {
    const a = plaintextAudio(j);
    res.download(a.path, `${jobDate(j)}-meeting-audio${path.extname(j.audio_path)}`, () => a.cleanup());
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

// mp3 convenience copy (transcoded once, then cached beside the job).
app.get('/api/jobs/:id/download/audio.mp3', async (req, res) => {
  const j = ownedJob(req, res, req.params.id);
  if (!j) return;
  try {
    const m = await plaintextMp3(j);
    res.download(m.path, `${jobDate(j)}-meeting-audio.mp3`, () => m.cleanup());
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Could not produce mp3: ' + e.message });
  }
});

// "Download all" — one zip with summary + both transcripts + the original audio.
app.get('/api/jobs/:id/download/all.zip', (req, res) => {
  const j = ownedJob(req, res, req.params.id);
  if (!j) return;
  const date = jobDate(j);
  res.set('Content-Type', 'application/zip');
  res.set('Content-Disposition', `attachment; filename="${date}-meeting-bundle.zip"`);

  const temps = [];
  const cleanupAll = () => temps.forEach((t) => t.cleanup());
  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    console.error('Zip error:', err.message);
    cleanupAll();
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.destroy();
  });
  archive.on('end', cleanupAll);
  res.on('close', cleanupAll);
  archive.pipe(res);

  if (j.markdown) archive.append(decJobText(j, j.markdown), { name: `${date}-meeting-summary.md` });
  if (j.raw_transcript) archive.append(decJobText(j, j.raw_transcript), { name: `${date}-transcript-raw.txt` });
  if (j.cleaned_transcript) archive.append(decJobText(j, j.cleaned_transcript), { name: `${date}-transcript-cleaned.txt` });
  if (j.audio_path && fs.existsSync(j.audio_path)) {
    const a = plaintextAudio(j);
    temps.push(a);
    archive.file(a.path, { name: `${date}-meeting-audio${path.extname(j.audio_path)}` });
  }
  archive.finalize();
});

// Build the meeting bundle (summary + both transcripts + mp3) to a temp .zip file
// and return its path. The bit-exact original audio is left OUT — it can be huge
// and Telegram bots cap documents at 50MB; the mp3 keeps the bundle sendable.
async function buildBundleZip(j) {
  const date = jobDate(j);
  const tmpZip = path.join(UPLOAD_DIR, `bundle-${crypto.randomUUID()}.zip`);
  const output = fs.createWriteStream(tmpZip);
  const archive = archiver('zip', { zlib: { level: 9 } });
  const temps = [];
  const done = new Promise((resolve, reject) => {
    output.on('close', resolve);
    archive.on('error', reject);
  });
  archive.pipe(output);
  if (j.markdown) archive.append(decJobText(j, j.markdown), { name: `${date}-meeting-summary.md` });
  if (j.raw_transcript) archive.append(decJobText(j, j.raw_transcript), { name: `${date}-transcript-raw.txt` });
  if (j.cleaned_transcript) archive.append(decJobText(j, j.cleaned_transcript), { name: `${date}-transcript-cleaned.txt` });
  if (j.audio_path && fs.existsSync(j.audio_path)) {
    try { const m = await plaintextMp3(j); temps.push(m); archive.file(m.path, { name: `${date}-meeting-audio.mp3` }); }
    catch (e) { console.error('bundle mp3 failed, sending without audio:', e.message); }
  }
  archive.finalize();
  await done;
  temps.forEach((t) => t.cleanup());
  return tmpZip;
}

// Send a job's bundle to Telegram, to the user's remembered chat id (or the env
// default). The bot token is server-global; only the destination is per-user.
app.post('/api/jobs/:id/telegram', async (req, res) => {
  const j = ownedJob(req, res, req.params.id);
  if (!j) return;
  if (!TELEGRAM_BOT_TOKEN) return res.status(500).json({ error: 'Telegram is not configured on the server (TELEGRAM_BOT_TOKEN missing).' });
  const chatId = (auth.enabled && req.user && req.user.telegram_chat_id) || TELEGRAM_CHAT_ID;
  if (!chatId) return res.status(400).json({ error: 'No Telegram chat ID set — add one in the field above first.' });

  let zipPath = null;
  try {
    zipPath = await buildBundleZip(j);
    const buf = fs.readFileSync(zipPath);
    if (buf.length > 50 * 1024 * 1024) {
      throw new Error('Bundle is over Telegram’s 50MB limit — download it instead, or the meeting is too long to send this way.');
    }
    const form = new FormData();
    form.append('chat_id', String(chatId));
    form.append('caption', `Meeting bundle — ${jobDate(j)}`);
    form.append('document', new Blob([buf], { type: 'application/zip' }), `${jobDate(j)}-meeting-bundle.zip`);
    const tg = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendDocument`, { method: 'POST', body: form });
    if (!tg.ok) throw new Error(`Telegram send failed (${tg.status}): ${await tg.text()}`);
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  } finally {
    if (zipPath) { try { fs.unlinkSync(zipPath); } catch { /* ignore */ } }
  }
});

// ---------- Account, quota, PDPA (Phase 5) ----------
// Identity + quota + consent for the current session. Works in both modes: with
// auth off it reports authEnabled:false so the UI skips login/consent entirely.
app.get('/api/me', (req, res) => {
  const uid = currentUserId(req);
  const q = quotaFor(uid);
  res.json({
    authEnabled: auth.enabled,
    retentionDays: RETENTION_DAYS,
    quota: { ...q, month: new Date(monthStartMs()).toISOString().slice(0, 7) },
    user: auth.enabled && req.user
      ? {
          email: req.user.email, isAdmin: !!req.user.is_admin,
          consentAt: req.user.consent_at, createdAt: req.user.created_at,
          marketingConsentAt: req.user.marketing_consent_at,
          telegramChatId: req.user.telegram_chat_id || '',
        }
      : null,
  });
});

// Record PDPA consent ("I have consent to record everyone in this audio"). The
// optional `marketing` flag is a SEPARATE opt-in — never bundled into the
// required recording consent — so a marketing list only ever contains people who
// explicitly ticked it.
app.post('/api/me/consent', (req, res) => {
  if (!auth.enabled || !req.user) return res.status(400).json({ error: 'No account to record consent for' });
  const updated = jobs.setUserConsent(req.user.id);
  const withMkt = jobs.setUserMarketing(req.user.id, !!(req.body && req.body.marketing));
  res.json({ ok: true, consentAt: updated.consent_at, marketingConsentAt: withMkt.marketing_consent_at });
});

// Change the marketing preference later — the withdraw/unsubscribe path.
app.post('/api/me/marketing', (req, res) => {
  if (!auth.enabled || !req.user) return res.status(400).json({ error: 'No account' });
  const updated = jobs.setUserMarketing(req.user.id, !!(req.body && req.body.optIn));
  res.json({ ok: true, marketingConsentAt: updated.marketing_consent_at });
});

// Save (or clear) the user's remembered Telegram destination chat id.
app.post('/api/me/telegram', (req, res) => {
  if (!auth.enabled || !req.user) return res.status(400).json({ error: 'No account' });
  const chatId = String((req.body && req.body.chatId) || '').trim();
  const updated = jobs.setUserTelegram(req.user.id, chatId || null);
  res.json({ ok: true, telegramChatId: updated.telegram_chat_id || '' });
});

// Account deletion (PDPA): remove all of the user's jobs + files + usage + row.
app.delete('/api/me', (req, res) => {
  if (!auth.enabled || !req.user) return res.status(400).json({ error: 'No account to delete' });
  const userJobs = jobs.deleteUserCompletely(req.user.id);
  for (const j of userJobs) deleteJobFiles(j);
  auth.clearSessionCookie(res);
  res.json({ ok: true, deletedJobs: userJobs.length });
});

// Admin: the registered-users table — signup/consent/marketing + this-month and
// lifetime usage. usage_events survive job retention, so lifetime totals are real.
app.get('/api/admin/usage', (req, res) => {
  if (!auth.enabled || !req.user || !req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  const monthById = new Map(jobs.usageByUserSince(monthStartMs()).map((r) => [r.user_id, r]));
  const allById = new Map(jobs.usageByUserSince(0).map((r) => [r.user_id, r]));
  const users = jobs.listUsers().map((u) => {
    const m = monthById.get(u.id) || { mins: 0, jobs: 0 };
    const a = allById.get(u.id) || { mins: 0, jobs: 0 };
    return {
      id: u.id, email: u.email, isAdmin: !!u.is_admin, suspended: !!u.suspended_at,
      createdAt: u.created_at, lastLoginAt: u.last_login_at,
      consentAt: u.consent_at, marketingOptIn: !!u.marketing_consent_at,
      monthMinutes: +(+m.mins).toFixed(2), monthJobs: m.jobs,
      totalMinutes: +(+a.mins).toFixed(2), totalJobs: a.jobs,
    };
  });
  res.json({
    month: new Date(monthStartMs()).toISOString().slice(0, 7),
    minutesLimit: QUOTA_MINUTES,
    userCount: users.length,
    activeThisMonth: users.filter((u) => u.monthJobs > 0).length,
    marketingOptIns: users.filter((u) => u.marketingOptIn).length,
    users,
  });
});

// Admin: suspend / unsuspend an account (blocks the user's sessions at auth).
app.post('/api/admin/users/:id/suspend', (req, res) => {
  if (!auth.enabled || !req.user || !req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  const target = jobs.getUserById(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found' });
  if (target.id === req.user.id) return res.status(400).json({ error: "You can't suspend your own account" });
  const suspended = !!(req.body && req.body.suspended);
  jobs.setUserSuspended(target.id, suspended);
  // No need to purge sessions: the auth middleware rejects suspended users on
  // their very next request.
  res.json({ ok: true, suspended });
});

// Admin: export ONLY the addresses that currently agree to product marketing
// (opt-out clears the flag, so this list is always live + withdrawable). CSV.
app.get('/api/admin/marketing.csv', (req, res) => {
  if (!auth.enabled || !req.user || !req.user.is_admin) return res.status(403).json({ error: 'Admin only' });
  const rows = jobs.listMarketingOptIns();
  const csv = ['email,signed_up_at,opted_in_at']
    .concat(rows.map((r) => [
      r.email,
      new Date(r.created_at).toISOString(),
      new Date(r.marketing_consent_at).toISOString(),
    ].join(',')))
    .join('\n');
  const date = new Date().toISOString().slice(0, 10);
  sendDownload(res, `${date}-marketing-optin-emails.csv`, 'text/csv', csv + '\n');
});

// ---------- Admin AI pipeline: minutes → live Claude run → GitHub PR ----------
function requireAdmin(req, res) {
  if (!auth.enabled || !req.user || !req.user.is_admin) { res.status(403).json({ error: 'Admin only' }); return false; }
  return true;
}

// Read/write the editable instructions + chosen model.
app.get('/api/admin/pipeline/config', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({
    instructions: jobs.getSetting('pipeline_instructions') || pipeline.DEFAULT_INSTRUCTIONS,
    defaultInstructions: pipeline.DEFAULT_INSTRUCTIONS,
    // Stage 0 online research (Claude web_search). On by default; feeds a cited
    // research brief into the spec/architecture code-gen turn.
    research: jobs.getSetting('pipeline_research') !== '0',
    researchInstructions: jobs.getSetting('pipeline_research_instructions') || pipeline.RESEARCH_INSTRUCTIONS,
    defaultResearchInstructions: pipeline.RESEARCH_INSTRUCTIONS,
    model: jobs.getSetting('pipeline_model') || pipeline.DEFAULT_MODEL,
    models: pipeline.MODELS,
    githubReady: !!GITHUB_TOKEN,
    owner: GITHUB_OWNER || null,
    // MCP connector: the URL is not secret; tokens are never echoed back.
    mcpUrl: jobs.getSetting('pipeline_mcp_url') || '',
    mcpHasToken: !!jobs.getSetting('pipeline_mcp_token'),
    // OAuth connection state (for the "Connect" button UI).
    mcpConnected: !!jobs.getSetting('pipeline_mcp_refresh_token'),
    mcpScopes: jobs.getSetting('pipeline_mcp_scopes') || '',
    mcpCallbackReady: !!APP_BASE_URL,
    // Optional autonomous deploy (Phase 4/5 via the MCP's run_command tool).
    deploy: !!jobs.getSetting('pipeline_deploy'),
    deployInstructions: jobs.getSetting('pipeline_deploy_instructions') || pipeline.DEPLOY_INSTRUCTIONS,
    defaultDeployInstructions: pipeline.DEPLOY_INSTRUCTIONS,
    // "Deploy only" test button: is deploy runnable, and the last repo to prefill.
    deployReady: !!(jobs.getSetting('pipeline_mcp_refresh_token') || jobs.getSetting('pipeline_mcp_token')) && !!GITHUB_TOKEN,
    lastRepo: jobs.getSetting('pipeline_last_repo') || '',
  });
});
app.post('/api/admin/pipeline/config', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { instructions, model, mcpUrl, mcpToken, research, researchInstructions } = req.body || {};
  if (typeof instructions === 'string') jobs.setSetting('pipeline_instructions', instructions);
  if (typeof model === 'string' && model.trim()) jobs.setSetting('pipeline_model', model.trim());
  // Stage 0 online research toggle + editable prompt.
  if (typeof research === 'boolean') jobs.setSetting('pipeline_research', research ? '1' : '0');
  if (typeof researchInstructions === 'string') jobs.setSetting('pipeline_research_instructions', researchInstructions);
  // MCP URL saved as-is (empty string disables the connector). Token is only
  // updated when a new value is provided — blank leaves the stored one intact.
  if (typeof mcpUrl === 'string') jobs.setSetting('pipeline_mcp_url', mcpUrl.trim());
  if (typeof mcpToken === 'string' && mcpToken.trim()) jobs.setSetting('pipeline_mcp_token', mcpToken.trim());
  // Autonomous deploy toggle + editable Phase 4/5 instructions.
  const { deploy, deployInstructions } = req.body || {};
  if (typeof deploy === 'boolean') jobs.setSetting('pipeline_deploy', deploy ? '1' : '');
  if (typeof deployInstructions === 'string') jobs.setSetting('pipeline_deploy_instructions', deployInstructions);
  res.json({ ok: true });
});

// ----- MCP OAuth: browser-based connect (PKCE + dynamic client registration) -----
// Some MCP servers (e.g. the Dojo marketplace MCP) are OAuth-protected with
// short-lived access tokens. The Anthropic connector only sends a static bearer,
// so we run the OAuth flow here, store the refresh token, and mint a fresh access
// token before each run (see mcpAccessToken).
const MCP_REDIRECT = () => `${APP_BASE_URL}/api/admin/pipeline/mcp/callback`;

// Step 1: build the authorize URL the admin's browser is sent to.
app.post('/api/admin/pipeline/mcp/connect', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!APP_BASE_URL) return res.status(500).json({ error: 'APP_BASE_URL is not configured on the server (needed for the OAuth redirect).' });
  try {
    const url = mcpoauth.normalizeUrl((req.body && req.body.url) || jobs.getSetting('pipeline_mcp_url') || '');
    if (!url) return res.status(400).json({ error: 'Enter the MCP server URL first.' });
    jobs.setSetting('pipeline_mcp_url', url);

    const meta = await mcpoauth.discover(url);
    const scope = meta.scopes.join(' ');
    // Reuse a client already registered for this exact URL; else register one.
    let clientId = jobs.getSetting('pipeline_mcp_client_id');
    let clientSecret = jobs.getSetting('pipeline_mcp_client_secret') || '';
    if (!clientId || jobs.getSetting('pipeline_mcp_registered_for') !== url) {
      const reg = await mcpoauth.registerClient({ registration: meta.registration, redirectUri: MCP_REDIRECT(), scope });
      clientId = reg.client_id; clientSecret = reg.client_secret || '';
      jobs.setSetting('pipeline_mcp_client_id', clientId);
      jobs.setSetting('pipeline_mcp_client_secret', clientSecret);
      jobs.setSetting('pipeline_mcp_registered_for', url);
    }

    const { verifier, challenge } = mcpoauth.makePkce();
    const state = mcpoauth.randomState();
    jobs.setSetting('pipeline_mcp_pkce', verifier);
    jobs.setSetting('pipeline_mcp_state', state);
    jobs.setSetting('pipeline_mcp_token_endpoint', meta.token);
    jobs.setSetting('pipeline_mcp_scopes', scope);

    const authorizeUrl = mcpoauth.buildAuthorizeUrl({
      authorize: meta.authorize, clientId, redirectUri: MCP_REDIRECT(),
      challenge, state, scope, resource: url,
    });
    res.json({ authorizeUrl });
  } catch (err) {
    console.error('mcp connect failed:', err.message);
    res.status(502).json({ error: `Could not start the MCP login: ${err.message}` });
  }
});

// Step 2: OAuth redirect target — exchange the code, persist the refresh token.
// Returns a tiny HTML page (this is a top-level browser navigation, not fetch).
app.get('/api/admin/pipeline/mcp/callback', async (req, res) => {
  const page = (ok, msg) => `<!doctype html><meta charset="utf-8"><title>MCP ${ok ? 'connected' : 'error'}</title>` +
    `<body style="font-family:-apple-system,system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;text-align:center">` +
    `<h2>${ok ? '✅ MCP connected' : '⚠️ Could not connect'}</h2><p style="color:#555">${msg}</p>` +
    `<p><a href="/#/admin">Back to the admin page</a></p>` +
    `<script>try{if(window.opener){window.opener.postMessage({mcp:'${ok ? 'connected' : 'error'}'},'*');setTimeout(()=>window.close(),1200);}}catch(e){}</script>`;
  if (!auth.enabled || !req.user || !req.user.is_admin) return res.status(403).send(page(false, 'Admin sign-in required.'));
  const { code, state, error, error_description } = req.query;
  if (error) return res.status(400).send(page(false, `The MCP server returned: ${error_description || error}`));
  if (!code || !state || state !== jobs.getSetting('pipeline_mcp_state')) {
    return res.status(400).send(page(false, 'Invalid or expired login attempt — please try Connect again.'));
  }
  try {
    const tok = await mcpoauth.exchangeCode({
      token: jobs.getSetting('pipeline_mcp_token_endpoint'), code, redirectUri: MCP_REDIRECT(),
      clientId: jobs.getSetting('pipeline_mcp_client_id'), clientSecret: jobs.getSetting('pipeline_mcp_client_secret') || '',
      verifier: jobs.getSetting('pipeline_mcp_pkce'), resource: jobs.getSetting('pipeline_mcp_url'),
    });
    if (!tok.access_token) throw new Error('no access_token returned');
    jobs.setSetting('pipeline_mcp_access_token', tok.access_token);
    jobs.setSetting('pipeline_mcp_access_expiry', String(Date.now() + (Number(tok.expires_in) || 3600) * 1000));
    if (tok.refresh_token) jobs.setSetting('pipeline_mcp_refresh_token', tok.refresh_token);
    jobs.setSetting('pipeline_mcp_pkce', ''); jobs.setSetting('pipeline_mcp_state', '');
    res.send(page(true, 'You can close this tab and run the AI pipeline.'));
  } catch (err) {
    console.error('mcp callback failed:', err.message);
    res.status(502).send(page(false, `Token exchange failed: ${err.message}`));
  }
});

// Disconnect: forget the stored OAuth credentials for this MCP.
app.post('/api/admin/pipeline/mcp/disconnect', (req, res) => {
  if (!requireAdmin(req, res)) return;
  for (const k of ['pipeline_mcp_refresh_token', 'pipeline_mcp_access_token', 'pipeline_mcp_access_expiry',
    'pipeline_mcp_client_id', 'pipeline_mcp_client_secret', 'pipeline_mcp_registered_for',
    'pipeline_mcp_pkce', 'pipeline_mcp_state', 'pipeline_mcp_scopes', 'pipeline_mcp_token_endpoint']) {
    jobs.setSetting(k, '');
  }
  res.json({ ok: true });
});

// Introspect the connected MCP: list its tools + input schemas. Read-only. Used
// to see what the server (e.g. Dojo) actually exposes — e.g. create_server /
// add_ssh_key params for the SSH deploy model.
app.get('/api/admin/pipeline/mcp/tools', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const url = jobs.getSetting('pipeline_mcp_url') || '';
  if (!url) return res.status(400).json({ error: 'Set the MCP URL first.' });
  try {
    const token = await mcpAccessToken();
    const tools = await mcpclient.listTools(url, token);
    res.json({ count: tools.length, tools: tools.map((t) => ({ name: t.name, description: t.description || '', inputSchema: t.inputSchema || t.input_schema || null })) });
  } catch (err) {
    console.error('mcp tools/list failed:', err.message);
    res.status(502).json({ error: `Could not list MCP tools: ${err.message}` });
  }
});

// Resolve the bearer token for the MCP connector at run time. Prefers OAuth: if a
// refresh token is stored, return a cached access token that's still valid, else
// refresh it (rotating the refresh token when the server issues a new one). Falls
// back to the manually-pasted static token. Returns '' when nothing is configured.
async function mcpAccessToken() {
  const refreshToken = jobs.getSetting('pipeline_mcp_refresh_token');
  if (refreshToken) {
    const exp = Number(jobs.getSetting('pipeline_mcp_access_expiry') || 0);
    const cached = jobs.getSetting('pipeline_mcp_access_token');
    if (cached && exp - Date.now() > 60_000) return cached; // still valid (>60s headroom)
    const tok = await mcpoauth.refresh({
      token: jobs.getSetting('pipeline_mcp_token_endpoint'), refreshToken,
      clientId: jobs.getSetting('pipeline_mcp_client_id'), clientSecret: jobs.getSetting('pipeline_mcp_client_secret') || '',
      resource: jobs.getSetting('pipeline_mcp_url'),
    });
    if (tok.access_token) {
      jobs.setSetting('pipeline_mcp_access_token', tok.access_token);
      jobs.setSetting('pipeline_mcp_access_expiry', String(Date.now() + (Number(tok.expires_in) || 3600) * 1000));
      if (tok.refresh_token) jobs.setSetting('pipeline_mcp_refresh_token', tok.refresh_token);
      return tok.access_token;
    }
  }
  return jobs.getSetting('pipeline_mcp_token') || '';
}

// Pinned deploy target (user's Dojo account): Amazon Lightsail, Singapore, 1 GB.
const DEPLOY_CFG = {
  cloud_provider_id: 8, region_id: 15, cloud_service_plan_id: 57, support_level_id: 1,
  project_id: 17, admin_email: 'eddiesoo612@gmail.com',
  // We deploy over SSH (full root shell), so we CAN stop nginx and take port 80.
  app_port: 80,
};

// The remote deploy script, run over SSH (full shell — chaining/redirection OK,
// unlike run_command). Frees port 80, installs Node/npm/git, clones the public
// repo, and starts it under pm2. The API key is passed inline and never echoed
// (no `set -x`). ${…} are JS interpolations; $(…)/$cid are literal shell.
function deployScript({ cloneUrl, anthropicKey, port }) {
  // NodeSource installs Node 20 with npm bundled and pulls only ~a dozen
  // packages — far faster/quieter than Ubuntu's `npm` (which drags in webpack/
  // babel/jest, ~5 min). Output is NOT suppressed: the steady stream both shows
  // progress and keeps the SSH connection from idling out during install.
  return `set -e
export DEBIAN_FRONTEND=noninteractive
echo '[1/6] Waiting for first-boot cloud-init, then freeing port ${port}'
cloud-init status --wait >/dev/null 2>&1 || true
systemctl stop nginx 2>/dev/null || true
systemctl disable nginx 2>/dev/null || true
for cid in $(docker ps --filter 'publish=${port}' -q 2>/dev/null); do docker stop "$cid" || true; done
echo '[2/6] Installing Node.js 20 (NodeSource) + git'
curl -fsSL https://deb.nodesource.com/setup_20.x -o /tmp/nodesource_setup.sh
bash /tmp/nodesource_setup.sh
apt-get -o DPkg::Lock::Timeout=300 install -y nodejs git
echo "node $(node -v) / npm $(npm -v)"
echo '[3/6] Cloning repo'
rm -rf /opt/app
git clone --depth 1 ${cloneUrl} /opt/app
echo '[4/6] Installing dependencies'
npm install --prefix /opt/app --omit=dev --no-audit --no-fund
echo '[5/6] Starting under pm2 on port ${port}'
npm install -g pm2 --no-audit --no-fund
pm2 delete app 2>/dev/null || true
ANTHROPIC_API_KEY='${anthropicKey}' PORT=${port} pm2 start npm --name app --cwd /opt/app -- start
pm2 save 2>/dev/null || true
sleep 5
echo '[6/6] QA'
pm2 status
echo '--- health check ---'
curl -s -o /dev/null -m 10 -w 'HEALTHCHECK_HTTP_CODE=%{http_code}\n' http://localhost:${port} || echo 'curl failed'
echo '=== DEPLOY DONE ==='
`;
}

// Re-deploy after the self-heal loop pushed a fix to the repo: pull the new code,
// reinstall, restart under pm2, re-check. The box already has Node/nginx handled.
function redeployScript({ anthropicKey, port }) {
  return `set -e
echo '[redeploy] Pulling the fix'
git -C /opt/app fetch --depth 1 origin main
git -C /opt/app reset --hard origin/main
echo '[redeploy] Installing dependencies'
npm install --prefix /opt/app --omit=dev --no-audit --no-fund
echo '[redeploy] Restarting under pm2'
pm2 delete app 2>/dev/null || true
ANTHROPIC_API_KEY='${anthropicKey}' PORT=${port} pm2 start npm --name app --cwd /opt/app -- start
pm2 save 2>/dev/null || true
sleep 5
pm2 status
echo '--- health check ---'
curl -s -o /dev/null -m 10 -w 'HEALTHCHECK_HTTP_CODE=%{http_code}\n' http://localhost:${port} || echo 'curl failed'
echo '=== DEPLOY DONE ==='
`;
}

// Collect failure diagnostics to feed the self-heal fix pass: pm2 state + app
// logs (the crash/stack trace) + the HTTP response + package.json + file list.
function diagnosticsScript({ port }) {
  return `echo '=== pm2 status ==='
pm2 status 2>&1 || true
echo '=== pm2 logs (last 80 lines) ==='
pm2 logs app --lines 80 --nostream 2>&1 || true
echo '=== curl http://localhost:${port} ==='
curl -i -s -m 8 http://localhost:${port} 2>&1 | head -40 || echo 'no response on ${port}'
echo '=== package.json ==='
cat /opt/app/package.json 2>&1 || echo 'no package.json'
echo '=== ls /opt/app ==='
ls -la /opt/app 2>&1 || true
`;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Pull a value for `key` out of an MCP tool result no matter how it's nested.
function deepFind(obj, key) {
  const q = [obj];
  while (q.length) {
    const o = q.shift();
    if (o && typeof o === 'object') {
      for (const k of Object.keys(o)) {
        if (k === key && o[k] != null && o[k] !== '') return o[k];
        if (o[k] && typeof o[k] === 'object') q.push(o[k]);
      }
    }
  }
  return undefined;
}
// Normalise an MCP tool result into a plain object (structuredContent or parsed text).
function mcpResultObj(result) {
  if (!result || typeof result !== 'object') return {};
  if (result.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  const txt = (result.content || []).filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
  try { return JSON.parse(txt); } catch { return { _text: txt }; }
}

// Stage 3: autonomous deploy + QA of an already-pushed public repo — DETERMINISTIC
// (no model tokens; the long provision wait is Node sleeps, not Claude turns).
// Dojo tools are called directly via mcpclient: create_server → poll get_server
// for a public IP → add_ssh_key. The actual install/deploy runs over SSH (full
// root shell), because run_command's allowlist can't install a Node runtime.
// Progress streams over SSE (`send`); `isAborted` polls.
async function runMcpDeploy({ mcpUrl, mcpToken, cloneUrl, send, isAborted, onHeal }) {
  const c = DEPLOY_CFG;
  const call = (name, args) => mcpclient.callTool(mcpUrl, mcpToken, name, args).then(mcpResultObj);
  const log = (t) => send('delta', { text: t });

  // 1. Provision. The server name matches the GitHub repo/service we're
  // deploying (derived from the clone URL) so the Dojo box is identifiable and
  // maps 1:1 to the PR. Param names + metadata match the Dojo create_server API.
  const serverName = (String(cloneUrl).match(/([^/]+?)(?:\.git)?$/) || [])[1]
    || `notetaker-poc-${Date.now().toString(36)}`;
  send('status', { message: `Provisioning Amazon Lightsail (1 GB, Singapore) as “${serverName}”…` });
  // Param names MUST match the create_server tool schema exactly: region_id +
  // cloud_service_plan_id (NOT cloud_region_id/service_plan_id), and no
  // metadata_json (additionalProperties:false). The image defaults to
  // ubuntu-24.04 + nginx+docker. Verified against live Dojo (server 182).
  const created = await call('create_server', {
    project_id: c.project_id,
    cloud_provider_id: c.cloud_provider_id,
    region_id: c.region_id,
    cloud_service_plan_id: c.cloud_service_plan_id,
    support_level_id: c.support_level_id,
    name: serverName,
    admin_email: c.admin_email,
  });
  const serverId = deepFind(created, 'server_id') ?? deepFind(created, 'id');
  let vmId = deepFind(created, 'vm_id');
  if (!serverId) throw new Error(`create_server did not return a server_id (got: ${JSON.stringify(created).slice(0, 300)})`);
  log(`✔ create_server → server_id=${serverId}${vmId ? `, vm_id=${vmId}` : ''}. Waiting for a public IP…\n`);

  // 2. Poll get_server for the public IP (Node loop — no model tokens).
  let publicIp = null;
  const t0 = Date.now();
  const PROVISION_MS = 12 * 60 * 1000;
  while (!isAborted()) {
    if (Date.now() - t0 > PROVISION_MS) throw new Error('Timed out (12 min) waiting for a public IP.');
    const s = await call('get_server', { project_id: c.project_id, server_id: serverId });
    publicIp = deepFind(s, 'public_ip') || deepFind(s, 'publicIp') || deepFind(s, 'ip');
    if (!vmId) vmId = deepFind(s, 'vm_id');
    const st = deepFind(s, 'status');
    // Wait for BOTH a public IP and status=1 (ready). Adding the SSH key before
    // the box is ready never propagates — it must be applied once it's up.
    if (publicIp && String(publicIp).length > 6 && (st === 1 || st === '1')) { send('status', { message: `Server ready at ${publicIp}.` }); break; }
    send('status', { message: `Provisioning… ${Math.round((Date.now() - t0) / 1000)}s elapsed (status ${st})` });
    await sleep(15000);
  }
  if (isAborted()) return {};
  log(`✔ Public IP: ${publicIp}\n`);
  if (!vmId) throw new Error('Server is up but no vm_id was returned — cannot run_command.');

  // Best-effort: make sure port 80 is open in the cloud firewall.
  try {
    await call('add_firewall_rule', { vm_id: vmId, project_id: c.project_id, port: String(c.app_port), protocol: 'tcp', sources: ['0.0.0.0/0'] });
  } catch { /* rule may already exist */ }

  // 3. SSH-based deploy. run_command can't install Node (apt/docker run blocked),
  // so add an ephemeral SSH key to the box and run an unrestricted script over
  // SSH (full root shell). Streams the remote output live.
  const key = await sshdeploy.genKeyPair();
  try {
    send('status', { message: 'Registering a deploy SSH key on the server…' });
    await call('add_ssh_key', { vm_id: vmId, project_id: c.project_id, name: `deploy-${Date.now().toString(36)}`, public_key: key.publicKey });

    send('status', { message: 'Waiting for SSH to come up…' });
    const up = await sshdeploy.waitForSsh({ host: publicIp, keyPath: key.keyPath, onStatus: (m) => send('status', { message: m }), isAborted });
    if (!up) return {}; // aborted

    // Deploy, then self-heal: if the health check isn't 200 and a healer is
    // provided, collect the server logs, ask it to fix + push, and redeploy —
    // up to a few attempts. Without a healer it's a single shot (deploy-only).
    const runScript = (script) => sshdeploy.runScript({ host: publicIp, keyPath: key.keyPath, script, onData: (t) => log(t) });
    const maxAttempts = onHeal ? 3 : 1;
    let ok = false;
    for (let attempt = 1; attempt <= maxAttempts && !isAborted(); attempt++) {
      send('status', { message: attempt === 1
        ? 'Connected over SSH — installing Node, cloning, starting the app…'
        : `Redeploying the fix (attempt ${attempt}/${maxAttempts})…` });
      const script = attempt === 1
        ? deployScript({ cloneUrl, anthropicKey: ANTHROPIC_API_KEY, port: c.app_port })
        : redeployScript({ anthropicKey: ANTHROPIC_API_KEY, port: c.app_port });
      const { output } = await runScript(script);
      // Success = a GET on / returned 200 (mirrors the real user, not a HEAD).
      ok = /HEALTHCHECK_HTTP_CODE=200\b/.test(output);
      if (ok || attempt === maxAttempts || !onHeal || isAborted()) break;

      send('status', { message: `Health check failed — collecting logs and asking Claude to fix (attempt ${attempt}/${maxAttempts - 1})…` });
      const diag = await runScript(diagnosticsScript({ port: c.app_port }));
      const healed = await onHeal(diag.output, attempt); // fixes + pushes; false to stop
      if (!healed) break;
    }

    const liveUrl = ok ? `http://${publicIp}${c.app_port === 80 ? '' : ':' + c.app_port}` : null;
    send('status', { message: ok ? '✅ App is live (HTTP 200).' : '❌ Deploy failed — app never returned 200.' });
    log(`\n========================================\n${ok ? `✅ DEPLOYED\nLIVE URL:  ${liveUrl}` : '❌ DEPLOY FAILED (no HTTP 200 — see the log above)'}\nPUBLIC IP: ${publicIp}\n========================================\n`);
    return { publicIp, ok, liveUrl };
  } finally {
    sshdeploy.cleanup(key.dir);
  }
}

// Run the pipeline on a job's minutes and STREAM the phases live (SSE). On
// completion, parse the file manifest and open a PR in a new private repo.
app.get('/api/admin/pipeline/stream', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured on the server' });
  const j = jobs.getJob(req.query.jobId);
  if (!j || j.user_id !== currentUserId(req)) return res.status(404).json({ error: 'Job not found' });

  const md = decJobText(j, j.markdown) || '';
  const cleaned = decJobText(j, j.cleaned_transcript) || decJobText(j, j.raw_transcript) || '';
  const minutes = `# Meeting summary\n${md}\n\n# Transcript\n${cleaned}`.trim();
  if (md === '' && cleaned === '') return res.status(400).json({ error: 'This job has no minutes yet' });

  const instructions = jobs.getSetting('pipeline_instructions') || pipeline.DEFAULT_INSTRUCTIONS;
  const model = jobs.getSetting('pipeline_model') || pipeline.DEFAULT_MODEL;
  // Stage 0 online research (Claude web_search): on unless explicitly disabled.
  const researchEnabled = jobs.getSetting('pipeline_research') !== '0';
  const researchInstructions = jobs.getSetting('pipeline_research_instructions') || pipeline.RESEARCH_INSTRUCTIONS;
  const mcpUrl = jobs.getSetting('pipeline_mcp_url') || '';
  // Deploy runs automatically whenever an MCP is connected — code-gen → repo →
  // provision → git clone → pm2. Resolve the MCP bearer up front so a bad
  // connection fails before we stream. Code-gen itself uses no tools.
  let mcpToken = '';
  if (mcpUrl) {
    try { mcpToken = await mcpAccessToken(); }
    catch (err) { return res.status(502).json({ error: `MCP auth failed — reconnect in Admin → AI Pipeline. (${err.message})` }); }
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // don't let nginx buffer the stream
  });
  res.flushHeaders();
  const send = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ } };

  let stream = null;
  let aborted = false;
  req.on('close', () => { aborted = true; if (stream) { try { stream.abort(); } catch { /* ignore */ } } });

  let full = '';
  try {
    // ---- Stage 0: online research (Claude web_search server tool). Grounds the
    // product spec + architecture in real prior art / recommended stack / pitfalls
    // before any code is written — mirroring the Claude desktop "project" flow.
    // Streamed live, then folded into the Stage 1 code-gen message as a brief.
    // Best-effort: if research fails (tool disabled, etc.) we fall back to
    // straight code-gen so the pipeline never breaks. ----
    let researchBrief = '';
    if (researchEnabled) {
      send('status', { message: 'Researching the problem online (prior art, stack, pitfalls)…' });
      send('delta', { text: '## Stage 0 — Online research\n\n' });
      try {
        stream = anthropic.messages.stream({
          model,
          max_tokens: 8000,
          system: researchInstructions,
          tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 6 }],
          messages: [{ role: 'user', content: `Meeting minutes:\n\n${minutes}` }],
        });
        stream.on('text', (delta) => { researchBrief += delta; send('delta', { text: delta }); });
        await stream.finalMessage();
        researchBrief = researchBrief.trim();
      } catch (err) {
        console.error('pipeline research stage failed:', err.message);
        send('delta', { text: `\n_(Research step skipped: ${err.message})_\n` });
        researchBrief = '';
      }
      if (aborted) return res.end();
      send('delta', { text: '\n\n---\n\n' });
    }

    // ---- Stage 1: generate the POC code (no tools → reliable file manifest). ----
    send('status', { message: `Running ${model} on the meeting minutes…` });
    const codegenMessage = researchBrief
      ? `Meeting minutes:\n\n${minutes}\n\n---\n\nRESEARCH BRIEF (from your product-research lead — apply it to the product spec and architecture below):\n\n${researchBrief}`
      : `Meeting minutes:\n\n${minutes}`;
    stream = anthropic.messages.stream({
      model,
      max_tokens: 32000, // headroom for multi-file POCs; truncation degrades gracefully
      system: instructions,
      messages: [{ role: 'user', content: codegenMessage }],
    });
    stream.on('text', (delta) => { full += delta; send('delta', { text: delta }); });
    await stream.finalMessage();

    const manifest = pipeline.parseManifest(full);
    if (!manifest) { send('done', { prUrl: null, note: 'No file manifest was produced — showing the generated text only.' }); return res.end(); }
    const filePaths = manifest.files.map((f) => f.path);
    if (!GITHUB_TOKEN) {
      send('done', { prUrl: null, repo: manifest.repo, files: filePaths, note: 'GITHUB_TOKEN not set on the server — skipped repo creation.' });
      return res.end();
    }

    // ---- Stage 2: create the repo. Always PUBLIC so a deploy server can
    // `git clone` it without credentials. ----
    const willDeploy = !!mcpToken && !!mcpUrl; // deploy whenever the MCP is connected
    send('status', { message: `Creating a public repo with ${manifest.files.length} file(s)…` });
    const name = `${manifest.repo}-${Date.now().toString(36)}`;
    const { repoUrl, prUrl, cloneUrl, fullName } = await github.createRepoWithPR({
      token: GITHUB_TOKEN, ownerEnv: GITHUB_OWNER, name, files: manifest.files,
      prTitle: `POC: ${manifest.repo}`, prBody: manifest.summary, isPublic: true,
    });
    // Remember the last repo so the "Deploy only" test button can prefill it.
    jobs.setSetting('pipeline_last_repo', repoUrl);
    jobs.setSetting('pipeline_last_clone', cloneUrl);

    if (!willDeploy) {
      send('status', { message: mcpUrl
        ? 'MCP is not connected — created the repo only. Click Connect in Admin → AI Pipeline to auto-deploy.'
        : 'No MCP configured — created the repo only. Set the MCP URL + Connect in Admin → AI Pipeline to auto-deploy.' });
      send('done', { prUrl, repoUrl, repo: manifest.repo, files: filePaths });
      return res.end();
    }

    // ---- Stage 3: deploy + QA, with a self-heal loop. If the app doesn't answer
    // 200, feed the server logs + current files back to Claude, push the fix to
    // the repo, and redeploy — mirroring an engineer's deploy→observe→fix loop. ----
    let currentFiles = manifest.files;
    const onHeal = async (logs, attempt) => {
      send('status', { message: 'Claude is analysing the failure and rewriting the code…' });
      let fixText = ''; // keep the fix response separate from the original code-gen (full)
      // Use Sonnet for the fix pass: Opus 5 false-positive-refuses this "debug my
      // crashed server" prompt, while Sonnet handles it reliably.
      stream = anthropic.messages.stream({
        model: 'claude-sonnet-5',
        max_tokens: 32000,
        system: pipeline.FIX_INSTRUCTIONS,
        messages: [{ role: 'user', content: `Server logs from the failed deploy:\n\n${logs}\n\nCurrent project files:\n\n${pipeline.renderFiles(currentFiles)}` }],
      });
      stream.on('text', (delta) => { fixText += delta; send('delta', { text: delta }); });
      await stream.finalMessage();
      const fixed = pipeline.parseManifest(fixText);
      const fixedFiles = fixed && fixed.files && fixed.files.length ? fixed.files : null;
      if (!fixedFiles) { send('status', { message: 'Claude did not return a usable fix — stopping.' }); return false; }
      currentFiles = fixedFiles;
      try {
        await github.commitFiles({ token: GITHUB_TOKEN, fullName, files: currentFiles, message: `Self-heal fix (attempt ${attempt})` });
      } catch (e) { send('status', { message: `Could not push the fix: ${e.message}` }); return false; }
      send('status', { message: `Pushed a fix (${currentFiles.length} file(s)).` });
      return true;
    };
    const dep = await runMcpDeploy({ mcpUrl, mcpToken, cloneUrl, send, isAborted: () => aborted, onHeal });
    send('done', { prUrl, repoUrl, repo: manifest.repo, files: filePaths, deployed: !!(dep && dep.ok), liveUrl: (dep && dep.liveUrl) || null, deployNote: dep && !dep.ok ? 'Deploy did not succeed — see the log above.' : null });
  } catch (err) {
    console.error('pipeline stream failed:', err.message);
    send('error', { error: err.message });
  } finally {
    res.end();
  }
});

// Deploy-ONLY (SSE): skip code-gen + repo creation and run just the deploy + QA
// stage against an already-created repo. Lets you iterate on the
// provision → git clone → stop nginx → pm2 flow without regenerating everything.
app.get('/api/admin/pipeline/deploy-stream', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured on the server' });

  const repoUrl = String(req.query.repo || jobs.getSetting('pipeline_last_repo') || '').trim();
  if (!repoUrl) return res.status(400).json({ error: 'No repo URL — generate a POC first, or pass ?repo=…' });
  const cloneUrl = /\.git$/.test(repoUrl) ? repoUrl : `${repoUrl.replace(/\/$/, '')}.git`;

  const mcpUrl = jobs.getSetting('pipeline_mcp_url') || '';
  if (!mcpUrl) return res.status(400).json({ error: 'No MCP configured — set the MCP URL and Connect in Admin → AI Pipeline.' });
  let mcpToken = '';
  try { mcpToken = await mcpAccessToken(); }
  catch (err) { return res.status(502).json({ error: `MCP auth failed — reconnect in Admin → AI Pipeline. (${err.message})` }); }
  if (!mcpToken) return res.status(400).json({ error: 'MCP is not connected — click Connect in Admin → AI Pipeline first.' });

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const send = (event, data) => { try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* client gone */ } };

  let aborted = false;
  req.on('close', () => { aborted = true; });

  try {
    // Best-effort: make sure the repo is public so the fresh server can clone it.
    send('status', { message: 'Ensuring the repo is public so the server can clone it…' });
    if (GITHUB_TOKEN) await github.setRepoPublic(GITHUB_TOKEN, repoUrl);

    const dep = await runMcpDeploy({ mcpUrl, mcpToken, cloneUrl, send, isAborted: () => aborted });
    send('done', { repoUrl, deployed: !!(dep && dep.ok), liveUrl: (dep && dep.liveUrl) || null, deployNote: dep && !dep.ok ? 'Deploy did not succeed — see the log above.' : null });
  } catch (err) {
    console.error('deploy stream failed:', err.message);
    send('error', { error: err.message });
  } finally {
    res.end();
  }
});

// ---------- Route: process recording + attachments ----------
app.post(
  '/api/process',
  rateLimitUploads,
  upload.fields([{ name: 'audio', maxCount: 1 }, { name: 'attachments', maxCount: 10 }]),
  async (req, res) => {
    const tempPaths = [];
    let sonioxFileId = null;
    let transcriptionId = null;

    try {
      if (blockedByQuota(req, res)) return;
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

      const markdown = await prompts.structureNotes(anthropic, rawTranscript, attachments);

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
  // Transcription models are masked ("Model 1"/"Model 2"); expose which are
  // actually configured so the UI can offer only usable ones.
  const models = [
    { id: 'model1', label: 'Model 1', available: providerAvailable('soniox') },
    { id: 'model2', label: 'Model 2', available: providerAvailable('gemini') },
  ];
  const firstAvailable = (models.find((m) => m.available) || models[0]).id;
  res.json({
    segmentMinutes: SEGMENT_MINUTES,
    segmentMs: Math.round(SEGMENT_MINUTES * 60 * 1000),
    retentionDays: RETENTION_DAYS_EFFECTIVE,
    models,
    defaultModel: firstAvailable,
    // Public deployments (auth on) require a per-upload consent tick.
    requireUploadConsent: auth.enabled,
    encryptedAtRest: cs.enabled,
  });
});

// ---------- Abuse report (Phase 5.5, light moderation) ----------
app.post('/api/report', (req, res) => {
  const { jobId, reason, contact } = req.body || {};
  if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'A reason is required' });
  const reporter = (auth.enabled && req.user && req.user.email) || contact || null;
  const row = jobs.addReport({ job_id: jobId || null, reporter, reason: String(reason).slice(0, 2000) });
  console.warn(`ABUSE REPORT ${row.id} — job=${row.job_id || '-'} by=${reporter || 'anon'}: ${row.reason}`);
  // Best-effort admin email if Resend is configured (auth.js already wraps it).
  if (typeof auth.notifyAdmins === 'function') auth.notifyAdmins('Content reported', `${row.reason}\n\njob=${row.job_id}\nby=${reporter}`).catch(() => {});
  res.json({ ok: true });
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

// Store a single recording segment's AUDIO (no per-segment transcription).
// Phase 3 accuracy fix: transcribing isolated ~5-min segments lost cross-segment
// context and cut code-switched sentences. We now keep only the audio here and
// transcribe the whole recording in ONE Soniox pass at finalize. Index-named
// files keep segments in order and make re-uploads (crash recovery) idempotent.
app.post('/api/transcribe-chunk', rateLimitUploads, upload.single('audio'), (req, res) => {
  try {
    const dir = sessionDir(req.body.sessionId);
    if (!fs.existsSync(dir)) return res.status(400).json({ error: 'Unknown or expired session' });

    const segment = req.file;
    if (!segment) return res.status(400).json({ error: 'No audio segment provided' });

    const index = String(Math.max(0, parseInt(req.body.index, 10) || 0)).padStart(6, '0');
    const ext = extFromName(segment.originalname, segment.mimetype);
    // Move the multer temp file into the session store (same filesystem).
    fs.renameSync(segment.path, path.join(dir, `${index}${ext}`));

    res.json({ ok: true, index: parseInt(index, 10) });
  } catch (err) {
    console.error(err);
    if (req.file && req.file.path) {
      try { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); } catch { /* ignore */ }
    }
    res.status(500).json({ error: err.message });
  }
});

// Finalize: ffmpeg-concat the stored segments into ONE recording and enqueue a
// single job. Transcription/cleaning/summarising happen asynchronously in the
// worker (same pipeline as an upload), so the client just navigates to the job.
app.post('/api/finalize', upload.fields([{ name: 'attachments', maxCount: 10 }]), async (req, res) => {
  const tempPaths = [];
  let dir = null;

  try {
    if (blockedByQuota(req, res)) return;
    dir = sessionDir(req.body.sessionId);
    if (!fs.existsSync(dir)) throw new Error('Unknown or expired session');

    // Segment audio files are index-named (000000.<ext>); .txt files (if any
    // survived from an older build) are ignored.
    const segments = fs.readdirSync(dir)
      .filter((f) => /^\d{6}\.[a-z0-9]+$/i.test(f))
      .sort();
    if (!segments.length) {
      throw new Error('No audio captured for this session — check the recording had audio');
    }

    const ext = path.extname(segments[0]) || '.webm';
    const segPaths = segments.map((f) => path.join(dir, f));
    const jobId = crypto.randomUUID();
    const finalPath = path.join(UPLOAD_DIR, `${jobId}${ext}`);

    if (segPaths.length === 1) {
      fs.copyFileSync(segPaths[0], finalPath);
    } else {
      await ffmpegConcat(segPaths, finalPath);
    }
    const size = fs.statSync(finalPath).size; // plaintext size (before encryption)
    const uid = currentUserId(req);
    const dek = cs.enabled ? dekFor(uid) : null;
    if (cs.enabled) cs.encryptFileInPlace(dek, finalPath);

    // Persist attachments beside the job for the worker to fold into the summary.
    const attachmentFiles = (req.files && req.files.attachments) || [];
    attachmentFiles.forEach((f) => tempPaths.push(f.path));
    if (attachmentFiles.length) {
      const adir = jobAttachmentsDir(jobId);
      fs.mkdirSync(adir, { recursive: true });
      const meta = attachmentFiles.map((f, i) => {
        const file = `${i}${path.extname(f.originalname) || ''}`;
        const dest = path.join(adir, file);
        fs.copyFileSync(f.path, dest);
        if (cs.enabled) cs.encryptFileInPlace(dek, dest);
        return { file, mimetype: f.mimetype };
      });
      fs.writeFileSync(path.join(adir, 'meta.json'), JSON.stringify(meta));
    }

    const consentAt = req.body && req.body.consent === '1' ? Date.now() : null;
    const job = jobs.createJob({
      id: jobId,
      user_id: uid,
      original_name: `live-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}`,
      mime: `audio/${ext.slice(1)}`,
      size_bytes: size,
      source: 'live',
      status: 'uploaded',
      audio_path: finalPath,
      stt_provider: resolveProvider(req.body && req.body.model),
      encrypted: cs.enabled ? 1 : 0,
      upload_consent_at: consentAt,
    });

    // Session audio is now assembled into the job; drop the segment store.
    try { if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true }); }
    catch (e) { console.error('Session cleanup failed:', e.message); }

    setImmediate(pumpQueue);
    res.json({ jobId: job.id, status: job.status });
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
    gemini: !!GEMINI_API_KEY,
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

// ---------- Retention sweep (Phase 3) ----------
// Auto-delete jobs and their files RETENTION_DAYS after creation. Runs on boot
// and periodically; the window is a visible trust feature (surfaced in the UI),
// not a silent surprise. Manual "delete now" is the per-job counterpart above.
function sweepRetention() {
  try {
    const cutoff = Date.now() - RETENTION_MS;
    const stale = jobs.jobsOlderThan(cutoff);
    for (const j of stale) {
      deleteJobFiles(j);
      jobs.deleteJob(j.id);
    }
    if (stale.length) {
      console.log(`Retention sweep: deleted ${stale.length} job(s) older than ${RETENTION_DAYS} day(s)`);
    }
    // Also drop expired magic-link tokens and dead sessions.
    jobs.purgeExpiredAuth();
  } catch (e) {
    console.error('Retention sweep failed:', e.message);
  }
}
const RETENTION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // every 6h

const server = app.listen(PORT, () => {
  console.log(`Meeting notes app listening on port ${PORT}`);
  // Survive restarts: re-queue any job stranded mid-run by a crash/pm2 restart,
  // then start draining the queue.
  const requeued = jobs.resetStuckJobs();
  if (requeued) console.log(`Re-queued ${requeued} interrupted job(s) after restart`);
  setImmediate(pumpQueue);
  // Retention: sweep once on boot, then on a fixed interval.
  sweepRetention();
  setInterval(sweepRetention, RETENTION_SWEEP_INTERVAL_MS);
});
// Transcribing a long meeting can exceed Node's 5-minute default request timeout.
server.requestTimeout = 45 * 60 * 1000;
server.headersTimeout = 46 * 60 * 1000;
