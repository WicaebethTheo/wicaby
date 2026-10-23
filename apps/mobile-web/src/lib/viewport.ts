// The app's height. In a Home Screen app with a translucent status bar, iOS 26+ lays the page out in a viewport
// shorter than the screen by the status bar's height, while drawing it full screen: anything sized or fixed to that
// viewport stops a status bar's height above the bottom (a band under the tab bar). When the gap is exactly the
// top safe area, the screen's height is the real one; otherwise (Safari, an iPad window) the viewport's is.
export function trackViewportHeight(): void {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;padding-top:env(safe-area-inset-top)';
  document.body.appendChild(probe);
  const apply = () => {
    const safeTop = parseFloat(getComputedStyle(probe).paddingTop) || 0;
    const portrait = window.innerHeight >= window.innerWidth;
    const screenH = portrait ? Math.max(screen.width, screen.height) : Math.min(screen.width, screen.height);
    const gap = screenH - window.innerHeight;
    const h = safeTop > 0 && Math.abs(gap - safeTop) <= 2 ? screenH : window.innerHeight;
    document.documentElement.style.setProperty('--app-height', `${h}px`);
  };
  apply();
  window.addEventListener('resize', apply);
  window.addEventListener('orientationchange', () => setTimeout(apply, 300));
}

// The top inset iOS gives the page (the status bar's height when the page draws under it, else 0).
export function topInset(): number {
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;padding-top:env(safe-area-inset-top)';
  document.body.appendChild(probe);
  const px = parseFloat(getComputedStyle(probe).paddingTop) || 0;
  probe.remove();
  return px;
}
