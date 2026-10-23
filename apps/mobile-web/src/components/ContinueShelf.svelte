<script lang="ts">
  // Continue watching, in large (the TV app's first row, Netflix's "Reprendre"): wide 16:9 cards at nearly the full
  // width, the title and the episode over the artwork's foot, the time left and the accent progress under them, a
  // play disc; a tap plays from where it stopped, a long press opens the title's menu. Snaps card by card.
  import type { BaseItem } from '$shared/models';
  import type { SeriesDates } from '$desktop/continue';
  import type { Api } from '$tv/api';
  import { episodeLine, progress } from '$tv/format';
  import { placeholder } from '$tv/images';
  import { apiOf } from '$tv/session.svelte';
  import Play from '@lucide/svelte/icons/play';
  import { menuPress } from '../lib/item-menu.svelte';
  import { longpress } from '../lib/press';
  import { look } from '../lib/look.svelte';

  let {
    title,
    items,
    api,
    subtitle,
    continueRow,
    onplay,
  }: { title: string; items: BaseItem[]; api: Api; subtitle?: (item: BaseItem) => string | undefined; continueRow?: SeriesDates; onplay: (item: BaseItem) => void } = $props();

  // Settings > Appearance's card size: a smaller size shows more of the next card.
  const width = $derived(Math.round(Math.min(440, window.innerWidth * 0.86) * [0.78, 1, 1.05][look.posterSize]));
  const height = $derived(Math.round((width * 9) / 16));
  const dpr = Math.min(3, window.devicePixelRatio || 2);
  const art = (item: BaseItem) => (apiOf(item.ServerId) ?? api).thumb(item, Math.ceil(width * dpr));
</script>

<section class="continue">
  <h2 class="title-2 head">{title}</h2>
  <div class="shelf-row">
    {#each items as item (`${item.ServerId}/${item.Id}`)}
      {@const done = progress(item)}
      {@const src = art(item)}
      {@const line = item.Type === 'Episode' ? episodeLine(item) : item.ProductionYear?.toString()}
      {@const meta = subtitle?.(item)}
      <button
        class="big pressable"
        style:width="{width}px"
        style:height="{height}px"
        style:background-color={placeholder(item, 'Thumb') ?? placeholder(item, 'Backdrop')}
        aria-label={item.Type === 'Episode' ? `${item.SeriesName} · ${line}` : item.Name}
        onclick={() => onplay(item)}
        use:longpress={menuPress(item, { continueRow })}
      >
        {#if src}<img {src} alt="" decoding="async" loading="lazy" />{/if}
        <span class="shade"></span>
        <span class="play"><Play size={22} fill="currentColor" strokeWidth={0} aria-hidden="true" /></span>
        <span class="info">
          <span class="headline ellipsis">{item.Type === 'Episode' && item.SeriesName ? item.SeriesName : item.Name}</span>
          {#if line || meta}<span class="footnote dim ellipsis">{[line, meta].filter(Boolean).join(' · ')}</span>{/if}
          {#if done}<span class="bar"><span style:transform="scaleX({done})"></span></span>{/if}
        </span>
      </button>
    {/each}
  </div>
</section>

<style>
  .continue {
    margin-top: 18px;
  }
  .head {
    padding: 0 max(var(--gutter), var(--safe-right)) 10px max(var(--gutter), var(--safe-left));
  }
  .big {
    position: relative;
    flex: none;
    border-radius: var(--r-lg);
    overflow: hidden;
    text-align: left;
    color: #fff;
    box-shadow: var(--shadow-1);
  }
  img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .shade {
    position: absolute;
    inset: 0;
    background: linear-gradient(to top, rgb(0 0 0 / 0.82), rgb(0 0 0 / 0.25) 46%, transparent 70%);
  }
  .play {
    position: absolute;
    top: 12px;
    right: 12px;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: rgb(0 0 0 / 0.42);
    -webkit-backdrop-filter: blur(12px);
    backdrop-filter: blur(12px);
  }
  .play :global(svg) {
    margin-left: 2px;
  }
  .info {
    position: absolute;
    left: 16px;
    right: 16px;
    bottom: 14px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .ellipsis {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .dim {
    color: rgb(255 255 255 / 0.78);
  }
  .bar {
    margin-top: 8px;
    height: 4px;
    border-radius: 2px;
    background: rgb(255 255 255 / 0.3);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--accent);
    transform-origin: left;
  }
</style>
