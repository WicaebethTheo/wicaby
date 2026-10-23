<script lang="ts">
  // Recherche (Android SearchScreen, the desktop's search field): the field under the title, the recent searches before
  // typing, then the results grouped (films, series, episodes) on every signed-in server, one copy of a title found
  // on several. Queries of 2 characters or more run 300 ms after the last keystroke; the previous results stay
  // until the new ones arrive (the TV web app's rules).
  import type { BaseItem } from '$shared/models';
  import { t } from '$tv/i18n.svelte';
  import { merged } from '$tv/servers';
  import { api } from '$tv/session.svelte';
  import { settings } from '$tv/settings.svelte';
  import { load, save } from '$tv/storage';
  import Clock from '@lucide/svelte/icons/clock';
  import SearchIcon from '@lucide/svelte/icons/search';
  import X from '@lucide/svelte/icons/x';
  import LargeTitlePage from '../components/LargeTitlePage.svelte';
  import Shelf from '../components/Shelf.svelte';
  import Spinner from '../components/Spinner.svelte';
  import { itemRoute, nav } from '../lib/nav.svelte';

  const a = api()!;
  const RECENT = 'm.search.recent';
  let recent = $state<string[]>(load<string[]>(RECENT, []));
  let query = $state('');
  let field = $state<HTMLInputElement>();
  const q = $derived(query.trim());
  let results = $state<BaseItem[] | null>(null);
  let busy = $state(false);

  $effect(() => {
    const term = q;
    if (term.length < 2) {
      results = null;
      busy = false;
      return;
    }
    let stale = false;
    busy = true;
    const timer = setTimeout(() => {
      const types = settings.searchEpisodes.value ? 'Movie,Series,Episode' : 'Movie,Series';
      merged((x) => x.items({ SearchTerm: term, IncludeItemTypes: types, Recursive: true, Limit: 60 }).then((r) => r.Items)).then(
        (r) => {
          if (stale) return;
          results = r;
          busy = false;
        },
        () => {
          if (stale) return;
          results = [];
          busy = false;
        },
      );
    }, 300);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  });

  const groups = $derived.by(() => {
    const r = results ?? [];
    return [
      { key: 'movies', title: t('web_movies'), items: r.filter((i) => i.Type === 'Movie'), wide: false },
      { key: 'series', title: t('web_series'), items: r.filter((i) => i.Type === 'Series'), wide: false },
      { key: 'episodes', title: t('episodes'), items: r.filter((i) => i.Type === 'Episode'), wide: true },
    ].filter((g) => g.items.length);
  });

  // A title opened from the results remembers what found it.
  function open(item: BaseItem): void {
    if (q.length >= 2) {
      recent = [q, ...recent.filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, 8);
      save(RECENT, recent);
    }
    field?.blur();
    nav.push(itemRoute(item));
  }

  function clearRecent(): void {
    recent = [];
    save(RECENT, recent);
  }
</script>

<LargeTitlePage title={t('tab_search')} tab="search">
  {#snippet header()}
    <div class="field-wrap">
      <label class="field">
        <SearchIcon size={19} aria-hidden="true" />
        <input bind:this={field} bind:value={query} type="search" placeholder={t('search_hint')} enterkeyhint="search" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label={t('tab_search')} />
        {#if query}<button class="clear" aria-label={t('clear')} onclick={() => ((query = ''), field?.focus())}><X size={16} strokeWidth={2.6} aria-hidden="true" /></button>{/if}
      </label>
    </div>
  {/snippet}

  {#if results === null}
    {#if busy}
      <div class="state"><Spinner /></div>
    {:else if recent.length}
      <section class="recent">
        <div class="recent-head">
          <h2 class="title-3">{t('web_recent')}</h2>
          <button class="subhead accent" onclick={clearRecent}>{t('clear')}</button>
        </div>
        {#each recent as r (r)}
          <button class="recent-row" onclick={() => (query = r)}><Clock size={18} aria-hidden="true" /><span class="callout">{r}</span></button>
        {/each}
      </section>
    {/if}
  {:else if !groups.length}
    <p class="state callout label-2">{t('search_empty')}</p>
  {:else}
    {#each groups as g (g.key)}
      <Shelf title={g.title} items={g.items} api={a} wide={g.wide} onopen={open} />
    {/each}
  {/if}
</LargeTitlePage>

<style>
  .field-wrap {
    padding: 4px max(var(--gutter), var(--safe-right)) 4px max(var(--gutter), var(--safe-left));
  }
  .field {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 46px;
    padding: 0 12px 0 14px;
    border-radius: var(--r-md);
    background: var(--fill-2);
    color: var(--label-2);
  }
  input {
    flex: 1;
    min-width: 0;
    height: 100%;
    border: 0;
    outline: none;
    background: none;
    color: var(--label);
    font-size: max(16px, var(--fs-body));
  }
  input::placeholder {
    color: var(--label-3);
  }
  input::-webkit-search-cancel-button {
    display: none;
  }
  .clear {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--fill-4);
    color: var(--bg);
  }
  .state {
    display: grid;
    place-items: center;
    padding: 56px var(--gutter);
    color: var(--label-2);
    text-align: center;
  }
  .recent {
    padding: 18px max(var(--gutter), var(--safe-right)) 0 max(var(--gutter), var(--safe-left));
  }
  .recent-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 4px;
  }
  .accent {
    color: var(--accent);
  }
  .recent-row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 48px;
    color: var(--label-2);
    text-align: left;
    border-bottom: 0.5px solid var(--separator);
  }
  .recent-row span {
    color: var(--label);
  }
</style>
