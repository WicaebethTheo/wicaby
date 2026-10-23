<script lang="ts">
  // The video player, as the Android mobile app's (player/PlayerScreen.kt), full screen on black and driven by touch:
  // - a tap shows or hides the controls; a double tap on a side (the outer 40 %) skips 10 s, and single taps right
  //   after keep skipping; a double tap in the middle plays or pauses; a sideways swipe seeks (100 s across the
  //   screen) with the time and the trickplay frame in the middle; a pinch steps the picture Fit → Fill → Zoom;
  // - the controls: back, the series (or the year) and how it plays over the title, AirPlay and PiP at the top;
  //   −10 s, play/pause, +10 s in the middle; the bar (buffer, accent progress, knob), the times and "Ends at", then
  //   Netflix's row: audio and subtitles, speed, episodes (or chapters), next, and More (format, quality, sleep
  //   timer, playback info);
  // - sheets from the bottom for each of them.
  // Skip intro, the up-next card with its countdown, "Still watching?" and the sleep timer are the TV web app's rules
  // (shared Playback session, lib/sleep); the lock screen and Control Center drive it through Media Session. No
  // brightness or volume swipes: a web page can set neither on iOS.
  import type { BaseItem } from '$shared/models';
  import { ORIGINAL_BITRATE } from '$shared/quality-presets';
  import { clock, episodeLine } from '$tv/format';
  import { locale, t } from '$tv/i18n.svelte';
  import { stopMusic } from '$tv/music.svelte';
  import { Playback } from '$tv/playback.svelte';
  import { recall, remember } from '$tv/remembered';
  import { skippableAt, STILL_WATCHING_AFTER, upNextAt, type SegmentKind } from '$tv/segments';
  import { apiOf } from '$tv/session.svelte';
  import { SKIP_AUTO, SKIP_OFF, settings } from '$tv/settings.svelte';
  import { cancelSleep, checkSleep, endOfVideo, extendSleep, restartSleep, sleep, sleepAtEnd, SLEEP_MINUTES, startSleep } from '$tv/sleep.svelte';
  import { showToast } from '$tv/toast.svelte';
  import { trackName } from '$tv/track-memory';
  import * as Versions from '$tv/versions';
  import type { Aspect } from '$tvplatform/player';
  import Airplay from '@lucide/svelte/icons/airplay';
  import Captions from '@lucide/svelte/icons/captions';
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';
  import ChevronsLeft from '@lucide/svelte/icons/chevrons-left';
  import ChevronsRight from '@lucide/svelte/icons/chevrons-right';
  import Gauge from '@lucide/svelte/icons/gauge';
  import ListVideo from '@lucide/svelte/icons/list-video';
  import Pause from '@lucide/svelte/icons/pause';
  import PictureInPicture from '@lucide/svelte/icons/picture-in-picture-2';
  import Play from '@lucide/svelte/icons/play';
  import RotateCcw from '@lucide/svelte/icons/rotate-ccw';
  import RotateCw from '@lucide/svelte/icons/rotate-cw';
  import Scan from '@lucide/svelte/icons/scan';
  import SkipForward from '@lucide/svelte/icons/skip-forward';
  import X from '@lucide/svelte/icons/x';
  import { look } from '../lib/look.svelte';
  import { setPlayerStatus } from '../lib/status-colour';
  import { getContext, onMount } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import Spinner from '../components/Spinner.svelte';
  import OptionRow from '../components/player/OptionRow.svelte';
  import PlayerSheet from '../components/player/PlayerSheet.svelte';
  import Stats from '../components/player/Stats.svelte';
  import Subtitles from '../components/player/Subtitles.svelte';
  import { remote } from '../lib/device-profile';
  import { decoy, hideNowPlaying, video as sharedVideo } from '../lib/media-element';
  import { handleBack, nav, onBack, SCREEN } from '../lib/nav.svelte';
  import { createPlayer, keepAwake } from '../platform';
  import type { RemuxPlayer } from '../platform/remux-player.svelte';

  let {
    id,
    fromStart = false,
    trailer = false,
    queue,
    serverId,
    startMs,
    tracks,
  }: { id: string; fromStart?: boolean; trailer?: boolean; queue?: string[]; serverId?: string; startMs?: number; tracks?: { audio?: number; subtitle?: number } } = $props();

  // The jump of a double tap, the ±buttons and the lock screen's (Settings > Playback).
  const TAP_SEEK_MS = look.seekSeconds * 1000;
  const SWIPE_SPAN_MS = 100_000;
  const DOUBLE_TAP_MS = 300;

  // svelte-ignore state_referenced_locally
  const client = apiOf(serverId)!;
  const screen = getContext<number>(SCREEN);
  // The app's one video element, unlocked for sound at the first touch (lib/media-element.ts), placed here.
  const video = sharedVideo;
  let host: HTMLDivElement;
  let stage: HTMLDivElement;
  let pb = $state<Playback | null>(null);

  type Sheet = 'tracks' | 'speed' | 'quality' | 'chapters' | 'sleep' | 'episodes' | 'more';
  let sheet = $state<Sheet | null>(null);
  // Playback info stays on for the next videos (Android PlaybackStats.visible).
  let stats = $state(false);

  // The wall clock, for "Ends at" and the sleep timer.
  let now = $state(Date.now());

  // ---- Controls: shown on a tap, hidden a few seconds after the last one while playing (Settings > Playback) ----
  let controls = $state(true);
  let nonce = $state(0);
  function poke(): void {
    controls = true;
    nonce++;
    skipNonce++;
    if (pb) pb.autoCount = 0;
  }
  // Where a swipe or the bar would land, shown big in the middle; a bar drag keeps the controls up.
  let preview = $state<number | null>(null);
  let scrubbing = $state(false);
  $effect(() => {
    void nonce;
    if (!controls || !pb?.playing || sheet || preview !== null) return;
    const timer = setTimeout(() => (controls = false), look.controlsSeconds * 1000);
    return () => clearTimeout(timer);
  });

  function seekTo(ms: number): void {
    if (!pb) return;
    pb.autoCount = 0;
    pb.seek(Math.max(0, Math.min(ms, pb.durationMs || ms)));
  }
  function togglePlay(): void {
    if (!pb) return;
    pb.togglePlay(!pb.playing);
    poke();
  }

  // ---- Gestures on the picture ----
  // x: the finger, from the lobe's left edge (the ring grows from there).
  let tapSeek = $state<{ side: -1 | 1; secs: number; x: number; y: number; nonce: number } | null>(null);
  $effect(() => {
    void tapSeek?.nonce;
    if (!tapSeek) return;
    const timer = setTimeout(() => (tapSeek = null), 800);
    return () => clearTimeout(timer);
  });
  function sideOf(x: number): -1 | 0 | 1 {
    const w = host.clientWidth;
    return x < w * 0.4 ? -1 : x > w * 0.6 ? 1 : 0;
  }
  function tapSeekAt(side: -1 | 1, x: number, y: number): void {
    seekTo((pb?.positionMs ?? 0) + side * TAP_SEEK_MS);
    const s = tapSeek;
    tapSeek = { side, secs: s?.side === side ? s.secs + 10 : 10, x: side < 0 ? x : x - host.clientWidth * 0.6, y, nonce: (s?.nonce ?? 0) + 1 };
  }
  let lastTap = { at: 0, x: 0 };
  let singleTimer = 0;
  function onTap(x: number, y: number): void {
    const side = sideOf(x);
    const at = performance.now();
    // Right after a double tap, single taps on the same side keep seeking (YouTube).
    if (tapSeek && side === tapSeek.side) {
      clearTimeout(singleTimer);
      tapSeekAt(side, x, y);
    } else if (at - lastTap.at < DOUBLE_TAP_MS && Math.abs(x - lastTap.x) < 80) {
      clearTimeout(singleTimer);
      if (side === 0) togglePlay();
      else tapSeekAt(side, x, y);
      lastTap = { at: 0, x };
      return;
    } else {
      clearTimeout(singleTimer);
      singleTimer = window.setTimeout(() => (controls && pb?.playing ? (controls = false) : poke()), DOUBLE_TAP_MS);
    }
    lastTap = { at, x };
  }

  // One finger: a tap, or a sideways swipe that seeks (a vertical one does nothing). Two: a pinch.
  type Drag = { mode: 'none' | 'ignore' | 'seek' | 'pinch'; x: number; y: number; startPos: number; dist: number; zoom: number };
  const pointers = new Map<number, { x: number; y: number }>();
  let drag: Drag | null = null;
  const spread = () => {
    const [a, b] = [...pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y) || 1;
  };
  function onDown(e: PointerEvent): void {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1) drag = { mode: 'none', x: e.clientX, y: e.clientY, startPos: pb?.positionMs ?? 0, dist: 1, zoom: 1 };
    else if (pointers.size === 2 && drag && (drag.mode === 'none' || drag.mode === 'ignore')) {
      drag.mode = 'pinch';
      drag.dist = spread();
      preview = null;
    }
  }
  function onMove(e: PointerEvent): void {
    if (!drag || !pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (drag.mode === 'pinch') {
      if (pointers.size === 2) drag.zoom = spread() / drag.dist;
      return;
    }
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (drag.mode === 'none' && Math.hypot(dx, dy) > 10) {
      drag.mode = Math.abs(dx) > Math.abs(dy) && pb?.durationMs ? 'seek' : 'ignore';
      drag.startPos = pb?.positionMs ?? 0;
    }
    if (drag.mode === 'seek' && pb) preview = Math.max(0, Math.min(pb.durationMs, drag.startPos + (dx / host.clientWidth) * SWIPE_SPAN_MS));
  }
  function onUp(e: PointerEvent): void {
    if (!pointers.delete(e.pointerId) || !drag) return;
    const d = drag;
    if (d.mode === 'pinch') {
      if (pointers.size) return;
      if (d.zoom > 1.08 || d.zoom < 0.92) setAspect(pinchStep(d.zoom > 1));
    } else if (d.mode === 'seek') {
      if (preview !== null) seekTo(preview);
      preview = null;
    } else if (d.mode === 'none' && e.type === 'pointerup') onTap(e.clientX, e.clientY);
    if (!pointers.size) drag = null;
  }

  // ---- Picture format: the button cycles all four, a pinch steps Fit → Fill → Zoom; both flash the name ----
  let aspect = $state<Aspect>('fit');
  const ASPECT_LABEL: Record<Aspect, string> = { fit: 'aspect_fit', fill: 'aspect_fill', stretch: 'aspect_stretch', zoom: 'aspect_zoom' };
  const PINCH: Aspect[] = ['fit', 'fill', 'zoom'];
  function pinchStep(out: boolean): Aspect {
    const i = PINCH.indexOf(aspect);
    if (i < 0) return out ? 'zoom' : 'fit';
    return PINCH[Math.max(0, Math.min(PINCH.length - 1, i + (out ? 1 : -1)))];
  }
  let hud = $state<{ text: string; nonce: number } | null>(null);
  $effect(() => {
    void hud?.nonce;
    if (!hud) return;
    const timer = setTimeout(() => (hud = null), 700);
    return () => clearTimeout(timer);
  });
  function setAspect(a: Aspect): void {
    if (!pb) return;
    aspect = a;
    pb.player.setAspect(a);
    remember('aspect', pb.scopeCtx, a);
    hud = { text: t(ASPECT_LABEL[a]), nonce: (hud?.nonce ?? 0) + 1 };
  }
  function cycleAspect(): void {
    if (!pb) return;
    const list = pb.player.aspects;
    setAspect(list[(list.indexOf(aspect) + 1) % list.length]);
    poke();
  }
  // X-05: the title's remembered format, once its scope is known.
  $effect(() => {
    const p = pb;
    if (!p?.scopeCtx) return;
    const a = recall('aspect', p.scopeCtx);
    if (typeof a === 'string' && p.player.aspects.includes(a as Aspect)) {
      aspect = a as Aspect;
      p.player.setAspect(aspect);
    }
  });

  // ---- The bar: a tap or a drag; the time lands in the middle while dragging, the seek on release ----
  let bar = $state<HTMLElement>()!;
  function barAt(e: PointerEvent): number {
    const r = bar.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (pb?.durationMs ?? 0);
  }
  function onBarDown(e: PointerEvent): void {
    if (!pb?.durationMs) return;
    e.stopPropagation();
    bar.setPointerCapture(e.pointerId);
    scrubbing = true;
    preview = barAt(e);
  }
  function onBarMove(e: PointerEvent): void {
    if (scrubbing) preview = barAt(e);
  }
  function onBarUp(): void {
    if (!scrubbing) return;
    if (preview !== null) seekTo(preview);
    preview = null;
    scrubbing = false;
    poke();
  }
  const position = $derived(pb?.positionMs ?? 0);
  const duration = $derived(pb?.durationMs ?? 0);
  const shown = $derived(preview ?? position);
  const buffered = $derived(pb ? (void pb.positionMs, position + (pb.player.stats().bufferMs ?? 0)) : 0);
  const thumb = $derived(preview !== null && pb?.preview ? pb.preview.at(preview) : null);
  const timeFormat = $derived(new Intl.DateTimeFormat(locale.current, { hour: '2-digit', minute: '2-digit' }));
  // "Ends at": stable while playing, follows the clock while paused, at the playback speed.
  const endsAt = $derived(duration > 0 ? t('ends_at', timeFormat.format(now + Math.max(0, duration - position) / Math.max(0.1, pb?.rate ?? 1))) : '');

  // ---- How it plays: by the title, so a remux on the iPhone (no server work) shows ----
  const remuxed = $derived(!!pb && (pb.player as RemuxPlayer).remuxed);
  const mode = $derived.by(() => {
    if (!pb?.item) return '';
    if (pb.playMethod === 'Transcode') return t('web_mode_transcode');
    if (pb.playMethod === 'DirectStream') return t('web_mode_audio');
    return remuxed ? t('web_mode_remux') : t('web_mode_direct');
  });

  // ---- Skippable segments: a chip for 8 s (Ask), back when the controls wake; a jump once (Auto) ----
  const SKIP_SETTING: Record<SegmentKind, keyof typeof settings> = { Intro: 'skipIntro', Recap: 'skipRecap', Preview: 'skipPreview', Commercial: 'skipCommercial' };
  const SKIP_LABEL: Record<SegmentKind, string> = { Intro: 'skip_intro', Recap: 'skip_recap', Preview: 'skip_preview', Commercial: 'skip_commercial' };
  const skippable = $derived.by(() => {
    if (!pb || pb.trailer) return undefined;
    const r = skippableAt(pb.segments, pb.positionMs);
    const m = r ? (settings[SKIP_SETTING[r.kind]] as { value: number }).value : SKIP_OFF;
    return r && m !== SKIP_OFF ? { ...r, mode: m } : undefined;
  });
  let skipVisible = $state(false);
  let skipNonce = $state(0);
  // The chip keeps its label while it fades out.
  let chipKind = $state<SegmentKind>('Intro');
  const autoSkipped = new Set<number>();
  $effect(() => {
    void skipNonce;
    const s = skippable;
    if (!s) return void (skipVisible = false);
    if (s.mode === SKIP_AUTO) {
      if (!autoSkipped.has(s.startMs)) {
        autoSkipped.add(s.startMs);
        pb?.seek(s.endMs);
      }
      return;
    }
    chipKind = s.kind;
    skipVisible = true;
    const timer = setTimeout(() => (skipVisible = false), 8000);
    return () => clearTimeout(timer);
  });

  // ---- Up next, its countdown, "Still watching?" ----
  let dismissedUpNext = $state(false);
  let stillWatching = $state(false);
  let countdown = $state(0);
  const upNext = $derived.by<BaseItem | null>(() => {
    if (!pb || !pb.next || dismissedUpNext || stillWatching || pb.trailer) return null;
    const at = upNextAt(pb.durationMs, pb.segments.credits);
    return at !== undefined && pb.positionMs >= at && pb.positionMs > 0 ? pb.next : null;
  });
  function advance(auto: boolean): void {
    dismissedUpNext = false;
    autoSkipped.clear();
    pb?.advance(auto);
  }
  function autoAdvance(): void {
    if (!pb) return;
    if (pb.autoCount >= STILL_WATCHING_AFTER) {
      pb.togglePlay(false);
      stillWatching = true;
    } else advance(true);
  }
  $effect(() => {
    // "End of this video" takes priority over autoplay.
    if (!upNext || !settings.autoplayNext.value || endOfVideo()) return;
    const from = pb?.item?.Id;
    let left = settings.countdown.value;
    countdown = left;
    const timer = setInterval(() => {
      // The countdown waits while the credits are paused.
      if (pb?.playing) left--;
      countdown = left;
      if (left <= 0) {
        clearInterval(timer);
        if (pb?.item?.Id === from) autoAdvance();
      }
    }, 1000);
    return () => clearInterval(timer);
  });
  $effect(() => {
    if (!pb?.ended || stillWatching || sleep.state?.promptUntil) return;
    // The sleep timer's "end of this video": stay at the end and ask.
    if (sleepAtEnd()) return;
    if (pb.next && !dismissedUpNext && settings.autoplayNext.value) autoAdvance();
    else exit();
  });
  function keepWatching(): void {
    stillWatching = false;
    if (!pb) return;
    pb.autoCount = 0;
    if (pb.next) advance(false);
    else pb.togglePlay(true);
  }

  // ---- X-04 sleep timer: checked once a second (the prompt, then the pause) ----
  $effect(() => {
    void now;
    if (!pb || pb.trailer) return;
    if (checkSleep(now) === 'expire') pb.togglePlay(false);
  });
  const sleepLeft = $derived(sleep.state?.endsAt ? Math.max(0, sleep.state.endsAt - now) : null);
  const sleepPrompt = $derived(sleep.state?.promptUntil ? Math.max(0, Math.ceil((sleep.state.promptUntil - now) / 1000)) : null);
  // Continue (or Back): the same timer again; at the end of the video it goes on.
  function sleepContinue(): void {
    const atEnd = !!pb?.ended;
    restartSleep();
    if (atEnd) {
      if (pb?.next) advance(false);
      else exit();
    } else if (pb && !pb.playing) pb.togglePlay(true);
  }
  function sleepStop(): void {
    cancelSleep();
    pb?.togglePlay(false);
  }
  function pickSleep(minutes: number | null | 'extend' | 'cancel'): void {
    if (minutes === 'extend') extendSleep();
    else if (minutes === 'cancel') cancelSleep();
    else startSleep(minutes);
    sheet = null;
  }

  // ---- X-02 quality and version: the gear shows "Originale" or "720p", the sheet the presets with their size ----
  const mbps = (b: number) => (b / 1_000_000).toLocaleString(locale.current, { maximumFractionDigits: 2 });
  const presetLabel = (b: number, height?: number) => t('quality_preset', height ?? 0, mbps(b));
  const capped = $derived(pb && pb.qualityCap !== null && pb.qualityCap < ORIGINAL_BITRATE ? pb.qualityCap : null);
  const qualityShort = $derived.by(() => {
    const row = capped ? pb?.qualityRows().find((r) => r.maxBitrate === capped) : undefined;
    return row?.height ? `${row.height}p` : t('quality_original');
  });
  // "1,4 Go" / "1.4 GB" (Android formatShortFileSize).
  function size(bytes?: number): string | undefined {
    if (!bytes) return undefined;
    const units = locale.current.startsWith('fr') ? ['o', 'ko', 'Mo', 'Go', 'To'] : ['B', 'kB', 'MB', 'GB', 'TB'];
    let v = bytes;
    let u = 0;
    while (v >= 1000 && u < units.length - 1) {
      v /= 1000;
      u++;
    }
    return `${v.toLocaleString(locale.current, { maximumFractionDigits: v < 10 ? 1 : 0 })} ${units[u]}`;
  }
  type Column = { title: string; rows: { text: string; selected: boolean; busy?: boolean; run: () => void }[]; weight?: number };
  let busy = $state<{ col: 'v' | 'q'; i: number } | null>(null);
  const qualityColumns = $derived.by<Column[]>(() => {
    if (!pb) return [];
    const p = pb;
    const tag = p.playMethod === 'Transcode' ? t('play_method_transcode') : t('play_method_direct');
    const versions = p.versions;
    const labels = p.item ? Versions.labels(p.item) : [];
    const vSel = versions.findIndex((v) => v.Id === p.currentSourceId);
    const rows = p.qualityRows();
    const rSel = rows.findIndex((r) => r.maxBitrate === capped);
    const cols: Column[] = [];
    if (versions.length > 1)
      cols.push({
        title: t('quality_version'),
        rows: versions.map((v, i) => ({
          text: [labels[i] ?? v.Id, i === vSel && !p.switching ? tag : undefined, size(v.Size)].filter(Boolean).join(' · '),
          selected: i === vSel,
          busy: busy?.col === 'v' && busy.i === i,
          run: () => void (i !== vSel && switchQuality('v', i, v.Id, capped)),
        })),
      });
    cols.push({
      title: t('quality'),
      weight: 1.3,
      rows: rows.map((r, i) => {
        const name = r.maxBitrate === null ? [t('quality_original'), r.height ? `${r.height}p` : undefined].filter(Boolean).join(' · ') : presetLabel(r.maxBitrate, r.height);
        const sz = size(r.size);
        return {
          text: [name, i === rSel && !p.switching ? tag : undefined, sz && r.percent !== undefined ? t('quality_size', sz, r.percent) : sz].filter(Boolean).join(' · '),
          selected: i === rSel,
          busy: busy?.col === 'q' && busy.i === i,
          run: () => void (i !== rSel && switchQuality('q', i, null, r.maxBitrate)),
        };
      }),
    });
    return cols;
  });
  // The sheet closes once the switch took and stays open on a failure (its toast says so).
  async function switchQuality(col: 'v' | 'q', i: number, sourceId: string | null, maxBitrate: number | null): Promise<void> {
    if (!pb || pb.switching) return;
    busy = { col, i };
    const ok = await pb.switchQuality(sourceId, maxBitrate);
    busy = null;
    if (!ok) return showToast(t('quality_failed'));
    const item = pb.item;
    const label =
      sourceId && item
        ? (Versions.labels(item)[pb.versions.findIndex((v) => v.Id === sourceId)] ?? sourceId)
        : maxBitrate
          ? presetLabel(maxBitrate, pb.qualityRows().find((r) => r.maxBitrate === maxBitrate)?.height)
          : t('quality_original');
    showToast(t('quality_switched', label));
    sheet = null;
  }

  // ---- The other sheets ----
  const trackColumns = $derived.by<Column[]>(() => {
    if (!pb) return [];
    const p = pb;
    const audio = p.audio();
    const audioSel = p.audioIndex ?? audio.find((s) => s.IsDefault)?.Index;
    return [
      { title: t('audio'), rows: audio.map((s) => ({ text: trackName(s), selected: s.Index === audioSel, run: () => p.selectAudio(s.Index) })) },
      {
        title: t('subtitles'),
        rows: [{ Index: -1, text: t('subtitles_off') }, ...p.subtitles().map((s) => ({ Index: s.Index, text: trackName(s) }))].map((s) => ({
          text: s.text,
          selected: s.Index === p.subtitleIndex,
          run: () => p.selectSubtitle(s.Index),
        })),
      },
    ];
  });
  const speedText = (r: number) => (r === 1 ? t('speed_normal') : t('speed_value', r.toLocaleString(locale.current, { maximumFractionDigits: 2 })));
  const speedColumns = $derived.by<Column[]>(() => {
    if (!pb) return [];
    const p = pb;
    return [{ title: t('speed'), rows: p.player.speeds.map((r) => ({ text: speedText(r), selected: Math.abs(p.rate - r) < 0.01, run: () => (p.setSpeed(r), (sheet = null)) })) }];
  });
  const sleepColumns = $derived.by<Column[]>(() => {
    const st = sleep.state;
    return [
      {
        title: t('sleep_timer'),
        rows: [
          ...(st?.endsAt ? [{ text: t('sleep_extend'), selected: false, run: () => pickSleep('extend') }] : []),
          ...(st ? [{ text: t('sleep_cancel'), selected: false, run: () => pickSleep('cancel') }] : []),
          { text: t('sleep_end_of_video'), selected: !!st && st.minutes === null, run: () => pickSleep(null) },
          ...SLEEP_MINUTES.map((m) => ({ text: t('sleep_minutes', m), selected: st?.minutes === m, run: () => pickSleep(m) })),
        ],
      },
    ];
  });
  // The real chapters (Emby's intro and credits markers left out).
  const chapters = $derived(
    (pb?.item?.Chapters ?? [])
      .map((c) => ({ name: c.Name, ms: c.StartPositionTicks / 10_000, marker: c.MarkerType }))
      .filter((c) => !c.marker || c.marker === 'Chapter')
      .sort((a, b) => a.ms - b.ms),
  );
  const chapterColumns = $derived.by<Column[]>(() => {
    const current = chapters.findLastIndex((c) => c.ms <= position);
    return [{ title: t('chapters'), rows: chapters.map((c, i) => ({ text: `${clock(c.ms)} · ${c.name || i + 1}`, selected: i === current, run: () => (seekTo(c.ms), (sheet = null)) })) }];
  });
  // An episode's season (Netflix "Episodes"): read when the sheet opens; a tap plays that one from its resume point.
  let seasonEpisodes = $state<BaseItem[] | null>(null);
  $effect(() => {
    const it = pb?.item;
    if (sheet !== 'episodes' || !it?.SeriesId) return;
    seasonEpisodes = null;
    void client.episodes(it.SeriesId, it.SeasonId).then((list) => (seasonEpisodes = list), () => (seasonEpisodes = []));
  });
  function playEpisode(ep: BaseItem): void {
    sheet = null;
    if (ep.Id === pb?.item?.Id) return;
    handleBack();
    nav.push({ name: 'player', id: ep.Id, serverId: ep.ServerId ?? serverId });
  }
  const episodeColumns = $derived.by<Column[]>(() => {
    const it = pb?.item;
    const season = it?.ParentIndexNumber !== undefined ? t('season_n', it.ParentIndexNumber) : t('episodes');
    const rows = (seasonEpisodes ?? []).map((ep) => ({ text: `${ep.IndexNumber ?? ''}. ${ep.Name}`, selected: ep.Id === it?.Id, run: () => playEpisode(ep) }));
    return [{ title: season, rows }];
  });

  // "More": what the bottom row leaves out.
  const moreColumns = $derived.by<Column[]>(() => {
    if (!pb) return [];
    const rows: Column['rows'] = [{ text: t('aspect_value', t(ASPECT_LABEL[aspect])), selected: false, run: cycleAspect }];
    if (!pb.trailer) {
      rows.push({ text: `${t('quality')} · ${qualityShort}`, selected: false, run: () => (sheet = 'quality') });
      rows.push({ text: [t('sleep_timer'), sleepLeft !== null ? clock(sleepLeft) : sleep.state ? t('sleep_end_of_video') : ''].filter(Boolean).join(' · '), selected: false, run: () => (sheet = 'sleep') });
    }
    if (pb.item?.Type === 'Episode' && chapters.length > 1) rows.push({ text: t('chapters'), selected: false, run: () => (sheet = 'chapters') });
    rows.push({ text: t('stats_title'), selected: stats, run: () => ((stats = !stats), (sheet = null)) });
    if (airplayOk) rows.push({ text: t('web_airplay'), selected: false, run: () => ((sheet = null), void airplay()) });
    return [{ title: t('more'), rows }];
  });
  const SHEETS = $derived<Record<Sheet, Column[]>>({
    tracks: trackColumns,
    speed: speedColumns,
    quality: qualityColumns,
    chapters: chapterColumns,
    sleep: sleepColumns,
    episodes: episodeColumns,
    more: moreColumns,
  });
  const columns = $derived(sheet ? SHEETS[sheet] : []);

  // ---- Picture in picture, AirPlay ----
  // iOS reports PiP as enabled in a Home Screen app where it refuses it (WebKit bug 303885): WebKit's own check,
  // once the video has data, says whether this video may go; the button shows only then, and comes back by itself
  // once iOS allows it.
  type PresentableVideo = HTMLVideoElement & { webkitSupportsPresentationMode?(m: string): boolean; webkitSetPresentationMode?(m: string): void; webkitPresentationMode?: string };
  const pipOk = $derived.by(() => {
    void pb?.playing;
    const v = video as PresentableVideo;
    if (typeof v.webkitSupportsPresentationMode === 'function') return v.readyState >= 2 && v.webkitSupportsPresentationMode('picture-in-picture');
    return typeof document !== 'undefined' && 'pictureInPictureEnabled' in document && document.pictureInPictureEnabled;
  });
  let airplayOk = $state(false);
  function pip(): void {
    const v = video as PresentableVideo;
    if (v.webkitSetPresentationMode) return v.webkitSetPresentationMode(v.webkitPresentationMode === 'picture-in-picture' ? 'inline' : 'picture-in-picture');
    if (document.pictureInPictureElement) void document.exitPictureInPicture();
    else void video.requestPictureInPicture().catch(() => showToast(t('web_pip_unavailable')));
  }
  // A title the phone remuxes cannot leave for a TV (the stream is made on the phone): the first tap reloads it, at
  // the same position, as the server's HLS, which AirPlay takes; the next one opens the picker (it must come from a
  // tap, which a reload after a network round trip no longer is).
  let preparing = $state(false);
  async function airplay(): Promise<void> {
    if (remuxed && pb) {
      if (preparing) return;
      preparing = true;
      remote.hls = true;
      showToast(t('web_airplay_preparing'));
      const ok = await pb.switchQuality(null, pb.qualityCap);
      preparing = false;
      if (!ok) remote.hls = false;
      showToast(t(ok ? 'web_airplay_ready' : 'web_action_failed'));
      return;
    }
    (video as HTMLVideoElement & { webkitShowPlaybackTargetPicker?(): void }).webkitShowPlaybackTargetPicker?.();
  }

  function exit(): void {
    handleBack();
  }

  // ---- The lock screen and Control Center ----
  // Only while the app is away: metadata or an action handler would bring the video back to the Dynamic Island
  // (lib/media-element hideNowPlaying).
  let away = $state(document.visibilityState === 'hidden');
  $effect(() => {
    const it = pb?.item;
    if (!it || !away || !('mediaSession' in navigator)) return;
    const art = client.thumb(it, 600) ?? client.poster(it, 600);
    navigator.mediaSession.metadata = new MediaMetadata({
      title: it.Type === 'Episode' ? (episodeLine(it) ?? it.Name) : it.Name,
      artist: it.Type === 'Episode' ? (it.SeriesName ?? '') : (it.ProductionYear?.toString() ?? ''),
      artwork: art ? [{ src: art, sizes: '600x338', type: 'image/jpeg' }] : [],
    });
  });
  $effect(() => {
    if (!away || !('mediaSession' in navigator) || !pb || !duration) return;
    try {
      navigator.mediaSession.setPositionState({ duration: duration / 1000, position: Math.min(duration, pb.positionMs) / 1000, playbackRate: pb.rate });
    } catch {
      // A position past the duration while it is not known yet.
    }
  });

  onMount(() => {
    // The status bar goes black over the video (lib/status-colour).
    setPlayerStatus(true);
    // A video ends the music, as on Android (one audio output, one session).
    stopMusic();
    keepAwake(true);
    stage.prepend(video);
    host.prepend(decoy);
    hideNowPlaying(true);
    const player = createPlayer(video);
    // The shared element keeps the last video's format.
    player.setAspect('fit');
    const p = new Playback(client, player, id, { fromStart, trailer, startMs, tracks, queue: queue ? { ids: queue, index: Math.max(0, queue.indexOf(id)), fromStart: true } : undefined });
    pb = p;
    p.start();
    const clockTimer = setInterval(() => (now = Date.now()), 1000);
    const w = window as unknown as { WebKitPlaybackTargetAvailabilityEvent?: unknown };
    const onTargets = (e: Event) => (airplayOk = (e as Event & { availability?: string }).availability === 'available');
    // A remuxed video turns remote playback off (ManagedMediaSource asks it), so the receivers are watched on an
    // element of its own too.
    const probe = document.createElement('video');
    if (w.WebKitPlaybackTargetAvailabilityEvent) {
      video.addEventListener('webkitplaybacktargetavailabilitychanged', onTargets);
      probe.addEventListener('webkitplaybacktargetavailabilitychanged', onTargets);
    }
    const ms = 'mediaSession' in navigator ? navigator.mediaSession : null;
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ['play', () => p.togglePlay(true)],
      ['pause', () => p.togglePlay(false)],
      ['seekbackward', () => seekTo(p.positionMs - TAP_SEEK_MS)],
      ['seekforward', () => seekTo(p.positionMs + TAP_SEEK_MS)],
      ['seekto', (d) => d.seekTime !== undefined && p.seek(d.seekTime * 1000)],
      ['nexttrack', () => void (p.next && advance(false))],
    ];
    const onVisibility = () => {
      away = document.visibilityState === 'hidden';
      for (const [a, h] of handlers) ms?.setActionHandler(a, away ? h : null);
      if (ms && !away) ms.metadata = null;
    };
    document.addEventListener('visibilitychange', onVisibility);
    // Back closes a sheet, counts as Continue on the sleep prompt, dismisses up next, then leaves.
    const stopBack = onBack(screen, () => {
      if (sheet) return (sheet = null), true;
      if (sleepPrompt !== null) return sleepContinue(), true;
      if (upNext) return (dismissedUpNext = true), true;
      return false;
    });
    return () => {
      stopBack();
      document.removeEventListener('visibilitychange', onVisibility);
      for (const [a] of handlers) ms?.setActionHandler(a, null);
      if (ms) ms.metadata = null;
      video.removeEventListener('webkitplaybacktargetavailabilitychanged', onTargets);
      probe.removeEventListener('webkitplaybacktargetavailabilitychanged', onTargets);
      remote.hls = false;
      clearInterval(clockTimer);
      setPlayerStatus(false);
      clearTimeout(singleTimer);
      // The timer belongs to this session.
      cancelSleep();
      p.stop();
      video.remove();
      hideNowPlaying(false);
      decoy.remove();
      keepAwake(false);
    };
  });

  const eyebrow = $derived(pb?.item ? (pb.item.Type === 'Episode' ? pb.item.SeriesName : pb.item.ProductionYear?.toString()) : undefined);
  const title = $derived(pb?.item ? (pb.item.Type === 'Episode' ? (episodeLine(pb.item) ?? pb.item.Name) : pb.item.Name) : '');
  const osd = $derived(!!pb?.item && ((controls && (preview === null || scrubbing) && !pb.error) || sheet !== null));
  const cornerUp = $derived(controls && !!pb?.item && !pb.error);
</script>

<div class="player" bind:this={host}>
  <div class="stage" bind:this={stage}></div>
  <!-- svelte-ignore a11y_no_static_element_interactions (gestures on the picture; every action also has a button) -->
  <div class="surface" onpointerdown={onDown} onpointermove={onMove} onpointerup={onUp} onpointercancel={onUp}></div>

  {#if pb}
    <Subtitles cues={pb.activeCues} raised={controls} />

    {#if tapSeek}
      {#key tapSeek.nonce}
        <div class="lobe" class:right={tapSeek.side > 0} out:fade={{ duration: 200 }}>
          <span class="ring" style:left="{tapSeek.x}px" style:top="{tapSeek.y}px"></span>
          {#if tapSeek.side < 0}<ChevronsLeft size={28} aria-hidden="true" />{:else}<ChevronsRight size={28} aria-hidden="true" />{/if}
          <span class="callout">{t(tapSeek.side < 0 ? 'seek_back_seconds' : 'seek_forward_seconds', tapSeek.secs)}</span>
        </div>
      {/key}
    {/if}

    {#if pb.error}
      <div class="center">
        <p class="title-2">{pb.error}</p>
        <div class="actions">
          <button class="pill pressable" onclick={exit}>{t('back')}</button>
          {#if pb.item}<button class="pill pressable" onclick={() => pb?.retry()}>{t('retry')}</button>{/if}
        </div>
      </div>
    {:else if (pb.buffering || !pb.item) && preview === null && !osd}
      <div class="center quiet"><Spinner size={44} /></div>
    {/if}

    {#if stats && preview === null}<Stats {pb} />{/if}

    {#if osd}
      <div class="osd" transition:fade={{ duration: 200 }}>
        <div class="scrim-top"></div>
        <div class="scrim-bottom"></div>
        <div class="top">
          <button class="icon" aria-label={t('back')} onclick={exit}><ChevronLeft size={24} aria-hidden="true" /></button>
          <div class="heading">
            <p class="footnote dim ellipsis">{[eyebrow, mode].filter(Boolean).join(' · ')}</p>
            <p class="headline ellipsis">{title}</p>
          </div>
          {#if airplayOk}<button class="icon" class:busy={preparing} aria-label={t('web_airplay')} onclick={() => void airplay()}><Airplay size={22} aria-hidden="true" /></button>{/if}
          {#if pipOk}<button class="icon" aria-label={t('pip')} onclick={pip}><PictureInPicture size={22} aria-hidden="true" /></button>{/if}
        </div>

        <div class="middle">
          <button class="icon step" aria-label={t('rewind_10')} onclick={() => (seekTo(position - TAP_SEEK_MS), poke())}>
            <RotateCcw size={30} aria-hidden="true" /><span class="badge mono">{look.seekSeconds}</span>
          </button>
          <button class="icon main" aria-label={pb.playing ? t('pause') : t('play')} onclick={togglePlay}>
            {#if pb.buffering}<Spinner size={34} />{:else if pb.playing}<Pause size={34} fill="currentColor" strokeWidth={0} aria-hidden="true" />{:else}<Play size={34} fill="currentColor" strokeWidth={0} aria-hidden="true" />{/if}
          </button>
          <button class="icon step" aria-label={t('forward_10')} onclick={() => (seekTo(position + TAP_SEEK_MS), poke())}>
            <RotateCw size={30} aria-hidden="true" /><span class="badge mono">{look.seekSeconds}</span>
          </button>
        </div>

        <div class="bottom">
          <div
            class="bar"
            class:active={scrubbing}
            bind:this={bar}
            role="slider"
            tabindex="0"
            aria-label={title}
            aria-valuemin={0}
            aria-valuemax={Math.round(duration / 1000)}
            aria-valuenow={Math.round(shown / 1000)}
            onpointerdown={onBarDown}
            onpointermove={onBarMove}
            onpointerup={onBarUp}
            onpointercancel={onBarUp}
          >
            <span class="track">
              <span class="buffered" style:transform="scaleX({duration ? Math.min(1, buffered / duration) : 0})"></span>
              <span class="done" style:transform="scaleX({duration ? shown / duration : 0})"></span>
            </span>
            <span class="knob" style:left="{duration ? (shown / duration) * 100 : 0}%"></span>
          </div>
          <div class="times mono footnote">
            <span>{clock(shown)}</span>
            <span>{[t('seek_delta_back', clock(Math.max(0, duration - shown))), endsAt].filter(Boolean).join(' · ')}</span>
          </div>
          <!-- Netflix's row under the bar: what one reaches for while watching; the rest in More. -->
          <div class="actions-row">
            <button class="act" onclick={() => (sheet = 'tracks')}><Captions size={22} aria-hidden="true" /><span>{t('tracks_hint_touch')}</span></button>
            {#if pb.player.speeds.length > 1}
              <button class="act" onclick={() => (sheet = 'speed')}><Gauge size={22} aria-hidden="true" /><span>{pb.rate === 1 ? t('web_speed_short') : speedText(pb.rate)}</span></button>
            {/if}
            {#if pb.item?.Type === 'Episode' && pb.item.SeriesId}
              <button class="act" onclick={() => (sheet = 'episodes')}><ListVideo size={22} aria-hidden="true" /><span>{t('episodes')}</span></button>
            {:else if chapters.length > 1}
              <button class="act" onclick={() => (sheet = 'chapters')}><ListVideo size={22} aria-hidden="true" /><span>{t('chapters')}</span></button>
            {/if}
            {#if pb.next}<button class="act" onclick={() => advance(false)}><SkipForward size={22} aria-hidden="true" /><span>{t('up_next')}</span></button>{/if}
            <button class="act" onclick={() => (sheet = 'more')}>
              <Ellipsis size={22} aria-hidden="true" /><span>{t('more')}</span>
              {#if sleepLeft !== null}<span class="sleep-dot mono">{clock(sleepLeft)}</span>{/if}
            </button>
          </div>
        </div>
      </div>
    {/if}

    {#if preview !== null}
      <div class="preview">
        {#if thumb}
          {#if thumb.tile}
            <span class="frame" style:background-image="url({thumb.src})" style:background-size="{(thumb.tile.sheetWidth / thumb.width) * 100}% auto" style:background-position="{(thumb.tile.x / Math.max(1, thumb.tile.sheetWidth - thumb.width)) * 100}% {(thumb.tile.y / Math.max(1, thumb.tile.sheetHeight - thumb.height)) * 100}%"></span>
          {:else}
            <img class="frame" src={thumb.src} alt="" />
          {/if}
        {/if}
        <div class="when">
          <p class="mono big">{clock(preview)}</p>
          <p class="mono footnote dim">{t(preview >= position ? 'seek_delta_forward' : 'seek_delta_back', clock(Math.abs(preview - position)))}</p>
        </div>
      </div>
    {/if}

    {#if hud}
      {#key hud.nonce}<div class="hud callout" out:fade={{ duration: 200 }}><Scan size={20} aria-hidden="true" />{hud.text}</div>{/key}
    {/if}

    {#if skipVisible && skippable && !upNext && !sheet}
      <button class="action corner pressable" class:up={cornerUp} transition:fade={{ duration: 220 }} onclick={() => (seekTo(skippable!.endMs), (skipVisible = false))}>
        <SkipForward size={18} fill="currentColor" aria-hidden="true" /><span class="headline">{t(SKIP_LABEL[chipKind])}</span>
      </button>
    {/if}

    {#if upNext && !sheet}
      {@const art = client.thumb(upNext, 600)}
      <div class="next corner" class:up={cornerUp} in:fly={{ y: 40, duration: 320 }} out:fade={{ duration: 200 }}>
        <div class="art">
          {#if art}<img src={art} alt="" />{/if}
          <button class="icon close" aria-label={t('close')} onclick={() => (dismissedUpNext = true)}><X size={16} aria-hidden="true" /></button>
          {#if settings.autoplayNext.value && !endOfVideo()}
            <span class="count"><span style:transform="scaleX({1 - countdown / Math.max(1, settings.countdown.value)})"></span></span>
          {/if}
        </div>
        <div class="next-body">
          <p class="eyebrow">{t('up_next')}</p>
          <p class="headline two-lines">{episodeLine(upNext) ?? upNext.Name}</p>
          <div class="next-actions">
            <button class="action pressable" onclick={() => advance(false)}><SkipForward size={18} fill="currentColor" aria-hidden="true" /><span class="headline">{t('play_now')}</span></button>
            {#if settings.autoplayNext.value && !endOfVideo()}<span class="callout label-2">{t('up_next_in', countdown)}</span>{/if}
          </div>
        </div>
      </div>
    {/if}

    {#if sheet}
      <PlayerSheet onclose={() => (sheet = null)}>
        <div class="columns">
          {#each columns as col (col.title)}
            <div class="column" style:flex={col.weight ?? 1}>
              <p class="eyebrow label-3">{col.title}</p>
              <div class="rows">
                {#each col.rows as row, i (i)}
                  <OptionRow text={row.text} selected={row.selected} busy={row.busy} onclick={row.run} />
                {/each}
              </div>
            </div>
          {/each}
        </div>
      </PlayerSheet>
    {/if}

    {#if sleepPrompt !== null && !stillWatching}
      {@render ask(t('still_watching_pausing_in', sleepPrompt), sleepContinue, t('sleep_pause'), sleepStop)}
    {/if}
    {#if stillWatching}
      {@render ask(t('still_watching_sub'), keepWatching, t('stop_watching'), exit)}
    {/if}
  {/if}
</div>

{#snippet ask(sub: string, onContinue: () => void, stopLabel: string, onStop: () => void)}
  <div class="modal" transition:fade={{ duration: 180 }}>
    <div class="card">
      <p class="title-2">{t('still_watching')}</p>
      <p class="callout label-2">{sub}</p>
      <div class="actions">
        <button class="pill primary pressable" onclick={onContinue}>{t('keep_watching')}</button>
        <button class="pill pressable" onclick={onStop}>{stopLabel}</button>
      </div>
    </div>
  </div>
{/snippet}

<style>
  .player {
    position: absolute;
    inset: 0;
    background: #000;
    color: #fff;
    overflow: hidden;
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
  }
  /* Laid out at a quarter and scaled up: too small to be main content for WebKit (lib/media-element decoy), the
     picture itself is the full frame. */
  .stage {
    position: absolute;
    left: 0;
    top: 0;
    width: 25%;
    height: 25%;
    transform: scale(4);
    transform-origin: 0 0;
  }
  .player > :global(.app-decoy) {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  .stage > :global(.app-video) {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    transition: transform var(--t-med) var(--ease-out);
  }
  .surface {
    position: absolute;
    inset: 0;
  }
  .dim {
    color: rgb(255 255 255 / 0.7);
  }
  .ellipsis {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .center {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 16px;
    padding: 24px;
    text-align: center;
  }
  .center.quiet {
    pointer-events: none;
  }
  .actions {
    display: flex;
    gap: 12px;
    justify-content: center;
  }

  /* ---- The controls ---- */
  .osd {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .osd button,
  .osd .bar {
    pointer-events: auto;
  }
  /* Video scrims (content, not chrome): the white controls stay legible on bright frames. */
  .scrim-top,
  .scrim-bottom {
    position: absolute;
    left: 0;
    right: 0;
  }
  .scrim-top {
    top: 0;
    height: calc(var(--safe-top) + 130px);
    background: linear-gradient(rgb(0 0 0 / 0.62), transparent);
  }
  .scrim-bottom {
    bottom: 0;
    height: calc(var(--safe-bottom) + 170px);
    background: linear-gradient(transparent, rgb(0 0 0 / 0.72));
  }
  .icon {
    position: relative;
    width: 44px;
    height: 44px;
    border-radius: 50%;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    color: #fff;
    transition:
      transform var(--t-fast) var(--ease-out),
      background-color var(--t-fast);
  }
  .icon:active {
    transform: scale(0.9);
  }
  .icon.busy {
    color: var(--accent);
    animation: pulse 1s var(--ease-in-out, ease-in-out) infinite alternate;
  }
  @keyframes pulse {
    to {
      opacity: 0.45;
    }
  }
  .badge {
    position: absolute;
    font-size: 9px;
    line-height: 1;
    margin-top: 2px;
  }
  .top {
    position: absolute;
    top: calc(var(--safe-top) + 6px);
    left: max(12px, var(--safe-left));
    right: max(12px, var(--safe-right));
    display: flex;
    flex-wrap: wrap;
    align-items: center;
  }
  .heading {
    flex: 1;
    min-width: 0;
    padding: 0 12px 0 6px;
  }
  .middle {
    position: absolute;
    left: 50%;
    top: 50%;
    translate: -50% -50%;
    display: flex;
    align-items: center;
    gap: 44px;
  }
  .icon.step {
    width: 56px;
    height: 56px;
  }
  .icon.main {
    width: 76px;
    height: 76px;
    background: rgb(0 0 0 / 0.32);
  }
  .bottom {
    position: absolute;
    left: max(24px, var(--safe-left));
    right: max(24px, var(--safe-right));
    bottom: calc(var(--safe-bottom) + 14px);
  }
  .bar {
    position: relative;
    height: 36px;
    display: flex;
    align-items: center;
    touch-action: none;
  }
  .track {
    position: relative;
    flex: 1;
    height: 4px;
    border-radius: 2px;
    background: rgb(255 255 255 / 0.22);
    overflow: hidden;
    transition: height var(--t-fast) var(--ease-out);
  }
  .bar.active .track {
    height: 6px;
  }
  .buffered,
  .done {
    position: absolute;
    inset: 0;
    transform-origin: left;
  }
  .buffered {
    background: rgb(255 255 255 / 0.2);
  }
  .done {
    background: var(--accent);
  }
  .knob {
    position: absolute;
    top: 50%;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: #fff;
    translate: -50% -50%;
    transition:
      width var(--t-fast) var(--ease-out),
      height var(--t-fast) var(--ease-out);
  }
  .bar.active .knob {
    width: 18px;
    height: 18px;
  }
  .times {
    display: flex;
    justify-content: space-between;
    color: rgb(255 255 255 / 0.7);
  }
  .actions-row {
    display: flex;
    justify-content: space-around;
    margin-top: 8px;
  }
  .act {
    position: relative;
    min-width: 0;
    flex: 1;
    max-width: 150px;
    min-height: 52px;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    border-radius: var(--r-sm);
    color: #fff;
    font-size: 11px;
    font-weight: 600;
    transition: background-color var(--t-fast);
  }
  .act:active {
    background: rgb(255 255 255 / 0.12);
  }
  .act span {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .sleep-dot {
    position: absolute;
    top: 2px;
    right: 8px;
    font-size: 9px;
    color: var(--accent);
  }
  /* On its side: the icon beside its label, as Netflix's landscape row. */
  @media (orientation: landscape) {
    .act {
      flex-direction: row;
      flex: none;
      max-width: none;
      padding: 0 14px;
      gap: 8px;
      font-size: var(--fs-subhead);
    }
  }

  /* ---- Feedback ---- */
  .lobe {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    width: 40%;
    border-radius: 0 50% 50% 0 / 0 50% 50% 0;
    background: rgb(255 255 255 / 0.08);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    pointer-events: none;
  }
  .lobe.right {
    left: auto;
    right: 0;
    border-radius: 50% 0 0 50% / 50% 0 0 50%;
  }
  .ring {
    position: absolute;
    width: 120vh;
    height: 120vh;
    border-radius: 50%;
    background: rgb(255 255 255 / 0.16);
    translate: -50% -50%;
    animation: ring 450ms var(--ease-out) forwards;
  }
  @keyframes ring {
    from {
      transform: scale(0);
      opacity: 1;
    }
    to {
      transform: scale(1);
      opacity: 0;
    }
  }
  .preview {
    position: absolute;
    left: 50%;
    top: 50%;
    translate: -50% -50%;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    pointer-events: none;
  }
  .frame {
    display: block;
    width: 220px;
    aspect-ratio: 16 / 9;
    border-radius: var(--r-sm);
    background-color: var(--bg-elevated-2);
    background-repeat: no-repeat;
    object-fit: cover;
  }
  .when {
    padding: 8px 16px;
    border-radius: var(--r-md);
    background: color-mix(in srgb, var(--bg-elevated) 88%, transparent);
    text-align: center;
  }
  .big {
    font-size: 26px;
    line-height: 30px;
  }
  .hud {
    position: absolute;
    top: calc(var(--safe-top) + 28px);
    left: 50%;
    translate: -50% 0;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 16px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--bg-elevated) 92%, transparent);
    color: var(--label);
    pointer-events: none;
  }

  /* ---- Skip, up next: bottom right, above the bar while the controls show ---- */
  .corner {
    position: absolute;
    right: max(24px, var(--safe-right));
    bottom: calc(var(--safe-bottom) + 28px);
    transition: bottom var(--t-med) var(--ease-out);
  }
  .corner.up {
    bottom: calc(var(--safe-bottom) + 150px);
  }
  .action {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 11px 20px;
    border-radius: 999px;
    background: #fff;
    color: #000;
    white-space: nowrap;
  }
  .next {
    width: min(300px, calc(100% - 48px));
    border-radius: var(--r-lg);
    background: color-mix(in srgb, var(--bg-elevated) 95%, transparent);
    color: var(--label);
    overflow: hidden;
  }
  .art {
    position: relative;
    aspect-ratio: 16 / 9;
    background: var(--bg-elevated-2);
  }
  .art img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .icon.close {
    position: absolute;
    top: 8px;
    right: 8px;
    width: 32px;
    height: 32px;
    background: rgb(0 0 0 / 0.45);
  }
  .count {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 3px;
    background: rgb(255 255 255 / 0.22);
  }
  .count span {
    display: block;
    height: 100%;
    background: var(--accent);
    transform-origin: left;
    transition: transform 1s linear;
  }
  .next-body {
    padding: 12px 16px 14px;
  }
  .next-body .eyebrow {
    color: var(--label-3);
  }
  .two-lines {
    margin: 3px 0 12px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .next-actions {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  /* ---- Sheets ---- */
  .columns {
    display: flex;
    gap: 20px;
    min-height: 0;
    flex: 1;
  }
  .column {
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .column .eyebrow {
    padding: 0 0 6px 12px;
  }
  .rows {
    overflow-y: auto;
    overscroll-behavior: contain;
    min-height: 0;
  }

  /* ---- "Still watching?" ---- */
  .modal {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    padding: 24px;
    background: rgb(0 0 0 / 0.6);
    z-index: 30;
  }
  .card {
    width: min(420px, 100%);
    padding: 28px;
    border-radius: var(--r-xl);
    background: var(--bg-elevated);
    color: var(--label);
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
  }
  .card .callout {
    margin: 6px 0 22px;
  }
</style>
