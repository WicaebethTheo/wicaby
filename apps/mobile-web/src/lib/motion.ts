// The app's motion, on iOS's curve (app.css --ease), as CSS animations (compositor: transform and opacity only):
// - sheet: a sheet comes up from below by its own height, so it starts out of sight however tall it is, and leaves
//   faster than it came; it can also be pulled down to close (dragDismiss);
// - pop: a menu or a dialog grows from its anchor (its transform-origin) as it fades in;
// - lift: a toast rises a little as it fades in.
// Settings > Appearance > Reduce motion (or the system's) turns them into a plain fade.
import type { TransitionConfig } from 'svelte/transition';

// A CSS cubic-bezier as an easing function (Newton's method on x, then y).
function bezier(x1: number, y1: number, x2: number, y2: number): (t: number) => number {
  const cx = 3 * x1,
    bx = 3 * (x2 - x1) - cx,
    ax = 1 - cx - bx;
  const cy = 3 * y1,
    by = 3 * (y2 - y1) - cy,
    ay = 1 - cy - by;
  const x = (s: number) => ((ax * s + bx) * s + cx) * s;
  const dx = (s: number) => (3 * ax * s + 2 * bx) * s + cx;
  return (t) => {
    let s = t;
    for (let i = 0; i < 6; i++) {
      const d = dx(s);
      if (Math.abs(d) < 1e-6) break;
      s -= (x(s) - t) / d;
    }
    s = Math.min(1, Math.max(0, s));
    return ((ay * s + by) * s + cy) * s;
  };
}

export const ease = bezier(0.32, 0.72, 0, 1);
export const reducedMotion = () => document.documentElement.hasAttribute('data-reduce-motion') || matchMedia('(prefers-reduced-motion: reduce)').matches;
const reduced = reducedMotion;

// in:sheet / out:sheet={{ duration: 240 }}. A pull in progress (--drag) carries on from where the finger left it.
export function sheet(node: HTMLElement, { duration = 420 }: { duration?: number } = {}): TransitionConfig {
  const h = node.offsetHeight + 16;
  return {
    duration: reduced() ? 0 : duration,
    easing: ease,
    css: (_t, u) => `transform: translate3d(0, calc(${(u * h).toFixed(1)}px + var(--drag, 0px)), 0)`,
  };
}

export function pop(node: HTMLElement, { start = 0.86, duration = 280 }: { start?: number; duration?: number } = {}): TransitionConfig {
  if (reduced()) return { duration: 160, css: (t) => `opacity: ${t}` };
  return { duration, easing: ease, css: (t, u) => `opacity: ${Math.min(1, t * 1.6)}; transform: scale(${(start + (1 - start) * t).toFixed(4)})` };
}

export function lift(node: HTMLElement, { y = 18, duration = 320 }: { y?: number; duration?: number } = {}): TransitionConfig {
  if (reduced()) return { duration: 160, css: (t) => `opacity: ${t}` };
  return { duration, easing: ease, css: (t, u) => `opacity: ${t}; transform: translate3d(0, ${(u * y).toFixed(1)}px, 0)` };
}

// A tab coming in: from the side of the tab tapped, a short way, as it fades in over the one it replaces.
export function tabIn(node: Element, dir: number): void {
  if (reduced()) return;
  node.animate(
    [
      { opacity: 0, transform: `translate3d(${dir * 36}px, 0, 0)` },
      { opacity: 1, transform: 'none' },
    ],
    { duration: 360, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' },
  );
}

// use:reveal: a block comes up and in the first time it scrolls into view (once; at once with Reduce motion).
export function reveal(node: HTMLElement) {
  if (reduced() || typeof IntersectionObserver === 'undefined') return;
  node.classList.add('reveal');
  const io = new IntersectionObserver(
    (entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      node.classList.add('revealed');
      io.disconnect();
    },
    { rootMargin: '0px 0px -6% 0px' },
  );
  io.observe(node);
  return { destroy: () => io.disconnect() };
}

// Pull the sheet down by its grip (the node, e.g. its handle and title) to close it: past a quarter of its height
// or with a flick it closes, else it springs back.
export function dragDismiss(grip: HTMLElement, onclose: () => void) {
  let close = onclose;
  let start: { y: number; t: number; id: number } | null = null;
  let last = { y: 0, t: 0 };
  let sheetEl: HTMLElement | null = null;
  const setDrag = (px: number) => sheetEl?.style.setProperty('--drag', `${px}px`);
  const down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    sheetEl = grip.closest<HTMLElement>('[role=dialog]');
    start = { y: e.clientY, t: e.timeStamp, id: e.pointerId };
    last = { y: e.clientY, t: e.timeStamp };
    if (sheetEl) sheetEl.style.transition = 'none';
  };
  const move = (e: PointerEvent) => {
    if (!start || e.pointerId !== start.id) return;
    const dy = e.clientY - start.y;
    // Upwards it resists (a fifth of the pull), as iOS's sheets.
    setDrag(dy > 0 ? dy : dy / 5);
    if (Math.abs(dy) > 4) grip.setPointerCapture?.(e.pointerId);
    last = { y: e.clientY, t: e.timeStamp };
  };
  const up = (e: PointerEvent) => {
    if (!start || e.pointerId !== start.id) return;
    const dy = e.clientY - start.y;
    const v = (e.clientY - last.y) / Math.max(1, e.timeStamp - last.t);
    start = null;
    const h = sheetEl?.offsetHeight ?? 400;
    if (dy > h / 4 || (dy > 24 && v > 0.5)) {
      close();
      return;
    }
    if (sheetEl) sheetEl.style.transition = 'transform 320ms cubic-bezier(0.32, 0.72, 0, 1)';
    setDrag(0);
  };
  grip.addEventListener('pointerdown', down);
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up);
  grip.addEventListener('pointercancel', up);
  return {
    update(next: () => void) {
      close = next;
    },
    destroy() {
      grip.removeEventListener('pointerdown', down);
      grip.removeEventListener('pointermove', move);
      grip.removeEventListener('pointerup', up);
      grip.removeEventListener('pointercancel', up);
    },
  };
}
