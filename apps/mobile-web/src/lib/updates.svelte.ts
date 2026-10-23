// App updates through the service worker (src/sw.ts). A new version installs in the background; the app then offers
// to reload into it (components/UpdateBanner.svelte) instead of swapping code under a page the user is on.
// iOS keeps a Home Screen app alive for days: it also checks when the app comes back to the front.
export const updates = $state<{ ready: boolean }>({ ready: false });

let registration: ServiceWorkerRegistration | null = null;

export function initUpdates(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' }).then((reg) => {
    registration = reg;
    // A worker already waiting from an earlier visit, then any new one.
    if (reg.waiting && navigator.serviceWorker.controller) updates.ready = true;
    reg.addEventListener('updatefound', () => {
      const next = reg.installing;
      next?.addEventListener('statechange', () => {
        if (next.state === 'installed' && navigator.serviceWorker.controller) updates.ready = true;
      });
    });
  });
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    location.reload();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void registration?.update().catch(() => {});
  });
}

// Settings > About: asks the server for a new version now. true: one is ready (the banner shows), false: none,
// null: no service worker (the browser, the dev server).
export async function checkForUpdate(): Promise<boolean | null> {
  if (!registration) return null;
  await registration.update();
  const next = registration.installing ?? registration.waiting;
  if (next && next.state !== 'installed' && next.state !== 'activated') {
    await new Promise<void>((resolve) => {
      const done = () => (next.state === 'installed' || next.state === 'redundant' ? resolve() : undefined);
      next.addEventListener('statechange', done);
      setTimeout(resolve, 15_000);
    });
  }
  if (registration.waiting && navigator.serviceWorker.controller) updates.ready = true;
  return updates.ready;
}

export function applyUpdate(): void {
  registration?.waiting?.postMessage('skip-waiting');
}
