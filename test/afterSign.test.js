'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const hook = require('../scripts/after-sign');


test('signing secret: password before the first colon, base64 after', () => {
  const b64 = Buffer.from('p12-bytes').toString('base64');
  const s = hook.parseSecret(`secret123:${b64.slice(0, 4)}\n${b64.slice(4)}`);
  assert.equal(s.password, 'secret123');
  assert.equal(s.p12.toString(), 'p12-bytes');
  assert.throws(() => hook.parseSecret('no-colon'));
});

test('without the secret the hook keeps the ad-hoc signature', async () => {
  delete process.env.MAC_SIGNING_CERT;
  await hook.default({ electronPlatformName: 'darwin', appOutDir: '/nonexistent', packager: { appInfo: { productFilename: 'X' } } });
  await hook.default({ electronPlatformName: 'win32', appOutDir: '/x', packager: { appInfo: { productFilename: 'X' } } });
});
