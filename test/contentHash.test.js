'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { contentHash, lite } = require('../src/main/itemOps');

const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

test('pinned copies match their history entry by content', () => {
  // same keys as clipboardWatcher
  assert.equal(contentHash({ type: 'text', text: 'あああ' }), `t:${sha1('あああ')}`);
  assert.equal(contentHash({ type: 'url', text: 'https://x.test/' }), `t:${sha1('https://x.test/')}`);
  assert.equal(contentHash({ type: 'image', blob: 'abc.png' }), 'i:abc.png');
  assert.equal(contentHash({ type: 'file', files: [{ path: '/a' }, { path: '/b' }] }), `f:${sha1('/a\n/b')}`);
  assert.equal(contentHash({ type: 'file', files: [{ blob: 'x' }] }), null);
  const pin = lite({ id: 'p', board: 'pin', type: 'text', text: 'あああ', sourceHash: 't:old' });
  assert.deepEqual(pin.matchHashes, ['t:old', `t:${sha1('あああ')}`]);
  assert.equal(lite({ id: 'h', board: 'history', type: 'text', text: 'x', hash: 't:1' }).matchHashes, undefined);
});
