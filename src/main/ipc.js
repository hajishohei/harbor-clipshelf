'use strict';
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { ipcMain, dialog, app, shell, BrowserWindow, Menu, screen, nativeImage } = require('electron');
const blobs = require('./blobs');
const { lite, isRef } = require('./itemOps');
const pasteImport = require('./pasteImport');
const previewContent = require('./previewContent');
const { hasFullDiskAccess } = require('./fullDiskAccess');
const { previewOf, isUrl, formatBytes } = require('../shared/text');
const layouts = require('../shared/layouts');
const paths = require('./paths');
const settingsStore = require('./settings');
const nativeDrag = require('./nativeDrag');
const { DEFAULT_PINBOARD_ID, PINBOARD_COLORS } = require('./store');

const ID_RE = /^[0-9a-f-]{36}$/;
const MAX_BYTES_FROM_RENDERER = 64 * 1024 * 1024;
const SETTABLE = [
  'syncFolder', 'launchAtLogin', 'showMenuBarIcon', 'soundEffects', 'copySound', 'pasteSound', 'soundVolume', 'appearance', 'captureEnabled',
  'historyRetention', 'pasteTarget', 'alwaysPlainText', 'plainTextModifier', 'quickPasteModifier',
  'multiPasteSeparator', 'pasteStackOrder', 'recordSourceApp', 'ocrEnabled', 'ignoredApps', 'ignoreTransient',
  'ignoreConfidential', 'linkPreviews', 'showDuringScreenSharing', 'shelfEnabled', 'shelfShowMode', 'shelfPosition',
  'shelfSize', 'shelfIgnoredApps', 'shelfFileMode', 'shelfRemoveAfterDragOut', 'shelfStackMultiple',
  'shelfQuickLookThumbnails', 'shelfResolveAliases', 'shelfFaviconsForWebloc', 'shelfCollapseWhenIdle',
  'shelfFollowActiveDisplay', 'shelfParkSide', 'screenOcrEnabled',
  'windowSnapEnabled', 'focusFollowMouse', 'keepAwake', 'shortcuts', 'updateCheckEnabled', 'firstRunCompleted'
];
const PINBOARD_EDITABLE = ['name', 'color'];

const RENDERER_URL = pathToFileURL(path.join(__dirname, '..', 'renderer') + path.sep).href.toLowerCase();
function trustedSender(event) {
  const url = event && event.senderFrame && event.senderFrame.url;
  return typeof url === 'string' && decodeURI(url).toLowerCase().startsWith(decodeURI(RENDERER_URL));
}

const isId = (v) => typeof v === 'string' && ID_RE.test(v);
const idList = (v) => (Array.isArray(v) ? v : [v]).filter(isId).slice(0, 5000);
// shelf routes also accept "<id>#<n>" (one file inside a stack)
const refList = (v) => (Array.isArray(v) ? v : [v]).filter((x) => isId(x) || isRef(x)).slice(0, 5000);
const TYPE_LABEL = { text: 'テキスト', url: 'リンク', image: '画像', file: 'ファイル' };

function registerIpc(ctx) {
  const {
    store, watcher, ocr, ops, panel, shelf, stack, pasteService, settingsWindow, previewWindow, getSettings, setSettings,
    shortcuts, applyShortcuts, snapper, keepAwake, windowService, focusFollow, monitor, screenOcr, hud, log, deviceId,
    updater, appIcons, pause, sounds, broadcast, conflicts
  } = ctx;

  store.on('changed', (item) => broadcast('items:changed', lite(item)));
  store.on('removed', (id) => broadcast('items:removed', id));
  store.on('reset', () => broadcast('items:reset'));

  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (event, ...args) => {
      if (!trustedSender(event)) {
        log.warn(`[ipc] rejected ${channel} from ${event.senderFrame && event.senderFrame.url}`);
        throw new Error('forbidden');
      }
      try {
        return await fn(event, ...args);
      } catch (err) {
        log.error(`[ipc] ${channel} failed`, err && err.stack ? err.stack : err);
        throw err;
      }
    });
  const on = (channel, fn) =>
    ipcMain.on(channel, (event, ...args) => {
      if (!trustedSender(event)) return;
      try {
        fn(event, ...args);
      } catch (err) {
        log.error(`[ipc] ${channel} failed`, err && err.stack ? err.stack : err);
      }
    });
  const winOf = (event) => BrowserWindow.fromWebContents(event.sender);
  const items = (ids) => idList(ids).map((id) => store.get(id)).filter(Boolean);
  // like items(), but stack children become stand-in items
  const refItems = (ids) => refList(ids).map((id) => ops.virtual(id)).filter(Boolean);
  const refItem = (id) => ((isId(id) || isRef(id)) && ops.virtual(id)) || null;

  function withIcon(item) {
    const out = lite(item);
    if (!out) return out;
    const key = appIcons.key(item);
    const entry = appIcons.get(key);
    if (entry) {
      out.appIcon = entry.icon;
      out.appColor = entry.color;
    }
    return out;
  }

  // ---------------------------------------------------------------- app
  handle('app:info', () => ({
    version: app.getVersion(),
    platform: process.platform,
    dataDir: store.dataDir,
    logsDir: log.dir(),
    deviceId,
    firstRunCompleted: getSettings().firstRunCompleted,
    defaults: settingsStore.DEFAULT_SHORTCUTS,
    localShortcuts: settingsStore.LOCAL_SHORTCUTS,
    snapActions: layouts.ACTIONS,
    snapLabels: layouts.LABELS,
    nativeDrag: nativeDrag.available(),
    pinboardColors: PINBOARD_COLORS,
    defaultPinboardId: DEFAULT_PINBOARD_ID
  }));
  handle('app:openFolder', (_e, kind) => {
    const dir = kind === 'logs' ? log.dir() : store.dataDir;
    if (dir) shell.openPath(dir);
    return true;
  });
  handle('app:openSettings', (_e, section) => {
    panel.hide({ restoreFocus: false });
    settingsWindow.show(typeof section === 'string' ? section : null);
    return true;
  });
  handle('app:quit', () => {
    app.quit();
    return true;
  });
  handle('app:about', () => {
    app.setAboutPanelOptions({ applicationName: 'HarboR ClipShelf', applicationVersion: app.getVersion(), copyright: 'HarboR 社内ツール' });
    app.showAboutPanel();
    return true;
  });

  // ---------------------------------------------------------------- items
  handle('items:list', (_e, board, opts = {}) => {
    if (!['history', 'pin', 'shelf'].includes(board)) return [];
    const list = store.list(board, { pinboardId: opts && isId(opts.pinboardId) ? opts.pinboardId : null });
    for (const item of list.slice(0, 400)) {
      if (item.sourceBundleId && !appIcons.get(appIcons.key(item))) {
        appIcons.request({ bundleId: item.sourceBundleId, name: item.sourceApp }, () => broadcast('icons:changed'));
      }
    }
    return list.map(withIcon);
  });
  handle('items:get', (_e, id) => (isId(id) ? store.get(id) : null));

  handle('items:update', (_e, id, patch) => {
    const item = isId(id) && store.get(id);
    if (!item || !patch || typeof patch !== 'object') return null;
    const safe = {};
    if (typeof patch.label === 'string' || patch.label === null) safe.label = patch.label ? patch.label.trim().slice(0, 120) || null : null;
    if (typeof patch.text === 'string' && (item.type === 'text' || item.type === 'url') && patch.text.length) {
      safe.text = patch.text;
      safe.preview = previewOf(patch.text);
      safe.type = isUrl(patch.text) ? 'url' : 'text';
      if (typeof patch.html === 'string' && patch.html.length < 512 * 1024) safe.html = patch.html;
      else safe.html = null;
      safe.rtf = null;
      if (item.board === 'history') safe.hash = null; // edited → no longer the same copy
    }
    if (typeof patch.locked === 'boolean') safe.locked = patch.locked;
    if (Number.isInteger(patch.rotate) && item.type === 'image') {
      const { nativeImage } = require('electron');
      const img = nativeImage.createFromBuffer(blobs.readBlob(store.settings, item.blob));
      const turns = ((patch.rotate % 4) + 4) % 4;
      if (turns && !img.isEmpty()) {
        const rotated = rotateImage(img, turns);
        safe.blob = blobs.saveBlob(store.settings, rotated.toPNG(), '.png');
        safe.imageSize = rotated.getSize();
      }
    }
    return lite(store.update(id, safe));
  });

  handle('items:remove', (_e, ids, source) =>
    source === 'shelf' ? ops.remove(refList(ids), { source: 'shelf' }) : ops.remove(idList(ids), { source: 'panel' })
  );
  handle('items:undo', () => ops.undoRemove());
  handle('items:eraseHistory', () => {
    const n = ops.remove(store.list('history').map((i) => i.id), { source: 'panel' });
    return n;
  });
  handle('items:retentionPreview', (_e, value) => store.countOlderThan(settingsStore.RETENTION_MS[value]));

  handle('items:paste', (_e, ids, opts = {}) => pasteService.paste(idList(ids), { plain: !!(opts && opts.plain) }));
  handle('items:copy', (_e, ids, opts = {}) =>
    pasteService.copy(idList(ids), { plain: !!(opts && opts.plain), close: !(opts && opts.close === false) })
  );
  handle('items:duplicate', (_e, id) => (isId(id) ? ops.duplicate(id) : null));
  handle('items:createText', (_e, input = {}) => {
    const text = typeof input.text === 'string' ? input.text : '';
    if (!text.trim()) return null;
    const board = input.board === 'pin' ? 'pin' : input.board === 'shelf' ? 'shelf' : 'history';
    const extra = board === 'pin' ? { pinboardId: isId(input.pinboardId) ? input.pinboardId : DEFAULT_PINBOARD_ID, order: -Date.now() } : {};
    return lite(store.create({
      board,
      type: isUrl(text) ? 'url' : 'text',
      text,
      preview: previewOf(text),
      label: typeof input.label === 'string' && input.label.trim() ? input.label.trim().slice(0, 120) : null,
      ...extra
    }));
  });
  handle('items:pinTo', async (_e, ids, pinboardId) => {
    const board = isId(pinboardId) ? store.get(pinboardId) : null;
    if (!board || board.type !== 'pinboard') return 0;
    let n = 0;
    for (const item of items(ids)) {
      if (item.board === 'pin') {
        store.update(item.id, { pinboardId, order: -Date.now() });
        n++;
      } else if (await ops.copyToBoard(item.id, 'pin', { pinboardId })) {
        n++;
      }
    }
    if (n) sounds.play('copy');
    return n;
  });
  handle('items:unpin', (_e, ids) => ops.remove(items(ids).filter((i) => i.board === 'pin').map((i) => i.id)));
  handle('items:reorder', (_e, ids) => {
    store.reorder(idList(ids));
    return true;
  });
  handle('items:sendToShelf', async (_e, ids) => {
    let n = 0;
    for (const item of items(ids)) if (await ops.copyToBoard(item.id, 'shelf')) n++;
    if (n) shelf.show();
    return n;
  });
  handle('items:thumbnail', (_e, id, size) => (isId(id) || isRef(id) ? ops.thumbnail(id, Math.max(64, Math.min(640, Number(size) || 320))) : null));
  handle('items:fileStatus', (_e, ids) => ops.fileStatus(idList(ids)));
  handle('items:open', (_e, id) => {
    const item = refItem(id);
    return item ? ops.open(item) : false;
  });
  handle('items:reveal', (_e, id) => {
    const item = refItem(id);
    return item ? ops.reveal(item) : false;
  });
  handle('items:ocr', (_e, id) => {
    const item = isId(id) && store.get(id);
    if (!item || item.type !== 'image') return false;
    store.update(id, { ocrPending: true });
    ocr.enqueue(id, { force: true });
    return true;
  });

  // Space / 目のボタン: a Quick Look-like popup that closes when you click
  // anywhere else (or press Space / Esc).
  let previewSeq = 0;
  handle('items:preview', async (_e, id, from, opts = {}) => {
    const item = refItem(id);
    if (!item) return false;
    const owner = from === 'shelf' ? 'shelf' : 'panel';
    const replace = !!(opts && opts.replace);
    const seq = ++previewSeq;
    if (!replace && previewWindow.isOpen()) {
      previewWindow.close();
      return true;
    }
    // The click on the eye button itself closed it a moment ago → leave it closed.
    if (!replace && previewWindow.justClosed(id)) return true;
    const payload = await previewPayload(item, { owner });
    // A newer request came in, or the popup was closed while we were reading the file.
    if (seq !== previewSeq || (replace && !previewWindow.isOpen())) return false;
    const anchor = owner === 'shelf' ? shelf.bounds() : null;
    const fresh = !previewWindow.isOpen();
    if (fresh && owner === 'panel') panel.pushModal();
    if (owner === 'shelf') shelf.setPreviewOpen(true);
    const returnTo = fresh ? (owner === 'shelf' && shelf.win && !shelf.win.isDestroyed() && shelf.win.isFocused() ? 'shelf' : 'app') : undefined;
    previewWindow.show(payload, { owner, id, anchor, side: owner === 'shelf' ? shelf.sideForPreview() : null, keepPosition: replace, returnTo });
    return true;
  });
  on('preview:close', () => previewWindow.close({ restore: true }));

  async function previewPayload(item, { owner }) {
    const out = { item: lite(item), owner, text: null, image: null, content: null, files: [] };
    out.meta = {
      type: TYPE_LABEL[item.type] || item.type,
      app: item.sourceApp || null,
      at: item.usedAt || item.createdAt
    };
    if (item.type === 'text' || item.type === 'url') {
      out.text = item.text;
      out.content = { kind: item.type === 'url' ? 'link' : 'snippet' };
    }
    if (item.type === 'image' || (item.type === 'url' && item.linkImage)) {
      out.image = await ops.thumbnail(item.id, 1600);
      if (item.type === 'image') {
        const size = item.imageSize || {};
        out.content = { kind: 'image', src: out.image, width: size.width, height: size.height };
      }
    }
    if (item.type === 'file') {
      const files = item.files || [];
      const paths = files.map((f) => (f.path && fs.existsSync(f.path) ? f.path : null));
      const staged = ops.dragPaths([item], { source: 'panel' });
      const firstPath = paths[0] || staged[0] || null;
      out.content = firstPath ? await previewContent.describeFile(firstPath, { name: files[0] && files[0].name, isDir: files[0] && files[0].isDir }) : { kind: 'missing', name: files[0] && files[0].name };
      out.files = files.map((f, i) => ({
        name: f.name,
        path: f.path,
        size: formatBytes(f.size),
        isDir: f.isDir,
        ref: item.parentId ? null : files.length > 1 ? `${item.id}#${i}` : null
      }));
      if (files.length > 1) {
        out.content.stackCount = files.length;
        out.stackThumbs = await Promise.all(files.slice(0, 40).map((_f, i) => ops.thumbnail(`${item.id}#${i}`, 160)));
      }
      out.title = files.length > 1 ? `${files[0].name} ほか ${files.length - 1} 件` : files[0] && files[0].name;
    }
    return out;
  }

  // ---------------------------------------------------------------- context menus (native)
  handle('menu:item', async (event, ids, where) => {
    if (where === 'shelf') shelf.pushBusy();
    try {
      const picked = await itemMenu(event, ids, where);
      if (where === 'shelf' && !picked) shelf.holdFor(8000); // "共有" opens a system sheet after the menu closes
      return picked;
    } finally {
      if (where === 'shelf') shelf.popBusy();
    }
  });
  async function itemMenu(event, ids, where) {
    const list = where === 'shelf' ? refItems(ids) : items(ids);
    if (!list.length) return null;
    const first = list[0];
    const s = getSettings();
    const target = panel.targetAppName();
    const single = list.length === 1;
    return new Promise((resolve) => {
      const act = (name, ...args) => () => resolve({ action: name, args });
      let template;
      if (where === 'shelf' && list.some((i) => i.parentId)) {
        template = [
          { label: 'クイックルック', click: act('preview'), enabled: single },
          { label: 'スタックから取り出して削除', click: act('remove') },
          { type: 'separator' },
          { label: '開く', click: act('open'), enabled: single },
          { label: process.platform === 'darwin' ? 'Finder に表示' : 'エクスプローラーで表示', click: act('reveal'), enabled: single },
          { label: 'ファイルパスをコピー', click: act('copyPaths') }
        ];
      } else if (where === 'shelf') {
        const files = first.type === 'file';
        template = [
          { label: 'クイックルック', click: act('preview'), enabled: single },
          { label: 'リストから削除', click: act('remove') },
          { label: first.locked ? '項目のピン留めを外す' : '項目のピン留めをする', click: act('lock', !first.locked) },
          { type: 'separator' },
          { label: '開く', click: act('open'), enabled: single },
          { label: '移動…', click: act('move'), enabled: single && files },
          { label: 'コピー…', click: act('copyTo'), enabled: single && files },
          { label: '名称変更', click: act('rename'), enabled: single },
          { type: 'separator' },
          { label: process.platform === 'darwin' ? 'Finder に表示' : 'エクスプローラーで表示', click: act('reveal'), enabled: single && files },
          { label: 'ファイルパスをコピー', click: act('copyPaths'), enabled: files },
          ...(files && single && (first.files || []).length > 1 ? [{ label: 'スタックを分割', click: act('split') }] : []),
          ...(list.length > 1 ? [{ label: '選択した項目をスタックにまとめる', click: act('merge') }] : []),
          { type: 'separator' },
          { label: '最後に削除したファイルを戻す', click: act('restore'), enabled: ops.recentlyRemoved.length > 0 },
          { label: 'クリップボードから追加', click: act('addClipboard') }
        ];
        if (process.platform === 'darwin' && files) {
          const filePaths = list.flatMap((i) => ops.originalPaths(i));
          if (filePaths.length) template.splice(9, 0, { label: '共有', role: 'shareMenu', sharingItem: { filePaths } });
        }
      } else {
        const inPin = first.board === 'pin';
        const pinboards = store.pinboards();
        template = [
          { label: target ? `「${target}」に貼り付け` : '貼り付け', click: act('paste') },
          { label: '書式なしテキストとして貼り付け', click: act('pastePlain'), enabled: list.every((i) => i.type === 'text' || i.type === 'url') },
          { label: 'コピー', click: act('copy') },
          { label: '書式なしテキストとしてコピー', click: act('copyPlain'), enabled: list.every((i) => i.type === 'text' || i.type === 'url') },
          { type: 'separator' },
          { label: 'プレビュー', accelerator: 'Space', registerAccelerator: false, click: act('preview'), enabled: single },
          { label: '開く', accelerator: 'CommandOrControl+O', registerAccelerator: false, click: act('open'), enabled: single && ['url', 'file', 'image'].includes(first.type) },
          ...(first.type === 'file' ? [{ label: process.platform === 'darwin' ? 'Finder で表示' : 'エクスプローラーで表示', click: act('reveal'), enabled: single }] : []),
          { type: 'separator' },
          { label: '名前変更', accelerator: 'CommandOrControl+R', registerAccelerator: false, click: act('rename'), enabled: single },
          { label: '編集', accelerator: 'CommandOrControl+E', registerAccelerator: false, click: act('edit'), enabled: single && ['text', 'url', 'image'].includes(first.type) },
          { label: '複製', click: act('duplicate'), enabled: single },
          {
            label: '固定',
            submenu: [
              ...pinboards.map((b) => ({ label: b.name, type: 'checkbox', checked: inPin && (first.pinboardId || DEFAULT_PINBOARD_ID) === b.id, click: act('pinTo', b.id) })),
              { type: 'separator' },
              { label: 'ピンボードを作成…', click: act('newPinboardWith') }
            ]
          },
          ...(inPin ? [{ label: 'アンピン', click: act('unpin') }] : []),
          { label: 'シェルフに置く', click: act('sendToShelf') },
          ...(first.type === 'image' ? [{ label: '画像の文字を読み取り直す', click: act('ocr'), enabled: single && s.ocrEnabled }] : []),
          { type: 'separator' },
          { label: '削除', accelerator: 'Backspace', registerAccelerator: false, click: act('remove') }
        ];
      }
      const menu = Menu.buildFromTemplate(template);
      menu.popup({ window: winOf(event), callback: () => setTimeout(() => resolve(null), 50) });
    });
  }

  handle('menu:pinboard', async (event, id) => {
    const board = isId(id) && store.get(id);
    return new Promise((resolve) => {
      const act = (name, ...args) => () => resolve({ action: name, args });
      const template = board
        ? [
          { label: '名前を変更…', click: act('rename') },
          { label: '色', submenu: PINBOARD_COLORS.map((c) => ({ label: COLOR_NAMES[c], type: 'radio', checked: board.color === c, click: act('color', c) })) },
          { type: 'separator' },
          { label: 'ピンボードを削除…', click: act('delete'), enabled: store.pinboards().length > 1 || id !== DEFAULT_PINBOARD_ID }
        ]
        : [
          { label: '履歴を消去…', click: act('eraseHistory') },
          { label: 'ピンボードを作成', accelerator: 'Shift+CommandOrControl+N', registerAccelerator: false, click: act('newPinboard') }
        ];
      Menu.buildFromTemplate(template).popup({ window: winOf(event), callback: () => setTimeout(() => resolve(null), 50) });
    });
  });

  // "…" menu in the panel toolbar (Paste's app menu)
  handle('menu:panel', async (event) => {
    return new Promise((resolve) => {
      const act = (name, ...args) => () => resolve({ action: name, args });
      const st = pause.state();
      const template = [
        { label: '新しいテキストアイテム', accelerator: 'CommandOrControl+N', registerAccelerator: false, click: act('newText') },
        { label: 'ピンボードを作成', accelerator: 'Shift+CommandOrControl+N', registerAccelerator: false, click: act('newPinboard') },
        { label: 'Paste Stack', accelerator: getSettings().shortcuts.pasteStack || undefined, registerAccelerator: false, click: act('stack') },
        { type: 'separator' },
        st.paused
          ? { label: '記録を再開', accelerator: 'CommandOrControl+T', registerAccelerator: false, click: act('resume') }
          : { label: '記録を一時停止', submenu: pauseMenu(act) },
        { type: 'separator' },
        { label: '履歴を消去…', click: act('eraseHistory') },
        { label: 'バーの高さを元に戻す', click: act('resetHeight') },
        { type: 'separator' },
        { label: '設定…', accelerator: 'CommandOrControl+,', registerAccelerator: false, click: act('settings') },
        { label: 'HarboR ClipShelf を終了', accelerator: 'CommandOrControl+Q', registerAccelerator: false, click: act('quit') }
      ];
      Menu.buildFromTemplate(template).popup({ window: winOf(event), callback: () => setTimeout(() => resolve(null), 50) });
    });
  });

  // Yoink gear menu
  handle('menu:shelfGear', async (event, selected) => {
    const s = getSettings();
    return new Promise((resolve) => {
      const act = (name, ...args) => () => resolve({ action: name, args });
      const pos = (value, label) => ({ label, type: 'radio', checked: !s.shelfCustomPosition && s.shelfPosition === value, click: act('position', value) });
      const size = (value, label) => ({ label, type: 'radio', checked: s.shelfSize === value, click: act('size', value) });
      const template = [
        {
          label: 'ウインドウの位置',
          submenu: [
            { label: '画面の左端', enabled: false }, pos('left-top', '左端、上辺'), pos('left-center', '左端、中央'), pos('left-bottom', '左端、下辺'),
            { type: 'separator' },
            { label: '画面の右端', enabled: false }, pos('right-top', '右端、上辺'), pos('right-center', '右端、中央'), pos('right-bottom', '右端、下辺')
          ]
        },
        { label: 'ウインドウの大きさ', submenu: [size('default', 'デフォルト（3 項目）'), size('auto', '自動調整（3 項目）'), size('autoMin', '自動調整（最小）')] },
        {
          label: 'データを置いたあとの移動先',
          submenu: [
            { label: '画面の右端', type: 'radio', checked: s.shelfParkSide === 'right', click: act('park', 'right') },
            { label: '画面の左端', type: 'radio', checked: s.shelfParkSide === 'left', click: act('park', 'left') },
            { label: 'シェルフと同じ側', type: 'radio', checked: s.shelfParkSide === 'same', click: act('park', 'same') },
            { type: 'separator' },
            { label: '使っていないときは端に収納する', type: 'checkbox', checked: s.shelfCollapseWhenIdle, click: act('collapseIdle', !s.shelfCollapseWhenIdle) }
          ]
        },
        { type: 'separator' },
        { label: 'すべて選択', accelerator: 'CommandOrControl+A', registerAccelerator: false, click: act('selectAll') },
        { label: '選択中の項目をスタックにマージ', enabled: Array.isArray(selected) && selected.length > 1, click: act('merge') },
        { label: '最後に削除したファイルを戻す', enabled: ops.recentlyRemoved.length > 0, click: act('restore') },
        { label: 'クリップボードから追加', click: act('addClipboard') },
        { type: 'separator' },
        { label: 'HarboR ClipShelf について', click: act('about') },
        { label: '環境設定…', click: act('settings') },
        { type: 'separator' },
        { label: 'HarboR ClipShelf を終了', click: act('quit') }
      ];
      Menu.buildFromTemplate(template).popup({ window: winOf(event), callback: () => setTimeout(() => resolve(null), 50) });
    });
  });

  function pauseMenu(act) {
    return [
      { label: '15分間', click: act('pause', 15 * 60 * 1000) },
      { label: '1時間', click: act('pause', 60 * 60 * 1000) },
      { label: '8時間', click: act('pause', 8 * 60 * 60 * 1000) },
      { label: '24時間', click: act('pause', 24 * 60 * 60 * 1000) },
      { label: '再開するまで', click: act('pause', null) }
    ];
  }

  handle('dialog:folder', async (event, title) => {
    panel.pushModal();
    try {
      const r = await dialog.showOpenDialog(winOf(event), { title: String(title || 'フォルダを選択'), properties: ['openDirectory', 'createDirectory'] });
      return r.canceled ? null : r.filePaths[0];
    } finally {
      panel.popModal();
    }
  });
  handle('dialog:confirm', async (event, opts = {}) => {
    panel.pushModal();
    try {
      const r = await dialog.showMessageBox(winOf(event), {
        type: 'warning',
        message: String(opts.message || ''),
        detail: String(opts.detail || ''),
        buttons: [String(opts.ok || 'OK'), 'キャンセル'],
        defaultId: 1,
        cancelId: 1
      });
      return r.response === 0;
    } finally {
      panel.popModal();
    }
  });
  handle('dialog:chooseApp', async (event) => {
    const r = await dialog.showOpenDialog(winOf(event), {
      title: 'アプリケーションを選択',
      defaultPath: process.platform === 'darwin' ? '/Applications' : process.env.ProgramFiles,
      properties: ['openFile', ...(process.platform === 'darwin' ? ['treatPackageAsDirectory'] : [])],
      filters: process.platform === 'win32' ? [{ name: 'アプリ', extensions: ['exe'] }] : [{ name: 'アプリ', extensions: ['app'] }]
    });
    if (r.canceled || !r.filePaths.length) return null;
    return path.basename(r.filePaths[0]).replace(/\.(app|exe)$/i, '');
  });

  // ---------------------------------------------------------------- pinboards
  handle('pinboards:list', () => {
    store.ensureDefaultPinboard();
    return store.pinboards().map(lite);
  });
  handle('pinboards:create', (_e, input = {}) => lite(store.createPinboard(input)));
  handle('pinboards:update', (_e, id, patch = {}) => {
    const board = isId(id) && store.get(id);
    if (!board || board.type !== 'pinboard') return null;
    const safe = {};
    for (const k of PINBOARD_EDITABLE) if (typeof patch[k] === 'string') safe[k] = patch[k];
    if (safe.name !== undefined) safe.name = safe.name.trim().slice(0, 60) || board.name;
    if (safe.color !== undefined && !PINBOARD_COLORS.includes(safe.color)) delete safe.color;
    return lite(store.update(id, safe));
  });
  handle('pinboards:delete', (_e, id) => (isId(id) ? store.deletePinboard(id) : false));
  handle('pinboards:reorder', (_e, ids) => {
    store.reorder(idList(ids));
    return true;
  });

  // ---------------------------------------------------------------- panel
  on('panel:hide', (_e, opts = {}) => panel.hide({ restoreFocus: opts.restoreFocus !== false }));
  on('panel:resize', (_e, height) => panel.resizeTo(Number(height)));
  on('panel:modal', (_e, open) => panel.setRendererModal(!!open));
  handle('sounds:list', () => sounds.choices());
  handle('sounds:preview', (_e, value, kind, volume) => sounds.preview(String(value || ''), kind === 'paste' ? 'paste' : 'copy', Number(volume)));
  on('panel:dragOut', (_e, active) => (active ? panel.beginDragOut() : panel.endDragOut()));
  handle('panel:resetHeight', () => panel.resetHeight());
  handle('panel:open', () => panel.show());
  handle('panel:targetApp', () => panel.targetAppName());

  // ---------------------------------------------------------------- drag out (panel + shelf)
  // Paths of a drag that started on the shelf: dropping them back onto the
  // shelf must not add them again.
  let activeShelfDrag = null;
  ops.isActiveShelfDragPath = (p) => !!(activeShelfDrag && activeShelfDrag.paths.has(path.resolve(p)));
  on('shelf:ownDrag', () => shelf.ownDragStarted(8000));

  on('drag:start', (event, ids, source) => {
    const list = source === 'shelf' ? refItems(ids) : items(ids);
    if (!list.length) return;
    const from = source === 'shelf' ? 'shelf' : 'panel';
    const files = ops.dragPaths(list, { source: from });
    if (!files.length) return;
    const win = winOf(event);
    if (from === 'shelf') {
      shelf.ownDragStarted(30000);
      activeShelfDrag = { paths: new Set(files.map((f) => path.resolve(f))) };
    }
    const startedAt = Date.now();
    if (from === 'panel') panel.beginDragOut();
    ops.dragIcon(list).then((icon) => {
      const iconPng = icon.toPNG();
      const done = (result) => {
        if (from === 'panel') panel.endDragOut();
        afterDrag(list, from, files, result, startedAt);
        if (from === 'shelf') {
          shelf.ownDragStarted(600);
          setTimeout(() => {
            activeShelfDrag = null;
          }, 800);
        }
      };
      let pending = null;
      try {
        // Yoink moves files like Finder; Paste only ever copies.
        pending = nativeDrag.startFileDrag(win, files, iconPng, { allowMove: from === 'shelf' });
      } catch (err) {
        log.warn('[drag] native drag could not start', err.message);
        pending = null;
      }
      if (pending) {
        pending.then(done).catch((err) => log.warn('[drag] native drag error', err.message));
        return;
      }
      // Electron fallback: copy-only, no result. The monitor's DRAG end tells
      // us roughly where it was dropped.
      event.sender.startDrag({ file: files[0], files, icon });
      if (from === 'shelf') awaitMonitorDragEnd(list, files, startedAt, () => {
        shelf.ownDragStarted(600);
        setTimeout(() => {
          activeShelfDrag = null;
        }, 800);
      });
    }).catch((err) => log.error('[drag] failed', err));
  });

  function awaitMonitorDragEnd(list, files, startedAt, finished) {
    if (!monitor.available) {
      setTimeout(finished, 3000);
      return;
    }
    const onDrag = (ev) => {
      if (ev.active) return;
      monitor.off('drag', onDrag);
      const p = screen.getCursorScreenPoint();
      afterDrag(list, 'shelf', files, { operation: 'unknown', x: p.x, y: p.y }, startedAt);
      finished();
    };
    monitor.on('drag', onDrag);
    setTimeout(() => {
      monitor.off('drag', onDrag);
      finished();
    }, 5 * 60 * 1000);
  }

  function afterDrag(list, from, files, result, startedAt) {
    if (from !== 'shelf') return;
    let point = { x: result.x, y: result.y };
    if (process.platform === 'win32' && result.operation !== 'unknown') {
      try {
        point = screen.screenToDipPoint(point);
      } catch {
        /* keep */
      }
    }
    const inside = shelf.containsPoint(point);
    const moved = files.some((f) => !fs.existsSync(f));
    const dropped = result.operation !== 'none' || moved;
    log.info(`[drag] ended op=${result.operation} inside=${inside} moved=${moved} ${Date.now() - startedAt}ms`);
    if (!dropped || inside) return;
    if (!getSettings().shelfRemoveAfterDragOut) {
      if (moved) refreshMovedFiles(list);
      return;
    }
    const removable = list.filter((i) => !i.locked);
    ops.remove(removable.filter((i) => !i.parentId).map((i) => i.id), { source: 'shelf' });
    // files taken out of a stack: find them again by identity (indexes may have shifted meanwhile)
    const refs = ops.refsForFiles(removable.filter((i) => i.parentId));
    if (refs.length) ops.remove(refs, { source: 'shelf' });
    if (moved) refreshMovedFiles(list.filter((i) => i.locked));
  }

  function refreshMovedFiles(list) {
    for (const item of list) shelf.send('shelf:fileStatus', ops.fileStatus([item.parentId || item.id]));
  }

  // ---------------------------------------------------------------- shelf
  handle('shelf:addPaths', (_e, list) => ops.addPathsToShelf((Array.isArray(list) ? list : []).slice(0, 2000)));
  handle('shelf:addText', (_e, text) => ops.addTextToShelf(text));
  handle('shelf:addBytes', (_e, input = {}) => {
    const { bytes } = input;
    if (!(bytes instanceof Uint8Array) && !(bytes instanceof ArrayBuffer)) return null;
    const buf = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
    if (!buf.length || buf.length > MAX_BYTES_FROM_RENDERER) return null;
    return ops.addBytesToShelf({ ...input, bytes: buf });
  });
  handle('shelf:addClipboard', () => ops.addClipboardToShelf());
  handle('shelf:list', () => store.list('shelf').map(lite));
  handle('shelf:split', (_e, id) => (isId(id) ? ops.splitStack(id) : 0));
  handle('shelf:merge', (_e, ids) => ops.mergeToStack(idList(ids)));
  handle('shelf:lock', (_e, ids, locked) => {
    for (const item of items(ids)) store.update(item.id, { locked: !!locked });
    return true;
  });
  handle('shelf:restore', () => ops.restoreRecentlyRemoved());
  handle('shelf:wipe', () => ops.remove(store.list('shelf').filter((i) => !i.locked).map((i) => i.id), { source: 'shelf' }));
  handle('shelf:hide', () => shelf.hide());
  handle('shelf:state', () => ({ visible: shelf.isVisible() }));
  handle('shelf:transfer', async (event, id, move) => {
    const item = isId(id) && store.get(id);
    if (!item || item.type !== 'file') return null;
    shelf.pushBusy();
    let r;
    try {
      r = await dialog.showOpenDialog(winOf(event), { title: move ? '移動先を選択' : 'コピー先を選択', properties: ['openDirectory', 'createDirectory'] });
    } finally {
      shelf.popBusy();
    }
    if (r.canceled || !r.filePaths.length) return null;
    return ops.transfer(item, r.filePaths[0], { move: !!move });
  });
  handle('shelf:rename', async (_e, id, name) => {
    const item = isId(id) && store.get(id);
    if (!item) return null;
    try {
      return await ops.rename(item, name);
    } catch (err) {
      return { error: err.message === 'exists' ? '同じ名前のファイルがあります' : 'このファイルの名前は変更できません' };
    }
  });
  handle('shelf:copyPaths', (_e, ids) => ops.copyPaths(refItems(ids)));
  on('shelf:expand', () => shelf.expand({ focus: false }));
  on('shelf:busy', (_e, busy) => shelf.setBusy(!!busy));
  on('shelf:activity', () => shelf.markActive());
  handle('shelf:setPosition', (_e, position) => {
    if (settingsStore.ENUMS.shelfPosition.includes(position)) setSettings({ shelfPosition: position, shelfCustomPosition: null });
    shelf.applySettings();
    return true;
  });
  handle('shelf:setSize', (_e, size) => {
    if (settingsStore.ENUMS.shelfSize.includes(size)) setSettings({ shelfSize: size });
    return true;
  });
  handle('shelf:resetPosition', () => shelf.resetPosition());

  // ---------------------------------------------------------------- paste stack
  handle('stack:state', () => stack.state());
  handle('stack:toggle', () => {
    panel.hide({ restoreFocus: true });
    stack.toggle();
    return stack.state();
  });
  handle('stack:close', () => stack.close());
  handle('stack:add', (_e, ids, index) => stack.add(idList(ids), { index: Number.isInteger(index) ? index : null }));
  handle('stack:remove', (_e, ids) => stack.remove(idList(ids)));
  handle('stack:reorder', (_e, ids) => stack.reorder(idList(ids)));
  handle('stack:toggleOrder', () => stack.toggleOrder());

  // ---------------------------------------------------------------- settings
  handle('settings:get', () => getSettings());
  handle('settings:set', (_e, patch) => {
    if (!patch || typeof patch !== 'object') return getSettings();
    const safe = {};
    for (const k of SETTABLE) if (k in patch) safe[k] = patch[k];
    if ('syncFolder' in safe && safe.syncFolder !== null && (typeof safe.syncFolder !== 'string' || !path.isAbsolute(safe.syncFolder))) {
      delete safe.syncFolder;
    }
    if (safe.shortcuts && typeof safe.shortcuts === 'object') {
      const clean = {};
      for (const [k, v] of Object.entries(safe.shortcuts)) if (k in settingsStore.DEFAULT_SHORTCUTS && typeof v === 'string') clean[k] = v;
      safe.shortcuts = clean;
    }
    return setSettings(safe);
  });
  handle('settings:resetShortcuts', () => setSettings({ shortcuts: { ...settingsStore.DEFAULT_SHORTCUTS } }));
  handle('settings:chooseSyncFolder', async (event) => {
    const result = await dialog.showOpenDialog(winOf(event), {
      title: '同期フォルダを選択（Google Drive / Dropbox / iCloud Drive など）',
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
  });
  handle('settings:syncInfo', () => {
    const s = getSettings();
    return {
      folder: s.syncFolder,
      available: paths.isSyncFolderAvailable(s),
      dataDir: store.dataDir,
      usingSync: !!s.syncFolder && path.resolve(store.dataDir) === path.resolve(paths.syncDataDir(s.syncFolder))
    };
  });

  const shortcutStatus = () => ({ ...shortcuts.status(), conflicts: conflicts ? conflicts.current() : [] });
  handle('shortcuts:status', () => shortcutStatus());
  handle('shortcuts:suspend', () => {
    shortcuts.suspend();
    return true;
  });
  handle('shortcuts:resume', () => {
    shortcuts.resume();
    applyShortcuts();
    if (conflicts) conflicts.check();
    return shortcutStatus();
  });
  handle('shortcuts:check', (_e, accelerator) => shortcuts.check(String(accelerator || '')));

  // ---------------------------------------------------------------- pause (Paste ⌘T)
  handle('pause:state', () => pause.state());
  handle('pause:set', (_e, durationMs) => pause.pause(Number(durationMs) > 0 ? Number(durationMs) : null));
  handle('pause:resume', () => pause.resume());

  // ---------------------------------------------------------------- system / features
  handle('system:status', () => ({
    platform: process.platform,
    captureMode: watcher.mode,
    monitor: monitor.status(),
    windowService: windowService.status(),
    focusFollow: focusFollow.status(),
    screenPermission: screenOcr.permission(),
    keepAwake: keepAwake.state(),
    capsLock: monitor.capsOn,
    accessibility: windowService.accessibilityGranted(false),
    accessibilityEverGranted: !!getSettings().accessibilityEverGranted,
    fullDiskAccess: hasFullDiskAccess(),
    appPath: process.platform === 'darwin' ? (/(.*?\.app)\//.exec(process.execPath) || [])[1] || null : null,
    shortcutConflicts: conflicts ? conflicts.current() : [],
    nativeDrag: nativeDrag.available()
  }));
  handle('system:revealApp', () => {
    const m = /(.*?\.app)\//.exec(process.execPath);
    if (m) shell.showItemInFolder(m[1]);
    return !!m;
  });
  handle('system:quitConflictingApp', (_e, bundleId) => (conflicts ? conflicts.quitApp(String(bundleId || '')) : false));

  // ---------------------------------------------------------------- Paste から取り込む
  let importing = false;
  handle('import:paste', async (event) => {
    if (process.platform !== 'darwin') return { error: 'mac-only' };
    if (importing) return { error: 'busy' };
    const found = pasteImport.findStores();
    if (!found.stores.length) return { error: found.denied ? 'permission' : 'not-found' };
    let best = null;
    let denied = found.denied;
    for (const file of found.stores) {
      try {
        const info = pasteImport.inspectStore(file);
        log.info('[import:paste] store', path.basename(file), JSON.stringify({ total: info.total, pinned: info.pinned, ...info.report }).slice(0, 3000));
        if (info.total && (!best || info.total > best.total)) best = { file, ...info };
      } catch (err) {
        log.warn('[import:paste] could not read', path.basename(file), err.message);
        if (/EPERM|EACCES|not permitted|authori[sz]ation/i.test(err.message)) denied = true;
      }
    }
    if (!best) return { error: denied ? 'permission' : 'empty' };
    const s = getSettings();
    const limited = s.historyRetention !== 'forever';
    const choice = await dialog.showMessageBox(winOf(event), {
      type: 'question',
      buttons: ['取り込む', 'キャンセル'],
      defaultId: 0,
      cancelId: 1,
      message: `Paste の項目が ${best.total} 件見つかりました`,
      detail: `うちピンボードの項目 ${best.pinned} 件。コピー履歴とピンボードを ClipShelf に取り込みます（Paste 側のデータはそのまま残ります）。同じ項目は二重に取り込みません。件数が多いと数分かかることがあります。`,
      checkboxLabel: limited ? '保持期間より古い履歴も取り込む（保持期間を「無期限」に変更）' : undefined,
      checkboxChecked: limited
    });
    if (choice.response !== 0) return { canceled: true };
    if (limited && choice.checkboxChecked) setSettings({ historyRetention: 'forever' });
    const retention = settingsStore.RETENTION_MS[getSettings().historyRetention];
    importing = true;
    hud.show('Paste から取り込んでいます…', `${best.total} 件`, { durationMs: 4000 });
    let result;
    try {
      result = await pasteImport.importStore(best.file, {
        store,
        quiet: true,
        saveBlob: (buf, ext) => blobs.saveBlob(store.settings, buf, ext || '.png'),
        toPng: (buf) => {
          const img = nativeImage.createFromBuffer(buf);
          return img.isEmpty() ? null : img.toPNG();
        },
        statFile: (p) => {
          try {
            const st = fs.statSync(p);
            return { name: path.basename(p) || p, size: st.isDirectory() ? null : st.size, isDir: st.isDirectory(), path: p, blob: null };
          } catch {
            return null;
          }
        },
        since: retention ? Date.now() - retention : 0
      });
    } catch (err) {
      log.error('[import:paste] failed', err && err.stack ? err.stack : err);
      return { error: /EPERM|EACCES|not permitted/i.test(String(err && err.message)) ? 'permission' : 'failed' };
    } finally {
      importing = false;
      store.emit('reset');
    }
    const { counts, report } = result;
    log.info('[import:paste] done', JSON.stringify(counts), JSON.stringify({ rows: report.rows, decoded: report.decoded, typeNames: report.typeNames, blobKinds: report.blobKinds, skippedLarge: report.skippedLarge }).slice(0, 3000));
    if (getSettings().ocrEnabled) {
      for (const item of store.list('history').filter((i) => i.type === 'image' && i.importKey && !i.ocrText).slice(0, 200)) ocr.enqueue(item.id);
    }
    if (!counts.history && !counts.pinned && !counts.duplicates) return { error: 'empty', counts };
    return { counts, found: best.total };
  });
  // Clears a stale entry left by an older build, then asks macOS again.
  handle('system:requestAccessibility', async () => {
    if (windowService.accessibilityGranted(false)) return true;
    await require('./accessibility').repair({ log });
    return false;
  });
  handle('system:openPrivacy', (_e, kind) => {
    windowService.openPrivacyPane(String(kind));
    return true;
  });
  handle('system:probeAutomation', async () => {
    try {
      await windowService.probe();
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err.reason || 'helper-error', message: err.message };
    }
  });
  handle('system:retryHelpers', () => {
    windowService.resetHelper();
    monitor.retry();
    return true;
  });
  handle('system:testSnap', async (_e, action) => {
    if (!layouts.ACTIONS.includes(action)) return { ok: false, reason: 'unknown-action' };
    await new Promise((r) => setTimeout(r, 1500));
    return snapper.apply(action);
  });

  handle('keepAwake:get', () => keepAwake.state());
  handle('keepAwake:set', (_e, input) => {
    const { active, durationMs } = input || {};
    if (active) keepAwake.start({ durationMs: Number(durationMs) > 0 ? Number(durationMs) : null });
    else keepAwake.stop();
    return keepAwake.state();
  });

  handle('screenOcr:trigger', async () => {
    panel.hide({ restoreFocus: false });
    await new Promise((r) => setTimeout(r, 300));
    await screenOcr.trigger();
    return true;
  });
  handle('screenOcr:primePermission', () => screenOcr.primePermission());

  // ---------------------------------------------------------------- updates
  handle('update:state', () => updater.state());
  handle('update:check', () => updater.check({ manual: true }));
  handle('update:install', () => updater.install());
  handle('update:openPage', (_e, which) => (which === 'download' ? updater.openDownloadPage() : updater.openReleasePage()));
  handle('update:skip', (_e, version) => updater.skip(version === null ? null : String(version || '')));

  handle('hud:test', () => {
    hud.show('テスト表示', 'お知らせはこの位置に出ます');
    sounds.play('copy');
    return true;
  });
}

const COLOR_NAMES = { red: 'レッド', orange: 'オレンジ', yellow: 'イエロー', green: 'グリーン', teal: 'ティール', blue: 'ブルー', purple: 'パープル', pink: 'ピンク', gray: 'グレー' };

function rotateImage(img, turns) {
  // nativeImage has no rotate: rotate the BGRA bitmap by 90° steps.
  let { width, height } = img.getSize();
  let src = img.toBitmap();
  for (let t = 0; t < turns; t++) {
    const dst = Buffer.alloc(src.length);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const si = (y * width + x) * 4;
        const nx = height - 1 - y;
        const ny = x;
        const di = (ny * height + nx) * 4;
        src.copy(dst, di, si, si + 4);
      }
    }
    src = dst;
    [width, height] = [height, width];
  }
  const { nativeImage } = require('electron');
  return nativeImage.createFromBitmap(src, { width, height });
}

module.exports = { registerIpc, lite, rotateImage };
