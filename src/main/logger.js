'use strict';
const fs = require('fs');
const path = require('path');
const util = require('util');

const MAX_BYTES = 1024 * 1024;
let file = null;

function init(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'main.log');
  } catch {
    file = null;
  }
}

function write(level, args) {
  const line = `[${new Date().toISOString()}] ${level} ${util.format(...args)}\n`;
  try {
    (level === 'INFO' ? process.stdout : process.stderr).write(line);
  } catch {
    /* no console attached (packaged Windows app) */
  }
  if (!file) return;
  try {
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {
      /* file doesn't exist yet */
    }
    fs.appendFileSync(file, line);
  } catch {
    /* logging must never throw */
  }
}

module.exports = {
  init,
  dir: () => (file ? path.dirname(file) : null),
  info: (...a) => write('INFO', a),
  warn: (...a) => write('WARN', a),
  error: (...a) => write('ERROR', a)
};
