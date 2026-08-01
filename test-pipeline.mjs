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

// ---------- parseManifest (delimiter format) ----------
{
  const good = `[1. Product Specs] a POC
REPO: My POC!
SUMMARY: does x

<<<<FILE: README.md>>>>
# hi
some text
<<<<END>>>>

<<<<FILE: src/i.js>>>>
const x = \`template \${1}\`;
console.log(x);
<<<<END>>>>`;
  const r = pipeline.parseManifest(good);
  ok('parses a valid manifest', r && r.files.length === 2);
  ok('slugifies the repo name', r.repo === 'my-poc');
  ok('keeps summary', r.summary === 'does x');
  ok('keeps raw code verbatim (backticks/${} unescaped)', r.files[1].content.includes('`template ${1}`'));

  ok('returns null when no file blocks', pipeline.parseManifest('just prose, no files') === null);

  // Truncated trailing block (no <<<<END>>>>) is dropped; earlier complete ones kept.
  const truncated = `<<<<FILE: a.js>>>>\nok\n<<<<END>>>>\n<<<<FILE: b.js>>>>\nunterminated...`;
  const tr = pipeline.parseManifest(truncated);
  ok('drops an unterminated trailing block, keeps complete ones', tr.files.length === 1 && tr.files[0].path === 'a.js');

  // Path traversal + absolute paths are dropped.
  const evil = `<<<<FILE: ../escape>>>>\nx\n<<<<END>>>>\n<<<<FILE: /etc/passwd>>>>\ny\n<<<<END>>>>\n<<<<FILE: ok.txt>>>>\nz\n<<<<END>>>>`;
  const er = pipeline.parseManifest(evil);
  ok('drops traversal/absolute paths, keeps safe ones', er.files.length === 1 && er.files[0].path === 'ok.txt');

  // Oversized file is skipped.
  const big = 'x'.repeat(pipeline.MAX_FILE_BYTES + 1);
  const or = pipeline.parseManifest(`<<<<FILE: big>>>>\n${big}\n<<<<END>>>>\n<<<<FILE: small>>>>\nok\n<<<<END>>>>`);
  ok('skips oversized files', or.files.length === 1 && or.files[0].path === 'small');
}

// ---------- models / defaults ----------
ok('exposes a model list incl. the default', pipeline.MODELS.includes(pipeline.DEFAULT_MODEL));
ok('default instructions forbid deploy/secrets', /do NOT deploy/i.test(pipeline.DEFAULT_INSTRUCTIONS) && /do NOT write secrets/i.test(pipeline.DEFAULT_INSTRUCTIONS));
ok('default instructions require Claude (not OpenAI) for AI', /ANTHROPIC_API_KEY/.test(pipeline.DEFAULT_INSTRUCTIONS) && /do NOT use OpenAI/i.test(pipeline.DEFAULT_INSTRUCTIONS));

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
