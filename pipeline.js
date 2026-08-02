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

// Phase 4 (DevOps) + Phase 5 (QA) instructions for the OPTIONAL autonomous
// deploy stage. Only used when admin enables deploy AND a Dojo-style MCP with a
// run_command tool is connected. Runs as a second, MCP-connected turn after the
// repo/PR already exist — so it deploys the PUBLIC repo to a fresh server. This
// is the user's pasted DevOps/QA phases, adapted: keys are injected from server
// config (no pause-and-ask), and it deploys the already-created repo.
const DEPLOY_INSTRUCTIONS = `You are the DevOps + QA stage of an engineering squad. The POC code is ALREADY generated and pushed to a PUBLIC GitHub repository. Deploy it to a fresh Dojo server and verify it — FULLY AUTONOMOUSLY, using the connected Dojo MCP tools. Provisioning and deployment are pre-authorized: do NOT ask the user anything, do NOT wait for confirmation, just run the tools. The repo clone URL and the environment variables to use are given in the message.

Relevant Dojo tools: create_server, get_server, run_command (use list_providers / list_regions / list_service_plans only if a value below is rejected).

**4. DEVOPS PHASE (Deployment)**

Step 4.1 — Provision a fresh server. Call create_server EXACTLY with these values (do not ask, do not change them, do not send any other fields such as metadata_json/os/webserver — they are invalid):
  cloud_provider_id: 8          (Amazon Lightsail)
  region_id: 15                 (Singapore)
  cloud_service_plan_id: 57     (1 GB RAM tier)
  support_level_id: 1           (Basic)
  project_id: 17
  name: "notetaker-poc-<short random suffix>"
  admin_email: "eddiesoo612@gmail.com"
Capture vm_id and server_id from the response.

Step 4.2 — Poll get_server (project_id 17, server_id from 4.1) roughly every 30s until it has a public_ip and is running. Capture public_ip.

Step 4.3 — Deploy via run_command. CRITICAL run_command rules: every call runs ONE command in a FRESH shell — nothing persists between calls. \`cd\`, command chaining (\`&&\` \`;\` \`|\`), output redirection (\`>\`), and \`$()\` are ALL REJECTED. Therefore: never write a file with \`>\`; set the directory with tool flags (\`git -C <dir>\`, \`npm --prefix <dir>\`, pm2 \`--cwd <dir>\`); and pass secrets INLINE as a leading \`VAR=value command\`. Run these as SEPARATE, sequential run_command calls (using vm_id), checking exit_code each time:
  1. \`systemctl stop nginx\`      — free port 80 (then \`systemctl disable nginx\`). If not permitted, note it and continue.
  2. \`git clone <cloneUrl> /opt/app\`   — on a redeploy use \`git -C /opt/app pull\` instead.
  3. \`npm install --prefix /opt/app --omit=dev\`
  4. \`npm install -g pm2\`   — if pm2 is missing.
  5. Start on port 80 with env passed INLINE (there is NO .env file — run_command cannot create one):
     \`<ENV_INLINE> pm2 start /opt/app/server.js --name app --cwd /opt/app\`
     where <ENV_INLINE> is the provided variables joined with spaces, e.g. \`ANTHROPIC_API_KEY=... PORT=80\`. Use the repo's real entrypoint if it is not server.js (\`pm2 start npm --name app --cwd /opt/app -- start\` also works).
  6. \`pm2 save\`

**5. QA & VERIFICATION PHASE (Testing)**
Via run_command (vm_id):
- \`pm2 status\` — confirm the app process is "online", not errored/looping.
- \`curl -I -s http://localhost\` — confirm an \`HTTP/… 200\` response.
- Print a clear SUCCESS or FAILURE line based on the HTTP status.
- End with a prominent banner containing the LIVE URL (http://<public_ip>) and the PUBLIC IP.

Output under the headers \`[4. Deployment Execution]\` and \`[5. QA & Verification Report]\`, listing the exact commands you ran and their results. Only ever touch the fresh server you just provisioned — never an existing production system.`;

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
  DEPLOY_INSTRUCTIONS,
  MAX_FILES,
  MAX_FILE_BYTES,
  slugify,
  parseManifest,
};
