'use strict';
const path = require('path');
const { app, BrowserWindow, screen, desktopCapturer, systemPreferences, globalShortcut, ipcMain } = require('electron');
const { webPreferences, forwardRendererErrors, RENDERER } = require('./windowsCommon');
const { restoreFocus } = require('./focusReturn');
const io = require('./clipboardIO');
const { previewOf } = require('../shared/text');

const isMac = process.platform === 'darwin';

/**
 * "TextSniper相当": dim every display, let the user drag a rectangle, OCR
 * that part of a screenshot taken *before* the overlay appeared, and put
 * the text on the clipboard (and into history).
 */
class ScreenOcr {
  constructor({ ocr, store, watcher, monitor, hud, windowService, getSettings, log }) {
    this.ocr = ocr;
    this.store = store;
    this.watcher = watcher;
    this.monitor = monitor;
    this.hud = hud;
    this.ws = windowService;
    this.getSettings = getSettings;
    this.log = log;
    this.overlays = [];
    this.active = false;
  }

  registerIpc() {
    const entryFor = (sender) => this.overlays.find((o) => !o.win.isDestroyed() && o.win.webContents === sender);
    ipcMain.handle('screen-ocr:init', (e) => {
      const entry = entryFor(e.sender);
      if (!entry) return null;
      return { image: entry.dataUrl };
    });
    ipcMain.on('screen-ocr:selected', (e, rect) => {
      const entry = entryFor(e.sender);
      this.close();
      if (entry && rect && rect.width >= 6 && rect.height >= 6) {
        this._recognize(entry, rect).catch((err) => this.log.error('[screenOcr]', err));
      }
    });
    ipcMain.on('screen-ocr:cancel', () => this.close());
  }

  permission() {
    if (!isMac) return 'granted';
    try {
      return systemPreferences.getMediaAccessStatus('screen');
    } catch {
      return 'unknown';
    }
  }

  // Makes macOS show its "Screen Recording" prompt right when the feature is
  // switched on, instead of on first use.
  async primePermission() {
    if (!isMac || this.permission() === 'granted') return;
    try {
      await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
    } catch {
      /* the prompt is the point */
    }
  }

  async trigger() {
    if (this.active) return;
    if (!this.getSettings().screenOcrEnabled) {
      this.hud.show('画面の文字読み取りはOFFです', '設定タブの「画面から文字を読み取る」をONにしてください', { kind: 'info' });
      return;
    }
    const perm = this.permission();
    if (perm === 'denied' || perm === 'restricted') {
      this.hud.show('画面収録の許可が必要です', 'システム設定 > プライバシーとセキュリティ > 画面収録 で許可してください', { kind: 'warn' });
      this.ws.openPrivacyPane('screen');
      return;
    }
    this.active = true;
    try {
      await this._open();
    } catch (err) {
      this.log.error('[screenOcr] capture failed', err);
      this.hud.show('画面を取得できませんでした', String(err.message || err), { kind: 'warn' });
      this.close({ returnFocus: false });
    }
  }

  async _open() {
    const displays = screen.getAllDisplays();
    let maxW = 0;
    let maxH = 0;
    for (const d of displays) {
      maxW = Math.max(maxW, Math.round(d.size.width * d.scaleFactor));
      maxH = Math.max(maxH, Math.round(d.size.height * d.scaleFactor));
    }
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: maxW, height: maxH } });
    if (!sources.length) throw new Error('no screen sources');
    if (isMac && this.permission() !== 'granted') {
      this.hud.show('画面収録の許可が必要です', '許可したあと、もう一度ショートカットを押してください', { kind: 'warn' });
      this.ws.openPrivacyPane('screen');
      this.close({ returnFocus: false });
      return;
    }

    this.overlays = displays.map((display, index) => {
      const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[index] || sources[0];
      const thumb = source.thumbnail;
      const size = thumb.getSize();
      const win = new BrowserWindow({
        ...display.bounds,
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
        alwaysOnTop: true,
        acceptFirstMouse: true,
        enableLargerThanScreen: true,
        title: 'ClipShelf OCR',
        backgroundColor: '#00000000',
        webPreferences: webPreferences()
      });
      win.setAlwaysOnTop(true, 'screen-saver');
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      win.loadFile(path.join(RENDERER, 'overlay.html'));
      forwardRendererErrors(win, 'overlay', this.log);
      win.once('ready-to-show', () => {
        if (win.isDestroyed()) return;
        win.setBounds(display.bounds);
        win.show();
        if (display.bounds.x <= screen.getCursorScreenPoint().x && screen.getCursorScreenPoint().x < display.bounds.x + display.bounds.width) {
          win.focus();
          if (isMac) app.focus({ steal: true });
        }
      });
      win.on('closed', () => {
        this.overlays = this.overlays.filter((o) => o.win !== win);
      });
      return {
        win,
        display,
        thumb,
        dataUrl: thumb.toDataURL(),
        scaleX: size.width / display.bounds.width,
        scaleY: size.height / display.bounds.height
      };
    });

    try {
      globalShortcut.register('Escape', () => this.close());
    } catch {
      /* Esc is also handled inside the overlay */
    }
  }

  close({ returnFocus = true } = {}) {
    const hadOverlays = this.overlays.length > 0;
    for (const { win } of this.overlays) {
      if (!win.isDestroyed()) win.close();
    }
    this.overlays = [];
    this.active = false;
    try {
      globalShortcut.unregister('Escape');
    } catch {
      /* not registered */
    }
    if (hadOverlays && returnFocus) restoreFocus({ monitor: this.monitor, keepOwnWindowsVisible: true, log: this.log });
  }

  async _recognize(entry, rect) {
    const { thumb, scaleX, scaleY } = entry;
    const size = thumb.getSize();
    const x = Math.max(0, Math.round(rect.x * scaleX));
    const y = Math.max(0, Math.round(rect.y * scaleY));
    const crop = {
      x,
      y,
      width: Math.max(1, Math.min(size.width - x, Math.round(rect.width * scaleX))),
      height: Math.max(1, Math.min(size.height - y, Math.round(rect.height * scaleY)))
    };
    const png = thumb.crop(crop).toPNG();

    const slowNotice = setTimeout(() => {
      this.hud.show('文字を読み取っています…', this.ocr.warm ? '' : '初回は準備に数秒かかります', { kind: 'info', durationMs: 8000 });
    }, 500);
    let text;
    try {
      text = await this.ocr.recognizeBuffer(png);
    } finally {
      clearTimeout(slowNotice);
    }
    if (!text) {
      this.hud.show('文字が見つかりませんでした', '範囲を少し広げて、もう一度試してください', { kind: 'warn' });
      return;
    }
    await this.watcher.runOwnWrite(() => io.writeText(text));
    const hash = `t:${io.sha1(text)}`;
    const existing = this.store.findHistoryByHash(hash);
    if (existing) this.store.touch(existing.id, { sourceApp: '画面から読み取り' });
    else {
      this.store.create({
        board: 'history',
        type: 'text',
        text,
        hash,
        preview: previewOf(text),
        sourceApp: '画面から読み取り',
        tags: ['screen-ocr']
      });
    }
    this.hud.show('コピーしました', previewOf(text.replace(/\s+/g, ' '), 60));
  }
}

module.exports = { ScreenOcr };
