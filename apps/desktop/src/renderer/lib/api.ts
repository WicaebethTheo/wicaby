// Typed wrappers over the IPC API proxy. Paths are server-relative; main adds
// the /emby prefix and auth. apiFor(serverId) talks to one server; `api` is the
// primary one.
import type { Query } from "../../shared/contract";
import type { BaseItem, ItemsResult } from "../../shared/models";
import { w } from "./bridge";
import { t } from "./i18n.svelte";
import { caps } from "../../shared/server-caps";
import { dataVersion, errorMessage, fileSessions, onlineSessions, progressToast, sessionFor, settings } from "./stores.svelte";

export { dedupe, itemKey, merge, sameTitle } from "./items";

export const LIST_FIELDS =
  "PrimaryImageAspectRatio,ProductionYear,ChildCount,RecursiveItemCount,OfficialRating,CommunityRating,Overview,Width,Height,ProviderIds,DateCreated,Etag";
export const DETAIL_FIELDS = `${LIST_FIELDS},Genres,Studios,People,MediaSources,MediaStreams,Chapters,Taglines,ParentId,RemoteTrailers`;

// Route of an item (or library, or book) on its own server.
export function itemPath(
  item: { Id: string; ServerId?: string; IsFolder?: boolean },
  kind: "item" | "library" | "read" = "item",
): string {
  // A file source's folders open in the folder browser (routes/Files.svelte).
  if (item.ServerId && (item.IsFolder || kind === "library") && sessionFor(item.ServerId)?.server.kind === "files")
    return `/files/${item.ServerId}/${item.Id}`;
  return item.ServerId
    ? `/${kind}/${item.ServerId}/${item.Id}`
    : `/${kind}/${item.Id}`;
}

// A library in row ids and the start page setting: its plain id on the primary
// server (what single-server settings saved), `<serverId>/<id>` elsewhere.
export function libraryRef(lib: { Id: string; ServerId?: string }): string {
  return !lib.ServerId || lib.ServerId === sessionFor()?.server.id
    ? lib.Id
    : `${lib.ServerId}/${lib.Id}`;
}

// Every response item carries the server it came from, so pages, images and
// playback reach the right one.
function stamp<T>(value: T, serverId: string): T {
  const mark = (x: unknown) => {
    if (x && typeof x === "object" && "Id" in x)
      (x as BaseItem).ServerId = serverId;
  };
  if (Array.isArray(value)) value.forEach(mark);
  else if (value && typeof value === "object") {
    const items = (value as { Items?: unknown }).Items;
    if (Array.isArray(items)) items.forEach(mark);
    else mark(value);
  }
  return value;
}

// Short-lived cache of GET responses: going back, or opening a card that was
// prefetched on hover, renders instantly instead of waiting on the server.
// Entries die after TTL_MS, on any write, and when the server reports changes.
const TTL_MS = 120_000;
const cache = new Map<
  string,
  { at: number; version: string; value: Promise<unknown> }
>();

// fresh: skip a cached answer (a random pick asked again) and keep the new one.
function get<T>(path: string, query?: Query, serverId?: string, fresh = false): Promise<T> {
  const s = sessionFor(serverId);
  const sid = s?.server.id ?? "";
  const key = `${sid}/${s?.user?.id}|${path}|${JSON.stringify(query ?? {})}`;
  const version = `${dataVersion.userData}.${dataVersion.library}`;
  const hit = cache.get(key);
  if (!fresh && hit && hit.version === version && Date.now() - hit.at < TTL_MS)
    return hit.value as Promise<T>;
  const value = w.api
    .get<T>(path, query, sid || undefined)
    .then((v) => stamp(v, sid));
  cache.set(key, { at: Date.now(), version, value });
  value.catch(() => cache.delete(key));
  if (cache.size > 300) cache.delete(cache.keys().next().value!);
  return value;
}

export { get as cachedGet };

export function invalidateApiCache(): void {
  cache.clear();
}

const imageQuery = {
  EnableImageTypes: "Primary,Backdrop,Thumb,Logo",
  ImageTypeLimit: 1,
};

// serverId undefined = the primary server, resolved at call time.
export function apiFor(serverId?: string) {
  function uid(): string {
    const id = sessionFor(serverId)?.user?.id;
    if (!id) throw new Error(t("browse.errors.notSignedIn"));
    return id;
  }
  const jellyfin = () => sessionFor(serverId)?.server.kind === "jellyfin";
  // PremiereDate is not an ItemFields value on Jellyfin (it always sends it): named for Emby only.
  const listFields = () => (jellyfin() ? LIST_FIELDS : `${LIST_FIELDS},PremiereDate`);

  // Jellyfin 10.9+ removed the /Users/{id}/… routes from its API (still served, marked
  // obsolete) in favour of userId-as-query routes; Emby only has the per-user ones.
  // `route` is the Emby path after /Users/{id}.
  function userRoute(route: string, query: Query = {}): [string, Query] {
    if (!jellyfin()) return [`/Users/${uid()}${route}`, query];
    const q = { ...query, userId: uid() };
    if (route === "/Views") return ["/UserViews", q];
    if (route === "/Items/Resume") return ["/UserItems/Resume", q];
    const m = /^\/(Favorite|Played)Items\/(.+)$/.exec(route);
    if (m) return [`/User${m[1]}Items/${m[2]}`, q];
    // /Items, /Items/Latest, /Items/{id}
    return [route, q];
  }
  const cached = <T>(path: string, query?: Query, fresh = false) =>
    get<T>(path, query, serverId, fresh);
  const post = ([path, query]: [string, Query]) =>
    w.api.post(path, query, undefined, serverId);
  const del = ([path, query]: [string, Query]) =>
    w.api.del(path, query, serverId);

  return {
    views: () => cached<ItemsResult>(...userRoute("/Views")),

    resume: (limit = 24) =>
      cached<ItemsResult>(...userRoute("/Items/Resume", {
        Limit: limit,
        MediaTypes: "Video",
        // Genres: the Automatic featured banner shows the first one and leaves out the excluded ones (lib/hero-feed.ts).
        Fields: `${listFields()},Genres`,
        ...imageQuery,
      })),

    nextUp: (limit = 24) =>
      cached<ItemsResult>("/Shows/NextUp", {
        UserId: uid(),
        // Jellyfin's default (true) repeats the episodes already in the resume row; jellyfin-web sends false.
        EnableResumable: jellyfin() ? false : undefined,
        Limit: limit,
        Fields: listFields(),
        ...imageQuery,
      }),

    // Episodes airing soon, the same route and query on Emby and Jellyfin.
    upcoming: (limit = 24) =>
      cached<ItemsResult>("/Shows/Upcoming", {
        UserId: uid(),
        Limit: limit,
        Fields: LIST_FIELDS,
        ...imageQuery,
      }),

    latest: (parentId: string, limit = 24) =>
      cached<BaseItem[]>(...userRoute("/Items/Latest", {
        ParentId: parentId,
        Limit: limit,
        Fields: `${listFields()},Genres`,
        ...imageQuery,
      })),

    item: (id: string) => cached<BaseItem>(...userRoute(`/Items/${id}`)),

    localTrailers: (id: string) => cached<BaseItem[]>(...userRoute(`/Items/${id}/LocalTrailers`)),

    // Extras: deleted scenes, making-of, interviews (Emby /Users/{id}/Items/{id}/SpecialFeatures, Jellyfin ?userId=).
    specialFeatures: (id: string) => cached<BaseItem[]>(...userRoute(`/Items/${id}/SpecialFeatures`)),

    items: (query: Query, fresh = false) =>
      cached<ItemsResult>(...userRoute("/Items", {
        Fields: listFields(),
        ...imageQuery,
        ...query,
      }), fresh),

    // Photo timelines (photos spec §3.1): 1,000-item skeleton pages, kept out of the GET cache they would crowd.
    photoItems: (query: Query) => {
      const s = sessionFor(serverId);
      return w.api
        .get<ItemsResult>(...userRoute("/Items", { Fields: listFields(), EnableImageTypes: "Primary", ImageTypeLimit: 1, EnableUserData: true, ...query }), s?.server.id)
        .then((v) => stamp(v, s?.server.id ?? ""));
    },

    // Shuffle screen (SortBy=Random): outside the GET cache, or a re-roll would get the same set back.
    randomItems: (query: Query) => {
      const sid = sessionFor(serverId)?.server.id ?? "";
      return w.api
        .get<ItemsResult>(...userRoute("/Items", { Fields: `${listFields()},Genres`, ...imageQuery, Recursive: true, SortBy: "Random", ...query }), sid || undefined)
        .then((v) => stamp(v, sid));
    },

    // Genre names of a library (ParentId) or of the whole server.
    genres: (query: Query) => cached<{ Items?: { Name: string }[] }>("/Genres", { UserId: uid(), Recursive: true, SortBy: "SortName", ...query }),

    seasons: (seriesId: string) =>
      cached<ItemsResult>(`/Shows/${seriesId}/Seasons`, {
        UserId: uid(),
        Fields: listFields(),
        ...imageQuery,
      }),

    episodes: (seriesId: string, seasonId?: string) =>
      cached<ItemsResult>(`/Shows/${seriesId}/Episodes`, {
        UserId: uid(),
        SeasonId: seasonId,
        Fields: `${listFields()},MediaSources`,
        ...imageQuery,
      }),

    similar: (id: string, limit = 16) =>
      cached<ItemsResult>(`/Items/${id}/Similar`, {
        UserId: uid(),
        Limit: limit,
        Fields: listFields(),
        ...imageQuery,
      }),

    search: (term: string, limit = 60) =>
      cached<ItemsResult>(...userRoute("/Items", {
        SearchTerm: term,
        Recursive: true,
        Limit: limit,
        IncludeItemTypes:
          "Movie,Series,Episode,MusicAlbum,MusicArtist,Audio,BoxSet,Book",
        Fields: listFields(),
        ...imageQuery,
      })),

    // Live TV in the global search (LT-10): results of type TvChannel and Program, in their own request
    // so they never crowd the library out of its 60. LiveTvProgram is the query name on both servers.
    searchLive: (term: string, limit = 20) =>
      cached<ItemsResult>(...userRoute("/Items", {
        SearchTerm: term,
        Recursive: true,
        Limit: limit,
        IncludeItemTypes: "TvChannel,LiveTvProgram",
        Fields: "ChannelInfo",
        EnableImages: false,
      })),

    setFavorite: (id: string, value: boolean) => (
      invalidateApiCache(),
      value
        ? post(userRoute(`/FavoriteItems/${id}`))
        : del(userRoute(`/FavoriteItems/${id}`))
    ),

    // Server-defined Home rows (caps.serverHubs: Plex's promoted hubs, plex-spec §8); none elsewhere.
    hubs: () =>
      caps(sessionFor(serverId)?.server.kind).serverHubs
        ? cached<{ Name: string; Key: string; Items: BaseItem[] }[]>("/Hubs").then((hubs) => hubs.map((h) => ({ ...h, Items: stamp(h.Items, sessionFor(serverId)?.server.id ?? "") })))
        : Promise.resolve([]),

    // Series last played, for ordering next-up cards (X-01): one call for up to 24 series.
    seriesUserData: (ids: string[]) =>
      cached<ItemsResult>(...userRoute("/Items", { Ids: ids.slice(0, 24).join(","), Fields: "UserData", EnableImages: false })),

    // "Retirer de Continuer à regarder": Emby only (Jellyfin has no equivalent; a 404 means unsupported).
    hideFromResume: (id: string, hide: boolean) => (
      invalidateApiCache(),
      post([`/Users/${uid()}/Items/${id}/HideFromResume`, { Hide: hide }])
    ),

    setPlayed: (id: string, value: boolean) => (
      invalidateApiCache(),
      value
        ? post(userRoute(`/PlayedItems/${id}`))
        : del(userRoute(`/PlayedItems/${id}`))
    ),
  };
}

export type Api = ReturnType<typeof apiFor>;
export const api = apiFor();

// The same query on every signed-in server, in parallel. A server that fails
// (or is down) gives null instead of holding up or breaking the others.
// `each` gets the answers so far whenever one server answers, so a slow server
// never holds back what the others already returned.
export function fanOut<T>(
  fn: (api: Api, serverId: string) => Promise<T>,
  each?: (sofar: (T | null)[]) => void,
): Promise<(T | null)[]> {
  // File sources join only when "Show file sources on Home" is on (caps homeOptIn, file-sources-spec D10).
  const files = settings.value?.ui.filesOnHome ? fileSessions().filter((s) => s.status === "signed-in" && caps(s.server.kind).homeOptIn) : [];
  const sessions = [...onlineSessions(), ...files];
  const out: (T | null)[] = sessions.map(() => null);
  return Promise.all(
    sessions.map((s, i) =>
      fn(apiFor(s.server.id), s.server.id)
        .catch(() => null)
        .then((v) => {
          out[i] = v;
          each?.(out);
        }),
    ),
  ).then(() => out);
}

// Episodes before this one in series order; specials (season 0) are left alone unless it is one.
export function previousEpisodes(all: BaseItem[], ep: BaseItem): BaseItem[] {
  const idx = all.findIndex((e) => e.Id === ep.Id);
  return idx < 0 ? [] : all.slice(0, idx).filter((e) => e.ParentIndexNumber !== 0 || ep.ParentIndexNumber === 0);
}

// Items marked (un)watched one by one under a progress toast; pages refetch once at the end.
export async function markPlayed(items: BaseItem[], value: boolean, serverId?: string): Promise<void> {
  const todo = items.filter((x) => Boolean(x.UserData?.Played) !== value);
  const total = todo.length;
  const api = apiFor(serverId);
  const p = progressToast(t("item.toast.marking", { done: 0, total }));
  try {
    for (const [i, x] of todo.entries()) {
      await api.setPlayed(x.Id, value);
      p.update(t("item.toast.marking", { done: i + 1, total }));
    }
    p.done("success", t(value ? "item.toast.markedWatchedCount" : "item.toast.markedUnwatchedCount", { count: total }));
  } catch (err) {
    p.done("error", errorMessage(err));
  } finally {
    dataVersion.userData++;
  }
}

// Ids to queue when playing an item: episodes continue through the series.
export async function playQueueFor(
  item: BaseItem,
): Promise<{ itemIds: string[]; startIndex: number; serverId?: string }> {
  const serverId = item.ServerId;
  const api = apiFor(serverId);
  // A file: the videos of its folder from this one on, in folder order ("next in folder").
  if (item.ParentId && sessionFor(serverId)?.server.kind === "files" && !item.IsFolder) {
    const siblings = await api.items({ ParentId: item.ParentId, SortBy: "SortName" }).catch(() => null);
    const ids = (siblings?.Items ?? []).filter((x) => !x.IsFolder).map((x) => x.Id);
    const idx = ids.indexOf(item.Id);
    return idx < 0 ? { itemIds: [item.Id], startIndex: 0, serverId } : { itemIds: ids, startIndex: idx, serverId };
  }
  if (item.Type === "Episode" && item.SeriesId) {
    const eps = await api.episodes(item.SeriesId);
    const ids = eps.Items.map((e) => e.Id);
    const idx = ids.indexOf(item.Id);
    if (idx >= 0) return { itemIds: ids, startIndex: idx, serverId };
  }
  if (item.Type === "Series" || item.Type === "Season") {
    const seriesId = item.Type === "Series" ? item.Id : item.SeriesId!;
    const eps = await api.episodes(
      seriesId,
      item.Type === "Season" ? item.Id : undefined,
    );
    const first = eps.Items.findIndex((e) => !e.UserData?.Played);
    return {
      itemIds: eps.Items.map((e) => e.Id),
      startIndex: Math.max(0, first),
      serverId,
    };
  }
  if (
    item.Type === "MusicAlbum" ||
    item.Type === "Playlist" ||
    item.Type === "BoxSet"
  ) {
    const children = await api.items({
      ParentId: item.Id,
      Recursive: true,
      IncludeItemTypes: "Audio,Movie,Episode,Video",
      SortBy: "ParentIndexNumber,IndexNumber,SortName",
    });
    return { itemIds: children.Items.map((c) => c.Id), startIndex: 0, serverId };
  }
  return { itemIds: [item.Id], startIndex: 0, serverId };
}
