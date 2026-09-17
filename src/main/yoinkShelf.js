'use strict';
const path = require('path');
const { EventEmitter } = require('events');
const { BrowserWindow, screen } = require('electron');
const { webPreferences, forwardRendererErrors, floatingOptions, makeFloating, RENDERER } = require('./windowsCommon');
const { isExcludedApp } = require('../shared/text');
const { shelfGeometry, tabGeometry, sideOf, translatePoint, containsPoint } = require('../shared/shelfGeometry');

const EDGE_TRIGGER_PX = 24;
const POLL_MS = 60;
const HIDE_AFTER_DRAG_MS = 450;
const TRACK_MS = 180; // cursor tracking while the shelf is on screen
const IDLE_COLLAPSE_MS = 1200; // mouse away this long → tuck into the edge
const HOVER_SLOP = 6;
const animate = process.platform === 'darwin';

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
    this.collapsed = false; // tucked into a slim tab at the screen edge
    this.lastActive = 0; // last time the user was using the shelf
    this.busy = false; // renaming / menu open in the shelf
    this.previewOpen = false;
    this.trackTimer = null;
    this.displayId = null;
    this.atPark = false; // opened from the edge tab → shown at the park side
    this.parkCenterY = null; // vertical center of the tab (and of the shelf opened from it)
    this.tabArmed = false; // the pointer has been away from the tab since it appeared
    this.busyCount = 0; // dialogs opened from the shelf (move/copy to…)

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
    if (this.dragDisplay) return this.dragDisplay;
    if (this.displayId !== null && this.visible) {
      const d = screen.getAllDisplays().find((x) => x.id === this.displayId);
      if (d) return d;
    }
    return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  }

  _custom(display) {
    const custom = this.getSettings().shelfCustomPosition;
    if (!custom) return null;
    const displays = screen.getAllDisplays();
    const home = displays.find((d) => containsPoint(d.workArea, custom)) || screen.getDisplayNearestPoint(custom);
    if (!home || home.id === display.id) return custom;
    return translatePoint(custom, home.workArea, display.workArea);
  }

  _geometry(display = this._display(), { home = false } = {}) {
    const s = this.getSettings();
    const common = { workArea: display.workArea, size: s.shelfSize, count: this.count(), allDisplays: screen.getAllDisplays().map((d) => d.workArea) };
    if (this.atPark && !home) {
      const g = shelfGeometry({ ...common, position: `${this._parkSide(display)}-center` });
      if (!Number.isFinite(this.parkCenterY)) return g;
      const area = display.workArea;
      const y = Math.round(this.parkCenterY - g.height / 2);
      return { ...g, y: Math.max(area.y, Math.min(area.y + area.height - g.height, y)) };
    }
    return shelfGeometry({ ...common, position: s.shelfPosition, custom: this.anchor || this._custom(display) });
  }

  // Where the shelf goes after something was dropped on it (右端 / 左端 / 同じ側).
  _parkSide(display) {
    const s = this.getSettings();
    if (s.shelfParkSide === 'left' || s.shelfParkSide === 'right') return s.shelfParkSide;
    const home = s.shelfCustomPosition ? this._geometry(display, { home: true }) : null;
    return sideOf(home, display.workArea, s.shelfPosition);
  }

  _tab(display) {
    let centerY = this.parkCenterY;
    if (!Number.isFinite(centerY)) {
      const home = this._geometry(display, { home: true });
      centerY = home.y + home.height / 2;
    }
    return tabGeometry({ workArea: display.workArea, side: this._parkSide(display), centerY });
  }

  _place(display = this._display(), { smooth = false } = {}) {
    if (!this.win || this.win.isDestroyed()) return;
    this.programmaticMove = true;
    this.displayId = display.id;
    const bounds = this.collapsed ? this._tab(display) : this._geometry(display);
    this.win.setBounds(bounds, smooth && animate);
    clearTimeout(this.moveTimer);
    this.moveTimer = setTimeout(() => {
      this.programmaticMove = false;
    }, smooth && animate ? 400 : 100);
    this._sendState();
  }

  _onMoved() {
    if (this.programmaticMove || !this.win || this.collapsed) return;
    // The user is dragging the window: it belongs where they put it.
    const b = this.win.getBounds();
    this.lastActive = Date.now();
    this.atPark = false;
    this.anchor = null;
    try {
      this.displayId = screen.getDisplayMatching(b).id;
    } catch {
      /* keep */
    }
    clearTimeout(this.moveSaveTimer);
    this.moveSaveTimer = setTimeout(() => this.setSettings({ shelfCustomPosition: { x: b.x, y: b.y } }, { silent: true }), 300);
  }

  _sendState() {
    if (this.win && this.ready && !this.win.isDestroyed()) {
      const s = this.getSettings();
      this.win.webContents.send('shelf:state', {
        visible: this.visible,
        dragging: !!this.systemDrag,
        collapsed: this.collapsed,
        count: this.count(),
        position: s.shelfPosition,
        size: s.shelfSize,
        side: this._side()
      });
    }
  }

  _side() {
    const s = this.getSettings();
    if (this.visible && (this.collapsed || this.atPark)) return this._parkSide(this._display());
    if (this.win && !this.win.isDestroyed() && this.visible && (this.anchor || s.shelfCustomPosition)) {
      const d = this._display();
      return sideOf(this._geometry(d), d.workArea, s.shelfPosition);
    }
    return (s.shelfPosition || 'left').startsWith('right') ? 'right' : 'left';
  }

  _show({ focus = false, display, smooth = false } = {}) {
    const win = this._ensure();
    const wasCollapsed = this.collapsed;
    this.collapsed = false;
    this.atPark = false;
    this.lastActive = Date.now() + 2500; // give the pointer time to get there
    this._place(display, { smooth: smooth || wasCollapsed });
    if (focus) {
      win.show();
      win.focus();
    } else if (!win.isVisible()) {
      win.showInactive();
    }
    this.visible = true;
    this._startTracking();
    this._sendState();
    this.emit('change');
  }

  _hide() {
    if (this.win && !this.win.isDestroyed()) this.win.hide();
    this.visible = false;
    this.collapsed = false;
    this.atPark = false;
    this.parkCenterY = null;
    this.keepEmpty = false;
    this.anchor = null;
    this._stopTracking();
    this._sendState();
    this.emit('change');
  }

  isVisible() {
    return this.visible;
  }

  // ------------------------------------------------------------ public actions
  toggle() {
    if (this.visible && this.collapsed) {
      this.expand({ focus: true });
    } else if (this.visible) {
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

  isCollapsed() {
    return this.visible && this.collapsed;
  }

  // Slide out from the edge tab (hover / click / shortcut / a drag).
  expand({ focus = false } = {}) {
    if (!this.visible) return this.show({ focus });
    this.lastActive = Date.now() + (focus ? 2500 : 0);
    if (!this.collapsed) return undefined;
    this.collapsed = false;
    this.atPark = true;
    this._place(this._display(), { smooth: true });
    if (focus && this.win && !this.win.isDestroyed()) this.win.focus();
    this.emit('change');
    return undefined;
  }

  // Tuck into a slim tab at the screen edge (items stay on the shelf).
  collapse() {
    if (!this.visible || this.collapsed || this.count() === 0) return;
    if (this.win && !this.win.isDestroyed()) {
      const b = this.win.getBounds();
      this.parkCenterY = b.y + b.height / 2;
    }
    this.collapsed = true;
    this.tabArmed = false;
    this.anchor = null;
    this._place(this._display(), { smooth: true });
    this.emit('change');
  }

  // The user is doing something in the shelf (typing, renaming, a menu).
  markActive() {
    this.lastActive = Date.now();
  }

  setBusy(busy) {
    this.busy = !!busy;
    this.lastActive = Date.now();
  }

  // A dialog / share sheet opened from the shelf: stay open until it closes.
  pushBusy() {
    this.busyCount++;
    this.lastActive = Date.now();
  }

  popBusy() {
    this.busyCount = Math.max(0, this.busyCount - 1);
    this.lastActive = Date.now();
  }

  // Keep it open for a while (e.g. after a menu that may open a system sheet).
  holdFor(ms) {
    this.lastActive = Math.max(this.lastActive, Date.now() + ms);
  }

  setPreviewOpen(open) {
    this.previewOpen = !!open;
    this.lastActive = Date.now();
  }

  _startTracking() {
    if (this.trackTimer) return;
    this.trackTimer = setInterval(() => this._track(), TRACK_MS);
  }

  _stopTracking() {
    clearInterval(this.trackTimer);
    this.trackTimer = null;
  }

  _track() {
    if (!this.visible || !this.win || this.win.isDestroyed()) return this._stopTracking();
    let p;
    try {
      p = screen.getCursorScreenPoint();
    } catch {
      return undefined;
    }
    const now = Date.now();
    const b = this.win.getBounds();
    const slop = this.collapsed ? HOVER_SLOP * 2 : HOVER_SLOP;
    const inside = p.x >= b.x - slop && p.x <= b.x + b.width + slop && p.y >= b.y - slop && p.y <= b.y + b.height + slop;
    if (inside) {
      this.lastActive = Math.max(this.lastActive, now);
      if (this.collapsed && this.tabArmed) this.expand();
      return undefined;
    }
    if (this.collapsed) this.tabArmed = true;
    const s = this.getSettings();
    const inUse = this.systemDrag || now < this.ownDragUntil || this.busy || this.busyCount > 0 || this.previewOpen || this.programmaticMove;
    if (inUse) {
      this.lastActive = Math.max(this.lastActive, now);
      return undefined;
    }
    // Follow the user to the display they are working on.
    if (s.shelfFollowActiveDisplay && now - this.lastActive > 800) {
      const d = screen.getDisplayNearestPoint(p);
      if (d && d.id !== this.displayId) {
        this.anchor = null;
        this._place(d);
        this.emit('change');
        return undefined;
      }
    }
    if (s.shelfCollapseWhenIdle && !this.collapsed && !this.keepEmpty && this.count() > 0 && now - this.lastActive > IDLE_COLLAPSE_MS) {
      this.collapse();
    }
    return undefined;
  }

  resetPosition() {
    this.setSettings({ shelfCustomPosition: null }, { silent: true });
    if (this.visible) this._place();
  }

  applySettings() {
    if (this.visible && this.collapsed && !this.getSettings().shelfCollapseWhenIdle) this.collapsed = false;
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
      this.lastActive = Date.now();
    }
    if (n === 0 && !this.systemDrag && this.visible && !this.keepEmpty) {
      this._hide();
      return;
    }
    if (added && n > 0 && !this.visible && !this.userHidden) this._show();
    else if (this.visible && (this.collapsed || this.getSettings().shelfSize !== 'default')) this._place();
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
    const wasVisible = this.visible && !this.collapsed && !this.atPark;
    if (s.shelfShowMode === 'edge') {
      if (!wasVisible) this._watchEdge();
      return;
    }
    if (s.shelfShowMode === 'mouse') {
      this.anchor = { x: cursor.x - 66, y: cursor.y - 40 };
    }
    if (!wasVisible || s.shelfShowMode === 'mouse') {
      this.dragShown = !this.visible;
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
        this._show({ display: d, smooth: this.visible });
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
      // Hidden before the drag (or empty) → hide again, like Yoink.
      if (shownForDrag && (this.count() === 0 || this.userHidden)) this._hide();
      else if (this.count() === 0 && this.visible && !this.keepEmpty) this._hide();
      else if (this.visible) {
        // Shown at the mouse for this drag → go back to the usual place.
        const hadAnchor = !!this.anchor;
        this.anchor = null;
        this.lastActive = Date.now();
        if (hadAnchor && !this.collapsed) this._place(this._display(), { smooth: true });
      }
    }, HIDE_AFTER_DRAG_MS);
  }

  // Which side the preview popup should open away from.
  sideForPreview() {
    const b = this.bounds();
    if (!b) return 'left';
    const area = screen.getDisplayMatching(b).workArea;
    return b.x + b.width / 2 > area.x + area.width / 2 ? 'right' : 'left';
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
    this._stopTracking();
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
  }
}

module.exports = { YoinkShelf };
