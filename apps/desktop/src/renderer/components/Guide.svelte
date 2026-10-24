<script lang="ts" module>
  import { imageUrl } from '../lib/images';

  // F1: IPTV logos are often dark on transparent and vanish on Graphite (and white ones on the light theme).
  // The mean luminance and chroma of the opaque pixels are measured once per logo URL (16 × 16). Below 0.3
  // on a dark theme the logo gets a plate in the label colour. On the light theme a light monochrome logo
  // (a white wordmark) is drawn in ink instead, like plain text; only a light coloured one keeps a plate.
  // The media scheme answers with CORS, so <img crossorigin="anonymous"> keeps the canvas readable.
  const plates = new Map<string, { lum: number; chroma: number }>();
  // Mounted logos, set again when the theme changes under them ('system' follows the OS live).
  const mounted = new Set<() => void>();
  let themeWatch: MutationObserver | null = null;
  export function logoPlate(img: HTMLImageElement): { destroy(): void } {
    const check = (): void => {
      const key = img.currentSrc || img.src;
      let m = plates.get(key);
      if (m === undefined) {
        try {
          const g = new OffscreenCanvas(16, 16).getContext('2d', { willReadFrequently: true }) as OffscreenCanvasRenderingContext2D;
          g.drawImage(img, 0, 0, 16, 16);
          const d = g.getImageData(0, 0, 16, 16).data;
          // Alpha-weighted: a thin wordmark downscaled to 16 × 16 leaves no fully opaque pixel.
          let sum = 0;
          let chroma = 0;
          let n = 0;
          for (let i = 0; i < d.length; i += 4) {
            const a = d[i + 3] / 255;
            sum += (a * (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2])) / 255;
            chroma += (a * (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]))) / 255;
            n += a;
          }
          m = n > 0 ? { lum: sum / n, chroma: chroma / n } : { lum: 0.5, chroma: 0 };
        } catch {
          m = { lum: 0.5, chroma: 0 }; // unreadable (tainted): no plate
        }
        plates.set(key, m);
      }
      // A media surface (.on-media: the OSD guide overlay, …) stays dark even in Light.
      // data-scheme: a light Hyprland palette (stores.svelte.ts applyTheme).
      const root = document.documentElement;
      const light = (root.dataset.theme === 'light' || root.dataset.scheme === 'light') && !img.closest('.on-media');
      img.toggleAttribute('data-ink', light && m.lum > 0.7 && m.chroma < 0.15);
      img.toggleAttribute('data-plate', light ? m.lum > 0.7 && m.chroma >= 0.15 : m.lum < 0.3);
    };
    if (img.complete && img.naturalWidth) check();
    img.addEventListener('load', check);
    const recheck = () => void (img.complete && img.naturalWidth && check());
    mounted.add(recheck);
    if (!themeWatch) {
      themeWatch = new MutationObserver(() => mounted.forEach((f) => f()));
      themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-scheme'] });
    }
    return {
      destroy: () => {
        img.removeEventListener('load', check);
        mounted.delete(recheck);
      },
    };
  }

  // Server-resized channel logo (§21.9): never the 512–1,000 px original.
  export function channelLogoUrl(r: { id: string; serverId: string; logoTag?: string }, h = 40): string {
    return r.logoTag ? imageUrl(r.id, 'Primary', { tag: r.logoTag, maxHeight: h, maxWidth: h * 2, server: r.serverId }) : '';
  }
</script>

<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { dayStart, leftForNow, MINUTE, PAGE_MS, shiftDay } from '../../shared/livetv/anchor';
  import { dimmed } from '../../shared/livetv/lens';
  import { resolveKey } from '../../shared/livetv/keys';
  import { PF } from '../../shared/livetv/model';
  import type { ChannelRow, ProgramLite } from '../../shared/livetv/model';
  import { gateMove, navMove, repeatGateInit, resolveJump, restoreFocus, rowCells } from '../../shared/livetv/nav';
  import type { Cell, GuideFocus, NavModel, NavMove, PendingJump } from '../../shared/livetv/nav';
  import { programsInWindow, TUNING } from '../../shared/livetv/tiles';
  import { markFor } from '../../shared/livetv/timers';
  import type { Mark } from '../../shared/livetv/timers';
  import { digitIndex, digitReduce, JUMP_TIMEOUT_MS } from '../../shared/livetv/zap';
  import type { DigitEvent, DigitState } from '../../shared/livetv/zap';
  import { fmt, t } from '../lib/i18n.svelte';
  import { legacyChannel, legacyProgram, live, openProgram, playChannel } from '../lib/livetv.svelte';
  import type { LiveTvStore } from '../lib/livetv.svelte';
  import { toggleReminder } from '../lib/livetv/reminders';
  import { reducedMotion } from '../lib/motion';
  import { toast } from '../lib/stores.svelte';
  import Icon from './Icon.svelte';
  import RecordOptionsSheet, { dvrToast } from './livetv/RecordOptionsSheet.svelte';
  import type { RecordTarget } from './livetv/RecordOptionsSheet.svelte';

  // Channels × the guide range (start of today to GuideInfo.EndDate) on one scroller (§6.1, §6.2).
  // The ruler and the channel column are sticky; only rows and cells near the viewport exist, read
  // from the store's tile cache (binary search per row). Navigation runs on the data model
  // (shared/livetv/nav.ts); focus then moves between real DOM elements.
  let {
    store,
    mode = 'page',
    initial,
    onexit,
    onview,
    onfocus,
    onlens,
    onsearch,
    onmenu,
  }: {
    store: LiveTvStore;
    mode?: 'page' | 'overlay';
    initial?: { left?: number; jump?: PendingJump };
    onexit?: (dir: 'up') => void;
    onview?: (left: number, laneMs: number) => void;
    onfocus?: (p: ProgramLite | null, c: ChannelRow | null) => void;
    onlens?: (step: -1 | 1 | 'all') => void;
    onsearch?: () => void;
    onmenu?: (c: ChannelRow, x: number, y: number) => void;
  } = $props();

  const CH_W = 188;
  const ROW_H = 68;
  const RULER_H = 40;
  const PX_MS = 5.6 / MINUTE; // 5.6 px per minute
  const DOM_OVERSCAN = 30 * MINUTE; // cells kept past each edge (the planner fetches ±2 h)
  const NARROW = 48; // under this width a cell shows its marks only
  const TUNE = TUNING.desktop;

  const rangeStart = untrack(() => dayStart(store.clock));
  const rangeEnd = $derived(Math.max(rangeStart + 86_400_000, store.guideEnd ?? store.clock + 7 * 86_400_000));
  const totalW = $derived((rangeEnd - rangeStart) * PX_MS);
  const x = (time: number): number => (time - rangeStart) * PX_MS;

  let scroller = $state<HTMLDivElement>();
  let view = $state({ top: 0, left: 0, w: 1200, h: 600 });
  const laneMs = $derived(view.w / PX_MS);
  const left = $derived(rangeStart + view.left / PX_MS);
  const right = $derived(left + laneMs);
  const rows = $derived(store.rows);
  const firstVis = $derived(Math.floor(view.top / ROW_H));
  const lastVis = $derived(Math.min(rows.length - 1, Math.floor((view.top + view.h - 1) / ROW_H)));
  const first = $derived(Math.max(0, firstVis - TUNE.rowOverscan));
  const last = $derived(Math.min(rows.length, lastVis + 1 + TUNE.rowOverscan));
  const tFrom = $derived(Math.max(rangeStart, left - DOM_OVERSCAN));
  const tTo = $derived(Math.min(rangeEnd, right + DOM_OVERSCAN));
  const clock = $derived(store.clock);
  const nowX = $derived(x(clock));
  const overlay = $derived(store.dvr.overlay);
  const hidden = $derived(new Set(store.prefs.hidden));

  let focus = $state<GuideFocus | null>(null);
  const focusKey = $derived(focus ? keyOf(focus) : '');
  const focusRow = $derived(focus ? rows.findIndex((r) => r.id === focus!.channelId) : -1);
  // The row holding DOM focus stays mounted until the model's target row exists (§6.9).
  let held = $state<string | null>(null);
  const heldRow = $derived(held ? rows.findIndex((r) => r.id === held) : -1);

  // ---- Cells (stable objects, so a scroll frame re-renders only the cells that change) ----

  interface CellView extends Cell {
    key: string;
    p?: ProgramLite;
  }
  interface RowView {
    r: ChannelRow;
    i: number;
    cells: CellView[] | undefined;
    failed: boolean;
    busy: boolean;
  }
  let memo = new Map<string, CellView>();

  // The cache's merged list once every slab of the visible span is in; undefined while loading.
  const listOf = (id: string): ProgramLite[] | undefined => store.programs(id, Math.max(rangeStart, left), Math.max(right, left + MINUTE));

  const rowViews = $derived.by(() => {
    const out: RowView[] = [];
    const next = new Map<string, CellView>();
    const indexes: number[] = [];
    for (let i = first; i < last; i++) indexes.push(i);
    for (const k of [focusRow, heldRow]) if (k >= 0 && (k < first || k >= last) && !indexes.includes(k)) indexes.push(k); // keep DOM focus alive
    for (const i of indexes) {
      const r = rows[i];
      const list = listOf(r.id);
      let cells: CellView[] | undefined;
      if (list) {
        let from = tFrom;
        let to = tTo;
        if (focus && focus.channelId === r.id && focus.start !== undefined && focus.end !== undefined) {
          from = Math.min(from, focus.start);
          to = Math.max(to, focus.end);
        }
        const byId = new Map(programsInWindow(list, from, to).map((p) => [p.id, p]));
        cells = (rowCells({ programs: () => list, rangeStart, rangeEnd }, r.id, from, to) ?? []).map((c) => {
          const key = c.programId ?? (list.length ? `f:${c.start}` : 'f:all');
          const p = c.programId ? byId.get(c.programId) : undefined;
          const id = `${r.id}|${key}`;
          const old = memo.get(id);
          const cv = old && old.start === c.start && old.end === c.end && old.p === p ? old : { ...c, key, p };
          next.set(id, cv);
          return cv;
        });
      }
      out.push({ r, i, cells, failed: !list && store.rowFailed(r.id, left, right), busy: store.rowLoading(r.id, left, right) });
    }
    memo = next;
    return out;
  });

  // Virtualized ruler: half-hour ticks around the viewport.
  const ticks = $derived.by(() => {
    const out: number[] = [];
    const step = 30 * MINUTE;
    for (let tk = Math.max(rangeStart, Math.floor((left - 60 * MINUTE) / step) * step); tk < Math.min(rangeEnd, right + 60 * MINUTE); tk += step) out.push(tk);
    return out;
  });

  // ---- Viewport → planner, anchor, URL ----

  let frame = 0;
  let lastLeft = -1;
  function measure(): void {
    if (frame || !scroller) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!scroller) return;
      view = { top: scroller.scrollTop, left: scroller.scrollLeft, w: Math.max(1, scroller.clientWidth - CH_W), h: Math.max(1, scroller.clientHeight - RULER_H) };
    });
  }

  $effect(() => {
    const v = { firstRow: firstVis, lastRow: Math.max(firstVis, lastVis), from: left, to: right };
    void store.rowIds; // a lens or sort change re-plans the same viewport
    const dir = lastLeft < 0 || left === lastLeft ? 0 : left > lastLeft ? 1 : -1;
    untrack(() => {
      if (!rows.length) return;
      store.setViewport({ ...v, dir });
      if (lastLeft >= 0 && Math.abs(left - lastLeft) > MINUTE / 2) store.anchorEvent({ type: 'scroll', at: store.now(), nowVisible: clock >= left && clock < right });
      lastLeft = left;
      onview?.(left, laneMs);
    });
  });

  // The first programmes on screen (first-paint counter).
  $effect(() => {
    if (rowViews.some((r) => r.cells?.length)) untrack(() => store.markPainted());
  });

  function scrollToTime(time: number, rowIndex?: number, smooth = false): void {
    if (!scroller) return;
    const h = scroller.clientHeight - RULER_H;
    let top = scroller.scrollTop;
    if (rowIndex !== undefined) {
      const y = rowIndex * ROW_H;
      if (y < top) top = y;
      else if (y + ROW_H > top + h) top = y + ROW_H - h;
    }
    const leftPx = Math.max(0, Math.min(totalW - view.w, x(time)));
    if (Math.abs(top - scroller.scrollTop) < 1 && Math.abs(leftPx - scroller.scrollLeft) < 1) return;
    // One combined scroll: two smooth scrolls on a two-axis scroller cancel each other.
    scroller.scrollTo({ top: Math.max(0, top), left: leftPx, behavior: smooth ? 'smooth' : 'auto' });
  }

  // ---- Time navigation (§6.4) ----

  export function goTo(leftTime: number): void {
    store.anchorEvent({ type: 'pick', at: store.now() });
    scrollToTime(leftTime);
  }

  export function goNow(): void {
    store.anchorEvent({ type: 'now', at: store.now() });
    scrollToTime(leftForNow(store.now(), laneMs));
  }

  export function page(delta: number): void {
    goTo(left + delta);
  }

  export function viewLeft(): number {
    return left;
  }

  let recenterSeen = untrack(() => store.recenterSeq);
  $effect(() => {
    const seq = store.recenterSeq;
    if (seq === recenterSeen) return;
    recenterSeen = seq;
    untrack(() => scrollToTime(leftForNow(store.now(), laneMs)));
  });

  // ---- Focus on the data model (§6.9) ----

  function model(): NavModel {
    return { rows: store.rowIds, programs: listOf, rangeStart, rangeEnd, left, right, now: store.now() };
  }

  function keyOf(f: GuideFocus): string {
    if (f.kind === 'program') return `${f.channelId}|${f.programId}`;
    if (f.kind === 'filler') return `${f.channelId}|${listOf(f.channelId)?.length ? `f:${f.start}` : 'f:all'}`;
    return `${f.channelId}|ch`;
  }

  // Moves DOM focus to the focused cell once it is mounted. A smooth scroll or a slow tile can take
  // many frames; the old row stays mounted meanwhile (held), so focus never drops to <body>.
  let focusSeq = 0;
  function applyFocus(): void {
    const seq = ++focusSeq;
    let tries = 90; // ~1.5 s, then the row header
    const step = (): void => {
      if (seq !== focusSeq || !scroller || !focus) return;
      const el = scroller.querySelector<HTMLElement>(`[data-key="${CSS.escape(keyOf(focus))}"]`) ?? scroller.querySelector<HTMLElement>(`[data-key="${CSS.escape(`${focus.channelId}|ch`)}"]`);
      if (el && (el.dataset.key === keyOf(focus) || tries <= 1)) el.focus({ preventScroll: true });
      else if (--tries > 0) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  const gridHasFocus = (): boolean => !!scroller && (scroller.contains(document.activeElement) || document.activeElement === document.body);

  export function focusGrid(): void {
    if (!focus) {
      const r = rows[Math.min(rows.length - 1, firstVis)];
      if (!r) return;
      focus = navMove(model(), { kind: 'channel', channelId: r.id, focusT: store.now() }, 'right').focus ?? { kind: 'channel', channelId: r.id, focusT: store.now() };
    }
    scrollToTime(left, rows.findIndex((r) => r.id === focus!.channelId));
    applyFocus();
  }

  // Focus that arrived by pointer or Tab: adopt it as the model focus.
  function onFocusIn(e: FocusEvent): void {
    const el = (e.target as HTMLElement).closest<HTMLElement>('[data-key]');
    if (!el) return;
    const ch = el.dataset.ch as string;
    held = ch;
    if (focus && keyOf(focus) === el.dataset.key) return;
    const kind = el.dataset.kind as GuideFocus['kind'];
    const start = Number(el.dataset.start);
    const end = Number(el.dataset.end);
    focus =
      kind === 'channel'
        ? { kind, channelId: ch, focusT: focus?.focusT ?? store.now() }
        : { kind, channelId: ch, programId: el.dataset.pid, start, end, focusT: Math.max(start, left + MINUTE) };
  }

  // The detail band follows the focused programme.
  $effect(() => {
    const f = focus;
    const r = f ? rows.find((x) => x.id === f.channelId) ?? null : null;
    const p = f?.kind === 'program' && f.programId ? (listOf(f.channelId)?.find((x) => x.id === f.programId) ?? null) : null;
    untrack(() => onfocus?.(p, r));
  });

  // Reloads (lens, tiles, refresh) keep the focus by identity; the grid is never unmounted.
  let lastFocusRow = 0;
  $effect(() => {
    void store.version;
    const ids = store.rowIds;
    untrack(() => {
      if (!focus) return;
      const i = ids.indexOf(focus.channelId);
      if (i >= 0 && focus.kind !== 'filler' && focus.kind !== 'loading') {
        lastFocusRow = i;
        return;
      }
      const had = gridHasFocus();
      const next = restoreFocus(model(), focus, i >= 0 ? i : lastFocusRow);
      if (!next || keyOf(next) === keyOf(focus)) return;
      focus = next;
      if (had) applyFocus();
    });
  });

  // ---- Pending jump (search, deep link, "Voir dans le guide"), replayed while loading ----

  let pending = $state<PendingJump | null>(untrack(() => initial?.jump ?? null));
  let switched = false;

  export function jump(j: PendingJump): void {
    switched = false;
    pending = j;
  }

  $effect(() => {
    const j = pending;
    void store.version;
    void store.rowIds;
    const loaded = store.channels.length > 0;
    if (!j || !scroller) return;
    untrack(() => {
      const step = resolveJump(model(), j, loaded, store.channels.map((r) => r.id));
      if (step.status === 'switch-lens') {
        if (!switched) {
          switched = true;
          onlens?.('all');
        }
        return;
      }
      if (step.status === 'wait') {
        const row = store.rowIds.indexOf(j.channelId);
        if (row >= 0) {
          scrollToTime(j.time - 30 * MINUTE, row);
          void store.ensure([j.channelId], j.time - 60 * MINUTE, j.time + 3 * 60 * MINUTE);
        }
        return;
      }
      pending = null;
      // A jump away from now is a manual view; the restore on the last channel at now stays live.
      if (Math.abs(j.time - store.now()) > 5 * MINUTE) store.anchorEvent({ type: 'pick', at: store.now() });
      focus = step.focus;
      scrollToTime(step.scrollLeft, step.rowIndex);
      applyFocus();
    });
  });

  // ---- Activation ----

  const programOf = (f: GuideFocus | null): ProgramLite | undefined =>
    f?.kind === 'program' && f.programId ? listOf(f.channelId)?.find((p) => p.id === f.programId) : undefined;
  const rowOf = (id: string): ChannelRow | undefined => rows.find((r) => r.id === id) ?? store.channels.find((r) => r.id === id);
  const airing = (p: ProgramLite): boolean => p.start <= store.now() && p.end > store.now();

  function sheet(p: ProgramLite, r: ChannelRow): void {
    openProgram(legacyProgram(p, store), legacyChannel(r, store));
  }

  function watch(r: ChannelRow): void {
    void playChannel(r.id, store.serverId);
  }

  // Recording options (D-6, §9.1): Shift+R, and the quick-record toast's action.
  let recordTarget = $state<RecordTarget | null>(null);
  function recordOptions(p: ProgramLite): void {
    const id = store.dvr.overlay?.get(p.id)?.id;
    recordTarget = id && !id.startsWith('pending-') ? { kind: 'timer', id } : { kind: 'new', programId: p.id, series: false, isSeries: Boolean(p.flags & PF.Series) };
  }

  async function record(p: ProgramLite): Promise<void> {
    try {
      await live.record(p.id, false, store.serverId);
      toast('success', t('livetv.toasts.recordingScheduled'), { label: t('livetv.record.options'), run: () => recordOptions(p) });
    } catch (err) {
      dvrToast(err);
    }
  }

  // ---- Keys (§10.1, keys.ts context 'guide') ----

  const MOVES: Record<string, NavMove> = {
    'guide.left': 'left',
    'guide.right': 'right',
    'guide.up': 'up',
    'guide.down': 'down',
    'guide.pageUp': 'page-up',
    'guide.pageDown': 'page-down',
    'guide.firstChannel': 'first',
    'guide.lastChannel': 'last',
  };
  let gate = repeatGateInit();

  function move(m: NavMove, repeat: boolean): boolean {
    if (!focus) {
      focusGrid();
      return true;
    }
    const g = gateMove(gate, Math.floor(performance.now() / 16), repeat);
    gate = g.gate;
    if (!g.accept) return true;
    const res = navMove(model(), focus, m, Math.max(1, Math.floor(view.h / ROW_H) - 1));
    if (res.exit === 'up') {
      focus = null;
      onexit?.('up');
      return true;
    }
    if (res.exit === 'left' || !res.focus) return false; // the sidebar's spatial navigation takes it
    const from = focusRow;
    focus = res.focus;
    const row = res.rowIndex ?? rows.findIndex((r) => r.id === res.focus!.channelId);
    if (res.scrollLeft !== undefined) store.anchorEvent({ type: 'pick', at: store.now() });
    // Smooth only for a one-row step: a jump lands at once (and a mounted target row).
    scrollToTime(res.scrollLeft ?? left, row, !repeat && Math.abs(row - from) <= 1 && !reducedMotion());
    applyFocus();
    return true;
  }

  // Number entry in jump mode: commit scrolls to and focuses the channel; Enter then tunes.
  let digits = $state<DigitState | null>(null);
  let digitTimer: ReturnType<typeof setTimeout> | undefined;
  const digitIx = $derived(digitIndex(store.channels.map((r) => ({ id: r.id, number: r.number, hidden: hidden.has(r.id) }))));

  function digit(ev: DigitEvent): void {
    const s = digitReduce(digitIx, digits, ev, JUMP_TIMEOUT_MS);
    digits = s.state;
    clearTimeout(digitTimer);
    if (s.state) digitTimer = setTimeout(() => digit({ type: 'tick', at: Date.now() }), JUMP_TIMEOUT_MS + 20);
    if (s.result?.type !== 'commit') return;
    if (s.result.hidden) return toast('info', t('livetv.channel.hiddenToast'));
    const id = s.result.id;
    const row = store.rowIds.indexOf(id);
    if (row < 0) {
      jump({ channelId: id, time: store.now() });
      return;
    }
    focus = { kind: 'channel', channelId: id, focusT: focus?.focusT ?? store.now() };
    scrollToTime(left, row);
    applyFocus();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.target instanceof HTMLInputElement) return;
    store.anchorEvent({ type: 'input', at: store.now() });
    const k = resolveKey(e, 'guide');
    if (digits && (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'Enter')) {
      e.preventDefault();
      e.stopPropagation();
      digit({ type: e.key === 'Escape' ? 'escape' : e.key === 'Backspace' ? 'backspace' : 'enter', at: Date.now() });
      return;
    }
    if (!k) return;
    const id = k.id;
    const f = focus;
    const p = programOf(f);
    const r = f ? rowOf(f.channelId) : undefined;
    let handled = true;
    if (MOVES[id]) handled = move(MOVES[id], e.repeat);
    else
      switch (id) {
        case 'guide.digits':
          digit({ type: 'digit', d: e.code.slice(-1), at: Date.now() });
          break;
        case 'guide.separator':
          if (digits) digit({ type: 'separator', at: Date.now() });
          else handled = false;
          break;
        case 'guide.earlier':
        case 'guide.later':
          page(id === 'guide.later' ? PAGE_MS : -PAGE_MS);
          break;
        case 'guide.prevDay':
        case 'guide.nextDay':
          goTo(shiftDay(left, id === 'guide.nextDay' ? 1 : -1));
          break;
        case 'guide.now':
          goNow();
          break;
        case 'guide.open':
        case 'guide.watch':
          if (!r) handled = false;
          else if (!f || f.kind !== 'program' || !p) watch(r);
          else if ((id === 'guide.watch' || mode === 'overlay') && airing(p)) watch(r); // picture-in-guide: OK tunes in place
          else sheet(p, r);
          break;
        case 'guide.search':
          onsearch?.();
          break;
        case 'guide.favorite':
          if (r) void store.toggleFavorite(r.id);
          break;
        case 'guide.record':
          if (p) void record(p);
          break;
        case 'guide.recordOptions':
          if (p) recordOptions(p);
          break;
        case 'guide.prevLens':
        case 'guide.nextLens':
          onlens?.(id === 'guide.nextLens' ? 1 : -1);
          break;
        case 'guide.menu': {
          const el = e.target as HTMLElement;
          const box = el.getBoundingClientRect();
          if (r) onmenu?.(r, box.left + 12, box.bottom);
          break;
        }
        case 'guide.reminder':
          if (p && r && p.start > store.now()) void toggleReminder({ serverId: store.serverId, programId: p.id, channelId: r.id, start: p.start, title: p.title, channelName: r.name });
          else handled = false;
          break;
        default:
          handled = false; // close
      }
    if (handled) e.preventDefault();
  }

  // ---- Labels ----

  function badgesOf(p: ProgramLite): string[] {
    const on = store.badges;
    const out: string[] = [];
    if (on.includes('live') && p.flags & PF.Live) out.push(t('livetv.badges.live'));
    if (on.includes('new') && store.caps.newFlag && p.flags & PF.New) out.push(t('livetv.badges.new'));
    if (on.includes('premiere') && p.flags & PF.Premiere) out.push(t('livetv.badges.premiere'));
    if (on.includes('repeat') && p.flags & PF.Repeat) out.push(t('livetv.badges.repeat'));
    if (on.includes('hd') && store.caps.hdFlag !== false && p.flags & PF.HD) out.push('HD');
    if (on.includes('rating') && p.rating) out.push(p.rating);
    return out;
  }

  const MARK_KEY: Record<Mark, string> = {
    timer: 'marks.timer',
    series: 'marks.series',
    recording: 'marks.recording',
    'conflict-wont': 'marks.wontRecord',
    'conflict-ok': 'marks.conflictOk',
    error: 'marks.error',
    'rule-skip': 'marks.ruleSkips',
  };

  function subLine(p: ProgramLite): string {
    const se = p.season !== undefined && p.episode !== undefined ? t('livetv.guide.episode', { season: p.season, episode: p.episode }) : '';
    return [se, p.episodeTitle].filter(Boolean).join(' · ') || fmt.time(p.start);
  }

  function cellLabel(p: ProgramLite, r: ChannelRow, mark: Mark | null): string {
    const parts = [t('livetv.guide.aria.cell', { title: p.title, channel: r.name, start: fmt.time(p.start), end: fmt.time(p.end) })];
    if (p.start <= clock && p.end > clock) parts.push(t('livetv.guide.aria.onNow', { percent: Math.round(((clock - p.start) / (p.end - p.start)) * 100) }));
    parts.push(...badgesOf(p));
    if (mark && mark !== 'rule-skip') parts.push(t(`livetv.${MARK_KEY[mark]}`));
    if (p.start > clock && store.reminded.has(p.id)) parts.push(t('livetv.marks.reminder'));
    return parts.join(', ');
  }

  const channelLabel = (r: ChannelRow): string => (r.number ? t('livetv.guide.aria.channel', { number: r.number, name: r.name }) : r.name);

  function dayLabel(time: number): string {
    const d = dayStart(time);
    if (d === dayStart(clock)) return t('livetv.guide.today');
    return fmt.day(time);
  }

  // ---- Mount ----

  onMount(() => {
    if (!scroller) return;
    const box = scroller.getBoundingClientRect();
    view = { top: 0, left: 0, w: Math.max(1, box.width - CH_W), h: Math.max(1, box.height - RULER_H) };
    const start = initial?.left ?? leftForNow(store.now(), view.w / PX_MS);
    if (initial?.left !== undefined) store.anchorEvent({ type: 'pick', at: store.now() });
    scroller.scrollLeft = Math.max(0, x(start));
    const ro = new ResizeObserver(measure);
    ro.observe(scroller);
    measure();
    store.setNowFraction(() => (laneMs > 0 ? (store.now() - left) / laneMs : null));
    let counters: Record<string, unknown> | undefined;
    if (import.meta.env.DEV) {
      counters = ((window as unknown as { __wicabyLive?: Record<string, unknown> }).__wicabyLive ??= {});
      Object.defineProperty(counters, 'guide', {
        configurable: true,
        enumerable: true,
        get: () => ({
          cells: scroller?.querySelectorAll('[role="gridcell"]').length ?? 0,
          rows: scroller?.querySelectorAll('[role="row"]').length ?? 0,
          nodes: scroller?.getElementsByTagName('*').length ?? 0,
        }),
      });
    }
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
      clearTimeout(digitTimer);
      store.setNowFraction(null);
      if (counters) delete counters.guide;
    };
  });
</script>

<div class="guide-box">
<!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_interactive_supports_focus -->
<div
  class="guide"
  class:overlay={mode === 'overlay'}
  bind:this={scroller}
  onscroll={measure}
  onkeydown={onKey}
  onfocusin={onFocusIn}
  onpointerdown={() => store.anchorEvent({ type: 'input', at: store.now() })}
  role="grid"
  tabindex="-1"
  aria-label={t('livetv.guide.aria.grid')}
  aria-rowcount={rows.length + 1}
  aria-colcount={-1}
  style:--ch="{CH_W}px"
  style:--row="{ROW_H}px"
  style:--ruler="{RULER_H}px"
  style:--now={(clock - rangeStart) / MINUTE}
  style:--now-x="{nowX}px"
>
  <div class="canvas" style:width="{CH_W + totalW}px" style:height="{RULER_H + Math.max(rows.length, 1) * ROW_H}px">
    <div class="ruler" role="row" aria-rowindex={1}>
      <div class="corner" role="columnheader">{dayLabel(left)}</div>
      {#each ticks as tk (tk)}
        <span class="tick mono" class:hour={new Date(tk).getMinutes() === 0} role="columnheader" style:transform="translate3d({CH_W + x(tk)}px, 0, 0)">{fmt.time(tk)}</span>
      {/each}
      {#if clock >= left && clock < right}<span class="now-dot" aria-hidden="true"></span>{/if}
    </div>

    {#if !rows.length && store.channelsState !== 'ready'}
      <!-- First load, no cache: skeleton rows, no spinner. -->
      {#each Array(10) as _, i (i)}
        <div class="row sk" aria-hidden="true" style:transform="translate3d(0, {RULER_H + i * ROW_H}px, 0)">
          <span class="chan"><span class="plate-sk skeleton"></span></span>
          <span class="lane-sk skeleton" style:left="{CH_W + view.left}px" style:width="{view.w}px"></span>
        </div>
      {/each}
    {:else if !rows.length}
      <div class="empty-lens">
        <p>{store.lens.kind === 'favorites' ? t('livetv.lens.emptyFavorites') : t('livetv.lens.empty')}</p>
        <button class="btn" onclick={() => onlens?.('all')}>{t('livetv.lens.showAll')}</button>
      </div>
    {/if}

    {#each rowViews as row (row.r.id)}
      {@const r = row.r}
      <div class="row" role="row" aria-rowindex={row.i + 2} aria-busy={row.busy ? 'true' : undefined} style:transform="translate3d(0, {RULER_H + row.i * ROW_H}px, 0)">
        <div
          class="chan"
          role="rowheader"
          tabindex={(focus ? focusKey === `${r.id}|ch` : row.i === firstVis) ? 0 : -1}
          data-key="{r.id}|ch"
          data-ch={r.id}
          data-kind="channel"
          aria-label={channelLabel(r)}
          onclick={() => watch(r)}
          oncontextmenu={(e) => (e.preventDefault(), onmenu?.(r, e.clientX, e.clientY))}
          onkeydown={() => undefined}
        >
          {#if r.logoTag}
            <span class="c-num mono">{r.number}</span>
            <img class="logo" src={channelLogoUrl(r)} alt="" crossorigin="anonymous" loading="lazy" decoding="async" draggable="false" use:logoPlate />
          {:else}
            <span class="c-stack"><span class="c-num mono">{r.number}</span><span class="c-name">{r.name}</span></span>
          {/if}
          {#if r.favorite}<span class="fav" aria-hidden="true">★</span>{/if}
        </div>

        {#if row.cells}
          {#each row.cells as c (c.key)}
            {@const x0 = Math.max(0, x(c.start))}
            {@const w = Math.max(2, Math.min(totalW, x(c.end)) - x0 - 2)}
            {@const isFocus = focusKey === `${r.id}|${c.key}`}
            {#if c.kind === 'filler'}
              <div
                class="cell filler"
                role="gridcell"
                tabindex={isFocus ? 0 : -1}
                data-key="{r.id}|{c.key}"
                data-ch={r.id}
                data-kind="filler"
                data-start={c.start}
                data-end={c.end}
                style:left="{CH_W + x0}px"
                style:width="{w}px"
                aria-label={t('livetv.guide.aria.filler', { channel: r.name })}
                onclick={() => watch(r)}
                onkeydown={() => undefined}
              >
                {#if w >= NARROW}<span class="inner"><span class="p-name">{t('livetv.guide.noInfo')}</span></span>{/if}
              </div>
            {:else if c.p}
              {@const p = c.p}
              {@const mark = markFor(p, overlay)}
              {@const on = p.start <= clock && p.end > clock}
              {@const bell = p.start > clock && store.reminded.has(p.id)}
              {@const badges = Math.min(totalW, x(c.end)) - Math.max(x0, view.left) >= 160 ? badgesOf(p) : []}
              <!-- Badges only while enough of the cell shows: under the sticky title they would collide. -->
              <div
                class="cell"
                class:on
                class:past={p.end <= clock}
                class:dim={dimmed(p, store.category)}
                class:rec={mark === 'recording'}
                role="gridcell"
                tabindex={isFocus ? 0 : -1}
                data-key="{r.id}|{c.key}"
                data-pid={p.id}
                data-ch={r.id}
                data-kind="program"
                data-start={p.start}
                data-end={p.end}
                style:left="{CH_W + x0}px"
                style:width="{w}px"
                style:--s={on ? (p.start - rangeStart) / MINUTE : undefined}
                style:--w={on ? (p.end - p.start) / MINUTE : undefined}
                style:--bw={badges.length || (mark && mark !== 'rule-skip') || bell ? `${badges.length * 46 + 18}px` : undefined}
                aria-label={cellLabel(p, r, mark)}
                title={w < NARROW ? p.title : undefined}
                onclick={() => sheet(p, r)}
                ondblclick={() => (airing(p) ? watch(r) : sheet(p, r))}
                onkeydown={() => undefined}
              >
                {#if w >= NARROW}
                  <span class="inner"><span class="p-name">{p.title}</span><span class="p-sub">{subLine(p)}</span></span>
                  {#if badges.length}<span class="badges">{#each badges as b, bi (bi)}<span class="badge">{b}</span>{/each}</span>{/if}
                {/if}
                {#if mark && mark !== 'rule-skip'}
                  <span class="mark" data-mark={mark} aria-hidden="true">
                    {#if mark === 'error'}!{:else}<span class="dot"></span>{/if}
                    {#if mark === 'conflict-wont'}<svg viewBox="0 0 12 12"><path d="M1 11 11 1" /></svg>{/if}
                  </span>
                {:else if bell}
                  <!-- One mark slot: a recording mark outranks the reminder bell. -->
                  <span class="mark bell" aria-hidden="true"><Icon name="bell" size={12} /></span>
                {/if}
              </div>
            {/if}
          {/each}
        {:else if row.failed}
          <button class="cell retry" style:left="{CH_W + view.left}px" style:width="{Math.min(view.w, 320)}px" onclick={() => store.retryRow(r.id)} tabindex="-1">
            <span class="inner"><span class="p-name">{t('livetv.guide.retry')}</span></span>
          </button>
        {:else}
          <div class="lane-sk skeleton" aria-hidden="true" style:left="{CH_W + view.left}px" style:width="{view.w}px"></div>
        {/if}
      </div>
    {/each}

    {#if clock >= left && clock < right}<span class="now-line" aria-hidden="true" style:height="{rows.length * ROW_H}px"></span>{/if}
  </div>
</div>
  {#if digits}
    <div class="digits title-1 mono" aria-hidden="true">{digits.buf}</div>
  {/if}
</div>
<RecordOptionsSheet {store} target={recordTarget} onclose={() => (recordTarget = null)} />

<style>
  .guide {
    position: relative;
    height: 100%;
    overflow: auto;
    overscroll-behavior: contain;
    border-radius: var(--r-lg);
    background: var(--bg-elevated);
    outline: none;
  }
  .guide.overlay {
    background: var(--material);
    -webkit-backdrop-filter: var(--blur);
    backdrop-filter: var(--blur);
  }
  .canvas {
    position: relative;
  }
  .ruler {
    position: sticky;
    top: 0;
    z-index: 3;
    height: var(--ruler);
    background: var(--bg-elevated);
    box-shadow: 0 1px 0 var(--separator);
  }
  .overlay .ruler,
  .overlay .chan {
    background: var(--bg-elevated-2);
  }
  .corner {
    position: sticky;
    left: 0;
    z-index: 2;
    width: var(--ch);
    height: 100%;
    display: flex;
    align-items: center;
    padding-left: 16px;
    font-size: var(--fs-footnote);
    font-weight: 600;
    color: var(--label);
    background: var(--bg-elevated);
    text-transform: capitalize;
  }
  .tick {
    position: absolute;
    top: 0;
    left: 0;
    height: 100%;
    display: flex;
    align-items: center;
    padding-left: 8px;
    border-left: 1px solid var(--separator);
    font-size: var(--fs-caption);
    color: var(--label-3);
    white-space: nowrap;
  }
  .tick.hour {
    color: var(--label-2);
  }
  .now-dot {
    position: absolute;
    left: calc(var(--ch) - 4px);
    bottom: -4px;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--label);
    transform: translate3d(var(--now-x), 0, 0);
  }
  .now-line {
    position: absolute;
    top: var(--ruler);
    left: var(--ch);
    z-index: 1;
    width: 1px;
    background: var(--label);
    opacity: 0.7;
    pointer-events: none;
    transform: translate3d(var(--now-x), 0, 0);
  }
  .row {
    position: absolute;
    top: 0;
    left: 0;
    width: 100%;
    height: var(--row);
    box-shadow: inset 0 -1px 0 var(--separator);
    contain: layout style;
  }
  .chan {
    position: sticky;
    left: 0;
    z-index: 2;
    width: var(--ch);
    height: 100%;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 14px 0 16px;
    background: var(--bg-elevated);
    box-shadow:
      1px 0 0 var(--separator),
      inset 0 -1px 0 var(--separator);
    cursor: pointer;
    outline: none;
  }
  .chan:hover,
  .chan:focus-visible {
    background: var(--fill-4);
    color: var(--label);
  }
  .c-num {
    width: 34px;
    flex: none;
    font-size: var(--fs-footnote);
    font-weight: 600;
    color: var(--label-3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .c-stack {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .c-stack .c-num {
    width: auto;
  }
  .c-name {
    font-size: var(--fs-callout);
    font-weight: 560;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .logo {
    width: 96px;
    height: 40px;
    flex: none;
    object-fit: contain;
    object-position: left center;
    border-radius: var(--r-xs);
  }
  .logo:global([data-plate]) {
    padding: 3px 6px;
    background: color-mix(in srgb, var(--label) 85%, transparent);
  }
  .fav {
    margin-left: auto;
    font-size: 11px;
    color: var(--label-3);
  }
  .cell {
    position: absolute;
    top: 5px;
    height: calc(var(--row) - 10px);
    padding: 0 10px;
    border-radius: var(--r-xs);
    text-align: left;
    background: var(--fill-1);
    color: var(--label-2);
    /* clip, not hidden: hidden would make the cell the sticky title's scroller. */
    overflow: clip;
    cursor: pointer;
    outline: none;
  }
  /* High Contrast: a 3:1 outline on the control's edge (docs/design.md). */
  :global(html[data-theme='contrast']) .cell:not(.filler) {
    outline: 1px solid var(--separator);
    outline-offset: -1px;
  }
  .cell.on {
    background: var(--fill-2);
    color: var(--label);
  }
  /* Airing progress from two custom properties: the clock tick does no per-cell work. */
  .cell.on::after {
    content: '';
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 2px;
    background: var(--label);
    opacity: 0.6;
    transform-origin: left;
    transform: scaleX(clamp(0, calc((var(--now) - var(--s)) / var(--w)), 1));
  }
  .cell.past {
    color: var(--label-2);
  }
  .cell.past .p-name {
    font-weight: 500;
  }
  .cell.dim {
    opacity: 0.35;
  }
  .cell.filler {
    background: transparent;
    color: var(--label-3);
    box-shadow: inset 0 0 0 1px var(--separator);
  }
  .cell.rec {
    box-shadow: inset 0 0 0 1px var(--red);
  }
  .cell:hover {
    background: var(--fill-3);
    color: var(--label);
  }
  /* Focus is inverted, never an accent ring (§11). */
  .cell:focus-visible {
    background: var(--label);
    color: var(--bg);
    opacity: 1;
  }
  .cell:focus-visible .p-sub,
  .cell:focus-visible .badge {
    color: color-mix(in srgb, var(--bg) 70%, transparent);
  }
  .cell:focus-visible .badge {
    background: color-mix(in srgb, var(--bg) 12%, transparent);
  }
  .cell.retry {
    display: flex;
    align-items: center;
    font: inherit;
    background: var(--fill-2);
    color: var(--label);
  }
  /* The title stays readable while a long programme scrolls off to the left. */
  .inner {
    position: sticky;
    left: calc(var(--ch) + 10px);
    display: inline-flex;
    flex-direction: column;
    justify-content: center;
    max-width: calc(100% - var(--bw, 0px)); /* the title ends before the badges */
    height: 100%;
    vertical-align: top;
  }
  .p-name {
    font-size: var(--fs-callout);
    font-weight: 560;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .p-sub {
    margin-top: 2px;
    font-size: var(--fs-caption);
    color: var(--label-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-variant-numeric: tabular-nums;
  }
  /* Badges drop from the right when the cell is too narrow: wrapped ones fall out of the box. */
  .badges {
    position: absolute;
    top: 6px;
    right: 22px;
    left: 45%;
    height: 16px;
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 4px;
    overflow: hidden;
  }
  .badge {
    height: 16px;
    padding: 0 5px;
    border-radius: 4px;
    background: var(--fill-3);
    color: var(--label-2);
    font-size: var(--fs-caption);
    line-height: 16px;
    white-space: nowrap;
  }
  .mark {
    position: absolute;
    top: 8px;
    right: 7px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 2px;
    width: 12px;
    height: 12px;
    font-size: 11px;
    font-weight: 700;
    line-height: 1;
  }
  .mark .dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    border: 3.5px solid var(--red);
    box-sizing: border-box;
  }
  .mark[data-mark='series'] {
    border: 1.5px solid var(--red);
    border-radius: 50%;
    box-sizing: border-box;
  }
  .mark[data-mark='conflict-wont'] {
    width: auto;
    color: var(--label-3);
  }
  .mark[data-mark='conflict-wont'] .dot {
    border-color: var(--label-3);
  }
  .mark[data-mark='error'],
  .mark.bell {
    color: var(--label-2);
  }
  .mark svg {
    width: 12px;
    height: 12px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.5;
  }
  .lane-sk {
    position: absolute;
    top: 8px;
    height: calc(var(--row) - 16px);
    border-radius: var(--r-xs);
  }
  .plate-sk {
    width: 96px;
    height: 40px;
    border-radius: var(--r-xs);
    margin-left: 46px;
  }
  .empty-lens {
    position: sticky;
    left: 0;
    display: grid;
    justify-items: center;
    gap: 12px;
    width: min(100%, 100vw);
    padding: 64px 24px;
    color: var(--label-3);
    text-align: center;
  }
  .empty-lens p {
    margin: 0;
    max-width: 44ch;
  }
  .guide-box {
    position: relative;
    height: 100%;
  }
  .digits {
    position: absolute;
    top: 52px;
    right: 16px;
    z-index: 4;
    padding: 6px 14px;
    border-radius: var(--r-md);
    background: var(--label);
    color: var(--bg);
  }
  @media (forced-colors: active) {
    .cell.rec {
      outline: 1px solid Highlight;
      outline-offset: -1px;
    }
    .cell:focus-visible,
    .cell.rec:focus-visible,
    .chan:focus-visible {
      outline: 3px solid Highlight;
      outline-offset: -3px;
    }
    .now-line,
    .now-dot {
      background: CanvasText;
    }
  }
</style>
