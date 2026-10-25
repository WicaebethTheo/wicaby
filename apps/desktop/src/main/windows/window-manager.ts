import os from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { app, BaseWindow, BrowserWindow, nativeTheme, screen, shell, systemPreferences, type Rectangle } from 'electron';
import { APP_HOST, APP_SCHEME, Channels, type WindowState } from '../../shared/contract';
import { logger } from '../core/log';
import type { SettingsService } from '../core/settings';
import { EXIT_FADE_MS } from '../playback/player';
import tokens from '../../../../../packages/tokens/tokens.json';
import { centred, mainAfterPlayback, near, playbackRect } from './window-geometry';

const log = logger.scope('windows');

// Mica, native menus and the caption buttons follow the theme's scheme; 'system' lets Windows decide.
export function applyNativeTheme(theme: string): void {
  nativeTheme.themeSource = theme === 'light' ? 'light' : theme === 'system' ? 'system' : 'dark';
}

// The window behind the page (first paint, resizing) and the caption glyphs, from the theme's colour tokens
// (packages/tokens/tokens.json). Call applyNativeTheme first: 'system' reads the scheme it set.
export function chromeColours(theme: string): { bg: string; symbol: string } {
  const themes = tokens.themes as Record<string, Record<string, unknown>>;
  const id = theme === 'system' ? (nativeTheme.shouldUseDarkColors ? 'graphite' : 'light') : theme;
  const own = themes[id] ?? {};
  const base = themes.graphite as Record<string, string>;
  return { bg: (own.bg as string) ?? base.bg, symbol: (own.label as string) ?? base.label };
}

export function isWindows11(): boolean {
  const build = Number(os.release().split('.')[2] ?? 0);
  return process.platform === 'win32' && build >= 22000;
}

// URL.origin is "null" for a non-special scheme such as app://, so it is rebuilt from
// protocol and host there. Credentials in the URL never match.
function originOf(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.username || u.password) return null;
  return u.origin !== 'null' ? u.origin : `${u.protocol}//${u.host}`;
}

// Debugging entry points the fuses leave open (remote-debugging-*) or that must stay closed
// even if a fuse is ever reverted. Exported so index.ts can refuse them before app ready.
export const DEBUG_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe', 'inspect', 'inspect-brk', 'inspect-port'] as const;

export function packagedDebugSwitch(
  packaged = app.isPackaged,
  hasSwitch: (name: string) => boolean = (name) => app.commandLine.hasSwitch(name),
): string | null {
  if (!packaged) return null;
  return DEBUG_SWITCHES.find((name) => hasSwitch(name)) ?? null;
}

export interface WindowManagerOptions {
  preload: string;
  devUrl?: string;
  icon?: string;
  settings: SettingsService;
}

// pair: mpv's own video window (--wid) under a transparent OSD window. single (texture mode, native Wayland): one
// opaque window that draws libmpv's frames on a canvas under the OSD (video-surface.ts), so no video window.
export type PlaybackWindows = { mode: 'pair'; video: BaseWindow; osd: BrowserWindow } | { mode: 'single'; video: null; osd: BrowserWindow };

// Owns every BrowserWindow. The main window hosts the Svelte app. mpv playback
// uses a pair: an opaque video window whose HWND mpv renders into, and a
// transparent OSD window owned by it, so the web UI floats above the video
// (Emby layered a child HWND under WebView2 for the same effect).
export class WindowManager {
  main: BrowserWindow | null = null;
  playback: PlaybackWindows | null = null;
  private readonly mica = isWindows11();
  // Main window hidden in the notification area (close-to-tray or tray click).
  inTray = false;
  // Maximized as the user left it: Windows reports a minimized maximized window as not maximized, and a window
  // started hidden (--hidden) maximizes only at its first show. Neither fires 'unmaximize'.
  private mainMaximized = false;
  // Set by index.ts: first-time explanation when closing only hides the window.
  onHiddenToTray: (() => void) | null = null;
  private quitting = false;

  // A quit vetoed later in before-quit (e.g. "confirmer avant de quitter") must not leave close-to-tray disabled.
  cancelQuit(): void {
    this.quitting = false;
  }

  constructor(private readonly opts: WindowManagerOptions) {
    // Chromium's remote debugging is not covered by the Electron fuses: a packaged build never
    // opens a window (preload API, signed-in session) with a CDP endpoint listening.
    const debugSwitch = packagedDebugSwitch();
    if (debugSwitch) {
      logger.errorSync('windows', `refusing to start: --${debugSwitch} is not allowed in a packaged build`);
      app.exit(1);
    }
    app.on('before-quit', () => {
      this.quitting = true;
    });
  }

  url(route: string, extra: Record<string, string> = {}): string {
    // linux=1: the renderer sizes the title bar from the overlay's env() values (app.css). win=1: Windows wording.
    const platform: Record<string, string> = process.platform === 'linux' ? { linux: '1' } : process.platform === 'win32' ? { win: '1' } : {};
    const params = new URLSearchParams({ mica: this.mica ? '1' : '0', ...platform, ...extra }).toString();
    const base = this.opts.devUrl ? `${this.opts.devUrl}/index.html` : `${APP_SCHEME}://${APP_HOST}/index.html`;
    return `${base}?${params}#${route}`;
  }

  // Another page of the renderer build (pdf.html), from the dev server or app://.
  pageUrl(file: string): string {
    return this.opts.devUrl ? `${this.opts.devUrl}/${file}` : `${APP_SCHEME}://${APP_HOST}/${file}`;
  }

  // Exact origin match: a prefix test let "http://localhost:5173.evil.test" or
  // "app://wicaby.evil/" through.
  isAppUrl(url: string): boolean {
    const origin = originOf(url);
    if (!origin) return false;
    if (this.opts.devUrl && origin === originOf(this.opts.devUrl)) return true;
    return origin === `${APP_SCHEME}://${APP_HOST}`;
  }

  private webPreferences(): Electron.WebPreferences {
    // app.exit() in the constructor is not synchronous: no preload window in the meantime.
    if (packagedDebugSwitch()) throw new Error('debugging switch in a packaged build');
    return {
      preload: this.opts.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      // Never in a packaged build, whatever the environment says (the fuses close NODE_OPTIONS
      // and --inspect; an env-var DevTools switch would be the same kind of backdoor).
      devTools: !app.isPackaged && (Boolean(this.opts.devUrl) || process.env.WICABY_DEVTOOLS === '1'),
    };
  }

  private harden(win: BrowserWindow): void {
    const wc = win.webContents;
    wc.on('will-navigate', (event, url) => {
      if (!this.isAppUrl(url)) {
        event.preventDefault();
        log.warn(`blocked navigation to ${url}`);
      }
    });
    wc.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    wc.on('render-process-gone', (_e, details) => log.error(`renderer gone: ${details.reason}`));
    wc.on('console-message', (event) => {
      // A map tile address is a place (photos spec §6.1): never logged.
      // The source file and line (no query string) say which code threw, e.g. an uncloneable value sent over IPC.
      const where = event.sourceId ? ` @ ${event.sourceId.replace(/[?#].*$/, '').split('/').pop()}:${event.lineNumber}` : '';
      if (event.level === 'error') log.warn(`renderer: ${event.message.replace(/wicaby-media:\/\/tile\/[^\s'")]*/g, 'wicaby-media://tile/…')}${where}`);
    });
  }

  // hidden: started by the login item (--hidden); the tray icon brings it up.
  createMain(hidden = false): BrowserWindow {
    const saved = this.opts.settings.value.window;
    const bounds = saved.bounds ? this.placeOnScreen(saved.bounds) : { width: 1440, height: 900 };
    let theme = this.opts.settings.value.ui.theme;
    applyNativeTheme(theme);
    const colours = chromeColours(theme);
    const win = new BrowserWindow({
      ...bounds,
      minWidth: 960,
      minHeight: 600,
      show: false,
      title: 'Wicaby',
      icon: this.opts.icon,
      backgroundColor: this.mica ? '#00000000' : colours.bg,
      backgroundMaterial: this.mica ? 'mica' : undefined,
      titleBarStyle: 'hidden',
      // Native caption buttons keep Snap Layouts on hover over maximize.
      titleBarOverlay: { color: '#00000000', symbolColor: colours.symbol, height: 44 },
      webPreferences: this.webPreferences(),
    });
    this.harden(win);
    // The constructor sizes the window with the primary display's scale; setting the
    // bounds again once it exists lands it at the right size on a monitor with another DPI.
    if ('x' in bounds) win.setBounds(bounds);
    this.inTray = hidden;
    this.mainMaximized = saved.maximized === true;
    win.on('maximize', () => (this.mainMaximized = true));
    win.on('unmaximize', () => (this.mainMaximized = false));
    // maximize() would show a hidden window: defer it to the first show.
    if (saved.maximized) {
      if (hidden) win.once('show', () => win.maximize());
      else win.maximize();
    }
    let ready = false;
    win.once('ready-to-show', () => {
      ready = true;
      if (!hidden) win.show();
    });
    // Some Linux GPU/compositor setups never fire ready-to-show: show it anyway after 3 s.
    // Only then: once it came, a hidden window was hidden on purpose (mpv playback swaps it out).
    if (!hidden)
      setTimeout(() => {
        if (!ready && !win.isDestroyed() && !win.isVisible() && !this.inTray) win.show();
      }, 3000);
    const paintChrome = () => {
      if (win.isDestroyed()) return;
      const c = chromeColours(theme);
      // The mini player lives only while this window does, so it repaints from here too.
      if (!this.mica) for (const w of [win, this.mini]) if (w && !w.isDestroyed()) w.setBackgroundColor(c.bg);
      if (process.platform !== 'darwin') win.setTitleBarOverlay({ color: '#00000000', symbolColor: c.symbol, height: 44 });
    };
    const onSettings = () => {
      const next = this.opts.settings.value.ui.theme;
      if (next === theme) return;
      theme = next;
      applyNativeTheme(theme);
      paintChrome();
    };
    // Windows switching between light and dark while the theme follows it.
    const onNative = () => {
      if (theme === 'system') paintChrome();
    };
    this.opts.settings.on('change', onSettings);
    nativeTheme.on('updated', onNative);
    win.once('closed', () => {
      this.opts.settings.off('change', onSettings);
      nativeTheme.off('updated', onNative);
    });

    const sendState = () => this.send(win, Channels.windowState, this.windowState(win));
    for (const ev of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'focus', 'blur'] as const) {
      win.on(ev as 'maximize', sendState);
    }
    win.on('close', (event) => {
      if (!this.quitting && this.opts.settings.value.windows.closeToTray) {
        event.preventDefault();
        this.hideMain();
        this.onHiddenToTray?.();
      } else {
        this.saveBounds(win);
      }
    });
    // A monitor unplugged or rescaled: bring the window back if it is now off screen.
    const keepOnScreen = () => {
      if (win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return;
      const b = win.getBounds();
      if (!this.visibleOnSomeDisplay(b)) win.setBounds(this.placeOnScreen(b));
    };
    screen.on('display-removed', keepOnScreen);
    screen.on('display-metrics-changed', keepOnScreen);
    win.once('closed', () => {
      screen.off('display-removed', keepOnScreen);
      screen.off('display-metrics-changed', keepOnScreen);
    });
    win.on('closed', () => {
      this.main = null;
      // A lone mini player would keep the app alive with no way back.
      if (this.mini && !this.mini.isDestroyed()) this.mini.destroy();
    });
    void win.loadURL(this.url('/'));
    this.main = win;
    return win;
  }

  // Enough of the window and its title bar is on some monitor to grab it.
  private visibleOnSomeDisplay(b: Rectangle): boolean {
    return screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x < a.x + a.width - 50 && b.x + b.width > a.x + 50 && b.y < a.y + a.height - 50 && b.y + 40 > a.y;
    });
  }

  // Saved bounds as is when still reachable; otherwise (monitor removed, layout or
  // DPI changed) the same size, shrunk if needed, centred on the nearest monitor.
  private placeOnScreen(b: Rectangle): Rectangle {
    return this.visibleOnSomeDisplay(b) ? b : centred(b, screen.getDisplayMatching(b).workArea);
  }

  hideMain(): void {
    const win = this.main;
    if (!win || win.isDestroyed()) return;
    this.saveBounds(win);
    this.inTray = true;
    win.hide();
  }

  // Quit: the placement reaches settings before the final flush (the windows close after it).
  saveState(): void {
    if (this.main && !this.main.isDestroyed()) this.saveBounds(this.main);
  }

  // A hidden window keeps the bounds saved when it was hidden.
  private saveBounds(win: BrowserWindow): void {
    if (win.isVisible()) this.opts.settings.update({ window: { bounds: win.getNormalBounds(), maximized: win.isMaximized() } });
  }

  // The app's "reduce motion" or the system's: player transitions become instant switches.
  reducedMotion(): boolean {
    return this.opts.settings.value.ui.reduceMotion || systemPreferences.getAnimationSettings().prefersReducedMotion;
  }

  windowState(win: BrowserWindow): WindowState {
    return { maximized: win.isMaximized(), fullscreen: win.isFullScreen(), focused: win.isFocused() };
  }

  private wasMaximized(m: BrowserWindow): boolean {
    return m.isMaximized() || ((m.isMinimized() || !m.isVisible()) && this.mainMaximized);
  }

  createPlaybackWindows(fullscreen: boolean): PlaybackWindows {
    if (this.playback) return this.playback;
    // The main window's place and state (window-geometry.ts): playback looks like it happens in that window.
    const m = this.main && !this.main.isDestroyed() ? this.main : null;
    const ref = m
      ? playbackRect({ bounds: m.getBounds(), normal: m.getNormalBounds(), maximized: this.wasMaximized(m), minimized: m.isMinimized(), fullscreen: m.isFullScreen() }, screen.getDisplayMatching(m.getBounds()).workArea)
      : screen.getPrimaryDisplay().workArea;
    // mpv renders into a child of this window (--wid). Chromium composites the
    // window's own surface above child windows, so it must be a transparent
    // BaseWindow (no web contents); any opaque background hides the video.
    const video = new BaseWindow({
      ...ref,
      show: false,
      frame: false,
      transparent: true,
      title: 'Wicaby',
      icon: this.opts.icon,
      backgroundColor: '#00000000',
    });
    const osd = new BrowserWindow({
      ...ref,
      parent: video,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      skipTaskbar: true,
      resizable: true,
      title: 'Wicaby',
      webPreferences: this.webPreferences(),
    });
    this.harden(osd);
    void osd.loadURL(this.url('/osd', { osd: '1' }));
    // The constructors size windows with the primary display's scale; set again so both land
    // at the same pixel size on a monitor with another DPI (see createMain).
    osd.setBounds(ref);
    video.setBounds(ref);

    // The OSD is the window the user drags and snaps; the video follows it at once, then
    // settlePlayback re-checks once the moves, DPI changes and display changes are over.
    const follow = () => {
      if (video.isDestroyed() || osd.isDestroyed()) return;
      video.setBounds(osd.getBounds());
      this.settlePlayback();
    };
    osd.on('move', follow);
    osd.on('resize', follow);
    const displayChanged = () => this.settlePlayback();
    for (const ev of ['display-metrics-changed', 'display-added', 'display-removed'] as const) screen.on(ev as 'display-added', displayChanged);
    video.once('closed', () => {
      for (const ev of ['display-metrics-changed', 'display-added', 'display-removed'] as const) screen.off(ev as 'display-added', displayChanged);
    });
    // Alt+Tab or a taskbar click activates the video window; hand focus to the OSD.
    video.on('focus', () => {
      if (!osd.isDestroyed()) osd.focus();
    });
    video.on('restore', () => {
      if (!osd.isDestroyed()) osd.focus();
    });

    this.playback = { mode: 'pair', video, osd };
    video.once('closed', () => {
      if (this.playback?.video === video) this.playback = null;
    });

    if (fullscreen) this.setPlaybackFullscreen(true);
    // Opening: the OSD's veil takes the page to black first (OsdWindow.svelte), then mpv's window comes in under
    // it and the main window hides; the veil lifts on the first frame. Instant with reduced motion.
    const reduced = this.reducedMotion();
    this.playbackLeaving = false;
    const swap = () => {
      if (this.playback?.video !== video || this.playbackLeaving) return;
      video.showInactive();
      this.main?.hide();
    };
    if (reduced) video.showInactive();
    osd.once('ready-to-show', () => {
      osd.show();
      osd.focus();
      if (reduced) return swap();
      const veiled = osd.webContents.executeJavaScript('window.__wicabyVeil?.()').catch(() => undefined);
      void Promise.race([veiled, sleep(EXIT_FADE_MS * 3)]).then(swap);
    });
    return this.playback;
  }

  // Texture mode (mpv-player.ts): one opaque window whose page draws the video frames under the OSD. Native Wayland
  // only, where a client cannot place or stack its windows: fullscreen is the compositor's, and nothing follows
  // or settles. The video window of the pair is the OSD window itself here (hostWindow, minimise, tray).
  createPlaybackWindow(fullscreen: boolean): PlaybackWindows {
    if (this.playback) return this.playback;
    // No position on Wayland: the main window's size and maximized state are what a client can ask for.
    const m = this.main && !this.main.isDestroyed() ? this.main : null;
    const ref = m ? m.getNormalBounds() : screen.getPrimaryDisplay().workArea;
    const maximized = m ? this.wasMaximized(m) : false;
    const osd = new BrowserWindow({
      ...ref,
      show: false,
      frame: false,
      transparent: false,
      backgroundColor: '#000000',
      resizable: true,
      title: 'Wicaby',
      icon: this.opts.icon,
      webPreferences: this.webPreferences(),
    });
    this.harden(osd);
    void osd.loadURL(this.url('/osd', { osd: '1', video: '1' }));
    this.playback = { mode: 'single', video: null, osd };
    osd.once('closed', () => {
      if (this.playback?.osd === osd) this.playback = null;
    });
    // Opening: the veil takes the page to black (OsdWindow.svelte), then the main window hides; there is no
    // second window to swap in. The veil lifts on the first frame.
    const reduced = this.reducedMotion();
    this.playbackLeaving = false;
    const swap = () => {
      if (this.playback?.osd !== osd || this.playbackLeaving) return;
      this.main?.hide();
    };
    osd.once('ready-to-show', () => {
      osd.show();
      osd.focus();
      // Not the constructor's fullscreen option: Hyprland ignores a fullscreen request made before the first map
      // while Electron then reports the window fullscreen, so the first toggle did nothing. Maximize likewise.
      if (maximized) osd.maximize();
      if (fullscreen) osd.setFullScreen(true);
      if (reduced) return swap();
      const veiled = osd.webContents.executeJavaScript('window.__wicabyVeil?.()').catch(() => undefined);
      void Promise.race([veiled, sleep(EXIT_FADE_MS * 3)]).then(swap);
    });
    return this.playback;
  }

  private savedPlaybackBounds: Rectangle | null = null;
  private playbackLeaving = false;
  private settleTimer: NodeJS.Timeout | null = null;
  // Set by the mpv player: checks that mpv's own child window followed the video window.
  onPlaybackSettled: (() => void) | null = null;

  // 150 ms after the last move, resize or display change. A window that crossed to a monitor
  // with another DPI is rescaled by Windows (WM_DPICHANGED) after our setBounds, the OSD and the
  // video each on their own, and a fullscreen pair keeps covering the old size when the display
  // changes under it (resolution, scale, HDR or refresh switch). Put both back on one rectangle.
  private settlePlayback(): void {
    if (this.settleTimer) clearTimeout(this.settleTimer);
    this.settleTimer = setTimeout(() => {
      this.settleTimer = null;
      const pw = this.playback;
      if (!pw || pw.mode === 'single' || pw.osd.isDestroyed() || pw.video.isDestroyed() || pw.video.isMinimized()) return;
      const target = this.savedPlaybackBounds ? screen.getDisplayMatching(pw.osd.getBounds()).bounds : pw.osd.getBounds();
      for (const win of [pw.osd, pw.video]) {
        if (near(win.getBounds(), target)) continue;
        log.info(`playback window off by more than 1 px, set again: ${JSON.stringify(win.getBounds())} → ${JSON.stringify(target)}`);
        win.setBounds(target);
      }
      this.onPlaybackSettled?.();
    }, 150);
  }

  // Manual fullscreen: both windows cover the display. Windows hides the
  // taskbar because the focused window spans the monitor.
  setPlaybackFullscreen(value: boolean): void {
    const pw = this.playback;
    if (!pw) return;
    if (value && this.pipBounds) this.togglePlaybackPip();
    if (pw.mode === 'single') {
      if (!pw.osd.isDestroyed()) pw.osd.setFullScreen(value);
      return;
    }
    if (value) {
      if (!this.savedPlaybackBounds) this.savedPlaybackBounds = pw.osd.getBounds();
      const display = screen.getDisplayMatching(pw.osd.getBounds());
      pw.osd.setBounds(display.bounds);
      pw.video.setBounds(display.bounds);
    } else if (this.savedPlaybackBounds) {
      pw.osd.setBounds(this.savedPlaybackBounds);
      pw.video.setBounds(this.savedPlaybackBounds);
      this.savedPlaybackBounds = null;
    }
    this.settlePlayback();
  }

  isPlaybackFullscreen(): boolean {
    const pw = this.playback;
    if (pw?.mode === 'single') return !pw.osd.isDestroyed() && pw.osd.isFullScreen();
    return this.savedPlaybackBounds !== null;
  }

  // The pair's bounds before picture-in-picture.
  private pipBounds: Rectangle | null = null;
  // Single window: it was maximized before picture-in-picture.
  private pipMaximized = false;

  // Picture-in-picture (LT-23, §8.7): the pair becomes an always-on-top 16:9 mini window in the bottom-right
  // corner of the work area, or goes back. No --wid reparenting: mpv keeps rendering into the same window.
  togglePlaybackPip(): void {
    const pw = this.playback;
    if (!pw) return;
    const on = !this.pipBounds;
    if (pw.mode === 'single') return this.togglePipSingle(pw.osd, on);
    if (on && this.savedPlaybackBounds) this.setPlaybackFullscreen(false);
    let target: Rectangle;
    if (on) {
      this.pipBounds = pw.osd.getBounds();
      const a = screen.getDisplayMatching(this.pipBounds).workArea;
      const width = Math.round(Math.min(480, a.width / 3));
      const height = Math.round((width * 9) / 16);
      target = { x: a.x + a.width - width - 16, y: a.y + a.height - height - 16, width, height };
    } else {
      target = this.pipBounds as Rectangle;
      this.pipBounds = null;
    }
    for (const win of [pw.video, pw.osd]) win.setAlwaysOnTop(on, 'floating');
    pw.osd.setBounds(target);
    pw.video.setBounds(target);
    this.settlePlayback();
  }

  // Single window (native Wayland): a client can neither place nor pin its window, so only the size changes. The
  // title ("Wicaby PiP") is set after the window is mapped, so a compositor's static rules (Hyprland float/pin) do
  // not apply to it; docs/desktop.md (Picture-in-picture) gives the keybind that works and the rule syntax.
  private togglePipSingle(win: BrowserWindow, on: boolean): void {
    if (win.isDestroyed()) return;
    if (on) {
      if (win.isFullScreen()) win.setFullScreen(false);
      this.pipBounds = win.getNormalBounds();
      this.pipMaximized = win.isMaximized();
      if (this.pipMaximized) win.unmaximize();
      const a = screen.getDisplayMatching(this.pipBounds).workArea;
      const width = Math.round(Math.min(480, a.width / 3));
      win.setSize(width, Math.round((width * 9) / 16));
    } else {
      const back = this.pipBounds as Rectangle;
      this.pipBounds = null;
      win.setSize(back.width, back.height);
      if (this.pipMaximized) win.maximize();
      this.pipMaximized = false;
    }
    win.setTitle(on ? 'Wicaby PiP' : 'Wicaby');
  }

  isPlaybackPip(): boolean {
    return this.pipBounds !== null;
  }

  // What the user made of the player becomes the main window's state, so the two feel like one window: the player's
  // windowed rectangle (the one under full screen or PiP), or maximized (window-geometry.ts). Un/maximizing would show
  // and activate a hidden window, so that part waits for the call made once main is visible (under the OSD).
  private mainLikePlayback(pw: PlaybackWindows): void {
    const main = this.main;
    if (!main || main.isDestroyed() || main.isFullScreen()) return;
    let player: Rectangle;
    let filled: boolean;
    if (pw.mode === 'pair') {
      // The video window: it follows the OSD and outlives it when the OSD is closed (Alt+F4).
      if (pw.video.isDestroyed() || pw.video.isMinimized()) return;
      player = this.pipBounds ?? this.savedPlaybackBounds ?? pw.video.getBounds();
      filled = near(player, screen.getDisplayMatching(player).workArea);
    } else {
      // Wayland: no position, and the state under the compositor's full screen is unknown: size and maximized only.
      if (pw.osd.isDestroyed() || (pw.osd.isFullScreen() && !this.pipBounds)) return;
      const b = this.pipBounds ?? pw.osd.getNormalBounds();
      player = { ...main.getNormalBounds(), width: b.width, height: b.height };
      filled = this.pipBounds ? this.pipMaximized : pw.osd.isMaximized();
    }
    const now = main.getBounds();
    const step = mainAfterPlayback({ bounds: now, normal: main.getNormalBounds(), maximized: main.isMaximized(), work: screen.getDisplayMatching(now).workArea }, player, filled, screen.getDisplayMatching(player).workArea);
    if (!main.isVisible() && (step.maximize !== main.isMaximized() || (step.maximize && step.bounds))) return;
    // shortcut: un/maximizing a just-shown main can flash its old state where the OSD does not cover it, and
    // SW_RESTORE activates it before hidePlayback; hide it with setOpacity(0) once tested with Mica.
    if (main.isMaximized() && (!step.maximize || step.bounds)) main.unmaximize();
    // Twice: a move to a monitor with another DPI (see createMain).
    if (step.bounds) for (let i = 0; i < 2; i++) main.setBounds(step.bounds);
    if (step.maximize && !main.isMaximized()) main.maximize();
  }

  // Exit transition, once the OSD's veil is opaque: the main window shown without the focus, under the OSD, in the
  // player's place and state (mainLikePlayback). Resolves once it painted a frame (500 ms at most).
  async showMainUnder(): Promise<void> {
    const main = this.main;
    const pw = this.playback;
    // An opening that has not swapped the windows yet (stopped within a few hundred ms) never will.
    this.playbackLeaving = true;
    if (!main || main.isDestroyed() || this.inTray) return;
    if (!main.isVisible()) {
      if (pw) this.mainLikePlayback(pw);
      // A maximized main window comes up above the pair, inactive or not: the OSD floats over it until it hides.
      // A single window (native Wayland) cannot keep itself above it.
      if (pw?.mode === 'pair' && !pw.osd.isDestroyed()) pw.osd.setAlwaysOnTop(true);
      main.showInactive();
      if (pw) this.mainLikePlayback(pw);
    }
    const painted = main.webContents.executeJavaScript('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(true))))');
    await Promise.race([painted.catch(() => undefined), sleep(500)]);
  }

  // End of the exit transition: the main window takes the focus and the pair goes (destroyed afterwards).
  hidePlayback(): void {
    const pw = this.playback;
    if (this.main && !this.main.isDestroyed() && this.main.isVisible()) this.main.focus();
    if (!pw) return;
    for (const win of pw.video ? [pw.osd, pw.video] : [pw.osd]) if (!win.isDestroyed()) win.hide();
  }

  destroyPlaybackWindows(): void {
    const pw = this.playback;
    // Playback started from the tray (remote "Play on") ends back in the tray. After an exit transition the
    // main window is already up, and the user may have moved on to another app since. Before the PiP and
    // full-screen rectangles are cleared: mainLikePlayback reads them.
    if (pw && this.main && !this.main.isDestroyed() && !this.inTray && !this.main.isVisible()) {
      this.mainLikePlayback(pw);
      this.main.show();
      this.mainLikePlayback(pw);
      this.main.focus();
    }
    this.playback = null;
    this.savedPlaybackBounds = null;
    this.pipBounds = null;
    this.pipMaximized = false;
    this.onPlaybackSettled = null;
    if (this.settleTimer) clearTimeout(this.settleTimer);
    if (!pw) return;
    if (!pw.osd.isDestroyed()) pw.osd.destroy();
    if (pw.video && !pw.video.isDestroyed()) pw.video.destroy();
  }

  send(win: BrowserWindow | null | undefined, channel: string, payload: unknown): void {
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
  }

  broadcast(channel: string, payload: unknown): void {
    this.send(this.main, channel, payload);
    if (this.playback) this.send(this.playback.osd, channel, payload);
    this.send(this.mini, channel, payload);
  }

  // Music mini player (music-spec §4.4, MU-10): 360 × 96, frameless, always on top, where it was last left. Opening
  // it sends the main window to the tray when "Réduire dans la barre" is on; closing it brings the main window back.
  mini: BrowserWindow | null = null;

  openMini(): void {
    if (this.mini && !this.mini.isDestroyed()) return this.mini.show();
    const size = { width: 360, height: 96 };
    const at = this.opts.settings.value.window.mini;
    const saved = at && Number.isFinite(at.x) && Number.isFinite(at.y) ? { ...size, x: Math.round(at.x), y: Math.round(at.y) } : null;
    const a = screen.getPrimaryDisplay().workArea;
    const bounds = saved && this.visibleOnSomeDisplay(saved) ? saved : { ...size, x: a.x + a.width - size.width - 24, y: a.y + a.height - size.height - 24 };
    const win = new BrowserWindow({
      ...bounds,
      show: false,
      frame: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      title: 'Wicaby',
      icon: this.opts.icon,
      backgroundColor: this.mica ? '#00000000' : chromeColours(this.opts.settings.value.ui.theme).bg,
      backgroundMaterial: this.mica ? 'acrylic' : undefined,
      webPreferences: this.webPreferences(),
    });
    this.harden(win);
    win.setAlwaysOnTop(true, 'floating');
    win.setBounds(bounds);
    const save = () => {
      if (win.isDestroyed()) return;
      const { x, y } = win.getBounds();
      this.opts.settings.update({ window: { mini: { x, y } } });
    };
    win.on('moved', save);
    win.on('close', save);
    win.on('closed', () => {
      if (this.mini === win) this.mini = null;
      // The main window comes back, unless the app is quitting.
      if (!this.quitting) this.focusMain();
    });
    win.once('ready-to-show', () => win.show());
    void win.loadURL(this.url('/mini', { mini: '1' }));
    this.mini = win;
    if (this.opts.settings.value.windows.closeToTray) this.hideMain();
  }

  closeMini(): void {
    if (this.mini && !this.mini.isDestroyed()) this.mini.close();
  }

  toggleMini(): void {
    if (this.mini && !this.mini.isDestroyed()) this.closeMini();
    else this.openMini();
  }

  focusMain(): void {
    const win = this.main;
    if (!win) return;
    this.inTray = false;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
}
