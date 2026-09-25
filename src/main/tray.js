'use strict';
const path = require('path');
const { Tray, Menu, nativeImage, app } = require('electron');
const { formatUntil } = require('./pause');

const isMac = process.platform === 'darwin';

function loadIcon(awake) {
  const dir = path.join(__dirname, '..', '..', 'assets');
  const name = isMac ? (awake ? 'trayAwakeTemplate.png' : 'trayTemplate.png') : awake ? 'trayAwake.png' : 'tray.png';
  const image = nativeImage.createFromPath(path.join(dir, name));
  if (isMac && !image.isEmpty()) image.setTemplateImage(true);
  return image;
}

function remainingLabel(until) {
  const ms = until - Date.now();
  if (ms <= 0) return '';
  const min = Math.ceil(ms / 60000);
  return min >= 60 ? `残り ${Math.floor(min / 60)}時間${min % 60 ? `${min % 60}分` : ''}` : `残り ${min}分`;
}

/**
 * Menu-bar (macOS) / notification-area (Windows) icon. The menu is rebuilt
 * from current state every time something relevant changes.
 */
class TrayMenu {
  constructor({ handlers, getState, log }) {
    this.handlers = handlers;
    this.getState = getState;
    this.log = log;
    this.tray = null;
    this.clock = null;
  }

  create() {
    if (this.tray) return;
    const image = loadIcon(false);
    this.tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);
    this.iconState = 'normal';
    if (!isMac) this.tray.on('click', () => this.handlers.openPanel());
    // Yoink: the menu bar icon accepts drops
    this.tray.on('drop-files', (_e, files) => this.handlers.dropFiles(files));
    this.tray.on('drop-text', (_e, text) => this.handlers.dropText(text));
    this.refresh();
  }

  // Paste animates its menu bar icon on every copy.
  flash() {
    if (!this.tray || this.flashTimer) return;
    const alt = loadIcon(true);
    if (alt.isEmpty()) return;
    this.tray.setImage(alt);
    this.flashTimer = setTimeout(() => {
      this.flashTimer = null;
      if (this.tray) this.tray.setImage(loadIcon(this.awakeIcon));
    }, 350);
  }

  refresh() {
    if (!this.tray) return;
    const st = this.getState();
    const h = this.handlers;
    const acc = (key) => (st.shortcuts[key] ? { accelerator: st.shortcuts[key], registerAccelerator: false } : {});
    const ka = st.keepAwake;
    const kaLabel = ka.active ? `スリープ防止: ON${ka.until ? `（${remainingLabel(ka.until)}）` : ''}` : 'スリープ防止: OFF';

    const up = st.update || {};
    const updateItems = [];
    if (up.newer && ['available', 'error'].includes(up.status) && !up.skipped) {
      updateItems.push({ label: `新しい版 v${up.latest.version} にアップデート…`, click: () => h.installUpdate() }, { type: 'separator' });
    } else if (up.status === 'downloading') {
      const p = up.progress && up.progress.total ? Math.floor((up.progress.received / up.progress.total) * 100) : null;
      updateItems.push({ label: `アップデートをダウンロード中…${p !== null ? ` ${p}%` : ''}`, enabled: false }, { type: 'separator' });
    } else if (up.status === 'installing') {
      updateItems.push({ label: 'アップデートを準備中…', enabled: false }, { type: 'separator' });
    }

    const pause = st.pause || {};
    const pauseItem = pause.paused
      ? { label: pause.until ? `一時停止中（${formatUntil(pause.until)}まで）— 再開` : '一時停止中 — 再開', click: () => h.resume() }
      : {
        label: '一時停止',
        submenu: [
          { label: '15分間', click: () => h.pause(15 * 60 * 1000) },
          { label: '1時間', click: () => h.pause(60 * 60 * 1000) },
          { label: '8時間', click: () => h.pause(8 * 60 * 60 * 1000) },
          { label: '24時間', click: () => h.pause(24 * 60 * 60 * 1000) },
          { type: 'separator' },
          { label: '再開するまで', click: () => h.pause(null) }
        ]
      };

    const template = [
      ...updateItems,
      { label: 'ClipShelf を開く', click: () => h.openPanel(), ...acc('togglePanel') },
      { label: 'Paste Stack', type: 'checkbox', checked: !!st.stackActive, click: () => h.toggleStack(), ...acc('pasteStack') },
      pauseItem,
      { type: 'separator' },
      { label: st.shelfVisible ? 'シェルフを隠す' : 'シェルフを表示', click: () => h.toggleShelf(), ...acc('toggleShelf') },
      { label: '最後に削除したファイルをシェルフに戻す', enabled: !!st.canRestore, click: () => h.restoreShelf() },
      { label: 'クリップボードからシェルフに追加', click: () => h.addClipboardToShelf() },
      { type: 'separator' },
      {
        label: st.screenOcrEnabled ? '画面から文字を読み取る' : '画面から文字を読み取る（設定でON）',
        click: () => h.screenOcr(),
        ...(st.screenOcrEnabled ? acc('screenOcr') : {})
      },
      {
        label: kaLabel,
        visible: st.keepAwakeEnabled,
        submenu: [
          { label: 'ONにする（OFFにするまで）', click: () => h.keepAwake(true, null) },
          { label: '1時間だけON', click: () => h.keepAwake(true, 60 * 60 * 1000) },
          { label: '3時間だけON', click: () => h.keepAwake(true, 3 * 60 * 60 * 1000) },
          { label: '8時間だけON', click: () => h.keepAwake(true, 8 * 60 * 60 * 1000) },
          { type: 'separator' },
          { label: 'OFFにする', enabled: ka.active, click: () => h.keepAwake(false) }
        ]
      },
      {
        label: st.mouse && st.mouse.paused ? 'マウス操作: 一時停止中 — 再開' : 'マウス操作を一時停止',
        visible: !!(st.mouse && st.mouse.enabled && st.mouse.supported),
        accelerator: acc('toggleMouse').accelerator,
        registerAccelerator: false,
        click: () => h.toggleMouse()
      },
      { type: 'separator' },
      { label: '設定…', accelerator: 'CommandOrControl+,', registerAccelerator: false, click: () => h.openSettings() },
      { label: up.status === 'checking' ? 'アップデートを確認中…' : 'アップデートを確認…', enabled: !['checking', 'downloading', 'installing'].includes(up.status), click: () => h.checkUpdate() },
      { label: `HarboR ClipShelf ${app.getVersion()} について`, click: () => h.about() },
      { type: 'separator' },
      { label: 'HarboR ClipShelf を終了', accelerator: 'CommandOrControl+Q', registerAccelerator: false, click: () => h.quit() }
    ];
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
    const tip = ['HarboR ClipShelf'];
    if (pause.paused) tip.push('記録一時停止中');
    if (ka.active) tip.push('スリープ防止中');
    if (up.newer && up.status === 'available' && !up.skipped) tip.push(`新しい版 v${up.latest.version} あり`);
    this.tray.setToolTip(tip.join(' — '));
    if (this.awakeIcon !== ka.active && !this.flashTimer) {
      const icon = loadIcon(ka.active);
      if (!icon.isEmpty()) this.tray.setImage(icon);
    }
    this.awakeIcon = ka.active;

    clearInterval(this.clock);
    this.clock = (ka.active && ka.until) || (pause.paused && pause.until) ? setInterval(() => this.refresh(), 30000) : null;
  }

  destroy() {
    clearInterval(this.clock);
    clearTimeout(this.flashTimer);
    this.flashTimer = null;
    if (this.tray) this.tray.destroy();
    this.tray = null;
  }
}

module.exports = { TrayMenu };
