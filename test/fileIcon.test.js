'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { iconSize } = require('../src/main/fileIcon');

// Regression: v1.3.1 crashed on launch on macOS because app.getFileIcon was
// asked for 'large' (Chromium NOTREACHED on Mac).
test('never asks macOS for a large file icon', () => {
  assert.equal(iconSize('large', 'darwin'), 'normal');
  assert.equal(iconSize(undefined, 'darwin'), 'normal');
  assert.equal(iconSize('normal', 'darwin'), 'normal');
  assert.equal(iconSize('small', 'darwin'), 'small');
  assert.equal(iconSize('large', 'win32'), 'large');
  assert.equal(iconSize('large', 'linux'), 'large');
});

test('app.getFileIcon is only called through the safe wrapper', () => {
  const root = path.join(__dirname, '..', 'src');
  const offenders = [];
  const walk = (dir) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (/\.(js|mjs|cjs)$/.test(d.name) && d.name !== 'fileIcon.js' && /\.getFileIcon\s*\(/.test(fs.readFileSync(p, 'utf8'))) offenders.push(path.relative(root, p));
    }
  };
  walk(root);
  assert.deepEqual(offenders, []);
});
