<script lang="ts">
  // A sheet inside the player (Android PlayerSheet): it rises from the bottom over a scrim, on the elevated surface,
  // with a handle; a tap outside closes it. Up to 330 px high, the rows scroll inside.
  import type { Snippet } from 'svelte';
  import { fade } from 'svelte/transition';
  import { sheet } from '../../lib/motion';

  let { onclose, children }: { onclose: () => void; children: Snippet } = $props();
</script>

<div class="scrim" role="presentation" onclick={onclose} transition:fade={{ duration: 180 }}></div>
<div class="sheet" role="dialog" aria-modal="true" in:sheet out:sheet={{ duration: 240 }}>
  <span class="handle" aria-hidden="true"></span>
  {@render children()}
</div>

<style>
  .scrim {
    position: absolute;
    inset: 0;
    background: rgb(0 0 0 / 0.45);
    z-index: 20;
  }
  .sheet {
    position: absolute;
    left: 50%;
    bottom: 0;
    translate: -50% 0;
    width: min(680px, 100%);
    max-height: min(330px + var(--safe-bottom), 70%);
    display: flex;
    flex-direction: column;
    padding: 0 max(20px, var(--safe-right)) calc(var(--safe-bottom) + 12px) max(20px, var(--safe-left));
    border-radius: var(--r-xl) var(--r-xl) 0 0;
    background: var(--bg-elevated);
    color: var(--label);
    z-index: 21;
    overflow: hidden;
  }
  .handle {
    align-self: center;
    width: 36px;
    height: 4px;
    border-radius: 2px;
    background: var(--fill-4);
    margin: 10px 0;
    flex: none;
  }
</style>
