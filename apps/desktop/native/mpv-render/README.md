# wicaby_mpv (Linux only)

Node-API addon for the native Wayland "texture" mode. It runs libmpv in the main process, renders each frame into a ring of four GBM dmabufs (ABGR8888 with a tiled modifier, through EGL/GLES 3), and hands their fds to JS so Electron's `sharedTexture` can draw them under the OSD. The JS contract is `src/main/playback/libmpv-native.ts`. The threading model is described in `src/player.h` and `src/renderer.h`.

- libmpv is loaded with `dlopen("libmpv.so.2")` and needs client API 2.1 (mpv 0.36) or newer; `libmpv.so.1` (API 1.x, mpv 0.34 and older) is never tried. Only the vendored ISC headers in `include/mpv/` are used, so libmpv is never a `NEEDED` entry. The addon links EGL, GLESv2 and gbm (`libgbm-dev libegl-dev libgles-dev` to build).
- Electron links its own FFmpeg (`libffmpeg.so`) into the global symbol scope. `src/ffmpeg_rebind.cc` points the system FFmpeg that libmpv loads back at itself (see the header for why `RTLD_DEEPBIND` is not used). If it cannot, `probe()` fails and the app falls back to detached mpv.
- `probe(renderNode?)` also checks the render node the way a player would (open it, GBM device, EGL display, GLES 3 context, then free it all) and returns `render: { ok, node, error? }`. The node is `renderNode`, else `WICABY_RENDER_NODE`, else the first `/dev/dri/renderD*` (sorted) that passes; `create(onEvent)` without a node uses the same one.
- GPU driver fds (dmabufs, render node handles that NVIDIA's EGL/GBM opens without `O_CLOEXEC`) get `FD_CLOEXEC` after setup, each ring allocation and the first frame, so processes the main process spawns do not inherit the video buffers.
- On app exit, a player whose teardown hangs (a stuck libmpv core) is waited for at most 2 s, then left behind so the process can exit.
- When the render context is created, mpv logs `drmprime-overlay: Cannot retrieve DRM resources: Bad file descriptor` at error level. This is harmless: `DRM_DISPLAY_V2` carries only a render fd, which is all VAAPI interop needs.

Build: `node-gyp rebuild -C native/mpv-render` (from `apps/desktop`).

Test: `node native/mpv-render/test/smoke.cjs` (also runs `test/exit-hang.cjs`, the exit paths with a hung core), then `electron --ozone-platform=wayland native/mpv-render/test/electron-main.cjs` (with `ELECTRON_RUN_AS_NODE` unset). The tests are silent and use lavfi sources only.
