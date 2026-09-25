// N-API glue for the mouse engine.
//   start(callback(event)) → true | throws Error("accessibility" | "unsupported")
//   stop()  running() → bool  trusted() → bool
//   configure({ enabled, holdMs, gestureDistance, scrollCooldownMs, profiles: { "<app id>|": [keys] } })
//   setObserve(bool)  frontApp() → string
//   postKey(macKeyCode, mods)  postMedia(code)  postHotKey(id)  click(button) → bool | throws
#include <node_api.h>

#include <memory>
#include <string>

#include "engine.h"
#include "platform.h"

namespace {

using namespace clipshelf_mouse;

Engine g_engine;
napi_threadsafe_function g_tsfn = nullptr;

napi_value Throw(napi_env env, const std::string& message) {
  napi_throw_error(env, nullptr, message.c_str());
  return nullptr;
}

napi_value Bool(napi_env env, bool v) {
  napi_value out;
  napi_get_boolean(env, v, &out);
  return out;
}

napi_value Str(napi_env env, const std::string& s) {
  napi_value out;
  napi_create_string_utf8(env, s.c_str(), s.size(), &out);
  return out;
}

bool ReadString(napi_env env, napi_value value, std::string* out) {
  size_t len = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &len) != napi_ok) return false;
  std::string s(len, '\0');
  if (napi_get_value_string_utf8(env, value, &s[0], len + 1, &len) != napi_ok) return false;
  s.resize(len);
  *out = std::move(s);
  return true;
}

bool GetNumber(napi_env env, napi_value obj, const char* name, double* out) {
  bool has = false;
  if (napi_has_named_property(env, obj, name, &has) != napi_ok || !has) return false;
  napi_value v;
  napi_get_named_property(env, obj, name, &v);
  return napi_get_value_double(env, v, out) == napi_ok;
}

bool GetBool(napi_env env, napi_value obj, const char* name, bool* out) {
  bool has = false;
  if (napi_has_named_property(env, obj, name, &has) != napi_ok || !has) return false;
  napi_value v;
  napi_get_named_property(env, obj, name, &v);
  return napi_get_value_bool(env, v, out) == napi_ok;
}

void CallJs(napi_env env, napi_value js_cb, void* /*context*/, void* data) {
  std::unique_ptr<Event> ev(static_cast<Event*>(data));
  if (env == nullptr || js_cb == nullptr) return;
  napi_value obj;
  napi_create_object(env, &obj);
  napi_set_named_property(env, obj, "type", Str(env, ev->type));
  napi_set_named_property(env, obj, "key", Str(env, ev->key));
  napi_set_named_property(env, obj, "app", Str(env, ev->app));
  napi_set_named_property(env, obj, "button", Str(env, ev->button));
  napi_value x, y;
  napi_create_double(env, ev->x, &x);
  napi_create_double(env, ev->y, &y);
  napi_set_named_property(env, obj, "x", x);
  napi_set_named_property(env, obj, "y", y);
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  napi_call_function(env, undefined, js_cb, 1, &obj, nullptr);
}

void ReleaseTsfn() {
  if (!g_tsfn) return;
  napi_release_threadsafe_function(g_tsfn, napi_tsfn_release);
  g_tsfn = nullptr;
}

napi_value Start(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_valuetype t = napi_undefined;
  if (argc >= 1) napi_typeof(env, argv[0], &t);
  if (t != napi_function) return Throw(env, "start(callback)");
  if (PlatformRunning()) return Bool(env, true);

  napi_value name;
  napi_create_string_utf8(env, "clipshelf-mouse", NAPI_AUTO_LENGTH, &name);
  napi_threadsafe_function tsfn = nullptr;
  if (napi_create_threadsafe_function(env, argv[0], nullptr, name, 0, 1, nullptr, nullptr, nullptr, CallJs, &tsfn) != napi_ok) {
    return Throw(env, "could not create callback");
  }
  // Don't keep the event loop alive just for this.
  napi_unref_threadsafe_function(env, tsfn);
  std::string error;
  bool ok = PlatformStart(
      &g_engine,
      [tsfn](const Event& e) {
        auto* copy = new Event(e);
        if (napi_call_threadsafe_function(tsfn, copy, napi_tsfn_nonblocking) != napi_ok) delete copy;
      },
      &error);
  if (!ok) {
    napi_release_threadsafe_function(tsfn, napi_tsfn_release);
    return Throw(env, error.empty() ? "start failed" : error);
  }
  g_tsfn = tsfn;
  return Bool(env, true);
}

napi_value Stop(napi_env env, napi_callback_info /*info*/) {
  PlatformStop();  // after this the sink is never called again
  ReleaseTsfn();
  return Bool(env, true);
}

napi_value Running(napi_env env, napi_callback_info /*info*/) {
  return Bool(env, PlatformRunning());
}

napi_value Trusted(napi_env env, napi_callback_info /*info*/) {
  return Bool(env, PlatformTrusted());
}

napi_value Configure(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_valuetype t = napi_undefined;
  if (argc >= 1) napi_typeof(env, argv[0], &t);
  if (t != napi_object) return Throw(env, "configure(object)");
  napi_value obj = argv[0];
  Config c;
  GetBool(env, obj, "enabled", &c.enabled);
  GetNumber(env, obj, "holdMs", &c.hold_ms);
  GetNumber(env, obj, "gestureDistance", &c.gesture_px);
  GetNumber(env, obj, "scrollCooldownMs", &c.scroll_cooldown_ms);

  bool has = false;
  napi_has_named_property(env, obj, "profiles", &has);
  if (has) {
    napi_value profiles;
    napi_get_named_property(env, obj, "profiles", &profiles);
    napi_value names;
    if (napi_get_property_names(env, profiles, &names) == napi_ok) {
      uint32_t count = 0;
      napi_get_array_length(env, names, &count);
      for (uint32_t i = 0; i < count; i++) {
        napi_value k;
        napi_get_element(env, names, i, &k);
        std::string id;
        if (!ReadString(env, k, &id)) continue;
        napi_value list;
        if (napi_get_property(env, profiles, k, &list) != napi_ok) continue;
        bool is_array = false;
        napi_is_array(env, list, &is_array);
        if (!is_array) continue;
        uint32_t n = 0;
        napi_get_array_length(env, list, &n);
        auto& set = c.profiles[id];
        for (uint32_t j = 0; j < n; j++) {
          napi_value item;
          napi_get_element(env, list, j, &item);
          std::string key;
          if (ReadString(env, item, &key) && !key.empty()) set.insert(key);
        }
      }
    }
  }
  g_engine.Configure(c);
  return Bool(env, true);
}

napi_value SetObserve(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  bool on = false;
  if (argc >= 1) napi_get_value_bool(env, argv[0], &on);
  PlatformSetObserve(on);
  return Bool(env, true);
}

napi_value FrontApp(napi_env env, napi_callback_info /*info*/) {
  return Str(env, PlatformFrontApp());
}

int IntArg(napi_env env, napi_callback_info info, size_t index, int fallback) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc <= index) return fallback;
  int32_t v = fallback;
  if (napi_get_value_int32(env, argv[index], &v) != napi_ok) return fallback;
  return v;
}

napi_value Result(napi_env env, bool ok, const std::string& error) {
  if (!ok) return Throw(env, error.empty() ? "failed" : error);
  return Bool(env, true);
}

napi_value PostKey(napi_env env, napi_callback_info info) {
  std::string error;
  bool ok = PlatformPostKey(IntArg(env, info, 0, -1), static_cast<uint32_t>(IntArg(env, info, 1, 0)), &error);
  return Result(env, ok, error);
}

napi_value PostMedia(napi_env env, napi_callback_info info) {
  std::string error;
  return Result(env, PlatformPostMedia(IntArg(env, info, 0, -1), &error), error);
}

napi_value PostHotKey(napi_env env, napi_callback_info info) {
  std::string error;
  return Result(env, PlatformPostHotKey(IntArg(env, info, 0, -1), &error), error);
}

napi_value Click(napi_env env, napi_callback_info info) {
  std::string error;
  return Result(env, PlatformClick(IntArg(env, info, 0, -1), &error), error);
}

void Define(napi_env env, napi_value exports, const char* name, napi_callback cb) {
  napi_value fn;
  napi_create_function(env, name, NAPI_AUTO_LENGTH, cb, nullptr, &fn);
  napi_set_named_property(env, exports, name, fn);
}

void Cleanup(void* /*arg*/) {
  PlatformStop();
}

napi_value Init(napi_env env, napi_value exports) {
  Define(env, exports, "start", Start);
  Define(env, exports, "stop", Stop);
  Define(env, exports, "running", Running);
  Define(env, exports, "trusted", Trusted);
  Define(env, exports, "configure", Configure);
  Define(env, exports, "setObserve", SetObserve);
  Define(env, exports, "frontApp", FrontApp);
  Define(env, exports, "postKey", PostKey);
  Define(env, exports, "postMedia", PostMedia);
  Define(env, exports, "postHotKey", PostHotKey);
  Define(env, exports, "click", Click);
  napi_value version;
  napi_create_uint32(env, 1, &version);
  napi_set_named_property(env, exports, "version", version);
  napi_add_env_cleanup_hook(env, Cleanup, nullptr);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
