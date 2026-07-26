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

## Endpoints

- `GET /` — the UI
- `GET /healthz` — reports which credentials are configured
- `POST /api/process` — multipart: `audio` (1 file), `attachments` (up to 10)
- `POST /api/send-telegram` — JSON `{ markdown }`
