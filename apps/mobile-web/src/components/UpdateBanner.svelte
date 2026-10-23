<script lang="ts">
  // A new version is installed (lib/updates.svelte.ts): offered, never forced on a page the user is on.
  import { fly } from 'svelte/transition';
  import { t } from '$tv/i18n.svelte';
  import { applyUpdate, updates } from '../lib/updates.svelte';

  let later = $state(false);
</script>

{#if updates.ready && !later}
  <div class="banner material" role="status" transition:fly={{ y: -80, duration: 320 }}>
    <div class="text">
      <p class="headline">{t('update_available')}</p>
      <p class="footnote label-2">{t('web_update_body')}</p>
    </div>
    <button class="later subhead label-2" onclick={() => (later = true)}>{t('update_later')}</button>
    <button class="now subhead" onclick={applyUpdate}>{t('update_now')}</button>
  </div>
{/if}

<style>
  .banner {
    position: absolute;
    top: calc(var(--safe-top) + 8px);
    left: max(8px, var(--safe-left));
    right: max(8px, var(--safe-right));
    z-index: 70;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    border-radius: var(--r-lg);
    background: var(--material-thick);
    box-shadow: var(--shadow-2);
  }
  .text {
    flex: 1;
    min-width: 0;
  }
  .now {
    padding: 8px 14px;
    border-radius: 999px;
    background: var(--accent);
    color: var(--accent-fg);
    font-weight: 600;
  }
</style>
