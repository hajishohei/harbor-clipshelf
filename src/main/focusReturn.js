'use strict';
const { app } = require('electron');
const { execFile } = require('child_process');

/**
 * After the history window / OCR overlay closes, give keyboard focus back
 * to the app the user came from so ⌘V / Ctrl+V pastes right away.
 * - Windows does this by itself when our window hides.
 * - macOS: our app is an "accessory" app, so we re-activate the previous
 *   app via LaunchServices (`open -b <bundle id>`, no permission needed).
 *   Without that info we fall back to hiding the whole app (⌘H behaviour).
 */
function restoreFocus({ monitor, keepOwnWindowsVisible = false, log }) {
  if (process.platform !== 'darwin') return;
  const prev = monitor && monitor.front;
  if (prev && prev.bundleId && prev.pid !== process.pid) {
    execFile('/usr/bin/open', ['-b', prev.bundleId], (err) => {
      if (err) {
        log && log.warn('[focus] open -b failed', err.message);
        if (!keepOwnWindowsVisible) app.hide();
      }
    });
    return;
  }
  if (!keepOwnWindowsVisible) app.hide();
}

module.exports = { restoreFocus };
