# NoteWise — Dojo Marketplace Listing

Source content for the NoteWise listing on [dojoapp.ai](https://dojoapp.ai).
Copy the sections below into the marketplace form.

---

## Summary

**NoteWise** is a self-hosted AI notetaker that turns any meeting into a clean,
verifiable record. Record live in the browser (microphone or a shared call
tab / system audio) or upload a voice memo, and NoteWise transcribes it,
structures it into markdown minutes, audits every claim against the transcript,
and delivers it to your team on Telegram — all on infrastructure you control.

Built for real-world, multilingual meetings (English, Bahasa Melayu, and
Mandarin, freely code-switched), NoteWise keeps the raw transcript untouched,
attributes every point to a speaker, and refuses to invent conclusions — so what
you send is what was actually said.

---

## Features

- **Record or upload, on any device** — In-browser live recording from your
  microphone or a shared meeting tab / system audio (desktop Chrome/Edge), or
  upload from iPhone Voice Memos, WhatsApp, or Zoom. Crash-proof: audio streams
  to local storage in 30-second chunks and recovers automatically after a
  browser crash or force-quit.

- **Multilingual transcription** — Automatic language-mixing and speaker
  diarization via Soniox, with Google Gemini as a switchable second engine.
  Handles English / Malay / Mandarin code-switching in a single pass.

- **Three-layer, self-verifying output** — Raw transcript (exactly what was
  heard), a cleaned transcript that fixes speech-to-text errors without removing
  anything, and structured markdown minutes where every point carries a
  timestamp citation back into the audio.

- **Faithfulness audit** — A second AI pass checks the summary against the
  transcript claim-by-claim and shows a trust verdict ("✓ N/N grounded"), so
  unsupported statements surface before you send anything.

- **One-tap delivery + downloads** — Post final minutes to Telegram as a `.md`
  document, or download the summary, raw/cleaned transcripts, original audio, an
  mp3 copy, or a single "Download all" zip.

- **Accounts, quotas & privacy controls** — Optional passwordless magic-link
  login, per-user job isolation, monthly transcription quotas, one-time consent
  gate, per-user data deletion, and PDPA-oriented retention windows.

- **Encryption at rest** — Optional envelope encryption (AES-256-GCM) of audio,
  transcripts, and summaries on disk and in the database, protecting a stolen
  disk or DB snapshot.

- **You own the data** — Self-hosted, single-tenant, with automatic retention
  cleanup. Transcripts and audio never accumulate on third-party servers beyond
  the transcription call itself.

---

## Open Source

NoteWise is **open source**, released under the **MIT License**. The full source
code — server, recording client, transcription pipeline, and deployment
scripts — is available in the repository, free to self-host, audit, and modify.

- **License:** MIT
- **Stack:** Node.js (Express) · SQLite (better-sqlite3) · ffmpeg · vanilla-JS PWA
- **External services (bring your own keys):** Soniox (transcription),
  Anthropic Claude (structuring + audit), optional Google Gemini, optional
  Resend (login email) and Telegram (delivery).

---

## Provisioning Specs

| Specification | Recommended | Minimum |
|---|---|---|
| vCPU | 2 | 1 |
| RAM | 2 GB | 1 GB |
| Storage | 20 GB SSD | 10 GB SSD |
| OS | Ubuntu 22.04 LTS | Ubuntu 20.04+ |
| Region | Global (choose nearest to users) | — |

**Runtime:** Node.js 18+ · ffmpeg · pm2 (process manager)

**Notes**

- The heavy lifting (transcription and LLM structuring) runs on external APIs, so
  the server itself stays lightweight — a 1 GB / 1 vCPU instance runs a single
  user comfortably; 2 GB / 2 vCPU is recommended for multi-user or concurrent
  transcription.
- **ffmpeg is required** to concatenate live-recording segments and produce mp3
  downloads (installed by `deploy.sh`).
- Storage is transient: audio and transcripts auto-delete after a configurable
  retention window (default 30 days, capped at 14 in public mode). 20 GB
  comfortably covers active jobs; scale up for high volume or long retention.
- **Required API keys** at deploy: `SONIOX_API_KEY`, `ANTHROPIC_API_KEY`.
  Optional: `GEMINI_API_KEY`, `RESEND_API_KEY`, `TELEGRAM_BOT_TOKEN`.
- Exposes an HTTP port (default 80); put behind a reverse proxy / TLS for
  production.
