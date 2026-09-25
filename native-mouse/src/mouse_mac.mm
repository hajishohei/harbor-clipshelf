// macOS: a CGEventTap on its own thread feeds the engine; hidden events are
// dropped, triggers go to JS. Actions post synthetic key / media / mouse
// events. Needs the Accessibility permission (ClipShelf already asks for it).
#import <Cocoa/Cocoa.h>
#import <ApplicationServices/ApplicationServices.h>

#include <dlfcn.h>

#include <atomic>
#include <chrono>
#include <future>
#include <memory>
#include <mutex>
#include <thread>

#include "platform.h"

namespace clipshelf_mouse {
namespace {

// Stamped on every event we post ourselves so the tap lets it through.
constexpr int64_t kMarker = 0x43534D53;  // "CSMS"

Engine* g_engine = nullptr;
Sink g_sink;
std::mutex g_sink_mu;
CFMachPortRef g_tap = nullptr;
CFRunLoopRef g_loop = nullptr;
std::thread g_thread;
std::atomic<bool> g_running{false};
std::atomic<bool> g_observe{false};
id g_observer = nil;

double NowMs() {
  using namespace std::chrono;
  return duration<double, std::milli>(steady_clock::now().time_since_epoch()).count();
}

uint32_t ModsFromFlags(CGEventFlags f) {
  uint32_t m = 0;
  if (f & kCGEventFlagMaskControl) m |= kCtrl;
  if (f & kCGEventFlagMaskAlternate) m |= kAlt;
  if (f & kCGEventFlagMaskShift) m |= kShift;
  if (f & kCGEventFlagMaskCommand) m |= kCmd;
  return m;
}

CGEventFlags FlagsFromMods(uint32_t m) {
  CGEventFlags f = 0;
  if (m & kCtrl) f |= kCGEventFlagMaskControl;
  if (m & kAlt) f |= kCGEventFlagMaskAlternate;
  if (m & kShift) f |= kCGEventFlagMaskShift;
  if (m & kCmd) f |= kCGEventFlagMaskCommand;
  return f;
}

std::string AppId(NSRunningApplication* app) {
  if (!app) return "";
  NSString* s = app.bundleIdentifier ?: app.localizedName;
  return s ? std::string(s.UTF8String ?: "") : "";
}

void Deliver(const Event& e) {
  std::lock_guard<std::mutex> lock(g_sink_mu);
  if (g_sink) g_sink(e);
}

double Sign(double v) {
  return v > 0 ? 1 : v < 0 ? -1 : 0;
}

void PostClickAt(int button, CGPoint p) {
  CGEventSourceRef src = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
  CGEventType down_type = button == 0 ? kCGEventLeftMouseDown : button == 1 ? kCGEventRightMouseDown : kCGEventOtherMouseDown;
  CGEventType up_type = button == 0 ? kCGEventLeftMouseUp : button == 1 ? kCGEventRightMouseUp : kCGEventOtherMouseUp;
  CGMouseButton mb = static_cast<CGMouseButton>(button);
  CGEventRef down = CGEventCreateMouseEvent(src, down_type, p, mb);
  CGEventRef up = CGEventCreateMouseEvent(src, up_type, p, mb);
  for (CGEventRef ev : {down, up}) {
    if (!ev) continue;
    CGEventSetIntegerValueField(ev, kCGMouseEventButtonNumber, button);
    CGEventSetIntegerValueField(ev, kCGMouseEventClickState, 1);
    CGEventSetIntegerValueField(ev, kCGEventSourceUserData, kMarker);
    CGEventPost(kCGHIDEventTap, ev);
    CFRelease(ev);
  }
  if (src) CFRelease(src);
}

CGEventRef TapCallback(CGEventTapProxy /*proxy*/, CGEventType type, CGEventRef ev, void* /*info*/) {
  if (type == kCGEventTapDisabledByTimeout || type == kCGEventTapDisabledByUserInput) {
    if (g_tap && g_running) CGEventTapEnable(g_tap, true);
    return ev;
  }
  if (!g_engine || !ev) return ev;
  if (CGEventGetIntegerValueField(ev, kCGEventSourceUserData) == kMarker) return ev;

  Input in;
  in.t_ms = NowMs();
  CGPoint p = CGEventGetLocation(ev);
  in.x = p.x;
  in.y = p.y;
  in.mods = ModsFromFlags(CGEventGetFlags(ev));
  switch (type) {
    case kCGEventOtherMouseDown:
      in.type = EvType::Down;
      break;
    case kCGEventOtherMouseUp:
      in.type = EvType::Up;
      break;
    case kCGEventOtherMouseDragged:
      in.type = EvType::Drag;
      break;
    case kCGEventScrollWheel: {
      in.type = EvType::Scroll;
      in.continuous = CGEventGetIntegerValueField(ev, kCGScrollWheelEventIsContinuous) != 0;
      double a1 = static_cast<double>(CGEventGetIntegerValueField(ev, kCGScrollWheelEventDeltaAxis1));
      double a2 = static_cast<double>(CGEventGetIntegerValueField(ev, kCGScrollWheelEventDeltaAxis2));
      // Slow notches can report 0 lines; the fixed-point value still has the direction.
      if (a1 == 0) a1 = CGEventGetDoubleValueField(ev, kCGScrollWheelEventFixedPtDeltaAxis1);
      if (a2 == 0) a2 = CGEventGetDoubleValueField(ev, kCGScrollWheelEventFixedPtDeltaAxis2);
      bool inverted = false;
      @autoreleasepool {
        NSEvent* ne = [NSEvent eventWithCGEvent:ev];
        inverted = ne && ne.isDirectionInvertedFromDevice;
      }
      const double flip = inverted ? -1 : 1;
      in.dy = Sign(a1) * flip;   // + = wheel rolled up
      in.dx = -Sign(a2) * flip;  // Axis2 > 0 scrolls left → tilt left
      break;
    }
    default:
      return ev;
  }
  if (in.type == EvType::Down || in.type == EvType::Up || in.type == EvType::Drag) {
    in.button = static_cast<int>(CGEventGetIntegerValueField(ev, kCGMouseEventButtonNumber));
  }

  if (in.type == EvType::Down && g_observe) {
    Event e;
    e.type = "press";
    e.button = ButtonName(in.button);
    e.app = g_engine->FrontApp();
    e.x = in.x;
    e.y = in.y;
    Deliver(e);
  }

  Decision d = g_engine->Handle(in);
  if (!d.emits.empty()) {
    const std::string app = g_engine->FrontApp();
    for (const auto& em : d.emits) {
      Event e;
      e.type = "trigger";
      e.key = em.key;
      e.app = app;
      e.x = em.x;
      e.y = em.y;
      Deliver(e);
    }
  }
  if (d.replay_click) PostClickAt(d.replay_button, CGPointMake(d.replay_x, d.replay_y));
  return d.swallow ? nullptr : ev;
}

// ---- symbolic hot keys (the shortcuts in System Settings → Keyboard) ----
typedef CGError (*GetHotKeyFn)(int, unichar*, unichar*, uint32_t*);
typedef bool (*IsHotKeyEnabledFn)(int);
typedef CGError (*SetHotKeyEnabledFn)(int, bool);
typedef CGError (*SetHotKeyValueFn)(int, unichar, unichar, uint32_t);

template <typename T>
T Sym(const char* name) {
  return reinterpret_cast<T>(dlsym(RTLD_DEFAULT, name));
}

CGEventFlags ExtraFlagsFor(int code) {
  switch (code) {
    case 123: case 124: case 125: case 126:  // arrows
      return kCGEventFlagMaskNumericPad | kCGEventFlagMaskSecondaryFn;
    case 115: case 119: case 116: case 121: case 117:  // home end pgup pgdn fwd-delete
    case 122: case 120: case 99: case 118: case 96: case 97: case 98: case 100: case 101: case 109: case 103: case 111:  // F1-F12
    case 105: case 107: case 113: case 106: case 64: case 79: case 80: case 90:  // F13-F20
      return kCGEventFlagMaskSecondaryFn;
    default:
      return 0;
  }
}

bool PostKeyFlags(int code, CGEventFlags flags, std::string* error) {
  CGEventSourceRef src = CGEventSourceCreate(kCGEventSourceStateHIDSystemState);
  CGEventRef down = CGEventCreateKeyboardEvent(src, static_cast<CGKeyCode>(code), true);
  CGEventRef up = CGEventCreateKeyboardEvent(src, static_cast<CGKeyCode>(code), false);
  if (!down || !up) {
    if (down) CFRelease(down);
    if (up) CFRelease(up);
    if (src) CFRelease(src);
    if (error) *error = "could not create key event";
    return false;
  }
  flags |= ExtraFlagsFor(code);
  for (CGEventRef ev : {down, up}) {
    CGEventSetFlags(ev, flags);
    CGEventSetIntegerValueField(ev, kCGEventSourceUserData, kMarker);
    CGEventPost(kCGHIDEventTap, ev);
    CFRelease(ev);
  }
  if (src) CFRelease(src);
  return true;
}

}  // namespace

bool PlatformStart(Engine* engine, Sink sink, std::string* error) {
  if (g_running) return true;
  if (!AXIsProcessTrusted()) {
    if (error) *error = "accessibility";
    return false;
  }
  CGEventMask mask = CGEventMaskBit(kCGEventOtherMouseDown) | CGEventMaskBit(kCGEventOtherMouseUp) |
                     CGEventMaskBit(kCGEventOtherMouseDragged) | CGEventMaskBit(kCGEventScrollWheel);
  g_engine = engine;
  CFMachPortRef tap = CGEventTapCreate(kCGSessionEventTap, kCGHeadInsertEventTap, kCGEventTapOptionDefault, mask,
                                       TapCallback, nullptr);
  if (!tap) {
    g_engine = nullptr;
    if (error) *error = "accessibility";
    return false;
  }
  {
    std::lock_guard<std::mutex> lock(g_sink_mu);
    g_sink = std::move(sink);
  }
  g_tap = tap;
  engine->SetFrontApp(AppId([[NSWorkspace sharedWorkspace] frontmostApplication]));
  g_observer = [[[NSWorkspace sharedWorkspace] notificationCenter]
      addObserverForName:NSWorkspaceDidActivateApplicationNotification
                  object:nil
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(NSNotification* note) {
                NSRunningApplication* app = note.userInfo[NSWorkspaceApplicationKey];
                if (g_engine) g_engine->SetFrontApp(AppId(app));
              }];

  g_running = true;
  auto ready = std::make_shared<std::promise<void>>();
  std::future<void> started = ready->get_future();
  g_thread = std::thread([ready]() {
    @autoreleasepool {
      g_loop = CFRunLoopGetCurrent();
      CFRetain(g_loop);
      CFRunLoopSourceRef source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, g_tap, 0);
      CFRunLoopAddSource(g_loop, source, kCFRunLoopCommonModes);
      CGEventTapEnable(g_tap, true);
      ready->set_value();
      // Short slices so a stop request can never be missed.
      while (g_running) CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.5, false);
      CFRunLoopRemoveSource(g_loop, source, kCFRunLoopCommonModes);
      CFRelease(source);
    }
  });
  started.wait();
  return true;
}

void PlatformStop() {
  if (!g_running) return;
  g_running = false;
  if (g_tap) CGEventTapEnable(g_tap, false);
  if (g_loop) CFRunLoopStop(g_loop);
  if (g_thread.joinable()) g_thread.join();
  if (g_loop) {
    CFRelease(g_loop);
    g_loop = nullptr;
  }
  if (g_tap) {
    CFMachPortInvalidate(g_tap);
    CFRelease(g_tap);
    g_tap = nullptr;
  }
  if (g_observer) {
    [[[NSWorkspace sharedWorkspace] notificationCenter] removeObserver:g_observer];
    g_observer = nil;
  }
  {
    std::lock_guard<std::mutex> lock(g_sink_mu);
    g_sink = nullptr;
  }
  g_engine = nullptr;
}

bool PlatformRunning() {
  return g_running;
}

void PlatformSetObserve(bool on) {
  g_observe = on;
}

bool PlatformTrusted() {
  return AXIsProcessTrusted();
}

bool PlatformPostKey(int key_code, uint32_t mods, std::string* error) {
  if (key_code < 0 || key_code > 255) {
    if (error) *error = "invalid key";
    return false;
  }
  return PostKeyFlags(key_code, FlagsFromMods(mods), error);
}

bool PlatformPostMedia(int code, std::string* error) {
  // NX_KEYTYPE_* (0 volume up, 1 down, 7 mute, 16 play, 17 next, 18 previous)
  @autoreleasepool {
  for (int down = 1; down >= 0; down--) {
    NSInteger data1 = (static_cast<NSInteger>(code) << 16) | ((down ? 0xa : 0xb) << 8);
    NSEvent* ev = [NSEvent otherEventWithType:NSEventTypeSystemDefined
                                     location:NSZeroPoint
                                modifierFlags:static_cast<NSEventModifierFlags>(down ? 0xa00 : 0xb00)
                                    timestamp:0
                                 windowNumber:0
                                      context:nil
                                      subtype:8
                                        data1:data1
                                        data2:-1];
    CGEventRef cg = ev ? [ev CGEvent] : nullptr;
    if (!cg) {
      if (error) *error = "could not create media key event";
      return false;
    }
    CGEventPost(kCGHIDEventTap, cg);
  }
  }
  return true;
}

// Mission Control (32), App windows (33), Show desktop (36), Move a space
// left / right (79 / 81), Switch to Desktop N (118 + N - 1)… Uses the key the
// user set in System Settings; switches it on / gives it a spare key for the
// moment when it is off or has none, exactly like Mac Mouse Fix does.
bool PlatformPostHotKey(int hotkey, std::string* error) {
  auto get = Sym<GetHotKeyFn>("CGSGetSymbolicHotKeyValue");
  auto is_enabled = Sym<IsHotKeyEnabledFn>("CGSIsSymbolicHotKeyEnabled");
  auto set_enabled = Sym<SetHotKeyEnabledFn>("CGSSetSymbolicHotKeyEnabled");
  auto set_value = Sym<SetHotKeyValueFn>("CGSSetSymbolicHotKeyValue");
  if (!get || !is_enabled || !set_enabled) {
    if (error) *error = "hotkey-api";
    return false;
  }
  unichar key_equivalent = 0;
  unichar key_code = 0;
  uint32_t mods = 0;
  if (get(hotkey, &key_equivalent, &key_code, &mods) != kCGErrorSuccess) {
    if (error) *error = "hotkey-read";
    return false;
  }
  if (key_code == 0xFFFF) {
    if (!set_value) {
      if (error) *error = "hotkey-unassigned";
      return false;
    }
    static const unichar kSpare[] = {105, 107, 113, 106, 64, 79, 80, 90};  // F13..F20
    key_code = kSpare[hotkey % 8];
    key_equivalent = 0xFFFF;
    mods = static_cast<uint32_t>(kCGEventFlagMaskControl | kCGEventFlagMaskAlternate | kCGEventFlagMaskShift |
                                 kCGEventFlagMaskCommand);
    set_value(hotkey, key_equivalent, key_code, mods);
  }
  const bool was_enabled = is_enabled(hotkey);
  if (!was_enabled) set_enabled(hotkey, true);
  const bool ok = PostKeyFlags(key_code, static_cast<CGEventFlags>(mods), error);
  if (!was_enabled) {
    // Give the window server time to act on the key, then put the setting back.
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, static_cast<int64_t>(1 * NSEC_PER_SEC)), dispatch_get_main_queue(), ^{
      set_enabled(hotkey, false);
    });
  }
  return ok;
}

bool PlatformClick(int button, std::string* error) {
  if (button < 0 || button > 31) {
    if (error) *error = "invalid button";
    return false;
  }
  CGEventRef now = CGEventCreate(nullptr);
  CGPoint p = now ? CGEventGetLocation(now) : CGPointZero;
  if (now) CFRelease(now);
  PostClickAt(button, p);
  return true;
}

std::string PlatformFrontApp() {
  return AppId([[NSWorkspace sharedWorkspace] frontmostApplication]);
}

}  // namespace clipshelf_mouse
