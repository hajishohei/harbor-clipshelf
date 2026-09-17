'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { blobsDir, ensureDirs } = require('./paths');

function hashOf(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function safeExt(ext) {
  const e = String(ext || '').toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(e) ? e : '';
}

function blobPath(settings, name) {
  if (!/^[a-f0-9]{64}(\.[a-z0-9]{1,10})?$/.test(String(name))) {
    throw new Error(`invalid blob name: ${name}`);
  }
  return path.join(blobsDir(settings), name);
}

// Content-addressed: identical bytes are stored once.
function saveBlob(settings, buffer, ext) {
  ensureDirs(settings);
  const name = hashOf(buffer) + safeExt(ext);
  const full = blobPath(settings, name);
  if (!fs.existsSync(full)) {
    const tmp = `${full}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, buffer);
    fs.renameSync(tmp, full);
  }
  return name;
}

// Streams a file through the hash so large files never sit in memory.
function saveBlobFromFile(settings, srcPath) {
  ensureDirs(settings);
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(srcPath, 'r');
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    let read;
    while ((read = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      hash.update(read === chunk.length ? chunk : chunk.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  const name = hash.digest('hex') + safeExt(path.extname(srcPath));
  const full = blobPath(settings, name);
  if (!fs.existsSync(full)) {
    const tmp = `${full}.${process.pid}.tmp`;
    fs.copyFileSync(srcPath, tmp);
    fs.renameSync(tmp, full);
  }
  return name;
}

// Async variant for user-sized files (videos, archives…): hashing and copying
// happen off the main thread's hot path, and APFS/ReFS clone instead of copy.
async function saveBlobFromFileAsync(settings, srcPath) {
  ensureDirs(settings);
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    fs.createReadStream(srcPath, { highWaterMark: 1024 * 1024 })
      .on('data', (d) => hash.update(d))
      .on('end', resolve)
      .on('error', reject);
  });
  const name = hash.digest('hex') + safeExt(path.extname(srcPath));
  const full = blobPath(settings, name);
  if (!fs.existsSync(full)) {
    const tmp = `${full}.${process.pid}.${Date.now()}.tmp`;
    try {
      await fs.promises.copyFile(srcPath, tmp, fs.constants.COPYFILE_FICLONE);
      await fs.promises.rename(tmp, full);
    } catch (err) {
      await fs.promises.rm(tmp, { force: true });
      throw err;
    }
  }
  return name;
}

function readBlob(settings, name) {
  return fs.readFileSync(blobPath(settings, name));
}

function blobExists(settings, name) {
  try {
    return fs.existsSync(blobPath(settings, name));
  } catch {
    return false;
  }
}

function listBlobs(settings) {
  try {
    return fs.readdirSync(blobsDir(settings)).filter((n) => /^[a-f0-9]{64}(\.[a-z0-9]{1,10})?$/.test(n));
  } catch {
    return [];
  }
}

function removeBlob(settings, name) {
  try {
    fs.unlinkSync(blobPath(settings, name));
    return true;
  } catch {
    return false;
  }
}

module.exports = { hashOf, safeExt, blobPath, saveBlob, saveBlobFromFile, saveBlobFromFileAsync, readBlob, blobExists, listBlobs, removeBlob };
