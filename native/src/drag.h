// HarboR ClipShelf native drag: starts a file drag that lets the drop target
// move (not only copy) the files, exactly like dragging them in Finder /
// Explorer, and reports how the drag ended.
#pragma once
#include <functional>
#include <string>
#include <vector>

namespace clipshelf {

struct DragResult {
  // "none" (cancelled / nobody accepted), "copy", "move", "link", "generic"
  std::string operation;
  double x = 0;
  double y = 0;
};

using DragDone = std::function<void(const DragResult&)>;

// `view` is the pointer inside BrowserWindow.getNativeWindowHandle()
// (NSView* on macOS, HWND on Windows). `icon_png` may be empty.
// Returns false (and never calls `done`) if the drag could not start.
// macOS: returns immediately, `done` runs later on the main thread.
// Windows: runs the modal drag loop and calls `done` before returning.
// `allow_move`: offer "move" to the drop target (shelf, like Yoink) or only
// "copy" (clipboard history, like Paste).
bool StartFileDrag(void* view,
                   const std::vector<std::string>& utf8_paths,
                   const std::vector<unsigned char>& icon_png,
                   bool allow_move,
                   DragDone done,
                   std::string* error);

}  // namespace clipshelf
