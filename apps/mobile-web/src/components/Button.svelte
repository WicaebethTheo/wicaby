<script lang="ts">
  // A pill button: filled with the accent for the primary action, a neutral fill otherwise.
  import type { Snippet } from 'svelte';
  import Spinner from './Spinner.svelte';

  let {
    text,
    primary = false,
    destructive = false,
    busy = false,
    disabled = false,
    wide = false,
    type = 'button',
    onclick,
    children,
  }: { text?: string; primary?: boolean; destructive?: boolean; busy?: boolean; disabled?: boolean; wide?: boolean; type?: 'button' | 'submit'; onclick?: () => void; children?: Snippet } = $props();
</script>

<button class="btn pressable headline" class:primary class:destructive class:wide {type} disabled={disabled || busy} aria-busy={busy} {onclick}>
  {#if busy}<Spinner size={20} />{:else}{text}{@render children?.()}{/if}
</button>

<style>
  .btn {
    min-height: 50px;
    padding: 0 24px;
    border-radius: 999px;
    background: var(--fill-3);
    color: var(--label);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .primary {
    background: var(--accent);
    color: var(--accent-fg);
  }
  .destructive {
    color: var(--red);
  }
  .wide {
    width: 100%;
  }
  .btn:disabled {
    opacity: 0.5;
  }
  .btn[aria-busy='true'] {
    opacity: 1;
  }
</style>
