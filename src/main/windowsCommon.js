'use strict';
const path = require('path');
const { BrowserWindow } = require('electron');

const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const RENDERER = path.join(__dirname, '..', 'renderer');

function webPreferences(extra = {}) {
  return { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, ...extra };
}

function forwardRendererErrors(win, label, log) {
  // Electron 35+: the event itself carries { level: 'error' | …, message,
  // lineNumber, sourceId }; the second argument is the deprecated number.
  win.webContents.on('console-message', (event, legacyLevel) => {
    const level = event && event.level;
    if (level === 'error' || (level === undefined && legacyLevel === 3)) {
      log.error(`[renderer:${label}] ${event.message} (${event.sourceId}:${event.lineNumber})`);
    }
  });
  win.webContents.on('preload-error', (_e, preloadPath, error) => {
    log.error(`[renderer:${label}] preload error`, preloadPath, error && error.message);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    log.error(`[renderer:${label}] gone`, details && details.reason);
  });
}

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send(channel, payload);
  }
}

// Panel-style window that floats above full-screen apps on every Space.
function floatingOptions(extra = {}) {
  const opts = {
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    acceptFirstMouse: true,
    backgroundColor: '#00000000',
    ...extra
  };
  if (process.platform === 'darwin') opts.type = 'panel';
  if (process.platform === 'win32') opts.type = 'toolbar';
  return opts;
}

function makeFloating(win, level = 'floating') {
  win.setAlwaysOnTop(true, level);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (typeof win.setHiddenInMissionControl === 'function') win.setHiddenInMissionControl(true);
}

module.exports = { PRELOAD, RENDERER, webPreferences, forwardRendererErrors, broadcast, floatingOptions, makeFloating };
