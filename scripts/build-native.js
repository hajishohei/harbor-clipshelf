#!/usr/bin/env node
'use strict';
// Builds native/ (file drag with move support) for the Electron version in
// package.json and puts the result where src/main/nativeDrag.js looks:
//   native/prebuilt/darwin-universal/clipshelf_native.node
//   native/prebuilt/win32-<arch>/clipshelf_native.node
// Usage: node scripts/build-native.js [--arch x64,arm64]
// Needs Xcode command line tools (macOS) or Visual Studio C++ tools (Windows).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const nativeDir = path.join(root, 'native');
const electronVersion = require(path.join(root, 'node_modules', 'electron', 'package.json')).version;
const nodeGyp = require.resolve('node-gyp/bin/node-gyp.js');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
}

function build(arch) {
  const out = path.join(nativeDir, 'build-' + arch);
  fs.rmSync(path.join(nativeDir, 'build'), { recursive: true, force: true });
  execFileSync(process.execPath, [nodeGyp, 'rebuild', `--target=${electronVersion}`, `--arch=${arch}`,
    '--dist-url=https://electronjs.org/headers', '--build-from-source'], { cwd: nativeDir, stdio: 'inherit' });
  fs.rmSync(out, { recursive: true, force: true });
  fs.renameSync(path.join(nativeDir, 'build'), out);
  return path.join(out, 'Release', 'clipshelf_native.node');
}

function place(file, key) {
  const dir = path.join(nativeDir, 'prebuilt', key);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(file, path.join(dir, 'clipshelf_native.node'));
  console.log(`native: ${key} ready`);
}

const archs = arg('arch', process.platform === 'darwin' ? 'x64,arm64' : process.arch).split(',');
if (process.platform === 'darwin') {
  const built = archs.map(build);
  const dir = path.join(nativeDir, 'prebuilt', 'darwin-universal');
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'clipshelf_native.node');
  if (built.length > 1) execFileSync('lipo', ['-create', ...built, '-output', target], { stdio: 'inherit' });
  else fs.copyFileSync(built[0], target);
  execFileSync('codesign', ['--force', '--sign', '-', target], { stdio: 'inherit' });
  console.log('native: darwin-universal ready');
} else if (process.platform === 'win32') {
  for (const arch of archs) place(build(arch), `win32-${arch}`);
} else {
  console.log('native: nothing to build on this platform (Electron drag is used instead)');
}
