'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args);
const send = (channel, ...args) => ipcRenderer.send(channel, ...args);

function subscribe(channel) {
  return (cb) => {
    const listener = (_e, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  };
}

contextBridge.exposeInMainWorld('clipshelf', {
  platform: process.platform,

  // app
  appInfo: () => invoke('app:info'),
  openFolder: (kind) => invoke('app:openFolder', kind),
  openSettings: (section) => invoke('app:openSettings', section),
  quit: () => invoke('app:quit'),
  about: () => invoke('app:about'),

  // items (history / pinboards / shelf)
  listItems: (board, opts) => invoke('items:list', board, opts),
  getItem: (id) => invoke('items:get', id),
  updateItem: (id, patch) => invoke('items:update', id, patch),
  removeItems: (ids, source) => invoke('items:remove', ids, source),
  undoRemove: () => invoke('items:undo'),
  eraseHistory: () => invoke('items:eraseHistory'),
  retentionPreview: (value) => invoke('items:retentionPreview', value),
  pasteItems: (ids, opts) => invoke('items:paste', ids, opts),
  copyItems: (ids, opts) => invoke('items:copy', ids, opts),
  duplicateItem: (id) => invoke('items:duplicate', id),
  createText: (input) => invoke('items:createText', input),
  pinTo: (ids, pinboardId) => invoke('items:pinTo', ids, pinboardId),
  unpin: (ids) => invoke('items:unpin', ids),
  reorderItems: (ids) => invoke('items:reorder', ids),
  sendToShelf: (ids) => invoke('items:sendToShelf', ids),
  thumbnail: (id, size) => invoke('items:thumbnail', id, size),
  fileStatus: (ids) => invoke('items:fileStatus', ids),
  openItem: (id) => invoke('items:open', id),
  revealItem: (id) => invoke('items:reveal', id),
  previewItem: (id, from, opts) => invoke('items:preview', id, from, opts || {}),
  runOcr: (id) => invoke('items:ocr', id),
  startDrag: (ids, source) => send('drag:start', ids, source),
  markShelfDrag: () => send('shelf:ownDrag'),

  // native menus → resolve to { action, args } | null
  itemMenu: (ids, where) => invoke('menu:item', ids, where),
  pinboardMenu: (id) => invoke('menu:pinboard', id),
  panelMenu: () => invoke('menu:panel'),
  shelfGearMenu: (selected) => invoke('menu:shelfGear', selected),
  chooseFolder: (title) => invoke('dialog:folder', title),
  confirm: (opts) => invoke('dialog:confirm', opts),
  chooseApp: () => invoke('dialog:chooseApp'),

  // pinboards
  listPinboards: () => invoke('pinboards:list'),
  createPinboard: (input) => invoke('pinboards:create', input),
  updatePinboard: (id, patch) => invoke('pinboards:update', id, patch),
  deletePinboard: (id) => invoke('pinboards:delete', id),
  reorderPinboards: (ids) => invoke('pinboards:reorder', ids),

  // panel
  hidePanel: (opts) => send('panel:hide', opts || {}),
  openPanel: () => invoke('panel:open'),
  resizePanel: (height) => send('panel:resize', height),
  setPanelModal: (open) => send('panel:modal', !!open),
  resetPanelHeight: () => invoke('panel:resetHeight'),
  onPanelShow: subscribe('panel:show'),
  onPanelHide: subscribe('panel:hide'),

  // shelf
  listShelf: () => invoke('shelf:list'),
  addPathsToShelf: (paths) => invoke('shelf:addPaths', paths),
  addTextToShelf: (text) => invoke('shelf:addText', text),
  addBytesToShelf: (input) => invoke('shelf:addBytes', input),
  addClipboardToShelf: () => invoke('shelf:addClipboard'),
  splitStack: (id) => invoke('shelf:split', id),
  mergeStack: (ids) => invoke('shelf:merge', ids),
  lockItems: (ids, locked) => invoke('shelf:lock', ids, locked),
  restoreShelf: () => invoke('shelf:restore'),
  wipeShelf: () => invoke('shelf:wipe'),
  hideShelf: () => invoke('shelf:hide'),
  transferItem: (id, move) => invoke('shelf:transfer', id, move),
  renameShelfItem: (id, name) => invoke('shelf:rename', id, name),
  copyPaths: (ids) => invoke('shelf:copyPaths', ids),
  setShelfPosition: (position) => invoke('shelf:setPosition', position),
  setShelfSize: (size) => invoke('shelf:setSize', size),
  resetShelfPosition: () => invoke('shelf:resetPosition'),
  expandShelf: () => send('shelf:expand'),
  setShelfBusy: (busy) => send('shelf:busy', !!busy),
  shelfActivity: () => send('shelf:activity'),
  onShelfState: subscribe('shelf:state'),
  onFileStatus: subscribe('shelf:fileStatus'),
  // Electron 32+ no longer exposes File.path; this is the supported way.
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },

  // paste stack
  stackState: () => invoke('stack:state'),
  toggleStack: () => invoke('stack:toggle'),
  closeStack: () => invoke('stack:close'),
  addToStack: (ids, index) => invoke('stack:add', ids, index),
  removeFromStack: (ids) => invoke('stack:remove', ids),
  reorderStack: (ids) => invoke('stack:reorder', ids),
  toggleStackOrder: () => invoke('stack:toggleOrder'),
  onStackState: subscribe('stack:state'),

  // preview window
  closePreview: () => send('preview:close'),
  importFromPaste: () => invoke('import:paste'),
  revealApp: () => invoke('system:revealApp'),
  quitConflictingApp: (bundleId) => invoke('system:quitConflictingApp', bundleId),
  onPreview: subscribe('preview:show'),

  // settings
  getSettings: () => invoke('settings:get'),
  setSettings: (patch) => invoke('settings:set', patch),
  resetShortcuts: () => invoke('settings:resetShortcuts'),
  chooseSyncFolder: () => invoke('settings:chooseSyncFolder'),
  syncInfo: () => invoke('settings:syncInfo'),
  shortcutStatus: () => invoke('shortcuts:status'),
  suspendShortcuts: () => invoke('shortcuts:suspend'),
  resumeShortcuts: () => invoke('shortcuts:resume'),
  checkShortcut: (accelerator) => invoke('shortcuts:check', accelerator),
  onSettingsSection: subscribe('settings:section'),
  onShortcutStatus: subscribe('shortcuts:status'),

  // pause
  pauseState: () => invoke('pause:state'),
  pause: (durationMs) => invoke('pause:set', durationMs),
  resume: () => invoke('pause:resume'),
  onPauseChanged: subscribe('pause:changed'),

  // system features
  systemStatus: () => invoke('system:status'),
  requestAccessibility: () => invoke('system:requestAccessibility'),
  openPrivacy: (kind) => invoke('system:openPrivacy', kind),
  probeAutomation: () => invoke('system:probeAutomation'),
  retryHelpers: () => invoke('system:retryHelpers'),
  testSnap: (action) => invoke('system:testSnap', action),
  getKeepAwake: () => invoke('keepAwake:get'),
  setKeepAwake: (input) => invoke('keepAwake:set', input),
  triggerScreenOcr: () => invoke('screenOcr:trigger'),
  primeScreenPermission: () => invoke('screenOcr:primePermission'),
  testHud: () => invoke('hud:test'),

  // updates
  updateState: () => invoke('update:state'),
  checkUpdate: () => invoke('update:check'),
  installUpdate: () => invoke('update:install'),
  openUpdatePage: (which) => invoke('update:openPage', which),
  skipUpdate: (version) => invoke('update:skip', version),

  // screen OCR overlay
  screenOcrInit: () => invoke('screen-ocr:init'),
  screenOcrSelected: (rect) => send('screen-ocr:selected', rect),
  screenOcrCancel: () => send('screen-ocr:cancel'),

  // events
  onItemsChanged: subscribe('items:changed'),
  onItemsRemoved: subscribe('items:removed'),
  onItemsReset: subscribe('items:reset'),
  onIconsChanged: subscribe('icons:changed'),
  onSettingsChanged: subscribe('settings:changed'),
  onKeepAwakeChanged: subscribe('keepAwake:changed'),
  onHud: subscribe('hud:show'),
  onSound: subscribe('hud:sound'),
  onUpdateState: subscribe('update:state')
});
