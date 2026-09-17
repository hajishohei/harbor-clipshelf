'use strict';
// electron-builder afterSign hook (macOS).
//
// Without a signing certificate every build is signed "ad-hoc", and macOS
// remembers permissions (Accessibility, etc.) for that exact build only, so
// every update asked for them again. When the MAC_SIGNING_CERT secret is set,
// the app is re-signed with that one self-made certificate: macOS then
// recognises every future version as the same app and keeps the permission.
//
//   MAC_SIGNING_CERT = "<password>:<base64 of the .p12>"
//   (made with scripts/make-signing-cert.sh; registered as a GitHub secret)
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

function parseSecret(value) {
  const i = value.indexOf(':');
  if (i <= 0) throw new Error('MAC_SIGNING_CERT must look like "<password>:<base64 p12>"');
  return { password: value.slice(0, i), p12: Buffer.from(value.slice(i + 1).replace(/\s+/g, ''), 'base64') };
}

function listKeychains() {
  return run('security', ['list-keychains', '-d', 'user'])
    .split('\n')
    .map((l) => l.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

function signApp(appPath, secret) {
  const { password, p12 } = parseSecret(secret);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipshelf-sign-'));
  const keychain = path.join(dir, 'signing.keychain-db');
  const p12File = path.join(dir, 'cert.p12');
  const kcPass = crypto.randomBytes(18).toString('hex');
  fs.writeFileSync(p12File, p12, { mode: 0o600 });
  const before = listKeychains();
  try {
    run('security', ['create-keychain', '-p', kcPass, keychain]);
    run('security', ['set-keychain-settings', '-lut', '3600', keychain]);
    run('security', ['unlock-keychain', '-p', kcPass, keychain]);
    run('security', ['import', p12File, '-k', keychain, '-P', password, '-T', '/usr/bin/codesign']);
    run('security', ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', kcPass, keychain]);
    run('security', ['list-keychains', '-d', 'user', '-s', keychain, ...before]);
    // Self-made certificates are "not trusted" as a CA, which codesign does not need.
    const ids = run('security', ['find-identity', '-p', 'codesigning', keychain]);
    const m = /\b([0-9A-F]{40})\b/.exec(ids);
    if (!m) throw new Error(`no code signing identity in the certificate:\n${ids}`);
    const identity = m[1];
    run('codesign', ['--force', '--deep', '--sign', identity, '--keychain', keychain, '--timestamp=none',
      '--preserve-metadata=entitlements', appPath]);
    run('codesign', ['--verify', '--deep', '--strict', appPath]);
    // codesign prints the requirement on stdout (and details on stderr)
    const res = require('child_process').spawnSync('codesign', ['-d', '-r-', appPath], { encoding: 'utf8' });
    const out = `${res.stdout || ''}\n${res.stderr || ''}`;
    if (!/certificate/.test(out) || /cdhash/.test(out)) throw new Error(`unexpected designated requirement:\n${out}`);
    console.log(`[sign] ${path.basename(appPath)} signed with the ClipShelf certificate (${identity.slice(0, 8)}…)`);
    return identity;
  } finally {
    try {
      run('security', ['list-keychains', '-d', 'user', '-s', ...before]);
    } catch {
      /* ignore */
    }
    try {
      run('security', ['delete-keychain', keychain]);
    } catch {
      /* ignore */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const secret = process.env.MAC_SIGNING_CERT;
  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  if (!secret) {
    console.log('[sign] MAC_SIGNING_CERT is not set: keeping the ad-hoc signature (permissions reset on every update)');
    return;
  }
  if (!fs.existsSync(appPath)) throw new Error(`app not found: ${appPath}`);
  signApp(appPath, secret);
};
exports.signApp = signApp;
exports.parseSecret = parseSecret;
