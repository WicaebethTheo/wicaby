import { EventEmitter } from 'node:events';
import { app, screen, sharedTexture, type BrowserWindow, type SharedTextureImported } from 'electron';
import { logger } from '../core/log';
import { Channels } from '../../shared/contract';
import type { LibmpvController } from './libmpv-controller';
import type { NativeBuffer, NativeEvent } from './libmpv-native';

const log = logger.scope('video-surface');

const RESIZE_DEBOUNCE_MS = 100;
// A send Electron gave up on (its 1 s transfer timeout) may still be drawn by a late renderer: its import keeps
// the slot this much longer before it is released.
const TIMED_OUT_HOLD_MS = 2000;
// Consecutive frames that could not be imported or delivered before the surface reports 'fatal'.
const FATAL_FAILURES = 60;
// At most one warning per failure streak, and at most one per this interval.
const WARN_INTERVAL_MS = 5000;
// A slot whose import Electron never reports released (a renderer that lost the frame) goes back to libmpv after this.
const RELEASE_WATCHDOG_MS = 5000;

// Picture check: libmpv reads back 5 pixels of a frame it rendered (probeNextFrame), the playback page reads the same
// pixels from the frame it received, and they must match. It catches what no error reports: a buffer Chromium imports
// with another layout or on another GPU, drawn as garbage or black (#14). A dark frame proves nothing and is retried;
// 2 matches in a row verify the path (then a check every 30 s), 3 mismatches in a row fail it for good.
const PROBE_DARK = 48;
const PROBE_DARK_RETRY_MS = 500;
const PROBE_REPLY_MS = 2000;
const PROBE_MAX_DIFF = 40;
const PROBE_VERIFIED = 2;
const PROBE_FAILED = 3;
const PROBE_RECHECK_MS = 30_000;

// native: [x, y, r, g, b] x n from libmpv; seen: [r, g, b] x n from the playback page. A mean channel difference up
// to PROBE_MAX_DIFF is the same picture (sampling and conversion differ a little); anything malformed is not.
export function probeVerdict(native: number[], seen: number[]): 'ok' | 'bad' {
  const n = Math.floor(native.length / 5);
  if (!n || seen.length !== n * 3) return 'bad';
  let sum = 0;
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) sum += Math.abs(native[i * 5 + 2 + c] - seen[i * 3 + c]);
  return sum / (n * 3) <= PROBE_MAX_DIFF ? 'ok' : 'bad';
}

// "rgb(r,g,b) ..." for the log: three values every stride, from off.
function pixels(v: number[], stride: number, off: number): string {
  const out: string[] = [];
  for (let i = off; i + 2 < v.length; i += stride) out.push(`rgb(${v[i]},${v[i + 1]},${v[i + 2]})`);
  return out.join(' ');
}

interface Ring {
  generation: number;
  buffers: Map<number, NativeBuffer>;
}

// Texture mode's frame pump (main process). Every rendered frame of libmpv's ring is imported as a shared texture
// on its own, sent to the playback window, where the preload draws it on the video canvas, and released here once
// the send settles. The slot goes back to the addon only from allReferencesReleased: Electron fires it once main
// and the renderer have both released the texture, and the renderer releases only after its GPU work on the frame
// is done, so libmpv never renders into a buffer Chromium may still sample. Also keeps the ring at the window's
// size in physical pixels.
//
// Events: 'fatal' (message: string) after FATAL_FAILURES frames in a row could not be imported or delivered, when
// the playback page reports a frame it could not draw, when the picture check fails, or when Chromium's GPU process
// goes or stops drawing on the GPU, once per surface: the picture is gone for good (audio may still play).
export class VideoSurface extends EventEmitter {
  private ring: Ring | null = null;
  // `${generation}:${slot}` from its frame event until allReferencesReleased: never two imports of one slot. The value
  // is that import's release watchdog, which also tells a late release of an older import from the current one's.
  private readonly pending = new Map<string, NodeJS.Timeout>();
  // Imports whose send timed out, released after TIMED_OUT_HOLD_MS.
  private readonly held = new Map<SharedTextureImported, NodeJS.Timeout>();
  private size = { width: 0, height: 0 };
  private resizeTimer: NodeJS.Timeout | null = null;
  private failures = 0;
  private lastWarnAt = -Infinity;
  private fatal = false;
  private destroyed = false;
  // The picture check (PROBE_*): the frame whose answer is awaited, the next request, the streaks.
  private probe: { key: string; native: number[]; timer: NodeJS.Timeout } | null = null;
  private probeTimer: NodeJS.Timeout | null = null;
  private probeOk = 0;
  private probeBad = 0;

  private readonly onBuffers = (e: Extract<NativeEvent, { type: 'buffers' }>) => this.setRing(e.generation, e.buffers);
  private readonly onFrame = (e: Extract<NativeEvent, { type: 'frame' }>) => void this.sendFrame(e.generation, e.slot, e.probe);
  private readonly onGeometry = () => this.scheduleResize();
  // A ring resize the addon could not allocate keeps the old ring: forget the size, so the next geometry change
  // (even back to the same size) asks again.
  private readonly onRenderWarning = () => (this.size = { width: 0, height: 0 });
  // The playback page could not draw a frame (preload): every frame fails alike, so no picture for good.
  private readonly onDrawFailed = (_e: unknown, msg: unknown) => this.fail(`video frame not drawn by the playback window: ${String(msg)}`);
  // The playback page's pixels for a probed frame (preload).
  private readonly onProbeReply = (_e: unknown, msg: unknown) => {
    const m = (msg ?? {}) as { generation?: unknown; slot?: unknown; rgb?: unknown };
    this.probeResult(`${String(m.generation)}:${String(m.slot)}`, Array.isArray(m.rgb) ? m.rgb.slice(0, 15).map(Number) : null);
  };
  // The GPU process gone, or Chromium back in software: imports stop working or go black, with no error.
  private readonly onGpuGone = (_e: unknown, d: Electron.Details) => {
    if (d.type === 'GPU') this.fail(`Chromium's GPU process went away during playback (${d.reason}, exit code ${d.exitCode})`);
  };
  private readonly onGpuInfo = () => {
    const s = app.getGPUFeatureStatus() as unknown as Record<string, string | undefined>;
    const lost = ['gpu_compositing', '2d_canvas'].filter((k) => s[k] && !s[k].startsWith('enabled'));
    if (lost.length) this.fail(`Chromium stopped drawing on the GPU during playback (${lost.map((k) => `${k} ${s[k]}`).join(', ')})`);
  };

  constructor(
    private readonly win: BrowserWindow,
    private readonly ctl: LibmpvController,
    // WindowManager.isAppUrl: frames only ever go to Wicaby's own page.
    private readonly isAppUrl: (url: string) => boolean,
  ) {
    super();
    ctl.on('buffers', this.onBuffers);
    ctl.on('frame', this.onFrame);
    ctl.on('render-warning', this.onRenderWarning);
    win.on('resize', this.onGeometry);
    win.on('move', this.onGeometry);
    win.webContents.ipc.on(Channels.videoDrawFailed, this.onDrawFailed);
    win.webContents.ipc.on(Channels.videoProbe, this.onProbeReply);
    app.on('child-process-gone', this.onGpuGone);
    app.on('gpu-info-update', this.onGpuInfo);
    // A display scale change keeps the window's DIP size but not its pixel count.
    screen.on('display-metrics-changed', this.onGeometry);
    if (ctl.lastBuffers) this.setRing(ctl.lastBuffers.generation, ctl.lastBuffers.buffers);
    this.resize();
  }

  // Nothing to import or free here: the addon keeps a replaced ring's buffers (and fds) until every frame of it
  // came back, and Electron dups the fds it imports. Frames of an older generation still in flight finish normally.
  // A new ring is new buffers: the picture is checked again.
  private setRing(generation: number, buffers: NativeBuffer[]): void {
    if (this.destroyed || generation === this.ring?.generation) return;
    this.ring = { generation, buffers: new Map(buffers.map((b) => [b.slot, b])) };
    this.requestProbe();
  }

  private async sendFrame(generation: number, slot: number, probe?: number[]): Promise<void> {
    const native = this.ctl.native;
    const key = `${generation}:${slot}`;
    // Already imported: the addon gets this slot back from that import's allReferencesReleased.
    if (this.pending.has(key)) return this.reprobe(probe);
    const b = this.ring?.generation === generation ? this.ring.buffers.get(slot) : undefined;
    const frame = this.win.isDestroyed() ? null : this.win.webContents.mainFrame;
    // A stale ring, a window gone or showing anything but Wicaby: drop the frame, not a delivery failure.
    if (this.destroyed || !b || !frame || !this.isAppUrl(frame.url)) {
      this.reprobe(probe);
      return native.releaseFrame(generation, slot);
    }
    // After destroy() this still runs; the addon ignores releases once it is destroyed. Only the import that holds
    // the slot frees it: a late release of an older import of the same slot (after its watchdog) does nothing.
    const free = () => {
      if (this.pending.get(key) !== watchdog) return;
      clearTimeout(watchdog);
      this.pending.delete(key);
      native.releaseFrame(generation, slot);
    };
    const watchdog = setTimeout(() => {
      log.warn(`frame ${key} not released after ${RELEASE_WATCHDOG_MS / 1000} s: slot handed back to libmpv`);
      free();
    }, RELEASE_WATCHDOG_MS);
    watchdog.unref();
    this.pending.set(key, watchdog);
    let imp: SharedTextureImported;
    try {
      imp = sharedTexture.importSharedTexture({ textureInfo: textureInfo(b), allReferencesReleased: free });
    } catch (err) {
      free();
      this.reprobe(probe);
      this.failed(`frame not imported: ${message(err)}`);
      return;
    }
    // A probed frame: lit, its points go with it and the page answers with what it sees there; dark, another later.
    let points: number[] | undefined;
    if (probe && !this.probe) {
      if (Math.max(...probe.filter((_, i) => i % 5 >= 2)) < PROBE_DARK) this.requestProbe(PROBE_DARK_RETRY_MS);
      else {
        points = probe.filter((_, i) => i % 5 < 2);
        this.probe = { key, native: probe, timer: setTimeout(() => this.probeResult(key, null), PROBE_REPLY_MS) };
      }
    }
    try {
      await sharedTexture.sendSharedTexture({ frame, importedSharedTexture: imp }, points ? { generation, slot, probe: points } : { generation, slot });
      this.delivered();
    } catch (err) {
      // A rejection is always a fault: with no receiver registered yet the renderer still answers success. It is
      // Electron's 1 s timeout (renderer hung or gone) or a texture Electron no longer knows. A probed frame that
      // never arrived says nothing about the picture: another one is probed.
      const msg = message(err);
      if (this.probe?.key === key) this.cancelProbe(true);
      this.failed(`frame not delivered: ${msg}`);
      if (/timed out/i.test(msg) && !this.destroyed) {
        this.held.set(
          imp,
          setTimeout(() => {
            this.held.delete(imp);
            release(imp);
          }, TIMED_OUT_HOLD_MS),
        );
        return;
      }
    }
    // Main's reference; the slot is freed when the renderer's (if it got one) goes too.
    release(imp);
  }

  private delivered(): void {
    if (this.failures) log.info(`frames delivered again after ${this.failures} failure(s)`);
    this.failures = 0;
  }

  private failed(msg: string): void {
    if (this.destroyed) return log.debug(msg);
    this.failures++;
    const now = Date.now();
    if (this.failures === 1 && now - this.lastWarnAt >= WARN_INTERVAL_MS) {
      this.lastWarnAt = now;
      log.warn(msg);
    } else log.debug(msg);
    if (this.failures >= FATAL_FAILURES) this.fail(`no video frame reached the playback window (${this.failures} in a row): ${msg}`);
  }

  private fail(message: string): void {
    if (this.fatal || this.destroyed) return;
    this.fatal = true;
    this.cancelProbe(false);
    log.error(message);
    this.emit('fatal', message);
  }

  // The next rendered frame carries a pixel probe, now or after delay ms.
  private requestProbe(delay = 0): void {
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.probeTimer = null;
    if (this.destroyed || this.fatal) return;
    const ask = () => {
      this.probeTimer = null;
      try {
        this.ctl.native.probeNextFrame();
      } catch (err) {
        log.debug(`probe not requested: ${message(err)}`);
      }
    };
    if (delay) this.probeTimer = setTimeout(ask, delay);
    else ask();
  }

  // A probed frame that was dropped: another one shortly.
  private reprobe(probe: number[] | undefined): void {
    if (probe) this.requestProbe(PROBE_DARK_RETRY_MS);
  }

  private cancelProbe(again: boolean): void {
    if (this.probe) clearTimeout(this.probe.timer);
    this.probe = null;
    if (again) this.requestProbe();
  }

  // seen: the page's [r, g, b] x 5, or null when it did not answer within PROBE_REPLY_MS (a mismatch too).
  private probeResult(key: string, seen: number[] | null): void {
    const p = this.probe;
    if (!p || p.key !== key || this.destroyed) return;
    clearTimeout(p.timer);
    this.probe = null;
    if (seen && probeVerdict(p.native, seen) === 'ok') {
      this.probeBad = 0;
      if (++this.probeOk === PROBE_VERIFIED) log.info('picture check passed: the playback window shows the frames libmpv renders');
      return this.requestProbe(this.probeOk >= PROBE_VERIFIED ? PROBE_RECHECK_MS : 0);
    }
    this.probeOk = 0;
    const what = `libmpv drew ${pixels(p.native, 5, 2)}, the playback window shows ${seen ? pixels(seen, 3, 0) : `nothing (no answer within ${PROBE_REPLY_MS / 1000} s)`}`;
    if (++this.probeBad >= PROBE_FAILED) return this.fail(`picture check failed ${this.probeBad} times in a row: ${what}`);
    log.warn(`picture check mismatch: ${what}`);
    this.requestProbe();
  }

  private scheduleResize(): void {
    if (this.destroyed) return;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = null;
      this.resize();
    }, RESIZE_DEBOUNCE_MS);
  }

  // The ring at the window's content size in physical pixels, so the page draws it 1:1. The scale is the one of
  // the display matching the content bounds. On Wayland a client is never told where it is, so Electron's origin is
  // nominal and on a mixed-scale multi-monitor setup this can pick another output's scale; the preload sizes its
  // canvas from each frame and CSS scales it to the window, so a wrong guess costs sharpness, never the picture.
  private resize(): void {
    if (this.destroyed || this.win.isDestroyed()) return;
    const bounds = this.win.getContentBounds();
    const scale = screen.getDisplayMatching(bounds).scaleFactor || 1;
    const width = Math.max(1, Math.round(bounds.width * scale));
    const height = Math.max(1, Math.round(bounds.height * scale));
    if (width === this.size.width && height === this.size.height) return;
    this.size = { width, height };
    this.ctl.resize(width, height);
  }

  // Stops sending. Frames in flight settle and release themselves; held imports go now.
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    if (this.probeTimer) clearTimeout(this.probeTimer);
    this.cancelProbe(false);
    // Frames in flight still free their slot through allReferencesReleased; only their watchdogs stop.
    for (const watchdog of this.pending.values()) clearTimeout(watchdog);
    app.off('child-process-gone', this.onGpuGone);
    app.off('gpu-info-update', this.onGpuInfo);
    this.ctl.off('buffers', this.onBuffers);
    this.ctl.off('frame', this.onFrame);
    this.ctl.off('render-warning', this.onRenderWarning);
    if (!this.win.isDestroyed()) {
      this.win.off('resize', this.onGeometry);
      this.win.off('move', this.onGeometry);
      this.win.webContents.ipc.off(Channels.videoDrawFailed, this.onDrawFailed);
      this.win.webContents.ipc.off(Channels.videoProbe, this.onProbeReply);
    }
    screen.off('display-metrics-changed', this.onGeometry);
    for (const [imp, timer] of this.held) {
      clearTimeout(timer);
      release(imp);
    }
    this.held.clear();
    this.ring = null;
    this.removeAllListeners();
  }
}

function textureInfo(b: NativeBuffer) {
  return {
    // AB24 (DRM ABGR8888) is R, G, B, A in memory.
    pixelFormat: 'rgba' as const,
    codedSize: { width: b.width, height: b.height },
    visibleRect: { x: 0, y: 0, width: b.width, height: b.height },
    handle: { nativePixmap: { planes: [{ fd: b.fd, stride: b.stride, offset: b.offset, size: b.size }], modifier: b.modifier, supportsZeroCopyWebGpuImport: false } },
  };
}

function release(imp: SharedTextureImported): void {
  try {
    imp.release();
  } catch (err) {
    log.debug(`shared texture release: ${message(err)}`);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
