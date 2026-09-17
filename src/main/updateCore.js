'use strict';
// Pure helpers for the update checker (no Electron imports → unit-testable).

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v == null ? '' : v).trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ? m[4].split('.') : [] };
}

// 1 if a > b, -1 if a < b, 0 if equal, null if either is not a version.
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (const k of ['major', 'minor', 'patch']) {
    if (x[k] !== y[k]) return x[k] > y[k] ? 1 : -1;
  }
  if (!x.pre.length && !y.pre.length) return 0;
  if (!x.pre.length) return 1; // 1.0.0 > 1.0.0-beta
  if (!y.pre.length) return -1;
  const n = Math.max(x.pre.length, y.pre.length);
  for (let i = 0; i < n; i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      if (+p !== +q) return +p > +q ? 1 : -1;
    } else if (pn !== qn) {
      return pn ? -1 : 1;
    } else if (p !== q) {
      return p > q ? 1 : -1;
    }
  }
  return 0;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// "owner/repo" from env or package.json → '' when unset / placeholder.
function resolveRepo(pkg, env = {}) {
  const raw = String(env.CLIPSHELF_UPDATE_REPO || (pkg && pkg.harbor && pkg.harbor.updateRepo) || '').trim();
  if (!REPO_RE.test(raw) || /^(OWNER|YOUR[-_]?ORG|example)\//i.test(raw)) return '';
  return raw;
}

function feedFor(repo, env = {}) {
  if (env.CLIPSHELF_UPDATE_FEED) return { feed: env.CLIPSHELF_UPDATE_FEED, api: null, page: null };
  if (!repo) return null;
  return {
    // The "latest/download" URL is served from GitHub's CDN and is not
    // subject to the 60 requests/hour API limit shared by an office's IP.
    feed: `https://github.com/${repo}/releases/latest/download/latest.json`,
    api: `https://api.github.com/repos/${repo}/releases/latest`,
    page: `https://github.com/${repo}/releases/latest`
  };
}

function classifyAsset(name) {
  const n = String(name || '').toLowerCase();
  let platform = null;
  let kind = null;
  if (n.endsWith('.blockmap') || n.endsWith('.yml') || n.endsWith('.json') || n.endsWith('.txt')) return null;
  if (n.endsWith('.dmg')) [platform, kind] = ['darwin', 'dmg'];
  else if (n.endsWith('.zip') && /(^|[-_.])(mac|darwin|osx)([-_.]|$)/.test(n)) [platform, kind] = ['darwin', 'zip'];
  else if (n.endsWith('.exe')) [platform, kind] = ['win32', 'exe'];
  else if (n.endsWith('.appimage')) [platform, kind] = ['linux', 'appimage'];
  else return null;
  const arch = /universal/.test(n) ? 'universal' : /(arm64|aarch64)/.test(n) ? 'arm64' : /(x64|x86_64|amd64)/.test(n) ? 'x64' : null;
  return { platform, kind, arch };
}

function isHttpsUrl(u, { allowLocalHttp = false } = {}) {
  try {
    const url = new URL(u);
    if (url.protocol === 'https:') return true;
    return allowLocalHttp && url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname);
  } catch {
    return false;
  }
}

function cleanSha(v) {
  const s = String(v || '').trim().toLowerCase().replace(/^sha256:/, '');
  return /^[0-9a-f]{64}$/.test(s) ? s : null;
}

// Accepts either our latest.json or the GitHub "latest release" API shape.
function normalizeRelease(json, { allowLocalHttp = false } = {}) {
  if (!json || typeof json !== 'object') throw new Error('invalid-feed');
  const fromApi = 'tag_name' in json;
  const version = String(fromApi ? json.tag_name : json.version || '').replace(/^v/, '');
  if (!parseVersion(version)) throw new Error('invalid-version');
  if (fromApi && (json.draft || json.prerelease)) throw new Error('not-a-release');
  const list = Array.isArray(json.assets) ? json.assets : [];
  const assets = [];
  for (const a of list) {
    if (!a || typeof a !== 'object') continue;
    const name = String(a.name || '');
    const url = fromApi ? a.browser_download_url : a.url;
    const cls = classifyAsset(name);
    if (!cls || !isHttpsUrl(url, { allowLocalHttp })) continue;
    assets.push({
      name,
      url,
      size: Number(a.size) > 0 ? Number(a.size) : null,
      sha256: cleanSha(fromApi ? a.digest : a.sha256),
      platform: a.platform || cls.platform,
      kind: a.kind || cls.kind,
      arch: a.arch !== undefined ? a.arch : cls.arch
    });
  }
  const page = fromApi ? json.html_url : json.page;
  return {
    version,
    notes: String((fromApi ? json.body : json.notes) || '').slice(0, 4000),
    page: isHttpsUrl(page, { allowLocalHttp }) ? page : null,
    publishedAt: (fromApi ? json.published_at : json.publishedAt) || null,
    assets
  };
}

// Best asset of `kind` for this machine. Windows on ARM can run x64 builds,
// so x64 is an acceptable fallback there.
function pickAsset(assets, { platform, arch, kind }) {
  const pool = (assets || []).filter((a) => a.platform === platform && (!kind || a.kind === kind));
  const order = [arch, 'universal', null];
  if (platform === 'win32' && arch === 'arm64') order.push('x64');
  for (const want of order) {
    const hit = pool.find((a) => a.arch === want);
    if (hit) return hit;
  }
  return null;
}

// "/Applications/HarboR ClipShelf.app/Contents/MacOS/HarboR ClipShelf" → bundle path
function macBundlePath(execPath) {
  const m = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(String(execPath || ''));
  return m ? m[1] : null;
}

// Why an in-place swap is not possible (null = OK).
function macSwapBlocker(bundle) {
  if (!bundle) return 'not-bundle';
  if (/\/AppTranslocation\//.test(bundle)) return 'translocated';
  if (/^\/Volumes\//.test(bundle)) return 'on-disk-image';
  return null;
}

module.exports = {
  parseVersion, compareVersions, resolveRepo, feedFor, classifyAsset, isHttpsUrl, cleanSha,
  normalizeRelease, pickAsset, macBundlePath, macSwapBlocker
};
