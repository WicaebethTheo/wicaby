// IPTV sources: the stored list (names and hosts only), their playlist and guide addresses in the credential vault
// (an Xtream address carries the account's user and password), one IptvClient session each in the
// ConnectionManager, and the parsed playlist and guide cached encrypted in userData/iptv (the stream URLs carry the
// same credentials). Refreshed on demand and when older than 12 h. Logs name a source by its id and host only.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IptvSourceInfo, IptvSourceInput, ServerInfo } from '../../shared/contract';
import type { GuideProgramme } from '../../shared/iptv/guide';
import { isWebUrl, type Playlist } from '../../shared/iptv/m3u';
import type { ApiClient, ClientIdentity } from '../connection/api-client';
import { JsonStore } from '../core/json-store';
import { logger } from '../core/log';
import type { CredentialVault } from '../core/vault';
import { t } from '../i18n';
import { IptvClient, type IptvData } from './iptv-client';
import { hostOf, IptvLoadError, isLocalPath, loadGuide, loadPlaylist, type Fetcher } from './load';

const log = logger.scope('iptv');

export const REFRESH_MS = 12 * 3_600_000;
const CHECK_MS = 30 * 60_000;
const VAULT_PREFIX = 'iptv:';
const ID = /^[0-9a-f]{32}$/;
const short = (id: string) => id.slice(0, 6);

interface StoredSource {
  id: string;
  name: string;
  display: string;
  guide?: string;
  addedAt: number;
}

interface CacheDoc {
  v: 1;
  updatedAt: number;
  guideAt: number;
  guideEnd: number | null;
  playlist: Playlist;
  guide: [string, GuideProgramme[]][];
}

export interface IptvHost {
  putLocal(info: ServerInfo, client: ApiClient, status: 'signed-in' | 'offline'): void;
  dropLocal(id: string): void;
}

interface Live {
  client: IptvClient;
  data: IptvData | null;
  playlist: Playlist | null;
  state: IptvSourceInfo['state'];
  guideError: boolean;
  guideAt: number;
  refreshing: Promise<void> | null;
  firstLoad: Promise<void>;
  loaded: () => void;
}

export class IptvSources {
  private store: JsonStore<{ v: 1; sources: StoredSource[] }>;
  private live = new Map<string, Live>();
  private picked = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly dir: string,
    private readonly vault: CredentialVault,
    private readonly identity: ClientIdentity,
    private readonly host: IptvHost,
    private readonly fetcher: Fetcher,
    // A server event for the renderer's Live TV store of that source (LibraryChanged, ScheduledTaskEnded).
    private readonly event: (serverId: string, type: string, data?: unknown) => void,
  ) {
    fs.mkdirSync(dir, { recursive: true });
    this.store = new JsonStore(path.join(dir, 'sources.json'), { v: 1, sources: [] });
    const doc = this.store.value;
    if (!doc || !Array.isArray(doc.sources)) this.store.set({ v: 1, sources: [] });
    else doc.sources = doc.sources.filter((s) => s && ID.test(s.id) && typeof s.name === 'string');
  }

  start(): void {
    for (const s of this.store.value.sources) this.attach(s);
    this.timer = setInterval(() => this.refreshStale(), CHECK_MS);
    this.timer.unref?.();
  }

  shutdown(): void {
    if (this.timer) clearInterval(this.timer);
    for (const l of this.live.values()) l.client.state.flush();
  }

  list(): IptvSourceInfo[] {
    return this.store.value.sources.map((s) => this.info(s));
  }

  rememberPicked(p: string): void {
    this.picked.add(path.resolve(p));
  }

  private info(s: StoredSource): IptvSourceInfo {
    const l = this.live.get(s.id);
    let programmes = 0;
    for (const v of l?.data?.guide.values() ?? []) programmes += v.length;
    return {
      id: s.id,
      name: s.name,
      display: s.display,
      ...(s.guide ? { guide: s.guide } : {}),
      channels: l?.data?.channels.length ?? 0,
      programmes,
      updatedAt: l?.data?.updatedAt ?? 0,
      state: l?.state ?? 'error',
      ...(l?.guideError ? { guideError: true } : {}),
    };
  }

  private serverInfo(s: StoredSource): ServerInfo {
    return { id: s.id, name: s.name, kind: 'iptv', version: '', hasToken: true };
  }

  private secret(id: string): { playlist: string; guide: string } | null {
    const c = this.vault.get(VAULT_PREFIX + id);
    return c?.token ? { playlist: c.token, guide: c.userName } : null;
  }

  // pl: the playlist add() just loaded (its guide loads now); else the cache, then a refresh when stale.
  private attach(s: StoredSource, pl?: Playlist): void {
    let loaded!: () => void;
    const firstLoad = new Promise<void>((r) => (loaded = r));
    const l: Live = {
      client: null as unknown as IptvClient,
      data: null,
      playlist: null,
      state: 'loading',
      guideError: false,
      guideAt: 0,
      refreshing: null,
      firstLoad,
      loaded,
    };
    l.client = new IptvClient(
      s.id,
      () => s.name,
      () => l.data,
      // A request before the first load waits for it, at most 25 s (the renderer's channel deadline is 20 s).
      () => Promise.race([l.firstLoad, new Promise<void>((r) => setTimeout(r, 25_000))]),
      path.join(this.dir, `state-${s.id}.json`),
      this.identity,
      this.fetcher,
    );
    this.live.set(s.id, l);
    this.host.putLocal(this.serverInfo(s), l.client, 'signed-in');
    if (pl) {
      this.ready(l, pl);
      l.refreshing = this.guide(s.id, l).finally(() => (l.refreshing = null));
      return;
    }
    void this.readCache(s.id, l).then(() => {
      if (!l.data || Date.now() - l.data.updatedAt > REFRESH_MS) void this.refresh(s.id).catch(() => undefined);
    });
  }

  private ready(l: Live, pl: Playlist): void {
    l.playlist = pl;
    l.data = { channels: pl.channels, guide: l.data?.guide ?? new Map(), guideEnd: l.data?.guideEnd ?? null, updatedAt: Date.now() };
    l.state = 'ready';
    l.loaded();
  }

  private cacheFile(id: string): string {
    return path.join(this.dir, `cache-${id}.bin`);
  }

  private async readCache(id: string, l: Live): Promise<void> {
    try {
      const blob = await fs.promises.readFile(this.cacheFile(id));
      const text = await this.vault.unseal(blob);
      if (!text) return;
      const doc = JSON.parse(text) as CacheDoc;
      if (doc?.v !== 1 || !Array.isArray(doc.playlist?.channels)) return;
      l.playlist = doc.playlist;
      l.data = { channels: doc.playlist.channels, guide: new Map(doc.guide), guideEnd: doc.guideEnd, updatedAt: doc.updatedAt };
      l.guideAt = doc.guideAt;
      l.state = 'ready';
      l.loaded();
    } catch {
      // No cache yet, or unreadable: the refresh rebuilds it.
    }
  }

  // A source removed meanwhile (a refresh still in flight) is not brought back: no events, no cache file.
  private gone(id: string, l: Live): boolean {
    return this.live.get(id) !== l;
  }

  private async writeCache(id: string, l: Live): Promise<void> {
    if (!l.data || !l.playlist || this.gone(id, l)) return;
    const doc: CacheDoc = { v: 1, updatedAt: l.data.updatedAt, guideAt: l.guideAt, guideEnd: l.data.guideEnd, playlist: l.playlist, guide: [...l.data.guide] };
    const blob = await this.vault.seal(JSON.stringify(doc));
    // Nothing can encrypt here: no cache on disk (the source reloads at the next start).
    if (!blob) return void fs.promises.rm(this.cacheFile(id), { force: true }).catch(() => undefined);
    const tmp = `${this.cacheFile(id)}.tmp`;
    await fs.promises.writeFile(tmp, blob);
    await fs.promises.rename(tmp, this.cacheFile(id));
    // Removed while it was written: the playlist's stream URLs carry the account, nothing stays behind.
    if (this.gone(id, l)) await fs.promises.rm(this.cacheFile(id), { force: true });
  }

  // The playlist, then the guide (the channels show as soon as the playlist is parsed).
  refresh(id: string): Promise<void> {
    const l = this.live.get(id);
    const s = this.store.value.sources.find((x) => x.id === id);
    const sec = this.secret(id);
    if (!l || !s || !sec) return Promise.reject(new Error(t('errors.iptv.notFound')));
    if (l.refreshing) return l.refreshing;
    l.refreshing = (async () => {
      const started = Date.now();
      try {
        const pl = await loadPlaylist(sec.playlist, this.fetcher);
        if (this.gone(id, l)) return;
        this.ready(l, pl);
        log.info(`source ${short(id)} (${s.display}): ${pl.channels.length} channels, ${pl.skipped} lines skipped, ${Date.now() - started} ms`);
        this.event(id, 'LibraryChanged');
      } catch (err) {
        log.warn(`source ${short(id)} (${s.display}) playlist failed: ${describe(err)}`);
        if (!l.data) l.state = 'error';
        l.loaded();
        throw new Error(loadMessage(err, sec.playlist));
      }
      await this.guide(id, l);
    })().finally(() => (l.refreshing = null));
    return l.refreshing;
  }

  // The guide (the form's, else the playlist's url-tvg), then the encrypted cache.
  private async guide(id: string, l: Live): Promise<void> {
    const sec = this.secret(id);
    const guideSrc = sec && l.playlist ? sec.guide || l.playlist.guides[0] : '';
    if (guideSrc && l.playlist && l.data) {
      const at = Date.now();
      try {
        const g = await loadGuide(guideSrc, l.playlist, this.fetcher);
        if (this.gone(id, l)) return;
        l.data = { ...l.data, guide: g.programmes, guideEnd: g.end };
        l.guideAt = Date.now();
        l.guideError = false;
        log.info(`source ${short(id)} guide (${hostOf(guideSrc)}): ${g.count} programmes kept, ${g.skipped} skipped, ${Date.now() - at} ms`);
        this.event(id, 'ScheduledTaskEnded', { Key: 'RefreshGuide' });
      } catch (err) {
        l.guideError = true;
        log.warn(`source ${short(id)} guide (${hostOf(guideSrc)}) failed: ${describe(err)}`);
      }
    }
    await this.writeCache(id, l).catch((err) => log.warn(`source ${short(id)} cache not written: ${describe(err)}`));
  }


  private refreshStale(): void {
    for (const [id, l] of this.live) if (!l.refreshing && (!l.data || Date.now() - l.data.updatedAt > REFRESH_MS)) void this.refresh(id).catch(() => undefined);
  }

  async refreshNow(id: string): Promise<IptvSourceInfo> {
    await this.refresh(id);
    const s = this.store.value.sources.find((x) => x.id === id);
    if (!s) throw new Error(t('errors.iptv.notFound'));
    return this.info(s);
  }

  // A web address, or a file the OS picker returned this run. Anything else is refused.
  private address(v: unknown): string | null {
    if (typeof v !== 'string') return null;
    const s = v.trim();
    if (!s || s.length > 4096) return null;
    if (isWebUrl(s)) return s;
    if (isLocalPath(s) && this.picked.has(path.resolve(s))) return path.resolve(s);
    return null;
  }

  async add(input: IptvSourceInput): Promise<IptvSourceInfo> {
    if (!input || typeof input !== 'object') throw new Error(t('errors.iptv.invalidPlaylist'));
    const playlist = this.address(input.playlist);
    if (!playlist) throw new Error(t('errors.iptv.invalidPlaylist'));
    const guideRaw = typeof input.guide === 'string' ? input.guide.trim() : '';
    const guide = guideRaw ? this.address(guideRaw) : '';
    if (guide === null) throw new Error(t('errors.iptv.invalidGuide'));
    // The playlist must load before anything is stored.
    let pl: Playlist;
    try {
      pl = await loadPlaylist(playlist, this.fetcher);
    } catch (err) {
      log.info(`new source (${hostOf(playlist)}) refused: ${describe(err)}`);
      throw new Error(loadMessage(err, playlist));
    }
    const id = randomBytes(16).toString('hex');
    const name = (typeof input.name === 'string' ? input.name.trim().slice(0, 80) : '') || hostOf(playlist) || 'IPTV';
    const s: StoredSource = { id, name, display: hostOf(playlist), ...(guide || pl.guides[0] ? { guide: hostOf(guide || pl.guides[0]) } : {}), addedAt: Date.now() };
    await this.vault.set(VAULT_PREFIX + id, { userId: '', userName: guide, token: playlist });
    this.store.update((d) => void d.sources.push(s));
    this.attach(s, pl);
    log.info(`source ${short(id)} added (${s.display}, ${pl.channels.length} channels)`);
    return this.info(s);
  }

  async remove(id: string): Promise<void> {
    const l = this.live.get(id);
    l?.client.state.flush();
    this.live.delete(id);
    this.host.dropLocal(id);
    this.store.update((d) => {
      d.sources = d.sources.filter((s) => s.id !== id);
    });
    await this.vault.delete(VAULT_PREFIX + id);
    for (const f of [this.cacheFile(id), path.join(this.dir, `state-${id}.json`)]) await fs.promises.rm(f, { force: true }).catch(() => undefined);
  }
}

function describe(err: unknown): string {
  return err instanceof IptvLoadError ? `${err.code}${err.status ? ` ${err.status}` : ''}` : err instanceof Error ? err.name : 'error';
}

function loadMessage(err: unknown, src: string): string {
  const msg = loadReason(err);
  // mafreebox.freebox.fr resolves anywhere but only serves the list from behind the box itself.
  const offLan = hostOf(src) === 'mafreebox.freebox.fr' && (!(err instanceof IptvLoadError) || ['http', 'timeout', 'unreachable'].includes(err.code));
  return offLan ? `${msg}. ${t('errors.iptv.freeboxLan')}` : msg;
}

function loadReason(err: unknown): string {
  if (!(err instanceof IptvLoadError)) return t('errors.iptv.unreachable');
  switch (err.code) {
    case 'http':
      return t('errors.iptv.http', { status: err.status });
    case 'tooBig':
      return t('errors.iptv.tooBig');
    case 'timeout':
      return t('errors.iptv.timeout');
    case 'empty':
      return t('errors.iptv.empty');
    case 'unsupported':
      return t('errors.iptv.unsupported');
    case 'invalid':
      return t('errors.iptv.invalidPlaylist');
    default:
      return t('errors.iptv.unreachable');
  }
}
