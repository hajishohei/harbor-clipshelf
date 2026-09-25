#!/usr/bin/env node
'use strict';
// Compiles and runs the mouse engine's unit tests (native-mouse/test/engine_test.cc)
// with the system C++ compiler. Used by CI; needs g++ or clang++.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const dir = path.join(__dirname, '..', 'native-mouse');
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mouse-engine-')), process.platform === 'win32' ? 'engine_test.exe' : 'engine_test');
const cxx = process.env.CXX || (spawnSync('clang++', ['--version']).status === 0 ? 'clang++' : 'g++');
execFileSync(cxx, ['-std=c++17', '-Wall', '-Wextra', '-Werror', '-I', path.join(dir, 'src'),
  path.join(dir, 'src', 'engine.cc'), path.join(dir, 'test', 'engine_test.cc'), '-o', out], { stdio: 'inherit' });
execFileSync(out, [], { stdio: 'inherit' });
