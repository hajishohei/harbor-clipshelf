'use strict';
const { screen } = require('electron');
const layouts = require('../shared/layouts');

const REASON_TEXT = {
  unsupported: 'このOSではウィンドウ整列に対応していません',
  accessibility: '「アクセシビリティ」の許可が必要です（設定タブから許可できます）',
  automation: '「オートメーション（System Events）」の許可が必要です',
  'helper-failed': 'ウィンドウ操作用の補助プロセスを起動できませんでした',
  'helper-error': 'ウィンドウを動かせませんでした',
  'no-window': '整列できるウィンドウがありません',
  fullscreen: 'フルスクリーンのウィンドウは整列できません',
  'no-history': '戻せる整列履歴がありません',
  'single-display': 'ディスプレイが1枚だけです'
};

class WindowSnapper {
  constructor({ windowService, log }) {
    this.ws = windowService;
    this.log = log;
    this.history = new Map(); // window id → { before, after }
    this.busy = false;
  }

  _displays() {
    return screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, workArea: d.workArea }));
  }

  async apply(action) {
    if (!layouts.ACTIONS.includes(action)) return { ok: false, reason: 'unknown-action' };
    if (this.busy) return { ok: false, reason: 'busy' };
    const problem = this.ws.preflight({ prompt: true });
    if (problem) return { ok: false, reason: problem };
    this.busy = true;
    try {
      const win = await this.ws.getFrontWindow();
      if (!win) return { ok: false, reason: 'no-window' };
      if (win.fullscreen) return { ok: false, reason: 'fullscreen' };

      let target;
      if (action === 'snapRestore') {
        const h = this.history.get(win.id);
        // On macOS the id is per app, so only restore the window we last
        // arranged (i.e. it's still where we put it).
        if (!h || (process.platform === 'darwin' && !layouts.sameRect(h.after, win.frame, 8))) {
          return { ok: false, reason: 'no-history' };
        }
        target = h.before;
      } else {
        target = layouts.computeLayout(action, { frame: win.frame, displays: this._displays() });
        if (!target) return { ok: false, reason: 'single-display' };
      }

      const actual = (await this.ws.setFrame(win, target)) || target;
      if (action === 'snapRestore') {
        this.history.delete(win.id);
      } else {
        const prev = this.history.get(win.id);
        // Pressing several layouts in a row still restores the original size.
        const before = prev && layouts.sameRect(prev.after, win.frame, 8) ? prev.before : win.frame;
        this.history.set(win.id, { before, after: actual });
        if (this.history.size > 200) this.history.delete(this.history.keys().next().value);
      }
      return { ok: true };
    } catch (err) {
      this.log.warn('[snap] failed', action, err && err.message);
      return { ok: false, reason: err.reason || 'helper-error' };
    } finally {
      this.busy = false;
    }
  }
}

module.exports = { WindowSnapper, REASON_TEXT };
