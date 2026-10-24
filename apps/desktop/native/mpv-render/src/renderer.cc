#include "renderer.h"

#include <dirent.h>
#include <fcntl.h>
#include <gbm.h>
#include <poll.h>
#include <unistd.h>

#include <algorithm>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>

namespace wicaby {
namespace {

constexpr uint64_t kModifierInvalid = 0x00ffffffffffffffULL;  // DRM_FORMAT_MOD_INVALID

bool HasExtension(const char* list, const char* ext) {
  if (!list) return false;
  const size_t n = std::strlen(ext);
  for (const char* p = list; (p = std::strstr(p, ext)) != nullptr; p += n)
    if ((p == list || p[-1] == ' ') && (p[n] == ' ' || p[n] == '\0')) return true;
  return false;
}

std::string EglError(const char* what) {
  char buf[128];
  std::snprintf(buf, sizeof buf, "%s failed (EGL 0x%x)", what, eglGetError());
  return buf;
}

void* GetProcAddress(void*, const char* name) {
  return reinterpret_cast<void*>(eglGetProcAddress(name));
}

// The fds the addon opens itself (render node, gbm_bo_get_fd) are O_CLOEXEC,
// but the GPU driver opens more inside gbm_create_device, eglInitialize and
// eglCreateImage (NVIDIA: dmabufs and render node handles) without it, and
// libuv's spawn does not close inherited fds. Every helper the main process
// starts during playback (display-mode tools, xdg-open, the music mpv) would
// then keep the video buffers alive and reachable. Electron dups the fds it
// imports with CLOEXEC itself, so setting the flag on every dmabuf and DRM fd
// of the process is safe; nothing hands these to a child by inheritance.
void CloexecGpuFds() {
  DIR* dir = opendir("/proc/self/fd");
  if (!dir) return;
  const int self = dirfd(dir);
  while (dirent* e = readdir(dir)) {
    char* end = nullptr;
    const long fd = std::strtol(e->d_name, &end, 10);
    if (end == e->d_name || *end != '\0' || fd == self) continue;
    char link[64];
    const ssize_t n = readlinkat(self, e->d_name, link, sizeof link - 1);
    if (n <= 0) continue;
    link[n] = '\0';
    if (std::strncmp(link, "/dmabuf:", 8) != 0 && std::strncmp(link, "/dev/dri/", 9) != 0) continue;
    const int flags = fcntl(static_cast<int>(fd), F_GETFD);
    if (flags >= 0 && !(flags & FD_CLOEXEC)) fcntl(static_cast<int>(fd), F_SETFD, flags | FD_CLOEXEC);
  }
  closedir(dir);
}

}  // namespace

bool Renderer::OpenDevice(const std::string& render_node, Device* d, std::string* error) {
  d->fd = open(render_node.c_str(), O_RDWR | O_CLOEXEC);
  if (d->fd < 0) {
    *error = "open " + render_node + ": " + std::strerror(errno);
    return false;
  }
  d->gbm = gbm_create_device(d->fd);
  if (!d->gbm) {
    *error = "gbm_create_device(" + render_node + ") failed";
    return false;
  }

  // GBM platform on the render node is the portable choice (Mesa and NVIDIA);
  // surfaceless is a fallback for drivers without EGL_KHR_platform_gbm. The
  // buffers come from GBM either way.
  auto get_display = reinterpret_cast<PFNEGLGETPLATFORMDISPLAYEXTPROC>(eglGetProcAddress("eglGetPlatformDisplayEXT"));
  if (!get_display) {
    *error = "eglGetPlatformDisplayEXT missing";
    return false;
  }
  d->display = get_display(EGL_PLATFORM_GBM_KHR, d->gbm, nullptr);
  d->owns_display = true;
  if (d->display == EGL_NO_DISPLAY || !eglInitialize(d->display, nullptr, nullptr)) {
    // The surfaceless display is process-wide (EGL_DEFAULT_DISPLAY), so it is
    // never terminated: another player may be using it.
    d->display = get_display(EGL_PLATFORM_SURFACELESS_MESA, EGL_DEFAULT_DISPLAY, nullptr);
    d->owns_display = false;
    if (d->display == EGL_NO_DISPLAY || !eglInitialize(d->display, nullptr, nullptr)) {
      d->display = EGL_NO_DISPLAY;
      *error = EglError("eglInitialize (gbm and surfaceless)");
      return false;
    }
  }
  const char* exts = eglQueryString(d->display, EGL_EXTENSIONS);
  for (const char* need : {"EGL_KHR_no_config_context", "EGL_KHR_surfaceless_context", "EGL_EXT_image_dma_buf_import",
                           "EGL_EXT_image_dma_buf_import_modifiers"}) {
    if (!HasExtension(exts, need)) {
      *error = std::string("EGL lacks ") + need;
      return false;
    }
  }
  if (!eglBindAPI(EGL_OPENGL_ES_API)) {
    *error = EglError("eglBindAPI");
    return false;
  }
  const EGLint context_attribs[] = {EGL_CONTEXT_MAJOR_VERSION, 3, EGL_NONE};
  d->context = eglCreateContext(d->display, EGL_NO_CONFIG_KHR, EGL_NO_CONTEXT, context_attribs);
  if (d->context == EGL_NO_CONTEXT) {
    *error = EglError("eglCreateContext(GLES 3)");
    return false;
  }
  if (!eglMakeCurrent(d->display, EGL_NO_SURFACE, EGL_NO_SURFACE, d->context)) {
    *error = EglError("eglMakeCurrent");
    return false;
  }
  return true;
}

// Also after a failed OpenDevice. GL objects made in the context must be gone.
void Renderer::CloseDevice(Device* d) {
  if (d->display != EGL_NO_DISPLAY) {
    eglMakeCurrent(d->display, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
    if (d->context != EGL_NO_CONTEXT) eglDestroyContext(d->display, d->context);
    if (d->owns_display) eglTerminate(d->display);
  }
  eglReleaseThread();
  if (d->gbm) gbm_device_destroy(d->gbm);
  if (d->fd >= 0) close(d->fd);
  *d = Device{};
}

bool Renderer::ProbeNode(const std::string& render_node, std::string* error) {
  bool ok = false;
  std::thread([&] {
    Device d;
    ok = OpenDevice(render_node, &d, error);
    CloseDevice(&d);
    CloexecGpuFds();
  }).join();
  return ok;
}

bool Renderer::ResolveNode(std::string* node, std::string* error) {
  const char* env = std::getenv("WICABY_RENDER_NODE");
  if (env && *env) {
    *node = env;
    return ProbeNode(*node, error);
  }
  // Auto-selection once per process: EGL init costs tens of ms per node, and
  // the GPUs do not change while the app runs.
  struct Choice {
    std::string node;
    std::string error;
    bool ok = false;
  };
  // A magic static (not std::call_once: see LoadMpv), never freed so no
  // static destructor runs at exit.
  static const Choice* const choice = [] {
    auto* c = new Choice;
    std::vector<std::string> nodes;
    if (DIR* dir = opendir("/dev/dri")) {
      while (dirent* e = readdir(dir))
        if (std::strncmp(e->d_name, "renderD", 7) == 0) nodes.push_back(std::string("/dev/dri/") + e->d_name);
      closedir(dir);
    }
    // renderD128..renderD255: equal length, so lexical order is numeric.
    std::sort(nodes.begin(), nodes.end());
    if (nodes.empty()) {
      c->node = "/dev/dri/renderD128";
      c->error = "no /dev/dri/renderD* node";
      return c;
    }
    for (const std::string& n : nodes) {
      std::string e;
      if (ProbeNode(n, &e)) {
        c->node = n;
        c->ok = true;
        c->error.clear();
        return c;
      }
      if (!c->error.empty()) c->error += "; ";
      c->error += e;
    }
    c->node = nodes.front();
    return c;
  }();
  *node = choice->node;
  if (!choice->ok) *error = choice->error;
  return choice->ok;
}

Renderer::Renderer(const MpvApi* mpv, mpv_handle* handle, std::string render_node, Callbacks callbacks)
    : mpv_(mpv), handle_(handle), render_node_(std::move(render_node)), cb_(std::move(callbacks)) {}

Renderer::~Renderer() { Stop(); }

void Renderer::Start(int width, int height) {
  thread_ = std::thread(&Renderer::ThreadMain, this, width, height);
}

void Renderer::Resize(int width, int height) {
  std::lock_guard<std::mutex> lock(mu_);
  resize_requested_ = true;
  resize_w_ = width;
  resize_h_ = height;
  cv_.notify_one();
}

void Renderer::Release(uint32_t generation, uint32_t slot) {
  std::lock_guard<std::mutex> lock(mu_);
  releases_.emplace_back(generation, slot);
  cv_.notify_one();
}

void Renderer::Delivered(uint32_t generation) {
  std::lock_guard<std::mutex> lock(mu_);
  if (generation > delivered_request_) delivered_request_ = generation;
  cv_.notify_one();
}

void Renderer::Stop() {
  if (!thread_.joinable()) return;
  {
    std::lock_guard<std::mutex> lock(mu_);
    stop_ = true;
    cv_.notify_one();
  }
  thread_.join();
}

// Called by mpv from its own threads: only signal (render.h forbids anything else).
void Renderer::OnUpdate(void* self) {
  auto* r = static_cast<Renderer*>(self);
  std::lock_guard<std::mutex> lock(r->mu_);
  r->update_ = true;
  r->cv_.notify_one();
}

void Renderer::ThreadMain(int width, int height) {
  std::string error;
  const bool ok = Setup(width, height, &error);
  if (!ok) cb_.error(error);
  cb_.ready();
  if (ok) {
    Loop();
  } else {
    std::unique_lock<std::mutex> lock(mu_);
    cv_.wait(lock, [this] { return stop_; });
  }
  Teardown();
}

bool Renderer::Setup(int width, int height, std::string* error) {
  Device d;
  const bool opened = OpenDevice(render_node_, &d, error);
  // Teardown frees whatever was opened, also after a failure.
  fd_ = d.fd;
  gbm_ = d.gbm;
  display_ = d.display;
  owns_display_ = d.owns_display;
  context_ = d.context;
  CloexecGpuFds();
  if (!opened) return false;
  const char* exts = eglQueryString(display_, EGL_EXTENSIONS);
  create_image_ = reinterpret_cast<PFNEGLCREATEIMAGEKHRPROC>(eglGetProcAddress("eglCreateImageKHR"));
  destroy_image_ = reinterpret_cast<PFNEGLDESTROYIMAGEKHRPROC>(eglGetProcAddress("eglDestroyImageKHR"));
  image_target_texture_ =
      reinterpret_cast<PFNGLEGLIMAGETARGETTEXTURE2DOESPROC>(eglGetProcAddress("glEGLImageTargetTexture2DOES"));
  if (!create_image_ || !destroy_image_ || !image_target_texture_) {
    *error = "EGLImage entry points missing";
    return false;
  }
  if (HasExtension(exts, "EGL_ANDROID_native_fence_sync")) {
    create_sync_ = reinterpret_cast<PFNEGLCREATESYNCKHRPROC>(eglGetProcAddress("eglCreateSyncKHR"));
    destroy_sync_ = reinterpret_cast<PFNEGLDESTROYSYNCKHRPROC>(eglGetProcAddress("eglDestroySyncKHR"));
    dup_fence_ = reinterpret_cast<PFNEGLDUPNATIVEFENCEFDANDROIDPROC>(eglGetProcAddress("eglDupNativeFenceFDANDROID"));
    native_fence_ = create_sync_ && destroy_sync_ && dup_fence_;
  }

  // render_fd lets mpv open VAAPI on the same node; without it vaapi interop
  // fails with "Could not create a VA display".
  drm_params_ = mpv_opengl_drm_params_v2{-1, -1, -1, nullptr, fd_};
  mpv_opengl_init_params gl_init{GetProcAddress, nullptr};
  int advanced = 1;
  mpv_render_param params[] = {
      {MPV_RENDER_PARAM_API_TYPE, const_cast<char*>(MPV_RENDER_API_TYPE_OPENGL)},
      {MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &gl_init},
      {MPV_RENDER_PARAM_ADVANCED_CONTROL, &advanced},
      {MPV_RENDER_PARAM_DRM_DISPLAY_V2, &drm_params_},
      {MPV_RENDER_PARAM_INVALID, nullptr},
  };
  const int err = mpv_->mpv_render_context_create(&render_, handle_, params);
  if (err < 0) {
    render_ = nullptr;
    *error = std::string("mpv_render_context_create: ") + mpv_->mpv_error_string(err);
    return false;
  }
  mpv_->mpv_render_context_set_update_callback(render_, &Renderer::OnUpdate, this);

  ring_ = AllocRing(width, height, error);
  CloexecGpuFds();
  if (!ring_) return false;
  Announce(*ring_);
  return true;
}

void Renderer::Loop() {
  for (;;) {
    bool update = false;
    bool resize = false;
    int resize_w = 0;
    int resize_h = 0;
    std::vector<std::pair<uint32_t, uint32_t>> releases;
    {
      std::unique_lock<std::mutex> lock(mu_);
      cv_.wait(lock, [this] {
        return stop_ || update_ || resize_requested_ || !releases_.empty() || delivered_request_ != delivered_;
      });
      if (stop_) return;
      update = update_;
      update_ = false;
      resize = resize_requested_;
      resize_requested_ = false;
      resize_w = resize_w_;
      resize_h = resize_h_;
      releases.swap(releases_);
      delivered_ = delivered_request_;
    }

    for (const auto& r : releases) MarkReleased(r.first, r.second);

    if (resize && (resize_w != ring_->width || resize_h != ring_->height)) {
      std::string error;
      std::unique_ptr<Ring> next = AllocRing(resize_w, resize_h, &error);
      CloexecGpuFds();
      if (next) {
        // The old ring stays until JS has the new one and released every old
        // frame (FreeRetired); its fds must stay valid for imports until then.
        retired_.push_back(std::move(ring_));
        ring_ = std::move(next);
        next_slot_ = 0;
        Announce(*ring_);
        frame_pending_ = true;  // redraw at the new size, also while paused
      } else {
        // Not fatal (e.g. VRAM pressure in fullscreen): the old ring keeps
        // working and the picture is scaled. A later resize tries again.
        cb_.warn("resize to " + std::to_string(resize_w) + "x" + std::to_string(resize_h) + " failed, keeping " +
                 std::to_string(ring_->width) + "x" + std::to_string(ring_->height) + ": " + error);
      }
    }
    FreeRetired();

    // ADVANCED_CONTROL: update() after every callback, render only for FRAME.
    if (update && (mpv_->mpv_render_context_update(render_) & MPV_RENDER_UPDATE_FRAME)) frame_pending_ = true;
    // With every slot held by JS the frame stays pending and is rendered on
    // the next release; mpv then draws its current frame.
    if (frame_pending_) RenderFrame();
  }
}

void Renderer::RenderFrame() {
  int index = -1;
  for (int i = 0; i < kSlots; i++) {
    const int candidate = (next_slot_ + i) % kSlots;
    if (!ring_->slots[candidate].busy) {
      index = candidate;
      break;
    }
  }
  if (index < 0) return;
  frame_pending_ = false;
  Slot& s = ring_->slots[index];
  mpv_opengl_fbo fbo{static_cast<int>(s.fbo), ring_->width, ring_->height, 0};
  int flip_y = 0;  // row 0 is the top of the image, as Chromium expects for a dmabuf
  // Never sleep on this thread for frame timing. render.h asks for either a
  // wait on target_time or video-timing-offset=0 then: LibmpvController sets
  // the latter, so mpv's vo thread itself waits until each frame is due.
  int block = 0;
  mpv_render_param params[] = {
      {MPV_RENDER_PARAM_OPENGL_FBO, &fbo},
      {MPV_RENDER_PARAM_FLIP_Y, &flip_y},
      {MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME, &block},
      {MPV_RENDER_PARAM_INVALID, nullptr},
  };
  if (mpv_->mpv_render_context_render(render_, params) < 0) return;
  WaitGpu();
  // Render completion, not presentation: the compositor's vsync never
  // reaches this process. Good enough for video-sync=audio (the default);
  // display-resample is approximate (override-display-fps anchors it).
  mpv_->mpv_render_context_report_swap(render_);
  // hwdec interop opens its driver fds with the first decoded frame.
  if (!swept_after_first_frame_) {
    swept_after_first_frame_ = true;
    CloexecGpuFds();
  }
  s.busy = true;
  next_slot_ = (index + 1) % kSlots;
  cb_.frame(ring_->generation, static_cast<uint32_t>(index));
}

// The sharedTexture API carries no fence and NVIDIA does not reliably sync
// dmabufs implicitly, so the frame must be complete before it is announced.
void Renderer::WaitGpu() {
  if (native_fence_) {
    const EGLint attribs[] = {EGL_NONE};
    EGLSyncKHR sync = create_sync_(display_, EGL_SYNC_NATIVE_FENCE_ANDROID, attribs);
    if (sync != EGL_NO_SYNC_KHR) {
      glFlush();  // the fence fd exists only once the sync is flushed
      const int fence = dup_fence_(display_, sync);
      destroy_sync_(display_, sync);
      if (fence >= 0) {
        pollfd p{fence, POLLIN, 0};
        int r;
        do {
          r = poll(&p, 1, 1000);
        } while (r < 0 && errno == EINTR);
        close(fence);
        if (r > 0) return;
      }
    }
  }
  glFinish();
}

std::unique_ptr<Renderer::Ring> Renderer::AllocRing(int width, int height, std::string* error) {
  auto ring = std::make_unique<Ring>();
  ring->width = width;
  ring->height = height;
  ring->slots.resize(kSlots);
  for (Slot& s : ring->slots) {
    // GBM picks a tiled modifier the driver can render to; NVIDIA has no
    // renderable LINEAR, so a modifier-less allocation is never requested.
    s.bo = gbm_bo_create(gbm_, static_cast<uint32_t>(width), static_cast<uint32_t>(height), GBM_FORMAT_ABGR8888,
                         GBM_BO_USE_RENDERING);
    if (!s.bo) {
      *error = "gbm_bo_create(" + std::to_string(width) + "x" + std::to_string(height) + ") failed";
      FreeRing(ring.get());
      return nullptr;
    }
    if (gbm_bo_get_plane_count(s.bo) != 1) {
      *error = "gbm returned a multi-plane ABGR8888 buffer";
      FreeRing(ring.get());
      return nullptr;
    }
    s.fd = gbm_bo_get_fd(s.bo);
    s.stride = gbm_bo_get_stride(s.bo);
    s.offset = gbm_bo_get_offset(s.bo, 0);
    s.modifier = gbm_bo_get_modifier(s.bo);
    if (s.fd < 0) {
      *error = "gbm_bo_get_fd failed";
      FreeRing(ring.get());
      return nullptr;
    }
    const off_t end = lseek(s.fd, 0, SEEK_END);
    s.size = end > 0 ? static_cast<uint64_t>(end) : static_cast<uint64_t>(s.stride) * height + s.offset;
    lseek(s.fd, 0, SEEK_SET);

    EGLint attribs[32];
    int n = 0;
    attribs[n++] = EGL_WIDTH;
    attribs[n++] = width;
    attribs[n++] = EGL_HEIGHT;
    attribs[n++] = height;
    attribs[n++] = EGL_LINUX_DRM_FOURCC_EXT;
    attribs[n++] = static_cast<EGLint>(GBM_FORMAT_ABGR8888);
    attribs[n++] = EGL_DMA_BUF_PLANE0_FD_EXT;
    attribs[n++] = s.fd;
    attribs[n++] = EGL_DMA_BUF_PLANE0_OFFSET_EXT;
    attribs[n++] = static_cast<EGLint>(s.offset);
    attribs[n++] = EGL_DMA_BUF_PLANE0_PITCH_EXT;
    attribs[n++] = static_cast<EGLint>(s.stride);
    if (s.modifier != kModifierInvalid) {
      attribs[n++] = EGL_DMA_BUF_PLANE0_MODIFIER_LO_EXT;
      attribs[n++] = static_cast<EGLint>(s.modifier & 0xffffffffu);
      attribs[n++] = EGL_DMA_BUF_PLANE0_MODIFIER_HI_EXT;
      attribs[n++] = static_cast<EGLint>(s.modifier >> 32);
    }
    attribs[n++] = EGL_NONE;
    s.image = create_image_(display_, EGL_NO_CONTEXT, EGL_LINUX_DMA_BUF_EXT, nullptr, attribs);
    if (s.image == EGL_NO_IMAGE_KHR) {
      *error = EglError("eglCreateImage(dmabuf)");
      FreeRing(ring.get());
      return nullptr;
    }
    glGenTextures(1, &s.texture);
    glBindTexture(GL_TEXTURE_2D, s.texture);
    image_target_texture_(GL_TEXTURE_2D, s.image);
    glGenFramebuffers(1, &s.fbo);
    glBindFramebuffer(GL_FRAMEBUFFER, s.fbo);
    glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, s.texture, 0);
    const GLenum status = glCheckFramebufferStatus(GL_FRAMEBUFFER);
    glBindFramebuffer(GL_FRAMEBUFFER, 0);
    glBindTexture(GL_TEXTURE_2D, 0);
    if (status != GL_FRAMEBUFFER_COMPLETE) {
      char buf[64];
      std::snprintf(buf, sizeof buf, "framebuffer incomplete (0x%x)", status);
      *error = buf;
      FreeRing(ring.get());
      return nullptr;
    }
  }
  ring->generation = next_generation_++;
  return ring;
}

void Renderer::FreeSlot(Slot* s) {
  if (s->fbo) glDeleteFramebuffers(1, &s->fbo);
  if (s->texture) glDeleteTextures(1, &s->texture);
  if (s->image != EGL_NO_IMAGE_KHR) destroy_image_(display_, s->image);
  if (s->fd >= 0) close(s->fd);
  if (s->bo) gbm_bo_destroy(s->bo);
  *s = Slot{};
}

void Renderer::FreeRing(Ring* ring) {
  for (Slot& s : ring->slots) FreeSlot(&s);
}

void Renderer::Announce(const Ring& ring) {
  std::vector<BufferInfo> buffers;
  for (int i = 0; i < kSlots; i++) {
    const Slot& s = ring.slots[i];
    BufferInfo b;
    b.slot = static_cast<uint32_t>(i);
    b.fd = s.fd;
    b.stride = s.stride;
    b.offset = s.offset;
    b.size = s.size;
    b.modifier = s.modifier;
    b.width = static_cast<uint32_t>(ring.width);
    b.height = static_cast<uint32_t>(ring.height);
    buffers.push_back(b);
  }
  cb_.buffers(ring.generation, std::move(buffers));
}

void Renderer::MarkReleased(uint32_t generation, uint32_t slot) {
  if (slot >= static_cast<uint32_t>(kSlots)) return;
  if (ring_ && ring_->generation == generation) {
    ring_->slots[slot].busy = false;
    return;
  }
  for (auto& r : retired_)
    if (r->generation == generation) r->slots[slot].busy = false;
}

void Renderer::FreeRetired() {
  for (auto it = retired_.begin(); it != retired_.end();) {
    Ring& r = **it;
    bool all_free = true;
    if (delivered_ > r.generation) {
      for (Slot& s : r.slots) {
        if (!s.busy)
          FreeSlot(&s);
        else
          all_free = false;
      }
    } else {
      all_free = false;
    }
    it = all_free ? retired_.erase(it) : it + 1;
  }
}

void Renderer::Teardown() {
  // The render context must be freed on this thread, with the GL context
  // current, and before mpv_terminate_destroy (Player does that afterwards).
  if (render_) {
    mpv_->mpv_render_context_free(render_);
    render_ = nullptr;
  }
  if (display_ != EGL_NO_DISPLAY && context_ != EGL_NO_CONTEXT) {
    if (ring_) FreeRing(ring_.get());
    for (auto& r : retired_) FreeRing(r.get());
  }
  ring_.reset();
  retired_.clear();
  Device d{fd_, gbm_, display_, owns_display_, context_};
  CloseDevice(&d);
  fd_ = -1;
  gbm_ = nullptr;
  display_ = EGL_NO_DISPLAY;
  owns_display_ = false;
  context_ = EGL_NO_CONTEXT;
}

}  // namespace wicaby
