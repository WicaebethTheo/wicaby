// Reactive mirrors of main-process state. Main is the source of truth; these
// objects are updated from its push events.
import type { DesktopThemeState, DownloadEntry, HtmlPlayerLoad, PlaybackState, ServerSession, SessionState, Settings, Toast } from '../../shared/contract';
import type { BaseItem } from '../../shared/models';
import { musicViews } from '../../shared/music-source';
import { isLocalSource } from '../../shared/server-caps';
import { w } from './bridge';
import { setLanguage } from './i18n.svelte';

export const session = $state<{ value: SessionState; ready: boolean }>({ value: { status: 'no-server', sessions: [] }, ready: false });
export const settings = $state<{ value: Settings | null }>({ value: null });
export const playback = $state<{ value: PlaybackState | null }>({ value: null });
export const downloads = $state<{ list: DownloadEntry[] }>({ list: [] });
// Views of every signed-in server, primary first; each carries its ServerId.
// all: every signed-in server's views; list: the same with the music source applied (shared/music-source.ts).
export const libraries = $state<{ list: BaseItem[]; all: BaseItem[] }>({ list: [], all: [] });
function applyMusicSource(): void {
  libraries.list = musicViews(libraries.all, settings.value?.music.source ?? '');
}
// Live TV is offered only when a server has a tuner/guide set up for this user (servers: their ids).
export const liveTv = $state({ available: false, servers: [] as string[] });

// Signed-in servers, primary first. Reactive when read in a template or a $derived. File sources are not
// servers (their own section, fileSessions()); fanOut() adds them to Home when the setting asks. Nor are IPTV
// sources (iptvSessions()).
export function onlineSessions(): ServerSession[] {
  return session.value.sessions.filter((s) => s.status === 'signed-in' && !isLocalSource(s.server.kind));
}

// IPTV sources (main/iptv): the IPTV sidebar group, one Live TV store each.
export function iptvSessions(): ServerSession[] {
  return session.value.sessions.filter((s) => s.server.kind === 'iptv');
}

// File sources (file-sources-spec): every one, online or not. Photo sources are listed apart (photoSessions).
export function fileSessions(): ServerSession[] {
  return session.value.sessions.filter((s) => s.server.kind === 'files' && !s.server.files?.photos);
}

// Photo sources on files (Settings > Photo sources): a photo library each, like an Immich source.
export function photoSessions(): ServerSession[] {
  return session.value.sessions.filter((s) => s.server.kind === 'files' && s.server.files?.photos === true);
}

export function isFileSource(serverId?: string): boolean {
  return Boolean(serverId) && sessionFor(serverId)?.server.kind === 'files';
}

// More than one server signed in: the UI then names servers where it matters.
export function multiServer(): boolean {
  return onlineSessions().length > 1;
}

export function sessionFor(serverId?: string): ServerSession | undefined {
  return serverId ? session.value.sessions.find((s) => s.server.id === serverId) : session.value.sessions[0];
}

export function serverName(serverId?: string): string {
  return sessionFor(serverId)?.server.name ?? '';
}

// Last load request for the <video> player. Buffered here because it arrives
// before the /player route has mounted.
export const htmlPlayer = $state<{ load: HtmlPlayerLoad | null; seq: number }>({ load: null, seq: 0 });

export interface ToastItem extends Toast {
  id: number;
  action?: { label: string; run: () => void };
}
export const toasts = $state<{ list: ToastItem[] }>({ list: [] });
let toastId = 0;
// Expiry timers by toast id; undefined while held under the pointer or focus (progress toasts have none).
const toastTimers = new Map<number, ReturnType<typeof setTimeout> | undefined>();

function expire(id: number, ms: number): void {
  toastTimers.set(
    id,
    setTimeout(() => {
      toastTimers.delete(id);
      toasts.list = toasts.list.filter((t) => t.id !== id);
    }, ms),
  );
}

export function toast(kind: Toast['kind'], message: string, action?: ToastItem['action'], ms?: number): void {
  const id = ++toastId;
  toasts.list.push({ id, kind, message, action });
  expire(id, ms ?? (kind === 'error' ? 6000 : 3500));
}

// A toast under the pointer or focus stays up (reaching for Undo), then leaves shortly after it is let go.
export function holdToast(id: number): void {
  if (!toastTimers.has(id)) return;
  clearTimeout(toastTimers.get(id));
  toastTimers.set(id, undefined);
}

export function dropToast(id: number): void {
  clearTimeout(toastTimers.get(id));
  toastTimers.delete(id);
  toasts.list = toasts.list.filter((t) => t.id !== id);
}

export function releaseToast(id: number): void {
  if (toastTimers.has(id) && toastTimers.get(id) === undefined) expire(id, 2000);
}

// A toast that stays up while a long task runs: update() rewrites it, done() swaps it for a normal toast.
export function progressToast(message: string): { update: (message: string) => void; done: (kind: Toast['kind'], message: string) => void } {
  const id = ++toastId;
  toasts.list.push({ id, kind: 'info', message });
  return {
    update: (m) => {
      const x = toasts.list.find((x) => x.id === id);
      if (x) x.message = m;
    },
    done: (kind, m) => {
      toasts.list = toasts.list.filter((x) => x.id !== id);
      toast(kind, m);
    },
  };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Bumped on server UserDataChanged / LibraryChanged so pages can refetch.
export const dataVersion = $state({ userData: 0, library: 0 });

// The 'hyprland' theme's palette, from main (desktop-theme-linux.ts); unavailable on Windows and without Hyprland.
export const desktopTheme = $state<DesktopThemeState>({ available: false, palette: null });

// The accent comes from the desktop theme: the accent picker is locked (AccentSwatches).
export function desktopAccent(): boolean {
  return settings.value?.ui.theme === 'hyprland' && desktopTheme.available;
}

// 'system' follows Windows (main sets nativeTheme.themeSource, so this query tracks it). The OSD stays dark:
// it floats over video.
const lightQuery = matchMedia('(prefers-color-scheme: light)');
// Properties the 'hyprland' palette set inline on :root (they outrank tokens.css), removed when leaving it.
let inlineTokens: string[] = [];
function applyTheme(): void {
  const theme = settings.value?.ui.theme ?? 'graphite';
  const root = document.documentElement;
  const osd = root.classList.contains('osd');
  const palette = theme === 'hyprland' && !osd ? desktopTheme.palette : null;
  // 'hyprland' with no palette (Omarchy or Hyprland gone since it was chosen): Graphite, the setting is kept.
  root.dataset.theme = osd ? 'graphite' : theme === 'system' ? (lightQuery.matches ? 'light' : 'graphite') : theme === 'hyprland' && !palette ? 'graphite' : theme;
  for (const k of inlineTokens) root.style.removeProperty(k);
  inlineTokens = [];
  if (palette) {
    // Reduce transparency's opaque materials (app.css) would lose to inline ones: leave those to it.
    const opaque = settings.value?.ui.reduceTransparency === true;
    inlineTokens = Object.keys(palette.tokens).filter((k) => k.startsWith('--') && !(opaque && k.startsWith('--material')));
    for (const k of inlineTokens) root.style.setProperty(k, palette.tokens[k]);
    root.style.setProperty('color-scheme', palette.mode);
    inlineTokens.push('color-scheme');
    // A light palette: light-theme shadows and dark media surfaces (app.css).
    root.dataset.scheme = palette.mode;
  } else delete root.dataset.scheme;
}
lightQuery.addEventListener('change', applyTheme);

function applyDesktopTheme(d: DesktopThemeState): void {
  desktopTheme.available = d.available;
  desktopTheme.palette = d.palette;
  applyTheme();
}

function applySettings(s: Settings): void {
  const source = settings.value?.music.source;
  settings.value = s;
  if (source !== undefined && source !== s.music.source) applyMusicSource();
  setLanguage(s.ui.language);
  const root = document.documentElement;
  applyTheme();
  root.dataset.accent = s.ui.accent;
  root.toggleAttribute('data-reduce-transparency', s.ui.reduceTransparency);
  if (s.ui.reduceMotion) root.dataset.reduceMotion = '1';
  else delete root.dataset.reduceMotion;
  // Density and poster size drive every card grid and shelf through two CSS variables (app.css).
  root.dataset.density = s.ui.density;
  root.style.setProperty('--card-scale', String((s.ui.posterSize / 100) * (s.ui.density === 'compact' ? 0.88 : 1)));
  root.toggleAttribute('data-hide-card-titles', !s.ui.cardTitles);
}

async function serverViews(s: ServerSession): Promise<{ views: BaseItem[]; live: boolean; failed?: boolean }> {
  const uid = s.user!.id;
  const sid = s.server.id;
  // Jellyfin 10.9+ moved the per-user route to /UserViews (see userRoute in api.ts).
  const views = await (s.server.kind === 'jellyfin'
    ? w.api.get<{ Items: BaseItem[] }>('/UserViews', { userId: uid }, sid)
    : w.api.get<{ Items: BaseItem[] }>(`/Users/${uid}/Views`, undefined, sid)
  ).then(
    (r) => r.Items ?? [],
    () => null,
  );
  if (!views) return { views: [], live: false, failed: true };
  for (const v of views) v.ServerId = sid;
  // The Live TV view can be hidden from "My media"; /LiveTv/Info still knows.
  const live =
    views.some((l) => l.CollectionType === 'livetv') ||
    (await w.api
      .get<{ IsEnabled?: boolean; EnabledUsers?: string[] }>('/LiveTv/Info', undefined, sid)
      .then((i) => Boolean(i.IsEnabled) && (!i.EnabledUsers?.length || i.EnabledUsers.includes(uid)))
      .catch(() => false));
  return { views, live };
}

// Session changes fire for every server's state; only a different set of signed-in users reloads.
let librariesKey = '';
async function loadLibraries(): Promise<void> {
  const list = onlineSessions();
  const key = list.map((s) => `${s.server.id}/${s.user?.id}`).join();
  if (key === librariesKey) return;
  librariesKey = key;
  const results = await Promise.all(list.map(serverViews));
  if (key !== librariesKey) return;
  libraries.all = results.flatMap((r) => r.views);
  applyMusicSource();
  liveTv.servers = list.filter((_, i) => results[i].live).map((s) => s.server.id);
  liveTv.available = liveTv.servers.length > 0;
  // A failed server is asked again on the next session change instead of staying without libraries.
  if (results.some((r) => r.failed)) librariesKey = '';
}

// Servers whose socket dropped or that went offline: their data may have changed meanwhile.
const dropped = new Set<string>();

export async function initStores(): Promise<void> {
  w.session.onChange((s) => {
    session.value = s;
    let back = false;
    for (const x of s.sessions) {
      if (x.status === 'offline' || x.socket === 'down') dropped.add(x.server.id);
      else if (x.status === 'signed-in' && x.socket === 'open' && dropped.delete(x.server.id)) back = true;
    }
    // Reconnected: libraries and every page reading dataVersion load again.
    if (back) {
      librariesKey = '';
      dataVersion.userData++;
      dataVersion.library++;
    }
    void loadLibraries();
  });
  w.settings.onChange(applySettings);
  w.desktopTheme.onChange(applyDesktopTheme);
  w.playback.onState((s) => {
    const was = playback.value;
    playback.value = s;
    // A file source has no server socket to report UserDataChanged: its progress changed when playback ended.
    if (was?.active && (!s.active || s.item?.id !== was.item?.id) && isFileSource(was.item?.serverId)) dataVersion.userData++;
  });
  w.downloads.onChange((d) => {
    downloads.list = d;
  });
  w.events.onToast((t) => void toast(t.kind, t.message, undefined, t.ms));
  w.htmlPlayer.onLoad((load) => {
    htmlPlayer.load = load;
    htmlPlayer.seq++;
  });
  w.events.onServerEvent((ev) => {
    if (ev.type === 'UserDataChanged') dataVersion.userData++;
    else if (ev.type === 'LibraryChanged') dataVersion.library++;
  });

  const [s, st, pb, dl, dt] = await Promise.all([w.session.get(), w.settings.get(), w.playback.getState(), w.downloads.list(), w.desktopTheme.get()]);
  session.value = s;
  applyDesktopTheme(dt);
  applySettings(st);
  playback.value = pb;
  downloads.list = dl;
  session.ready = true;
  void loadLibraries();
}

export async function updateSettings(patch: Parameters<typeof w.settings.update>[0]): Promise<void> {
  // Patches are often built from settings.value ($state): its proxies cannot cross the bridge.
  applySettings(await w.settings.update($state.snapshot(patch) as typeof patch));
}
