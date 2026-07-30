// Envelope encryption at rest (Phase 5.5). Feature-flagged: only active when
// ENCRYPT_AT_REST=1 AND a 32-byte MASTER_KEY is set. Off by default, so existing
// deployments are untouched.
//
// Pattern (same shape as AWS KMS / Vault):
//   MASTER_KEY  → wraps each user's random data key (DEK)
//   DEK         → encrypts that user's audio/transcripts/summary
// The server must see plaintext to call Soniox/Gemini/Claude and to serve
// downloads, so this is NOT zero-knowledge — it protects a stolen disk/DB
// snapshot, which is the right threat model for a public multi-tenant app.
//
// All crypto is Node's built-in `crypto` (AES-256-GCM), no dependency.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MASTER_KEY_B64 = process.env.MASTER_KEY || '';
const FLAG = process.env.ENCRYPT_AT_REST === '1';

// Decode + validate the master key up front so we fail fast rather than
// half-encrypting with a bad key.
let masterKey = null;
if (FLAG) {
  if (!MASTER_KEY_B64) throw new Error('ENCRYPT_AT_REST=1 but MASTER_KEY is not set');
  masterKey = Buffer.from(MASTER_KEY_B64, 'base64');
  if (masterKey.length !== 32) {
    throw new Error(`MASTER_KEY must decode to 32 bytes (got ${masterKey.length}); generate one with: openssl rand -base64 32`);
  }
}

const enabled = FLAG && !!masterKey;

const MAGIC = Buffer.from('MNE1');       // file/buffer frame marker
const TEXT_PREFIX = 'enc1:';             // DB-text marker (self-describing)
const IV_LEN = 12;
const TAG_LEN = 16;

// ---------- low-level AES-256-GCM with a given key ----------
function sealWith(key, plaintextBuf) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintextBuf), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ct]); // [iv|tag|ct]
}
function openWith(key, sealedBuf) {
  const iv = sealedBuf.subarray(0, IV_LEN);
  const tag = sealedBuf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ct = sealedBuf.subarray(IV_LEN + TAG_LEN);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]); // throws on tamper
}

// ---------- data keys (DEK), wrapped by the master key ----------
function newDataKey() { return crypto.randomBytes(32); }
function wrapKey(dek) {
  if (!masterKey) throw new Error('encryption not enabled');
  return sealWith(masterKey, dek).toString('base64');
}
function unwrapKey(wrappedB64) {
  if (!masterKey) throw new Error('encryption not enabled');
  return openWith(masterKey, Buffer.from(wrappedB64, 'base64'));
}

// ---------- content: buffers ----------
// Framed with a magic header so encrypted files are self-identifying.
function encrypt(dek, buf) { return Buffer.concat([MAGIC, sealWith(dek, buf)]); }
function isEncrypted(buf) { return Buffer.isBuffer(buf) && buf.length >= 4 && buf.subarray(0, 4).equals(MAGIC); }
function decrypt(dek, buf) {
  if (!isEncrypted(buf)) return buf; // legacy plaintext passthrough
  return openWith(dek, buf.subarray(4));
}

// ---------- content: DB text ----------
function encryptText(dek, str) {
  if (str == null) return str;
  return TEXT_PREFIX + sealWith(dek, Buffer.from(String(str), 'utf8')).toString('base64');
}
function decryptText(dek, val) {
  if (typeof val !== 'string' || !val.startsWith(TEXT_PREFIX)) return val; // legacy plaintext
  return openWith(dek, Buffer.from(val.slice(TEXT_PREFIX.length), 'base64')).toString('utf8');
}

// ---------- content: files ----------
function encryptFileInPlace(dek, filePath) {
  const data = fs.readFileSync(filePath);
  if (isEncrypted(data)) return; // already encrypted; idempotent
  fs.writeFileSync(filePath, encrypt(dek, data));
}
// Decrypt an at-rest file to a fresh temp file, returning its path. Caller
// deletes it. Plaintext files pass through (copied) so callers are uniform.
function decryptToTemp(dek, filePath, ext = '') {
  const data = fs.readFileSync(filePath);
  const out = path.join(os.tmpdir(), `dec-${crypto.randomUUID()}${ext}`);
  fs.writeFileSync(out, isEncrypted(data) ? openWith(dek, data.subarray(4)) : data);
  return out;
}

module.exports = {
  enabled,
  newDataKey, wrapKey, unwrapKey,
  encrypt, decrypt, isEncrypted,
  encryptText, decryptText,
  encryptFileInPlace, decryptToTemp,
  MAGIC, TEXT_PREFIX,
};
