'use strict';
const { dialog, systemPreferences } = require('electron');
const io = require('./clipboardIO');
const blobs = require('./blobs');
const { resolveFilePaths } = require('./fileResolver');

const SEPARATORS = { newline: '\n', space: ' ', none: '' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * "Paste Items": write the chosen items to the clipboard, close the panel and
 * — when set to "To active app" — press ⌘V / Ctrl+V in the app the user came
 * from (Paste's Direct Paste). Without permission it falls back to copying.
 */
class PasteService {
  constructor({ store, watcher, panel, windowService, getSettings, setSettings, sounds, hud, log }) {
    this.store = store;
    this.watcher = watcher;
    this.panel = panel;
    this.ws = windowService;
    this.getSettings = getSettings;
    this.setSettings = setSettings;
    this.sounds = sounds;
    this.hud = hud;
    this.log = log;
    this.asking = false;
  }

  _items(ids) {
    return (Array.isArray(ids) ? ids : [ids]).map((id) => this.store.get(id)).filter(Boolean);
  }

  async writeToClipboard(items, { plain = false } = {}) {
    const s = this.getSettings();
    const settings = this.store.settings;
    await this.watcher.runOwnWrite(() =>
      io.writeItems(items, {
        plain: plain || s.alwaysPlainText,
        separator: SEPARATORS[s.multiPasteSeparator] ?? '\n',
        resolveImage: (it) => blobs.readBlob(settings, it.blob),
        resolveFiles: async (it) => resolveFilePaths(settings, it, { purpose: 'export' })
      })
    );
    for (const it of items) if (it.board === 'history') this.store.touch(it.id);
  }

  // Copy only (⌘C in the panel, "To clipboard" mode).
  async copy(ids, { plain = false, close = true } = {}) {
    const items = this._items(ids);
    if (!items.length) return { ok: false, reason: 'not-found' };
    await this.writeToClipboard(items, { plain });
    this.sounds.play('copy');
    if (close) this.panel.hide({ restoreFocus: true });
    return { ok: true, pasted: false };
  }

  async paste(ids, { plain = false } = {}) {
    const items = this._items(ids);
    if (!items.length) return { ok: false, reason: 'not-found' };
    const s = this.getSettings();
    await this.writeToClipboard(items, { plain });
    if (s.pasteTarget === 'clipboard' || !this.ws.supported) {
      this.sounds.play('copy');
      this.panel.hide({ restoreFocus: true });
      return { ok: true, pasted: false };
    }
    if (process.platform === 'darwin' && !this.ws.accessibilityGranted(false)) {
      const choice = await this._askForAccessibility();
      this.panel.hide({ restoreFocus: true });
      this.sounds.play('copy');
      return { ok: true, pasted: false, reason: choice };
    }
    const target = this.panel.previous;
    this.panel.hide({ restoreFocus: true });
    try {
      await this._waitForTarget(target);
      await this.ws.paste();
      this.sounds.play('paste');
      return { ok: true, pasted: true };
    } catch (err) {
      this.log.warn('[paste] direct paste failed', err && (err.reason || err.message));
      this.hud.show('コピーしました', '貼り付けたい場所で ⌘V / Ctrl+V を押してください', { kind: 'info' });
      return { ok: true, pasted: false, reason: err && (err.reason || err.message) };
    }
  }

  // Waits until the app we came from is frontmost again (max ~0.8s).
  async _waitForTarget(target) {
    const want = target && target.pid;
    for (let i = 0; i < 16; i++) {
      await wait(i === 0 ? 60 : 50);
      if (!want) return;
      try {
        const fg = await this.ws.foreground();
        if (fg && fg.pid === want) {
          await wait(40);
          return;
        }
        if (fg && fg.pid !== process.pid && i > 4) return; // something else took focus; paste there
      } catch {
        return;
      }
    }
  }

  async _askForAccessibility() {
    if (this.asking) return 'busy';
    this.asking = true;
    this.panel.pushModal();
    try {
      const appName = this.panel.targetAppName() || '現在のアプリ';
      const { response, checkboxChecked } = await dialog.showMessageBox({
        type: 'question',
        message: `${appName}に直接貼り付けますか？`,
        detail: 'ClipShelf が他のアプリに直接貼り付けるには、「アクセシビリティ」へのアクセスが必要です。\n今回の内容はクリップボードにコピーしました（⌘V で貼り付けられます）。',
        buttons: ['アクセシビリティへのアクセスを有効にする', '今はしない、クリップボードにコピーする'],
        defaultId: 0,
        cancelId: 1,
        checkboxLabel: '今後表示しない（いつもクリップボードへコピーする）'
      });
      if (response === 0) {
        systemPreferences.isTrustedAccessibilityClient(true);
        this.ws.openPrivacyPane('accessibility');
        return 'enabling';
      }
      if (checkboxChecked) this.setSettings({ pasteTarget: 'clipboard' });
      return 'declined';
    } finally {
      this.panel.popModal();
      this.asking = false;
    }
  }
}

module.exports = { PasteService, SEPARATORS };
