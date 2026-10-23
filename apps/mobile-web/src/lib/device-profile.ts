// The DeviceProfile sent with PlaybackInfo, for Safari on iPhone and iPad (same signature as the TV's,
// apps/tv-web/src/lib/device-profile.ts). The aim is the lightest work for the server, in this order:
// 1. Direct play of MP4/MOV files Safari opens itself.
// 2. Direct play of Matroska (MKV, WebM): the phone remuxes it (platform/remux-player.ts) for every codec its
//    ManagedMediaSource takes (caps.remux), text subtitles included (read from the file: Embed). The server only
//    reads the file.
// 3. A conversion the phone still remuxes: Matroska over HTTP with the video copied, only the audio converted
//    (DTS, TrueHD, Vorbis…).
// 4. Without ManagedMediaSource (iOS < 17.1): the server's HLS. HEVC and Dolby Vision play from fMP4 segments only,
//    never MPEG-TS: Jellyfin segments fMP4, Emby MPEG-TS, so Emby's HLS transcodes are H.264 there.
// AC3 and EAC3 (Dolby Digital, Dolby Digital Plus with Atmos) are kept: 5.1 stays 5.1. PGS subtitles in a Matroska
// file are decoded by the phone too (media/pgs.ts); other image subtitles (VobSub, DVB) are burnt in by the server.
import type { Caps } from '../platform/caps';
import type { ServerKind } from '$tv/api';
import { PASS_OFF, PASS_ON, settings } from '$tv/settings.svelte';

function ranges(c: Caps): string {
  const out = ['SDR'];
  if (c.hdr10) out.push('HDR10', 'HDR10Plus', 'DOVIWithHDR10', 'DOVIWithHDR10Plus');
  if (c.hlg) out.push('HLG', 'DOVIWithHLG');
  out.push('DOVIWithSDR');
  if (c.dolbyVision) out.push('DOVI');
  return out.join('|');
}

function dolby(c: Caps): string[] {
  const pass = (codec: 'ac3' | 'eac3', probed: boolean) => {
    const v = settings.passthrough[codec].value;
    return v === PASS_ON || (v !== PASS_OFF && probed);
  };
  return [...(pass('ac3', c.ac3) ? ['ac3'] : []), ...(pass('eac3', c.eac3) ? ['eac3'] : [])];
}

// AirPlay (and any other system casting) takes what Safari plays itself, never the phone's remux: while it is asked
// for, Matroska goes through the server's HLS (the video copied when the stream takes it, H.264 otherwise).
export const remote = { hls: false };

export function deviceProfile(c: Caps, server: ServerKind, maxBitrate: number, maxHeight = 0, burnText = false): Record<string, unknown> {
  const video = ['h264', ...(c.hevc ? ['hevc'] : []), ...(c.av1 ? ['av1'] : [])].join(',');
  const surround = dolby(c);
  const fileAudio = ['aac', 'mp3', 'alac', 'flac', ...surround].join(',');
  const hlsAudio = ['aac', ...surround].join(',');
  const fmp4 = server === 'jellyfin';
  const remux = c.remux ?? { video: [], audio: [] };
  const mkv = !remote.hls && c.mkv && remux.video.length > 0;
  // The audio the phone takes when it remuxes, Dolby passthrough choices applied.
  const remuxAudio = remux.audio.filter((a) => (a === 'ac3' || a === 'eac3' ? surround.includes(a) : true));
  const height = maxHeight ? Math.min(maxHeight, c.maxHeight) : c.maxHeight;
  const width = Math.round((height * 16) / 9);
  return {
    Name: 'Wicaby iOS web',
    MaxStreamingBitrate: maxBitrate,
    MaxStaticBitrate: maxBitrate,
    MusicStreamingTranscodingBitrate: 320_000,
    DirectPlayProfiles: [
      { Container: 'mp4,m4v,mov', Type: 'Video', VideoCodec: video, AudioCodec: fileAudio },
      ...(mkv ? [{ Container: 'mkv,webm', Type: 'Video', VideoCodec: remux.video.join(','), AudioCodec: remuxAudio.join(',') }] : []),
      { Container: 'mp3', Type: 'Audio' },
      { Container: 'aac,m4a,m4b', Type: 'Audio', AudioCodec: 'aac,alac' },
      { Container: 'flac', Type: 'Audio' },
      { Container: 'wav', Type: 'Audio' },
    ],
    TranscodingProfiles: [
      // Matroska over HTTP: the video copied when the phone decodes it, the audio converted to what it takes.
      ...(mkv
        ? [{
            Container: 'mkv',
            Type: 'Video',
            VideoCodec: remux.video.join(','),
            AudioCodec: ['aac', ...remuxAudio.filter((a) => a === 'ac3' || a === 'eac3')].join(','),
            Context: 'Streaming',
            Protocol: 'http',
            MaxAudioChannels: surround.length ? '6' : '2',
            CopyTimestamps: true,
          }]
        : []),
      {
        Container: fmp4 ? 'mp4' : 'ts',
        Type: 'Video',
        VideoCodec: fmp4 && c.hevc ? 'hevc,h264' : 'h264',
        AudioCodec: hlsAudio,
        Context: 'Streaming',
        Protocol: 'hls',
        MaxAudioChannels: surround.length ? '6' : '2',
        MinSegments: 2,
        BreakOnNonKeyFrames: true,
      },
      { Container: 'mp3', Type: 'Audio', AudioCodec: 'mp3', Context: 'Streaming', Protocol: 'http', MaxAudioChannels: '2' },
    ],
    ContainerProfiles: [],
    CodecProfiles: [
      {
        Type: 'Video',
        Conditions: [
          { Condition: 'LessThanEqual', Property: 'Width', Value: String(width), IsRequired: false },
          { Condition: 'LessThanEqual', Property: 'Height', Value: String(height), IsRequired: false },
        ],
      },
      // hev1-tagged HEVC (common in MKV remuxes) shows no picture in Safari: only hvc1 and Dolby Vision's dvh1.
      ...(c.hevc
        ? [{ Type: 'Video', Codec: 'hevc', Conditions: [
            { Condition: 'EqualsAny', Property: 'VideoCodecTag', Value: 'hvc1|dvh1', IsRequired: false },
            ...(c.hevc10 ? [] : [{ Condition: 'LessThanEqual', Property: 'VideoBitDepth', Value: '8', IsRequired: false }]),
          ] }]
        : []),
      ...(server === 'jellyfin'
        ? ['hevc', 'av1'].map((Codec) => ({ Type: 'Video', Codec, Conditions: [{ Condition: 'EqualsAny', Property: 'VideoRangeType', Value: ranges(c), IsRequired: false }] }))
        : []),
    ],
    ResponseProfiles: [],
    // Text and PGS subtitles inside a Matroska file are read by the phone (Embed); other text comes as WebVTT the
    // app draws (lib/subtitles.ts); other image subtitles are burnt in.
    SubtitleProfiles: [
      ...(burnText
        ? ['srt', 'subrip', 'ass', 'ssa', 'vtt', 'webvtt', 'mov_text'].map((Format) => ({ Format, Method: 'Encode' }))
        : [...(mkv ? ['srt', 'subrip', 'ass', 'ssa', 'webvtt'].map((Format) => ({ Format, Method: 'Embed' })) : []), { Format: 'vtt', Method: 'External' }]),
      ...(mkv ? ['pgs', 'pgssub'].map((Format) => ({ Format, Method: 'Embed' })) : []),
      ...[...(mkv ? [] : ['pgs', 'pgssub']), 'dvdsub', 'dvbsub', 'vobsub', 'sub', 'idx'].map((Format) => ({ Format, Method: 'Encode' })),
    ],
  };
}
