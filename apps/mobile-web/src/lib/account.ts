// Leaving the account, from the profile menu and Settings.
import { clearCache } from '$tv/load.svelte';
import { api, prefs, signOut } from '$tv/session.svelte';
import { nav } from './nav.svelte';

// Switch user keeps the profile and its token for the "Who's watching?" picker. Sign out forgets the profile and
// revokes its token on the server too, so a copy of this phone's storage opens nothing.
export function leave(forget: boolean): void {
  const server = prefs.session?.server;
  if (forget) void api()?.post('/Sessions/Logout').catch(() => {});
  signOut(forget);
  clearCache();
  nav.reset(server ? { name: 'login', server } : { name: 'servers' });
}
