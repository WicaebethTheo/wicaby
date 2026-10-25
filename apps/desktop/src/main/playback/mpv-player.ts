import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { app, screen, type BaseWindow } from 'electron';
import type { Settings, SubtitleStyle, VideoAspect } from '../../shared/contract';
import { detachedWindowArgs, mpvAtLeast, mpvOutputArgs, parseMpvArgs } from '../../shared/mpv-args';
import { snippetWindow } from '../../shared/song-id';
import { logger } from '../core/log';
import type { MpvRender } from '../features/display-mode-linux';
import { t } from '../i18n';
import { LIVE_MPV_OPTIONS } from '../livetv/live-session';
import type { WindowManager } from '../windows/window-manager';
import { hdrFromMpv, hdrLabel, hdrOutputShown, mergeHdr, type HdrFormat, type MpvVideoParams } from './hdr';
import { LibmpvController } from './libmpv-controller';
import { loadLibmpvNative } from './libmpv-native';
import { MpvController, mpvVersion, type MpvTransport } from './mpv-controller';
import { EXIT_FADE_MS, EXIT_REVEAL_MS, type ActivePlayer, type LoadParams, type PlaybackStats, type TimeUpdate } from './player';
import { VideoSurface } from './video-surface';

const log = logger.scope('mpv-player');

// Audio devices that refused the bitstream: a new mpv starts without --audio-spdif for them instead of failing at
// the start of every AC3/DTS file. shortcut: keyed on the configured device ('auto' = the Windows default), kept until
// the app restarts; key on the resolved endpoint if the default device often changes to a receiver.
const spdifRefused = new Set<string>();

// Seconds buffered from the position: the end of the cached range that holds it ('?' when none does, e.g. right after a seek).
const cacheAhead = (ranges: [number, number][] | undefined, posMs: number): string => {
  const r = ranges?.find(([start, end]) => start <= posMs && posMs <= end);
  return r ? String(Math.round((r[1] - posMs) / 1000)) : '?';
};

// Picture-in-guide tile as video-margin-ratio [left, right, top, bottom]: 30 % of the width, 2 % from the
// right edge, 3 % from the top. GuideOverlay.svelte cuts its transparent hole at the same place.
export const GUIDE_TILE = [0.68, 0.02, 0.03, 0.67] as const;

interface MpvTrack {
  id: number;
  type: 'video' | 'audio' | 'sub';
  'ff-index'?: number;
  external?: boolean;
  selected?: boolean;
  codec?: string;
  'demux-channels'?: string;
  'demux-channel-count'?: number;
}

// libass only sees system fonts and sub-fonts-dir, so Geist (the default subtitle font) is
// copied there from the renderer's bundled woff2 files. Returns the folder.
function ensureSubFonts(configDir: string): string {
  const dir = path.join(configDir, 'fonts');
  try {
    fs.mkdirSync(dir, { recursive: true });
    const geist = path.join('node_modules', '@fontsource-variable', 'geist', 'files');
    // npm workspaces hoist node_modules to the repo root in development.
    const sources = [path.join(__dirname, '..', 'renderer', 'assets'), path.join(app.getAppPath(), geist), path.join(app.getAppPath(), '..', '..', geist)];
    for (const subset of ['latin', 'latin-ext']) {
      const target = path.join(dir, `geist-${subset}.woff2`);
      if (fs.existsSync(target)) continue;
      const re = new RegExp(`^geist-${subset}-wght-normal(-[\\w-]+)?\\.woff2$`);
      for (const src of sources) {
        const name = fs.existsSync(src) ? fs.readdirSync(src).find((f) => re.test(f)) : undefined;
        if (name) {
          fs.writeFileSync(target, fs.readFileSync(path.join(src, name)));
          break;
        }
      }
    }
  } catch (err) {
    log.warn('could not prepare subtitle fonts', err);
  }
  return dir;
}

// Text subtitle look (mpv defaults: size 38 at 720p, outline 1.65).
function subtitleProps(s: SubtitleStyle): [string, unknown][] {
  const look: [string, unknown][] =
    s.border === 'box'
      ? [['sub-border-style', 'background-box'], ['sub-outline-size', 2.5], ['sub-shadow-offset', 0], ['sub-back-color', '#B0000000']]
      : s.border === 'shadow'
        ? [['sub-border-style', 'outline-and-shadow'], ['sub-outline-size', 0.6], ['sub-shadow-offset', 2.2], ['sub-back-color', '#C0000000']]
        : [['sub-border-style', 'outline-and-shadow'], ['sub-outline-size', 2.2], ['sub-shadow-offset', 0], ['sub-outline-color', '#FF000000']];
  return [
    ['sub-font', s.font],
    ['sub-font-size', Math.round((38 * s.size) / 100)],
    ['sub-color', s.color],
    ['sub-pos', s.position],
    // scale keeps typeset ASS (signs, karaoke) intact; force restyles it like plain text.
    ['sub-ass-override', s.overrideAss ? 'force' : 'scale'],
    // "Taille selon la résolution": scale with the video picture, not the window (letterbox included).
    ['sub-scale-with-window', !s.scaleWithVideo],
    ...look,
  ];
}

// Layouts (mpv and FFmpeg share these names) whose third channel is front centre, with their
// channel count. Channels are addressed by index so a decoder that labels them differently
// (back vs side surrounds) cannot make the pan filter fail.
const CENTER_LAYOUTS: Record<string, number> = {
  '3.0': 3,
  '3.1': 4,
  '4.0': 4,
  '4.1': 5,
  '5.0': 5,
  '5.0(side)': 5,
  '5.1': 6,
  '5.1(side)': 6,
  '6.1': 7,
  '7.1': 8,
};

// mpv --af for the selected audio track. Filters cannot touch a bitstream, so a track sent
// as S/PDIF gets none (mpv would otherwise fall back to decoding it).
export function audioFilters(p: Settings['playback'], track: Pick<MpvTrack, 'codec' | 'demux-channels'> | undefined): string {
  const codec = track?.codec ?? '';
  const spdif = p.spdif.includes(codec) || (codec === 'dts' && p.spdif.includes('dts-hd'));
  if (spdif) return '';
  const chain: string[] = [];
  if (p.dialogueBoost) {
    const layout = track?.['demux-channels'] ?? '';
    const count = CENTER_LAYOUTS[layout];
    // Multichannel: centre +3 dB, the rest -3 dB. Stereo has no centre: normalise speech instead.
    chain.push(
      count
        ? `lavfi=[pan=${layout}|${Array.from({ length: count }, (_, i) => `c${i}=${i === 2 ? 1.41 : 0.71}*c${i}`).join('|')}]`
        : 'lavfi=[speechnorm=e=6.25:r=0.00001:l=1]',
    );
  }
  // Night mode: -20 dB threshold, 4:1, +6 dB make-up; quiet dialogue rises, explosions shrink.
  if (p.nightMode) chain.push('lavfi=[acompressor=threshold=0.1:ratio=4:attack=5:release=200:makeup=2]');
  // Normalisation: evens out loudness between scenes and titles (dynamic, no look-ahead pass).
  if (p.normalize) chain.push('lavfi=[dynaudnorm=f=250:g=15:p=0.9:m=8]');
  return chain.join(',');
}

// Windows: the HWND. Linux (Ozone/X11, index.ts): the X11 window id, which mpv takes the same way.
function hwndOf(win: BaseWindow): string {
  const handle = win.getNativeWindowHandle();
  return (handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0))).toString();
}

// Texture mode: the refresh rate of the display under the playback window, for mpv's display-fps (0: unknown).
// Wayland tells a client neither its position nor its output, so with several displays getDisplayMatching may
// pick the wrong one; with one display (the common case) it is exact.
function displayHz(bounds: Electron.Rectangle): number {
  const all = screen.getAllDisplays();
  const hz = (all.length === 1 ? all[0] : screen.getDisplayMatching(bounds)).displayFrequency;
  return hz > 0 ? Math.round(hz * 1000) / 1000 : 0;
}

// Texture mode: the version-gated options of mpvOutputArgs (target-colorspace-hint-mode, deinterlace=auto...).
// libmpv's own version is only readable once it runs, so all of them are passed and LibmpvController skips the
// ones this libmpv refuses, instead of trusting the mpv CLI's version (which may be another build, or absent).
function gatedOptions(p: Settings['playback']): Set<string> {
  const names = (args: string[]) => new Set(args.map((a) => a.slice(2).split('=')[0]));
  const oldest = names(mpvOutputArgs(p, 'linux', '0.0', false));
  return new Set([...names(mpvOutputArgs(p, 'linux', null, false))].filter((n) => !oldest.has(n)));
}

export class MpvPlayer extends EventEmitter implements ActivePlayer {
  readonly kind = 'mpv' as const;
  private ctl: MpvTransport;
  // Texture mode: pumps libmpv's frames into the playback window's page.
  private surface: VideoSurface | null = null;
  private params: LoadParams | null = null;
  private audioMap = new Map<number, number>();
  private subMap = new Map<number, number>();
  private position = 0;
  private duration = 0;
  private paused = false;
  private buffering = false;
  private stats: PlaybackStats = {};
  private destroyed = false;
  private mpvHdr: HdrFormat | null = null;
  private dvProfile: number | undefined;
  private targetGamma: string | undefined;
  private hintMode: 'target' | 'source' = 'target';
  private audioCodec: string | undefined;
  private bitstream = false;
  private hung = false;
  private audioTracks: MpvTrack[] = [];
  private af = '';
  private audioDevice = 'auto';
  // From load() to file-loaded: time-pos, duration and eof still describe the previous file.
  private loading = false;
  private firstFrame = false;
  private cache: TimeUpdate['cache'];
  private fullscreen = false;
  // Texture mode: the override-display-fps Wicaby last set (0: none); the user's own value is left alone.
  private displayFps = 0;
  private stopDisplayWatch: (() => void) | null = null;
  // Texture mode: a frame came out of the render thread, and why the render path failed, if it did.
  private framed = false;
  private renderError: string | null = null;
  // Detached (native Wayland, #14): mpv's own window with its own controls; the main window was visible before it.
  private mainWasShown = false;

  private constructor(
    exe: string | null,
    private readonly windows: WindowManager,
    private readonly settings: () => Settings,
    private readonly passthrough: boolean,
    // A user mpv.conf owns tone mapping and subtitle looks; Wicaby then leaves those options alone.
    private readonly tuneHdr: boolean,
    readonly mode: MpvRender,
  ) {
    super();
    // Texture mode: libmpv in this process (libmpv-controller.ts); the other modes run an mpv process.
    if (mode !== 'texture' && !exe) throw new Error(t('main.playback.mpvMissing'));
    this.ctl = mode === 'texture' ? new LibmpvController(MpvPlayer.native()) : new MpvController(exe!);
  }

  // index.ts only picks texture mode once the addon probed fine, so a null here is a broken install.
  private static native() {
    const lib = loadLibmpvNative();
    if (!lib) throw new Error('libmpv addon unavailable');
    return lib;
  }

  get detached(): boolean {
    return this.mode === 'detached';
  }

  get hostWindow(): BaseWindow | null {
    // Detached: the hidden main window still says which display to switch the refresh rate on.
    if (this.mode === 'texture') return this.windows.playback?.osd ?? null;
    return this.detached ? this.windows.main : (this.windows.playback?.video ?? null);
  }

  // detached: native Wayland has no X11 window for --wid, so mpv opens its own window, with its own on-screen
  // controller and keys, and Wicaby's main window steps aside until it closes. No OSD window in that mode.
  // texture: native Wayland with the libmpv addon, the video drawn inside one playback window under the OSD. It needs
  // no mpv CLI (exe may be null): libmpv's own version is checked once it runs (below).
  static async create(exe: string | null, windows: WindowManager, settings: () => Settings, configDir: string, mode: MpvRender = 'wid'): Promise<MpvPlayer> {
    const detached = mode === 'detached';
    const texture = mode === 'texture';
    const p = settings().playback;
    // Linux runs the system mpv: 0.37 or newer, newer options gated (probed once per path, index.ts
    // already did at startup). Windows ships its own mpv and never waits for the probe.
    const version = process.platform === 'win32' || texture || !exe ? null : await mpvVersion(exe);
    if (process.platform !== 'win32' && !texture && !mpvAtLeast(version, 37)) throw new Error(t('errors.playback.mpvTooOld', { version: String(version), min: '0.37' }));
    // Texture mode renders SDR into 8-bit buffers: no HDR passthrough there (onTargetGamma never asks for source).
    const player = new MpvPlayer(exe, windows, settings, p.hdrPassthrough && !texture, !p.useMpvConfig, mode);
    // A main window in full screen (Reader, Slideshow) hands over to a player in full screen.
    const fullscreen = p.startFullscreen || (!!windows.main && !windows.main.isDestroyed() && windows.main.isFullScreen());
    const pw = detached ? null : texture ? windows.createPlaybackWindow(fullscreen) : windows.createPlaybackWindows(fullscreen);
    pw?.osd.on('closed', () => {
      if (!player.destroyed) player.emit('closed');
    });
    // An OSD crash leaves nothing to control playback with: handled as a close (live: ledger sweep, §8.1).
    pw?.osd.webContents.on('render-process-gone', () => {
      if (!player.destroyed) player.emit('closed');
    });
    if (texture && pw) player.displayFps = displayHz(pw.osd.getBounds());
    const userConf = path.join(configDir, 'mpv.conf');
    // Allow-listed options only (shared/mpv-args.ts); the rest is logged and dropped.
    const extra = parseMpvArgs(p.mpvArgs);
    if (extra.rejected.length) log.warn(`ignored mpv arguments: ${extra.rejected.join(' ')}`);
    // Detached: the main window's size and state (Wayland: one display's scale is exact; see displayHz).
    const main = detached && windows.main && !windows.main.isDestroyed() ? windows.main : null;
    const at = main?.getNormalBounds();
    const detachedWindow = detachedWindowArgs(at && main ? { width: at.width, height: at.height, scale: screen.getDisplayMatching(at).scaleFactor, maximized: main.isMaximized() } : null, fullscreen);
    // Embedding and control: neither the user's mpv.conf nor a profile may change these.
    const control = pw
      ? [
          ...(pw.mode === 'pair' ? [`--wid=${hwndOf(pw.video)}`] : []),
          '--osc=no',
          '--osd-level=0',
          '--osd-bar=no',
          '--input-default-bindings=no',
          '--input-vo-keyboard=no',
          '--input-cursor=no',
          '--cursor-autohide=no',
        ]
      : ['--title=Wicaby', '--osc=yes', '--input-default-bindings=yes', '--input-vo-keyboard=yes', ...detachedWindow];
    const fixed = [
      ...control,
      '--idle=yes',
      '--force-window=yes',
      '--keep-open=no',
      '--terminal=yes',
      '--msg-level=all=warn',
      '--ytdl=no',
      '--load-scripts=no',
      '--sub-auto=no',
    ];
    // Wicaby's defaults; with "Utiliser mpv.conf" the user's file is included after them and wins.
    const args = [
      ...(p.useMpvConfig ? ['--config=yes', `--config-dir=${configDir}`] : ['--no-config']),
      '--hr-seek=yes',
      // Remote servers: 512 MiB ahead (about 50 s of an 80 Mb/s remux), 128 MiB behind for
      // instant short rewinds, 3 s of refill after a stall instead of stuttering at 1 s.
      '--cache=yes',
      '--demuxer-max-bytes=512MiB',
      '--demuxer-max-back-bytes=128MiB',
      '--cache-pause-wait=3',
      // Survive Wi-Fi drops and server restarts: FFmpeg reconnects the HTTP stream, HLS retries segments.
      '--stream-lavf-o=reconnect=1,reconnect_streamed=1,reconnect_delay_max=5',
      '--demuxer-lavf-o=seg_max_retry=5',
      '--network-timeout=20',
      // rtsp only (Freebox): mpv's default tcp gets "461 Unsupported Transport" from the box. udp alone, not lavf:
      // lavf would fall back to tcp (refused anyway) and then to a multicast group the server names. Global, not
      // file-local, so an mpv without per-file loadfile options (< 0.38) still gets it.
      '--rtsp-transport=udp',
      '--embeddedfonts=yes',
      `--sub-fonts-dir=${ensureSubFonts(configDir)}`,
      ...mpvOutputArgs(p, process.platform, version, mode === 'wid'),
      // No swapchain to time frames against: display-resample and the stats need the display's refresh rate
      // (kept up to date by refreshDisplayFps).
      ...(player.displayFps ? [`--override-display-fps=${player.displayFps}`] : []),
      `--volume-max=${p.volumeBoost ? 150 : 100}`,
      '--background-color=#000000',
      // dts-hd already covers the DTS core. WASAPI switches to exclusive mode for any bitstream.
      ...(p.spdif.length && !spdifRefused.has(p.audioDevice) ? [`--audio-spdif=${p.spdif.filter((c) => c !== 'dts' || !p.spdif.includes('dts-hd')).join(',')}`] : []),
      `--audio-device=${p.audioDevice}`,
      ...(p.useMpvConfig && fs.existsSync(userConf) ? [`--include=${userConf}`] : []),
      // "Arguments mpv supplémentaires": after Wicaby's defaults, before the fixed embedding options.
      ...extra.args,
      ...fixed,
    ];
    player.audioDevice = p.audioDevice;
    try {
      // Listening before start: the first buffer ring is announced while libmpv initialises.
      if (texture && pw && player.ctl instanceof LibmpvController) {
        player.ctl.optional = gatedOptions(p);
        const surface = new VideoSurface(pw.osd, player.ctl, (url) => windows.isAppUrl(url));
        player.surface = surface;
        // Frames never reach the page, or not as libmpv drew them, or the GPU process went: the render path does not
        // work on this machine, remembered for later starts (sticky).
        surface.on('fatal', (message: string) => player.onRenderFailure(message, true));
        player.ctl.once('frame', () => (player.framed = true));
        player.ctl.on('render-error', (message: string) => (player.renderError = message));
      }
      await player.ctl.start(args);
      if (texture) {
        // "mpv 0.41.0" or "mpv v0.40.0-12-gabc": the library that actually plays, not the CLI.
        const lib = /mpv\s+(\S+)/.exec(String(await player.ctl.get<string>('mpv-version')))?.[1] ?? null;
        log.info(`libmpv ${lib ?? 'version unknown'}`);
        if (!mpvAtLeast(lib, 37)) throw new Error(t('errors.playback.mpvTooOld', { version: String(lib), min: '0.37' }));
        if (pw) player.watchDisplay(pw.osd);
      }
      if (detached) {
        player.mainWasShown = Boolean(windows.main?.isVisible());
        windows.main?.hide();
      } else if (!texture) windows.onPlaybackSettled = () => player.scheduleGeometryCheck();
      player.wire();
      await player.applySettings();
    } catch (err) {
      // No playback windows left open over a hidden main window, no orphan mpv --idle.
      await player.destroy();
      throw err;
    }
    return player;
  }

  // Live settings: volume ceiling, audio filters and, without a user mpv.conf, the subtitle look.
  async applySettings(): Promise<void> {
    const p = this.settings().playback;
    const sets: [string, unknown][] = [['volume-max', p.volumeBoost ? 150 : 100], ...(this.tuneHdr ? subtitleProps(p.subtitleStyle) : [])];
    // Switching the device reopens the audio output, so only on a real change.
    if (p.audioDevice !== this.audioDevice) {
      this.audioDevice = p.audioDevice;
      sets.push(['audio-device', p.audioDevice]);
    }
    for (const [name, value] of sets) await this.ctl.set(name, value).catch((err) => log.warn(`set ${name} failed`, err));
    await this.updateFilters();
  }

  // The container's title tag (file sources cache it, file-sources-spec D5).
  async mediaTitle(): Promise<string | undefined> {
    const v = await this.ctl.get<unknown>('metadata/by-key/title').catch(() => undefined);
    return typeof v === 'string' ? v : undefined;
  }

  // "What's this song?" (playback/song-id.ts): writes the cached seconds around the position to `file` as they came
  // in (mpv dump-cache): no second download, no microphone. False when the cache holds too little there.
  async dumpSnippet(file: string): Promise<boolean> {
    const span = snippetWindow(this.position, this.cache?.ranges ?? []);
    if (!span) return false;
    await this.ctl.command('dump-cache', (span[0] / 1000).toFixed(3), (span[1] / 1000).toFixed(3), file);
    return true;
  }

  async audioDevices(): Promise<{ name: string; description: string }[]> {
    return (await this.ctl.get<{ name: string; description: string }[]>('audio-device-list')) ?? [];
  }

  private async updateFilters(): Promise<void> {
    const sel = this.audioTracks.find((t) => t.selected) ?? this.audioTracks[0];
    const af = audioFilters(this.settings().playback, sel);
    // Leave a user mpv.conf's own af alone until Wicaby has something to say.
    if (af === this.af) return;
    this.af = af;
    await this.ctl.set('af', af).catch((err) => log.warn(`audio filters rejected: ${af}`, err));
  }

  private wire(): void {
    const ctl = this.ctl;
    ctl.on('property', (name: string, value: unknown) => this.onProperty(name, value));
    ctl.on('event', (event: string, msg: Record<string, unknown>) => {
      if (event === 'start-file') this.firstFrame = false;
      else if (event === 'file-loaded') {
        this.loading = false;
        void this.onFileLoaded();
      }
      // The observer stays silent when the gamma does not change across files (pq to pq), so re-read it once frames flow.
      else if (event === 'playback-restart') {
        // Live TV adopts a stream on its first frame (live-session.ts).
        if (!this.firstFrame) {
          this.firstFrame = true;
          this.emit('first-frame');
        }
        void ctl.get<string>('video-target-params/gamma').then((g) => this.onTargetGamma(g), () => undefined);
      }
      else if (event === 'end-file') {
        const reason = msg.reason as string;
        log.info(`end-file: ${reason}${msg.file_error ? ` (${String(msg.file_error)})` : ''}`);
        if (reason === 'eof' && !this.loading) this.emit('ended');
        else if (reason === 'error') {
          const fileError = String(msg.file_error ?? '');
          // 'stream': the service may reopen it (stream-recovery.ts); 'decode': mpv cannot play what it got.
          const kind = /format|codec|decod|output init|no audio or video/i.test(fileError) ? 'decode' : 'stream';
          this.emit('failure', fileError ? t('errors.playback.fileError', { reason: fileError }) : t('errors.playback.fileErrorUnknown'), kind);
        }
      }
    });
    // A device that refuses the bitstream (TrueHD/DTS-HD to plain speakers) leaves mpv waiting for audio
    // forever. Decode to PCM instead for the rest of this player's life.
    ctl.on('ao-failed', () => {
      void (async () => {
        const spdif = await ctl.get<string>('audio-spdif').catch(() => '');
        if (this.destroyed) return;
        // Not a passthrough refusal: the service retries a direct-play file once with a server transcode.
        if (!spdif) return void this.emit('decode-failure', 'audio output initialization failed');
        log.warn(`audio output refused passthrough (${spdif}); falling back to PCM`);
        spdifRefused.add(this.audioDevice);
        await ctl.set('audio-spdif', '').catch(() => undefined);
        // The spdif choice is made when the decoder opens: re-select the track to rebuild the audio chain.
        const aid = await ctl.get<number | string | false>('aid').catch(() => false);
        if (aid !== false && aid !== 'no') {
          await ctl.set('aid', 'no').catch(() => undefined);
          await ctl.set('aid', aid).catch(() => undefined);
        }
        this.emit('notice', 'player.notice.passthroughRefused');
      })();
    });
    ctl.on('vo-failed', () => {
      if (!this.destroyed) this.emit('decode-failure', 'video output initialization failed');
    });
    // The watchdog's "hung" and the kill's "exit" can arrive in either order.
    ctl.on('hung', () => {
      if (this.destroyed || this.hung) return;
      this.hung = true;
      this.emit('hung');
    });
    ctl.on('exit', (code: number | null) => {
      // Its own window closed, or q: the user left playback.
      if (this.detached && code === 0 && !this.destroyed) return void this.emit('closed');
      // Texture mode that never showed a frame, or whose render thread failed: the render path, not mpv, is at fault.
      if (this.mode === 'texture' && !this.hung && (this.renderError || !this.framed)) return this.onRenderFailure(this.renderError ?? `libmpv stopped (${code ?? 'error'}) before its first frame`);
      setTimeout(() => {
        if (!this.destroyed && !this.hung) this.emit('failure', t('errors.playback.mpvExited'));
      }, 300);
    });
    const props = [
      'time-pos',
      'duration',
      'pause',
      'paused-for-cache',
      'seeking',
      'volume',
      'mute',
      'hwdec-current',
      'video-params',
      'video-target-params/gamma',
      'current-tracks/video/dolby-vision-profile',
      'audio-params/format',
      'video-codec',
      'audio-codec-name',
      'file-format',
      'estimated-vf-fps',
      'display-fps',
      'frame-drop-count',
      'video-bitrate',
      'demuxer-cache-state',
      'fullscreen',
    ];
    for (const p of props) void ctl.observe(p).catch(() => undefined);
  }

  private timer: NodeJS.Timeout | null = null;
  private geometryTimer: NodeJS.Timeout | null = null;
  private nudged = false;

  // mpv sizes its child window from a cross-process WinEvent hook (EVENT_OBJECT_LOCATIONCHANGE,
  // delivered asynchronously, then SetWindowPos with SWP_ASYNCWINDOWPOS). If it misses the last
  // event it keeps rendering at the old size and offset. Its osd-dimensions are that child's
  // client size in pixels: compare them with the host, and if they differ, change the host by
  // one pixel and back, which raises the event again and makes mpv re-read the parent rectangle.
  scheduleGeometryCheck(): void {
    if (this.geometryTimer) clearTimeout(this.geometryTimer);
    // mpv's resize is asynchronous too: leave it time to land before judging.
    this.geometryTimer = setTimeout(() => {
      this.geometryTimer = null;
      void this.checkGeometry();
    }, 250);
  }

  private async checkGeometry(): Promise<void> {
    const win = this.hostWindow;
    if (!win || win.isDestroyed() || win.isMinimized() || this.destroyed) return;
    const dims = await this.ctl.get<{ w: number; h: number }>('osd-dimensions').catch(() => null);
    if (!dims?.w || win.isDestroyed()) return;
    const b = win.getBounds();
    // null: the display under the rectangle sets the scale (the API only takes a BrowserWindow).
    const px = screen.dipToScreenRect(null, b);
    if (Math.abs(dims.w - px.width) <= 2 && Math.abs(dims.h - px.height) <= 2) {
      this.nudged = false;
      return;
    }
    // Once per mismatch, so a size mpv never reaches does not wiggle the window on every settle.
    if (this.nudged) return;
    this.nudged = true;
    log.warn(`mpv renders at ${dims.w}×${dims.h} in a ${px.width}×${px.height} window: forcing a re-layout`);
    win.setBounds({ ...b, width: b.width + 1 });
    win.setBounds(b);
  }

  private onProperty(name: string, value: unknown): void {
    switch (name) {
      case 'time-pos':
        if (typeof value === 'number' && !this.loading) this.position = value * 1000;
        break;
      case 'fullscreen':
        this.fullscreen = value === true;
        break;
      case 'duration':
        if (typeof value === 'number' && !this.loading) this.duration = value * 1000;
        break;
      case 'pause':
        this.paused = Boolean(value);
        break;
      case 'paused-for-cache':
      case 'seeking':
        this.buffering = Boolean(value);
        break;
      case 'volume':
      case 'mute':
        void Promise.all([this.ctl.get<number>('volume'), this.ctl.get<boolean>('mute')])
          .then(([volume, muted]) => this.emit('volume', { volume, muted }))
          .catch(() => undefined);
        return;
      case 'hwdec-current':
        this.stats.hwdec = typeof value === 'string' ? value : undefined;
        break;
      case 'video-params': {
        const v = value as (MpvVideoParams & { w?: number; h?: number }) | null;
        if (v) this.stats.resolution = v.w && v.h ? `${v.w}×${v.h}` : undefined;
        this.mpvHdr = hdrFromMpv(v, this.dvProfile);
        this.updateHdr();
        break;
      }
      case 'current-tracks/video/dolby-vision-profile':
        this.dvProfile = typeof value === 'number' ? value : undefined;
        if (this.mpvHdr?.kind === 'dv') this.mpvHdr = { kind: 'dv', dvProfile: this.dvProfile ? String(this.dvProfile) : undefined };
        this.updateHdr();
        break;
      case 'video-target-params/gamma':
        this.onTargetGamma(typeof value === 'string' ? value : undefined);
        break;
      case 'audio-params/format':
        // Bitstreams force WASAPI exclusive mode and disable display-resample, whatever the settings say.
        this.bitstream = typeof value === 'string' && value.startsWith('spdif');
        this.updateAudio();
        break;
      case 'video-codec':
        this.stats.videoCodec = typeof value === 'string' ? value.split(' ')[0] : undefined;
        break;
      case 'audio-codec-name':
        this.audioCodec = typeof value === 'string' ? value : undefined;
        this.updateAudio();
        break;
      case 'file-format':
        this.stats.container = typeof value === 'string' ? value : undefined;
        break;
      case 'estimated-vf-fps':
        this.stats.frameRate = typeof value === 'number' ? Math.round(value * 1000) / 1000 : undefined;
        break;
      case 'display-fps':
        this.stats.displayFps = typeof value === 'number' ? Math.round(value * 100) / 100 : undefined;
        break;
      case 'frame-drop-count':
        // Each burst is logged with where it happened: drops come from short mpv stalls, and the position, the
        // subtitle state and the cache say what was on screen (diagnosis of the 2-4 frame bursts).
        if (typeof value === 'number' && value > (this.stats.droppedFrames ?? 0) && !this.loading)
          log.info(`dropped ${value - (this.stats.droppedFrames ?? 0)} frame(s) at ${Math.round(this.position / 1000)} s (total ${value}, cache ${cacheAhead(this.cache?.ranges, this.position)} s ahead)`);
        this.stats.droppedFrames = typeof value === 'number' ? value : undefined;
        break;
      case 'video-bitrate':
        this.stats.bitrateKbps = typeof value === 'number' ? Math.round(value / 1000) : undefined;
        break;
      case 'demuxer-cache-state': {
        const c = value as { 'seekable-ranges'?: { start: number; end: number }[]; 'file-cache-bytes'?: number; 'fw-bytes'?: number } | null;
        this.cache = c
          ? { ranges: (c['seekable-ranges'] ?? []).map((r) => [r.start * 1000, r.end * 1000]), fileBytes: c['file-cache-bytes'] ?? 0, fwBytes: c['fw-bytes'] ?? 0 }
          : undefined;
        break;
      }
    }
    // Coalesce the per-frame property storm into ~5 updates per second.
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null;
        // Until the new file opens, the spinner stays up whatever the old file's cache state was.
        this.emit('time', { positionMs: this.position, durationMs: this.duration, paused: this.paused, buffering: this.buffering || this.loading, cache: this.cache });
        this.emit('stats', { ...this.stats });
      }, 200);
    }
  }

  private updateAudio(): void {
    this.stats.audioCodec = this.audioCodec;
    this.stats.audioBitstream = Boolean(this.audioCodec && this.bitstream);
  }

  private onTargetGamma(gamma: string | undefined): void {
    this.targetGamma = gamma;
    this.updateHdr();
  }

  private updateHdr(): void {
    const g = this.targetGamma;
    const format = mergeHdr(this.params?.hdr ?? null, this.mpvHdr);
    // In target mode the output gamma tells whether Windows HDR is on. "source" on an SDR desktop
    // would write PQ into an sRGB swapchain (washed out), so it is only enabled after that check.
    // SDR content stays in target mode, which places it at the HDR reference white.
    if (this.passthrough && this.hintMode === 'target' && g === 'pq' && format && format.kind !== 'sdr') {
      this.hintMode = 'source';
      void this.ctl.set('target-colorspace-hint-mode', 'source').catch(() => undefined);
    }
    const output = !g ? undefined : g !== 'pq' && g !== 'hlg' ? 'sdr' : this.hintMode === 'source' ? 'passthrough' : 'hdr';
    this.stats.hdr = hdrLabel(format);
    this.stats.hdrOutput = hdrOutputShown(format, output);
  }

  // live: a Live TV stream, which gets the live file-local options (§8.9) on top of the defaults;
  // timeshift: its back-buffer options (§8.8, live-session.ts timeshiftPlan).
  async load(params: LoadParams & { live?: boolean; timeshift?: readonly (readonly [string, string])[] }): Promise<void> {
    this.params = params;
    this.loading = true;
    this.cache = undefined;
    // Re-armed by the new file's start-file, so a late event of the old file is not taken for it.
    this.firstFrame = true;
    this.audioMap.clear();
    this.subMap.clear();
    this.position = params.startMs;
    this.duration = 0;
    this.stats = {};
    this.mpvHdr = null;
    this.dvProfile = undefined;
    this.targetGamma = undefined;
    this.audioCodec = undefined;
    this.bitstream = false;
    const ctl = this.ctl;
    // A reused player, and refresh-rate matching (playback-service.ts) switches the mode just before this.
    this.refreshDisplayFps();
    // Re-check the display on every file: Windows HDR may have been toggled since the last one.
    if (this.hintMode !== 'target') {
      this.hintMode = 'target';
      await ctl.set('target-colorspace-hint-mode', 'target').catch(() => undefined);
    }
    // HDR10+ carries per-scene ST 2094-40 curves; spline with peak detection does as well for the rest.
    if (this.tuneHdr) await ctl.set('tone-mapping', params.hdr?.kind === 'hdr10+' ? 'st2094-40' : 'spline').catch(() => undefined);
    // The auth header is a per-file option of loadfile (below); emptied here so no later file
    // or URL on another origin inherits it (older mpv sets it globally for one file).
    await ctl.set('http-header-fields', []);
    await ctl.set('start', params.startMs > 0 ? `+${(params.startMs / 1000).toFixed(3)}` : 'none');
    await ctl.set('force-media-title', params.title);
    await ctl.set('volume', params.volume);
    await ctl.set('mute', params.muted);
    // speed is global in mpv: without this the next file would inherit the last one's.
    await ctl.set('speed', params.rate ?? 1);
    await ctl.set('sid', 'no');
    await ctl.set('secondary-sid', 'no').catch(() => undefined);
    // Subtitle sync belongs to a file; the audio delay (display and receiver latency) carries over.
    await ctl.set('sub-delay', 0);
    // The next file's first track may be a bitstream, which no filter accepts; onFileLoaded sets them again.
    this.audioTracks = [];
    if (this.af) await this.updateFilters();
    await ctl.set('pause', false);
    const headers = params.httpHeaders.join(',');
    // File-local options: the auth header, and for live the live profile. They end with this file.
    const options = [
      ...(params.live ? LIVE_MPV_OPTIONS.map(([k, v]) => `${k}=${v}`) : []),
      // %n% quoting: the cache dir is a path.
      ...(params.live ? (params.timeshift ?? []).map(([k, v]) => `${k}=%${Buffer.byteLength(v)}%${v}`) : []),
      ...(headers ? [`http-header-fields=%${Buffer.byteLength(headers)}%${headers}`] : []),
    ];
    if (!options.length) await ctl.command('loadfile', params.url, 'replace');
    else {
      try {
        // loadfile <url> <flags> <index> <options> (mpv 0.38+); %n% quotes the value byte for byte.
        await ctl.command('loadfile', params.url, 'replace', -1, options.join(','));
      } catch {
        // Older mpv has no index argument and refuses the command before doing anything: the
        // global header list instead, for this file only (the next load() empties it first).
        // The live profile is skipped there rather than leaked into the next VOD file.
        if (params.live) log.warn('this mpv takes no per-file options: live profile skipped');
        if (headers) await ctl.set('http-header-fields', params.httpHeaders);
        await ctl.command('loadfile', params.url, 'replace');
      }
    }
  }

  private async onFileLoaded(): Promise<void> {
    const p = this.params;
    if (!p) return;
    const tracks = ((await this.ctl.get<MpvTrack[]>('track-list').catch(() => [])) ?? []).filter((t) => !t.external);
    const audio = tracks.filter((t) => t.type === 'audio');
    const subs = tracks.filter((t) => t.type === 'sub');
    this.audioTracks = audio;
    // Server stream index == FFmpeg stream index when the original file is streamed.
    p.embeddedAudio.forEach((serverIndex, i) => {
      const byFf = audio.find((t) => t['ff-index'] === serverIndex);
      const id = byFf?.id ?? audio[i]?.id;
      if (id !== undefined) this.audioMap.set(serverIndex, id);
    });
    p.embeddedSubtitles.forEach((serverIndex, i) => {
      const byFf = subs.find((t) => t['ff-index'] === serverIndex);
      const id = byFf?.id ?? subs[i]?.id;
      if (id !== undefined) this.subMap.set(serverIndex, id);
    });
    if (!p.tracksFixed) {
      if (p.audioIndex === null || !(await this.setAudio(p.audioIndex))) await this.updateFilters();
      await this.setSubtitle(p.subtitleIndex);
    } else {
      await this.updateFilters();
      await this.ctl.set('sid', p.subtitleIndex !== null ? 'auto' : 'no').catch(() => undefined);
    }
  }

  // Returns the new delay in ms.
  async adjustDelay(kind: 'audio' | 'subtitle', deltaMs: number): Promise<number> {
    const prop = kind === 'audio' ? 'audio-delay' : 'sub-delay';
    if (deltaMs === 0) await this.ctl.set(prop, 0);
    else await this.ctl.command('add', prop, deltaMs / 1000);
    return Math.round(((await this.ctl.get<number>(prop)) ?? 0) * 1000);
  }

  // X-05: a remembered delay, in ms.
  async setDelay(kind: 'audio' | 'subtitle', ms: number): Promise<void> {
    await this.ctl.set(kind === 'audio' ? 'audio-delay' : 'sub-delay', ms / 1000).catch(() => undefined);
  }

  // X-05: a second subtitle drawn at the top of the picture (null = none). An external one is
  // added without being selected as the primary.
  async setSecondarySubtitle(index: number | null): Promise<boolean> {
    const p = this.params;
    if (!p) return false;
    if (index === null) {
      await this.ctl.set('secondary-sid', 'no').catch(() => undefined);
      return true;
    }
    if (p.tracksFixed) return false;
    let id = this.subMap.get(index);
    if (id === undefined) {
      const ext = p.externalSubtitles.find((s) => s.index === index);
      if (!ext) return false;
      try {
        await this.ctl.command('sub-add', ext.url, 'auto', ext.label, ext.language ?? '');
        const tracks = (await this.ctl.get<(MpvTrack & { 'external-filename'?: string })[]>('track-list')) ?? [];
        id = tracks.filter((t) => t.type === 'sub' && t['external-filename'] === ext.url).pop()?.id;
        if (id === undefined) return false;
        this.subMap.set(index, id);
      } catch (err) {
        log.warn('sub-add failed', err);
        return false;
      }
    }
    await this.ctl.set('secondary-sid', id).catch(() => undefined);
    // mpv 0.38+: the top of the picture (older builds already draw it there and refuse the property).
    await this.ctl.set('secondary-sub-pos', 10).catch(() => undefined);
    return true;
  }

  // X-04 Ctrl+←/→: the previous or next subtitle line.
  subSeek(delta: 1 | -1): void {
    void this.ctl.command('sub-seek', delta).catch(() => undefined);
  }

  play(): void {
    void this.ctl.set('pause', false).catch(() => undefined);
  }

  pause(): void {
    void this.ctl.set('pause', true).catch(() => undefined);
  }

  seek(positionMs: number): void {
    // A coalesced emit pending from before the seek must carry the target, not the old time-pos.
    this.position = Math.max(0, positionMs);
    void this.ctl.command('seek', Math.max(0, positionMs / 1000), 'absolute+exact').catch(() => undefined);
  }

  setVolume(volume: number): void {
    const max = this.settings().playback.volumeBoost ? 150 : 100;
    void this.ctl.set('volume', Math.max(0, Math.min(max, volume))).catch(() => undefined);
  }

  setMuted(muted: boolean): void {
    void this.ctl.set('mute', muted).catch(() => undefined);
  }

  setRate(rate: number): void {
    void this.ctl.set('speed', rate).catch(() => undefined);
  }

  async setAudio(index: number): Promise<boolean> {
    if (this.params?.tracksFixed) return false;
    const id = this.audioMap.get(index);
    if (id === undefined) return false;
    for (const t of this.audioTracks) t.selected = t.id === id;
    // Filters off before switching to a bitstream track, on after switching to a decoded one.
    if (!audioFilters(this.settings().playback, this.audioTracks.find((t) => t.selected))) await this.updateFilters();
    await this.ctl.set('aid', id).catch(() => undefined);
    await this.updateFilters();
    return true;
  }

  async setSubtitle(index: number | null): Promise<boolean> {
    const p = this.params;
    if (!p) return false;
    if (index === null || index < 0) {
      await this.ctl.set('sid', 'no').catch(() => undefined);
      return true;
    }
    if (p.tracksFixed) return false;
    let id = this.subMap.get(index);
    if (id === undefined) {
      const ext = p.externalSubtitles.find((s) => s.index === index);
      if (!ext) return false;
      try {
        await this.ctl.command('sub-add', ext.url, 'select', ext.label, ext.language ?? '');
        id = await this.ctl.get<number>('sid');
        if (typeof id === 'number') this.subMap.set(index, id);
        return true;
      } catch (err) {
        log.warn('sub-add failed', err);
        return false;
      }
    }
    await this.ctl.set('sid', id).catch(() => undefined);
    return true;
  }

  // These are global in mpv and outlive loadfile, so every item sets all four. While the guide overlay is
  // open they wait for its close (it owns keepaspect and the zoom).
  private aspect: VideoAspect = { mode: 'fit', zoom: 1.25 };
  private guide = false;
  setAspect(a: VideoAspect): void {
    this.aspect = a;
    if (this.guide) return;
    const props: [string, unknown][] = [
      ['keepaspect', a.mode !== 'stretch'],
      ['panscan', a.mode === 'fill' ? 1 : 0],
      // video-zoom is a power of two.
      ['video-zoom', a.mode === 'zoom' ? Math.log2(a.zoom) : 0],
      ['video-unscaled', a.mode === 'original' ? 'yes' : 'no'],
    ];
    for (const [name, value] of props) void this.ctl.set(name, value).catch((err) => log.warn(`set ${name} failed`, err));
  }

  // Picture-in-guide (§8.7, LT-17): the video in a 16:9 tile at the top right (30 % of the width), over
  // the guide's transparent hole. The margins need keepaspect=yes; subtitles are hidden so they do not land
  // in the guide. An mpv without the margin options gets video-zoom + video-pan instead. Global
  // properties: a tune in place keeps the tile. Closing restores the aspect mode (Z) and subtitles.
  async setGuideOverlay(open: boolean): Promise<void> {
    if (open === this.guide) return;
    this.guide = open;
    const set = (name: string, value: unknown) => this.ctl.set(name, value);
    const [l, r, top, bottom] = open ? GUIDE_TILE : [0, 0, 0, 0];
    await set('sub-visibility', !open).catch(() => undefined);
    if (open) await set('keepaspect', true).catch(() => undefined);
    try {
      await set('video-margin-ratio-left', l);
      await set('video-margin-ratio-right', r);
      await set('video-margin-ratio-top', top);
      await set('video-margin-ratio-bottom', bottom);
    } catch {
      // Fallback (V8): scale to the tile's width and move its centre there (pan is in video widths).
      const w = 1 - l - r;
      if (open) log.info('no video-margin-ratio: zoom/pan fallback');
      await set('video-zoom', open ? Math.log2(w) : 0).catch(() => undefined);
      await set('video-pan-x', open ? (l + w / 2 - 0.5) / w : 0).catch(() => undefined);
      await set('video-pan-y', open ? (top + (1 - top - bottom) / 2 - 0.5) / w : 0).catch(() => undefined);
    }
    if (!open) this.setAspect(this.aspect);
  }

  setFullscreen(value: boolean): void {
    if (this.detached) void this.ctl.set('fullscreen', value).catch(() => undefined);
    else this.windows.setPlaybackFullscreen(value);
  }

  isFullscreen(): boolean {
    return this.detached ? this.fullscreen : this.windows.isPlaybackFullscreen();
  }

  // The OSD's veil fades the paused picture to black (OsdWindow.svelte), the main window comes up and paints under
  // the veil, mpv's window goes and the veil uncovers the page. destroy() quits mpv once all this is hidden.
  async leave(reduced: boolean, phase: (p: 'out' | 'reveal') => void): Promise<void> {
    const pw = this.windows.playback;
    if (this.destroyed || !pw || pw.osd.isDestroyed()) return;
    if (!reduced) {
      phase('out');
      await sleep(EXIT_FADE_MS);
    }
    await this.windows.showMainUnder();
    // A single window (texture mode) has no video window to take away first: it goes as a whole.
    if (!reduced && pw.video && !pw.video.isDestroyed()) {
      pw.video.hide();
      phase('reveal');
      await sleep(EXIT_REVEAL_MS);
    }
    this.windows.hidePlayback();
  }

  // Texture mode cannot show video here: 'render-failed' (message, sticky), once, instead of 'failure'. The service
  // then plays on in mpv's own window (detached) for the rest of the session, and for later starts too when sticky.
  // A render-thread error is not sticky: libmpv or its options, not this machine's GPU path.
  private renderFailed = false;
  private onRenderFailure(message: string, sticky = false): void {
    if (this.destroyed || this.renderFailed || this.hung) return;
    this.renderFailed = true;
    log.error(`texture mode failed: ${message}`);
    this.emit('render-failed', message, sticky);
  }

  // Texture mode: mpv learns the refresh rate from Wicaby only (no swapchain), so follow it when refresh-rate matching
  // switches the mode, the window moves to another display or a display changes.
  private watchDisplay(win: BaseWindow): void {
    const refresh = () => this.refreshDisplayFps();
    win.on('move', refresh);
    screen.on('display-metrics-changed', refresh);
    this.stopDisplayWatch = () => {
      if (!win.isDestroyed()) win.off('move', refresh);
      screen.off('display-metrics-changed', refresh);
    };
  }

  // Texture mode: override-display-fps to the display under the playback window, when it changed. A value set by the
  // user (extra arguments or mpv.conf) is left alone: mpv then reports something else than Wicaby's last value.
  refreshDisplayFps(): void {
    const win = this.windows.playback?.osd;
    if (this.mode !== 'texture' || this.destroyed || !win || win.isDestroyed()) return;
    const hz = displayHz(win.getBounds());
    if (!hz || hz === this.displayFps) return;
    const was = this.displayFps;
    void this.ctl.get<number>('override-display-fps').then(
      (cur) => {
        if (this.destroyed || this.displayFps !== was || Math.abs(Number(cur) - was) > 0.001) return;
        this.displayFps = hz;
        log.info(`display refresh rate ${was} → ${hz} Hz`);
        return this.ctl.set('override-display-fps', hz);
      },
      () => undefined,
    ).catch((err) => log.warn('override-display-fps not updated', err));
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopDisplayWatch?.();
    this.stopDisplayWatch = null;
    if (this.timer) clearTimeout(this.timer);
    if (this.geometryTimer) clearTimeout(this.geometryTimer);
    this.removeAllListeners();
    this.surface?.destroy();
    this.surface = null;
    await this.ctl.quit();
    this.windows.destroyPlaybackWindows();
    const main = this.windows.main;
    if (this.mainWasShown && !this.windows.inTray && main && !main.isDestroyed()) {
      main.show();
      main.focus();
    }
  }
}
