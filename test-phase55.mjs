// Phase 5.5 verification: encryption at rest, upload rate limiting, admin
// suspend, and abuse reports. Spawns its OWN server (AUTH=magic, ENCRYPT_AT_REST)
// on a throwaway DATA_DIR + port, so it never touches the real DB. No STT/AI keys
// needed — we exercise the storage/security layer, not the transcription pipeline.
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import crypto from 'crypto';

const require = createRequire(import.meta.url);
const DATA_DIR = mkdtempSync(join(tmpdir(), 'mn-p55-'));
const MASTER_KEY = crypto.randomBytes(32).toString('base64');
process.env.DATA_DIR = DATA_DIR;
process.env.ENCRYPT_AT_REST = '1';
process.env.MASTER_KEY = MASTER_KEY;
const db = require('./db.js');
const cs = require('./cryptostore.js'); // same MASTER_KEY → can wrap/unwrap like the server

const PORT = 3155;
const BASE = `http://localhost:${PORT}`;
let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let out = '';
const child = spawn('node', ['server.js'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(PORT), AUTH: 'magic', APP_BASE_URL: BASE,
    ENCRYPT_AT_REST: '1', MASTER_KEY,
    UPLOAD_RATE_PER_HOUR: '3', ADMIN_EMAILS: 'admin@example.com',
    RESEND_API_KEY: '', APP_PASSWORD: '', SONIOX_API_KEY: '', ANTHROPIC_API_KEY: '', DATA_DIR,
  },
});
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });

async function waitFor(pred, timeoutMs = 5000, step = 50) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { const v = pred(); if (v) return v; await sleep(step); }
  return null;
}
async function waitForServer() {
  await waitFor(() => out.includes(`listening on port ${PORT}`), 8000);
  for (let i = 0; i < 20; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return true; } catch { /* not up */ }
    await sleep(150);
  }
  return false;
}
async function login(email) {
  const before = out.length;
  await fetch(`${BASE}/api/auth/request`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
  });
  const esc = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const link = await waitFor(() => { const m = out.slice(before).match(new RegExp(`magic link for ${esc}: (\\S+)`)); return m && m[1]; });
  const vr = await fetch(link, { redirect: 'manual' });
  const token = (/mn_session=([^;]+)/.exec(vr.headers.get('set-cookie') || '') || [])[1];
  return `mn_session=${token}`;
}
const authed = (cookie, extra = {}) => ({ ...extra, headers: { ...(extra.headers || {}), Cookie: cookie } });

// Authenticated resumable upload of a buffer → returns jobId.
async function uploadBuffer(cookie, buf, { filename = 'clip.webm', mime = 'audio/webm' } = {}) {
  const init = await (await fetch(`${BASE}/api/uploads`, authed(cookie, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, size: buf.length, mime, consent: true }),
  }))).json();
  await fetch(`${BASE}/api/uploads/${init.uploadId}/0`, authed(cookie, {
    method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: buf,
  }));
  const done = await (await fetch(`${BASE}/api/uploads/${init.uploadId}/complete`, authed(cookie, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ totalChunks: 1 }),
  }))).json();
  return done.jobId;
}

async function run() {
  if (!(await waitForServer())) { console.error('server did not start\n' + out); process.exit(1); }
  ok('server reports encryptedAtRest', (await (await fetch(`${BASE}/api/config`)).json()).encryptedAtRest === true);

  const cookieA = await login('alice@example.com');
  await fetch(`${BASE}/api/me/consent`, authed(cookieA, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ marketing: false }),
  }));
  const alice = db.getUserByEmail('alice@example.com');

  // ---------- Audio encrypted at rest, but downloads decrypt ----------
  const audioBytes = Buffer.from('THIS-IS-FAKE-PLAINTEXT-AUDIO-' + 'x'.repeat(200));
  const jobId = await uploadBuffer(cookieA, audioBytes);
  ok('upload created a job', !!jobId);

  const jobRow = db.getJob(jobId);
  ok('job is flagged encrypted', jobRow.encrypted === 1);
  ok('per-upload consent was recorded', jobRow.upload_consent_at > 0);
  const onDisk = readFileSync(jobRow.audio_path);
  ok('audio on disk is ciphertext (magic header, not plaintext)',
    cs.isEncrypted(onDisk) && !onDisk.includes(Buffer.from('FAKE-PLAINTEXT-AUDIO')));
  const dl = Buffer.from(await (await fetch(`${BASE}/api/jobs/${jobId}/download/audio`, authed(cookieA))).arrayBuffer());
  ok('audio download returns the exact plaintext', dl.equals(audioBytes));

  // ---------- Transcript/summary encrypted at rest, but reads decrypt ----------
  // Seed the job's text layers through the same crypto path the worker uses.
  const dek = cs.unwrapKey(db.getDataKey(alice.id).wrapped);
  const rawText = 'Speaker 0 [00:00]: the secret budget is RM50,000';
  const md = '### 2026 — Meeting\n- Context: Speaker 0 said the budget is RM50,000 [00:00]';
  db.updateJob(jobId, {
    status: 'ready',
    raw_transcript: cs.encryptText(dek, rawText),
    markdown: cs.encryptText(dek, md),
  });
  const rowAfter = db.getJob(jobId);
  ok('raw transcript column is ciphertext (enc1: prefix)', rowAfter.raw_transcript.startsWith(cs.TEXT_PREFIX));
  ok('summary column is ciphertext (enc1: prefix)', rowAfter.markdown.startsWith(cs.TEXT_PREFIX));
  ok('secret text is NOT present in plaintext in the DB', !rowAfter.raw_transcript.includes('RM50,000'));

  const detail = await (await fetch(`${BASE}/api/jobs/${jobId}`, authed(cookieA))).json();
  ok('job detail decrypts the transcript', detail.job.rawTranscript === rawText);
  ok('job detail decrypts the summary', detail.job.markdown === md);
  const sumTxt = await (await fetch(`${BASE}/api/jobs/${jobId}/download/summary.md`, authed(cookieA))).text();
  ok('summary download decrypts', sumTxt.includes('RM50,000'));

  // ---------- Upload rate limit (3/hour in this run) ----------
  const carol = await login('carol@example.com');
  let got429 = false;
  for (let i = 0; i < 5; i++) {
    const r = await fetch(`${BASE}/api/uploads`, authed(carol, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'x.webm', size: 3, mime: 'audio/webm' }),
    }));
    if (r.status === 429) { got429 = true; break; }
  }
  ok('upload rate limit returns 429 after the cap', got429);

  // ---------- Admin suspend blocks the user ----------
  const cookieAdmin = await login('admin@example.com');
  const bob = await login('bob@example.com');
  const bobId = db.getUserByEmail('bob@example.com').id;
  const susp = await fetch(`${BASE}/api/admin/users/${bobId}/suspend`, authed(cookieAdmin, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ suspended: true }),
  }));
  ok('admin can suspend a user', susp.ok);
  ok('suspended user is blocked (403)', (await fetch(`${BASE}/api/jobs`, authed(bob))).status === 403);
  const nonAdmin = await fetch(`${BASE}/api/admin/users/${bobId}/suspend`, authed(cookieA, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ suspended: false }),
  }));
  ok('non-admin cannot suspend', nonAdmin.status === 403);

  // ---------- Abuse report is recorded ----------
  const rep = await fetch(`${BASE}/api/report`, authed(cookieA, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId, reason: 'test abuse' }),
  }));
  ok('report endpoint accepts a report', rep.ok);
  ok('report is stored', db.listReports().some((r) => r.reason === 'test abuse'));

  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'}`);
  child.kill();
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((e) => { console.error(e, '\n' + out); child.kill(); process.exit(1); });
