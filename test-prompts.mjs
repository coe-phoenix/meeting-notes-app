// Deterministic unit tests for the faithfulness parse/score logic in prompts.js.
// No API key or server needed — pure functions only.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const prompts = require('./prompts.js');

let failures = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
  if (!cond) failures++;
};

// ---------- parseFaithfulness ----------
{
  const plain = '{"claims":[{"claim":"a","supported":true,"evidence":"x"}]}';
  ok('parses plain JSON', prompts.parseFaithfulness(plain).claims.length === 1);

  const fenced = '```json\n{"claims":[{"claim":"a","supported":false,"evidence":"nope"}]}\n```';
  ok('parses ```json fenced JSON', prompts.parseFaithfulness(fenced).claims[0].supported === false);

  const prosey = 'Here is the audit:\n{"claims":[]}\nHope that helps.';
  ok('parses JSON embedded in prose', Array.isArray(prompts.parseFaithfulness(prosey).claims));

  let threw = false;
  try { prompts.parseFaithfulness('not json at all'); } catch { threw = true; }
  ok('throws on unparseable text', threw);

  let threw2 = false;
  try { prompts.parseFaithfulness('{"nope":1}'); } catch { threw2 = true; }
  ok('throws when claims[] missing', threw2);
}

// ---------- scoreFaithfulness ----------
{
  const allGood = prompts.scoreFaithfulness({ claims: [
    { claim: 'a', supported: true }, { claim: 'b', supported: true },
  ] });
  ok('all-supported -> pass', allGood.pass === true && allGood.total === 2 && allGood.supported === 2 && allGood.unsupportedCount === 0);

  const oneBad = prompts.scoreFaithfulness({ claims: [
    { claim: 'a', supported: true },
    { claim: 'budget is 80k', supported: false, evidence: 'transcript says 50k' },
  ] });
  ok('one-unsupported -> fail', oneBad.pass === false && oneBad.unsupportedCount === 1);
  ok('unsupported list carries claim + evidence',
    oneBad.unsupported[0].claim === 'budget is 80k' && /50k/.test(oneBad.unsupported[0].evidence));

  const empty = prompts.scoreFaithfulness({ claims: [] });
  ok('no claims -> vacuously pass', empty.pass === true && empty.total === 0);

  ok('score is tagged with the prompt version', allGood.version === prompts.FAITHFULNESS_PROMPT_VERSION);
}

// ---------- prompt builders include the inputs ----------
{
  ok('summary prompt embeds the transcript + date',
    prompts.buildSummaryPrompt('HELLO_TX', '2026-07-29').includes('HELLO_TX')
    && prompts.buildSummaryPrompt('HELLO_TX', '2026-07-29').includes('2026-07-29'));
  ok('faithfulness prompt embeds transcript + summary',
    prompts.buildFaithfulnessPrompt('TX', 'SUM').includes('TX') && prompts.buildFaithfulnessPrompt('TX', 'SUM').includes('SUM'));
}

console.log(`\n${failures === 0 ? 'ALL PASSED' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
