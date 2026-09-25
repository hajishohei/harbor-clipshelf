{
  "targets": [
    {
      "target_name": "clipshelf_mouse",
      "sources": ["src/addon.cc", "src/engine.cc"],
      "defines": ["NAPI_VERSION=8"],
      "cflags_cc": ["-std=c++17"],
      "conditions": [
        ["OS=='mac'", {
          "sources": ["src/mouse_mac.mm"],
          "xcode_settings": {
            "CLANG_ENABLE_OBJC_ARC": "YES",
            "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
            "MACOSX_DEPLOYMENT_TARGET": "12.0"
          },
          "link_settings": { "libraries": ["-framework Cocoa", "-framework ApplicationServices"] }
        }],
        ["OS!='mac'", {
          "sources": ["src/mouse_stub.cc"]
        }],
        ["OS=='win'", {
          "defines": ["UNICODE", "_UNICODE", "NOMINMAX"],
          "msvs_settings": { "VCCLCompilerTool": { "ExceptionHandling": 1, "AdditionalOptions": ["/std:c++17"] } }
        }]
      ]
    }
  ]
}
