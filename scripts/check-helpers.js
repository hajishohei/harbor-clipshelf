'use strict';
// Runs the real OS helper scripts (macOS: osascript/JXA, Windows: PowerShell)
// and checks the line protocol. Used by CI on macOS / Windows runners and
// handy on a developer machine:  node scripts/check-helpers.js
const platform = require('../src/main/platform');
const { LineProcess } = require('../src/main/helperProcess');

const log = { info: console.log, warn: console.warn, error: console.error };
const failures = [];
const ok = (name, cond, detail) => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`);
  if (!cond) failures.push(name);
};

async function main() {
  const override = process.env.CLIPSHELF_PWSH; // lets Linux CI parse-check with pwsh
  if (!platform.supported && !override) {
    console.log(`skip: helpers are only used on macOS/Windows (this is ${process.platform})`);
    return;
  }
  let commander = platform.createCommander(log);
  let monitor = platform.createMonitor(log);
  if (override) {
    commander = new LineProcess({ name: 'pwsh-commands', command: override, args: platform.powershellArgs(platform.readScript('win-commands.ps1')), log, timeoutMs: 30000 });
    monitor = null;
  }

  ok('commander ping', (await commander.request('ping', {}, { timeoutMs: 30000 })) === 'pong');
  try {
    await commander.request('no-such-command');
    ok('unknown command rejected', false);
  } catch (err) {
    ok('unknown command rejected', /unknown-command/.test(err.message), err.message);
  }
  if (platform.isWin && !override) {
    const front = await commander.request('getFront', { ownPid: -1 }).catch((e) => ({ error: e.message }));
    ok('getFront answers', front === null || typeof front === 'object', front);
    const fg = await commander.request('foreground').catch((e) => ({ error: e.message }));
    ok('foreground answers', fg === null || (fg && !fg.error), fg);
    const own = await commander.request('appPath', { pid: process.pid }).catch((e) => ({ error: e.message }));
    ok('appPath finds this process', typeof own === 'string' && /node/i.test(own), own);
    const xm = await commander.request('getXMouse');
    ok('getXMouse returns settings', xm && typeof xm.enabled === 'boolean' && Number.isFinite(xm.delayMs), xm);
  }
  if (platform.isMac) {
    const front = await commander.request('getFront', { ownPid: -1 }).catch((e) => ({ error: e.message }));
    ok('getFront answers (may need Accessibility on CI)', true, front);
    const fg = await commander.request('foreground').catch((e) => ({ error: e.message }));
    ok('foreground answers', fg && !fg.error && Number.isFinite(fg.pid), fg);
    const finder = await commander.request('appPath', { bundleId: 'com.apple.finder' }).catch((e) => ({ error: e.message }));
    ok('appPath resolves Finder', typeof finder === 'string' && finder.endsWith('Finder.app'), finder);
  }
  commander.stop();

  if (monitor) {
    const lines = [];
    monitor.on('line', (l) => lines.push(l));
    monitor.start();
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !(lines.some((l) => l.startsWith('READY')) && lines.some((l) => l.startsWith('CAPS')))) {
      await new Promise((r) => setTimeout(r, 200));
    }
    ok('monitor READY', lines.some((l) => l.startsWith('READY')), lines.slice(0, 4));
    ok('monitor CAPS', lines.some((l) => /^CAPS\t[01]$/.test(l)));
    ok('monitor FRONT', lines.some((l) => l.startsWith('FRONT')));
    const parsed = lines.map(platform.parseMonitorLine).filter(Boolean);
    ok('monitor lines parse', parsed.length === lines.length, lines);
    monitor.stop();
  }
}

main()
  .catch((err) => {
    console.error(err);
    failures.push('crash');
  })
  .finally(() => {
    console.log(failures.length ? `FAILED: ${failures.join(', ')}` : 'all helper checks passed');
    process.exit(failures.length ? 1 : 0);
  });
