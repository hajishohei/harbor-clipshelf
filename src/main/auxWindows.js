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

/** Quick Look-style preview for panel / shelf items (Space). */
class PreviewWindow {
  constructor({ log, onClosed }) {
    this.log = log;
    this.onClosed = onClosed;
    this.win = null;
    this.ready = false;
    this.pending = null;
  }

  show(payload, { owner = null } = {}) {
    this.owner = owner;
    let win = this.win;
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    const width = Math.min(760, area.width - 80);
    const height = Math.min(560, area.height - 360 > 320 ? area.height - 360 : area.height - 80);
    const bounds = { x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + 40), width, height };
    if (!win || win.isDestroyed()) {
      win = new BrowserWindow({
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
        title: 'プレビュー',
        backgroundColor: nativeTheme.shouldUseDarkColors ? '#232428' : '#ffffff',
        webPreferences: webPreferences()
      });
      this.win = win;
      this.ready = false;
      win.setAlwaysOnTop(true, 'pop-up-menu', 1);
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      win.loadFile(path.join(RENDERER, 'preview.html'));
      forwardRendererErrors(win, 'preview', this.log);
      win.webContents.on('did-finish-load', () => {
        this.ready = true;
        if (this.pending) win.webContents.send('preview:show', this.pending);
        this.pending = null;
        win.show();
        win.focus();
      });
      win.on('blur', () => this.close());
      win.on('closed', () => {
        this.win = null;
        this.ready = false;
        if (this.onClosed) this.onClosed(this.owner);
        this.owner = null;
      });
    } else {
      win.setBounds(bounds);
    }
    if (this.ready) {
      win.webContents.send('preview:show', payload);
      win.show();
      win.focus();
    } else {
      this.pending = payload;
    }
  }

  isOpen() {
    return !!(this.win && !this.win.isDestroyed() && this.win.isVisible());
  }

  close() {
    if (this.win && !this.win.isDestroyed()) this.win.close();
  }
}

module.exports = { SettingsWindow, PreviewWindow };
