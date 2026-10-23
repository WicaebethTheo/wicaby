<script lang="ts">
  // A title's card (Android PosterCard / ThumbCard): a poster (2:3) with its name under it (titled), or a 16:9 card
  // with its
  // progress over the picture and two lines under it. The image is asked for at the device's pixel size (the
  // server resizes once), fades in over the BlurHash's average colour, and decodes off the main thread; without an
  // image the card shows the title on its tint.
  import type { BaseItem } from '$shared/models';
  import type { Api } from '$tv/api';
  import { episodeLine, progress } from '$tv/format';
  import { placeholder } from '$tv/images';
  import Check from '@lucide/svelte/icons/check';
  import { menuPress, type ItemMenuContext } from '../lib/item-menu.svelte';
  import { look } from '../lib/look.svelte';
  import { longpress } from '../lib/press';

  let {
    item,
    api,
    wide = false,
    titled = false,
    width,
    subtitle,
    menu = {},
    onclick,
  }: { item: BaseItem; api: Api; wide?: boolean; titled?: boolean; width: number; subtitle?: string; menu?: ItemMenuContext; onclick?: () => void } = $props();

  const dpr = Math.min(3, window.devicePixelRatio || 2);
  const height = $derived(wide ? Math.round((width * 9) / 16) : Math.round((width * 3) / 2));
  const src = $derived(wide ? api.thumb(item, Math.ceil(width * dpr)) : api.poster(item, Math.ceil(height * dpr)));
  const tint = $derived(placeholder(item, wide ? 'Thumb' : 'Primary') ?? placeholder(item, 'Backdrop'));
  const done = $derived(progress(item));
  const title = $derived(item.Type === 'Episode' && item.SeriesName ? item.SeriesName : item.Name);
  const line = $derived(subtitle ?? (item.Type === 'Episode' ? episodeLine(item) : undefined));
  let loaded = $state(false);
  let failed = $state(false);
</script>

<!-- A long press opens the title's menu (components/ItemMenu.svelte). -->
<button class="card pressable" class:wide style:width="{width}px" aria-label={title} {onclick} use:longpress={menuPress(item, menu)}>
  <span class="art" style:height="{height}px" style:background-color={tint}>
    {#if src && !failed}
      <img {src} alt="" loading="lazy" decoding="async" class:loaded onload={() => (loaded = true)} onerror={() => (failed = true)} />
    {/if}
    {#if !src || failed}<span class="fallback subhead">{title}</span>{/if}
    {#if done}<span class="bar"><span style:transform="scaleX({done})"></span></span>{/if}
    <!-- Watched tick or unplayed count (Android CardBadge), in the chosen accent. -->
    {#if !look.cardBadges}
      <!-- Settings > Appearance: no badges. -->
    {:else if item.UserData?.Played}
      <span class="badge tick"><Check size={13} strokeWidth={3} aria-label="✓" /></span>
    {:else if (item.UserData?.UnplayedItemCount ?? 0) > 0}
      <span class="badge count">{item.UserData!.UnplayedItemCount}</span>
    {/if}
  </span>
  {#if wide}
    <span class="subhead strong text">{title}</span>
    {#if line}<span class="footnote label-2 text">{line}</span>{/if}
  {:else if titled}
    <span class="footnote label-2 text">{title}</span>
  {/if}
</button>

<style>
  .card {
    display: flex;
    flex-direction: column;
    gap: 2px;
    text-align: left;
    flex: none;
  }
  .art {
    position: relative;
    display: block;
    border-radius: var(--r-md);
    overflow: hidden;
    background: var(--fill-2);
    margin-bottom: 6px;
  }
  /* A hairline inside the edge: dark artwork keeps its shape on the dark canvas. */
  .art::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    box-shadow: inset 0 0 0 0.5px rgb(255 255 255 / 0.1);
    pointer-events: none;
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    opacity: 0;
    transition: opacity var(--t-med) var(--ease-out);
  }
  img.loaded {
    opacity: 1;
  }
  .fallback {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 12px;
    text-align: center;
    color: #fff;
    font-weight: 600;
  }
  .bar {
    position: absolute;
    left: 10px;
    right: 10px;
    bottom: 10px;
    height: 4px;
    border-radius: 2px;
    background: rgb(255 255 255 / 0.32);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--accent);
    transform-origin: left;
  }
  .badge {
    position: absolute;
    top: 6px;
    right: 6px;
    min-width: 22px;
    height: 22px;
    border-radius: 11px;
    display: grid;
    place-items: center;
    background: var(--accent);
    color: var(--accent-fg);
    box-shadow: 0 1px 4px rgb(0 0 0 / 0.35);
    font-size: 11px;
    font-weight: 700;
    padding: 0 6px;
  }
  .badge.tick {
    padding: 0;
  }
  .strong {
    font-weight: 600;
  }
  .text {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
