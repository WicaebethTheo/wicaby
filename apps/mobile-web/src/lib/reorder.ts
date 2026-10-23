// Reordering a list by hand (the Home Screen's way): a long press lifts an item, which then follows the finger;
// the others make way as it passes their middle, and letting go drops it there. A finger that moves before the
// press is long is a scroll, left alone. Near the top or the bottom of the page, the page scrolls along.
// use:reorder={{ item: '.lib', onlift, onmove, ondrop }}: the list's direct items are the ones matching `item`;
// onmove(from, to) reorders the data (the list draws itself again with the lifted item moved).
import { haptic } from './haptic';

export interface ReorderOptions {
  item: string;
  onlift?: (index: number) => void;
  onmove: (from: number, to: number) => void;
  ondrop: () => void;
}

const PRESS_MS = 420;
const SLOP = 8;
const EDGE = 90;

export function reorder(list: HTMLElement, options: ReorderOptions) {
  let opts = options;
  let timer = 0;
  let start = { x: 0, y: 0 };
  let finger = { x: 0, y: 0 };
  let drag: { el: HTMLElement; index: number; grabX: number; grabY: number } | null = null;
  let scrollFrame = 0;

  const items = () => Array.from(list.children).filter((c): c is HTMLElement => c instanceof HTMLElement && c.matches(opts.item));
  const scroller = () => list.closest<HTMLElement>('[data-scroll]') ?? document.scrollingElement;

  // The lifted item under the finger: its translation from where the layout puts it.
  function place(): void {
    if (!drag) return;
    const box = list.getBoundingClientRect();
    const x = finger.x - drag.grabX - (box.left + drag.el.offsetLeft);
    const y = finger.y - drag.grabY - (box.top + drag.el.offsetTop);
    drag.el.style.transform = `translate3d(${x}px, ${y}px, 0) scale(1.04)`;
  }

  // The item whose place is nearest the lifted one's middle takes it.
  function target(): number {
    if (!drag) return -1;
    const box = list.getBoundingClientRect();
    const cx = finger.x - drag.grabX + drag.el.offsetWidth / 2;
    const cy = finger.y - drag.grabY + drag.el.offsetHeight / 2;
    let best = drag.index;
    let bestD = Infinity;
    items().forEach((el, i) => {
      const ex = box.left + el.offsetLeft + el.offsetWidth / 2;
      const ey = box.top + el.offsetTop + el.offsetHeight / 2;
      const d = (ex - cx) ** 2 + (ey - cy) ** 2;
      if (d < bestD) (bestD = d), (best = i);
    });
    return best;
  }

  function follow(): void {
    if (!drag) return;
    const to = target();
    if (to !== drag.index) {
      opts.onmove(drag.index, to);
      drag.index = to;
      // Placed again once the list has redrawn with the item at its new place.
      requestAnimationFrame(place);
    }
    place();
  }

  function autoScroll(): void {
    scrollFrame = 0;
    const s = scroller();
    if (!drag || !s) return;
    const top = s === document.scrollingElement ? 0 : s.getBoundingClientRect().top;
    const bottom = s === document.scrollingElement ? window.innerHeight : s.getBoundingClientRect().bottom;
    const step = finger.y < top + EDGE ? -Math.ceil((top + EDGE - finger.y) / 6) : finger.y > bottom - EDGE ? Math.ceil((finger.y - bottom + EDGE) / 6) : 0;
    if (!step) return;
    s.scrollTop += step;
    follow();
    scrollFrame = requestAnimationFrame(autoScroll);
  }

  function lift(el: HTMLElement): void {
    const r = el.getBoundingClientRect();
    drag = { el, index: items().indexOf(el), grabX: start.x - r.left, grabY: start.y - r.top };
    el.classList.add('lifted');
    list.classList.add('reordering');
    haptic();
    opts.onlift?.(drag.index);
    place();
  }

  function onStart(e: TouchEvent): void {
    if (e.touches.length !== 1) return cancel();
    const el = (e.target as Element).closest<HTMLElement>(opts.item);
    if (!el || el.parentElement !== list) return;
    start = finger = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    timer = window.setTimeout(() => lift(el), PRESS_MS);
  }

  function onMove(e: TouchEvent): void {
    const t = e.touches[0];
    finger = { x: t.clientX, y: t.clientY };
    if (!drag) {
      if (Math.abs(finger.x - start.x) > SLOP || Math.abs(finger.y - start.y) > SLOP) cancel();
      return;
    }
    // Lifted: the page does not scroll under the finger.
    e.preventDefault();
    follow();
    scrollFrame ||= requestAnimationFrame(autoScroll);
  }

  function onEnd(e: TouchEvent): void {
    clearTimeout(timer);
    if (!drag) return;
    // No tap on the item dropped.
    e.preventDefault();
    const { el } = drag;
    drag = null;
    cancelAnimationFrame(scrollFrame);
    scrollFrame = 0;
    el.classList.remove('lifted');
    list.classList.remove('reordering');
    // Settles into its place.
    el.style.transition = 'transform 260ms cubic-bezier(0.32, 0.72, 0, 1)';
    el.style.transform = '';
    el.addEventListener('transitionend', () => (el.style.transition = ''), { once: true });
    haptic();
    opts.ondrop();
  }

  function cancel(): void {
    clearTimeout(timer);
  }

  list.addEventListener('touchstart', onStart, { passive: true });
  list.addEventListener('touchmove', onMove, { passive: false });
  list.addEventListener('touchend', onEnd, { passive: false });
  list.addEventListener('touchcancel', onEnd, { passive: false });
  // No callout or selection on the long press.
  list.addEventListener('contextmenu', (e) => e.preventDefault());
  return {
    update: (next: ReorderOptions) => (opts = next),
    destroy: () => {
      cancel();
      list.removeEventListener('touchstart', onStart);
      list.removeEventListener('touchmove', onMove);
      list.removeEventListener('touchend', onEnd);
      list.removeEventListener('touchcancel', onEnd);
    },
  };
}
