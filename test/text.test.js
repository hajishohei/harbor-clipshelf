'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../src/shared/text');

test('cleanOcrText joins Japanese characters but keeps Latin spacing', () => {
  assert.equal(T.cleanOcrText('ライ ブ コ マー ス 配 信 本 日 20 時\nHarboR ClipShelf OCR test 2026\n'), 'ライブコマース配信本日20時\nHarboR ClipShelf OCR test 2026');
  assert.equal(T.cleanOcrText('合 計 1,200 円'), '合計1,200円');
  assert.equal(T.cleanOcrText('a\n\n\n\nb  \n'), 'a\n\nb');
  assert.equal(T.cleanOcrText(''), '');
  assert.equal(T.cleanOcrText(null), '');
});

test('isUrl', () => {
  assert.ok(T.isUrl('https://harbor-live.com/a?b=c'));
  assert.ok(T.isUrl('  www.example.com  '));
  assert.ok(!T.isUrl('see https://example.com'));
  assert.ok(!T.isUrl('https://a.com\nhttps://b.com'));
  assert.ok(!T.isUrl(''));
});

test('previewOf truncates', () => {
  assert.equal(T.previewOf('abc', 2), 'ab…');
  assert.equal(T.previewOf('abc', 5), 'abc');
});

test('excluded apps match by name or bundle id, case-insensitively', () => {
  const list = ['1Password', 'keychain', ''];
  assert.ok(T.isExcludedApp({ name: '1Password 8' }, list));
  assert.ok(T.isExcludedApp({ name: 'x', bundleId: 'com.apple.KeychainAccess' }, list));
  assert.ok(!T.isExcludedApp({ name: 'Google Chrome' }, list));
  assert.ok(!T.isExcludedApp(null, list));
  assert.ok(!T.isExcludedApp({ name: '' }, ['']));
});

test('raw format helper', () => {
  assert.equal(T.rawFormat('org.nspasteboard.ConcealedType'), 'electron application/osclipboard;format="org.nspasteboard.ConcealedType"');
});

test('link previews skip one-time and private links', () => {
  assert.ok(T.isSafeForLinkPreview('https://harbor-live.com/news/1'));
  assert.ok(T.isSafeForLinkPreview('https://www.youtube.com/watch?v=abc'));
  assert.ok(!T.isSafeForLinkPreview('https://example.com/reset-password?x=1'));
  assert.ok(!T.isSafeForLinkPreview('https://example.com/a?token=abc'));
  assert.ok(!T.isSafeForLinkPreview('https://example.com/cb?code=123&state=x'));
  assert.ok(!T.isSafeForLinkPreview('https://user:pw@example.com/'));
  assert.ok(!T.isSafeForLinkPreview('http://localhost:3000/'));
  assert.ok(!T.isSafeForLinkPreview('http://192.168.1.10/admin'));
  assert.ok(!T.isSafeForLinkPreview('http://0.0.0.0:8080/'));
  assert.ok(!T.isSafeForLinkPreview('http://[fe80::1]/'));
  assert.ok(!T.isSafeForLinkPreview('http://intranet/wiki'));
  assert.ok(!T.isSafeForLinkPreview('https://nas.home/'));
  assert.ok(!T.isSafeForLinkPreview('ftp://example.com/'));
  assert.ok(!T.isSafeForLinkPreview('not a url'));
});

test('confidential and transient formats are separate', () => {
  assert.ok(T.CONFIDENTIAL_FORMATS.includes('org.nspasteboard.ConcealedType'));
  assert.ok(T.TRANSIENT_FORMATS.includes('org.nspasteboard.TransientType'));
  assert.ok(!T.CONFIDENTIAL_FORMATS.some((f) => T.TRANSIENT_FORMATS.includes(f)));
  assert.deepEqual(T.textStats('ab\nc'), { chars: 4, lines: 2 });
});
