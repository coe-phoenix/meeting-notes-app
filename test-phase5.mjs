// Phase 5 verification: magic-link auth, per-user job isolation, monthly quota,
// and account deletion. Self-contained — it spawns its OWN server with AUTH=magic
// on a throwaway DATA_DIR and port, so it doesn't touch your real DB or the
// :3000 server the other suites use. No email provider needed: with RESEND unset
// the server logs the magic link, which we scrape from its stdout.
import { createRequire } from 'module';
import { spawn } from 'child_process';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const require = createRequire(import.meta.url);
// Point OUR db handle at the same throwaway dir the server child will use, so we
// can seed jobs/usage and read back what the server wrote.
const DATA_DIR = mkdtempSync(join(tmpdir(), 'mn-p5-'));
process.env.DATA_DIR = DATA_DIR;
const db = require('./db.js');

const PORT = 3100;
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
    QUOTA_MINUTES: '60', RESEND_API_KEY: '', APP_PASSWORD: '',
    SONIOX_API_KEY: '', ANTHROPIC_API_KEY: '', DATA_DIR,
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
    try { if ((await fetch(`${BASE}/healthz`)).ok) return true; } catch { /* not up yet */ }
    await sleep(150);
  }
  return false;
}

// Drive the magic-link flow end to end, returning a Cookie header for the user.
async function login(email) {
  const before = out.length;
  const r = await fetch(`${BASE}/api/auth/request`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }),
  });
  if (!r.ok) throw new Error('auth/request failed');
  const esc = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`magic link for ${esc}: (\\S+)`);
  const link = await waitFor(() => { const m = out.slice(before).match(re); return m && m[1]; });
  if (!link) throw new Error('magic link not found in server log');
  const vr = await fetch(link, { redirect: 'manual' });
  const setCookie = vr.headers.get('set-cookie') || '';
  const token = (/mn_session=([^;]+)/.exec(setCookie) || [])[1];
  if (!token) throw new Error('no session cookie set on verify');
  return `mn_session=${token}`;
}
const authed = (cookie, extra = {}) => ({ ...extra, headers: { ...(extra.headers || {}), Cookie: cookie } });

async function run() {
  if (!(await waitForServer())) { console.error('server did not start\n' + out); process.exit(1); }

  // 1) Gate: unauthenticated API access is refused.
  ok('unauthenticated /api/jobs is 401', (await fetch(`${BASE}/api/jobs`)).status === 401);

  // 2) Magic-link login mints a session.
  const cookieA = await login('alice@example.com');
  const cookieB = await login('bob@example.com');
  const meA = await (await fetch(`${BASE}/api/me`, authed(cookieA))).json();
  ok('logged-in /api/me returns the user', meA.authEnabled === true && meA.user.email === 'alice@example.com');
  ok('new user has no consent yet', meA.user.consentAt == null);

  const alice = db.getUserByEmail('alice@example.com');
  const bob = db.getUserByEmail('bob@example.com');
  ok('both users exist in the DB', !!alice && !!bob && alice.id !== bob.id);

  // 3) Consent (PDPA) is recorded.
  const consent = await (await fetch(`${BASE}/api/me/consent`, authed(cookieA, { method: 'POST' }))).json();
  ok('consent is recorded', consent.ok === true && consent.consentAt > 0);

  // 4) Isolation: each user only sees their own jobs.
  const jobA = db.createJob({ user_id: alice.id, source: 'upload', status: 'ready', markdown: 'A summary', original_name: 'a-job' });
  const jobB = db.createJob({ user_id: bob.id, source: 'upload', status: 'ready', markdown: 'B summary', original_name: 'b-job' });
  const listA = await (await fetch(`${BASE}/api/jobs`, authed(cookieA))).json();
  ok('alice lists only her job', listA.jobs.length === 1 && listA.jobs[0].id === jobA.id);
  ok("alice cannot read bob's job (404)", (await fetch(`${BASE}/api/jobs/${jobB.id}`, authed(cookieA))).status === 404);
  ok('bob can read his own job', (await fetch(`${BASE}/api/jobs/${jobB.id}`, authed(cookieB))).status === 200);
  ok("alice cannot download bob's summary", (await fetch(`${BASE}/api/jobs/${jobB.id}/download/summary.md`, authed(cookieA))).status === 404);

  // 5) Quota: seed usage over the 60-minute cap → new jobs blocked; under-cap user is fine.
  db.addUsage({ user_id: alice.id, job_id: null, minutes: 100 });
  const qMe = await (await fetch(`${BASE}/api/me`, authed(cookieA))).json();
  ok('quota usage is reported', qMe.quota.minutesUsed >= 100 && qMe.quota.minutesLimit === 60);
  const overRes = await fetch(`${BASE}/api/uploads`, authed(cookieA, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: 'x.webm', size: 10, mime: 'audio/webm' }),
  }));
  ok('over-quota upload is blocked (429)', overRes.status === 429);
  const underRes = await fetch(`${BASE}/api/uploads`, authed(cookieB, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: 'y.webm', size: 10, mime: 'audio/webm' }),
  }));
  ok('under-quota upload is allowed', underRes.status === 200);

  // 6) Admin usage view is admin-only (neither alice nor bob is admin here).
  ok('non-admin blocked from /api/admin/usage', (await fetch(`${BASE}/api/admin/usage`, authed(cookieA))).status === 403);

  // 7) Account deletion removes everything and invalidates the session.
  const del = await fetch(`${BASE}/api/me`, authed(cookieA, { method: 'DELETE' }));
  const delData = await del.json();
  ok('account deletion succeeds', del.ok && delData.ok === true);
  ok('deleted user is gone from DB', db.getUserById(alice.id) == null);
  ok("deleted user's jobs are gone", db.listJobs(alice.id).length === 0);
  // GET /api/me is public (reports auth state), so check a PROTECTED route: the
  // deleted session must no longer authenticate.
  ok('deleted session no longer authenticates (401)', (await fetch(`${BASE}/api/jobs`, authed(cookieA))).status === 401);
  ok('deleted session /api/me reports logged-out', (await (await fetch(`${BASE}/api/me`, authed(cookieA))).json()).user == null);
  ok("bob's data is untouched", db.getUserById(bob.id) != null && db.listJobs(bob.id).length === 1);

  console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'}`);
}

run()
  .catch((e) => { console.error(e); failures++; })
  .finally(() => { child.kill('SIGKILL'); process.exit(failures === 0 ? 0 : 1); });
