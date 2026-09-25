// HarboR ClipShelf mouse engine: turns raw mouse events into "triggers"
// (e.g. "middle.scrollDown" = wheel down while the wheel button is held) and
// decides, for every event, whether the OS should still see it.
//
// Platform-independent on purpose: mouse_mac.mm / mouse_win.cc only convert
// OS events into Input and act on the Decision, so all of the gesture logic
// is covered by native-mouse/test/engine_test.cc on any machine.
#pragma once
#include <cstdint>
#include <mutex>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace clipshelf_mouse {

enum Mods : uint32_t { kCtrl = 1, kAlt = 2, kShift = 4, kCmd = 8 };

enum class EvType { Down, Up, Drag, Scroll };

struct Input {
  EvType type = EvType::Down;
  // 0 left, 1 right, 2 middle (wheel button), 3 back, 4 forward, 5.. extra
  int button = 0;
  double x = 0, y = 0;  // screen position (top-left origin, points)
  // Scroll: physical direction, already corrected for "natural scrolling".
  // dy > 0 = wheel rolled up (away from you), dx > 0 = tilted right.
  double dx = 0, dy = 0;
  bool continuous = false;  // trackpad / Magic Mouse (ignored for triggers)
  uint32_t mods = 0;        // Mods bit set
  double t_ms = 0;          // monotonic time
};

struct Emit {
  std::string key;  // "middle.scrollDown", "back.click", "tiltLeft", "alt.scrollUp" ...
  double x = 0, y = 0;
};

struct Decision {
  bool swallow = false;       // hide the event from the OS / apps
  bool replay_click = false;  // post a normal click of `replay_button` (nothing was bound to it after all)
  int replay_button = 0;
  double replay_x = 0, replay_y = 0;
  std::vector<Emit> emits;
};

struct Config {
  bool enabled = false;
  // profile id ("" = everything else) → trigger keys that have an action
  std::unordered_map<std::string, std::unordered_set<std::string>> profiles;
  double hold_ms = 450;          // press longer than this = "hold"
  double gesture_px = 40;        // move farther than this while held = drag gesture
  double scroll_cooldown_ms = 250;  // min gap between two scroll triggers (desktop animations)
};

std::string ButtonName(int button);            // 2 → "middle", 3 → "back", 7 → "b7"
std::string ModsName(uint32_t mods);           // kCtrl|kAlt → "ctrl+alt" (fixed order)

class Engine {
 public:
  void Configure(const Config& config);
  void SetFrontApp(const std::string& id);
  std::string FrontApp();
  bool Enabled();
  Decision Handle(const Input& in);

 private:
  const std::unordered_set<std::string>* ProfileLocked();
  bool HasLocked(const std::string& key);
  bool HasPrefixLocked(const std::string& prefix);
  bool EmitScrollLocked(const std::string& base, const Input& in, Decision* d);

  std::mutex mu_;
  Config config_;
  std::string front_;

  struct Held {
    bool active = false;
    int button = -1;
    std::string name;
    double sx = 0, sy = 0, x = 0, y = 0;
    double t0 = 0;
    bool used = false;  // a scroll trigger fired while it was held
  } held_;
  double last_scroll_emit_ = -1e12;
  int last_scroll_dir_ = 0;
};

}  // namespace clipshelf_mouse
