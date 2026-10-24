<script lang="ts" module>
  import type { BaseItem as Item } from '../../shared/models';

  // Last view per library, so "back" repaints instantly at the same scroll offset
  // with the same pages and filters instead of refetching page one. Kept to the 5 most recent.
  const memo = new Map<
    string,
    { lib: Item | null; items: Item[]; total: number; repeated: number; sort: string; desc: boolean; unplayed: boolean; favorites: boolean; genre: string; genres: string[]; view: View; folders: Item[] }
  >();
  // Books libraries: every book (flat) or the library's folder tree.
  export type View = 'books' | 'folders';
</script>

<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import type { BaseItem } from '../../shared/models';
  import BrowseMenu from '../components/BrowseMenu.svelte';
  import Card from '../components/Card.svelte';
  import Icon from '../components/Icon.svelte';
  import Photos from './photos/Photos.svelte';
  import Music from './Music.svelte';
  import { apiFor, dedupe, itemKey } from '../lib/api';
  import { w } from '../lib/bridge';
  import { t } from '../lib/i18n.svelte';
  import { queue, queueModes } from '../lib/queue.svelte';
  import { entering, scrollMemory } from '../lib/motion';
  const enter = entering();
  import { posterUrl } from '../lib/images';
  import { dataVersion, errorMessage, libraries, sessionFor, settings } from '../lib/stores.svelte';

  // server: the library's server (absent: the primary one).
  let { id, server }: { id: string; server?: string } = $props();
  const api = apiFor(untrack(() => server));
  const memoKey = untrack(() => `${server ?? ''}:${id}`);

  const PAGE = 100;
  const SORTS = [
    { key: 'SortName', labelKey: 'browse.library.sort.name' },
    { key: 'DateCreated', labelKey: 'browse.library.sort.dateAdded' },
    { key: 'ProductionYear', labelKey: 'browse.library.sort.year' },
    { key: 'CommunityRating', labelKey: 'browse.library.sort.rating' },
    { key: 'PremiereDate', labelKey: 'browse.library.sort.releaseDate' },
  ];
  const STORE_KEY = 'wicaby.library.prefs';

  function loadPrefs(): { sort: string; desc: boolean; view: View } {
    // Settings > Accueil et bibliothèques: the sort a library starts with until you change it there.
    const fallback = { sort: settings.value?.ui.librarySort ?? 'SortName', desc: settings.value?.ui.librarySortDesc ?? false, view: 'folders' as View };
    try {
      const all = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Record<string, { sort: string; desc: boolean; view?: View }>;
      return { ...fallback, ...all[id] };
    } catch {
      return fallback;
    }
  }

  function savePrefs(): void {
    try {
      const all = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Record<string, unknown>;
      all[id] = { sort, desc, view };
      localStorage.setItem(STORE_KEY, JSON.stringify(all));
    } catch {
      // Preference persistence is best effort.
    }
  }

  const initial = loadPrefs();
  const saved = untrack(() => (document.documentElement.dataset.nav === 'back' ? memo.get(memoKey) : undefined));
  let lib = $state<BaseItem | null>(saved?.lib ?? null);
  let items = $state<BaseItem[]>(saved?.items ?? []);
  let total = $state(saved?.total ?? 0);
  // Items a page repeated from an earlier one (the list moved while paging): counted for the next StartIndex, not shown twice.
  let repeated = saved?.repeated ?? 0;
  let loading = $state(!saved);
  let error = $state('');
  let sort = $state(saved?.sort ?? initial.sort);
  let desc = $state(saved?.desc ?? initial.desc);
  let unplayed = $state(saved?.unplayed ?? false);
  let favorites = $state(saved?.favorites ?? false);
  let genre = $state(saved?.genre ?? '');
  let genres = $state<string[]>(saved?.genres ?? []);
  let view = $state<View>(saved?.view ?? initial.view);
  // Folders view: the path from the library root.
  let folders = $state<BaseItem[]>(saved?.folders ?? []);
  // A folder without an image of its own: its first book's cover (null: none, a folder icon).
  let art = $state<Record<string, string | null>>({});
  const asked = new Set<string>();
  // Restored pages are already on screen: skip the first refetch.
  let skipReset = Boolean(saved);
  let sentinel: HTMLDivElement | undefined = $state();
  let generation = 0;
  // Items from the first page animate in; later pages just appear under the fold.
  let firstPage = $state(0);

  const collection = $derived(lib?.CollectionType ?? '');
  // Photo and home-video libraries open the photo timeline (photos spec §4.2, decision O3) instead of this grid.
  const photos = $derived(collection === 'photos' || collection === 'homevideos');
  // Music libraries open their own tabs (music-spec MU-03).
  const music = $derived(collection === 'music');
  const includeTypes = $derived(
    ({ movies: 'Movie', tvshows: 'Series', music: 'MusicAlbum', boxsets: 'BoxSet', musicvideos: 'MusicVideo', homevideos: 'Video,Photo', books: 'Book' } as Record<string, string>)[
      collection
    ] ?? '',
  );
  // "Affichage" setting: posters or wide thumbnails for film and series libraries.
  const variant = $derived(
    collection === 'music' ? 'square' : collection === 'homevideos' || (collection !== 'books' && settings.value?.ui.libraryView === 'thumb') ? 'thumb' : 'poster',
  );
  // Books libraries open on their folders, as the TV app's library grid (non-recursive, folders pushed).
  const browsing = $derived(collection === 'books' && view === 'folders');
  const filter = $derived(unplayed ? 'unplayed' : favorites ? 'favorites' : 'all');
  const FILTERS = [
    { key: 'all', labelKey: 'browse.library.filter.all' },
    { key: 'unplayed', labelKey: 'browse.library.filter.unplayed' },
    { key: 'favorites', labelKey: 'browse.library.filter.favorites' },
  ] as const;

  function query(start: number) {
    const filters = [unplayed ? 'IsUnplayed' : '', favorites ? 'IsFavorite' : ''].filter(Boolean).join(',');
    const sortBy = sort === 'SortName' ? 'SortName' : `${sort},SortName`;
    if (browsing)
      return { ParentId: folders.at(-1)?.Id ?? id, SortBy: `IsFolder,${sortBy}`, SortOrder: desc ? 'Descending' : 'Ascending', StartIndex: start, Limit: PAGE };
    return {
      ParentId: id,
      Recursive: Boolean(includeTypes),
      IncludeItemTypes: includeTypes || undefined,
      SortBy: sortBy,
      SortOrder: desc ? 'Descending' : 'Ascending',
      Filters: filters || undefined,
      Genres: genre || undefined,
      StartIndex: start,
      Limit: PAGE,
    };
  }

  async function reset(): Promise<void> {
    const gen = ++generation;
    loading = true;
    error = '';
    try {
      const res = await api.items(query(0));
      if (gen !== generation) return;
      items = dedupe(res.Items);
      repeated = res.Items.length - items.length;
      firstPage = res.Items.length;
      total = res.TotalRecordCount;
    } catch (err) {
      if (gen === generation) error = errorMessage(err);
    } finally {
      if (gen === generation) loading = false;
    }
  }

  async function more(): Promise<void> {
    if (loading || items.length + repeated >= total) return;
    const gen = generation;
    loading = true;
    try {
      const res = await api.items(query(items.length + repeated));
      if (gen !== generation) return;
      const next = dedupe([...items, ...res.Items]);
      repeated += items.length + res.Items.length - next.length;
      items = next;
      total = res.TotalRecordCount;
    } catch (err) {
      if (gen === generation) error = errorMessage(err);
    } finally {
      if (gen === generation) loading = false;
    }
  }

  onMount(scrollMemory);

  $effect(() => {
    // Map order is insertion order: re-inserting marks this library the most recent.
    memo.delete(memoKey);
    memo.set(memoKey, { lib, items, total, repeated, sort, desc, unplayed, favorites, genre, genres, view, folders });
    if (memo.size > 5) memo.delete(memo.keys().next().value!);
  });

  // Library metadata (name, collection type) then genres.
  $effect(() => {
    const known = libraries.list.find((l) => l.Id === id && (!server || l.ServerId === server));
    if (known) lib = known;
    else if (sessionFor(server)?.status === 'signed-in') void api.item(id).then((it) => (lib = it)).catch(() => undefined);
  });

  $effect(() => {
    if (!lib || photos || music) return;
    const types = includeTypes;
    void w.api
      .get<{ Items: { Name: string }[] }>('/Genres', { ParentId: id, UserId: sessionFor(server)?.user?.id, IncludeItemTypes: types || undefined, SortBy: 'SortName' }, server)
      .then((r) => (genres = (r.Items ?? []).map((g) => g.Name)))
      .catch(() => (genres = []));
  });

  // Boolean, not the object: the library record can be swapped for an equal copy.
  const ready = $derived(Boolean(lib) && !photos && !music);
  $effect(() => {
    if (!ready) return;
    void sort;
    void desc;
    void unplayed;
    void favorites;
    void genre;
    void browsing;
    void folders;
    void dataVersion.library;
    if (skipReset) {
      skipReset = false;
      return;
    }
    // Untracked: reset() reads the session store (api.items), and a session push must not reload page 1.
    untrack(() => void reset());
  });

  // shortcut: one request per imageless folder on screen; batch it if libraries with hundreds of folders show up.
  $effect(() => {
    for (const f of items) {
      if (f.Type !== 'Folder' || f.ImageTags?.Primary || asked.has(f.Id)) continue;
      asked.add(f.Id);
      void api
        .items({ ParentId: f.Id, Recursive: true, IncludeItemTypes: 'Book', SortBy: 'SortName', Limit: 1 })
        .then((r) => (art[f.Id] = r.Items[0] ? posterUrl(r.Items[0], 330) : null))
        .catch(() => undefined);
    }
  });

  function setView(v: View): void {
    toTop();
    view = v;
    folders = [];
    savePrefs();
  }

  function openFolder(to: BaseItem[]): void {
    toTop();
    folders = to;
  }

  // Re-created after each load: a new observer reports at once, so a sentinel that stays
  // in view still pulls the next page. An error stops it until the next reset.
  $effect(() => {
    if (!sentinel || loading || error) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && void more(), {
      root: document.getElementById('main-scroller'),
      rootMargin: '1200px 0px',
    });
    io.observe(sentinel);
    return () => io.disconnect();
  });

  // The toolbar is sticky: a new sort or filter starts at the top, not deep in the new list.
  // Not in reset(), which also runs when the library changes underneath (dataVersion.library).
  const toTop = () => document.getElementById('main-scroller')?.scrollTo({ top: 0 });

  function setFilter(key: (typeof FILTERS)[number]['key']): void {
    toTop();
    unplayed = key === 'unplayed';
    favorites = key === 'favorites';
  }

  function onSort(v: string): void {
    toTop();
    if (v === 'asc' || v === 'desc') desc = v === 'desc';
    else sort = v;
    savePrefs();
  }

  const sortLabel = $derived(t(SORTS.find((s) => s.key === sort)?.labelKey ?? 'browse.library.sort.name'));
</script>

{#if lib && photos}
  <Photos {lib} {server} />
{:else if lib && music}
  <Music {lib} {server} />
{:else}
<div class="library">
  <header class="head">
    <h1 class="large-title">{lib?.Name ?? ''}</h1>
    {#if total > 0}<span class="count">{t('common.count.items', { count: total })}</span>{/if}
  </header>

  <div class="toolbar">
    {#if collection === 'books'}
      <div class="segmented" role="tablist" aria-label={t('browse.library.view.label')}>
        {#each ['folders', 'books'] as const as v (v)}
          <button role="tab" data-view={v} class:on={view === v} aria-selected={view === v} onclick={() => setView(v)}>{t(`browse.library.view.${v}`)}</button>
        {/each}
      </div>
    {/if}
    {#if !browsing}
      <div class="segmented" role="tablist" aria-label={t('browse.library.filter.label')}>
        {#each FILTERS as f (f.key)}
          <button role="tab" class:on={filter === f.key} aria-selected={filter === f.key} onclick={() => setFilter(f.key)}>{t(f.labelKey)}</button>
        {/each}
      </div>
    {/if}
    <div class="spacer"></div>
    <!-- Box sets and playlists hold linked children, not descendants: a recursive query finds nothing. -->
    {#if lib && !['books', 'boxsets', 'playlists'].includes(collection) && queueModes(lib).includes('shuffle')}
      <button class="btn shuffle" onclick={() => lib && queue(lib, 'shuffle')}><Icon name="shuffle" size={15} stroke={2} /> {t('common.actions.shuffle')}</button>
    {/if}
    {#if genres.length > 0 && !browsing}
      <BrowseMenu
        label={genre || t('browse.library.genres')}
        icon="filter"
        active={Boolean(genre)}
        align="end"
        options={[{ value: '', label: t('browse.library.allGenres'), checked: !genre }, ...genres.map((g, i) => ({ value: g, label: g, checked: genre === g, section: i === 0 ? (true as const) : undefined }))]}
        onselect={(v) => (toTop(), (genre = v))}
      />
    {/if}
    <BrowseMenu
      label={sortLabel}
      icon="sort"
      align="end"
      options={[
        ...SORTS.map((s) => ({ value: s.key, label: t(s.labelKey), checked: sort === s.key })),
        { value: 'asc', label: t('browse.library.order.asc'), checked: !desc, section: t('browse.library.order.label') },
        { value: 'desc', label: t('browse.library.order.desc'), checked: desc },
      ]}
      onselect={onSort}
    />
  </div>

  {#if browsing && folders.length > 0}
    <nav class="crumbs callout" aria-label={t('browse.library.view.folders')}>
      <button class="btn ghost" onclick={() => openFolder(folders.slice(0, -1))}><Icon name="chevronLeft" size={14} /> {t('browse.library.folders.up')}</button>
      {#each [lib, ...folders] as f, i (f?.Id)}
        {#if i > 0}<span aria-hidden="true">/</span>{/if}
        {#if i === folders.length}<span aria-current="page">{f?.Name}</span>
        {:else}<button class="crumb" onclick={() => openFolder(folders.slice(0, i))}>{f?.Name}</button>{/if}
      {/each}
    </nav>
  {/if}

  {#if error}
    <div class="error"><Icon name="exclamation" size={16} /> {error}</div>
  {/if}

  <div class="grid {variant}">
    {#each items as item, i (itemKey(item))}
      <div class="cell" class:enter={enter && i < firstPage && i < 30} style:--i={i}>
        {#if browsing && item.Type === 'Folder'}
          <Card {item} {variant} art={item.ImageTags?.Primary ? undefined : (art[item.Id] ?? null)} onopen={() => openFolder([...folders, item])} />
        {:else}
          <Card {item} {variant} />
        {/if}
      </div>
    {/each}
    {#if loading}
      {#each Array(items.length === 0 ? 18 : 6) as _, i (i)}
        <div class="sk" aria-hidden="true">
          <div class="sk-frame skeleton"></div>
          <div class="sk-line skeleton"></div>
        </div>
      {/each}
    {/if}
  </div>

  {#if !loading && items.length === 0 && !error}
    <div class="empty">
      <Icon name="filter" size={36} stroke={1.5} />
      <p class="headline">{t('browse.library.empty.title')}</p>
      <p class="footnote">{t(browsing ? 'browse.library.empty.folder' : 'browse.library.empty.body')}</p>
    </div>
  {/if}

  <div bind:this={sentinel} class="sentinel"></div>
</div>
{/if}

<style>
  .library {
    padding: 28px 0 72px;
  }
  .head {
    display: flex;
    align-items: baseline;
    gap: 14px;
    flex-wrap: wrap;
    padding: 0 var(--gutter);
  }
  .head .large-title {
    margin: 0;
  }
  .count {
    font-size: var(--fs-callout);
    color: var(--label-3);
    font-variant-numeric: tabular-nums;
  }

  /* Sticky bar; its material fades in as the page scrolls under it (scroll-driven, no JS). */
  .toolbar {
    position: sticky;
    top: 0;
    z-index: 5;
    display: flex;
    align-items: center;
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
  .spacer {
    flex: 1;
  }
  .shuffle {
    gap: 6px;
    padding: 0 14px;
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
    padding: 0 16px;
    border-radius: 999px;
    font-size: var(--fs-callout);
    font-weight: 560;
    color: var(--label-2);
    transition:
      transform var(--t-med) var(--spring);
  }
  .segmented button:not(.on):focus-visible,
  .segmented button:hover {
    color: var(--label);
  }
  .segmented button:active {
    transform: scale(0.96);
  }
  .segmented button.on {
    background: var(--fill-4);
    color: var(--label);
    box-shadow: var(--shadow-1);
  }
  .segmented button:not(.on):focus-visible {
    background: var(--fill-3);
  }
  .segmented button:focus-visible {
    border-radius: 999px;
  }

  .grid {
    --min: calc(clamp(140px, 11vw, 200px) * var(--card-scale, 1));
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(var(--min), 1fr));
    gap: calc(28px * var(--density, 1)) calc(clamp(14px, 1.3vw, 22px) * var(--density, 1));
    padding: 8px var(--gutter) 0;
  }
  .grid.thumb {
    --min: calc(clamp(240px, 19vw, 340px) * var(--card-scale, 1));
  }
  .grid.square {
    --min: calc(clamp(150px, 11.5vw, 210px) * var(--card-scale, 1));
  }
  /* Thousands of cards: off-screen cells skip layout and paint. The hovered one opts out so its lift isn't clipped. */
  .cell {
    content-visibility: auto;
    contain-intrinsic-size: auto 320px;
  }
  .thumb .cell {
    contain-intrinsic-size: auto 220px;
  }
  .cell:hover,
  .cell:focus-within,
  :global(#main-scroller.restoring) .cell {
    content-visibility: visible;
    position: relative;
    z-index: 1;
  }
  .enter {
    animation: rise var(--t-slow) var(--ease-out) both;
    animation-delay: calc(var(--i) * var(--t-stagger));
  }
  .sk-frame {
    border-radius: var(--r-md);
    aspect-ratio: 2 / 3;
  }
  .thumb .sk-frame {
    aspect-ratio: 16 / 9;
  }
  .square .sk-frame {
    aspect-ratio: 1;
  }
  .sk-line {
    height: 11px;
    width: 64%;
    margin-top: 12px;
    border-radius: 4px;
  }
  .crumbs {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
    padding: 0 var(--gutter) 12px;
    color: var(--label-2);
  }
  .crumb:hover,
  .crumb:focus-visible {
    color: var(--label);
    text-decoration: underline;
  }
  [aria-current='page'] {
    color: var(--label);
  }
  .error {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 var(--gutter) 16px;
    padding: 12px 16px;
    border-radius: var(--r-sm);
    background: var(--fill-1);
    color: var(--label);
    font-size: var(--fs-callout);
  }
  .empty {
    display: grid;
    justify-items: center;
    gap: 4px;
    padding: 72px var(--gutter);
    color: var(--label-3);
    text-align: center;
  }
  .empty p {
    margin: 0;
  }
  .empty .headline {
    margin-top: 10px;
    color: var(--label);
  }
  .sentinel {
    height: 1px;
  }
</style>
