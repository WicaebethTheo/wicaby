<script lang="ts">
  import { untrack } from 'svelte';
  import { TICKS_PER_MS } from '../../../shared/contract';
  import type { BaseItem } from '../../../shared/models';
  import { formatDuration } from '../../../shared/music';
  import { t } from '../../lib/i18n.svelte';
  import { instantMix } from '../../lib/music';
  import { openTrackMenu, playTracks } from '../../lib/music-ui.svelte';
  import MusicArt from './MusicArt.svelte';

  // The full-screen player's "Similaires" tab (music spec C6): the current track's instant mix, 20 tracks; a click
  // plays the list from that track (the current one is left out).
  let { id, serverId }: { id: string; serverId?: string } = $props();

  let items = $state<BaseItem[] | null>(null);
  // Only the track drives a new mix: InstantMix is random, so any other reactive read here (the session the query
  // reads) would reload the list with new songs while it is open. The parent passes plain ids (curId), not
  // it.id: a getter through playback.value would rerun this on every position update.
  $effect(() => {
    const cur = id;
    const sid = serverId;
    let live = true;
    untrack(() => {
      items = null;
      instantMix(cur, 21, sid)
        .then((r) => live && (items = (r.Items ?? []).filter((x) => x.Id !== cur).slice(0, 20)))
        .catch(() => live && (items = []));
    });
    return () => (live = false);
  });
</script>

<div class="similar" data-similar>
  {#if items === null}
    <div class="sk skeleton" aria-hidden="true"></div>
  {:else if items.length === 0}
    <p class="empty footnote">{t('music.similar.empty')}</p>
  {:else}
    <ul role="list">
      {#each items as it, i (it.Id)}
        <li>
          <button class="row" data-id={it.Id} onclick={() => playTracks(items!.map((x) => x.Id), i, serverId)} oncontextmenu={(e) => openTrackMenu(it, e, e.currentTarget)}>
            <span class="art"><MusicArt item={it} size={40} /></span>
            <span class="txt"><span class="t">{it.Name}</span><span class="a">{(it.Artists ?? []).join(', ')}</span></span>
            <span class="rt mono">{it.RunTimeTicks ? formatDuration(it.RunTimeTicks / TICKS_PER_MS) : ''}</span>
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .similar {
    height: 100%;
    overflow-y: auto;
  }
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .row {
    width: 100%;
    display: grid;
    grid-template-columns: 40px minmax(0, 1fr) auto;
    align-items: center;
    gap: 12px;
    height: 52px;
    padding: 0 10px 0 6px;
    border-radius: var(--r-sm);
    text-align: left;
  }
  .row:hover,
  .row:focus-visible {
    background: var(--fill-2);
  }
  .art {
    width: 40px;
    height: 40px;
    overflow: hidden;
    border-radius: 6px;
    display: grid;
  }
  .txt {
    display: grid;
    min-width: 0;
  }
  .t,
  .a {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .t {
    font-weight: 500;
  }
  .a,
  .rt {
    font-size: var(--fs-footnote);
    color: var(--label-2);
  }
  .rt {
    color: var(--label-3);
    font-variant-numeric: tabular-nums;
  }
  .sk {
    height: 14px;
    width: 50%;
    margin: 12px 6px;
    border-radius: 4px;
  }
  .empty {
    margin: 12px 6px;
    color: var(--label-3);
  }
</style>
