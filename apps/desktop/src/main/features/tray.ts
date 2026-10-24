import { app, globalShortcut, Menu, nativeImage, Tray, type BaseWindow, type MenuItemConstructorOptions, type NativeImage } from 'electron';
import { Channels, type PlaybackCommand, type PlaybackState } from '../../shared/contract';
import { logger } from '../core/log';
import type { SettingsService } from '../core/settings';
import type { DownloadManager } from '../downloads/download-manager';
import { onLanguageChange, t } from '../i18n';
import type { PlaybackService } from '../playback/playback-service';
import type { WindowManager } from '../windows/window-manager';
import type { ContinueEntry } from './continue-watching';
import { setTaskbarProgress } from './taskbar';

const log = logger.scope('tray');

export interface DesktopDeps {
  windows: WindowManager;
  playback: PlaybackService;
  settings: SettingsService;
  downloads: DownloadManager;
  icon: string | NativeImage;
}

// ---- Overlay badge: a graphite disc with a white play or pause glyph ----

function badge(kind: 'play' | 'pause'): NativeImage {
  // 16x16 DIP at 2x, 4x supersampled, BGRA premultiplied.
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  const inDisc = (x: number, y: number) => (x - 8) ** 2 + (y - 8) ** 2 <= 7.6 ** 2;
  const inGlyph =
    kind === 'play'
      ? (x: number, y: number) => x >= 6 && x <= 11.6 && Math.abs(y - 8) <= ((11.6 - x) / 5.6) * 3.6
      : (x: number, y: number) => y >= 4.8 && y <= 11.2 && ((x >= 5.2 && x <= 7.2) || (x >= 8.8 && x <= 10.8));
  const disc = [44, 44, 46];
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let d = 0;
      let g = 0;
      for (const [ox, oy] of [
        [0.25, 0.25],
        [0.75, 0.25],
        [0.25, 0.75],
        [0.75, 0.75],
      ]) {
        const x = (px + ox) / 2;
        const y = (py + oy) / 2;
        if (inDisc(x, y)) {
          d++;
          if (inGlyph(x, y)) g++;
        }
      }
      const alpha = d / 4;
      const white = d ? g / d : 0;
      const i = (py * size + px) * 4;
      for (let c = 0; c < 3; c++) buf[i + c] = Math.round((white * 255 + (1 - white) * disc[2 - c]) * alpha);
      buf[i + 3] = Math.round(alpha * 255);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size, scaleFactor: 2 });
}

const MEDIA_KEYS: [string, PlaybackCommand][] = [
  ['MediaPlayPause', { type: 'toggle-pause' }],
  ['MediaNextTrack', { type: 'next' }],
  ['MediaPreviousTrack', { type: 'previous' }],
  ['MediaStop', { type: 'stop' }],
];

// Media keys reach Wicaby through Chromium's Media Session (SMTC), which only
// engages while a page plays audio: the <video> of the built-in player, or the
// OSD's silent keep-alive during mpv playback. With WASAPI exclusive the OSD
// plays nothing, so only then do we take the keys as global shortcuts. One path
// at a time, so a key press never fires twice. Linux: Chromium publishes the same
// Media Session over MPRIS and the OSD keeps it alive even in exclusive mode, so the
// desktop's media keys always go through MPRIS (an X11 key grab would steal them).
export function needsGlobalMediaKeys(state: PlaybackState, audioExclusive: boolean, platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'linux' && state.active && state.player === 'mpv' && audioExclusive;
}

const titleOf = (s: PlaybackState) => {
  const it = s.item;
  if (!it) return '';
  // A track (music-spec §4.2): "Titre · Artiste".
  if (it.artists?.length) return t('main.music.tray.nowPlaying', { title: it.name, artist: it.artists.join(', ') });
  return it.seriesName ? `${it.seriesName} · ${it.name}` : it.name;
};

// Tray icon and menu, taskbar overlay badge and playback progress, media key
// fallback. Everything follows PlaybackService's state events.
export class DesktopIntegration {
  readonly tray: Tray;
  private menuKey: string | null = null;
  private host: BaseWindow | null = null;
  private progressKey = '';
  private overlayKey = '';
  private mediaKeys = false;
  private lastMainBlur = 0;
  private badges: Record<'play' | 'pause', NativeImage> | null = null;
  private continueEntries: ContinueEntry[] = [];
  private readonly offLanguage: () => void;
  private readonly onBlur = (_e: unknown, w: unknown) => {
    if (w === this.deps.windows.main) this.lastMainBlur = Date.now();
  };

  constructor(private readonly deps: DesktopDeps) {
    this.tray = new Tray(deps.icon);
    this.tray.setToolTip('Wicaby');
    this.tray.on('click', () => this.toggleWindow());
    app.on('browser-window-blur', this.onBlur);
    deps.playback.on('state', (s: PlaybackState) => this.update(s));
    deps.settings.on('change', () => this.update(deps.playback.getState()));
    this.offLanguage = onLanguageChange(() => {
      // Force the cached menu and overlay label to rebuild in the new language.
      this.menuKey = null;
      this.overlayKey = '';
      this.update(deps.playback.getState());
    });
    this.update(deps.playback.getState());
  }

  private command(c: PlaybackCommand): void {
    void this.deps.playback.command(c).catch((err) => log.warn('tray command failed', err));
  }

  // Playing in mpv: bring the video forward. Otherwise show or hide the main window.
  showApp(): void {
    const pw = this.deps.windows.playback;
    // Texture mode: one window, the OSD's (window-manager.ts createPlaybackWindow).
    if (pw?.mode === 'single' && !pw.osd.isDestroyed()) {
      if (pw.osd.isMinimized()) pw.osd.restore();
      pw.osd.show();
      pw.osd.focus();
      return;
    }
    if (pw?.mode === 'pair' && !pw.osd.isDestroyed() && !pw.video.isDestroyed()) {
      if (pw.video.isMinimized()) pw.video.restore();
      pw.video.showInactive();
      pw.osd.show();
      pw.osd.focus();
      return;
    }
    this.deps.windows.focusMain();
  }

  toggleWindow(): void {
    const main = this.deps.windows.main;
    // The click itself takes focus away from the window: "was focused" means just before.
    const active = main && main.isVisible() && !main.isMinimized() && (main.isFocused() || Date.now() - this.lastMainBlur < 500);
    if (active && !this.deps.windows.playback) this.deps.windows.hideMain();
    else this.showApp();
  }

  setContinue(entries: ContinueEntry[]): void {
    this.continueEntries = entries;
    this.menuKey = null;
    this.updateMenu(this.deps.playback.getState());
  }

  private open(route: string): void {
    const { windows } = this.deps;
    windows.focusMain();
    windows.send(windows.main, Channels.navigate, route);
  }

  private update(s: PlaybackState): void {
    this.updateMenu(s);
    this.updateTaskbar(s);
    this.updateMediaKeys(s);
  }

  private updateMenu(s: PlaybackState): void {
    const title = titleOf(s);
    const hasNext = s.queueIndex + 1 < s.queueLength;
    const key = s.active ? `${title}|${s.paused}|${hasNext}` : '';
    // Rebuilt only when something shown changes, not on every time update.
    if (key === this.menuKey) return;
    this.menuKey = key;
    const items: MenuItemConstructorOptions[] = [{ label: t('main.tray.open'), click: () => this.showApp() }];
    if (this.continueEntries.length) {
      items.push({
        label: t('main.tray.continue'),
        // && shows a literal & (a single one would underline the next letter).
        submenu: this.continueEntries.map((e) => ({ label: e.title.replace(/&/g, '&&'), click: () => this.open(e.route) })),
      });
    }
    if (s.active) {
      const label = title.length > 60 ? `${title.slice(0, 59)}…` : title;
      items.push(
        { type: 'separator' },
        { label: label || t('main.tray.nowPlaying'), enabled: false },
        { label: s.paused ? t('main.tray.play') : t('main.tray.pause'), click: () => this.command({ type: 'toggle-pause' }) },
        { label: t('main.tray.next'), enabled: hasNext, click: () => this.command({ type: 'next' }) },
        { label: t('main.tray.stop'), click: () => this.command({ type: 'stop' }) },
      );
    }
    items.push({ type: 'separator' }, { label: t('main.tray.quit'), click: () => app.quit() });
    this.tray.setContextMenu(Menu.buildFromTemplate(items));
    this.tray.setToolTip(s.active && title ? `Wicaby · ${title}`.slice(0, 127) : 'Wicaby');
  }

  private hostFor(s: PlaybackState): BaseWindow | null {
    if (!s.active) return null;
    const pw = this.deps.windows.playback;
    const w = s.player === 'mpv' ? (pw?.video ?? pw?.osd) : this.deps.windows.main;
    return w && !w.isDestroyed() ? w : null;
  }

  private downloadsRunning(): boolean {
    return this.deps.downloads.list().some((d) => d.status === 'downloading' || d.status === 'queued');
  }

  private updateTaskbar(s: PlaybackState): void {
    if (process.platform !== 'win32') return;
    const host = this.hostFor(s);
    const main = this.deps.windows.main;
    if (host !== this.host) {
      const old = this.host;
      if (old && !old.isDestroyed()) {
        old.setOverlayIcon(null, '');
        // The main window's bar belongs to downloads when they run.
        if (old !== main || !this.downloadsRunning()) setTaskbarProgress(old, null);
      }
      this.host = host;
      this.progressKey = '';
      this.overlayKey = '';
    }
    if (!host) return;

    const overlay = s.paused ? 'pause' : 'play';
    if (overlay !== this.overlayKey) {
      this.overlayKey = overlay;
      this.badges ??= { play: badge('play'), pause: badge('pause') };
      host.setOverlayIcon(this.badges[overlay], s.paused ? t('main.tray.paused') : t('main.tray.nowPlaying'));
    }

    if (host === main && this.downloadsRunning()) return;
    const fraction = s.durationMs > 0 ? Math.min(1, s.positionMs / s.durationMs) : null;
    const key = fraction === null ? 'none' : `${Math.round(fraction * 500)}|${s.paused}`;
    if (key === this.progressKey) return;
    this.progressKey = key;
    setTaskbarProgress(host, fraction, s.paused ? 'paused' : 'normal');
  }

  private updateMediaKeys(s: PlaybackState): void {
    const want = needsGlobalMediaKeys(s, this.deps.settings.value.playback.audioExclusive);
    if (want === this.mediaKeys) return;
    this.mediaKeys = want;
    for (const [accel, cmd] of MEDIA_KEYS) {
      if (!want) {
        if (globalShortcut.isRegistered(accel)) globalShortcut.unregister(accel);
      } else if (!globalShortcut.register(accel, () => this.command(cmd))) {
        log.warn(`media key ${accel} is taken by another application`);
      }
    }
  }

  dispose(): void {
    app.off('browser-window-blur', this.onBlur);
    this.offLanguage();
    for (const [accel] of MEDIA_KEYS) if (globalShortcut.isRegistered(accel)) globalShortcut.unregister(accel);
    if (!this.tray.isDestroyed()) this.tray.destroy();
  }
}
