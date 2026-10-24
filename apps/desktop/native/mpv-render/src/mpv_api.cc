#include "mpv_api.h"

#include <dlfcn.h>

#include <mutex>
#include <vector>

#include "ffmpeg_rebind.h"

namespace wicaby {
namespace {

// Client API 2.1 (mpv 0.36), the same floor tools/checks/native-addon-check.mjs
// asserts. The render API with DRM_DISPLAY_V2 and ADVANCED_CONTROL and the
// event fields player.cc reads (playlist_entry_id, 1.108) are older than that;
// MpvPlayer applies its own mpv 0.37 gate on top. Every libmpv.so.1 is API 1.x
// (mpv <= 0.34), so only libmpv.so.2 is ever tried.
constexpr unsigned long kMinApiVersion = MPV_MAKE_VERSION(2, 1);

MpvApi g_api;
std::string g_error;
bool g_ok = false;

void Load() {
  // Not RTLD_DEEPBIND: see ffmpeg_rebind.h for why, and for what replaces it.
  // RTLD_NOW matters: every binding must exist before it is rewritten.
  const std::vector<uintptr_t> before = LoadedObjects();
  void* lib = dlopen("libmpv.so.2", RTLD_NOW | RTLD_LOCAL);
  if (!lib) {
    const char* e = dlerror();
    g_error = e ? e : "dlopen libmpv.so.2 failed";
    return;
  }
  if (!RebindChromiumFfmpeg(lib, before, &g_api.ffmpeg_rebound, &g_error)) return;
#define WICABY_MPV_RESOLVE(name)                                       \
  g_api.name = reinterpret_cast<decltype(g_api.name)>(dlsym(lib, #name)); \
  if (!g_api.name) {                                                   \
    g_error = "libmpv lacks " #name;                                   \
    return;                                                            \
  }
  WICABY_MPV_FUNCTIONS(WICABY_MPV_RESOLVE)
#undef WICABY_MPV_RESOLVE
  g_api.api_version = g_api.mpv_client_api_version();
  if (g_api.api_version < kMinApiVersion) {
    g_error = "libmpv client API " + std::to_string(g_api.api_version >> 16) + "." +
              std::to_string(g_api.api_version & 0xffff) + " is older than 2.1 (mpv 0.36)";
    return;
  }
  g_ok = true;
}

}  // namespace

const MpvApi* LoadMpv(std::string* error) {
  // A magic static, not std::call_once: with libstdc++ linked statically, the
  // call_once trampoline (a weak template instance) can bind to the host's own
  // copy, which reads another libstdc++'s TLS callable and crashes.
  static const bool loaded = (Load(), true);
  (void)loaded;
  if (!g_ok && error) *error = g_error;
  return g_ok ? &g_api : nullptr;
}

}  // namespace wicaby
