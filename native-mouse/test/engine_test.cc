// g++ -std=c++17 -I../src ../src/engine.cc engine_test.cc -o /tmp/engine_test && /tmp/engine_test
// (run by `node scripts/test-native-engine.js`)
#include <cassert>
#include <cstdio>
#include <string>

#include "engine.h"

using namespace clipshelf_mouse;

static int failures = 0;
#define CHECK(cond)                                                   \
  do {                                                                \
    if (!(cond)) {                                                    \
      std::fprintf(stderr, "FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); \
      failures++;                                                     \
    }                                                                 \
  } while (0)

static Input down(int b, double t, double x = 100, double y = 100) {
  Input i;
  i.type = EvType::Down;
  i.button = b;
  i.t_ms = t;
  i.x = x;
  i.y = y;
  return i;
}
static Input up(int b, double t, double x = 100, double y = 100) {
  Input i = down(b, t, x, y);
  i.type = EvType::Up;
  return i;
}
static Input drag(int b, double t, double x, double y) {
  Input i = down(b, t, x, y);
  i.type = EvType::Drag;
  return i;
}
static Input wheel(double dy, double t, double dx = 0, uint32_t mods = 0, bool continuous = false) {
  Input i;
  i.type = EvType::Scroll;
  i.dy = dy;
  i.dx = dx;
  i.t_ms = t;
  i.mods = mods;
  i.continuous = continuous;
  return i;
}

static Config cfg(std::initializer_list<const char*> keys) {
  Config c;
  c.enabled = true;
  for (auto k : keys) c.profiles[""].insert(k);
  return c;
}

int main() {
  // 1. middle + wheel → desktop switch; middle alone → the normal click comes back
  {
    Engine e;
    e.Configure(cfg({"middle.scrollUp", "middle.scrollDown"}));
    Decision d = e.Handle(down(2, 0));
    CHECK(d.swallow);
    d = e.Handle(wheel(-1, 10));
    CHECK(d.swallow && d.emits.size() == 1 && d.emits[0].key == "middle.scrollDown");
    d = e.Handle(wheel(-1, 50));  // inside the cool-down: hidden, no second switch
    CHECK(d.swallow && d.emits.empty());
    d = e.Handle(wheel(-1, 400));
    CHECK(d.emits.size() == 1);
    d = e.Handle(wheel(1, 410));  // direction change is immediate
    CHECK(d.emits.size() == 1 && d.emits[0].key == "middle.scrollUp");
    d = e.Handle(up(2, 500));
    CHECK(d.swallow && !d.replay_click && d.emits.empty());

    d = e.Handle(down(2, 1000));
    CHECK(d.swallow);
    d = e.Handle(up(2, 1080));
    CHECK(d.swallow && d.replay_click && d.replay_button == 2);
  }

  // 2. wheel without a button is untouched; left / right never captured
  {
    Engine e;
    e.Configure(cfg({"middle.scrollUp", "left.click", "right.click"}));
    CHECK(!e.Handle(wheel(1, 0)).swallow);
    CHECK(!e.Handle(down(0, 0)).swallow);
    CHECK(!e.Handle(down(1, 0)).swallow);
  }

  // 3. click / hold / gestures on the back button
  {
    Engine e;
    e.Configure(cfg({"back.click", "back.hold", "back.dragUp", "back.dragLeft"}));
    e.Handle(down(3, 0));
    Decision d = e.Handle(up(3, 100));
    CHECK(d.emits.size() == 1 && d.emits[0].key == "back.click" && !d.replay_click);
    e.Handle(down(3, 1000));
    d = e.Handle(up(3, 1600));
    CHECK(d.emits.size() == 1 && d.emits[0].key == "back.hold");
    e.Handle(down(3, 2000, 100, 100));
    e.Handle(drag(3, 2050, 100, 80));
    d = e.Handle(up(3, 2100, 105, 30));
    CHECK(d.emits.size() == 1 && d.emits[0].key == "back.dragUp");
    e.Handle(down(3, 3000, 100, 100));
    d = e.Handle(up(3, 3100, 150, 100));  // dragRight not assigned: nothing, no click
    CHECK(d.swallow && d.emits.empty() && !d.replay_click);
  }

  // 4. unassigned buttons pass through; forward untouched when only back is used
  {
    Engine e;
    e.Configure(cfg({"back.click"}));
    CHECK(!e.Handle(down(4, 0)).swallow);
    CHECK(!e.Handle(up(4, 10)).swallow);
    CHECK(!e.Handle(down(2, 0)).swallow);
  }

  // 5. per-app profile overrides the default one
  {
    Engine e;
    Config c = cfg({"back.click"});
    c.profiles["com.google.Chrome"] = {};  // Chrome: back button stays "back"
    e.Configure(c);
    e.SetFrontApp("com.google.Chrome");
    CHECK(!e.Handle(down(3, 0)).swallow);
    e.Handle(up(3, 10));
    e.SetFrontApp("com.apple.finder");
    CHECK(e.Handle(down(3, 100)).swallow);
    CHECK(e.Handle(up(3, 150)).emits.size() == 1);
  }

  // 6. modifier + wheel, tilt, trackpad ignored
  {
    Engine e;
    e.Configure(cfg({"ctrl+alt.scrollDown", "tiltLeft"}));
    Decision d = e.Handle(wheel(-1, 0, 0, kCtrl | kAlt));
    CHECK(d.swallow && d.emits.size() == 1 && d.emits[0].key == "ctrl+alt.scrollDown");
    d = e.Handle(wheel(-1, 1000, 0, kAlt));
    CHECK(!d.swallow && d.emits.empty());
    d = e.Handle(wheel(0, 2000, -1));
    CHECK(d.swallow && d.emits.size() == 1 && d.emits[0].key == "tiltLeft");
    d = e.Handle(wheel(0, 2050, -1));
    CHECK(d.swallow && d.emits.empty());
    d = e.Handle(wheel(0, 3000, 1));
    CHECK(!d.swallow);
    d = e.Handle(wheel(-3, 4000, 0, kCtrl | kAlt, true));
    CHECK(!d.swallow);
  }

  // 7. held button with no scroll keys lets the wheel through; disabled engine passes everything
  {
    Engine e;
    e.Configure(cfg({"middle.click"}));
    CHECK(e.Handle(down(2, 0)).swallow);
    CHECK(!e.Handle(wheel(1, 10)).swallow);
    Decision d = e.Handle(up(2, 50));
    CHECK(d.emits.size() == 1 && d.emits[0].key == "middle.click");
    Config off = cfg({"middle.click"});
    off.enabled = false;
    e.Configure(off);
    CHECK(!e.Handle(down(2, 100)).swallow);
    CHECK(!e.Handle(up(2, 110)).swallow);
  }

  // 8. a lost release does not lock the button
  {
    Engine e;
    e.Configure(cfg({"middle.click"}));
    e.Handle(down(2, 0));
    CHECK(e.Handle(down(2, 20000)).swallow);
    CHECK(e.Handle(up(2, 20050)).emits.size() == 1);
  }

  CHECK(ButtonName(7) == "b7");
  CHECK(ModsName(kCmd | kCtrl | kShift) == "ctrl+shift+cmd");

  if (failures) {
    std::fprintf(stderr, "%d check(s) failed\n", failures);
    return 1;
  }
  std::printf("engine: all checks passed\n");
  return 0;
}
