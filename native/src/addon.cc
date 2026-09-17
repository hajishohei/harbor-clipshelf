// N-API glue: startDrag(handle: Buffer, paths: string[], iconPng: Buffer|null,
//                       callback: (result) => void, allowMove?: boolean) -> boolean
#include <node_api.h>

#include <cstring>
#include <memory>
#include <string>
#include <vector>

#include "drag.h"

namespace {

struct Pending {
  napi_threadsafe_function tsfn = nullptr;
};

void CallJs(napi_env env, napi_value js_cb, void* /*context*/, void* data) {
  std::unique_ptr<clipshelf::DragResult> result(static_cast<clipshelf::DragResult*>(data));
  if (env == nullptr || js_cb == nullptr) return;
  napi_value obj;
  napi_create_object(env, &obj);
  napi_value op;
  napi_create_string_utf8(env, result->operation.c_str(), NAPI_AUTO_LENGTH, &op);
  napi_set_named_property(env, obj, "operation", op);
  napi_value x;
  napi_create_double(env, result->x, &x);
  napi_set_named_property(env, obj, "x", x);
  napi_value y;
  napi_create_double(env, result->y, &y);
  napi_set_named_property(env, obj, "y", y);
  napi_value undefined;
  napi_get_undefined(env, &undefined);
  napi_call_function(env, undefined, js_cb, 1, &obj, nullptr);
}

napi_value Throw(napi_env env, const char* message) {
  napi_throw_error(env, nullptr, message);
  return nullptr;
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

napi_value StartDrag(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 4) return Throw(env, "startDrag(handle, paths, iconPng, callback)");

  // native window handle
  bool is_buffer = false;
  napi_is_buffer(env, argv[0], &is_buffer);
  if (!is_buffer) return Throw(env, "handle must be a Buffer");
  void* handle_data = nullptr;
  size_t handle_len = 0;
  napi_get_buffer_info(env, argv[0], &handle_data, &handle_len);
  if (handle_len < sizeof(void*)) return Throw(env, "invalid window handle");
  void* view = nullptr;
  std::memcpy(&view, handle_data, sizeof(void*));

  // paths
  bool is_array = false;
  napi_is_array(env, argv[1], &is_array);
  if (!is_array) return Throw(env, "paths must be an array");
  uint32_t count = 0;
  napi_get_array_length(env, argv[1], &count);
  if (count == 0) return Throw(env, "no paths");
  std::vector<std::string> paths;
  for (uint32_t i = 0; i < count; i++) {
    napi_value el;
    napi_get_element(env, argv[1], i, &el);
    std::string p;
    if (!ReadString(env, el, &p) || p.empty()) return Throw(env, "paths must be strings");
    paths.push_back(std::move(p));
  }

  // icon
  std::vector<unsigned char> icon;
  napi_is_buffer(env, argv[2], &is_buffer);
  if (is_buffer) {
    void* data = nullptr;
    size_t len = 0;
    napi_get_buffer_info(env, argv[2], &data, &len);
    icon.assign(static_cast<unsigned char*>(data), static_cast<unsigned char*>(data) + len);
  }

  bool allow_move = false;
  if (argc >= 5) {
    napi_valuetype move_type;
    napi_typeof(env, argv[4], &move_type);
    if (move_type == napi_boolean) napi_get_value_bool(env, argv[4], &allow_move);
  }

  napi_valuetype cb_type;
  napi_typeof(env, argv[3], &cb_type);
  if (cb_type != napi_function) return Throw(env, "callback must be a function");

  napi_value name;
  napi_create_string_utf8(env, "clipshelf-drag", NAPI_AUTO_LENGTH, &name);
  napi_threadsafe_function tsfn = nullptr;
  if (napi_create_threadsafe_function(env, argv[3], nullptr, name, 0, 1, nullptr, nullptr, nullptr, CallJs,
                                      &tsfn) != napi_ok) {
    return Throw(env, "could not create callback");
  }

  auto shared_tsfn = std::make_shared<napi_threadsafe_function>(tsfn);
  std::string error;
  bool started = clipshelf::StartFileDrag(
      view, paths, icon, allow_move,
      [shared_tsfn](const clipshelf::DragResult& r) {
        auto* copy = new clipshelf::DragResult(r);
        if (napi_call_threadsafe_function(*shared_tsfn, copy, napi_tsfn_blocking) != napi_ok) delete copy;
        napi_release_threadsafe_function(*shared_tsfn, napi_tsfn_release);
      },
      &error);

  if (!started) {
    napi_release_threadsafe_function(tsfn, napi_tsfn_release);
    return Throw(env, error.empty() ? "drag could not start" : error.c_str());
  }
  napi_value ok;
  napi_get_boolean(env, true, &ok);
  return ok;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_value fn;
  napi_create_function(env, "startDrag", NAPI_AUTO_LENGTH, StartDrag, nullptr, &fn);
  napi_set_named_property(env, exports, "startDrag", fn);
  napi_value version;
  napi_create_uint32(env, 1, &version);
  napi_set_named_property(env, exports, "version", version);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
