// OS side of the mouse engine. One implementation per platform
// (mouse_mac.mm, mouse_stub.cc; Windows comes next).
#pragma once
#include <cstdint>
#include <functional>
#include <string>

#include "engine.h"

namespace clipshelf_mouse {

struct Event {
  std::string type;    // "trigger" | "press" | "stopped"
  std::string key;     // trigger key ("middle.scrollDown")
  std::string app;     // profile id of the front app (bundle id / exe name)
  std::string button;  // "press": button name ("middle", "back", "b5" ...)
  double x = 0, y = 0;
};

using Sink = std::function<void(const Event&)>;

// Starts watching the mouse. `error` gets "accessibility" when the OS refused
// (permission missing) or "unsupported".
bool PlatformStart(Engine* engine, Sink sink, std::string* error);
void PlatformStop();
bool PlatformRunning();
void PlatformSetObserve(bool on);  // report every extra-button press ("press" events)
bool PlatformTrusted();

// Actions (called on the JS main thread).
bool PlatformPostKey(int key_code, uint32_t mods, std::string* error);
bool PlatformPostMedia(int code, std::string* error);
bool PlatformPostHotKey(int hotkey, std::string* error);  // macOS symbolic hot key (Spaces, Mission Control…)
bool PlatformClick(int button, std::string* error);
std::string PlatformFrontApp();

}  // namespace clipshelf_mouse
