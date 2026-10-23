// How this phone presents itself to the server (dashboard "Devices", the session list, "Play on").
import { platform } from '../platform';
import { load, save } from '$tv/storage';

export const CLIENT = 'Wicaby';
export const VERSION: string = __APP_VERSION__;
declare const __APP_BUILD__: string;
export const BUILD: string = __APP_BUILD__;

// Stable per install, like the Android app's device id.
export const deviceId: string = (() => {
  let id = load<string>('deviceId', '');
  if (!id) {
    // getRandomValues, not randomUUID: a phone on the dev server's LAN address is not a secure context.
    const b = crypto.getRandomValues(new Uint8Array(16));
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    save('deviceId', id);
  }
  return id;
})();

export function deviceName(): string {
  if (platform !== 'ios') return 'Web';
  return /iPad/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)) ? 'iPad' : 'iPhone';
}
