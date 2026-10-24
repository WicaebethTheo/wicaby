{
  # Kept out of the package root on purpose: npm gives any package with a
  # root binding.gyp a hidden `node-gyp rebuild` install script.
  "targets": [{
    "target_name": "wicaby_mpv",
    "conditions": [
      ["OS!='linux'", {"type": "none"}],
      ["OS=='linux'", {
        "sources": [
          "src/addon.cc",
          "src/ffmpeg_rebind.cc",
          "src/mpv_api.cc",
          "src/player.cc",
          "src/renderer.cc",
          "src/value.cc"
        ],
        # libmpv is dlopen()ed at runtime; only its vendored headers are used here.
        "include_dirs": [
          "include",
          "<!(node -p \"require('node-addon-api').include_dir\")"
        ],
        "defines": ["NAPI_VERSION=8", "NODE_ADDON_API_DISABLE_CPP_EXCEPTIONS"],
        "cflags": ["-fvisibility=hidden", "-Wall", "-Wextra", "-Wno-unused-parameter", "<!@(pkg-config --cflags egl glesv2 gbm)"],
        "cflags_cc": ["-std=c++17", "-fvisibility-inlines-hidden"],
        "libraries": ["<!@(pkg-config --libs egl glesv2 gbm)", "-ldl", "-lpthread"],
        # The GCC runtime is linked in, so the addon needs no GLIBCXX_* version from the user's libstdc++
        # (Electron itself uses its own libc++); --exclude-libs keeps those symbols out of the dynamic table.
        # -Bsymbolic (and hidden inline functions above): the addon's own copies of libstdc++ templates and
        # statics are used, never the host's (node links its own libstdc++; mixing them crashed std::call_once).
        "ldflags": ["-static-libstdc++", "-static-libgcc", "-Wl,--exclude-libs,ALL", "-Wl,-Bsymbolic"]
      }]
    ]
  }]
}
