<script lang="ts">
  import { HERO_COUNTS, HERO_INTERVALS, HERO_SOURCES, type HeroFeed } from '../../../shared/contract';
  import type { BaseItem } from '../../../shared/models';
  import Icon from '../../components/Icon.svelte';
  import Picker from '../../components/Picker.svelte';
  import Segmented from '../../components/Segmented.svelte';
  import Sheet from '../../components/Sheet.svelte';
  import Toggle from '../../components/Toggle.svelte';
  import { itemKey } from '../../lib/api';
  import { w } from '../../lib/bridge';
  import { heroQueryable, isVideoLibrary } from '../../lib/hero-feed';
  import { t } from '../../lib/i18n.svelte';
  import { list as listOf } from '../../lib/playlists';
  import { genreKey, mergeGenres } from '../../lib/shuffle';
  import { libraries, multiServer, onlineSessions, serverName, settings } from '../../lib/stores.svelte';
  import { set, step } from './shared.svelte';

  // Settings > Home and libraries > Featured banner (#19): what the Home banner (components/Hero.svelte) shows.
  const s = $derived(settings.value);
  const feed = $derived(s?.ui.hero);
  const setFeed = (patch: Partial<HeroFeed>) => set({ ui: { hero: patch } });

  // Only Emby and Jellyfin take the queries of the other sources; elsewhere the banner stays Automatic.
  const servers = $derived(onlineSessions().filter((x) => heroQueryable(x.server.kind)));
  const auto = $derived(feed?.source === 'auto' || servers.length === 0);
  const named = (it: BaseItem) => (multiServer() ? `${it.Name} · ${serverName(it.ServerId)}` : it.Name);
  const videoLibs = $derived(libraries.list.filter((l) => isVideoLibrary(l) && servers.some((x) => x.server.id === l.ServerId)));

  // The multi-select sheet: libraries, collections or excluded genres.
  type Pick = 'libraries' | 'collections' | 'genres';
  let pick = $state<Pick | null>(null);
  let collections = $state<BaseItem[] | null>(null);
  let genres = $state<string[] | null>(null);

  function open(which: Pick): void {
    pick = which;
    if (which === 'collections' && !collections) {
      void Promise.all(servers.map((x) => listOf('collection', x.server.id).then((r) => r.Items ?? [], () => [] as BaseItem[]))).then((l) => (collections = l.flat()));
    }
    // One row per genre across servers, case and languages ("Horror", "Horreur"), as hero-feed matches them.
    if (which === 'genres' && !genres) {
      void Promise.all(
        servers.map((x) =>
          w.api
            .get<{ Items: { Name: string }[] }>('/Genres', { UserId: x.user?.id, SortBy: 'SortName', Recursive: true, IncludeItemTypes: 'Movie,Series' }, x.server.id)
            .then((r) => (r.Items ?? []).map((g) => g.Name), () => [] as string[]),
        ),
      ).then((l) => (genres = mergeGenres(l).map((g) => g.name)));
    }
  }

  const options = $derived.by<{ value: string; label: string }[] | null>(() => {
    if (pick === 'libraries') return videoLibs.map((l) => ({ value: itemKey(l), label: named(l) }));
    if (pick === 'collections') return collections?.map((c) => ({ value: itemKey(c), label: named(c) })) ?? null;
    if (pick === 'genres') return genres?.map((g) => ({ value: g, label: g })) ?? null;
    return null;
  });

  // No library chosen means all of them: every switch shows on, and turning all of them on again saves "all".
  function checked(value: string): boolean {
    if (!feed) return false;
    if (pick === 'libraries') return feed.libraries.length === 0 || feed.libraries.includes(value);
    if (pick === 'genres') return feed.excludeGenres.some((g) => genreKey(g) === genreKey(value));
    return feed.collections.includes(value);
  }

  function toggle(value: string, on: boolean): void {
    if (!feed || !pick || !options) return;
    if (pick === 'libraries') {
      const now = feed.libraries.length === 0 ? options.map((o) => o.value) : feed.libraries;
      const next = on ? [...now, value] : now.filter((v) => v !== value);
      return void setFeed({ libraries: options.every((o) => next.includes(o.value)) ? [] : next });
    }
    const now = pick === 'collections' ? feed.collections : feed.excludeGenres;
    // Off drops every spelling of the genre saved before (another server's, an older list's).
    const next = on ? [...now, value] : now.filter((v) => (pick === 'genres' ? genreKey(v) !== genreKey(value) : v !== value));
    void setFeed(pick === 'collections' ? { collections: next } : { excludeGenres: next });
  }

  const titles = $derived({ libraries: t('settings.library.hero.libraries.label'), collections: t('settings.library.hero.collections.label'), genres: t('settings.library.hero.genres.label') });
  const sources = $derived(HERO_SOURCES.filter((v) => v === 'auto' || servers.length > 0).map((v) => ({ value: v, label: t(`settings.library.hero.sources.${v}`) })));
</script>

{#if s && feed}
  <h3 class="gh">{t('settings.library.hero.title')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.appearance.hero.label')}</div>
        <div class="desc">{t('settings.appearance.hero.desc')}</div>
      </div>
      <Toggle label={t('settings.appearance.hero.label')} checked={s.ui.heroEnabled} onchange={(v) => set({ ui: { heroEnabled: v } })} />
    </div>
    {#if s.ui.heroEnabled}
      <div class="row">
        <div class="txt">
          <div class="lbl">{t('settings.library.hero.source.label')}</div>
          <div class="desc">{t('settings.library.hero.source.desc')}</div>
        </div>
        <Picker label={t('settings.library.hero.source.label')} value={auto ? 'auto' : feed.source} options={sources} onchange={(v) => setFeed({ source: v })} />
      </div>
      <div class="row">
        <div class="txt"><div class="lbl">{t('settings.library.hero.types.label')}</div></div>
        <Segmented
          label={t('settings.library.hero.types.label')}
          value={feed.types}
          options={[
            { value: 'movies', label: t('settings.library.hero.types.movies') },
            { value: 'shows', label: t('settings.library.hero.types.shows') },
            { value: 'both', label: t('settings.library.hero.types.both') },
          ]}
          onchange={(v) => setFeed({ types: v })}
        />
      </div>
      {#if !auto}
        <button type="button" class="row link-row" onclick={() => open('libraries')}>
          <div class="txt">
            <div class="lbl">{titles.libraries}</div>
            <div class="desc">
              {feed.collections.length > 0
                ? t('settings.library.hero.libraries.byCollections')
                : feed.libraries.length === 0
                  ? t('settings.library.hero.libraries.all')
                  : t('settings.library.hero.libraries.count', { count: feed.libraries.length })}
            </div>
          </div>
          <span class="chev"><Icon name="chevronRight" size={16} /></span>
        </button>
        <button type="button" class="row link-row" onclick={() => open('collections')}>
          <div class="txt">
            <div class="lbl">{titles.collections}</div>
            <div class="desc">
              {feed.collections.length === 0 ? t('settings.library.hero.collections.none') : t('settings.library.hero.collections.count', { count: feed.collections.length })}
            </div>
          </div>
          <span class="chev"><Icon name="chevronRight" size={16} /></span>
        </button>
      {/if}
      <button type="button" class="row link-row" onclick={() => open('genres')}>
        <div class="txt">
          <div class="lbl">{titles.genres}</div>
          <div class="desc">{feed.excludeGenres.length === 0 ? t('settings.library.hero.genres.none') : feed.excludeGenres.join(', ')}</div>
        </div>
        <span class="chev"><Icon name="chevronRight" size={16} /></span>
      </button>
      <div class="row">
        <div class="txt"><div class="lbl">{t('settings.library.hero.count.label')}</div></div>
        <Picker label={t('settings.library.hero.count.label')} value={feed.count} options={HERO_COUNTS.map((n) => ({ value: n, label: String(n) }))} onchange={(v) => setFeed({ count: v })} />
      </div>
      <div class="row">
        <div class="txt">
          <div class="lbl">{t('settings.library.hero.hideWatched.label')}</div>
          <div class="desc">{t('settings.library.hero.hideWatched.desc')}</div>
        </div>
        <Toggle label={t('settings.library.hero.hideWatched.label')} checked={feed.hideWatched} onchange={(v) => setFeed({ hideWatched: v })} />
      </div>
      <div class="row">
        <div class="txt">
          <div class="lbl">{t('settings.appearance.heroAutoplay.label')}</div>
          <div class="desc">{t('settings.appearance.heroAutoplay.desc')}</div>
        </div>
        <Toggle label={t('settings.appearance.heroAutoplay.label')} checked={s.ui.heroAutoplay} onchange={(v) => set({ ui: { heroAutoplay: v } })} />
      </div>
      {#if s.ui.heroAutoplay}
        <div class="row">
          <div class="txt"><div class="lbl">{t('settings.library.hero.interval.label')}</div></div>
          <Picker label={t('settings.library.hero.interval.label')} value={feed.intervalS} options={HERO_INTERVALS.map((n) => ({ value: n, label: step(n) }))} onchange={(v) => setFeed({ intervalS: v })} />
        </div>
      {/if}
    {/if}
  </div>
  {#if s.ui.heroEnabled}<p class="foot">{t('settings.library.hero.foot')}</p>{/if}

  <Sheet open={pick !== null} onclose={() => (pick = null)} label={pick ? titles[pick] : ''} width={440}>
    {#if pick}
      <div class="body">
        <h2 class="title-3">{titles[pick]}</h2>
        <p class="footnote">{t(`settings.library.hero.${pick}.intro`)}</p>
        {#if !options}
          <p class="footnote">{t('settings.library.hero.loading')}</p>
        {:else if options.length === 0}
          <p class="footnote">{t('settings.library.hero.empty')}</p>
        {:else}
          <ul class="choices">
            {#each options as o (o.value)}
              <li>
                <span class="label">{o.label}</span>
                <Toggle label={o.label} checked={checked(o.value)} onchange={(v) => toggle(o.value, v)} />
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
  </Sheet>
{/if}

<style>
  .gh {
    margin: 30px 0 8px 2px;
    font-size: var(--fs-footnote);
    font-weight: 500;
    color: var(--label-3);
  }
  .foot {
    margin: 10px 2px 0;
    font-size: var(--fs-footnote);
    color: var(--label-3);
    line-height: 1.5;
  }
  .group {
    border-radius: var(--r-sm);
    background: var(--bg-elevated);
    box-shadow: inset 0 0 0 1px var(--separator);
    overflow: hidden;
  }
  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 16px;
    min-height: 58px;
    padding: 12px 18px;
  }
  .row + .row::before {
    content: '';
    position: absolute;
    top: 0;
    left: 18px;
    right: 0;
    height: 1px;
    background: var(--separator);
  }
  .txt {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
  }
  .lbl {
    font-size: var(--fs-body);
    font-weight: 500;
    color: var(--label);
  }
  .desc {
    margin-top: 2px;
    font-size: var(--fs-footnote);
    color: var(--label-3);
    line-height: 1.45;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .link-row {
    width: 100%;
    text-align: left;
    color: var(--label);
  }
  .link-row:hover,
  .link-row:focus-visible {
    background: var(--fill-1);
  }
  .chev {
    flex: none;
    display: grid;
    color: var(--label-3);
  }
  :global(.searching) .foot {
    display: none;
  }
  :global(.searching) .row::before {
    display: none;
  }
  :global(.searching) .row:not([hidden]) ~ .row:not([hidden])::before {
    display: block;
  }
  :global(html[data-density='compact']) .row {
    min-height: 50px;
    padding-block: 9px;
  }

  .body {
    padding: 26px 24px 22px;
  }
  .body h2 {
    margin: 0 32px 4px 0;
  }
  .body p {
    margin: 0 0 14px;
    color: var(--label-3);
  }
  .choices {
    list-style: none;
    margin: 0;
    padding: 0;
    max-height: min(60vh, 520px);
    overflow-y: auto;
  }
  .choices li {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 44px;
    padding: 4px 2px;
  }
  .choices li + li {
    border-top: 1px solid var(--separator);
  }
  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
