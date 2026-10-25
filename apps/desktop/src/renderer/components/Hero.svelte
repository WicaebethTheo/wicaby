<script lang="ts">
  import { tick, untrack } from 'svelte';
  import type { BaseItem } from '../../shared/models';
  import { itemKey, itemPath, playQueueFor } from '../lib/api';
  import { w } from '../lib/bridge';
  import { endsAt, episodeCode, progress, remaining, runtime, typeLabel } from '../lib/format';
  import { fmt, t } from '../lib/i18n.svelte';
  import { backdropUrl, logoUrl } from '../lib/images';
  import { morphFrom, reducedMotion, remember, reveal } from '../lib/motion';
  import { navigate } from '../lib/router.svelte';
  import { resumeAt } from '../lib/resume.svelte';
  import { errorMessage, settings, toast } from '../lib/stores.svelte';
  import Icon from './Icon.svelte';

  // onshuffle: a new set of titles (the Random source); the button shows only with it.
  let { items, eyebrow, onshuffle }: { items: BaseItem[]; eyebrow?: (item: BaseItem) => string; onshuffle?: () => Promise<void> } = $props();

  // Slides advance on a timer; nothing moves between two changes, so an idle Home draws no frames.
  const slideMs = $derived((settings.value?.ui.hero.intervalS ?? 8) * 1000);

  // Home already cut the list to the chosen count.
  const slides = $derived(items);
  // The shown slide is kept by key: Home reloads reorder `items`, and an index would jump to another title.
  let current = $state<string | undefined>();
  let paused = $state(false);
  let offscreen = $state(false);
  let busy = $state(false);
  let root: HTMLElement | undefined = $state();
  const auto = $derived(slides.length > 1 && !reducedMotion() && settings.value?.ui.heroAutoplay !== false);

  const idx = $derived(Math.max(0, slides.findIndex((s) => itemKey(s) === current)));
  const item = $derived(slides[idx]);
  // Pin the slide on screen before the first change, so a reload in the meantime does not swap it either.
  $effect(() => {
    const k = item && itemKey(item);
    if (k && untrack(() => current) !== k) current = k;
  });
  // Backdrops and logos load for the slide shown, its neighbours (ready for the crossfade either way) and the one
  // just left (still fading out). Not for slides that may never come (autoplay off, reduced motion), and not kept
  // after: twenty slides would otherwise leave twenty decoded 1920px backdrops in memory.
  let left = $state<string | undefined>();
  const warm = $derived([idx - 1, idx, idx + 1].map((i) => slides[(i + slides.length) % slides.length]).filter(Boolean).map(itemKey).concat(left ?? []));

  // Hover, focus or scrolling the hero away holds the slide; the full delay restarts afterwards.
  $effect(() => {
    if (!auto || paused || offscreen) return;
    const next = idx + 1;
    const id = setTimeout(() => go(next), slideMs);
    return () => clearTimeout(id);
  });

  $effect(() => {
    if (!root) return;
    const io = new IntersectionObserver(([e]) => (offscreen = !e.isIntersecting), { threshold: 0.25 });
    io.observe(root);
    return () => io.disconnect();
  });

  function go(i: number): void {
    left = current;
    current = itemKey(slides[(i + slides.length) % slides.length]);
  }

  async function shuffle(): Promise<void> {
    if (!onshuffle || busy) return;
    busy = true;
    try {
      await onshuffle();
    } finally {
      busy = false;
    }
    // The slide that held focus is gone: focus the new one's shuffle button.
    await tick();
    root?.querySelector<HTMLElement>('.slide.active .shuffle')?.focus({ preventScroll: true });
  }

  function titleOf(it: BaseItem): string {
    return it.Type === 'Episode' && it.SeriesName ? it.SeriesName : it.Name;
  }

  function meta(it: BaseItem): string[] {
    const out: string[] = [];
    if (it.Type === 'Episode') {
      const code = episodeCode(it);
      if (code) out.push(code);
    } else out.push(typeLabel(it.Type));
    if (it.Genres?.[0]) out.push(it.Genres[0]);
    if (it.ProductionYear) out.push(String(it.ProductionYear));
    if (it.RunTimeTicks && it.Type !== 'Series') out.push(runtime(it.RunTimeTicks));
    if (it.Type === 'Series' && it.ChildCount) out.push(t('common.count.seasons', { count: it.ChildCount }));
    return out;
  }

  const resumable = (it: BaseItem) => (it.UserData?.PlaybackPositionTicks ?? 0) > 0;

  async function play(it: BaseItem): Promise<void> {
    if (it.Type === 'Book') return navigate(itemPath(it, 'read'));
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

  function details(it: BaseItem): void {
    remember(it, backdropUrl(it, 1920));
    morphFrom(root?.querySelector<HTMLElement>('.bg.active'), itemKey(it));
    navigate(itemPath(it));
  }

  function onKey(e: KeyboardEvent): void {
    // Arrow keys inside the hero page slides instead of leaving it sideways.
    if (slides.length < 2 || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    const el = e.target as HTMLElement;
    const buttons = [...(el.closest('.actions')?.querySelectorAll('button') ?? [])];
    if (buttons.length === 0 || el !== (e.key === 'ArrowLeft' ? buttons[0] : buttons[buttons.length - 1])) return;
    e.preventDefault();
    e.stopPropagation();
    go(idx + (e.key === 'ArrowRight' ? 1 : -1));
    requestAnimationFrame(() => root?.querySelector<HTMLElement>('.slide.active .actions button')?.focus({ preventScroll: true }));
  }
</script>

{#if item}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <section
    class="hero on-media"
    bind:this={root}
    aria-roledescription={t('browse.hero.roleDescription')}
    aria-label={t('browse.hero.label')}
    onpointerenter={() => (paused = true)}
    onpointerleave={() => (paused = false)}
    onfocusin={() => (paused = true)}
    onfocusout={() => (paused = false)}
    onkeydown={onKey}
  >
    <div class="backdrops" aria-hidden="true">
      {#each slides as s, i (itemKey(s))}
        {@const bg = backdropUrl(s, 1920)}
        <div class="bg" class:active={i === idx}>
          {#if bg && warm.includes(itemKey(s))}<img class="reveal" use:reveal src={bg} alt="" decoding="async" fetchpriority={i === 0 ? 'high' : 'low'} />{/if}
        </div>
      {/each}
    </div>
    <div class="scrim"></div>

    {#each slides as s, i (itemKey(s))}
      {@const logo = logoUrl(s, 560)}
      {@const ends = endsAt(s)}
      <div class="slide" class:active={i === idx} inert={i !== idx} aria-hidden={i !== idx}>
        <div class="eyebrow">{eyebrow?.(s) ?? (resumable(s) ? t('browse.hero.resume') : t('browse.hero.label'))}</div>
        <!-- Logos load with the backdrops (the shown slide and the next), not for all the slides at once. -->
        {#if logo && warm.includes(itemKey(s))}
          <img class="logo reveal" use:reveal src={logo} alt={titleOf(s)} decoding="async" />
        {:else}
          <h1 class="title">{titleOf(s)}</h1>
        {/if}
        {#if s.Type === 'Episode'}<div class="episode">{s.Name}</div>{/if}
        <div class="meta">
          {#each meta(s) as m, j (j)}<span>{m}</span>{/each}
          {#if s.OfficialRating}<span class="chip">{s.OfficialRating}</span>{/if}
          {#if s.CommunityRating}
            <span class="rating"><Icon name="star" size={12} fill stroke={0} />{fmt.number(s.CommunityRating, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}</span>
          {/if}
        </div>
        {#if s.Overview}<p class="overview">{s.Overview}</p>{/if}
        <div class="actions">
          <button class="btn light lg" onclick={() => play(s)} aria-disabled={busy}>
            <Icon name="play" size={17} fill stroke={0} />
            {s.Type === 'Book' ? (resumable(s) ? t('browse.hero.resumeReading') : t('browse.hero.read')) : resumable(s) ? t('browse.hero.resume') : t('browse.hero.play')}
          </button>
          <button class="btn lg glass" onclick={() => details(s)}>{t('browse.hero.moreInfo')}</button>
          {#if onshuffle}
            <button class="btn lg glass icon shuffle" onclick={shuffle} aria-disabled={busy} aria-label={t('browse.hero.shuffle')} title={t('browse.hero.shuffle')}>
              <Icon name="refresh" size={18} />
            </button>
          {/if}
          {#if resumable(s)}
            <div class="resume">
              <span class="bar"><span style:transform="scaleX({progress(s) / 100})"></span></span>
              <span class="caption">{remaining(s)}{ends ? ` · ${ends}` : ''}</span>
            </div>
          {/if}
        </div>
      </div>
    {/each}

    {#if slides.length > 1}
      <div class="pager">
        <button class="arrow" onclick={() => go(idx - 1)} aria-label={t('browse.hero.previous')} title={t('browse.hero.previous')}>
          <Icon name="chevronLeft" size={16} />
        </button>
        <div class="dots" role="tablist" aria-label={t('browse.hero.slides')}>
          {#each slides as s, i (itemKey(s))}
            <button
              class="dot"
              class:active={i === idx}
              role="tab"
              aria-selected={i === idx}
              aria-label={titleOf(s)}
              tabindex="-1"
              onclick={() => go(i)}
            ></button>
          {/each}
        </div>
        <button class="arrow" onclick={() => go(idx + 1)} aria-label={t('browse.hero.next')} title={t('browse.hero.next')}>
          <Icon name="chevronRight" size={16} />
        </button>
      </div>
    {/if}
  </section>
{/if}

<style>
  .hero {
    position: relative;
    /* Light: the dark media band runs 96px past the text, then fades into the pale canvas (as on the phone). */
    --hero-fade: 0px;
    height: calc(clamp(460px, 74vh, 860px) + var(--hero-fade));
    margin-bottom: 4px;
    overflow: hidden;
    isolation: isolate;
  }
  /* Light theme: the art melts into a dark band (the hero is a media surface, .on-media), and the band's
     last 96px fade into the pale canvas instead of ending on a hard edge. */
  :global(:is([data-theme='light'], [data-scheme='light'])) .hero {
    --hero-fade: 96px;
    background: linear-gradient(to bottom, var(--bg) calc(100% - var(--hero-fade)), transparent);
  }
  .backdrops,
  .bg {
    position: absolute;
    inset: 0;
  }
  /* Fade the art out with a mask, not a colour, so it melts into any canvas (Mica, OLED). */
  .backdrops,
  .scrim {
    -webkit-mask-image: linear-gradient(to bottom, #000 55%, transparent calc(100% - var(--hero-fade)));
    mask-image: linear-gradient(to bottom, #000 55%, transparent calc(100% - var(--hero-fade)));
  }
  .backdrops {
    z-index: -2;
  }
  .bg {
    opacity: 0;
    transition: opacity var(--t-slow) var(--ease-in-out);
  }
  .bg.active {
    opacity: 1;
  }
  .bg img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: center 22%;
    transform: scale(1.08);
  }
  .scrim {
    position: absolute;
    inset: 0;
    z-index: -1;
    pointer-events: none;
    background:
      linear-gradient(to top, rgb(0 0 0 / 0.6) 0%, rgb(0 0 0 / 0.4) 30%, transparent 60%),
      linear-gradient(to right, rgb(0 0 0 / 0.62) 0%, rgb(0 0 0 / 0.3) 36%, transparent 64%),
      linear-gradient(to bottom, rgb(0 0 0 / 0.3), transparent 22%);
  }

  .slide {
    position: absolute;
    left: var(--gutter);
    bottom: calc(clamp(40px, 7vh, 72px) + var(--hero-fade));
    width: min(620px, 52%);
    opacity: 0;
    transform: translate3d(0, 14px, 0);
    pointer-events: none;
    transition:
      opacity var(--t-med) var(--ease),
      transform var(--t-med) var(--ease);
  }
  .slide.active {
    opacity: 1;
    transform: none;
    pointer-events: auto;
    transition:
      opacity var(--t-slow) var(--ease-out) var(--t-fast),
      transform var(--t-slow) var(--ease-out) var(--t-fast);
  }
  .eyebrow {
    margin-bottom: 12px;
    color: var(--label-2);
  }
  .logo {
    display: block;
    max-width: min(420px, 100%);
    max-height: 140px;
    object-fit: contain;
    object-position: left bottom;
    margin-bottom: 16px;
    filter: drop-shadow(0 2px 18px rgb(0 0 0 / 0.5));
  }
  .title {
    margin: 0 0 12px;
    font-size: var(--fs-hero);
    font-weight: 750;
    letter-spacing: -0.03em;
    line-height: 1;
    text-wrap: balance;
    text-shadow: 0 2px 30px rgb(0 0 0 / 0.35);
  }
  .episode {
    font-size: var(--fs-title-3);
    font-weight: 600;
    letter-spacing: -0.014em;
    margin-bottom: 6px;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    color: var(--label-2);
    font-size: var(--fs-callout);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }
  .meta > span:not(.chip):not(:first-child)::before {
    content: '·';
    margin-right: 6px;
    color: var(--label-3);
  }
  .meta .chip {
    margin-left: 4px;
  }
  .rating {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }
  .rating :global(svg) {
    color: var(--label-2);
  }
  .overview {
    margin: 12px 0 0;
    color: var(--label-2);
    font-size: var(--fs-headline);
    line-height: 1.5;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    max-width: 56ch;
    text-wrap: pretty;
  }
  .actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;
    margin-top: 22px;
  }
  .glass {
    background: rgb(255 255 255 / 0.16);
    -webkit-backdrop-filter: var(--blur);
    backdrop-filter: var(--blur);
  }
  .glass:hover,
  .glass:focus-visible {
    background: rgb(255 255 255 / 0.24);
  }
  .actions .btn:focus-visible {
    transform: scale(1.05);
  }
  .actions .btn.light:focus-visible {
    background: #fff;
  }
  .resume {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-left: 6px;
  }
  .resume .caption {
    color: var(--label-2);
    font-variant-numeric: tabular-nums;
  }
  .bar {
    width: 88px;
    height: 4px;
    border-radius: 2px;
    overflow: hidden;
    background: rgb(255 255 255 / 0.22);
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--label);
    transform-origin: left;
  }

  /* Apple TV style pager: dots, the current one is a still pill, between previous and next arrows. */
  .pager {
    position: absolute;
    right: var(--gutter);
    bottom: calc(clamp(46px, 7vh, 78px) - 12px + var(--hero-fade));
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .arrow {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    border-radius: 999px;
    color: var(--label);
    background: rgb(255 255 255 / 0.12);
    -webkit-backdrop-filter: var(--blur);
    backdrop-filter: var(--blur);
    opacity: 0.7;
    transition: opacity var(--t-fast) var(--ease);
  }
  .hero:hover .arrow,
  .arrow:focus-visible {
    opacity: 1;
  }
  .arrow:hover,
  .arrow:focus-visible {
    background: rgb(255 255 255 / 0.24);
  }
  .dots {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .dot {
    position: relative;
    width: 7px;
    height: 7px;
    border-radius: 999px;
    background: rgb(255 255 255 / 0.32);
    transition:
      transform var(--t-med) var(--spring);
  }
  /* Bigger hit area without changing the dot's size. */
  .dot::before {
    content: '';
    position: absolute;
    inset: -10px -5px;
  }
  .dot:hover {
    background: rgb(255 255 255 / 0.6);
  }
  .dot.active {
    width: 28px;
    background: var(--label);
  }
  @media (max-width: 1100px) {
    .slide {
      width: min(620px, 78%);
    }
  }
</style>
