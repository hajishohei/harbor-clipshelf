'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const P = require('../src/main/platform');

test('monitor lines are parsed', () => {
  assert.deepEqual(P.parseMonitorLine('READY\t42'), { type: 'ready', seq: '42' });
  assert.deepEqual(P.parseMonitorLine('CAPS\t1'), { type: 'caps', on: true });
  assert.deepEqual(P.parseMonitorLine('CAPS\t0'), { type: 'caps', on: false });
  assert.deepEqual(P.parseMonitorLine('FRONT\t77\t\tEXCEL'), { type: 'front', pid: 77, bundleId: '', name: 'EXCEL' });
  assert.deepEqual(P.parseMonitorLine('CLIP\t9\t12\tcom.apple.Safari\tSafari%20%E3%83%86'), { type: 'clip', seq: '9', pid: 12, bundleId: 'com.apple.Safari', name: 'Safari テ' });
  assert.equal(P.parseMonitorLine('garbage'), null);
  assert.equal(P.parseMonitorLine('CLIP\t1\t2\t%E0\tbad').bundleId, '%E0', 'bad escapes do not throw');
});

test('JXA helper scripts are valid JavaScript', () => {
  for (const name of ['mac-monitor.jxa.js', 'mac-commands.jxa.js']) {
    assert.doesNotThrow(() => new vm.Script(P.readScript(name), { filename: name }), name);
  }
});

test('PowerShell helpers fit the Windows command line and keep here-strings intact', () => {
  for (const name of ['win-monitor.ps1', 'win-commands.ps1']) {
    const src = P.readScript(name);
    const args = P.powershellArgs(src);
    assert.ok(args.join(' ').length < 30000, `${name} too long`);
    const min = P.minifyPowerShell(src);
    const lines = min.split('\n');
    const opens = lines.filter((l) => l.endsWith("@'")).length;
    const closes = lines.filter((l) => l === "'@").length;
    assert.equal(opens, closes, `${name} here-strings balanced`);
    assert.ok(!/\t/.test(min.replace(/`t/g, '')), `${name}: no raw tabs`);
    const decoded = Buffer.from(args[args.length - 1], 'base64').toString('utf16le');
    assert.equal(decoded, min);
    // braces balanced (rough syntax sanity check)
    const count = (ch) => (min.match(new RegExp(`\\${ch}`, 'g')) || []).length;
    assert.equal(count('{'), count('}'), `${name} braces`);
    assert.equal(count('('), count(')'), `${name} parens`);
  }
});

test('helper scripts are shipped inside src/', () => {
  for (const name of ['mac-monitor.jxa.js', 'mac-commands.jxa.js', 'win-monitor.ps1', 'win-commands.ps1']) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'src', 'main', 'platform', name)));
  }
});
