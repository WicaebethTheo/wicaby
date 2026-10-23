<script lang="ts">
  // Playback info, top left (Android StatsOverlay): the TV web app's rows (method and why, container, streams,
  // bitrate, buffer, dropped frames, server) at phone size, then the iPhone remux's own (MediaSource state, codecs,
  // the last error), for a report from the phone.
  import type { Playback } from '$tv/playback.svelte';
  import StatsOverlay from '../../../../tv-web/src/components/player/StatsOverlay.svelte';
  import type { RemuxPlayer } from '../../platform/remux-player.svelte';

  let { pb }: { pb: Playback } = $props();

  let tick = $state(0);
  $effect(() => {
    const id = setInterval(() => tick++, 1000);
    return () => clearInterval(id);
  });
  const lines = $derived((void tick, (pb.player as RemuxPlayer).diagnostics?.() ?? []));
</script>

<div class="panel">
  <StatsOverlay {pb} />
  {#each lines as line, i (i)}
    <p class="caption mono line">{line}</p>
  {/each}
</div>

<style>
  .panel {
    position: absolute;
    top: calc(var(--safe-top) + 72px);
    left: max(16px, var(--safe-left));
    width: min(420px, calc(100% - 32px));
    padding: 10px 14px;
    border-radius: var(--r-md);
    background: rgb(0 0 0 / 0.72);
    color: #fff;
    pointer-events: none;
  }
  /* The TV panel sits inside, unpositioned, at phone sizes. */
  .panel :global(.stats) {
    position: static;
    max-width: none;
    padding: 0;
    background: none;
  }
  .panel :global(.stats p) {
    margin: 0 0 6px;
    font-size: 11px;
    font-weight: 650;
    letter-spacing: 0.06em;
  }
  .panel :global(.stats .row) {
    font-size: var(--fs-footnote);
    line-height: 1.45;
  }
  .panel :global(.stats .k) {
    width: 104px;
  }
  .line {
    margin-top: 4px;
    color: rgb(255 255 255 / 0.6);
    overflow-wrap: anywhere;
  }
</style>
