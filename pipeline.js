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
const DEFAULT_INSTRUCTIONS = `You are an engineering squad that turns meeting minutes into a minimal, working Proof of Concept, delivered as code for review via a pull request. Work through these phases and show your thinking for each so the reader can follow along:

[1. Product Specs] — Extract the core requirement and the strict Acceptance Criteria (AC) from the minutes. If the minutes are thin, state your assumptions explicitly.

[2. Architecture Blueprint] — The smallest technical design that meets the AC. Forbid gold-plating: no features outside the AC.

[3. Implementation] — Write the actual, functional code. Use real logic and environment variables for any keys/config — NO hardcoded mock data, fake responses, or simulated timeouts. Keep it demo-ready and minimal.

[4. How to run] — A short README: prerequisites, env vars, and the commands to run it locally.

Do NOT deploy anything, do NOT write secrets, and do NOT assume any infrastructure. Your only deliverable is the code + docs, which a human will review as a pull request.

CRITICAL OUTPUT CONTRACT: After your phase write-up, end your response with a single fenced code block tagged json containing the files to commit, in exactly this shape:

\`\`\`json
{
  "repo": "short-kebab-case-name",
  "summary": "one-paragraph PR description",
  "files": [
    { "path": "README.md", "content": "..." },
    { "path": "src/index.js", "content": "..." }
  ]
}
\`\`\`

Every file's full contents go in "content" (escaped for JSON). Keep it under ${MAX_FILES} files. Output nothing after the closing fence.`;

function slugify(s, fallback = 'poc') {
  const out = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return out || fallback;
}

// Extract the LAST ```json fenced block from the model output and validate it.
// Returns { repo, summary, files } or null if there's no usable manifest.
function parseManifest(text) {
  if (typeof text !== 'string') return null;
  // Find the last ```json ... ``` block (there may be illustrative ones earlier).
  const re = /```json\s*([\s\S]*?)```/gi;
  let m, last = null;
  while ((m = re.exec(text)) !== null) last = m[1];
  if (!last) return null;

  let parsed;
  try { parsed = JSON.parse(last.trim()); } catch { return null; }
  if (!parsed || !Array.isArray(parsed.files) || !parsed.files.length) return null;

  const files = [];
  for (const f of parsed.files) {
    if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') continue;
    const path = f.path.replace(/^\.\//, '').trim();
    // Reject absolute paths + traversal — everything must land inside the repo.
    if (!path || path.startsWith('/') || path.split('/').includes('..')) continue;
    if (Buffer.byteLength(f.content, 'utf8') > MAX_FILE_BYTES) continue;
    files.push({ path, content: f.content });
    if (files.length >= MAX_FILES) break;
  }
  if (!files.length) return null;

  return {
    repo: slugify(parsed.repo, 'meeting-poc'),
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
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
