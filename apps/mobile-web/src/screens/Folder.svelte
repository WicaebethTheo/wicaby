<script lang="ts">
  // A library or folder as a poster grid (Android GridScreen), under a large title with the count, Sort, Filter and
  // Genre as compact pills (Emby's library sorts and filters), and Shuffle for libraries that play. The choices are
  // remembered per library. Given a query instead of a folder (collections, playlists, history, favourites), the
  // grid shows what it returns, sorted and filtered the same way.
  import type { BaseItem } from '$shared/models';
  import { plural, t } from '$tv/i18n.svelte';
  import { useLoad } from '$tv/load.svelte';
  import { shuffle } from '$tv/playback';
  import { apiOf } from '$tv/session.svelte';
  import { load, save } from '$tv/storage';
  import ArrowUpDown from '@lucide/svelte/icons/arrow-up-down';
  import ListFilter from '@lucide/svelte/icons/list-filter';
  import ShuffleIcon from '@lucide/svelte/icons/shuffle';
  import Tags from '@lucide/svelte/icons/tags';
  import LargeTitlePage from '../components/LargeTitlePage.svelte';
  import PosterGrid from '../components/PosterGrid.svelte';
  import { itemRoute, nav } from '../lib/nav.svelte';
  import { showAlert } from '../lib/overlay.svelte';

  let { id, title, serverId, query }: { id: string; title: string; serverId?: string; query?: Record<string, string> } = $props();
  // A page is opened for one folder and never re-targeted: the initial values are the values.
  // svelte-ignore state_referenced_locally
  const client = apiOf(serverId)!;
  // svelte-ignore state_referenced_locally
  const folder = useLoad(() => `folder-${id || title}`, () => (id ? client.item(id) : Promise.resolve({ Id: '', Name: title } as BaseItem)));
  // svelte-ignore state_referenced_locally
  const store = id || `q.${JSON.stringify(query)}`;
  const ct = $derived(folder.value?.CollectionType);
  const types = $derived(ct === 'movies' ? 'Movie' : ct === 'tvshows' ? 'Series' : ct === 'boxsets' ? 'BoxSet' : undefined);

  const SORTS = [
    { key: 'sort_name', by: 'SortName', order: 'Ascending' },
    { key: 'sort_added', by: 'DateCreated,SortName', order: 'Descending' },
    { key: 'sort_year', by: 'ProductionYear,PremiereDate,SortName', order: 'Descending' },
    { key: 'sort_rating', by: 'CommunityRating,SortName', order: 'Descending' },
    { key: 'web_sort_critic', by: 'CriticRating,SortName', order: 'Descending' },
    { key: 'web_sort_release', by: 'PremiereDate,ProductionYear,SortName', order: 'Descending' },
    { key: 'web_sort_played', by: 'DatePlayed,SortName', order: 'Descending' },
    { key: 'web_sort_runtime', by: 'Runtime,SortName', order: 'Ascending' },
    { key: 'web_sort_plays', by: 'PlayCount,SortName', order: 'Descending' },
    { key: 'web_sort_random', by: 'Random', order: 'Ascending' },
  ] as const;
  const FILTERS = [
    { key: 'filter_all', value: undefined },
    { key: 'filter_unplayed', value: 'IsUnplayed' },
    { key: 'filter_favorites', value: 'IsFavorite' },
    { key: 'web_filter_played', value: 'IsPlayed' },
    { key: 'web_filter_resumable', value: 'IsResumable' },
  ] as const;
  // svelte-ignore state_referenced_locally
  const stored = load<{ sort: number; filter: number; genre?: { id: string; name: string } | null }>(`m.grid.${store}`, { sort: 0, filter: 0 });
  // A query's own order (a history by date played) until another is picked.
  // svelte-ignore state_referenced_locally
  let sort = $state(query?.SortBy && !localStorage.getItem(`m.grid.${store}`) ? -1 : stored.sort);
  let filter = $state(stored.filter);
  let genre = $state(stored.genre ?? null);
  $effect(() => save(`m.grid.${store}`, { sort, filter, genre }));

  let scroller = $state<HTMLElement>();
  let total = $state(-1);
  const key = $derived(`${store}/${types ?? ''}/${sort}/${filter}/${genre?.id ?? ''}`);

  function page(start: number, limit: number) {
    const s = SORTS[sort];
    const filters = [query?.Filters, FILTERS[filter]?.value].filter(Boolean).join(',') || undefined;
    return client.items({
      ...(query ?? { ParentId: id, IncludeItemTypes: types, Recursive: types !== undefined }),
      ...(s ? { SortBy: s.by, SortOrder: s.order } : {}),
      Filters: filters,
      GenreIds: genre?.id,
      StartIndex: start,
      Limit: limit,
    });
  }

  function pickSort(): void {
    showAlert({ title: t('web_sort'), actions: SORTS.map((s, i) => ({ label: t(s.key), run: () => (sort = i) })), selected: sort });
  }

  // The genres of what the grid shows (Emby's Genres tab), all of them first.
  async function pickGenre(): Promise<void> {
    const scope = query ? { IncludeItemTypes: query.IncludeItemTypes, Recursive: true } : { ParentId: id, IncludeItemTypes: types };
    const list = await client.get<{ Items: BaseItem[] }>('/Genres', { userId: client.userId, SortBy: 'SortName', ...scope }).then((r) => r.Items, () => []);
    showAlert({
      title: t('web_genre'),
      actions: [{ label: t('web_genre_all'), run: () => (genre = null) }, ...list.map((g) => ({ label: g.Name, run: () => (genre = { id: g.Id, name: g.Name }) }))],
      selected: genre ? list.findIndex((g) => g.Id === genre!.id) + 1 : 0,
    });
  }

  function pickFilter(): void {
    showAlert({ title: t('web_filter'), actions: FILTERS.map((f, i) => ({ label: t(f.key), run: () => (filter = i) })), selected: filter });
  }

  const playable = $derived(!!folder.value && !query && !['books', 'boxsets', 'playlists', 'livetv'].includes(ct ?? ''));
</script>

<LargeTitlePage {title} back bind:scroller>
  {#snippet header()}
    <div class="tools">
      <span class="footnote label-2 count">{total > 0 ? plural('items_count', total, total.toLocaleString()) : ''}</span>
      {#if playable && total > 0}
        <button class="round small" aria-label={t('shuffle')} onclick={() => shuffle(folder.value as BaseItem)}><ShuffleIcon size={18} aria-hidden="true" /></button>
      {/if}
      <button class="round small" class:on={filter > 0} aria-label={t('web_filter')} onclick={pickFilter}><ListFilter size={18} aria-hidden="true" /></button>
      {#if !['Playlist', 'BoxSet'].includes(query?.IncludeItemTypes ?? '') && !query?.IncludeItemTypes?.includes('Episode') && ct !== 'boxsets'}
        <button class="pill compact" class:on={!!genre} onclick={() => void pickGenre()}><Tags size={16} aria-hidden="true" /><span class="subhead ellipsis">{genre?.name ?? t('web_genre')}</span></button>
      {/if}
      <button class="pill compact" onclick={pickSort}><ArrowUpDown size={16} aria-hidden="true" /><span class="subhead ellipsis">{SORTS[sort] ? t(SORTS[sort].key) : t('web_sort')}</span></button>
    </div>
  {/snippet}
  {#if folder.value}
    <PosterGrid api={client} {key} {page} {scroller} bind:total onopen={(item) => nav.push(itemRoute(item))} />
  {/if}
</LargeTitlePage>

<style>
  .tools {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px max(var(--gutter), var(--safe-right)) 18px max(var(--gutter), var(--safe-left));
  }
  .count {
    flex: 1;
  }
  .round.small {
    width: 38px;
    height: 38px;
  }
  .round.on,
  .pill.on {
    color: var(--accent);
  }
  .ellipsis {
    max-width: 120px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
