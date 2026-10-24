// wicaby_mpv.node: libmpv rendered into dmabufs for Electron's sharedTexture
// (native Wayland texture mode). The JS contract lives in
// src/main/playback/libmpv-native.ts; see player.h for the threading model.
#include <napi.h>

#include "mpv_api.h"
#include "player.h"
#include "renderer.h"

namespace {

// probe(renderNode?): never throws.
//   { ok, apiVersion, ffmpegRebound, render } or { ok: false, error, render }
// ok/error is about libmpv (missing, too old, FFmpeg rebinding failed).
// render: { ok, node, error? } tries the render node the way a player's render
// thread would (open, GBM device, EGL display, GLES 3 context, then frees it
// all): renderNode if given, else WICABY_RENDER_NODE, else the first
// /dev/dri/renderD* that works. create() without a renderNode uses the same
// node. Texture mode needs both ok and render.ok.
Napi::Value Probe(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::string error;
  const wicaby::MpvApi* mpv = wicaby::LoadMpv(&error);
  Napi::Object result = Napi::Object::New(env);
  result.Set("ok", mpv != nullptr);
  if (mpv) {
    result.Set("apiVersion", static_cast<double>(mpv->api_version));
    // Diagnostics only: non-zero inside Electron.
    result.Set("ffmpegRebound", mpv->ffmpeg_rebound);
  } else {
    result.Set("error", error);
  }
  std::string node;
  if (info.Length() > 0 && info[0].IsString()) node = info[0].As<Napi::String>().Utf8Value();
  std::string render_error;
  const bool render_ok = node.empty() ? wicaby::Renderer::ResolveNode(&node, &render_error)
                                      : wicaby::Renderer::ProbeNode(node, &render_error);
  Napi::Object render = Napi::Object::New(env);
  render.Set("ok", render_ok);
  render.Set("node", node);
  if (!render_ok) render.Set("error", render_error);
  result.Set("render", render);
  return result;
}

// create(onEvent, renderNode?): NativePlayer
Napi::Value Create(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  auto* ctor = env.GetInstanceData<Napi::FunctionReference>();
  return ctor->New({info[0], info[1]});
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  env.SetInstanceData(new Napi::FunctionReference(Napi::Persistent(wicaby::Player::Define(env))));
  exports.Set("probe", Napi::Function::New(env, Probe, "probe"));
  exports.Set("create", Napi::Function::New(env, Create, "create"));
  return exports;
}

}  // namespace

NODE_API_MODULE(wicaby_mpv, Init)
