<script lang="ts" module>
  import type { BaseItem as Item } from '../../shared/models';
  import type { Channel as LiveChannel } from '../lib/livetv.svelte';
  import type { MemoryGroup } from '../lib/photos/source.svelte';

  // Last shelves shown, so coming back paints the full page on the first frame.
  type Shelves = {
    resume: Item[];
    nextUp: Item[];
    cont: Item[];
    upcoming: Item[];
    latest: Record<string, Item[]>;
    because: { seed: Item; items: Item[] }[];
    favorites: Item[];
    playlists: Item[];
    collections: Item[];
    live: LiveChannel[];
    memories: MemoryGroup[];
    hubs: Hub[];
  };
  // A server-defined row (Plex hubs, caps.serverHubs), with the server it came from.
  type Hub = { sid: string; key: string; name: string; items: Item[] };
  let last: Shelves | null = null;
  // The banner from a chosen source (not Automatic) and the settings it was picked with.
  let lastHero: { feed: string; items: Item[] } | null = null;
</script>

<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { flip } from 'svelte/animate';
  import { scale } from 'svelte/transition';
  import type { BaseItem } from '../../shared/models';
  import ChannelTile from '../components/ChannelTile.svelte';
  import Hero from '../components/Hero.svelte';
  import Card from '../components/Card.svelte';
  import HomeSheet from '../components/HomeSheet.svelte';
  import Icon, { type IconName } from '../components/Icon.svelte';
  import ItemMenu from '../components/ItemMenu.svelte';
  import Row from '../components/Row.svelte';
  import { apiFor, dedupe, fanOut, itemKey, itemPath, LIST_FIELDS, libraryRef, merge, type Api } from '../lib/api';
  import { becauseSeeds, unseen } from '../lib/items';
  import { autoFeatured, heroParents, heroQuery, heroQueryable, pickFeatured, seriesToAsk, type SeriesGenres } from '../lib/hero-feed';
  import { hiddenKey, isHidden, mergeContinue, recency, withHidden, withoutHidden, type SeriesDates } from '../lib/continue';
  import { episodeCode, runtime } from '../lib/format';
  import { t } from '../lib/i18n.svelte';
  import { imageUrl } from '../lib/images';
  import { live } from '../lib/livetv.svelte';
  import { list as listOf } from '../lib/playlists';
  import { canShuffle, VIDEO_COLLECTIONS } from '../lib/shuffle';
  import { dur, reveal, scrollMemory } from '../lib/motion';
  import { navigate, router } from '../lib/router.svelte';
  import { localDay } from '../lib/photos/memories';
  import { memoriesOf } from '../lib/photos/source.svelte';
  import MemoryCards from './photos/MemoryCards.svelte';
  import { dataVersion, fileSessions, libraries, liveTv, multiServer, onlineSessions, photoSessions, serverName, session, sessionFor, settings, toast, updateSettings } from '../lib/stores.svelte';

  let resume = $state<BaseItem[]>(last?.resume ?? []);
  let nextUp = $state<BaseItem[]>(last?.nextUp ?? []);
  let upcoming = $state<BaseItem[]>(last?.upcoming ?? []);
  let because = $state<{ seed: BaseItem; items: BaseItem[] }[]>(last?.because ?? []);
  // X-01: "Continuer à regarder" (resume + next up in one row) while ui.mergeContinue is on (the default).
  let cont = $state<BaseItem[]>(last?.cont ?? []);
  let seriesDates: SeriesDates = new Map();
  let menuFor = $state<string | null>(null);
  const mergeOn = $derived(settings.value?.ui.mergeContinue !== false);
  let latest = $state<Record<string, BaseItem[]>>(last?.latest ?? {});
  let favorites = $state<BaseItem[]>(last?.favorites ?? []);
  let playlists = $state<BaseItem[]>(last?.playlists ?? []);
  let collections = $state<BaseItem[]>(last?.collections ?? []);
  let channels = $state<LiveChannel[]>(last?.live ?? []);
  // "Ce jour-là" (photos PH-08): every server's memories, one card per year.
  let memories = $state<MemoryGroup[]>(last?.memories ?? []);
  let hubs = $state<Hub[]>(last?.hubs ?? []);
  const hubId = (h: Hub) => `hub:${h.sid}:${h.key}`;
  let loading = $state(last === null);
  // Settings > Accueil et bibliothèques opens the sheet through /home?customize=1.
  let customizing = $state(router.route.query.get('customize') === '1');

  onMount(scrollMemory);

  const libs = $derived(libraries.list.filter((l) => !['playlists', 'livetv', 'folders'].includes(l.CollectionType ?? '')));
  // Photo sources on files bring "on this day" too, whatever "Show file sources on Home" says.
  const photoSources = $derived(photoSessions().filter((s) => s.status === 'signed-in').map((s) => s.server.id));
  const hasPhotos = $derived(photoSources.length > 0 || libs.some((l) => l.CollectionType === 'photos' || l.CollectionType === 'homevideos'));
  // Several servers: merged rows name each card's server, and same-named libraries name theirs.
  // File sources merged into Home (setting on): their cards carry the source name like another server's.
  const filesOn = $derived(settings.value?.ui.filesOnHome === true && fileSessions().some((s) => s.status === 'signed-in'));
  const multi = $derived(multiServer() || filesOn);
  const ambiguous = (l: BaseItem) => multi && libs.some((o) => o.Name === l.Name && o.ServerId !== l.ServerId);
  const libLabel = (l: BaseItem) => (ambiguous(l) ? `${l.Name} · ${serverName(l.ServerId)}` : l.Name);
  // The shuffle screen (#18) needs a film or series library on a server that sorts at random.
  const shuffleOn = $derived(libs.some((l) => VIDEO_COLLECTIONS.includes(l.CollectionType ?? '') && canShuffle(sessionFor(l.ServerId)?.server.kind)));

  // ---- Row model: default order, then the user's order and hidden set ----
  // `server` is shown in the customisation sheet, where the rows of every server sit in one list.
  const defs = $derived<{ id: string; label: string; server?: string }[]>([
    // Merged, the row keeps the 'resume' id so the user's order and hidden set still apply.
    { id: 'resume', label: mergeOn ? t('browse.home.rows.continueMerged') : t('browse.home.rows.continue') },
    ...(mergeOn ? [] : [{ id: 'nextUp', label: t('browse.home.rows.nextUp') }]),
    { id: 'upcoming', label: t('browse.home.rows.upcoming') },
    ...(liveTv.available ? [{ id: 'liveNow', label: t('browse.home.rows.liveNow') }] : []),
    ...hubs.map((h) => ({ id: hubId(h), label: h.name, server: multi ? serverName(h.sid) : undefined })),
    ...libs.map((l) => ({ id: `latest:${libraryRef(l)}`, label: t('browse.home.rows.latest', { name: l.Name }), server: multi ? serverName(l.ServerId) : undefined })),
    ...(hasPhotos ? [{ id: 'memories', label: t('photos.memories.title') }] : []),
    { id: 'because', label: t('browse.home.rows.becauseAny') },
    { id: 'favorites', label: t('browse.home.rows.favorites') },
    { id: 'playlists', label: t('browse.home.rows.playlists') },
    { id: 'collections', label: t('browse.home.rows.collections') },
    { id: 'libraries', label: t('browse.home.rows.libraries') },
  ]);
  const userKey = $derived(`${session.value.server?.id ?? ''}/${session.value.user?.id ?? ''}`);
  const pref = $derived(settings.value?.ui.homeRows?.find((p) => p.user === userKey));
  const hidden = $derived(new Set(pref?.hidden ?? []));
  const rows = $derived.by(() => {
    if (!pref) return defs;
    const byId = new Map(defs.map((d) => [d.id, d]));
    const out = pref.order.filter((id) => byId.has(id));
    // Rows the saved order does not know (a new library) slot in after their default neighbour.
    defs.forEach((d, i) => {
      if (out.includes(d.id)) return;
      out.splice(i === 0 ? 0 : out.indexOf(defs[i - 1].id) + 1, 0, d.id);
    });
    return out.map((id) => byId.get(id)!);
  });
  const shown = $derived(rows.filter((r) => !hidden.has(r.id)));

  function savePref(order: string[], hide: string[]): void {
    const others = (settings.value?.ui.homeRows ?? []).filter((p) => p.user !== userKey);
    void updateSettings({ ui: { homeRows: [...others, { user: userKey, order, hidden: hide }] } });
  }

  function resetPref(): void {
    void updateSettings({ ui: { homeRows: (settings.value?.ui.homeRows ?? []).filter((p) => p.user !== userKey) } });
  }

  // A slower earlier load (another server set, another user) must not overwrite a newer one.
  let loadSeq = 0;

  async function load(): Promise<void> {
    if (session.value.status !== 'signed-in') return;
    const gen = ++loadSeq;
    const current = () => gen === loadSeq;
    // Read the rows now: deriveds must not be read after an await (the page may be gone).
    const wanted = new Set(shown.map((r) => r.id));
    const wants = (id: string) => wanted.has(id);
    const libList = libs.filter((l) => wants(`latest:${libraryRef(l)}`));
    const liveServers = liveTv.servers;
    const merged = mergeOn && wants('resume');
    const hiddenList = settings.value?.ui.continueHidden ?? [];
    const airs = (x: BaseItem) => Date.parse(x.PremiereDate ?? '') || 0;
    // Every row asks each signed-in server at once and fills in as answers arrive: no row waits for
    // another, nor for a slow server (fanOut's `each`); a server that is down only leaves its part out.
    const rows: Promise<unknown>[] = [];
    function row<T extends { Items?: BaseItem[] } | null>(on: boolean, fn: (a: Api, sid: string) => Promise<T>, set: (lists: BaseItem[][]) => void): void {
      if (!on) return set([]);
      rows.push(fanOut(fn, (parts) => current() && set(parts.map((x) => x?.Items ?? []))));
    }
    row(true, (a) => a.resume(24), (l) => (resume = merge(l, true)));
    row(wants('nextUp'), (a) => a.nextUp(24), (l) => (nextUp = merge(l, true)));
    row(wants('upcoming'), (a) => a.upcoming(24), (l) => (upcoming = merge(l).sort((a, b) => airs(a) - airs(b))));
    row(
      wants('favorites'),
      (a) => a.items({ Filters: 'IsFavorite', Recursive: true, IncludeItemTypes: 'Movie,Series,Episode,MusicAlbum,BoxSet,Book', SortBy: 'SortName', Limit: 24 }),
      (l) => (favorites = merge(l)),
    );
    row(wants('playlists'), (_, s) => listOf('playlist', s), (l) => (playlists = merge(l)));
    // Server hubs: Continue Watching and On Deck are the row above already.
    rows.push(
      fanOut(
        (a, sid) => a.hubs().then((list) => list.filter((h) => !/continue|ondeck/i.test(h.Key)).map((h) => ({ sid, key: h.Key, name: h.Name, items: h.Items }))),
        (parts) => current() && (hubs = parts.flatMap((x) => x ?? [])),
      ),
    );
    row(wants('collections'), (_, s) => listOf('collection', s), (l) => (collections = merge(l)));
    if (merged) {
      // Per server: its resume and next-up lists (the same cached requests as the rows above), then the
      // last played dates of its next-up series, so its cards land once, in their final order.
      const dates: SeriesDates = new Map();
      rows.push(
        fanOut(
          async (a) => {
            const [r, n] = await Promise.all([a.resume(24).catch(() => null), a.nextUp(24).catch(() => null)]);
            const both = [...(r?.Items ?? []), ...(n?.Items ?? [])];
            for (const [k, v] of await loadSeriesDates(both)) dates.set(k, v);
            return { r: r?.Items ?? [], n: n?.Items ?? [] };
          },
          (parts) => {
            if (!current()) return;
            seriesDates = dates;
            cont = mergeContinue(merge(parts.map((x) => x?.r)), merge(parts.map((x) => x?.n)), dates).filter((it) => {
              const uid = sessionFor(it.ServerId)?.user?.id;
              return !uid || !isHidden(hiddenList, hiddenKey(it, uid), recency(it, dates));
            });
          },
        ),
      );
    }
    if (wants('liveNow')) {
      rows.push(
        Promise.all(liveServers.map((s) => live.channels(24, s).catch(() => null))).then((ch) => {
          if (current()) channels = (merge(ch.map((x) => x?.Items)) as LiveChannel[]).filter((x) => x.CurrentProgram);
        }),
      );
    } else channels = [];
    if (wants('memories')) {
      const today = localDay();
      let fromServers: (MemoryGroup[] | null)[] = [];
      let fromSources: (MemoryGroup[] | null)[] = [];
      const show = () => {
        if (!current()) return;
        // One card per year across servers and photo sources, nearest first.
        const byYear = new Map<number, MemoryGroup>();
        for (const g of [...fromServers, ...fromSources].flatMap((x) => x ?? [])) {
          const m = byYear.get(g.yearsAgo);
          byYear.set(g.yearsAgo, m ? { ...m, assets: [...m.assets, ...g.assets] } : g);
        }
        memories = [...byYear.values()].sort((a, b) => a.yearsAgo - b.yearsAgo);
      };
      rows.push(fanOut((_, sid) => memoriesOf(sid, today), (parts) => ((fromServers = parts), show())));
      rows.push(Promise.all(photoSources.map((sid) => memoriesOf(sid, today).catch(() => null))).then((parts) => ((fromSources = parts), show())));
    } else memories = [];
    // Each library's row as soon as its own answer lands; the set is replaced at the end (rows removed meanwhile go).
    const fresh: Record<string, BaseItem[]> = {};
    for (const l of libList) {
      const ref = libraryRef(l);
      rows.push(
        apiFor(l.ServerId)
          .latest(l.Id, 24)
          .catch(() => [] as BaseItem[])
          .then((items) => {
            fresh[ref] = dedupe(items);
            if (current()) latest = { ...latest, [ref]: fresh[ref] };
          }),
      );
    }
    // Similar titles to the 2 latest watched, asked at once; shown last, minus what the other rows
    // (and the first one) show, so it waits for them.
    const similar = wants('because')
      ? fanOut((a) => a.items({ Filters: 'IsPlayed', Recursive: true, IncludeItemTypes: 'Movie,Episode', SortBy: 'DatePlayed', SortOrder: 'Descending', Limit: 20 })).then((played) => {
          const seeds = becauseSeeds(merge(played.map((x) => x?.Items), true));
          return Promise.all(seeds.map((s) => apiFor(s.ServerId).similar(s.Id, 16).then((r) => ({ seed: s, items: r.Items }), () => ({ seed: s, items: [] as BaseItem[] }))));
        })
      : Promise.resolve([]);
    const [found] = await Promise.all([similar, ...rows]);
    if (!current()) return;
    latest = fresh;
    let shownItems = [...resume, ...nextUp, ...cont, ...favorites, ...Object.values(latest).flat()];
    because = found.map(({ seed, items }) => {
      const kept = unseen(items, shownItems);
      shownItems = [...shownItems, ...kept];
      return { seed, items: kept };
    });
    loading = false;
    last = { resume, nextUp, cont, upcoming, latest, because, favorites, playlists, collections, live: channels, memories, hubs };
  }

  // Reloads only when what the rows show can change; a string, so a session or settings update that
  // changes none of it (a socket connecting, another server going offline) does not restart the load.
  const loadKey = $derived(
    [
      dataVersion.userData,
      dataVersion.library,
      shown.map((r) => r.id).join(),
      onlineSessions().map((s) => `${s.server.id}/${s.user?.id}`).join(),
      mergeOn,
      filesOn ? fileSessions().map((s) => `${s.server.id}:${s.status}`).join() : '',
      photoSources.join(),
      liveTv.servers.join(),
      JSON.stringify(settings.value?.ui.continueHidden ?? []),
    ].join('|'),
  );
  $effect(() => {
    void loadKey;
    untrack(() => void load());
  });

  // Last played date of each series with a next-up card: one batched call per server.
  async function loadSeriesDates(items: BaseItem[]): Promise<SeriesDates> {
    const byServer = new Map<string, Set<string>>();
    for (const it of items) {
      if (!it.SeriesId || !it.ServerId || inProgress(it)) continue;
      if (!byServer.has(it.ServerId)) byServer.set(it.ServerId, new Set());
      byServer.get(it.ServerId)!.add(it.SeriesId);
    }
    const out: SeriesDates = new Map();
    await Promise.all(
      [...byServer].map(([sid, ids]) =>
        apiFor(sid)
          .seriesUserData([...ids])
          .then((res) => res.Items.forEach((s) => s.UserData?.LastPlayedDate && out.set(itemKey(s), s.UserData.LastPlayedDate)))
          // Without dates the next-up cards keep the server order, after the dated ones.
          .catch(() => undefined),
      ),
    );
    return out;
  }

  const inProgress = (it: BaseItem) => (it.UserData?.PlaybackPositionTicks ?? 0) > 0;

  function contSubtitle(it: BaseItem): string {
    if (inProgress(it)) {
      const left = (it.RunTimeTicks ?? 0) - (it.UserData?.PlaybackPositionTicks ?? 0);
      return [it.Type === 'Episode' ? episodeCode(it) : '', left > 0 ? t('browse.home.card.timeLeft', { time: runtime(left) }) : ''].filter(Boolean).join(' · ');
    }
    if (it.Type === 'Episode' && it.IndexNumber !== undefined) return t('browse.home.card.nextEpisode', { season: it.ParentIndexNumber ?? 0, episode: it.IndexNumber });
    return it.ProductionYear ? String(it.ProductionYear) : '';
  }

  // Emby also hides an in-progress item on the server (a 404 there means unsupported: the local list covers it);
  // next-up cards and Jellyfin hide locally only. Played again, the card comes back (continue.ts isHidden).
  async function removeFromContinue(it: BaseItem): Promise<void> {
    const uid = sessionFor(it.ServerId)?.user?.id;
    if (!uid) return;
    const key = hiddenKey(it, uid);
    const emby = sessionFor(it.ServerId)?.server.kind !== 'jellyfin' && inProgress(it);
    cont = cont.filter((x) => x !== it);
    await updateSettings({ ui: { continueHidden: withHidden(settings.value?.ui.continueHidden ?? [], key, recency(it, seriesDates)) } });
    if (emby) void apiFor(it.ServerId).hideFromResume(it.Id, true).catch(() => undefined);
    toast(
      'info',
      t('item.toast.removedFromContinue'),
      {
        label: t('common.undo'),
        // Un-hidden on the server first, so the reload that follows the settings change finds it again.
        run: async () => {
          if (emby) await apiFor(it.ServerId).hideFromResume(it.Id, false).catch(() => undefined);
          void updateSettings({ ui: { continueHidden: withoutHidden(settings.value?.ui.continueHidden ?? [], key) } });
        },
      },
      5000,
    );
  }

  // ---- Featured banner (#19): Automatic follows the rows above; any other source asks the servers itself ----
  const heroFeed = $derived(settings.value?.ui.hero);
  // null: the Automatic banner. undefined: the chosen source is loading, and nothing shows rather than the Automatic
  // titles swapped out a moment later. Random starts empty on each visit; the other sources show their last set again.
  const startFeed = settings.value?.ui.hero;
  let heroPicked = $state<BaseItem[] | null | undefined>(
    !startFeed || startFeed.source === 'auto'
      ? null
      : startFeed.source !== 'random' && lastHero?.feed === JSON.stringify(startFeed)
        ? lastHero.items
        : undefined,
  );
  let heroSeq = 0;

  // keep: the shuffle button, which leaves the shown set (and the focus in it) until the new one is in.
  async function loadHero(keep = false): Promise<void> {
    const feed = heroFeed;
    const gen = ++heroSeq;
    const parents =
      feed && feed.source !== 'auto' && settings.value?.ui.heroEnabled !== false
        ? heroParents(feed, libraries.list, (sid) => sessionFor(sid)?.status === 'signed-in' && heroQueryable(sessionFor(sid)?.server.kind))
        : [];
    // No server that takes the query (Plex only, say): the Automatic banner. No library yet (a cold start, the
    // views still loading): wait for them rather than show the Automatic banner and swap it out.
    if (!feed || parents.length === 0) {
      const waiting = feed && feed.source !== 'auto' && settings.value?.ui.heroEnabled !== false && libraries.list.length === 0 && feed.collections.length === 0;
      heroPicked = waiting ? undefined : null;
    } else {
      const key = JSON.stringify(feed);
      if (!keep && (heroPicked === null || feed.source === 'random' || lastHero?.feed !== key)) heroPicked = undefined;
      // Random asks again each time, past the request cache: a new set on every visit and shuffle.
      const lists = await Promise.all(parents.map((p) => apiFor(p.serverId).items({ ...heroQuery(feed, p.id), Fields: `${LIST_FIELDS},Genres` }, feed.source === 'random').then((r) => r.Items ?? [], () => [] as BaseItem[])));
      const series = await seriesGenres(seriesToAsk(lists.flat(), feed));
      if (gen !== heroSeq) return;
      heroPicked = pickFeatured(lists, feed, series);
      lastHero = { feed: key, items: heroPicked };
    }
  }

  // Excluded genres on episodes: their series' genres, one request per server (Emby and Jellyfin only).
  async function seriesGenres(episodes: BaseItem[]): Promise<SeriesGenres> {
    const out: SeriesGenres = new Map();
    const eps = episodes.filter((it) => it.ServerId && heroQueryable(sessionFor(it.ServerId)?.server.kind));
    await Promise.all(
      [...new Set(eps.map((it) => it.ServerId!))].map((sid) =>
        apiFor(sid)
          .items({ Ids: [...new Set(eps.filter((it) => it.ServerId === sid).map((it) => it.SeriesId))].join(','), Fields: 'Genres' })
          .then((r) => r.Items?.forEach((x) => out.set(x.Id, x.Genres ?? [])), () => undefined),
      ),
    );
    return out;
  }

  // The same for the Automatic banner's in-progress episodes.
  let resumeSeries = $state<SeriesGenres>();
  let seriesSeq = 0;
  $effect(() => {
    const ask = heroPicked === null && heroFeed ? seriesToAsk(resume, heroFeed) : [];
    const gen = ++seriesSeq;
    untrack(() => void seriesGenres(ask).then((m) => gen === seriesSeq && (resumeSeries = m)));
  });

  // Random re-rolls on a visit, a settings change or the shuffle button only: not on every played or favourite
  // change, which would swap the banner under the pointer.
  const heroKey = $derived(
    [
      JSON.stringify(heroFeed ?? null),
      settings.value?.ui.heroEnabled,
      onlineSessions().map((s) => s.server.id).join(),
      libraries.list.map(itemKey).join(),
      heroFeed?.source === 'random' ? '' : `${dataVersion.userData}.${dataVersion.library}`,
    ].join('|'),
  );
  $effect(() => {
    void heroKey;
    untrack(() => void loadHero());
  });

  const featured = $derived.by(() => {
    if (heroPicked !== null) return heroPicked ?? [];
    const feed = heroFeed;
    return feed ? autoFeatured(resume, Object.values(latest).flat(), feed, resumeSeries) : [];
  });

  function variantFor(lib: BaseItem): 'poster' | 'square' {
    return lib.CollectionType === 'music' ? 'square' : 'poster';
  }

  function iconFor(lib: BaseItem): IconName {
    switch (lib.CollectionType) {
      case 'movies':
        return 'film'; // i18n-ignore
      case 'tvshows':
        return 'tv';
      case 'music':
        return 'music';
      case 'books':
        return 'book';
      case 'boxsets':
        return 'collection';
      case 'livetv':
        return 'live';
      default:
        return 'folder';
    }
  }

  const empty = $derived(
    !loading &&
      [resume, nextUp, cont, upcoming, favorites, playlists, collections, channels, memories, ...because.map((b) => b.items), ...hubs.map((h) => h.items)].every((l) => l.length === 0) &&
      Object.values(latest).every((l) => l.length === 0),
  );
</script>

<div class="home">
  {#if featured.length > 0 && settings.value?.ui.heroEnabled !== false}
    <svelte:boundary onerror={(e) => console.error('home hero:', e)}>
      <Hero
        items={featured}
        eyebrow={heroPicked ? undefined : (i) => ((i.UserData?.PlaybackPositionTicks ?? 0) > 0 ? t('browse.home.eyebrow.resume') : t('browse.home.eyebrow.new'))}
        onshuffle={heroPicked && heroFeed?.source === 'random' ? () => loadHero(true) : undefined}
      />
      {#snippet failed()}<div class="spacer"></div>{/snippet}
    </svelte:boundary>
  {:else}
    <div class="spacer"></div>
  {/if}

  {#if shuffleOn}
    <div class="discover">
      <button class="btn" onclick={() => navigate('/shuffle')}><Icon name="shuffle" size={15} /> {t('browse.shuffle.homeButton')}</button>
    </div>
  {/if}

  {#each shown as row (row.id)}
    <!-- One row failing (bad data from a server) leaves the others and the page working. -->
    <svelte:boundary onerror={(e) => console.error(`home row ${row.id}:`, e)}>
    {#if row.id === 'resume' && mergeOn}
      {#if cont.length > 0 || loading}
        <Row title={t('browse.home.rows.continueMerged')} variant="thumb" loading={loading && cont.length === 0}>
          {#each cont as item, i (itemKey(item))}
            <div
              class="cell cont"
              role="presentation"
              animate:flip={{ duration: dur('med') }}
              out:scale={{ duration: dur('fast'), start: 0.9 }}
              oncontextmenu={(e) => {
                e.preventDefault();
                menuFor = itemKey(item);
              }}
            >
              <Card {item} variant="thumb" showServer={multi} subtitle={contSubtitle(item)} />
              <ItemMenu
                {item}
                compact
                onremove={() => void removeFromContinue(item)}
                bind:open={() => menuFor === itemKey(item), (v) => (menuFor = v ? itemKey(item) : menuFor === itemKey(item) ? null : menuFor)}
              />
            </div>
          {/each}
        </Row>
      {/if}
    {:else if row.id === 'resume'}
      <Row title={t('browse.home.rows.continue')} items={resume} variant="thumb" loading={loading && resume.length === 0} showServer={multi} />
    {:else if row.id === 'nextUp'}
      <Row title={t('browse.home.rows.nextUp')} items={nextUp} variant="thumb" showServer={multi} />
    {:else if row.id === 'upcoming'}
      <Row title={t('browse.home.rows.upcoming')} items={upcoming} variant="thumb" showServer={multi} />
    {:else if row.id === 'because'}
      {#each because as b (itemKey(b.seed))}
        <Row title={t('browse.home.rows.because', { name: b.seed.Name })} items={b.items} showServer={multi} />
      {/each}
    {:else if row.id === 'liveNow'}
      {#if channels.length > 0}
        <Row title={t('browse.home.rows.liveNow')} variant="thumb" href="/livetv">
          {#each channels as c, i (itemKey(c))}
            <div class="cell"><ChannelTile channel={c} /></div>
          {/each}
        </Row>
      {/if}
    {:else if row.id === 'memories'}
      <MemoryCards groups={memories} />
    {:else if row.id === 'favorites'}
      <Row title={t('browse.home.rows.favorites')} items={favorites} href="/favorites" showServer={multi} />
    {:else if row.id === 'playlists'}
      <Row title={t('browse.home.rows.playlists')} items={playlists} variant="square" showServer={multi} />
    {:else if row.id === 'collections'}
      <Row title={t('browse.home.rows.collections')} items={collections} showServer={multi} />
    {:else if row.id.startsWith('hub:')}
      {@const hub = hubs.find((h) => hubId(h) === row.id)}
      {#if hub}<Row title={hub.name} items={hub.items} showServer={multi} />{/if}
    {:else if row.id === 'libraries'}
      {#if libs.length > 0}
        <Row title={t('browse.home.rows.libraries')} variant="thumb">
          {#each libs as lib, i (itemKey(lib))}
            <a
              class="lib"
              href={`#${itemPath(lib, 'library')}`}
              onclick={(e) => {
                e.preventDefault();
                navigate(itemPath(lib, 'library'));
              }}
            >
              <span class="lib-media">
                {#if lib.ImageTags?.Primary}
                  <img class="reveal" use:reveal src={imageUrl(lib.Id, 'Primary', { tag: lib.ImageTags.Primary, maxWidth: 400, server: lib.ServerId })} alt="" loading="lazy" decoding="async" />
                {/if}
                <span class="lib-scrim"></span>
                <span class="lib-label">
                  <Icon name={iconFor(lib)} size={18} stroke={2} />
                  {lib.Name}
                  {#if ambiguous(lib)}<span class="lib-server">{serverName(lib.ServerId)}</span>{/if}
                </span>
              </span>
            </a>
          {/each}
        </Row>
      {/if}
    {:else}
      {@const lib = libs.find((l) => `latest:${libraryRef(l)}` === row.id)}
      {#if lib}
        {@const ref = libraryRef(lib)}
        <Row title={t('browse.home.rows.latest', { name: libLabel(lib) })} items={latest[ref] ?? []} variant={variantFor(lib)} href={itemPath(lib, 'library')} loading={loading && !latest[ref]} />
      {/if}
    {/if}
    {#snippet failed()}{/snippet}
    </svelte:boundary>
  {/each}

  {#if empty}
    <div class="empty">
      <Icon name="film" size={44} stroke={1.4} />
      <h2 class="title-2">{t('browse.home.empty.title')}</h2>
      <p class="footnote">{t('browse.home.empty.body')}</p>
    </div>
  {/if}

  <div class="customize">
    <button class="btn" onclick={() => (customizing = true)}><Icon name="customize" size={15} /> {t('browse.home.customize')}</button>
  </div>
</div>

<HomeSheet
  open={customizing}
  {rows}
  {hidden}
  mergeContinue={mergeOn}
  onmerge={(v) => void updateSettings({ ui: { mergeContinue: v } })}
  onchange={savePref} onreset={resetPref} onclose={() => (customizing = false)} />

<style>
  .home {
    padding-bottom: 56px;
  }
  .spacer {
    height: 28px;
  }
  .cell {
    width: var(--card-w);
  }
  .cont {
    position: relative;
  }
  .cont :global(.compact) {
    opacity: 0;
    transition: opacity var(--t-fast) var(--ease);
  }
  .cont:hover :global(.compact),
  .cont:focus-within :global(.compact),
  .cont :global(.compact:has([aria-expanded='true'])) {
    opacity: 1;
  }
  .discover {
    padding: 0 var(--gutter) 8px;
  }
  .customize {
    display: flex;
    justify-content: center;
    padding: 20px var(--gutter) 0;
  }
  .customize .btn {
    color: var(--label-2);
  }
  .customize .btn:hover,
  .customize .btn:focus-visible {
    color: var(--label);
  }
  .lib {
    position: relative;
    display: block;
    width: var(--card-w);
    aspect-ratio: 16 / 9;
    isolation: isolate;
    border-radius: var(--r-md);
    transition: transform var(--t-slow) var(--spring);
  }
  .lib::after {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    border-radius: inherit;
    box-shadow: var(--shadow-3);
    opacity: 0;
    transition: opacity var(--t-med) var(--ease);
  }
  .lib-media {
    position: absolute;
    inset: 0;
    overflow: hidden;
    border-radius: inherit;
    background: linear-gradient(150deg, var(--bg-elevated-2), var(--bg-elevated));
  }
  .lib img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .lib-scrim {
    position: absolute;
    inset: 0;
    background: linear-gradient(to top, rgb(0 0 0 / 0.7), transparent 60%);
  }
  .lib-server {
    font-size: var(--fs-footnote);
    font-weight: 500;
    color: var(--label-2);
  }
  .lib-label {
    position: absolute;
    left: 16px;
    bottom: 14px;
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: var(--fs-title-3);
    font-weight: 650;
    letter-spacing: -0.014em;
  }
  .lib:hover,
  .lib:focus-visible {
    z-index: 1;
    will-change: transform;
    transform: scale(1.05);
  }
  .lib:hover::after,
  .lib:focus-visible::after {
    opacity: 1;
  }
  .lib:focus-visible {
    border-radius: var(--r-md);
  }
  .empty {
    display: grid;
    justify-items: center;
    gap: 6px;
    padding: 96px var(--gutter);
    text-align: center;
    color: var(--label-3);
  }
  .empty h2 {
    margin: 12px 0 0;
    color: var(--label);
  }
  .empty p {
    margin: 0;
  }
</style>
