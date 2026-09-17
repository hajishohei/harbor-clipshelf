'use strict';
const path = require('path');
const { app, Menu, net, shell, powerMonitor, nativeTheme, systemPreferences } = require('electron');
const log = require('./logger');
const paths = require('./paths');
const settingsStore = require('./settings');
const { ItemStore } = require('./store');
const { SystemMonitor } = require('./systemMonitor');
const { ClipboardWatcher } = require('./clipboardWatcher');
const { OcrService } = require('./ocr');
const { TrayMenu } = require('./tray');
const { ShortcutManager } = require('./shortcuts');
const { WindowService } = require('./windowService');
const { WindowSnapper, REASON_TEXT } = require('./windowSnap');
const { FocusFollow } = require('./focusFollow');
const { KeepAwake } = require('./keepAwake');
const { ScreenOcr } = require('./screenOcr');
const { registerIpc } = require('./ipc');
const { Updater } = require('./updater');
const { cleanupStaging } = require('./fileResolver');
const { PastePanel } = require('./panel');
const { YoinkShelf } = require('./yoinkShelf');
const { PasteService } = require('./pasteService');
const { PasteStack } = require('./pasteStack');
const { ItemOps } = require('./itemOps');
const { AppIcons } = require('./appIcons');
const { LinkPreviews } = require('./linkPreview');
const { PauseController } = require('./pause');
const { SettingsWindow, PreviewWindow } = require('./auxWindows');
const previewContent = require('./previewContent');
const { ShortcutConflicts } = require('./shortcutConflicts');
const { restoreFocus } = require('./focusReturn');
const { createSounds } = require('./sounds');
const { broadcast } = require('./windowsCommon');
const hud = require('./hud');
const layouts = require('../shared/layouts');

const isMac = process.platform === 'darwin';
const SHELF_DOUBLE_PRESS_MS = 320;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  main();
}

function main() {
  // Test hook: isolated profile for automated smoke runs.
  if (process.env.CLIPSHELF_USER_DATA) app.setPath('userData', process.env.CLIPSHELF_USER_DATA);
  log.init(paths.logsDir());
  process.on('uncaughtException', (err) => log.error('[uncaught]', err && err.stack ? err.stack : err));
  process.on('unhandledRejection', (err) => log.error('[unhandled]', err && err.stack ? err.stack : err));
  if (process.platform === 'win32') app.setAppUserModelId('com.harbor-live.clipshelf');

  previewContent.registerScheme(); // must happen before 'ready'
  let settings = settingsStore.load();
  settingsStore.save(settings); // persist migrations
  const getSettings = () => settings;
  const deviceId = settingsStore.getDeviceId();

  const monitor = new SystemMonitor(log);
  const store = new ItemStore(settings, { deviceId, log });
  const watcher = new ClipboardWatcher({ store, getSettings, monitor, log });
  const ocr = new OcrService({ store, getSettings, deviceId, log });
  const keepAwake = new KeepAwake(getSettings);
  const windowService = new WindowService(log);
  const snapper = new WindowSnapper({ windowService, log });
  const shortcuts = new ShortcutManager(log);
  const ops = new ItemOps({ store, getSettings, log });
  const sounds = createSounds({ hud, getSettings });
  let tray = null;
  let focusFollow = null;
  let screenOcr = null;
  let updater = null;
  let panel = null;
  let shelf = null;
  let stack = null;
  let pasteService = null;
  let settingsWindow = null;
  let previewWindow = null;
  let pause = null;
  let appIcons = null;
  let linkPreviews = null;
  let conflicts = null;
  let lastWarnAt = 0;
  let capsSeen = false;

  function warn(title, body) {
    const now = Date.now();
    if (now - lastWarnAt < 4000) return;
    lastWarnAt = now;
    hud.show(title, body, { kind: 'warn' });
  }

  // ---------------------------------------------------------------- shortcuts
  async function runSnap(action) {
    const result = await snapper.apply(action);
    if (result.ok || result.reason === 'busy') return;
    warn('ウィンドウを整列できません', REASON_TEXT[result.reason] || result.reason);
    if (result.reason === 'accessibility') windowService.openPrivacyPane('accessibility');
    if (result.reason === 'automation') windowService.openPrivacyPane('automation');
  }

  // Yoink's shortcut: press = show/hide, double-press = add the clipboard,
  // hold (key repeat) = bring back recently removed files.
  const shelfPresses = { times: [], timer: null };
  function onShelfShortcut() {
    const now = Date.now();
    shelfPresses.times.push(now);
    clearTimeout(shelfPresses.timer);
    const wait = shelfPresses.times.length >= 2 ? 170 : SHELF_DOUBLE_PRESS_MS;
    shelfPresses.timer = setTimeout(() => {
      const times = shelfPresses.times;
      shelfPresses.times = [];
      const gaps = times.slice(1).map((t, i) => t - times[i]);
      const held = times.length >= 3 && gaps.slice(1).every((g) => g < 150);
      if (held) {
        const n = ops.restoreRecentlyRemoved();
        if (n) shelf.show();
        hud.show(n ? `${n} 件をシェルフに戻しました` : '戻せる項目はありません', '', { kind: 'info' });
      } else if (times.length >= 2) {
        ops.addClipboardToShelf().then((added) => {
          if (added && added.length) shelf.show();
        });
      } else {
        shelf.toggle();
      }
    }, wait);
  }

  function applyShortcuts() {
    const s = settings;
    const handlers = {
      togglePanel: () => panel.toggle(),
      pasteStack: () => stack.toggle(),
      toggleShelf: () => onShelfShortcut()
    };
    if (s.screenOcrEnabled) handlers.screenOcr = () => screenOcr.trigger();
    if (s.keepAwake.enabled) handlers.toggleKeepAwake = () => keepAwake.toggle();
    if (s.windowSnapEnabled) {
      for (const action of layouts.ACTIONS) handlers[action] = () => runSnap(action);
    }
    const results = shortcuts.apply(s, handlers);
    if (settingsWindow) settingsWindow.send('shortcuts:status', { ...shortcuts.status(), conflicts: conflicts ? conflicts.current() : [] });
    if (conflicts) conflicts.check();
    return results;
  }

  function applyLoginItem() {
    if (isMac || process.platform === 'win32') {
      try {
        app.setLoginItemSettings(
          isMac ? { openAtLogin: !!settings.launchAtLogin } : { openAtLogin: !!settings.launchAtLogin, args: ['--hidden'] }
        );
      } catch (err) {
        log.warn('[login-item]', err.message);
      }
    }
  }

  function applyAppearance() {
    nativeTheme.themeSource = settings.appearance;
  }

  function applyTray() {
    if (settings.showMenuBarIcon) {
      if (tray && !tray.tray) tray.create();
    } else if (tray && tray.tray) {
      tray.destroy();
    }
  }

  // ---------------------------------------------------------------- data dir / sync
  let switching = Promise.resolve();
  function switchDataDir(reason) {
    switching = switching.then(async () => {
      const oldDir = store.dataDir;
      await store.reconfigure(settings);
      const newDir = store.dataDir;
      if (path.resolve(oldDir) !== path.resolve(newDir)) {
        const imported = store.importFrom(oldDir);
        log.info(`[sync] data dir ${oldDir} → ${newDir} (${reason}), imported ${imported}`);
      }
      store.ensureDefaultPinboard();
      broadcast('items:reset');
      ocr.enqueuePending();
    }).catch((err) => log.error('[sync] switch failed', err));
    return switching;
  }

  function checkSyncFolder() {
    if (!settings.syncFolder) return;
    const expected = paths.isSyncFolderAvailable(settings) ? paths.syncDataDir(settings.syncFolder) : paths.localDataDir();
    if (path.resolve(expected) === path.resolve(store.dataDir)) return;
    if (expected === paths.localDataDir()) {
      warn('同期フォルダが見つかりません', 'いったんこの端末の中に保存します。フォルダが戻ると自動で同期に戻ります');
    }
    switchDataDir('sync-folder-availability');
  }

  const retentionMs = () => settingsStore.RETENTION_MS[settings.historyRetention];

  // ---------------------------------------------------------------- settings
  function setSettings(patch, { silent = false } = {}) {
    const prev = settings;
    settings = settingsStore.merge(prev, patch);
    settingsStore.save(settings);
    if (silent) {
      broadcast('settings:changed', settings);
      return settings;
    }
    const changed = (k) => JSON.stringify(prev[k]) !== JSON.stringify(settings[k]);

    if (changed('syncFolder')) switchDataDir('settings');
    if (changed('shortcuts') || changed('screenOcrEnabled') || changed('windowSnapEnabled') || changed('keepAwake')) applyShortcuts();
    if (changed('focusFollowMouse')) {
      focusFollow.apply();
      if (settings.focusFollowMouse.enabled && !prev.focusFollowMouse.enabled && isMac) {
        windowService.accessibilityGranted(true);
        windowService.probe().catch(() => {});
      }
    }
    if (changed('windowSnapEnabled') && settings.windowSnapEnabled && isMac) {
      windowService.accessibilityGranted(true);
      windowService.probe().catch(() => {});
    }
    if (changed('pasteTarget') && settings.pasteTarget === 'app' && isMac) windowService.accessibilityGranted(true);
    if (changed('screenOcrEnabled') && settings.screenOcrEnabled) screenOcr.primePermission();
    if (changed('keepAwake')) {
      if (!settings.keepAwake.enabled) keepAwake.stop({ source: 'settings' });
      else keepAwake.refreshMode();
      if (settings.keepAwake.enabled && settings.keepAwake.followCapsLock && monitor.capsOn !== null) {
        if (monitor.capsOn) keepAwake.start({ source: 'capslock' });
        else keepAwake.stop({ source: 'capslock' });
      }
    }
    if (changed('launchAtLogin')) applyLoginItem();
    if (changed('appearance')) applyAppearance();
    if (changed('showMenuBarIcon')) applyTray();
    if (changed('showDuringScreenSharing')) panel.applyPrivacy();
    if (['shelfEnabled', 'shelfPosition', 'shelfSize', 'shelfCustomPosition', 'shelfParkSide', 'shelfCollapseWhenIdle', 'shelfFollowActiveDisplay'].some(changed)) shelf.applySettings();
    if (changed('historyRetention')) store.trimHistory(retentionMs());
    if (changed('ocrEnabled') && settings.ocrEnabled) ocr.enqueuePending();
    if (changed('captureEnabled')) pause.syncFromSettings();

    broadcast('settings:changed', settings);
    if (tray) tray.refresh();
    return settings;
  }

  // After an update: say so once, and on macOS point out permissions that the
  // new (ad-hoc signed) build has to be granted again.
  function noticeVersionChange() {
    const current = app.getVersion();
    const prev = settings.lastRunVersion;
    if (prev === current) return;
    setSettings({ lastRunVersion: current }, { silent: true });
    if (!prev) return;
    const needsAx = isMac && (settings.windowSnapEnabled || settings.focusFollowMouse.enabled || settings.pasteTarget === 'app') &&
      windowService.accessibilityGranted(false) === false;
    setTimeout(() => {
      if (needsAx) {
        hud.show(`v${current} にアップデートしました`, 'アクセシビリティの許可を付け直してください（設定に手順があります）', { kind: 'warn', durationMs: 8000 });
        settingsWindow.show('permissions');
      } else {
        hud.show(`v${current} にアップデートしました`, `v${prev} から更新されました`, { durationMs: 5000 });
      }
    }, 1500);
  }

  // ---------------------------------------------------------------- app lifecycle
  app.on('second-instance', () => settingsWindow && settingsWindow.show());

  // None of our windows ever navigate or open new windows; links go through
  // shell.openExternal in the main process.
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-navigate', (event) => event.preventDefault());
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
  });

  app.whenReady().then(() => {
    if (isMac && app.dock) app.dock.hide();
    applyAppearance();
    if (isMac) {
      // Needed so ⌘C / ⌘V / ⌘A work inside our own text fields.
      Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]));
    } else {
      Menu.setApplicationMenu(null);
    }

    pause = new PauseController({ getSettings, setSettings: (p) => setSettings(p), hud });
    panel = new PastePanel({ getSettings, setSettings, monitor, windowService, log });
    shelf = new YoinkShelf({ store, monitor, getSettings, setSettings, log });
    pasteService = new PasteService({ store, watcher, panel, windowService, getSettings, setSettings, sounds, hud, log });
    stack = new PasteStack({ store, watcher, shortcuts, windowService, pasteService, getSettings, setSettings, hud, log });
    settingsWindow = new SettingsWindow({ log });
    previewWindow = new PreviewWindow({
      log,
      onClosed: (owner) => {
        if (owner === 'panel') panel.popModal();
        if (owner === 'shelf') shelf.setPreviewOpen(false);
      },
      restoreFocus: (to) => {
        // Space / Esc in the popup: back to the shelf if it had the keyboard, else to the app the user was in.
        if (to === 'shelf' && shelf.win && !shelf.win.isDestroyed() && shelf.isVisible()) shelf.win.focus();
        else restoreFocus({ monitor, keepOwnWindowsVisible: true, log });
      }
    });
    previewContent.handleProtocol();
    conflicts = new ShortcutConflicts({
      shortcuts,
      reapply: () => {
        const r = shortcuts.retryFailed();
        if (settingsWindow) settingsWindow.send('shortcuts:status', { ...shortcuts.status(), conflicts: conflicts ? conflicts.current() : [] });
        return r;
      },
      hud,
      log,
      onChange: (list) => settingsWindow && settingsWindow.send('shortcuts:status', { ...shortcuts.status(), conflicts: list })
    });
    appIcons = new AppIcons({ windowService, log });
    linkPreviews = new LinkPreviews({ store, getSettings, log });
    focusFollow = new FocusFollow({ windowService, getSettings, setSettings: (p) => setSettings(p), log });
    screenOcr = new ScreenOcr({ ocr, store, watcher, monitor, hud, windowService, getSettings, log });
    updater = new Updater({
      getSettings,
      setSettings: (p) => setSettings(p, { silent: true }),
      log,
      fetch: (url, opts) => net.fetch(url, opts),
      shell,
      quit: () => app.quit(),
      currentVersion: app.getVersion(),
      workDir: path.join(app.getPath('userData'), 'updates'),
      pkg: require('../../package.json')
    });

    store.start();
    store.ensureDefaultPinboard();
    monitor.start();
    watcher.start();
    pause.init();
    ocr.enqueuePending();
    cleanupStaging(24 * 60 * 60 * 1000);
    store.prune(retentionMs());
    setInterval(() => {
      store.prune(retentionMs());
      cleanupStaging(24 * 60 * 60 * 1000);
    }, 60 * 60 * 1000);
    setInterval(checkSyncFolder, 30 * 1000);
    checkSyncFolder();
    let syncMissingTimer = null;
    store.on('sync-missing', () => {
      if (syncMissingTimer) return;
      syncMissingTimer = setTimeout(() => {
        syncMissingTimer = null;
        checkSyncFolder();
      }, 500);
    });

    store.on('changed', (item, meta) => {
      if (item.type === 'image' && item.ocrPending && meta && !meta.external) ocr.enqueue(item.id);
      if (item.type === 'url' && meta && meta.created && !meta.external) linkPreviews.maybeFetch(item);
    });

    watcher.on('captured', (item) => {
      sounds.play('copy');
      if (tray) tray.flash();
      if (item && item.sourceApp && monitor.front) {
        appIcons.request({ bundleId: item.sourceBundleId, name: item.sourceApp, pid: monitor.front.pid }, () => broadcast('icons:changed'));
      }
    });
    watcher.on('skipped', (why) => {
      if (why === 'too-large') warn('大きすぎるため履歴に保存しませんでした', 'テキストが2MBを超えています');
    });

    monitor.on('drag', (ev) => shelf.onSystemDrag(ev));
    monitor.on('caps', (on) => {
      const first = !capsSeen;
      capsSeen = true;
      const ka = settings.keepAwake;
      if (!ka.enabled || !ka.followCapsLock) return;
      if (on && !keepAwake.isActive()) keepAwake.start({ source: first ? 'capslock-startup' : 'capslock' });
      if (!on && keepAwake.isActive()) keepAwake.stop({ source: first ? 'capslock-startup' : 'capslock' });
    });

    keepAwake.on('change', (state) => {
      if (tray) tray.refresh();
      broadcast('keepAwake:changed', state);
      if (['capslock-startup', 'settings', 'quit'].includes(state.source)) return;
      if (state.active) {
        const how = state.source === 'capslock' ? 'Caps Lock がONの間' : state.until ? `${Math.round((state.until - Date.now()) / 60000)}分間` : 'OFFにするまで';
        hud.show('スリープ防止: ON', `${how}スリープしません`);
      } else {
        hud.show('スリープ防止: OFF', state.source === 'timer' ? '時間になったので通常に戻しました' : '通常どおりスリープします', { kind: 'info' });
      }
    });

    pause.on('change', (st) => {
      broadcast('pause:changed', st);
      if (tray) tray.refresh();
    });
    stack.on('change', () => tray && tray.refresh());

    let trayUpdateKey = '';
    updater.on('state', (st) => {
      broadcast('update:state', st);
      // Rebuilding the tray menu closes it on some systems: only do it when
      // the status (or the 10% progress step) actually changes.
      const pct = st.progress && st.progress.total ? Math.floor((st.progress.received / st.progress.total) * 10) : '';
      const key = `${st.status}|${st.newer}|${st.skipped}|${pct}`;
      if (tray && key !== trayUpdateKey) {
        trayUpdateKey = key;
        tray.refresh();
      }
    });
    updater.on('available', (st, { manual }) => {
      if (manual || !st.latest) return;
      hud.show(`新しい版 v${st.latest.version} があります`, isMac ? 'メニューバーのアイコンからアップデートできます' : 'タスクトレイのアイコンからアップデートできます', { kind: 'info', durationMs: 6000 });
    });
    updater.on('handoff', ({ method, version }) => {
      const body = method === 'dmg'
        ? '開いた画面で、アプリを「Applications」へドラッグして置き換えてください'
        : method === 'installer' ? 'インストーラの案内に沿って進めてください' : '数秒後に新しい版が起動します';
      hud.show(`v${version} にアップデートします`, body, { kind: 'info', durationMs: 6000 });
    });
    updater.on('swap-failed', ({ version }) => {
      setTimeout(() => hud.show('自動アップデートできませんでした', `もう一度「アップデート」を押すと、v${version} のインストール画面を開きます`, { kind: 'warn', durationMs: 8000 }), 2500);
    });

    tray = new TrayMenu({
      log,
      getState: () => ({
        shortcuts: settings.shortcuts,
        screenOcrEnabled: settings.screenOcrEnabled,
        keepAwakeEnabled: settings.keepAwake.enabled,
        keepAwake: keepAwake.state(),
        update: updater.state(),
        pause: pause.state(),
        stackActive: stack.active,
        shelfVisible: shelf.isVisible(),
        canRestore: ops.recentlyRemoved.length > 0
      }),
      handlers: {
        openPanel: () => panel.show(),
        toggleStack: () => stack.toggle(),
        pause: (ms) => pause.pause(ms),
        resume: () => pause.resume(),
        openSettings: () => settingsWindow.show(),
        toggleShelf: () => {
          shelf.toggle();
          setTimeout(() => tray && tray.refresh(), 50);
        },
        restoreShelf: () => {
          if (ops.restoreRecentlyRemoved()) shelf.show();
        },
        addClipboardToShelf: () => ops.addClipboardToShelf().then((a) => a && a.length && shelf.show()),
        dropFiles: (files) => ops.addPathsToShelf(files).then(() => shelf.show()),
        dropText: (text) => {
          ops.addTextToShelf(text);
          shelf.show();
        },
        screenOcr: () => (settings.screenOcrEnabled ? screenOcr.trigger() : settingsWindow.show('screenOcr')),
        keepAwake: (on, durationMs) => (on ? keepAwake.start({ durationMs }) : keepAwake.stop()),
        installUpdate: () => updater.install(),
        checkUpdate: async () => {
          const st = await updater.check({ manual: true });
          if (st.status === 'latest') hud.show('最新の版です', `HarboR ClipShelf ${app.getVersion()}`, { kind: 'info' });
          else if (st.status === 'error') hud.show('アップデートを確認できませんでした', 'ネットワーク接続を確認してください', { kind: 'warn' });
          else if (st.status === 'unconfigured') hud.show('アップデートの確認先が未設定です', 'GitHub で作ったインストーラで確認できるようになります', { kind: 'info' });
          else if (st.newer) settingsWindow.show('update');
        },
        about: () => {
          app.setAboutPanelOptions({ applicationName: 'HarboR ClipShelf', applicationVersion: app.getVersion(), copyright: 'HarboR 社内ツール' });
          app.showAboutPanel();
        },
        quit: () => app.quit()
      }
    });
    if (settings.showMenuBarIcon) tray.create();
    shelf.on('change', () => tray && tray.refresh());

    registerIpc({
      store, watcher, ocr, ops, panel, shelf, stack, pasteService, settingsWindow, previewWindow, getSettings, setSettings,
      shortcuts, applyShortcuts, snapper, keepAwake, windowService, focusFollow, monitor, screenOcr, hud, log, deviceId,
      updater, appIcons, pause, sounds, broadcast, conflicts
    });
    screenOcr.registerIpc();

    applyShortcuts();
    setTimeout(() => conflicts.start(), 1500);
    applyLoginItem();
    focusFollow.apply();
    shelf.applySettings();
    hud.ensure();
    updater.start();
    updater.cleanup();
    powerMonitor.on('resume', () => updater.onResume());
    noticeVersionChange();

    const openedAtLogin = (() => {
      if (process.argv.includes('--hidden')) return true;
      try {
        return isMac && !!app.getLoginItemSettings().wasOpenedAtLogin;
      } catch {
        return false;
      }
    })();
    // First launch: the quick start (like Paste's onboarding).
    if (!settings.firstRunCompleted) settingsWindow.show('welcome');
    else if (!openedAtLogin && !process.env.CLIPSHELF_SMOKE) panel.show();
    app.on('activate', () => settingsWindow.show());
    if (process.env.CLIPSHELF_SMOKE) {
      // Development-only end-to-end check (scripts/ is not packaged).
      require(process.env.CLIPSHELF_SMOKE_SCRIPT || path.join(__dirname, '..', '..', 'scripts', 'smoke-run.js'))({
        app, store, watcher, ocr, ops, panel, shelf, stack, pasteService, settingsWindow, previewWindow, keepAwake,
        windowService, snapper, focusFollow, monitor, screenOcr, hud, log, getSettings, setSettings, shortcuts, updater, pause,
        conflicts
      });
    }
    log.info(`HarboR ClipShelf ${app.getVersion()} started (${process.platform}, data: ${store.dataDir}, capture: ${watcher.mode}, accessibility: ${isMac ? systemPreferences.isTrustedAccessibilityClient(false) : 'n/a'})`);
  });

  // Tray app: keep running with no windows open.
  app.on('window-all-closed', () => {});

  let cleanedUp = false;
  app.on('before-quit', (event) => {
    if (cleanedUp) return;
    event.preventDefault();
    const cleanup = (async () => {
      if (updater) updater.stop();
      if (conflicts) conflicts.stop();
      if (pause) pause.stop();
      if (stack) stack.destroy();
      if (panel) panel.destroy();
      if (shelf) shelf.destroy();
      if (focusFollow) await focusFollow.restoreForQuit();
      shortcuts.dispose();
      watcher.stop();
      monitor.stop();
      windowService.stop();
      keepAwake.stop({ source: 'quit' });
      await store.stop();
      await ocr.dispose();
      hud.destroy();
      if (tray) tray.destroy();
      if (settingsWindow) settingsWindow.destroy();
    })().catch((err) => log.error('[quit] cleanup failed', err));
    Promise.race([cleanup, new Promise((r) => setTimeout(r, 3000))]).finally(() => {
      cleanedUp = true;
      app.quit();
    });
  });
}
