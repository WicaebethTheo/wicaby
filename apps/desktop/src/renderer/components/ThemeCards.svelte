<script lang="ts">
  // The theme choice with a mini screenshot per theme: Settings > Appearance and the first-run setup.
  // Each shot carries its own data-theme and data-accent, so it paints with that theme's real tokens
  // (tokens.css), whatever theme the app is in. Hyprland's shot gets the live palette inline, and its card shows
  // only where main found a Hyprland or Omarchy theme.
  import { THEMES } from '../../shared/contract';
  import { has, t } from '../lib/i18n.svelte';
  import { windows } from '../lib/platform';
  import { desktopTheme, settings } from '../lib/stores.svelte';
  import { set } from '../routes/settings/shared.svelte';

  const current = $derived(settings.value?.ui.theme ?? 'graphite');
  const accent = $derived(settings.value?.ui.accent ?? 'blue');
  const themes = $derived(THEMES.filter((theme) => theme !== 'hyprland' || desktopTheme.available));
  const paletteStyle = $derived(
    Object.entries(desktopTheme.palette?.tokens ?? {})
      .map(([k, v]) => `${k}: ${v}`)
      .join('; '),
  );
  // Mica and "Windows" only on Windows; Linux, macOS and the web TV get the neutral wording.
  const desc = (theme: string) => t(`settings.appearance.theme.${theme}Desc${!windows && has(`settings.appearance.theme.${theme}DescNeutral`) ? 'Neutral' : ''}`);
</script>

{#snippet shot(theme: string)}
  <span class="screen" data-theme={theme} data-accent={accent} style={theme === 'hyprland' ? paletteStyle : undefined}>
    <span class="sb"><i></i><i></i><i></i></span>
    <span class="hero-bar"><b></b></span>
    <span class="tiles"><i></i><i></i><i></i></span>
  </span>
{/snippet}

<div class="themes" role="radiogroup" aria-label={t('settings.appearance.theme.title')}>
  {#each themes as theme (theme)}
    <button type="button" class="theme" role="radio" data-theme-card={theme} aria-checked={current === theme} class:on={current === theme} onclick={() => set({ ui: { theme } })}>
      <span class="shot">
        {#if theme === 'system'}
          {@render shot('light')}
          <span class="half">{@render shot('graphite')}</span>
        {:else}
          {@render shot(theme)}
        {/if}
      </span>
      <span class="theme-txt">
        <span class="theme-label">{t(`settings.appearance.theme.${theme}`)}</span>
        <span class="theme-desc">{desc(theme)}</span>
      </span>
    </button>
  {/each}
</div>

<style>
  .themes {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
    gap: 18px 14px;
    padding: 18px;
  }
  .theme {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 10px;
    min-width: 0;
    border-radius: var(--r-sm);
    text-align: left;
  }
  .shot {
    position: relative;
    aspect-ratio: 148 / 92;
    border-radius: var(--r-xs);
    overflow: hidden;
    box-shadow: inset 0 0 0 1px var(--hairline);
  }
  /* Selection: a thin neutral ring inside the tile. Focus: a stronger 2px ring offset outside it, on the
     page canvas, so it reads on every preview (light ones included) and beats selection. Both instant. */
  .shot::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: inherit;
    box-shadow:
      inset 0 0 0 1px var(--hairline),
      inset 0 0 0 1.5px var(--label);
    opacity: 0;
  }
  .theme.on .shot::after {
    opacity: 1;
  }
  .theme:not(.on):hover .shot::after {
    opacity: 0.3;
  }
  .theme:focus-visible .shot {
    outline: 2px solid var(--label);
    outline-offset: 3px;
  }
  /* Automatic: light on the left, graphite on the right. */
  .half {
    position: absolute;
    inset: 0;
    clip-path: polygon(62% 0, 100% 0, 100% 100%, 38% 100%);
  }
  .screen {
    position: absolute;
    inset: 0;
    background: var(--bg);
  }
  .sb {
    position: absolute;
    inset: 0 auto 0 0;
    width: 22%;
    padding: 10px 7px;
    display: flex;
    flex-direction: column;
    gap: 5px;
    background: var(--bg-elevated);
  }
  .sb i {
    height: 3px;
    border-radius: 2px;
    background: var(--fill-4);
  }
  .sb i:first-child {
    background: var(--label-3);
  }
  .hero-bar {
    position: absolute;
    left: 27%;
    right: 6%;
    top: 10%;
    height: 37%;
    border-radius: 3px;
    background: var(--fill-3);
  }
  /* The accent in this theme's tone, on a play button. */
  .hero-bar b {
    position: absolute;
    left: 8px;
    bottom: 7px;
    width: 26px;
    height: 7px;
    border-radius: 4px;
    background: var(--accent);
  }
  .tiles {
    position: absolute;
    left: 27%;
    right: 6%;
    bottom: 10%;
    display: flex;
    gap: 5px;
  }
  .tiles i {
    flex: 1;
    height: 30px;
    border-radius: 3px;
    background: var(--bg-elevated-2);
    box-shadow: inset 0 0 0 1px var(--separator);
  }
  .theme-txt {
    display: flex;
    flex-direction: column;
    padding-left: 1px;
  }
  .theme-label {
    font-size: var(--fs-callout);
    font-weight: 500;
    color: var(--label-2);
  }
  .theme-desc {
    font-size: var(--fs-caption);
    color: var(--label-3);
  }
  .theme.on .theme-label {
    color: var(--label);
  }
  :global(.searching) .themes {
    display: none;
  }
</style>
