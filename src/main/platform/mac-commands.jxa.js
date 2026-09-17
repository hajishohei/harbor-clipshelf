// HarboR ClipShelf — macOS window commands (JavaScript for Automation).
// Reads one JSON request per line on stdin, answers one JSON line on stdout.
// Moving/raising other apps' windows goes through System Events, which needs
// the Accessibility permission (and Automation → System Events) for the app.
ObjC.import('Foundation');
ObjC.import('AppKit');
ObjC.import('CoreGraphics');

var stdin = $.NSFileHandle.fileHandleWithStandardInput;
var stdout = $.NSFileHandle.fileHandleWithStandardOutput;
function send(obj) {
  stdout.writeData($(JSON.stringify(obj) + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
}

var systemEvents = null;
function SE() {
  if (!systemEvents) systemEvents = Application('System Events');
  return systemEvents;
}

var SKIP_OWNERS = {
  'Dock': 1, 'SystemUIServer': 1, 'Control Center': 1, 'コントロールセンター': 1,
  'Notification Center': 1, '通知センター': 1, 'Window Server': 1, 'WindowManager': 1,
  'Spotlight': 1, 'screencaptureui': 1, 'loginwindow': 1, 'TextInputMenuAgent': 1
};

// This helper blocks on stdin, so AppKit never gets to process workspace
// notifications on its own; pump the run loop briefly before asking.
function pump() {
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.02));
}

function frontApp() {
  pump();
  var app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  return { pid: app.processIdentifier, name: ObjC.unwrap(app.localizedName) || '' };
}

function procByPid(pid) {
  var procs = SE().processes.whose({ unixId: pid });
  if (procs.length === 0) return null;
  return procs[0];
}

function focusedWindow(proc) {
  var win = null;
  try {
    win = proc.attributes.byName('AXFocusedWindow').value();
  } catch (e) {
    win = null;
  }
  if (!win) {
    if (proc.windows.length === 0) return null;
    win = proc.windows[0];
  }
  return win;
}

function frameOf(win) {
  var pos = win.position();
  var size = win.size();
  return { x: pos[0], y: pos[1], width: size[0], height: size[1] };
}

function isFullscreen(win) {
  try {
    return !!win.attributes.byName('AXFullScreen').value();
  } catch (e) {
    return false;
  }
}

function getFront(req) {
  var fa = frontApp();
  if (!fa.pid || fa.pid === req.ownPid) return null;
  var proc = procByPid(fa.pid);
  if (!proc) return null;
  var win = focusedWindow(proc);
  if (!win) return null;
  return { pid: fa.pid, app: fa.name, fullscreen: isFullscreen(win), frame: frameOf(win) };
}

function setFront(req) {
  var proc = procByPid(req.pid);
  if (!proc) throw new Error('process-not-found');
  var win = focusedWindow(proc);
  if (!win) throw new Error('no-window');
  var f = req.frame;
  // position → size → position: size can be clamped by the old screen when
  // moving between displays, so re-apply the position afterwards.
  win.position = [Math.round(f.x), Math.round(f.y)];
  win.size = [Math.round(f.width), Math.round(f.height)];
  win.position = [Math.round(f.x), Math.round(f.y)];
  return frameOf(win);
}

function windowList() {
  var ref = $.CGWindowListCopyWindowInfo(1 | 16, 0); // on-screen only, no desktop elements
  var list = ObjC.deepUnwrap(ObjC.castRefToObject(ref)) || [];
  var result = [];
  for (var i = 0; i < list.length; i++) {
    var w = list[i];
    var b = w.kCGWindowBounds || {};
    result.push({
      num: w.kCGWindowNumber,
      pid: w.kCGWindowOwnerPID,
      owner: w.kCGWindowOwnerName || '',
      layer: w.kCGWindowLayer,
      alpha: w.kCGWindowAlpha === undefined ? 1 : w.kCGWindowAlpha,
      x: b.X, y: b.Y, width: b.Width, height: b.Height
    });
  }
  return result;
}

function raise(target) {
  var proc = procByPid(target.pid);
  if (!proc) return false;
  var wins = proc.windows();
  for (var i = 0; i < wins.length; i++) {
    try {
      var f = frameOf(wins[i]);
      if (Math.abs(f.x - target.x) <= 2 && Math.abs(f.y - target.y) <= 2 &&
          Math.abs(f.width - target.width) <= 2 && Math.abs(f.height - target.height) <= 2) {
        wins[i].actions.byName('AXRaise').perform();
        break;
      }
    } catch (e) { /* window vanished */ }
  }
  proc.frontmost = true;
  return true;
}

// AutoRaise-style: raise the topmost normal window under the cursor unless
// it's already frontmost or a mouse button is held (drag in progress).
// If the topmost thing under the cursor is not a normal window (menu, Dock,
// our shelf / overlay, a popover…), do nothing rather than raising what's
// underneath it.
function hover(req) {
  if ($.NSEvent.pressedMouseButtons > 0) return { raised: false, reason: 'button-down' };
  var front = frontApp().pid;
  var all = windowList().filter(function (w) { return w.alpha > 0.05; });
  var target = null;
  for (var i = 0; i < all.length; i++) { // CGWindowList is front-to-back
    var w = all[i];
    if (req.x >= w.x && req.x < w.x + w.width && req.y >= w.y && req.y < w.y + w.height) {
      target = w;
      break;
    }
  }
  if (!target) return { raised: false, reason: 'no-window' };
  if (target.pid === req.ownPid) return { raised: false, reason: 'own-window' };
  if (target.layer !== 0 || SKIP_OWNERS[target.owner]) return { raised: false, reason: 'overlay' };
  if (target.width <= 40 || target.height <= 40) return { raised: false, reason: 'small-window' };
  var list = all.filter(function (x) { return x.layer === 0; });
  for (var j = 0; j < list.length; j++) {
    if (list[j].pid === front) {
      if (list[j].num === target.num) return { raised: false, reason: 'already-front' };
      break;
    }
  }
  raise(target);
  return { raised: true, app: target.owner };
}

// ⌘V into the frontmost app (Paste's "Direct Paste"). CGEvent first; System
// Events as a fallback. Both need the Accessibility permission.
function paste() {
  try {
    var src = $.CGEventSourceCreate(1); // kCGEventSourceStateHIDSystemState
    var down = $.CGEventCreateKeyboardEvent(src, 9, true); // kVK_ANSI_V
    var up = $.CGEventCreateKeyboardEvent(src, 9, false);
    $.CGEventSetFlags(down, 1048576); // kCGEventFlagMaskCommand
    $.CGEventSetFlags(up, 1048576);
    $.CGEventPost(0, down); // kCGHIDEventTap
    $.CGEventPost(0, up);
    return true;
  } catch (e) {
    SE().keystroke('v', { using: 'command down' });
    return true;
  }
}

function appPath(req) {
  var url = null;
  if (req.bundleId) url = $.NSWorkspace.sharedWorkspace.URLForApplicationWithBundleIdentifier($(req.bundleId));
  if ((!url || url.isNil()) && req.pid) {
    var app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(req.pid);
    if (app && !app.isNil()) url = app.bundleURL;
  }
  if (!url || url.isNil()) return null;
  return ObjC.unwrap(url.path);
}

// The app's real icon as a PNG (base64). Electron's app.getFileIcon only
// gives the generic icon for the file type on macOS.
function appIcon(req) {
  var p = req.path;
  if (!p && req.bundleId) p = appPath({ bundleId: req.bundleId });
  if (!p) return null;
  var size = Math.max(16, Math.min(256, Number(req.size) || 64));
  var icon = $.NSWorkspace.sharedWorkspace.iconForFile($(p));
  if (!icon || icon.isNil()) return null;
  var canvas = $.NSImage.alloc.initWithSize($.NSMakeSize(size, size));
  canvas.lockFocus;
  icon.drawInRectFromRectOperationFraction($.NSMakeRect(0, 0, size, size), $.NSZeroRect, 2, 1.0); // NSCompositingOperationSourceOver
  canvas.unlockFocus;
  var tiff = canvas.TIFFRepresentation;
  if (!tiff || tiff.isNil()) return null;
  var rep = $.NSBitmapImageRep.imageRepWithData(tiff);
  if (!rep || rep.isNil()) return null;
  var png = rep.representationUsingTypeProperties(4, $({})); // NSBitmapImageFileTypePNG
  if (!png || png.isNil()) return null;
  return ObjC.unwrap(png.base64EncodedStringWithOptions(0));
}

function foreground() {
  var fa = frontApp();
  var app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  return { pid: fa.pid, name: fa.name, bundleId: ObjC.unwrap(app.bundleIdentifier) || '' };
}

// Touches System Events once so macOS asks for (or reports) the
// Automation permission up front.
function probe() {
  SE().processes.whose({ frontmost: true }).length;
  return true;
}

function handle(req) {
  switch (req.cmd) {
    case 'ping': return 'pong';
    case 'probe': return probe();
    case 'getFront': return getFront(req);
    case 'setFront': return setFront(req);
    case 'hover': return hover(req);
    case 'paste': return paste();
    case 'foreground': return foreground();
    case 'appPath': return appPath(req);
    case 'appIcon': return appIcon(req);
    default: throw new Error('unknown-command:' + req.cmd);
  }
}

var buffer = '';
send({ ready: true });
while (true) {
  var data = stdin.availableData; // blocks until input or EOF
  if (!data || data.length === 0) break;
  buffer += ObjC.unwrap($.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding)) || '';
  var idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    var line = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 1);
    if (!line.trim()) continue;
    var req;
    try { req = JSON.parse(line); } catch (e) { continue; }
    try {
      send({ id: req.id, ok: true, result: handle(req) });
    } catch (e) {
      send({ id: req.id, ok: false, error: String(e && e.message ? e.message : e) });
    }
  }
}
