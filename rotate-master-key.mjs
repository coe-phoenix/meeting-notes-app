// Master-key rotation (Phase 5.5). Re-wraps every per-user data key from an OLD
// master key to a NEW one. Data itself is NOT re-encrypted (the DEKs don't
// change) — only their wrapping — so this is fast and safe to run live-ish.
//
// Usage:
//   OLD_MASTER_KEY=<base64-32b> NEW_MASTER_KEY=<base64-32b> node rotate-master-key.mjs
//
// Afterwards, set MASTER_KEY=<NEW> in .env and restart. Take a DB backup first.
import { createRequire } from 'module';
import crypto from 'crypto';
const require = createRequire(import.meta.url);
const db = require('./db.js');

const OLD = Buffer.from(process.env.OLD_MASTER_KEY || '', 'base64');
const NEW = Buffer.from(process.env.NEW_MASTER_KEY || '', 'base64');
if (OLD.length !== 32 || NEW.length !== 32) {
  console.error('Set OLD_MASTER_KEY and NEW_MASTER_KEY to base64-encoded 32-byte keys.');
  process.exit(1);
}

// Same frame as cryptostore.sealWith/openWith: [iv(12)|tag(16)|ct].
function unwrap(key, wrappedB64) {
  const b = Buffer.from(wrappedB64, 'base64');
  const iv = b.subarray(0, 12), tag = b.subarray(12, 28), ct = b.subarray(28);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]);
}
function wrap(key, dek) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(dek), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
}

const rows = db.listDataKeys();
let n = 0;
for (const r of rows) {
  const dek = unwrap(OLD, r.wrapped); // throws if OLD is wrong → aborts, nothing changed
  db.rewrapDataKey(r.user_id, wrap(NEW, dek));
  n++;
}
console.log(`Re-wrapped ${n} data key(s). Now set MASTER_KEY to the new key and restart.`);
