// macOS: NSDraggingSession whose source allows move as well as copy, so
// Finder applies its usual rules (same volume → move, other volume → copy,
// ⌥ → copy, ⌘ → move) — the behaviour people know from Yoink.
#import <Cocoa/Cocoa.h>

#include "drag.h"

@interface ClipShelfDragSource : NSObject <NSDraggingSource>
- (instancetype)initWithDone:(clipshelf::DragDone)done allowMove:(BOOL)allowMove;
@end

@implementation ClipShelfDragSource {
  clipshelf::DragDone _done;
  BOOL _allowMove;
}

- (instancetype)initWithDone:(clipshelf::DragDone)done allowMove:(BOOL)allowMove {
  if ((self = [super init])) {
    _done = std::move(done);
    _allowMove = allowMove;
  }
  return self;
}

- (NSDragOperation)draggingSession:(NSDraggingSession*)session
    sourceOperationMaskForDraggingContext:(NSDraggingContext)context {
  if (context == NSDraggingContextOutsideApplication) {
    return _allowMove ? (NSDragOperationCopy | NSDragOperationMove | NSDragOperationLink | NSDragOperationGeneric)
                      : NSDragOperationCopy;
  }
  return NSDragOperationEvery;
}

- (BOOL)ignoreModifierKeysForDraggingSession:(NSDraggingSession*)session {
  return NO;
}

- (void)draggingSession:(NSDraggingSession*)session
           endedAtPoint:(NSPoint)screenPoint
              operation:(NSDragOperation)operation {
  clipshelf::DragResult result;
  if (operation & NSDragOperationMove) {
    result.operation = "move";
  } else if (operation & NSDragOperationCopy) {
    result.operation = "copy";
  } else if (operation & NSDragOperationLink) {
    result.operation = "link";
  } else if (operation & NSDragOperationGeneric) {
    result.operation = "generic";
  } else if (operation & NSDragOperationDelete) {
    result.operation = "move";  // dropped on the Trash
  } else {
    result.operation = "none";
  }
  // Report in the same top-left based coordinates Electron's screen API uses.
  NSScreen* primary = [[NSScreen screens] firstObject];
  CGFloat height = primary ? NSMaxY(primary.frame) : 0;
  result.x = screenPoint.x;
  result.y = height - screenPoint.y;
  if (_done) {
    clipshelf::DragDone done = std::move(_done);
    _done = nullptr;
    done(result);
  }
  // Balance the retain taken in StartFileDrag, once this method has returned.
  CFTypeRef me = (__bridge CFTypeRef)self;
  dispatch_async(dispatch_get_main_queue(), ^{
    CFRelease(me);
  });
}

@end

namespace clipshelf {

bool StartFileDrag(void* view_ptr,
                   const std::vector<std::string>& utf8_paths,
                   const std::vector<unsigned char>& icon_png,
                   bool allow_move,
                   DragDone done,
                   std::string* error) {
  @autoreleasepool {
    NSView* view = (__bridge NSView*)view_ptr;
    if (!view || ![view isKindOfClass:[NSView class]] || !view.window) {
      if (error) *error = "no window";
      return false;
    }

    NSImage* image = nil;
    if (!icon_png.empty()) {
      NSData* data = [NSData dataWithBytes:icon_png.data() length:icon_png.size()];
      image = [[NSImage alloc] initWithData:data];
    }

    NSWindow* window = view.window;
    NSPoint location = [window mouseLocationOutsideOfEventStream];
    NSPoint in_view = [view convertPoint:location fromView:nil];

    NSMutableArray<NSDraggingItem*>* items = [NSMutableArray array];
    CGFloat offset = 0;
    for (const auto& path : utf8_paths) {
      NSString* p = [NSString stringWithUTF8String:path.c_str()];
      if (!p) continue;
      NSURL* url = [NSURL fileURLWithPath:p];
      NSImage* item_image = image ?: [[NSWorkspace sharedWorkspace] iconForFile:p];
      NSSize size = item_image.size;
      if (size.width <= 0 || size.height <= 0 || size.width > 256 || size.height > 256) {
        size = NSMakeSize(64, 64);
        [item_image setSize:size];
      }
      NSDraggingItem* item = [[NSDraggingItem alloc] initWithPasteboardWriter:url];
      NSRect frame = NSMakeRect(in_view.x - size.width / 2 + offset, in_view.y - size.height / 2 - offset,
                                size.width, size.height);
      [item setDraggingFrame:frame contents:item_image];
      [items addObject:item];
      offset += 4;
    }
    if (items.count == 0) {
      if (error) *error = "no valid paths";
      return false;
    }

    NSEvent* event = [NSEvent mouseEventWithType:NSEventTypeLeftMouseDragged
                                        location:location
                                   modifierFlags:[NSEvent modifierFlags]
                                       timestamp:[[NSProcessInfo processInfo] systemUptime]
                                    windowNumber:window.windowNumber
                                         context:nil
                                     eventNumber:0
                                      clickCount:1
                                        pressure:1.0];
    if (!event) {
      if (error) *error = "could not create drag event";
      return false;
    }

    ClipShelfDragSource* source = [[ClipShelfDragSource alloc] initWithDone:std::move(done) allowMove:allow_move ? YES : NO];
    // Keep the source alive until the session ends (released in endedAtPoint).
    CFRetain((__bridge CFTypeRef)source);
    NSDraggingSession* session = nil;
    @try {
      session = [view beginDraggingSessionWithItems:items event:event source:source];
    } @catch (NSException* exception) {
      session = nil;
    }
    if (!session) {
      CFRelease((__bridge CFTypeRef)source);
      if (error) *error = "drag session was refused";
      return false;
    }
    session.animatesToStartingPositionsOnCancelOrFail = YES;
    session.draggingFormation = NSDraggingFormationStack;
    return true;
  }
}

}  // namespace clipshelf
