// One dialog at a time over the pages (the TV's lib/overlay.svelte.ts, same exports): a title, an optional message
// and actions, drawn as an iOS alert (two actions) or action sheet (more, or a picker).
export interface AlertAction {
  label: string;
  destructive?: boolean;
  run: () => void;
}

export interface Alert {
  title: string;
  message?: string;
  actions: AlertAction[];
  // The TV's initial focus; the phone has none, kept for the shared callers.
  focusIndex?: number;
  // A picker: the chosen action gets a check.
  selected?: number;
  // A link the TV shows as a QR code: the phone opens it instead (components/AlertDialog.svelte).
  qr?: string;
}

export const overlay = $state<{ alert: Alert | null }>({ alert: null });

export function showAlert(alert: Alert): void {
  overlay.alert = alert;
}

export function closeAlert(): void {
  overlay.alert = null;
}
