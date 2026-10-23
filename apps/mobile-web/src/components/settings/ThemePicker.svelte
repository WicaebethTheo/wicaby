<script lang="ts">
  // The themes as cards (the TV's ThemeCards, Android ThemePicker): each a small page in that theme's own tokens
  // (its canvas, a card, two lines of text, the accent), whatever theme the app is in; Automatic is half Graphite,
  // half Light. A row that scrolls sideways; the chosen one ringed in the accent.
  import { t } from '$tv/i18n.svelte';
  import Check from '@lucide/svelte/icons/check';
  import { ACCENTS, THEME_IDS } from '../../lib/theme';

  let { theme, accent, onpick }: { theme: string; accent: number; onpick: (id: string) => void } = $props();
  const accentId = $derived(ACCENTS[accent] ?? ACCENTS[0]);
</script>

<div class="themes" role="radiogroup" aria-label={t('settings_theme')}>
  {#each THEME_IDS as id (id)}
    <button class="theme pressable" class:on={id === theme} role="radio" aria-checked={id === theme} onclick={() => onpick(id)}>
      <span class="preview">
        {#each id === 'system' ? ['graphite', 'light'] : [id] as part (part)}
          <span class="half" data-theme={part} data-accent={accentId}>
            <span class="card"><span class="line"></span><span class="line short"></span></span>
            <span class="pill-mini"></span>
          </span>
        {/each}
        {#if id === theme}<span class="check"><Check size={14} strokeWidth={3} aria-hidden="true" /></span>{/if}
      </span>
      <span class="footnote name">{t(`theme_${id}`)}</span>
    </button>
  {/each}
</div>

<style>
  .themes {
    display: flex;
    gap: 12px;
    overflow-x: auto;
    padding: 16px;
    scrollbar-width: none;
    scroll-snap-type: x proximity;
  }
  .theme {
    flex: none;
    width: 92px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    scroll-snap-align: start;
    color: var(--label-2);
  }
  .theme.on {
    color: var(--label);
  }
  .preview {
    position: relative;
    width: 92px;
    height: 128px;
    border-radius: var(--r-md);
    overflow: hidden;
    display: flex;
    box-shadow: 0 0 0 1px var(--separator);
    transition: box-shadow var(--t-fast);
  }
  .on .preview {
    box-shadow:
      0 0 0 2px var(--bg-elevated),
      0 0 0 4px var(--accent);
  }
  .half {
    flex: 1;
    min-width: 0;
    background: var(--bg);
    padding: 10px 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .card {
    flex: 1;
    border-radius: 6px;
    background: var(--bg-elevated);
    padding: 8px 6px;
    display: flex;
    flex-direction: column;
    gap: 5px;
  }
  .line {
    height: 5px;
    border-radius: 3px;
    background: var(--label);
    opacity: 0.85;
  }
  .line.short {
    width: 60%;
    background: var(--label-3);
  }
  .pill-mini {
    height: 12px;
    border-radius: 6px;
    background: var(--accent);
  }
  .check {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 22px;
    height: 22px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: var(--accent);
    color: var(--accent-fg);
  }
  .name {
    font-weight: 600;
  }
</style>
