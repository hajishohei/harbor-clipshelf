'use strict';
const fs = require('fs');
const path = require('path');
const blobs = require('./blobs');
const { dragStagingDir, exportDir } = require('./paths');

function safeName(name) {
  const base = Array.from(path.basename(String(name || '')))
    .map((c) => (c.charCodeAt(0) < 32 || '\\/:*?"<>|'.includes(c) ? '_' : c))
    .join('')
    .trim();
  return base || 'file';
}

// Copies a blob out under its original file name (stable location per blob,
// so repeated drags don't pile up copies).
function stageBlob(settings, blob, name, baseDir) {
  const dir = path.join(baseDir, blob.slice(0, 20));
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, safeName(name));
  if (!fs.existsSync(dest)) {
    const tmp = `${dest}.${process.pid}.tmp`;
    fs.copyFileSync(blobs.blobPath(settings, blob), tmp, fs.constants.COPYFILE_FICLONE);
    fs.renameSync(tmp, dest);
  }
  touch(dir);
  return dest;
}

// cleanupStaging() ages entries by mtime; mark reused copies as fresh.
function touch(p) {
  try {
    const now = new Date();
    fs.utimesSync(p, now, now);
  } catch {
    /* best effort */
  }
}

// Prepares drag copies ahead of time so a later drag-out starts instantly.
async function prestage(settings, item) {
  for (const f of (item && item.files) || []) {
    if (!f.blob || !blobs.blobExists(settings, f.blob)) continue;
    const dir = path.join(dragStagingDir(), f.blob.slice(0, 20));
    const dest = path.join(dir, safeName(f.name));
    if (fs.existsSync(dest)) continue;
    const tmp = `${dest}.${process.pid}.${Math.random().toString(36).slice(2)}.pre.tmp`;
    try {
      await fs.promises.mkdir(dir, { recursive: true });
      await fs.promises.copyFile(blobs.blobPath(settings, f.blob), tmp, fs.constants.COPYFILE_FICLONE);
      if (!fs.existsSync(dest)) await fs.promises.rename(tmp, dest);
      else await fs.promises.rm(tmp, { force: true });
    } catch {
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
    }
  }
}

/**
 * Paths usable on *this* device for a file item.
 * Shelf items carry a blob copy: we hand out a staged copy so dragging into
 * Finder/Explorer can never move the user's original. Items without a blob
 * (folders, very large files, history entries) point at the original path.
 */
function resolveFilePaths(settings, item, { purpose = 'drag' } = {}) {
  const base = purpose === 'drag' ? dragStagingDir() : exportDir();
  const out = [];
  for (const f of item.files || []) {
    if (f.blob && blobs.blobExists(settings, f.blob)) {
      out.push(stageBlob(settings, f.blob, f.name, base));
    } else if (f.path && fs.existsSync(f.path)) {
      out.push(f.path);
    }
  }
  return out;
}

// Removes staged copies older than maxAgeMs.
function cleanupStaging(maxAgeMs, dirs = [dragStagingDir(), exportDir()]) {
  const now = Date.now();
  for (const dir of dirs) {
    let entries = [];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = path.join(dir, name);
      try {
        const st = fs.statSync(full);
        if (now - st.mtimeMs > maxAgeMs) fs.rmSync(full, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

// Text / link items dragged out become files, like Yoink's "Snippet".
function stageText(item) {
  const isLink = item.type === 'url';
  const url = String(item.text || '').trim();
  const title = safeName(item.label || item.linkTitle || (isLink ? url.replace(/^https?:\/\//, '').split(/[/?#]/)[0] : 'スニペット')).slice(0, 60) || 'スニペット';
  const hash = require('crypto').createHash('sha1').update(`${item.type}:${item.text}:${title}`).digest('hex');
  const dir = path.join(dragStagingDir(), `t-${hash.slice(0, 18)}`);
  fs.mkdirSync(dir, { recursive: true });
  let file;
  let body;
  if (isLink && process.platform === 'win32') {
    file = path.join(dir, `${title}.url`);
    body = `[InternetShortcut]\r\nURL=${url}\r\n`;
  } else if (isLink) {
    file = path.join(dir, `${title}.webloc`);
    const esc = url.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    body = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>URL</key><string>${esc}</string></dict></plist>\n`;
  } else {
    file = path.join(dir, `${title}.txt`);
    body = (process.platform === 'win32' ? '\ufeff' : '') + String(item.text || '');
  }
  if (!fs.existsSync(file)) fs.writeFileSync(file, body, 'utf8');
  touch(dir);
  return file;
}

module.exports = { safeName, stageBlob, stageText, prestage, resolveFilePaths, cleanupStaging };
