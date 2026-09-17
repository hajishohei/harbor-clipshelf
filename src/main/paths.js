'use strict';
const path = require('path');
const fs = require('fs');

// `electron` resolves to a plain string outside Electron (unit tests), so
// only touch `app` lazily.
function app() {
  return require('electron').app;
}

const userDataDir = () => app().getPath('userData');
const settingsFile = () => path.join(userDataDir(), 'settings.json');
const deviceIdFile = () => path.join(userDataDir(), 'device-id');
const logsDir = () => path.join(userDataDir(), 'logs');
const ocrLangDir = () => path.join(userDataDir(), 'ocr-lang');
const ocrCacheDir = () => path.join(userDataDir(), 'ocr-cache');
const dragStagingDir = () => path.join(userDataDir(), 'drag-staging');
const exportDir = () => path.join(userDataDir(), 'exported');
const localDataDir = () => path.join(userDataDir(), 'local-data');

const SYNC_SUBDIR = 'HarboR-ClipShelf-Data';

function syncDataDir(syncFolder) {
  return path.join(syncFolder, SYNC_SUBDIR);
}

function isSyncFolderAvailable(settings) {
  return !!(settings && settings.syncFolder && fs.existsSync(settings.syncFolder));
}

// Where items/ and blobs/ live. `settings.dataDirOverride` exists for tests.
function dataDir(settings) {
  if (settings && settings.dataDirOverride) return settings.dataDirOverride;
  if (isSyncFolderAvailable(settings)) return syncDataDir(settings.syncFolder);
  return localDataDir();
}

const itemsDir = (settings) => path.join(dataDir(settings), 'items');
const blobsDir = (settings) => path.join(dataDir(settings), 'blobs');

// Never (re)create a sync folder that has gone away (unmounted drive, Drive
// app quit…): that would leave a stray local folder that looks like the real one.
function assertSyncRoot(settings) {
  if (!settings || !settings.syncFolder) return;
  const root = dataDir(settings);
  if (path.resolve(root) === path.resolve(syncDataDir(settings.syncFolder)) && !fs.existsSync(settings.syncFolder)) {
    throw Object.assign(new Error('sync folder is not available'), { code: 'SYNC_MISSING' });
  }
}

function ensureDirs(settings) {
  assertSyncRoot(settings);
  for (const dir of [dataDir(settings), itemsDir(settings), blobsDir(settings)]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

module.exports = {
  userDataDir, settingsFile, deviceIdFile, logsDir, ocrLangDir, ocrCacheDir,
  dragStagingDir, exportDir, localDataDir, syncDataDir, isSyncFolderAvailable,
  dataDir, itemsDir, blobsDir, ensureDirs, assertSyncRoot, SYNC_SUBDIR
};
