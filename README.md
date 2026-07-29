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

1. **Record live** (in-browser) or **Upload a recording** (iPhone Voice Memos, WhatsApp, Zoom) — two separate cards on the home screen
2. For a live recording, optionally attach photos/PDFs (whiteboard shots, decks, business cards) before transcribing
3. It queues a job: audio → Soniox (raw) → Claude cleans it → Claude summarises → a faithfulness audit
4. Open the job to review the layers, read the summary (with its faithfulness verdict), edit, and download everything
5. "Send to Telegram" posts the final markdown as a `.md` document to the Hermes bot chat

## Notes

- `.env` is git-ignored — never commit real API keys
- **`APP_PASSWORD` is important**: if unset, anyone with the server IP can use the app,
  burn API credits, and post into your Telegram channel
- Soniox model: `stt-async-v5` (async file transcription, auto language-mixing,
  speaker diarization and language identification enabled)
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

## Endpoints

- `GET /` — the UI
- `GET /healthz` — reports which credentials are configured
- `GET /api/config` — client runtime config (segment length, retention days)
- `POST /api/process` — multipart: `audio` (1 file), `attachments` (up to 10)  *(legacy single-shot path)*
- `POST /api/session/start` — mint a live-recording session id
- `POST /api/session/resume` — JSON `{ sessionId }`; recreate a session dir during crash recovery
- `POST /api/transcribe-chunk` — multipart: `audio` segment + `sessionId` + `index`; **stores segment audio only**
- `POST /api/finalize` — multipart: `sessionId` + `attachments`; ffmpeg-concats segments and **enqueues one job**, returns `{ jobId }`
- **Resumable upload:** `POST /api/uploads` (init) · `PUT /api/uploads/:id/:index` (chunk) · `GET /api/uploads/:id` (received chunks) · `POST /api/uploads/:id/complete` (assemble + enqueue)
- **Jobs:** `GET /api/jobs` · `GET /api/jobs/:id` · `PUT /api/jobs/:id/markdown` · `POST /api/jobs/:id/retry` · `DELETE /api/jobs/:id` (delete now)
- **Downloads:** `GET /api/jobs/:id/download/summary.md` · `…/transcript.txt` (raw) · `…/transcript-cleaned.txt` · `…/audio` (original) · `…/audio.mp3` · `…/all.zip`
- `POST /api/send-telegram` — JSON `{ markdown }`

## Tests

The Playwright/HTTP suites require the server running on `:3000`: `PORT=3000 node server.js`.

- `npm run test:prompts` — pure unit tests for the faithfulness parse/score logic
  in `prompts.js` (no server or API key needed).
- `npm run test:phase1` — Playwright (fake mic, stubbed APIs): recording heartbeat/meter,
  IndexedDB persistence, crash → recover/discard.
- `npm run test:phase2` — resumable upload assembly, worker lifecycle, retry, size/gap
  verification, boot re-scan, ready-job downloads, plus **Phase 3**: three-layer
  detail fields, cleaned/audio/zip downloads, manual delete, and the **Phase 4**
  faithfulness verdict on the job detail.
- `npm test` — runs all three.
- `npm run eval` — **Phase 4** eval set (needs `ANTHROPIC_API_KEY`); see above.
