// Tiny in-memory sliding-window rate limiter (Phase 5.5). Guards the upload
// endpoints against scripted abuse independently of the minutes quota — a burst
// of tiny uploads never reaches transcription in the first place.
//
// Single-process only (matches the in-process job queue); if this ever scales to
// multiple workers, swap the Map for Redis. No dependency.

// key -> array of request timestamps (ms) within the window.
const hits = new Map();

// Returns { ok, retryAfterSec }. Records the hit when allowed.
function check(key, limit, windowMs) {
  if (!limit || limit <= 0) return { ok: true }; // 0 = disabled
  const now = Date.now();
  const cutoff = now - windowMs;
  const arr = (hits.get(key) || []).filter((t) => t > cutoff);
  if (arr.length >= limit) {
    const retryAfterSec = Math.max(1, Math.ceil((arr[0] + windowMs - now) / 1000));
    hits.set(key, arr);
    return { ok: false, retryAfterSec };
  }
  arr.push(now);
  hits.set(key, arr);
  return { ok: true };
}

// Periodically drop empty/expired buckets so the Map doesn't grow unbounded.
function sweep(windowMs) {
  const cutoff = Date.now() - windowMs;
  for (const [k, arr] of hits) {
    const kept = arr.filter((t) => t > cutoff);
    if (kept.length) hits.set(k, kept);
    else hits.delete(k);
  }
}

module.exports = { check, sweep };
