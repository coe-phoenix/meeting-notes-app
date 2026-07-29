// Phase 4 eval harness. Runs each case's transcript through the SAME summarise +
// faithfulness passes the server uses (prompts.js), and:
//   1. checks the generated summary passes the faithfulness audit, and
//   2. runs hand-written "probe" summaries to prove the audit catches invented
//      claims (expectPass:false) and accepts faithful ones (expectPass:true).
// Results are appended to eval/results.jsonl, tagged with the prompt versions,
// so regressions across prompt changes stay visible.
//
// Requires ANTHROPIC_API_KEY (loaded from .env). Without it, the harness skips
// rather than failing, so it's safe to wire into CI that lacks the secret.
//
// Run:  npm run eval
import { createRequire } from 'module';
import { readFileSync, readdirSync, appendFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const require = createRequire(import.meta.url);
require('dotenv').config();
const prompts = require('./../prompts.js');
const Anthropic = require('@anthropic-ai/sdk');

const HERE = dirname(fileURLToPath(import.meta.url));
const CASES_DIR = join(HERE, 'cases');
const RESULTS = join(HERE, 'results.jsonl');

if (!process.env.ANTHROPIC_API_KEY) {
  console.log('SKIP  eval — ANTHROPIC_API_KEY not set (set it in .env to run the eval set).');
  process.exit(0);
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

function loadCases() {
  return readdirSync(CASES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(CASES_DIR, f), 'utf8')));
}

async function run() {
  const cases = loadCases();
  const ts = new Date().toISOString();
  let failures = 0;

  console.log(`Eval — summary=${prompts.SUMMARY_PROMPT_VERSION}  faithfulness=${prompts.FAITHFULNESS_PROMPT_VERSION}\n`);

  for (const c of cases) {
    // 1. Generate a summary and audit it.
    const summary = await prompts.structureNotes(anthropic, c.transcript);
    const verdict = await prompts.faithfulnessCheck(anthropic, c.transcript, summary);
    const genOk = verdict.pass;
    if (!genOk) failures++;
    console.log(`${genOk ? 'PASS' : 'FAIL'}  ${c.name} — generated summary: ${verdict.supported}/${verdict.total} grounded`);
    if (!genOk) {
      for (const u of verdict.unsupported) console.log(`        ⚠ ${u.claim} — ${u.evidence}`);
    }

    // 2. Probe the auditor with hand-written summaries of known faithfulness.
    const probeResults = [];
    for (const p of c.probes || []) {
      const pv = await prompts.faithfulnessCheck(anthropic, c.transcript, p.summary);
      const correct = pv.pass === p.expectPass;
      if (!correct) failures++;
      probeResults.push({ name: p.name, expectPass: p.expectPass, gotPass: pv.pass, correct });
      console.log(`  ${correct ? 'PASS' : 'FAIL'}  ${c.name}/${p.name} — audit ${pv.pass ? 'passed' : 'flagged'} (expected ${p.expectPass ? 'pass' : 'flag'})`);
    }

    appendFileSync(RESULTS, JSON.stringify({
      ts,
      summaryPromptVersion: prompts.SUMMARY_PROMPT_VERSION,
      faithfulnessPromptVersion: prompts.FAITHFULNESS_PROMPT_VERSION,
      case: c.name,
      generated: { pass: genOk, total: verdict.total, supported: verdict.supported, unsupported: verdict.unsupported },
      probes: probeResults,
    }) + '\n');
  }

  console.log(`\n${failures === 0 ? 'EVAL PASSED' : failures + ' EVAL FAILURE(S)'}  — logged to eval/results.jsonl`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((e) => { console.error(e); process.exit(1); });
