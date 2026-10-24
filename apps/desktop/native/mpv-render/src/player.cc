#include "player.h"

#include <algorithm>
#include <chrono>
#include <clocale>
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <mutex>
#include <utility>

namespace wicaby {

struct Message {
  enum class Type { kProperty, kEvent, kLog, kReply, kBuffers, kFrame, kShutdown, kError, kReady, kDestroyed };
  explicit Message(Type t) : type(t) {}
  Type type;
  std::string name;  // property or event name; error message
  Value value;       // property data, event fields, reply result
  std::string prefix;
  std::string level;
  std::string text;
  uint64_t id = 0;
  int error = 0;
  uint32_t generation = 0;
  uint32_t slot = 0;
  std::vector<BufferInfo> buffers;
  std::vector<int> probe;  // kFrame: see Renderer::Callbacks::frame
};

struct Core {
  const MpvApi* mpv = nullptr;
  mpv_handle* handle = nullptr;
  std::string render_node;
  EventTsfn tsfn;
  std::unique_ptr<Renderer> renderer;
  std::thread events;
  std::thread teardown;
  std::atomic<bool> stopping{false};
  // Cleared when the process or environment is going away: the tsfn may be
  // closed by Node, so nothing more is posted.
  std::atomic<bool> posting{true};
  std::shared_ptr<Core>* cleanup_arg = nullptr;
  // Teardown runs once, on the teardown thread only. A hung core can block it
  // forever (in the render thread join or mpv_terminate_destroy), so the exit
  // paths wait for it with a time limit (ExitTeardown), never on a mutex.
  enum class State { kIdle, kRunning, kDone };
  std::mutex state_mu;
  std::condition_variable state_cv;
  State state = State::kIdle;  // guarded by state_mu
  bool abandoned = false;      // guarded by state_mu; left behind at exit
  std::atomic<bool> first_frame{false};

  Core();
  ~Core();
  // Any thread. Non-blocking: the tsfn queue is unbounded.
  void Post(Message* m) {
    if (!posting.load() || tsfn.NonBlockingCall(m) != napi_ok) delete m;
  }
  void EventLoop();
  void Teardown(bool notify);
  bool ExitTeardown();
};

namespace {

// Live cores, for the exit() path: process.exit() in plain Node runs neither
// env cleanup hooks nor finalizers, and the GPU driver's exit handler would
// then run under a render thread that is still drawing (seen as a segfault in
// glBindFramebuffer). Electron's app.exit/quit go through EnvCleanup instead.
// Heap-allocated and never freed so no static destructor races the handler.
std::mutex& RegistryMutex() {
  static auto* mu = new std::mutex;
  return *mu;
}
std::vector<Core*>& Registry() {
  static auto* cores = new std::vector<Core*>;
  return *cores;
}

void TeardownAllAtExit() {
  std::vector<Core*> cores;
  {
    std::lock_guard<std::mutex> lock(RegistryMutex());
    cores = Registry();
  }
  for (Core* c : cores) c->ExitTeardown();
}

}  // namespace

Core::Core() {
  // Not std::call_once: see LoadMpv.
  static const bool registered = (std::atexit(TeardownAllAtExit), true);
  (void)registered;
  std::lock_guard<std::mutex> lock(RegistryMutex());
  Registry().push_back(this);
}

Core::~Core() {
  std::lock_guard<std::mutex> lock(RegistryMutex());
  auto& cores = Registry();
  cores.erase(std::remove(cores.begin(), cores.end(), this), cores.end());
}

namespace {

const char* EndReason(int reason) {
  switch (reason) {
    case MPV_END_FILE_REASON_EOF:
      return "eof";
    case MPV_END_FILE_REASON_STOP:
      return "stop";
    case MPV_END_FILE_REASON_QUIT:
      return "quit";
    case MPV_END_FILE_REASON_ERROR:
      return "error";
    case MPV_END_FILE_REASON_REDIRECT:
      return "redirect";
    default:
      return "unknown";
  }
}

// Runs when the Node environment is torn down (Electron quit, worker exit,
// Node's normal exit) with a player that was never destroyed. Registered after the tsfn so it runs
// before Node closes it (cleanup hooks run in reverse order).
void EnvCleanup(void* arg) {
  auto* holder = static_cast<std::shared_ptr<Core>*>(arg);
  // On a timeout the teardown thread still uses the core: leak it with the
  // holder rather than destroy a joinable std::thread.
  if ((*holder)->ExitTeardown()) delete holder;
}

int ToSize(const Napi::Value& v) {
  if (!v.IsNumber()) return 0;
  const double d = v.As<Napi::Number>().DoubleValue();
  if (!(d >= 1 && d <= Renderer::kMaxSize)) return 0;
  return static_cast<int>(d);
}

}  // namespace

// Event thread. mpv's event memory is only valid until the next
// mpv_wait_event(), hence the deep copies.
void Core::EventLoop() {
  for (;;) {
    mpv_event* e = mpv->mpv_wait_event(handle, -1);
    if (stopping.load()) return;
    switch (e->event_id) {
      case MPV_EVENT_NONE:
        break;
      case MPV_EVENT_SHUTDOWN:
        Post(new Message(Message::Type::kShutdown));
        return;
      case MPV_EVENT_LOG_MESSAGE: {
        auto* log = static_cast<mpv_event_log_message*>(e->data);
        auto* m = new Message(Message::Type::kLog);
        m->prefix = log->prefix ? log->prefix : "";
        m->level = log->level ? log->level : "";
        m->text = log->text ? log->text : "";
        Post(m);
        break;
      }
      case MPV_EVENT_PROPERTY_CHANGE: {
        auto* prop = static_cast<mpv_event_property*>(e->data);
        auto* m = new Message(Message::Type::kProperty);
        m->name = prop->name ? prop->name : "";
        if (prop->format == MPV_FORMAT_NODE && prop->data) m->value = FromNode(*static_cast<mpv_node*>(prop->data));
        Post(m);
        break;
      }
      case MPV_EVENT_COMMAND_REPLY:
      case MPV_EVENT_SET_PROPERTY_REPLY:
      case MPV_EVENT_GET_PROPERTY_REPLY: {
        auto* m = new Message(Message::Type::kReply);
        m->id = e->reply_userdata;
        m->error = e->error;
        if (e->error >= 0 && e->data) {
          if (e->event_id == MPV_EVENT_COMMAND_REPLY) {
            m->value = FromNode(static_cast<mpv_event_command*>(e->data)->result);
          } else if (e->event_id == MPV_EVENT_GET_PROPERTY_REPLY) {
            auto* prop = static_cast<mpv_event_property*>(e->data);
            if (prop->format == MPV_FORMAT_NODE && prop->data) m->value = FromNode(*static_cast<mpv_node*>(prop->data));
          }
        }
        Post(m);
        break;
      }
      default: {
        // Shaped like mpv's JSON IPC events, which MpvPlayer already parses.
        const char* name = mpv->mpv_event_name(e->event_id);
        auto* m = new Message(Message::Type::kEvent);
        m->name = name ? name : "unknown";
        m->value = Value::Map();
        m->value.Set("event", Value::String(m->name));
        if (e->event_id == MPV_EVENT_START_FILE && e->data) {
          m->value.Set("playlist_entry_id",
                       Value::Int(static_cast<mpv_event_start_file*>(e->data)->playlist_entry_id));
        } else if (e->event_id == MPV_EVENT_END_FILE && e->data) {
          auto* end = static_cast<mpv_event_end_file*>(e->data);
          m->value.Set("reason", Value::String(EndReason(end->reason)));
          m->value.Set("playlist_entry_id", Value::Int(end->playlist_entry_id));
          if (end->error < 0) m->value.Set("file_error", Value::String(mpv->mpv_error_string(end->error)));
          if (end->playlist_insert_id) {
            m->value.Set("playlist_insert_id", Value::Int(end->playlist_insert_id));
            m->value.Set("playlist_insert_num_entries", Value::Int(end->playlist_insert_num_entries));
          }
        } else if (e->event_id == MPV_EVENT_CLIENT_MESSAGE && e->data) {
          auto* cm = static_cast<mpv_event_client_message*>(e->data);
          Value args;
          args.kind = Value::Kind::kArray;
          for (int i = 0; i < cm->num_args; i++) args.items.push_back(Value::String(cm->args[i] ? cm->args[i] : ""));
          m->value.Set("args", std::move(args));
        }
        Post(m);
        break;
      }
    }
  }
}

// Teardown thread only (started by destroy() or by ExitTeardown), once. Order
// matters: the render context must be gone before mpv_terminate_destroy, and
// the event thread must be joined before the handle is destroyed.
void Core::Teardown(bool notify) {
  {
    std::lock_guard<std::mutex> lock(state_mu);
    if (state != State::kIdle) return;
    state = State::kRunning;
  }
  if (renderer) renderer->Stop();
  stopping = true;
  if (handle) mpv->mpv_wakeup(handle);
  if (events.joinable()) events.join();
  if (handle) mpv->mpv_terminate_destroy(handle);
  handle = nullptr;
  {
    std::lock_guard<std::mutex> registry(RegistryMutex());
    auto& cores = Registry();
    cores.erase(std::remove(cores.begin(), cores.end(), this), cores.end());
  }
  bool skip;
  {
    std::lock_guard<std::mutex> lock(state_mu);
    state = State::kDone;
    // Abandoned at exit: Node may already have freed the tsfn.
    skip = abandoned;
  }
  state_cv.notify_all();
  if (notify && !skip) {
    Post(new Message(Message::Type::kDestroyed));
    tsfn.Release();
  }
}

// The exit paths (EnvCleanup, the atexit handler), on the main thread: tear
// down a player that destroy() did not finish, waiting at most kExitWait.
// Past that the core is abandoned: the teardown thread is detached and the
// process exits around it (a hung core used to keep Electron alive forever,
// holding the single-instance lock). Returns false then; the Core must stay
// allocated. Abandoned cores return false at once on later calls.
bool Core::ExitTeardown() {
  constexpr auto kExitWait = std::chrono::seconds(2);
  posting = false;
  std::unique_lock<std::mutex> lock(state_mu);
  if (abandoned) return false;
  if (state == State::kIdle && !teardown.joinable()) teardown = std::thread([this] { Teardown(false); });
  if (!state_cv.wait_for(lock, kExitWait, [this] { return state == State::kDone; })) {
    abandoned = true;
    lock.unlock();
    std::fprintf(stderr, "wicaby_mpv: libmpv teardown did not finish in 2 s; leaving it behind\n");
    if (teardown.joinable()) teardown.detach();
    return false;
  }
  lock.unlock();
  if (teardown.joinable()) teardown.join();
  return true;
}

void CallJs(Napi::Env env, Napi::Function callback, Player* player, Message* message) {
  std::unique_ptr<Message> m(message);
  if (env == nullptr || player == nullptr) return;  // environment shutting down
  player->Dispatch(env, callback, *m);
}

Napi::Function Player::Define(Napi::Env env) {
  return DefineClass(env, "NativePlayer",
                     {
                         InstanceMethod<&Player::SetOption>("setOption"),
                         InstanceMethod<&Player::Initialize>("initialize"),
                         InstanceMethod<&Player::Command>("command"),
                         InstanceMethod<&Player::SetProperty>("setProperty"),
                         InstanceMethod<&Player::GetProperty>("getProperty"),
                         InstanceMethod<&Player::Observe>("observe"),
                         InstanceMethod<&Player::Resize>("resize"),
                         InstanceMethod<&Player::ReleaseFrame>("releaseFrame"),
                         InstanceMethod<&Player::ProbeNextFrame>("probeNextFrame"),
                         InstanceMethod<&Player::Destroy>("destroy"),
                     });
}

// new NativePlayer(onEvent, renderNode?)
Player::Player(const Napi::CallbackInfo& info) : Napi::ObjectWrap<Player>(info) {
  Napi::Env env = info.Env();
  std::string error;
  const MpvApi* mpv = LoadMpv(&error);
  if (!mpv) {
    Napi::Error::New(env, error).ThrowAsJavaScriptException();
    return;
  }
  if (!info[0].IsFunction()) {
    Napi::TypeError::New(env, "onEvent must be a function").ThrowAsJavaScriptException();
    return;
  }
  std::string render_node;
  if (info[1].IsString()) render_node = info[1].As<Napi::String>().Utf8Value();
  const char* env_node = std::getenv("WICABY_RENDER_NODE");
  if (render_node.empty() && env_node && *env_node) render_node = env_node;  // probe() checked it
  if (render_node.empty()) {
    // On failure the best guess is kept: the render thread then reports why.
    std::string unused;
    Renderer::ResolveNode(&render_node, &unused);
  }

  // mpv_create refuses a non-C LC_NUMERIC (it parses floats with strtod).
  // Chromium and V8 format numbers locale-independently, so this is safe.
  const char* numeric = std::setlocale(LC_NUMERIC, nullptr);
  if (!numeric || std::strcmp(numeric, "C") != 0) std::setlocale(LC_NUMERIC, "C");
  mpv_handle* handle = mpv->mpv_create();
  if (!handle) {
    Napi::Error::New(env, "mpv_create failed").ThrowAsJavaScriptException();
    return;
  }

  core_ = std::make_shared<Core>();
  core_->mpv = mpv;
  core_->handle = handle;
  core_->render_node = std::move(render_node);
  mpv->mpv_request_log_messages(handle, "warn");
  core_->tsfn = EventTsfn::New(env, info[0].As<Napi::Function>(), "wicaby_mpv", 0, 1, this);
  core_->cleanup_arg = new std::shared_ptr<Core>(core_);
  napi_add_env_cleanup_hook(env, EnvCleanup, core_->cleanup_arg);
  self_ = Napi::Persistent(info.This().As<Napi::Object>());
  core_->events = std::thread(&Core::EventLoop, core_.get());
}

Player::~Player() = default;

void Player::Dispatch(Napi::Env env, Napi::Function callback, Message& m) {
  Napi::HandleScope scope(env);
  auto emit = [&](Napi::Object e) { callback.Call({e}); };
  switch (m.type) {
    case Message::Type::kProperty: {
      Napi::Object e = Napi::Object::New(env);
      e.Set("type", "property");
      e.Set("name", m.name);
      e.Set("data", ToJs(env, m.value));
      emit(e);
      break;
    }
    case Message::Type::kEvent: {
      Napi::Object e = Napi::Object::New(env);
      e.Set("type", "event");
      e.Set("name", m.name);
      e.Set("msg", ToJs(env, m.value));
      emit(e);
      break;
    }
    case Message::Type::kLog: {
      Napi::Object e = Napi::Object::New(env);
      e.Set("type", "log");
      e.Set("prefix", m.prefix);
      e.Set("level", m.level);
      e.Set("text", m.text);
      emit(e);
      break;
    }
    case Message::Type::kReply: {
      auto it = pending_.find(m.id);
      if (it == pending_.end()) break;
      Napi::Promise::Deferred d = it->second;
      pending_.erase(it);
      if (m.error < 0)
        d.Reject(Napi::Error::New(env, core_->mpv->mpv_error_string(m.error)).Value());
      else
        d.Resolve(m.value.kind == Value::Kind::kNone ? env.Undefined() : ToJs(env, m.value));
      break;
    }
    case Message::Type::kBuffers: {
      // destroy() frees the fds, so a late announcement must not be imported.
      if (destroying_) break;
      generation_ = m.generation;
      Napi::Array list = Napi::Array::New(env, m.buffers.size());
      for (size_t i = 0; i < m.buffers.size(); i++) {
        const BufferInfo& b = m.buffers[i];
        Napi::Object o = Napi::Object::New(env);
        o.Set("slot", b.slot);
        o.Set("fd", b.fd);
        o.Set("stride", b.stride);
        o.Set("offset", b.offset);
        o.Set("size", static_cast<double>(b.size));
        o.Set("modifier", std::to_string(b.modifier));
        o.Set("width", b.width);
        o.Set("height", b.height);
        o.Set("fourcc", "AB24");
        list.Set(static_cast<uint32_t>(i), o);
      }
      Napi::Object e = Napi::Object::New(env);
      e.Set("type", "buffers");
      e.Set("generation", m.generation);
      e.Set("buffers", list);
      emit(e);
      core_->renderer->Delivered(m.generation);
      break;
    }
    case Message::Type::kFrame: {
      if (destroying_) break;
      // A frame rendered just before a resize: JS already dropped that
      // generation's imports, so hand the slot straight back.
      if (m.generation != generation_) {
        core_->renderer->Release(m.generation, m.slot);
        // Its probe would be lost: ask again so JS still gets one.
        if (!m.probe.empty()) core_->renderer->ProbeNextFrame();
        break;
      }
      Napi::Object e = Napi::Object::New(env);
      e.Set("type", "frame");
      e.Set("generation", m.generation);
      e.Set("slot", m.slot);
      if (!m.probe.empty()) {
        Napi::Array probe = Napi::Array::New(env, m.probe.size());
        for (size_t i = 0; i < m.probe.size(); i++) probe.Set(static_cast<uint32_t>(i), m.probe[i]);
        e.Set("probe", probe);
      }
      emit(e);
      break;
    }
    case Message::Type::kShutdown: {
      Napi::Object e = Napi::Object::New(env);
      e.Set("type", "shutdown");
      emit(e);
      break;
    }
    case Message::Type::kError: {
      Napi::Object e = Napi::Object::New(env);
      e.Set("type", "error");
      e.Set("message", m.name);
      emit(e);
      break;
    }
    case Message::Type::kReady: {
      // Also after a failed setup: mpv then reports vo errors itself, and
      // nothing hangs.
      ready_ = true;
      if (destroying_) break;
      std::vector<std::function<void()>> queued;
      queued.swap(queued_);
      for (auto& fn : queued) fn();
      break;
    }
    case Message::Type::kDestroyed:
      Finish(env);
      break;
  }
}

void Player::WhenReady(std::function<void()> fn) {
  if (ready_)
    fn();
  else
    queued_.push_back(std::move(fn));
}

Napi::Value Player::Rejected(Napi::Env env, const std::string& message) {
  auto d = Napi::Promise::Deferred::New(env);
  d.Reject(Napi::Error::New(env, message).Value());
  return d.Promise();
}

uint64_t Player::Expect(Napi::Promise::Deferred deferred) {
  const uint64_t id = next_id_++;
  pending_.emplace(id, deferred);
  return id;
}

void Player::Fail(uint64_t id, const std::string& message) {
  auto it = pending_.find(id);
  if (it == pending_.end()) return;
  Napi::Env env = it->second.Env();
  it->second.Reject(Napi::Error::New(env, message).Value());
  pending_.erase(it);
}

void Player::Finish(Napi::Env env) {
  destroyed_ = true;
  if (core_->teardown.joinable()) core_->teardown.join();
  napi_remove_env_cleanup_hook(env, EnvCleanup, core_->cleanup_arg);
  delete core_->cleanup_arg;
  core_->cleanup_arg = nullptr;
  auto pending = std::move(pending_);
  for (auto& p : pending) p.second.Reject(Napi::Error::New(env, "player destroyed").Value());
  auto waiters = std::move(destroy_waiters_);
  for (auto& d : waiters) d.Resolve(env.Undefined());
  self_.Reset();
}

Napi::Value Player::SetOption(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (destroying_) {
    Napi::Error::New(env, "player destroyed").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (initialized_) {
    Napi::Error::New(env, "setOption after initialize").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (!info[0].IsString()) {
    Napi::TypeError::New(env, "option name must be a string").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const std::string name = info[0].As<Napi::String>().Utf8Value();
  const std::string value = info[1].ToString().Utf8Value();
  const int r = core_->mpv->mpv_set_option_string(core_->handle, name.c_str(), value.c_str());
  if (r < 0) {
    Napi::Error::New(env, std::string(core_->mpv->mpv_error_string(r)) + ": " + name + "=" + value)
        .ThrowAsJavaScriptException();
  }
  return env.Undefined();
}

Napi::Value Player::Initialize(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const int width = ToSize(info[0]);
  const int height = ToSize(info[1]);
  if (destroying_ || initialized_) {
    Napi::Error::New(env, destroying_ ? "player destroyed" : "already initialized").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (!width || !height) {
    Napi::RangeError::New(env, "width and height must be 1..16384").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const int r = core_->mpv->mpv_initialize(core_->handle);
  if (r < 0) {
    Napi::Error::New(env, std::string("mpv_initialize: ") + core_->mpv->mpv_error_string(r))
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }
  initialized_ = true;
  Core* core = core_.get();
  Renderer::Callbacks cb;
  cb.buffers = [core](uint32_t generation, std::vector<BufferInfo> buffers) {
    auto* m = new Message(Message::Type::kBuffers);
    m->generation = generation;
    m->buffers = std::move(buffers);
    core->Post(m);
  };
  cb.frame = [core](uint32_t generation, uint32_t slot, std::vector<int> probe) {
    // atexit handlers run in reverse order: register again once the decoder
    // (CUDA, VA drivers) is up, so ours runs before theirs. Deliberately per
    // player, not once per process: a later player can be the first to bring
    // up a decoder driver (hwdec after software-decoded files), and an extra
    // entry costs one walk of the live-core registry at exit.
    if (!core->first_frame.exchange(true)) std::atexit(TeardownAllAtExit);
    auto* m = new Message(Message::Type::kFrame);
    m->generation = generation;
    m->slot = slot;
    m->probe = std::move(probe);
    core->Post(m);
  };
  cb.error = [core](std::string message) {
    auto* m = new Message(Message::Type::kError);
    m->name = std::move(message);
    core->Post(m);
  };
  cb.warn = [core](std::string message) {
    auto* m = new Message(Message::Type::kLog);
    m->prefix = "wicaby-render";
    m->level = "warn";
    m->text = std::move(message);
    core->Post(m);
  };
  // Its own prefix: 'wicaby-render' lines are warnings JS acts on.
  cb.info = [core](std::string message) {
    auto* m = new Message(Message::Type::kLog);
    m->prefix = "wicaby-render-info";
    m->level = "info";
    m->text = std::move(message);
    core->Post(m);
  };
  cb.ready = [core] {
    // Likewise after EGL init: the driver registers its own exit handler then.
    std::atexit(TeardownAllAtExit);
    core->Post(new Message(Message::Type::kReady));
  };
  core_->renderer = std::make_unique<Renderer>(core_->mpv, core_->handle, core_->render_node, std::move(cb));
  core_->renderer->Start(width, height);
  return env.Undefined();
}

Napi::Value Player::Command(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (destroying_) return Rejected(env, "player destroyed");
  if (!info[0].IsArray()) return Rejected(env, "command expects an array");
  auto builder = std::make_shared<NodeBuilder>();
  auto node = std::make_shared<mpv_node>();
  std::string error;
  if (!builder->Build(info[0], node.get(), &error)) return Rejected(env, error);
  auto d = Napi::Promise::Deferred::New(env);
  const uint64_t id = Expect(d);
  WhenReady([this, builder, node, id] {
    const int r = core_->mpv->mpv_command_node_async(core_->handle, id, node.get());
    if (r < 0) Fail(id, core_->mpv->mpv_error_string(r));
  });
  return d.Promise();
}

Napi::Value Player::SetProperty(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (destroying_) return Rejected(env, "player destroyed");
  if (!info[0].IsString()) return Rejected(env, "property name must be a string");
  auto name = std::make_shared<std::string>(info[0].As<Napi::String>().Utf8Value());
  auto builder = std::make_shared<NodeBuilder>();
  auto node = std::make_shared<mpv_node>();
  std::string error;
  if (!builder->Build(info[1], node.get(), &error)) return Rejected(env, error);
  auto d = Napi::Promise::Deferred::New(env);
  const uint64_t id = Expect(d);
  WhenReady([this, name, builder, node, id] {
    const int r = core_->mpv->mpv_set_property_async(core_->handle, id, name->c_str(), MPV_FORMAT_NODE, node.get());
    if (r < 0) Fail(id, core_->mpv->mpv_error_string(r));
  });
  return d.Promise();
}

Napi::Value Player::GetProperty(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (destroying_) return Rejected(env, "player destroyed");
  if (!info[0].IsString()) return Rejected(env, "property name must be a string");
  auto name = std::make_shared<std::string>(info[0].As<Napi::String>().Utf8Value());
  auto d = Napi::Promise::Deferred::New(env);
  const uint64_t id = Expect(d);
  WhenReady([this, name, id] {
    const int r = core_->mpv->mpv_get_property_async(core_->handle, id, name->c_str(), MPV_FORMAT_NODE);
    if (r < 0) Fail(id, core_->mpv->mpv_error_string(r));
  });
  return d.Promise();
}

Napi::Value Player::Observe(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (destroying_) return env.Undefined();
  if (!info[0].IsString()) {
    Napi::TypeError::New(env, "property name must be a string").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const std::string name = info[0].As<Napi::String>().Utf8Value();
  if (ready_) {
    const int r = core_->mpv->mpv_observe_property(core_->handle, 0, name.c_str(), MPV_FORMAT_NODE);
    if (r < 0) Napi::Error::New(env, core_->mpv->mpv_error_string(r)).ThrowAsJavaScriptException();
  } else {
    // Only fails for an invalid format, which is fixed here.
    WhenReady([this, name] { core_->mpv->mpv_observe_property(core_->handle, 0, name.c_str(), MPV_FORMAT_NODE); });
  }
  return env.Undefined();
}

Napi::Value Player::Resize(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (destroying_) return env.Undefined();
  const int width = ToSize(info[0]);
  const int height = ToSize(info[1]);
  if (!initialized_) {
    Napi::Error::New(env, "resize before initialize").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  if (!width || !height) {
    Napi::RangeError::New(env, "width and height must be 1..16384").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  core_->renderer->Resize(width, height);
  return env.Undefined();
}

Napi::Value Player::ReleaseFrame(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (destroying_ || !core_ || !core_->renderer) return env.Undefined();
  if (!info[0].IsNumber() || !info[1].IsNumber()) return env.Undefined();
  core_->renderer->Release(info[0].As<Napi::Number>().Uint32Value(), info[1].As<Napi::Number>().Uint32Value());
  return env.Undefined();
}

// probeNextFrame(): the next frame event carries `probe` (see renderer.h).
Napi::Value Player::ProbeNextFrame(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (destroying_ || !core_ || !core_->renderer) return env.Undefined();
  core_->renderer->ProbeNextFrame();
  return env.Undefined();
}

Napi::Value Player::Destroy(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto d = Napi::Promise::Deferred::New(env);
  if (destroyed_ || !core_) {
    d.Resolve(env.Undefined());
    return d.Promise();
  }
  destroy_waiters_.push_back(d);
  if (!destroying_) {
    destroying_ = true;
    queued_.clear();  // their promises are in pending_ and rejected by Finish
    std::shared_ptr<Core> core = core_;
    core_->teardown = std::thread([core] { core->Teardown(true); });
  }
  return d.Promise();
}

}  // namespace wicaby
