'use strict';
// Sound feedback ("効果音") for copy / paste.
// Each can be an OS system sound (the default: the sounds macOS / Windows
// already use), ClipShelf's own sound, or nothing.
//   macOS:   /System/Library/Sounds/<name>.aiff, played with afplay
//            (Chromium can't decode AIFF)
//   Windows: C:\Windows\Media\<name>.wav, played through the HUD window
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const MAC_DIR = '/System/Library/Sounds';
const MAC_SOUNDS = [
  ['Pop', 'ポン（Pop）'], ['Tink', 'チン（Tink）'], ['Bottle', 'ボトル（Bottle）'], ['Morse', 'モールス（Morse）'],
  ['Purr', 'パー（Purr）'], ['Frog', 'フロッグ（Frog）'], ['Glass', 'ガラス（Glass）'], ['Ping', 'ピン（Ping）'],
  ['Blow', 'ブロー（Blow）'], ['Funk', 'ファンク（Funk）'], ['Hero', 'ヒーロー（Hero）'], ['Submarine', 'サブマリン（Submarine）'],
  ['Basso', 'バッソ（Basso）'], ['Sosumi', 'ソスミ（Sosumi）']
];
const WIN_DIR = path.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'Media');
const WIN_SOUNDS = [
  ['Windows Navigation Start', 'クリック（ナビゲーション開始）'],
  ['Windows Pop-up Blocked', 'ポップアップ ブロック'],
  ['Windows Notify System Generic', '通知'],
  ['Windows Ding', 'ディン'],
  ['Speech On', '音声認識オン'],
  ['Speech Sleep', '音声認識スリープ'],
  ['Windows Balloon', 'バルーン'],
  ['chimes', 'チャイム']
];

const DEFAULT_SOUNDS = {
  darwin: { copySound: 'system:Pop', pasteSound: 'system:Tink' },
  win32: { copySound: 'system:Windows Navigation Start', pasteSound: 'system:Windows Navigation Start' },
  linux: { copySound: 'clipshelf', pasteSound: 'clipshelf' }
};

function defaultsFor(platform = process.platform) {
  return DEFAULT_SOUNDS[platform] || DEFAULT_SOUNDS.linux;
}

const VALUE_RE = /^(none|clipshelf|system:[\w .()-]{1,60})$/;
function validValue(v) {
  return typeof v === 'string' && VALUE_RE.test(v) && !v.includes('..');
}

function systemFile(name, platform = process.platform) {
  if (platform === 'darwin') return path.join(MAC_DIR, `${name}.aiff`);
  if (platform === 'win32') return path.join(WIN_DIR, `${name}.wav`);
  return null;
}

// Choices for the settings screen (only sounds that exist on this computer).
function choices(platform = process.platform) {
  const list = platform === 'darwin' ? MAC_SOUNDS : platform === 'win32' ? WIN_SOUNDS : [];
  const out = [];
  for (const [name, label] of list) {
    const file = systemFile(name, platform);
    if (file && fs.existsSync(file)) out.push({ value: `system:${name}`, label });
  }
  out.push({ value: 'clipshelf', label: 'ClipShelf の音（以前の音）' });
  out.push({ value: 'none', label: '鳴らさない' });
  return out;
}

function createSounds({ hud, getSettings, log }) {
  let last = 0;
  let player = null;
  const dataUrls = new Map();

  function resolve(value, kind) {
    if (value === 'none') return null;
    if (typeof value === 'string' && value.startsWith('system:')) {
      const file = systemFile(value.slice(7));
      if (file && fs.existsSync(file)) return { file };
    }
    return { bundled: kind }; // 'clipshelf', or a system sound this computer doesn't have
  }

  function playResolved(target, volume) {
    if (!target) return;
    const vol = Math.max(0, Math.min(1, volume));
    if (target.file && process.platform === 'darwin') {
      try {
        if (player && player.exitCode === null) player.kill();
        player = spawn('/usr/bin/afplay', ['-v', vol.toFixed(2), target.file], { stdio: 'ignore' });
        player.on('error', (err) => log && log.warn('[sound] afplay failed', err.message));
      } catch (err) {
        if (log) log.warn('[sound] afplay failed', err.message);
      }
      return;
    }
    if (target.file) {
      let src = dataUrls.get(target.file);
      if (!src) {
        try {
          src = `data:audio/wav;base64,${fs.readFileSync(target.file).toString('base64')}`;
          dataUrls.set(target.file, src);
        } catch {
          src = null;
        }
      }
      if (src) return hud.sound({ key: target.file, src, volume: vol });
      return;
    }
    hud.sound({ key: target.bundled, bundled: target.bundled, volume: vol });
  }

  const volumeOf = (s) => (Number.isFinite(s.soundVolume) ? s.soundVolume : 60) / 100;

  return {
    // kind: 'copy' | 'paste'
    play(kind) {
      const s = getSettings();
      if (!s.soundEffects) return;
      const now = Date.now();
      if (now - last < 80) return;
      last = now;
      const value = kind === 'paste' ? s.pasteSound : s.copySound;
      playResolved(resolve(value, kind === 'paste' ? 'paste' : 'copy'), volumeOf(s));
    },
    // Settings screen: try a sound before choosing it.
    preview(value, kind = 'copy', volume) {
      if (!validValue(value)) return false;
      const s = getSettings();
      playResolved(resolve(value, kind === 'paste' ? 'paste' : 'copy'), Number.isFinite(volume) ? volume / 100 : volumeOf(s));
      return true;
    },
    choices: () => choices()
  };
}

module.exports = { createSounds, choices, defaultsFor, validValue, systemFile, MAC_SOUNDS, WIN_SOUNDS };
