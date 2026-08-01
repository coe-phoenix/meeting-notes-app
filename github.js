// Create a NEW private GitHub repo and open a pull request with generated files.
// REST via fetch (no SDK), matching how Soniox/Gemini/Resend are called.
//
// Safety: this only ever CREATES a new repo (never touches existing ones) and
// lands the code on a `poc` branch behind a PR — the human reviews/merges. It
// never merges or deploys.
const API = 'https://api.github.com';

async function gh(token, method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'meeting-notes-app',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    let hint = '';
    if (res.status === 401) hint = ' — GITHUB_TOKEN is invalid or expired';
    else if (res.status === 403) hint = ' — token lacks permission (needs repo scope) or hit a rate limit';
    else if (res.status === 422) hint = ' — invalid request (a repo with that name may already exist)';
    throw new Error(`GitHub ${method} ${path} failed (${res.status})${hint}: ${text}`);
  }
  return res.status === 204 ? null : res.json();
}

async function resolveOwner(token, ownerEnv) {
  if (ownerEnv) return { owner: ownerEnv, isOrg: true };
  const me = await gh(token, 'GET', '/user');
  return { owner: me.login, isOrg: false };
}

// files: [{ path, content }]. Returns { repoUrl, prUrl }.
async function createRepoWithPR({ token, ownerEnv, name, files, prTitle, prBody }) {
  if (!token) throw new Error('GITHUB_TOKEN is not configured on the server');
  const { owner, isOrg } = await resolveOwner(token, ownerEnv);

  // 1. Create the repo (private, with an initial commit so `main` exists).
  const repo = await gh(token, 'POST', isOrg ? `/orgs/${owner}/repos` : '/user/repos', {
    name, private: true, auto_init: true,
    description: (prTitle || 'Meeting-notes POC').slice(0, 100),
  });
  const fullName = repo.full_name; // owner/name
  const base = repo.default_branch || 'main';

  // 2. Base commit + its tree (from auto_init's README commit).
  const ref = await gh(token, 'GET', `/repos/${fullName}/git/ref/heads/${base}`);
  const baseSha = ref.object.sha;
  const baseCommit = await gh(token, 'GET', `/repos/${fullName}/git/commits/${baseSha}`);

  // 3. Blobs → tree → commit.
  const tree = [];
  for (const f of files) {
    const blob = await gh(token, 'POST', `/repos/${fullName}/git/blobs`, {
      content: Buffer.from(f.content, 'utf8').toString('base64'), encoding: 'base64',
    });
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const newTree = await gh(token, 'POST', `/repos/${fullName}/git/trees`, {
    base_tree: baseCommit.tree.sha, tree,
  });
  const commit = await gh(token, 'POST', `/repos/${fullName}/git/commits`, {
    message: 'Add generated POC from meeting minutes', tree: newTree.sha, parents: [baseSha],
  });

  // 4. New branch `poc` at that commit, then a PR into the default branch.
  await gh(token, 'POST', `/repos/${fullName}/git/refs`, { ref: 'refs/heads/poc', sha: commit.sha });
  const pr = await gh(token, 'POST', `/repos/${fullName}/pulls`, {
    title: prTitle || 'Generated POC', head: 'poc', base,
    body: (prBody || '') + '\n\n---\n_Generated from meeting minutes. Review before merging or deploying._',
  });

  return { repoUrl: repo.html_url, prUrl: pr.html_url };
}

module.exports = { createRepoWithPR };
