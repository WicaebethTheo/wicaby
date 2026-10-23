// What this iPhone (or iPad) decodes and shows, probed once at the first playback. Safari answers canPlayType for
// the device's own hardware decoders, so the profile (lib/device-profile.ts) follows the chip: HEVC on every
// supported iPhone, AV1 from the A17 Pro, Dolby Vision on the HDR screens.
import type { Caps as TvCaps } from '$tvplatform/caps';
import { remuxAvailable, remuxSupports } from './remux-player.svelte';

// What the phone remuxes from Matroska (platform/remux-player.ts): the server's codec names Safari's
// ManagedMediaSource takes in fragmented MP4.
export interface Caps extends TvCaps {
  remux: { video: string[]; audio: string[] };
}

const MSE_VIDEO: [string, string][] = [
  ['h264', 'video/mp4; codecs="avc1.640028"'],
  ['hevc', 'video/mp4; codecs="hvc1.2.4.L153.B0"'],
  ['av1', 'video/mp4; codecs="av01.0.08M.10"'],
];
const MSE_AUDIO: [string, string][] = [
  ['aac', 'audio/mp4; codecs="mp4a.40.2"'],
  ['mp3', 'audio/mp4; codecs="mp4a.6b"'],
  ['ac3', 'audio/mp4; codecs="ac-3"'],
  ['eac3', 'audio/mp4; codecs="ec-3"'],
  ['opus', 'audio/mp4; codecs="opus"'],
  ['flac', 'audio/mp4; codecs="flac"'],
];

const probe = document.createElement('video');

const can = (type: string): boolean => {
  try {
    return probe.canPlayType(type) !== '';
  } catch {
    return false;
  }
};

let cached: Promise<Caps> | null = null;

export function caps(): Promise<Caps> {
  return (cached ??= Promise.resolve(detect()));
}

function detect(): Caps {
  const hevc = can('video/mp4; codecs="hvc1.1.6.L120.90"');
  const hdr = matchMedia('(dynamic-range: high)').matches;
  return {
    h264: true,
    hevc,
    hevc10: can('video/mp4; codecs="hvc1.2.4.L153.B0"'),
    av1: can('video/mp4; codecs="av01.0.08M.10"'),
    vp9: false,
    ac3: can('audio/mp4; codecs="ac-3"'),
    eac3: can('audio/mp4; codecs="ec-3"'),
    dts: false,
    // Matroska plays through the phone's own remux when ManagedMediaSource is there (iOS 17.1+).
    mkv: remuxAvailable(),
    hls: can('application/vnd.apple.mpegurl'),
    // 4K for the decoder (AirPlay to a 4K TV, a sharp picture zoomed in), whatever the screen's own size.
    maxHeight: hevc ? 2160 : 1080,
    hdr10: hdr && can('video/mp4; codecs="hvc1.2.4.L153.B0"'),
    hlg: hdr,
    dolbyVision: hdr && (can('video/mp4; codecs="dvh1.08.06"') || can('video/mp4; codecs="dvh1.05.06"')),
    remux: {
      video: remuxAvailable() ? MSE_VIDEO.filter(([, m]) => remuxSupports(m)).map(([c]) => c) : [],
      audio: remuxAvailable() ? MSE_AUDIO.filter(([, m]) => remuxSupports(m)).map(([c]) => c) : [],
    },
  };
}
