// A message with one action (Android Snackbar "Retiré · Annuler"): 5 s above the tab bar, a new one replaces it.
const SHOW_MS = 5_000;

export interface Snack {
  text: string;
  action: string;
  run: () => void;
}

export const snackbar = $state<{ snack: Snack | null; key: number }>({ snack: null, key: 0 });
let timer = 0;

export function showSnack(snack: Snack): void {
  clearTimeout(timer);
  snackbar.snack = snack;
  snackbar.key++;
  timer = window.setTimeout(() => (snackbar.snack = null), SHOW_MS);
}

export function dismissSnack(): void {
  clearTimeout(timer);
  snackbar.snack = null;
}
