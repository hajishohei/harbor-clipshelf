// Windows: OLE DoDragDrop with a shell data object, offering move as well as
// copy so Explorer applies its usual rules (same drive → move, other drive →
// copy, Ctrl → copy, Shift → move) — like dragging the file in Explorer.
#include <windows.h>
#include <ole2.h>
#include <shlobj.h>
#include <shlwapi.h>
#include <shobjidl.h>

#include <algorithm>
#include <memory>
#include <string>
#include <vector>

#include <shlguid.h>
#include <objidl.h>
// gdiplus.h needs min/max, which NOMINMAX removes.
namespace Gdiplus {
using std::max;
using std::min;
}  // namespace Gdiplus
#include <gdiplus.h>

#include "drag.h"

namespace clipshelf {
namespace {

std::wstring Widen(const std::string& utf8) {
  if (utf8.empty()) return std::wstring();
  int len = MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), nullptr, 0);
  std::wstring out(static_cast<size_t>(len), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), &out[0], len);
  return out;
}

class DropSource final : public IDropSource {
 public:
  DropSource() = default;

  // IUnknown
  HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** out) override {
    if (!out) return E_POINTER;
    if (riid == IID_IUnknown || riid == IID_IDropSource) {
      *out = static_cast<IDropSource*>(this);
      AddRef();
      return S_OK;
    }
    *out = nullptr;
    return E_NOINTERFACE;
  }
  ULONG STDMETHODCALLTYPE AddRef() override { return InterlockedIncrement(&refs_); }
  ULONG STDMETHODCALLTYPE Release() override {
    LONG n = InterlockedDecrement(&refs_);
    if (n == 0) delete this;
    return static_cast<ULONG>(n);
  }

  // IDropSource
  HRESULT STDMETHODCALLTYPE QueryContinueDrag(BOOL escape_pressed, DWORD key_state) override {
    if (escape_pressed) return DRAGDROP_S_CANCEL;
    if (!(key_state & (MK_LBUTTON | MK_RBUTTON))) return DRAGDROP_S_DROP;
    return S_OK;
  }
  HRESULT STDMETHODCALLTYPE GiveFeedback(DWORD /*effect*/) override { return DRAGDROP_S_USEDEFAULTCURSORS; }

 private:
  LONG refs_ = 1;
};

struct PidlList {
  std::vector<PIDLIST_ABSOLUTE> items;
  ~PidlList() {
    for (auto p : items) CoTaskMemFree(p);
  }
};

HBITMAP BitmapFromPng(const std::vector<unsigned char>& png, SIZE* size) {
  if (png.empty()) return nullptr;
  Gdiplus::GdiplusStartupInput input;
  ULONG_PTR token = 0;
  if (Gdiplus::GdiplusStartup(&token, &input, nullptr) != Gdiplus::Ok) return nullptr;
  HBITMAP result = nullptr;
  IStream* stream = SHCreateMemStream(png.data(), static_cast<UINT>(png.size()));
  if (stream) {
    {
      std::unique_ptr<Gdiplus::Bitmap> bmp(Gdiplus::Bitmap::FromStream(stream));
      if (bmp && bmp->GetLastStatus() == Gdiplus::Ok) {
        // Premultiplied transparent background is what the drag helper expects.
        if (bmp->GetHBITMAP(Gdiplus::Color(0, 0, 0, 0), &result) == Gdiplus::Ok) {
          size->cx = static_cast<LONG>(bmp->GetWidth());
          size->cy = static_cast<LONG>(bmp->GetHeight());
        } else {
          result = nullptr;
        }
      }
    }
    stream->Release();
  }
  Gdiplus::GdiplusShutdown(token);
  return result;
}

}  // namespace

bool StartFileDrag(void* view,
                   const std::vector<std::string>& utf8_paths,
                   const std::vector<unsigned char>& icon_png,
                   bool allow_move,
                   DragDone done,
                   std::string* error) {
  (void)view;
  HRESULT ole = OleInitialize(nullptr);  // S_FALSE if Chromium already did
  bool ole_ok = SUCCEEDED(ole);

  PidlList pidls;
  for (const auto& path : utf8_paths) {
    std::wstring w = Widen(path);
    PIDLIST_ABSOLUTE pidl = nullptr;
    if (SUCCEEDED(SHParseDisplayName(w.c_str(), nullptr, &pidl, 0, nullptr)) && pidl) {
      pidls.items.push_back(pidl);
    }
  }
  if (pidls.items.empty()) {
    if (ole_ok) OleUninitialize();
    if (error) *error = "no valid paths";
    return false;
  }

  std::vector<PCIDLIST_ABSOLUTE> const_pidls(pidls.items.begin(), pidls.items.end());
  IShellItemArray* array = nullptr;
  HRESULT hr = SHCreateShellItemArrayFromIDLists(static_cast<UINT>(const_pidls.size()), const_pidls.data(), &array);
  IDataObject* data = nullptr;
  if (SUCCEEDED(hr)) hr = array->BindToHandler(nullptr, BHID_DataObject, IID_IDataObject, reinterpret_cast<void**>(&data));
  if (array) array->Release();
  if (FAILED(hr) || !data) {
    if (ole_ok) OleUninitialize();
    if (error) *error = "could not create data object";
    return false;
  }

  // Drag image (optional).
  SIZE size = {0, 0};
  HBITMAP bitmap = BitmapFromPng(icon_png, &size);
  if (bitmap) {
    IDragSourceHelper* helper = nullptr;
    if (SUCCEEDED(CoCreateInstance(CLSID_DragDropHelper, nullptr, CLSCTX_INPROC_SERVER, IID_IDragSourceHelper,
                                   reinterpret_cast<void**>(&helper)))) {
      SHDRAGIMAGE image = {};
      image.sizeDragImage = size;
      image.ptOffset.x = size.cx / 2;
      image.ptOffset.y = size.cy / 2;
      image.hbmpDragImage = bitmap;
      image.crColorKey = CLR_NONE;
      if (SUCCEEDED(helper->InitializeFromBitmap(&image, data))) bitmap = nullptr;  // helper owns it now
      helper->Release();
    }
    if (bitmap) DeleteObject(bitmap);
  }

  DropSource* source = new DropSource();
  DWORD effect = DROPEFFECT_NONE;
  DWORD allowed = allow_move ? (DROPEFFECT_COPY | DROPEFFECT_MOVE | DROPEFFECT_LINK) : DROPEFFECT_COPY;
  hr = DoDragDrop(data, source, allowed, &effect);
  source->Release();
  data->Release();

  POINT pt = {0, 0};
  GetCursorPos(&pt);
  DragResult result;
  if (hr == DRAGDROP_S_DROP) {
    // Explorer's "optimized move" reports DROPEFFECT_NONE after moving the
    // file itself; the caller double-checks whether the original still exists.
    if (effect & DROPEFFECT_MOVE) result.operation = "move";
    else if (effect & DROPEFFECT_COPY) result.operation = "copy";
    else if (effect & DROPEFFECT_LINK) result.operation = "link";
    else result.operation = "generic";
  } else {
    result.operation = "none";
  }
  // Physical pixels; the JS side converts with screen.screenToDipPoint().
  result.x = pt.x;
  result.y = pt.y;
  if (ole_ok) OleUninitialize();
  if (done) done(result);
  return true;
}

}  // namespace clipshelf
