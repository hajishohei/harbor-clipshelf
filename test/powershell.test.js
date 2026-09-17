'use strict';
// Runs the Windows helper through a real PowerShell when one is available
// (pwsh on Linux/macOS dev machines, set CLIPSHELF_PWSH=/path/to/pwsh).
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const P = require('../src/main/platform');
const { LineProcess } = require('../src/main/helperProcess');

function findPwsh() {
  if (process.env.CLIPSHELF_PWSH) return process.env.CLIPSHELF_PWSH;
  try {
    execFileSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' });
    return 'pwsh';
  } catch {
    return null;
  }
}
const pwsh = findPwsh();
const silent = { info() {}, warn() {}, error() {} };

test('PowerShell helpers parse and their C# compiles', { skip: !pwsh && 'pwsh not available' }, () => {
  for (const name of ['win-monitor.ps1', 'win-commands.ps1']) {
    const script = [
      '$src = [Console]::In.ReadToEnd()',
      '$t = $null; $e = $null',
      '[void][System.Management.Automation.Language.Parser]::ParseInput($src, [ref]$t, [ref]$e)',
      'if ($e.Count) { throw ($e | ForEach-Object { $_.Message + " @" + $_.Extent.StartLineNumber }) -join "; " }',
      '$m = [regex]::Match($src, "@' + "'" + '\\r?\\n(.*?)\\r?\\n' + "'" + '@", "Singleline")',
      'Add-Type -TypeDefinition $m.Groups[1].Value -IgnoreWarnings -ErrorAction Stop',
      '"ok"'
    ].join('\n');
    const out = execFileSync(pwsh, ['-NoProfile', '-NonInteractive', '-Command', script], {
      input: P.minifyPowerShell(P.readScript(name)),
      encoding: 'utf8'
    });
    assert.match(out, /ok/, name);
  }
});

test('PowerShell command helper speaks the JSON line protocol', { skip: !pwsh && 'pwsh not available', timeout: 90000 }, async () => {
  const proc = new LineProcess({ name: 'pwsh', command: pwsh, args: P.powershellArgs(P.readScript('win-commands.ps1')), timeoutMs: 60000, log: silent });
  try {
    assert.equal(await proc.request('ping'), 'pong');
    await assert.rejects(proc.request('nope'), /unknown-command:nope/);
    assert.equal(await proc.request('ping'), 'pong');
  } finally {
    proc.stop();
  }
});
