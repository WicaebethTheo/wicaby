<script lang="ts">
  // A title's page, as the Android mobile app lays it out (ui/Detail.kt): the backdrop at the top (half-speed
  // parallax, fading into the canvas), the poster at its foot with the series, the title and the facts beside it;
  // Play across the width in the accent, the round actions under it (favourite, watched, trailer, more); version,
  // audio and subtitles in a group; the tagline, the overview and the technical tags; a series' season chips and
  // episode rows (long press: watched, earlier ones watched); the cast, bonus videos and similar titles.
  // The data and its rules are the TV web app's (versions, track memory, Trakt, toggles answered at once).
  import type { BaseItem } from '$shared/models';
  import { episodeLine, runtimeText, TICKS_PER_MS } from '$tv/format';
  import { t } from '$tv/i18n.svelte';
  import { placeholder } from '$tv/images';
  import { changed, useLoad } from '$tv/load.svelte';
  import { badges, hasTrailer, isBook, remoteTrailer, resumeMs, resumePage } from '$tv/media';
  import { openRemoteTrailer, play, playTrailer, read, shuffle } from '$tv/playback';
  import { apiOf } from '$tv/session.svelte';
  import { showToast } from '$tv/toast.svelte';
  import { trackName } from '$tv/track-memory';
  import * as Trakt from '$tv/trakt.svelte';
  import * as Versions from '$tv/versions';
  import Check from '@lucide/svelte/icons/check';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import Clapperboard from '@lucide/svelte/icons/clapperboard';
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import Heart from '@lucide/svelte/icons/heart';
  import Play from '@lucide/svelte/icons/play';
  import Shelf from '../components/Shelf.svelte';
  import Spinner from '../components/Spinner.svelte';
  import { endsAt, metaLine } from '../lib/format';
  import { handleBack, itemRoute, nav, peek } from '../lib/nav.svelte';
  import { showAlert } from '../lib/overlay.svelte';
  import { menuPress, openItemMenu } from '../lib/item-menu.svelte';
  import { longpress } from '../lib/press';
  import { reveal } from '../lib/motion';

  let { id, serverId }: { id: string; serverId?: string } = $props();
  // A page is opened for one title and never re-targeted: the initial value is the value.
  // svelte-ignore state_referenced_locally
  const client = apiOf(serverId)!;
  const dpr = Math.min(3, window.devicePixelRatio || 2);

  let reload = $state(0);
  const loaded = useLoad(() => `item-${id}-${reload}`, () => client.item(id));
  // What the card had, until the whole title is in (lib/nav peek): the page shows at once, the rest fills in.
  // svelte-ignore state_referenced_locally
  const early = peek(id);
  const item = $derived(loaded.value ?? (loaded.error === undefined ? early : undefined));
  // The rows under the fold (cast, extras, similar) join once the page has slid in: the slide stays smooth.
  let settled = $state(false);
  $effect(() => {
    const timer = setTimeout(() => (settled = true), 420);
    return () => clearTimeout(timer);
  });
  const series = $derived(item?.Type === 'Series');
  const book = $derived(!!item && isBook(item));

  const seasons = useLoad(() => (series ? `seasons-${id}` : 'none'), () => (series ? client.seasons(id) : Promise.resolve([])));
  const nextUp = useLoad(() => (series ? `nextup-${id}` : 'none-next'), () => (series ? client.nextUp(id, 1) : Promise.resolve([])));
  // The season of the next episode to watch, else the first; then whichever the user picks.
  let picked = $state(-1);
  const nextKnown = $derived(nextUp.value !== undefined || nextUp.error !== undefined);
  const seasonIndex = $derived(picked >= 0 ? picked : Math.max(0, (seasons.value ?? []).findIndex((s) => s.Id === nextUp.value?.[0]?.SeasonId)));
  const season = $derived(picked >= 0 || nextKnown ? seasons.value?.[seasonIndex] : undefined);
  let episodesNonce = $state(0);
  const episodes = useLoad(() => (season ? `episodes-${id}-${season.Id}-${episodesNonce}` : 'none-ep'), () => (season ? client.episodes(id, season.Id) : Promise.resolve([])));
  // The last season's episodes stay while the next one loads, so the list does not collapse and shift the page.
  let shownEpisodes = $state<BaseItem[]>([]);
  $effect(() => {
    if (episodes.value !== undefined) shownEpisodes = episodes.value;
    else if (episodes.error !== undefined) shownEpisodes = [];
  });
  const extras = useLoad(() => (book ? 'none-extras' : `extras-${id}`), () => (book ? Promise.resolve([]) : client.specialFeatures(id)));
  const similar = useLoad(() => `similar-${id}`, () => client.similar(id, 16));

  // The toggles answer at once; the next load of the item takes over.
  let favorite = $derived(item?.UserData?.IsFavorite === true);
  let watched = $derived(item?.UserData?.Played === true);
  const target = $derived<BaseItem | undefined>(series ? (nextUp.value?.[0] ?? shownEpisodes[0]) : item);
  const resume = $derived(target ? resumeMs(target) : 0);
  const bookPage = $derived(item && book ? resumePage(item) : null);
  let sourceId = $derived(item ? Versions.selected(item)?.Id : undefined);
  const source = $derived(item?.MediaSources?.find((s) => s.Id === sourceId) ?? item?.MediaSources?.[0]);
  const tags = $derived(item ? badges(item, source) : []);

  const playLabel = $derived.by(() => {
    if (book) return bookPage !== null ? t('reader_resume_page', bookPage + 1) : t('reader_read');
    if (!target) return t('play');
    if (resume > 0) {
      const left = runtimeText(Math.max(0, (target.RunTimeTicks ?? 0) - resume * TICKS_PER_MS));
      return left ? t('resume_time_left', left) : t('resume');
    }
    if (series && target.IndexNumber != null) return t('play_episode', target.ParentIndexNumber ?? 1, target.IndexNumber);
    return t('play');
  });
  // "Ends at" for a film (the desktop's item page).
  const ends = $derived(!series && !book && target?.RunTimeTicks ? endsAt(target.RunTimeTicks / TICKS_PER_MS - resume) : '');

  function onPlay(): void {
    if (book && item) read(item);
    else if (target) play(target);
  }

  function fromStart(): void {
    if (book && item) read(item, { fromStart: true });
    else if (target) play(target, { fromStart: true });
  }

  async function toggleFavorite(): Promise<void> {
    if (!item) return;
    const on = !favorite;
    favorite = on;
    try {
      await client.setFavorite(item.Id, on);
      changed();
    } catch {
      favorite = !on;
    }
  }

  async function toggleWatched(): Promise<void> {
    if (!item) return;
    const on = !watched;
    watched = on;
    try {
      await client.setPlayed(item.Id, on);
      Trakt.history(client, item, on);
      changed();
    } catch {
      watched = !on;
    }
  }

  // Marks a list of episodes; the season's rows reload after.
  async function mark(list: BaseItem[], on: boolean): Promise<void> {
    try {
      await client.markPlayed(list, on);
      changed();
      episodesNonce++;
    } catch {
      showToast(t('mark_failed'));
    }
  }

  // A local trailer plays in the app's player (reporting nothing); a remote one opens elsewhere.
  async function trailer(): Promise<void> {
    if (!item) return;
    if ((item.LocalTrailerCount ?? 0) > 0) {
      const local = (await client.localTrailers(item.Id).catch(() => []))[0];
      if (local) return playTrailer(local);
    }
    const url = remoteTrailer(item);
    if (url) openRemoteTrailer(url);
  }

  // "…": the title's whole menu (components/ItemMenu.svelte), as its long press; a book keeps its own (its page).
  function more(): void {
    if (!item) return;
    if (!book) {
      openItemMenu(item, { onPage: true });
      return;
    }
    showAlert({
      title: item.Name,
      actions: [
        ...((book ? bookPage !== null : resume > 0) && target ? [{ label: t('from_start'), run: fromStart }] : []),
        ...(series || item.Type === 'Season' ? [{ label: t('shuffle'), run: () => void shuffle(item) }] : []),
        { label: watched ? t('mark_unplayed') : t('mark_played'), run: () => void toggleWatched() },
      ],
    });
  }

  // ---- Version, audio, subtitles: rows of a group, each opening its sheet ----
  const audio = $derived(source?.MediaStreams?.filter((s) => s.Type === 'Audio') ?? []);
  const subs = $derived(source?.MediaStreams?.filter((s) => s.Type === 'Subtitle') ?? []);
  const versions = $derived(item?.MediaSources ?? []);
  const versionLabels = $derived(item ? Versions.labels(item) : []);
  let pickVersion = $state(0);
  const pick = $derived.by(() => {
    void pickVersion;
    return item && source ? Versions.pick(item.Id, source.Id) : undefined;
  });
  const audioIndex = $derived(Math.max(0, audio.findIndex((s) => s.Index === (pick?.audio ?? (source ? Versions.defaultAudioStream(source)?.Index : undefined)))));
  const subIndex = $derived(Math.max(0, subs.findIndex((s) => s.Index === (pick?.subtitle ?? (source ? Versions.defaultSubtitleIndex(source) : -1))) + 1));
  const showTracks = $derived(!series && !book && !!source && (versions.length > 1 || audio.length > 1 || subs.length > 0));
  const subNames = $derived([t('subtitles_off'), ...subs.map((s) => trackName(s))]);

  function picker(title: string, labels: string[], selected: number, onpick: (i: number) => void): void {
    showAlert({ title, actions: labels.map((label, i) => ({ label, run: () => onpick(i) })), selected });
  }

  function setPick(p: Versions.TrackPick): void {
    if (!item || !source) return;
    Versions.setPick(item.Id, source.Id, { ...pick, ...p });
    pickVersion++;
  }

  // ---- The page as it scrolls (one write per frame, transform and opacity only) ----
  // The page rises over its artwork, which drifts at half speed, softens (a blurred copy fading in) and dims, so the
  // text over it stays legible; the poster and the titles fade as they near the top, where the bar takes the title
  // over. A pull down stretches the artwork.
  let scroller: HTMLElement;
  let art = $state<HTMLElement>();
  let soft = $state<HTMLElement>();
  let identity = $state<HTMLElement>();
  let bar = $state<HTMLElement>();
  let solid = $state(false);
  let expanded = $state(false);
  let frame = 0;
  const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
  function onScroll(): void {
    frame ||= requestAnimationFrame(paintScroll);
  }
  function paintScroll(): void {
    frame = 0;
    const y = scroller.scrollTop;
    const h = art?.offsetHeight ?? 320;
    if (art) art.style.transform = y > 0 ? `translate3d(0, ${(y * 0.5).toFixed(1)}px, 0)` : `scale(${(1 + -y / h).toFixed(4)})`;
    soft?.style.setProperty('opacity', clamp01(y / (h * 0.7)).toFixed(3));
    const fade = clamp01((y - h * 0.3) / (h * 0.4));
    if (identity) {
      identity.style.opacity = (1 - fade).toFixed(3);
      identity.style.transform = fade ? `translate3d(0, ${(-fade * 14).toFixed(1)}px, 0) scale(${(1 - fade * 0.05).toFixed(4)})` : '';
    }
    const show = clamp01((y - (h - 150)) / 80);
    bar?.style.setProperty('--show', show.toFixed(3));
    solid = show > 0.5;
  }

  // Cast and crew, as Emby lists them: the actors first (in the server's order), then directors, writers and the rest,
  // whose job stands where an actor's role does.
  const CREW: Record<string, string> = { Director: 'web_director', Writer: 'web_writer', Producer: 'web_producer', Composer: 'web_composer', GuestStar: 'web_guest_star' };
  const people = $derived.by(() => {
    const all = item?.People ?? [];
    const actors = all.filter((p) => p.Type === 'Actor' || !p.Type);
    const crew = all.filter((p) => p.Type && p.Type !== 'Actor').map((p) => ({ ...p, Role: p.Role || (CREW[p.Type!] ? t(CREW[p.Type!]) : p.Type) }));
    return [...actors, ...crew].slice(0, 40);
  });
  const backdrop = $derived(item ? (client.backdrop(item, Math.round(1100 * dpr)) ?? client.poster(item, Math.round(900 * dpr))) : undefined);
  const poster = $derived(item ? client.poster(item, Math.round(162 * dpr)) : undefined);
  const seasonPlayed = $derived(shownEpisodes.length > 0 && shownEpisodes.every((e) => e.UserData?.Played));
</script>

<div class="page">
  <div class="scroller" bind:this={scroller} onscroll={onScroll}>
    {#if !item}
      <div class="center">
        {#if loaded.error !== undefined}
          <p class="title-3 label-2">{t('load_error')}</p>
          <button class="pill" onclick={() => reload++}>{t('retry')}</button>
        {:else}
          <Spinner size={30} />
        {/if}
      </div>
    {:else}
      <header class="header">
        <div class="art" bind:this={art} style:background-color={placeholder(item, 'Backdrop') ?? placeholder(item, 'Primary') ?? '#111'}>
          {#if backdrop}<img src={backdrop} alt="" decoding="async" fetchpriority="high" />{/if}
          <div class="soft" bind:this={soft}>
            {#if backdrop}<img src={backdrop} alt="" decoding="async" />{/if}
          </div>
          <div class="shade"></div>
        </div>
        <div class="identity" bind:this={identity}>
          {#if poster}
            <img class="poster" src={poster} alt="" decoding="async" />
          {/if}
          <div class="titles">
            {#if item.Type === 'Episode'}<p class="callout label-2 ellipsis">{item.SeriesName ?? ''}</p>{/if}
            <h1 class="title-1 name">{item.Type === 'Episode' ? (episodeLine(item) ?? item.Name) : item.Name}</h1>
            <p class="footnote label-2 meta">
              {metaLine(item)}
              {#if item.OfficialRating}<span class="chip">{item.OfficialRating}</span>{/if}
            </p>
          </div>
        </div>
      </header>

      <div class="content">
      <div class="body">
        <button class="pill primary play pressable" onclick={onPlay} disabled={!target && !book}>
          <Play size={18} fill="currentColor" strokeWidth={0} aria-hidden="true" />
          <span class="ellipsis">{playLabel}</span>
        </button>
        {#if ends}<p class="footnote label-3 ends">{ends}</p>{/if}

        <div class="actions">
          {#if hasTrailer(item)}
            <button class="action" onclick={trailer}><span class="round"><Clapperboard size={21} aria-hidden="true" /></span><span class="caption">{t('trailer')}</span></button>
          {/if}
          <button class="action" class:active={favorite} aria-pressed={favorite} onclick={toggleFavorite}>
            <span class="round"><Heart size={21} fill={favorite ? 'currentColor' : 'none'} aria-hidden="true" /></span>
            <span class="caption">{t('favorite')}</span>
          </button>
          <button class="action" class:active={watched} aria-pressed={watched} onclick={toggleWatched}>
            <span class="round">{#if watched}<CircleCheck size={22} aria-hidden="true" />{:else}<Check size={22} aria-hidden="true" />{/if}</span>
            <span class="caption">{t('watched')}</span>
          </button>
          <button class="action" onclick={more}><span class="round"><Ellipsis size={22} aria-hidden="true" /></span><span class="caption">{t('more')}</span></button>
        </div>

        {#if showTracks && source}
          <div class="group">
            {#if versions.length > 1}
              {@const i = Math.max(0, versions.findIndex((v) => v.Id === source.Id))}
              <button
                class="selector"
                onclick={() =>
                  picker(t('version'), versionLabels, i, (n) => {
                    sourceId = versions[n].Id;
                    Versions.select(item.Id, versions[n].Id);
                  })}
              >
                <span class="key">{t('version')}</span><span class="value ellipsis">{versionLabels[i] ?? ''}</span><ChevronRight size={18} aria-hidden="true" />
              </button>
            {/if}
            {#if audio.length > 1}
              <button class="selector" onclick={() => picker(t('audio'), audio.map((s) => trackName(s)), audioIndex, (n) => setPick({ audio: audio[n].Index }))}>
                <span class="key">{t('audio')}</span><span class="value ellipsis">{trackName(audio[audioIndex])}</span><ChevronRight size={18} aria-hidden="true" />
              </button>
            {/if}
            {#if subs.length}
              <button class="selector" onclick={() => picker(t('subtitles'), subNames, subIndex, (n) => setPick({ subtitle: n === 0 ? -1 : subs[n - 1].Index }))}>
                <span class="key">{t('subtitles')}</span><span class="value ellipsis">{subNames[subIndex]}</span><ChevronRight size={18} aria-hidden="true" />
              </button>
            {/if}
          </div>
        {/if}

        {#if item.Taglines?.[0] || item.Overview || tags.length}
          <div class="about" use:reveal>
            {#if item.Taglines?.[0]}<p class="headline">{item.Taglines[0]}</p>{/if}
            {#if item.Overview}
              <button class="overview callout" class:expanded onclick={() => (expanded = !expanded)}>{item.Overview}</button>
              {#if !expanded}<button class="footnote more-link" onclick={() => (expanded = true)}>{t('more')}</button>{/if}
            {/if}
            {#if tags.length}
              <div class="tags">{#each tags as tag (tag)}<span class="tag caption">{tag}</span>{/each}</div>
            {/if}
          </div>
        {/if}
      </div>

      {#if series && seasons.value?.length}
        <div class="season-row" use:reveal>
          {#each seasons.value as s, i (s.Id)}
            <button class="chip-btn" class:selected={i === seasonIndex} onclick={() => (picked = i)}>{s.Name?.trim() || t('season_n', s.IndexNumber ?? i + 1)}</button>
          {/each}
          {#if shownEpisodes.length}
            <button class="chip-btn" onclick={() => mark(shownEpisodes, !seasonPlayed)}>
              {#if seasonPlayed}<CircleCheck size={16} aria-hidden="true" />{:else}<Check size={16} aria-hidden="true" />{/if}
              {t(seasonPlayed ? 'mark_season_unplayed' : 'mark_season_played')}
            </button>
          {/if}
        </div>
        <div class="episodes">
          {#each shownEpisodes as ep (ep.Id)}
            {@const thumb = client.thumb(ep, Math.round(150 * dpr))}
            {@const done = ep.UserData?.PlayedPercentage}
            <button class="episode pressable" onclick={() => play(ep)} use:longpress={menuPress(ep)} use:reveal>
              <span class="ep-art" style:background-color={placeholder(ep, 'Primary') ?? undefined}>
                {#if thumb}<img src={thumb} alt="" loading="lazy" decoding="async" />{/if}
                {#if done}<span class="ep-bar"><span style:transform="scaleX({done / 100})"></span></span>{/if}
                {#if ep.UserData?.Played}<span class="ep-tick"><Check size={13} strokeWidth={3} aria-hidden="true" /></span>{/if}
              </span>
              <span class="ep-text">
                <span class="callout clamp2">{ep.IndexNumber != null ? t('episode_numbered', ep.IndexNumber, ep.Name) : ep.Name}</span>
                {#if runtimeText(ep.RunTimeTicks)}<span class="footnote label-2">{runtimeText(ep.RunTimeTicks)}</span>{/if}
              </span>
            </button>
          {/each}
        </div>
      {/if}

      {#if settled && people.length}
        <section class="people" use:reveal>
          <h2 class="title-3 head">{t('web_cast_crew')}</h2>
          <div class="shelf-row">
            {#each people as p (p.Id + (p.Role ?? ''))}
              {@const face = p.PrimaryImageTag ? client.image(p.Id, 'Primary', p.PrimaryImageTag, { maxHeight: Math.round(96 * dpr) }) : undefined}
              <button class="person pressable" onclick={() => nav.push({ name: 'person', id: p.Id, serverId: item?.ServerId, title: p.Name })}>
                <span class="face">
                  {#if face}<img src={face} alt="" loading="lazy" decoding="async" />{:else}<span class="initial">{p.Name.slice(0, 1)}</span>{/if}
                </span>
                <span class="footnote ellipsis">{p.Name}</span>
                {#if p.Role}<span class="caption label-2 ellipsis">{p.Role}</span>{/if}
              </button>
            {/each}
          </div>
        </section>
      {/if}

      {#if settled && extras.value?.length}
        <div use:reveal><Shelf title={t('bonus')} items={extras.value} api={client} wide onopen={(i) => playTrailer(i)} /></div>
      {/if}
      {#if settled && similar.value?.length}
        <div use:reveal><Shelf title={t('similar')} items={similar.value} api={client} onopen={(i) => nav.push(itemRoute(i))} /></div>
      {/if}
      </div>
    {/if}
  </div>

  <div class="bar" class:solid bind:this={bar}>
    <span class="headline ellipsis">{item?.Name ?? ''}</span>
  </div>
  <button class="round back" class:on-art={!solid} aria-label={t('back')} onclick={() => handleBack()}>
    <ChevronLeft size={24} strokeWidth={2.2} aria-hidden="true" />
  </button>
</div>

<style>
  .page {
    position: relative;
    height: 100%;
  }
  .scroller {
    height: 100%;
    overflow-y: auto;
    overscroll-behavior-y: contain;
    padding-bottom: calc(var(--tabbar) + 28px);
  }
  .center {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    color: var(--label-2);
  }
  .ellipsis {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  /* The backdrop, then the poster and the titles overlapping its foot (96 px into it). Everything under the header
     (.content) stacks above the artwork, which drifts down behind it. */
  .header {
    position: relative;
    z-index: 0;
    padding-bottom: 4px;
  }
  .content {
    position: relative;
    z-index: 1;
  }
  .art {
    position: relative;
    height: min(calc(100vw * 0.82), 420px);
    overflow: hidden;
    transform-origin: 50% 100%;
    will-change: transform;
  }
  .art > img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: 50% 25%;
  }
  /* The artwork softened: blurred once (a still layer), only its opacity follows the scroll. */
  .soft {
    position: absolute;
    inset: 0;
    opacity: 0;
    background: color-mix(in srgb, var(--bg) 35%, transparent);
    will-change: opacity;
  }
  .soft > img {
    position: absolute;
    inset: -40px;
    width: calc(100% + 80px);
    height: calc(100% + 80px);
    object-fit: cover;
    object-position: 50% 25%;
    filter: blur(28px) saturate(1.5) brightness(0.7);
  }
  .shade {
    position: absolute;
    inset: 0;
    background:
      linear-gradient(to bottom, color-mix(in srgb, var(--bg) 40%, transparent), transparent 100px),
      linear-gradient(to bottom, transparent 50%, var(--bg));
  }
  .identity {
    position: relative;
    margin-top: -96px;
    transform-origin: 0 100%;
    will-change: opacity, transform;
    padding: 0 max(var(--gutter), var(--safe-right)) 0 max(var(--gutter), var(--safe-left));
    display: flex;
    align-items: flex-end;
    gap: 16px;
  }
  .poster {
    width: 108px;
    aspect-ratio: 2 / 3;
    border-radius: var(--r-md);
    object-fit: cover;
    background: var(--bg-elevated-2);
    box-shadow: var(--shadow-2);
    flex: none;
  }
  .titles {
    flex: 1;
    min-width: 0;
    padding-bottom: 4px;
  }
  .name {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .meta {
    margin-top: 6px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .body {
    padding: 20px max(var(--gutter), var(--safe-right)) 0 max(var(--gutter), var(--safe-left));
  }
  .play {
    width: 100%;
  }
  .ends {
    margin-top: 6px;
  }
  /* Android ActionIcon: a round fill with its caption under it, evenly spread. */
  .actions {
    display: flex;
    justify-content: space-evenly;
    margin-top: 16px;
  }
  .action {
    flex: 1;
    max-width: 92px;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 4px 0;
    color: var(--label-2);
  }
  .action .round {
    width: 48px;
    height: 48px;
    color: inherit;
  }
  .action.active {
    color: var(--label);
  }
  .action .caption {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* A group of selector rows (Android TrackSelectors): the elevated surface, rounded. */
  .group {
    margin-top: 18px;
    border-radius: var(--r-lg);
    background: var(--bg-elevated);
    overflow: hidden;
  }
  .selector {
    width: 100%;
    min-height: 52px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 12px 0 16px;
    text-align: left;
    color: var(--label);
  }
  .selector + .selector {
    border-top: 0.5px solid var(--separator);
  }
  .selector:active {
    background: var(--fill-2);
  }
  .key {
    flex: none;
  }
  .value {
    flex: 1;
    text-align: right;
    color: var(--label-2);
  }
  .selector :global(svg) {
    color: var(--label-3);
    flex: none;
  }
  .about {
    margin-top: 18px;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .overview {
    text-align: left;
    color: var(--label);
    line-height: 1.45;
    display: -webkit-box;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .overview.expanded {
    -webkit-line-clamp: unset;
    line-clamp: unset;
  }
  .more-link {
    align-self: flex-start;
    color: var(--label-2);
    font-weight: 600;
  }
  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 8px;
  }
  .tag {
    padding: 3px 7px;
    border-radius: var(--r-xs);
    background: var(--fill-2);
    color: var(--label-2);
  }
  /* Season chips (Android Chip): fill-4 when selected, fill-1 otherwise. */
  .season-row {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    scrollbar-width: none;
    padding: 26px max(var(--gutter), var(--safe-right)) 8px max(var(--gutter), var(--safe-left));
  }
  .chip-btn {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 36px;
    padding: 0 14px;
    border-radius: 18px;
    background: var(--fill-1);
    color: var(--label-2);
    font-size: var(--fs-callout);
    white-space: nowrap;
  }
  .chip-btn.selected {
    background: var(--fill-4);
    color: var(--label);
  }
  .episode {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 10px max(var(--gutter), var(--safe-right)) 10px max(var(--gutter), var(--safe-left));
    text-align: left;
  }
  .ep-art {
    position: relative;
    width: 150px;
    aspect-ratio: 16 / 9;
    border-radius: var(--r-sm);
    overflow: hidden;
    background: var(--bg-elevated-2);
    flex: none;
  }
  .ep-art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .ep-bar {
    position: absolute;
    left: 8px;
    right: 8px;
    bottom: 7px;
    height: 3px;
    border-radius: 2px;
    background: rgb(255 255 255 / 0.28);
    overflow: hidden;
  }
  .ep-bar span {
    display: block;
    height: 100%;
    background: var(--accent);
    transform-origin: left;
  }
  .ep-tick {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: rgb(0 0 0 / 0.55);
    color: #fff;
  }
  .ep-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    color: var(--label);
  }
  .clamp2 {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .people {
    margin-top: 26px;
  }
  .head {
    padding: 0 max(var(--gutter), var(--safe-right)) 10px max(var(--gutter), var(--safe-left));
  }
  .person {
    flex: none;
    color: var(--label);
    width: 84px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    text-align: center;
  }
  .person .ellipsis {
    max-width: 100%;
  }
  .face {
    width: 76px;
    height: 76px;
    border-radius: 50%;
    overflow: hidden;
    background: var(--fill-2);
    display: grid;
    place-items: center;
    margin-bottom: 6px;
  }
  .face img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .initial {
    font-size: 28px;
    font-weight: 600;
    color: var(--label-2);
  }
  .bar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: var(--top-bar);
    padding: var(--safe-top) 72px 0;
    display: grid;
    place-items: center;
    /* The canvas, not a blur over the artwork (the top row of every page), coming in with the scroll; the title
       rises into it. */
    --show: 0;
    background: var(--bg);
    border-bottom: 0.5px solid color-mix(in srgb, var(--separator) calc(var(--show) * 100%), transparent);
    opacity: var(--show);
    pointer-events: none;
    z-index: 4;
  }
  .bar > span {
    transform: translate3d(0, calc((1 - var(--show)) * 10px), 0);
  }
  .back {
    position: absolute;
    top: calc(var(--safe-top) + 4px);
    left: max(var(--gutter), var(--safe-left));
    width: 36px;
    height: 36px;
    z-index: 5;
  }
</style>
