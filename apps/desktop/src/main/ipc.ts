import fs from 'node:fs';
import { app, BrowserWindow, dialog, ipcMain, powerSaveBlocker, shell, type IpcMainInvokeEvent } from 'electron';
import {
  Channels,
  type AppInfo,
  type CastCommand,
  type DeepPartial,
  type HtmlPlayerEvent,
  type LrclibTrack,
  type PlaybackCommand,
  type PlayRequest,
  type Query,
  type Settings,
  type VpnConnectOptions,
  type VpnKind,
} from '../shared/contract';
import type { Lyrics } from '../shared/music';
import { uploadItemImage } from './admin/item-images';
import type { CastManager } from './cast/cast-manager';
import type { ComicService } from './comics/comic-service';
import { ApiError } from './connection/api-client';
import type { ConnectionManager } from './connection/connection-manager';
import { discoverServers } from './connection/discovery';
import { logger } from './core/log';
import { discover as discoverFiles } from './files/mdns';
import type { FileSources } from './files/sources';
import type { IptvSources } from './iptv/sources';
import type { ImmichService } from './photos/immich';
import { isSafeMpvPath, type SettingsService } from './core/settings';
import type { SettingsExtras } from './core/settings-extras';
import type { DownloadManager } from './downloads/download-manager';
import type { RatingsService } from './features/ratings';
import type { ScrobbleService } from './features/scrobble';
import type { TraktService } from './features/trakt';
import type { AppUpdates } from './features/app-updates';
import type { DesktopTheme } from './features/desktop-theme-linux';
import type { Reminders } from './features/reminders';
import { t } from './i18n';
import type { PlaybackService } from './playback/playback-service';
import type { SyncPlay } from './playback/syncplay';
import { HASH_RE, MAGNET_RE, type TorrentService } from './torrents/torrent-service';
import type { VpnService } from './vpn';
import { EmbeddedMesh } from './vpn/embedded-mesh';
import type { WindowManager } from './windows/window-manager';

const log = logger.scope('ipc');
const rendererLog = logger.scope('renderer');

export interface IpcDeps {
  windows: WindowManager;
  settings: SettingsService;
  connection: ConnectionManager;
  playback: PlaybackService;
  downloads: DownloadManager;
  comics: ComicService;
  vpn: VpnService;
  torrents: TorrentService;
  trakt: TraktService;
  ratings: RatingsService;
  scrobble: ScrobbleService;
  reminders: Reminders;
  cast: CastManager;
  syncplay: SyncPlay;
  appInfo: () => Promise<AppInfo>;
  updates: AppUpdates;
  desktopTheme: DesktopTheme;
  openPath: (kind: 'logs' | 'downloads' | 'mpv-config' | 'data') => void;
  extras: SettingsExtras;
  files: FileSources;
  iptv: IptvSources;
  immich: ImmichService;
  // MU-13: lrclib.net lyrics (main/music/lrclib.ts), behind the music.lyricsProvider setting.
  lrclib: (track: LrclibTrack) => Promise<Lyrics | null>;
}

const isString = (v: unknown, max = 2048): v is string => typeof v === 'string' && v.length <= max;

// Optional trailing serverId; absent means the primary server.
function serverArg(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isString(v, 128) || !/^[\w-]+$/.test(v)) throw new Error(t('errors.ipc.invalidServer'));
  return v;
}

function plainQuery(q: unknown): Query | undefined {
  if (q === undefined || q === null) return undefined;
  if (typeof q !== 'object' || Array.isArray(q)) throw new Error(t('errors.ipc.invalidQuery'));
  const out: Query = {};
  for (const [k, v] of Object.entries(q as Record<string, unknown>)) {
    if (v === undefined || v === null || ['string', 'number', 'boolean'].includes(typeof v)) out[k] = v as Query[string];
  }
  return out;
}

// The mpv executable and its extra arguments decide what program runs and with which
// options: neither may come from a settings patch (beyond clearing the path) or an
// imported file. The path is set only through the pick-mpv dialog below.
function withoutMpvOverrides(doc: Record<string, unknown>, current: Settings['playback'] | null): Record<string, unknown> {
  const playback = doc.playback;
  const valid = !!playback && typeof playback === 'object' && !Array.isArray(playback);
  // A patch without playback leaves it alone; an import without one still keeps this machine's mpv.
  if (!valid && !current) return doc;
  const { mpvPath, mpvArgs, ...rest } = (valid ? playback : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...rest };
  if (current) {
    // Import: this machine's values stay.
    out.mpvPath = current.mpvPath;
    out.mpvArgs = current.mpvArgs;
  } else {
    if (mpvPath === '') out.mpvPath = '';
    if (mpvArgs !== undefined) out.mpvArgs = mpvArgs;
  }
  return { ...doc, playback: out };
}

// api:request paths are relative to the server root: printable ASCII only (the URL parser
// drops tab/CR/LF before it resolves dot segments), no "." or ".." segment, no encoded
// dot, backslash, query or fragment (the query travels separately).
export function isSafeApiPath(path: unknown): path is string {
  return isString(path, 1024) && path.startsWith('/') && !path.startsWith('//') && !path.includes('://') && !/[^\x21-\x7e]|%2e|[\\?#]/i.test(path) && !path.split('/').some((s) => s === '.' || s === '..');
}

// Management server: https, or plain http only to this machine.
export function isSafeManagementUrl(v: unknown): v is string {
  if (!isString(v, 512) || !/^https?:\/\/[^\s]+$/i.test(v)) return false;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  if (u.protocol === 'https:') return true;
  const host = u.hostname.toLowerCase();
  return u.protocol === 'http:' && (host === 'localhost' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host));
}

// Typed IPC replaces Emby's "##seq/count#Action#Obj#Member#Id##json" frames and
// the window.prompt() sync channel. Every handler checks that the sender is one
// of our own pages.
export function registerIpc(deps: IpcDeps): void {
  const { windows, settings, connection, playback, downloads } = deps;

  const handle = <A extends unknown[], R>(channel: string, fn: (event: IpcMainInvokeEvent, ...args: A) => R | Promise<R>) => {
    ipcMain.handle(channel, async (event, ...args) => {
      if (!windows.isAppUrl(event.senderFrame?.url ?? '')) {
        log.warn(`rejected ${channel} from ${event.senderFrame?.url}`);
        throw new Error(t('errors.ipc.unauthorizedSender'));
      }
      return fn(event, ...(args as A));
    });
  };
  const senderWindow = (event: IpcMainInvokeEvent) => BrowserWindow.fromWebContents(event.sender);

  // app
  handle(Channels.appInfo, () => deps.appInfo());
  handle(Channels.appQuit, () => app.quit());
  handle(Channels.appOpenExternal, (_e, url: unknown) => {
    if (isString(url) && /^https?:\/\//i.test(url)) return shell.openExternal(url);
  });
  handle(Channels.appOpenPath, (_e, kind: unknown) => {
    if (kind === 'logs' || kind === 'downloads' || kind === 'mpv-config' || kind === 'data') deps.openPath(kind);
  });
  handle(Channels.updatesState, () => deps.updates.state);
  handle(Channels.updatesCheck, () => deps.updates.check(true));
  handle(Channels.updatesDismiss, () => deps.updates.dismiss());
  handle(Channels.updatesOpen, (_e, target: unknown) => {
    if (target === 'notes' || target === 'download' || target === 'repo') return deps.updates.open(target);
  });
  handle(Channels.desktopThemeGet, () => deps.desktopTheme.ready.then(() => deps.desktopTheme.state));
  handle(Channels.appStorage, () => deps.extras.storage());
  handle(Channels.appClearStorage, (_e, kind: unknown) => {
    if (kind !== 'http' && kind !== 'logs') throw new Error(t('errors.ipc.unknownCache'));
    return deps.extras.clearStorage(kind);
  });
  ipcMain.on(Channels.appLog, (event, level: unknown, message: unknown) => {
    if (!windows.isAppUrl(event.senderFrame?.url ?? '') || !isString(message, 8000)) return;
    if (level === 'error') rendererLog.error(message);
    else if (level === 'warn') rendererLog.warn(message);
    else rendererLog.info(message);
  });

  // window
  handle(Channels.windowMinimize, (e) => {
    const win = senderWindow(e);
    // The OSD is owned by the video window; minimising the owner hides both. A single playback window (texture
    // mode) is its own video window.
    if (win && win === windows.playback?.osd) (windows.playback.video ?? win).minimize();
    else win?.minimize();
  });
  handle(Channels.windowToggleMaximize, (e) => {
    const win = senderWindow(e);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  handle(Channels.windowClose, (e) => {
    const win = senderWindow(e);
    if (win && win === windows.playback?.osd) return playback.command({ type: 'stop' });
    win?.close();
  });
  handle(Channels.windowToggleFullscreen, (e) => {
    const win = senderWindow(e);
    if (win && win === windows.playback?.osd) return playback.command({ type: 'toggle-fullscreen' });
    win?.setFullScreen(!win.isFullScreen());
  });
  handle(Channels.windowMini, (_e, action: unknown) => {
    if (action === 'open') windows.openMini();
    else if (action === 'close') windows.closeMini();
    else if (action === 'toggle') windows.toggleMini();
    else throw new Error(t('errors.ipc.invalidQuery'));
  });
  handle(Channels.musicLrclib, (_e, track: unknown) => {
    const o = (track ?? {}) as Record<string, unknown>;
    const ok = isString(o.id, 128) && isString(o.artist, 512) && isString(o.title, 512) && isString(o.album, 512) && typeof o.durationMs === 'number' && Number.isFinite(o.durationMs) && o.durationMs >= 0;
    if (!ok || !o.artist || !o.title) return null;
    return deps.lrclib(o as unknown as LrclibTrack);
  });
  handle(Channels.windowGetState, (e) => {
    const win = senderWindow(e);
    return win ? windows.windowState(win) : { maximized: false, fullscreen: false, focused: false };
  });

  // settings
  handle(Channels.settingsGet, () => settings.value);
  handle(Channels.settingsUpdate, (_e, patch: unknown) => {
    if (!patch || typeof patch !== 'object') throw new Error(t('errors.ipc.invalidSettings'));
    return settings.update(withoutMpvOverrides(patch as Record<string, unknown>, null) as DeepPartial<Settings>);
  });
  handle(Channels.settingsPickFolder, async (e) => {
    const win = senderWindow(e);
    const opts: Electron.OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'], defaultPath: settings.value.downloads.folder };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });
  handle(Channels.settingsAudioDevices, () => deps.extras.audioDevices());
  handle(Channels.settingsReset, () => settings.reset());
  handle(Channels.settingsExport, async (e) => {
    const win = senderWindow(e);
    const opts: Electron.SaveDialogOptions = { defaultPath: t('main.dialog.settingsExportName'), filters: [{ name: 'JSON', extensions: ['json'] }] };
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return false;
    // The window placement belongs to this machine.
    const { window: _w, ...doc } = settings.value;
    // WebDAV and SMB sources without credentials; local folders only mean something on this machine.
    await fs.promises.writeFile(r.filePath, JSON.stringify({ wicabySettings: 1, ...doc, fileSources: deps.files.exportable() }, null, 2), 'utf8');
    return true;
  });
  handle(Channels.settingsImport, async (e) => {
    const win = senderWindow(e);
    const opts: Electron.OpenDialogOptions = { properties: ['openFile'], filters: [{ name: 'JSON', extensions: ['json'] }] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    const file = r.canceled ? undefined : r.filePaths[0];
    if (!file) return null;
    if ((await fs.promises.stat(file)).size > 1024 * 1024) throw new Error(t('errors.ipc.fileTooLarge'));
    let doc: unknown;
    try {
      doc = JSON.parse(await fs.promises.readFile(file, 'utf8'));
    } catch {
      throw new Error(t('errors.ipc.notSettingsExport'));
    }
    if (!doc || typeof doc !== 'object' || (doc as { wicabySettings?: unknown }).wicabySettings !== 1) throw new Error(t('errors.ipc.notSettingsExport'));
    // File sources travel beside the settings (remote ones only, without credentials).
    deps.files.importSources((doc as { fileSources?: unknown }).fileSources);
    delete (doc as { fileSources?: unknown }).fileSources;
    return settings.replace(withoutMpvOverrides(doc as Record<string, unknown>, settings.value.playback));
  });
  handle(Channels.settingsPickMpv, async (e) => {
    const win = senderWindow(e);
    // Linux: the binary has no extension, so no filter (isSafeMpvPath still wants a file named mpv).
    const opts: Electron.OpenDialogOptions = { properties: ['openFile'], ...(process.platform === 'win32' ? { filters: [{ name: 'mpv', extensions: ['exe'] }] } : {}) };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    const file = r.canceled ? undefined : r.filePaths[0];
    if (!file) return null;
    // Main sets the path itself, and only to a local, existing mpv.exe.
    if (!isSafeMpvPath(file)) throw new Error(t('errors.ipc.pathRefused'));
    settings.update({ playback: { mpvPath: file } });
    return file;
  });

  // servers & session
  handle(Channels.serversDiscover, () => discoverServers());
  handle(Channels.serversList, () => connection.list());
  handle(Channels.serversAdd, (_e, address: unknown) => {
    if (!isString(address, 512)) throw new Error(t('errors.ipc.invalidAddress'));
    return connection.add(address);
  });
  handle(Channels.serversEmbyConnect, (_e, username: unknown, password: unknown) => {
    if (!isString(username, 256) || !isString(password, 1024)) throw new Error(t('errors.ipc.invalidCredentials'));
    return connection.embyConnect(username, password);
  });
  handle(Channels.serversSelect, (_e, id: unknown) => {
    if (!isString(id, 128)) throw new Error(t('errors.ipc.invalidId'));
    return connection.select(id);
  });
  handle(Channels.serversRemove, async (_e, id: unknown) => {
    if (!isString(id, 128)) return;
    // The stopped report to an unreachable server (a common reason to remove it) must not hold up the removal.
    if (playback.serverId === id)
      await Promise.race([playback.stop().catch((err) => log.warn('stop before remove failed', err)), new Promise((r) => setTimeout(r, 2000))]);
    connection.remove(id);
  });
  handle(Channels.serversWake, (_e, id: unknown) => (isString(id, 128) ? connection.wake(id) : false));
  // Plex (plex-spec §5): tokens only ever stay in main.
  const plexId = (v: unknown): string => {
    if (!isString(v, 64) || !/^[0-9a-f]{8,40}$/i.test(v)) throw new Error(t('errors.ipc.invalidId'));
    return v;
  };
  handle(Channels.serversPlexLink, () => connection.plexLink());
  handle(Channels.serversPlexPoll, () => connection.plexPoll());
  handle(Channels.serversPlexAccounts, () => connection.plexAccounts());
  handle(Channels.serversPlexUnlink, async (_e, id: unknown) => {
    const account = plexId(id);
    if (connection.plexServerIds(account).includes(playback.serverId ?? '')) await playback.stop();
    connection.plexUnlink(account);
  });
  handle(Channels.serversPlexSetHidden, async (_e, id: unknown, hidden: unknown) => {
    const sid = plexId(id);
    if (hidden === true && playback.serverId === sid) await playback.stop();
    return connection.plexSetHidden(sid, hidden === true);
  });
  handle(Channels.serversPlexConfirm, (_e, id: unknown, address: unknown) => {
    if (!isString(address, 512)) throw new Error(t('errors.ipc.invalidAddress'));
    return connection.plexConfirm(plexId(id), address);
  });
  handle(Channels.sessionGet, () => connection.session);
  handle(Channels.sessionPublicUsers, (_e, serverId: unknown) => connection.publicUsers(serverArg(serverId)));
  handle(Channels.sessionLogin, (_e, username: unknown, password: unknown, serverId: unknown) => {
    if (!isString(username, 256) || !isString(password ?? '', 1024)) throw new Error(t('errors.ipc.invalidCredentials'));
    return connection.login(username, (password as string) ?? '', serverArg(serverId));
  });
  handle(Channels.sessionQuickConnect, (_e, serverId: unknown) => connection.quickConnect(serverArg(serverId)));
  handle(Channels.sessionLogout, (_e, serverId: unknown) => connection.logout(serverArg(serverId)));
  handle(Channels.sessionDisconnect, async (_e, serverId: unknown) => {
    const id = serverArg(serverId);
    if (!id || playback.serverId === id) await playback.stop();
    return connection.disconnect(id);
  });

  // file sources: credentials only ever go in (no handler returns them)
  const files = deps.files;
  const sourceId = (v: unknown): string => {
    if (!isString(v, 32) || !/^[0-9a-f]{32}$/.test(v)) throw new Error(t('errors.ipc.invalidId'));
    return v;
  };
  handle(Channels.filesList, () => files.list());
  handle(Channels.filesTest, (_e, input: unknown) => files.test(input as never));
  handle(Channels.filesAdd, (_e, input: unknown) => files.add(input as never));
  handle(Channels.filesRemove, async (_e, id: unknown) => {
    const sid = sourceId(id);
    if (playback.serverId === sid) await playback.stop();
    return files.remove(sid);
  });
  handle(Channels.filesRename, (_e, id: unknown, name: unknown) => files.rename(sourceId(id), String(name ?? '')));
  handle(Channels.filesSetCredentials, (_e, id: unknown, user: unknown, pass: unknown, domain: unknown, insecure: unknown) => {
    if (!isString(user, 256) || !isString(pass, 1024) || (domain !== undefined && domain !== null && !isString(domain, 256))) throw new Error(t('errors.ipc.invalidCredentials'));
    return files.setCredentials(sourceId(id), user, pass, (domain as string | undefined) ?? undefined, insecure === true);
  });
  handle(Channels.filesTrustCert, (_e, id: unknown, sha256: unknown) => files.trustCert(sourceId(id), isString(sha256, 128) ? sha256 : ''));
  handle(Channels.filesRefresh, (_e, id: unknown) => files.refresh(sourceId(id)));
  handle(Channels.filesDiscover, () => discoverFiles());
  // Local folders come only from here (file-sources-spec D11): the path is remembered for add().
  handle(Channels.filesPickFolder, async (e) => {
    const win = senderWindow(e);
    const opts: Electron.OpenDialogOptions = { properties: ['openDirectory'] };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    const dir = r.canceled ? undefined : r.filePaths[0];
    if (!dir) return null;
    files.rememberPicked(dir);
    return dir;
  });

  // IPTV sources: addresses only ever go in (no handler returns one); local files only from the picker.
  const iptv = deps.iptv;
  handle(Channels.iptvList, () => iptv.list());
  handle(Channels.iptvAdd, (_e, input: unknown) => {
    const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    if (!isString(i.playlist, 4096) || (i.guide !== undefined && !isString(i.guide, 4096)) || (i.name !== undefined && !isString(i.name, 256))) throw new Error(t('errors.iptv.invalidPlaylist'));
    return iptv.add({ playlist: i.playlist as string, guide: i.guide as string | undefined, name: i.name as string | undefined });
  });
  handle(Channels.iptvRemove, async (_e, id: unknown) => {
    const sid = sourceId(id);
    if (playback.serverId === sid) await playback.stop();
    return iptv.remove(sid);
  });
  handle(Channels.iptvRefresh, (_e, id: unknown) => iptv.refreshNow(sourceId(id)));
  handle(Channels.iptvPickFile, async (e, kind: unknown) => {
    const win = senderWindow(e);
    const filters = kind === 'guide' ? [{ name: 'XMLTV', extensions: ['xml', 'gz'] }] : [{ name: 'M3U', extensions: ['m3u', 'm3u8'] }];
    const opts: Electron.OpenDialogOptions = { properties: ['openFile'], filters };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    const file = r.canceled ? undefined : r.filePaths[0];
    if (!file) return null;
    iptv.rememberPicked(file);
    return file;
  });

  // api proxy
  // One liveness check (and at most one sign-out) per server for a burst of parallel 401s.
  const tokenChecks = new Map<string, Promise<void>>();
  handle(Channels.apiRequest, async (_e, method: unknown, path: unknown, query: unknown, body: unknown, serverId: unknown) => {
    if (method !== 'GET' && method !== 'POST' && method !== 'DELETE' && method !== 'PUT') throw new Error(t('errors.ipc.methodRefused'));
    if (!isSafeApiPath(path)) throw new Error(t('errors.ipc.pathRefused'));
    const sid = serverArg(serverId);
    const api = connection.apiFor(sid);
    try {
      return await api.request(method, path, plainQuery(query), body);
    } catch (err) {
      // Emby answers 401 on some endpoints a non-admin user may not call;
      // sign out only when the token itself no longer works.
      const s = connection.sessionFor(sid);
      if (err instanceof ApiError && err.status === 0 && s) void connection.reportFailure(s.server.id);
      const userId = s?.user?.id;
      if (err instanceof ApiError && err.status === 401 && s?.status === 'signed-in' && userId) {
        const id = s.server.id;
        let check = tokenChecks.get(id);
        if (!check) {
          check = (async () => {
            const alive = await api.request('GET', `/Users/${userId}`).then(
              () => true,
              (e: unknown) => !(e instanceof ApiError && e.status === 401),
            );
            if (!alive && connection.sessionFor(id)?.status === 'signed-in') {
              log.warn(`token rejected by ${s.server.name}, signing out`);
              await connection.logout(id);
            } else if (alive) log.warn(`401 on ${method} ${path} (token still valid)`);
          })().finally(() => tokenChecks.delete(id));
          tokenChecks.set(id, check);
        }
        await check;
      }
      // Only the message crosses IPC: keep the status readable for the renderer (livetv/api.ts statusOf).
      if (err instanceof ApiError && err.status > 0 && !/\bHTTP \d{3}\b/.test(err.message)) throw new ApiError(`${err.message} (HTTP ${err.status})`, err.status);
      throw err;
    }
  });

  handle(Channels.apiUploadImage, (_e, itemId: unknown, type: unknown, mime: unknown, data: unknown, serverId: unknown) =>
    uploadItemImage(connection, serverArg(serverId), itemId, type, mime, data),
  );

  // playback
  handle(Channels.playbackPlay, (_e, req: unknown) => {
    if (!req || typeof req !== 'object') throw new Error(t('errors.ipc.invalidPlayRequest'));
    return playback.play(req as PlayRequest);
  });
  handle(Channels.playbackCommand, (_e, cmd: unknown) => {
    if (!cmd || typeof cmd !== 'object' || !isString((cmd as PlaybackCommand).type, 32)) throw new Error(t('errors.ipc.invalidCommand'));
    return playback.command(cmd as PlaybackCommand);
  });
  handle(Channels.playbackGetState, () => playback.getState());
  handle(Channels.playbackIdentifySong, () => playback.identifySong());
  // Live TV reminders (§9.6): toggle validates its argument.
  handle(Channels.remindersList, () => deps.reminders.list());
  handle(Channels.remindersToggle, (_e, r: unknown) => deps.reminders.toggle(r));
  handle(Channels.remindersStay, () => deps.reminders.stay());
  // Cast (cast-spec CA-04): the manager checks the target key and the start options.
  handle(Channels.castTargets, (_e, itemId: unknown, serverId: unknown) => {
    if (!isString(itemId, 64)) throw new Error(t('errors.ipc.invalidId'));
    return deps.cast.targets(itemId, serverArg(serverId));
  });
  handle(Channels.castStart, (_e, key: unknown, options: unknown) => {
    if (!isString(key, 256) || (options !== undefined && (options === null || typeof options !== 'object'))) throw new Error(t('errors.ipc.invalidId'));
    return deps.cast.start(key, options);
  });
  handle(Channels.castControl, (_e, cmd: unknown) => {
    if (!cmd || typeof cmd !== 'object' || !isString((cmd as CastCommand).type, 32)) throw new Error(t('errors.ipc.invalidCommand'));
    return deps.cast.control(cmd as CastCommand);
  });
  handle(Channels.castStop, () => deps.cast.stop());
  handle(Channels.castTakeBack, () => deps.cast.takeBack());
  handle(Channels.castGetState, () => deps.cast.state);
  // SyncPlay (Jellyfin): a group name and a group id, both short strings.
  handle(Channels.syncplayList, (_e, serverId: unknown) => deps.syncplay.list(serverArg(serverId)));
  handle(Channels.syncplayCreate, (_e, name: unknown, serverId: unknown) => {
    if (!isString(name, 100) || !name.trim()) throw new Error(t('errors.ipc.invalidCommand'));
    return deps.syncplay.create(name.trim(), serverArg(serverId));
  });
  handle(Channels.syncplayJoin, (_e, groupId: unknown, serverId: unknown) => {
    if (!isString(groupId, 64) || !/^[\w-]+$/.test(groupId)) throw new Error(t('errors.ipc.invalidId'));
    return deps.syncplay.join(groupId, serverArg(serverId));
  });
  handle(Channels.syncplayLeave, () => deps.syncplay.leave());
  handle(Channels.syncplayGet, () => deps.syncplay.current);
  ipcMain.on(Channels.htmlPlayerEvent, (event, ev: unknown) => {
    if (event.sender !== windows.main?.webContents || !ev || typeof ev !== 'object') return;
    playback.handleHtmlEvent(ev as HtmlPlayerEvent);
  });

  // downloads
  const idArg = (id: unknown) => {
    if (!isString(id, 256)) throw new Error(t('errors.ipc.invalidId'));
    return id;
  };
  handle(Channels.downloadsList, () => downloads.list());
  handle(Channels.downloadsAdd, (_e, ids: unknown, serverId: unknown) => {
    if (!Array.isArray(ids) || !ids.every((i) => isString(i, 128))) throw new Error(t('errors.ipc.invalidIds'));
    return downloads.add(ids as string[], serverArg(serverId));
  });
  handle(Channels.downloadsPause, (_e, id: unknown) => downloads.pause(idArg(id)));
  handle(Channels.downloadsResume, (_e, id: unknown) => downloads.resume(idArg(id)));
  handle(Channels.downloadsRemove, (_e, id: unknown) => downloads.remove(idArg(id)));
  handle(Channels.downloadsReveal, (_e, id: unknown) => downloads.reveal(idArg(id)));

  // vpn
  const vpnKind = (kind: unknown): VpnKind => {
    if (kind !== 'tailscale' && kind !== 'netbird' && kind !== 'embedded') throw new Error(t('errors.ipc.unknownNetwork'));
    return kind;
  };
  const vpnOptions = (o: unknown): VpnConnectOptions | undefined => {
    if (o === undefined || o === null) return undefined;
    if (typeof o !== 'object' || Array.isArray(o)) throw new Error(t('errors.ipc.invalidOptions'));
    const { provider, managementUrl, authKey } = o as Record<string, unknown>;
    const out: VpnConnectOptions = {};
    if (provider !== undefined) {
      if (provider !== 'tailscale' && provider !== 'netbird') throw new Error(t('errors.ipc.unknownNetwork'));
      out.provider = provider;
    }
    // '': back to the hosted service.
    if (managementUrl === '') out.managementUrl = '';
    else if (managementUrl !== undefined) {
      if (!isSafeManagementUrl(managementUrl)) throw new Error(t('errors.ipc.invalidManagementUrl'));
      out.managementUrl = managementUrl;
    }
    if (authKey !== undefined && authKey !== '') {
      // Never starts with "-" or "file:": it may end up next to CLI flags.
      if (!isString(authKey, 256) || !/^[A-Za-z0-9][A-Za-z0-9_-]{7,}$/.test(authKey)) throw new Error(t('errors.ipc.invalidKey'));
      out.authKey = authKey;
    }
    return out;
  };
  handle(Channels.vpnStatus, () => deps.vpn.status());
  handle(Channels.vpnConnect, (_e, kind: unknown, options: unknown) => deps.vpn.connect(vpnKind(kind), vpnOptions(options)));
  handle(Channels.vpnPeers, (_e, kind: unknown, withServers: unknown) => deps.vpn.peers(vpnKind(kind), withServers !== false));
  handle(Channels.vpnDiagnostics, async () => deps.vpn.diagnostics((await deps.appInfo()).version, process.platform));
  const embedded = () => {
    const e = deps.vpn.embeddedProvider;
    if (!(e instanceof EmbeddedMesh)) throw new Error(t('errors.ipc.embeddedUnavailable'));
    return e;
  };
  handle(Channels.vpnEmbeddedStatus, () => embedded().status());
  handle(Channels.vpnEmbeddedLogout, () => embedded().logout());
  handle(Channels.vpnEmbeddedTurnOff, () => embedded().turnOff());

  // photos: the slideshow's display wake lock, one at a time, dropped with the window.
  let awake: number | null = null;
  const sleepAgain = () => {
    if (awake !== null && powerSaveBlocker.isStarted(awake)) powerSaveBlocker.stop(awake);
    if (awake !== null) log.info('photos: slideshow wake lock off');
    awake = null;
  };
  // Immich sources (photos spec PH-12): main validates the method and path (ImmichService.request) and adds the key.
  const immichId = (v: unknown) => {
    if (!isString(v, 64) || !/^[0-9a-f]{12}$/.test(v)) throw new Error(t('errors.ipc.invalidServer'));
    return v;
  };
  handle(Channels.immichSources, () => deps.immich.list());
  handle(Channels.immichTest, (_e, url: unknown, key: unknown) => deps.immich.test(isString(url, 512) ? url : '', isString(key, 512) ? key : ''));
  handle(Channels.immichAdd, (_e, url: unknown, key: unknown) => deps.immich.add(isString(url, 512) ? url : '', isString(key, 512) ? key : ''));
  handle(Channels.immichRemove, (_e, id: unknown) => deps.immich.remove(immichId(id)));
  handle(Channels.immichRequest, (_e, id: unknown, method: unknown, path: unknown, query: unknown, body: unknown) => {
    if (!isString(method, 8) || !isSafeApiPath(path)) throw new Error(t('errors.ipc.invalidQuery'));
    return deps.immich.request(immichId(id), method, path, plainQuery(query), body === undefined || body === null ? undefined : JSON.parse(JSON.stringify(body)));
  });
  handle(Channels.immichSaveOriginal, (_e, id: unknown, assetId: unknown) => deps.immich.saveOriginal(immichId(id), isString(assetId, 64) ? assetId : ''));

  handle(Channels.photosKeepAwake, (e, on: unknown) => {
    if (on !== true) return sleepAgain();
    if (awake !== null) return;
    awake = powerSaveBlocker.start('prevent-display-sleep');
    log.info('photos: slideshow wake lock on');
    e.sender.once('destroyed', sleepAgain);
  });

  // comics
  const count = (n: unknown, max: number): n is number => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= max;
  handle(Channels.comicsOpen, (_e, id: unknown, serverId: unknown) => deps.comics.open(idArg(id), serverArg(serverId)));
  handle(Channels.comicsSaveProgress, (_e, id: unknown, page: unknown, pageCount: unknown, serverId: unknown) => {
    if (!count(pageCount, 100_000) || !count(page, pageCount - 1)) throw new Error(t('errors.ipc.invalidPage'));
    return deps.comics.saveProgress(idArg(id), page, pageCount, serverArg(serverId));
  });

  // torrents (qBittorrent)
  const torrents = deps.torrents;
  const torrentConfig = (c: unknown) => {
    const { url, username, password } = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
    if (!isString(url, 512) || !/^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/i.test(url)) throw new Error(t('errors.ipc.invalidUrlScheme'));
    if (!isString(username, 256) || (password !== undefined && !isString(password, 1024))) throw new Error(t('errors.ipc.invalidCredentials'));
    return { url: url.replace(/\/+$/, ''), username, password: password as string | undefined };
  };
  const hashes = (h: unknown): string[] => {
    if (!Array.isArray(h) || h.length === 0 || h.length > 500 || !h.every((x) => typeof x === 'string' && HASH_RE.test(x))) throw new Error(t('errors.ipc.invalidTorrent'));
    return h as string[];
  };
  const category = (c: unknown): string => {
    if (!isString(c, 200) || /[\\\n\r]/.test(c)) throw new Error(t('errors.ipc.invalidCategory'));
    return c;
  };
  const ACTIONS = new Set(['pause', 'resume', 'recheck', 'force-start', 'priority-up', 'priority-down', 'sequential', 'first-last']);
  handle(Channels.torrentsState, () => torrents.getState());
  handle(Channels.torrentsWatch, (_e, mode: unknown) => {
    if (mode === 'fg' || mode === 'bg' || mode === 'off') torrents.watch(mode);
  });
  handle(Channels.torrentsTest, (_e, c: unknown) => torrents.test(torrentConfig(c)));
  handle(Channels.torrentsConfigure, (_e, c: unknown) => torrents.configure(torrentConfig(c)));
  handle(Channels.torrentsForget, () => torrents.forget());
  handle(Channels.torrentsTrustCert, (_e, host: unknown, fingerprint: unknown) => {
    if (!isString(host, 256) || !isString(fingerprint, 256)) throw new Error(t('errors.ipc.invalidCertificate'));
    torrents.trustCertificate(host, fingerprint);
  });
  handle(Channels.torrentsAdd, (_e, req: unknown) => {
    const r = (req && typeof req === 'object' ? req : {}) as Record<string, unknown>;
    const magnets = Array.isArray(r.magnets) ? r.magnets : [];
    const files = Array.isArray(r.files) ? r.files : [];
    if (magnets.length + files.length === 0 || magnets.length > 50 || files.length > 50) throw new Error(t('errors.ipc.nothingToAdd'));
    if (!magnets.every((m) => isString(m, 8192) && MAGNET_RE.test(m))) throw new Error(t('errors.ipc.invalidMagnet'));
    let total = 0;
    for (const f of files as { name?: unknown; data?: unknown }[]) {
      if (!f || !isString(f.name, 260) || !(f.data instanceof Uint8Array) || f.data.length === 0 || f.data[0] !== 0x64) throw new Error(t('errors.ipc.invalidTorrentFile'));
      total += f.data.length;
    }
    if (total > 32 * 1024 * 1024) throw new Error(t('errors.ipc.torrentFilesTooLarge'));
    if (!isString(r.savePath ?? '', 1024)) throw new Error(t('errors.ipc.invalidFolder'));
    return torrents.add({
      magnets: magnets as string[],
      files: (files as { name: string; data: Uint8Array }[]).map((f) => ({ name: f.name, data: f.data })),
      category: category(r.category ?? ''),
      savePath: (r.savePath as string | undefined) ?? '',
      paused: r.paused === true,
      sequential: r.sequential === true,
    });
  });
  handle(Channels.torrentsAction, (_e, h: unknown, action: unknown) => {
    if (typeof action !== 'string' || !ACTIONS.has(action)) throw new Error(t('errors.ipc.unknownAction'));
    return torrents.action(hashes(h), action as Parameters<TorrentService['action']>[1]);
  });
  handle(Channels.torrentsRemove, (_e, h: unknown, deleteFiles: unknown) => torrents.remove(hashes(h), deleteFiles === true));
  handle(Channels.torrentsSetCategory, (_e, h: unknown, c: unknown) => torrents.setCategory(hashes(h), category(c)));
  handle(Channels.torrentsToggleAltSpeed, () => torrents.toggleAltSpeed());
  handle(Channels.torrentsClipboardMagnet, () => torrents.clipboardMagnet());
  handle(Channels.torrentsTakeMagnet, () => torrents.takeMagnet());

  // External ratings (the service validates the key and the path)
  handle(Channels.ratingsConfigured, () => deps.ratings.configured());
  handle(Channels.ratingsSetKey, (_e, key: unknown) => deps.ratings.setKey(isString(key, 256) ? key : 'x'));
  handle(Channels.ratingsGet, (_e, path: unknown) => deps.ratings.get(isString(path, 64) ? path : ''));
  // Music scrobbling (the service validates the token, key and secret)
  handle(Channels.scrobbleState, () => deps.scrobble.state());
  handle(Channels.scrobbleLbConnect, (_e, token: unknown) => {
    if (!isString(token, 256)) throw new Error(t('errors.scrobble.invalidToken'));
    return deps.scrobble.connectListenBrainz(token);
  });
  handle(Channels.scrobbleLbDisconnect, () => deps.scrobble.disconnectListenBrainz());
  handle(Channels.scrobbleLastfmConnect, (_e, key: unknown, secret: unknown) => {
    if (!isString(key, 256) || !isString(secret, 256)) throw new Error(t('errors.scrobble.invalidKey'));
    return deps.scrobble.connectLastfm(key, secret);
  });
  handle(Channels.scrobbleLastfmCancel, () => deps.scrobble.cancelLastfm());
  handle(Channels.scrobbleLastfmDisconnect, () => deps.scrobble.disconnectLastfm());
  // Trakt (the service validates the client id and secret)
  handle(Channels.traktState, () => deps.trakt.state());
  handle(Channels.traktConnect, (_e, id: unknown, secret: unknown) => {
    if (!isString(id, 256) || !isString(secret, 256)) throw new Error(t('errors.trakt.invalidClient'));
    return deps.trakt.connect(id, secret);
  });
  handle(Channels.traktCancel, () => deps.trakt.cancel());
  handle(Channels.traktDisconnect, () => deps.trakt.disconnect());
}
