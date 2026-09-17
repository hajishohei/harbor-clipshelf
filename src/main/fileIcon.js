'use strict';
// app.getFileIcon wrapper.
//
// On macOS, Chromium's IconLoader only supports SMALL / NORMAL: asking for
// 'large' hits NOTREACHED() on a thread-pool worker and kills the whole app
// (v1.3.1 crashed on every launch once a folder sat on the shelf). Never pass
// 'large' there — use a Quick Look thumbnail for big icons instead.
const { app, nativeImage } = require('electron');

function iconSize(requested, platform = process.platform) {
  if (platform === 'darwin') return requested === 'small' ? 'small' : 'normal';
  return requested === 'small' || requested === 'normal' ? requested : 'large';
}

async function getFileIcon(p, { size = 'large' } = {}) {
  try {
    const img = await app.getFileIcon(p, { size: iconSize(size) });
    return img && !img.isEmpty() ? img : null;
  } catch {
    return null;
  }
}

// Large icon: Quick Look thumbnail on macOS / Windows (works for folders and
// apps too), falling back to the system icon.
async function largeIcon(p, px = 256) {
  if (process.platform !== 'linux') {
    try {
      const img = await nativeImage.createThumbnailFromPath(p, { width: px, height: px });
      if (img && !img.isEmpty()) return img;
    } catch {
      /* fall through */
    }
  }
  return getFileIcon(p, { size: 'large' });
}

module.exports = { iconSize, getFileIcon, largeIcon };
