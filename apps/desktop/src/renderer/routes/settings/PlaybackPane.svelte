<script lang="ts">
  import type { ResumeMode, Settings, SkipMode, TypePlayer } from '../../../shared/contract';
  import { isLanAddress } from '../../../shared/network';
  import Picker from '../../components/Picker.svelte';
  import Segmented from '../../components/Segmented.svelte';
  import Toggle from '../../components/Toggle.svelte';
  import { w } from '../../lib/bridge';
  import { fmt, t } from '../../lib/i18n.svelte';
  import { linux, web } from '../../lib/platform';
  import { errorMessage, session, settings, toast } from '../../lib/stores.svelte';
  import { set, step } from './shared.svelte';

  // Picture, decoding and mpv rows live in VideoPane, casting in CastPane.
  // Option lists are $derived so their labels follow a language switch.
  const BITRATES = [4, 8, 20, 40, 80, 120, 200];
  const RESOLUTIONS = $derived([
    { value: 0, label: t('settings.playback.maxResolution.unlimited') },
    { value: 2160, label: '4K (2160p)' },
    { value: 1440, label: '1440p' },
    { value: 1080, label: '1080p' },
    { value: 720, label: '720p' },
  ]);
  const SPEEDS = $derived([0.75, 1, 1.1, 1.25, 1.5, 2].map((v) => ({ value: v, label: v === 1 ? t('settings.playback.speed.normal') : `${fmt.number(v)}×` })));
  // X-05 "Mémoriser les réglages": one scope per player setting.
  const REMEMBER = $derived([
    { prop: 'speed', label: t('settings.playback.remember.speed') },
    { prop: 'audioDelay', label: t('settings.playback.remember.audioDelay') },
    { prop: 'subtitleDelay', label: t('settings.playback.remember.subtitleDelay') },
    { prop: 'aspect', label: t('settings.playback.remember.aspect') },
  ] as const);
  const SCOPES = $derived([
    { value: 'off' as const, label: t('settings.playback.remember.scope.off') },
    { value: 'global' as const, label: t('settings.playback.remember.scope.global') },
    { value: 'library' as const, label: t('settings.playback.remember.scope.library') },
    { value: 'title' as const, label: t('settings.playback.remember.scope.title') },
  ]);
  const COUNTDOWNS = $derived([5, 10, 15, 20, 30].map((v) => ({ value: v, label: step(v) })));
  const SHORT_STEPS = $derived([5, 10, 15, 20, 30].map((v) => ({ value: v, label: step(v) })));
  const LONG_STEPS = $derived([30, 60, 120, 300, 600].map((v) => ({ value: v, label: step(v) })));
  const RESUME = $derived<{ value: ResumeMode; label: string }[]>([
    { value: 'ask', label: t('settings.playback.resume.ask') },
    { value: 'resume', label: t('settings.playback.resume.resume') },
    { value: 'start', label: t('settings.playback.resume.start') },
  ]);
  const SKIP = $derived<{ value: SkipMode; label: string }[]>([
    { value: 'ask', label: t('settings.playback.skip.ask') },
    { value: 'auto', label: t('settings.playback.skip.auto') },
    { value: 'off', label: t('settings.playback.skip.off') },
  ]);
  const TYPE_PLAYERS = $derived<{ value: TypePlayer; label: string }[]>([
    { value: 'default', label: t('settings.playback.byType.sameAsAbove') },
    { value: 'mpv', label: 'mpv' },
    { value: 'html', label: t('settings.playback.player.builtIn') },
  ]);
  // Labels: settings.playback.byType.<key>.
  const CONTENT_TYPES: (keyof Settings['playback']['playerByType'])[] = ['movie', 'episode', 'music', 'live'];
  const REMINDER_LEADS = $derived(
    ([0, 1, 2, 5, 10] as const).map((v) => ({ value: v as Settings['live']['reminderLeadMin'], label: v ? t('settings.units.minutes', { count: v }) : t('settings.livetv.reminderLead.atStart') })),
  );

  const s = $derived(settings.value);
  const onLan = $derived(isLanAddress(session.value.address));

  async function forgetPlayerSettings(): Promise<void> {
    try {
      await w.playback.command({ type: 'forget-player-settings' });
      toast('success', t('settings.playback.remember.cleared'));
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }
</script>

{#if s}
  <!-- The web TV app (lib/platform.ts) has a single built-in player and no desktop window. -->
  {#if !web}
    <h3 class="gh">{t('settings.playback.player.title')}</h3>
    <div class="group">
      <div class="row">
        <div class="txt">
          <div class="lbl">{t('settings.playback.player.label')}</div>
          <div class="desc">{t('settings.playback.player.desc')}</div>
        </div>
        <Segmented
          label={t('settings.playback.player.label')}
          value={s.playback.player}
          options={[
            { value: 'auto', label: t('settings.playback.player.auto') },
            { value: 'mpv', label: 'mpv' },
            { value: 'html', label: t('settings.playback.player.builtIn') },
          ]}
          onchange={(v) => set({ playback: { player: v } })}
        />
      </div>
      <div class="row">
        <div class="txt">
          <div class="lbl">{t('settings.general.startFullscreen.label')}</div>
          <div class="desc">{t('settings.general.startFullscreen.desc')}</div>
        </div>
        <Toggle label={t('settings.general.startFullscreen.label')} checked={s.playback.startFullscreen} onchange={(v) => set({ playback: { startFullscreen: v } })} />
      </div>
      {#if linux}
        <div class="row">
          <div class="txt">
            <div class="lbl">{t('settings.playback.inWindowVideo.label')}</div>
            <div class="desc">{t('settings.playback.inWindowVideo.desc')}</div>
          </div>
          <Toggle label={t('settings.playback.inWindowVideo.label')} checked={s.playback.inWindowVideo} onchange={(v) => set({ playback: { inWindowVideo: v } })} />
        </div>
      {/if}
      <div class="row">
        <div class="txt">
          <div class="lbl">{t('settings.playback.pauseOnMinimize.label')}</div>
          <div class="desc">{t('settings.playback.pauseOnMinimize.desc')}</div>
        </div>
        <Toggle label={t('settings.playback.pauseOnMinimize.label')} checked={s.playback.pauseOnMinimize} onchange={(v) => set({ playback: { pauseOnMinimize: v } })} />
      </div>
      <div class="row">
        <div class="txt">
          <div class="lbl">{t('settings.general.confirmQuit.label')}</div>
          <div class="desc">{t('settings.general.confirmQuit.desc')}</div>
        </div>
        <Toggle
          label={t('settings.general.confirmQuit.label')}
          checked={s.ui.confirmQuitDuringPlayback}
          onchange={(v) => set({ ui: { confirmQuitDuringPlayback: v } })}
        />
      </div>
    </div>

    <h3 class="gh">{t('settings.playback.byType.title')}</h3>
    <div class="group">
      {#each CONTENT_TYPES as type (type)}
        {@const typeLabel = t(`settings.playback.byType.${type}`)}
        <div class="row">
          <div class="txt"><div class="lbl">{typeLabel}</div></div>
          <Picker
            label={t('settings.playback.byType.aria', { type: typeLabel })}
            value={s.playback.playerByType[type]}
            options={TYPE_PLAYERS}
            onchange={(v) => set({ playback: { playerByType: { [type]: v } as Partial<Settings['playback']['playerByType']> } })}
          />
        </div>
      {/each}
    </div>
  {/if}

  <h3 class="gh">{t('settings.playback.quality')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.bitrateLocal.label')}</div>
        <div class="desc">{t('settings.playback.bitrateLocal.desc')}</div>
      </div>
      <Picker
        label={t('settings.playback.bitrateLocal.label')}
        value={s.playback.maxBitrateMbps}
        options={[...new Set([...BITRATES, s.playback.maxBitrateMbps])].sort((a, b) => a - b).map((b) => ({ value: b, label: fmt.bitrate(b) }))}
        onchange={(v) => set({ playback: { maxBitrateMbps: v } })}
      />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.bitrateRemote.label')}</div>
        <div class="desc">{t('settings.playback.bitrateRemote.desc')}</div>
      </div>
      <Picker
        label={t('settings.playback.bitrateRemote.label')}
        value={s.playback.maxBitrateRemoteMbps}
        options={[...new Set([...BITRATES, s.playback.maxBitrateRemoteMbps])].sort((a, b) => a - b).map((b) => ({ value: b, label: fmt.bitrate(b) }))}
        onchange={(v) => set({ playback: { maxBitrateRemoteMbps: v } })}
      />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.maxResolution.label')}</div>
        <div class="desc">{t('settings.playback.maxResolution.desc')}</div>
      </div>
      <Picker label={t('settings.playback.maxResolution.label')} value={s.playback.maxResolution} options={RESOLUTIONS} onchange={(v) => set({ playback: { maxResolution: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.forceTranscode.label')}</div>
        <div class="desc">{t('settings.playback.forceTranscode.desc')}</div>
      </div>
      <Toggle label={t('settings.playback.forceTranscode.label')} checked={s.playback.forceTranscode} onchange={(v) => set({ playback: { forceTranscode: v } })} />
    </div>
  </div>
  {#if session.value.address}
    <p class="foot">{t('settings.playback.connection', { kind: onLan ? 'lan' : 'remote', address: session.value.address })}</p>
  {/if}

  <h3 class="gh">{t('settings.playback.resumeNext')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.resume.label')}</div>
        <div class="desc">{t('settings.playback.resume.desc')}</div>
      </div>
      <Picker label={t('settings.playback.resume.label')} value={s.playback.resume} options={RESUME} onchange={(v) => set({ playback: { resume: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.autoPlayNext.label')}</div>
        <div class="desc">{t('settings.playback.autoPlayNext.desc')}</div>
      </div>
      <Toggle label={t('settings.playback.autoPlayNext.label')} checked={s.playback.autoPlayNext} onchange={(v) => set({ playback: { autoPlayNext: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.countdown.label')}</div>
        <div class="desc">{t('settings.playback.countdown.desc')}</div>
      </div>
      <Picker label={t('settings.playback.countdown.label')} value={s.playback.upNextSeconds} options={COUNTDOWNS} onchange={(v) => set({ playback: { upNextSeconds: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.cinemaMode.label')}</div>
        <div class="desc">{t('settings.playback.cinemaMode.desc')}</div>
      </div>
      <Toggle label={t('settings.playback.cinemaMode.label')} checked={s.playback.cinemaMode} onchange={(v) => set({ playback: { cinemaMode: v } })} />
    </div>
  </div>

  <h3 class="gh">{t('settings.playback.skip.title')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.skipIntro.label')}</div>
        <div class="desc">{t('settings.playback.skipIntro.desc')}</div>
      </div>
      <Segmented label={t('settings.playback.skipIntro.label')} value={s.playback.skipIntro} options={SKIP} onchange={(v) => set({ playback: { skipIntro: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.skipCredits.label')}</div>
        <div class="desc">{t('settings.playback.skipCredits.desc')}</div>
      </div>
      <Segmented label={t('settings.playback.skipCredits.label')} value={s.playback.skipCredits} options={SKIP} onchange={(v) => set({ playback: { skipCredits: v } })} />
    </div>
    {#each ['skipRecap', 'skipPreview', 'skipCommercial'] as const as k (k)}
      <div class="row">
        <div class="txt">
          <div class="lbl">{t(`settings.playback.${k}.label`)}</div>
          <div class="desc">{t(`settings.playback.${k}.desc`)}</div>
        </div>
        <Segmented label={t(`settings.playback.${k}.label`)} value={s.playback[k]} options={SKIP} onchange={(v) => set({ playback: { [k]: v } })} />
      </div>
    {/each}
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.aniskip.label')}</div>
        <div class="desc">{t('settings.playback.aniskip.desc')}</div>
      </div>
      <Toggle label={t('settings.playback.aniskip.label')} checked={s.playback.aniskip} onchange={(v) => set({ playback: { aniskip: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.communitySegments.label')}</div>
        <div class="desc">{t('settings.playback.communitySegments.desc')}</div>
      </div>
      <Toggle label={t('settings.playback.communitySegments.label')} checked={s.playback.communitySegments} onchange={(v) => set({ playback: { communitySegments: v } })} />
    </div>
  </div>

  <h3 class="gh">{t('settings.playback.speedSeek')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.speed.label')}</div>
        <div class="desc">{t('settings.playback.speed.desc')}</div>
      </div>
      <Picker label={t('settings.playback.speed.label')} value={s.playback.defaultSpeed} options={SPEEDS} onchange={(v) => set({ playback: { defaultSpeed: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.seekShort.label')}</div>
        <div class="desc">{t('settings.playback.seekShort.desc')}</div>
      </div>
      <Picker label={t('settings.playback.seekShort.label')} value={s.playback.seekShortS} options={SHORT_STEPS} onchange={(v) => set({ playback: { seekShortS: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.seekLong.label')}</div>
        <div class="desc">{t('settings.playback.seekLong.desc')}</div>
      </div>
      <Picker label={t('settings.playback.seekLong.label')} value={s.playback.seekLongS} options={LONG_STEPS} onchange={(v) => set({ playback: { seekLongS: v } })} />
    </div>
  </div>

  <h3 class="gh">{t('settings.playback.remember.title')}</h3>
  <div class="group">
    {#each REMEMBER as r (r.prop)}
      <div class="row">
        <div class="txt">
          <div class="lbl">{r.label}</div>
        </div>
        <Picker label={r.label} value={s.playback.rememberScopes[r.prop]} options={SCOPES} onchange={(v) => set({ playback: { rememberScopes: { [r.prop]: v } } })} />
      </div>
    {/each}
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.playback.remember.clear')}</div>
      </div>
      <button type="button" class="push" onclick={forgetPlayerSettings}>{t('settings.playback.remember.clearButton')}</button>
    </div>
  </div>

  <h3 class="gh">{t('settings.livetv.title')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.livetv.reminderLead.label')}</div>
        <div class="desc">{t('settings.livetv.reminderLead.desc')}</div>
      </div>
      <Picker label={t('settings.livetv.reminderLead.label')} value={s.live.reminderLeadMin} options={REMINDER_LEADS} onchange={(v) => set({ live: { reminderLeadMin: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.livetv.reminderAutoTune.label')}</div>
        <div class="desc">{t('settings.livetv.reminderAutoTune.desc')}</div>
      </div>
      <Toggle label={t('settings.livetv.reminderAutoTune.label')} checked={s.live.reminderAutoTune} onchange={(v) => set({ live: { reminderAutoTune: v } })} />
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
  .foot {
    margin: 10px 2px 0;
    font-size: var(--fs-footnote);
    color: var(--label-3);
    line-height: 1.5;
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
  .row + .row::before {
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

  /* Push button: small, neutral. */
  .push {
    flex: none;
    height: 28px;
    padding: 0 12px;
    border-radius: var(--r-xs);
    background: var(--fill-2);
    font-size: var(--fs-callout);
    font-weight: 500;
    color: var(--label);
    white-space: nowrap;
  }
  .push:hover,
  .push:focus-visible {
    background: var(--fill-3);
  }
  :global(.searching) .foot {
    display: none;
  }
  /* Hairlines only between rows that are still shown. */
  :global(.searching) .row::before {
    display: none;
  }
  :global(.searching) .row:not([hidden]) ~ .row:not([hidden])::before {
    display: block;
  }

  /* Compact density tightens these rows as well. */
  :global(html[data-density='compact']) .row {
    min-height: 50px;
    padding-block: 9px;
  }
</style>
