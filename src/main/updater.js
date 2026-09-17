'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const { Readable, Transform } = require('stream');
const { pipeline } = require('stream/promises');
const { EventEmitter } = require('events');
const core = require('./updateCore');

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 20 * 1000;
const STALL_TIMEOUT_MS = 60 * 1000;

const MAC_SWAP_SCRIPT = `#!/bin/sh
# HarboR ClipShelf updater: waits for the app to quit, swaps the bundle, relaunches.
# On failure the old app is restored, FAILMARK is written and the old app reopened.
PID="$1"; TARGET="$2"; NEWAPP="$3"; FAILMARK="$4"
fail() {
  echo "[$(date)] $1"
  [ -n "$FAILMARK" ] && echo "$1" > "$FAILMARK"
  open "$TARGET"
  exit 1
}
echo "[$(date)] waiting for pid $PID"
i=0
while kill -0 "$PID" 2>/dev/null; do
  i=$((i+1))
  if [ "$i" -gt 300 ]; then echo "timeout waiting for quit"; exit 1; fi
  sleep 0.2
done
BACKUP="$TARGET.old-$$"
mv "$TARGET" "$BACKUP" || fail "could not move old app"
if ! mv "$NEWAPP" "$TARGET"; then
  # a cross-volume move can leave a partial copy behind
  [ -e "$TARGET" ] && rm -rf "$TARGET"
  mv "$BACKUP" "$TARGET"
  fail "could not move new app; restored"
fi
xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null
rm -rf "$BACKUP"
echo "[$(date)] updated, relaunching"
open "$TARGET"
`;

function execFileP(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120000, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.message = `${err.message} ${String(stderr || '').trim()}`.trim();
        reject(err);
      } else resolve(String(stdout || ''));
    });
  });
}

/**
 * "新しい版があります" checker. Reads latest.json (or the GitHub API as a
 * fallback) from the repo's latest Release, and on request downloads the
 * installer for this OS and hands over to it:
 *   macOS   → swaps the .app in place (zip) and relaunches; falls back to
 *             opening the .dmg when the app can't be replaced in place.
 *   Windows → starts the installer and quits.
 * No code signing or paid services are needed.
 */
class Updater extends EventEmitter {
  constructor(opts) {
    super();
    this.getSettings = opts.getSettings;
    this.setSettings = opts.setSettings;
    this.log = opts.log;
    this.fetch = opts.fetch;
    this.shell = opts.shell;
    this.quit = opts.quit;
    this.currentVersion = opts.currentVersion;
    this.workDir = opts.workDir;
    this.execPath = opts.execPath || process.execPath;
    this.platform = opts.platform || process.platform;
    this.arch = opts.arch || process.arch;
    this.env = opts.env || process.env;
    this.repo = core.resolveRepo(opts.pkg, this.env);
    this.urls = core.feedFor(this.repo, this.env);
    this.allowLocalHttp = !!this.env.CLIPSHELF_UPDATE_FEED;
    this.timer = null;
    this.firstTimer = null;
    this.checking = null;
    this.busy = false;
    this.handedOff = false;
    this.notified = new Set();
    this.latest = null;
    this.downloaded = null; // { version, file, asset }
    this.swapFailed = new Set(); // versions whose in-place swap failed before
    this._state = {
      status: this.urls ? 'idle' : 'unconfigured',
      current: this.currentVersion,
      repo: this.repo,
      latest: null,
      progress: null,
      error: null,
      checkedAt: null
    };
  }

  // ------------------------------------------------------------ state
  state() {
    const s = this._state;
    const skipped = !!(s.latest && this.getSettings().skippedUpdateVersion === s.latest.version);
    return { ...s, newer: !!this.latest, skipped, install: this.installPlan(), enabled: this.getSettings().updateCheckEnabled !== false };
  }

  _set(patch) {
    this._state = { ...this._state, ...patch };
    this.emit('state', this.state());
  }

  get hasUpdate() {
    return ['available', 'downloading', 'installing'].includes(this._state.status) ||
      (this._state.status === 'error' && !!this.latest);
  }

  // ------------------------------------------------------------ scheduling
  start() {
    this._readSwapMarkers();
    if (!this.urls) {
      this.log.info('[update] no update repo configured; checks disabled');
      return;
    }
    const jitter = 15000 + Math.floor(Math.random() * 45000);
    this.firstTimer = setTimeout(() => this.check({ manual: false }), jitter);
    this.timer = setInterval(() => this.check({ manual: false }), CHECK_INTERVAL_MS);
  }

  _readSwapMarkers() {
    let names = [];
    try {
      names = fs.readdirSync(this.workDir);
    } catch {
      return;
    }
    for (const name of names) {
      const m = /^swap-failed-(.+)$/.exec(name);
      if (!m) continue;
      if (core.compareVersions(m[1], this.currentVersion) === 1) {
        this.swapFailed.add(m[1]);
        this.emit('swap-failed', { version: m[1] });
      } else {
        fs.rmSync(path.join(this.workDir, name), { force: true });
      }
    }
  }

  // Called after the machine wakes up.
  onResume() {
    const last = this._state.checkedAt || 0;
    if (this.urls && Date.now() - last > CHECK_INTERVAL_MS) this.check({ manual: false });
  }

  stop() {
    clearTimeout(this.firstTimer);
    clearInterval(this.timer);
  }

  // ------------------------------------------------------------ check
  async _getJson(url) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await this.fetch(url, {
        signal: ctrl.signal,
        headers: { Accept: 'application/vnd.github+json, application/json', 'User-Agent': `HarboR-ClipShelf/${this.currentVersion}` },
        cache: 'no-store'
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  async _fetchRelease() {
    const opts = { allowLocalHttp: this.allowLocalHttp };
    try {
      return core.normalizeRelease(await this._getJson(this.urls.feed), opts);
    } catch (err) {
      if (!this.urls.api) throw err;
      this.log.warn('[update] latest.json unavailable, trying API:', err.message);
      return core.normalizeRelease(await this._getJson(this.urls.api), opts);
    }
  }

  check({ manual = false } = {}) {
    if (!this.urls) return Promise.resolve(this.state());
    if (!manual && this.getSettings().updateCheckEnabled === false) return Promise.resolve(this.state());
    if (this.busy || this.handedOff) return Promise.resolve(this.state());
    if (this.checking) return this.checking;
    const prevStatus = this._state.status;
    const prevError = this._state.error;
    this._set({ status: 'checking', error: null });
    this.checking = (async () => {
      try {
        const rel = await this._fetchRelease();
        if (this.busy || this.handedOff) {
          // An install started meanwhile; it owns status/latest now.
          this._set({ checkedAt: Date.now() });
          return this.state();
        }
        const cmp = core.compareVersions(rel.version, this.currentVersion);
        if (cmp === 1) {
          this.latest = rel;
          this._set({ status: 'available', latest: this._public(rel), checkedAt: Date.now(), error: null });
          const skipped = this.getSettings().skippedUpdateVersion === rel.version;
          if (!this.notified.has(rel.version) && (manual || !skipped)) {
            this.notified.add(rel.version);
            this.emit('available', this.state(), { manual });
          }
          this.log.info(`[update] ${rel.version} available (current ${this.currentVersion})`);
        } else {
          this.latest = null;
          this._set({ status: 'latest', latest: this._public(rel), checkedAt: Date.now(), error: null });
        }
      } catch (err) {
        const reason = this._reason(err);
        this.log.warn('[update] check failed:', reason, err.message);
        if (this.busy || this.handedOff) return this.state();
        // A silent background failure keeps whatever we knew before.
        let status = prevStatus;
        if (manual) status = 'error';
        else if (this.latest) status = 'available';
        this._set({ status, error: manual ? reason : status === 'error' ? prevError : null, checkedAt: Date.now() });
      } finally {
        this.checking = null;
      }
      return this.state();
    })();
    return this.checking;
  }

  _reason(err) {
    if (err && err.status === 404) return 'not-found';
    if (err && (err.status === 403 || err.status === 429)) return 'rate-limited';
    if (err && /invalid/.test(err.message)) return 'invalid-feed';
    if (err && err.name === 'AbortError') return 'timeout';
    return 'network';
  }

  _public(rel) {
    return {
      version: rel.version,
      notes: rel.notes,
      page: rel.page || (this.urls && this.urls.page) || null,
      publishedAt: rel.publishedAt,
      download: this._browserAsset(rel)
    };
  }

  _browserAsset(rel) {
    const kind = this.platform === 'darwin' ? 'dmg' : this.platform === 'win32' ? 'exe' : null;
    const a = kind ? core.pickAsset(rel.assets, { platform: this.platform, arch: this.arch, kind }) : null;
    return a ? { name: a.name, url: a.url, size: a.size } : null;
  }

  // ------------------------------------------------------------ install plan
  installPlan(rel = this.latest) {
    if (!rel) return null;
    if (this.platform === 'win32') {
      const a = core.pickAsset(rel.assets, { platform: 'win32', arch: this.arch, kind: 'exe' });
      return a ? { method: 'installer', asset: a.name } : { method: 'browser' };
    }
    if (this.platform === 'darwin') {
      const bundle = core.macBundlePath(this.execPath);
      const zip = core.pickAsset(rel.assets, { platform: 'darwin', arch: this.arch, kind: 'zip' });
      const dmg = core.pickAsset(rel.assets, { platform: 'darwin', arch: this.arch, kind: 'dmg' });
      const blocker = core.macSwapBlocker(bundle) || (bundle && !this._writable(bundle) ? 'not-writable' : null);
      if (zip && !blocker && !this.swapFailed.has(rel.version)) return { method: 'swap', asset: zip.name };
      if (dmg) return { method: 'dmg', asset: dmg.name, blocker };
      return { method: 'browser', blocker };
    }
    return { method: 'browser' };
  }

  _writable(bundle) {
    try {
      fs.accessSync(path.dirname(bundle), fs.constants.W_OK);
      fs.accessSync(bundle, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  // ------------------------------------------------------------ download
  async download(asset, rel = this.latest) {
    const dir = path.join(this.workDir, rel.version);
    fs.mkdirSync(dir, { recursive: true });
    const safe = asset.name.replace(/[^A-Za-z0-9._-]/g, '_');
    const file = path.join(dir, safe);
    if (fs.existsSync(file) && asset.sha256 && (await this._sha256(file)) === asset.sha256) return file;

    const tmp = `${file}.${process.pid}.part`;
    const ctrl = new AbortController();
    let stall = null;
    const kick = () => {
      clearTimeout(stall);
      stall = setTimeout(() => ctrl.abort(), STALL_TIMEOUT_MS);
    };
    kick();
    try {
      const res = await this.fetch(asset.url, { signal: ctrl.signal, headers: { 'User-Agent': `HarboR-ClipShelf/${this.currentVersion}` } });
      if (!res.ok || !res.body) {
        const err = new Error(`HTTP ${res.status}`);
        err.status = res.status;
        throw err;
      }
      const total = Number(res.headers.get('content-length')) || asset.size || 0;
      const hash = crypto.createHash('sha256');
      let received = 0;
      let lastEmit = 0;
      const meter = new Transform({
        transform: (chunk, _enc, cb) => {
          kick();
          hash.update(chunk);
          received += chunk.length;
          const now = Date.now();
          if (now - lastEmit > 250) {
            lastEmit = now;
            this._set({ progress: { received, total } });
          }
          cb(null, chunk);
        }
      });
      // pipeline() propagates errors from any side (network, disk full,
      // locked file) and tears the others down, so nothing is left hanging.
      await pipeline(Readable.fromWeb(res.body), meter, fs.createWriteStream(tmp), { signal: ctrl.signal });
      if (asset.size && received !== asset.size) throw new Error('size-mismatch');
      const digest = hash.digest('hex');
      if (asset.sha256 && digest !== asset.sha256) throw new Error('checksum-mismatch');
      if (!asset.sha256) this.log.warn(`[update] ${asset.name} has no published checksum; size check only`);
      fs.renameSync(tmp, file);
      this._set({ progress: { received, total: total || received } });
      return file;
    } catch (err) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
      if (ctrl.signal.aborted && err.name !== 'AbortError') {
        const e = new Error('download stalled');
        e.name = 'AbortError';
        throw e;
      }
      throw err;
    } finally {
      clearTimeout(stall);
    }
  }

  _sha256(file) {
    return new Promise((resolve) => {
      const h = crypto.createHash('sha256');
      fs.createReadStream(file)
        .on('data', (d) => h.update(d))
        .on('end', () => resolve(h.digest('hex')))
        .on('error', () => resolve(null));
    });
  }

  // Removes downloads of versions other than `keep`.
  cleanup(keep = null) {
    let names = [];
    try {
      names = fs.readdirSync(this.workDir);
    } catch {
      return; // nothing to clean
    }
    for (const name of names) {
      if (name === keep || name === 'swap.log' || name.startsWith('swap-failed-')) continue;
      try {
        fs.rmSync(path.join(this.workDir, name), { recursive: true, force: true });
      } catch {
        /* e.g. the installer that just ran is still open on Windows */
      }
    }
  }

  // ------------------------------------------------------------ install
  async install() {
    if (this.busy || this.handedOff) return this.state();
    this.busy = true;
    try {
      if (!this.latest) {
        this.busy = false;
        await this.check({ manual: true });
        if (this.busy || this.handedOff || !this.latest) return this.state();
        this.busy = true;
      }
      const rel = this.latest; // everything below works on this snapshot
      const plan = this.installPlan(rel);
      if (plan.method === 'browser') {
        this.openDownloadPage();
        return this.state();
      }
      const asset = rel.assets.find((a) => a.name === plan.asset);
      this._set({ status: 'downloading', progress: { received: 0, total: asset.size || 0 }, error: null });
      const file = await this.download(asset, rel);
      this.downloaded = { version: rel.version, file, asset };
      this._set({ status: 'installing', progress: null });
      if (plan.method === 'installer') await this._runWindowsInstaller(file, rel);
      else if (plan.method === 'swap') await this._swapMacApp(file, rel);
      else await this._openDmg(file, rel);
      return this.state();
    } catch (err) {
      const reason = err.message === 'checksum-mismatch' || err.message === 'size-mismatch' ? 'corrupt' : err.code === 'swap-failed' ? 'swap-failed' : this._reason(err);
      this.log.error('[update] install failed:', reason, err.stack || err.message);
      this._set({ status: 'error', error: reason, progress: null });
      return this.state();
    } finally {
      this.busy = false;
    }
  }

  _handoff(method, rel) {
    this.handedOff = true;
    this.emit('handoff', { method, version: rel.version });
  }

  async _runWindowsInstaller(file, rel) {
    this.log.info(`[update] launching installer ${file}`);
    const child = spawn(file, [], { detached: true, stdio: 'ignore', windowsHide: false });
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('spawn', resolve);
    });
    child.unref();
    this._handoff('installer', rel);
    setTimeout(() => this.quit(), 800);
  }

  async _swapMacApp(zipFile, rel) {
    const bundle = core.macBundlePath(this.execPath);
    const version = rel.version;
    const stage = path.join(this.workDir, version, 'expanded');
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
    try {
      await execFileP('/usr/bin/ditto', ['-x', '-k', zipFile, stage]);
      const appName = fs.readdirSync(stage).find((n) => n.endsWith('.app'));
      if (!appName) throw new Error('no .app in archive');
      const newApp = path.join(stage, appName);
      const plist = path.join(newApp, 'Contents', 'Info.plist');
      const got = (await execFileP('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist])).trim();
      if (core.compareVersions(got, version) !== 0) throw new Error(`archive version ${got} != ${version}`);
      await execFileP('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', newApp]).catch(() => {});
      await execFileP('/usr/bin/codesign', ['--verify', '--deep', newApp]).catch((err) => {
        this.log.warn('[update] codesign verify warning:', err.message);
      });
      const script = path.join(this.workDir, 'swap.sh');
      fs.writeFileSync(script, MAC_SWAP_SCRIPT, { mode: 0o755 });
      const logFd = fs.openSync(path.join(this.workDir, 'swap.log'), 'a');
      const marker = path.join(this.workDir, `swap-failed-${version}`);
      fs.rmSync(marker, { force: true });
      const child = spawn('/bin/sh', [script, String(process.pid), bundle, newApp, marker], {
        detached: true,
        stdio: ['ignore', logFd, logFd]
      });
      child.unref();
      fs.closeSync(logFd);
      this.log.info(`[update] swapping ${bundle} → ${version}`);
      this._handoff('swap', rel);
      setTimeout(() => this.quit(), 800);
    } catch (err) {
      err.code = 'swap-failed';
      throw err;
    }
  }

  async _openDmg(file, rel) {
    const failure = await this.shell.openPath(file);
    if (failure) throw new Error(failure);
    this._handoff('dmg', rel);
    // Finder can't replace a running app, so step aside.
    setTimeout(() => this.quit(), 1500);
  }

  // ------------------------------------------------------------ misc actions
  openDownloadPage() {
    const st = this._state.latest;
    const url = (st && st.download && st.download.url) || (st && st.page) || (this.urls && this.urls.page);
    if (url && core.isHttpsUrl(url)) this.shell.openExternal(url);
    return !!url;
  }

  openReleasePage() {
    const st = this._state.latest;
    const url = (st && st.page) || (this.urls && this.urls.page);
    if (url && core.isHttpsUrl(url)) this.shell.openExternal(url);
    return !!url;
  }

  skip(version) {
    const v = version === null ? null : String(version || '');
    if (v !== null && !core.parseVersion(v)) return this.state();
    this.setSettings({ skippedUpdateVersion: v });
    this.emit('state', this.state());
    return this.state();
  }
}

module.exports = { Updater, MAC_SWAP_SCRIPT, CHECK_INTERVAL_MS };
