// Home's data, as the TV web app's HomeTab loads it (apps/tv-web/src/tabs/HomeTab.svelte, Android Main.kt): the
// hero's titles, then the user's rows in their saved order (Settings > Home): Continue watching (merged with Next
// up, or apart), Upcoming, each library's Recently added, "Because you watched". Rows paint from the last visit
// (persisted) and refresh behind. Live TV now and photo memories join with M3.
// Call useHome() from a component's script: it sets up the component's loads.
import type { BaseItem } from '$shared/models';
import { recency, type SeriesDates } from '$desktop/continue';
import type { Api } from '$tv/api';
import { continueSubtitle, loadContinueAll } from '$tv/continue-watching';
import { BECAUSE, becauseSeeds, defaults, latestViewId, move, NEXT_UP, RESUME, UPCOMING, unseen, type HomePref } from '$tv/home-rows';
import { t } from '$tv/i18n.svelte';
import { useLoad } from '$tv/load.svelte';
import { extraViews as loadExtraViews, libraryRef, merged as mergedAll } from '$tv/servers';
import { apiOf, isMulti, prefs, serverName } from '$tv/session.svelte';
import { arrange, homeRows, setHomeRows, settings } from '$tv/settings.svelte';
import { uniqueBy } from './diagnostics';
import { look } from './look.svelte';

export interface HomeRow {
  key: string;
  title: string;
  items: BaseItem[];
  // 16:9 cards with a progress bar (Continue watching, Next up…), else posters.
  wide: boolean;
  // A tap plays (Continue watching, Next up); elsewhere it opens the title's page.
  playable: boolean;
  subtitle?: (item: BaseItem) => string | undefined;
  // The merged Continue watching row's series dates: its cards' menu can remove them.
  continueRow?: SeriesDates;
}

// The libraries with a Recently added row: all but playlists, Live TV and folders (HomeLayout.kt latestViews).
// Music, photos and books join with their pages (M3).
const latestOf = (list: BaseItem[]) => uniqueBy(list, (v) => `${v.ServerId ?? ''}:${v.Id}`).filter((v) => !['playlists', 'livetv', 'folders', 'music', 'photos', 'books'].includes(v.CollectionType ?? ''));
const airDate = (i: BaseItem) => Date.parse(i.PremiereDate ?? '') || 0;

// A Recently added row in posters: Emby lists the new episodes (and seasons) themselves, whose picture is a 16:9
// still; each becomes its series, once, with the series' poster, and opens the series.
export function asSeries(items: BaseItem[]): BaseItem[] {
  const seen = new Set<string>();
  const out: BaseItem[] = [];
  for (const i of items) {
    if ((i.Type !== 'Episode' && i.Type !== 'Season') || !i.SeriesId) {
      if (!seen.has(i.Id)) out.push(i);
      seen.add(i.Id);
      continue;
    }
    if (seen.has(i.SeriesId)) continue;
    seen.add(i.SeriesId);
    out.push({
      Id: i.SeriesId,
      Name: i.SeriesName ?? i.Name,
      Type: 'Series',
      ServerId: i.ServerId,
      ImageTags: i.SeriesPrimaryImageTag ? { Primary: i.SeriesPrimaryImageTag } : {},
      ProductionYear: i.ProductionYear,
    } as BaseItem);
  }
  return out;
}

// The rows Home can show for the signed-in user, in their order, with what the user changed (TP-07): Home's rows
// and Settings > Home's editor read the same layout.
function useLayout(views: () => BaseItem[]) {
  const serverId = prefs.session!.server.id;
  const user = `${serverId}/${prefs.session!.userId}`;
  const merged = $derived(settings.mergeContinue.value);
  const multi = $derived(isMulti());
  const extra = useLoad(
    () => (multi ? `extra-views-${(prefs.extras ?? []).map((e) => e.server.id).join(',')}` : 'extra-views-off'),
    () => (multi ? loadExtraViews() : Promise.resolve([])),
  );
  const latestViews = $derived([...latestOf(views()), ...latestOf(extra.value ?? [])]);
  const viewRef = (v: BaseItem) => libraryRef(v, serverId);
  const ids = $derived(defaults(latestViews.map(viewRef), merged));
  const pref = $derived(homeRows(user, ids));
  const order = $derived(arrange(ids, pref));
  // A library's name, with its server's when it is another server's ("Films · <server name>").
  const viewName = (view: BaseItem | undefined) => (view && view.ServerId && view.ServerId !== serverId ? `${view.Name} · ${serverName(view.ServerId) ?? ''}` : view?.Name);
  return {
    serverId,
    user,
    get merged() {
      return merged;
    },
    get latestViews() {
      return latestViews;
    },
    get pref() {
      return pref;
    },
    get order() {
      return order;
    },
    viewRef,
    viewName,
  };
}

export interface LayoutRow {
  id: string;
  label: string;
  hidden: boolean;
  // A Recently added row: shown as 16:9 thumbnails instead of posters.
  wide: boolean | null;
}

// Settings > Home: show or hide each row, move it, a library's row in thumbnails, back to the defaults.
export function useHomeLayout(views: () => BaseItem[]) {
  const l = useLayout(views);
  const label = (id: string): string => {
    if (id === RESUME) return t(l.merged ? 'continue_watching_merged' : 'continue_watching');
    if (id === NEXT_UP) return t('next_up');
    if (id === UPCOMING) return t('row_upcoming');
    if (id === BECAUSE) return t('web_row_because');
    const viewId = latestViewId(id);
    return t('latest_in', l.viewName(l.latestViews.find((v) => l.viewRef(v) === viewId)) ?? '');
  };
  const save = (patch: Partial<HomePref>) => setHomeRows(l.user, { order: l.order, hidden: l.pref.hidden, thumb: l.pref.thumb, ...patch });
  const flip = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  return {
    get rows(): LayoutRow[] {
      return l.order.map((id) => ({ id, label: label(id), hidden: l.pref.hidden.includes(id), wide: latestViewId(id) !== null ? l.pref.thumb.includes(id) : null }));
    },
    toggle: (id: string) => save({ hidden: flip(l.pref.hidden, id) }),
    wide: (id: string) => save({ thumb: flip(l.pref.thumb, id) }),
    // Every Recently added row in thumbnails, or every one in posters.
    allWide: (on: boolean) => save({ thumb: on ? l.order.filter((id) => latestViewId(id) !== null) : [] }),
    get anyWide(): boolean {
      return l.order.some((id) => latestViewId(id) !== null && l.pref.thumb.includes(id));
    },
    move: (id: string, by: number) => save({ order: move(l.order, l.order.indexOf(id), l.order.indexOf(id) + by) }),
    reset: () => setHomeRows(l.user, { order: [], hidden: [], thumb: [] }),
  };
}

export function useHome(api: Api, views: () => BaseItem[]) {
  const l = useLayout(views);
  const serverId = l.serverId;
  const merged = $derived(l.merged);
  const latestViews = $derived(l.latestViews);
  const viewRef = l.viewRef;
  const pref = $derived(l.pref);
  const shown = $derived(l.order.filter((id) => !pref.hidden.includes(id)));

  // #8: unwatched titles only when asked, all of them when everything is watched (Main.kt heroItems).
  const pickHero = async (unwatched: boolean) =>
    (
      await api.items({
        IncludeItemTypes: 'Movie,Series',
        Recursive: true,
        SortBy: 'Random',
        Limit: 10,
        ImageTypes: 'Backdrop',
        EnableImageTypes: 'Primary,Backdrop,Logo,Thumb',
        Fields: 'Overview,Genres,ProductionYear,OfficialRating,CommunityRating,RunTimeTicks,ChildCount',
        Filters: unwatched ? 'IsUnplayed' : undefined,
      })
    ).Items.filter((i) => i.BackdropImageTags?.length).slice(0, 6);
  const hideWatched = $derived(settings.heroHideWatched.value);
  const hero = useLoad(
    () => (!settings.rowHero.value ? 'hero-off' : hideWatched ? 'hero-unwatched' : 'hero'),
    async () => {
      if (!settings.rowHero.value) return [];
      if (!hideWatched) return pickHero(false);
      const list = await pickHero(true);
      return list.length ? list : pickHero(false);
    },
    // A new draw per launch, stable for the session.
    { refresh: false },
  );

  // Kept for the next start as JSON: the series' last-played dates go as entries (a Map would come back empty).
  const cont = useLoad(
    () => (merged ? 'continue2' : 'continue-off'),
    async () => {
      if (!merged) return null;
      const r = await loadContinueAll(api, serverId);
      return { items: r.items, dates: [...r.series] };
    },
    { persist: true },
  );
  const contSeries = $derived<SeriesDates>(new Map(Array.isArray(cont.value?.dates) ? cont.value.dates : []));
  // When each title was last watched, from the latest plays (one call): Emby gives a series no date of its own, so a
  // next-up card is dated by the series' latest episode watched. Keyed by series, or by film.
  const lastPlays = useLoad(
    () => (look.resumeHeroDays && settings.rowHero.value ? 'last-plays' : 'last-plays-off'),
    async () => {
      if (!look.resumeHeroDays || !settings.rowHero.value) return [] as [string, string][];
      const r = await api.items({ IncludeItemTypes: 'Movie,Episode', Recursive: true, SortBy: 'DatePlayed', SortOrder: 'Descending', Limit: 40, Fields: api.playFields, EnableImages: false });
      const out = new Map<string, string>();
      for (const i of r.Items) {
        const d = i.UserData?.LastPlayedDate;
        const k = i.SeriesId ?? i.Id;
        if (d && !out.has(k)) out.set(k, d);
      }
      return [...out];
    },
    { persist: true },
  );
  const lastPlayed = $derived(new Map(Array.isArray(lastPlays.value) ? lastPlays.value : []));
  const resume = useLoad(() => (merged ? 'resume-off' : 'resume'), () => (merged ? Promise.resolve([]) : mergedAll((a) => a.resume(), true)), { persist: true });
  const nextUp = useLoad(() => (merged ? 'nextup-off' : 'nextup'), () => (merged ? Promise.resolve([]) : mergedAll((a) => a.nextUp())), { persist: true });
  const upcoming = useLoad(() => 'upcoming', async () => (await mergedAll((a) => a.upcoming())).sort((x, y) => airDate(x) - airDate(y)), { persist: true });
  // One load for every Recently added row: their order and visibility change without refetching.
  const latests = useLoad(
    () => `latest:${latestViews.map(viewRef).join(',')}`,
    async () =>
      Object.fromEntries(
        await Promise.all(
          latestViews.map(async (v) => {
            const a = apiOf(v.ServerId) ?? api;
            const items = await a.latest(v.Id).catch(() => [] as BaseItem[]);
            return [viewRef(v), items.map((i) => (i.ServerId ? i : { ...i, ServerId: a.serverId }))] as const;
          }),
        ),
      ),
    { persist: true },
  );
  // "Because you watched": titles similar to the two latest played, minus what the rows above show.
  const because = useLoad(
    () => 'because',
    async () => {
      const played = (await api.items({ Filters: 'IsPlayed', Recursive: true, IncludeItemTypes: 'Movie,Episode', SortBy: 'DatePlayed', SortOrder: 'Descending', Limit: 20 })).Items;
      return Promise.all(becauseSeeds(played).map(async (seed) => ({ seed, items: await api.similar(seed.Id, 16).catch(() => []) })));
    },
  );

  const rows = $derived.by(() => {
    let seen: BaseItem[] = [...(cont.value?.items ?? []), ...(resume.value ?? []), ...(nextUp.value ?? []), ...Object.values(latests.value ?? {}).flat()];
    const out: HomeRow[] = [];
    for (const id of shown) {
      if (id === RESUME) {
        if (merged && cont.value?.items.length) out.push({ key: 'continue', title: t('continue_watching_merged'), items: cont.value.items, wide: true, playable: true, subtitle: continueSubtitle, continueRow: contSeries });
        if (!merged && resume.value?.length) out.push({ key: 'resume', title: t('continue_watching'), items: resume.value, wide: true, playable: true, continueRow: new Map() });
      } else if (id === NEXT_UP) {
        if (nextUp.value?.length) out.push({ key: 'nextup', title: t('next_up'), items: nextUp.value, wide: true, playable: true });
      } else if (id === UPCOMING) {
        if (upcoming.value?.length) out.push({ key: 'upcoming', title: t('row_upcoming'), items: upcoming.value, wide: true, playable: false });
      } else if (id === BECAUSE) {
        for (const b of because.value ?? []) {
          const items = unseen(b.items, seen);
          seen = [...seen, ...items];
          if (items.length) out.push({ key: `because-${b.seed.Id}`, title: t('row_because', b.seed.Name), items, wide: false, playable: false });
        }
      } else {
        const viewId = latestViewId(id);
        const view = latestViews.find((v) => viewRef(v) === viewId);
        const items = viewId ? latests.value?.[viewId] : undefined;
        const name = l.viewName(view);
        const wide = pref.thumb.includes(id);
        if (view && items?.length) out.push({ key: id, title: t('latest_in', name ?? ''), items: wide ? items : asSeries(items), wide, playable: false });
      }
    }
    // One row per key, each card once (a server can list a library, or a title, twice): a repeated key stops the
    // whole list from drawing.
    return uniqueBy(out, (r) => r.key).map((r) => ({ ...r, items: uniqueBy(r.items, (i) => `${i.ServerId ?? ''}:${i.Id}`) }));
  });

  // What was watched lately (Settings > Home: within the last days), up to three, newest first: the hero shows them
  // to resume, as the desktop app does, until they are older; then the featured titles again.
  const recent = $derived.by(() => {
    const days = look.resumeHeroDays;
    if (!days || !settings.rowHero.value) return [];
    const series = contSeries;
    const list = merged ? (cont.value?.items ?? []) : [...(resume.value ?? []), ...(nextUp.value ?? [])];
    const since = Date.now() - days * 86_400_000;
    return list
      .map((item) => ({ item, at: Math.max(Date.parse(recency(item, series)) || 0, Date.parse(lastPlayed.get(item.SeriesId ?? item.Id) ?? '') || 0) }))
      .filter((x) => x.at >= since)
      .sort((x, y) => y.at - x.at)
      .slice(0, 3)
      .map((x) => x.item);
  });

  return {
    get hero() {
      return recent.length ? recent : (hero.value ?? []);
    },
    // The hero is the "Resume" one.
    get heroResume() {
      return recent.length > 0;
    },
    get rows() {
      return rows;
    },
    get loading() {
      return cont.loading && latests.loading;
    },
  };
}
