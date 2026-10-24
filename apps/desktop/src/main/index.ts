import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, dialog, Menu, nativeTheme, net, session, shell } from 'electron';
import { installKind } from '../shared/app-update';
import { Channels, type AppInfo } from '../shared/contract';
import { CastManager } from './cast/cast-manager';
import { SyncPlay } from './playback/syncplay';
import { EphemeralTokens } from './cast/ephemeral-token';
import type { SocketMessage } from './connection/server-socket';
import { ComicService } from './comics/comic-service';
import { PdfPages } from './comics/pdf-pages';
import { ConnectionManager } from './connection/connection-manager';
import { watchNetwork } from './connection/network-watch';
import { JsonStore } from './core/json-store';
import { logger } from './core/log';
import { isSafeMpvPath, SettingsService } from './core/settings';
import { CredentialVault, linuxPasswordStore } from './core/vault';
import { DownloadManager } from './downloads/download-manager';
import { FileSources } from './files/sources';
import { IptvSources } from './iptv/sources';
import { AdminAlerts } from './features/admin-alerts';
import { AppUpdates } from './features/app-updates';
import { ContinueWatching } from './features/continue-watching';
import { DesktopTheme } from './features/desktop-theme-linux';
import { DisplayModeSwitcher } from './features/display-mode';
import { clearGpuCaches, gpuLevel, gpuSwitches, nextGpuStep, readGpuState, readTextureCheck, writeGpuState, writeTextureCheck } from './features/gpu-recovery';
import { mpvRenderMode, ozonePlan, ozonePlatform, pickRenderNode } from './features/display-mode-linux';
import { HdrModeSwitcher } from './features/hdr-mode';
import { Notifier } from './features/notify';
import { Reminders } from './features/reminders';
import { liveLinkFromArgv } from '../shared/livetv/reminders';
import { installLoginItem, startedHidden } from './features/startup';
import { installJumpList } from './features/taskbar';
import { RatingsService } from './features/ratings';
import { ScrobbleService } from './features/scrobble';
import { TraktService } from './features/trakt';
import { DesktopIntegration } from './features/tray';
import { createSettingsExtras } from './core/settings-extras';
import { initI18n, t } from './i18n';
import { isSafeManagementUrl, registerIpc } from './ipc';
import { lrclibBase, lrclibLyrics, type LrclibCache } from './music/lrclib';
import { libmpvProbe } from './playback/libmpv-native';
import { mpvCandidates, mpvVersion } from './playback/mpv-controller';
import { PlaybackService, validId } from './playback/playback-service';
import { commandName } from './playback/remote-commands';
import { ImmichService } from './photos/immich';
import { tileService } from './photos/tiles';
import { handleProtocols, registerSchemes } from './protocols';
import { TorrentService } from './torrents/torrent-service';
import { VpnService } from './vpn';
import { EmbeddedMesh, locateMeshHelper } from './vpn/embedded-mesh';
import { vpnFixture } from './vpn/fixture';
import { WindowManager } from './windows/window-manager';

const APP_ID = 'com.wika.wicaby';
const log = logger.scope('main');

// A packaged build ignores the development switches entirely: every module that reads them
// later (protocol origin check, devtools, logging) sees them unset.
if (app.isPackaged) {
  delete process.env.WICABY_DEV_URL;
  delete process.env.WICABY_DEVTOOLS;
  delete process.env.WICABY_TEST_SILENT;
  delete process.env.WICABY_FAKE_VERSION;
}
// Checks (music-spec §6.2): nothing the app plays makes a sound; mpv gets --ao=null (mpv-controller.ts).
if (process.env.WICABY_TEST_SILENT === '1') app.commandLine.appendSwitch('mute-audio');

registerSchemes();
// Keyring on desktops Chromium does not recognise (Hyprland...): see linuxPasswordStore in vault.ts.
const passwordStore = process.platform === 'linux' ? linuxPasswordStore(process.env, process.argv) : null;
if (passwordStore) app.commandLine.appendSwitch('password-store', passwordStore);
// Keep rasterization, video decode and compositing on the GPU, even on drivers
// Chromium blocklists by default; scrolling and transitions stay at display rate.
// "Accélération matérielle de l'interface" off: none of that, and no GPU at all (read before ready). Read once: the
// libmpv texture mode below needs the GPU process too (#54).
const gpuAcceleration = hardwareAccelerationSetting();
// Native Wayland in a Wayland session, X11 elsewhere, unless WICABY_OZONE says otherwise (display-mode-linux.ts).
// Read before anything is appended: the platform Electron already runs on, and one relaunch when it is not the
// wanted one (an X11 browser with a Wayland GPU process has no GPU).
const ozone = process.platform === 'linux' ? ozonePlan(process.env, process.argv, app.commandLine.getSwitchValue('ozone-platform'), ozonePlatform(process.env)) : null;
const relaunching = Boolean(ozone?.relaunchWith);
if (ozone?.relaunchWith) {
  const args = [...process.argv.slice(1), `--ozone-platform=${ozone.relaunchWith}`];
  // An AppImage runs from a mount that goes away with this process: relaunch the image itself.
  app.relaunch(process.env.APPIMAGE ? { execPath: process.env.APPIMAGE, args } : { args });
  app.exit(0);
}
// Native Wayland windows have no X11 id for mpv's --wid: video then plays through libmpv inside the playback window
// when the native addon, libmpv and a render node pass the probe and GPU acceleration is on, else in mpv's own window
// (mpvRenderMode, mpv-player.ts). WICABY_MPV_RENDER=detached forces mpv's own window.
const waylandWindows = ozone?.effective === 'wayland';
// Linux: the GPU switches level that composited on the GPU last time for this build (gpu-recovery.ts).
const gpuStart = (() => {
  const key = `${app.getVersion()}/${process.versions.electron}`;
  const state = process.platform === 'linux' ? readGpuState(app.getPath('userData')) : null;
  return { key, state, level: gpuLevel(state, key) };
})();
// One render node for Chromium's GPU process and libmpv, chosen before Chromium starts (display-mode-linux.ts
// pickRenderNode); WICABY_RENDER_NODE wins. The addon reads WICABY_RENDER_NODE once, when it loads.
const renderNode = gpuAcceleration && waylandWindows ? process.env.WICABY_RENDER_NODE || pickRenderNode() : null;
if (gpuAcceleration) {
  for (const [name, value] of gpuSwitches(process.platform, gpuStart.level, waylandWindows)) app.commandLine.appendSwitch(name, value);
  if (renderNode) {
    app.commandLine.appendSwitch('render-node-override', renderNode);
    process.env.WICABY_RENDER_NODE = renderNode;
  }
} else {
  app.disableHardwareAcceleration();
}
// Set by the GPU process once it reported (getGPUFeatureStatus reads as software until then): registered before
// ready so the first report is never missed.
let gpuReported = false;
app.on('gpu-info-update', () => (gpuReported = true));

function hardwareAccelerationSetting(): boolean {
  // WICABY_DISABLE_GPU=1: for GPUs whose process crashes before a window ever shows (hybrid laptops).
  if (process.env.WICABY_DISABLE_GPU === '1') return false;
  try {
    const doc = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf8')) as { system?: { hardwareAcceleration?: unknown } };
    return doc.system?.hardwareAcceleration !== false;
  } catch {
    return true;
  }
}
// Dev runs (electron.exe) get their own id: sharing it makes Windows cache Electron's icon and jump list for the packaged app.
app.setAppUserModelId(app.isPackaged ? APP_ID : `${APP_ID}.dev`);
Menu.setApplicationMenu(null);
// Dark Mica and caption buttons until the main window applies the theme's scheme (applyNativeTheme).
nativeTheme.themeSource = 'dark';

// Accepts --wicaby-nav=/route (jump list) and wicaby://item/<id> (deep link).
function routeFromArgv(argv: string[]): string | null {
  for (const arg of argv) {
    let route: string | null = null;
    if (arg.startsWith('--wicaby-nav=')) route = arg.slice('--wicaby-nav='.length);
    else if (arg.startsWith('wicaby://')) route = `/${arg.slice('wicaby://'.length).replace(/\/+$/, '')}`;
    // /name, /name/:id or /name/:server/:id (jump list "Continue watching" entries).
    if (route && /^\/[a-z]+(\/[A-Za-z0-9-]{1,64}){0,2}$/.test(route)) return route;
  }
  return null;
}

const MPV_CONF_TEMPLATE = `# Wicaby: mpv configuration
# Read only when "Utiliser mpv.conf" is enabled in Wicaby's settings.
# Wicaby's own options (wid, OSD, input) are applied before this file.
#
# profile=high-quality
# scale=ewa_lanczossharp
# dscale=mitchell
# video-sync=display-resample
# interpolation=yes
# tscale=oversample
# sub-font="Segoe UI Semibold"
# sub-font-size=44
`;

// mpvCandidates (mpv-controller.ts) in order, each one validated.
function findSafeMpv(configured: string, resourcesPath: string, appRoot: string): string | null {
  const candidates = mpvCandidates(configured, resourcesPath, appRoot);
  return candidates.find((c) => isSafeMpvPath(c)) ?? null;
}

// The embedded mesh passes its stored control URL to the helper on every start. One saved
// before the https-or-loopback rule (or edited on disk) is dropped and the node left off,
// so it never reaches --control-url; the user signs in again from Settings.
function dropUnsafeMeshControlUrl(file: string): void {
  let prefs: Record<string, unknown>;
  try {
    prefs = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return;
  }
  if (!prefs || typeof prefs !== 'object' || prefs.managementUrl === undefined || isSafeManagementUrl(prefs.managementUrl)) return;
  delete prefs.managementUrl;
  prefs.enabled = false;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(prefs, null, 2));
  fs.renameSync(tmp, file);
  log.warn('mesh: dropped a control URL that is neither https nor loopback');
}

if (relaunching) {
  // app.exit above: nothing else starts.
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // A start that throws (a bad file, a locked profile) must not leave a windowless process holding the lock.
  bootstrap().catch((err: unknown) => {
    logger.errorSync('main', `start failed: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    dialog.showErrorBox('Wicaby', String(err));
    app.exit(1);
  });
}

async function bootstrap(): Promise<void> {
  await app.whenReady();
  const userData = app.getPath('userData');
  const logDir = path.join(userData, 'logs');
  logger.init(logDir);
  log.info(`==== Wicaby ${app.getVersion()} starting (Electron ${process.versions.electron}, ${os.release()}) ====`);
  app.on('child-process-gone', (_e, d) => {
    if (d.type === 'GPU') log.warn(`GPU process gone: ${d.reason} (exit code ${d.exitCode})`);
  });

  // Chromium's own GPU state (all platforms, read once, first: a relaunch below must not cut short anything started):
  // it can fall back to software compositing by itself (a GPU process that cannot start), which also leaves Linux
  // in-window video black with no error (#14). On Linux such a start relaunches with the next, safer GPU switches
  // (gpu-recovery.ts); when none works, a message says so. Nothing is decided on a GPU process that never reported.
  let composited = true;
  let canvasOnGpu = true;
  let gpuKnown = false;
  let gpuId = 'none';
  {
    type Gpu = { active?: boolean; vendorId?: number; deviceId?: number; driverVendor?: string; driverVersion?: string };
    const info = gpuAcceleration ? ((await Promise.race([app.getGPUInfo('basic').catch(() => null), new Promise((r) => setTimeout(r, 3000, null))])) as { gpuDevice?: Gpu[] } | null) : null;
    const gpus = info?.gpuDevice ?? [];
    const status = () => app.getGPUFeatureStatus() as unknown as Record<string, string>;
    const onGpu = () => status().gpu_compositing?.startsWith('enabled') ?? true;
    // getGPUFeatureStatus reads as software until the GPU process reported (gpu-info-update): up to 10 s for that.
    for (let waited = 0; gpuAcceleration && waited < 10_000 && !onGpu() && !gpuReported; waited += 250) await new Promise((r) => setTimeout(r, 250));
    const s = status();
    if (gpuAcceleration) {
      composited = onGpu();
      gpuKnown = composited || gpuReported;
      canvasOnGpu = s['2d_canvas']?.startsWith('enabled') ?? true;
    }
    const hex = (n?: number) => `0x${(n ?? 0).toString(16).padStart(4, '0')}`;
    const driver = (d: Gpu) => `${d.driverVendor ?? ''} ${d.driverVersion ?? ''}`.trim();
    const active = gpus.find((d) => d.active) ?? gpus[0];
    if (active) gpuId = `${hex(active.vendorId)}:${hex(active.deviceId)}/${driver(active) || '?'}`;
    (composited && (gpuKnown || !gpuAcceleration) ? log.info : log.warn)(
      `chromium gpu: ${gpus.map((d) => `${hex(d.vendorId)}:${hex(d.deviceId)}${d.active ? ' (active)' : ''}${driver(d) ? ` ${driver(d)}` : ''}`).join(', ') || 'none'}; ` +
        (ozone ? `ozone ${ozone.effective}${waylandWindows ? `, render node ${renderNode ?? 'none found'}` : ''}; ` : '') +
        (gpuAcceleration ? `switches level ${gpuStart.level}; ` : 'acceleration off; ') +
        ['gpu_compositing', '2d_canvas', 'rasterization', 'vulkan', 'webgl'].map((k) => `${k} ${s[k] ?? '?'}`).join(', ') +
        (gpuAcceleration && !gpuKnown ? '; the GPU process never reported in 10 s, nothing changed' : ''),
    );
    if (process.platform === 'linux' && gpuKnown) {
      const step = nextGpuStep(gpuStart.state, gpuStart.key, composited);
      // A state that cannot be saved would bring every start back to this level: no relaunch then.
      if (!writeGpuState(userData, step.state)) {
        if (step.relaunch) log.warn('no GPU compositing, and the GPU state could not be saved: no relaunch');
      } else if (step.relaunch) {
        log.warn(`no GPU compositing with switches level ${gpuStart.level}: relaunching with level ${step.state.level}`);
        clearGpuCaches(app.getPath('sessionData'));
        // An AppImage runs from a mount that goes away with this process: relaunch the image itself.
        app.relaunch(process.env.APPIMAGE ? { execPath: process.env.APPIMAGE, args: process.argv.slice(1) } : undefined);
        app.exit(0);
        return;
      }
    }
  }
  // Texture mode that failed for good with this build, GPU, driver, render node and switches level (gpu-recovery.ts).
  const textureKey = `${app.getVersion()}/${process.versions.electron}/${gpuId}/${renderNode ?? 'none'}/level ${gpuStart.level}`;

  const settings = new SettingsService(path.join(userData, 'settings.json'));
  initI18n(settings);
  const device = new JsonStore<{ deviceId: string }>(path.join(userData, 'device.json'), { deviceId: randomUUID() });
  device.flush();
  const identity = {
    client: 'Wicaby',
    version: app.getVersion(),
    deviceId: device.value.deviceId,
    deviceName: os.hostname().replace(/[^\x20-\x7e]/g, '') || 'Windows',
  };

  // After whenReady: the async safeStorage API needs a ready app. Every vault user below gets it loaded.
  const vault = await CredentialVault.open(path.join(userData, 'vault.bin'), undefined, { allowPlainText: () => settings.value.system.plainTextVault });
  let plainTextVault = settings.value.system.plainTextVault;
  settings.on('change', (s) => {
    if (s.system.plainTextVault !== plainTextVault && vault.plainText) void vault.save();
    plainTextVault = s.system.plainTextVault;
  });
  dropUnsafeMeshControlUrl(path.join(userData, 'mesh', 'wicaby.json'));
  const vpn = new VpnService((url) => void shell.openExternal(url), vpnFixture(process.env.WICABY_VPN_FIXTURE, app.isPackaged));
  const mesh = new EmbeddedMesh({
    exe: locateMeshHelper(process.resourcesPath, app.getAppPath()),
    dataDir: path.join(userData, 'mesh'),
    vault,
    deviceName: identity.deviceName,
  });
  vpn.setEmbedded(mesh);
  const connection = new ConnectionManager(path.join(userData, 'servers.json'), vault, identity, vpn);
  connection.setAllowControl(settings.value.remote.allowControl);
  // File sources (file-sources-spec): one local session each, next to the servers.
  const files = new FileSources(path.join(userData, 'files'), vault, identity, connection, process.platform, () => settings.value.photos.map.enabled);
  files.start();
  // A packaged build always loads its own bundled pages.
  const devUrl = app.isPackaged ? undefined : process.env.WICABY_DEV_URL;
  // Linux cannot decode .ico (the window would get no icon at all).
  const icon = path.join(app.getAppPath(), 'resources', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
  const windows = new WindowManager({
    preload: path.join(__dirname, '..', 'preload', 'index.cjs'),
    devUrl,
    icon: fs.existsSync(icon) ? icon : undefined,
    settings,
  });
  // IPTV sources: one local session each, answering the Live TV calls from an M3U playlist and an XMLTV guide.
  const iptv = new IptvSources(
    path.join(userData, 'iptv'),
    vault,
    identity,
    connection,
    (url, init) => net.fetch(url, { ...init, redirect: 'follow', cache: 'no-store', credentials: 'omit' }),
    (serverId, type, data) => windows.broadcast(Channels.serverEvent, { type, data, serverId }),
  );
  iptv.start();
  const downloads = new DownloadManager(path.join(userData, 'downloads.json'), connection, settings, windows);
  const display = new DisplayModeSwitcher();
  const hdr = new HdrModeSwitcher(userData);
  void hdr.restoreAfterCrash();
  const comicsDir = path.join(userData, 'cache', 'comics');
  const pdfPages = new PdfPages(() => windows.pageUrl('pdf.html'));
  // The archive worker is started from its source (main reads app.asar; a worker thread may not), read once.
  let archiveWorker: { script: string; evaluate: boolean; wasm: Uint8Array } | undefined;
  const comics = new ComicService(comicsDir, connection, downloads, () => settings.value.system.comicCacheGb * 1024 ** 3, {
    archiveWorker: () =>
      (archiveWorker ??= { script: fs.readFileSync(path.join(__dirname, 'archive-worker.cjs'), 'utf8'), evaluate: true, wasm: fs.readFileSync(path.join(__dirname, 'libarchive.wasm')) }),
    pdf: pdfPages,
  });
  const torrents = new TorrentService(path.join(userData, 'torrents.json'), settings, vault, connection, windows);
  const trakt = new TraktService(vault, settings, connection);
  const ratings = new RatingsService(vault, path.join(userData, 'ratings-cache.json'));
  const scrobble = new ScrobbleService(vault, path.join(userData, 'scrobble-queue.json'));

  const mpvConfigDir = path.join(userData, 'mpv');
  fs.mkdirSync(mpvConfigDir, { recursive: true });
  const confPath = path.join(mpvConfigDir, 'mpv.conf');
  if (!fs.existsSync(confPath)) fs.writeFileSync(confPath, MPV_CONF_TEMPLATE);

  // Whatever is found (setting, bundled copy, PATH...), only a validated local mpv.exe is run:
  // the first candidate that passes, not the first that merely exists.
  const findMpv = () => findSafeMpv(settings.value.playback.mpvPath, process.resourcesPath, app.getAppPath());
  let mpvPath = findMpv();
  let mpvVer: Promise<string | null> = mpvPath ? mpvVersion(mpvPath) : Promise.resolve(null);
  settings.on('change', () => {
    const next = findMpv();
    if (next !== mpvPath) {
      mpvPath = next;
      mpvVer = mpvPath ? mpvVersion(mpvPath) : Promise.resolve(null);
    }
  });
  // Probed once here: loading the addon dlopens libmpv, which an X11 or Windows run never needs.
  // libmpvProbe(): the one probe the addon load ran, with its real failure reason (missing libmpv, require error,
  // render node), never a second probe that would replace it (#33/#59/#68).
  // Settings > Playback can keep mpv in its own window (applies at the next start): the way out of a black picture.
  const render =
    waylandWindows && settings.value.playback.inWindowVideo === false
      ? { mode: 'detached' as const, reason: 'in-window video turned off in Settings' }
      : mpvRenderMode(process.env, waylandWindows, libmpvProbe, gpuAcceleration && (!gpuKnown || (composited && canvasOnGpu)), waylandWindows ? readTextureCheck(userData, textureKey) : null);
  const mpvRender = render.mode;
  (render.warn ? log.warn : log.info)(`mpv: ${mpvPath ?? 'not found'}, video ${mpvRender} (${render.reason})`);

  const toast = (kind: 'info' | 'success' | 'error', message: string, ms?: number) => windows.broadcast(Channels.toast, { kind, message, ms });

  const playback = new PlaybackService({
    connection,
    settings,
    windows,
    downloads,
    display,
    hdr,
    mpvExe: () => mpvPath,
    mpvRender,
    mpvConfigDir,
    deviceId: identity.deviceId,
    onMessage: toast,
    musicQueueFile: path.join(userData, 'music-queue.json'),
  });
  // Later starts go straight to mpv's own window on this machine (until the build, GPU, driver or level changes).
  playback.on('texture-failed', (message: string) => writeTextureCheck(userData, textureKey, message));
  // D8 (music-spec): the last music queue comes back, paused, once its server is signed in.
  connection.on('session', () => playback.restoreMusic());
  playback.restoreMusic();

  const cast = new CastManager({ connection, local: playback, deviceId: identity.deviceId, notify: toast, settings, tokens: new EphemeralTokens(vault, identity.version) });
  playback.beforePlay = () => cast.stopSenderReported();
  const syncplay = new SyncPlay({ connection, playback, onMessage: toast });
  // CA-11: disposable cast tokens left by a crash or a quit are revoked once their server is signed in again.
  connection.on('session', () => void cast.cleanupTokens());

  const notifier = new Notifier({ connection, downloads, settings, windows, playback, icon: fs.existsSync(icon) ? icon : undefined });
  const reminders = new Reminders(path.join(userData, 'reminders.json'), { connection, settings, windows, notifier, playback });

  // Photos map tiles (PH-09): only while the map is on; turning it off forgets the areas viewed.
  const tilesDir = path.join(userData, 'tiles');
  const tiles = tileService({
    config: () => settings.value.photos.map,
    userAgent: `Wicaby/${app.getVersion()} (+https://github.com/WicaebethTheo/wicaby-releases)`,
    dir: tilesDir,
  });
  settings.on('change', (s: { photos: { map: { enabled: boolean } } }) => {
    if (!s.photos.map.enabled) fs.rmSync(tilesDir, { recursive: true, force: true });
  });
  // Online lyrics (MU-13): nothing leaves the app unless Settings > Music turned it on.
  const lrclibOptions = {
    base: lrclibBase(process.env.LRCLIB_BASE, app.isPackaged),
    userAgent: `Wicaby/${app.getVersion()} (+https://github.com/WicaebethTheo/wicaby-releases)`,
    enabled: () => settings.value.music.lyricsProvider === 'server+lrclib',
    cache: new JsonStore<LrclibCache>(path.join(userData, 'lrclib-cache.json'), {}),
  };
  // Immich photo sources (photos spec PH-12): the key in the vault, pictures through wicaby-media://immich.
  const immich = new ImmichService({ file: path.join(userData, 'immich.json'), vault, downloads: () => settings.value.downloads.folder });
  handleProtocols({ rendererDir: path.join(__dirname, '..', 'renderer'), connection, downloads, comics, tiles, immich });

  // Nothing in the UI needs camera, mic, geolocation or notifications from the web layer.
  const allowed = new Set(['fullscreen', 'clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));

  const appInfo = async (): Promise<AppInfo> => ({
    name: 'Wicaby',
    version: app.getVersion(),
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    node: process.versions.node,
    platform: `${os.type()} ${os.arch()}`,
    osRelease: os.release(),
    deviceId: identity.deviceId,
    deviceName: identity.deviceName,
    mpvPath,
    mpvVersion: await mpvVer,
    userDataPath: userData,
    logPath: logger.filePath,
    isPackaged: app.isPackaged,
    vaultPlainText: vault.plainText,
    refreshRateMatch: display.available(),
  });

  // WICABY_FAKE_VERSION (development builds only, deleted above when packaged): the version the update check
  // compares against, e.g. 0.1.0 to see the notice for the current GitHub release.
  const updates = new AppUpdates(path.join(userData, 'update-check.json'), settings, process.env.WICABY_FAKE_VERSION || app.getVersion(), installKind(process.platform, process.env));
  updates.on('state', (s) => windows.send(windows.main, Channels.updatesChanged, s));
  updates.start();

  // The 'hyprland' theme's palette (Linux only: elsewhere it stays unavailable and the card is hidden).
  const desktopTheme = new DesktopTheme();
  if (process.platform === 'linux') void desktopTheme.start();
  desktopTheme.on('change', (s) => windows.broadcast(Channels.desktopThemeChanged, s));

  registerIpc({
    windows,
    updates,
    desktopTheme,
    settings,
    connection,
    playback,
    downloads,
    comics,
    vpn,
    torrents,
    trakt,
    ratings,
    scrobble,
    reminders,
    cast,
    syncplay,
    appInfo,
    files,
    iptv,
    immich,
    lrclib: (track) => lrclibLyrics(track, lrclibOptions),
    extras: createSettingsExtras({ mpvExe: () => mpvPath, runningMpv: () => playback.mpv, comicsDir, logDir, currentLog: () => logger.filePath }),
    openPath: (kind) => {
      const target = kind === 'logs' ? logDir : kind === 'mpv-config' ? mpvConfigDir : kind === 'data' ? userData : settings.value.downloads.folder;
      fs.mkdirSync(target, { recursive: true });
      void shell.openPath(target);
    },
  });

  connection.on('session', (s) => windows.broadcast(Channels.sessionChanged, s));
  settings.on('change', (s) => windows.broadcast(Channels.settingsChanged, s));
  settings.on('change', (s) => connection.setAllowControl(s.remote.allowControl));
  playback.on('state', (s) => windows.broadcast(Channels.playbackState, s));
  downloads.on('change', (d) => windows.broadcast(Channels.downloadsChanged, d));
  immich.on('change', (list) => windows.send(windows.main, Channels.immichChanged, list));
  torrents.on('state', (s) => windows.send(windows.main, Channels.torrentsChanged, s));
  trakt.on('state', (s) => windows.send(windows.main, Channels.traktChanged, s));
  playback.on('report', (action, serverId, item, positionMs, durationMs) => trakt.scrobble(action, serverId, item, positionMs, durationMs));
  scrobble.on('state', (s) => windows.send(windows.main, Channels.scrobbleChanged, s));
  playback.on('report', (action, _serverId, item, positionMs, durationMs) => scrobble.report(action, item, positionMs, durationMs));
  mesh.on('change', (s) => windows.broadcast(Channels.vpnEmbeddedChanged, s));
  cast.on('state', (s) => windows.broadcast(Channels.castState, s));
  cast.on('targets', (list) => windows.broadcast(Channels.castTargetsUpdated, list));
  syncplay.on('change', (g) => windows.broadcast(Channels.syncplayChanged, g));
  connection.on('server-message', (msg: SocketMessage, serverId: string) => {
    // The cast mirror's SessionsStart pushes (cast-spec CA-04).
    if (msg.MessageType === 'Sessions') return cast.onSessions(serverId, msg.Data);
    if (msg.MessageType.startsWith('SyncPlay')) return syncplay.onMessage(msg, serverId);
    // A Plex server stopped this client's session (server-socket.ts plexEvent).
    if (msg.MessageType === 'PlexSessionEnded') return void playback.serverEnded(serverId, String((msg.Data as { ItemId?: string } | undefined)?.ItemId ?? ''));
    if (playback.handleRemote(msg, serverId)) return;
    const d = (msg.Data ?? {}) as Record<string, unknown>;
    const args = (d.Arguments ?? {}) as Record<string, string>;
    // handleRemote already dropped every remote command but DisplayMessage while remote control is off.
    if (msg.MessageType === 'GeneralCommand') {
      switch (commandName(d.Name, ['DisplayMessage', 'DisplayContent', 'GoHome', 'GoToSettings'] as const)) {
        case 'DisplayMessage':
          // Plain text (the toast does not render markup), capped like the other apps.
          // Up for the sender's TimeoutMs (3-30 s, 8 s without one).
          toast('info', [args.Header, args.Text].filter((v) => typeof v === 'string' && v).join(' · ').slice(0, 500), Math.min(30_000, Math.max(3000, Number(args.TimeoutMs) || 8000)));
          return;
        case 'DisplayContent':
          // The id ends up in a route: Emby ids are digits, Jellyfin ids hex or GUIDs.
          if (validId(args.ItemId)) windows.send(windows.main, Channels.navigate, `/item/${serverId}/${args.ItemId}`);
          return;
        case 'GoHome':
          windows.send(windows.main, Channels.navigate, '/home');
          return;
        case 'GoToSettings':
          windows.send(windows.main, Channels.navigate, '/settings');
          return;
      }
    }
    windows.broadcast(Channels.serverEvent, { type: msg.MessageType, data: msg.Data, serverId });
  });

  // --hidden (login item): no window, only the tray icon.
  const main = windows.createMain(startedHidden(process.argv));
  // "Échelle de l'interface": Chromium zoom, per origin, so the OSD window follows too.
  const applyZoom = () => {
    if (!main.isDestroyed()) main.webContents.setZoomFactor(settings.value.ui.zoom / 100);
  };
  main.webContents.on('did-finish-load', applyZoom);
  settings.on('change', applyZoom);
  // "Confirmer avant de quitter pendant une lecture": closing the main window or quitting the app.
  let quitConfirmed = false;
  const confirmQuit = (): boolean => {
    if (quitConfirmed) return true;
    const parent = windows.playback?.osd ?? windows.main;
    const ask = (o: Electron.MessageBoxSyncOptions) => (parent && !parent.isDestroyed() ? dialog.showMessageBoxSync(parent, o) : dialog.showMessageBoxSync(o)) === 0;
    // A cast the sender reports for (direct DLNA, Cast DMR) ends with the app (cast-spec §2.5); session targets play on.
    const casting = cast.senderReported;
    if (casting) {
      quitConfirmed = ask({
        type: 'question',
        buttons: [t('cast.quit.confirm'), t('common.actions.cancel')],
        defaultId: 1,
        cancelId: 1,
        noLink: true,
        title: 'Wicaby',
        message: t('cast.quit.title'),
        detail: t('cast.quit.body', { device: casting.name }),
      });
      if (quitConfirmed) void cast.stop();
      return quitConfirmed;
    }
    if (!settings.value.ui.confirmQuitDuringPlayback || !playback.getState().active) return true;
    const opts: Electron.MessageBoxSyncOptions = {
      type: 'question',
      buttons: [t('common.actions.quit'), t('common.actions.cancel')],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
      title: 'Wicaby',
      message: t('main.dialog.quitPlayback.message'),
      detail: t('main.dialog.quitPlayback.detail'),
    };
    quitConfirmed = ask(opts);
    return quitConfirmed;
  };
  // After the close-to-tray handler: a window only hidden is not a quit.
  main.on('close', (event) => {
    if (!event.defaultPrevented && !confirmQuit()) event.preventDefault();
  });
  const initialRoute = routeFromArgv(process.argv);
  if (initialRoute) main.webContents.once('did-finish-load', () => windows.send(main, Channels.navigate, initialRoute));
  // wicaby://live?channel=…: tuned once the servers are up (reminders.watch retries, F3).
  const link = liveLinkFromArgv(process.argv);
  if (link) main.webContents.once('did-finish-load', () => void reminders.watch(link.channel, link.server));
  // Launched by Windows as the magnet: handler.
  main.webContents.once('did-finish-load', () => torrents.handleArgv(process.argv));
  // Linux without a keyring: say why sign-ins do not survive a restart (Confidentialité pane to keep them).
  if (vault.plainText && !settings.value.system.plainTextVault) main.webContents.once('did-finish-load', () => toast('info', t('main.vault.memoryOnly')));
  // No GPU after every recovery level (Linux) or on Windows: the app works, slowly, and says why.
  if (gpuKnown && !composited) main.webContents.once('did-finish-load', () => toast('error', t('main.gpu.software'), 20000));

  const adminAlerts = new AdminAlerts({ connection, settings, windows, notifier }, path.join(userData, 'admin-alerts.json'));
  windows.onHiddenToTray = () => notifier.trayHint();
  const desktop = new DesktopIntegration({
    windows,
    playback,
    settings,
    downloads,
    icon: fs.existsSync(icon) ? icon : await app.getFileIcon(process.execPath, { size: 'small' }),
  });
  installLoginItem(settings);

  app.on('second-instance', (_e, argv) => {
    if (torrents.handleArgv(argv)) return;
    const live = liveLinkFromArgv(argv);
    if (live) return void reminders.watch(live.channel, live.server);
    const route = routeFromArgv(argv);
    // Another login-item launch (--hidden) leaves the running instance as it is.
    if (!route && startedHidden(argv)) return;
    windows.focusMain();
    if (route) windows.send(windows.main, Channels.navigate, route);
  });

  installJumpList();
  const continueWatching = new ContinueWatching(connection, playback);
  continueWatching.on('change', (entries) => {
    installJumpList(entries);
    desktop.setContinue(entries);
  });
  if (app.isPackaged) app.setAsDefaultProtocolClient('wicaby');
  // A server only on the mesh needs the embedded node up before the address race.
  void mesh.resume().finally(() => connection.resumeLastSession());
  // Wake, network change, or a server that dropped: re-pick its address and reconnect (connection-manager recheck()).
  watchNetwork((moved) => void connection.recheckAll(moved));
  // File sources that went offline (a share asleep, a drive unplugged) come back on the same passes.
  watchNetwork(() => void files.recheckAll());

  app.on('window-all-closed', () => app.quit());

  let cleaned = false;
  app.on('before-quit', (event) => {
    if (cleaned) return;
    if (!confirmQuit()) {
      windows.cancelQuit();
      return event.preventDefault();
    }
    event.preventDefault();
    cleaned = true;
    void (async () => {
      try {
        cast.dispose();
        await Promise.race([playback.shutdown(), new Promise((r) => setTimeout(r, 4000))]);
        // After playback's final 'stop' report: its listen is sent or queued, and the queue saved.
        await scrobble.shutdown();
        // A credential change still being encrypted reaches the disk before exit.
        if (vault.busy) await Promise.race([vault.flush(), new Promise((r) => setTimeout(r, 2000))]);
      } finally {
        // One failing step must not skip the others' writes, nor app.quit().
        for (const step of [() => windows.saveState(), () => settings.flush(), () => reminders.flush(), () => connection.flush(), () => files.shutdown(), () => iptv.shutdown(), () => downloads.flush(), () => torrents.flush(), () => adminAlerts.flush(), () => updates.flush(), () => vpn.dispose(), () => desktop.dispose(), () => pdfPages.close()]) {
          try {
            step();
          } catch (err) {
            log.warn('quit step failed', err);
          }
        }
        log.info('==== Wicaby exiting ====');
        app.quit();
      }
    })();
  });
}
