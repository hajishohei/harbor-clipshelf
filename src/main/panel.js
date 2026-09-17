'use strict';
const path = require('path');
const { app, BrowserWindow, screen } = require('electron');
const { webPreferences, forwardRendererErrors, floatingOptions, makeFloating, RENDERER } = require('./windowsCommon');
const { restoreFocus } = require('./focusReturn');

const isMac = process.platform === 'darwin';
const MARGIN = 8;
const DEFAULT_HEIGHT = 324;
const MIN_HEIGHT = 150;
const HIDE_ANIMATION_MS = 140;

/**
 * The Paste-style clipboard panel: a translucent bar across the bottom of the
 * display the user is working on. It takes keyboard focus while open and
 * hands focus back to the previous app when it closes.
 */
class PastePanel {
  constructor({ getSettings, setSettings, monitor, windowService, log }) {
    this.getSettings = getSettings;
    this.setSettings = setSettings;
    this.monitor = monitor;
    this.ws = windowService;
    this.log = log;
    this.win = null;
    this.ready = false;
    this.visible = false;
    this.previous = null; // { pid, bundleId, name, hwnd }
    this.modalDepth = 0; // preview windows / dialogs keep the panel open
    this.rendererModal = false; // rename / edit in the panel itself
    this.hideTimer = null;
    this.saveTimer = null;
    this.quitting = false;
    this.pendingShow = null;
    this.dragOut = null; // { timer, faded, until }
  }

  _create() {
    const win = new BrowserWindow({
      ...floatingOptions({ title: 'ClipShelf', resizable: false }),
      width: 800,
      height: DEFAULT_HEIGHT,
      webPreferences: webPreferences()
    });
    this.win = win;
    this.ready = false;
    makeFloating(win, 'pop-up-menu');
    win.loadFile(path.join(RENDERER, 'panel.html'));
    forwardRendererErrors(win, 'panel', this.log);
    win.webContents.on('did-finish-load', () => {
      this.ready = true;
      this.applyPrivacy();
      if (this.pendingShow) {
        const fn = this.pendingShow;
        this.pendingShow = null;
        fn();
      }
    });
    win.on('blur', () => {
      // Clicking anywhere else closes the panel, as in Paste.
      if (this.dragOut) return;
      if (this.visible && this.modalDepth === 0 && !this.rendererModal && !this.quitting) this.hide({ restoreFocus: false, reason: 'blur' });
    });
    win.on('closed', () => {
      this.win = null;
      this.ready = false;
      this.visible = false;
    });
    return win;
  }

  _ensure() {
    return this.win && !this.win.isDestroyed() ? this.win : this._create();
  }

  applyPrivacy() {
    if (this.win && !this.win.isDestroyed()) {
      this.win.setContentProtection(!this.getSettings().showDuringScreenSharing);
    }
  }

  _display() {
    try {
      return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    } catch {
      return screen.getPrimaryDisplay();
    }
  }

  _bounds(display = this._display()) {
    const area = display.workArea;
    const wanted = this.getSettings().panelHeight || DEFAULT_HEIGHT;
    const height = Math.max(MIN_HEIGHT, Math.min(wanted, Math.round(area.height * 0.8)));
    return {
      x: area.x + MARGIN,
      y: area.y + area.height - height - MARGIN,
      width: area.width - MARGIN * 2,
      height
    };
  }

  isVisible() {
    return this.visible;
  }

  async _rememberPrevious() {
    const front = this.monitor && this.monitor.front;
    this.previous = front ? { ...front } : null;
    if (process.platform === 'win32') {
      try {
        const fg = await this.ws.foreground();
        if (fg && fg.pid !== process.pid) this.previous = { ...(this.previous || {}), hwnd: fg.hwnd, pid: fg.pid };
      } catch {
        /* keep what the monitor knows */
      }
    }
  }

  // opts: { pinboardId, focusSearch, pasteStack }
  async show(opts = {}) {
    clearTimeout(this.hideTimer);
    if (!this.visible) await this._rememberPrevious();
    this.rendererModal = false;
    const win = this._ensure();
    const reveal = () => {
      if (win.isDestroyed()) return;
      if (this.dragOut) this.endDragOut({ silent: true });
      win.setIgnoreMouseEvents(false);
      win.setOpacity(1);
      win.setBounds(this._bounds());
      win.webContents.send('panel:show', { ...opts, targetApp: this.targetAppName() });
      win.show();
      win.focus();
      if (isMac) app.focus({ steal: true });
      this.visible = true;
    };
    if (this.ready) reveal();
    else this.pendingShow = reveal;
  }

  // ---------------------------------------------------------------- drag out
  // Paste gets out of the way once a card is dragged off the panel, so the
  // drop can land in the window behind it. We fade the panel out and let the
  // mouse pass through it until the drag ends, then close it.
  beginDragOut() {
    const win = this.win;
    if (!this.visible || !win || win.isDestroyed()) return;
    this.endDragOut({ silent: true });
    const state = { faded: false, timer: null, startedAt: Date.now(), sawSystemDrag: false };
    this.dragOut = state;
    const onDrag = (ev) => {
      if (ev.active) state.sawSystemDrag = true;
      else if (this.dragOut === state && Date.now() - state.startedAt > 150) this.endDragOut();
    };
    state.onDrag = onDrag;
    if (this.monitor) this.monitor.on('drag', onDrag);
    state.timer = setInterval(() => {
      if (this.dragOut !== state || win.isDestroyed()) return;
      if (Date.now() - state.startedAt > 60000) return this.endDragOut();
      if (state.faded) return;
      let p;
      try {
        p = screen.getCursorScreenPoint();
      } catch {
        return;
      }
      const b = win.getBounds();
      const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
      if (!inside) {
        state.faded = true;
        win.setIgnoreMouseEvents(true);
        win.setOpacity(0);
      }
    }, 50);
  }

  isDraggingOut() {
    return !!this.dragOut;
  }

  endDragOut({ silent = false } = {}) {
    const state = this.dragOut;
    if (!state) return;
    this.dragOut = null;
    clearInterval(state.timer);
    if (this.monitor && state.onDrag) this.monitor.off('drag', state.onDrag);
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    if (!state.faded) {
      // Dropped back on the panel (or cancelled there): stay open.
      return;
    }
    const restore = () => {
      if (win.isDestroyed()) return;
      win.setIgnoreMouseEvents(false);
      win.setOpacity(1);
    };
    if (silent) return restore();
    this.hide({ restoreFocus: false, reason: 'drag' });
    setTimeout(restore, HIDE_ANIMATION_MS + 60);
  }

  targetAppName() {
    return (this.previous && this.previous.name) || null;
  }

  hide({ restoreFocus: restore = true, reason = 'user' } = {}) {
    if (!this.visible || !this.win || this.win.isDestroyed()) return;
    this.visible = false;
    this.modalDepth = 0;
    this.rendererModal = false;
    const win = this.win;
    win.webContents.send('panel:hide', { reason });
    clearTimeout(this.hideTimer);
    this.hideTimer = setTimeout(() => {
      if (!win.isDestroyed() && !this.visible) win.hide();
    }, HIDE_ANIMATION_MS);
    if (restore) this.restoreFocus();
  }

  restoreFocus() {
    if (process.platform === 'win32') {
      if (this.previous && this.previous.hwnd) this.ws.activate(this.previous.hwnd).catch(() => {});
      return;
    }
    restoreFocus({ monitor: { front: this.previous || (this.monitor && this.monitor.front) }, keepOwnWindowsVisible: true, log: this.log });
  }

  toggle(opts) {
    if (this.visible && this.win && this.win.isFocused()) this.hide();
    else this.show(opts);
  }

  // Renderer drags the top edge.
  resizeTo(height) {
    if (!this.win || this.win.isDestroyed()) return;
    const area = screen.getDisplayMatching(this.win.getBounds()).workArea;
    const h = Math.max(MIN_HEIGHT, Math.min(Math.round(height), Math.round(area.height * 0.8)));
    this.win.setBounds({ x: area.x + MARGIN, y: area.y + area.height - h - MARGIN, width: area.width - MARGIN * 2, height: h });
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.setSettings({ panelHeight: h }, { silent: true }), 400);
  }

  resetHeight() {
    this.setSettings({ panelHeight: null }, { silent: true });
    if (this.win && this.visible) this.win.setBounds(this._bounds(screen.getDisplayMatching(this.win.getBounds())));
  }

  setRendererModal(open) {
    this.rendererModal = open;
  }

  pushModal() {
    this.modalDepth++;
  }

  popModal() {
    this.modalDepth = Math.max(0, this.modalDepth - 1);
    if (this.visible && this.win && !this.win.isDestroyed()) this.win.focus();
  }

  send(channel, payload) {
    if (this.win && !this.win.isDestroyed() && this.ready) this.win.webContents.send(channel, payload);
  }

  destroy() {
    this.quitting = true;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
  }
}

module.exports = { PastePanel, DEFAULT_HEIGHT, MIN_HEIGHT };
