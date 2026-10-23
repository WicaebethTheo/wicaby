// The phone platform, behind the exports the TV web logic expects of its own (apps/tv-web/src/platform/index.ts):
// a <video> player that remuxes Matroska itself (platform/remux-player.ts), the Screen Wake Lock, links in a new
// browsing context. Volume, the network type and quitting
// belong to the system on iOS: a web app reads or sets none of them.
import type { VideoPlayer } from '$tvplatform/player';
import { RemuxPlayer } from './remux-player.svelte';

export type PlatformName = 'ios' | 'web';

const nav = navigator as Navigator & { standalone?: boolean };

// iPadOS presents itself as a Mac: touch points tell them apart.
export const platform: PlatformName = /iPhone|iPad|iPod/.test(navigator.userAgent) || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1) ? 'ios' : 'web';

// Opened from the Home Screen (no Safari toolbar), on iOS as elsewhere.
export const standalone: boolean = nav.standalone === true || matchMedia('(display-mode: standalone)').matches;

export async function initPlatform(): Promise<void> {}

// A web app cannot close itself.
export function exitApp(): void {}

export function openUrl(url: string): Promise<boolean> {
  return Promise.resolve(window.open(url, '_blank', 'noopener,noreferrer') !== null);
}

// The screen stays on while [on] (a video, a slideshow). The lock drops when the app is hidden: it is taken again
// when the app comes back.
let awake = 0;
let lock: WakeLockSentinel | null = null;

async function syncLock(): Promise<void> {
  if (!('wakeLock' in navigator)) return;
  if (awake > 0 && !lock && document.visibilityState === 'visible') {
    try {
      lock = await navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => (lock = null));
    } catch {
      // Refused (Low Power Mode): the system's auto-lock applies.
    }
  } else if (awake === 0 && lock) {
    const l = lock;
    lock = null;
    await l.release().catch(() => {});
  }
}

document.addEventListener('visibilitychange', () => void syncLock());

export function keepAwake(on: boolean): void {
  awake = Math.max(0, awake + (on ? 1 : -1));
  void syncLock();
}

export const canSetVolume = (): boolean => false;

export function setVolume(_command: string, _level?: number): void {}

export function createPlayer(video: HTMLVideoElement): VideoPlayer {
  return new RemuxPlayer(video);
}

// Safari exposes no connection type: Settings' single cap applies everywhere.
export function onWifi(): boolean {
  return false;
}
