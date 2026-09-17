// HarboR ClipShelf — prints an app's (or any file's) real icon as base64 PNG.
//   osascript -l JavaScript mac-appicon.jxa.js <path> [size]
// Runs as its own short-lived process so a slow icon lookup can never block
// the window / paste helper.
ObjC.import('Foundation');
ObjC.import('AppKit');

function run(argv) {
  var p = argv[0];
  var size = Math.max(16, Math.min(256, Number(argv[1]) || 64));
  if (!p) return '';
  var icon = $.NSWorkspace.sharedWorkspace.iconForFile($(p));
  if (!icon || icon.isNil()) return '';
  icon.setSize($.NSMakeSize(size, size));
  var cg = icon.CGImageForProposedRectContextHints(null, $(), $());
  if (!cg) return '';
  var rep = $.NSBitmapImageRep.alloc.initWithCGImage(cg);
  if (!rep || rep.isNil()) return '';
  var png = rep.representationUsingTypeProperties(4, $({})); // NSBitmapImageFileTypePNG
  if (!png || png.isNil()) return '';
  return ObjC.unwrap(png.base64EncodedStringWithOptions(0));
}
