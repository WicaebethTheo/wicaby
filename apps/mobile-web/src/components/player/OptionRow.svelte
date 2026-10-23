<script lang="ts">
  // A row of a player sheet (Android OptionRow): the accent check (or a spinner while it switches) in front of the
  // label, the chosen row on a fill.
  import Check from '@lucide/svelte/icons/check';
  import Spinner from '../Spinner.svelte';

  let { text, selected = false, busy = false, disabled = false, onclick }: { text: string; selected?: boolean; busy?: boolean; disabled?: boolean; onclick: () => void } = $props();
</script>

<button class="row" class:selected aria-pressed={selected} {disabled} {onclick}>
  <span class="mark">
    {#if busy}<Spinner size={18} />{:else if selected}<Check size={18} strokeWidth={2.4} aria-hidden="true" />{/if}
  </span>
  <span class="text">{text}</span>
</button>

<style>
  .row {
    width: 100%;
    min-height: 44px;
    display: flex;
    align-items: center;
    padding: 0 12px;
    border-radius: var(--r-sm);
    text-align: left;
    color: var(--label);
    font-size: var(--fs-body);
  }
  .row:active,
  .selected {
    background: var(--fill-2);
  }
  .row:disabled {
    opacity: 0.4;
  }
  .mark {
    width: 28px;
    flex: none;
    display: flex;
    color: var(--accent);
  }
  .text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
