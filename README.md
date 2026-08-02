# Meeting Notes App

Record or upload meeting audio (Malaysian multilingual: English / BM / Mandarin, freely mixed)
→ Soniox transcribes → Claude cleans up and structures it into a markdown meeting record →
you review/edit → send to Hermes via Telegram.

## Setup

```bash
npm install
cp .env.example .env
# fill in APP_PASSWORD, SONIOX_API_KEY, ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
npm start
```

## Flow

1. **Record live** (in-browser, from the **microphone**, or — desktop Chrome/Edge only — from a **shared tab / system audio** via the "Record tab / system audio" button, good for online meetings) or **Upload a recording** (iPhone Voice Memos, WhatsApp, Zoom) — two separate cards on the home screen
2. For a live recording, optionally attach photos/PDFs (whiteboard shots, decks, business cards) before transcribing
3. It queues a job: audio → Soniox (raw) → Claude cleans it → Claude summarises → a faithfulness audit
4. Open the job to review the layers, read the summary (with its faithfulness verdict), edit, and download everything
5. "Send to Telegram" posts the final markdown as a `.md` document to the Hermes bot chat

## Notes

- `.env` is git-ignored — never commit real API keys
- **`APP_PASSWORD` is important**: if unset, anyone with the server IP can use the app,
  burn API credits, and post into your Telegram channel
- **Transcription providers** (masked in the UI as **Model 1** / **Model 2**):
  - **Model 1 — Soniox** (`stt-async-v5`): async file transcription, auto
    language-mixing, speaker diarization + language identification.
  - **Model 2 — Gemini** (`GEMINI_MODEL`, default `gemini-2.5-flash`): the audio is
    transcoded to mp3 and sent via the Gemini Files API, prompted to emit the same
    `Speaker N [mm:ss]:` shape so the rest of the pipeline is provider-agnostic.
  - A per-recording toggle picks the model; it only appears when **both** keys are
    configured. The chosen model is stored per job (`stt_provider`) and shown on the
    job detail. Duration (for quotas) falls back to `ffprobe` when a provider
    doesn't report it.
- Claude model: `claude-sonnet-5`
- Soniox files/transcriptions are deleted after each run so they don't accumulate

## Known limitation

Soniox's supported-language list covers Malay (`ms`), English (`en`) and Chinese (`zh`),
but has **no separate Cantonese code**. Cantonese-heavy audio is therefore unproven —
test a real Cantonese clip before relying on it.

## Crash-proof recording (Phase 1)

- Live recording streams to `MediaRecorder` with a 30s timeslice; every chunk is
  written to **IndexedDB** the instant it arrives, so a crash/lock/force-quit loses
  at most ~30s of audio.
- A segment's chunks are deleted only after that segment's audio is safely stored
  server-side; the whole session is deleted only after a successful finalize.
- On next launch, leftover chunks surface a **"Recover recording"** card
  (re-uploads the audio, then finalizes into a job) with a **"Clear recovered data"** option.
- While recording: **Screen Wake Lock** (re-acquired on tab return), a live
  **elapsed timer + audio-level meter**, and a **beforeunload** warning.

## Async jobs + resumable upload (Phase 2)

- Uploaded audio no longer blocks the tab. The client splits the file into 5MB
  chunks, PUTs each (with retry/backoff), then the server **assembles, verifies
  total size, and enqueues a job**. You can close the app and come back.
- Jobs live in **SQLite** (`db.js`, stored under `data/app.db`) with states
  `uploaded → transcribing → summarising → ready → failed`.
- A single in-process **worker** drains the queue one job at a time. On boot it
  **re-scans** any job stranded mid-run (crash/pm2 restart) and re-queues it;
  processing is idempotent (re-run from the stored audio file).
- **Jobs list** and **job detail** views (hash router `#/jobs`, `#/jobs/:id`) show
  status/progress, let you review + edit the summary, **retry** failures, and
  **download** everything when ready.
- Finished **live recordings** are also recorded as jobs, so history is unified.

## Three-layer output + downloads (Phase 3)

Every job carries three layers, and the raw layer is never overwritten:

1. **Raw transcript** — exactly what Soniox heard, with `Speaker N [mm:ss]:` turn
   markers and `[language]` tags intact.
2. **Cleaned transcript** — a Claude pass that fixes STT errors (proper nouns,
   code-switched phrases) but **removes nothing**; unrecoverable garble is marked
   `[UNCLEAR]`. This is still a full transcript, not a summary.
3. **Summary (`.md`)** — structured from the cleaned layer, with each field
   carrying a `[mm:ss]` citation back into the audio (self-verifying).

**Live-recording accuracy:** segments are captured as audio only and stitched
with `ffmpeg` into one file that is transcribed in a **single Soniox pass**, so
whole-meeting context is preserved (fixes the per-segment regression from
`48c6e97`). **ffmpeg is required on the server** — `deploy.sh` installs it.

**Downloads** (per job): summary `.md`, raw `.txt`, cleaned `.txt`, the
bit-exact **original audio**, an **mp3** convenience copy (transcoded + cached),
and a **"Download all" `.zip`** bundling all of the above. Filenames are
self-describing (`2026-07-28-meeting-summary.md`, `…-transcript-raw.txt`, …).

**Retention:** jobs and their files are auto-deleted `RETENTION_DAYS` (default
30) after creation — swept on boot and every 6h. The window is shown on each job
(“Files auto-delete on …”), and every job has a manual **Delete now**.

## "Summarise, don't interpret" guarantee (Phase 4)

The summary is deliberately narrow and provably grounded:

- **Hardened prompt** (`prompts.js`, `SUMMARY_PROMPT_VERSION`): extractive over
  abstractive, every point **attributed to a speaker** ("Speaker 2 said …"),
  `[UNCLEAR]` / `[NOT STATED]` preserved, and **no advice, conclusions, sentiment,
  or implied action items**. The output is a single **Context** record (the old
  sales-template fields were dropped) with `[mm:ss]` citations.
- **Faithfulness audit**: a second Claude pass checks whether the summary makes any
  claim the transcript doesn't support, returning a per-claim verdict. The result
  is stored per job and shown on the job detail as a trust signal — green
  "✓ N/N grounded" or a yellow list of unsupported claims to review before sending.
- **Eval harness** (`npm run eval`): runs transcript fixtures in `eval/cases/`
  through the same summarise + audit passes, plus hand-written "probe" summaries
  that prove the auditor catches invented claims. Results append to
  `eval/results.jsonl` tagged with the prompt versions, so regressions across
  prompt changes stay visible. Requires `ANTHROPIC_API_KEY`; skips without one.

The prompt logic lives in `prompts.js` so the server and the eval harness share
exactly one source of truth — change a prompt, bump its `*_PROMPT_VERSION`, rerun
the eval.

## Accounts, quotas, PDPA (Phase 5)

Off by default (single-user, shared `APP_PASSWORD`). Set `AUTH=magic` to turn on
per-user accounts:

- **Passwordless magic-link login** (`auth.js`): user enters their email, gets a
  one-time sign-in link (sent via **Resend**; logged to the server console if
  `RESEND_API_KEY` is unset, so it works before email is wired). Sessions are
  opaque random tokens stored **hashed**, held in an httpOnly cookie — no
  passwords, no JWT, no extra dependency. Needs `APP_BASE_URL` set.
- **Per-user isolation**: every job is tied to a `user_id`; one user can't see,
  download, or delete another's jobs (cross-user requests 404).
- **Monthly quota** (`QUOTA_MINUTES`, 0 = unlimited): transcribed minutes are
  tracked in a ledger that survives job retention; once a user is at the cap, new
  uploads/recordings are blocked with a clear message. Usage (`X / Y min this
  month`) shows in the header. `ADMIN_EMAILS` get an **Admin** usage view across
  all users.
- **PDPA basics**: a one-time consent gate ("I have consent to record everyone in
  this audio") is required on first sign-in and logged with a timestamp; the
  retention window is stated there; **Delete account** removes all of the user's
  jobs, files, usage, sessions, and the account row.
- **Product-updates agreement + marketing list**: a second required checkbox on
  the consent gate — agreement to receive product updates (e.g. Dojo Marketplace),
  framed as an accepted term with a clear unsubscribe rather than a bundled
  "consent". Stored as a separate, timestamped `marketing_consent_at`. Users can
  **unsubscribe/re-subscribe anytime** from the account bar ("Emails: on/off"),
  which clears/sets the flag. Admins export **only currently-opted-in** addresses
  as CSV (`GET /api/admin/marketing.csv`); opt-outs drop off the list
  automatically. Note: forcing marketing consent as a signup gate is legally
  weaker than an opt-in under PDPA — the unsubscribe path is what keeps it
  defensible; confirm with compliance before using the list.

## Going public (Phase 5.5)

Extra protections for a multi-tenant / public deployment. Encryption is
**feature-flagged and off by default**, so existing single-user boxes are unchanged.

- **Encryption at rest** (`cryptostore.js`): envelope encryption — a server
  `MASTER_KEY` wraps a random **per-user data key**; that key AES-256-GCM-encrypts
  the user's **audio, attachments, transcripts, and summary** on disk and in the DB.
  Turn on with `ENCRYPT_AT_REST=1` + a base64 32-byte `MASTER_KEY`
  (`openssl rand -base64 32`). Content is decrypted only in memory — to send to
  Soniox/Gemini/Claude, or to serve an authenticated download. Legacy plaintext
  jobs keep working (a per-job `encrypted` flag + an `enc1:` text marker), so the
  flag can be flipped without a migration. Rotate the master key with
  `OLD_MASTER_KEY=… NEW_MASTER_KEY=… node rotate-master-key.mjs` (re-wraps data
  keys only; documented, take a DB backup first). Not zero-knowledge — the server
  must see plaintext to process — this protects a **stolen disk/DB snapshot**.
- **Upload rate limiting** (`ratelimit.js`): `UPLOAD_RATE_PER_HOUR` (default 60)
  per user/IP on the upload endpoints → `429`, independent of the minutes quota.
- **Admin suspend**: suspended accounts are blocked at auth (`POST
  /api/admin/users/:id/suspend`); toggle from the Admin view.
- **Public retention ceiling**: `PUBLIC_RETENTION_DAYS` (default 14) caps the
  effective retention when auth is on.
- **Consent + moderation (light)**: a per-upload "I have consent to record
  everyone" checkbox (required in public mode, stamped per job); a draft
  **Terms** page (`#/terms`, review with counsel); and a **Report content**
  action (`POST /api/report`) that logs to a `reports` table (+ admin email if
  Resend is set).

## Admin AI pipeline (meeting → POC → GitHub PR)

Admin-only. Turns a meeting's minutes into a small, working proof-of-concept and
opens a pull request for review — the human gate is the PR; nothing deploys
automatically.

- **Editable instructions + model** (Admin page → *AI Pipeline*): a prompt you can
  edit (`settings` table, key `pipeline_instructions`) and a model picker
  (curated Claude ids + a custom field, key `pipeline_model`). Defaults live in
  `pipeline.js` — the 5-phase POC prompt with the auto-deploy / secret-writing
  steps removed.
- **Live run** (a job's detail → *Run AI pipeline*): streams the phases over SSE
  (`GET /api/admin/pipeline/stream?jobId=`) so you watch the AI work in real time,
  then parses the required JSON file-manifest and, via `github.js`, creates a
  **new private repo**, commits the files to a `poc` branch, and **opens a PR**.
  Set `GITHUB_TOKEN` (repo scope) and optionally `GITHUB_OWNER`. Without a token,
  it still streams the code but skips the repo.
- **MCP tools** (Admin page → *AI Pipeline* → *MCP tools*, optional): point the run
  at an MCP server (e.g. an internal marketplace MCP) so Claude can call its tools
  while generating the POC. Enter the **endpoint URL** (the Streamable-HTTP path,
  often ending in `/mcp` — not the site root) and an optional bearer token; both are
  stored in the DB (`settings` keys `pipeline_mcp_url` / `pipeline_mcp_token`, token
  never echoed back) and changeable without a redeploy. Uses the Anthropic MCP
  connector (`anthropic.beta.messages.stream`, beta `mcp-client-2025-11-20`);
  `pause_turn` tool loops are resumed automatically and live tool calls are shown.
- **Guardrails** (a transcript is untrusted input): admin-only; new **private**
  repo per run; code behind a **PR** (no auto-merge); **no auto-deploy**; path
  traversal/absolute paths rejected; ≤40 files, ≤256 KB each.

## Endpoints

- `GET /` — the UI
- `GET /healthz` — reports which credentials are configured
- `GET /api/config` — client runtime config (segment length, retention days, available transcription models)
- `POST /api/process` — multipart: `audio` (1 file), `attachments` (up to 10)  *(legacy single-shot path)*
- `POST /api/session/start` — mint a live-recording session id
- `POST /api/session/resume` — JSON `{ sessionId }`; recreate a session dir during crash recovery
- `POST /api/transcribe-chunk` — multipart: `audio` segment + `sessionId` + `index`; **stores segment audio only**
- `POST /api/finalize` — multipart: `sessionId` + `attachments`; ffmpeg-concats segments and **enqueues one job**, returns `{ jobId }`
- **Resumable upload:** `POST /api/uploads` (init) · `PUT /api/uploads/:id/:index` (chunk) · `GET /api/uploads/:id` (received chunks) · `POST /api/uploads/:id/complete` (assemble + enqueue)
- **Jobs:** `GET /api/jobs` · `GET /api/jobs/:id` · `PUT /api/jobs/:id/markdown` · `POST /api/jobs/:id/retry` · `DELETE /api/jobs/:id` (delete now)
- **Downloads:** `GET /api/jobs/:id/download/summary.md` · `…/transcript.txt` (raw) · `…/transcript-cleaned.txt` · `…/audio` (original) · `…/audio.mp3` · `…/all.zip`
- `POST /api/send-telegram` — JSON `{ markdown }`
- **Auth (AUTH=magic):** `POST /api/auth/request` (email → magic link) · `GET /auth/verify?token=` (sets session cookie) · `POST /api/auth/logout`
- **Account:** `GET /api/me` (identity + quota + consent; public — reports auth state) · `POST /api/me/consent` (JSON `{ marketing }`) · `POST /api/me/marketing` (JSON `{ optIn }` — unsubscribe/re-subscribe) · `DELETE /api/me` (delete account + all data)
- **Admin:** `GET /api/admin/usage` · `GET /api/admin/marketing.csv` (opted-in emails) · `POST /api/admin/users/:id/suspend` (JSON `{ suspended }`)
- **Public/abuse (Phase 5.5):** `POST /api/report` (JSON `{ jobId?, reason }`)
- **Admin AI pipeline:** `GET`/`POST /api/admin/pipeline/config` · `GET /api/admin/pipeline/stream?jobId=` (SSE)

## Tests

The Playwright/HTTP suites require the server running on `:3000`: `PORT=3000 node server.js`.

- `npm run test:crypto` — envelope-encryption round-trips + GCM tamper rejection
  (`cryptostore.js`; no server needed).
- `npm run test:prompts` — pure unit tests for the faithfulness parse/score logic
  in `prompts.js` (no server or API key needed).
- `npm run test:phase1` — Playwright (fake mic, stubbed APIs): recording heartbeat/meter,
  IndexedDB persistence, crash → recover/discard.
- `npm run test:phase2` — resumable upload assembly, worker lifecycle, retry, size/gap
  verification, boot re-scan, ready-job downloads, plus **Phase 3**: three-layer
  detail fields, cleaned/audio/zip downloads, manual delete, and the **Phase 4**
  faithfulness verdict on the job detail.
- `npm run test:phase5` — **Phase 5**: spawns its own `AUTH=magic` server on a
  throwaway DB/port and verifies magic-link login, per-user job isolation, the
  monthly quota block, account deletion, and the marketing opt-in export.
  Self-contained (no `:3000`, no email).
- `npm run test:phase55` — **Phase 5.5**: spawns its own encrypted `AUTH=magic`
  server and verifies encryption at rest (ciphertext on disk + in the DB, downloads
  decrypt), upload rate limiting, admin suspend, and abuse reports. Self-contained.
- `npm test` — runs all suites (phase 1/2 still need the `:3000` server).
- `npm run eval` — **Phase 4** eval set (needs `ANTHROPIC_API_KEY`); see above.
