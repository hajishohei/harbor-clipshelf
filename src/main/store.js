'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const chokidar = require('chokidar');
const { itemsDir, blobsDir, ensureDirs, dataDir, localDataDir } = require('./paths');
const blobs = require('./blobs');

const ITEM_FILE = /^[0-9a-f-]{36}\.json$/;
const TOMBSTONE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const ORPHAN_BLOB_GRACE_MS = 2 * 24 * 60 * 60 * 1000;
// The pinboard every older "pin" item belongs to. Fixed id so two devices
// creating it at the same time converge on one pinboard.
const DEFAULT_PINBOARD_ID = 'b0a1d000-0000-4000-8000-000000000001';
const PINBOARD_COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'gray'];

/**
 * Persists every history / shelf / pin entry as its own small JSON file
 * (<dataDir>/items/<id>.json) plus content-addressed blobs
 * (<dataDir>/blobs/<sha256>.<ext>).
 *
 * One file per item keeps cloud-sync clients (Google Drive, Dropbox,
 * iCloud Drive) happy: two devices only conflict when they edit the very
 * same item, and that is resolved last-write-wins on `updatedAt`.
 *
 * Timestamps: `updatedAt` changes on every write (it drives sync),
 * `usedAt` only when the user actually copies/uses the item (it drives
 * the list order).
 */
class ItemStore extends EventEmitter {
  constructor(settings, { deviceId = 'unknown', log = console } = {}) {
    super();
    this.settings = settings;
    this.deviceId = deviceId;
    this.log = log;
    this.items = new Map();
    this.historyByHash = new Map();
    this.watcher = null;
    this.unwritten = new Map(); // items that could not be written (sync folder missing)
  }

  // ---------- lifecycle ----------

  start() {
    // Pin the folder for this session: if the sync folder disappears later,
    // dataDir() must not silently start pointing at the local folder while
    // our watcher and in-memory items still belong to the old one.
    this.settings = { ...this.settings, dataDirOverride: dataDir(this.settings) };
    try {
      ensureDirs(this.settings);
    } catch (err) {
      if (err.code !== 'SYNC_MISSING') throw err;
      this.settings = { ...this.settings, dataDirOverride: localDataDir() };
      ensureDirs(this.settings);
    }
    this._load();
    this._watch();
  }

  async stop() {
    if (this.watcher) {
      const w = this.watcher;
      this.watcher = null;
      await w.close();
    }
  }

  async reconfigure(settings) {
    await this.stop();
    this.settings = settings;
    this.items.clear();
    this.historyByHash.clear();
    this.start();
    // Items captured while the old folder was unreachable go to the new one.
    const pending = [...this.unwritten.values()];
    this.unwritten.clear();
    for (const item of pending) {
      const existing = this.items.get(item.id);
      if (existing && existing.updatedAt >= item.updatedAt) continue;
      this._set(item);
      this._write(item);
    }
    this.emit('reset');
  }

  get dataDir() {
    return path.dirname(itemsDir(this.settings));
  }

  // ---------- reading ----------

  _load() {
    const dir = itemsDir(this.settings);
    for (const name of fs.readdirSync(dir)) {
      if (!ITEM_FILE.test(name)) continue;
      const item = this._readFile(path.join(dir, name));
      if (item) this._set(item);
    }
  }

  _readFile(file) {
    try {
      const item = JSON.parse(fs.readFileSync(file, 'utf8'));
      return item && typeof item.id === 'string' ? item : null;
    } catch {
      return null; // partially synced / corrupt: picked up again on next change
    }
  }

  _watch() {
    const dir = itemsDir(this.settings);
    this.watcher = chokidar.watch(dir, {
      ignoreInitial: true,
      depth: 0,
      ignored: (p, stats) => !!stats && stats.isFile() && !ITEM_FILE.test(path.basename(p)),
      awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 }
    });
    const onUpsert = (p) => {
      if (!ITEM_FILE.test(path.basename(p))) return;
      const incoming = this._readFile(p);
      if (!incoming) return;
      const existing = this.items.get(incoming.id);
      // Strictly newer only: our own writes come back through the watcher
      // with an identical updatedAt and must not be re-emitted.
      if (existing && !(incoming.updatedAt > existing.updatedAt)) return;
      this._set(incoming);
      this.emit('changed', incoming, { external: true });
    };
    this.watcher.on('add', onUpsert);
    this.watcher.on('change', onUpsert);
    this.watcher.on('unlink', (p) => {
      const name = path.basename(p);
      if (!ITEM_FILE.test(name)) return;
      const id = name.slice(0, -5);
      const existing = this.items.get(id);
      if (!existing) return;
      this._unset(existing);
      this.emit('removed', id, { external: true });
    });
    this.watcher.on('error', (err) => this.log.warn('[store] watcher error', err && err.message));
  }

  _set(item) {
    const prev = this.items.get(item.id);
    if (prev) this._unindex(prev);
    this.items.set(item.id, item);
    this._index(item);
  }

  _unset(item) {
    this._unindex(item);
    this.items.delete(item.id);
  }

  _index(item) {
    if (item.board === 'history' && item.hash && !item.deleted) {
      const current = this.historyByHash.get(item.hash);
      const other = current && this.items.get(current);
      // keep the most recently used item if two devices captured the same thing
      if (!other || other.deleted || (item.usedAt || 0) >= (other.usedAt || 0)) {
        this.historyByHash.set(item.hash, item.id);
      }
    }
  }

  _unindex(item) {
    if (item.hash && this.historyByHash.get(item.hash) === item.id) this.historyByHash.delete(item.hash);
  }

  get(id) {
    const item = this.items.get(id);
    return item && !item.deleted ? item : null;
  }

  list(board, { pinboardId = null } = {}) {
    const out = [];
    for (const item of this.items.values()) {
      if (item.deleted) continue;
      if (board && item.board !== board) continue;
      if (board === 'pin' && pinboardId && (item.pinboardId || DEFAULT_PINBOARD_ID) !== pinboardId) continue;
      out.push(item);
    }
    if (board === 'pin' || board === 'meta') {
      // manual order (drag to reorder), newest first when unordered
      return out.sort((a, b) => orderOf(a) - orderOf(b) || (b.createdAt || 0) - (a.createdAt || 0));
    }
    return out.sort((a, b) => (b.usedAt || b.updatedAt || 0) - (a.usedAt || a.updatedAt || 0));
  }

  // ---------- pinboards ----------

  pinboards() {
    return this.list('meta').filter((m) => m.type === 'pinboard');
  }

  ensureDefaultPinboard() {
    const existing = this.items.get(DEFAULT_PINBOARD_ID);
    if (existing) return existing.deleted ? null : existing;
    const item = {
      ...this._blank(),
      id: DEFAULT_PINBOARD_ID,
      board: 'meta',
      type: 'pinboard',
      name: 'ピン留め',
      color: 'blue',
      order: 0,
      createdAt: 0,
      updatedAt: 1,
      usedAt: 0
    };
    this._set(item);
    this._write(item);
    this.emit('changed', item, { external: false, created: true });
    return item;
  }

  createPinboard({ name, color }) {
    const boards = this.pinboards();
    return this.create({
      board: 'meta',
      type: 'pinboard',
      name: String(name || '').trim().slice(0, 60) || '新しいピンボード',
      color: PINBOARD_COLORS.includes(color) ? color : PINBOARD_COLORS[boards.length % PINBOARD_COLORS.length],
      order: boards.length ? Math.max(...boards.map(orderOf).filter(Number.isFinite)) + 1 : 0
    });
  }

  deletePinboard(id) {
    const board = this.get(id);
    if (!board || board.type !== 'pinboard') return false;
    for (const item of this.list('pin', { pinboardId: id })) this.remove(item.id);
    return this.remove(id);
  }

  // ids in their new order (pin items of one pinboard, or pinboards)
  reorder(ids) {
    ids.forEach((id, i) => {
      const it = this.get(id);
      if (it && it.order !== i) this.update(id, { order: i });
    });
  }

  count(board) {
    let n = 0;
    for (const item of this.items.values()) if (!item.deleted && (!board || item.board === board)) n++;
    return n;
  }

  findHistoryByHash(hash) {
    const id = this.historyByHash.get(hash);
    return id ? this.get(id) : null;
  }

  // ---------- writing ----------

  _file(id) {
    return path.join(itemsDir(this.settings), `${id}.json`);
  }

  _write(item) {
    try {
      ensureDirs(this.settings);
    } catch (err) {
      if (err.code !== 'SYNC_MISSING') throw err;
      this.log.warn('[store] sync folder missing; item kept in memory for now', item.id);
      this.unwritten.set(item.id, item);
      this.emit('sync-missing');
      return;
    }
    this.unwritten.delete(item.id);
    const file = this._file(item.id);
    const tmp = path.join(path.dirname(file), `.${item.id}.${process.pid}.tmp`);
    const json = JSON.stringify(item);
    try {
      fs.writeFileSync(tmp, json, 'utf8');
      fs.renameSync(tmp, file);
    } catch (err) {
      // Some sync clients briefly lock files on Windows; fall back to a direct write.
      try {
        fs.writeFileSync(file, json, 'utf8');
      } catch (err2) {
        this.log.error('[store] failed to write item', item.id, err2.message);
      }
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* already gone */
      }
    }
  }

  _now(prev) {
    // monotonic per item so last-write-wins always sees our edit as newer
    const now = Date.now();
    return prev && prev.updatedAt >= now ? prev.updatedAt + 1 : now;
  }

  _blank() {
    const now = Date.now();
    return {
      id: crypto.randomUUID(),
      board: 'history',
      type: 'text',
      text: null,
      html: null,
      rtf: null,
      hash: null,
      blob: null,
      imageSize: null,
      files: [],
      preview: '',
      label: null,
      sourceApp: null,
      sourceBundleId: null,
      ocrText: null,
      ocrPending: false,
      tags: [],
      createdAt: now,
      usedAt: now,
      updatedAt: now,
      deviceId: this.deviceId,
      deleted: false,
      deletedAt: null
    };
  }

  create(partial) {
    const now = Date.now();
    const item = {
      id: crypto.randomUUID(),
      board: 'history', // 'history' | 'shelf' | 'pin' | 'meta'
      type: 'text', // 'text' | 'url' | 'image' | 'file'
      text: null,
      html: null,
      rtf: null,
      hash: null,
      blob: null,
      imageSize: null,
      files: [], // [{ name, size, blob|null, path|null, isDir }]
      preview: '',
      label: null,
      sourceApp: null,
      sourceBundleId: null,
      ocrText: null,
      ocrPending: false,
      tags: [],
      createdAt: now,
      usedAt: now,
      updatedAt: now,
      deviceId: this.deviceId,
      deleted: false,
      deletedAt: null,
      ...partial
    };
    if (!Array.isArray(item.files)) item.files = [];
    if (!Array.isArray(item.tags)) item.tags = [];
    this._set(item);
    this._write(item);
    this.emit('changed', item, { external: false, created: true });
    return item;
  }

  update(id, patch = {}) {
    const existing = this.items.get(id);
    if (!existing || existing.deleted) return null;
    const { id: _ignore, createdAt: _c, deviceId: _d, ...safe } = patch;
    const updated = { ...existing, ...safe, id, updatedAt: this._now(existing) };
    this._set(updated);
    this._write(updated);
    this.emit('changed', updated, { external: false });
    return updated;
  }

  touch(id, patch = {}) {
    return this.update(id, { ...patch, usedAt: Date.now() });
  }

  // Brings back an item removed in this session (⌘Z). `snapshot` is the
  // item as it was before remove().
  restore(snapshot) {
    if (!snapshot || !snapshot.id) return null;
    const current = this.items.get(snapshot.id);
    if (current && !current.deleted) return current;
    const item = { ...snapshot, deleted: false, deletedAt: null, updatedAt: this._now(current) };
    this._set(item);
    this._write(item);
    this.emit('changed', item, { external: false, created: true });
    return item;
  }

  remove(id) {
    const existing = this.items.get(id);
    if (!existing || existing.deleted) return false;
    const now = this._now(existing);
    // Tombstone (not an unlink) so other devices learn about the deletion.
    const tombstone = {
      id,
      board: existing.board,
      hash: existing.hash,
      blob: null,
      files: [],
      deleted: true,
      deletedAt: now,
      createdAt: existing.createdAt,
      updatedAt: now,
      deviceId: existing.deviceId
    };
    this._set(tombstone);
    this._write(tombstone);
    this.emit('removed', id, { external: false });
    return true;
  }

  clearBoard(board) {
    let n = 0;
    for (const item of this.list(board)) if (this.remove(item.id)) n++;
    return n;
  }

  // Paste-style retention: history items not used within `maxAgeMs` go.
  // Pinned items and the shelf are never touched.
  trimHistory(maxAgeMs, now = Date.now()) {
    if (!Number.isFinite(maxAgeMs)) return 0;
    let removed = 0;
    for (const item of this.list('history')) {
      if (now - (item.usedAt || item.createdAt || 0) > maxAgeMs && this.remove(item.id)) removed++;
    }
    return removed;
  }

  // How many history items a shorter retention would delete (for the
  // confirmation Paste shows when you lower the limit).
  countOlderThan(maxAgeMs, now = Date.now()) {
    if (!Number.isFinite(maxAgeMs)) return 0;
    return this.list('history').filter((i) => now - (i.usedAt || i.createdAt || 0) > maxAgeMs).length;
  }

  // Housekeeping: purge old tombstones, enforce the history cap and delete
  // blobs no live item references anymore.
  prune(historyMaxAgeMs, now = Date.now()) {
    this.trimHistory(historyMaxAgeMs, now);
    for (const item of [...this.items.values()]) {
      if (item.deleted && now - (item.deletedAt || 0) > TOMBSTONE_TTL_MS) {
        this._unset(item);
        try {
          fs.unlinkSync(this._file(item.id));
        } catch {
          /* already gone */
        }
      }
    }
    const referenced = new Set();
    for (const item of this.items.values()) {
      if (item.deleted) continue;
      if (item.blob) referenced.add(item.blob);
      if (item.linkImage) referenced.add(item.linkImage);
      for (const f of item.files || []) if (f && f.blob) referenced.add(f.blob);
    }
    let removedBlobs = 0;
    for (const name of blobs.listBlobs(this.settings)) {
      if (referenced.has(name)) continue;
      try {
        const st = fs.statSync(path.join(blobsDir(this.settings), name));
        // grace period: the item that references it may still be syncing in
        if (now - st.mtimeMs > ORPHAN_BLOB_GRACE_MS && blobs.removeBlob(this.settings, name)) removedBlobs++;
      } catch {
        /* vanished meanwhile */
      }
    }
    return { removedBlobs };
  }

  // Copies items/blobs from another data dir into the current one (used
  // when the user turns sync on or off, so nothing "disappears").
  importFrom(otherDataDir) {
    const srcItems = path.join(otherDataDir, 'items');
    const srcBlobs = path.join(otherDataDir, 'blobs');
    let imported = 0;
    ensureDirs(this.settings);
    if (fs.existsSync(srcBlobs)) {
      for (const name of fs.readdirSync(srcBlobs)) {
        if (!/^[a-f0-9]{64}(\.[a-z0-9]{1,10})?$/.test(name)) continue;
        const dest = path.join(blobsDir(this.settings), name);
        if (!fs.existsSync(dest)) {
          try {
            fs.copyFileSync(path.join(srcBlobs, name), dest);
          } catch (err) {
            this.log.warn('[store] blob import failed', name, err.message);
          }
        }
      }
    }
    if (fs.existsSync(srcItems)) {
      for (const name of fs.readdirSync(srcItems)) {
        if (!ITEM_FILE.test(name)) continue;
        const incoming = this._readFile(path.join(srcItems, name));
        if (!incoming) continue;
        const existing = this.items.get(incoming.id);
        if (existing && existing.updatedAt >= incoming.updatedAt) continue;
        this._set(incoming);
        this._write(incoming);
        imported++;
      }
    }
    if (imported) this.emit('reset');
    return imported;
  }
}

function orderOf(item) {
  return Number.isFinite(item.order) ? item.order : -1;
}

module.exports = { ItemStore, TOMBSTONE_TTL_MS, ORPHAN_BLOB_GRACE_MS, DEFAULT_PINBOARD_ID, PINBOARD_COLORS };
