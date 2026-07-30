// Unit tests for cryptostore.js — envelope encryption round-trips + tamper
// rejection. No server needed. Sets the flag/key BEFORE requiring the module
// (it reads env at load time).
import { createRequire } from 'module';
import crypto from 'crypto';
const require = createRequire(import.meta.url);

process.env.ENCRYPT_AT_REST = '1';
process.env.MASTER_KEY = crypto.randomBytes(32).toString('base64');
const cs = require('./cryptostore.js');

import fs from 'fs';
import os from 'os';
import path from 'path';

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

ok('module reports enabled', cs.enabled === true);

// ---------- data key wrap/unwrap ----------
{
  const dek = cs.newDataKey();
  ok('data key is 32 bytes', dek.length === 32);
  const wrapped = cs.wrapKey(dek);
  ok('wrapped key is a base64 string', typeof wrapped === 'string' && wrapped.length > 0);
  ok('unwrap round-trips the DEK', cs.unwrapKey(wrapped).equals(dek));
  ok('wrapped key is not the raw key', !wrapped.includes(dek.toString('base64')));
}

// ---------- buffer encrypt/decrypt ----------
{
  const dek = cs.newDataKey();
  const plain = Buffer.from('the quick brown fox 你好 apa khabar');
  const enc = cs.encrypt(dek, plain);
  ok('ciphertext carries the magic header', cs.isEncrypted(enc));
  ok('ciphertext differs from plaintext', !enc.subarray(4).equals(plain));
  ok('decrypt round-trips the buffer', cs.decrypt(dek, enc).equals(plain));
  ok('plaintext passes through decrypt unchanged', cs.decrypt(dek, plain).equals(plain));

  // GCM tamper rejection.
  const tampered = Buffer.from(enc);
  tampered[tampered.length - 1] ^= 0xff;
  let threw = false;
  try { cs.decrypt(dek, tampered); } catch { threw = true; }
  ok('tampered ciphertext is rejected', threw);

  // Wrong key rejected.
  let threw2 = false;
  try { cs.decrypt(cs.newDataKey(), enc); } catch { threw2 = true; }
  ok('wrong key is rejected', threw2);
}

// ---------- text encrypt/decrypt ----------
{
  const dek = cs.newDataKey();
  const s = 'Speaker 0 [00:00]: budget is RM50,000 [UNCLEAR]';
  const enc = cs.encryptText(dek, s);
  ok('encrypted text carries enc1: prefix', enc.startsWith(cs.TEXT_PREFIX));
  ok('encrypted text round-trips', cs.decryptText(dek, enc) === s);
  ok('legacy plaintext text passes through', cs.decryptText(dek, 'plain old text') === 'plain old text');
  ok('null text passes through', cs.encryptText(dek, null) == null);
}

// ---------- file encrypt-in-place / decrypt-to-temp ----------
{
  const dek = cs.newDataKey();
  const src = path.join(os.tmpdir(), `csrc-${Date.now()}.bin`);
  const bytes = crypto.randomBytes(4096);
  fs.writeFileSync(src, bytes);
  cs.encryptFileInPlace(dek, src);
  const onDisk = fs.readFileSync(src);
  ok('file on disk is ciphertext (magic header, not plaintext)', cs.isEncrypted(onDisk) && !onDisk.subarray(4).equals(bytes));
  cs.encryptFileInPlace(dek, src); // idempotent
  ok('encryptFileInPlace is idempotent', cs.decrypt(dek, fs.readFileSync(src)).equals(bytes));
  const tmp = cs.decryptToTemp(dek, src);
  ok('decryptToTemp yields the original plaintext', fs.readFileSync(tmp).equals(bytes));
  fs.unlinkSync(src); fs.unlinkSync(tmp);
}

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
