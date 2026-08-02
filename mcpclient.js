// Minimal MCP JSON-RPC client over the Streamable-HTTP transport, so the SERVER
// can call an MCP's tools directly (not just hand them to Claude). Used to
// introspect the connected MCP (tools/list) and, for autonomous deploy, to call
// provisioning tools like create_server / add_ssh_key / get_server with the
// OAuth access token we already mint (see mcpoauth.js / mcpAccessToken).
//
// Streamable HTTP: POST JSON-RPC to the server URL. The response is either
// application/json or a text/event-stream carrying one `data:` JSON-RPC message.
// A session id may come back in the `Mcp-Session-Id` header and must be echoed on
// later requests. We open a fresh short session per operation (low volume).

const PROTOCOL_VERSION = '2025-06-18';

function parseBody(contentType, text) {
  if ((contentType || '').includes('text/event-stream')) {
    // Concatenate all `data:` lines and parse the last JSON object seen.
    let out = null;
    for (const line of text.split(/\r?\n/)) {
      const m = /^data:\s?(.*)$/.exec(line);
      if (m && m[1].trim()) { try { out = JSON.parse(m[1]); } catch { /* partial */ } }
    }
    if (out) return out;
    throw new Error('could not parse SSE MCP response');
  }
  return JSON.parse(text);
}

async function post(url, token, sessionId, payload, extraHeaders = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  return { res, text, sessionId: res.headers.get('mcp-session-id') || sessionId };
}

// Open a session: initialize handshake + the initialized notification.
async function openSession(url, token) {
  const init = await post(url, token, null, {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'meeting-notes-app', version: '1.0' } },
  });
  if (!init.res.ok) throw new Error(`MCP initialize ${init.res.status}: ${init.text.slice(0, 300)}`);
  const parsed = parseBody(init.res.headers.get('content-type'), init.text);
  if (parsed.error) throw new Error(`MCP initialize error: ${parsed.error.message || JSON.stringify(parsed.error)}`);
  const sessionId = init.sessionId;
  // Best-effort initialized notification (some servers require it before tool calls).
  try { await post(url, token, sessionId, { jsonrpc: '2.0', method: 'notifications/initialized' }); } catch { /* ignore */ }
  return sessionId;
}

async function call(url, token, sessionId, method, params) {
  const r = await post(url, token, sessionId, { jsonrpc: '2.0', id: Date.now(), method, params });
  if (!r.res.ok) throw new Error(`MCP ${method} ${r.res.status}: ${r.text.slice(0, 300)}`);
  const parsed = parseBody(r.res.headers.get('content-type'), r.text);
  if (parsed.error) throw new Error(`MCP ${method} error: ${parsed.error.message || JSON.stringify(parsed.error)}`);
  return parsed.result;
}

// List the MCP's tools → [{ name, description, inputSchema }].
async function listTools(url, token) {
  const sessionId = await openSession(url, token);
  const result = await call(url, token, sessionId, 'tools/list', {});
  return (result && result.tools) || [];
}

// Call one tool → its result (content blocks / structured content).
async function callTool(url, token, name, args) {
  const sessionId = await openSession(url, token);
  return call(url, token, sessionId, 'tools/call', { name, arguments: args || {} });
}

module.exports = { PROTOCOL_VERSION, parseBody, listTools, callTool };
