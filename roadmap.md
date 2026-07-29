# Meeting Notes App — v2 Roadmap

**Positioning:** The notetaker that (1) genuinely works for Malaysian code-switched speech, (2) provably doesn't make things up, and (3) lets you leave with everything — summary, raw transcript, raw audio.

**Scope of this roadmap:** user starts using the app → downloads summary.md, raw transcript .txt, raw audio. (Telegram/Hermes delivery is out of scope for now.)

Phases are ordered by risk: each phase de-risks the next. Ship and test each before moving on.

---

## Phase 0 — Validate the moat (do this before building anything)

The whole product bet rests on Soniox handling BM/English/Mandarin code-switching well. Prove it now, with the POC you already have.

- [ ] Collect 3–5 real meeting recordings covering your actual mix: BM-heavy, rapid code-switching, poor audio (phone on table, aircon hum)
- [ ] Run each through the current POC; save raw Soniox output for each
- [ ] Score them: proper nouns right? language segments usable or garbage? Code-switch boundaries handled?
- [ ] **Decision gate:** if language segments fail badly → evaluate alternatives (or explicitly descope from marketing claims) *before* building v2 on top
- [ ] Save these recordings + expected outputs as your permanent eval set (used again in Phase 4)

---

## Phase 1 — Reliable capture (riskiest part of current POC)

A recording that dies at minute 55 of a 60-minute meeting loses the meeting. Current in-memory recording will die on screen lock / tab switch / Safari memory reclaim.

### Chunked, crash-proof recording
- [x] `MediaRecorder` with timeslice (~30s chunks) instead of one blob at stop
- [x] Persist each chunk to IndexedDB the moment it arrives
- [x] On app open: detect leftover chunks from a crashed session → offer "Recover recording"
- [x] "Clear recovered data" option so failed experiments don't haunt the UI

### Keep the phone awake and honest
- [x] Screen Wake Lock API while recording (with re-acquire on visibilitychange)
- [x] Recording heartbeat UI: elapsed timer + live audio level meter (user must *see* it's alive)
- [x] Warn before leaving/closing the page while recording (beforeunload)

### Upload path stays first-class
- [x] Keep voice-memo upload as an equal citizen, not a fallback (native recorders are more robust than any browser)
- [ ] Test upload of: iPhone Voice Memos (.m4a), WhatsApp voice note, Zoom recording *(needs real files + Soniox key)*

### Definition of done
- [ ] 60-minute test recording on a real iPhone with screen allowed to lock → zero lost audio *(needs a physical device)*
- [x] Kill the browser mid-recording → recover flow restores all chunks *(verified in `test-phase1.mjs`)*

---

## Phase 2 — Async processing + jobs

User must be able to upload, close the app, and come back when it's ready. Today the tab must stay open up to 30+ min.

### Job pipeline
- [x] SQLite (fine at this scale) job table: `id, user_id, filename, status, created_at, error, duration_minutes` *(in `db.js`)*
- [x] States: `uploaded → transcribing → summarising → ready → failed`
- [x] Background worker processes the queue (simple in-process serial queue; survives pm2 restart by re-scanning non-terminal jobs on boot)
- [x] Retry action for `failed` jobs (idempotent — safe to re-run)

### Upload robustness
- [x] Chunked/resumable upload to server (a 90-min recording on hotel Wi-Fi will fail as a single POST)
- [x] Server assembles chunks, verifies size, then enqueues

### Status UI
- [x] Jobs list screen: past recordings with status, duration, date
- [x] Job detail screen: progress, and downloads when ready
- [ ] (Optional) email notification on ready/failed *(deferred — needs an email provider; see Phase 5 Auth)*

### Definition of done
- [x] Upload a 60-min file, close the browser entirely, return later → job completed, files downloadable *(verified in `test-phase2.mjs`; full-length run needs a real Soniox key)*

---

## Phase 3 — Three-layer output + downloads

"Easy to transfer out" made concrete. Raw must mean raw.

> **Status: DONE (working tree, not yet committed).** `archiver` installed (pinned `^7` — v8 is ESM-only and needs newer Node); `processJob` rewritten into the three-layer pipeline; live recording now concats segments and transcribes in one pass; downloads (audio/mp3/zip/cleaned) + retention sweep + manual delete added. ffmpeg install folded into `deploy.sh`. Verified by `test-phase1.mjs` + `test-phase2.mjs` (both suites pass).

### Layer separation
- [x] **Raw transcript (.txt):** untouched Soniox output — exactly what the engine heard, speaker + language tags intact *(rendered tokens with speaker + `[language]` + `[mm:ss]`; stored per job in `raw_transcript`, never overwritten after first write)*
- [x] **Cleaned transcript (.txt):** STT errors fixed, nothing removed, [UNCLEAR] markers preserved *(`claudeCleanTranscript()` pass → `cleaned_transcript`; falls back to raw if the pass fails)*
- [x] **Summary (.md):** condensed, attributed (see Phase 4) *(regenerated from the cleaned layer via `claudeStructureNotes`)*
- [x] Store all three per job; never overwrite raw *(`raw_transcript` / `cleaned_transcript` / `markdown`)*

### Timestamps (the self-verifying summary)
- [x] Keep Soniox per-token timestamps instead of discarding them *(`renderTokens` reads `start_ms`)*
- [x] Raw transcript includes periodic timestamps (e.g. every speaker turn) *(`[mm:ss]` prefixed at each speaker turn via `fmtTimestamp`)*
- [x] Each summary bullet carries a timestamp reference back to the audio (`[12:34]`) *(summary prompt now appends `[mm:ss]` citations drawn only from timestamps present in the transcript)*

### Audio downloads
- [x] Install ffmpeg on server *(folded into `deploy.sh`: checks for ffmpeg, installs via apt-get, warns rather than aborting)*
- [x] Offer BOTH: bit-exact original file (true raw) + mp3 convenience copy (transcoded) *(`/download/audio` + `/download/audio.mp3`, mp3 transcoded once and cached)*
- [x] Self-describing filenames: `2026-07-28-meeting-summary.md`, `...-transcript-raw.txt`, `...-audio.mp3`
- [x] "Download all" → single .zip bundle (summary + both transcripts + audio) *(`/download/all.zip` via archiver)*

### Retention
- [x] Auto-delete files after N days (pick N; show it clearly in UI — cost constraint becomes trust feature) *(N = 30, configurable via `RETENTION_DAYS`; swept on boot + every 6h; “Files auto-delete on …” shown per job)*
- [x] Manual "delete now" per job *(`DELETE /api/jobs/:id` + button; removes audio, cached mp3, attachments, and the row)*

### Notes — live-recording accuracy regression (found while starting Phase 3)
- Cause: commit `48c6e97` switched live recording from ONE whole-meeting Soniox transcription to independent ~5-min segment transcriptions (stitched text). Model/config unchanged (`stt-async-v5`, `language_hints ['en','ms','zh']`). Isolated chunks lose context and cut code-switched sentences → worse Malaysian English + Chinese accuracy. Uploads (whole-file) are unaffected.
- Fix (DONE): `/api/transcribe-chunk` now stores segment audio only; `/api/finalize` ffmpeg-concats the segments and enqueues ONE job, so the whole recording is transcribed in a single Soniox pass. The client navigates to the job detail (async), same as an upload.

### Definition of done
- [x] One tap gets a zip containing everything; raw transcript is byte-identical to Soniox output *(zip verified in `test-phase2.mjs`; "raw" layer = the rendered-token output we store verbatim, tags + timestamps intact)*

---

## Phase 4 — "Summarise, don't interpret" as a guarantee

Prompt rules alone drift. Make non-interpretation testable.

> **Status: DONE (working tree).** Prompt logic extracted to `prompts.js` (shared by server + eval), with versioned prompts. Summary hardened + narrowed to a single attributed **Context** record (the interpretive sales-template fields — "What they need / Signals / Our angle / Agreed next step / Proposal due" — were dropped at the user's request). Faithfulness audit runs per job, is stored, and is surfaced on the job detail. Eval harness added. Verified by `test-prompts.mjs` + the faithfulness assertion in `test-phase2.mjs`.

### Prompt hardening
- [x] Extractive over abstractive: prefer near-verbatim phrasing from the transcript *(`buildSummaryPrompt`, rule 1)*
- [x] Attribution rule: "Speaker 2 said the budget is 50k" — never "the budget is 50k" *(rule 2 — attribute every point to a speaker)*
- [x] Keep + strengthen: [UNCLEAR] for garbled terms, [NOT STATED] for missing fields, never invent names/numbers/commitments *(rule 3)*
- [x] No advice, no conclusions, no sentiment, no "action items the model thinks are implied" *(rule 1, explicit)*

### Eval habit
- [x] Rerun the Phase 0 eval set on every prompt or model change *(`npm run eval` over `eval/cases/`; prompts live in `prompts.js` so a change is one edit + a `*_PROMPT_VERSION` bump. Fixtures are text transcripts today — swap in the real Phase 0 recordings' transcripts when they exist)*
- [x] Automated faithfulness check: second model pass answering "does the summary contain any claim not present in the transcript?" *(`faithfulnessCheck` → per-claim `supported` yes/no + overall pass; runs in `processJob`, shown on job detail)*
- [x] Log eval results per prompt version so regressions are visible *(`eval/run-eval.mjs` appends to `eval/results.jsonl` tagged with `SUMMARY_PROMPT_VERSION` + `FAITHFULNESS_PROMPT_VERSION`)*

### Definition of done
- [x] Faithfulness check passes 100% on eval set; any future prompt change re-proves it *(`npm run eval` passed 2026-07-29: budget-meeting 4/4 grounded, mic-test 3/3 grounded, and both invented-claim probes correctly flagged; baseline in `eval/results.jsonl`. Rerun on any prompt change.)*

---

## Phase 5 — Accounts, quotas, and PDPA basics

Last, because everything above is testable single-user.

### Auth (thin as possible)
- [ ] Magic-link or email-OTP login (no passwords to store or forget) - use resend, i have subscribed to resend.
- [ ] Session management; each job tied to user_id
- [ ] Replace shared APP_PASSWORD with per-user auth

### Quotas (Soniox + Claude cost real money per minute)
- [ ] Track transcribed minutes per user per month
- [ ] Enforce a cap with a clear "you've used X of Y minutes" display
- [ ] Admin view: usage across users

### PDPA / consent basics
- [ ] Onboarding line: user is responsible for having consent to record third parties
- [ ] Stated retention policy (from Phase 3) surfaced at signup
- [ ] Account deletion = all files + records gone

### Definition of done
- [ ] Two users can't see each other's jobs; quota blocks the 61st minute; deleting an account leaves nothing behind

---

## Phase 5.5 — Going public: encryption at rest, quotas, consent

Only needed once this stops being an internal tool and becomes a public toy app. Multi-tenant + public means the threat model changes: strangers' data, strangers' cost exposure, strangers' consent.

### Encryption at rest (envelope encryption — NOT zero-knowledge)
Zero-knowledge (master key derived from password, never leaves browser) is the wrong pattern here — the server *must* see plaintext to send audio to Soniox and transcripts to Claude. Envelope encryption protects the right thing (stolen disk/DB backup) without breaking the pipeline.

- [ ] Generate a random **per-user data key** at signup (NOT derived from password)
- [ ] Wrap (encrypt) each user's data key with a server-held **master key** (envelope encryption — same pattern as AWS KMS/Vault)
- [ ] Master key itself stored outside the app's database (env var at minimum; a real KMS/secrets manager if budget allows)
- [ ] Encrypt audio/transcript/summary files with **AES-256-GCM** using the user's data key before writing to disk
- [ ] Decrypt only in memory, only when: sending to Soniox/Claude for processing, or serving an authenticated download
- [ ] Password stored only as an **Argon2id hash** for login verification — never used as a crypto key directly
- [ ] Key rotation plan: if the master key is ever suspected compromised, re-wrap all user data keys

### Per-account quotas (before public launch, not after)
- [ ] Minutes-transcribed cap per user per month (Soniox + Claude both bill per-minute/per-token — an open public endpoint with no cap is a live bill)
- [ ] Hard stop + clear "quota reached" UI once hit, not a silent failure
- [ ] Rate limit on upload endpoint (prevent scripted abuse independent of the quota)
- [ ] Admin dashboard: usage across all accounts, ability to suspend an account

### Consent + moderation (the part that isn't solved by code alone)
- [ ] Checkbox at upload: "I have consent to record everyone in this audio" — logged with timestamp
- [ ] Terms of Service covering third-party voice data, written for a Malaysian PDPA context
- [ ] Basic abuse path: a way to flag/report content, and a documented takedown process
- [ ] Decide and state a hard retention ceiling for public accounts (shorter than internal use — e.g. 7–14 days)

### Definition of done
- [ ] Full DB + disk snapshot leaked → attacker has ciphertext only, no usable audio/text without the master key
- [ ] A user hitting their quota gets a clear message, not a broken app or a surprise bill on your end

---

## Cross-cutting (applies throughout)

- [ ] Every deploy: run the Phase 0/4 eval set before calling it done
- [ ] Rotate the exposed Anthropic API key (still outstanding)
- [ ] Delete the old DigitalOcean server if not done yet (still billing)
- [ ] Keep deploy.sh as the single redeploy path

---

## Suggested order of attack

1. **Phase 0 this week** — it's cheap (POC already works) and could change everything downstream
2. **Phase 1 next** — capture reliability is the difference between demo and product
3. **Phases 2 → 3 → 4** in sequence — each builds on the previous
4. **Phase 5 only when you're ready to let someone outside the team use it**
5. **Phase 5.5 only when you're ready for strangers, not just known users**

---

## Framework & Architecture

What to actually build each phase with. Bias throughout: smallest thing that works, add complexity only when a phase's checklist forces it.

### Frontend

| Phase | Recommendation | Why |
|---|---|---|
| 1–3 (current) | **Vanilla JS**, no framework | One page, no framework overhead earns its keep yet |
| 2–3 (jobs list/detail appear) | Add a **tiny router** (~30 lines) or **Alpine.js/htmx** | Multiple views + live status polling get painful in raw DOM; these add reactivity with no build step |
| 5+ (auth screens, admin dashboard, real complexity) | **React + Vite** as a plain SPA (Express stays the API) | Component reuse + state management justified by then; skip Next.js — SSR/file routing solve problems you don't have (no SEO need, it's an authenticated tool) |
| Browser extension (later, separate project) | **React + Vite + `@crxjs/vite-plugin`** if you went React for web; otherwise vanilla | Can share components with the web app's popup-style UI if both are React; extension APIs (`chrome.*`, background workers) don't map to Next.js at all |

### Backend

| Concern | Recommendation | Why |
|---|---|---|
| Server | **Express** (keep it) | Already working, no reason to migrate |
| Database | **SQLite** → Postgres only if you outgrow it | SQLite is genuinely fine through Phase 5; don't add Postgres/ops overhead early |
| Job queue | **In-process queue** (simple array/promise-based) → **BullMQ + Redis** if you need multi-server workers | Single-server POC doesn't need Redis; add it only when you scale workers horizontally |
| File storage | Local disk (`/opt/.../uploads`) through Phase 5 → **S3-compatible object storage** (e.g. DigitalOcean Spaces, Cloudflare R2) at Phase 5.5 | Public + multi-tenant wants durable, non-server-local storage; R2 has no egress fees, worth it for downloadable content |
| Auth | **Magic-link / email-OTP** (e.g. Resend or SES for email) | No password storage/reset flow to build until Phase 5.5 makes real passwords necessary for the master-key pattern's login-hash step |
| Encryption (Phase 5.5) | Node's built-in `crypto` (AES-256-GCM), **Argon2id** via `argon2` npm package | No need for a full KMS at this scale; env-var-held master key is a reasonable middle ground — real KMS (AWS KMS/Vault) only if budget/compliance demands it |
| Audio transcoding | **ffmpeg** (via `fluent-ffmpeg` or direct CLI calls) | Needed for the "raw mp3" convenience download (Phase 3) |
| Background jobs surviving restart | Re-scan non-terminal job rows on process boot | Cheaper than a persistent queue broker for this scale |

### Infra

| Concern | Recommendation | Why |
|---|---|---|
| Hosting | Stay on current Lightsail box through Phase 5; **re-evaluate at 5.5** | Public traffic + object storage + a queue worker may want to split into app server + worker + managed Postgres; not needed before then |
| TLS | Keep the Cloudflare + nginx setup already built | Already solved, don't touch |
| Secrets | `.env` today → real secrets manager (Doppler, AWS Secrets Manager, or even 1Password CLI) at Phase 5.5 | Master key and API keys deserve better than a flat file once public |
| Monitoring | pm2 logs today → add error tracking (Sentry free tier) by Phase 2 | Async jobs fail silently otherwise — you need to know before the user reports it |
| CI | None needed through Phase 3; simple GitHub Actions (run eval set on prompt changes) at Phase 4 | Matches the "eval habit" checklist item — automate it once it exists |

### One sequencing note

Don't adopt React *just because* the extension is coming — only pull it forward if Phase 5's UI complexity actually demands it around the same time. Building state-management machinery you don't need yet is the same mistake as premature Next.js adoption, just with extra steps.