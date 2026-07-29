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

1. Record in-browser, or upload a voice memo (iPhone Voice Memos works via the file picker)
2. Optionally attach photos/PDFs (whiteboard shots, decks, business cards) for extra context
3. "Transcribe & Structure" — audio → Soniox; transcript + attachments → Claude
4. Review the raw transcript and edit the structured record (fix names, correct mis-heard terms)
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
- A segment's chunks are deleted only after that segment is safely transcribed
  server-side; the whole session is deleted only after a successful finalize.
- On next launch, leftover chunks surface a **"Recover recording"** card
  (reassembles + re-transcribes) with a **"Clear recovered data"** option.
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
  **download** `summary.md` / `transcript.txt` when ready.
- Finished **live recordings** are also recorded as jobs, so history is unified.

## Endpoints

- `GET /` — the UI
- `GET /healthz` — reports which credentials are configured
- `GET /api/config` — client runtime config (segment length)
- `POST /api/process` — multipart: `audio` (1 file), `attachments` (up to 10)  *(legacy single-shot path)*
- `POST /api/session/start` — mint a live-recording session id
- `POST /api/session/resume` — JSON `{ sessionId }`; recreate a session dir during crash recovery
- `POST /api/transcribe-chunk` — multipart: `audio` segment + `sessionId` + `index`
- `POST /api/finalize` — multipart: `sessionId` + `attachments`; stitches + structures; records a job
- **Resumable upload:** `POST /api/uploads` (init) · `PUT /api/uploads/:id/:index` (chunk) · `GET /api/uploads/:id` (received chunks) · `POST /api/uploads/:id/complete` (assemble + enqueue)
- **Jobs:** `GET /api/jobs` · `GET /api/jobs/:id` · `PUT /api/jobs/:id/markdown` · `POST /api/jobs/:id/retry` · `GET /api/jobs/:id/download/summary.md` · `GET /api/jobs/:id/download/transcript.txt`
- `POST /api/send-telegram` — JSON `{ markdown }`

## Tests

Both suites require the server running on `:3000`: `PORT=3000 node server.js`.

- `npm run test:phase1` — Playwright (fake mic, stubbed APIs): recording heartbeat/meter,
  IndexedDB persistence, crash → recover/discard.
- `npm run test:phase2` — resumable upload assembly, worker lifecycle, retry, size/gap
  verification, boot re-scan, and ready-job downloads.
- `npm test` — runs both.
