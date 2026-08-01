// Admin AI-pipeline: the editable default prompt, the model list, and the parser
// that turns Claude's output into a set of files to commit. Kept separate from
// the server so the prompt + parser are easy to inspect and unit-test.

// Curated Claude model ids offered in the picker (the UI also allows a custom id).
const MODELS = [
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-haiku-4-5-20251001',
  'claude-opus-4-8',
];
const DEFAULT_MODEL = 'claude-sonnet-5';

// Caps on what we'll commit — a transcript is untrusted input, so bound the blast
// radius of a generated manifest.
const MAX_FILES = 40;
const MAX_FILE_BYTES = 256 * 1024;

// Default pipeline instructions. This is the user's 5-phase "POC squad" flow with
// the autonomous-deploy / secret-writing steps REMOVED — this feature generates
// code and opens a PR for human review; it never deploys. Editable in the UI.
const DEFAULT_INSTRUCTIONS = `You are an engineering squad that turns meeting minutes into a minimal, working Proof of Concept, delivered as code for review via a pull request.

FORMAT: Write phases 1–4 below as normal, readable Markdown prose — real headings, paragraphs, and bullet lists with actual line breaks. Do NOT wrap this narrative in JSON or escape the newlines; a person reads it live as you type. Keep it concise.

[1. Product Specs] — Extract the core requirement and the strict Acceptance Criteria (AC) from the minutes. If the minutes are thin, state your assumptions explicitly.

[2. Architecture Blueprint] — The smallest technical design that meets the AC. Forbid gold-plating: no features outside the AC.

[3. Implementation] — Briefly describe the files you're creating and the key logic. Use real logic and environment variables for any keys/config — NO hardcoded mock data, fake responses, or simulated timeouts. Keep it demo-ready and minimal.

[4. How to run] — Prerequisites, env vars, and the commands to run it locally.

Do NOT deploy anything, do NOT write secrets, and do NOT assume any infrastructure. Your only deliverable is the code + docs, which a human will review as a pull request.

AI PROVIDER: If the POC needs an LLM or any AI capability, use Anthropic's Claude API (the \`@anthropic-ai/sdk\` npm package, or the REST API) with an \`ANTHROPIC_API_KEY\` environment variable — do NOT use OpenAI or any other provider. Include \`ANTHROPIC_API_KEY\` (and any other needed variables) in a generated \`.env.example\` file, and read config from environment variables.

CRITICAL OUTPUT CONTRACT: ONLY after all four phases above, output the files to commit. Do NOT use JSON. First output these two lines:

REPO: short-kebab-case-name
SUMMARY: one sentence describing the PR

Then output each file as a block delimited EXACTLY like this, with the delimiter lines on their own lines and the file's real, verbatim contents in between (any characters allowed — do not escape anything):

<<<<FILE: relative/path/to/file>>>>
...the complete file contents, exactly as they should appear on disk...
<<<<END>>>>

Keep the project minimal — a handful of files, under ${MAX_FILES}. Output nothing after the last <<<<END>>>>.`;

function slugify(s, fallback = 'poc') {
  const out = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return out || fallback;
}

// Parse the delimiter-based file manifest (see DEFAULT_INSTRUCTIONS). File
// contents are RAW text between <<<<FILE: path>>>> and <<<<END>>>> markers, so
// generated code (backticks, ${}, quotes, newlines) needs no escaping — far more
// robust than packing everything into JSON. Returns { repo, summary, files } or
// null if no usable file block is present. Truncated output degrades gracefully:
// complete blocks are kept, an unterminated trailing block is dropped.
function parseManifest(text) {
  if (typeof text !== 'string') return null;
  const fileRe = /<<<<FILE:\s*([^\n>]+?)\s*>>>>\r?\n([\s\S]*?)\r?\n<<<<END>>>>/g;
  const files = [];
  let m;
  while ((m = fileRe.exec(text)) !== null) {
    const path = m[1].replace(/^\.\//, '').trim();
    const content = m[2];
    // Reject absolute paths + traversal — everything must land inside the repo.
    if (!path || path.startsWith('/') || path.split('/').includes('..')) continue;
    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) continue;
    files.push({ path, content });
    if (files.length >= MAX_FILES) break;
  }
  if (!files.length) return null;

  const repoM = text.match(/^REPO:\s*(.+)$/m);
  const sumM = text.match(/^SUMMARY:\s*(.+)$/m);
  return {
    repo: slugify(repoM ? repoM[1] : '', 'meeting-poc'),
    summary: sumM ? sumM[1].trim() : '',
    files,
  };
}

module.exports = {
  MODELS,
  DEFAULT_MODEL,
  DEFAULT_INSTRUCTIONS,
  MAX_FILES,
  MAX_FILE_BYTES,
  slugify,
  parseManifest,
};
