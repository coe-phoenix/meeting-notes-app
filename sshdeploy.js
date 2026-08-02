// SSH-based deploy: run a full root shell on a freshly provisioned Dojo VM.
// Dojo's run_command allowlist is too narrow to install a Node runtime (apt and
// `docker run` are blocked, and the stock image has no Node), so instead we add
// an ephemeral SSH key to the VM (via the MCP's add_ssh_key) and SSH in from this
// app to run an unrestricted install/deploy script — exactly like the manual
// playbook. Uses the system `ssh`/`ssh-keygen` (present on the app host) so there
// is no native npm dependency.

const { spawn, execFile } = require('child_process');
const { mkdtempSync, rmSync, readFileSync } = require('fs');
const { tmpdir } = require('os');
const { join } = require('path');
const { promisify } = require('util');
const execFileP = promisify(execFile);

// ssh options: key-only (BatchMode) and NO host-key checking against a known
// file — these are throwaway boxes we just created, and recycled cloud IPs often
// carry a stale host key that would make `accept-new` fail ("Host key
// verification failed"). Disabling the check + /dev/null known_hosts is correct
// here: identity is proven by our just-generated keypair, not by a pinned host key.
const sshOpts = (keyPath) => [
  '-i', keyPath,
  '-o', 'IdentitiesOnly=yes',
  '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=no',
  '-o', 'UserKnownHostsFile=/dev/null',
  '-o', 'GlobalKnownHostsFile=/dev/null',
  '-o', 'ConnectTimeout=10',
  // Keepalive: a long, silent remote step (e.g. apt) must not let an idle NAT/
  // firewall drop the connection — send a probe every 15s, tolerate ~2min of no
  // reply. Without this the deploy can die mid-install.
  '-o', 'ServerAliveInterval=15',
  '-o', 'ServerAliveCountMax=8',
  '-o', 'LogLevel=ERROR',
];

// Generate an ephemeral ed25519 keypair in a temp dir. Returns the private-key
// path, the OpenSSH public key line, and the dir (pass to cleanup() when done).
async function genKeyPair() {
  const dir = mkdtempSync(join(tmpdir(), 'mn-deploy-'));
  const keyPath = join(dir, 'id');
  try {
    await execFileP('ssh-keygen', ['-t', 'ed25519', '-N', '', '-q', '-f', keyPath, '-C', 'meeting-notes-deploy']);
  } catch (e) {
    cleanup(dir);
    if (e.code === 'ENOENT') throw new Error('ssh-keygen not found on the app host — install openssh-client to enable SSH deploys.');
    throw e;
  }
  const publicKey = readFileSync(`${keyPath}.pub`, 'utf8').trim();
  return { dir, keyPath, publicKey };
}

function cleanup(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// Poll an SSH login until it succeeds (the box + our key are ready). Resolves
// true on success, false if aborted; throws on timeout.
async function waitForSsh({ host, keyPath, onStatus, isAborted, timeoutMs = 5 * 60 * 1000 }) {
  const start = Date.now();
  for (;;) {
    if (isAborted && isAborted()) return false;
    if (Date.now() - start > timeoutMs) throw new Error(`SSH did not become reachable on ${host} within ${Math.round(timeoutMs / 1000)}s`);
    const ok = await new Promise((resolve) => {
      const p = spawn('ssh', [...sshOpts(keyPath), `root@${host}`, 'true']);
      p.on('error', () => resolve(false));
      p.on('close', (code) => resolve(code === 0));
    });
    if (ok) return true;
    if (onStatus) onStatus(`Waiting for SSH on ${host}… ${Math.round((Date.now() - start) / 1000)}s`);
    await new Promise((r) => setTimeout(r, 10000));
  }
}

// Run a bash script on the VM over SSH, streaming stdout+stderr line-wise to
// onData. Resolves { code, output }. The script is fed on stdin (`bash -s`), so
// it can be arbitrarily long and use full shell features.
function runScript({ host, keyPath, script, onData }) {
  return new Promise((resolve, reject) => {
    const p = spawn('ssh', [...sshOpts(keyPath), `root@${host}`, 'bash -s'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    const feed = (buf) => { const t = buf.toString(); output += t; if (onData) onData(t); };
    p.stdout.on('data', feed);
    p.stderr.on('data', feed);
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, output }));
    p.stdin.write(script);
    p.stdin.end();
  });
}

module.exports = { genKeyPair, cleanup, waitForSsh, runScript };
