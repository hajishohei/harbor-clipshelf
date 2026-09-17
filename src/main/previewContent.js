'use strict';
// Builds what the preview popup shows for an item (Quick Look-like):
// images, text, video / audio, folders, and a Quick Look thumbnail for
// everything else (PDF, Office, …).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { nativeImage, protocol } = require('electron');
const { largeIcon } = require('./fileIcon');

const SCHEME = 'clipshelf-media';
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg']);
const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv']);
const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'wav', 'ogg', 'oga', 'flac', 'opus']);
const TEXT_EXT = new Set([
  'txt', 'text', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'log', 'xml', 'yml', 'yaml', 'toml', 'ini', 'conf', 'cfg',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cc', 'cpp', 'hpp', 'cs',
  'php', 'sh', 'zsh', 'bash', 'ps1', 'bat', 'sql', 'html', 'htm', 'css', 'scss', 'less', 'vue', 'svelte', 'env', 'srt', 'vtt',
  'gitignore', 'dockerfile'
]);
const MIME = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  ico: 'image/x-icon', avif: 'image/avif', svg: 'image/svg+xml', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
  webm: 'video/webm', ogv: 'video/ogg', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav',
  ogg: 'audio/ogg', oga: 'audio/ogg', flac: 'audio/flac', opus: 'audio/opus'
};
const MAX_INLINE_IMAGE = 25 * 1024 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;
const TOKEN_TTL_MS = 30 * 60 * 1000;

const tokens = new Map(); // token → { path, mime, expires }

function extOf(p) {
  const base = path.basename(String(p || '')).toLowerCase();
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return base === 'dockerfile' ? 'dockerfile' : '';
  return base.slice(dot + 1);
}

function kindOf(p, { isDir = false } = {}) {
  if (isDir) return 'folder';
  const ext = extOf(p);
  if (IMAGE_EXT.has(ext)) return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'other';
}

// Must run before app 'ready'.
function registerScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }]);
}

function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m) return null;
  let start = m[1] === '' ? null : Number(m[1]);
  let end = m[2] === '' ? null : Number(m[2]);
  if (start === null && end === null) return null;
  if (start === null) {
    start = Math.max(0, size - end);
    end = size - 1;
  } else if (end === null || end >= size) {
    end = size - 1;
  }
  if (start > end || start >= size) return 'unsatisfiable';
  return { start, end };
}

// Streams only files the preview was just opened for (by random token).
function handleProtocol() {
  protocol.handle(SCHEME, async (request) => {
    let entry = null;
    try {
      const url = new URL(request.url);
      entry = tokens.get(url.pathname.replace(/^\/+/, ''));
    } catch {
      entry = null;
    }
    if (!entry || entry.expires < Date.now()) return new Response('not found', { status: 404 });
    let stat;
    try {
      stat = await fs.promises.stat(entry.path);
    } catch {
      return new Response('not found', { status: 404 });
    }
    const size = stat.size;
    const range = parseRange(request.headers.get('range'), size);
    const headers = { 'Content-Type': entry.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' };
    if (range === 'unsatisfiable') return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
    const { start, end } = range || { start: 0, end: size - 1 };
    const body = size === 0 ? null : Readable.toWeb(fs.createReadStream(entry.path, { start, end }));
    return new Response(body, {
      status: range ? 206 : 200,
      headers: { ...headers, 'Content-Length': String(size === 0 ? 0 : end - start + 1), ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}) }
    });
  });
}

function mediaUrl(p) {
  const now = Date.now();
  for (const [k, v] of tokens) if (v.expires < now) tokens.delete(k);
  const token = crypto.randomBytes(18).toString('hex');
  tokens.set(token, { path: p, mime: MIME[extOf(p)] || 'application/octet-stream', expires: now + TOKEN_TTL_MS });
  return `${SCHEME}://preview/${token}`;
}

async function thumbnailOf(p, size) {
  if (process.platform === 'linux') return null;
  try {
    const img = await nativeImage.createThumbnailFromPath(p, { width: size, height: size });
    return img && !img.isEmpty() ? { src: img.toDataURL(), ...img.getSize() } : null;
  } catch {
    return null;
  }
}

async function iconOf(p) {
  const img = await largeIcon(p, 128);
  return img ? img.toDataURL() : null;
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 4096);
  let odd = 0;
  for (let i = 0; i < n; i++) {
    const c = buf[i];
    if (c === 0) return true;
    if (c < 7 || (c > 13 && c < 32)) odd++;
  }
  return n > 0 && odd / n > 0.1;
}

/**
 * One file → { kind, name, path, size, src?, text?, entries?, width?, height?, icon? }
 * `p` must be a readable local path (the original, or a staged copy).
 */
async function describeFile(p, { name, isDir = false } = {}) {
  const out = { name: name || path.basename(p), path: p, kind: kindOf(p, { isDir }) };
  let stat = null;
  try {
    stat = await fs.promises.stat(p);
  } catch {
    return { ...out, kind: 'missing' };
  }
  if (stat.isDirectory()) out.kind = 'folder';
  out.size = stat.isDirectory() ? null : stat.size;
  out.modifiedAt = stat.mtimeMs;
  try {
    if (out.kind === 'folder') {
      const list = await fs.promises.readdir(p, { withFileTypes: true });
      const visible = list.filter((d) => !d.name.startsWith('.'));
      out.count = visible.length;
      out.entries = visible
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'ja'))
        .slice(0, 300)
        .map((d) => ({ name: d.name, dir: d.isDirectory() }));
      out.icon = await iconOf(p);
    } else if (out.kind === 'image') {
      if (stat.size <= MAX_INLINE_IMAGE) {
        const buf = await fs.promises.readFile(p);
        const ext = extOf(p);
        out.src = `data:${MIME[ext] || 'image/png'};base64,${buf.toString('base64')}`;
        if (ext !== 'svg') {
          const img = nativeImage.createFromBuffer(buf);
          if (!img.isEmpty()) Object.assign(out, img.getSize());
        }
      } else {
        const t = await thumbnailOf(p, 1600);
        if (t) Object.assign(out, t);
        else out.kind = 'other';
      }
    } else if (out.kind === 'video' || out.kind === 'audio') {
      out.src = mediaUrl(p);
    } else if (out.kind === 'text') {
      const fh = await fs.promises.open(p, 'r');
      try {
        const buf = Buffer.alloc(Math.min(stat.size, MAX_TEXT_BYTES));
        await fh.read(buf, 0, buf.length, 0);
        if (looksBinary(buf)) out.kind = 'other';
        else {
          out.text = buf.toString('utf8');
          out.truncated = stat.size > MAX_TEXT_BYTES;
        }
      } finally {
        await fh.close();
      }
    }
    if (out.kind === 'other') {
      const t = await thumbnailOf(p, 1200);
      if (t) Object.assign(out, t);
      out.icon = await iconOf(p);
    }
  } catch {
    out.kind = 'other';
    out.icon = out.icon || (await iconOf(p));
  }
  return out;
}

// Popup size that fits the content (Quick Look-like).
function sizeFor(content, area) {
  const maxW = Math.min(820, Math.round(area.width * 0.6));
  const maxH = Math.min(640, Math.round(area.height * 0.75));
  const chrome = { w: 40, h: 84 }; // header + padding around the picture
  let w = 520;
  let h = 440;
  const k = content && content.kind;
  if ((k === 'image' || (k === 'other' && content.src)) && content.width && content.height) {
    const scale = Math.min(1, (maxW - chrome.w) / content.width, (maxH - chrome.h) / content.height);
    w = Math.round(content.width * scale) + chrome.w;
    h = Math.round(content.height * scale) + chrome.h;
  } else if (k === 'video') {
    w = 720;
    h = 470;
  } else if (k === 'audio') {
    w = 460;
    h = 220;
  } else if (k === 'text') {
    w = 600;
    h = 520;
  } else if (k === 'folder') {
    w = 460;
    h = 480;
  } else if (k === 'snippet') {
    w = 560;
    h = 420;
  }
  if (content && content.stackCount > 1) h += 92;
  return { width: Math.max(420, Math.min(maxW, w)), height: Math.max(220, Math.min(maxH + (content && content.stackCount > 1 ? 92 : 0), h)) };
}

// Where the popup goes: next to the shelf (Yoink) or above the panel (Paste).
function placeNear({ anchor, side, size, area }) {
  const gap = 10;
  let x;
  let y;
  if (anchor) {
    x = side === 'right' ? anchor.x - size.width - gap : anchor.x + anchor.width + gap;
    y = Math.round(anchor.y + anchor.height / 2 - size.height / 2);
  } else {
    x = Math.round(area.x + (area.width - size.width) / 2);
    y = Math.round(area.y + Math.max(24, (area.height - size.height) / 2 - 160));
  }
  x = Math.max(area.x + 4, Math.min(area.x + area.width - size.width - 4, x));
  y = Math.max(area.y + 4, Math.min(area.y + area.height - size.height - 4, y));
  return { x, y, ...size };
}

module.exports = { registerScheme, handleProtocol, describeFile, kindOf, extOf, parseRange, sizeFor, placeNear, mediaUrl, SCHEME };
