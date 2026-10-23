<script lang="ts">
  // The message with an action (lib/snackbar.svelte.ts), above the tab bar like the toasts.
  import { lift } from '../lib/motion';
  import { dismissSnack, snackbar } from '../lib/snackbar.svelte';

  function act(): void {
    const s = snackbar.snack;
    dismissSnack();
    s?.run();
  }
</script>

{#key snackbar.key}
  {#if snackbar.snack}
    <div class="snack subhead" role="status" in:lift out:lift={{ duration: 200 }}>
      <span class="text">{snackbar.snack.text}</span>
      <button class="headline action" onclick={act}>{snackbar.snack.action}</button>
    </div>
  {/if}
{/key}

<style>
  .snack {
    position: absolute;
    left: max(16px, var(--safe-left));
    right: max(16px, var(--safe-right));
    bottom: calc(var(--tabbar) + 12px);
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 6px 6px 6px 18px;
    border-radius: var(--r-md);
    background: var(--bg-elevated-2);
    box-shadow: var(--shadow-2);
    z-index: 60;
  }
  .text {
    flex: 1;
    min-width: 0;
  }
  .action {
    height: 40px;
    padding: 0 14px;
    border-radius: var(--r-sm);
    color: var(--accent);
  }
  .action:active {
    background: var(--fill-2);
  }
</style>
