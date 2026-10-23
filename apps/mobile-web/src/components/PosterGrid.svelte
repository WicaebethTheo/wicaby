<script lang="ts">
  // A library's posters in a grid that stays smooth at any size (thousands of titles): only the rows in view, and two
  // above and below, are in the page, each card placed by transform; pages of 100 load as they come near. The grid
  // follows its page's scroller (scroller), and starts over when [key] changes (another sort or filter).
  import type { BaseItem, ItemsResult } from '$shared/models';
  import type { Api } from '$tv/api';
  import { untrack } from 'svelte';
  import { look, textScale } from '../lib/look.svelte';
  import Card from './Card.svelte';

  let {
    api,
    key,
    page,
    scroller,
    onopen,
    total = $bindable(-1),
  }: { api: Api; key: string; page: (start: number, limit: number) => Promise<ItemsResult>; scroller: HTMLElement | undefined; onopen: (item: BaseItem) => void; total?: number } = $props();

  const PAGE = 100;
  const GAP = 12;
  const TITLE = 22; // the footnote line under each poster
  const BUFFER = 2;

  let items: (BaseItem | null)[] = [];
  let rev = $state(0);
  const inFlight = new Set<number>();
  let grid = $state<HTMLElement>();
  let width = $state(0);
  let viewTop = $state(0);
  let viewH = $state(800);

  // Settings > Appearance: small posters fit one more column, large ones one fewer; the titles under them are optional.
  const cols = $derived((width >= 700 ? 6 : width >= 520 ? 4 : 3) + [1, 0, -1][look.posterSize]);
  const cardW = $derived(Math.floor((width - GAP * (cols - 1)) / cols));
  const pitch = $derived(Math.round(cardW * 1.5) + 6 + (look.posterTitles ? Math.ceil(TITLE * textScale()) : 0) + GAP);
  const rows = $derived(total > 0 ? Math.ceil(total / cols) : 0);
  const first = $derived(Math.max(0, Math.floor(viewTop / Math.max(1, pitch)) - BUFFER));
  const last = $derived(Math.min(rows, Math.ceil((viewTop + viewH) / Math.max(1, pitch)) + BUFFER));

  async function load(n: number, generation: string): Promise<void> {
    if (inFlight.has(n)) return;
    inFlight.add(n);
    try {
      const r = await page(n * PAGE, PAGE);
      if (generation !== key) return;
      if (r.TotalRecordCount !== total || items.length !== r.TotalRecordCount) {
        items = new Array(r.TotalRecordCount).fill(null);
        total = r.TotalRecordCount;
      }
      r.Items.forEach((it, k) => {
        if (n * PAGE + k < items.length) items[n * PAGE + k] = it.ServerId ? it : { ...it, ServerId: api.serverId };
      });
      rev++;
    } catch {
      if (total < 0) total = 0;
    } finally {
      inFlight.delete(n);
    }
  }

  // A new sort or filter: an empty grid, from the top.
  $effect(() => {
    const k = key;
    untrack(() => {
      items = [];
      total = -1;
      inFlight.clear();
      rev++;
      void load(0, k);
    });
  });

  // The pages the shown rows need.
  $effect(() => {
    void rev;
    if (total <= 0) return;
    const from = Math.floor((first * cols) / PAGE);
    const to = Math.floor((Math.min(total, last * cols) - 1) / PAGE);
    const k = key;
    untrack(() => {
      for (let n = from; n <= to; n++) if (items[n * PAGE] == null) void load(n, k);
    });
  });

  // Where the page's scroller is, relative to the grid (read once per frame at most).
  $effect(() => {
    const s = scroller;
    if (!s || !grid) return;
    let queued = false;
    const read = () => {
      queued = false;
      viewTop = s.scrollTop - grid!.offsetTop;
      viewH = s.clientHeight;
    };
    const onScroll = () => {
      if (!queued) {
        queued = true;
        requestAnimationFrame(read);
      }
    };
    read();
    s.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(() => {
      width = grid!.clientWidth;
      read();
    });
    ro.observe(grid);
    return () => {
      s.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  });

  const shown = $derived.by(() => {
    void rev;
    const out: { item: BaseItem | null; i: number; x: number; y: number }[] = [];
    for (let r = first; r < last; r++)
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (i >= total) break;
        out.push({ item: items[i] ?? null, i, x: c * (cardW + GAP), y: r * pitch });
      }
    return out;
  });
</script>

<div class="grid" bind:this={grid} style:height="{rows * pitch}px">
  {#each shown as cell (cell.item ? `${cell.i}:${cell.item.Id}` : cell.i)}
    <div class="cell" style:transform="translate3d({cell.x}px, {cell.y}px, 0)" style:width="{cardW}px">
      {#if cell.item}
        <Card item={cell.item} {api} titled={look.posterTitles} width={cardW} onclick={() => onopen(cell.item!)} />
      {:else}
        <div class="ghost" style:height="{Math.round(cardW * 1.5)}px"></div>
      {/if}
    </div>
  {/each}
</div>

<style>
  .grid {
    position: relative;
    margin: 0 max(var(--gutter), var(--safe-right)) 0 max(var(--gutter), var(--safe-left));
    contain: strict;
    content-visibility: visible;
  }
  .cell {
    position: absolute;
    top: 0;
    left: 0;
  }
  .ghost {
    border-radius: var(--r-md);
    background: var(--fill-1);
  }
</style>
