'use strict';
const crypto = require('crypto');
const { pathToFileURL, fileURLToPath } = require('url');
const { clipboard, ClipboardItem, nativeImage } = require('electron');
const { CONFIDENTIAL_FORMATS, TRANSIENT_FORMATS, rawFormat } = require('../shared/text');

// Electron 44+ clipboard API (W3C-style, Promise based).
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_RICH_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 80 * 1024 * 1024;
const CONFIDENTIAL_TYPES = new Set(CONFIDENTIAL_FORMATS.map(rawFormat));
const TRANSIENT_TYPES = new Set(TRANSIENT_FORMATS.map(rawFormat));
const WIN_HISTORY_OPT_OUT = rawFormat('CanIncludeInClipboardHistory');

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

async function firstItem() {
  const items = await clipboard.read();
  return items && items.length ? items[0] : null;
}

async function blobOf(item, type) {
  try {
    const b = await item.getType(type);
    return b && typeof b.arrayBuffer === 'function' ? b : null;
  } catch {
    return null;
  }
}

function parseUriList(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('#') && /^file:/i.test(s))
    .map((u) => {
      try {
        return fileURLToPath(u);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function isConfidential(item, types) {
  if (types.some((t) => CONFIDENTIAL_TYPES.has(t))) return true;
  if (types.includes(WIN_HISTORY_OPT_OUT)) {
    const b = await blobOf(item, WIN_HISTORY_OPT_OUT);
    if (b) {
      const buf = Buffer.from(await b.arrayBuffer());
      if (buf.length >= 4 && buf.readUInt32LE(0) === 0) return true;
    }
  }
  return false;
}

/**
 * Reads the clipboard once and classifies it. Priority: files > text > image
 * (Office/Numbers put both text and a picture on the clipboard; the text is
 * what people want back).
 */
async function readSnapshot() {
  const item = await firstItem();
  if (!item) return { kind: 'empty', types: [] };
  const types = Array.from(item.types || []);
  const snap = {
    kind: 'empty',
    types,
    confidential: await isConfidential(item, types),
    transient: types.some((t) => TRANSIENT_TYPES.has(t))
  };

  if (types.includes('text/uri-list')) {
    const b = await blobOf(item, 'text/uri-list');
    const files = parseUriList(b ? await b.text() : '');
    if (files.length) return { ...snap, kind: 'files', files };
  }

  if (types.includes('text/plain')) {
    const b = await blobOf(item, 'text/plain');
    if (b && b.size > MAX_TEXT_BYTES) return { ...snap, kind: 'too-large' };
    const text = b ? await b.text() : '';
    if (text && text.trim()) {
      const out = { ...snap, kind: 'text', text };
      for (const [mime, key] of [['text/html', 'html'], ['text/rtf', 'rtf']]) {
        if (!types.includes(mime)) continue;
        const rb = await blobOf(item, mime);
        if (rb && rb.size <= MAX_RICH_BYTES) out[key] = await rb.text();
      }
      return out;
    }
  }

  const imageType = types.includes('image/png') ? 'image/png' : types.find((t) => /^image\//.test(t));
  if (imageType) {
    const b = await blobOf(item, imageType);
    if (b && b.size > 0 && b.size <= MAX_IMAGE_BYTES) {
      let png = Buffer.from(await b.arrayBuffer());
      const img = nativeImage.createFromBuffer(png);
      if (!img.isEmpty()) {
        if (imageType !== 'image/png') png = img.toPNG();
        return { ...snap, kind: 'image', png, imageSize: img.getSize() };
      }
    }
  }
  return snap;
}

// Cheap change detector for the polling fallback (no monitor helper).
// Images are only sampled when `includeImage` is set, because asking for
// the image makes the OS convert/encode it.
async function quickFingerprint({ includeImage = false } = {}) {
  const item = await firstItem();
  if (!item) return 'empty';
  const types = Array.from(item.types || []);
  const parts = [types.join('|')];
  for (const t of ['text/plain', 'text/uri-list']) {
    if (!types.includes(t)) continue;
    const b = await blobOf(item, t);
    if (b) parts.push(`${t}:${b.size}:${sha1(await b.text())}`);
  }
  const imageType = types.find((t) => /^image\//.test(t));
  if (imageType) {
    if (includeImage) {
      const b = await blobOf(item, imageType);
      if (b) {
        const head = Buffer.from(await b.slice(0, 65536).arrayBuffer());
        const tail = Buffer.from(await b.slice(Math.max(0, b.size - 65536)).arrayBuffer());
        parts.push(`img:${b.size}:${sha1(Buffer.concat([head, tail]))}`);
      }
    } else {
      parts.push('img:?');
    }
  }
  return parts.join('#');
}

/**
 * Writes one stored item back to the system clipboard.
 *   resolveImage(item) -> Buffer (PNG)
 *   resolveFiles(item) -> Promise<string[]> absolute paths usable on this device
 */
async function writeItem(item, { plain = false, resolveImage, resolveFiles }) {
  const data = {};
  if (item.type === 'image') {
    const png = resolveImage(item);
    data['image/png'] = new Blob([png], { type: 'image/png' });
  } else if (item.type === 'file') {
    const paths = await resolveFiles(item);
    if (!paths.length) throw new Error('files-unavailable');
    data['text/uri-list'] = paths.map((p) => pathToFileURL(p).href).join('\r\n');
    data['text/plain'] = paths.join('\n');
  } else {
    data['text/plain'] = item.text || '';
    if (!plain) {
      if (item.html) data['text/html'] = item.html;
      if (item.rtf) data['text/rtf'] = item.rtf;
    }
  }
  await clipboard.write([new ClipboardItem(data)]);
}

// Several items at once (multi-selection). Text-like items are joined with
// `separator`; file items are combined into one file list. Images can only
// travel alone, so a mixed selection keeps the text and file parts.
async function writeItems(items, { plain = false, separator = '\n', resolveImage, resolveFiles }) {
  if (items.length === 1) return writeItem(items[0], { plain, resolveImage, resolveFiles });
  const texts = items.filter((i) => i.type === 'text' || i.type === 'url');
  const files = items.filter((i) => i.type === 'file');
  const images = items.filter((i) => i.type === 'image');
  if (!texts.length && !files.length && images.length) return writeItem(images[0], { plain, resolveImage, resolveFiles });
  const data = {};
  if (files.length && !texts.length) {
    const paths = (await Promise.all(files.map((f) => resolveFiles(f)))).flat();
    if (!paths.length) throw new Error('files-unavailable');
    data['text/uri-list'] = paths.map((p) => pathToFileURL(p).href).join('\r\n');
    data['text/plain'] = paths.join('\n');
  } else {
    data['text/plain'] = texts.map((t) => t.text || '').join(separator);
    if (!plain && texts.some((t) => t.html)) {
      const esc = (x) => String(x).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
      const sepHtml = separator === '\n' ? '<br>' : esc(separator);
      data['text/html'] = texts.map((t) => t.html || esc(t.text || '').replace(/\n/g, '<br>')).join(sepHtml);
    }
  }
  await clipboard.write([new ClipboardItem(data)]);
}

async function writeText(text) {
  await clipboard.writeText(String(text || ''));
}

module.exports = { readSnapshot, quickFingerprint, writeItem, writeItems, writeText, parseUriList, sha1 };
