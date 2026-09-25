// Platforms without a mouse layer yet (Windows is the next step, Linux dev machines).
#include "platform.h"

namespace clipshelf_mouse {

bool PlatformStart(Engine*, Sink, std::string* error) {
  if (error) *error = "unsupported";
  return false;
}
void PlatformStop() {}
bool PlatformRunning() { return false; }
void PlatformSetObserve(bool) {}
bool PlatformTrusted() { return false; }
bool PlatformPostKey(int, uint32_t, std::string* error) {
  if (error) *error = "unsupported";
  return false;
}
bool PlatformPostMedia(int, std::string* error) {
  if (error) *error = "unsupported";
  return false;
}
bool PlatformPostHotKey(int, std::string* error) {
  if (error) *error = "unsupported";
  return false;
}
bool PlatformClick(int, std::string* error) {
  if (error) *error = "unsupported";
  return false;
}
std::string PlatformFrontApp() { return ""; }

}  // namespace clipshelf_mouse
