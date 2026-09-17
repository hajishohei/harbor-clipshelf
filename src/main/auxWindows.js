'use strict';
const path = require('path');
const { app, BrowserWindow, screen, nativeTheme } = require('electron');
const { webPreferences, forwardRendererErrors, RENDERER } = require('./windowsCommon');

const isMac = process.platform === 'darwin';

/** Settings window (Paste/Yoink-style preferences, one sidebar per area). */
class SettingsWindow {
  constructor({ log }) {
    this.log = log;
    this.win = null;
    this.ready = false;
    this.pendingSection = null;
    this.quitting = false;
  }

  show(section) {
    let win = this.win;
    if (!win || win.isDestroyed()) {
      win = new BrowserWindow({
        width: 860,
        height: 680,
        minWidth: 720,
        minHeight: 520,
        show: false,
        title: 'ClipShelf 設定',
        autoHideMenuBar: true,
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#1e1f22' : '#f5f5f7',
        webPreferences: webPreferences()
      });
      this.win = win;
      this.ready = false;
      win.setMenuBarVisibility(false);
      win.loadFile(path.join(RENDERER, 'settings.html'));
      forwardRendererErrors(win, 'settings', this.log);
      win.webContents.on('did-finish-load', () => {
        this.ready = true;
        if (this.pendingSection) win.webContents.send('settings:section', this.pendingSection);
        this.pendingSection = null;
      });
      win.once('ready-to-show', () => {
        win.show();
        win.focus();
      });
      win.on('closed', () => {
        this.win = null;
        this.ready = false;
      });
    } else {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    if (isMac) app.focus({ steal: true });
    if (section) {
      if (this.ready) win.webContents.send('settings:section', section);
      else this.pendingSection = section;
    }
    return win;
  }

  isFocused() {
    return !!(this.win && !this.win.isDestroyed() && this.win.isFocused());
  }

  send(channel, payload) {
    if (this.win && !this.win.isDestroyed() && this.ready) this.win.webContents.send(channel, payload);
  }

  destroy() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
  }
}

/**
 * Quick Look-style preview popup for panel / shelf items.
 * Closes as soon as it loses focus (a click anywhere else), on Space / Esc,
 * or when the eye button is pressed again.
 */
class PreviewWindow {
  constructor({ log, onClosed, restoreFocus }) {
    this.log = log;
    this.onClosed = onClosed;
    this.restoreFocus = restoreFocus;
    this.win = null;
    this.ready = false;
    this.pending = null;
    this.owner = null;
    this.id = null;
    this.lastClosed = { id: null, at: 0 };
    this.shownAt = 0;
  }

  _create(bounds) {
    const win = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      transparent: false,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: true,
      roundedCorners: true,
      title: 'プレビュー',
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#232428' : '#ffffff',
      webPreferences: webPreferences()
    });
    this.win = win;
    this.ready = false;
    win.setAlwaysOnTop(true, 'pop-up-menu', 1);
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (typeof win.setHiddenInMissionControl === 'function') win.setHiddenInMissionControl(true);
    win.loadFile(path.join(RENDERER, 'preview.html'));
    forwardRendererErrors(win, 'preview', this.log);
    win.webContents.on('did-finish-load', () => {
      this.ready = true;
      if (this.pending) {
        win.webContents.send('preview:show', this.pending);
        this.pending = null;
        this._reveal();
      }
    });
    // Clicking anywhere else closes it (like Quick Look / Yoink's popover).
    win.on('blur', () => {
      if (Date.now() - this.shownAt < 250) return; // focus settling right after opening
      this.close({ restore: false });
    });
    win.on('closed', () => {
      const owner = this.owner;
      this.win = null;
      this.ready = false;
      this.owner = null;
      this.id = null;
      if (this.onClosed) this.onClosed(owner);
    });
    return win;
  }

  _reveal() {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    this.shownAt = Date.now();
    win.show();
    win.focus();
    if (isMac) app.focus({ steal: true });
  }

  // payload: see ipc previewPayload; opts: { owner, id, anchor, side, keepPosition }
  show(payload, { owner = null, id = null, anchor = null, side = null, keepPosition = false, returnTo } = {}) {
    if (returnTo) this.returnTo = returnTo;
    const { sizeFor, placeNear } = require('./previewContent');
    this.owner = owner;
    // Switching files inside a stack keeps the item the popup was opened for.
    if (!keepPosition || !this.id) this.id = id;
    const point = anchor ? { x: anchor.x + anchor.width / 2, y: anchor.y + anchor.height / 2 } : screen.getCursorScreenPoint();
    const area = screen.getDisplayNearestPoint(point).workArea;
    const size = sizeFor(payload.content, area);
    let bounds = placeNear({ anchor, side, size, area });
    if (!anchor && owner === 'panel') {
      // above the Paste bar
      bounds = { ...bounds, y: Math.max(area.y + 8, Math.min(bounds.y, area.y + area.height - 340 - size.height)) };
    }
    let win = this.win;
    if (!win || win.isDestroyed()) {
      win = this._create(bounds);
    } else if (!keepPosition) {
      win.setBounds(bounds);
    } else {
      const cur = win.getBounds();
      win.setBounds({ ...cur, width: bounds.width, height: bounds.height });
    }
    if (this.ready) {
      win.webContents.send('preview:show', payload);
      this._reveal();
    } else {
      this.pending = payload;
    }
  }

  isOpen() {
    return !!(this.win && !this.win.isDestroyed() && this.win.isVisible());
  }

  justClosed(id, withinMs = 400) {
    return this.lastClosed.id === id && Date.now() - this.lastClosed.at < withinMs;
  }

  close({ restore = false } = {}) {
    if (!this.win || this.win.isDestroyed()) return;
    this.lastClosed = { id: this.id, at: Date.now() };
    const owner = this.owner;
    this.win.close();
    // Closed from the keyboard / close button: give focus back to the app
    // the user was in (a click elsewhere already moved it there).
    if (restore && owner === 'shelf' && this.restoreFocus) this.restoreFocus(this.returnTo || 'app');
  }
}

module.exports = { SettingsWindow, PreviewWindow };
