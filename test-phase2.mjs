// Phase 2 verification: resumable chunked upload -> job -> worker lifecycle,
// retry, size verification, boot re-scan, and ready-job downloads.
// Assumes the server is running on :3000 WITHOUT Soniox/Anthropic keys, so real
// processing fails fast (which is exactly what we assert for the failure paths).
// The "ready" download path is tested by seeding a ready job directly in SQLite.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const db = require('./db.js');

const BASE = 'http://localhost:3000';
let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForStatus(id, statuses, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const res = await fetch(`${BASE}/api/jobs/${id}`);
    const { job } = await res.json();
    if (statuses.includes(job.status)) return job;
    await sleep(400);
  }
  const res = await fetch(`${BASE}/api/jobs/${id}`);
  return (await res.json()).job;
}

async function uploadBuffer(buf, { filename = 'clip.webm', mime = 'audio/webm', chunkSize = 8, lieSize = null } = {}) {
  const initRes = await fetch(`${BASE}/api/uploads`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, size: lieSize != null ? lieSize : buf.length, mime }),
  });
  const { uploadId } = await initRes.json();
  const total = Math.max(1, Math.ceil(buf.length / chunkSize));
  for (let i = 0; i < total; i++) {
    const slice = buf.subarray(i * chunkSize, (i + 1) * chunkSize);
    const r = await fetch(`${BASE}/api/uploads/${uploadId}/${i}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: slice,
    });
    if (!r.ok) throw new Error('chunk PUT failed');
  }
  return { uploadId, total };
}

async function run() {
  // ---------- Test 1: resumable upload assembles + reports received chunks ----------
  {
    const buf = Buffer.from('hello-this-is-a-fake-audio-payload-1234567890', 'utf8');
    const { uploadId, total } = await uploadBuffer(buf, { chunkSize: 8 });

    const statusRes = await fetch(`${BASE}/api/uploads/${uploadId}`);
    const statusData = await statusRes.json();
    ok('upload status lists all received chunks', statusData.received.length === total,
      `received ${statusData.received.length}/${total}`);

    const doneRes = await fetch(`${BASE}/api/uploads/${uploadId}/complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ totalChunks: total }),
    });
    const doneData = await doneRes.json();
    ok('complete returns a jobId', doneRes.ok && !!doneData.jobId, doneData.error || '');

    // No API keys -> worker should transition uploaded -> (transcribing) -> failed.
    const job = await waitForStatus(doneData.jobId, ['failed', 'ready']);
    ok('worker processes the job to a terminal state', ['failed', 'ready'].includes(job.status), job.status);
    ok('failure surfaces a helpful error (missing SONIOX key)',
      job.status === 'ready' || /SONIOX/i.test(job.error || ''), job.error || '');

    // Retry a failed job -> back through the queue.
    if (job.status === 'failed') {
      const retryRes = await fetch(`${BASE}/api/jobs/${job.id}/retry`, { method: 'POST' });
      ok('retry accepted for failed job', retryRes.ok);
      const after = await waitForStatus(job.id, ['failed', 'ready']);
      ok('retried job reaches a terminal state again', ['failed', 'ready'].includes(after.status), after.status);
    }
  }

  // ---------- Test 2: size mismatch is rejected ----------
  {
    const buf = Buffer.from('too-small-for-the-claimed-size', 'utf8');
    const { uploadId, total } = await uploadBuffer(buf, { chunkSize: 8, lieSize: 999999 });
    const doneRes = await fetch(`${BASE}/api/uploads/${uploadId}/complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ totalChunks: total }),
    });
    ok('size mismatch rejected with 400', doneRes.status === 400);
    const body = await doneRes.json();
    ok('mismatch error explains itself', /size mismatch/i.test(body.error || ''), body.error || '');
  }

  // ---------- Test 3: missing chunk rejected ----------
  {
    const initRes = await fetch(`${BASE}/api/uploads`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'gap.webm', size: 20, mime: 'audio/webm' }),
    });
    const { uploadId } = await initRes.json();
    // Upload only chunk 0 but claim 2.
    await fetch(`${BASE}/api/uploads/${uploadId}/0`, {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('0123456789'),
    });
    const doneRes = await fetch(`${BASE}/api/uploads/${uploadId}/complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ totalChunks: 2 }),
    });
    ok('incomplete upload rejected with 400', doneRes.status === 400);
  }

  // ---------- Test 4: boot re-scan resets stranded jobs (db unit) ----------
  {
    const stuck = db.createJob({ original_name: 'stuck', status: 'transcribing', source: 'upload' });
    const changed = db.resetStuckJobs();
    const after = db.getJob(stuck.id);
    ok('resetStuckJobs re-queues in-flight jobs', after.status === 'uploaded' && changed >= 1, after.status);
    db.deleteJob(stuck.id);
  }

  // ---------- Test 5: ready-job downloads (seed a ready job directly) ----------
  {
    const ready = db.createJob({
      original_name: 'seeded-ready',
      source: 'live',
      status: 'ready',
      raw_transcript: 'Speaker 0: hello world raw transcript',
      markdown: '# Seeded summary\n- point one',
    });

    const detail = await (await fetch(`${BASE}/api/jobs/${ready.id}`)).json();
    ok('ready job detail exposes markdown + transcript',
      detail.job.markdown.includes('Seeded summary') && detail.job.rawTranscript.includes('raw transcript'));

    const sumRes = await fetch(`${BASE}/api/jobs/${ready.id}/download/summary.md`);
    const sumText = await sumRes.text();
    ok('summary.md downloads with content', sumRes.ok && sumText.includes('Seeded summary'));
    ok('summary.md has self-describing filename',
      /filename=".*meeting-summary\.md"/.test(sumRes.headers.get('content-disposition') || ''));

    const txtRes = await fetch(`${BASE}/api/jobs/${ready.id}/download/transcript.txt`);
    const txtText = await txtRes.text();
    ok('transcript.txt downloads with content', txtRes.ok && txtText.includes('raw transcript'));

    // Edit persistence.
    const putRes = await fetch(`${BASE}/api/jobs/${ready.id}/markdown`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ markdown: '# Edited summary' }),
    });
    ok('markdown edit saved', putRes.ok);
    const reread = await (await fetch(`${BASE}/api/jobs/${ready.id}`)).json();
    ok('edit persisted', reread.job.markdown === '# Edited summary');

    db.deleteJob(ready.id);
  }

  // ---------- Test 5b: Phase 3 layers, audio + zip downloads, manual delete ----------
  {
    const fs = require('fs');
    const path = require('path');
    // Seed a ready job with all three layers and a real audio file on disk.
    const audioPath = path.join(process.cwd(), 'uploads', `test-p3-${Date.now()}.webm`);
    fs.writeFileSync(audioPath, Buffer.from('fake-webm-audio-bytes'));
    const ready = db.createJob({
      original_name: 'seeded-p3',
      source: 'live',
      status: 'ready',
      raw_transcript: 'Speaker 0 [00:00]: raw layer text',
      cleaned_transcript: 'Speaker 0 [00:00]: cleaned layer text [UNCLEAR]',
      markdown: '# Seeded summary\n- point one [00:00]',
      faithfulness: JSON.stringify({ version: 'faithful-test', total: 2, supported: 2, unsupportedCount: 0, unsupported: [], pass: true }),
      audio_path: audioPath,
    });

    const detail = await (await fetch(`${BASE}/api/jobs/${ready.id}`)).json();
    ok('detail exposes cleaned layer + hasCleaned + expiresAt',
      detail.job.cleanedTranscript.includes('cleaned layer') &&
      detail.job.hasCleaned === true && detail.job.hasAudio === true &&
      typeof detail.job.expiresAt === 'number');
    ok('detail exposes parsed faithfulness verdict',
      detail.job.faithfulness && detail.job.faithfulness.pass === true && detail.job.faithfulness.total === 2);

    const clRes = await fetch(`${BASE}/api/jobs/${ready.id}/download/transcript-cleaned.txt`);
    const clText = await clRes.text();
    ok('cleaned transcript downloads with content', clRes.ok && clText.includes('[UNCLEAR]'));
    ok('cleaned transcript has self-describing filename',
      /filename=".*transcript-cleaned\.txt"/.test(clRes.headers.get('content-disposition') || ''));

    const auRes = await fetch(`${BASE}/api/jobs/${ready.id}/download/audio`);
    const auBuf = Buffer.from(await auRes.arrayBuffer());
    ok('original audio downloads bit-exact', auRes.ok && auBuf.toString() === 'fake-webm-audio-bytes');
    ok('audio has self-describing filename',
      /filename=".*meeting-audio\.webm"/.test(auRes.headers.get('content-disposition') || ''));

    const zipRes = await fetch(`${BASE}/api/jobs/${ready.id}/download/all.zip`);
    const zipBuf = Buffer.from(await zipRes.arrayBuffer());
    ok('all.zip downloads as a zip',
      zipRes.ok && zipRes.headers.get('content-type') === 'application/zip' &&
      zipBuf.length > 0 && zipBuf.slice(0, 2).toString() === 'PK');

    const delRes = await fetch(`${BASE}/api/jobs/${ready.id}`, { method: 'DELETE' });
    ok('manual delete succeeds', delRes.ok);
    const gone = await fetch(`${BASE}/api/jobs/${ready.id}`);
    ok('deleted job is gone (404)', gone.status === 404);
    ok('deleted job audio file removed from disk', !fs.existsSync(audioPath));
  }

  // ---------- Test 5c: transcription-model selection (masked model1/model2) ----------
  {
    const cfg = await (await fetch(`${BASE}/api/config`)).json();
    ok('config exposes masked models', Array.isArray(cfg.models)
      && cfg.models.some((m) => m.id === 'model1') && cfg.models.some((m) => m.id === 'model2'));
    ok('config reports a default model', typeof cfg.defaultModel === 'string');

    // A job stored with the Gemini provider surfaces as masked "model2".
    const gemJob = db.createJob({ source: 'upload', status: 'ready', markdown: 'g', stt_provider: 'gemini' });
    const gd = await (await fetch(`${BASE}/api/jobs/${gemJob.id}`)).json();
    ok('gemini job is masked as model2', gd.job.model === 'model2');
    db.deleteJob(gemJob.id);

    // Default (no provider) surfaces as model1.
    const sonJob = db.createJob({ source: 'upload', status: 'ready', markdown: 's' });
    const sd = await (await fetch(`${BASE}/api/jobs/${sonJob.id}`)).json();
    ok('default job is masked as model1', sd.job.model === 'model1');
    db.deleteJob(sonJob.id);

    // Upload-init carries the model choice through to the created job.
    const initRes = await fetch(`${BASE}/api/uploads`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'm.webm', size: 5, mime: 'audio/webm', model: 'model2' }),
    });
    const { uploadId } = await initRes.json();
    await fetch(`${BASE}/api/uploads/${uploadId}/0`, {
      method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: Buffer.from('audio'),
    });
    const done = await (await fetch(`${BASE}/api/uploads/${uploadId}/complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ totalChunks: 1 }),
    })).json();
    const created = db.getJob(done.jobId);
    ok('upload carries model2 -> gemini provider', created && created.stt_provider === 'gemini');
    db.deleteJob(done.jobId);
  }

  // ---------- Test 6: jobs list endpoint ----------
  {
    const res = await fetch(`${BASE}/api/jobs`);
    const data = await res.json();
    ok('jobs list returns an array', Array.isArray(data.jobs));
  }

  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'}`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(1); });
