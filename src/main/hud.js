'use strict';
const path = require('path');
const { BrowserWindow, screen } = require('electron');

/**
 * Small non-activating overlay used for feedback ("コピーしました",
 * "スリープ防止: ON" …). OS notifications aren't reliable for this app
 * (macOS requires a signed app for UNNotification since Electron 42).
 */
let win = null;
let ready = false;
let queued = null;
let hideTimer = null;

const WIDTH = 360;
const HEIGHT = 92;

function ensure() {
  if (win && !win.isDestroyed()) return win;
  ready = false;
  win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });
  win.setIgnoreMouseEvents(true);
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, '..', 'renderer', 'hud.html'));
  win.webContents.on('did-finish-load', () => {
    ready = true;
    if (queued) {
      const q = queued;
      queued = null;
      deliver(q);
    }
  });
  win.on('closed', () => {
    win = null;
    ready = false;
  });
  return win;
}

function deliver(msg) {
  const w = ensure();
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display.workArea;
  w.setBounds({
    x: Math.round(area.x + (area.width - WIDTH) / 2),
    y: Math.round(area.y + area.height - HEIGHT - 72),
    width: WIDTH,
    height: HEIGHT
  });
  w.webContents.send('hud:show', msg);
  w.showInactive();
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (win && !win.isDestroyed()) win.hide();
  }, msg.durationMs || 1600);
}

// kind: 'ok' | 'info' | 'warn'
function show(title, body = '', { kind = 'ok', durationMs } = {}) {
  const msg = { title, body, kind, durationMs: durationMs || (kind === 'warn' ? 4200 : 1600) };
  const w = ensure();
  if (!ready || w.webContents.isLoading()) {
    queued = msg;
    return;
  }
  deliver(msg);
}

function sound(name) {
  if (!['copy', 'paste'].includes(name)) return;
  const w = ensure();
  if (!ready || w.webContents.isLoading()) return;
  w.webContents.send('hud:sound', name);
}

function destroy() {
  clearTimeout(hideTimer);
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
}

module.exports = { show, sound, destroy, ensure };
