'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const core = require('../src/main/updateCore');
const { Updater } = require('../src/main/updater');

test('compareVersions orders releases and prereleases', () => {
  assert.equal(core.compareVersions('1.2.0', '1.1.9'), 1);
  assert.equal(core.compareVersions('v1.0.0', '1.0.0'), 0);
  assert.equal(core.compareVersions('1.0.0', '1.0.1'), -1);
  assert.equal(core.compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(core.compareVersions('1.0.0', '1.0.0-beta.2'), 1);
  assert.equal(core.compareVersions('1.0.0-beta.10', '1.0.0-beta.2'), 1);
  assert.equal(core.compareVersions('1.0.0-alpha', '1.0.0-1'), 1);
  assert.equal(core.compareVersions('junk', '1.0.0'), null);
});

test('resolveRepo ignores placeholders and bad values', () => {
  assert.equal(core.resolveRepo({ harbor: { updateRepo: 'OWNER/harbor-clipshelf' } }), '');
  assert.equal(core.resolveRepo({ harbor: { updateRepo: 'harbor-live/clipshelf' } }), 'harbor-live/clipshelf');
  assert.equal(core.resolveRepo({ harbor: { updateRepo: 'a/b/c' } }), '');
  assert.equal(core.resolveRepo({}, { CLIPSHELF_UPDATE_REPO: 'x/y' }), 'x/y');
  assert.equal(core.feedFor(''), null);
  assert.match(core.feedFor('x/y').feed, /^https:\/\/github\.com\/x\/y\/releases\/latest\/download\/latest\.json$/);
});

test('classifyAsset understands electron-builder names', () => {
  assert.deepEqual(core.classifyAsset('HarboR-ClipShelf-1.1.0-mac-universal.dmg'), { platform: 'darwin', kind: 'dmg', arch: 'universal' });
  assert.deepEqual(core.classifyAsset('HarboR-ClipShelf-1.1.0-mac-universal.zip'), { platform: 'darwin', kind: 'zip', arch: 'universal' });
  assert.deepEqual(core.classifyAsset('HarboR-ClipShelf-1.1.0-win-arm64.exe'), { platform: 'win32', kind: 'exe', arch: 'arm64' });
  assert.deepEqual(core.classifyAsset('HarboR-ClipShelf-1.1.0-win.exe'), { platform: 'win32', kind: 'exe', arch: null });
  assert.equal(core.classifyAsset('HarboR-ClipShelf-1.1.0-win-x64.exe.blockmap'), null);
  assert.equal(core.classifyAsset('source.zip'), null);
  assert.equal(core.classifyAsset('latest.json'), null);
});

const API_RELEASE = {
  tag_name: 'v1.2.0',
  body: 'notes',
  html_url: 'https://github.com/x/y/releases/tag/v1.2.0',
  draft: false,
  prerelease: false,
  assets: [
    { name: 'HarboR-ClipShelf-1.2.0-win-x64.exe', browser_download_url: 'https://github.com/x/y/releases/download/v1.2.0/a.exe', size: 10, digest: `sha256:${'a'.repeat(64)}` },
    { name: 'HarboR-ClipShelf-1.2.0-mac-universal.dmg', browser_download_url: 'https://github.com/x/y/releases/download/v1.2.0/a.dmg', size: 10 },
    { name: 'evil.exe', browser_download_url: 'http://example.com/evil.exe', size: 1 }
  ]
};

test('normalizeRelease reads the GitHub API shape and drops non-https assets', () => {
  const rel = core.normalizeRelease(API_RELEASE);
  assert.equal(rel.version, '1.2.0');
  assert.equal(rel.assets.length, 2);
  assert.equal(rel.assets[0].sha256, 'a'.repeat(64));
  assert.throws(() => core.normalizeRelease({ ...API_RELEASE, draft: true }));
  assert.throws(() => core.normalizeRelease({ version: 'nope' }));
});

test('pickAsset prefers the exact arch, then universal, then x64 on Windows ARM', () => {
  const assets = [
    { platform: 'win32', kind: 'exe', arch: 'x64', name: 'x64' },
    { platform: 'win32', kind: 'exe', arch: null, name: 'combined' },
    { platform: 'darwin', kind: 'dmg', arch: 'universal', name: 'dmg' }
  ];
  assert.equal(core.pickAsset(assets, { platform: 'win32', arch: 'x64', kind: 'exe' }).name, 'x64');
  assert.equal(core.pickAsset(assets, { platform: 'win32', arch: 'arm64', kind: 'exe' }).name, 'combined');
  assert.equal(core.pickAsset(assets.slice(0, 1), { platform: 'win32', arch: 'arm64', kind: 'exe' }).name, 'x64');
  assert.equal(core.pickAsset(assets, { platform: 'darwin', arch: 'arm64', kind: 'dmg' }).name, 'dmg');
  assert.equal(core.pickAsset(assets, { platform: 'darwin', arch: 'arm64', kind: 'zip' }), null);
});

test('mac bundle helpers', () => {
  assert.equal(core.macBundlePath('/Applications/HarboR ClipShelf.app/Contents/MacOS/HarboR ClipShelf'), '/Applications/HarboR ClipShelf.app');
  assert.equal(core.macBundlePath('/usr/bin/node'), null);
  assert.equal(core.macSwapBlocker('/private/var/folders/x/AppTranslocation/y/d/HarboR ClipShelf.app'), 'translocated');
  assert.equal(core.macSwapBlocker('/Volumes/HarboR ClipShelf 1.0.0/HarboR ClipShelf.app'), 'on-disk-image');
  assert.equal(core.macSwapBlocker('/Applications/HarboR ClipShelf.app'), null);
});

// ---------------------------------------------------------------- Updater with a fake network
function fakeResponse(status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(buf.length) : headers[k] || null) },
    json: async () => JSON.parse(buf.toString()),
    body: new ReadableStream({
      start(c) {
        for (let i = 0; i < buf.length; i += 4) c.enqueue(new Uint8Array(buf.subarray(i, i + 4)));
        c.close();
      }
    })
  };
}

function makeUpdater({ routes, platform = 'win32', arch = 'x64', current = '1.1.0', settings = {} }) {
  let s = { updateCheckEnabled: true, skippedUpdateVersion: null, ...settings };
  const calls = [];
  const opened = [];
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-upd-'));
  const u = new Updater({
    getSettings: () => s,
    setSettings: (p) => (s = { ...s, ...p }),
    log: { info() {}, warn() {}, error() {} },
    fetch: async (url) => {
      calls.push(url);
      const r = routes[url];
      if (!r) return fakeResponse(404, '{}');
      if (r instanceof Error) throw r;
      return typeof r === 'function' ? r() : r;
    },
    shell: { openExternal: (url) => opened.push(url), openPath: async () => '' },
    quit: () => {},
    currentVersion: current,
    workDir,
    platform,
    arch,
    pkg: { harbor: { updateRepo: 'x/y' } },
    env: {}
  });
  return { u, calls, opened, workDir, settings: () => s };
}

const FEED = 'https://github.com/x/y/releases/latest/download/latest.json';
const API = 'https://api.github.com/repos/x/y/releases/latest';

test('check finds a newer release via latest.json and notifies once', async () => {
  const payload = Buffer.from('installer-bytes');
  const sha = crypto.createHash('sha256').update(payload).digest('hex');
  const feed = {
    version: '1.2.0',
    notes: 'hello',
    page: 'https://github.com/x/y/releases/tag/v1.2.0',
    assets: [{ name: 'HarboR-ClipShelf-1.2.0-win-x64.exe', url: 'https://github.com/x/y/releases/download/v1.2.0/HarboR-ClipShelf-1.2.0-win-x64.exe', size: payload.length, sha256: sha }]
  };
  const { u, workDir } = makeUpdater({ routes: { [FEED]: () => fakeResponse(200, feed), [feed.assets[0].url]: () => fakeResponse(200, payload) } });
  const seen = [];
  u.on('available', (st) => seen.push(st.latest.version));
  let st = await u.check();
  assert.equal(st.status, 'available');
  assert.equal(st.newer, true);
  assert.equal(st.latest.notes, 'hello');
  assert.equal(st.install.method, 'installer');
  await u.check();
  assert.deepEqual(seen, ['1.2.0']);

  const file = await u.download(u.latest.assets[0]);
  assert.equal(fs.readFileSync(file, 'utf8'), 'installer-bytes');
  assert.ok(fs.existsSync(path.join(workDir, '1.2.0')));
  u.cleanup('nothing');
  assert.ok(!fs.existsSync(path.join(workDir, '1.2.0')));
});

test('download rejects a checksum mismatch and leaves no file', async () => {
  const url = 'https://github.com/x/y/releases/download/v1.2.0/HarboR-ClipShelf-1.2.0-win-x64.exe';
  const feed = { version: '1.2.0', assets: [{ name: 'HarboR-ClipShelf-1.2.0-win-x64.exe', url, size: 5, sha256: 'b'.repeat(64) }] };
  const { u, workDir } = makeUpdater({ routes: { [FEED]: () => fakeResponse(200, feed), [url]: () => fakeResponse(200, 'hello') } });
  await u.check();
  const st = await u.install();
  assert.equal(st.status, 'error');
  assert.equal(st.error, 'corrupt');
  const dir = path.join(workDir, '1.2.0');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('falls back to the API when latest.json is missing; same version → latest', async () => {
  const { u, calls } = makeUpdater({ current: '1.2.0', routes: { [API]: () => fakeResponse(200, API_RELEASE) } });
  const st = await u.check({ manual: true });
  assert.equal(st.status, 'latest');
  assert.equal(st.newer, false);
  assert.deepEqual(calls, [FEED, API]);
});

test('skipped versions do not notify in the background but stay visible', async () => {
  const { u, opened } = makeUpdater({ platform: 'darwin', arch: 'arm64', settings: { skippedUpdateVersion: '1.2.0' }, routes: { [API]: () => fakeResponse(200, API_RELEASE) } });
  let notified = 0;
  u.on('available', () => notified++);
  const st = await u.check();
  assert.equal(notified, 0);
  assert.equal(st.skipped, true);
  assert.equal(st.install.method, 'dmg'); // not running from an .app bundle here
  assert.equal(st.latest.download.name, 'HarboR-ClipShelf-1.2.0-mac-universal.dmg');
  u.skip(null);
  assert.equal(u.state().skipped, false);
  u.openDownloadPage();
  assert.deepEqual(opened, ['https://github.com/x/y/releases/download/v1.2.0/a.dmg']);
});

test('network failures: silent in the background, reported when manual', async () => {
  const { u } = makeUpdater({ routes: { [FEED]: new Error('offline'), [API]: new Error('offline') } });
  let st = await u.check();
  assert.equal(st.status, 'idle');
  st = await u.check({ manual: true });
  assert.equal(st.status, 'error');
  assert.equal(st.error, 'network');
});

test('disabled checks and unconfigured repo', async () => {
  const { u, calls } = makeUpdater({ settings: { updateCheckEnabled: false }, routes: {} });
  await u.check();
  assert.equal(calls.length, 0);
  const none = new Updater({ getSettings: () => ({}), log: { info() {} }, pkg: {}, env: {}, currentVersion: '1.0.0' });
  assert.equal(none.state().status, 'unconfigured');
});

test('mac swap script replaces the bundle after the process exits', { skip: process.platform === 'win32' }, () => {
  const { MAC_SWAP_SCRIPT } = require('../src/main/updater');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-swap-'));
  const target = path.join(dir, 'Apps', 'My App.app');
  const fresh = path.join(dir, 'stage', 'My App.app');
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(fresh, { recursive: true });
  fs.writeFileSync(path.join(target, 'v'), 'old');
  fs.writeFileSync(path.join(fresh, 'v'), 'new');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'open'), '#!/bin/sh\necho "$1" > "$(dirname "$0")/opened"\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'xattr'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const script = path.join(dir, 'swap.sh');
  fs.writeFileSync(script, MAC_SWAP_SCRIPT, { mode: 0o755 });
  execFileSync('/bin/sh', [script, '999999', target, fresh], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(fs.readFileSync(path.join(target, 'v'), 'utf8'), 'new');
  assert.ok(!fs.existsSync(fresh));
  assert.equal(fs.readFileSync(path.join(bin, 'opened'), 'utf8').trim(), target);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'Apps')), ['My App.app']);

  // failure: the new app is missing → old app restored, marker written
  const marker = path.join(dir, 'swap-failed-9.9.9');
  let failed = false;
  try {
    execFileSync('/bin/sh', [script, '999999', target, path.join(dir, 'stage', 'missing.app'), marker], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: 'pipe' });
  } catch {
    failed = true;
  }
  assert.ok(failed);
  assert.equal(fs.readFileSync(path.join(target, 'v'), 'utf8'), 'new');
  assert.ok(fs.existsSync(marker));
  assert.deepEqual(fs.readdirSync(path.join(dir, 'Apps')), ['My App.app']);
});

test('make-latest-json builds a manifest the app can read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-rel-'));
  for (const n of ['HarboR-ClipShelf-1.2.0-mac-universal.dmg', 'HarboR-ClipShelf-1.2.0-mac-universal.zip', 'HarboR-ClipShelf-1.2.0-win-x64.exe', 'HarboR-ClipShelf-1.2.0-win-arm64.exe']) {
    fs.writeFileSync(path.join(dir, n), n);
  }
  const cl = path.join(dir, 'CHANGELOG.md');
  fs.writeFileSync(cl, '# x\n\n## v1.2.0\n\n- A\n- B\n\n## v1.1.0\n\n- old\n');
  execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'make-latest-json.js'), '--dir', dir, '--repo', 'x/y', '--tag', 'v1.2.0', '--changelog', cl], { stdio: 'pipe' });
  const json = JSON.parse(fs.readFileSync(path.join(dir, 'latest.json'), 'utf8'));
  assert.equal(json.notes, '- A\n- B');
  const rel = core.normalizeRelease(json);
  assert.equal(rel.assets.length, 4);
  assert.equal(core.pickAsset(rel.assets, { platform: 'win32', arch: 'arm64', kind: 'exe' }).name, 'HarboR-ClipShelf-1.2.0-win-arm64.exe');
  assert.equal(core.pickAsset(rel.assets, { platform: 'darwin', arch: 'x64', kind: 'zip' }).name, 'HarboR-ClipShelf-1.2.0-mac-universal.zip');
  assert.match(fs.readFileSync(path.join(dir, 'SHA256SUMS.txt'), 'utf8'), /^[0-9a-f]{64} {2}HarboR-ClipShelf-1\.2\.0-mac-universal\.dmg$/m);
});

test('a disk error during download ends in an error state instead of hanging', async () => {
  const url = 'https://github.com/x/y/releases/download/v1.2.0/HarboR-ClipShelf-1.2.0-win-x64.exe';
  const feed = { version: '1.2.0', assets: [{ name: 'HarboR-ClipShelf-1.2.0-win-x64.exe', url, size: 5 }] };
  const { u, workDir } = makeUpdater({ routes: { [FEED]: () => fakeResponse(200, feed), [url]: () => fakeResponse(200, 'hello') } });
  await u.check();
  // make the .part path unwritable (a directory)
  fs.mkdirSync(path.join(workDir, '1.2.0', `HarboR-ClipShelf-1.2.0-win-x64.exe.${process.pid}.part`), { recursive: true });
  const st = await Promise.race([u.install(), new Promise((r) => setTimeout(() => r('timeout'), 3000))]);
  assert.notEqual(st, 'timeout');
  assert.equal(st.status, 'error');
  assert.equal(u.busy, false);
});

test('a check finishing during an install does not clobber its state', async () => {
  const url = 'https://github.com/x/y/releases/download/v1.2.0/HarboR-ClipShelf-1.2.0-win-x64.exe';
  const payload = Buffer.from('abcde');
  const feed = { version: '1.2.0', assets: [{ name: 'HarboR-ClipShelf-1.2.0-win-x64.exe', url, size: 5, sha256: crypto.createHash('sha256').update(payload).digest('hex') }] };
  let releaseDownload;
  const gate = new Promise((r) => (releaseDownload = r));
  let feedCalls = 0;
  const { u } = makeUpdater({
    routes: {
      [FEED]: async () => {
        feedCalls++;
        if (feedCalls === 2) await new Promise((r) => setTimeout(r, 50));
        return fakeResponse(200, feedCalls === 1 ? feed : { version: '1.1.0', assets: [] });
      },
      [url]: async () => {
        await gate;
        return fakeResponse(200, payload);
      }
    }
  });
  await u.check();
  u._runWindowsInstaller = async (file, rel) => u._handoff('installer', rel);
  const installing = u.install();
  const checking = u.check({ manual: true }); // started while busy → ignored
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(u.state().status, 'downloading');
  releaseDownload();
  const st = await installing;
  await checking;
  assert.equal(st.status, 'installing');
  assert.equal(u.latest.version, '1.2.0');
});

test('swap failure marker switches the Mac plan to the dmg', () => {
  const { u, workDir } = makeUpdater({ platform: 'darwin', arch: 'arm64', routes: {} });
  u.execPath = '/Applications/HarboR ClipShelf.app/Contents/MacOS/HarboR ClipShelf';
  u._writable = () => true;
  u.latest = core.normalizeRelease({
    version: '1.2.0',
    assets: [
      { name: 'HarboR-ClipShelf-1.2.0-mac-universal.zip', url: 'https://x/a.zip' },
      { name: 'HarboR-ClipShelf-1.2.0-mac-universal.dmg', url: 'https://x/a.dmg' }
    ]
  });
  assert.equal(u.installPlan().method, 'swap');
  fs.writeFileSync(path.join(workDir, 'swap-failed-1.2.0'), 'x');
  fs.writeFileSync(path.join(workDir, 'swap-failed-1.0.0'), 'old');
  const seen = [];
  u.on('swap-failed', (e) => seen.push(e.version));
  u._readSwapMarkers();
  assert.deepEqual(seen, ['1.2.0']);
  assert.equal(u.installPlan().method, 'dmg');
  assert.ok(!fs.existsSync(path.join(workDir, 'swap-failed-1.0.0')));
  u.cleanup();
  assert.ok(fs.existsSync(path.join(workDir, 'swap-failed-1.2.0')));
});
