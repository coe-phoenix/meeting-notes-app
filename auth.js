// Phase 5 — thin per-user auth: passwordless magic links over email (Resend).
// Sessions are opaque random tokens; we store only their SHA-256 hash and hand
// the raw token to the browser in an httpOnly cookie. No JWT, no session secret,
// no extra npm dependency (Resend is called over its REST API with fetch).
//
// Enabled only when AUTH=magic. Otherwise server.js keeps its APP_PASSWORD gate,
// so existing single-user deployments and the test suites are unaffected.
const crypto = require('crypto');

const COOKIE_NAME = 'mn_session';
const TOKEN_TTL_MS = (parseFloat(process.env.LOGIN_TOKEN_TTL_MINUTES) > 0
  ? parseFloat(process.env.LOGIN_TOKEN_TTL_MINUTES) : 15) * 60 * 1000;
const SESSION_TTL_MS = (parseFloat(process.env.SESSION_TTL_DAYS) > 0
  ? parseFloat(process.env.SESSION_TTL_DAYS) : 30) * 24 * 60 * 60 * 1000;

const enabled = process.env.AUTH === 'magic';
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const RESEND_FROM = process.env.RESEND_FROM || 'Meeting Notes <onboarding@resend.dev>';
const APP_BASE_URL = (process.env.APP_BASE_URL || '').replace(/\/$/, '');
const ADMIN_EMAILS = new Set(
  (process.env.ADMIN_EMAILS || '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
);
const COOKIE_SECURE = APP_BASE_URL.startsWith('https://');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > -1) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function setSessionCookie(res, rawToken) {
  const attrs = [
    `${COOKIE_NAME}=${rawToken}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (COOKIE_SECURE) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

function clearSessionCookie(res) {
  const attrs = [`${COOKIE_NAME}=`, 'HttpOnly', 'Path=/', 'SameSite=Lax', 'Max-Age=0'];
  if (COOKIE_SECURE) attrs.push('Secure');
  res.append('Set-Cookie', attrs.join('; '));
}

// Send the login link via Resend. With no API key configured we log it instead
// (dev fallback) so the flow is fully usable before email is wired up.
async function sendMagicLink(email, link) {
  if (!RESEND_API_KEY) {
    console.log(`[auth] (no RESEND_API_KEY) magic link for ${email}: ${link}`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: RESEND_FROM,
      to: [email],
      subject: 'Your Meeting Notes login link',
      html: `<p>Click to sign in to Meeting Notes:</p>
             <p><a href="${link}">Sign in</a></p>
             <p>This link expires in ${Math.round(TOKEN_TTL_MS / 60000)} minutes and can be used once. If you didn't request it, ignore this email.</p>`,
    }),
  });
  if (!res.ok) throw new Error(`Resend send failed (${res.status}): ${await res.text()}`);
}

// Wire cookie-session middleware + the auth routes onto the app. `db` is ./db.
function attach(app, db) {
  // 1) Attach req.user (+ req.authSession) from the session cookie, if any.
  app.use((req, res, next) => {
    const raw = parseCookies(req)[COOKIE_NAME];
    if (raw) {
      const session = db.getSession(sha256(raw));
      if (session) {
        const user = db.getUserById(session.user_id);
        if (user) { req.user = user; req.authSession = session; }
      }
    }
    next();
  });

  // 2) Gate: allow the login UI + auth endpoints through; block data routes.
  app.use((req, res, next) => {
    if (req.user) return next();
    const p = req.path;
    if (p.startsWith('/api/auth/') || p === '/auth/verify' || p === '/healthz') return next();
    // GET /api/me is intentionally public: it lets the client learn that auth is
    // ON but nobody is signed in (so it can render the login screen) rather than
    // getting a bare 401 it can't distinguish from auth being off.
    if (req.method === 'GET' && p === '/api/me') return next();
    // Let GETs for the SPA shell + static assets load so the login screen renders.
    if (req.method === 'GET' && !p.startsWith('/api/')) return next();
    return res.status(401).json({ error: 'Not authenticated' });
  });

  // 3) Request a magic link. Always 200 (don't leak which emails exist); any
  // valid email is allowed — the account is created on first verify.
  app.post('/api/auth/request', async (req, res) => {
    try {
      const email = String((req.body && req.body.email) || '').toLowerCase().trim();
      if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address' });
      if (!APP_BASE_URL) throw new Error('APP_BASE_URL is not configured on the server');

      const rawToken = crypto.randomBytes(32).toString('hex');
      db.createLoginToken(sha256(rawToken), email, TOKEN_TTL_MS);
      await sendMagicLink(email, `${APP_BASE_URL}/auth/verify?token=${rawToken}`);
      res.json({ ok: true });
    } catch (err) {
      console.error('auth/request failed:', err.message);
      res.status(500).json({ error: 'Could not send the login link. Try again shortly.' });
    }
  });

  // 4) Verify a magic link: consume token, find/create user, start a session.
  app.get('/auth/verify', (req, res) => {
    const raw = String(req.query.token || '');
    const row = raw && db.consumeLoginToken(sha256(raw));
    if (!row) return res.redirect('/?login=expired');

    let user = db.getUserByEmail(row.email);
    if (!user) user = db.createUser({ email: row.email, is_admin: ADMIN_EMAILS.has(row.email) ? 1 : 0 });
    db.setUserLastLogin(user.id);

    const sessionToken = crypto.randomBytes(32).toString('hex');
    db.createSession(sha256(sessionToken), user.id, SESSION_TTL_MS);
    setSessionCookie(res, sessionToken);
    res.redirect('/');
  });

  // 5) Logout: drop the server session + cookie.
  app.post('/api/auth/logout', (req, res) => {
    if (req.authSession) db.deleteSession(req.authSession.token_hash);
    clearSessionCookie(res);
    res.json({ ok: true });
  });
}

module.exports = {
  enabled,
  attach,
  clearSessionCookie,
  COOKIE_NAME,
  SESSION_TTL_MS,
  isAdminEmail: (email) => ADMIN_EMAILS.has(String(email).toLowerCase().trim()),
};
