'use strict';
const { EventEmitter } = require('events');
const platform = require('./platform');

/**
 * Wraps the per-OS monitor helper (see platform/*-monitor.*) and turns its
 * output into events:
 *   'clip'  { seq, pid, bundleId, name }   clipboard changed (+ likely source app)
 *   'front' { pid, bundleId, name }        frontmost app changed
 *   'caps'  boolean                        Caps Lock state changed
 *   'drag'  { active, kind, bypass, pid }  a system drag started / ended
 *   'status'                               availability changed
 * If the helper can't run (Linux, or it keeps crashing) `available` is false
 * and the clipboard watcher falls back to polling.
 */
class SystemMonitor extends EventEmitter {
  constructor(log) {
    super();
    this.log = log;
    this.proc = null;
    this.ready = false;
    this.capsOn = null;
    this.front = null; // last frontmost app that isn't us
  }

  get available() {
    return !!(this.proc && this.ready && !this.proc.failed);
  }

  start() {
    if (!platform.supported || this.proc) return;
    this.proc = platform.createMonitor(this.log);
    this.proc.on('line', (line) => this._onLine(line));
    this.proc.on('exit', () => {
      this.ready = false;
      this.emit('status');
    });
    this.proc.on('failed', (st) => {
      this.ready = false;
      this.log.warn('[monitor] unavailable, falling back to polling:', st.lastError);
      this.emit('status');
    });
    this.proc.start();
  }

  _onLine(line) {
    const ev = platform.parseMonitorLine(line);
    if (!ev) return;
    if (ev.type === 'ready') {
      this.ready = true;
      this.emit('status');
      return;
    }
    if (ev.type === 'clip') this.emit('clip', ev);
    if (ev.type === 'front') {
      if (ev.pid && ev.pid !== process.pid) this.front = ev;
      this.emit('front', ev);
    }
    if (ev.type === 'drag') {
      this.dragging = ev.active;
      this.emit('drag', ev);
    }
    if (ev.type === 'caps') {
      this.capsOn = ev.on;
      this.emit('caps', ev.on);
    }
  }

  status() {
    return this.proc ? { ...this.proc.status(), ready: this.ready } : { running: false, ready: false, unsupported: !platform.supported };
  }

  retry() {
    if (!this.proc) return this.start();
    this.proc.reset();
    this.proc.start();
  }

  stop() {
    if (this.proc) this.proc.stop();
  }
}

module.exports = { SystemMonitor };
