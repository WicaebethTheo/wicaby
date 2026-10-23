<script lang="ts">
  // A short choice as a row of chips (Android Settings' FlowRow of Chip): every option in view, the chosen one on the
  // accent. An optional label above them, inside the group's card.
  let { label, options, selected, onpick }: { label?: string; options: string[]; selected: number; onpick: (i: number) => void } = $props();
</script>

<div class="chips-row">
  {#if label}<p class="label">{label}</p>{/if}
  <div class="chips" role="radiogroup" aria-label={label}>
    {#each options as o, i (i)}
      <button class="chip-btn pressable" class:on={i === selected} role="radio" aria-checked={i === selected} onclick={() => i !== selected && onpick(i)}>{o}</button>
    {/each}
  </div>
</div>

<style>
  .chips-row {
    padding: 14px 16px;
  }
  .label {
    margin-bottom: 10px;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .chip-btn {
    height: 36px;
    padding: 0 14px;
    border-radius: 999px;
    background: var(--fill-2);
    color: var(--label);
    font-size: var(--fs-subhead);
    font-weight: 550;
    transition:
      background-color var(--t-fast),
      color var(--t-fast),
      transform var(--t-fast) var(--ease-out);
  }
  .chip-btn.on {
    background: var(--accent);
    color: var(--accent-fg);
  }
</style>
