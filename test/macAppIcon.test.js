'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { icnsPath, readInfoPlist } = require('../src/main/macAppIcon');

function fakeApp(plist, icon) {
  const app = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-app-')) + '/Foo.app';
  fs.mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true });
  if (plist) fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), plist);
  if (icon) fs.writeFileSync(path.join(app, 'Contents', 'Resources', icon), 'x');
  return app;
}

test('finds the bundle icon named in an XML Info.plist', () => {
  const app = fakeApp('<plist><dict><key>CFBundleIconFile</key>\n  <string>electron</string></dict></plist>', 'electron.icns');
  assert.equal(readInfoPlist(app).CFBundleIconFile, 'electron');
  assert.equal(icnsPath(app), path.join(app, 'Contents', 'Resources', 'electron.icns'));
});

test('finds the bundle icon in a binary Info.plist', () => {
  const plist = require('bplist-creator')({ CFBundleIconFile: 'Main.icns' });
  const app = fakeApp(plist, 'Main.icns');
  assert.equal(icnsPath(app), path.join(app, 'Contents', 'Resources', 'Main.icns'));
});

test('falls back to AppIcon.icns, or nothing', () => {
  assert.match(icnsPath(fakeApp(null, 'AppIcon.icns')), /AppIcon\.icns$/);
  assert.equal(icnsPath(fakeApp('<plist/>', null)), null);
});
