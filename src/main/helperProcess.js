'use strict';
const { spawn } = require('child_process');
const readline = require('readline');
const { EventEmitter } = require('events');

/**
 * A long-running child process that talks newline-delimited text.
 *  - request(): writes {"id","cmd",...} and resolves with the matching
 *    {"id","ok","result"|"error"} line.
 *  - any other stdout line is emitted as 'line' (used by the monitors).
 * Restarts itself with backoff; gives up after too many crashes and emits
 * 'failed' so the UI can explain why a feature isn't working.
 */
class LineProcess extends EventEmitter {
  constructor({ name, command, args = [], env = {}, timeoutMs = 6000, maxRestarts = 4, restartWindowMs = 120000, log = console }) {
    super();
    this.name = name;
    this.command = command;
    this.args = args;
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.maxRestarts = maxRestarts;
    this.restartWindowMs = restartWindowMs;
    this.log = log;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.stopping = false;
    this.failed = false;
    this.lastError = null;
    this.stderrTail = [];
    this.crashTimes = [];
    this.restartTimer = null;
  }

  get running() {
    return !!this.child;
  }

  status() {
    return {
      name: this.name,
      running: this.running,
      failed: this.failed,
      lastError: this.lastError,
      stderr: this.stderrTail.slice(-5).join('\n')
    };
  }

  start() {
    this.stopping = false;
    if (this.child) return;
    let child;
    try {
      child = spawn(this.command, this.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, ...this.env }
      });
    } catch (err) {
      this._handleExit(null, null, err);
      return;
    }
    this.child = child;
    child.stdin.on('error', () => {
      /* EPIPE when the child dies; handled by exit */
    });
    readline.createInterface({ input: child.stdout }).on('line', (line) => this._onLine(line));
    readline.createInterface({ input: child.stderr }).on('line', (line) => {
      // strip ANSI colours / CLIXML noise so the settings screen shows readable text
      const clean = line.replace(/\u001b\[[0-9;]*m/g, '').replace(/_x001B_\[[0-9;]*m/g, '').replace(/<[^>]+>/g, '').trim();
      if (!clean) return;
      this.stderrTail.push(clean);
      if (this.stderrTail.length > 30) this.stderrTail.shift();
    });
    child.on('error', (err) => {
      if (this.child === child) this._handleExit(null, null, err);
    });
    child.on('exit', (code, signal) => {
      if (this.child === child) this._handleExit(code, signal, null);
    });
  }

  _onLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    if (trimmed.startsWith('{')) {
      let msg = null;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        msg = null;
      }
      if (msg && msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result === undefined ? null : msg.result);
        else p.reject(Object.assign(new Error(msg.error || 'helper error'), { helperError: true }));
        return;
      }
    }
    this.emit('line', trimmed);
  }

  _handleExit(code, signal, err) {
    this.child = null;
    const reason = err ? err.message : `exited (code=${code}, signal=${signal})`;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`${this.name} ${reason}`));
    }
    this.pending.clear();
    if (this.stopping) return;
    this.lastError = reason + (this.stderrTail.length ? ` — ${this.stderrTail.slice(-2).join(' / ')}` : '');
    this.log.warn(`[${this.name}] ${this.lastError}`);
    this.emit('exit', { code, signal, error: err });
    const now = Date.now();
    this.crashTimes = this.crashTimes.filter((t) => now - t < this.restartWindowMs);
    this.crashTimes.push(now);
    if (err && err.code === 'ENOENT') {
      this.failed = true;
      this.emit('failed', this.status());
      return;
    }
    if (this.crashTimes.length > this.maxRestarts) {
      this.failed = true;
      this.emit('failed', this.status());
      return;
    }
    const delay = Math.min(30000, 1000 * 2 ** (this.crashTimes.length - 1));
    clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => this.start(), delay);
  }

  request(cmd, params = {}, { timeoutMs } = {}) {
    if (this.failed) return Promise.reject(new Error(`${this.name} is unavailable: ${this.lastError || 'failed'}`));
    if (!this.child) this.start();
    if (!this.child) return Promise.reject(new Error(`${this.name} could not start`));
    const id = this.nextId++;
    const payload = JSON.stringify({ ...params, id, cmd }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.name}: '${cmd}' timed out`));
      }, timeoutMs || this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(payload);
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  // Clears the "failed" latch (e.g. after the user granted a permission).
  reset() {
    this.failed = false;
    this.crashTimes = [];
    this.lastError = null;
  }

  stop() {
    this.stopping = true;
    clearTimeout(this.restartTimer);
    const child = this.child;
    this.child = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`${this.name} stopped`));
    }
    this.pending.clear();
    if (child) {
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
      try {
        child.kill();
      } catch {
        /* ignore */
      }
    }
  }
}

module.exports = { LineProcess };
