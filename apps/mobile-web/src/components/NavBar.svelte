<script lang="ts">
  // A pushed page's bar: Back with a chevron, the title, an optional trailing action; translucent over the content,
  // under the status bar. The page itself scrolls beneath it.
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import type { Snippet } from 'svelte';
  import { t } from '$tv/i18n.svelte';
  import { handleBack } from '../lib/nav.svelte';

  let { title = '', back = true, trailing }: { title?: string; back?: boolean; trailing?: Snippet } = $props();
</script>

<header class="bar material">
  <div class="row">
    {#if back}
      <button class="back" aria-label={t('back')} onclick={() => handleBack()}><ChevronLeft size={30} strokeWidth={2} aria-hidden="true" /></button>
    {/if}
    <h1 class="headline title">{title}</h1>
    <div class="end">{@render trailing?.()}</div>
  </div>
</header>

<style>
  .bar {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    padding-top: var(--safe-top);
    z-index: 5;
    border-bottom: 0.5px solid var(--separator);
  }
  .row {
    height: 44px;
    display: flex;
    align-items: center;
    padding: 0 max(8px, var(--safe-right)) 0 max(4px, var(--safe-left));
  }
  .back {
    width: 44px;
    height: 44px;
    display: grid;
    place-items: center;
    color: var(--accent);
    margin-right: -4px;
  }
  .title {
    flex: 1;
    min-width: 0;
    text-align: center;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .end {
    min-width: 40px;
    display: flex;
    justify-content: flex-end;
  }
</style>
