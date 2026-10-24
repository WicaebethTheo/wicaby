// libmpv entry points, resolved with dlsym so the addon has no link-time
// dependency on libmpv: a missing or too old libmpv is a probe() failure
// (detached fallback), not a require() failure.
#pragma once

#include <mpv/client.h>
#include <mpv/render_gl.h>

#include <string>

namespace wicaby {

#define WICABY_MPV_FUNCTIONS(X)              \
  X(mpv_client_api_version)                  \
  X(mpv_error_string)                        \
  X(mpv_event_name)                          \
  X(mpv_create)                              \
  X(mpv_initialize)                          \
  X(mpv_terminate_destroy)                   \
  X(mpv_set_option_string)                   \
  X(mpv_request_log_messages)                \
  X(mpv_wait_event)                          \
  X(mpv_wakeup)                              \
  X(mpv_command_node_async)                  \
  X(mpv_set_property_async)                  \
  X(mpv_get_property_async)                  \
  X(mpv_observe_property)                    \
  X(mpv_render_context_create)               \
  X(mpv_render_context_set_update_callback)  \
  X(mpv_render_context_update)               \
  X(mpv_render_context_render)               \
  X(mpv_render_context_report_swap)          \
  X(mpv_render_context_free)

struct MpvApi {
#define WICABY_MPV_MEMBER(name) decltype(&::name) name = nullptr;
  WICABY_MPV_FUNCTIONS(WICABY_MPV_MEMBER)
#undef WICABY_MPV_MEMBER
  unsigned long api_version = 0;
  // Relocations redirected away from Electron's bundled FFmpeg (ffmpeg_rebind.h).
  int ffmpeg_rebound = 0;
};

// Loads libmpv once per process (thread-safe, memoised) and never unloads it:
// mpv's own threads can outlive a player. Returns null with *error set when
// libmpv is missing, lacks a symbol or is older than the render API we use.
const MpvApi* LoadMpv(std::string* error);

}  // namespace wicaby
