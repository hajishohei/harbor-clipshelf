#include "engine.h"

#include <cmath>

namespace clipshelf_mouse {

std::string ButtonName(int button) {
  switch (button) {
    case 0: return "left";
    case 1: return "right";
    case 2: return "middle";
    case 3: return "back";
    case 4: return "forward";
    default: return "b" + std::to_string(button);
  }
}

std::string ModsName(uint32_t mods) {
  std::string out;
  auto add = [&](uint32_t bit, const char* name) {
    if (!(mods & bit)) return;
    if (!out.empty()) out += "+";
    out += name;
  };
  add(kCtrl, "ctrl");
  add(kAlt, "alt");
  add(kShift, "shift");
  add(kCmd, "cmd");
  return out;
}

void Engine::Configure(const Config& config) {
  std::lock_guard<std::mutex> lock(mu_);
  config_ = config;
  if (!config_.enabled) held_ = Held();
}

void Engine::SetFrontApp(const std::string& id) {
  std::lock_guard<std::mutex> lock(mu_);
  front_ = id;
}

std::string Engine::FrontApp() {
  std::lock_guard<std::mutex> lock(mu_);
  return front_;
}

bool Engine::Enabled() {
  std::lock_guard<std::mutex> lock(mu_);
  return config_.enabled;
}

const std::unordered_set<std::string>* Engine::ProfileLocked() {
  auto it = config_.profiles.find(front_);
  if (it == config_.profiles.end()) it = config_.profiles.find("");
  return it == config_.profiles.end() ? nullptr : &it->second;
}

bool Engine::HasLocked(const std::string& key) {
  const auto* p = ProfileLocked();
  return p && p->count(key) > 0;
}

bool Engine::HasPrefixLocked(const std::string& prefix) {
  const auto* p = ProfileLocked();
  if (!p) return false;
  for (const auto& k : *p) {
    if (k.compare(0, prefix.size(), prefix) == 0) return true;
  }
  return false;
}

// One wheel notch → at most one trigger; repeated notches in the same
// direction are ignored for `scroll_cooldown_ms` so one flick of the wheel
// doesn't fly across five desktops.
bool Engine::EmitScrollLocked(const std::string& base, const Input& in, Decision* d) {
  std::string dir;
  int code = 0;
  if (std::fabs(in.dy) >= std::fabs(in.dx)) {
    if (in.dy == 0) return false;
    dir = in.dy > 0 ? "scrollUp" : "scrollDown";
    code = in.dy > 0 ? 1 : 2;
  } else {
    dir = in.dx > 0 ? "scrollRight" : "scrollLeft";
    code = in.dx > 0 ? 3 : 4;
  }
  const std::string key = base.empty() ? dir : base + "." + dir;
  if (!HasLocked(key)) return false;
  const bool same = code == last_scroll_dir_;
  if (same && in.t_ms - last_scroll_emit_ < config_.scroll_cooldown_ms) return true;  // swallowed, no repeat
  last_scroll_emit_ = in.t_ms;
  last_scroll_dir_ = code;
  d->emits.push_back({key, in.x, in.y});
  return true;
}

Decision Engine::Handle(const Input& in) {
  std::lock_guard<std::mutex> lock(mu_);
  Decision d;
  if (!config_.enabled) {
    held_ = Held();
    return d;
  }

  switch (in.type) {
    case EvType::Down: {
      // The primary / secondary buttons are never taken over.
      if (in.button < 2) return d;
      // A press that never got its release (e.g. lost while the tap was
      // disabled) must not block the button forever.
      if (held_.active && in.t_ms - held_.t0 > 10000) held_ = Held();
      if (held_.active) return d;  // chords: leave the second button alone
      const std::string name = ButtonName(in.button);
      if (!HasPrefixLocked(name + ".")) return d;
      held_.active = true;
      held_.button = in.button;
      held_.name = name;
      held_.sx = held_.x = in.x;
      held_.sy = held_.y = in.y;
      held_.t0 = in.t_ms;
      held_.used = false;
      last_scroll_dir_ = 0;
      d.swallow = true;
      return d;
    }

    case EvType::Drag: {
      if (held_.active && in.button == held_.button) {
        held_.x = in.x;
        held_.y = in.y;
      }
      return d;  // the pointer keeps moving normally
    }

    case EvType::Up: {
      if (!held_.active || in.button != held_.button) return d;
      Held h = held_;
      held_ = Held();
      d.swallow = true;  // its press was hidden, so hide the release too
      if (h.used) return d;
      const double mx = in.x - h.sx;
      const double my = in.y - h.sy;
      if (std::hypot(mx, my) >= config_.gesture_px) {
        std::string dir;
        if (std::fabs(mx) >= std::fabs(my)) dir = mx > 0 ? "dragRight" : "dragLeft";
        else dir = my > 0 ? "dragDown" : "dragUp";
        const std::string key = h.name + "." + dir;
        if (HasLocked(key)) d.emits.push_back({key, in.x, in.y});
        return d;  // a drag is never turned back into a click
      }
      const std::string hold = h.name + ".hold";
      const std::string click = h.name + ".click";
      if (in.t_ms - h.t0 >= config_.hold_ms && HasLocked(hold)) {
        d.emits.push_back({hold, in.x, in.y});
      } else if (HasLocked(click)) {
        d.emits.push_back({click, in.x, in.y});
      } else {
        // Only scroll / gesture / hold were assigned and none happened:
        // give the app its ordinary click back.
        d.replay_click = true;
        d.replay_button = h.button;
        d.replay_x = in.x;
        d.replay_y = in.y;
      }
      return d;
    }

    case EvType::Scroll: {
      if (in.continuous) return d;  // trackpads keep their own gestures
      if (held_.active) {
        if (!HasPrefixLocked(held_.name + ".scroll")) return d;
        d.swallow = true;
        Input at = in;
        at.x = held_.x;
        at.y = held_.y;
        if (EmitScrollLocked(held_.name, at, &d)) held_.used = true;
        return d;
      }
      if (in.mods) {
        if (EmitScrollLocked(ModsName(in.mods), in, &d)) d.swallow = true;
        return d;
      }
      // Tilt wheel: horizontal-only notches with nothing held.
      if (in.dx != 0 && in.dy == 0) {
        const std::string key = in.dx > 0 ? "tiltRight" : "tiltLeft";
        if (!HasLocked(key)) return d;
        d.swallow = true;
        const int code = in.dx > 0 ? 5 : 6;
        if (code == last_scroll_dir_ && in.t_ms - last_scroll_emit_ < config_.scroll_cooldown_ms) return d;
        last_scroll_emit_ = in.t_ms;
        last_scroll_dir_ = code;
        d.emits.push_back({key, in.x, in.y});
      }
      return d;
    }
  }
  return d;
}

}  // namespace clipshelf_mouse
