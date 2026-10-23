// Lengths: the TV scales 1rem to 1 dp of its layout; on a phone 1rem stays the CSS pixel (16px root, Dynamic Type
// through the root size), and a length in "dp" is a CSS pixel. Same exports as the TV's lib/screen.ts.
export const lite = false;

export function initScreen(): void {}

export function dp(n: number): number {
  return n;
}
