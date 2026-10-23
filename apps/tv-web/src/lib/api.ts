// Emby / Jellyfin HTTP client: the browser counterpart of the desktop's main/connection/api-client.ts and of the
// Android core Emby.kt. One instance per signed-in server and user.
import type { MediaSegment } from '$shared/markers';
import type { AuthenticationResult, BaseItem, ItemsResult, MediaSource, SystemInfoPublic, UserDto } from '$shared/models';
import { addressFailed, addressInUse } from './addresses.svelte';
import { CLIENT, VERSION, deviceId, deviceName } from './identity';

export type ServerKind = 'emby' | 'jellyfin';
export type Query = Record<string, string | number | boolean | undefined | null>;

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const TIMEOUT_MS = 20_000;

// Told of every 401 with a token: the signed-in shell (Main) sends the user back to sign-in when the token is its own
// (revoked from the server's dashboard, the password changed).
export const unauthorized: { handler: ((api: Api) => void) | null } = { handler: null };

function quote(value: string): string {
  return `"${encodeURIComponent(value)}"`;
}

export function buildQuery(query?: Query): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const k of Object.keys(query)) {
    const v = query[k];
    if (v !== undefined && v !== null && v !== '') parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

// fetch() with a timeout. Engines before Chromium 66 ignore AbortSignal, so the request also races the timer.
async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  let timer = 0;
  const timeout = new Promise<never>((_, reject) => {
    timer = window.setTimeout(() => {
      controller.abort();
      reject(new ApiError('timeout', 0));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fetch(url, { ...init, signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export class Api {
  // The server's id (System/Info Id), once known: what items carry as ServerId.
  serverId?: string;

  constructor(
    readonly address: string,
    readonly kind: ServerKind,
    public token?: string,
    public userId?: string,
  ) {}

  private get prefix(): string {
    return this.kind === 'emby' ? '/emby' : '';
  }

  // B09: the address requests go to now (local or remote, lib/addresses); `address` stays the server's identity.
  get base(): string {
    return addressInUse(this.serverId, this.address);
  }

  url(path: string, query?: Query): string {
    return `${this.base}${this.prefix}${path}${buildQuery(query)}`;
  }

  authHeaders(): Record<string, string> {
    const parts = [`Client=${quote(CLIENT)}`, `Device=${quote(deviceName())}`, `DeviceId=${quote(deviceId)}`, `Version=${quote(VERSION)}`];
    if (this.kind === 'emby') {
      if (this.userId) parts.unshift(`UserId=${quote(this.userId)}`);
      const headers: Record<string, string> = { 'X-Emby-Authorization': `Emby ${parts.join(', ')}` };
      if (this.token) headers['X-Emby-Token'] = this.token;
      return headers;
    }
    if (this.token) parts.push(`Token=${quote(this.token)}`);
    return { Authorization: `MediaBrowser ${parts.join(', ')}` };
  }

  async request<T>(method: string, path: string, query?: Query, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json', ...this.authHeaders() };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res: Response;
    try {
      res = await fetchWithTimeout(this.url(path, query), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }, TIMEOUT_MS);
    } catch (e) {
      // Could not connect: the server's other address may answer (B09).
      addressFailed(this.serverId, this.address, this.isEmby);
      throw e instanceof ApiError ? e : new ApiError(e instanceof Error ? e.message : String(e), 0);
    }
    if (res.status === 401 && this.token) unauthorized.handler?.(this);
    if (!res.ok) throw new ApiError((await res.text().catch(() => '')).slice(0, 300) || `HTTP ${res.status}`, res.status);
    if (res.status === 204) return undefined as T;
    const type = res.headers.get('content-type') ?? '';
    return (type.includes('json') ? await res.json() : await res.text()) as T;
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>('GET', path, query);
  }

  post<T>(path: string, body?: unknown, query?: Query): Promise<T> {
    return this.request<T>('POST', path, query, body ?? {});
  }

  del<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>('DELETE', path, query);
  }

  // --- Sign-in ---

  publicUsers(): Promise<UserDto[]> {
    return this.get('/Users/Public');
  }

  // The signed-in user: their avatar tag (PrimaryImageTag), which the session does not keep.
  me(): Promise<UserDto> {
    return this.get(`/Users/${this.userId}`);
  }

  async signIn(username: string, password: string): Promise<AuthenticationResult> {
    const r = await this.post<AuthenticationResult>('/Users/AuthenticateByName', { Username: username, Pw: password });
    this.token = r.AccessToken;
    this.userId = r.User.Id;
    return r;
  }

  // --- Quick Connect (Jellyfin, core Emby.kt): sign in by approving a code on a device already signed in ---

  async quickConnectEnabled(): Promise<boolean> {
    if (this.isEmby) return false;
    return (await this.get<boolean>('/QuickConnect/Enabled').catch(() => false)) === true;
  }

  // Shows each code through [onCode] and polls until it is approved; an expired code (Connect 404s) gets a fresh
  // one. [stopped] ends the wait (the sheet closed): it then rejects.
  async quickConnect(onCode: (code: string) => void, stopped: () => boolean, everyMs = 5000): Promise<AuthenticationResult> {
    type Qc = { Code: string; Secret: string; Authenticated?: boolean };
    const wait = () => new Promise((r) => setTimeout(r, everyMs));
    for (;;) {
      // Jellyfin 10.8 only answers GET here (10.9+ only POST).
      const init = await this.post<Qc>('/QuickConnect/Initiate').catch((e) => {
        if (e instanceof ApiError && (e.status === 405 || e.status === 404)) return this.get<Qc>('/QuickConnect/Initiate');
        throw e;
      });
      onCode(init.Code);
      for (;;) {
        await wait();
        if (stopped()) throw new ApiError('cancelled', 0);
        let s: Qc;
        try {
          s = await this.get<Qc>('/QuickConnect/Connect', { secret: init.Secret });
        } catch (e) {
          if (e instanceof ApiError && e.status === 404) break;
          throw e;
        }
        if (s.Authenticated) {
          const r = await this.post<AuthenticationResult>('/Users/AuthenticateWithQuickConnect', { Secret: init.Secret });
          this.token = r.AccessToken;
          this.userId = r.User.Id;
          return r;
        }
      }
    }
  }

  // The other side: approves [code] shown by another device, for this signed-in user.
  authorizeQuickConnect(code: string): Promise<void> {
    return this.request('POST', '/QuickConnect/Authorize', { code: code.trim() });
  }

  // --- Browsing: the Android Emby.kt calls, same routes and queries ---

  get isEmby(): boolean {
    return this.kind === 'emby';
  }

  // Emby 4.8+ leaves a list's UserData without LastPlayedDate (and PlayCount) unless asked by name: Continue
  // watching's order and "watched lately" depend on it.
  get listFields(): string {
    return this.isEmby ? `${LIST_FIELDS},PremiereDate,${EMBY_PLAY_FIELDS}` : LIST_FIELDS;
  }

  // The fields that bring a user's play dates (UserData on Jellyfin).
  get playFields(): string {
    return this.isEmby ? EMBY_PLAY_FIELDS : 'UserData';
  }

  // Jellyfin 10.9 moved several per-user routes; older Jellyfin only has the old ones.
  private async jellyfinOrLegacy<T>(modern: () => Promise<T>, legacy: () => Promise<T>): Promise<T> {
    try {
      return await modern();
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 405)) return legacy();
      throw e;
    }
  }

  async views(): Promise<BaseItem[]> {
    const r = this.isEmby
      ? await this.get<ItemsResult>(`/Users/${this.userId}/Views`)
      : await this.jellyfinOrLegacy(() => this.get<ItemsResult>('/UserViews', { userId: this.userId }), () => this.get<ItemsResult>(`/Users/${this.userId}/Views`));
    return r.Items;
  }

  async resume(): Promise<BaseItem[]> {
    const q: Query = { Limit: 24, MediaTypes: 'Video', Fields: this.listFields, EnableImageTypes: ART, ImageTypeLimit: 1 };
    const r = this.isEmby
      ? await this.get<ItemsResult>(`/Users/${this.userId}/Items/Resume`, q)
      : await this.jellyfinOrLegacy(() => this.get<ItemsResult>('/UserItems/Resume', { userId: this.userId, ...q }), () => this.get<ItemsResult>(`/Users/${this.userId}/Items/Resume`, q));
    return r.Items;
  }

  async nextUp(seriesId?: string, limit = 24): Promise<BaseItem[]> {
    const q: Query = { UserId: this.userId, SeriesId: seriesId, Limit: limit, Fields: this.listFields, EnableImageTypes: ART, ImageTypeLimit: 1 };
    return (await this.get<ItemsResult>('/Shows/NextUp', q)).Items;
  }

  // Episodes airing soon, soonest first.
  async upcoming(limit = 24): Promise<BaseItem[]> {
    const q: Query = { UserId: this.userId, Limit: limit, Fields: this.listFields, EnableImageTypes: ART, ImageTypeLimit: 1 };
    return (await this.get<ItemsResult>('/Shows/Upcoming', q)).Items.sort((a, b) => (a.PremiereDate ?? '').localeCompare(b.PremiereDate ?? ''));
  }

  latest(parentId?: string): Promise<BaseItem[]> {
    const q: Query = { ParentId: parentId, Limit: 24, Fields: this.listFields, EnableImageTypes: ART, ImageTypeLimit: 1 };
    if (this.isEmby) return this.get(`/Users/${this.userId}/Items/Latest`, q);
    return this.get<BaseItem[]>('/Items/Latest', { userId: this.userId, ...q }).catch(() => this.get<BaseItem[]>(`/Users/${this.userId}/Items/Latest`, q));
  }

  // Emby 4.10 joins a repeated query name ("1,1"): a default the query names is left out.
  items(query: Query): Promise<ItemsResult> {
    const named = new Set(Object.keys(query).map((k) => k.toLowerCase()));
    const defaults: Query = {};
    if (!named.has('fields')) defaults.Fields = this.listFields;
    if (!named.has('enableimagetypes')) defaults.EnableImageTypes = ART;
    if (!named.has('imagetypelimit')) defaults.ImageTypeLimit = 1;
    if (this.isEmby) return this.get(`/Users/${this.userId}/Items`, { ...defaults, ...query });
    return this.get('/Items', { userId: this.userId, ...defaults, ...query });
  }

  item(id: string): Promise<BaseItem> {
    if (this.isEmby) return this.get(`/Users/${this.userId}/Items/${id}`, { Fields: DETAIL_FIELDS });
    return this.jellyfinOrLegacy(
      () => this.get<BaseItem>(`/Items/${id}`, { userId: this.userId, Fields: DETAIL_FIELDS }),
      () => this.get<BaseItem>(`/Users/${this.userId}/Items/${id}`, { Fields: DETAIL_FIELDS }),
    );
  }

  async seasons(seriesId: string): Promise<BaseItem[]> {
    return (await this.get<ItemsResult>(`/Shows/${seriesId}/Seasons`, { UserId: this.userId, Fields: this.listFields })).Items;
  }

  // No seasonId: every episode of the series, in order (specials included).
  async episodes(seriesId: string, seasonId?: string): Promise<BaseItem[]> {
    return (await this.get<ItemsResult>(`/Shows/${seriesId}/Episodes`, { UserId: this.userId, SeasonId: seasonId, Fields: this.listFields })).Items;
  }

  async similar(id: string, limit = 16): Promise<BaseItem[]> {
    return (await this.get<ItemsResult>(`/Items/${id}/Similar`, { UserId: this.userId, Limit: limit, Fields: this.listFields })).Items;
  }

  // Last played date per series, one batched call (Continue Watching's next-up order).
  async seriesUserData(ids: string[]): Promise<Map<string, string>> {
    if (!ids.length) return new Map();
    // items() picks the route each server takes (Jellyfin 10.9+ dropped /Users/{id}/Items).
    const r = await this.items({ Ids: ids.slice(0, 24).join(','), Fields: this.playFields, EnableImages: false });
    return new Map(r.Items.filter((i) => i.UserData?.LastPlayedDate).map((i) => [i.Id, i.UserData!.LastPlayedDate!]));
  }

  // "Retirer de Continuer à regarder": Emby only (Jellyfin has no equivalent; a 404 means unsupported).
  hideFromResume(id: string, hide: boolean): Promise<void> {
    return this.request('POST', `/Users/${this.userId}/Items/${id}/HideFromResume`, { Hide: hide }, {});
  }

  // The user's server-side configuration (audio/subtitle languages, subtitle mode): the servers pick default streams
  // from it, so every client follows the same preference (Settings.kt ServerConfig).
  async userConfiguration(): Promise<Record<string, unknown>> {
    return (await this.get<{ Configuration?: Record<string, unknown> }>(`/Users/${this.userId}`)).Configuration ?? {};
  }

  setUserConfiguration(config: Record<string, unknown>): Promise<void> {
    return this.isEmby
      ? this.request('POST', `/Users/${this.userId}/Configuration`, undefined, config)
      : this.request('POST', '/Users/Configuration', { userId: this.userId }, config);
  }

  // --- Images (core data/Images.kt: the fallbacks Emby web uses) ---

  image(id: string, type: string, tag: string | undefined, size: { maxWidth?: number; maxHeight?: number }): string | undefined {
    if (!tag) return undefined;
    return this.url(`/Items/${id}/Images/${type}`, { tag, maxWidth: size.maxWidth && Math.round(size.maxWidth), maxHeight: size.maxHeight && Math.round(size.maxHeight), quality: 90 });
  }

  poster(item: BaseItem, maxHeight: number): string | undefined {
    const own = item.ImageTags?.Primary;
    if (own) return this.image(item.Id, 'Primary', own, { maxHeight });
    if (item.SeriesId && item.SeriesPrimaryImageTag) return this.image(item.SeriesId, 'Primary', item.SeriesPrimaryImageTag, { maxHeight });
    if (item.AlbumId && item.AlbumPrimaryImageTag) return this.image(item.AlbumId, 'Primary', item.AlbumPrimaryImageTag, { maxHeight });
    return undefined;
  }

  thumb(item: BaseItem, maxWidth: number): string | undefined {
    if (item.Type === 'Episode' && item.ImageTags?.Primary) return this.image(item.Id, 'Primary', item.ImageTags.Primary, { maxWidth });
    if (item.ImageTags?.Thumb) return this.image(item.Id, 'Thumb', item.ImageTags.Thumb, { maxWidth });
    if (item.ParentThumbItemId && item.ParentThumbImageTag) return this.image(item.ParentThumbItemId, 'Thumb', item.ParentThumbImageTag, { maxWidth });
    return this.backdrop(item, maxWidth);
  }

  backdrop(item: BaseItem, maxWidth = 1920): string | undefined {
    const own = item.BackdropImageTags?.[0];
    if (own) return this.image(item.Id, 'Backdrop', own, { maxWidth });
    const parent = item.ParentBackdropImageTags?.[0];
    if (item.ParentBackdropItemId && parent) return this.image(item.ParentBackdropItemId, 'Backdrop', parent, { maxWidth });
    return undefined;
  }

  logo(item: BaseItem, maxWidth = 800): string | undefined {
    if (item.ImageTags?.Logo) return this.image(item.Id, 'Logo', item.ImageTags.Logo, { maxWidth });
    if (item.ParentLogoItemId && item.ParentLogoImageTag) return this.image(item.ParentLogoItemId, 'Logo', item.ParentLogoImageTag, { maxWidth });
    return undefined;
  }

  // Jellyfin 10.9 moved user avatars to /UserImage?userId=.
  userImage(user: { Id: string; PrimaryImageTag?: string }, maxHeight: number): string | undefined {
    const tag = user.PrimaryImageTag;
    if (!tag) return undefined;
    return this.isEmby
      ? this.url(`/Users/${user.Id}/Images/Primary`, { tag, maxHeight, quality: 90 })
      : this.url('/UserImage', { userId: user.Id, tag, maxHeight, quality: 90 });
  }

  // --- Library grid (tv Main.kt LibraryGrid) ---

  // A Live TV library's grid: the channel list rather than the view's folders.
  liveChannelsPage(start: number, limit: number): Promise<ItemsResult> {
    return this.get('/LiveTv/Channels', { UserId: this.userId, StartIndex: start, Limit: limit, EnableImageTypes: 'Primary,Thumb', Fields: 'PrimaryImageAspectRatio' });
  }

  // --- Details page (core Emby.kt, Playlists.kt) ---

  setFavorite(id: string, on: boolean): Promise<void> {
    return this.request(on ? 'POST' : 'DELETE', `/Users/${this.userId}/FavoriteItems/${id}`, undefined, on ? {} : undefined);
  }

  // Jellyfin 10.9 moved it to /UserPlayedItems (the per-user route is obsolete); older Jellyfin only has the old one.
  setPlayed(id: string, on: boolean): Promise<void> {
    const method = on ? 'POST' : 'DELETE';
    const body = on ? {} : undefined;
    if (this.isEmby) return this.request(method, `/Users/${this.userId}/PlayedItems/${id}`, undefined, body);
    return this.jellyfinOrLegacy(
      () => this.request<void>(method, `/UserPlayedItems/${id}`, { userId: this.userId }, body),
      () => this.request<void>(method, `/Users/${this.userId}/PlayedItems/${id}`, undefined, body),
    );
  }

  // "Marquer les précédents comme vus": one call per item not already in that state. Returns how many changed; stops
  // at the first failure. progress(done, total) after each call.
  async markPlayed(items: BaseItem[], on: boolean, progress: (done: number, total: number) => void = () => {}): Promise<number> {
    const todo = items.filter((i) => (i.UserData?.Played === true) !== on);
    progress(0, todo.length);
    for (let i = 0; i < todo.length; i++) {
      await this.setPlayed(todo[i].Id, on);
      progress(i + 1, todo.length);
    }
    return todo.length;
  }

  // Trailer files stored with the film. Jellyfin 10.9 moved the route; the old one is the fallback.
  localTrailers(id: string): Promise<BaseItem[]> {
    if (this.isEmby) return this.get(`/Users/${this.userId}/Items/${id}/LocalTrailers`, { Fields: DETAIL_FIELDS });
    return this.get<BaseItem[]>(`/Items/${id}/LocalTrailers`, { userId: this.userId }).catch(() => this.get<BaseItem[]>(`/Users/${this.userId}/Items/${id}/LocalTrailers`));
  }

  // Bonus videos stored with a film or a show (making-of, deleted scenes, interviews). Empty when the server has none
  // or answers the route with an HTTP error; network failures still throw.
  async specialFeatures(id: string): Promise<BaseItem[]> {
    try {
      if (this.isEmby) return await this.get<BaseItem[]>(`/Users/${this.userId}/Items/${id}/SpecialFeatures`);
      return await this.get<BaseItem[]>(`/Items/${id}/SpecialFeatures`, { userId: this.userId }).catch((e) => {
        if (e instanceof ApiError && e.status) return this.get<BaseItem[]>(`/Users/${this.userId}/Items/${id}/SpecialFeatures`);
        throw e;
      });
    } catch (e) {
      if (e instanceof ApiError && e.status) return [];
      throw e;
    }
  }

  async lists(kind: ListKind): Promise<BaseItem[]> {
    return (await this.items({ IncludeItemTypes: kind === 'playlist' ? 'Playlist' : 'BoxSet', Recursive: true, SortBy: 'SortName' })).Items;
  }

  // Jellyfin reads the playlist create call from a JSON body, Emby from the query, so both go.
  createList(kind: ListKind, name: string, item: BaseItem): Promise<void> {
    if (kind === 'collection') return this.request('POST', '/Collections', { Name: name, Ids: item.Id }, {});
    const type = mediaTypeOf(item);
    return this.request('POST', '/Playlists', { Name: name, Ids: item.Id, UserId: this.userId, MediaType: type }, { Name: name, Ids: [item.Id], UserId: this.userId, MediaType: type });
  }

  addToList(kind: ListKind, listId: string, item: BaseItem): Promise<void> {
    if (kind === 'playlist') return this.request('POST', `/Playlists/${listId}/Items`, { Ids: item.Id, UserId: this.userId }, {});
    return this.request('POST', `/Collections/${listId}/Items`, { Ids: item.Id }, {});
  }

  // --- Playback (core Emby.kt, player/Playback.kt) ---

  playbackInfo(id: string, query: Query, body: Record<string, unknown>): Promise<PlaybackInfo> {
    return this.post(`/Items/${id}/PlaybackInfo`, body, query);
  }

  // A server URL (absolute, or a path the server gave) for <video> and AVPlay, which cannot send headers: the token
  // goes in the query, only to this server's own origin. Null for anything but http(s) or a server path.
  mediaUrl(url: string): string | null {
    if ((/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^https?:\/\//i.test(url)) || url.startsWith('//')) return null;
    let full: URL;
    try {
      const rel = url.startsWith('/') ? url : `/${url}`;
      // Emby's URLs may already carry the /emby prefix.
      full = new URL(/^https?:\/\//i.test(url) ? url : `${this.base}${this.isEmby && /^\/emby\//i.test(rel) ? rel : this.prefix + rel}`);
    } catch {
      return null;
    }
    if (full.origin !== new URL(this.base).origin) return full.href;
    // Emby reads api_key; Jellyfin ApiKey (it dropped api_key in 10.11).
    if (this.token && !/[?&](api_key|ApiKey)=/i.test(full.search)) full.searchParams.set(this.isEmby ? 'api_key' : 'ApiKey', this.token);
    return full.href;
  }

  // The episode after [ep] in the server's order (core Emby.kt nextInOrder, B29): a special follows only where the
  // server placed it by air date, or after another special.
  async nextEpisode(ep: BaseItem): Promise<BaseItem | undefined> {
    if (!ep.SeriesId) return undefined;
    const list = (
      await this.get<ItemsResult>(`/Shows/${ep.SeriesId}/Episodes`, {
        UserId: this.userId, StartItemId: ep.Id, Limit: 8, IsMissing: false, Fields: `${this.listFields},SpecialEpisodeNumbers`,
        EnableImageTypes: 'Primary,Backdrop,Thumb', ImageTypeLimit: 1,
      })
    ).Items;
    const i = list.findIndex((e) => e.Id === ep.Id);
    if (i < 0) return undefined;
    type Special = BaseItem & { AirsBeforeSeasonNumber?: number; AirsAfterSeasonNumber?: number };
    return list.slice(i + 1).find((e: Special) => e.ParentIndexNumber !== 0 || ep.ParentIndexNumber === 0 || e.AirsBeforeSeasonNumber != null || e.AirsAfterSeasonNumber != null);
  }

  // Jellyfin 10.10+ media segments (intro, outro, recap, preview, commercial). Emby has no such route.
  async mediaSegments(id: string): Promise<MediaSegment[]> {
    const types = ['Intro', 'Outro', 'Recap', 'Preview', 'Commercial'].map((t) => `includeSegmentTypes=${t}`).join('&');
    const r = await this.request<{ Items?: MediaSegment[] }>('GET', `/MediaSegments/${id}?${types}`);
    return r?.Items ?? [];
  }

  // The /Sessions/Playing* reports; the body is SessionReporter's (lib/playback.svelte.ts).
  report(path: '/Sessions/Playing' | '/Sessions/Playing/Progress' | '/Sessions/Playing/Stopped', body: Record<string, unknown>): Promise<void> {
    return this.post(path, body);
  }

  // A paused transcode is killed after ~60 s without news (Jellyfin); the ping keeps it.
  ping(playSessionId: string): Promise<void> {
    return this.post('/Sessions/Playing/Ping', undefined, { PlaySessionId: playSessionId });
  }

  // Ends a transcode now rather than when the server notices.
  stopEncoding(playSessionId: string): Promise<void> {
    return this.del('/Videos/ActiveEncodings', { DeviceId: deviceId, PlaySessionId: playSessionId });
  }

  // --- Music (core MusicApi.kt, Emby.kt): the Emby / Jellyfin differences in one place ---

  // A track's list fields: its MediaSources too (the stream's own source id, the audio badge).
  get trackFields(): string {
    return `${this.listFields},MediaSources`;
  }

  albumArtists(query: Query): Promise<ItemsResult> {
    return this.get('/Artists/AlbumArtists', { UserId: this.userId, Fields: this.listFields, EnableImageTypes: 'Primary', ImageTypeLimit: 1, ...query });
  }

  // Emby /MusicGenres; Jellyfin /Genres?IncludeItemTypes=MusicAlbum (its /MusicGenres is deprecated since 10.8).
  musicGenres(parentId: string): Promise<ItemsResult> {
    if (this.isEmby) return this.get('/MusicGenres', { UserId: this.userId, ParentId: parentId, SortBy: 'SortName' });
    return this.get('/Genres', { userId: this.userId, ParentId: parentId, IncludeItemTypes: 'MusicAlbum', SortBy: 'SortName' });
  }

  // One route for tracks, albums, artists, genres and playlists on both servers.
  instantMix(id: string, limit = 100): Promise<ItemsResult> {
    return this.get(`/Items/${id}/InstantMix`, { [this.isEmby ? 'UserId' : 'userId']: this.userId, Limit: limit, Fields: this.trackFields });
  }

  // The tracks of an album, artist, playlist or genre, in play order (core PlayQueue.tracks), with their metadata.
  async tracksOf(item: BaseItem): Promise<BaseItem[]> {
    const order: Query =
      item.Type === 'MusicArtist' ? { ArtistIds: item.Id, SortBy: 'Album,ParentIndexNumber,IndexNumber,SortName' }
      : item.Type === 'Playlist' ? { ParentId: item.Id }
      : item.Type === 'MusicGenre' || item.Type === 'Genre' ? { GenreIds: item.Id, SortBy: 'Random' }
      : { ParentId: item.Id, SortBy: 'ParentIndexNumber,IndexNumber,SortName' };
    return (await this.items({ ...order, Recursive: true, IncludeItemTypes: 'Audio', Limit: 1000, Fields: this.trackFields })).Items;
  }

  // Server lyrics. Jellyfin: /Audio/{id}/Lyrics when HasLyrics. Emby has no lyrics route: an external lrc / text
  // subtitle stream of the audio item (that Emby shape is unverified: any failure reads as "no lyrics").
  async lyricsText(item: BaseItem): Promise<{ jellyfin: unknown } | { lrc: string } | null> {
    try {
      const has = (item as BaseItem & { HasLyrics?: boolean }).HasLyrics !== false;
      if (!this.isEmby) return has ? { jellyfin: await this.get(`/Audio/${item.Id}/Lyrics`) } : null;
      const source = item.MediaSources?.[0];
      const stream = (source?.MediaStreams ?? item.MediaStreams ?? []).find((s) => s.Type === 'Subtitle' && ['lrc', 'text', 'txt'].includes((s.Codec ?? '').toLowerCase()));
      if (!stream) return null;
      const base = `/Videos/${item.Id}/${source?.Id || item.Id}/Subtitles/${stream.Index}/Stream`;
      return { lrc: await this.get<string>(`${base}.lrc`).catch(() => this.get<string>(`${base}.txt`)) };
    } catch {
      return null;
    }
  }

  // A stream's server URL for direct play (no transcode), with this device's session.
  streamUrl(item: BaseItem, mediaSourceId: string, playSessionId?: string): string | null {
    const kind = item.MediaType === 'Audio' ? 'Audio' : 'Videos';
    return this.mediaUrl(`/${kind}/${item.Id}/stream${buildQuery({ Static: true, MediaSourceId: mediaSourceId, PlaySessionId: playSessionId, DeviceId: deviceId })}`);
  }
}

export interface PlaybackInfo {
  PlaySessionId?: string;
  ErrorCode?: string;
  MediaSources?: MediaSource[];
}

// "Ajouter à une playlist / collection" (core Playlists.kt, desktop lib/playlists.ts).
export type ListKind = 'playlist' | 'collection';
const PLAYLISTABLE = new Set(['Movie', 'Episode', 'Series', 'Season', 'Video', 'MusicVideo', 'Audio', 'MusicAlbum', 'Trailer']);
const COLLECTABLE = new Set(['Movie', 'Series', 'Video', 'MusicVideo', 'MusicAlbum', 'Book', 'Trailer']);
export const acceptsList = (kind: ListKind, item: BaseItem): boolean => (kind === 'playlist' ? PLAYLISTABLE : COLLECTABLE).has(item.Type ?? '');
// Playlists hold one media type; music goes to audio playlists.
export const mediaTypeOf = (item: BaseItem): string =>
  ['Audio', 'MusicAlbum', 'MusicArtist'].includes(item.Type ?? '') || item.MediaType === 'Audio' ? 'Audio' : 'Video';
// A playlist keeps one media type; one with no type is offered anyway.
export const listTargets = (kind: ListKind, item: BaseItem, all: BaseItem[]): BaseItem[] =>
  kind === 'collection' ? all : all.filter((l) => !l.MediaType || l.MediaType === mediaTypeOf(item));

// The episodes before [ep] in series order; specials only when [ep] is one (core Emby.kt previousEpisodes).
export function previousEpisodes(all: BaseItem[], ep: BaseItem): BaseItem[] {
  const i = all.findIndex((e) => e.Id === ep.Id);
  return i < 0 ? [] : all.slice(0, i).filter((e) => e.ParentIndexNumber !== 0 || ep.ParentIndexNumber === 0);
}

// core data/Emby.kt LIST_FIELDS and DETAIL_FIELDS.
export const LIST_FIELDS = 'PrimaryImageAspectRatio,ProductionYear,ChildCount,RecursiveItemCount,OfficialRating,CommunityRating,Overview,Genres,ProviderIds,DateCreated,Etag';
// Emby 4.8+: a list's UserData has LastPlayedDate and PlayCount only when these are asked for.
const EMBY_PLAY_FIELDS = 'UserDataPlayCount,UserDataLastPlayedDate';
export const DETAIL_FIELDS = `${LIST_FIELDS},Taglines,MediaSources,MediaStreams,People,Studios,Chapters,RemoteTrailers,LocalTrailerCount,Trickplay`;
const ART = 'Primary,Backdrop,Thumb,Logo';

// --- Finding a server from what the user typed ---

// The Android Api.candidates (core Emby.kt): "192.168.1.20", "nas:8920", "https://media.example.org/jellyfin" →
// base URLs to try. 8920 / 8096 are the Emby and Jellyfin default HTTPS / HTTP ports.
export function candidates(input: string): string[] {
  let raw = input.trim().replace(/\/+$/, '');
  if (!raw) return [];
  if (/^https?:\/\//i.test(raw)) return [raw];
  raw = raw.replace(/^\/+/, '');
  const slash = raw.indexOf('/');
  const host = slash < 0 ? raw : raw.slice(0, slash);
  if (/:\d+$/.test(host)) return [`https://${raw}`, `http://${raw}`];
  const tail = slash < 0 ? '' : raw.slice(slash);
  return [`https://${raw}`, `https://${host}:8920${tail}`, `http://${host}:8096${tail}`, `http://${raw}`];
}

export interface FoundServer {
  address: string;
  kind: ServerKind;
  info: SystemInfoPublic;
}

// Android Api.probeOne: /emby first (Emby only), then the root. No HTTP answer at all (refused, TLS failure) ends the
// address: the root path would not do better.
async function probeOne(address: string): Promise<FoundServer> {
  for (const prefix of ['/emby', '']) {
    let res: Response;
    try {
      res = await fetchWithTimeout(`${address}${prefix}/System/Info/Public`, { headers: { Accept: 'application/json' } }, 6_000);
    } catch {
      break;
    }
    const info = res.ok ? ((await res.json().catch(() => null)) as (SystemInfoPublic & { ProductName?: string }) | null) : null;
    if (!info?.Id) continue;
    const product = info.ProductName ?? '';
    const kind: ServerKind = /jellyfin/i.test(product) ? 'jellyfin' : prefix === '/emby' || /emby/i.test(product) ? 'emby' : 'jellyfin';
    return { address, kind, info };
  }
  throw new Error('not a server');
}

// The first address of [list] that answers, or null.
function race(list: string[]): Promise<FoundServer | null> {
  if (!list.length) return Promise.resolve(null);
  return new Promise((resolve) => {
    let pending = list.length;
    for (const a of list)
      probeOne(a).then(resolve, () => {
        if (--pending === 0) resolve(null);
      });
  });
}

// Android Api.probe: HTTPS and plain HTTP are probed at once, but an HTTP answer is used only once every HTTPS
// candidate has failed, so a faster HTTP answer never wins over HTTPS.
export async function probe(input: string): Promise<FoundServer | null> {
  const list = candidates(input);
  const secure = race(list.filter((a) => /^https:/i.test(a)));
  const plain = race(list.filter((a) => !/^https:/i.test(a)));
  return (await secure) ?? (await plain);
}
