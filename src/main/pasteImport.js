'use strict';
/**
 * 「Paste から取り込む」: reads the local database of Paste (wiheads, macOS)
 * and copies its clipboard history and pinboards into ClipShelf.
 *
 * Paste keeps its data in a Core Data SQLite store inside its app group
 * container. The model (v5Paste) has ItemEntity / ItemDataEntity /
 * ListEntity / ApplicationEntity. Pasteboard contents are archived blobs,
 * so the decoder below accepts binary plists, NSKeyedArchiver archives and
 * JSON, and collects every "<type identifier> → data" pair it can find.
 * Nothing is sent anywhere; the store is copied to a temp folder and opened
 * read-only.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const bplist = require('bplist-parser');

const CORE_DATA_EPOCH_MS = 978307200000; // 2001-01-01
const MAX_ITEMS = 50000;
const MAX_WALK_NODES = 20000;
const UTI_RE = /^(public|com|org|net|dyn|io|jp|de|app|co)\.[\w.+-]+$/i;
const LEGACY_TYPES = new Set(['NSStringPboardType', 'NSFilenamesPboardType', 'NSURLPboardType', 'NSTIFFPboardType', 'NSPNGPboardType', 'NSHTMLPboardType', 'NSRTFPboardType', 'Apple PNG pasteboard type', 'Apple URL pasteboard type', 'CorePasteboardFlavorType 0x75726C20']);

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

// ------------------------------------------------------------------ locating
function candidateRoots(home = os.homedir()) {
  const lib = path.join(home, 'Library');
  const roots = [
    path.join(lib, 'Group Containers', '4788TTJ39Y.com.wiheads.paste'),
    path.join(lib, 'Containers', 'com.wiheads.paste', 'Data', 'Library', 'Application Support'),
    path.join(lib, 'Containers', 'com.wiheads.paste-setapp', 'Data', 'Library', 'Application Support'),
    path.join(lib, 'Application Support', 'com.wiheads.paste'),
    path.join(lib, 'Application Support', 'Paste')
  ];
  try {
    for (const name of fs.readdirSync(path.join(lib, 'Group Containers'))) {
      if (/wiheads\.paste/i.test(name)) roots.push(path.join(lib, 'Group Containers', name));
    }
  } catch {
    /* not readable */
  }
  return [...new Set(roots)];
}

function isSqlite(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(16);
      fs.readSync(fd, buf, 0, 16, 0);
      return buf.toString('latin1') === 'SQLite format 3\u0000';
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

// → { stores: [paths], denied: bool }
function findStores({ roots = candidateRoots(), maxDepth = 6 } = {}) {
  const stores = [];
  let denied = false;
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'EPERM' || err.code === 'EACCES') denied = true;
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth && !/^\..*_SUPPORT$/.test(e.name) && e.name !== '_EXTERNAL_DATA') walk(p, depth + 1);
      } else if (e.isFile() && !/-(wal|shm|journal)$/.test(e.name) && (/\.(sqlite|db|store)$/i.test(e.name) || !path.extname(e.name))) {
        if (isSqlite(p)) stores.push(p);
      }
    }
  };
  for (const root of roots) {
    if (fs.existsSync(root)) walk(root, 0);
    else {
      try {
        fs.accessSync(path.dirname(root));
      } catch (err) {
        if (err.code === 'EPERM' || err.code === 'EACCES') denied = true;
      }
    }
  }
  return { stores, denied };
}

// ------------------------------------------------------------------ decoding
function isUid(v) {
  return v instanceof bplist.UID || (v && typeof v === 'object' && Object.keys(v).length === 1 && Number.isInteger(v.UID));
}

// NSKeyedArchiver → plain JS values (NSDictionary / NSArray / NSData / NSString).
function unarchive(root) {
  const objects = root.$objects || [];
  const cache = new Map();
  let budget = MAX_WALK_NODES;
  const resolve = (v, depth) => {
    if (budget-- <= 0 || depth > 40) return null;
    if (isUid(v)) {
      const idx = v.UID;
      if (cache.has(idx)) return cache.get(idx);
      const raw = objects[idx];
      if (raw === '$null') return null;
      if (raw && typeof raw === 'object' && !Buffer.isBuffer(raw) && !Array.isArray(raw)) {
        const out = {};
        cache.set(idx, out); // cycles
        const decoded = decodeObject(raw, depth);
        if (decoded !== out) {
          cache.set(idx, decoded);
          return decoded;
        }
        return out;
      }
      const val = resolve(raw, depth + 1);
      cache.set(idx, val);
      return val;
    }
    if (Array.isArray(v)) return v.map((x) => resolve(x, depth + 1));
    if (v && typeof v === 'object' && !Buffer.isBuffer(v)) {
      const out = {};
      for (const [k, x] of Object.entries(v)) out[k] = resolve(x, depth + 1);
      return out;
    }
    return v;
  };
  const decodeObject = (raw, depth) => {
    if ('NS.keys' in raw && 'NS.objects' in raw) {
      const out = {};
      const keys = raw['NS.keys'].map((k) => resolve(k, depth + 1));
      raw['NS.objects'].forEach((o, i) => {
        out[String(keys[i])] = resolve(o, depth + 1);
      });
      return out;
    }
    if ('NS.objects' in raw) return raw['NS.objects'].map((o) => resolve(o, depth + 1));
    if ('NS.data' in raw) return resolve(raw['NS.data'], depth + 1);
    if ('NS.bytes' in raw) return resolve(raw['NS.bytes'], depth + 1);
    if ('NS.string' in raw) return String(resolve(raw['NS.string'], depth + 1));
    if ('NS.relative' in raw) {
      const rel = resolve(raw['NS.relative'], depth + 1);
      return typeof rel === 'string' ? rel : null;
    }
    const out = {};
    for (const [k, x] of Object.entries(raw)) if (k !== '$class') out[k] = resolve(x, depth + 1);
    return out;
  };
  const top = root.$top || {};
  const keys = Object.keys(top);
  const first = top.root !== undefined ? top.root : keys.length ? top[keys[0]] : null;
  return resolve(first, 0);
}

// Core Data "allows external storage": 0x01 + inline bytes, 0x02 + UUID.
function unwrapExternal(buf, { storePath } = {}) {
  if (!Buffer.isBuffer(buf) || buf.length < 2) return buf;
  if (buf[0] === 0x02 && buf.length <= 64) {
    const uuid = buf.slice(1).toString('latin1').replace(/\u0000+$/, '');
    if (/^[0-9A-F-]{36}$/i.test(uuid) && storePath) {
      const dir = path.dirname(storePath);
      const base = path.basename(storePath).replace(/\.[^.]+$/, '');
      for (const p of [path.join(dir, `.${base}_SUPPORT`, '_EXTERNAL_DATA', uuid), path.join(dir, `.${path.basename(storePath)}_SUPPORT`, '_EXTERNAL_DATA', uuid)]) {
        try {
          return fs.readFileSync(p);
        } catch {
          /* try next */
        }
      }
      return null;
    }
  }
  if (buf[0] === 0x01 && buf.length > 1 && (buf.slice(1, 9).toString('latin1') === 'bplist00' || buf[1] === 0x7b || buf[1] === 0x5b)) return buf.slice(1);
  return buf;
}

function decodeBlob(input, ctx = {}) {
  let buf = input;
  if (buf == null) return null;
  if (buf instanceof Uint8Array && !Buffer.isBuffer(buf)) buf = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  if (!Buffer.isBuffer(buf)) return buf;
  buf = unwrapExternal(buf, ctx);
  if (!buf) return null;
  if (buf.slice(0, 8).toString('latin1') === 'bplist00') {
    try {
      const parsed = bplist.parseBuffer(buf);
      const root = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : parsed;
      if (root && typeof root === 'object' && root.$archiver && root.$objects) return unarchive(root);
      return root;
    } catch {
      return buf;
    }
  }
  const head = buf.slice(0, 1).toString('latin1');
  if ((head === '{' || head === '[') && buf.length < 64 * 1024 * 1024) {
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch {
      /* not JSON */
    }
  }
  return buf;
}

const isTypeName = (k) => typeof k === 'string' && (UTI_RE.test(k) || LEGACY_TYPES.has(k));
const TYPE_KEYS = ['type', 'typeIdentifier', 'uti', 'pasteboardType', 'rawType', 'identifier', 'format'];
const DATA_KEYS = ['data', 'value', 'rawData', 'content', 'contents', 'rawValue'];

function asBuffer(v) {
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v);
  if (typeof v === 'string') return Buffer.from(v, 'utf8');
  if (v && v.type === 'Buffer' && Array.isArray(v.data)) return Buffer.from(v.data);
  // JSON-encoded Data is often base64
  return null;
}

// Walks any decoded structure → [{ type, data: Buffer, group }]
function collectPasteboard(value, ctx = {}) {
  const out = [];
  let budget = MAX_WALK_NODES;
  const seen = new Set();
  const add = (type, v, group) => {
    let data = asBuffer(v);
    if (typeof v === 'string' && ctx.base64 !== false && /^[A-Za-z0-9+/=\s]{16,}$/.test(v) && v.length % 4 === 0 && !/^\s*$/.test(v)) {
      const decoded = Buffer.from(v, 'base64');
      if (decoded.length && /png|tiff|jpeg|image/i.test(type)) data = decoded;
    }
    if (data) out.push({ type, data, group });
  };
  const walk = (v, depth, group) => {
    if (budget-- <= 0 || depth > 24 || v == null) return;
    if (typeof v !== 'object') return;
    if (Buffer.isBuffer(v)) {
      const inner = decodeBlob(v, ctx);
      if (inner !== v && inner && typeof inner === 'object') walk(inner, depth + 1, group);
      return;
    }
    if (seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      // [type, data, type, data, …]
      if (v.length >= 2 && v.length % 2 === 0 && v.every((x, i) => (i % 2 === 0 ? isTypeName(x) : x != null))) {
        for (let i = 0; i < v.length; i += 2) add(v[i], v[i + 1], group);
        return;
      }
      v.forEach((x, i) => walk(x, depth + 1, Array.isArray(x) || (x && typeof x === 'object') ? `${group}.${i}` : group));
      return;
    }
    const typeKey = TYPE_KEYS.find((k) => isTypeName(v[k]));
    const dataKey = DATA_KEYS.find((k) => v[k] != null);
    if (typeKey && dataKey) {
      const d = v[dataKey];
      if (asBuffer(d)) add(v[typeKey], d, group);
      else walk(d, depth + 1, group);
    }
    for (const [k, x] of Object.entries(v)) {
      if (isTypeName(k)) {
        if (asBuffer(x)) add(k, x, group);
        else if (x && typeof x === 'object') {
          const dk = DATA_KEYS.find((d) => asBuffer(x[d]));
          if (dk) add(k, x[dk], group);
        }
      } else if (x && typeof x === 'object' && k !== typeKey && k !== dataKey) {
        walk(x, depth + 1, group);
      }
    }
  };
  walk(value, 0, 'g');
  return out;
}

function textOf(entries, types) {
  for (const t of types) {
    const e = entries.find((x) => x.type === t);
    if (!e) continue;
    if (/utf16|NSStringPboardType16/i.test(t)) return e.data.toString('utf16le').replace(/^﻿/, '');
    return e.data.toString('utf8');
  }
  return null;
}

function fileUrlsOf(entries) {
  const out = [];
  for (const e of entries) {
    if (e.type === 'public.file-url' || e.type === 'NSFilenamesPboardType') {
      const s = e.data.toString('utf8').trim();
      if (e.type === 'NSFilenamesPboardType') {
        try {
          const list = bplist.parseBuffer(e.data)[0];
          if (Array.isArray(list)) out.push(...list.filter((x) => typeof x === 'string'));
          continue;
        } catch {
          /* plain text list */
        }
      }
      for (const line of s.split(/\r?\n/)) {
        if (!line) continue;
        if (/^file:\/\//i.test(line)) {
          try {
            out.push(decodeURIComponent(new URL(line).pathname));
          } catch {
            /* bad url */
          }
        } else if (line.startsWith('/')) out.push(line);
      }
    }
  }
  return [...new Set(out)];
}

const IMAGE_TYPES = ['public.png', 'Apple PNG pasteboard type', 'NSPNGPboardType', 'public.jpeg', 'public.tiff', 'NSTIFFPboardType', 'public.heic', 'com.compuserve.gif'];

/**
 * Pasteboard entries → the ClipShelf item shape (without board fields).
 * `toPng(buffer)` converts other image formats (Electron nativeImage).
 */
function itemFromEntries(entries, { title = null, toPng = null } = {}) {
  const files = fileUrlsOf(entries);
  const text = textOf(entries, ['public.utf8-plain-text', 'public.plain-text', 'NSStringPboardType', 'public.utf16-plain-text', 'public.utf16-external-plain-text']);
  const url = textOf(entries, ['public.url', 'Apple URL pasteboard type', 'NSURLPboardType']);
  const html = textOf(entries, ['public.html', 'NSHTMLPboardType']);
  const rtf = textOf(entries, ['public.rtf', 'NSRTFPboardType']);
  const image = IMAGE_TYPES.map((t) => entries.find((e) => e.type === t)).find(Boolean);
  if (files.length) return { type: 'file', paths: files };
  const cleanText = text && text.replace(/\u0000+$/, '');
  if (image && (!cleanText || cleanText.trim().length === 0)) {
    let png = image.data;
    if (!/png/i.test(image.type) && toPng) png = toPng(image.data);
    if (png && png.length) return { type: 'image', png };
  }
  const body = cleanText && cleanText.trim() ? cleanText : url && url.trim() ? url.trim() : null;
  if (body) return { type: 'text', text: body, html: html || null, rtf: rtf || null };
  if (image) {
    let png = image.data;
    if (!/png/i.test(image.type) && toPng) png = toPng(image.data);
    if (png && png.length) return { type: 'image', png };
  }
  if (title && String(title).trim()) return { type: 'text', text: String(title).trim(), html: null, rtf: null };
  return null;
}

// ------------------------------------------------------------------ reading
const MAX_BLOB_BYTES = 64 * 1024 * 1024;
const USEFUL_TYPES = new Set([
  'public.utf8-plain-text', 'public.plain-text', 'NSStringPboardType', 'public.utf16-plain-text', 'public.utf16-external-plain-text',
  'public.url', 'Apple URL pasteboard type', 'NSURLPboardType', 'public.html', 'NSHTMLPboardType', 'public.rtf', 'NSRTFPboardType',
  'public.file-url', 'NSFilenamesPboardType', ...IMAGE_TYPES
]);

const safeJson = (v) => {
  try {
    return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : Buffer.isBuffer(x) || x instanceof Uint8Array ? '<data>' : x));
  } catch {
    return '';
  }
};

function openCopy(storePath) {
  const { DatabaseSync } = require('node:sqlite');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipshelf-paste-'));
  let db = null;
  const close = () => {
    try {
      if (db) db.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  };
  try {
    const dest = path.join(tmp, 'store.sqlite');
    fs.copyFileSync(storePath, dest);
    for (const suffix of ['-wal', '-shm']) {
      if (fs.existsSync(storePath + suffix)) fs.copyFileSync(storePath + suffix, dest + suffix);
    }
    db = new DatabaseSync(dest);
  } catch (err) {
    close(); // never leave a partial copy of someone's clipboard history behind
    throw err;
  }
  return { db, close };
}

function tablesOf(db) {
  const out = {};
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    out[String(name).toUpperCase()] = { name, columns: db.prepare(`PRAGMA table_info(${q(name)})`).all().map((c) => c.name) };
  }
  return out;
}

function col(table, ...names) {
  if (!table) return null;
  for (const n of names) {
    const hit = table.columns.find((c) => String(c).toUpperCase() === n.toUpperCase());
    if (hit) return hit;
  }
  return null;
}

const q = (s) => `"${String(s).replace(/"/g, '""')}"`;

function toMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return null;
  if (n > 1e12) return Math.round(n); // already ms since 1970
  if (n > 1.6e9) return Math.round(n * 1000); // seconds since 1970
  return Math.round(n * 1000 + CORE_DATA_EPOCH_MS);
}

function bufOf(v) {
  if (v == null) return null;
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  return null;
}

function stringOf(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint') return String(v);
  const b = bufOf(v);
  if (b) {
    if (b.length > 1024 * 1024) return null;
    const d = decodeBlob(b);
    if (typeof d === 'string') return d;
    if (d && typeof d === 'object' && !Buffer.isBuffer(d)) {
      for (const k of ['name', 'title', 'string', 'text']) if (typeof d[k] === 'string') return d[k];
    }
    return null;
  }
  return String(v);
}

// Reads the small tables and figures out the schema. Returns null when this
// isn't a Paste store.
function describe(db) {
  const t = tablesOf(db);
  const items = t.ZITEMENTITY;
  if (!items) return { tables: t, items: null };
  const dataT = t.ZITEMDATAENTITY || null;
  const listT = t.ZLISTENTITY || null;
  const appT = t.ZAPPLICATIONENTITY || null;
  const c = {
    type: col(items, 'ZRAWTYPE'),
    title: col(items, 'ZTITLE', 'ZNAME'),
    preview: col(items, 'ZRAWPREVIEW'),
    ts: col(items, 'ZTIMESTAMP'),
    created: col(items, 'ZCREATEDAT'),
    updated: col(items, 'ZUPDATEDAT'),
    list: col(items, 'ZLIST'),
    app: col(items, 'ZSOURCEAPPLICATION', 'ZAPPLICATION'),
    order: col(items, 'ZDISPLAYORDERINPINBOARD', 'ZINDEX'),
    ident: col(items, 'ZIDENTIFIER'),
    data: col(items, 'ZDATA'),
    raw: col(items, 'ZRAWPASTEBOARDITEMS')
  };
  const data = dataT
    ? { table: dataT, itemFk: col(dataT, 'ZITEM'), raw: col(dataT, 'ZRAWPASTEBOARDITEMS'), data: col(dataT, 'ZDATA') }
    : null;

  const apps = new Map();
  if (appT) {
    const nameC = col(appT, 'ZNAME');
    const bundleC = col(appT, 'ZBUNDLEIDENTIFIER');
    for (const r of db.prepare(`SELECT Z_PK AS pk${nameC ? `, ${q(nameC)} AS name` : ''}${bundleC ? `, ${q(bundleC)} AS bundle` : ''} FROM ${q(appT.name)}`).iterate()) {
      apps.set(Number(r.pk), { name: stringOf(r.name), bundleId: stringOf(r.bundle) });
    }
  }

  const lists = new Map();
  if (listT) {
    const nameC = col(listT, 'ZNAME', 'ZTITLE');
    const attrC = col(listT, 'ZRAWATTRIBUTES');
    const colorC = col(listT, 'ZRAWCOLOR', 'ZCOLOR');
    const idC = col(listT, 'ZIDENTIFIER');
    const sql = `SELECT Z_PK AS pk${nameC ? `, ${q(nameC)} AS name` : ''}${attrC ? `, ${q(attrC)} AS attrs` : ''}${colorC ? `, ${q(colorC)} AS color` : ''}${idC ? `, ${q(idC)} AS ident` : ''} FROM ${q(listT.name)}`;
    for (const r of db.prepare(sql).iterate()) {
      const attrBuf = bufOf(r.attrs);
      const attrs = attrBuf && attrBuf.length < 1024 * 1024 ? decodeBlob(attrBuf) : null;
      const isObj = attrs && typeof attrs === 'object' && !Buffer.isBuffer(attrs);
      const flat = (safeJson(isObj ? attrs : {}) || '').toLowerCase();
      let name = stringOf(r.name);
      if (!name && isObj) name = stringOf(attrs.name || attrs.title);
      const kindHint = /"(kind|type|listtype|rawtype)":\s*"?(history|clipboard)/.test(flat) ? 'history' : /"(kind|type|listtype|rawtype)":\s*"?pinboard/.test(flat) ? 'pinboard' : null;
      let color = null;
      const rawColor = r.color != null ? r.color : isObj ? attrs.color || attrs.rawColor : null;
      if (rawColor != null) color = String(stringOf(rawColor) || '').toLowerCase() || null;
      lists.set(Number(r.pk), { key: String(stringOf(r.ident) || r.pk), name: name || null, color, kindHint, count: 0 });
    }
    if (c.list) {
      for (const r of db.prepare(`SELECT ${q(c.list)} AS l, COUNT(*) AS n FROM ${q(items.name)} GROUP BY ${q(c.list)}`).iterate()) {
        const l = r.l != null ? lists.get(Number(r.l)) : null;
        if (l) l.count = Number(r.n);
      }
    }
  }
  // Which list is the clipboard history? An explicit hint, else unnamed
  // lists, else the biggest list when there are several.
  const all = [...lists.values()];
  for (const l of all) l.isHistory = l.kindHint ? l.kindHint === 'history' : !l.name;
  if (all.length > 1 && !all.some((l) => l.isHistory) && !all.some((l) => l.kindHint)) {
    const biggest = all.reduce((a, b) => (b.count > a.count ? b : a));
    if (biggest.count > 0 && all.filter((l) => l !== biggest).every((l) => l.count * 3 < biggest.count)) biggest.isHistory = true;
  }
  return { tables: t, items, c, data, apps, lists };
}

/**
 * Cheap look at a store (no pasteboard data is read).
 * → { total, pinned, report: { tables } }
 */
function inspectStore(storePath) {
  const { db, close } = openCopy(storePath);
  try {
    const d = describe(db);
    const report = { tables: Object.fromEntries(Object.entries(d.tables).map(([k, v]) => [k, v.columns])) };
    if (!d.items) return { total: 0, pinned: 0, report: { ...report, reason: 'no-item-table' } };
    const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${q(d.items.name)}`).get().n);
    const pinned = [...d.lists.values()].filter((l) => !l.isHistory).reduce((n, l) => n + l.count, 0);
    return { total, pinned, report };
  } finally {
    close();
  }
}

function usefulEntries(entries) {
  const out = [];
  let image = false;
  for (const e of entries) {
    if (!USEFUL_TYPES.has(e.type)) continue;
    if (IMAGE_TYPES.includes(e.type)) {
      if (image) continue;
      image = true;
    }
    out.push(e);
  }
  return out;
}

/**
 * Streams a Paste store into ClipShelf.
 * opts: { store, saveBlob(buf, ext), statFile(path), toPng(buf), since, limit, quiet }
 * → { counts, report }  (report = structure only, never clipboard content)
 */
async function importStore(storePath, opts) {
  const { limit = MAX_ITEMS } = opts;
  const { db, close } = openCopy(storePath);
  try {
    const d = describe(db);
    const report = { tables: Object.fromEntries(Object.entries(d.tables).map(([k, v]) => [k, v.columns])), rows: 0, decoded: 0, typeNames: {}, blobKinds: {}, skippedLarge: 0 };
    const counts = { history: 0, pinned: 0, pinboards: 0, skipped: 0, duplicates: 0 };
    if (!d.items) return { counts, report: { ...report, reason: 'no-item-table' } };
    const { c, data, apps, lists } = d;
    const select = Object.entries(c).filter(([k, v]) => v && k !== 'raw' && k !== 'data').map(([k, v]) => `${q(v)} AS ${q(k)}`);
    if (c.data) select.push(`${q(c.data)} AS "dataPk"`);
    const hasRaw = !!c.raw;
    if (hasRaw) select.push(`length(${q(c.raw)}) AS "rawLen"`);
    const orderBy = c.ts || c.created || c.updated;
    const rows = db.prepare(`SELECT Z_PK AS pk, ${select.join(', ')} FROM ${q(d.items.name)}${orderBy ? ` ORDER BY ${q(orderBy)} DESC` : ''} LIMIT ?`);
    const rawOf = hasRaw ? db.prepare(`SELECT ${q(c.raw)} AS raw FROM ${q(d.items.name)} WHERE Z_PK = ?`) : null;
    let dataRows = null;
    if (data && (data.raw || data.data)) {
      const cols = [data.raw ? `${q(data.raw)} AS raw, length(${q(data.raw)}) AS rawLen` : null, data.data ? `${q(data.data)} AS data, length(${q(data.data)}) AS dataLen` : null].filter(Boolean).join(', ');
      if (data.itemFk) dataRows = db.prepare(`SELECT ${cols} FROM ${q(data.table.name)} WHERE ${q(data.itemFk)} = ?`);
      else if (c.data) dataRows = db.prepare(`SELECT ${cols} FROM ${q(data.table.name)} WHERE Z_PK = ?`);
    }
    const ctx = { storePath };
    const target = importTarget(opts, counts);
    let n = 0;
    for (const r of rows.iterate(Number(limit) | 0)) {
      report.rows++;
      const entries = [];
      const take = (blob, key) => {
        const buf = bufOf(blob);
        if (!buf) return;
        const kind = buf.slice(0, 8).toString('latin1') === 'bplist00' ? 'bplist' : buf[0] === 0x02 ? 'external' : buf[0] === 0x7b || buf[0] === 0x5b ? 'json' : 'raw';
        report.blobKinds[`${key}:${kind}`] = (report.blobKinds[`${key}:${kind}`] || 0) + 1;
        const decoded = decodeBlob(buf, ctx);
        if (decoded && typeof decoded === 'object' && !Buffer.isBuffer(decoded)) entries.push(...usefulEntries(collectPasteboard(decoded, ctx)));
      };
      const tooBig = (len) => Number(len || 0) > MAX_BLOB_BYTES;
      if (dataRows) {
        const key = data.itemFk ? r.pk : r.dataPk;
        if (key != null) {
          // an item can have several data rows: gather them all
          for (const dr of dataRows.iterate(key)) {
            if (tooBig(dr.rawLen) || tooBig(dr.dataLen)) {
              report.skippedLarge++;
              continue;
            }
            take(dr.raw, 'data.raw');
            take(dr.data, 'data.data');
          }
        }
      }
      if (rawOf && !tooBig(r.rawLen) && r.rawLen) take(rawOf.get(r.pk).raw, 'item.raw');
      for (const e of entries) report.typeNames[e.type] = (report.typeNames[e.type] || 0) + 1;
      if (entries.length) report.decoded++;
      const list = r.list != null ? lists.get(Number(r.list)) || null : null;
      const app = r.app != null ? apps.get(Number(r.app)) : null;
      let title = stringOf(r.title);
      if (!title && r.preview != null) {
        const pb = bufOf(r.preview);
        const pv = pb ? (pb.length < 1024 * 1024 ? decodeBlob(pb) : null) : r.preview;
        if (typeof pv === 'string') title = pv;
        else if (pv && typeof pv === 'object' && !Buffer.isBuffer(pv)) title = stringOf(pv.text || pv.title || pv.string);
      }
      const created = toMs(r.created) || toMs(r.ts) || null;
      target.add({
        key: String(stringOf(r.ident) || r.pk),
        createdAt: created,
        usedAt: toMs(r.ts) || toMs(r.updated) || created,
        title,
        sourceApp: app ? app.name : null,
        sourceBundleId: app ? app.bundleId : null,
        list,
        order: r.order != null ? Number(r.order) : null,
        entries
      });
      if (++n % 200 === 0) await new Promise((resolve) => setImmediate(resolve));
    }
    return { counts, report };
  } finally {
    close();
  }
}

// Turns one Paste item into a ClipShelf item (import side of importStore).
function importTarget({ store, saveBlob, statFile, toPng = null, since = 0, quiet = false }, counts) {
  const boardFor = new Map();
  const existingPins = new Set(store.list('pin').map((i) => i.importKey).filter(Boolean));
  const existingHistory = new Set(store.list('history').map((i) => i.importKey).filter(Boolean));
  const existingBoards = new Map(store.pinboards().filter((b) => b.importKey).map((b) => [b.importKey, b]));
  const colorMap = { red: 'red', orange: 'orange', yellow: 'yellow', green: 'green', teal: 'teal', blue: 'blue', purple: 'purple', pink: 'pink', gray: 'gray', grey: 'gray' };
  const create = (partial) => store.create(partial, { quiet });
  const pinboardOf = (list) => {
    const key = `paste:${list.key}`;
    if (boardFor.has(key)) return boardFor.get(key);
    let board = existingBoards.get(key);
    if (!board) {
      board = store.createPinboard({ name: list.name || 'Paste', color: colorMap[list.color] || undefined });
      store.update(board.id, { importKey: key });
      counts.pinboards++;
    }
    boardFor.set(key, board);
    return board;
  };
  return {
    add(it) {
      const pinned = !!(it.list && !it.list.isHistory);
      if (!pinned && since && (it.usedAt || 0) < since) {
        counts.skipped++;
        return;
      }
      const importKey = `paste:${it.key}`;
      if (pinned ? existingPins.has(importKey) : existingHistory.has(importKey)) {
        counts.duplicates++;
        return;
      }
      const shape = itemFromEntries(it.entries, { title: it.title, toPng });
      if (!shape) {
        counts.skipped++;
        return;
      }
      let partial;
      let hash;
      if (shape.type === 'text') {
        const isLink = /^(https?:\/\/|www\.)\S+$/i.test(shape.text.trim());
        hash = `t:${sha1(shape.text)}`;
        if (!pinned && store.findHistoryByHash(hash)) {
          counts.duplicates++;
          return;
        }
        partial = { type: isLink ? 'url' : 'text', text: shape.text, html: shape.html, rtf: shape.rtf, preview: shape.text.replace(/\s+/g, ' ').trim().slice(0, 200) };
      } else if (shape.type === 'image') {
        const blob = saveBlob(shape.png, '.png');
        hash = `i:${blob.slice(0, 64)}`;
        if (!pinned && store.findHistoryByHash(hash)) {
          counts.duplicates++;
          return;
        }
        partial = { type: 'image', blob, preview: '画像', imageSize: null };
      } else {
        const files = shape.paths.map((p) => statFile(p)).filter(Boolean);
        if (!files.length) {
          counts.skipped++;
          return;
        }
        hash = `f:${sha1(files.map((f) => f.path).join('\n'))}`;
        if (!pinned && store.findHistoryByHash(hash)) {
          counts.duplicates++;
          return;
        }
        partial = { type: 'file', files, preview: files.map((f) => f.name).join(', ') };
      }
      const times = { createdAt: it.createdAt || Date.now(), usedAt: it.usedAt || it.createdAt || Date.now() };
      const source = { sourceApp: it.sourceApp || null, sourceBundleId: it.sourceBundleId || null };
      const label = it.title && shape.type !== 'text' ? String(it.title).slice(0, 120) : null;
      if (pinned) {
        const board = pinboardOf(it.list);
        create({ board: 'pin', pinboardId: board.id, order: Number.isFinite(it.order) ? it.order : -times.usedAt, ...partial, ...source, ...times, label, importKey, hash: null });
        existingPins.add(importKey);
        counts.pinned++;
      } else {
        create({ board: 'history', hash, ...partial, ...source, ...times, label, importKey });
        existingHistory.add(importKey);
        counts.history++;
      }
    }
  };
}

module.exports = {
  candidateRoots, findStores, inspectStore, importStore, decodeBlob, unarchive, collectPasteboard, itemFromEntries, toMs, unwrapExternal
};
