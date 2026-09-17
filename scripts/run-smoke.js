#!/usr/bin/env node
'use strict';
// Runs the in-app end-to-end check (scripts/smoke-run.js) against a throwaway profile.
// Linux CI: xvfb-run -a npm run smoke
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const electron = require('electron');
const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clipshelf-smoke-'));
const env = {
  ...process.env,
  CLIPSHELF_SMOKE: '1',
  CLIPSHELF_USER_DATA: process.env.CLIPSHELF_USER_DATA || path.join(tmp, 'profile'),
  CLIPSHELF_SMOKE_OUT: process.env.CLIPSHELF_SMOKE_OUT || path.join(tmp, 'out'),
  CLIPSHELF_UPDATE_FEED: process.env.CLIPSHELF_UPDATE_FEED || `http://127.0.0.1:${40000 + Math.floor(Math.random() * 20000)}/latest.json`
};
const args = [root];
if (process.platform === 'linux') args.push('--no-sandbox');
const r = spawnSync(electron, args, { env, stdio: 'inherit' });
process.exit(r.status === null ? 1 : r.status);
