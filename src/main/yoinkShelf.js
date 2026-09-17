'use strict';
const path = require('path');
const { EventEmitter } = require('events');
const { BrowserWindow, screen } = require('electron');
const { webPreferences, forwardRendererErrors, floatingOptions, makeFloating, RENDERER } = require('./windowsCommon');
const { isExcludedApp } = require('../shared/text');
const { shelfGeometry } = require('../shared/shelfGeometry');

const EDGE_TRIGGER_PX = 24;
const POLL_MS = 60;
const HIDE_AFTER_DRAG_MS = 450;

/**
 * Yoink-style shelf window.
 *  - appears when a drag starts (or at the mouse / when the drag reaches the
 *    screen edge), and stays while it holds items
 *  - hides again when it is empty, or when the user hid it with the shortcut
 *  - lives at one of six edge positions (or where the user dragged it)
 */
class YoinkShelf extends EventEmitter {
  constructor({ store, monitor, getSettings, setSettings, log }) {
    super();
    this.store = store;
    this.monitor = monitor;
    this.getSettings = getSettings;
    this.setSettings = setSettings;
    this.log = log;
    this.win = null;
    this.ready = false;
    this.visible = false;
    this.userHidden = false; // hidden with the shortcut although it has items
    this.dragShown = false; // visible only because of the current drag
    this.systemDrag = null;
    this.ownDragUntil = 0;
    this.edgeTimer = null;
    this.anchor = null; // mouse-mode position for the current drag
    this.moveSaveTimer = null;
    this.programmaticMove = false;
    this.keepEmpty = false; // opened with the shortcut while empty

    store.on('changed', (item) => {
      if (item.board === 'shelf') this._afterItemsChanged(true);
    });
    store.on('removed', () => this._afterItemsChanged(false));
    store.on('reset', () => this._afterItemsChanged(false));
    const relayout = () => this.visible && this._place();
    screen.on('display-metrics-changed', relayout);
    screen.on('display-added', relayout);
    screen.on('display-removed', relayout);
  }

  count() {
    return this.store.count('shelf');
  }

  // ------------------------------------------------------------ window
  _ensure() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const win = new BrowserWindow({
      ...floatingOptions({ title: 'Shelf', movable: true }),
      width: 132,
      height: 340,
      webPreferences: webPreferences()
    });
    this.win = win;
    this.ready = false;
    makeFloating(win, 'floating');
    win.loadFile(path.join(RENDERER, 'shelf.html'));
    forwardRendererErrors(win, 'shelf', this.log);
    win.webContents.on('did-finish-load', () => {
      this.ready = true;
      this._sendState();
    });
    win.on('moved', () => this._onMoved());
    win.on('closed', () => {
      this.win = null;
      this.ready = false;
      this.visible = false;
    });
    return win;
  }

  _display() {
    const b = this.win && !this.win.isDestroyed() && this.visible ? this.win.getBounds() : null;
    if (this.dragDisplay) return this.dragDisplay;
    return b ? screen.getDisplayMatching(b) : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  }

  _geometry(display = this._display()) {
    const s = this.getSettings();
    return shelfGeometry({
      workArea: display.workArea,
      position: s.shelfPosition,
      size: s.shelfSize,
      count: this.count(),
      custom: this.anchor || s.shelfCustomPosition,
      allDisplays: screen.getAllDisplays().map((d) => d.workArea)
    });
  }

  _place(display) {
    if (!this.win || this.win.isDestroyed()) return;
    this.programmaticMove = true;
    this.win.setBounds(this._geometry(display));
    setTimeout(() => {
      this.programmaticMove = false;
    }, 100);
    this._sendState();
  }

  _onMoved() {
    if (this.programmaticMove || !this.win) return;
    const b = this.win.getBounds();
    clearTimeout(this.moveSaveTimer);
    this.moveSaveTimer = setTimeout(() => this.setSettings({ shelfCustomPosition: { x: b.x, y: b.y } }, { silent: true }), 300);
  }

  _sendState() {
    if (this.win && this.ready && !this.win.isDestroyed()) {
      const s = this.getSettings();
      this.win.webContents.send('shelf:state', {
        visible: this.visible,
        dragging: !!this.systemDrag,
        position: s.shelfPosition,
        size: s.shelfSize,
        side: (s.shelfPosition || 'left').startsWith('right') ? 'right' : 'left'
      });
    }
  }

  _show({ focus = false, display } = {}) {
    const win = this._ensure();
    this._place(display);
    if (focus) {
      win.show();
      win.focus();
    } else if (!win.isVisible()) {
      win.showInactive();
    }
    this.visible = true;
    this._sendState();
    this.emit('change');
  }

  _hide() {
    if (this.win && !this.win.isDestroyed()) this.win.hide();
    this.visible = false;
    this.keepEmpty = false;
    this.anchor = null;
    this._sendState();
    this.emit('change');
  }

  isVisible() {
    return this.visible;
  }

  // ------------------------------------------------------------ public actions
  toggle() {
    if (this.visible) {
      this.userHidden = true;
      this._hide();
    } else {
      this.userHidden = false;
      this.keepEmpty = this.count() === 0;
      this._show({ focus: true });
    }
  }

  show({ focus = false } = {}) {
    this.userHidden = false;
    if (this.count() === 0) this.keepEmpty = true;
    this._show({ focus });
  }

  hide() {
    this.userHidden = true;
    this._hide();
  }

  resetPosition() {
    this.setSettings({ shelfCustomPosition: null }, { silent: true });
    if (this.visible) this._place();
  }

  applySettings() {
    if (this.visible) this._place();
    else if (this.count() > 0 && !this.userHidden && this.getSettings().shelfEnabled) this._show();
  }

  // Called by main when our own window starts a drag (so the monitor's
  // DRAG event for it is not mistaken for a new drag).
  ownDragStarted(ms = 1500) {
    this.ownDragUntil = Date.now() + ms;
  }

  _afterItemsChanged(added) {
    this._sendState();
    const n = this.count();
    if (n > 0) this.keepEmpty = false;
    // Something was dropped while it was showing: it is now in normal use.
    if (added && this.visible) {
      this.userHidden = false;
      this.dragShown = false;
    }
    if (n === 0 && !this.systemDrag && this.visible && !this.keepEmpty) {
      this._hide();
      return;
    }
    if (added && n > 0 && !this.visible && !this.userHidden) this._show();
    else if (this.visible && this.getSettings().shelfSize !== 'default') this._place();
  }

  // ------------------------------------------------------------ system drags
  onSystemDrag(ev) {
    if (ev.active) this._dragStarted(ev);
    else this._dragEnded();
  }

  _dragStarted(ev) {
    const s = this.getSettings();
    this.systemDrag = ev;
    if (!s.shelfEnabled || ev.bypass) return;
    if (ev.pid === process.pid || Date.now() < this.ownDragUntil) return;
    const front = this.monitor && this.monitor.front;
    const source = front && front.pid === ev.pid ? front : null;
    if (source && isExcludedApp(source, s.shelfIgnoredApps)) return;
    let cursor;
    try {
      cursor = screen.getCursorScreenPoint();
    } catch {
      return;
    }
    this.dragDisplay = screen.getDisplayNearestPoint(cursor);
    const wasVisible = this.visible;
    if (s.shelfShowMode === 'edge') {
      if (!wasVisible) this._watchEdge();
      return;
    }
    if (s.shelfShowMode === 'mouse') {
      this.anchor = { x: cursor.x - 66, y: cursor.y - 40 };
    }
    if (!wasVisible || s.shelfShowMode === 'mouse') {
      this.dragShown = !wasVisible;
      this._show({ display: this.dragDisplay });
    }
  }

  _watchEdge() {
    clearInterval(this.edgeTimer);
    this.edgeTimer = setInterval(() => {
      if (!this.systemDrag) return clearInterval(this.edgeTimer);
      const p = screen.getCursorScreenPoint();
      const d = screen.getDisplayNearestPoint(p);
      const b = d.bounds;
      const side = (this.getSettings().shelfPosition || 'left').startsWith('right') ? 'right' : 'left';
      const near = side === 'left' ? p.x - b.x <= EDGE_TRIGGER_PX : b.x + b.width - p.x <= EDGE_TRIGGER_PX;
      if (near) {
        clearInterval(this.edgeTimer);
        this.dragDisplay = d;
        this.dragShown = !this.visible;
        this._show({ display: d });
      }
    }, POLL_MS);
  }

  _dragEnded() {
    clearInterval(this.edgeTimer);
    this.systemDrag = null;
    const shownForDrag = this.dragShown;
    this.dragShown = false;
    this._sendState();
    setTimeout(() => {
      this.dragDisplay = null;
      if (this.systemDrag) return;
      this.anchor = this.getSettings().shelfShowMode === 'mouse' && this.visible ? this.anchor : null;
      // Hidden before the drag (or empty) → hide again, like Yoink.
      if (shownForDrag && (this.count() === 0 || this.userHidden)) this._hide();
      else if (this.count() === 0 && this.visible && !this.keepEmpty) this._hide();
    }, HIDE_AFTER_DRAG_MS);
  }

  bounds() {
    return this.win && !this.win.isDestroyed() && this.visible ? this.win.getBounds() : null;
  }

  containsPoint(p) {
    const b = this.bounds();
    return !!(b && p && p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height);
  }

  send(channel, payload) {
    if (this.win && this.ready && !this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  destroy() {
    clearInterval(this.edgeTimer);
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
  }
}

module.exports = { YoinkShelf };
