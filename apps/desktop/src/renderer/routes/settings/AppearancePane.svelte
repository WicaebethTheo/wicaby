<script lang="ts">
  import type { Accent } from '../../../shared/contract';
  import AccentSwatches from '../../components/AccentSwatches.svelte';
  import Segmented from '../../components/Segmented.svelte';
  import ThemeCards from '../../components/ThemeCards.svelte';
  import Toggle from '../../components/Toggle.svelte';
  import { t } from '../../lib/i18n.svelte';
  import { linux } from '../../lib/platform';
  import { desktopAccent, settings } from '../../lib/stores.svelte';
  import { set } from './shared.svelte';

  const accentLabel = (a: Accent) => t(`settings.appearance.accents.${a}`);

  const s = $derived(settings.value);

  // ---- Sliders: live label while dragging, saved on release ----
  let posterDraft = $state<number | null>(null);
  let zoomDraft = $state<number | null>(null);
</script>

{#if s}
  <h3 class="gh first">{t('settings.appearance.theme.title')}</h3>
  <div class="group">
    <ThemeCards />
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.appearance.accent.label')}</div>
        <div class="desc">{desktopAccent() ? t('settings.appearance.accent.fromDesktop') : accentLabel(s.ui.accent)}</div>
      </div>
      <AccentSwatches />
    </div>
  </div>

  <h3 class="gh">{t('settings.appearance.layout')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.appearance.compactSidebar.label')}</div>
        <div class="desc">{t('settings.appearance.compactSidebar.desc')}</div>
      </div>
      <Toggle label={t('settings.appearance.compactSidebar.label')} checked={s.ui.sidebarCollapsed} onchange={(v) => set({ ui: { sidebarCollapsed: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.appearance.density.label')}</div>
        <div class="desc">{t('settings.appearance.density.desc')}</div>
      </div>
      <Segmented
        label={t('settings.appearance.density.label')}
        value={s.ui.density}
        options={[
          { value: 'comfortable', label: t('settings.appearance.density.comfortable') },
          { value: 'compact', label: t('settings.appearance.density.compact') },
        ]}
        onchange={(v) => set({ ui: { density: v } })}
      />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.appearance.posterSize.label')}</div>
        <div class="desc">{t('settings.appearance.posterSize.desc')}</div>
      </div>
      <div class="slider-wrap">
        <input
          type="range"
          class="slider"
          min="80"
          max="130"
          step="5"
          aria-label={t('settings.appearance.posterSize.label')}
          value={s.ui.posterSize}
          oninput={(e) => (posterDraft = +e.currentTarget.value)}
          onchange={(e) => set({ ui: { posterSize: +e.currentTarget.value } }).then(() => (posterDraft = null))}
        />
        <span class="slider-val tabular">{t('settings.units.percent', { value: posterDraft ?? s.ui.posterSize })}</span>
      </div>
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.appearance.zoom.label')}</div>
        <div class="desc">{t('settings.appearance.zoom.desc')}</div>
      </div>
      <div class="slider-wrap">
        <input
          type="range"
          class="slider"
          min="90"
          max="125"
          step="5"
          aria-label={t('settings.appearance.zoom.label')}
          value={s.ui.zoom}
          oninput={(e) => (zoomDraft = +e.currentTarget.value)}
          onchange={(e) => set({ ui: { zoom: +e.currentTarget.value } }).then(() => (zoomDraft = null))}
        />
        <span class="slider-val tabular">{t('settings.units.percent', { value: zoomDraft ?? s.ui.zoom })}</span>
      </div>
    </div>
  </div>

  <h3 class="gh">{t('settings.appearance.posters')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.appearance.cardTitles.label')}</div>
        <div class="desc">{t('settings.appearance.cardTitles.desc')}</div>
      </div>
      <Toggle label={t('settings.appearance.cardTitles.label')} checked={s.ui.cardTitles} onchange={(v) => set({ ui: { cardTitles: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.appearance.cardRatings.label')}</div>
        <div class="desc">{t('settings.appearance.cardRatings.desc')}</div>
      </div>
      <Toggle label={t('settings.appearance.cardRatings.label')} checked={s.ui.cardRatings} onchange={(v) => set({ ui: { cardRatings: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.appearance.cardAges.label')}</div>
        <div class="desc">{t('settings.appearance.cardAges.desc')}</div>
      </div>
      <Toggle label={t('settings.appearance.cardAges.label')} checked={s.ui.cardAges} onchange={(v) => set({ ui: { cardAges: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.appearance.cardQuality.label')}</div>
        <div class="desc">{t('settings.appearance.cardQuality.desc')}</div>
      </div>
      <Toggle label={t('settings.appearance.cardQuality.label')} checked={s.ui.cardQuality} onchange={(v) => set({ ui: { cardQuality: v } })} />
    </div>
  </div>

  <h3 class="gh">{t('settings.appearance.accessibility')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.appearance.reduceMotion.label')}</div>
        <div class="desc">{t(linux ? 'settings.appearance.reduceMotion.descLinux' : 'settings.appearance.reduceMotion.desc')}</div>
      </div>
      <Toggle label={t('settings.appearance.reduceMotion.label')} checked={s.ui.reduceMotion} onchange={(v) => set({ ui: { reduceMotion: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.appearance.reduceTransparency.label')}</div>
        <div class="desc">{t('settings.appearance.reduceTransparency.desc')}</div>
      </div>
      <Toggle label={t('settings.appearance.reduceTransparency.label')} checked={s.ui.reduceTransparency} onchange={(v) => set({ ui: { reduceTransparency: v } })} />
    </div>
  </div>
{/if}

<style>
  .gh {
    margin: 30px 0 8px 2px;
    font-size: var(--fs-footnote);
    font-weight: 500;
    color: var(--label-3);
  }
  .gh.first {
    margin-top: 0;
  }
  .group {
    border-radius: var(--r-sm);
    background: var(--bg-elevated);
    box-shadow: inset 0 0 0 1px var(--separator);
    overflow: hidden;
  }
  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 16px;
    min-height: 58px;
    padding: 12px 18px;
  }
  /* Hairline between rows, inset to the text edge. */
  .row + .row::before,
  :global(.themes) + .row::before {
    content: '';
    position: absolute;
    top: 0;
    left: 18px;
    right: 0;
    height: 1px;
    background: var(--separator);
  }
  .txt {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
  }
  .lbl {
    display: flex;
    align-items: baseline;
    gap: 10px;
    font-size: var(--fs-body);
    font-weight: 500;
    color: var(--label);
  }
  .desc {
    display: block;
    margin-top: 2px;
    font-size: var(--fs-footnote);
    color: var(--label-3);
    line-height: 1.45;
  }

  /* Hairlines only between rows that are still shown. */
  :global(.searching) .row::before {
    display: none;
  }
  :global(.searching) .row:not([hidden]) ~ .row:not([hidden])::before {
    display: block;
  }
  .slider-wrap {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: none;
  }
  .slider-val {
    min-width: 44px;
    text-align: right;
    font-size: var(--fs-callout);
    color: var(--label-2);
  }
  /* Neutral range: a control-tone track and a white knob with a hairline (Apple style), no accent fill. */
  .slider {
    width: 168px;
    height: 22px;
    margin: 0;
    background: transparent;
    appearance: none;
    cursor: pointer;
  }
  .slider::-webkit-slider-runnable-track {
    height: 4px;
    border-radius: 2px;
    background: var(--control);
  }
  .slider::-webkit-slider-thumb {
    appearance: none;
    width: 18px;
    height: 18px;
    margin-top: -7px;
    border-radius: 50%;
    background: #fff;
    box-shadow:
      0 0 0 0.5px rgb(0 0 0 / 0.12),
      0 1px 4px rgb(0 0 0 / 0.3);
    transition: transform var(--t-fast) var(--spring);
  }
  .slider:active::-webkit-slider-thumb {
    transform: scale(1.12);
  }
  .slider:focus-visible::-webkit-slider-thumb {
    box-shadow:
      0 0 0 4px var(--fill-4),
      0 0 0 0.5px rgb(0 0 0 / 0.12),
      0 1px 4px rgb(0 0 0 / 0.3);
  }
  .slider:focus {
    outline: none;
  }

  /* Compact density tightens these rows as well. */
  :global(html[data-density='compact']) .row {
    min-height: 50px;
    padding-block: 9px;
  }
</style>
