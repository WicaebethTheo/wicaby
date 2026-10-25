<script lang="ts">
  import { tick, untrack } from 'svelte';
  import type { BaseItem } from '../../shared/models';
  import Card from '../components/Card.svelte';
  import Icon from '../components/Icon.svelte';
  import Picker from '../components/Picker.svelte';
  import Segmented from '../components/Segmented.svelte';
  import Toggle from '../components/Toggle.svelte';
  import { apiFor, itemKey, itemPath, libraryRef, playQueueFor } from '../lib/api';
  import { w } from '../lib/bridge';
  import { runtime, typeLabel } from '../lib/format';
  import { fmt, t } from '../lib/i18n.svelte';
  import { navigate, router } from '../lib/router.svelte';
  import { resumeAt } from '../lib/resume.svelte';
  import { canShuffle, cleanText, continueTitles, DECADES, decadeYears, mergeGenres, pickSet, SHUFFLE_TYPES, VIDEO_COLLECTIONS, type MergedGenre } from '../lib/shuffle';
  import { errorMessage, libraries, multiServer, onlineSessions, serverName, toast } from '../lib/stores.svelte';

  type Mode = 'random' | 'library' | 'genre';
  interface Prefs {
    mode: Mode;
    library: string;
    genre: string;
    unwatched: boolean;
    hideContinue: boolean;
    decade: string;
    minRating: number;
  }
  const STORE_KEY = 'wicaby.shuffle.prefs';
  const DEFAULTS: Prefs = { mode: 'random', library: '', genre: '', unwatched: true, hideContinue: true, decade: '', minRating: 0 };

  function loadPrefs(): Prefs {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}') as Partial<Prefs>;
      return { ...DEFAULTS, ...saved };
    } catch {
      return { ...DEFAULTS };
    }
  }
  let prefs = $state<Prefs>(loadPrefs());

  function set<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
    prefs[key] = value;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(prefs));
    } catch {
      // Preference persistence is best effort.
    }
  }

  const servers = $derived(onlineSessions().filter((s) => canShuffle(s.server.kind)).map((s) => s.server.id));
  const libs = $derived(libraries.list.filter((l) => VIDEO_COLLECTIONS.includes(l.CollectionType ?? '') && servers.includes(l.ServerId ?? '')));
  const multi = $derived(multiServer());
  const lib = $derived(prefs.mode === 'library' ? (libs.find((l) => libraryRef(l) === prefs.library) ?? libs[0]) : undefined);
  const libLabel = (l: BaseItem) => (multi && libs.some((o) => o.Name === l.Name && o.ServerId !== l.ServerId) ? `${l.Name} · ${serverName(l.ServerId)}` : l.Name);

  // Genres of the chosen library, or of every server in Genre mode, merged across servers and languages.
  const genreCtx = $derived(prefs.mode === 'library' ? (lib ? `lib:${libraryRef(lib)}` : '') : prefs.mode === 'genre' ? `all:${servers.join()}` : '');
  let genres = $state<{ ctx: string; list: MergedGenre[]; failed?: boolean }>({ ctx: '', list: [] });
  let genreSeq = 0;
  // Bumped by Shuffle Again after a failed genre fetch, which otherwise runs again only when genreCtx changes.
  let genreRetry = $state(0);
  $effect(() => {
    const ctx = genreCtx;
    void genreRetry;
    if (!ctx) return;
    const asks = lib ? [{ sid: lib.ServerId, parent: lib.Id }] : servers.map((sid) => ({ sid, parent: undefined }));
    const gen = ++genreSeq;
    untrack(() => {
      void Promise.all(asks.map((a) => apiFor(a.sid).genres({ ParentId: a.parent, IncludeItemTypes: SHUFFLE_TYPES }).catch(() => null))).then((res) => {
        if (gen === genreSeq) genres = { ctx, list: mergeGenres(res.map((r) => r?.Items?.map((g) => g.Name)), fmt.compare), failed: res.every((r) => r === null) };
      });
    });
  });
  const genre = $derived(prefs.mode === 'random' ? undefined : (genres.list.find((g) => g.key === prefs.genre) ?? (prefs.mode === 'genre' ? genres.list[0] : undefined)));
  // Library mode without a video library has nothing to wait for: it rolls an empty set.
  const ready = $derived(servers.length > 0 && (prefs.mode === 'random' || (prefs.mode === 'library' && !lib) || (genreCtx !== '' && genres.ctx === genreCtx)));

  let picks = $state<BaseItem[]>([]);
  let selected = $state(0);
  let loading = $state(true);
  let failed = $state(false);
  let busy = $state(false);
  let row: HTMLDivElement | undefined = $state();
  let seq = 0;

  async function roll(): Promise<void> {
    const gen = ++seq;
    // Read everything now: the filters may change while the servers answer.
    const { unwatched, hideContinue, decade, minRating, mode } = prefs;
    if ((mode === 'genre' && !genre) || (mode === 'library' && !lib)) {
      picks = [];
      failed = mode === 'genre' && genres.failed === true;
      loading = false;
      return;
    }
    const from = lib ? [lib.ServerId] : servers;
    const query = {
      IncludeItemTypes: SHUFFLE_TYPES,
      // Room for what the filters below drop (Continue Watching, the previous set, the same title elsewhere).
      Limit: 30,
      ParentId: lib?.Id,
      Genres: genre?.sources.join('|'),
      Filters: unwatched ? 'IsUnplayed' : undefined,
      Years: decadeYears(decade),
      MinCommunityRating: minRating || undefined,
    };
    const hadFocus = Boolean(row?.contains(document.activeElement));
    loading = true;
    failed = false;
    const [lists, cont] = await Promise.all([
      Promise.all(from.map((sid) => apiFor(sid).randomItems(query).then((r) => r.Items, () => null))),
      // Every server's Continue Watching, as on Home: a title resumed on one is hidden on the others too.
      hideContinue
        ? Promise.all(servers.map((sid) => Promise.all([apiFor(sid).resume(24).catch(() => null), apiFor(sid).nextUp(24).catch(() => null)]))).then((all) =>
            all.flat().flatMap((r) => r?.Items ?? []),
          )
        : Promise.resolve([]),
    ]);
    if (gen !== seq) return;
    failed = lists.every((l) => l === null);
    picks = pickSet(lists, continueTitles(cont), picks);
    selected = 0;
    loading = false;
    if (hadFocus) {
      await tick();
      row?.querySelector<HTMLElement>('a[href]')?.focus();
    }
  }

  const rollKey = $derived(
    ready ? JSON.stringify([prefs.mode, lib && libraryRef(lib), genre?.key, prefs.unwatched, prefs.hideContinue, prefs.decade, prefs.minRating, servers]) : '',
  );
  $effect(() => {
    if (rollKey) untrack(() => void roll());
  });

  const item = $derived(picks[selected] as BaseItem | undefined);
  const resumable = (it: BaseItem) => (it.UserData?.PlaybackPositionTicks ?? 0) > 0;

  function meta(it: BaseItem): string[] {
    const out = [typeLabel(it.Type)];
    if (it.ProductionYear) out.push(String(it.ProductionYear));
    if (it.RunTimeTicks && it.Type !== 'Series') out.push(runtime(it.RunTimeTicks));
    if (it.Type === 'Series' && it.ChildCount) out.push(t('common.count.seasons', { count: it.ChildCount }));
    return out;
  }

  // The same path as the hero's Play: a series starts at its first unwatched episode, a film where it stopped.
  async function play(it: BaseItem): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      const q = await playQueueFor(it);
      const same = q.itemIds[q.startIndex] === it.Id;
      const at = await resumeAt(same ? it.UserData?.PlaybackPositionTicks : undefined, it.Name);
      if (at === null) return;
      await w.playback.play({ ...q, startPositionTicks: at });
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      busy = false;
    }
  }

  function reroll(): void {
    if (genres.failed) genreRetry++;
    void roll();
  }

  // On document in the capture phase: before the music bar's R (repeat), after the window-capture handlers of menus
  // and sheets. The page stays mounted under the player, hence the route check.
  function onKey(e: KeyboardEvent): void {
    if ((e.key !== 'r' && e.key !== 'R') || router.route.name !== 'shuffle') return;
    if (e.defaultPrevented || e.repeat || e.ctrlKey || e.altKey || e.metaKey || !ready) return;
    const el = e.target as HTMLElement | null;
    if (el?.closest('input, textarea, select, [contenteditable="true"], [role="menu"], [role="dialog"]')) return;
    e.preventDefault();
    reroll();
  }

  const modes = $derived<{ value: Mode; label: string }[]>([
    { value: 'random', label: t('browse.shuffle.mode.random') },
    { value: 'library', label: t('browse.shuffle.mode.library') },
    { value: 'genre', label: t('browse.shuffle.mode.genre') },
  ]);
  const decades = $derived([
    { value: '', label: t('browse.shuffle.anyYear') },
    ...DECADES.map((d) => ({ value: d, label: d === 'older' ? t('browse.shuffle.older') : t('browse.shuffle.decade', { decade: d }) })),
  ]);
  const ratings = $derived([
    { value: 0, label: t('browse.shuffle.anyRating') },
    ...[5, 6, 7, 8].map((r) => ({ value: r, label: t('browse.shuffle.minRating', { rating: fmt.number(r) }) })),
  ]);
  const genreOptions = $derived([...(prefs.mode === 'library' ? [{ value: '', label: t('browse.shuffle.anyGenre') }] : []), ...genres.list.map((g) => ({ value: g.key, label: g.name }))]);
</script>

<svelte:document onkeydowncapture={onKey} />

<div class="shuffle">
  <header class="head">
    <h1 class="large-title">{t('browse.shuffle.title')}</h1>
    <p class="callout sub">{t('browse.shuffle.subtitle')}</p>
  </header>

  {#if servers.length === 0}
    <div class="empty">
      <Icon name="shuffle" size={40} stroke={1.4} />
      <h2 class="title-2">{t('browse.shuffle.unavailable.title')}</h2>
      <p class="footnote">{t('browse.shuffle.unavailable.body')}</p>
    </div>
  {:else}
    <div class="controls">
      <Segmented value={prefs.mode} options={modes} label={t('browse.shuffle.mode.label')} onchange={(v) => set('mode', v)} />
      {#if prefs.mode === 'library' && lib}
        <Picker value={libraryRef(lib)} options={libs.map((l) => ({ value: libraryRef(l), label: libLabel(l) }))} label={t('browse.shuffle.library')} onchange={(v) => set('library', v)} />
      {/if}
      {#if prefs.mode !== 'random' && genreOptions.length > 0}
        <Picker value={genre?.key ?? ''} options={genreOptions} label={t('browse.shuffle.genre')} onchange={(v) => set('genre', v)} />
      {/if}
      <Picker value={prefs.decade} options={decades} label={t('browse.shuffle.year')} onchange={(v) => set('decade', v)} />
      <Picker value={prefs.minRating} options={ratings} label={t('browse.shuffle.rating')} onchange={(v) => set('minRating', v)} />
      <span class="filter">{t('browse.shuffle.unwatched')}<Toggle checked={prefs.unwatched} label={t('browse.shuffle.unwatched')} onchange={(v) => set('unwatched', v)} /></span>
      <span class="filter">{t('browse.shuffle.hideContinue')}<Toggle checked={prefs.hideContinue} label={t('browse.shuffle.hideContinue')} onchange={(v) => set('hideContinue', v)} /></span>
      <button class="btn primary reroll" onclick={reroll} disabled={!ready} title={t('browse.shuffle.rerollHint')} aria-keyshortcuts="R">
        <Icon name="shuffle" size={15} />
        {t('browse.shuffle.reroll')}
      </button>
    </div>

    {#if loading && picks.length === 0}
      <div class="row" aria-busy="true">
        {#each Array(5) as _, i (i)}<div class="sk-frame skeleton" aria-hidden="true"></div>{/each}
      </div>
    {:else if picks.length === 0}
      <div class="empty">
        <Icon name="shuffle" size={40} stroke={1.4} />
        <h2 class="title-2">{failed ? t('browse.shuffle.error') : t('browse.shuffle.empty.title')}</h2>
        {#if !failed}<p class="footnote">{t('browse.shuffle.empty.body')}</p>{/if}
      </div>
    {:else}
      <div class="row" class:loading bind:this={row} role="list" aria-label={t('browse.shuffle.picks')} aria-busy={loading}>
        {#each picks as it, i (itemKey(it))}
          <div class="pick" class:on={i === selected} role="listitem" onpointerenter={() => (selected = i)} onfocusin={() => (selected = i)}>
            <Card item={it} showServer={multi} />
          </div>
        {/each}
      </div>

      {#if item}
        {@const overview = cleanText(item.Overview)}
        <section class="details" aria-label={item.Name}>
          <h2 class="title-1">{item.Name}</h2>
          <div class="meta">
            {#each meta(item) as m, j (j)}<span>{m}</span>{/each}
            {#if item.OfficialRating}<span class="chip">{item.OfficialRating}</span>{/if}
            {#if item.CommunityRating}
              <span class="rating"><Icon name="star" size={12} fill stroke={0} />{fmt.number(item.CommunityRating, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</span>
            {/if}
          </div>
          {#if item.Genres?.length}<p class="genres footnote">{fmt.list(item.Genres)}</p>{/if}
          {#if overview}<p class="overview">{overview}</p>{/if}
          <div class="actions">
            <button class="btn primary lg" onclick={() => void play(item)} aria-disabled={busy}>
              <Icon name="play" size={17} fill stroke={0} />
              {resumable(item) ? t('browse.hero.resume') : t('browse.hero.play')}
            </button>
            <button class="btn lg" onclick={() => navigate(itemPath(item))}>{t('browse.hero.moreInfo')}</button>
          </div>
        </section>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .shuffle {
    padding: 28px 0 72px;
  }
  .head {
    padding: 0 var(--gutter);
  }
  .head h1,
  .sub {
    margin: 0;
  }
  .sub {
    margin-top: 6px;
    color: var(--label-2);
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 12px 16px;
    padding: 22px var(--gutter) 0;
  }
  .filter {
    display: inline-flex;
    align-items: center;
    gap: 10px;
    font-size: var(--fs-callout);
    color: var(--label-2);
  }
  .reroll {
    margin-left: auto;
  }
  .row {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: clamp(14px, 1.6vw, 26px);
    max-width: 1180px;
    padding: 28px var(--gutter) 0;
  }
  .row.loading {
    opacity: 0.6;
  }
  .pick {
    opacity: 0.62;
    transition: opacity var(--t-fast) var(--ease);
  }
  .pick.on {
    opacity: 1;
  }
  .sk-frame {
    aspect-ratio: 2 / 3;
    border-radius: var(--r-md);
  }
  .details {
    max-width: 72ch;
    padding: 28px var(--gutter) 0;
  }
  .details h2 {
    margin: 0;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 14px;
    margin-top: 10px;
    font-size: var(--fs-callout);
    color: var(--label-2);
  }
  .chip {
    padding: 1px 6px;
    border: 1px solid var(--separator);
    border-radius: 4px;
    font-size: var(--fs-footnote);
  }
  .rating {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .genres {
    margin: 8px 0 0;
    color: var(--label-2);
  }
  .overview {
    margin: 14px 0 0;
    white-space: pre-line;
    line-height: 1.5;
    color: var(--label-2);
  }
  .actions {
    display: flex;
    gap: 12px;
    margin-top: 20px;
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
    max-width: 44ch;
  }
</style>
