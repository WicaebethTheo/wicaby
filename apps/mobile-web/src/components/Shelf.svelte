<script lang="ts">
  // A row of cards under its title (with a chevron when it opens a full list), scrolling sideways and settling on a
  // card's edge. Cards are sized so the next one peeks in: the row reads as scrollable.
  import type { BaseItem } from '$shared/models';
  import type { Api } from '$tv/api';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import type { ItemMenuContext } from '../lib/item-menu.svelte';
  import { look, posterWidth, wideWidth } from '../lib/look.svelte';
  import Card from './Card.svelte';

  let {
    title,
    items,
    api,
    wide = false,
    subtitle,
    menu,
    onopen,
    onall,
  }: {
    title: string;
    items: BaseItem[];
    api: Api;
    wide?: boolean;
    subtitle?: (item: BaseItem) => string | undefined;
    menu?: ItemMenuContext;
    onopen: (item: BaseItem) => void;
    onall?: () => void;
  } = $props();

  // Android MediaRow: 16:9 cards at about three quarters of the width, posters at 116 dp.
  const width = $derived(wide ? wideWidth(Math.min(300, window.innerWidth * 0.74)) : posterWidth(116));
</script>

<section class="shelf">
  {#if onall}
    <button class="head" onclick={onall}>
      <h2 class="title-3">{title}</h2>
      <ChevronRight size={22} strokeWidth={2.2} aria-hidden="true" />
    </button>
  {:else}
    <h2 class="title-3 head">{title}</h2>
  {/if}
  <div class="shelf-row">
    {#each items as item (`${item.ServerId ?? ''}:${item.Id}`)}
      <Card {item} {api} {wide} titled={!wide && look.posterTitles} {width} subtitle={subtitle?.(item)} {menu} onclick={() => onopen(item)} />
    {/each}
  </div>
</section>

<style>
  .shelf {
    margin-top: 26px;
    content-visibility: auto;
    contain-intrinsic-size: auto 260px;
  }
  .head {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 max(var(--gutter), var(--safe-right)) 10px max(var(--gutter), var(--safe-left));
    color: var(--label);
    text-align: left;
  }
  .head :global(svg) {
    color: var(--label-3);
  }
</style>
