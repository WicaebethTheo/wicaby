<script lang="ts">
  // The accent as swatches (Android AccentPicker, the TV's accent row): one disc per colour in the current theme's
  // tone, the chosen one checked and ringed; its name under the row.
  import { t } from '$tv/i18n.svelte';
  import Check from '@lucide/svelte/icons/check';
  import { ACCENTS } from '../../lib/theme';

  let { accent, onpick }: { accent: number; onpick: (i: number) => void } = $props();
</script>

<div class="accents">
  <div class="swatches" role="radiogroup" aria-label={t('settings_accent')}>
    {#each ACCENTS as id, i (id)}
      <button class="swatch pressable" class:on={i === accent} data-accent={id} role="radio" aria-checked={i === accent} aria-label={t(`accent_${id}`)} onclick={() => onpick(i)}>
        {#if i === accent}<Check size={18} strokeWidth={3} aria-hidden="true" />{/if}
      </button>
    {/each}
  </div>
  <p class="footnote label-2">{t(`accent_${ACCENTS[accent] ?? ACCENTS[0]}`)}</p>
</div>

<style>
  .accents {
    padding: 14px 16px 16px;
  }
  .swatches {
    display: flex;
    justify-content: space-between;
    gap: 6px;
    margin-bottom: 10px;
  }
  .swatch {
    width: 34px;
    height: 34px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--accent);
    color: var(--accent-fg);
    transition: box-shadow var(--t-fast);
  }
  .swatch.on {
    box-shadow:
      0 0 0 2px var(--bg-elevated),
      0 0 0 4px var(--accent);
  }
</style>
