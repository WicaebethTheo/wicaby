<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { Query } from '../../shared/contract';
  import type { BaseItem, ItemsResult } from '../../shared/models';
  import BrowseMenu from '../components/BrowseMenu.svelte';
  import Card from '../components/Card.svelte';
  import Icon from '../components/Icon.svelte';
  import MusicArt from '../components/music/MusicArt.svelte';
  import SongList from '../components/music/SongList.svelte';
  import Toggle from '../components/Toggle.svelte';
  import { apiFor, dedupe, itemKey, itemPath } from '../lib/api';
  import { t } from '../lib/i18n.svelte';
  import { posterUrl } from '../lib/images';
  import { isMusicItem, placeholderBg } from '../lib/music-art';
  import { entering, scrollMemory } from '../lib/motion';
  const enter = entering();
  import { albums, artists, genres, years } from '../lib/music';
  import { musicSourceOptions, playMix, playTracks } from '../lib/music-ui.svelte';
  import { queue } from '../lib/queue.svelte';
  import { navigate, router } from '../lib/router.svelte';
  import { errorMessage, libraries, settings, updateSettings } from '../lib/stores.svelte';

  // A music library (music-spec MU-03, §4.3): Albums, Artists, Songs, Genres, Playlists and Folders tabs. The tab,
  // the album sort and view, and the artists toggle are kept per library (restored on the way back).
  let { lib, server }: { lib: BaseItem; server?: string } = $props();
  const id = untrack(() => lib.Id);
  const api = apiFor(untrack(() => server));

  type Tab = 'albums' | 'artists' | 'songs' | 'genres' | 'playlists' | 'folders';
  const TABS: Tab[] = ['albums', 'artists', 'songs', 'genres', 'playlists', 'folders'];
  const SORTS = [
    { key: 'SortName', label: () => t('browse.library.sort.name') },
    { key: 'AlbumArtist', label: () => t('music.sort.albumArtist') },
    { key: 'ProductionYear', label: () => t('browse.library.sort.year') },
    { key: 'DateCreated', label: () => t('browse.library.sort.dateAdded') },
    { key: 'PlayCount', label: () => t('music.sort.playCount') },
    { key: 'Random', label: () => t('music.sort.random') },
  ];
  const PAGE = 100;
  const STORE_KEY = 'wicaby.music.prefs';

  interface Prefs {
    tab: Tab;
    sort: string;
    desc: boolean;
    view: 'grid' | 'list';
    albumArtistsOnly: boolean;
  }
  function loadPrefs(): Prefs {
    const fallback: Prefs = { tab: 'albums', sort: 'SortName', desc: false, view: 'grid', albumArtistsOnly: true };
    try {
      const saved = (JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Record<string, Partial<Prefs>>)[id] ?? {};
      return { ...fallback, ...saved, tab: TABS.includes(saved.tab as Tab) ? (saved.tab as Tab) : 'albums' };
    } catch {
      return fallback;
    }
  }
  const prefs = $state<Prefs>(loadPrefs());
  // A link to a tab (the sidebar's "All playlists", music spec C5).
  const linkedTab = untrack(() => router.route.query.get('tab')) as Tab | null;
  if (linkedTab && TABS.includes(linkedTab)) prefs.tab = linkedTab;
  $effect(() => {
    const snapshot = JSON.stringify(prefs);
    try {
      const all = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Record<string, unknown>;
      all[id] = JSON.parse(snapshot);
      localStorage.setItem(STORE_KEY, JSON.stringify(all));
    } catch {
      // Best effort, like the Library page's prefs.
    }
  });

  let favorites = $state(false);
  let genre = $state<BaseItem | null>(null);
  // Folders tab: the path from the library root.
  let folders = $state<BaseItem[]>([]);
  let genreList = $state<BaseItem[]>([]);
  // Years filter (MU-03): a decade, the first year of it; the decades are those the library's albums cover.
  let decade = $state<number | null>(null);
  let decades = $state<number[]>([]);
  const yearsParam = () => (decade === null ? undefined : Array.from({ length: 10 }, (_, i) => decade! + i).join(','));

  let items = $state<BaseItem[]>([]);
  let total = $state(0);
  let loading = $state(true);
  let error = $state('');
  let sentinel = $state<HTMLDivElement>();
  let generation = 0;
  // Items the server sent again (dropped by dedupe): the next page starts after them.
  let repeated = 0;

  const albumQuery = (): Query => ({
    SortBy: prefs.sort === 'SortName' ? 'SortName' : `${prefs.sort},SortName`,
    SortOrder: prefs.desc ? 'Descending' : 'Ascending',
    Filters: favorites ? 'IsFavorite' : undefined,
    Genres: genre?.Name,
    Years: yearsParam(),
  });
  const songQuery = $derived<Query>({ Filters: favorites ? 'IsFavorite' : undefined, Genres: genre?.Name, Years: yearsParam() });

  function fetchPage(start: number): Promise<ItemsResult> {
    const page = { StartIndex: start, Limit: PAGE };
    switch (prefs.tab) {
      case 'albums':
        return albums(id, { ...albumQuery(), ...page }, server);
      case 'artists':
        return artists(id, prefs.albumArtistsOnly, page, server);
      case 'genres':
        return genres(id, server);
      case 'playlists':
        // Playlists live in their own library: the audio ones are this tab.
        return api.items({ IncludeItemTypes: 'Playlist', Recursive: true, SortBy: 'SortName' }).then((r) => {
          const audio = r.Items.filter((p) => !p.MediaType || p.MediaType === 'Audio');
          return { Items: audio, TotalRecordCount: audio.length };
        });
      case 'folders':
        return api.items({ ParentId: folders.at(-1)?.Id ?? id, SortBy: 'IsFolder,SortName', ...page });
      default:
        return Promise.resolve({ Items: [], TotalRecordCount: 0 });
    }
  }
  // Genres and playlists come in one answer: no paging.
  const paged = () => ['albums', 'artists', 'folders'].includes(prefs.tab);

  async function reset(): Promise<void> {
    const gen = ++generation;
    loading = true;
    error = '';
    items = [];
    total = 0;
    repeated = 0;
    if (prefs.tab === 'songs') return void (loading = false);
    try {
      const r = await fetchPage(0);
      if (gen !== generation) return;
      items = dedupe(r.Items);
      repeated = r.Items.length - items.length;
      total = r.TotalRecordCount;
    } catch (err) {
      if (gen === generation) error = errorMessage(err);
    } finally {
      if (gen === generation) loading = false;
    }
  }

  async function more(): Promise<void> {
    if (loading || !paged() || items.length + repeated >= total) return;
    const gen = generation;
    loading = true;
    try {
      const r = await fetchPage(items.length + repeated);
      if (gen === generation) {
        const next = dedupe([...items, ...r.Items]);
        repeated += items.length + r.Items.length - next.length;
        // A page with nothing new (a Random sort reshuffles every request): the end, not a request loop.
        if (next.length === items.length) total = items.length + repeated;
        items = next;
      }
    } catch (err) {
      if (gen === generation) error = errorMessage(err);
    } finally {
      if (gen === generation) loading = false;
    }
  }

  $effect(() => {
    void prefs.tab;
    void prefs.sort;
    void prefs.desc;
    void prefs.albumArtistsOnly;
    void favorites;
    void genre;
    void decade;
    void folders.length;
    // Only the deps above: reset() also reads stores that change when a track starts playing.
    untrack(() => void reset());
  });

  $effect(() => {
    if (!sentinel || loading || error) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && void more(), { root: document.getElementById('main-scroller'), rootMargin: '1200px 0px' });
    io.observe(sentinel);
    return () => io.disconnect();
  });

  // The genre menu of the Albums and Songs tabs.
  $effect(() => {
    void untrack(() => genres(id, server))
      .then((r) => (genreList = r.Items ?? []))
      .catch(() => (genreList = []));
  });

  $effect(() => {
    void untrack(() => years(id, server))
      .then((r) => (decades = [...new Set((r.Items ?? []).map((y) => y.ProductionYear ?? Number(y.Name)).filter((y) => y > 1800).map((y) => y - (y % 10)))].sort((a, b) => b - a)))
      .catch(() => (decades = []));
  });

  onMount(scrollMemory);

  function openGenre(g: BaseItem): void {
    genre = g;
    prefs.tab = 'albums';
  }

  // Header actions: shuffle everything under the current filter; Mix from the selected genre.
  async function shuffleAll(): Promise<void> {
    if (!genre && !favorites && decade === null) return void queue({ ...lib, ServerId: lib.ServerId ?? server }, 'shuffle');
    const r = await api.items({ ParentId: id, Recursive: true, IncludeItemTypes: 'Audio', SortBy: 'Random', Limit: 300, Genres: genre?.Name, Filters: favorites ? 'IsFavorite' : undefined, Years: yearsParam() });
    await playTracks(r.Items.map((x) => x.Id), 0, server);
  }

  function openFolderEntry(it: BaseItem): void {
    if (it.Type === 'Audio') {
      const audio = items.filter((x) => x.Type === 'Audio');
      return void playTracks(audio.map((x) => x.Id), audio.indexOf(it), server);
    }
    if (it.Type === 'Folder' || it.Type === 'CollectionFolder') folders = [...folders, it];
    else navigate(itemPath(it));
  }

  // Quick switch of the music source (Settings > Music) when several servers have music: sets it, then opens the
  // chosen server's first music library (Auto: the first of all).
  const sources = $derived(musicSourceOptions());
  async function switchSource(v: string): Promise<void> {
    await updateSettings({ music: { source: v } });
    const to = libraries.all.find((l) => l.CollectionType === 'music' && (!v || l.ServerId === v));
    if (to && to.Id !== lib.Id) navigate(itemPath(to, 'library'));
  }

  const sortLabel = $derived(SORTS.find((s) => s.key === prefs.sort)?.label() ?? t('browse.library.sort.name'));
</script>

<div class="music">
  <header class="head">
    <h1 class="large-title">{lib.Name}</h1>
    <div class="spacer"></div>
    {#if sources.length > 2}
      <BrowseMenu
        label={sources.find((o) => o.value === (settings.value?.music.source ?? ''))?.label ?? ''}
        icon="server"
        align="end"
        options={sources.map((o) => ({ value: o.value, label: o.label, checked: o.value === (settings.value?.music.source ?? '') }))}
        onselect={(v) => void switchSource(v)}
      />
    {/if}
    {#if genre}
      <button class="btn mix" data-genre-mix onclick={() => genre && playMix(genre)}><Icon name="sparkles" size={15} /> {t('music.actions.mix')}</button>
    {/if}
    <button class="btn shuffle" data-shuffle-all onclick={shuffleAll}><Icon name="shuffle" size={15} stroke={2} /> {t('music.actions.shuffle')}</button>
  </header>

  <div class="toolbar">
    <div class="segmented" role="tablist" aria-label={t('music.tabs.label')}>
      {#each TABS as tab (tab)}
        <button role="tab" data-tab={tab} class:on={prefs.tab === tab} aria-selected={prefs.tab === tab} onclick={() => (prefs.tab = tab)}>{t(`music.tabs.${tab}`)}</button>
      {/each}
    </div>
    <div class="spacer"></div>
    {#if prefs.tab === 'albums' || prefs.tab === 'songs'}
      <button class="btn chip-btn" class:on={favorites} aria-pressed={favorites} onclick={() => (favorites = !favorites)}>
        <Icon name="heart" size={14} fill={favorites} stroke={favorites ? 0 : 1.9} /> {t('music.filters.favorites')}
      </button>
      {#if genreList.length}
        <BrowseMenu
          label={genre?.Name ?? t('music.filters.genre')}
          icon="filter"
          active={Boolean(genre)}
          align="end"
          options={[{ value: '', label: t('music.filters.allGenres'), checked: !genre }, ...genreList.map((g, i) => ({ value: g.Id, label: g.Name, checked: genre?.Id === g.Id, section: i === 0 ? (true as const) : undefined }))]}
          onselect={(v) => (genre = genreList.find((g) => g.Id === v) ?? null)}
        />
      {/if}
      {#if decades.length > 1}
        <BrowseMenu
          label={decade === null ? t('music.filters.yearRange') : t('music.filters.decade', { decade })}
          icon="calendar"
          active={decade !== null}
          align="end"
          options={[{ value: '', label: t('music.filters.allYears'), checked: decade === null }, ...decades.map((d, i) => ({ value: String(d), label: t('music.filters.decade', { decade: d }), checked: decade === d, section: i === 0 ? (true as const) : undefined }))]}
          onselect={(v) => (decade = v ? Number(v) : null)}
        />
      {/if}
    {/if}
    {#if prefs.tab === 'albums'}
      <BrowseMenu
        label={sortLabel}
        icon="sort"
        align="end"
        options={[
          ...SORTS.map((s) => ({ value: s.key, label: s.label(), checked: prefs.sort === s.key })),
          { value: 'asc', label: t('browse.library.order.asc'), checked: !prefs.desc, section: t('browse.library.order.label') },
          { value: 'desc', label: t('browse.library.order.desc'), checked: prefs.desc },
        ]}
        onselect={(v) => (v === 'asc' || v === 'desc' ? (prefs.desc = v === 'desc') : (prefs.sort = v))}
      />
      <div class="views" role="group" aria-label={t('music.view.label')}>
        <button class="btn icon" data-view="grid" aria-pressed={prefs.view === 'grid'} title={t('music.view.grid')} aria-label={t('music.view.grid')} onclick={() => (prefs.view = 'grid')}><Icon name="grid" size={16} /></button>
        <button class="btn icon" data-view="list" aria-pressed={prefs.view === 'list'} title={t('music.view.list')} aria-label={t('music.view.list')} onclick={() => (prefs.view = 'list')}><Icon name="list" size={16} /></button>
      </div>
    {/if}
    {#if prefs.tab === 'artists'}
      <span class="toggle-row">
        <span class="callout">{t('music.filters.albumArtistsOnly')}</span>
        <Toggle checked={prefs.albumArtistsOnly} label={t('music.filters.albumArtistsOnly')} onchange={(v) => (prefs.albumArtistsOnly = v)} />
      </span>
    {/if}
  </div>

  {#if genre && (prefs.tab === 'albums' || prefs.tab === 'songs')}
    <p class="filter-note callout">
      {genre.Name}
      <button class="btn ghost icon" title={t('music.filters.clearGenre')} aria-label={t('music.filters.clearGenre')} onclick={() => (genre = null)}><Icon name="close" size={14} /></button>
    </p>
  {/if}

  {#if error}
    <div class="error"><Icon name="exclamation" size={16} /> {error}</div>
  {/if}

  <section class="tab" data-tab-panel={prefs.tab} data-count={total}>
    {#if prefs.tab === 'songs'}
      <SongList parentId={id} query={songQuery} serverId={server} />
    {:else if prefs.tab === 'genres'}
      <div class="genres">
        {#each items as g (g.Id)}
          {@const src = posterUrl(g, 160)}
          <button class="genre" class:tinted={!src} style:background={src ? undefined : placeholderBg(g.Name)} onclick={() => openGenre(g)}>
            {#if src}<img src={src} alt="" loading="lazy" decoding="async" />{/if}
            <span class="title-3">{g.Name}</span>
          </button>
        {/each}
      </div>
    {:else if prefs.tab === 'folders'}
      {#if folders.length}
        <div class="crumbs callout">
          <button class="btn ghost" onclick={() => (folders = folders.slice(0, -1))}><Icon name="back10" size={14} /> {t('music.folders.up')}</button>
          <span>{[t('music.folders.root'), ...folders.map((f) => f.Name)].join(' / ')}</span>
        </div>
      {/if}
      <div class="rows">
        {#each items as it (itemKey(it))}
          {@const src = it.IsFolder && it.Type !== 'MusicAlbum' ? null : posterUrl(it, 56)}
          <button class="line" onclick={() => openFolderEntry(it)}>
            <span class="art">{#if isMusicItem(it)}<MusicArt item={it} size={48} />{:else if src}<img src={src} alt="" loading="lazy" decoding="async" />{:else}<Icon name="folder" size={18} />{/if}</span>
            <span class="txt"><span class="t">{it.Name}</span><span class="a">{it.AlbumArtist ?? (it.Artists ?? []).join(', ')}</span></span>
          </button>
        {/each}
      </div>
    {:else if prefs.tab === 'albums' && prefs.view === 'list'}
      <div class="rows">
        {#each items as it (itemKey(it))}
          <a class="line" href={`#${itemPath(it)}`}>
            <span class="art"><MusicArt item={it} size={48} /></span>
            <span class="txt"><span class="t">{it.Name}</span><span class="a">{it.AlbumArtist ?? ''}</span></span>
            <span class="meta footnote">{it.ProductionYear ?? ''}</span>
            <span class="meta footnote">{it.ChildCount ? t('common.count.items', { count: it.ChildCount }) : ''}</span>
          </a>
        {/each}
      </div>
    {:else}
      <div class="grid" class:round={prefs.tab === 'artists'}>
        {#each items as it, i (itemKey(it))}
          <div class="cell" class:enter={enter && i < 30} style:--i={i}><Card item={it} variant="square" /></div>
        {/each}
      </div>
    {/if}
    {#if loading && prefs.tab !== 'songs'}
      <div class="grid" aria-hidden="true">
        {#each Array(items.length ? 6 : 12) as _, i (i)}<div class="sk skeleton"></div>{/each}
      </div>
    {/if}
    {#if !loading && !error && prefs.tab !== 'songs' && items.length === 0}
      <p class="empty footnote">{t(prefs.tab === 'albums' && !genre && !favorites && decade === null ? 'music.empty.library' : 'music.empty.tab')}</p>
    {/if}
  </section>
  <div bind:this={sentinel} class="sentinel"></div>
</div>

<style>
  .music {
    padding: 28px 0 72px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 var(--gutter);
  }
  .head .large-title {
    margin: 0;
  }
  .spacer {
    flex: 1;
  }
  .shuffle,
  .mix {
    gap: 6px;
    padding: 0 14px;
  }
  .toolbar {
    position: sticky;
    top: 0;
    z-index: 5;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    padding: 12px var(--gutter);
    margin: 6px 0 10px;
  }
  .toolbar::before {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    background: var(--material);
    -webkit-backdrop-filter: var(--blur);
    backdrop-filter: var(--blur);
    box-shadow: 0 1px 0 var(--separator);
    opacity: 0;
    animation: bar-in linear both;
    animation-timeline: scroll(nearest block);
    animation-range: 40px 110px;
  }
  @keyframes bar-in {
    to {
      opacity: 1;
    }
  }
  .segmented {
    display: inline-flex;
    padding: 3px;
    gap: 2px;
    border-radius: 999px;
    background: var(--fill-2);
  }
  .segmented button {
    height: 30px;
    padding: 0 14px;
    border-radius: 999px;
    font-size: var(--fs-callout);
    font-weight: 560;
    color: var(--label-2);
  }
  .segmented button:hover,
  .segmented button:focus-visible {
    color: var(--label);
  }
  .segmented button.on {
    background: var(--fill-4);
    color: var(--label);
    box-shadow: var(--shadow-1);
  }
  .chip-btn {
    gap: 6px;
    padding: 0 12px;
  }
  .chip-btn.on,
  .views .btn[aria-pressed='true'] {
    background: var(--fill-3);
    color: var(--label);
  }
  .views {
    display: flex;
    gap: 2px;
  }
  .toggle-row {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    color: var(--label-2);
  }
  .filter-note {
    display: flex;
    align-items: center;
    gap: 4px;
    margin: -4px var(--gutter) 10px;
    color: var(--label-2);
  }
  .grid {
    --min: calc(clamp(150px, 11.5vw, 210px) * var(--card-scale, 1));
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--min), 1fr));
    gap: calc(28px * var(--density, 1)) calc(clamp(14px, 1.3vw, 22px) * var(--density, 1));
    padding: 8px var(--gutter) 0;
  }
  .cell {
    content-visibility: auto;
    contain-intrinsic-size: auto 260px;
  }
  .cell:hover,
  .cell:focus-within,
  :global(#main-scroller.restoring) .cell {
    content-visibility: visible;
    position: relative;
    z-index: 1;
  }
  .round :global(.cover) {
    border-radius: 50%;
  }
  .enter {
    animation: rise var(--t-slow) var(--ease-out) both;
    animation-delay: calc(var(--i) * var(--t-stagger));
  }
  .sk {
    aspect-ratio: 1;
    border-radius: var(--r-md);
  }
  .genres {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 16px;
    padding: 8px var(--gutter) 0;
  }
  .genre {
    position: relative;
    aspect-ratio: 2 / 1;
    display: grid;
    align-items: end;
    padding: 14px 16px;
    border-radius: var(--r-md);
    overflow: hidden;
    background: var(--fill-2);
    text-align: left;
    transition: transform var(--t-med) var(--ease);
  }
  .genre img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0.5;
  }
  /* No genre image: a tile coloured from its name (music spec MU-A4), white text on it in both themes. */
  .genre.tinted {
    color: rgb(255 255 255 / 0.92);
  }
  .genre span {
    position: relative;
  }
  .genre:hover,
  .genre:focus-visible {
    transform: translateY(-2px);
    background: var(--fill-3);
  }
  .rows {
    display: flex;
    flex-direction: column;
    padding: 0 var(--gutter);
  }
  .line {
    display: grid;
    grid-template-columns: 48px minmax(0, 1fr) auto auto;
    align-items: center;
    gap: 14px;
    height: 56px;
    padding: 0 10px 0 4px;
    border-radius: var(--r-sm);
    text-align: left;
    color: inherit;
    text-decoration: none;
  }
  .line:hover,
  .line:focus-visible {
    background: var(--fill-2);
  }
  .art {
    width: 48px;
    height: 48px;
    display: grid;
    place-items: center;
    border-radius: var(--r-xs);
    background: var(--fill-2);
    color: var(--label-3);
    overflow: hidden;
  }
  .art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .txt {
    display: grid;
    min-width: 0;
  }
  .t,
  .a {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .t {
    font-weight: 500;
  }
  .a,
  .meta {
    color: var(--label-2);
    font-size: var(--fs-footnote);
  }
  .meta {
    font-variant-numeric: tabular-nums;
  }
  .crumbs {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 var(--gutter) 8px;
    color: var(--label-2);
  }
  .error {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 var(--gutter) 16px;
    padding: 12px 16px;
    border-radius: var(--r-sm);
    background: var(--fill-1);
    font-size: var(--fs-callout);
  }
  .empty {
    padding: 48px var(--gutter);
    text-align: center;
    color: var(--label-3);
  }
  .sentinel {
    height: 1px;
  }
</style>
