import { contextBridge, ipcRenderer, sharedTexture, type IpcRendererEvent } from 'electron';
import { Channels, type Query, type SyncPlayGroup, type WicabyBridge } from '../shared/contract';

// Strips Electron's "Error invoking remote method 'x': Error: " wrapper so the
// UI can show the main-process message as is.
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(message.replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, ''));
  }
}

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

// SyncPlay: current() answers synchronously from the last group main announced.
let syncGroup: SyncPlayGroup | null = null;
on<SyncPlayGroup | null>(Channels.syncplayChanged, (g) => (syncGroup = g));
void invoke<SyncPlayGroup | null>(Channels.syncplayGet).then((g) => (syncGroup = g), () => undefined);

const bridge: WicabyBridge = {
  app: {
    info: () => invoke(Channels.appInfo),
    quit: () => invoke(Channels.appQuit),
    openExternal: (url) => invoke(Channels.appOpenExternal, url),
    openPath: (kind) => invoke(Channels.appOpenPath, kind),
    log: (level, message) => ipcRenderer.send(Channels.appLog, level, String(message).slice(0, 8000)),
    storage: () => invoke(Channels.appStorage),
    clearStorage: (kind) => invoke(Channels.appClearStorage, kind),
  },
  updates: {
    state: () => invoke(Channels.updatesState),
    check: () => invoke(Channels.updatesCheck),
    open: (target) => invoke(Channels.updatesOpen, target),
    dismiss: () => invoke(Channels.updatesDismiss),
    onState: (cb) => on(Channels.updatesChanged, cb),
  },
  desktopTheme: {
    get: () => invoke(Channels.desktopThemeGet),
    onChange: (cb) => on(Channels.desktopThemeChanged, cb),
  },
  window: {
    minimize: () => invoke(Channels.windowMinimize),
    toggleMaximize: () => invoke(Channels.windowToggleMaximize),
    close: () => invoke(Channels.windowClose),
    toggleFullscreen: () => invoke(Channels.windowToggleFullscreen),
    getState: () => invoke(Channels.windowGetState),
    onState: (cb) => on(Channels.windowState, cb),
    mini: (action) => invoke(Channels.windowMini, action),
  },
  settings: {
    get: () => invoke(Channels.settingsGet),
    update: (patch) => invoke(Channels.settingsUpdate, patch),
    pickFolder: () => invoke(Channels.settingsPickFolder),
    pickMpv: () => invoke(Channels.settingsPickMpv),
    onChange: (cb) => on(Channels.settingsChanged, cb),
    audioDevices: () => invoke(Channels.settingsAudioDevices),
    exportFile: () => invoke(Channels.settingsExport),
    importFile: () => invoke(Channels.settingsImport),
    reset: () => invoke(Channels.settingsReset),
  },
  servers: {
    discover: () => invoke(Channels.serversDiscover),
    list: () => invoke(Channels.serversList),
    add: (address) => invoke(Channels.serversAdd, address),
    embyConnect: (username, password) => invoke(Channels.serversEmbyConnect, username, password),
    select: (id) => invoke(Channels.serversSelect, id),
    remove: (id) => invoke(Channels.serversRemove, id),
    wake: (id) => invoke(Channels.serversWake, id),
    plexLink: () => invoke(Channels.serversPlexLink),
    plexPoll: () => invoke(Channels.serversPlexPoll),
    plexAccounts: () => invoke(Channels.serversPlexAccounts),
    plexUnlink: (accountId) => invoke(Channels.serversPlexUnlink, accountId),
    plexSetHidden: (id, hidden) => invoke(Channels.serversPlexSetHidden, id, hidden),
    plexConfirm: (id, address) => invoke(Channels.serversPlexConfirm, id, address),
  },
  session: {
    get: () => invoke(Channels.sessionGet),
    publicUsers: (serverId) => invoke(Channels.sessionPublicUsers, serverId),
    login: (username, password, serverId) => invoke(Channels.sessionLogin, username, password, serverId),
    quickConnect: (serverId) => invoke(Channels.sessionQuickConnect, serverId),
    logout: (serverId) => invoke(Channels.sessionLogout, serverId),
    disconnect: (serverId) => invoke(Channels.sessionDisconnect, serverId),
    onChange: (cb) => on(Channels.sessionChanged, cb),
  },
  api: {
    get: <T>(path: string, query?: Query, serverId?: string) => invoke<T>(Channels.apiRequest, 'GET', path, query, undefined, serverId),
    post: <T>(path: string, query?: Query, body?: unknown, serverId?: string) => invoke<T>(Channels.apiRequest, 'POST', path, query, body, serverId),
    del: <T>(path: string, query?: Query, serverId?: string) => invoke<T>(Channels.apiRequest, 'DELETE', path, query, undefined, serverId),
    put: <T>(path: string, query?: Query, body?: unknown, serverId?: string) => invoke<T>(Channels.apiRequest, 'PUT', path, query, body, serverId),
    uploadImage: (itemId, type, mime, data, serverId) => invoke(Channels.apiUploadImage, itemId, type, mime, data, serverId),
  },
  files: {
    list: () => invoke(Channels.filesList),
    test: (input) => invoke(Channels.filesTest, input),
    add: (input) => invoke(Channels.filesAdd, input),
    remove: (id) => invoke(Channels.filesRemove, id),
    rename: (id, name) => invoke(Channels.filesRename, id, name),
    setCredentials: (id, user, pass, domain, insecure) => invoke(Channels.filesSetCredentials, id, user, pass, domain, insecure),
    trustCert: (id, sha256) => invoke(Channels.filesTrustCert, id, sha256),
    discover: () => invoke(Channels.filesDiscover),
    pickFolder: () => invoke(Channels.filesPickFolder),
    refresh: (id) => invoke(Channels.filesRefresh, id),
  },
  iptv: {
    list: () => invoke(Channels.iptvList),
    add: (input) => invoke(Channels.iptvAdd, input),
    remove: (id) => invoke(Channels.iptvRemove, id),
    refresh: (id) => invoke(Channels.iptvRefresh, id),
    pickFile: (kind) => invoke(Channels.iptvPickFile, kind),
  },
  playback: {
    play: (request) => invoke(Channels.playbackPlay, request),
    command: (command) => invoke(Channels.playbackCommand, command),
    getState: () => invoke(Channels.playbackGetState),
    onState: (cb) => on(Channels.playbackState, cb),
    identifySong: () => invoke(Channels.playbackIdentifySong),
  },
  music: {
    lrclib: (track) => invoke(Channels.musicLrclib, track),
  },
  htmlPlayer: {
    onLoad: (cb) => on(Channels.htmlPlayerLoad, cb),
    onCommand: (cb) => on(Channels.htmlPlayerCommand, cb),
    emit: (event) => ipcRenderer.send(Channels.htmlPlayerEvent, event),
  },
  downloads: {
    list: () => invoke(Channels.downloadsList),
    add: (itemIds, serverId) => invoke(Channels.downloadsAdd, itemIds, serverId),
    pause: (id) => invoke(Channels.downloadsPause, id),
    resume: (id) => invoke(Channels.downloadsResume, id),
    remove: (id) => invoke(Channels.downloadsRemove, id),
    reveal: (id) => invoke(Channels.downloadsReveal, id),
    onChange: (cb) => on(Channels.downloadsChanged, cb),
  },
  photos: {
    keepAwake: (on) => invoke(Channels.photosKeepAwake, on),
    immich: {
      sources: () => invoke(Channels.immichSources),
      onSources: (cb) => on(Channels.immichChanged, cb),
      test: (url, key) => invoke(Channels.immichTest, url, key),
      add: (url, key) => invoke(Channels.immichAdd, url, key),
      remove: (id) => invoke(Channels.immichRemove, id),
      request: (id, method, path, query, body) => invoke(Channels.immichRequest, id, method, path, query, body),
      saveOriginal: (id, assetId) => invoke(Channels.immichSaveOriginal, id, assetId),
    },
  },
  comics: {
    open: (itemId, serverId) => invoke(Channels.comicsOpen, itemId, serverId),
    saveProgress: (itemId, page, pageCount, serverId) => invoke(Channels.comicsSaveProgress, itemId, page, pageCount, serverId),
  },
  vpn: {
    status: () => invoke(Channels.vpnStatus),
    connect: (kind, options) => invoke(Channels.vpnConnect, kind, options),
    peers: (kind, withServers) => invoke(Channels.vpnPeers, kind, withServers),
    diagnostics: () => invoke(Channels.vpnDiagnostics),
    embedded: {
      status: () => invoke(Channels.vpnEmbeddedStatus),
      logout: () => invoke(Channels.vpnEmbeddedLogout),
      turnOff: () => invoke(Channels.vpnEmbeddedTurnOff),
      onChange: (cb) => on(Channels.vpnEmbeddedChanged, cb),
    },
  },
  torrents: {
    state: () => invoke(Channels.torrentsState),
    onState: (cb) => on(Channels.torrentsChanged, cb),
    watch: (mode) => invoke(Channels.torrentsWatch, mode),
    test: (config) => invoke(Channels.torrentsTest, config),
    configure: (config) => invoke(Channels.torrentsConfigure, config),
    forget: () => invoke(Channels.torrentsForget),
    trustCertificate: (host, fingerprint) => invoke(Channels.torrentsTrustCert, host, fingerprint),
    add: (request) => invoke(Channels.torrentsAdd, request),
    action: (hashes, action) => invoke(Channels.torrentsAction, hashes, action),
    remove: (hashes, deleteFiles) => invoke(Channels.torrentsRemove, hashes, deleteFiles),
    setCategory: (hashes, category) => invoke(Channels.torrentsSetCategory, hashes, category),
    toggleAltSpeed: () => invoke(Channels.torrentsToggleAltSpeed),
    clipboardMagnet: () => invoke(Channels.torrentsClipboardMagnet),
    takeMagnet: () => invoke(Channels.torrentsTakeMagnet),
    onMagnet: (cb) => on(Channels.torrentsMagnet, () => cb()),
  },
  ratings: {
    configured: () => invoke(Channels.ratingsConfigured),
    setKey: (key) => invoke(Channels.ratingsSetKey, key),
    get: (path) => invoke(Channels.ratingsGet, path),
  },
  scrobble: {
    state: () => invoke(Channels.scrobbleState),
    onState: (cb) => on(Channels.scrobbleChanged, cb),
    connectListenBrainz: (token) => invoke(Channels.scrobbleLbConnect, token),
    disconnectListenBrainz: () => invoke(Channels.scrobbleLbDisconnect),
    connectLastfm: (apiKey, secret) => invoke(Channels.scrobbleLastfmConnect, apiKey, secret),
    cancelLastfm: () => invoke(Channels.scrobbleLastfmCancel),
    disconnectLastfm: () => invoke(Channels.scrobbleLastfmDisconnect),
  },
  trakt: {
    state: () => invoke(Channels.traktState),
    onState: (cb) => on(Channels.traktChanged, cb),
    connect: (clientId, clientSecret) => invoke(Channels.traktConnect, clientId, clientSecret),
    cancel: () => invoke(Channels.traktCancel),
    disconnect: () => invoke(Channels.traktDisconnect),
  },
  reminders: {
    list: () => invoke(Channels.remindersList),
    toggle: (r) => invoke(Channels.remindersToggle, r),
    stay: () => invoke(Channels.remindersStay),
    onCountdown: (cb) => on(Channels.remindersCountdown, cb),
  },
  cast: {
    targets: (itemId, serverId) => invoke(Channels.castTargets, itemId, serverId),
    onTargets: (cb) => on(Channels.castTargetsUpdated, cb),
    start: (targetKey, options) => invoke(Channels.castStart, targetKey, options),
    control: (command) => invoke(Channels.castControl, command),
    stop: () => invoke(Channels.castStop),
    takeBack: () => invoke(Channels.castTakeBack),
    getState: () => invoke(Channels.castGetState),
    onState: (cb) => on(Channels.castState, cb),
  },
  syncplay: {
    list: (serverId) => invoke(Channels.syncplayList, serverId),
    create: (name, serverId) => invoke(Channels.syncplayCreate, name, serverId),
    join: (groupId, serverId) => invoke(Channels.syncplayJoin, groupId, serverId),
    leave: () => invoke(Channels.syncplayLeave),
    current: () => syncGroup,
    onChange: (cb) => on(Channels.syncplayChanged, cb),
  },
  events: {
    onServerEvent: (cb) => on(Channels.serverEvent, cb),
    onNavigate: (cb) => on(Channels.navigate, cb),
    onToast: (cb) => on(Channels.toast, cb),
  },
};

contextBridge.exposeInMainWorld('wicaby', bridge);

// Linux texture mode (video-surface.ts): main sends each libmpv frame as a shared texture and it is drawn
// here, in the isolated world, onto the OSD page's #wicaby-video canvas; the VideoFrame never reaches page
// script. mpv already rendered at the window's device-pixel size (letterbox included), so the backing store
// takes each frame's own size and CSS scales it to the window (object-fit: contain). A canvas is cleared whenever
// its size is set, so it is resized only when a frame of another size arrives, never by layout: during a resize
// or a fullscreen/PiP transition the last picture stays up until the ring follows. Releasing the texture is
// what hands the slot back to libmpv (after the GPU is done with it), so it happens on every path.
if (new URLSearchParams(location.search).get('video') === '1') {
  let canvas: HTMLCanvasElement | null = null;
  let ctx: CanvasRenderingContext2D | null = null;
  let reported = false;
  // The canvas mounts after this script runs and may be replaced, so it is looked up on each frame.
  const target = (): CanvasRenderingContext2D | null => {
    const el = document.getElementById('wicaby-video');
    if (!(el instanceof HTMLCanvasElement)) return null;
    if (el !== canvas) {
      canvas = el;
      ctx = el.getContext('2d', { alpha: false });
    }
    return ctx;
  };
  sharedTexture.setSharedTextureReceiver(async ({ importedSharedTexture }) => {
    let frame: VideoFrame | null = null;
    try {
      frame = importedSharedTexture.getVideoFrame();
      const c = target();
      if (!c) return;
      const { displayWidth: width, displayHeight: height } = frame;
      if (c.canvas.width !== width) c.canvas.width = width;
      if (c.canvas.height !== height) c.canvas.height = height;
      c.drawImage(frame, 0, 0);
    } catch (err) {
      // Once per page: a lost GPU context or a failed import fails every frame alike.
      if (!reported) console.error('wicaby: video frame not drawn', err);
      reported = true;
    } finally {
      frame?.close();
      importedSharedTexture.release();
    }
  });
}
