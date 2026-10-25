// Administration sections. Each section is one component in this folder;
// a section whose file does not exist yet is simply not listed.
import type { Component } from 'svelte';

const modules = import.meta.glob<{ default: Component }>('./*.svelte');

export interface AdminSection {
  id: string;
  /** i18n key, namespace "admin". */
  label: string;
  icon: string;
  load: () => Promise<{ default: Component }>;
}

const ALL: { id: string; file: string; label: string; icon: string }[] = [
  { id: 'dashboard', file: './Dashboard.svelte', label: 'admin.nav.dashboard', icon: 'gauge' },
  { id: 'activity', file: './Activity.svelte', label: 'admin.nav.activity', icon: 'activity' },
  { id: 'users', file: './Users.svelte', label: 'admin.nav.users', icon: 'users' },
  { id: 'devices', file: './Devices.svelte', label: 'admin.nav.devices', icon: 'device' },
  { id: 'libraries', file: './Libraries.svelte', label: 'admin.nav.libraries', icon: 'folder' },
  { id: 'analytics', file: './Analytics.svelte', label: 'admin.nav.analytics', icon: 'chart' },
  { id: 'tasks', file: './Tasks.svelte', label: 'admin.nav.tasks', icon: 'clock' },
  { id: 'transcoding', file: './Transcoding.svelte', label: 'admin.nav.transcoding', icon: 'cpu' },
  { id: 'server', file: './ServerSettings.svelte', label: 'admin.nav.server', icon: 'server' },
  { id: 'plugins', file: './Plugins.svelte', label: 'admin.nav.plugins', icon: 'puzzle' },
  { id: 'apikeys', file: './ApiKeys.svelte', label: 'admin.nav.apikeys', icon: 'key' },
  { id: 'logs', file: './Logs.svelte', label: 'admin.nav.logs', icon: 'file' },
];

export const ADMIN_SECTIONS: AdminSection[] = ALL.filter((s) => modules[s.file]).map((s) => ({
  id: s.id,
  label: s.label,
  icon: s.icon,
  load: modules[s.file],
}));
