<script lang="ts">
  // Accueil, as the TV app's Home: the hero first, full bleed under the status bar, Continue watching in large
  // right under it (components/ContinueShelf.svelte), then the user's other rows (lib/home.svelte.ts). The top row
  // (the account on the right) sits over the hero, which runs up to the status bar (app.css .status-colour); once
  // the hero scrolls away it turns into the canvas with the tab's name, as Netflix's. Pulling down at the top stretches the hero's
  // artwork. Continue watching and Next up play on a tap; other cards open their page.
  import type { BaseItem } from '$shared/models';
  import { t } from '$tv/i18n.svelte';
  import { useLoad } from '$tv/load.svelte';
  import { play } from '$tv/playback';
  import { api } from '$tv/session.svelte';
  import ContinueShelf from '../components/ContinueShelf.svelte';
  import Hero from '../components/Hero.svelte';
  import { reportError } from '../lib/diagnostics';
  import ProfileButton from '../components/ProfileButton.svelte';
  import Shelf from '../components/Shelf.svelte';
  import Spinner from '../components/Spinner.svelte';
  import { useHome } from '../lib/home.svelte';
  import { itemRoute, nav, shell, stack } from '../lib/nav.svelte';
  import { look } from '../lib/look.svelte';
  import { backdropTop, mixRgb, setPageStatusColour, toRgb } from '../lib/status-colour';

  const a = api()!;
  const views = useLoad<BaseItem[]>(() => 'views', () => a.views(), { persist: true });
  const home = useHome(a, () => views.value ?? []);

  let scroller: HTMLElement;
  let heroBox = $state<HTMLElement>();
  let solid = $state(false);

  function onScroll(): void {
    const y = scroller.scrollTop;
    // iOS reports the rubber band above the top as a negative offset.
    if (heroBox) heroBox.style.setProperty('--stretch', String(1 + Math.max(0, -y) / heroBox.offsetHeight));
    solid = y > (heroBox ? heroBox.offsetHeight - 120 : 2);
  }

  let seen = shell.reselect;
  $effect(() => {
    if (shell.reselect !== seen && shell.tab === 'home') scroller.scrollTo({ top: 0, behavior: 'smooth' });
    seen = shell.reselect;
  });

  const open = (item: BaseItem) => nav.push(itemRoute(item));
  const heroKey = $derived(`${home.heroResume ? 'resume' : 'featured'}:${home.hero.map((i) => i.Id).join(',')}`);
  $effect(() => {
    void heroKey;
    at = 0;
  });

  // At the top of Home, the status bar takes the colour along the top of the featured title's artwork, and the
  // artwork fades into it (Hero .blend): it seems to run on under the clock. Every slide's colour is read as soon as
  // the hero loads; while a slide is swiped the status bar blends the two, following the finger. Anywhere else,
  // the canvas.
  let tops = $state<Record<string, string>>({});
  let shownArt = $state<Record<string, true>>({});
  let at = $state(0);
  // A slide whose artwork is not on screen yet counts as the canvas.
  const canvas = () => toRgb(getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
  const colourOf = (id: string) => (shownArt[id] && tops[id]) || canvas();
  $effect(() => {
    const items = home.hero;
    let live = true;
    for (const item of items) {
      if (tops[item.Id]) continue;
      void backdropTop(a, item).then((c) => {
        if (live && c) tops[item.Id] = c;
      });
    }
    return () => {
      live = false;
    };
  });
  const topColour = $derived.by(() => {
    const items = home.hero;
    if (!items.length) return undefined;
    const i = Math.max(0, Math.min(items.length - 1, Math.floor(at)));
    return mixRgb(colourOf(items[i].Id), colourOf(items[Math.min(items.length - 1, i + 1)].Id), at - i);
  });
  const atTop = $derived(shell.tab === 'home' && stack[stack.length - 1]?.route.name === 'main' && !solid && home.hero.length > 0);
  $effect(() => {
    setPageStatusColour(atTop && topColour ? topColour : null);
  });
  $effect(() => () => setPageStatusColour(null));
</script>

<div class="page">
  <div class="scroller" data-scroll bind:this={scroller} onscroll={onScroll}>
    {#if home.hero.length}
      <!-- A new hero whenever its titles change (the featured ones, or those to resume once they load or as Settings
           change): its slide track starts afresh instead of keeping the old one's scroll and loads; iOS stopped
           scrolling Home with a track left scrolled past its end. -->
      {#key heroKey}
        <div bind:this={heroBox}><Hero items={home.hero} resume={home.heroResume} api={a} {tops} onposition={(p) => (at = p)} onshown={(id) => (shownArt[id] = true)} /></div>
      {/key}
    {:else}
      <div class="lead" aria-hidden="true"></div>
    {/if}
    {#each home.rows as row (row.key)}
      <!-- A row that fails to draw is left out (and logged, Settings > About); the others still show. -->
      <svelte:boundary onerror={(e) => reportError(`home row ${row.key}`, e)}>
        {#if row.continueRow && look.continueLarge}
          <ContinueShelf title={row.title} items={row.items} api={a} subtitle={row.subtitle} continueRow={row.continueRow} onplay={(i) => play(i)} />
        {:else}
          <Shelf title={row.title} items={row.items} api={a} wide={row.wide} subtitle={row.subtitle} menu={row.continueRow ? { continueRow: row.continueRow } : undefined} onopen={row.playable ? (i) => play(i) : open} />
        {/if}
        {#snippet failed()}{/snippet}
      </svelte:boundary>
    {/each}
    {#if home.loading && !home.rows.length}
      <!-- The first load ever (later ones paint from the stored rows): the rows' shapes, shimmering, not a spinner. -->
      <div class="ghost" aria-hidden="true">
        {#each [true, false, false] as wide, r (r)}
          <span class="ghost-title shimmer"></span>
          <div class="ghost-row">
            {#each Array(wide ? 2 : 4) as _, c (c)}<span class="shimmer" class:wide></span>{/each}
          </div>
        {/each}
      </div>
    {:else if home.loading}<div class="loading"><Spinner /></div>{/if}
  </div>

  <header class="top" class:solid class:over={home.hero.length > 0}>
    <h1 class="name">{t('tab_home')}</h1>
  </header>
  <ProfileButton floating onMedia={!solid && home.hero.length > 0} />
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
    padding-bottom: calc(var(--tabbar) + 12px);
  }
  /* No hero: the content starts under the top row. */
  .lead {
    height: calc(var(--top-bar) + 4px);
  }
  /* The top row: over the hero, nothing but its account button; past it, the canvas with a hairline. Opacity only. */
  .top {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    height: var(--top-bar);
    padding: var(--safe-top) calc(max(var(--gutter), var(--safe-right)) + 48px) 0 max(var(--gutter), var(--safe-left));
    display: flex;
    align-items: center;
    pointer-events: none;
    z-index: 4;
  }
  .top::after {
    content: '';
    position: absolute;
    inset: 0;
    z-index: -1;
    transition: opacity var(--t-med) var(--ease-out);
    background: var(--bg);
    box-shadow: 0 0.5px 0 var(--separator);
    opacity: 0;
  }
  .top.solid::after {
    opacity: 1;
  }
  .name {
    margin: 0;
    line-height: 1.15;
    font-size: var(--fs-title-1);
    font-weight: 800;
    letter-spacing: -0.03em;
    opacity: 0;
    transform: translate3d(0, 6px, 0);
    transition:
      opacity var(--t-med) var(--ease-out),
      transform var(--t-med) var(--ease-out);
  }
  .top.solid .name,
  .top:not(.over) .name {
    opacity: 1;
    transform: none;
  }
  .ghost {
    padding: 24px 0 0 max(var(--gutter), var(--safe-left));
    overflow: hidden;
  }
  .ghost-title {
    display: block;
    width: 160px;
    height: 20px;
    border-radius: 6px;
    margin: 6px 0 12px;
  }
  .ghost-row {
    display: flex;
    gap: 10px;
    margin-bottom: 22px;
  }
  .ghost-row span {
    flex: none;
    width: 116px;
    aspect-ratio: 2 / 3;
    border-radius: var(--r-md);
  }
  .ghost-row span.wide {
    width: min(300px, 74vw);
    aspect-ratio: 16 / 9;
  }
  .loading {
    display: grid;
    place-items: center;
    padding: 48px;
    color: var(--label-2);
  }
</style>
