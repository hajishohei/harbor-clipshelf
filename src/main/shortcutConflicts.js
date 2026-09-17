'use strict';
// When the original apps (Paste, Yoink, …) are still running they own the
// same global shortcuts (⇧⌘V, F5 …) and ours cannot be registered. This
// notices that, tells the user which app it is, keeps retrying, and can quit
// that app on request.
const { execFile } = require('child_process');
const accelerator = require('../shared/accelerator');
const layouts = require('../shared/layouts');

const KNOWN_APPS = [
  { name: 'Paste', bundleId: 'com.wiheads.paste', match: /^(?!.*\/Setapp\/).*\/Paste\.app\/Contents\/MacOS\/Paste$/, keys: ['togglePanel', 'pasteStack'] },
  { name: 'Paste（Setapp）', bundleId: 'com.wiheads.paste-setapp', match: /\/Setapp\/Paste\.app\/Contents\/MacOS\/Paste$/, keys: ['togglePanel', 'pasteStack'] },
  { name: 'Yoink', bundleId: 'at.EternalStorms.Yoink', match: /\/Yoink\.app\/Contents\/MacOS\/Yoink$/, keys: ['toggleShelf'] },
  { name: 'Magnet', bundleId: 'com.crowdcafe.windowmagnet', match: /\/Magnet\.app\/Contents\/MacOS\/Magnet$/, keys: layouts.ACTIONS },
  { name: 'TextSniper', bundleId: 'com.valerijs.boguckis.textsniper', match: /\/TextSniper\.app\/Contents\/MacOS\//, keys: ['screenOcr'] },
  { name: 'Clipy', bundleId: 'com.clipy-app.Clipy', match: /\/Clipy\.app\/Contents\/MacOS\/Clipy$/, keys: ['togglePanel'] }
];

// `ps -axo comm=` output → running known apps
function runningKnownApps(psOutput) {
  const lines = String(psOutput || '').split('\n');
  return KNOWN_APPS.filter((a) => lines.some((l) => a.match.test(l.trim())));
}

// failed shortcut keys + running apps → [{ key, accelerator, app }]
function explain(results, running) {
  const out = [];
  for (const [key, r] of Object.entries(results || {})) {
    if (!r || r.registered || r.reason !== 'in-use') continue;
    const owner = running.find((a) => a.keys.includes(key)) || null;
    out.push({ key, accelerator: r.accelerator, app: owner ? { name: owner.name, bundleId: owner.bundleId } : null });
  }
  return out;
}

class ShortcutConflicts {
  constructor({ shortcuts, reapply, hud, log, onChange, platform = process.platform }) {
    this.shortcuts = shortcuts;
    this.reapply = reapply;
    this.hud = hud;
    this.log = log;
    this.onChange = onChange;
    this.platform = platform;
    this.list = [];
    this.timer = null;
    this.notified = new Set();
  }

  start() {
    this.check();
    this.timer = setInterval(() => this.check({ retry: true }), 10000);
  }

  stop() {
    clearInterval(this.timer);
  }

  current() {
    return this.list;
  }

  _ps() {
    if (this.platform !== 'darwin') return Promise.resolve('');
    return new Promise((resolve) => {
      execFile('/bin/ps', ['-axo', 'comm='], { timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(err ? '' : out));
    });
  }

  async check({ retry = false } = {}) {
    let results = this.shortcuts.status().results;
    const failing = Object.values(results).some((r) => r && !r.registered && r.reason === 'in-use');
    if (!failing) {
      if (this.list.length) {
        this.list = [];
        if (this.onChange) this.onChange(this.list);
      }
      return this.list;
    }
    // The other app may have quit since: try again.
    if (retry) {
      results = this.reapply() || this.shortcuts.status().results;
    }
    const running = runningKnownApps(await this._ps());
    const list = explain(results, running);
    const changed = JSON.stringify(list) !== JSON.stringify(this.list);
    this.list = list;
    if (changed && this.onChange) this.onChange(list);
    for (const c of list) {
      const id = `${c.key}:${c.accelerator}:${c.app ? c.app.bundleId : ''}`;
      if (this.notified.has(id)) continue;
      this.notified.add(id);
      this.log.warn('[shortcut] in use', c.key, c.accelerator, c.app ? c.app.name : 'unknown app');
      if (this.hud && (c.key === 'togglePanel' || c.key === 'toggleShelf')) {
        const who = c.app ? `「${c.app.name}」が起動中のため` : '他のアプリが使っているため';
        this.hud.show(`${accelerator.toDisplay(c.accelerator, this.platform)} が使えません`, `${who}反応しません。設定 → ショートカット で確認できます`, { kind: 'warn', durationMs: 8000 });
      }
    }
    return list;
  }

  // Only the known apps above, and only when the user presses the button.
  quitApp(bundleId) {
    if (this.platform !== 'darwin') return Promise.resolve(false);
    const app = KNOWN_APPS.find((a) => a.bundleId === bundleId);
    if (!app) return Promise.resolve(false);
    return new Promise((resolve) => {
      execFile('/usr/bin/osascript', ['-e', `tell application id "${app.bundleId}" to quit`], { timeout: 8000 }, (err) => {
        if (err) this.log.warn('[shortcut] could not quit', app.name, err.message);
        setTimeout(() => this.check({ retry: true }).then(() => resolve(!err)), 1500);
      });
    });
  }
}

module.exports = { ShortcutConflicts, runningKnownApps, explain, KNOWN_APPS };
