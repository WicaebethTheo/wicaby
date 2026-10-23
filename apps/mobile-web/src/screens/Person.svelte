<script lang="ts">
  // A person (Emby's person page, the desktop's Item route for a Person): the portrait, birth and death, the
  // biography (four lines, a tap shows it whole), then the films and the series they appear in, newest first.
  import type { BaseItem } from '$shared/models';
  import { t } from '$tv/i18n.svelte';
  import { useLoad } from '$tv/load.svelte';
  import { apiOf } from '$tv/session.svelte';
  import LargeTitlePage from '../components/LargeTitlePage.svelte';
  import Shelf from '../components/Shelf.svelte';
  import Spinner from '../components/Spinner.svelte';
  import { itemRoute, nav } from '../lib/nav.svelte';

  let { id, serverId, name }: { id: string; serverId?: string; name?: string } = $props();
  // svelte-ignore state_referenced_locally
  const client = apiOf(serverId)!;
  const dpr = Math.min(3, window.devicePixelRatio || 2);

  const person = useLoad(() => `person-${id}`, () => client.item(id));
  const works = useLoad(
    () => `person-works-${id}`,
    () => client.items({ PersonIds: id, Recursive: true, IncludeItemTypes: 'Movie,Series', SortBy: 'ProductionYear,SortName', SortOrder: 'Descending', Limit: 300 }).then((r) => r.Items),
  );
  const movies = $derived((works.value ?? []).filter((i) => i.Type === 'Movie'));
  const series = $derived((works.value ?? []).filter((i) => i.Type === 'Series'));

  const p = $derived(person.value);
  const face = $derived(p?.ImageTags?.Primary ? client.image(id, 'Primary', p.ImageTags.Primary, { maxHeight: Math.round(140 * dpr) }) : undefined);
  const date = (iso?: string) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : '');
  const life = $derived.by(() => {
    if (!p?.PremiereDate) return '';
    const born = t('web_born', date(p.PremiereDate));
    const place = (p as BaseItem & { ProductionLocations?: string[] }).ProductionLocations?.[0];
    return [born, place, p.EndDate ? t('web_died', date(p.EndDate)) : ''].filter(Boolean).join(' · ');
  });
  let open = $state(false);
  const opened = (item: BaseItem) => nav.push(itemRoute(item));
</script>

<LargeTitlePage title={p?.Name ?? name ?? ''} back>
  <div class="head">
    <span class="face">
      {#if face}<img src={face} alt="" decoding="async" />{:else}<span class="title-1">{(p?.Name ?? name ?? '?').slice(0, 1)}</span>{/if}
    </span>
    <div class="facts">
      {#if life}<p class="footnote label-2">{life}</p>{/if}
      {#if works.value}<p class="footnote label-3">{[movies.length ? `${t('web_movies')} ${movies.length}` : '', series.length ? `${t('web_series')} ${series.length}` : ''].filter(Boolean).join(' · ')}</p>{/if}
    </div>
  </div>
  {#if p?.Overview}
    <button class="bio callout" class:open onclick={() => (open = !open)}>{p.Overview}</button>
  {/if}
  {#if !works.value}
    <div class="wait"><Spinner /></div>
  {:else}
    {#if movies.length}<Shelf title={t('web_movies')} items={movies} api={client} onopen={opened} />{/if}
    {#if series.length}<Shelf title={t('web_series')} items={series} api={client} onopen={opened} />{/if}
  {/if}
  <div class="end"></div>
</LargeTitlePage>

<style>
  .head {
    display: flex;
    align-items: center;
    gap: 18px;
    padding: 0 max(var(--gutter), var(--safe-right)) 14px max(var(--gutter), var(--safe-left));
  }
  .face {
    flex: none;
    width: 104px;
    height: 104px;
    border-radius: 50%;
    overflow: hidden;
    display: grid;
    place-items: center;
    background: var(--bg-elevated-2);
    color: var(--label-2);
  }
  .face img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .facts {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .bio {
    display: -webkit-box;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
    margin: 0 max(var(--gutter), var(--safe-right)) 6px max(var(--gutter), var(--safe-left));
    text-align: left;
    color: var(--label-2);
    line-height: 1.45;
  }
  .bio.open {
    -webkit-line-clamp: unset;
    line-clamp: unset;
  }
  .wait {
    display: grid;
    place-items: center;
    padding: 40px;
  }
  .end {
    height: 40px;
  }
</style>
