import { createRequire } from 'node:module';
import path from 'node:path';
import { logger } from '../core/log';

const log = logger.scope('libmpv');

// The wicaby_mpv addon (native/mpv-render, Linux only): libmpv in this process, rendering into a ring of GBM
// dmabufs the playback window imports as shared textures (video-surface.ts). Every call except setOption and
// initialize (synchronous, before playback starts) only enqueues work on the addon's own threads, so a slow mpv
// never blocks the main thread. probe() also runs synchronously, once, at startup.

// Whether the render path can start: the render node opened, a GBM device and an EGL display and context made on
// it (then torn down). node: the one tried, WICABY_RENDER_NODE or the first /dev/dri/renderD* where EGL starts.
export interface NativeRenderProbe {
  ok: boolean;
  node: string;
  error?: string;
}

// libmpv loaded (ok) with its mpv_client_api_version(), or why not; render is probed either way. Texture mode
// needs both. ffmpegRebound: diagnostics only (FFmpeg relocations rebound, non-zero inside Electron).
export type NativeProbe =
  | { ok: true; apiVersion: number; ffmpegRebound: number; render: NativeRenderProbe }
  | { ok: false; error: string; render?: NativeRenderProbe };

export interface NativeBuffer {
  slot: number;
  fd: number;
  stride: number;
  offset: number;
  size: number;
  // Decimal u64, as Electron's NativePixmap takes it.
  modifier: string;
  width: number;
  height: number;
  fourcc: 'AB24';
}

export type NativeEvent =
  // mpv_observe_property, MPV_FORMAT_NODE converted to plain JS.
  | { type: 'property'; name: string; data: unknown }
  // Shaped like a JSON IPC event ({ event: name, ...fields }): end-file carries reason
  // ('eof'|'stop'|'quit'|'error'|'redirect'), file_error (mpv_error_string) and playlist_entry_id.
  | { type: 'event'; name: string; msg: Record<string, unknown> }
  // mpv_request_log_messages('warn').
  | { type: 'log'; prefix: string; level: string; text: string }
  | { type: 'buffers'; generation: number; buffers: NativeBuffer[] }
  | { type: 'frame'; generation: number; slot: number }
  // MPV_EVENT_SHUTDOWN, or the core is gone.
  | { type: 'shutdown' }
  // Render thread failure (EGL/GBM): no picture can come out of this player any more.
  | { type: 'error'; message: string };

export interface NativePlayer {
  // Before initialize only (mpv_set_option_string); throws with mpv_error_string.
  setOption(name: string, value: string): void;
  // mpv_initialize, then the render thread, render context and first buffer ring: vo=libmpv needs the context
  // before the first loadfile.
  initialize(width: number, height: number): void;
  // mpv_command_node_async; rejects with Error(mpv_error_string).
  command(args: unknown[]): Promise<unknown>;
  setProperty(name: string, value: unknown): Promise<void>;
  getProperty(name: string): Promise<unknown>;
  observe(name: string): void;
  resize(width: number, height: number): void;
  // A no-op once destroyed: a frame still in flight in the renderer may come back after teardown.
  releaseFrame(generation: number, slot: number): void;
  // Stops rendering, frees the render context on its thread, mpv_terminate_destroy, frees the buffers. Idempotent.
  destroy(): Promise<void>;
}

export interface LibmpvNative {
  // renderNode: as create(); omitted, the same automatic choice.
  probe(renderNode?: string): NativeProbe;
  create(onEvent: (e: NativeEvent) => void, renderNode?: string): NativePlayer;
}

let loaded: LibmpvNative | null | undefined;
let probed: NativeProbe = { ok: false, error: 'native addon not loaded' };

// The addon, or null (not Linux, not built, libmpv missing): playback then falls back to mpv's own window.
// Loaded and probed once, on first use, so Windows and X11 never touch it. A render path that failed its probe
// still returns the addon: libmpvProbe() says so, and index.ts decides.
export function loadLibmpvNative(): LibmpvNative | null {
  if (loaded !== undefined) return loaded;
  loaded = null;
  if (process.platform !== 'linux') {
    probed = { ok: false, error: 'not Linux' };
    return loaded;
  }
  try {
    // out/main/index.cjs → out/native (asarUnpack: loading a .node from inside the archive copies it to /tmp first, which fails when /tmp is noexec).
    const file = path.join(__dirname, '..', 'native', 'wicaby_mpv.node');
    const addon = createRequire(__filename)(file) as LibmpvNative;
    probed = addon.probe();
    if (!probed.ok) {
      log.warn(`libmpv unavailable: ${probed.error}`);
      return loaded;
    }
    const { apiVersion: api, render } = probed;
    log.info(`libmpv client API ${api >>> 16}.${api & 0xffff}, render ${render.ok ? `ok on ${render.node}` : `failed on ${render.node || '?'}: ${render.error ?? 'unknown error'}`}`);
    loaded = addon;
  } catch (err) {
    probed = { ok: false, error: `native addon not loaded: ${err instanceof Error ? err.message : String(err)}` };
    log.warn('libmpv addon not loaded', err);
  }
  return loaded;
}

// The one probe loadLibmpvNative() ran (it loads the addon first if needed), with the real reason when it failed:
// probing again would redo the dlopen and the EGL setup for nothing.
export function libmpvProbe(): NativeProbe {
  loadLibmpvNative();
  return probed;
}
