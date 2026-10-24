<script lang="ts">
  // The accent colours: Settings > Appearance and the first-run setup. Hover and focus preview the colour
  // across the whole app; a click saves it. Locked (dimmed, not clickable) while the Hyprland theme sets the accent.
  import { ACCENTS, type Accent } from '../../shared/contract';
  import { t } from '../lib/i18n.svelte';
  import { desktopAccent, settings } from '../lib/stores.svelte';
  import { previewAccent, set } from '../routes/settings/shared.svelte';

  const accentLabel = (a: Accent) => t(`settings.appearance.accents.${a}`);
  const current = $derived(settings.value?.ui.accent ?? 'blue');
  const locked = $derived(desktopAccent());
</script>

<div
  class="accents"
  class:locked
  role="radiogroup"
  tabindex="-1"
  aria-label={t('settings.appearance.accent.label')}
  aria-disabled={locked}
  title={locked ? t('settings.appearance.accent.fromDesktop') : undefined}
  onpointerleave={() => previewAccent(null)}
>
  {#each ACCENTS as a (a)}
    <button
      type="button"
      class="swatch"
      role="radio"
      data-accent-swatch={a}
      aria-checked={!locked && current === a}
      disabled={locked}
      aria-label={accentLabel(a)}
      title={accentLabel(a)}
      style:--c={`var(--${a === 'graphite' ? 'silver' : a})`}
      onpointerenter={() => previewAccent(a)}
      onfocus={() => previewAccent(a)}
      onblur={() => previewAccent(null)}
      onclick={() => set({ ui: { accent: a } })}
    ></button>
  {/each}
</div>

<style>
  /* Accent swatches: small dots, a thin ring marks the current one. */
  .accents {
    display: flex;
    gap: 6px;
    flex: none;
  }
  .accents.locked {
    opacity: 0.4;
  }
  .swatch {
    position: relative;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: grid;
    place-items: center;
  }
  .swatch::before {
    content: '';
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--c);
  }
  .swatch::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 50%;
    box-shadow: inset 0 0 0 1.5px var(--label-2);
    opacity: 0;
    transition: opacity var(--t-fast) var(--ease);
  }
  .swatch:hover::after,
  .swatch:focus-visible::after {
    opacity: 0.35;
  }
  .swatch[aria-checked='true']::after {
    opacity: 1;
  }
</style>
