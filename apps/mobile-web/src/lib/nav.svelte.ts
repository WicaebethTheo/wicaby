// Navigation, as the Android mobile app (ui/App.kt MainShell): five tabs, each with its own back stack, and the
// full-screen pages (player, Live TV, reader, now playing, photo viewer) over them. Before sign-in, the setup pages.
// Same exports as the TV's lib/nav.svelte.ts, which the shared TV web logic imports: `stack` is what is shown, the
// top screen last; `nav.push` opens a page in the current tab (or full screen), `nav.back` closes the top one.
// Pages under the top stay mounted (hidden), so Back returns at once to the same scroll position.
import type { BaseItem } from '$shared/models';
import { look } from './look.svelte';
import type { Route as TvRoute } from '$tv/nav.svelte';

// A settings category's page (tabs/SettingsTab.svelte lists them).
export type SettingsPageId = 'general' | 'appearance' | 'playback' | 'subtitles' | 'home' | 'accounts' | 'password' | 'about';
// The TV's routes, plus the phone's own pages.
export type Route =
  | TvRoute
  | { name: 'settings'; page: SettingsPageId }
  | { name: 'admin'; section?: string }
  | { name: 'person'; id: string; serverId?: string; title?: string }
  | { name: 'favorites' }
  // A grid of what a server query returns (collections, playlists, history, a genre, a kind of favourites).
  | { name: 'browse'; title: string; query: Record<string, string>; serverId?: string };
export type RouteName = Route['name'];
export type TabId = 'home' | 'libraries' | 'search' | 'downloads' | 'settings';

export const TABS: TabId[] = ['home', 'libraries', 'search', 'downloads', 'settings'];

// Pages drawn over the tabs and their bar, without it.
const FULL_SCREEN = new Set<RouteName>(['player', 'live', 'reader', 'nowPlaying', 'photoView']);
// Pages before sign-in (and the "Who's watching?" picker): their own stack, without the tabs.
const SETUP = new Set<RouteName>(['servers', 'login']);

export function isFullScreen(route: Route): boolean {
  return FULL_SCREEN.has(route.name);
}

// The titles last opened from a card, as the card had them: a details page paints with them at once (name,
// artwork, facts) while it reads the whole title.
const peeked = new Map<string, BaseItem>();
export const peek = (id: string): BaseItem | undefined => peeked.get(id);

// Android NavController.open(item): an album or audio playlist opens its page, an artist theirs, a folder its grid,
// a channel plays live, a photo album opens its timeline, everything else its details page.
export function itemRoute(item: BaseItem): Route {
  peeked.delete(item.Id);
  peeked.set(item.Id, item);
  if (peeked.size > 40) peeked.delete(peeked.keys().next().value!);
  if (item.Type === 'MusicAlbum' || (item.Type === 'Playlist' && item.MediaType === 'Audio')) return { name: 'musicAlbum', id: item.Id, title: item.Name, serverId: item.ServerId };
  if (item.Type === 'MusicArtist') return { name: 'musicArtist', id: item.Id, title: item.Name, serverId: item.ServerId };
  if (item.Type === 'TvChannel') return { name: 'live', id: item.Id };
  if (item.Type === 'PhotoAlbum') return { name: 'photoAlbum', id: item.Id, title: item.Name, serverId: item.ServerId };
  return item.IsFolder && item.Type !== 'Series' && item.Type !== 'Season'
    ? { name: 'folder', id: item.Id, title: item.Name, serverId: item.ServerId }
    : { name: 'detail', id: item.Id, serverId: item.ServerId };
}

export interface Entry {
  key: number;
  route: Route;
  // The tab a page belongs to (null: setup and full-screen pages).
  tab: TabId | null;
}

let nextKey = 1;
const entry = (route: Route, tab: TabId | null): Entry => ({ key: nextKey++, route, tab });

// The root: the setup pages, or the signed-in shell ({ name: 'main' }) alone.
let roots: Entry[] = [];
const tabStacks: Record<TabId, Entry[]> = { home: [], libraries: [], search: [], downloads: [], settings: [] };
let full: Entry[] = [];

// op: what last changed the stack, for the page layer's motion (a push slides in, a tab switch is instant).
// dir: the side the last tab switch came from (1: a tab to the right of the previous one), for its motion.
export const shell = $state<{ tab: TabId; reselect: number; op: 'push' | 'back' | 'reset' | 'tab'; dir: 1 | -1 }>({ tab: 'home', reselect: 0, op: 'reset', dir: 1 });
// What is shown, bottom to top: the root, the current tab's pages, the full-screen pages.
export const stack = $state<Entry[]>([]);
// Every mounted page (each tab keeps its own), for the screen layer: hidden ones keep their state.
export const mounted = $state<Entry[]>([]);

const signedIn = (): boolean => roots.length === 1 && roots[0].route.name === 'main';

function sync(): void {
  const tab = signedIn() ? tabStacks[shell.tab] : [];
  stack.splice(0, stack.length, ...roots, ...tab, ...full);
  const all = signedIn() ? TABS.flatMap((t) => tabStacks[t]) : [];
  mounted.splice(0, mounted.length, ...roots, ...all, ...full);
}

export const nav = {
  push(route: Route): void {
    if (FULL_SCREEN.has(route.name)) full.push(entry(route, null));
    else if (route.name === 'main') return nav.reset(route);
    else if (SETUP.has(route.name) || !signedIn()) roots.push(entry(route, null));
    else tabStacks[shell.tab].push(entry(route, shell.tab));
    shell.op = 'push';
    sync();
  },
  reset(route: Route): void {
    roots = [entry(route, null)];
    for (const t of TABS) tabStacks[t] = [];
    full = [];
    shell.tab = look.startTab;
    shell.op = 'reset';
    sync();
  },
  // False on a root with nothing to go back to (Home, or the first setup page).
  back(): boolean {
    shell.op = 'back';
    if (full.length) full.pop();
    else if (signedIn() && tabStacks[shell.tab].length) tabStacks[shell.tab].pop();
    else if (!signedIn() && roots.length > 1) roots.pop();
    // Back on another tab's root returns to Home, like the platform's own apps.
    else if (signedIn() && shell.tab !== 'home') {
      shell.tab = 'home';
      shell.op = 'tab';
    } else return false;
    sync();
    return true;
  },
  // A tap on the tab bar: another tab shows where it was left; the current one returns to its root.
  selectTab(tab: TabId): void {
    if (tab === shell.tab) {
      // Already at the root: the tab scrolls back to its top.
      if (!tabStacks[tab].length) {
        shell.reselect++;
        return;
      }
      tabStacks[tab] = [];
      shell.op = 'back';
    } else {
      shell.dir = TABS.indexOf(tab) > TABS.indexOf(shell.tab) ? 1 : -1;
      shell.tab = tab;
      shell.op = 'tab';
    }
    sync();
  },
  get depth(): number {
    return stack.length;
  },
};

// Back handlers, like Compose's BackHandler: the top screen's newest handler that returns true consumes Back
// (a sheet closes before its page). Each screen's handlers carry its stack key, so hidden screens never react.
const SCREEN = Symbol('screen');
const handlers: { screen: number; fn: () => boolean }[] = [];

export function screenContext(key: number): [symbol, number] {
  return [SCREEN, key];
}

export function onBack(screen: number, fn: () => boolean): () => void {
  const h = { screen, fn };
  handlers.push(h);
  return () => {
    const i = handlers.indexOf(h);
    if (i >= 0) handlers.splice(i, 1);
  };
}

export function handleBack(): boolean {
  const top = stack[stack.length - 1]?.key;
  for (let i = handlers.length - 1; i >= 0; i--) if (handlers[i].screen === top && handlers[i].fn()) return true;
  return nav.back();
}

export { SCREEN };
