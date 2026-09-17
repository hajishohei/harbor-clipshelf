'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sounds = require('../src/main/sounds');
const S = require('../src/main/settings');

test('copy / paste sounds default to the OS sounds', () => {
  assert.equal(sounds.defaultsFor('darwin').copySound, 'system:Pop');
  assert.match(sounds.defaultsFor('win32').copySound, /^system:Windows /);
  assert.equal(sounds.systemFile('Pop', 'darwin'), '/System/Library/Sounds/Pop.aiff');
  assert.match(sounds.systemFile('Windows Navigation Start', 'win32'), /Media[\\/]Windows Navigation Start\.wav$/);
});

test('sound settings are validated', () => {
  assert.ok(sounds.validValue('none'));
  assert.ok(sounds.validValue('clipshelf'));
  assert.ok(sounds.validValue('system:Windows Pop-up Blocked'));
  assert.ok(!sounds.validValue('system:../../etc/passwd'));
  assert.ok(!sounds.validValue('system:/tmp/x'));
  assert.ok(!sounds.validValue('file:///x.wav'));
  const s = S.normalize({ version: 4, copySound: 'system:../x', pasteSound: 'none', soundVolume: 250 });
  assert.equal(s.copySound, sounds.defaultsFor().copySound);
  assert.equal(s.pasteSound, 'none');
  assert.equal(s.soundVolume, 100);
  const upgraded = S.normalize({ version: 4, soundEffects: true });
  assert.equal(upgraded.copySound, sounds.defaultsFor().copySound);
  assert.equal(upgraded.soundVolume, 60);
});

test('choices always offer the old sound and silence', () => {
  const c = sounds.choices('linux').map((x) => x.value);
  assert.deepEqual(c, ['clipshelf', 'none']);
});
