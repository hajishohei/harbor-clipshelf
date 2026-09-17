'use strict';
// macOS Accessibility ("アクセシビリティ") permission helpers.
//
// macOS remembers the permission for one exact build when an app is not
// signed with a stable certificate. After an update System Settings can still
// show ClipShelf as ON while macOS no longer trusts the new build, so the
// "allow" prompt keeps coming back. Resetting ClipShelf's entry and asking
// again fixes that in one step (only ClipShelf's own entry is touched).
const { execFile } = require('child_process');
const { app, systemPreferences, shell } = require('electron');

const BUNDLE_ID = 'com.harbor-live.clipshelf';
const PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility';

function isMac() {
  return process.platform === 'darwin';
}

function trusted() {
  if (!isMac()) return null;
  try {
    return systemPreferences.isTrustedAccessibilityClient(false);
  } catch {
    return null;
  }
}

function resetOwnEntry() {
  return new Promise((resolve) => {
    execFile('/usr/bin/tccutil', ['reset', 'Accessibility', BUNDLE_ID], { timeout: 5000 }, (err) => resolve(!err));
  });
}

// Clears ClipShelf's stale entry, shows macOS's own prompt and opens the
// Accessibility list so the user only has to switch ClipShelf on.
async function repair({ log } = {}) {
  if (!isMac()) return { ok: false, reason: 'unsupported' };
  if (trusted()) return { ok: true, already: true };
  const reset = await resetOwnEntry();
  if (log) log.info(`[accessibility] reset own entry: ${reset ? 'ok' : 'failed'}`);
  try {
    systemPreferences.isTrustedAccessibilityClient(true); // registers ClipShelf in the list + system prompt
  } catch {
    /* ignore */
  }
  setTimeout(() => shell.openExternal(PANE).catch(() => {}), 600);
  return { ok: true, reset };
}

// Calls onChange(true/false) whenever the permission flips.
function watch(onChange, intervalMs = 3000) {
  if (!isMac()) return () => {};
  let last = trusted();
  const timer = setInterval(() => {
    const now = trusted();
    if (now !== last) {
      last = now;
      onChange(now);
    }
  }, intervalMs);
  return () => clearInterval(timer);
}

function signedWithStableCertificate() {
  if (!isMac()) return null;
  const m = /(.*?\.app)\//.exec(process.execPath);
  if (!m) return null;
  return new Promise((resolve) => {
    execFile('/usr/bin/codesign', ['-dr', '-', m[1]], { timeout: 5000 }, (err, stdout, stderr) => {
      if (err) return resolve(null);
      const text = `${stdout}\n${stderr}`;
      resolve(/certificate/.test(text) && !/cdhash/.test(text));
    });
  });
}

module.exports = { trusted, repair, watch, resetOwnEntry, signedWithStableCertificate, BUNDLE_ID, appName: () => app.getName() };
