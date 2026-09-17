{
  "targets": [
    {
      "target_name": "clipshelf_native",
      "sources": ["src/addon.cc"],
      "defines": ["NAPI_VERSION=8"],
      "conditions": [
        ["OS=='mac'", {
          "sources": ["src/drag_mac.mm"],
          "xcode_settings": {
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "MACOSX_DEPLOYMENT_TARGET": "12.0"
          },
          "link_settings": { "libraries": ["-framework Cocoa"] }
        }],
        ["OS=='win'", {
          "sources": ["src/drag_win.cc"],
          "defines": ["UNICODE", "_UNICODE", "NOMINMAX"],
          "libraries": ["ole32.lib", "shell32.lib", "gdiplus.lib", "shlwapi.lib", "uuid.lib"],
          "msvs_settings": { "VCCLCompilerTool": { "ExceptionHandling": 1 } }
        }],
        ["OS!='mac' and OS!='win'", {
          "sources": ["src/drag_stub.cc"]
        }]
      ]
    }
  ]
}
