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
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
  CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at);
`);

// Lightweight migrations: add columns introduced after a DB was first created.
// (CREATE TABLE IF NOT EXISTS won't alter an existing table.)
function ensureColumn(name, ddl) {
  const cols = db.prepare(`PRAGMA table_info(jobs)`).all().map((c) => c.name);
  if (!cols.includes(name)) db.exec(`ALTER TABLE jobs ADD COLUMN ${name} ${ddl}`);
}
ensureColumn('cleaned_transcript', 'TEXT');
ensureColumn('faithfulness', 'TEXT'); // JSON: Phase 4 faithfulness-audit result

// Terminal states never get picked up by the worker again.
const TERMINAL = new Set(['ready', 'failed']);
// Non-terminal, in-flight states that a crash/restart can strand mid-run.
const STUCK = ['transcribing', 'summarising'];

const stmts = {
  insert: db.prepare(`
    INSERT INTO jobs (id, user_id, original_name, mime, size_bytes, source, status,
                      duration_minutes, audio_path, raw_transcript, cleaned_transcript, markdown, faithfulness, created_at, updated_at)
    VALUES (@id, @user_id, @original_name, @mime, @size_bytes, @source, @status,
            @duration_minutes, @audio_path, @raw_transcript, @cleaned_transcript, @markdown, @faithfulness, @created_at, @updated_at)
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
};
