<script lang="ts">
  // Home's hero (Android HeroCarousel, the desktop's Hero): the backdrop full bleed under the status bar, fading into
  // the canvas; at its foot, aligned left, the type and genres in small caps, the title's logo (or its name, large
  // and bold), the facts, then Play (the accent) and More info. Slides follow the finger (a native horizontal scroll that
  // snaps) and advance every few seconds (Settings > Home) while the hero is in view and untouched; the dots below mark the current one.
  // Pulling the page down stretches the artwork (the page writes --stretch).
  // resume: the titles watched lately instead (lib/home): "Resume" over the series' artwork, the episode, the time
  // left and the progress, and the one button that carries on.
  import type { BaseItem } from '$shared/models';
  import type { Api } from '$tv/api';
  import { t } from '$tv/i18n.svelte';
  import { placeholder } from '$tv/images';
  import { episodeLine, progress, runtimeText, TICKS_PER_MS } from '$tv/format';
  import { play } from '$tv/playback';
  import Play from '@lucide/svelte/icons/play';
  import { eyebrowLine, metaLine } from '../lib/format';
  import { look } from '../lib/look.svelte';
  import { itemRoute, nav } from '../lib/nav.svelte';

  // tops: each title's artwork top colour (lib/status-colour), its top fading into it under the status bar;
  // onposition: where the track is, in slides (1.5 = halfway from the second to the third), as it moves.
  // onshown: a slide's artwork is on screen (decoded), so its colour may take the status bar.
  let {
    items,
    api,
    resume = false,
    tops = {},
    onposition,
    onshown,
  }: { items: BaseItem[]; api: Api; resume?: boolean; tops?: Record<string, string>; onposition?: (at: number) => void; onshown?: (id: string) => void } = $props();

  const dpr = Math.min(3, window.devicePixelRatio || 2);
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let track: HTMLElement;
  let root: HTMLElement;
  let index = $state(0);
  let touching = $state(false);
  let offscreen = $state(false);
  // Artwork, one slide after the other: the first, then each next one once the previous is in, so a swipe never meets
  // an empty slide and the server resizes one image at a time. A failed load is asked again twice, a second apart.
  let warm = $state(new Set<number>([0]));
  let shown = $state(new Set<string>());
  let tries = $state<Record<string, number>>({});
  function loaded(i: number): void {
    const item = items[i];
    if (!item) return;
    shown = new Set([...shown, item.Id]);
    onshown?.(item.Id);
    const next = items.findIndex((_, k) => !warm.has(k));
    if (next >= 0) warm = new Set([...warm, next]);
  }
  function failed(i: number): void {
    const id = items[i]?.Id;
    if (!id) return;
    const n = tries[id] ?? 0;
    if (n < 2) setTimeout(() => (tries = { ...tries, [id]: n + 1 }), 1000);
    else loaded(i);
  }

  function onScroll(): void {
    onposition?.(track.scrollLeft / track.clientWidth);
    const i = Math.round(track.scrollLeft / track.clientWidth);
    if (i !== index) {
      index = i;
      warm = new Set([...warm, i - 1, i, i + 1]);
    }
  }

  $effect(() => {
    if (reduced || touching || offscreen || items.length < 2 || !look.heroSeconds) return;
    const id = setTimeout(() => {
      const next = (index + 1) % items.length;
      track.scrollTo({ left: next * track.clientWidth, behavior: next === 0 ? 'instant' : 'smooth' });
    }, look.heroSeconds * 1000);
    return () => clearTimeout(id);
  });

  $effect(() => {
    const io = new IntersectionObserver(([e]) => (offscreen = !e.isIntersecting), { threshold: 0.3 });
    io.observe(root);
    return () => io.disconnect();
  });

  // A retry asks the same image under another URL (the failed one may be cached).
  const backdrop = (item: BaseItem) => {
    const url = api.backdrop(item, Math.round(1100 * (dpr / 3) * (16 / 9)));
    return url && tries[item.Id] ? `${url}&retry=${tries[item.Id]}` : url;
  };
  const logo = (item: BaseItem) => api.logo(item, Math.round(280 * dpr));

  // ---- Resume slides ----
  const position = (item: BaseItem) => (item.UserData?.PlaybackPositionTicks ?? 0) / TICKS_PER_MS;
  const shownName = (item: BaseItem) => (item.Type === 'Episode' && item.SeriesName ? item.SeriesName : item.Name);
  function resumeLabel(item: BaseItem): string {
    if (position(item) > 0) {
      const left = runtimeText(Math.max(0, (item.RunTimeTicks ?? 0) - (item.UserData?.PlaybackPositionTicks ?? 0)));
      return left ? t('resume_time_left', left) : t('resume');
    }
    if (item.Type === 'Episode' && item.IndexNumber != null) return t('play_episode', item.ParentIndexNumber ?? 1, item.IndexNumber);
    return t('play');
  }
  // More info: the series' page for an episode.
  const infoRoute = (item: BaseItem) => (item.Type === 'Episode' && item.SeriesId ? itemRoute({ Id: item.SeriesId, Type: 'Series', ServerId: item.ServerId } as BaseItem) : itemRoute(item));
  // The artwork: the series' backdrop for an episode, else the episode's still.
  const artOf = (item: BaseItem) => backdrop(item) ?? api.thumb(item, Math.round(1100 * (dpr / 3) * (16 / 9)));
</script>

<section class="hero" bind:this={root} aria-roledescription="carousel">
  <!-- svelte-ignore a11y_no_static_element_interactions (touches only hold the timer; the slides scroll natively) -->
  <div class="track" bind:this={track} onscroll={onScroll} ontouchstart={() => (touching = true)} ontouchend={() => (touching = false)} ontouchcancel={() => (touching = false)}>
    {#each items as item, i (item.Id)}
      {@const art = warm.has(i) ? (resume ? artOf(item) : backdrop(item)) : undefined}
      {@const mark = logo(item)}
      <article class="slide" aria-roledescription="slide" aria-label={item.Name} style:background-color={placeholder(item, 'Backdrop') ?? '#111'}>
        {#if art}
          <img class="art" class:in={shown.has(item.Id)} src={art} alt="" decoding="async" fetchpriority={i === 0 ? 'high' : 'low'} onload={() => loaded(i)} onerror={() => failed(i)} />
        {/if}
        {#if tops[item.Id] && shown.has(item.Id)}<div class="blend" style:--top={tops[item.Id]} aria-hidden="true"></div>{/if}
        <div class="shade"></div>
        {#if resume}
          {@const done = progress(item)}
          <div class="content">
            <p class="eyebrow on">{t('web_resume_eyebrow')}</p>
            <button class="title-button" onclick={() => nav.push(infoRoute(item))}>
              {#if mark}
                <img class="logo" src={mark} alt={shownName(item)} decoding="async" />
              {:else}
                <h2 class="name">{shownName(item)}</h2>
              {/if}
            </button>
            <p class="subhead meta">{item.Type === 'Episode' ? (episodeLine(item) ?? item.Name) : metaLine(item)}</p>
            {#if done}<span class="progress" aria-hidden="true"><span style:transform="scaleX({done})"></span></span>{/if}
            <div class="actions">
              <button class="pill primary pressable" onclick={() => play(item)}>
                <Play size={18} fill="currentColor" strokeWidth={0} aria-hidden="true" />
                {resumeLabel(item)}
              </button>
              <button class="pill text pressable" onclick={() => nav.push(infoRoute(item))}>{t('more_info')}</button>
            </div>
          </div>
        {:else}
          <div class="content">
            <p class="eyebrow on">{eyebrowLine(item)}</p>
            <button class="title-button" onclick={() => nav.push(itemRoute(item))}>
              {#if mark}
                <img class="logo" src={mark} alt={item.Name} decoding="async" />
              {:else}
                <h2 class="name">{item.Name}</h2>
              {/if}
            </button>
            <p class="subhead meta">{metaLine(item)}</p>
            <div class="actions">
              <button class="pill primary pressable" onclick={() => play(item)}>
                <Play size={18} fill="currentColor" strokeWidth={0} aria-hidden="true" />
                {t('play')}
              </button>
              <button class="pill text pressable" onclick={() => nav.push(itemRoute(item))}>{t('more_info')}</button>
            </div>
          </div>
        {/if}
      </article>
    {/each}
  </div>
  {#if items.length > 1}
    <div class="dots" aria-hidden="true">
      {#each items as item, i (item.Id)}<span class:on={i === index}></span>{/each}
    </div>
  {/if}
</section>

<style>
  .hero {
    position: relative;
    /* Short enough that Continue watching shows under it at first sight. */
    height: min(calc(100vw * 1.12), 560px);
    transform-origin: 50% 100%;
    transform: scale(var(--stretch, 1));
  }
  /* The artwork's top fades into its top colour, the status bar's while it shows (lib/status-colour): solid at the
     edge, then eased out, so no seam shows under the clock. */
  .blend {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: 120px;
    background: linear-gradient(
      to bottom,
      var(--top) 0,
      var(--top) 6px,
      color-mix(in srgb, var(--top) 72%, transparent) 30px,
      color-mix(in srgb, var(--top) 38%, transparent) 62px,
      color-mix(in srgb, var(--top) 12%, transparent) 94px,
      transparent 120px
    );
    pointer-events: none;
  }
  /* The time watched, in the accent, as Continue watching's cards. */
  .progress {
    display: block;
    width: min(240px, 60%);
    height: 4px;
    margin-top: 10px;
    border-radius: 2px;
    background: rgb(255 255 255 / 0.28);
    overflow: hidden;
  }
  .progress > span {
    display: block;
    height: 100%;
    background: var(--accent);
    transform-origin: 0 50%;
  }
  .track {
    height: 100%;
    display: flex;
    overflow-x: auto;
    overflow-y: hidden;
    scroll-snap-type: x mandatory;
    scrollbar-width: none;
    overscroll-behavior-x: contain;
  }
  .slide {
    position: relative;
    flex: 0 0 100%;
    height: 100%;
    scroll-snap-align: center;
    scroll-snap-stop: always;
    overflow: hidden;
    color: #fff;
  }
  .art {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    object-position: 50% 30%;
    opacity: 0;
    transition: opacity var(--t-med) var(--ease-out);
  }
  .art.in {
    opacity: 1;
  }
  /* The canvas rises from the bottom with no hard edge (design.md). The top is left as it is: the status bar takes
     its colour (.blend), so a shade there would part them. */
  .shade {
    position: absolute;
    inset: 0;
    background:
      linear-gradient(to top, var(--bg) 0%, color-mix(in srgb, var(--bg) 78%, transparent) 20%, rgb(0 0 0 / 0.2) 50%, rgb(0 0 0 / 0) 66%);
  }
  .content {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 30px;
    padding: 0 max(var(--gutter), var(--safe-right)) 0 max(var(--gutter), var(--safe-left));
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }
  .eyebrow.on {
    color: rgb(255 255 255 / 0.75);
  }
  .title-button {
    display: block;
    max-width: 100%;
    text-align: left;
  }
  .logo {
    display: block;
    max-width: min(72vw, 300px);
    max-height: 96px;
    object-fit: contain;
    object-position: left bottom;
    filter: drop-shadow(0 2px 12px rgb(0 0 0 / 0.45));
  }
  .name {
    font-size: calc(40px * var(--text-scale));
    font-weight: 800;
    letter-spacing: -0.035em;
    line-height: 1.05;
    text-shadow: 0 2px 16px rgb(0 0 0 / 0.45);
  }
  .meta {
    color: rgb(255 255 255 / 0.78);
  }
  :global([data-theme='light']) .content {
    color: var(--label);
  }
  :global([data-theme='light']) .meta,
  :global([data-theme='light']) .eyebrow.on {
    color: var(--label-2);
  }
  .actions {
    display: flex;
    gap: 6px;
    margin-top: 8px;
  }
  /* "Plus d'infos" as Android's: a plain label beside Play. */
  .pill.text {
    background: transparent;
    color: inherit;
  }
  .dots {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 10px;
    display: flex;
    justify-content: center;
    align-items: center;
    gap: 6px;
  }
  .dots span {
    width: 6px;
    height: 6px;
    border-radius: 3px;
    background: var(--label-3);
  }
  .dots span.on {
    width: 18px;
    background: var(--label);
  }
</style>
