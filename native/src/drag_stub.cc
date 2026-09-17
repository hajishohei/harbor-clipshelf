// Other platforms: the app falls back to Electron's own startDrag().
#include "drag.h"

namespace clipshelf {

bool StartFileDrag(void*, const std::vector<std::string>&, const std::vector<unsigned char>&, bool, DragDone,
                   std::string* error) {
  if (error) *error = "native drag is not supported on this platform";
  return false;
}

}  // namespace clipshelf
