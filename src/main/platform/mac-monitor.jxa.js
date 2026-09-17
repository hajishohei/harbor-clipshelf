// HarboR ClipShelf — macOS monitor (JavaScript for Automation).
// Streams tab-separated events on stdout; needs no special permission.
//   READY  <changeCount>
//   CLIP   <changeCount> <pid> <bundleId> <name>   (clipboard changed)
//   FRONT  <pid> <bundleId> <name>                 (frontmost app changed)
//   CAPS   <0|1>                                   (Caps Lock state)
//   DRAG   1 <files|content> <fn 0|1> <pid>         (a drag started somewhere)
//   DRAG   0                                       (the mouse button was released)
ObjC.import('Foundation');
ObjC.import('AppKit');

var out = $.NSFileHandle.fileHandleWithStandardOutput;
function send(line) {
  out.writeData($(line + '\n').dataUsingEncoding($.NSUTF8StringEncoding));
}
function enc(s) {
  return encodeURIComponent(s || '');
}

var getppid = null;
try {
  ObjC.bindFunction('getppid', ['int', []]);
  getppid = function () { return $.getppid(); };
} catch (e) {
  getppid = null;
}

function frontInfo() {
  try {
    var app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
    return {
      pid: app.processIdentifier,
      bundleId: ObjC.unwrap(app.bundleIdentifier) || '',
      name: ObjC.unwrap(app.localizedName) || ''
    };
  } catch (e) {
    return { pid: 0, bundleId: '', name: '' };
  }
}

// NSWorkspace only refreshes frontmostApplication when the run loop gets to
// process its notifications, so wait by running the loop instead of delay().
function idle(seconds) {
  var t0 = Date.now();
  $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(seconds));
  var left = seconds - (Date.now() - t0) / 1000;
  if (left > 0.01) delay(left); // loop had no sources and returned at once
}

var pb = $.NSPasteboard.generalPasteboard;
// The system drag pasteboard is rewritten whenever any app starts a drag.
var dragPb = $.NSPasteboard.pasteboardWithName($('Apple CFPasteboard drag'));
var lastDragCount = dragPb.changeCount;
var dragging = false;
var NSFunctionKeyMask = 8388608;
function dragKind() {
  try {
    var types = ObjC.deepUnwrap(dragPb.types) || [];
    for (var i = 0; i < types.length; i++) {
      if (types[i] === 'public.file-url' || types[i] === 'NSFilenamesPboardType') return 'files';
    }
  } catch (e) { /* ignore */ }
  return 'content';
}
var lastCount = pb.changeCount;
var lastCaps = -1;
var lastFront = -1;
var tick = 0;
send('READY\t' + lastCount);

while (true) {
  tick++;
  if (getppid && tick % 8 === 0 && getppid() === 1) break; // parent is gone
  var count = pb.changeCount;
  if (count !== lastCount) {
    lastCount = count;
    var f = frontInfo();
    send('CLIP\t' + count + '\t' + f.pid + '\t' + enc(f.bundleId) + '\t' + enc(f.name));
  }
  var fr = frontInfo();
  if (fr.pid !== lastFront) {
    lastFront = fr.pid;
    send('FRONT\t' + fr.pid + '\t' + enc(fr.bundleId) + '\t' + enc(fr.name));
  }
  var caps = ($.NSEvent.modifierFlags & 65536) ? 1 : 0; // NSEventModifierFlagCapsLock
  if (caps !== lastCaps) {
    lastCaps = caps;
    send('CAPS\t' + caps);
  }
  var buttons = $.NSEvent.pressedMouseButtons;
  var dc = dragPb.changeCount;
  if ((buttons & 1) && dc !== lastDragCount && !dragging) {
    dragging = true;
    var fnDown = ($.NSEvent.modifierFlags & NSFunctionKeyMask) ? 1 : 0;
    send('DRAG\t1\t' + dragKind() + '\t' + fnDown + '\t' + frontInfo().pid);
  }
  lastDragCount = dc;
  if (dragging && !(buttons & 1)) {
    dragging = false;
    send('DRAG\t0');
  }
  idle(buttons & 1 ? 0.04 : 0.2);
}
