// The render thread: owns the EGL context, the mpv render context and a ring
// of GBM dmabufs that mpv renders into.
//
// Threading:
// - Start/Resize/Release/Delivered are called from the JS thread and only
//   push a request under mu_ and signal cv_; they never wait on the GPU or mpv.
// - Stop is called from the teardown thread and joins the render thread.
// - mpv's update callback (any mpv thread) only sets update_ and signals cv_,
//   as render.h requires.
// - Everything else (EGL, GL, GBM, mpv_render_context_*) happens on the render
//   thread, which never calls non-render libmpv functions, so it cannot
//   deadlock with the core (render.h "Threading").
// - Callbacks fire on the render thread; Player forwards them to JS through a
//   thread-safe function, so they must not block.
#pragma once

#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl3.h>
#include <GLES2/gl2ext.h>

#include <condition_variable>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "mpv_api.h"

struct gbm_bo;
struct gbm_device;

namespace wicaby {

struct BufferInfo {
  uint32_t slot = 0;
  int fd = -1;
  uint32_t stride = 0;
  uint32_t offset = 0;
  uint64_t size = 0;
  uint64_t modifier = 0;
  uint32_t width = 0;
  uint32_t height = 0;
};

class Renderer {
 public:
  struct Callbacks {
    std::function<void(uint32_t generation, std::vector<BufferInfo> buffers)> buffers;
    std::function<void(uint32_t generation, uint32_t slot)> frame;
    // Fatal: setup failed, no picture can come out of this renderer.
    std::function<void(std::string message)> error;
    // Non-fatal (a failed resize: the old ring stays in use).
    std::function<void(std::string message)> warn;
    // Once, after setup, also when it failed (then error came first): queued
    // mpv calls may run, and vo=libmpv reports its own errors.
    std::function<void()> ready;
  };

  static constexpr int kSlots = 4;
  static constexpr int kMaxSize = 16384;

  Renderer(const MpvApi* mpv, mpv_handle* handle, std::string render_node, Callbacks callbacks);
  ~Renderer();
  Renderer(const Renderer&) = delete;
  Renderer& operator=(const Renderer&) = delete;

  // Opens render_node, creates the GBM device and an EGL display + GLES 3
  // context the way the render thread does, then frees it all. Runs on a
  // short-lived thread of its own so the caller's EGL state is untouched.
  static bool ProbeNode(const std::string& render_node, std::string* error);
  // WICABY_RENDER_NODE if set, else the first /dev/dri/renderD* (sorted) that
  // ProbeNode accepts; the auto-selection is done once per process. Returns
  // false with *error when no node works; *node is then the best guess
  // (the env value or the first candidate), so a player fails with a clear
  // render error rather than a silent one.
  static bool ResolveNode(std::string* node, std::string* error);

  void Start(int width, int height);
  void Resize(int width, int height);
  // JS is done with the frame in (generation, slot); mpv may render into it again.
  void Release(uint32_t generation, uint32_t slot);
  // JS has handled the 'buffers' event of this generation, so older rings'
  // fds were imported (Electron dups them) and can be closed once released.
  void Delivered(uint32_t generation);
  // Frees the render context, the ring and EGL/GBM, then joins. Idempotent.
  void Stop();

 private:
  struct Slot {
    gbm_bo* bo = nullptr;
    int fd = -1;
    uint32_t stride = 0;
    uint32_t offset = 0;
    uint64_t size = 0;
    uint64_t modifier = 0;
    EGLImageKHR image = EGL_NO_IMAGE_KHR;
    GLuint texture = 0;
    GLuint fbo = 0;
    bool busy = false;  // announced to JS and not yet released
  };
  struct Ring {
    uint32_t generation = 0;
    int width = 0;
    int height = 0;
    std::vector<Slot> slots;
  };

  // What Setup and ProbeNode share: render node fd, GBM device, EGL display
  // and a current GLES 3 context.
  struct Device {
    int fd = -1;
    gbm_device* gbm = nullptr;
    EGLDisplay display = EGL_NO_DISPLAY;
    bool owns_display = false;
    EGLContext context = EGL_NO_CONTEXT;
  };
  static bool OpenDevice(const std::string& render_node, Device* d, std::string* error);
  static void CloseDevice(Device* d);

  static void OnUpdate(void* self);
  void ThreadMain(int width, int height);
  bool Setup(int width, int height, std::string* error);
  void Loop();
  void Teardown();
  std::unique_ptr<Ring> AllocRing(int width, int height, std::string* error);
  void FreeSlot(Slot* s);
  void FreeRing(Ring* ring);
  void Announce(const Ring& ring);
  void MarkReleased(uint32_t generation, uint32_t slot);
  void FreeRetired();
  void RenderFrame();
  void WaitGpu();

  const MpvApi* const mpv_;
  mpv_handle* const handle_;
  const std::string render_node_;
  const Callbacks cb_;
  std::thread thread_;

  // Requests from other threads, guarded by mu_.
  std::mutex mu_;
  std::condition_variable cv_;
  bool stop_ = false;
  bool update_ = false;
  bool resize_requested_ = false;
  int resize_w_ = 0;
  int resize_h_ = 0;
  std::vector<std::pair<uint32_t, uint32_t>> releases_;
  uint32_t delivered_request_ = 0;

  // Render thread only.
  int fd_ = -1;
  gbm_device* gbm_ = nullptr;
  EGLDisplay display_ = EGL_NO_DISPLAY;
  bool owns_display_ = false;
  EGLContext context_ = EGL_NO_CONTEXT;
  mpv_render_context* render_ = nullptr;
  mpv_opengl_drm_params_v2 drm_params_{};
  bool native_fence_ = false;
  PFNEGLCREATEIMAGEKHRPROC create_image_ = nullptr;
  PFNEGLDESTROYIMAGEKHRPROC destroy_image_ = nullptr;
  PFNGLEGLIMAGETARGETTEXTURE2DOESPROC image_target_texture_ = nullptr;
  PFNEGLCREATESYNCKHRPROC create_sync_ = nullptr;
  PFNEGLDESTROYSYNCKHRPROC destroy_sync_ = nullptr;
  PFNEGLDUPNATIVEFENCEFDANDROIDPROC dup_fence_ = nullptr;
  std::unique_ptr<Ring> ring_;
  std::vector<std::unique_ptr<Ring>> retired_;
  uint32_t next_generation_ = 1;
  uint32_t delivered_ = 0;
  bool frame_pending_ = false;
  bool swept_after_first_frame_ = false;
  int next_slot_ = 0;
};

}  // namespace wicaby
