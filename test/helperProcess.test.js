'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { LineProcess } = require('../src/main/helperProcess');

const silent = { info() {}, warn() {}, error() {} };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipshelf-helper-'));
const script = path.join(dir, 'echo.js');
fs.writeFileSync(
  script,
  `
const rl = require('readline').createInterface({ input: process.stdin });
console.log('HELLO\\tworld');
rl.on('line', (line) => {
  const req = JSON.parse(line);
  if (req.cmd === 'add') console.log(JSON.stringify({ id: req.id, ok: true, result: req.a + req.b }));
  else if (req.cmd === 'fail') console.log(JSON.stringify({ id: req.id, ok: false, error: 'nope' }));
  else if (req.cmd === 'crash') process.exit(3);
  else if (req.cmd === 'env') console.log(JSON.stringify({ id: req.id, ok: true, result: process.env.CLIPSHELF_TEST }));
  // 'silent' never answers
});
`
);

test('request/response, events, errors, timeouts', async () => {
  const proc = new LineProcess({ name: 't', command: process.execPath, args: [script], env: { CLIPSHELF_TEST: 'yes' }, timeoutMs: 400, log: silent });
  const lines = [];
  proc.on('line', (l) => lines.push(l));
  try {
    assert.equal(await proc.request('add', { a: 2, b: 3 }), 5);
    assert.equal(await proc.request('env'), 'yes');
    assert.deepEqual(lines, ['HELLO\tworld']);
    await assert.rejects(proc.request('fail'), /nope/);
    await assert.rejects(proc.request('silent'), /timed out/);
    assert.equal(await proc.request('add', { a: 1, b: 1 }), 2);
  } finally {
    proc.stop();
  }
});

test('restarts after a crash and gives up after repeated failures', async () => {
  const proc = new LineProcess({ name: 't2', command: process.execPath, args: [script], timeoutMs: 1000, maxRestarts: 1, log: silent });
  try {
    await assert.rejects(proc.request('crash'), /exited/);
    await new Promise((r) => setTimeout(r, 1300)); // first restart after 1s
    assert.equal(proc.running, true);
    assert.equal(await proc.request('add', { a: 1, b: 2 }), 3);
    const failed = new Promise((r) => proc.once('failed', r));
    await assert.rejects(proc.request('crash'), /exited/);
    await failed;
    assert.equal(proc.status().failed, true);
    await assert.rejects(proc.request('add', { a: 1, b: 2 }), /unavailable/);
    proc.reset();
    assert.equal(await proc.request('add', { a: 2, b: 2 }), 4);
  } finally {
    proc.stop();
  }
});

test('missing executable fails fast', async () => {
  const proc = new LineProcess({ name: 't3', command: path.join(dir, 'does-not-exist'), log: silent });
  const failed = new Promise((r) => proc.once('failed', r));
  proc.start();
  await failed;
  await assert.rejects(proc.request('add', { a: 1, b: 1 }), /unavailable/);
  proc.stop();
});
