'use strict';
const path = require('path');
const { EventEmitter } = require('events');
const { BrowserWindow, screen } = require('electron');
const { webPreferences, forwardRendererErrors, floatingOptions, makeFloating, RENDERER } = require('./windowsCommon');

const WIDTH = 300;
const HEIGHT = 420;
const PASTE_ACCEL = process.platform === 'darwin' ? 'Command+V' : 'Control+V';

/**
 * Paste Stack (⇧⌘C): while the small stack window is open, everything you
 * copy is collected in order; each ⌘V pastes the next item and removes it.
 */
class PasteStack extends EventEmitter {
  constructor({ store, watcher, shortcuts, windowService, pasteService, getSettings, setSettings, hud, log }) {
    super();
    this.store = store;
    this.watcher = watcher;
    this.shortcuts = shortcuts;
    this.ws = windowService;
    this.pasteService = pasteService;
    this.getSettings = getSettings;
    this.setSettings = setSettings;
    this.log = log;
    this.hud = hud;
    this.active = false;
    this.ids = []; // top → bottom
    this.win = null;
    this.ready = false;
    this.pasting = false;
    this.hooked = false;

    watcher.on('captured', (item) => {
      if (this.active && item && !this.pasting) this.add([item.id]);
    });
    store.on('removed', (id) => {
      if (this.ids.includes(id)) this._setIds(this.ids.filter((x) => x !== id));
    });
  }

  state() {
    return {
      active: this.active,
      order: this.getSettings().pasteStackOrder,
      items: this.ids.map((id) => this.store.get(id)).filter(Boolean).map((i) => ({ ...i, html: undefined, rtf: undefined }))
    };
  }

  _emit() {
    const st = this.state();
    this.emit('change', st);
    if (this.win && this.ready && !this.win.isDestroyed()) this.win.webContents.send('stack:state', st);
  }

  _setIds(ids) {
    this.ids = ids;
    this._syncHotkey();
    this._emit();
  }

  add(ids, { index = null } = {}) {
    const clean = ids.filter((id) => this.store.get(id) && !this.ids.includes(id));
    if (!clean.length) return;
    const next = this.ids.slice();
    if (index !== null) next.splice(Math.max(0, Math.min(index, next.length)), 0, ...clean);
    else if (this.getSettings().pasteStackOrder === 'lifo') next.unshift(...clean.reverse());
    else next.push(...clean);
    this._setIds(next);
  }

  remove(ids) {
    this._setIds(this.ids.filter((id) => !ids.includes(id)));
  }

  reorder(ids) {
    const keep = ids.filter((id) => this.ids.includes(id));
    const rest = this.ids.filter((id) => !keep.includes(id));
    this._setIds(keep.concat(rest));
  }

  toggleOrder() {
    const order = this.getSettings().pasteStackOrder === 'fifo' ? 'lifo' : 'fifo';
    this.setSettings({ pasteStackOrder: order });
    this._emit();
  }

  toggle() {
    if (this.active) this.close();
    else this.open();
  }

  canPaste() {
    if (!this.ws.supported) return false;
    return !(process.platform === 'darwin' && this.ws.accessibilityGranted(false) === false);
  }

  open() {
    if (process.platform === 'darwin' && this.ws.accessibilityGranted(false) === false) {
      // ⌘V can only be pressed for you with Accessibility access.
      this.ws.accessibilityGranted(true);
      if (this.hud) this.hud.show('Paste Stack にはアクセシビリティの許可が必要です', '許可するまでは、積んだアイテムを1つずつクリックしてコピーできます', { kind: 'warn', durationMs: 6000 });
    }
    this.active = true;
    this.ids = [];
    const win = this._ensure();
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    win.setBounds({ x: area.x + area.width - WIDTH - 16, y: area.y + 16, width: WIDTH, height: Math.min(HEIGHT, area.height - 32) });
    win.showInactive();
    this._syncHotkey();
    this._emit();
  }

  close() {
    this.active = false;
    this.ids = [];
    this._syncHotkey();
    if (this.win && !this.win.isDestroyed()) this.win.hide();
    this._emit();
  }

  _ensure() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const win = new BrowserWindow({
      ...floatingOptions({ title: 'Paste Stack', movable: true, focusable: false }),
      width: WIDTH,
      height: HEIGHT,
      webPreferences: webPreferences()
    });
    this.win = win;
    this.ready = false;
    makeFloating(win, 'floating');
    win.loadFile(path.join(RENDERER, 'stack.html'));
    forwardRendererErrors(win, 'stack', this.log);
    win.webContents.on('did-finish-load', () => {
      this.ready = true;
      win.webContents.send('stack:state', this.state());
    });
    win.on('closed', () => {
      this.win = null;
      this.ready = false;
    });
    return win;
  }

  // ⌘V is ours only while there is something to paste.
  _syncHotkey() {
    const want = this.active && this.ids.length > 0 && !this.pasting && this.canPaste();
    if (want && !this.hooked) {
      this.hooked = this.shortcuts.registerTemp(PASTE_ACCEL, () => this.pasteNext());
    } else if (!want && this.hooked) {
      this.shortcuts.unregisterTemp(PASTE_ACCEL);
      this.hooked = false;
    }
  }

  async pasteNext() {
    if (this.pasting || !this.ids.length) return;
    const id = this.ids[0];
    this.pasting = true;
    this._syncHotkey(); // release ⌘V so the synthetic press reaches the app
    let done = false;
    try {
      const item = this.store.get(id);
      if (item) {
        await this.pasteService.writeToClipboard([item]);
        await this.ws.paste();
      }
      done = true;
    } catch (err) {
      this.log.warn('[stack] paste failed', err && (err.reason || err.message));
      if (this.hud) this.hud.show('貼り付けできませんでした', 'アイテムはクリップボードにコピーしてあります', { kind: 'warn' });
    } finally {
      if (done) this.ids = this.ids.filter((x) => x !== id);
      setTimeout(() => {
        this.pasting = false;
        this._syncHotkey();
        this._emit();
      }, 180);
    }
  }

  destroy() {
    this.close();
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
  }
}

module.exports = { PasteStack, PASTE_ACCEL };
