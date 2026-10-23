<script lang="ts">
  // One settings category (Android Settings.kt pages), on the TV web app's settings (same keys and defaults). Short
  // choices are chips, every option in view; the look is the theme cards and the accent swatches; switches for the
  // on/off ones.
  import { setLanguage, t } from '$tv/i18n.svelte';
  import { clearCache } from '$tv/load.svelte';
  import { api, prefs, removeExtra } from '$tv/session.svelte';
  import { settings, type Setting } from '$tv/settings.svelte';
  import Avatar from '../components/Avatar.svelte';
  import LargeTitlePage from '../components/LargeTitlePage.svelte';
  import AccentPicker from '../components/settings/AccentPicker.svelte';
  import Chips from '../components/settings/Chips.svelte';
  import Group from '../components/settings/Group.svelte';
  import HomeRows from '../components/settings/HomeRows.svelte';
  import LibraryOrder from '../components/settings/LibraryOrder.svelte';
  import Row from '../components/settings/Row.svelte';
  import SubtitlePreview from '../components/settings/SubtitlePreview.svelte';
  import ThemePicker from '../components/settings/ThemePicker.svelte';
  import { useLoad } from '$tv/load.svelte';
  import { ServerPrefs } from '../lib/server-prefs.svelte';
  import { showToast } from '$tv/toast.svelte';
  import Button from '../components/Button.svelte';
  import TextField from '../components/TextField.svelte';
  import { changePassword, removeAvatar, setAvatar } from '../lib/profile';
  import { imageTags } from '../lib/user.svelte';
  import type { BaseItem } from '$shared/models';
  import { leave } from '../lib/account';
  import { look, setLook, TEXT_SCALES, systemScale } from '../lib/look.svelte';
  import { BUILD, VERSION } from '../lib/identity';
  import { clearErrors, loggedErrors } from '../lib/diagnostics';
  import { checkForUpdate } from '../lib/updates.svelte';
  import { nav, type SettingsPageId } from '../lib/nav.svelte';
  import { showAlert } from '../lib/overlay.svelte';
  import { isAdmin } from '../lib/user.svelte';
  import { standalone } from '../platform';

  let { page }: { page: SettingsPageId } = $props();

  const a = api()!;
  const session = $derived(prefs.session);
  let admin = $state(false);
  void isAdmin(a).then((on) => (admin = on));

  const TITLE: Record<SettingsPageId, string> = {
    general: 'settings_general',
    appearance: 'settings_appearance',
    home: 'settings_home',
    playback: 'settings_playback',
    subtitles: 'subtitles',
    accounts: 'settings_accounts',
    password: 'web_password_change',
    about: 'about',
  };
  const LANGS = ['auto', 'fr', 'en'] as const;
  const MBPS = [0, 120, 80, 60, 40, 20, 10, 8, 4, 2];
  const SECS = [5, 10, 15, 20, 30];
  const HERO_SECS = [0, 5, 8, 12];
  const RESUME_DAYS = [0, 1, 3, 7];
  const SEEK_SECS = [10, 15, 30];
  const HIDE_SECS = [3.5, 6, 10];
  const START_TABS = [
    { id: 'home', label: 'tab_home' },
    { id: 'libraries', label: 'nav_libraries' },
    { id: 'downloads', label: 'nav_downloads' },
    { id: 'search', label: 'tab_search' },
  ] as const;

  $effect(() => setLanguage(settings.language.value));

  // A setting stored as the index of its option.
  const chips = (s: Setting<number>) => ({ selected: Math.max(0, s.value), onpick: (i: number) => (s.value = i) });
  const toggle = (label: string, s: Setting<boolean>, sub?: string) => ({ label, sub, checked: s.value, ontoggle: (on: boolean) => (s.value = on) });

  // A longer choice: the value on the right, a sheet with every option and the chosen one checked.
  const pick = (label: string, options: string[], selected: number, onpick: (i: number) => void) => ({
    label,
    value: options[selected],
    chevron: true,
    onclick: () => showAlert({ title: label, selected, actions: options.map((o, i) => ({ label: o, run: () => onpick(i) })) }),
  });

  // The user's server-side preferences (Emby web's Playback, Subtitles and Home pages): the server picks the default
  // streams from them for every app. A row shows only when the server knows the key (Emby and Jellyfin differ).
  // svelte-ignore state_referenced_locally
  const server = page === 'playback' || page === 'subtitles' || page === 'home' || page === 'general' ? new ServerPrefs(a) : null;
  const has = (key: string) => !!server?.config && key in server.config;
  const serverHint = $derived(t(server?.failed ? 'server_pref_failed' : 'server_pref_hint'));
  // ISO 639-2 as the servers store them, named in the app's language.
  const LANG_CODES = ['', 'fre', 'eng', 'jpn', 'ger', 'spa', 'ita', 'kor', 'por', 'dut', 'chi', 'rus', 'ara'];
  const BCP47: Record<string, string> = { fre: 'fr', eng: 'en', jpn: 'ja', ger: 'de', spa: 'es', ita: 'it', kor: 'ko', por: 'pt', dut: 'nl', chi: 'zh', rus: 'ru', ara: 'ar' };
  const langNames = $derived.by(() => {
    let names: Intl.DisplayNames | null = null;
    try {
      names = new Intl.DisplayNames([settings.language.value === 'en' ? 'en' : 'fr'], { type: 'language' });
    } catch {
      // Named by code below.
    }
    return LANG_CODES.map((c) => {
      if (!c) return t('lang_auto');
      const n = names?.of(BCP47[c]);
      return n ? n[0].toUpperCase() + n.slice(1) : c;
    });
  });
  const langPick = (label: string, key: string) =>
    pick(label, langNames, Math.max(0, LANG_CODES.indexOf(server!.str(key))), (i) => void server!.set(key, LANG_CODES[i]));
  const serverToggle = (label: string, key: string, sub?: string) => ({ label, sub, checked: server!.config?.[key] === true, ontoggle: (on: boolean) => void server!.set(key, on) });
  const SUB_MODES = ['Default', 'Smart', 'OnlyForced', 'Always', 'None'];
  const subModeNames = $derived([t('sub_mode_default'), t('sub_mode_smart'), t('sub_mode_forced'), t('sub_mode_always'), t('sub_mode_none')]);
  const AD = ['prefer', 'avoid', 'any'] as const;

  // ---- The account: picture and password ----
  let picker = $state<HTMLInputElement>();
  let avatarBusy = $state(false);
  async function onPhoto(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    avatarBusy = true;
    try {
      await setAvatar(a, file);
      showToast(t('web_avatar_saved'));
    } catch {
      showToast(t('web_action_failed'));
    } finally {
      avatarBusy = false;
    }
  }
  function onRemovePhoto(): void {
    confirm(t('web_avatar_remove'), t('web_avatar_remove'), () =>
      removeAvatar(a).catch(() => showToast(t('web_action_failed'))),
    );
  }
  let currentPw = $state('');
  let newPw = $state('');
  let againPw = $state('');
  let pwBusy = $state(false);
  let pwError = $state('');
  const mismatch = $derived(againPw.length > 0 && againPw !== newPw);
  const pwReady = $derived(newPw.length > 0 && newPw === againPw && !pwBusy);
  async function savePassword(): Promise<void> {
    if (!pwReady) return;
    pwBusy = true;
    pwError = '';
    try {
      await changePassword(a, currentPw, newPw);
      showToast(t('web_password_saved'));
      nav.back();
    } catch (err) {
      const status = (err as { status?: number }).status;
      pwError = t(status === 400 || status === 401 || status === 403 ? 'web_password_wrong' : 'web_action_failed');
    } finally {
      pwBusy = false;
    }
  }

  const skipOptions = $derived([t('skip_ask'), t('skip_auto'), t('skip_off')]);
  const passOptions = $derived([t('pass_auto'), t('pass_on'), t('pass_off')]);

  function confirm(title: string, label: string, run: () => void): void {
    showAlert({ title, actions: [{ label, destructive: true, run }, { label: t('cancel'), run: () => {} }] });
  }

  // Text size: the system's, then the fixed sizes; the system's own scale shown in its chip.
  const textOptions = $derived([t('web_text_system', `${Math.round(systemScale() * 100)} %`), t('web_text_xs'), t('web_text_s'), t('web_text_m'), t('web_text_l'), t('web_text_xl')]);
  const textIndex = $derived(look.textSize === 'system' ? 0 : Math.max(0, TEXT_SCALES.indexOf(look.textSize)) + 1);
  // A settings page is pushed for one category and never re-targeted.
  // svelte-ignore state_referenced_locally
  const views = page === 'home' || page === 'appearance' ? useLoad<BaseItem[]>(() => 'views', () => a.views(), { persist: true }) : null;

  // svelte-ignore state_referenced_locally
  let errors = $state(page === 'about' ? loggedErrors() : []);

  let checking = $state(false);
  async function lookForUpdate(): Promise<void> {
    if (checking) return;
    checking = true;
    try {
      const ready = await checkForUpdate();
      if (!ready) showToast(t(ready === null ? 'web_update_unavailable' : 'web_update_none'));
    } catch {
      showToast(t('web_action_failed'));
    } finally {
      checking = false;
    }
  }

  const css = getComputedStyle(document.documentElement);
  const inset = (() => {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;padding-top:env(safe-area-inset-top)';
    document.body.appendChild(probe);
    const px = parseFloat(getComputedStyle(probe).paddingTop) || 0;
    probe.remove();
    return px;
  })();
  const display = `${window.innerHeight}/${screen.height} · ${css.getPropertyValue('--app-height').trim() || 'auto'} · ${t('web_display_top', Math.round(inset))} · ${standalone ? 'app' : 'web'}`;
</script>

<LargeTitlePage title={t(TITLE[page])} back>
  {#if page === 'general'}
    <Group title={t('settings_language')}>
      <Chips options={[t('language_system'), t('language_fr'), t('language_en')]} selected={Math.max(0, LANGS.indexOf(settings.language.value as (typeof LANGS)[number]))} onpick={(i) => (settings.language.value = LANGS[i])} />
    </Group>
    {#if has('DisplayMissingEpisodes')}
      <Group title={t('web_library_content')} hint={serverHint}>
        <Row {...serverToggle(t('web_missing_episodes'), 'DisplayMissingEpisodes', t('web_missing_episodes_sub'))} />
      </Group>
    {/if}
  {:else if page === 'appearance'}
    <Group title={t('settings_theme')}>
      <ThemePicker theme={settings.theme.value} accent={settings.accent.value} onpick={(id) => (settings.theme.value = id)} />
    </Group>
    <Group title={t('settings_accent')}>
      <AccentPicker accent={settings.accent.value} onpick={(i) => (settings.accent.value = i)} />
    </Group>
    <Group title={t('web_text')} hint={t('web_text_hint')}>
      <Chips label={t('web_text_size')} options={textOptions} selected={textIndex} onpick={(i) => setLook('textSize', i === 0 ? 'system' : TEXT_SCALES[i - 1])} />
      <p class="preview">{t('web_text_preview')}</p>
    </Group>
    <Group title={t('web_posters')}>
      <Chips label={t('web_poster_size')} options={[t('web_size_small'), t('web_size_medium'), t('web_size_large')]} selected={look.posterSize} onpick={(i) => setLook('posterSize', i)} />
      <Row label={t('web_poster_titles')} checked={look.posterTitles} ontoggle={(on) => setLook('posterTitles', on)} />
      <Row label={t('web_card_badges')} sub={t('web_card_badges_sub')} checked={look.cardBadges} ontoggle={(on) => setLook('cardBadges', on)} />
      <Row label={t('web_library_art')} sub={t('web_library_art_sub')} checked={look.libraryArt} ontoggle={(on) => setLook('libraryArt', on)} />
    </Group>
    <Group title={t('web_library_order')} hint={t('web_library_order_hint')}>
      <LibraryOrder api={a} views={() => views?.value ?? []} />
    </Group>
    <Group title={t('web_interface')}>
      <Chips label={t('web_start_tab')} options={START_TABS.map((s) => t(s.label))} selected={Math.max(0, START_TABS.findIndex((s) => s.id === look.startTab))} onpick={(i) => setLook('startTab', START_TABS[i].id)} />
      <Row label={t('web_tab_labels')} checked={look.tabLabels} ontoggle={(on) => setLook('tabLabels', on)} />
      <Row label={t('web_reduce_motion')} sub={t('web_reduce_motion_sub')} checked={look.reduceMotion} ontoggle={(on) => setLook('reduceMotion', on)} />
    </Group>
  {:else if page === 'home'}
    <Group title={t('group_home')}>
      <Row {...toggle(t('row_hero'), settings.rowHero)} />
      {#if settings.rowHero.value}<Row {...toggle(t('hero_hide_watched'), settings.heroHideWatched)} />{/if}
      <Row {...toggle(t('settings_merge_continue'), settings.mergeContinue)} />
      <Row label={t('web_continue_large')} sub={t('web_continue_large_sub')} checked={look.continueLarge} ontoggle={(on) => setLook('continueLarge', on)} />
      {#if settings.rowHero.value}
        <Chips
          label={t('web_resume_hero')}
          options={RESUME_DAYS.map((d) => (d ? t('web_days', d) : t('web_off')))}
          selected={Math.max(0, RESUME_DAYS.indexOf(look.resumeHeroDays))}
          onpick={(i) => setLook('resumeHeroDays', RESUME_DAYS[i])}
        />
        <p class="chip-hint footnote label-2">{t('web_resume_hero_hint')}</p>
        <Chips label={t('web_hero_rotation')} options={HERO_SECS.map((s) => (s ? t('seconds', s) : t('web_off')))} selected={Math.max(0, HERO_SECS.indexOf(look.heroSeconds))} onpick={(i) => setLook('heroSeconds', HERO_SECS[i])} />
      {/if}
    </Group>
    <Group title={t('web_home_rows')} hint={t('web_home_rows_hint')}>
      <HomeRows views={() => views?.value ?? []} />
    </Group>
    {#if has('HidePlayedInLatest')}
      <Group hint={serverHint}>
        <Row {...serverToggle(t('web_hide_played_latest'), 'HidePlayedInLatest', t('web_hide_played_latest_sub'))} />
      </Group>
    {/if}
    <Group title={t('tab_search')}>
      <Row {...toggle(t('search_episodes'), settings.searchEpisodes)} />
    </Group>
  {:else if page === 'playback'}
    <Group title={t('group_quality')}>
      <Chips
        label={t('settings_bitrate')}
        options={MBPS.map((m) => (m === 0 ? t('settings_bitrate_auto') : t('mbps', m)))}
        selected={Math.max(0, MBPS.indexOf(settings.mbpsEthernet.value))}
        onpick={(i) => (settings.mbpsEthernet.value = MBPS[i])}
      />
    </Group>
    <Group title={t('group_language')} hint={serverHint}>
      {#if server?.config}
        <Row {...langPick(t('audio_language'), 'AudioLanguagePreference')} />
        {#if has('PlayDefaultAudioTrack')}<Row {...serverToggle(t('web_default_audio'), 'PlayDefaultAudioTrack', t('web_default_audio_sub'))} />{/if}
        {#if has('RememberAudioSelections')}<Row {...serverToggle(t('web_remember_audio'), 'RememberAudioSelections', t('web_remember_sub'))} />{/if}
      {:else}
        <Row label={t('audio_language')} value={t('loading')} />
      {/if}
    </Group>
    <Group title={t('a11y_group')} hint={t('a11y_hint')}>
      <Row {...pick(t('audio_description'), [t('ad_prefer'), t('ad_avoid'), t('ad_any')], Math.max(0, AD.indexOf(settings.audioDescription.value)), (i) => (settings.audioDescription.value = AD[i]))} />
    </Group>
    <Group title={t('web_dolby')} hint={t('web_dolby_hint')}>
      <Chips label="Dolby Digital (AC3)" options={passOptions} {...chips(settings.passthrough.ac3)} />
      <Chips label="Dolby Digital Plus (EAC3)" options={passOptions} {...chips(settings.passthrough.eac3)} />
    </Group>
    <Group title={t('web_player_controls')}>
      <Chips label={t('web_seek_step')} options={SEEK_SECS.map((s) => t('seconds', s))} selected={Math.max(0, SEEK_SECS.indexOf(look.seekSeconds))} onpick={(i) => setLook('seekSeconds', SEEK_SECS[i])} />
      <Chips label={t('web_controls_hide')} options={HIDE_SECS.map((s) => t('web_seconds_dec', s.toLocaleString()))} selected={Math.max(0, HIDE_SECS.indexOf(look.controlsSeconds))} onpick={(i) => setLook('controlsSeconds', HIDE_SECS[i])} />
    </Group>
    <Group title={t('group_resume')}>
      <Chips label={t('resume_mode')} options={[t('resume_auto'), t('resume_ask'), t('resume_start')]} {...chips(settings.resume)} />
      <Row {...toggle(t('autoplay_next'), settings.autoplayNext)} />
      {#if settings.autoplayNext.value}
        <Chips
          label={t('countdown')}
          options={SECS.map((s) => t('seconds', s))}
          selected={Math.max(0, SECS.indexOf(settings.countdown.value))}
          onpick={(i) => (settings.countdown.value = SECS[i])}
        />
      {/if}
    </Group>
    <Group title={t('group_skip')}>
      <Chips label={t('skip_intro_mode')} options={skipOptions} {...chips(settings.skipIntro)} />
      {#if !a.isEmby}
        <Chips label={t('skip_recap')} options={skipOptions} {...chips(settings.skipRecap)} />
        <Chips label={t('skip_preview')} options={skipOptions} {...chips(settings.skipPreview)} />
        <Chips label={t('skip_commercial')} options={skipOptions} {...chips(settings.skipCommercial)} />
      {/if}
    </Group>
  {:else if page === 'subtitles'}
    <Group title={t('group_sub_language')} hint={serverHint}>
      {#if server?.config}
        <Row {...langPick(t('subtitle_language'), 'SubtitleLanguagePreference')} />
        <Row {...pick(t('subtitle_mode'), subModeNames, Math.max(0, SUB_MODES.indexOf(server.str('SubtitleMode') || 'Default')), (i) => void server!.set('SubtitleMode', SUB_MODES[i]))} />
        {#if has('RememberSubtitleSelections')}<Row {...serverToggle(t('web_remember_subs'), 'RememberSubtitleSelections', t('web_remember_sub'))} />{/if}
      {:else}
        <Row label={t('subtitle_language')} value={t('loading')} />
      {/if}
    </Group>
    <Group title={t('group_style')} hint={t('subtitle_hint')}>
      <SubtitlePreview />
      <Chips label={t('subtitle_size')} options={[t('size_small'), t('size_normal'), t('size_large'), t('size_xlarge')]} {...chips(settings.subtitleSize)} />
      <Chips label={t('subtitle_style')} options={[t('style_outline'), t('style_shadow'), t('style_box')]} {...chips(settings.subtitleStyle)} />
      <Chips label={t('subtitle_font')} options={['Geist', t('font_system'), t('font_serif')]} {...chips(settings.subtitleFont)} />
      <Chips label={t('subtitle_color')} options={[t('color_white'), t('color_yellow'), t('color_light_gray')]} {...chips(settings.subtitleColor)} />
      <Chips label={t('subtitle_position')} options={[t('sub_pos_bottom'), t('sub_pos_slightly_raised'), t('sub_pos_raised')]} {...chips(settings.subtitlePosition)} />
      <Row {...toggle(t('subtitle_override_ass'), settings.subtitleOverrideAss)} />
    </Group>
    <Group title={t('a11y_group')} hint={t('a11y_hint')}>
      <Row {...toggle(t('prefer_sdh'), settings.preferSdh)} />
    </Group>
  {:else if page === 'accounts' && session}
    <Group title={t('web_accounts')}>
      <div class="account">
        <Avatar user={{ Id: session.userId, Name: session.userName }} api={a} size={56} />
        <span class="who">
          <span class="headline">{session.userName}</span>
          <span class="footnote label-2 ellipsis">{session.server.name} · {session.server.address}</span>
          {#if admin}<span class="chip badge">{t('web_admin_badge')}</span>{/if}
        </span>
      </div>
      <Row label={t('web_avatar_change')} value={avatarBusy ? t('loading') : undefined} chevron onclick={() => picker?.click()} />
      {#if imageTags[session.userId]}<Row label={t('web_avatar_remove')} destructive onclick={onRemovePhoto} />{/if}
      <Row label={t('web_password_change')} chevron onclick={() => nav.push({ name: 'settings', page: 'password' })} />
      <input class="sr-only" type="file" accept="image/*" bind:this={picker} onchange={onPhoto} />
    </Group>
    <Group>
      <Row label={t('switch_user')} accent onclick={() => leave(false)} />
      <Row label={t('sign_out')} destructive onclick={() => confirm(t('sign_out'), t('sign_out'), () => leave(true))} />
    </Group>
    <Group title={t('other_servers')} hint={t('other_servers_hint')}>
      {#each prefs.extras ?? [] as extra (extra.server.id)}
        <Row label={extra.server.name} sub={extra.userName} onclick={() => confirm(extra.server.name, t('remove_server'), () => (removeExtra(extra.server.id), clearCache()))} />
      {/each}
      <Row label={t('add_server')} accent onclick={() => nav.push({ name: 'servers', add: true })} />
    </Group>
  {:else if page === 'password' && session}
    <form class="password" onsubmit={(e) => (e.preventDefault(), void savePassword())}>
      <!-- The account name for iCloud Keychain, which then offers to update the saved password. -->
      <input class="sr-only" type="text" autocomplete="username" value={session.userName} readonly tabindex="-1" aria-hidden="true" />
      <TextField label={t('web_password_current')} type="password" autocomplete="current-password" bind:value={currentPw} />
      <TextField label={t('web_password_new')} type="password" autocomplete="new-password" bind:value={newPw} />
      <TextField label={t('web_password_again')} type="password" autocomplete="new-password" bind:value={againPw} />
      <p class="footnote note" class:error={!!pwError || mismatch}>{pwError || (mismatch ? t('web_password_mismatch') : t('web_password_hint'))}</p>
      <Button text={t('save')} primary wide busy={pwBusy} disabled={!pwReady} onclick={() => void savePassword()} />
    </form>
  {:else if page === 'about'}
    {#if !standalone}
      <Group title={t('web_install_title')}><p class="footnote label-2 note">{t('web_install_body')}</p></Group>
    {/if}
    <Group title={t('about')}>
      <Row label={t('version')} value={`${VERSION} · ${BUILD}`} />
      <Row label={t('web_update_check')} value={checking ? t('loading') : undefined} accent onclick={() => void lookForUpdate()} />
      <!-- The heights lib/viewport.ts works with, for a report from the phone. -->
      <Row label={t('web_display')} value={display} />
    </Group>
    {#if errors.length}
      <Group title={t('web_errors')} hint={t('web_errors_hint')}>
        {#each errors as e, i (i)}
          <div class="error-entry">
            <span class="caption label-2">{new Date(e.at).toLocaleString()} · {e.where}</span>
            <pre class="caption">{e.message}</pre>
          </div>
        {/each}
        <Row label={t('web_errors_copy')} accent onclick={() => void navigator.clipboard?.writeText(errors.map((e) => `${e.at} ${e.where}\n${e.message}`).join('\n\n')).then(() => showToast(t('web_copied_done')))} />
        <Row label={t('web_errors_clear')} destructive onclick={() => (clearErrors(), (errors = []))} />
      </Group>
    {/if}
  {/if}
  <div class="end"></div>
</LargeTitlePage>

<style>
  .preview {
    margin: 0;
    padding: 12px 16px 14px;
    font-size: var(--fs-body);
    line-height: 1.35;
    color: var(--label-2);
  }
  .account {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px 16px;
  }
  .who {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
  }
  .ellipsis {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .badge {
    margin-top: 6px;
    background: color-mix(in srgb, var(--accent) 22%, transparent);
    color: var(--accent);
  }
  .note {
    padding: 14px 16px;
    line-height: 1.4;
  }
  .end {
    height: 32px;
  }
  .chip-hint {
    margin: -6px 0 0;
    padding: 0 16px 12px;
  }
  .error-entry {
    padding: 10px 16px;
    background: var(--bg-elevated);
    border-bottom: 0.5px solid var(--separator);
  }
  .error-entry pre {
    margin: 4px 0 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: ui-monospace, monospace;
    color: var(--label);
  }
  .password {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px max(var(--gutter), var(--safe-right)) 0 max(var(--gutter), var(--safe-left));
  }
  .password .note {
    margin: 0 4px 8px;
    color: var(--label-2);
  }
  .password .error {
    color: var(--red);
  }
</style>
