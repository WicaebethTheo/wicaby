// The "IPTV dialect": an IPTV source answers the Emby-shaped Live TV calls the renderer's Live TV store, the guide
// and the playback service already make (as FilesClient does for file sources), from the parsed playlist and guide.
// No recording, no catch-up, no transcoding: timers answer 403 (the store then hides recording), PlaybackInfo
// direct-plays the playlist URL through mpv (live-player.ts asks stream() for the URL and its headers).
// Favourites and the Live TV display preferences are kept on this machine (state-<id>.json).
import type { Query } from '../../shared/contract';
import type { GuideProgramme } from '../../shared/iptv/guide';
import type { IptvChannel } from '../../shared/iptv/m3u';
import { genreFlags } from '../../shared/livetv/lens';
import { PF } from '../../shared/livetv/model';
import { ApiClient, ApiError, type ClientIdentity } from '../connection/api-client';
import { JsonStore } from '../core/json-store';
import { t } from '../i18n';
import type { Fetcher } from './load';

export interface IptvData {
  channels: IptvChannel[];
  guide: Map<string, GuideProgramme[]>;
  guideEnd: number | null;
  updatedAt: number;
}

interface LocalState {
  fav: string[];
  played: Record<string, number>;
  prefs: Record<string, unknown> | null;
}

type J = Record<string, unknown>;
const MAX_LOGO_BYTES = 2 * 1024 * 1024;
const LOGO_CACHE_BYTES = 32 * 1024 * 1024;
const LOGO_TIMEOUT_MS = 10_000;
const PROGRAM_ID = /^(.+)-p([0-9a-z]{1,12})$/;
const iso = (ms: number): string => new Date(ms).toISOString();
// Emby's category flags, read from the XMLTV <category> words (the shared genre table).
const FLAG_BITS: Record<string, number> = { IsMovie: PF.Movie, IsSports: PF.Sports, IsNews: PF.News, IsKids: PF.Kids, IsSeries: PF.Series, IsNewOrPremiere: 0 };
const flagCache = new WeakMap<GuideProgramme, number>();
function flagsOf(p: GuideProgramme): number {
  if (!p.categories) return 0;
  let f = flagCache.get(p);
  if (f === undefined) flagCache.set(p, (f = genreFlags(p.categories)));
  return f;
}
// The category a query asks for: undefined for none, 0 for one no IPTV programme has (Inédits).
function asked(q: Query): number | undefined {
  for (const [k, bit] of Object.entries(FLAG_BITS)) if (q[k] === true || q[k] === 'true') return bit;
  return undefined;
}

const list = (Items: unknown[], total = Items.length) => ({ Items, TotalRecordCount: total, StartIndex: 0 });

export class IptvClient extends ApiClient {
  // Least recently used first (Map order); bounded by bytes, the renderer's HTTP cache keeps its own copy.
  private logos = new Map<string, { p: Promise<{ type: string; data: Uint8Array } | null>; size: number }>();
  private logoBytes = 0;
  private byId = new Map<string, IptvChannel>();
  private seenData: IptvData | null = null;
  readonly state: JsonStore<LocalState>;

  constructor(
    readonly sourceId: string,
    private readonly name: () => string,
    // The parsed source, or null until the playlist loaded; ready() waits for the first one.
    private readonly data: () => IptvData | null,
    private readonly ready: () => Promise<void>,
    stateFile: string,
    identity: ClientIdentity,
    private readonly fetcher: Fetcher,
  ) {
    super(`wicaby-iptv://${sourceId}`, 'iptv', identity, undefined, 'local');
    this.state = new JsonStore<LocalState>(stateFile, { fav: [], played: {}, prefs: null });
    const s = this.state.value;
    if (!s || !Array.isArray(s.fav)) this.state.set({ fav: [], played: {}, prefs: null });
  }

  override get prefix(): string {
    return '';
  }

  override url(path: string, query?: Query): string {
    return `wicaby-iptv://${this.sourceId}${path}${query ? `?${new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)]))}` : ''}`;
  }

  override authHeaders(): Record<string, string> {
    return {};
  }

  override mediaAuthHeaders(): string[] {
    return [];
  }

  private async current(): Promise<IptvData> {
    let d = this.data();
    if (!d) {
      await this.ready();
      d = this.data();
    }
    if (!d) throw new ApiError(t('errors.iptv.notLoaded'), 503);
    if (d !== this.seenData) {
      this.seenData = d;
      this.byId = new Map(d.channels.map((c) => [c.id, c]));
    }
    return d;
  }

  private channel(id: string): IptvChannel | undefined {
    return this.byId.get(id);
  }

  // What mpv plays for a channel (live-player.ts): the playlist URL with its #EXTVLCOPT headers.
  stream(channelId: string): { url: string; headers: string[]; isHls: boolean } | null {
    const c = this.channel(channelId);
    if (!c) return null;
    const headers: string[] = [];
    // Header values go to mpv as one comma-joined option: a comma or a line break would split or inject a header.
    const clean = (v: string) => v.replace(/[\r\n,]/g, ' ').trim();
    if (c.userAgent) headers.push(`User-Agent: ${clean(c.userAgent)}`);
    if (c.referrer) headers.push(`Referer: ${clean(c.referrer)}`);
    return { url: c.url, headers, isHls: /\.m3u8?(?:$|[?#])/i.test(c.url) };
  }

  private channelDto(c: IptvChannel, d: IptvData, withCurrent = false): J {
    const st = this.state.value;
    const dto: J = {
      Id: c.id,
      Name: c.name,
      Type: 'TvChannel',
      ChannelType: c.radio ? 'Radio' : 'TV',
      MediaType: c.radio ? 'Audio' : 'Video',
      ChannelNumber: c.number,
      Number: c.number,
      ServerId: this.sourceId,
      Tags: c.group ? [c.group] : [],
      ImageTags: c.logo ? { Primary: logoTag(c.logo) } : {},
      UserData: { IsFavorite: st.fav.includes(c.id), ...(st.played[c.id] ? { LastPlayedDate: iso(st.played[c.id]) } : {}) },
    };
    if (withCurrent) {
      const now = Date.now();
      const p = (d.guide.get(c.id) ?? []).find((x) => x.start <= now && x.stop > now);
      if (p) dto.CurrentProgram = this.programDto(c, p);
    }
    return dto;
  }

  private programDto(c: IptvChannel, p: GuideProgramme): J {
    const dto: J = {
      Id: `${c.id}-p${Math.floor(p.start / 60_000).toString(36)}`,
      Name: p.title || c.name,
      Type: 'Program',
      ServerId: this.sourceId,
      ChannelId: c.id,
      ChannelName: c.name,
      StartDate: iso(p.start),
      EndDate: iso(p.stop),
      RunTimeTicks: (p.stop - p.start) * 10_000,
    };
    if (p.subTitle) dto.EpisodeTitle = p.subTitle;
    if (p.desc) dto.Overview = p.desc;
    if (p.categories) dto.Genres = p.categories;
    const f = flagsOf(p);
    for (const [k, bit] of Object.entries(FLAG_BITS)) if (bit && f & bit) dto[k] = true;
    if (c.logo) dto.ChannelPrimaryImageTag = logoTag(c.logo);
    return dto;
  }

  private programById(id: string, d: IptvData): J | null {
    const m = PROGRAM_ID.exec(id);
    const c = m ? this.channel(m[1]) : undefined;
    if (!m || !c) return null;
    const start = parseInt(m[2], 36) * 60_000;
    const p = (d.guide.get(c.id) ?? []).find((x) => Math.floor(x.start / 60_000) * 60_000 === start);
    return p ? this.programDto(c, p) : null;
  }

  private programs(q: Query, d: IptvData): J {
    const cat = asked(q);
    if (cat === 0) return list([]);
    const date = (k: string): number => {
      const v = q[k];
      const t = typeof v === 'string' ? Date.parse(v) : NaN;
      return Number.isFinite(t) ? t : NaN;
    };
    const minEnd = date('MinEndDate');
    const maxStart = date('MaxStartDate');
    const minStart = date('MinStartDate');
    const ids = typeof q.ChannelIds === 'string' && q.ChannelIds ? q.ChannelIds.split(',') : d.channels.map((c) => c.id);
    const term = typeof q.SearchTerm === 'string' ? fold(q.SearchTerm) : '';
    const limit = Math.min(Number(q.Limit) || 5000, 5000);
    const out: J[] = [];
    for (const id of ids) {
      const c = this.channel(id);
      if (!c) continue;
      for (const p of d.guide.get(id) ?? []) {
        if (p.stop <= minEnd || p.start > maxStart || p.start < minStart) continue;
        if (term && !fold(p.title).includes(term)) continue;
        if (cat && !(flagsOf(p) & cat)) continue;
        out.push(this.programDto(c, p));
      }
    }
    out.sort((a, b) => String(a.StartDate).localeCompare(String(b.StartDate)));
    return list(out.slice(0, limit), out.length);
  }

  private airing(q: Query, d: IptvData): J {
    const cat = asked(q);
    if (cat === 0) return list([]);
    const now = Date.now();
    const out: J[] = [];
    for (const c of d.channels) {
      const p = (d.guide.get(c.id) ?? []).find((x) => x.start <= now && x.stop > now);
      if (p && (!cat || flagsOf(p) & cat)) out.push(this.programDto(c, p));
    }
    return list(out.slice(0, Math.min(Number(q.Limit) || 24, 500)), out.length);
  }

  private setFavorite(id: string, on: boolean): J {
    if (!this.channel(id)) throw new ApiError('Not found', 404);
    this.state.update((s) => {
      s.fav = on ? [...s.fav.filter((x) => x !== id), id] : s.fav.filter((x) => x !== id);
    });
    return { IsFavorite: on };
  }

  override async request<T>(method: string, path: string, query?: Query, body?: unknown): Promise<T> {
    const q = query ?? {};
    let m: RegExpExecArray | null = null;
    const is = (verb: string, re: RegExp) => method === verb && (m = re.exec(path)) !== null;
    const arg = (i: number): string => decodeURIComponent((m as RegExpExecArray)[i]);
    // Never a recording: the store reads the 403 as "this user cannot record" and hides it.
    if (/^\/LiveTv\/(Timers|SeriesTimers|Recordings|AvailableRecordingOptions)/.test(path) || path.startsWith('/LiveStreams/')) throw new ApiError('IPTV: no recording', 403);
    if (is('POST', /^\/Sessions\/(Playing|Playing\/Progress|Playing\/Stopped)$/)) {
      const id = (body as J | undefined)?.ItemId;
      if (path === '/Sessions/Playing' && typeof id === 'string' && this.channel(id)) this.state.update((s) => void (s.played[id] = Date.now()));
      return undefined as T;
    }
    if (is('GET', /^\/DisplayPreferences\/wicaby-livetv$/)) {
      // Emby answers an empty document for one never saved.
      return (this.state.value.prefs ?? { Id: 'wicaby-livetv', Client: 'wicaby', CustomPrefs: {} }) as T;
    }
    if (is('POST', /^\/DisplayPreferences\/wicaby-livetv$/)) {
      // Bounded: the store writes a few KB; anything bigger is refused rather than stored.
      if (!body || typeof body !== 'object' || JSON.stringify(body).length > 256 * 1024) throw new ApiError('Bad request', 400);
      this.state.update((s) => void (s.prefs = body as J));
      return undefined as T;
    }
    if (is('GET', /^\/Users\/[^/]+\/Views$/)) return list([]) as T;
    // The player and the OSD look items up by ids (channels only; nothing else lives here).
    if (is('GET', /^\/Users\/[^/]+\/Items$/) || is('GET', /^\/Items$/)) {
      const ids = typeof q.Ids === 'string' ? q.Ids.split(',') : [];
      const d0 = await this.current();
      return list(ids.map((id) => this.channel(id)).filter((c): c is IptvChannel => !!c).map((c) => this.channelDto(c, d0, true))) as T;
    }
    if (is('GET', /^\/LiveTv\/Info$/)) return { IsEnabled: true, EnabledUsers: [], Services: [{ Name: this.name(), Status: 'Ok', Tuners: [] }] } as T;
    const d = await this.current();
    if (is('GET', /^\/LiveTv\/GuideInfo$/)) return { StartDate: iso(Date.now()), EndDate: iso(d.guideEnd ?? Date.now()) } as T;
    if (is('GET', /^\/LiveTv\/ChannelTags$/)) {
      const tags = [...new Set(d.channels.map((c) => c.group).filter((g): g is string => !!g))];
      return list(tags.map((Name) => ({ Name, Id: Name }))) as T;
    }
    if (is('GET', /^\/LiveTv\/Channels$/)) {
      // A category: the channels with at least one programme of it in the guide.
      const cat = asked(q);
      if (cat !== undefined) return list(cat ? d.channels.filter((c) => (d.guide.get(c.id) ?? []).some((p) => flagsOf(p) & cat)).map((c) => ({ Id: c.id, Name: c.name })) : []) as T;
      const start = Math.max(0, Number(q.StartIndex) || 0);
      const limit = Math.min(Math.max(1, Number(q.Limit) || 5000), 5000);
      const page = d.channels.slice(start, start + limit).map((c) => this.channelDto(c, d, q.AddCurrentProgram === true || q.AddCurrentProgram === 'true'));
      return { Items: page, TotalRecordCount: d.channels.length, StartIndex: start } as T;
    }
    if (is('GET', /^\/LiveTv\/Channels\/([^/]+)$/)) {
      const c = this.channel(arg(1));
      if (!c) throw new ApiError('Not found', 404);
      return this.channelDto(c, d, true) as T;
    }
    if (is('GET', /^\/LiveTv\/Programs\/Recommended$/)) return this.airing(q, d) as T;
    if (is('GET', /^\/LiveTv\/Programs$/)) return this.programs(q, d) as T;
    if (is('GET', /^\/LiveTv\/Programs\/([^/]+)$/) || is('GET', /^\/Users\/[^/]+\/Items\/([^/]+)$/) || is('GET', /^\/Items\/([^/]+)$/)) {
      const id = arg(1);
      const c = this.channel(id);
      const item = c ? this.channelDto(c, d, true) : this.programById(id, d);
      if (!item) throw new ApiError('Not found', 404);
      return item as T;
    }
    if (is('POST', /^\/Users\/[^/]+\/FavoriteItems\/([^/]+)$/)) return this.setFavorite(arg(1), true) as T;
    if (is('DELETE', /^\/Users\/[^/]+\/FavoriteItems\/([^/]+)$/)) return this.setFavorite(arg(1), false) as T;
    if (is('POST', /^\/Items\/([^/]+)\/PlaybackInfo$/)) {
      const c = this.channel(arg(1));
      if (!c) throw new ApiError('Not found', 404);
      const s = this.stream(c.id);
      return {
        PlaySessionId: `iptv${Date.now().toString(36)}`,
        MediaSources: [
          {
            Id: c.id,
            Name: c.name,
            Protocol: 'Http',
            Container: s?.isHls ? 'hls' : 'ts',
            IsRemote: true,
            IsInfiniteStream: true,
            SupportsDirectPlay: true,
            SupportsDirectStream: false,
            SupportsTranscoding: false,
            RequiresOpening: false,
            // An M3U doesn't list tracks: leave them unknown (undefined = has video), not [] (= audio only, the radio screen).
            ...(c.radio ? { MediaStreams: [] } : {}),
          },
        ],
      } as T;
    }
    throw new ApiError(`IPTV-UNMAPPED ${method} ${path.split('?')[0]}`, 404);
  }

  // wicaby-media://api/<source>/… : channel logos, and the JSON calls the renderer's Live TV store makes.
  async media(apiPath: string, method: string, query: URLSearchParams): Promise<Response> {
    const cors = { 'Access-Control-Allow-Origin': '*' };
    const m = /^\/Items\/([^/]+)\/Images\/Primary(?:\/0)?$/.exec(apiPath);
    if (m) {
      await this.current().catch(() => undefined);
      const c = this.channel(decodeURIComponent(m[1]));
      const logo = c?.logo ? await this.logo(c.logo) : null;
      if (!logo) return new Response('Not found', { status: 404, headers: cors });
      return new Response(logo.data as BodyInit, { headers: { 'Content-Type': logo.type, 'Cache-Control': 'private, max-age=86400', 'X-Content-Type-Options': 'nosniff', ...cors } });
    }
    if (method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors });
    try {
      const q: Query = Object.fromEntries(query);
      const data = await this.request<unknown>('GET', apiPath, q);
      return new Response(JSON.stringify(data ?? null), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Date: new Date().toUTCString(), ...cors } });
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 500;
      return new Response(err instanceof Error ? err.message.slice(0, 200) : 'error', { status, headers: cors });
    }
  }

  // A logo: data: URIs decoded, http(s) fetched once (capped, images only), both cached (LOGO_CACHE_BYTES, 2000 entries).
  private logo(src: string): Promise<{ type: string; data: Uint8Array } | null> {
    const hit = this.logos.get(src);
    if (hit) {
      this.logos.delete(src);
      this.logos.set(src, hit);
      return hit.p;
    }
    const e = { p: fetchLogo(src, this.fetcher).catch(() => null), size: 0 };
    this.logos.set(src, e);
    this.trimLogos();
    void e.p.then((v) => {
      if (this.logos.get(src) !== e) return;
      e.size = v?.data.length ?? 0;
      this.logoBytes += e.size;
      this.trimLogos();
    });
    return e.p;
  }

  private trimLogos(): void {
    for (const [k, old] of this.logos) {
      if (this.logos.size <= 1 || (this.logoBytes <= LOGO_CACHE_BYTES && this.logos.size <= 2000)) break;
      this.logos.delete(k);
      this.logoBytes -= old.size;
    }
  }
}

const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon|avif|bmp)$/i;

async function fetchLogo(src: string, fetcher: Fetcher): Promise<{ type: string; data: Uint8Array } | null> {
  const d = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(src);
  if (d) {
    if (!IMAGE_TYPES.test(d[1]) || d[2].length > (MAX_LOGO_BYTES * 4) / 3) return null;
    return { type: d[1].toLowerCase(), data: new Uint8Array(Buffer.from(d[2], 'base64')) };
  }
  if (!/^https?:\/\//i.test(src)) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), LOGO_TIMEOUT_MS);
  try {
    const res = await fetcher(src, { signal: ctl.signal, headers: { Accept: 'image/*' } });
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim();
    if (!res.ok || !res.body || !IMAGE_TYPES.test(type) || Number(res.headers.get('content-length')) > MAX_LOGO_BYTES) {
      void res.body?.cancel().catch(() => undefined);
      return null;
    }
    const reader = res.body.getReader();
    const parts: Uint8Array[] = [];
    let n = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      n += value.length;
      if (n > MAX_LOGO_BYTES) {
        void reader.cancel().catch(() => undefined);
        return null;
      }
      parts.push(value);
    }
    return { type: type.toLowerCase(), data: new Uint8Array(Buffer.concat(parts)) };
  } finally {
    clearTimeout(timer);
  }
}

// The logo URL changes → the tag changes → the renderer's image cache misses.
function logoTag(src: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < src.length; i++) h = Math.imul(h ^ src.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}

const fold = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
