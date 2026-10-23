<script lang="ts">
  // Server administration (the desktop's routes/Admin.svelte): the sections as a list of icon rows, each opening its
  // own page with the desktop section itself (dashboard, activity, users, devices, libraries, scheduled tasks,
  // transcoding, server settings, plugins, API keys, logs). Only for an administrator of the signed-in server.
  import { ADMIN_SECTIONS } from '../../../desktop/src/renderer/admin/sections';
  import { t } from '$desktop/i18n.svelte';
  import { api, prefs } from '$tv/session.svelte';
  import Activity from '@lucide/svelte/icons/activity';
  import Clock from '@lucide/svelte/icons/clock';
  import Cpu from '@lucide/svelte/icons/cpu';
  import FileText from '@lucide/svelte/icons/file-text';
  import Folder from '@lucide/svelte/icons/folder';
  import Gauge from '@lucide/svelte/icons/gauge';
  import KeyRound from '@lucide/svelte/icons/key-round';
  import MonitorSmartphone from '@lucide/svelte/icons/monitor-smartphone';
  import Puzzle from '@lucide/svelte/icons/puzzle';
  import Server from '@lucide/svelte/icons/server';
  import Users from '@lucide/svelte/icons/users';
  import type { Component } from 'svelte';
  import LargeTitlePage from '../components/LargeTitlePage.svelte';
  import Spinner from '../components/Spinner.svelte';
  import Group from '../components/settings/Group.svelte';
  import Row from '../components/settings/Row.svelte';
  import { adminLanguage } from '../desktop/admin';
  import { nav } from '../lib/nav.svelte';

  let { section }: { section?: string } = $props();

  adminLanguage();
  const a = api()!;
  const serverId = a.serverId ?? '';
  const current = $derived(ADMIN_SECTIONS.find((s) => s.id === section));

  const LOOK: Record<string, [Component, string]> = {
    dashboard: [Gauge, 'var(--blue)'],
    activity: [Activity, 'var(--orange)'],
    users: [Users, 'var(--indigo)'],
    devices: [MonitorSmartphone, 'var(--teal)'],
    libraries: [Folder, 'var(--green)'],
    tasks: [Clock, 'var(--purple)'],
    transcoding: [Cpu, 'var(--red)'],
    server: [Server, 'var(--fill-4)'],
    plugins: [Puzzle, 'var(--pink)'],
    apikeys: [KeyRound, 'var(--yellow)'],
    logs: [FileText, 'var(--fill-4)'],
  };
  // The desktop's order, grouped as Emby's dashboard menu groups them.
  const GROUPS = [
    ['dashboard', 'activity'],
    ['users', 'devices'],
    ['libraries', 'tasks', 'transcoding'],
    ['server', 'plugins', 'apikeys', 'logs'],
  ];
</script>

{#if current}
  <LargeTitlePage title={t(current.label)} back>
    <div class="admin-pane">
      {#await current.load()}
        <div class="loading"><Spinner /></div>
      {:then mod}
        <mod.default {serverId} kind={a.kind} />
      {:catch err}
        <p class="footnote label-2 none">{t('admin.loadFailed')} {String(err)}</p>
      {/await}
    </div>
  </LargeTitlePage>
{:else}
  <LargeTitlePage title={t('admin.title')} back>
    <p class="footnote label-2 server">{prefs.session?.server.name} · {a.isEmby ? 'Emby' : 'Jellyfin'}</p>
    {#each GROUPS as ids, i (i)}
      <Group>
        {#each ADMIN_SECTIONS.filter((s) => ids.includes(s.id)) as s (s.id)}
          {@const [icon, tint] = LOOK[s.id] ?? [Server, 'var(--fill-4)']}
          <Row {icon} {tint} label={t(s.label)} chevron onclick={() => nav.push({ name: 'admin', section: s.id })} />
        {/each}
      </Group>
    {/each}
    <div class="end"></div>
  </LargeTitlePage>
{/if}

<style>
  .server {
    padding: 0 max(var(--gutter), var(--safe-right)) 4px max(var(--gutter), var(--safe-left));
  }
  .admin-pane {
    padding: 4px max(var(--gutter), var(--safe-right)) calc(var(--tabbar) + 32px) max(var(--gutter), var(--safe-left));
  }
  .loading {
    display: grid;
    place-items: center;
    height: 240px;
  }
  .none {
    padding: 24px 0;
  }
  .end {
    height: 32px;
  }
</style>
