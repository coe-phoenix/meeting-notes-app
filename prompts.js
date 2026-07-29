// Prompt logic + Claude passes, extracted so the server AND the eval harness
// share one source of truth (Phase 4: "rerun the eval set on every prompt change";
// "log eval results per prompt version"). Bump the *_PROMPT_VERSION strings
// whenever a prompt changes so eval logs stay attributable to a version.

const MODEL = 'claude-sonnet-5';

// Bump on any wording change to the corresponding prompt.
const CLEAN_PROMPT_VERSION = 'clean-v1-2026-07-28';
const SUMMARY_PROMPT_VERSION = 'summary-v2-context-2026-07-29';
const FAITHFULNESS_PROMPT_VERSION = 'faithful-v1-2026-07-29';

// ---------- Prompt builders (pure — easy to inspect and test) ----------
function buildCleanPrompt(rawTranscript) {
  return `You are cleaning a raw speech-to-text transcript from a Malaysian business meeting. The speech mixes English, Bahasa Melayu, Mandarin and Cantonese, sometimes within a single sentence. It is machine-generated and contains errors, especially on proper nouns, company names, and code-switched phrases. Speaker labels, [language] tags and [mm:ss] timestamps were added by the transcription engine.

Your task — clean, do not summarise:
1. Fix obvious transcription errors using context, especially proper nouns and code-switched phrases.
2. Remove NOTHING. Every utterance must remain — this is still a full transcript, not a summary. Do not condense, reorder, or drop filler.
3. Preserve the original language mix. Do not translate; keep phrases in the language spoken.
4. Keep the structure exactly: the \`Speaker N [mm:ss]:\` turn markers and \`[language]\` tags stay where they are.
5. Where a word or phrase is garbled and you cannot recover it confidently, replace only that span with [UNCLEAR] — never guess a name or number.

Output only the cleaned transcript, with the same structure and no preamble or commentary.

Raw transcript:
${rawTranscript}`;
}

// Phase 4 hardening: extractive, attributed, no invention, no interpretation.
// Output is a single "Context" record (the other sales-template fields were
// dropped as too interpretive / not wanted).
function buildSummaryPrompt(transcript, today) {
  return `You are turning a cleaned, speaker-labelled meeting transcript into a short, factual record. The meeting is Malaysian and mixes English, Bahasa Melayu, Mandarin and Cantonese. The transcript marks each speaker turn as \`Speaker N [mm:ss]:\` and tags languages as \`[language]\`.

Produce ONLY a Context summary — a faithful record of what was actually said. Follow these rules strictly:

1. Extractive, not interpretive. Stay close to the transcript's own wording. Do NOT add advice, conclusions, recommendations, opinions, sentiment, or "action items" that the speakers did not explicitly state.
2. Attribute every point to the speaker who said it — "Speaker 2 said …", "Speaker 1 asked …". Never state a claim as an independent fact: attribution is a summary, a bare assertion is interpretation.
3. Never invent names, numbers, dates, or commitments. If a term is garbled, keep it as [UNCLEAR]. Do not fill gaps with plausible guesses.
4. Preserve the original language where you quote — do not translate everything into English; add a short English gloss in brackets only where it aids comprehension.
5. Cite the audio: end each point with the [mm:ss] timestamp(s) of the turn(s) it came from. Use only timestamps that actually appear in the transcript; never invent one.

Output format — markdown, and nothing else:

### ${today} — <a 3–6 word descriptor of the meeting drawn from the transcript; if none is evident, use "Meeting">

- Context: <first attributed, extractive point> [mm:ss]
- <further attributed, extractive points, one per line> [mm:ss]

If the transcript has no substantive content (e.g. only a microphone test), say exactly that in a single bullet rather than inventing content.

Transcript:
${transcript}`;
}

// Second-model faithfulness audit: does the summary claim anything the
// transcript doesn't support? Returns strict JSON we parse + score.
function buildFaithfulnessPrompt(transcript, markdown) {
  return `You are auditing a meeting summary for faithfulness. You are given the TRANSCRIPT (the only ground truth) and a SUMMARY generated from it. List every substantive factual claim the summary makes, and for each decide whether the transcript supports it.

Rules:
- A claim is "supported" only if the transcript actually contains that information. Attribution wording ("Speaker 2 said X") is supported if Speaker 2 did say X in the transcript.
- Ignore template scaffolding: the date header, the word "Context", [NOT STATED] and [UNCLEAR] markers, and the [mm:ss] citations themselves. Judge only substantive factual claims.
- Use ONLY the transcript. Do not use outside knowledge.

Return ONLY a JSON object — no prose, no code fences — in exactly this shape:
{"claims":[{"claim":"<short restatement of the claim>","supported":true,"evidence":"<brief transcript quote or [mm:ss]>"}]}

For unsupported claims set "supported": false and use "evidence" to say why it isn't in the transcript.

TRANSCRIPT:
${transcript}

SUMMARY:
${markdown}`;
}

// ---------- Parsing + scoring (deterministic — unit-tested without a key) ----------
// Pull a JSON object out of a model response that may wrap it in ``` fences or
// stray prose. Returns the parsed object, or throws if nothing parseable.
function parseFaithfulness(text) {
  if (typeof text !== 'string') throw new Error('faithfulness response was not text');
  let s = text.trim();
  // Strip a leading ```json / ``` fence and trailing ```
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  // Fall back to the outermost { ... } if there's surrounding prose.
  if (s[0] !== '{') {
    const first = s.indexOf('{');
    const last = s.lastIndexOf('}');
    if (first === -1 || last === -1 || last < first) throw new Error('no JSON object in faithfulness response');
    s = s.slice(first, last + 1);
  }
  const parsed = JSON.parse(s);
  if (!parsed || !Array.isArray(parsed.claims)) throw new Error('faithfulness JSON missing claims[]');
  return parsed;
}

// Reduce parsed claims to a verdict. pass === no unsupported claims.
function scoreFaithfulness(parsed) {
  const claims = Array.isArray(parsed && parsed.claims) ? parsed.claims : [];
  const unsupported = claims.filter((c) => c && c.supported === false);
  return {
    version: FAITHFULNESS_PROMPT_VERSION,
    total: claims.length,
    supported: claims.length - unsupported.length,
    unsupportedCount: unsupported.length,
    unsupported: unsupported.map((c) => ({ claim: c.claim, evidence: c.evidence })),
    pass: unsupported.length === 0,
  };
}

// ---------- Claude passes (thin wrappers around the builders) ----------
function textOf(msg) {
  return msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
}

async function cleanTranscript(anthropic, rawTranscript) {
  const msg = await anthropic.messages.create({
    model: MODEL,
    // Generous ceiling: the cleaned transcript is roughly as long as the input.
    // Very long meetings could still hit this; that's an accepted limitation.
    max_tokens: 16000,
    messages: [{ role: 'user', content: buildCleanPrompt(rawTranscript) }],
  });
  return textOf(msg);
}

async function structureNotes(anthropic, transcript, attachments = [], today = new Date().toISOString().slice(0, 10)) {
  const content = [{ type: 'text', text: buildSummaryPrompt(transcript, today) }];
  for (const att of attachments) {
    if (att.mimetype === 'application/pdf') {
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: att.base64 } });
    } else if (att.mimetype && att.mimetype.startsWith('image/')) {
      content.push({ type: 'image', source: { type: 'base64', media_type: att.mimetype, data: att.base64 } });
    }
  }
  const msg = await anthropic.messages.create({ model: MODEL, max_tokens: 2000, messages: [{ role: 'user', content }] });
  return textOf(msg);
}

// Runs the audit and returns a scored verdict (throws if the model's JSON can't
// be parsed, so callers can decide whether to treat that as non-fatal).
async function faithfulnessCheck(anthropic, transcript, markdown) {
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2000,
    messages: [{ role: 'user', content: buildFaithfulnessPrompt(transcript, markdown) }],
  });
  return scoreFaithfulness(parseFaithfulness(textOf(msg)));
}

module.exports = {
  MODEL,
  CLEAN_PROMPT_VERSION,
  SUMMARY_PROMPT_VERSION,
  FAITHFULNESS_PROMPT_VERSION,
  buildCleanPrompt,
  buildSummaryPrompt,
  buildFaithfulnessPrompt,
  parseFaithfulness,
  scoreFaithfulness,
  cleanTranscript,
  structureNotes,
  faithfulnessCheck,
};
