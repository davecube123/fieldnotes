// Optional off-device backup: commits a sealed export into a private GitHub
// repository over the Contents API.
//
// This is the one place the app talks to the network, and only when you have
// configured it. What leaves the device is the same ciphertext you would get
// from a manual sealed export — GitHub stores a blob it cannot read. Each push
// is a commit, so the repository's history is your versioned backup.

const API = 'https://api.github.com';

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const CHUNK = 0x8000; // spreading the whole array blows the argument limit
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function call(config, path, init = {}) {
  const res = await fetch(`${API}/repos/${config.owner}/${config.repo}/contents/${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  return res;
}

function describe(status) {
  if (status === 401) return 'GitHub rejected the token. It may be expired or mistyped.';
  if (status === 403) return 'GitHub refused the request — usually the token lacks Contents write access.';
  if (status === 404) return 'Repository or path not found, or the token cannot see it.';
  if (status === 409) return 'The file changed on GitHub since this device last looked. Try again.';
  return `GitHub returned ${status}.`;
}

// Confirms the token can actually reach the repository before it is stored,
// so a typo surfaces now rather than silently at 3am in six weeks.
export async function verify(config) {
  const res = await fetch(`${API}/repos/${config.owner}/${config.repo}`, {
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) throw new Error(describe(res.status));
  const repo = await res.json();
  if (!repo.permissions?.push) throw new Error('That token can read the repository but not write to it.');
  return { private: repo.private, fullName: repo.full_name };
}

export async function push(config, sealedPayload) {
  const path = config.path || 'fieldnotes.fnotes';
  const body = JSON.stringify(sealedPayload, null, 2);

  // An existing file needs its blob sha, a new one must not send the field.
  let sha;
  const existing = await call(config, path);
  if (existing.ok) sha = (await existing.json()).sha;
  else if (existing.status !== 404) throw new Error(describe(existing.status));

  const res = await call(config, path, {
    method: 'PUT',
    body: JSON.stringify({
      message: `Backup ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`,
      content: toBase64(body),
      ...(sha ? { sha } : {}),
    }),
  });
  if (!res.ok) throw new Error(describe(res.status));

  const result = await res.json();
  return { commit: result.commit?.sha?.slice(0, 7), bytes: body.length, path };
}
