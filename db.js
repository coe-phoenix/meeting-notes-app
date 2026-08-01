// SQLite-backed job store (Phase 2). better-sqlite3 is synchronous, which is
// exactly what we want here: the job table is tiny and every call is a fast,
// transactional local read/write. WAL keeps concurrent reads snappy.
const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id               TEXT PRIMARY KEY,
    user_id          TEXT NOT NULL DEFAULT 'local',
    original_name    TEXT,
    mime             TEXT,
    size_bytes       INTEGER,
    source           TEXT NOT NULL DEFAULT 'upload',  -- 'upload' | 'live'
    status           TEXT NOT NULL,                    -- uploaded|transcribing|summarising|ready|failed
    error            TEXT,
    duration_minutes REAL,
    audio_path       TEXT,
    raw_transcript   TEXT,
    cleaned_transcript TEXT,
    markdown         TEXT,
    faithfulness     TEXT,
    stt_provider     TEXT NOT NULL DEFAULT 'soniox',
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
  CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);

  -- Phase 5: accounts, sessions, magic-link tokens, and usage (for quotas).
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT UNIQUE NOT NULL,
    is_admin      INTEGER NOT NULL DEFAULT 0,
    consent_at    INTEGER,
    marketing_consent_at INTEGER,
    created_at    INTEGER NOT NULL,
    last_login_at INTEGER
  );
  -- One-time magic-link tokens (stored hashed; short-lived; single-use).
  CREATE TABLE IF NOT EXISTS login_tokens (
    token_hash  TEXT PRIMARY KEY,
    email       TEXT NOT NULL,
    expires_at  INTEGER NOT NULL,
    consumed_at INTEGER,
    created_at  INTEGER NOT NULL
  );
  -- Server-side sessions (cookie holds the raw token; we store only its hash).
  CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );
  -- Transcribed-minutes ledger. Kept SEPARATE from jobs so quota accounting
  -- survives the retention sweep that deletes old jobs.
  CREATE TABLE IF NOT EXISTS usage_events (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    job_id     TEXT,
    minutes    REAL NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_events(user_id, created_at);

  -- Phase 5.5: per-user data keys (wrapped by the server master key) for
  -- envelope encryption at rest. Keyed by user_id so it works with AUTH on or
  -- off (the single-user 'local' id gets a key too).
  CREATE TABLE IF NOT EXISTS data_keys (
    user_id    TEXT PRIMARY KEY,
    wrapped    TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  -- Phase 5.5: abuse reports (basic moderation path).
  CREATE TABLE IF NOT EXISTS reports (
    id         TEXT PRIMARY KEY,
    job_id     TEXT,
    reporter   TEXT,
    reason     TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  -- Simple key/value app settings (admin-editable, e.g. the AI-pipeline prompt).
  CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at INTEGER NOT NULL
  );
`);

// Lightweight migrations: add columns introduced after a DB was first created.
// (CREATE TABLE IF NOT EXISTS won't alter an existing table.)
function ensureColumn(table, name, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${ddl}`);
}
ensureColumn('jobs', 'cleaned_transcript', 'TEXT');
ensureColumn('jobs', 'faithfulness', 'TEXT'); // JSON: Phase 4 faithfulness-audit result
ensureColumn('jobs', 'stt_provider', "TEXT NOT NULL DEFAULT 'soniox'"); // 'soniox' | 'gemini'
ensureColumn('users', 'marketing_consent_at', 'INTEGER'); // opt-in to product marketing (Phase 5)
ensureColumn('users', 'suspended_at', 'INTEGER'); // admin suspend (Phase 5.5)
ensureColumn('jobs', 'encrypted', 'INTEGER NOT NULL DEFAULT 0'); // 1 = audio+text encrypted at rest
ensureColumn('jobs', 'upload_consent_at', 'INTEGER'); // per-upload "I have consent" timestamp
ensureColumn('users', 'telegram_chat_id', 'TEXT'); // per-user Telegram destination (remembered)

// Terminal states never get picked up by the worker again.
const TERMINAL = new Set(['ready', 'failed']);
// Non-terminal, in-flight states that a crash/restart can strand mid-run.
const STUCK = ['transcribing', 'summarising'];

const stmts = {
  insert: db.prepare(`
    INSERT INTO jobs (id, user_id, original_name, mime, size_bytes, source, status,
                      duration_minutes, audio_path, raw_transcript, cleaned_transcript, markdown, faithfulness, stt_provider, encrypted, upload_consent_at, created_at, updated_at)
    VALUES (@id, @user_id, @original_name, @mime, @size_bytes, @source, @status,
            @duration_minutes, @audio_path, @raw_transcript, @cleaned_transcript, @markdown, @faithfulness, @stt_provider, @encrypted, @upload_consent_at, @created_at, @updated_at)
  `),
  get: db.prepare(`SELECT * FROM jobs WHERE id = ?`),
  listAll: db.prepare(`SELECT * FROM jobs ORDER BY created_at DESC`),
  listByUser: db.prepare(`SELECT * FROM jobs WHERE user_id = ? ORDER BY created_at DESC`),
  nextQueued: db.prepare(`SELECT * FROM jobs WHERE status = 'uploaded' ORDER BY created_at ASC LIMIT 1`),
  olderThan: db.prepare(`SELECT * FROM jobs WHERE created_at < ?`),
  del: db.prepare(`DELETE FROM jobs WHERE id = ?`),
};

function now() { return Date.now(); }

function createJob(fields) {
  const job = {
    id: fields.id || crypto.randomUUID(),
    user_id: fields.user_id || 'local',
    original_name: fields.original_name || null,
    mime: fields.mime || null,
    size_bytes: fields.size_bytes != null ? fields.size_bytes : null,
    source: fields.source || 'upload',
    status: fields.status || 'uploaded',
    duration_minutes: fields.duration_minutes != null ? fields.duration_minutes : null,
    audio_path: fields.audio_path || null,
    raw_transcript: fields.raw_transcript || null,
    cleaned_transcript: fields.cleaned_transcript || null,
    markdown: fields.markdown || null,
    faithfulness: fields.faithfulness || null,
    stt_provider: fields.stt_provider || 'soniox',
    encrypted: fields.encrypted ? 1 : 0,
    upload_consent_at: fields.upload_consent_at != null ? fields.upload_consent_at : null,
    created_at: now(),
    updated_at: now(),
  };
  stmts.insert.run(job);
  return job;
}

function getJob(id) {
  return stmts.get.get(id);
}

function listJobs(userId) {
  return userId ? stmts.listByUser.all(userId) : stmts.listAll.all();
}

function nextQueuedJob() {
  return stmts.nextQueued.get();
}

// Partial update by whitelisted columns; always bumps updated_at.
const UPDATABLE = new Set([
  'status', 'error', 'duration_minutes', 'audio_path',
  'raw_transcript', 'cleaned_transcript', 'markdown', 'faithfulness', 'original_name', 'mime', 'size_bytes',
  'encrypted', 'upload_consent_at',
]);
function updateJob(id, patch) {
  const keys = Object.keys(patch).filter((k) => UPDATABLE.has(k));
  if (!keys.length) return getJob(id);
  const setClause = keys.map((k) => `${k} = @${k}`).join(', ');
  const stmt = db.prepare(`UPDATE jobs SET ${setClause}, updated_at = @updated_at WHERE id = @id`);
  stmt.run({ ...patch, id, updated_at: now() });
  return getJob(id);
}

function deleteJob(id) {
  return stmts.del.run(id);
}

// Jobs created before the given cutoff timestamp (for retention sweeps).
function jobsOlderThan(cutoffMs) {
  return stmts.olderThan.all(cutoffMs);
}

// ---------- Phase 5: users / sessions / tokens / usage ----------
const authStmts = {
  insertUser: db.prepare(`INSERT INTO users (id, email, is_admin, consent_at, created_at, last_login_at)
                          VALUES (@id, @email, @is_admin, @consent_at, @created_at, @last_login_at)`),
  userByEmail: db.prepare(`SELECT * FROM users WHERE email = ?`),
  userById: db.prepare(`SELECT * FROM users WHERE id = ?`),
  allUsers: db.prepare(`SELECT * FROM users ORDER BY created_at ASC`),
  setConsent: db.prepare(`UPDATE users SET consent_at = ? WHERE id = ?`),
  setMarketing: db.prepare(`UPDATE users SET marketing_consent_at = ? WHERE id = ?`),
  marketingOptIns: db.prepare(`SELECT email, created_at, marketing_consent_at FROM users
                               WHERE marketing_consent_at IS NOT NULL ORDER BY marketing_consent_at ASC`),
  setLastLogin: db.prepare(`UPDATE users SET last_login_at = ? WHERE id = ?`),
  setSuspended: db.prepare(`UPDATE users SET suspended_at = ? WHERE id = ?`),
  setAdmin: db.prepare(`UPDATE users SET is_admin = ? WHERE id = ?`),
  setTelegram: db.prepare(`UPDATE users SET telegram_chat_id = ? WHERE id = ?`),
  delUser: db.prepare(`DELETE FROM users WHERE id = ?`),

  // Phase 5.5 — per-user wrapped data keys + abuse reports.
  getDataKey: db.prepare(`SELECT * FROM data_keys WHERE user_id = ?`),
  insertDataKey: db.prepare(`INSERT INTO data_keys (user_id, wrapped, created_at) VALUES (@user_id, @wrapped, @created_at)`),
  updateDataKey: db.prepare(`UPDATE data_keys SET wrapped = ? WHERE user_id = ?`),
  allDataKeys: db.prepare(`SELECT * FROM data_keys`),
  delDataKey: db.prepare(`DELETE FROM data_keys WHERE user_id = ?`),
  insertReport: db.prepare(`INSERT INTO reports (id, job_id, reporter, reason, created_at)
                            VALUES (@id, @job_id, @reporter, @reason, @created_at)`),
  listReports: db.prepare(`SELECT * FROM reports ORDER BY created_at DESC`),

  insertToken: db.prepare(`INSERT INTO login_tokens (token_hash, email, expires_at, consumed_at, created_at)
                           VALUES (@token_hash, @email, @expires_at, NULL, @created_at)`),
  getToken: db.prepare(`SELECT * FROM login_tokens WHERE token_hash = ?`),
  consumeToken: db.prepare(`UPDATE login_tokens SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL`),
  purgeTokens: db.prepare(`DELETE FROM login_tokens WHERE expires_at < ?`),

  insertSession: db.prepare(`INSERT INTO auth_sessions (token_hash, user_id, expires_at, created_at)
                             VALUES (@token_hash, @user_id, @expires_at, @created_at)`),
  getSession: db.prepare(`SELECT * FROM auth_sessions WHERE token_hash = ?`),
  delSession: db.prepare(`DELETE FROM auth_sessions WHERE token_hash = ?`),
  delUserSessions: db.prepare(`DELETE FROM auth_sessions WHERE user_id = ?`),
  purgeSessions: db.prepare(`DELETE FROM auth_sessions WHERE expires_at < ?`),

  insertUsage: db.prepare(`INSERT INTO usage_events (id, user_id, job_id, minutes, created_at)
                           VALUES (@id, @user_id, @job_id, @minutes, @created_at)`),
  usageSince: db.prepare(`SELECT COALESCE(SUM(minutes), 0) AS mins FROM usage_events WHERE user_id = ? AND created_at >= ?`),
  usageByUserSince: db.prepare(`SELECT user_id, COALESCE(SUM(minutes), 0) AS mins, COUNT(*) AS jobs
                                FROM usage_events WHERE created_at >= ? GROUP BY user_id`),
  usageForJob: db.prepare(`SELECT 1 FROM usage_events WHERE job_id = ? LIMIT 1`),
  delUserUsage: db.prepare(`DELETE FROM usage_events WHERE user_id = ?`),
};

function createUser({ email, is_admin = 0 }) {
  const user = {
    id: crypto.randomUUID(),
    email: String(email).toLowerCase().trim(),
    is_admin: is_admin ? 1 : 0,
    consent_at: null,
    created_at: now(),
    last_login_at: null,
  };
  authStmts.insertUser.run(user);
  return user;
}
function getUserByEmail(email) { return authStmts.userByEmail.get(String(email).toLowerCase().trim()); }
function getUserById(id) { return authStmts.userById.get(id); }
function listUsers() { return authStmts.allUsers.all(); }
function setUserConsent(id) { authStmts.setConsent.run(now(), id); return getUserById(id); }
// Opt in/out of product marketing. Opt-in stamps the time; opt-out clears it —
// so the export always reflects current, withdrawable consent.
function setUserMarketing(id, optIn) { authStmts.setMarketing.run(optIn ? now() : null, id); return getUserById(id); }
function listMarketingOptIns() { return authStmts.marketingOptIns.all(); }
function setUserLastLogin(id) { authStmts.setLastLogin.run(now(), id); }
// Admin suspend/unsuspend (Phase 5.5). Suspended users can't authenticate.
function setUserSuspended(id, suspended) { authStmts.setSuspended.run(suspended ? now() : null, id); return getUserById(id); }
// Keep is_admin in sync with ADMIN_EMAILS on login (env is the source of truth).
function setUserAdmin(id, isAdmin) { authStmts.setAdmin.run(isAdmin ? 1 : 0, id); return getUserById(id); }
// Per-user Telegram destination (remembered; used as the default when sending).
function setUserTelegram(id, chatId) { authStmts.setTelegram.run(chatId || null, id); return getUserById(id); }

// ---------- Phase 5.5: data keys + reports ----------
// db stays crypto-agnostic: the server wraps/unwraps; here we just persist the
// already-wrapped key. Returns the row ({ user_id, wrapped, created_at }) or null.
function getDataKey(userId) { return authStmts.getDataKey.get(userId); }
function saveDataKey(userId, wrapped) {
  authStmts.insertDataKey.run({ user_id: userId, wrapped, created_at: now() });
  return authStmts.getDataKey.get(userId);
}
function rewrapDataKey(userId, wrapped) { authStmts.updateDataKey.run(wrapped, userId); }
function listDataKeys() { return authStmts.allDataKeys.all(); }
// ---------- App settings (key/value) ----------
const settingsStmts = {
  get: db.prepare(`SELECT value FROM settings WHERE key = ?`),
  set: db.prepare(`INSERT INTO settings (key, value, updated_at) VALUES (@key, @value, @updated_at)
                   ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = @updated_at`),
};
function getSetting(key) { const r = settingsStmts.get.get(key); return r ? r.value : null; }
function setSetting(key, value) { settingsStmts.set.run({ key, value, updated_at: now() }); return value; }

function addReport({ job_id, reporter, reason }) {
  const row = { id: crypto.randomUUID(), job_id: job_id || null, reporter: reporter || null, reason, created_at: now() };
  authStmts.insertReport.run(row);
  return row;
}
function listReports() { return authStmts.listReports.all(); }

function createLoginToken(tokenHash, email, ttlMs) {
  authStmts.insertToken.run({
    token_hash: tokenHash,
    email: String(email).toLowerCase().trim(),
    expires_at: now() + ttlMs,
    created_at: now(),
  });
}
// Returns the token row if valid + unexpired + unconsumed, marking it consumed.
// Atomic-ish: the UPDATE ... WHERE consumed_at IS NULL guards against reuse.
function consumeLoginToken(tokenHash) {
  const row = authStmts.getToken.get(tokenHash);
  if (!row) return null;
  if (row.consumed_at != null) return null;
  if (row.expires_at < now()) return null;
  const info = authStmts.consumeToken.run(now(), tokenHash);
  return info.changes === 1 ? row : null;
}

function createSession(tokenHash, userId, ttlMs) {
  authStmts.insertSession.run({
    token_hash: tokenHash, user_id: userId, expires_at: now() + ttlMs, created_at: now(),
  });
}
function getSession(tokenHash) {
  const row = authStmts.getSession.get(tokenHash);
  if (!row) return null;
  if (row.expires_at < now()) { authStmts.delSession.run(tokenHash); return null; }
  return row;
}
function deleteSession(tokenHash) { authStmts.delSession.run(tokenHash); }

function addUsage({ user_id, job_id, minutes }) {
  authStmts.insertUsage.run({
    id: crypto.randomUUID(), user_id, job_id: job_id || null,
    minutes: minutes || 0, created_at: now(),
  });
}
function usageMinutesSince(userId, sinceMs) { return authStmts.usageSince.get(userId, sinceMs).mins || 0; }
function usageByUserSince(sinceMs) { return authStmts.usageByUserSince.all(sinceMs); }
function hasUsageForJob(jobId) { return !!authStmts.usageForJob.get(jobId); }

// Purge expired tokens/sessions (housekeeping, called on the retention sweep).
function purgeExpiredAuth() {
  authStmts.purgeTokens.run(now());
  authStmts.purgeSessions.run(now());
}

// Full account teardown: returns the user's jobs (so the caller can delete their
// files) then removes jobs, usage, sessions, and the user row.
const delJobsByUser = db.prepare(`DELETE FROM jobs WHERE user_id = ?`);
function deleteUserCompletely(userId) {
  const userJobs = stmts.listByUser.all(userId);
  const tx = db.transaction(() => {
    delJobsByUser.run(userId);
    authStmts.delUserUsage.run(userId);
    authStmts.delUserSessions.run(userId);
    authStmts.delDataKey.run(userId); // their key can never decrypt anything again
    authStmts.delUser.run(userId);
  });
  tx();
  return userJobs;
}

// On boot, any job left mid-flight (transcribing/summarising) was interrupted by
// a crash/restart. Processing is idempotent (re-run from the stored audio file),
// so reset them to 'uploaded' to be re-queued.
function resetStuckJobs() {
  const placeholders = STUCK.map(() => '?').join(', ');
  const stmt = db.prepare(
    `UPDATE jobs SET status = 'uploaded', error = NULL, updated_at = ? WHERE status IN (${placeholders})`
  );
  const info = stmt.run(now(), ...STUCK);
  return info.changes;
}

module.exports = {
  db,
  TERMINAL,
  createJob,
  getJob,
  listJobs,
  nextQueuedJob,
  updateJob,
  deleteJob,
  jobsOlderThan,
  resetStuckJobs,
  // Phase 5 — accounts / sessions / tokens / usage
  createUser,
  getUserByEmail,
  getUserById,
  listUsers,
  setUserConsent,
  setUserMarketing,
  listMarketingOptIns,
  setUserLastLogin,
  createLoginToken,
  consumeLoginToken,
  createSession,
  getSession,
  deleteSession,
  addUsage,
  usageMinutesSince,
  usageByUserSince,
  hasUsageForJob,
  purgeExpiredAuth,
  deleteUserCompletely,
  // Phase 5.5 — suspend, admin sync, data keys, reports
  setUserSuspended,
  setUserAdmin,
  setUserTelegram,
  getDataKey,
  saveDataKey,
  rewrapDataKey,
  listDataKeys,
  addReport,
  listReports,
  getSetting,
  setSetting,
};
