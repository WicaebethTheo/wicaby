<script lang="ts">
  // The page layer: every mounted page (lib/nav.svelte.ts), the top one shown. Pages under it stay mounted and keep
  // their scroll position. Motion is the iOS navigation controller's: a pushed page slides in from the right over
  // the previous one, which drifts left and dims; a full-screen page rises from the bottom. Swiping from the left
  // edge drags the top page back with the finger (a standalone web app gets no system back gesture), and lets go
  // to the side the finger was heading. Only transform and opacity move, on the compositor.
  import type { Snippet } from 'svelte';
  import { ease, reducedMotion, tabIn } from '../lib/motion';
  import { handleBack, isFullScreen, mounted, shell, stack, type Entry } from '../lib/nav.svelte';
  import PageScope from './PageScope.svelte';

  let { page }: { page: Snippet<[Entry]> } = $props();

  const EDGE = 24; // px from the left edge where the back swipe starts
  // By key: the same entry sits in both state arrays as two proxies.
  const top = $derived(stack[stack.length - 1]);
  const under = $derived(stack[stack.length - 2]);
  const shown = $derived(new Set(stack.map((e) => e.key)));

  function role(e: Entry): 'top' | 'behind' | 'covered' | 'away' {
    if (e.key === top?.key) return 'top';
    if (!shown.has(e.key)) return 'away';
    // Under a full-screen page nothing moves: it is covered, then hidden.
    return top && isFullScreen(top.route) ? 'covered' : 'behind';
  }

  // A tab switch or a reset shows its page at once: no slide. A tab showing a pushed page brings it in from the
  // side of the tab tapped (a tab at its root: screens/Main.svelte).
  let lastTab = shell.tab;
  $effect(() => {
    const tab = shell.tab;
    if (tab === lastTab) return;
    lastTab = tab;
    const e = stack[stack.length - 1];
    if (shell.op !== 'tab' || !e || e.route.name === 'main' || isFullScreen(e.route)) return;
    queueMicrotask(() => {
      const node = layer?.querySelector(`[data-key="${e.key}"]`);
      if (node) tabIn(node, shell.dir);
    });
  });
  let instant = $state(true);
  $effect.pre(() => {
    instant = shell.op === 'tab' || shell.op === 'reset';
  });

  // The page enters: slid in from the right, or up for a full-screen page, on a push only.
  function enter(node: HTMLElement, e: Entry) {
    if (shell.op !== 'push' || reducedMotion()) return { duration: 0 };
    const up = isFullScreen(e.route);
    return {
      duration: up ? 440 : 400,
      easing: ease,
      css: (t: number) => (up ? `transform: translate3d(0, ${(1 - t) * 100}%, 0)` : `transform: translate3d(${(1 - t) * 100}%, 0, 0)`),
    };
  }

  // The page leaves on Back: the way it came. After a completed swipe it is already off screen.
  let swiped = false;
  function leave(node: HTMLElement, e: Entry) {
    if (swiped || shell.op !== 'back' || reducedMotion()) {
      swiped = false;
      return { duration: 0 };
    }
    const down = isFullScreen(e.route);
    return {
      duration: 400,
      easing: ease,
      css: (t: number) => (down ? `transform: translate3d(0, ${(1 - t) * 100}%, 0)` : `transform: translate3d(${(1 - t) * 100}%, 0, 0)`),
    };
  }

  // ---- The back swipe ----
  let layer: HTMLElement;
  const el = (e: Entry | undefined) => (e ? layer.querySelector<HTMLElement>(`[data-key="${e.key}"]`) : null);

  function onTouchStart(ev: TouchEvent) {
    const t = ev.touches[0];
    if (ev.touches.length !== 1 || t.clientX > EDGE || !top || !under || isFullScreen(top.route)) return;
    const a = el(top);
    const b = el(under);
    if (!a || !b) return;
    const width = layer.clientWidth;
    const x0 = t.clientX;
    const y0 = t.clientY;
    let locked: boolean | null = null; // null until the finger shows its direction
    let dx = 0;
    let samples: { x: number; t: number }[] = [];

    const place = (x: number, animate: boolean) => {
      for (const n of [a, b]) n.style.transition = animate ? 'transform 300ms cubic-bezier(0.2, 0.9, 0.3, 1)' : 'none';
      a.style.transform = `translate3d(${x}px, 0, 0)`;
      b.style.transform = `translate3d(${-0.3 * (width - x)}px, 0, 0)`;
      b.style.setProperty('--dim', String(0.25 * (1 - x / width)));
    };

    const move = (e: TouchEvent) => {
      const p = e.touches[0];
      const mx = p.clientX - x0;
      const my = p.clientY - y0;
      if (locked === null) {
        if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
        locked = mx > Math.abs(my);
        if (!locked) return end();
        b.classList.add('peek');
      }
      e.preventDefault();
      dx = Math.max(0, mx);
      const now = performance.now();
      samples = [...samples.filter((s) => now - s.t < 100), { x: dx, t: now }];
      place(dx, false);
    };

    const end = () => {
      window.removeEventListener('touchmove', move);
      window.removeEventListener('touchend', end);
      window.removeEventListener('touchcancel', end);
      if (!locked) return;
      const first = samples[0];
      const last = samples[samples.length - 1];
      const velocity = first && last && last.t > first.t ? (last.x - first.x) / (last.t - first.t) : 0;
      const done = velocity > 0.35 || (velocity > -0.2 && dx > width * 0.4);
      place(done ? width : 0, true);
      a.addEventListener(
        'transitionend',
        () => {
          for (const n of [a, b]) {
            n.style.transition = '';
            n.style.transform = '';
            n.style.removeProperty('--dim');
          }
          b.classList.remove('peek');
          if (done) {
            swiped = true;
            handleBack();
          }
        },
        { once: true },
      );
    };

    window.addEventListener('touchmove', move, { passive: false });
    window.addEventListener('touchend', end);
    window.addEventListener('touchcancel', end);
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions (the edge swipe is a touch gesture; Back is also the bar's button) -->
<div class="layer" class:instant bind:this={layer} ontouchstart={onTouchStart}>
  {#each mounted as e (e.key)}
    {@const isTop = e.key === top?.key}
    <section class="page {role(e)}" data-key={e.key} data-screen-top={isTop ? '' : undefined} aria-hidden={!isTop} inert={!isTop} in:enter={e} out:leave={e}>
      <PageScope key={e.key}>{@render page(e)}</PageScope>
    </section>
  {/each}
</div>

<style>
  .layer {
    position: absolute;
    inset: 0;
    overflow: hidden;
    background: #000;
  }
  .layer {
    --page-move: 400ms;
  }
  .page {
    position: absolute;
    inset: 0;
    background: var(--bg);
    overflow: hidden;
    contain: strict;
    transition: transform var(--page-move) var(--ease);
    --dim: 0;
  }
  /* The previous page drifts left and dims, then hides once the move ends (visibility flips after the delay). */
  .page::after {
    content: '';
    position: absolute;
    inset: 0;
    background: #000;
    opacity: var(--dim);
    pointer-events: none;
    transition: opacity var(--page-move) var(--ease);
  }
  .behind {
    transform: translate3d(-30%, 0, 0);
    visibility: hidden;
    --dim: 0.25;
    transition: transform var(--page-move) var(--ease), visibility 0s linear var(--page-move);
  }
  .behind::after {
    transition: opacity var(--page-move) var(--ease);
  }
  .covered {
    visibility: hidden;
    transition: visibility 0s linear 420ms;
  }
  .away {
    visibility: hidden;
    transition: none;
  }
  .page:global(.peek) {
    visibility: visible;
    transition: none;
  }
  .instant .page,
  .instant .page::after {
    transition: none;
  }
  @media (prefers-reduced-motion: reduce) {
    .page,
    .page::after {
      transition: none;
    }
  }
  :global(:root[data-reduce-motion]) .page,
  :global(:root[data-reduce-motion]) .page::after {
    transition: none;
  }
</style>
