// Bump CACHE_VERSION on every deploy that changes the shell. Old caches are
// deleted on activate, which prevents the classic PWA failure mode of serving
// stale JavaScript forever.
const CACHE_VERSION = 'notewise-v2';

const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/favicon-32.png',
  '/notewise-logo.png',
  '/icon-192.png',
  '/icon-512.png',
];

self.addEventListener('install', (event) => {
  // Cache the shell, but never fail installation just because one asset 404s
  // or returns 401 behind the password gate.
  event.waitUntil(
    caches.open(CACHE_VERSION).then(async (cache) => {
      await Promise.allSettled(SHELL.map((url) => cache.add(url)));
      self.skipWaiting();
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only GET is cacheable. Audio uploads are POSTs and must go straight to the
  // network — never buffer a 300MB body through the service worker.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Never cache API traffic: transcripts and Telegram sends must always be live.
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return;

  // Cross-origin passes through untouched.
  if (url.origin !== self.location.origin) return;

  // Network-first so a redeploy is picked up immediately; cache is only a
  // fallback for genuine offline use.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then(
          (cached) =>
            cached ||
            new Response(
              '<h1>Offline</h1><p>NoteWise needs a connection to transcribe audio.</p>',
              { status: 503, headers: { 'Content-Type': 'text/html' } }
            )
        )
      )
  );
});
