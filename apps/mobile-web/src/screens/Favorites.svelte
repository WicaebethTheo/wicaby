<script lang="ts">
  // Favourites (Emby's Favorites, the desktop's Favorites route): a row per kind, films, series, episodes,
  // collections, people, each from the user's favourite flag on the server; a row opens its full grid.
  import type { BaseItem } from '$shared/models';
  import { t } from '$tv/i18n.svelte';
  import { useLoad } from '$tv/load.svelte';
  import { api } from '$tv/session.svelte';
  import LargeTitlePage from '../components/LargeTitlePage.svelte';
  import Shelf from '../components/Shelf.svelte';
  import Spinner from '../components/Spinner.svelte';
  import { itemRoute, nav } from '../lib/nav.svelte';

  const a = api()!;
  const KINDS = [
    { types: 'Movie', label: 'web_movies' },
    { types: 'Series', label: 'web_series' },
    { types: 'Episode', label: 'episodes', wide: true },
    { types: 'BoxSet', label: 'web_collections' },
    { types: 'Person', label: 'web_people' },
  ];
  const query = (types: string) => ({ Filters: 'IsFavorite', Recursive: 'true', IncludeItemTypes: types, SortBy: 'SortName' });
  const rows = useLoad(
    () => 'favorites',
    () =>
      Promise.all(
        KINDS.map((k) =>
          k.types === 'Person'
            ? a.get<{ Items: BaseItem[] }>('/Persons', { userId: a.userId, Filters: 'IsFavorite', IsFavorite: true, Limit: 60 }).then((r) => r.Items, () => [])
            : a.items({ ...query(k.types), Limit: 60 }).then((r) => r.Items, () => []),
        ),
      ),
  );
  const empty = $derived(!!rows.value && rows.value.every((r) => !r.length));

  function open(item: BaseItem): void {
    nav.push(item.Type === 'Person' ? { name: 'person', id: item.Id, serverId: item.ServerId, title: item.Name } : itemRoute(item));
  }
</script>

<LargeTitlePage title={t('web_favorites')} back>
  {#if !rows.value}
    <div class="wait"><Spinner /></div>
  {:else if empty}
    <p class="callout label-2 empty">{t('web_favorites_empty')}</p>
  {:else}
    {#each KINDS as k, i (k.types)}
      {@const items = rows.value[i]}
      {#if items.length}
        <Shelf
          title={t(k.label)}
          {items}
          api={a}
          wide={k.wide}
          onopen={open}
          onall={k.types === 'Person' ? undefined : () => nav.push({ name: 'browse', title: t(k.label), query: query(k.types) })}
        />
      {/if}
    {/each}
  {/if}
  <div class="end"></div>
</LargeTitlePage>

<style>
  .wait {
    display: grid;
    place-items: center;
    padding: 60px;
  }
  .empty {
    padding: 24px max(var(--gutter), var(--safe-right)) 0 max(var(--gutter), var(--safe-left));
  }
  .end {
    height: 40px;
  }
</style>
