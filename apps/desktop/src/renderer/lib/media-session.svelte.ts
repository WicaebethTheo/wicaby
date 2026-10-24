// The system media session (navigator.mediaSession: SMTC on Windows, MPRIS on Linux, media keys, the volume
// flyout), shared by the OSD window (mpv video) and MusicHost.svelte (music, in the main window).
import type { NowPlayingItem, PlaybackCommand } from '../../shared/contract';
import { w } from './bridge';
import { imageUrl } from './images';

// One second of 8 kHz mono 16-bit silence. Chromium only hands navigator.mediaSession to the system while a
// media element of the page plays, and mpv plays outside the page: this keeps one playing.
export function silentWavUrl(): string {
  const rate = 8000;
  const samples = rate;
  const buf = new ArrayBuffer(44 + samples * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples * 2, true);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

const cmd = (c: PlaybackCommand) => void w.playback.command(c).catch(() => undefined);

// Play, pause, stop, next, previous and seeking go to the playback service.
export function installMediaHandlers(seekBackS = 10, seekForwardS = 30): void {
  const ms = navigator.mediaSession;
  const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
    try {
      ms.setActionHandler(action, handler);
    } catch {
      // Action not supported by this Chromium build.
    }
  };
  set('play', () => cmd({ type: 'resume' }));
  set('pause', () => cmd({ type: 'pause' }));
  set('stop', () => cmd({ type: 'stop' }));
  set('nexttrack', () => cmd({ type: 'next' }));
  set('previoustrack', () => cmd({ type: 'previous' }));
  set('seekbackward', (d) => cmd({ type: 'seek-relative', deltaMs: -(d.seekOffset ?? seekBackS) * 1000 }));
  set('seekforward', (d) => cmd({ type: 'seek-relative', deltaMs: (d.seekOffset ?? seekForwardS) * 1000 }));
  set('seekto', (d) => {
    if (d.seekTime !== undefined) cmd({ type: 'seek', positionMs: d.seekTime * 1000 });
  });
}

// A track (music-spec §4.2): its title, its artists, its album and the album's art.
export function trackMetadata(item: NowPlayingItem): void {
  const art = item.imageItemId ? imageUrl(item.imageItemId, 'Primary', { tag: item.imageTag, maxHeight: 512, server: item.serverId }) : null;
  setSessionMetadata({ title: item.name, artist: (item.artists ?? []).join(', ') || (item.albumArtist ?? ''), album: item.album ?? '' }, art);
}

// Chromium only takes http(s), data: and blob: artwork: a wicaby-media:// src is dropped with a console warning, so
// MPRIS (Linux shell widgets) and SMTC got no cover. The art is read through fetch (CSP connect-src allows the
// scheme) into a data: URL. The metadata goes out at once without art, then again once it is read, unless another
// item took its place meanwhile. A few recent covers are kept: back and forth between tracks reads nothing again.
const artCache = new Map<string, Promise<string | null>>();
let metadataGeneration = 0;

function artDataUrl(src: string): Promise<string | null> {
  let p = artCache.get(src);
  if (!p) {
    p = fetch(src)
      .then((r) => (r.ok ? r.blob() : null))
      .then(
        (b) =>
          b &&
          new Promise<string | null>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(b);
          }),
      )
      .catch(() => null);
    artCache.set(src, p);
    if (artCache.size > 8) artCache.delete(artCache.keys().next().value!);
  }
  return p;
}

export function setSessionMetadata(init: Omit<MediaMetadataInit, 'artwork'>, artSrc: string | null): void {
  const generation = ++metadataGeneration;
  navigator.mediaSession.metadata = new MediaMetadata({ ...init, artwork: [] });
  if (!artSrc) return;
  void artDataUrl(artSrc).then((data) => {
    if (!data || generation !== metadataGeneration) return;
    navigator.mediaSession.metadata = new MediaMetadata({ ...init, artwork: [{ src: data, sizes: '512x512', type: data.slice(5, data.indexOf(';')) || 'image/jpeg' }] });
  });
}
