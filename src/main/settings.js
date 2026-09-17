'use strict';
const fs = require('fs');
const crypto = require('crypto');
const { settingsFile, deviceIdFile, userDataDir } = require('./paths');

const isMac = process.platform === 'darwin';
const CMD = isMac ? 'Command' : 'Control';
const SNAP = isMac ? 'Control+Option' : 'Control+Alt';
const DISPLAY = isMac ? 'Control+Option+Command' : 'Control+Alt+Shift';

const DEFAULT_SHORTCUTS = {
  // Paste 相当
  togglePanel: `${CMD}+Shift+V`,
  pasteStack: `${CMD}+Shift+C`,
  nextPinboard: `${CMD}+Right`, // パネル表示中のみ
  prevPinboard: `${CMD}+Left`, // パネル表示中のみ
  // Yoink 相当（Mac は Yoink と同じ F5。Windows の F5 はブラウザの更新なので別キー）
  toggleShelf: isMac ? 'F5' : 'Control+Shift+Y',
  // その他
  screenOcr: `${CMD}+Shift+2`,
  toggleKeepAwake: '',
  snapLeft: `${SNAP}+Left`,
  snapRight: `${SNAP}+Right`,
  snapTop: `${SNAP}+Up`,
  snapBottom: `${SNAP}+Down`,
  snapTopLeft: `${SNAP}+U`,
  snapTopRight: `${SNAP}+I`,
  snapBottomLeft: `${SNAP}+J`,
  snapBottomRight: `${SNAP}+K`,
  snapLeftThird: `${SNAP}+D`,
  snapCenterThird: `${SNAP}+F`,
  snapRightThird: `${SNAP}+G`,
  snapLeftTwoThirds: `${SNAP}+E`,
  snapRightTwoThirds: `${SNAP}+T`,
  snapMaximize: `${SNAP}+Return`,
  snapCenter: `${SNAP}+C`,
  snapRestore: `${SNAP}+Backspace`,
  snapNextDisplay: `${DISPLAY}+Right`,
  snapPrevDisplay: `${DISPLAY}+Left`
};

// Shortcuts that only work while the Paste-style panel is open.
const LOCAL_SHORTCUTS = ['nextPinboard', 'prevPinboard'];

const ENUMS = {
  appearance: ['system', 'light', 'dark'],
  historyRetention: ['day', 'week', 'month', 'year', 'forever'],
  pasteTarget: ['app', 'clipboard'],
  plainTextModifier: ['Shift', 'Option', 'Control', 'Command'],
  quickPasteModifier: ['Command', 'Control', 'Option'],
  pasteStackOrder: ['fifo', 'lifo'],
  multiPasteSeparator: ['newline', 'space', 'none'],
  shelfShowMode: ['dragStart', 'mouse', 'edge'],
  shelfPosition: ['left-top', 'left-center', 'left-bottom', 'right-top', 'right-center', 'right-bottom'],
  shelfSize: ['default', 'auto', 'autoMin'],
  shelfFileMode: ['reference', 'copy']
};

const RETENTION_MS = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 31 * 24 * 60 * 60 * 1000,
  year: 366 * 24 * 60 * 60 * 1000,
  forever: Infinity
};

const DEFAULTS = {
  version: 3,
  firstRunCompleted: false,
  // 同期したい場合だけ、Google Drive / Dropbox / iCloud Drive などの
  // 「常時同期されるローカルフォルダ」を指定する。
  syncFolder: null,

  // --- 一般（Paste・Yoink 共通）
  launchAtLogin: false,
  showMenuBarIcon: true,
  soundEffects: true,
  appearance: 'system',

  // --- クリップボード履歴（Paste 相当）
  captureEnabled: true, // false = 一時停止中
  pausedUntil: null, // 一時停止の終了時刻（ms）。null = 再開するまで
  historyRetention: 'month',
  pasteTarget: 'app', // Enter / ダブルクリックで「アクティブなアプリへ」貼り付け
  alwaysPlainText: false,
  plainTextModifier: 'Shift',
  quickPasteModifier: isMac ? 'Command' : 'Control',
  multiPasteSeparator: 'newline',
  pasteStackOrder: 'fifo',
  panelHeight: null,
  recordSourceApp: true,
  ocrEnabled: true,
  // プライバシー
  ignoredApps: [],
  ignoreTransient: true,
  ignoreConfidential: false, // パスワード等も記録する（社内要望）
  linkPreviews: true,
  showDuringScreenSharing: true,

  // --- シェルフ（Yoink 相当）
  shelfEnabled: true, // 「Yoink を自動的に表示する」
  shelfShowMode: 'dragStart',
  shelfPosition: 'left-center',
  shelfCustomPosition: null, // ウインドウをドラッグで動かした位置 { x, y }
  shelfSize: 'default',
  shelfIgnoredApps: [],
  shelfFileMode: 'reference', // Yoink と同じく元ファイルを参照
  shelfRemoveAfterDragOut: true,
  shelfStackMultiple: true,
  shelfQuickLookThumbnails: true,
  shelfResolveAliases: false,
  shelfFaviconsForWebloc: true,

  // --- その他の機能
  screenOcrEnabled: false,
  windowSnapEnabled: false,
  focusFollowMouse: { enabled: false, delayMs: 250 },
  keepAwake: { enabled: false, mode: 'system', followCapsLock: false },
  // Windows の「マウスを乗せたウィンドウをアクティブにする」設定を、
  // ON にする前の値。OFF に戻すときに復元する。
  xmouseOriginal: null,

  // --- アップデート確認
  updateCheckEnabled: true,
  skippedUpdateVersion: null,
  lastRunVersion: null,
  shortcuts: DEFAULT_SHORTCUTS
};

// Password managers that v1/v2 excluded by default.
const OLD_DEFAULT_EXCLUDED = ['1Password', 'Bitwarden', 'KeePass', 'LastPass', 'Dashlane', 'Enpass', 'Keychain Access', 'キーチェーンアクセス'];

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function getDeviceId() {
  fs.mkdirSync(userDataDir(), { recursive: true });
  const file = deviceIdFile();
  try {
    const id = fs.readFileSync(file, 'utf8').trim();
    if (id) return id;
  } catch {
    /* first run */
  }
  const id = crypto.randomUUID();
  fs.writeFileSync(file, id, 'utf8');
  return id;
}

// Accepts whatever is on disk (possibly written by an older build) and
// returns a complete, current-shape settings object.
function normalize(parsed) {
  const raw = parsed && typeof parsed === 'object' ? parsed : {};
  const s = { ...clone(DEFAULTS), ...raw };
  const rawShortcuts = { ...(raw.shortcuts || {}) };
  s.focusFollowMouse = { ...DEFAULTS.focusFollowMouse, ...(raw.focusFollowMouse || {}) };
  s.keepAwake = { ...DEFAULTS.keepAwake, ...(raw.keepAwake || {}) };
  const from = Number(raw.version) || (Object.keys(raw).length ? 1 : DEFAULTS.version);

  // v1 → v2
  if (typeof raw.keepAwakeEnabled === 'boolean' && !raw.keepAwake) s.keepAwake.enabled = raw.keepAwakeEnabled;
  if (typeof raw.shelfAutoHide === 'boolean' && raw.shelfAutoCollapse === undefined) s.shelfAutoCollapse = raw.shelfAutoHide;
  if (/^capslock$/i.test(rawShortcuts.toggleKeepAwake || '')) {
    rawShortcuts.toggleKeepAwake = '';
    s.keepAwake.followCapsLock = true;
  }

  // v2 → v3 (Paste / Yoink と同じ操作体系へ)
  if (from < 3) {
    if (rawShortcuts.toggleHistory !== undefined && rawShortcuts.togglePanel === undefined) {
      rawShortcuts.togglePanel = rawShortcuts.toggleHistory;
    }
    // 以前の初期値（⌘⇧Y）のままなら Yoink と同じ初期値に揃える
    if (rawShortcuts.toggleShelf === `${CMD}+Shift+Y`) delete rawShortcuts.toggleShelf;
    // パスワード系のコピーも記録する（社内の方針変更）
    s.ignoreConfidential = false;
    s.ignoredApps = Array.isArray(raw.excludedApps)
      ? raw.excludedApps.filter((a) => !OLD_DEFAULT_EXCLUDED.includes(a))
      : [];
    if (raw.shelfEdge === 'right' || raw.shelfEdge === 'left') s.shelfPosition = `${raw.shelfEdge}-center`;
    if (typeof raw.shelfEnabled === 'boolean') s.shelfEnabled = raw.shelfEnabled;
    // Older versions kept a number of items, not a period: don't delete
    // anything on upgrade (the period can be chosen in the settings).
    if (Object.keys(raw).length && raw.historyRetention === undefined) s.historyRetention = 'forever';
  }
  for (const k of ['toggleHistory']) delete rawShortcuts[k];
  s.shortcuts = { ...DEFAULT_SHORTCUTS };
  for (const [k, v] of Object.entries(rawShortcuts)) {
    if (k in DEFAULT_SHORTCUTS && typeof v === 'string') s.shortcuts[k] = v;
  }
  for (const k of ['keepAwakeEnabled', 'shelfAutoHide', 'shelfAutoCollapse', 'shelfEdge', 'excludedApps',
    'skipSensitive', 'historyLimit', 'closeAfterClickCopy', 'mainBounds']) {
    delete s[k];
  }

  for (const [k, values] of Object.entries(ENUMS)) {
    if (!values.includes(s[k])) s[k] = DEFAULTS[k];
  }
  for (const k of ['ignoredApps', 'shelfIgnoredApps']) {
    s[k] = Array.isArray(s[k]) ? s[k].map((x) => String(x).trim()).filter(Boolean).slice(0, 200) : [];
  }
  for (const k of ['launchAtLogin', 'showMenuBarIcon', 'soundEffects', 'captureEnabled', 'alwaysPlainText', 'recordSourceApp',
    'ocrEnabled', 'ignoreTransient', 'ignoreConfidential', 'linkPreviews', 'showDuringScreenSharing', 'shelfEnabled',
    'shelfRemoveAfterDragOut', 'shelfStackMultiple', 'shelfQuickLookThumbnails', 'shelfResolveAliases',
    'shelfFaviconsForWebloc', 'screenOcrEnabled', 'windowSnapEnabled', 'firstRunCompleted']) {
    s[k] = typeof s[k] === 'boolean' ? s[k] : DEFAULTS[k];
  }
  if (!Number.isFinite(s.pausedUntil)) s.pausedUntil = null;
  if (!Number.isFinite(s.panelHeight)) s.panelHeight = null;
  else s.panelHeight = Math.max(120, Math.min(900, Math.round(s.panelHeight)));
  const pos = s.shelfCustomPosition;
  s.shelfCustomPosition = pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) ? { x: Math.round(pos.x), y: Math.round(pos.y) } : null;
  s.focusFollowMouse.delayMs = Math.max(0, Math.min(3000, Number(s.focusFollowMouse.delayMs) || 0));
  if (!['system', 'display'].includes(s.keepAwake.mode)) s.keepAwake.mode = 'system';
  if (typeof s.skippedUpdateVersion !== 'string' || !s.skippedUpdateVersion) s.skippedUpdateVersion = null;
  if (typeof s.lastRunVersion !== 'string' || !s.lastRunVersion) s.lastRunVersion = null;
  s.updateCheckEnabled = s.updateCheckEnabled !== false;
  s.version = DEFAULTS.version;
  return s;
}

// Deep-merges a partial update coming from the settings screen.
function merge(current, patch) {
  const next = { ...current, ...patch };
  for (const key of ['shortcuts', 'focusFollowMouse', 'keepAwake']) {
    if (patch && patch[key]) next[key] = { ...current[key], ...patch[key] };
  }
  return normalize(next);
}

function load() {
  fs.mkdirSync(userDataDir(), { recursive: true });
  try {
    return normalize(JSON.parse(fs.readFileSync(settingsFile(), 'utf8')));
  } catch {
    return normalize({});
  }
}

function save(settings) {
  fs.mkdirSync(userDataDir(), { recursive: true });
  const file = settingsFile();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

module.exports = { DEFAULTS, DEFAULT_SHORTCUTS, LOCAL_SHORTCUTS, ENUMS, RETENTION_MS, normalize, merge, load, save, getDeviceId };
