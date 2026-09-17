'use strict';
// macOS: "フルディスクアクセス" lets the app open files anywhere (Desktop,
// Documents, Downloads, iCloud Drive, external disks, other apps' data)
// without asking folder by folder. There is no API to query it, so we try
// to read files that only apps with that permission can read.
const fs = require('fs');
const os = require('os');
const path = require('path');

function probes(home = os.homedir()) {
  return [
    path.join(home, 'Library', 'Application Support', 'com.apple.TCC', 'TCC.db'),
    path.join(home, 'Library', 'Safari', 'Bookmarks.plist'),
    path.join(home, 'Library', 'Safari', 'CloudTabs.db'),
    '/Library/Application Support/com.apple.TCC/TCC.db'
  ];
}

// → true (granted) | false (not granted) | null (can't tell / not macOS)
function hasFullDiskAccess({ platform = process.platform, candidates = probes() } = {}) {
  if (platform !== 'darwin') return null;
  let denied = false;
  for (const p of candidates) {
    try {
      const fd = fs.openSync(p, 'r');
      fs.closeSync(fd);
      return true;
    } catch (err) {
      if (err.code === 'EPERM' || err.code === 'EACCES') denied = true;
    }
  }
  return denied ? false : null;
}

module.exports = { hasFullDiskAccess, probes };
