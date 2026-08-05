// OAuth 2.1 (PKCE + dynamic client registration) for connecting the AI-pipeline
// to an MCP server that is protected by a browser-based OAuth flow — e.g. the Dojo
// marketplace MCP, which issues short-lived (1 h) access tokens plus rotating
// refresh tokens. The Anthropic MCP connector can only send a static bearer token,
// so we run the OAuth dance ourselves, persist the refresh token, and mint a fresh
// access token before each pipeline run.
//
// This module is pure networking + crypto helpers (no DB, no Express) so the PKCE
// and URL logic can be unit-tested. server.js owns the settings storage + routes.

const crypto = require('crypto');

const b64url = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Normalise a user-entered MCP URL: add https:// if no scheme, drop a trailing
// slash on the path only (keep the origin usable). Returns '' for empty input.
function normalizeUrl(url) {
  const s = String(url || '').trim();
  if (!s) return '';
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  try { return new URL(withScheme).toString().replace(/\/$/, ''); } catch { return withScheme.replace(/\/$/, ''); }
}

// PKCE (S256): a high-entropy verifier and its SHA-256 challenge.
function makePkce() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

const randomState = () => b64url(crypto.randomBytes(16));

async function getJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`GET ${url} → ${r.status}`);
  return r.json();
}
async function safeText(r) { try { return (await r.text()).slice(0, 300); } catch { return ''; } }

// Discover the authorization server for an MCP resource. Follows RFC 9728
// (protected-resource metadata → authorization_servers[0]) when present, then
// reads that server's OAuth metadata; falls back to the MCP origin directly.
async function discover(mcpUrl) {
  const origin = new URL(mcpUrl).origin;
  let asBase = origin;
  try {
    const pr = await getJson(`${origin}/.well-known/oauth-protected-resource`);
    if (pr && Array.isArray(pr.authorization_servers) && pr.authorization_servers[0]) {
      asBase = String(pr.authorization_servers[0]).replace(/\/$/, '');
    }
  } catch { /* no protected-resource doc — use the origin */ }

  let meta;
  try { meta = await getJson(`${asBase}/.well-known/oauth-authorization-server`); }
  catch { meta = await getJson(`${asBase}/.well-known/openid-configuration`); }
  if (!meta || !meta.authorization_endpoint || !meta.token_endpoint) {
    throw new Error('MCP server did not advertise OAuth endpoints (authorization/token).');
  }
  return {
    issuer: meta.issuer || asBase,
    authorize: meta.authorization_endpoint,
    token: meta.token_endpoint,
    registration: meta.registration_endpoint || null,
    revoke: meta.revocation_endpoint || null,
    scopes: Array.isArray(meta.scopes_supported) ? meta.scopes_supported : [],
  };
}

// Dynamic Client Registration (RFC 7591). Returns { client_id, client_secret? }.
async function registerClient({ registration, redirectUri, scope }) {
  if (!registration) throw new Error('MCP server does not support dynamic client registration.');
  const r = await fetch(registration, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'NoteWise AI Pipeline',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post',
      ...(scope ? { scope } : {}),
    }),
  });
  if (!r.ok) throw new Error(`client registration failed (${r.status}): ${await safeText(r)}`);
  return r.json();
}

// Build the browser authorize URL the admin is redirected to.
function buildAuthorizeUrl({ authorize, clientId, redirectUri, challenge, state, scope, resource }) {
  const u = new URL(authorize);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('state', state);
  if (scope) u.searchParams.set('scope', scope);
  if (resource) u.searchParams.set('resource', resource); // RFC 8707
  return u.toString();
}

async function postForm(tokenEndpoint, params) {
  const r = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(params).toString(),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`token endpoint ${r.status}: ${body.error_description || body.error || JSON.stringify(body).slice(0, 200)}`);
  return body; // { access_token, refresh_token?, expires_in, token_type, ... }
}

const exchangeCode = ({ token, code, redirectUri, clientId, clientSecret, verifier, resource }) =>
  postForm(token, {
    grant_type: 'authorization_code', code, redirect_uri: redirectUri,
    client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}),
    code_verifier: verifier, ...(resource ? { resource } : {}),
  });

const refresh = ({ token, refreshToken, clientId, clientSecret, resource }) =>
  postForm(token, {
    grant_type: 'refresh_token', refresh_token: refreshToken,
    client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}),
    ...(resource ? { resource } : {}),
  });

module.exports = {
  normalizeUrl, makePkce, randomState, discover, registerClient,
  buildAuthorizeUrl, exchangeCode, refresh,
};
