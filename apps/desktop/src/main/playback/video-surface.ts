import { EventEmitter } from 'node:events';
import { screen, sharedTexture, type BrowserWindow, type SharedTextureImported } from 'electron';
import { logger } from '../core/log';
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
// Events: 'fatal' (message: string) after FATAL_FAILURES frames in a row could not be imported or delivered, once
// per surface: the picture is gone for good (audio may still play).
export class VideoSurface extends EventEmitter {
  private ring: Ring | null = null;
  // `${generation}:${slot}` from its frame event until allReferencesReleased: never two imports of one slot.
  private readonly pending = new Set<string>();
  // Imports whose send timed out, released after TIMED_OUT_HOLD_MS.
  private readonly held = new Map<SharedTextureImported, NodeJS.Timeout>();
  private size = { width: 0, height: 0 };
  private resizeTimer: NodeJS.Timeout | null = null;
  private failures = 0;
  private lastWarnAt = -Infinity;
  private fatal = false;
  private destroyed = false;

  private readonly onBuffers = (e: Extract<NativeEvent, { type: 'buffers' }>) => this.setRing(e.generation, e.buffers);
  private readonly onFrame = (e: Extract<NativeEvent, { type: 'frame' }>) => void this.sendFrame(e.generation, e.slot);
  private readonly onGeometry = () => this.scheduleResize();
  // A ring resize the addon could not allocate keeps the old ring: forget the size, so the next geometry change
  // (even back to the same size) asks again.
  private readonly onRenderWarning = () => (this.size = { width: 0, height: 0 });

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
    // A display scale change keeps the window's DIP size but not its pixel count.
    screen.on('display-metrics-changed', this.onGeometry);
    if (ctl.lastBuffers) this.setRing(ctl.lastBuffers.generation, ctl.lastBuffers.buffers);
    this.resize();
  }

  // Nothing to import or free here: the addon keeps a replaced ring's buffers (and fds) until every frame of it
  // came back, and Electron dups the fds it imports. Frames of an older generation still in flight finish normally.
  private setRing(generation: number, buffers: NativeBuffer[]): void {
    if (this.destroyed || generation === this.ring?.generation) return;
    this.ring = { generation, buffers: new Map(buffers.map((b) => [b.slot, b])) };
  }

  private async sendFrame(generation: number, slot: number): Promise<void> {
    const native = this.ctl.native;
    const key = `${generation}:${slot}`;
    // Already imported: the addon gets this slot back from that import's allReferencesReleased.
    if (this.pending.has(key)) return;
    const b = this.ring?.generation === generation ? this.ring.buffers.get(slot) : undefined;
    const frame = this.win.isDestroyed() ? null : this.win.webContents.mainFrame;
    // A stale ring, a window gone or showing anything but Wicaby: drop the frame, not a delivery failure.
    if (this.destroyed || !b || !frame || !this.isAppUrl(frame.url)) return native.releaseFrame(generation, slot);
    this.pending.add(key);
    // After destroy() this still runs; the addon ignores releases once it is destroyed.
    const free = () => {
      if (this.pending.delete(key)) native.releaseFrame(generation, slot);
    };
    let imp: SharedTextureImported;
    try {
      imp = sharedTexture.importSharedTexture({ textureInfo: textureInfo(b), allReferencesReleased: free });
    } catch (err) {
      free();
      this.failed(`frame not imported: ${message(err)}`);
      return;
    }
    try {
      await sharedTexture.sendSharedTexture({ frame, importedSharedTexture: imp }, { generation, slot });
      this.delivered();
    } catch (err) {
      // A rejection is always a fault: with no receiver registered yet the renderer still answers success. It is
      // Electron's 1 s timeout (renderer hung or gone) or a texture Electron no longer knows.
      const msg = message(err);
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
    if (this.failures >= FATAL_FAILURES && !this.fatal) {
      this.fatal = true;
      const fatal = `no video frame reached the playback window (${this.failures} in a row): ${msg}`;
      log.error(fatal);
      this.emit('fatal', fatal);
    }
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
    this.ctl.off('buffers', this.onBuffers);
    this.ctl.off('frame', this.onFrame);
    this.ctl.off('render-warning', this.onRenderWarning);
    if (!this.win.isDestroyed()) {
      this.win.off('resize', this.onGeometry);
      this.win.off('move', this.onGeometry);
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
