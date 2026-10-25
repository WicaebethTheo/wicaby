// Pure placement rules for the playback windows (no Electron at run time: tools/checks/playback-window-check.mjs
// imports this file). Playback must look like it happens in the main window: it opens in the main window's place
// and state, and the main window comes back in the place and state the user left the player in.
import type { Rectangle } from 'electron';

// Within the 1 px DIP rounding leaves between what was asked and what getBounds reports.
export const near = (a: Rectangle, b: Rectangle): boolean =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.width - b.width), Math.abs(a.height - b.height)) <= 1;

// The same size, shrunk to fit if needed, centred in the work area a.
export function centred(b: Rectangle, a: Rectangle): Rectangle {
  const width = Math.min(b.width, a.width);
  const height = Math.min(b.height, a.height);
  return { x: Math.round(a.x + (a.width - width) / 2), y: Math.round(a.y + (a.height - height) / 2), width, height };
}

export interface MainPlacement {
  bounds: Rectangle;
  normal: Rectangle;
  maximized: boolean;
  minimized: boolean;
  fullscreen: boolean;
}

// The pair's opening rectangle (work: the work area of the main window's monitor). Maximized: the work area, which
// Electron reports as maximized for a transparent window on Windows (getBounds of a maximized window overhangs the
// monitor by the invisible frame). Minimized or full screen (Reader, Slideshow): its restore rectangle. Otherwise its
// rectangle as is, a snapped half included.
export function playbackRect(m: MainPlacement, work: Rectangle): Rectangle {
  if (m.maximized) return work;
  return m.minimized || m.fullscreen ? m.normal : m.bounds;
}

// What the main window becomes after playback. player: the player's windowed rectangle (the one under full screen
// or PiP); filled: it is maximized (pair: it covers its work area, playerWork). bounds null: leave the rectangle,
// which also keeps Windows' snapped state (any setBounds drops it).
export function mainAfterPlayback(
  main: { bounds: Rectangle; normal: Rectangle; maximized: boolean; work: Rectangle },
  player: Rectangle,
  filled: boolean,
  playerWork: Rectangle,
): { maximize: boolean; bounds: Rectangle | null } {
  // Maximized on the player's monitor: the restore rectangle moves there first when it is on another one.
  if (filled) return { maximize: true, bounds: near(main.work, playerWork) ? null : centred(main.normal, playerWork) };
  return { maximize: false, bounds: !main.maximized && near(main.bounds, player) ? null : player };
}
