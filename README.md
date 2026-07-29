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

## Endpoints

- `GET /` — the UI
- `GET /healthz` — reports which credentials are configured
- `GET /api/config` — client runtime config (segment length)
- `POST /api/process` — multipart: `audio` (1 file), `attachments` (up to 10)
- `POST /api/session/start` — mint a live-recording session id
- `POST /api/session/resume` — JSON `{ sessionId }`; recreate a session dir during crash recovery
- `POST /api/transcribe-chunk` — multipart: `audio` segment + `sessionId` + `index`
- `POST /api/finalize` — multipart: `sessionId` + `attachments`; stitches + structures
- `POST /api/send-telegram` — JSON `{ markdown }`

## Tests

- `node test-phase1.mjs` — Playwright (fake mic, stubbed APIs) covering the recording
  heartbeat/meter, IndexedDB persistence, and the crash → recover/discard flows.
  Requires the server running on `:3000`: `PORT=3000 node server.js`.
