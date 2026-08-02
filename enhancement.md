# Project Context: v2 Meeting Notes App (Mobile-First)

## 1. Core Product Identity
We are building a highly reliable, mobile-first web application for recording, transcribing, and summarizing meetings. 
*   **The Differentiator:** It is optimized for Malaysian code-switched speech (BM/English/Mandarin), provably does not hallucinate facts, and provides raw artifacts (audio, raw transcript, summary).
*   **The Target UX:** Frictionless Time-to-Value (TTV). Users must be able to land on the page on their phone and start recording immediately with zero upfront authentication.

## 2. Current Architecture State (Backend is DONE)
Do not rebuild the backend. The following infrastructure already exists and is functional:
*   **Server:** Node.js / Express.
*   **Database:** SQLite (`jobs`, `users`, `usage_events`, `data_keys`).
*   **Job Queue:** In-process serial queue handling state transitions (`uploaded` → `transcribing` → `summarising` → `ready`).
*   **APIs:** Soniox (Transcription) and Claude (Summarization with strict extraction rules).
*   **Security:** AES-256-GCM envelope encryption at rest for all audio and text artifacts.
*   **Auth:** Magic-link passwordless authentication (Resend).

## 3. Current Task: Frontend & UX Implementation
Act as an expert frontend engineer focusing on mobile-web optimization. We are building the client-side interface using Vanilla JS (or a minimal library like HTMX/Alpine.js if state becomes complex). **Do not use React or Next.js for this phase.**

### Key UX Directives:
1.  **"Ghost" Onboarding (Deferred Auth):**
    *   The landing page must feature a massive, immediate "Start Recording" button. No login walls.
    *   Auth is only requested *after* the meeting is successfully recorded and queued (e.g., "Enter your email to receive your summary").
2.  **Bulletproof Capture (The Heartbeat):**
    *   Implement `MediaRecorder` with 30-second `timeslice` chunks.
    *   Immediately persist every audio chunk to `IndexedDB`.
    *   Implement the Screen Wake Lock API to prevent mobile screens from sleeping.
    *   UI must feature a live visualizer (volume meter) and an elapsed timer so the user *knows* it has not crashed.
3.  **Crash Recovery:**
    *   On page load, always check `IndexedDB` for orphaned chunks. 
    *   If found, intercept the standard UI and offer a "Recover previous recording" flow to stitch and upload them to the Express backend.
4.  **Thumb-Zone UI:**
    *   Primary controls (Record, Stop, Pause) must be anchored to a fixed bottom navigation bar.
    *   Use massive tap targets. Require a deliberate action (like a long-press or confirmation modal) to stop a recording to prevent accidental data loss.

## 4. Immediate Next Steps for the AI
Please review this context and reply with a brief acknowledgment. Then, outline the HTML/CSS structure and the Vanilla JS `IndexedDB` chunking logic for the primary "Active Recording" view.