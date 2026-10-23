// A long press (Android's combinedClickable onLongClick): held still for 480 ms, it runs [run] and the click that
// would follow the release is swallowed. A move of more than 10 px (a scroll) cancels it.
// While held, the element sinks a little (app.css [data-holding]) so the menu is seen coming, and [hold] runs once
// the press looks meant (200 ms): what the menu needs can be fetched before it opens.
type Press = (() => void) | { run: () => void; hold?: () => void };

export function longpress(node: HTMLElement, press: Press) {
  let timer = 0;
  let early = 0;
  let start: { x: number; y: number } | null = null;
  let fired = false;
  let opts = typeof press === 'function' ? { run: press } : press;
  const rest = () => {
    clearTimeout(early);
    delete node.dataset.holding;
  };
  const cancel = () => {
    clearTimeout(timer);
    rest();
    start = null;
  };
  const down = (e: PointerEvent) => {
    if (e.button !== 0) return;
    fired = false;
    start = { x: e.clientX, y: e.clientY };
    early = window.setTimeout(() => {
      node.dataset.holding = '';
      opts.hold?.();
    }, 200);
    timer = window.setTimeout(() => {
      fired = true;
      start = null;
      rest();
      opts.run();
    }, 480);
  };
  const move = (e: PointerEvent) => {
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel();
  };
  const click = (e: MouseEvent) => {
    if (!fired) return;
    fired = false;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const menu = (e: Event) => e.preventDefault();
  node.addEventListener('pointerdown', down);
  node.addEventListener('pointermove', move);
  node.addEventListener('pointerup', cancel);
  node.addEventListener('pointercancel', cancel);
  node.addEventListener('click', click, true);
  node.addEventListener('contextmenu', menu);
  return {
    update(next: Press) {
      opts = typeof next === 'function' ? { run: next } : next;
    },
    destroy() {
      cancel();
      node.removeEventListener('pointerdown', down);
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', cancel);
      node.removeEventListener('pointercancel', cancel);
      node.removeEventListener('click', click, true);
      node.removeEventListener('contextmenu', menu);
    },
  };
}
