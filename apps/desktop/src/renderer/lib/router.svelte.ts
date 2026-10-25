// Hash router. Routes: /welcome[?rerun=1], /servers, /login[/:server], /home, /library/:server/:id, /item/:server/:id,
// /search, /favorites, /shuffle, /history, /downloads, /settings, /player, /osd, /read/:server/:id, /livetv, /iptv,
// /files/:server/:id (a file source's folder), /immich/:id (an Immich photo source, photos spec PH-12).
// Without :server (jump list, older links), an id belongs to the primary server.
// Route changes run inside a View Transition so pages cross-fade on the
// compositor; elements with a matching view-transition-name morph between pages.
import { tick } from 'svelte';
import { parseRouteParams } from './route-params';

export interface Route {
  path: string;
  name: string;
  params: Record<string, string>;
  query: URLSearchParams;
}

function parse(): Route {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = raw.split('?');
  const parts = path.split('/').filter(Boolean);
  const name = parts[0] ?? '';
  const params = parseRouteParams(parts);
  // A malformed id (hand-made link, injected hash) is refused: the route falls back to home.
  if (!params) {
    console.warn('router: refused malformed route');
    history.replaceState(null, '', '#/home');
    return { path: '/home', name: 'home', params: {}, query: new URLSearchParams() };
  }
  return { path, name, params, query: new URLSearchParams(qs) };
}

export const router = $state<{ route: Route }>({ route: parse() });

// Visited paths, to tell "back" from "forward" for the transition direction.
const trail: string[] = [router.route.path];

function apply(): void {
  const next = parse();
  if (next.path === router.route.path && next.query.toString() === router.route.query.toString()) return;
  const isBack = trail.length > 1 && trail[trail.length - 2] === next.path;
  if (isBack) trail.pop();
  else trail.push(next.path);
  if (trail.length > 64) trail.shift();

  // Set before every route change, animated or not: scroll restore reads it on the way back.
  document.documentElement.dataset.nav = isBack ? 'back' : 'forward';
  const reduce = document.documentElement.hasAttribute('data-reduce-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches;
  // The player and the OSD swap whole layouts; a cross-fade there only costs a frame.
  if (!document.startViewTransition || reduce || next.name === 'player' || router.route.name === 'player') {
    router.route = next;
    return;
  }
  const vt = document.startViewTransition(async () => {
    router.route = next;
    await tick();
  });
  // Chromium skips the animation (and rejects these) when the window is hidden or a new navigation interrupts.
  vt.ready.catch(() => undefined);
  vt.finished.catch(() => undefined);
}

window.addEventListener('hashchange', apply);

export function navigate(path: string, opts: { replace?: boolean } = {}): void {
  const target = `#${path}`;
  if (location.hash === target) return;
  if (opts.replace) {
    history.replaceState(null, '', target);
    trail[trail.length - 1] = path.split('?')[0];
    router.route = parse();
  } else {
    location.hash = path;
  }
}

export function back(fallback = '/home'): void {
  if (history.length > 1) history.back();
  else navigate(fallback, { replace: true });
}
