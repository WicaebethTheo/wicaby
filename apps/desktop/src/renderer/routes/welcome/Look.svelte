<script lang="ts">
  // Step 2: theme and accent. Hovering a colour already repaints the whole app (previewAccent), so the
  // setup itself is the live preview; the block below shows the accent on a button, a bar and a focus ring.
  import AccentSwatches from '../../components/AccentSwatches.svelte';
  import Icon from '../../components/Icon.svelte';
  import ThemeCards from '../../components/ThemeCards.svelte';
  import { t } from '../../lib/i18n.svelte';
  import { desktopAccent, settings } from '../../lib/stores.svelte';

  const accent = $derived(settings.value?.ui.accent ?? 'blue');
</script>

<h1>{t('welcome.look.title')}</h1>
<p class="lead">{t('welcome.look.body')}</p>

<div class="look">
  <ThemeCards />
  <div class="accent">
    <span class="lbl">{t('settings.appearance.accent.label')}</span>
    <AccentSwatches />
    <span class="name">{desktopAccent() ? t('settings.appearance.accent.fromDesktop') : t(`settings.appearance.accents.${accent}`)}</span>
  </div>
  <div class="preview" role="img" aria-label={t('welcome.look.preview')}>
    <span class="cap">{t('welcome.look.preview')}</span>
    <div class="pv">
      <span class="poster focus"></span>
      <span class="poster"></span>
      <span class="poster"></span>
      <div class="side">
        <span class="btn primary" aria-hidden="true"><Icon name="play" size={14} /> {t('common.actions.play')}</span>
        <span class="bar" aria-hidden="true"><i></i></span>
      </div>
    </div>
  </div>
</div>

<style>
  .look {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 18px;
  }
  .accent {
    display: flex;
    align-items: center;
    gap: 14px;
  }
  .lbl {
    font-size: var(--fs-callout);
    color: var(--label-2);
  }
  .name {
    min-width: 7ch;
    font-size: var(--fs-callout);
    color: var(--label);
  }
  .preview {
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 14px 16px 16px;
    border-radius: var(--r-md);
    background: var(--bg);
    box-shadow: inset 0 0 0 1px var(--separator);
  }
  .cap {
    font-size: var(--fs-caption);
    font-weight: 600;
    color: var(--label-3);
  }
  .pv {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .poster {
    width: 52px;
    height: 76px;
    flex: none;
    border-radius: var(--r-xs);
    background: var(--bg-elevated-2);
  }
  /* Focus shows as a lift, never a coloured ring (design rule). */
  .poster.focus {
    transform: translate3d(0, -3px, 0) scale(1.04);
    background: var(--fill-4);
    box-shadow: var(--shadow-1);
  }
  .side {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 14px;
    padding-left: 12px;
  }
  .side .btn {
    pointer-events: none;
  }
  .bar {
    width: 100%;
    height: 4px;
    border-radius: 2px;
    background: var(--fill-3);
    overflow: hidden;
  }
  .bar i {
    display: block;
    width: 62%;
    height: 100%;
    background: var(--accent);
  }
</style>
