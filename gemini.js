// Gemini audio transcription (the "Model 2" provider), via the Generative
// Language REST API — no SDK dependency, matching how Soniox/Resend are called.
// Flow: resumable-upload the audio to the Files API → wait until ACTIVE →
// generateContent with a transcription prompt → delete the remote file.
//
// Gemini is prompted to emit the SAME rendered shape Soniox produces
// (`Speaker N [mm:ss]:` turns, languages preserved), so the downstream
// clean → summarise → faithfulness pipeline is provider-agnostic.
const fs = require('fs');

const BASE = 'https://generativelanguage.googleapis.com';

const TRANSCRIBE_PROMPT = `You are transcribing audio from a Malaysian business meeting. The speech mixes English, Bahasa Melayu, Mandarin and Cantonese, often within a single sentence.

Transcribe it verbatim. Rules:
- Preserve the languages exactly as spoken — do NOT translate.
- Diarize: label each speaker turn as "Speaker 0", "Speaker 1", etc. Keep the same number for the same voice throughout.
- Prefix every speaker turn with its start time as [mm:ss] (or [h:mm:ss] past an hour).
- If a word or phrase is unintelligible, write [UNCLEAR] instead of guessing a name or number.
- Output ONLY the transcript, no preamble or summary.

Format each turn on its own block exactly like:
Speaker 0 [00:00]: <what they said>

Speaker 1 [00:12]: <what they said>`;

async function startResumableUpload(apiKey, numBytes, mimeType, displayName) {
  const res = await fetch(`${BASE}/upload/v1beta/files?key=${apiKey}`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(numBytes),
      'X-Goog-Upload-Header-Content-Type': mimeType,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: displayName || 'recording' } }),
  });
  if (!res.ok) throw new Error(`Gemini upload start failed (${res.status}): ${await res.text()}`);
  const url = res.headers.get('x-goog-upload-url');
  if (!url) throw new Error('Gemini did not return an upload URL');
  return url;
}

async function uploadBytes(uploadUrl, bytes) {
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Length': String(bytes.length),
      'X-Goog-Upload-Offset': '0',
      'X-Goog-Upload-Command': 'upload, finalize',
    },
    body: bytes,
  });
  if (!res.ok) throw new Error(`Gemini upload failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return data.file; // { name: 'files/…', uri, state, mimeType }
}

// Files are PROCESSING right after upload; audio must be ACTIVE before use.
async function waitUntilActive(apiKey, fileName, maxWaitMs = 5 * 60 * 1000) {
  const started = Date.now();
  while (Date.now() - started < maxWaitMs) {
    const res = await fetch(`${BASE}/v1beta/${fileName}?key=${apiKey}`);
    if (!res.ok) throw new Error(`Gemini file status failed (${res.status}): ${await res.text()}`);
    const data = await res.json();
    if (data.state === 'ACTIVE') return;
    if (data.state === 'FAILED') throw new Error('Gemini could not process the audio file');
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('Gemini file did not become ACTIVE in time');
}

async function deleteFile(apiKey, fileName) {
  try { await fetch(`${BASE}/v1beta/${fileName}?key=${apiKey}`, { method: 'DELETE' }); }
  catch (e) { console.error('Gemini file cleanup failed:', e.message); }
}

async function generate(apiKey, model, fileUri, mimeType) {
  const res = await fetch(`${BASE}/v1beta/models/${model}:generateContent?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: TRANSCRIBE_PROMPT }, { file_data: { mime_type: mimeType, file_uri: fileUri } }] }],
    }),
  });
  if (!res.ok) throw new Error(`Gemini transcription failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
  return parts.map((p) => p.text || '').join('').trim();
}

// Transcribe an audio file. Caller passes a Gemini-supported mime (mp3/wav/…);
// the server transcodes to mp3 first, so this always gets a friendly format.
async function transcribeAudio(filePath, mimeType, { apiKey, model }) {
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured on the server');
  const bytes = fs.readFileSync(filePath);
  const uploadUrl = await startResumableUpload(apiKey, bytes.length, mimeType, 'recording');
  const file = await uploadBytes(uploadUrl, bytes);
  try {
    await waitUntilActive(apiKey, file.name);
    return await generate(apiKey, model, file.uri, mimeType);
  } finally {
    await deleteFile(apiKey, file.name);
  }
}

module.exports = { transcribeAudio };
