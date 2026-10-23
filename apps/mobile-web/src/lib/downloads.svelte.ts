// Downloads (Emby's offline downloads, the Android app's Downloads): a film or an episode kept on the phone, its
// original file as the server would direct play it, with the title and the PlaybackInfo it was fetched with. The
// files live in the app's Cache Storage (persisted when Safari grants it), the list in localStorage.
// - The player reads a downloaded title from the phone, online or not (platform/remux-player: localMedia).
// - Offline, the API answers for a downloaded title from what was kept (its page, PlaybackInfo); its progress
//   reports are kept and sent to the server once it answers again.
// Safari has no background download: a file comes down while the app is open, one at a time, in order.
import type { BaseItem, MediaSource } from '$shared/models';
import { Api, ApiError, type PlaybackInfo } from '$tv/api';
import { apiOf } from '$tv/session.svelte';
import { load, save } from '$tv/storage';
import { caps } from '../platform/caps';
import { deviceProfile } from './device-profile';

const CACHE = 'wicaby-downloads';
const KEY = 'downloads';

export type DownloadStatus = 'queued' | 'downloading' | 'done' | 'failed';

export interface Download {
  id: string;
  serverId: string;
  item: BaseItem;
  info?: PlaybackInfo;
  status: DownloadStatus;
  received: number;
  size: number;
  error?: string;
  added: string;
  // A position played offline, for the server once it answers again.
  pending?: { ticks: number; played: boolean };
}

const kept = load<Download[]>(KEY, []);
// A download cut by the app closing starts over (Cache Storage cannot append to a file).
for (const d of kept) if (d.status === 'downloading') d.status = 'queued';
export const downloads = $state<{ list: Download[] }>({ list: kept });

let lastSave = 0;
function persist(force = false): void {
  const now = Date.now();
  if (!force && now - lastSave < 2000) return;
  lastSave = now;
  save(KEY, $state.snapshot(downloads.list));
}

const fileUrl = (d: Pick<Download, 'serverId' | 'id'>, part: 'media' | 'poster') => `https://offline.wicaby.invalid/${d.serverId}/${d.id}/${part}`;
const find = (id: string) => downloads.list.find((d) => d.id === id);

export const downloadOf = (id: string): Download | undefined => find(id);
export const canDownload = (item: BaseItem): boolean => ['Movie', 'Episode', 'Video', 'MusicVideo'].includes(item.Type ?? '') && item.MediaType === 'Video';

// ---- Queue ----

const controllers = new Map<string, AbortController>();
let running = false;

export function download(item: BaseItem): void {
  if (find(item.Id)) return;
  downloads.list.unshift({ id: item.Id, serverId: item.ServerId ?? '', item, status: 'queued', received: 0, size: 0, added: new Date().toISOString() });
  persist(true);
  void navigator.storage?.persist?.().catch(() => false);
  void pump();
}

export function retry(id: string): void {
  const d = find(id);
  if (!d || d.status !== 'failed') return;
  d.status = 'queued';
  d.error = undefined;
  persist(true);
  void pump();
}

export async function remove(id: string): Promise<void> {
  controllers.get(id)?.abort();
  const d = find(id);
  if (!d) return;
  downloads.list = downloads.list.filter((x) => x !== d);
  persist(true);
  const c = await caches.open(CACHE);
  await Promise.all([c.delete(fileUrl(d, 'media')), c.delete(fileUrl(d, 'poster'))]);
}

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const next = [...downloads.list].reverse().find((d) => d.status === 'queued');
      if (!next) break;
      await fetchOne(next);
    }
  } finally {
    running = false;
  }
}

// The server's answer for direct play with this phone's profile: what the player would stream, as is.
async function fetchOne(d: Download): Promise<void> {
  const api = apiOf(d.serverId);
  const ctl = new AbortController();
  controllers.set(d.id, ctl);
  d.status = 'downloading';
  d.received = 0;
  try {
    if (!api) throw new Error('not signed in');
    const item = await api.item(d.id);
    const body = { DeviceProfile: deviceProfile(await caps(), api.kind, 200_000_000), UserId: api.userId, MaxStreamingBitrate: 200_000_000, IsPlayback: false, EnableDirectPlay: true, EnableDirectStream: false, EnableTranscoding: false };
    const info = await api.playbackInfo(d.id, { UserId: api.userId, MaxStreamingBitrate: 200_000_000 }, body);
    const ps: MediaSource | undefined = info.MediaSources?.[0];
    const url = ps?.SupportsDirectPlay ? api.streamUrl(item, ps.Id, info.PlaySessionId) : null;
    if (!url) throw new Error('conversion');
    d.item = item;
    d.info = { ...info, MediaSources: [ps!] };
    d.size = ps!.Size ?? 0;

    const poster = api.poster(item, 600) ?? api.thumb(item, 600);
    const c = await caches.open(CACHE);
    if (poster) await fetch(poster, { signal: ctl.signal }).then((r) => (r.ok ? c.put(fileUrl(d, 'poster'), r) : undefined)).catch(() => {});

    const res = await fetch(url, { signal: ctl.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    d.size = Number(res.headers.get('content-length')) || d.size;
    let got = 0;
    let shown = 0;
    const count = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, out) {
        got += chunk.length;
        // The bar moves by whole tenths of a percent: no re-render per chunk.
        if (got - shown > Math.max(1 << 20, d.size / 1000)) {
          shown = got;
          d.received = got;
          persist();
        }
        out.enqueue(chunk);
      },
    });
    const headers = { 'Content-Type': res.headers.get('content-type') ?? 'video/x-matroska', 'Content-Length': String(d.size) };
    await c.put(fileUrl(d, 'media'), new Response(res.body.pipeThrough(count), { headers }));
    d.received = got;
    d.size = got;
    d.status = 'done';
  } catch (e) {
    if (!find(d.id)) return;
    d.status = 'failed';
    d.error = ctl.signal.aborted ? undefined : e instanceof Error && e.message === 'conversion' ? 'conversion' : e instanceof Error && /quota/i.test(e.name + e.message) ? 'quota' : 'network';
  } finally {
    controllers.delete(d.id);
    persist(true);
  }
}

// ---- Reading back ----

export async function posterOf(d: Download): Promise<string | undefined> {
  const hit = await caches.open(CACHE).then((c) => c.match(fileUrl(d, 'poster')));
  return hit ? URL.createObjectURL(await hit.blob()) : undefined;
}

// The downloaded file behind a stream URL of the server (/Videos/{id}/stream…), when there is one.
export async function localMedia(url: string): Promise<Blob | null> {
  const id = /[?&]static=true/i.test(url) ? /\/Videos\/([^/]+)\//i.exec(url)?.[1] : undefined;
  const d = id ? find(id) : undefined;
  if (d?.status !== 'done') return null;
  const hit = await caches.open(CACHE).then((c) => c.match(fileUrl(d, 'media')));
  return hit ? hit.blob() : null;
}

export async function usage(): Promise<{ used: number; free: number } | null> {
  const e = await navigator.storage?.estimate?.().catch(() => null);
  return e?.quota ? { used: e.usage ?? 0, free: Math.max(0, e.quota - (e.usage ?? 0)) } : null;
}

// ---- Offline answers ----

// What the API returns offline for a downloaded title; undefined when it has nothing to say.
function offline(method: string, path: string, body: unknown): { value: unknown } | undefined {
  let m = /^\/(?:Users\/[^/]+\/)?Items\/([^/?]+)$/.exec(path);
  if (method === 'GET' && m) {
    const d = find(m[1]);
    return d?.status === 'done' ? { value: d.item } : undefined;
  }
  m = /^\/Items\/([^/]+)\/PlaybackInfo$/.exec(path);
  if (method === 'POST' && m) {
    const d = find(m[1]);
    return d?.status === 'done' && d.info ? { value: d.info } : undefined;
  }
  // Progress reports: the position is kept for the server.
  if (method === 'POST' && /^\/Sessions\/Playing/.test(path)) {
    const r = body as { ItemId?: string; PositionTicks?: number } | undefined;
    const d = r?.ItemId ? find(r.ItemId) : undefined;
    if (d && typeof r?.PositionTicks === 'number') {
      const runtime = d.item.RunTimeTicks ?? 0;
      const played = runtime > 0 && r.PositionTicks / runtime > 0.9;
      d.pending = { ticks: played ? 0 : r.PositionTicks, played };
      d.item = { ...d.item, UserData: { ...d.item.UserData, PlaybackPositionTicks: d.pending.ticks, Played: played } };
      persist(true);
    }
    return { value: undefined };
  }
  if (method === 'GET' && /\/(NextUp|Episodes|Similar|SpecialFeatures|LocalTrailers|Segments|Intros)\b/.test(path)) return { value: { Items: [] } };
  return undefined;
}

let request: Api['request'] | undefined;

// Run once at start (App.svelte), after every module is in: the offline answers, the queue, the pending positions.
export function startDownloads(): void {
  if (request !== undefined) return;
  request = Api.prototype.request;
  Api.prototype.request = offlineRequest;
  window.addEventListener('online', () => void flush());
  void flush();
  void pump();
}

const offlineRequest = async function <T>(this: Api, method: string, path: string, query?: Parameters<Api['request']>[2], body?: unknown): Promise<T> {
  if (!navigator.onLine) {
    const hit = offline(method, path, body);
    if (hit) return hit.value as T;
  }
  try {
    return (await request!.call(this, method, path, query, body)) as T;
  } catch (e) {
    const hit = e instanceof ApiError && e.status === 0 ? offline(method, path, body) : undefined;
    if (hit) return hit.value as T;
    throw e;
  }
} as Api['request'];

// Positions played offline, sent once the server answers again.
async function flush(): Promise<void> {
  for (const d of downloads.list) {
    const p = d.pending;
    const api = p ? apiOf(d.serverId) : null;
    if (!p || !api) continue;
    const path = api.isEmby ? `/Users/${api.userId}/Items/${d.id}/UserData` : `/UserItems/${d.id}/UserData`;
    try {
      await request!.call(api, 'POST', path, api.isEmby ? undefined : { userId: api.userId }, { PlaybackPositionTicks: p.ticks, Played: p.played });
      d.pending = undefined;
      persist(true);
    } catch {
      return;
    }
  }
}

