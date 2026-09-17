'use strict';
const fs = require('fs');
const path = require('path');
const { app, nativeImage, shell, clipboard } = require('electron');
const blobs = require('./blobs');
const { resolveFilePaths, safeName, prestage, stageText } = require('./fileResolver');
const { previewOf, isUrl } = require('../shared/text');

const MAX_COPY_BYTES = 512 * 1024 * 1024; // bigger files are always referenced

// Items go to renderers without the heavy rich-text payloads.
function lite(item) {
  if (!item) return null;
  const { html, rtf, ...rest } = item;
  return { ...rest, hasRich: !!(html || rtf) };
}

function withoutIdentity(src) {
  const { id: _i, createdAt: _c, updatedAt: _u, usedAt: _us, deviceId: _d, board: _b, hash: _h, order: _o, pinboardId: _p, locked: _l, ...rest } = src;
  return rest;
}

class ItemOps {
  constructor({ store, getSettings, log }) {
    this.store = store;
    this.getSettings = getSettings;
    this.log = log;
    this.thumbCache = new Map();
    this.recentlyRemoved = []; // shelf items, newest last (Yoink "restore")
    this.undo = []; // panel deletions (⌘Z)
  }

  get settings() {
    return this.store.settings;
  }

  // ---------------------------------------------------------------- files
  async _fileEntry(p, { copy }) {
    const st = await fs.promises.stat(p);
    const entry = { name: path.basename(p) || p, path: p, isDir: st.isDirectory(), size: st.isDirectory() ? null : st.size, blob: null };
    if (copy && !entry.isDir && st.size <= MAX_COPY_BYTES) {
      try {
        entry.blob = await blobs.saveBlobFromFileAsync(this.settings, p);
      } catch (err) {
        this.log.warn('[items] copy failed', p, err.message);
      }
    }
    return entry;
  }

  async resolveAlias(p) {
    if (!this.getSettings().shelfResolveAliases) return p;
    try {
      if (process.platform === 'win32' && /\.lnk$/i.test(p)) {
        const target = shell.readShortcutLink(p).target;
        return target && fs.existsSync(target) ? target : p;
      }
      const real = await fs.promises.realpath(p); // symlinks (Finder aliases are not resolvable without native code)
      return real || p;
    } catch {
      return p;
    }
  }

  // Yoink: one drop of several files → one stack (if enabled)
  async addPathsToShelf(list) {
    const s = this.getSettings();
    const copy = s.shelfFileMode === 'copy';
    const entries = [];
    for (const raw of list) {
      if (typeof raw !== 'string' || !path.isAbsolute(raw)) continue;
      if (this.isActiveShelfDragPath && this.isActiveShelfDragPath(raw)) continue; // dropped back onto the shelf
      try {
        entries.push(await this._fileEntry(await this.resolveAlias(raw), { copy }));
      } catch (err) {
        this.log.warn('[shelf] cannot add', raw, err.message);
      }
    }
    if (!entries.length) return [];
    const groups = s.shelfStackMultiple ? [entries] : entries.map((e) => [e]);
    const created = [];
    for (const files of groups) {
      const item = this.store.create({
        board: 'shelf',
        type: 'file',
        files,
        preview: files.length > 1 ? `${files.length} ファイル` : files[0].name + (files[0].isDir ? '/' : '')
      });
      if (copy) prestage(this.settings, item).catch(() => {});
      created.push(item);
    }
    return created.map(lite);
  }

  addTextToShelf(text) {
    if (typeof text !== 'string' || !text.trim()) return null;
    return lite(this.store.create({ board: 'shelf', type: isUrl(text) ? 'url' : 'text', text, preview: previewOf(text) }));
  }

  addBytesToShelf({ name, bytes, mime }) {
    const buf = Buffer.from(bytes);
    const fileName = safeName(name || 'dropped');
    if (/^image\//.test(mime || '')) {
      const img = nativeImage.createFromBuffer(buf);
      if (!img.isEmpty()) {
        const blob = blobs.saveBlob(this.settings, img.toPNG(), '.png');
        return lite(this.store.create({ board: 'shelf', type: 'image', blob, imageSize: img.getSize(), preview: fileName, label: fileName }));
      }
    }
    const blob = blobs.saveBlob(this.settings, buf, path.extname(fileName));
    return lite(this.store.create({
      board: 'shelf',
      type: 'file',
      files: [{ name: fileName, size: buf.length, isDir: false, path: null, blob }],
      preview: fileName
    }));
  }

  // Yoink: "Add Clipboard Contents" (double-press the shortcut)
  async addClipboardToShelf() {
    const io = require('./clipboardIO');
    const snap = await io.readSnapshot();
    if (snap.kind === 'files') return this.addPathsToShelf(snap.files);
    if (snap.kind === 'text') return [this.addTextToShelf(snap.text)];
    if (snap.kind === 'image') {
      const blob = blobs.saveBlob(this.settings, snap.png, '.png');
      return [lite(this.store.create({ board: 'shelf', type: 'image', blob, imageSize: snap.imageSize, preview: `画像 ${snap.imageSize.width}×${snap.imageSize.height}` }))];
    }
    return [];
  }

  // History / pins / shelf → another board. Files are copied into the blob
  // store for pins (they sync); the shelf follows its own file setting.
  async copyToBoard(id, board, { pinboardId = null } = {}) {
    const src = this.store.get(id);
    if (!src || !['shelf', 'pin'].includes(board)) return null;
    const rest = withoutIdentity(src);
    const copy = board === 'pin' || this.getSettings().shelfFileMode === 'copy';
    if (src.type === 'file') {
      rest.files = await Promise.all(
        (src.files || []).map(async (f) => {
          if (f.blob || f.isDir || !f.path || !copy) return { ...f };
          try {
            return await this._fileEntry(f.path, { copy: true });
          } catch {
            return { ...f };
          }
        })
      );
    }
    const extra = board === 'pin' ? { pinboardId: pinboardId || require('./store').DEFAULT_PINBOARD_ID, order: -Date.now() } : {};
    const created = this.store.create({ ...rest, board, ...extra });
    if (created.type === 'file') prestage(this.settings, created).catch(() => {});
    return lite(created);
  }

  duplicate(id) {
    const src = this.store.get(id);
    if (!src) return null;
    const rest = withoutIdentity(src);
    const board = src.board === 'history' ? 'history' : src.board;
    const extra = src.board === 'pin' ? { pinboardId: src.pinboardId, order: (src.order || 0) + 0.5 } : {};
    return lite(this.store.create({ ...rest, board, ...extra, label: src.label }));
  }

  // ---------------------------------------------------------------- removal / undo
  remove(ids, { source = 'panel' } = {}) {
    const removed = [];
    for (const id of ids) {
      const item = this.store.get(id);
      if (item && this.store.remove(id)) removed.push(item);
    }
    if (!removed.length) return 0;
    if (source === 'shelf') {
      const at = Date.now();
      this.recentlyRemoved.push(...removed.map((item) => ({ item, at })));
      this.recentlyRemoved = this.recentlyRemoved.slice(-50);
    } else {
      this.undo.push(removed);
      this.undo = this.undo.slice(-20);
    }
    return removed.length;
  }

  undoRemove() {
    const batch = this.undo.pop();
    if (!batch) return 0;
    for (const item of batch) this.store.restore(item);
    return batch.length;
  }

  // Yoink: long-press the shortcut / "最後に削除したファイルを戻す"
  restoreRecentlyRemoved() {
    if (!this.recentlyRemoved.length) return 0;
    const last = this.recentlyRemoved.pop();
    const batch = [last];
    // things removed together (within a second) come back together
    while (this.recentlyRemoved.length && last.at - this.recentlyRemoved[this.recentlyRemoved.length - 1].at < 1000) {
      batch.push(this.recentlyRemoved.pop());
    }
    for (const { item } of batch) this.store.restore(item);
    return batch.length;
  }

  // ---------------------------------------------------------------- stacks
  splitStack(id) {
    const item = this.store.get(id);
    if (!item || item.type !== 'file' || (item.files || []).length < 2) return 0;
    for (const f of item.files.slice().reverse()) {
      this.store.create({ board: item.board, type: 'file', files: [f], preview: f.name + (f.isDir ? '/' : ''), locked: item.locked });
    }
    this.store.remove(id);
    return item.files.length;
  }

  mergeToStack(ids) {
    const items = ids.map((id) => this.store.get(id)).filter((i) => i && i.board === 'shelf' && i.type === 'file');
    if (items.length < 2) return null;
    const files = items.flatMap((i) => i.files || []);
    const created = this.store.create({ board: 'shelf', type: 'file', files, preview: `${files.length} ファイル` });
    for (const i of items) this.store.remove(i.id);
    return lite(created);
  }

  // ---------------------------------------------------------------- drag-out
  // Paths to hand to the OS for these items.
  dragPaths(items, { source }) {
    const s = this.getSettings();
    const out = [];
    for (const item of items) {
      if (item.type === 'image' && item.blob) {
        const base = safeName(item.label || (item.preview || '').replace(/^画像\s*/, 'image-')).replace(/\.[a-z0-9]+$/i, '').slice(0, 60) || 'image';
        out.push(...resolveFilePaths(this.settings, { files: [{ name: `${base}.png`, blob: item.blob }] }));
      } else if (item.type === 'file') {
        const reference = source === 'shelf' && s.shelfFileMode === 'reference';
        const originals = (item.files || []).filter((f) => f.path && fs.existsSync(f.path));
        if (reference && originals.length) out.push(...originals.map((f) => f.path));
        else out.push(...resolveFilePaths(this.settings, item, { purpose: 'drag' }));
      } else if (item.type === 'text' || item.type === 'url') {
        out.push(stageText(item));
      }
    }
    return out.filter(Boolean);
  }

  async dragIcon(items) {
    const first = items[0];
    let icon = null;
    try {
      if (first && first.type === 'image' && first.blob) {
        icon = nativeImage.createFromBuffer(blobs.readBlob(this.settings, first.blob)).resize({ width: 96 });
      } else if (first && first.type === 'file') {
        const thumb = await this.thumbnail(first.id, 128);
        if (thumb) icon = nativeImage.createFromDataURL(thumb);
      }
    } catch {
      icon = null;
    }
    if (!icon || icon.isEmpty()) icon = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'icon-256.png')).resize({ width: 64 });
    return icon;
  }

  // ---------------------------------------------------------------- thumbnails
  async thumbnail(id, size = 320) {
    const item = this.store.get(id);
    if (!item) return null;
    const key = `${id}:${item.updatedAt}:${size}`;
    if (this.thumbCache.has(key)) return this.thumbCache.get(key);
    const put = (v) => {
      this.thumbCache.set(key, v);
      if (this.thumbCache.size > 500) this.thumbCache.delete(this.thumbCache.keys().next().value);
      return v;
    };
    try {
      const blobName = item.type === 'image' ? item.blob : item.type === 'url' ? item.linkImage : null;
      if (blobName) {
        const img = nativeImage.createFromBuffer(blobs.readBlob(this.settings, blobName));
        if (img.isEmpty()) return put(null);
        const { width, height } = img.getSize();
        const scale = Math.min(1, size / Math.max(width, height));
        const small = scale < 1 ? img.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: 'good' }) : img;
        return put(`data:image/png;base64,${small.toPNG().toString('base64')}`);
      }
      if (item.type === 'file' && item.files && item.files.length) {
        const f = item.files[0];
        let p = f.path && fs.existsSync(f.path) ? f.path : null;
        if (!p && f.blob && (f.size || 0) < 64 * 1024 * 1024) p = resolveFilePaths(this.settings, { files: [f] })[0] || null;
        if (!p) return put(null);
        let img = null;
        const quickLook = item.board !== 'shelf' || this.getSettings().shelfQuickLookThumbnails;
        if (quickLook && process.platform !== 'linux' && !f.isDir) {
          try {
            img = await nativeImage.createThumbnailFromPath(p, { width: size, height: size });
          } catch {
            img = null;
          }
        }
        if (!img || img.isEmpty()) img = await app.getFileIcon(p, { size: 'large' });
        return put(img && !img.isEmpty() ? img.toDataURL() : null);
      }
    } catch (err) {
      this.log.warn('[thumb] failed', id, err.message);
    }
    return put(null);
  }

  // Missing originals (moved / deleted since they were put on the shelf)
  fileStatus(ids) {
    const out = {};
    for (const id of ids) {
      const item = this.store.get(id);
      if (!item || item.type !== 'file') continue;
      out[id] = (item.files || []).map((f) => {
        if (f.blob && blobs.blobExists(this.settings, f.blob)) return f.path && fs.existsSync(f.path) ? 'ok' : 'copy';
        if (!f.path) return 'missing';
        if (!fs.existsSync(f.path)) return 'missing';
        return /[\\/]\.Trash[\\/]|\$Recycle\.Bin/i.test(f.path) ? 'trash' : 'ok';
      });
    }
    return out;
  }

  // ---------------------------------------------------------------- file actions
  originalPaths(item) {
    return (item.files || []).map((f) => (f.path && fs.existsSync(f.path) ? f.path : null)).filter(Boolean);
  }

  reveal(item) {
    const target = this.originalPaths(item)[0] || this.dragPaths([item], { source: 'panel' })[0];
    if (target) shell.showItemInFolder(target);
    return !!target;
  }

  open(item) {
    if (item.type === 'url') {
      let url = String(item.text || '').trim();
      if (/^www\./i.test(url)) url = `https://${url}`;
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return true;
    }
    const target = item.type === 'file' ? this.originalPaths(item)[0] || this.dragPaths([item], { source: 'panel' })[0] : this.dragPaths([item], { source: 'panel' })[0];
    if (target) shell.openPath(target);
    return !!target;
  }

  copyPaths(items) {
    const list = items.flatMap((i) => this.originalPaths(i));
    if (list.length) clipboard.writeText(list.join('\n'));
    return list.length;
  }

  // Yoink: 移動… / コピー… (to a chosen folder)
  async transfer(item, folder, { move }) {
    const out = [];
    const files = [];
    for (const f of item.files || []) {
      const src = f.path && fs.existsSync(f.path) ? f.path : resolveFilePaths(this.settings, { files: [f] })[0];
      if (!src) {
        files.push(f);
        continue;
      }
      let dest = path.join(folder, path.basename(f.name || src));
      for (let i = 2; fs.existsSync(dest); i++) {
        const ext = path.extname(f.name || src);
        dest = path.join(folder, `${path.basename(f.name || src, ext)} ${i}${ext}`);
      }
      if (move && f.path && fs.existsSync(f.path)) {
        try {
          await fs.promises.rename(f.path, dest);
        } catch (err) {
          if (err.code !== 'EXDEV') throw err;
          await fs.promises.cp(f.path, dest, { recursive: true });
          await fs.promises.rm(f.path, { recursive: true, force: true });
        }
      } else {
        await fs.promises.cp(src, dest, { recursive: true });
      }
      out.push(dest);
      files.push({ ...f, path: dest, name: path.basename(dest) });
    }
    if (move) this.store.update(item.id, { files });
    return out;
  }

  // Rename: app content → label; referenced files → the file itself.
  async rename(item, name) {
    const clean = safeName(String(name || '').trim()).slice(0, 200);
    if (!clean) return null;
    if (item.type === 'file' && item.files.length === 1 && item.files[0].path && fs.existsSync(item.files[0].path) && item.board === 'shelf') {
      const f = item.files[0];
      const dest = path.join(path.dirname(f.path), clean);
      if (dest !== f.path) {
        if (fs.existsSync(dest)) throw new Error('exists');
        await fs.promises.rename(f.path, dest);
      }
      return lite(this.store.update(item.id, { files: [{ ...f, path: dest, name: clean }], preview: clean, label: null }));
    }
    return lite(this.store.update(item.id, { label: String(name).trim().slice(0, 120) || null }));
  }
}

module.exports = { ItemOps, lite, withoutIdentity };
