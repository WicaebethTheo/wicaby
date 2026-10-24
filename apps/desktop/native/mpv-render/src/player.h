// NativePlayer: one libmpv core rendering into a dmabuf ring (see renderer.h).
//
// Threading model:
// - JS thread: every method. Each one only enqueues work: option setting
//   before mpv_initialize, mpv_*_async calls, mpv_observe_property, or a
//   request to the render thread. Nothing here waits for the core or the GPU
//   except mpv_initialize itself (config parsing, no file I/O beyond configs).
// - Event thread: mpv_wait_event(-1) loop. It deep-copies each event and
//   posts it to JS through one napi_threadsafe_function (unbounded queue,
//   non-blocking call), so a slow JS thread never stalls the core.
// - Render thread: Renderer; posts buffers/frame/error/ready the same way.
// - Teardown thread: started by destroy(); stops the render thread (which
//   frees the render context), stops and joins the event thread, calls
//   mpv_terminate_destroy, then posts the final "destroyed" message and
//   releases the threadsafe function. The tsfn queue is FIFO, so every event
//   posted before teardown reaches JS before destroy() resolves.
// State touched by more than one thread lives in Core and is either immutable
// after creation (mpv api, handle until teardown), atomic (stopping), or owned
// by Renderer's mutex. All JS-facing state (pending promises, gating queue,
// generation bookkeeping) is JS-thread only.
#pragma once

#include <napi.h>

#include <atomic>
#include <cstdint>
#include <functional>
#include <map>
#include <memory>
#include <string>
#include <thread>
#include <vector>

#include "mpv_api.h"
#include "renderer.h"
#include "value.h"

namespace wicaby {

struct Message;
class Player;
struct Core;

void CallJs(Napi::Env env, Napi::Function callback, Player* player, Message* message);
using EventTsfn = Napi::TypedThreadSafeFunction<Player, Message, CallJs>;

class Player : public Napi::ObjectWrap<Player> {
 public:
  static Napi::Function Define(Napi::Env env);
  explicit Player(const Napi::CallbackInfo& info);
  ~Player() override;

  void Dispatch(Napi::Env env, Napi::Function callback, Message& m);

 private:
  Napi::Value SetOption(const Napi::CallbackInfo& info);
  Napi::Value Initialize(const Napi::CallbackInfo& info);
  Napi::Value Command(const Napi::CallbackInfo& info);
  Napi::Value SetProperty(const Napi::CallbackInfo& info);
  Napi::Value GetProperty(const Napi::CallbackInfo& info);
  Napi::Value Observe(const Napi::CallbackInfo& info);
  Napi::Value Resize(const Napi::CallbackInfo& info);
  Napi::Value ReleaseFrame(const Napi::CallbackInfo& info);
  Napi::Value ProbeNextFrame(const Napi::CallbackInfo& info);
  Napi::Value Destroy(const Napi::CallbackInfo& info);

  // Runs fn now if the render context is ready, else after it is: vo=libmpv
  // needs the context before the first loadfile, and queueing every mpv call
  // keeps them in order.
  void WhenReady(std::function<void()> fn);
  Napi::Value Rejected(Napi::Env env, const std::string& message);
  uint64_t Expect(Napi::Promise::Deferred deferred);
  void Fail(uint64_t id, const std::string& message);
  void Finish(Napi::Env env);

  std::shared_ptr<Core> core_;
  bool initialized_ = false;
  bool ready_ = false;
  bool destroying_ = false;
  bool destroyed_ = false;
  uint32_t generation_ = 0;  // newest 'buffers' generation delivered to JS
  uint64_t next_id_ = 1;     // reply_userdata; 0 is used for observe
  std::map<uint64_t, Napi::Promise::Deferred> pending_;
  std::vector<std::function<void()>> queued_;
  std::vector<Napi::Promise::Deferred> destroy_waiters_;
  Napi::ObjectReference self_;  // keeps this object alive until destroyed
};

}  // namespace wicaby
