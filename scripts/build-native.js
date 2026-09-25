#!/usr/bin/env node
'use strict';
// Builds the native modules for the Electron version in package.json and puts
// the results where the app looks for them:
//   native/        → clipshelf_native.node (file drag with move support)
//   native-mouse/  → clipshelf_mouse.node  (マウス操作: button / wheel assignments)
// into native/prebuilt/darwin-universal/ or native/prebuilt/win32-<arch>/.
// Each module is built on its own, so one failing never removes the other.
// Usage: node scripts/build-native.js [--arch x64,arm64] [--only drag|mouse]
// Needs Xcode command line tools (macOS) or Visual Studio C++ tools (Windows).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const prebuilt = path.join(root, 'native', 'prebuilt');
const electronVersion = require(path.join(root, 'node_modules', 'electron', 'package.json')).version;
const nodeGyp = require.resolve('node-gyp/bin/node-gyp.js');

const MODULES = [
  { id: 'drag', dir: path.join(root, 'native'), file: 'clipshelf_native.node' },
  { id: 'mouse', dir: path.join(root, 'native-mouse'), file: 'clipshelf_mouse.node' }
];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

function build(mod, arch) {
  const out = path.join(mod.dir, 'build-' + arch);
  fs.rmSync(path.join(mod.dir, 'build'), { recursive: true, force: true });
  execFileSync(process.execPath, [nodeGyp, 'rebuild', `--target=${electronVersion}`, `--arch=${arch}`,
    '--dist-url=https://electronjs.org/headers', '--build-from-source'], { cwd: mod.dir, stdio: 'inherit' });
  fs.rmSync(out, { recursive: true, force: true });
  fs.renameSync(path.join(mod.dir, 'build'), out);
  return path.join(out, 'Release', mod.file);
}

function place(mod, file, key) {
  const dir = path.join(prebuilt, key);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(file, path.join(dir, mod.file));
  console.log(`native ${mod.id}: ${key} ready`);
}

function buildModule(mod, archs) {
  if (process.platform === 'darwin') {
    const built = archs.map((a) => build(mod, a));
    const dir = path.join(prebuilt, 'darwin-universal');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, mod.file);
    if (built.length > 1) execFileSync('lipo', ['-create', ...built, '-output', target], { stdio: 'inherit' });
    else fs.copyFileSync(built[0], target);
    execFileSync('codesign', ['--force', '--sign', '-', target], { stdio: 'inherit' });
    console.log(`native ${mod.id}: darwin-universal ready`);
  } else if (process.platform === 'win32') {
    for (const arch of archs) place(mod, build(mod, arch), `win32-${arch}`);
  } else {
    console.log(`native ${mod.id}: nothing to build on this platform`);
  }
}

const archs = arg('arch', process.platform === 'darwin' ? 'x64,arm64' : process.arch).split(',');
const only = arg('only', null);
const failed = [];
for (const mod of MODULES) {
  if (only && only !== mod.id) continue;
  // The mouse engine only has a macOS implementation so far.
  if (mod.id === 'mouse' && process.platform === 'win32') {
    console.log('native mouse: Windows version comes later — skipped');
    continue;
  }
  try {
    buildModule(mod, archs);
  } catch (err) {
    failed.push(mod.id);
    console.error(`native ${mod.id}: build failed — ${err.message}`);
  }
}
if (failed.length) {
  console.error(`native: failed: ${failed.join(', ')}`);
  process.exit(1);
}
