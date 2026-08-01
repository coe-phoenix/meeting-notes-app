// Unit tests for pipeline.js manifest parsing + db settings. No network/server.
import { createRequire } from 'module';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
const require = createRequire(import.meta.url);
process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'mn-pipe-'));
const pipeline = require('./pipeline.js');
const db = require('./db.js');

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

// ---------- parseManifest ----------
{
  const good = 'Here is the plan...\n```json\n{"repo":"My POC!","summary":"does x","files":[{"path":"README.md","content":"# hi"},{"path":"src/i.js","content":"console.log(1)"}]}\n```';
  const r = pipeline.parseManifest(good);
  ok('parses a valid manifest', r && r.files.length === 2);
  ok('slugifies the repo name', r.repo === 'my-poc');
  ok('keeps summary', r.summary === 'does x');

  // Uses the LAST json block (earlier illustrative ones ignored).
  const twoBlocks = '```json\n{"files":[{"path":"a","content":"x"}]}\n```\nthen the real one:\n```json\n{"repo":"real","files":[{"path":"b.js","content":"y"}]}\n```';
  ok('uses the last json block', pipeline.parseManifest(twoBlocks).files[0].path === 'b.js');

  ok('returns null when no json block', pipeline.parseManifest('just prose, no manifest') === null);
  ok('returns null on invalid json', pipeline.parseManifest('```json\n{not json}\n```') === null);
  ok('returns null when files empty', pipeline.parseManifest('```json\n{"files":[]}\n```') === null);

  // Path traversal + absolute paths are dropped.
  const evil = '```json\n{"files":[{"path":"../escape","content":"x"},{"path":"/etc/passwd","content":"y"},{"path":"ok.txt","content":"z"}]}\n```';
  const er = pipeline.parseManifest(evil);
  ok('drops traversal/absolute paths, keeps safe ones', er.files.length === 1 && er.files[0].path === 'ok.txt');

  // Oversized file is skipped.
  const big = 'x'.repeat(pipeline.MAX_FILE_BYTES + 1);
  const or = pipeline.parseManifest(`\`\`\`json\n{"files":[{"path":"big","content":"${big}"},{"path":"small","content":"ok"}]}\n\`\`\``);
  ok('skips oversized files', or.files.length === 1 && or.files[0].path === 'small');
}

// ---------- models / defaults ----------
ok('exposes a model list incl. the default', pipeline.MODELS.includes(pipeline.DEFAULT_MODEL));
ok('default instructions forbid deploy/secrets', /do NOT deploy/i.test(pipeline.DEFAULT_INSTRUCTIONS) && /do NOT write secrets/i.test(pipeline.DEFAULT_INSTRUCTIONS));

// ---------- db settings ----------
{
  ok('unset setting is null', db.getSetting('nope') == null);
  db.setSetting('pipeline_model', 'claude-opus-5');
  ok('setSetting persists', db.getSetting('pipeline_model') === 'claude-opus-5');
  db.setSetting('pipeline_model', 'claude-sonnet-5');
  ok('setSetting upserts', db.getSetting('pipeline_model') === 'claude-sonnet-5');
}

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
