<script lang="ts">
  // Réglages, as the Android mobile app lays them out (ui/Settings.kt SettingsRoot): the account on top, then the
  // categories, each with its icon tile and what it is set to, opening its own page (screens/SettingsPage.svelte).
  import { t } from '$tv/i18n.svelte';
  import { api, prefs } from '$tv/session.svelte';
  import { settings } from '$tv/settings.svelte';
  import Captions from '@lucide/svelte/icons/captions';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import Globe from '@lucide/svelte/icons/globe';
  import House from '@lucide/svelte/icons/house';
  import Info from '@lucide/svelte/icons/info';
  import Palette from '@lucide/svelte/icons/palette';
  import Play from '@lucide/svelte/icons/play';
  import Users from '@lucide/svelte/icons/users';
  import Wrench from '@lucide/svelte/icons/wrench';
  import Avatar from '../components/Avatar.svelte';
  import LargeTitlePage from '../components/LargeTitlePage.svelte';
  import Group from '../components/settings/Group.svelte';
  import Row from '../components/settings/Row.svelte';
  import { VERSION } from '../lib/identity';
  import { nav, type SettingsPageId } from '../lib/nav.svelte';
  import { ACCENTS } from '../lib/theme';
  import { isAdmin } from '../lib/user.svelte';

  const a = api()!;
  const session = $derived(prefs.session);
  let admin = $state(false);
  void isAdmin(a).then((on) => (admin = on));

  const open = (page: SettingsPageId) => nav.push({ name: 'settings', page });
  const LANG: Record<string, string> = { auto: 'language_system', fr: 'language_fr', en: 'language_en' };
  const bitrate = $derived(settings.mbpsEthernet.value ? t('mbps', settings.mbpsEthernet.value) : t('settings_bitrate_auto'));
  const look = $derived(`${t(`theme_${settings.theme.value}`)} · ${t(`accent_${ACCENTS[settings.accent.value] ?? ACCENTS[0]}`)}`);
  const subs = $derived(t(['size_small', 'size_normal', 'size_large', 'size_xlarge'][settings.subtitleSize.value] ?? 'size_normal'));
</script>

<LargeTitlePage title={t('tab_settings')} tab="settings">
  {#if session}
    <button class="me pressable" onclick={() => open('accounts')}>
      <Avatar user={{ Id: session.userId, Name: session.userName }} api={a} size={60} />
      <span class="who">
        <span class="title-3 ellipsis">{session.userName}</span>
        <span class="footnote label-2 ellipsis">{session.server.name}</span>
        {#if admin}<span class="chip badge">{t('web_admin_badge')}</span>{/if}
      </span>
      <ChevronRight size={20} strokeWidth={2.2} aria-hidden="true" />
    </button>
  {/if}

  <Group>
    <Row icon={Globe} tint="var(--blue)" label={t('settings_general')} sub={t(LANG[settings.language.value] ?? 'language_system')} chevron onclick={() => open('general')} />
    <Row icon={Palette} tint="var(--purple)" label={t('settings_appearance')} sub={look} chevron onclick={() => open('appearance')} />
    <Row icon={House} tint="var(--green)" label={t('settings_home')} chevron onclick={() => open('home')} />
  </Group>

  <Group>
    <Row icon={Play} tint="var(--red)" label={t('settings_playback')} sub={bitrate} chevron onclick={() => open('playback')} />
    <Row icon={Captions} tint="var(--orange)" label={t('subtitles')} sub={subs} chevron onclick={() => open('subtitles')} />
  </Group>

  {#if admin}
    <Group>
      <Row icon={Wrench} tint="var(--gray, #8e8e93)" label={t('web_admin_title')} sub={t('web_admin_sub')} chevron onclick={() => nav.push({ name: 'admin' })} />
    </Group>
  {/if}

  <Group>
    <Row icon={Users} tint="var(--indigo)" label={t('settings_accounts')} sub={session ? t('signed_in_as', session.userName, session.server.name) : undefined} chevron onclick={() => open('accounts')} />
    <Row icon={Info} tint="var(--fill-4)" label={t('about')} sub={`Wicaby ${VERSION}`} chevron onclick={() => open('about')} />
  </Group>
  <div class="end"></div>
</LargeTitlePage>

<style>
  .me {
    margin: 8px max(var(--gutter), var(--safe-right)) 0 max(var(--gutter), var(--safe-left));
    width: calc(100% - 2 * var(--gutter));
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 16px;
    border-radius: var(--r-lg);
    background: var(--bg-elevated);
    text-align: left;
    color: var(--label);
  }
  .me > :global(svg) {
    color: var(--label-3);
    flex: none;
  }
  .who {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
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
  .end {
    height: 32px;
  }
</style>
