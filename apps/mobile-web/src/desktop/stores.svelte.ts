// The desktop renderer's stores, for the admin sections it reuses: the signed-in servers as its sessions, its toasts
// as this app's toasts (an action as a snackbar), and the data versions that make pages reload.
import type { ServerKind } from '$shared/contract';
import { changed } from '$tv/load.svelte';
import { apiOf, prefs, serverName as nameOf } from '$tv/session.svelte';
import { showToast } from '$tv/toast.svelte';
import { showSnack } from '../lib/snackbar.svelte';
import { adminKey, adminOf, isAdmin } from '../lib/user.svelte';

interface AdminSession {
  status: 'signed-in';
  server: { id: string; name: string; kind: ServerKind; address: string };
  user: { id: string; name: string; isAdmin: boolean };
}

export function sessionFor(serverId?: string): AdminSession | undefined {
  const a = apiOf(serverId);
  const s = !serverId || serverId === prefs.session?.server.id ? prefs.session : (prefs.extras ?? []).find((e) => e.server.id === serverId);
  if (!a || !s) return undefined;
  void isAdmin(a);
  return {
    status: 'signed-in',
    server: { id: s.server.id, name: s.server.name, kind: s.server.kind, address: s.server.address },
    user: { id: s.userId, name: s.userName, isAdmin: adminOf[adminKey(a)] === true },
  };
}

export const serverName = (serverId?: string): string => nameOf(serverId ?? prefs.session?.server.id) ?? '';

export function toast(_kind: 'info' | 'success' | 'error', message: string, action?: { label: string; run: () => void }): void {
  if (action) showSnack({ text: message, action: action.label, run: action.run });
  else showToast(message);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Bumped by the admin after a change; every visible page reloads (the desktop's pages watch these counters).
export const dataVersion = $state({ userData: 0, library: 0 });
$effect.root(() => {
  $effect(() => {
    if (dataVersion.userData + dataVersion.library) changed();
  });
});

// The admin reads the preferred subtitle language from the desktop settings; none here (it then follows the phone).
export const settings = { value: null as { playback: { preferredSubtitleLanguage?: string } } | null };
