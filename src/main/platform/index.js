'use strict';
const fs = require('fs');
const path = require('path');
const { LineProcess } = require('../helperProcess');

const isMac = process.platform === 'darwin';
const isWin = process.platform === 'win32';

function readScript(name) {
  // fs is asar-aware inside Electron, so this works from the packaged app.
  return fs.readFileSync(path.join(__dirname, name), 'utf8');
}

// Strips comments/indentation so the script fits comfortably inside the
// 32k Windows command-line limit when passed via -EncodedCommand.
function minifyPowerShell(src) {
  return src
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !l.startsWith('//'))
    .join('\n');
}

function powershellArgs(script) {
  const encoded = Buffer.from(minifyPowerShell(script), 'utf16le').toString('base64');
  return ['-NoLogo', '-NoProfile', '-NonInteractive', '-OutputFormat', 'Text', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded];
}

function powershellPath() {
  const root = process.env.SystemRoot || 'C:\\Windows';
  const full = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return fs.existsSync(full) ? full : 'powershell.exe';
}

const supported = isMac || isWin;

function createMonitor(log) {
  const env = { CLIPSHELF_PPID: String(process.pid) };
  if (isMac) {
    return new LineProcess({
      name: 'mac-monitor', command: '/usr/bin/osascript',
      args: ['-l', 'JavaScript', '-e', readScript('mac-monitor.jxa.js')], env, log
    });
  }
  if (isWin) {
    return new LineProcess({
      name: 'win-monitor', command: powershellPath(),
      args: powershellArgs(readScript('win-monitor.ps1')), env, log
    });
  }
  return null;
}

function createCommander(log) {
  if (isMac) {
    return new LineProcess({
      name: 'mac-commands', command: '/usr/bin/osascript',
      args: ['-l', 'JavaScript', '-e', readScript('mac-commands.jxa.js')], log, timeoutMs: 8000
    });
  }
  if (isWin) {
    return new LineProcess({
      name: 'win-commands', command: powershellPath(),
      args: powershellArgs(readScript('win-commands.ps1')), log, timeoutMs: 8000
    });
  }
  return null;
}

// Parses a monitor line into an event object.
function parseMonitorLine(line) {
  const parts = line.split('\t');
  const dec = (s) => {
    try {
      return decodeURIComponent(s || '');
    } catch {
      return s || '';
    }
  };
  switch (parts[0]) {
    case 'READY':
      return { type: 'ready', seq: parts[1] };
    case 'CLIP':
      return { type: 'clip', seq: parts[1], pid: Number(parts[2]) || 0, bundleId: dec(parts[3]), name: dec(parts[4]) };
    case 'FRONT':
      return { type: 'front', pid: Number(parts[1]) || 0, bundleId: dec(parts[2]), name: dec(parts[3]) };
    case 'CAPS':
      return { type: 'caps', on: parts[1] === '1' };
    case 'DRAG':
      return parts[1] === '1'
        ? { type: 'drag', active: true, kind: parts[2] || 'unknown', bypass: parts[3] === '1', pid: Number(parts[4]) || 0 }
        : { type: 'drag', active: false };
    default:
      return null;
  }
}

module.exports = { supported, isMac, isWin, createMonitor, createCommander, parseMonitorLine, minifyPowerShell, powershellArgs, readScript };
