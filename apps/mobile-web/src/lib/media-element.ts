// One <video> element for every playback, unlocked at the first touch in the app. iOS lets a page start sound only
// from a user's gesture, element by element; the player page loads on demand and its stream opens after network
// round trips, long after the Play tap. A load() during any early tap lifts the restriction for this element for
// good, so playback can start whenever the stream is ready.
export const video: HTMLVideoElement = (() => {
  const v = document.createElement('video');
  v.playsInline = true;
  v.preload = 'auto';
  v.className = 'app-video';
  return v;
})();

export function unlockOnFirstTouch(): void {
  const unlock = () => {
    window.removeEventListener('pointerup', unlock, true);
    window.removeEventListener('touchend', unlock, true);
    if (!video.src && !video.srcObject) video.load();
    if (!decoy.srcObject) decoy.load();
    makeSilence();
  };
  window.addEventListener('pointerup', unlock, true);
  window.addEventListener('touchend', unlock, true);
}

// iOS shows a Home Screen app's own video in the Dynamic Island while the app is open (Safari does not, for its own
// tabs). WebKit leaves a page out of Now Playing when the media element its Media Session would control plays a
// MediaStream and the page set no metadata and no action handlers: the rule for video calls
// (MediaElementSession::hasNowPlayingInfo). That element is picked among the visible ones, those large enough to
// be main content first (400 × 300 CSS px). So a full-size decoy plays a silent stream under the picture, and the
// picture's own element is laid out small and scaled up (Player.svelte .stage). Its sound stays the element's own:
// every codec, every channel, the silent switch ignored.
export const decoy: HTMLVideoElement = (() => {
  const v = document.createElement('video');
  v.playsInline = true;
  v.className = 'app-decoy';
  return v;
})();

let silence: { ctx: AudioContext; stream: MediaStream } | null = null;

function makeSilence(): void {
  if (silence || typeof AudioContext === 'undefined') return;
  try {
    const ctx = new AudioContext();
    silence = { ctx, stream: ctx.createMediaStreamDestination().stream };
    // Started by a touch, so it may resume later without one; idle until a video plays.
    void ctx.suspend();
  } catch {
    // No Web Audio: the Dynamic Island shows the video, as before.
  }
}

export function hideNowPlaying(on: boolean): void {
  if (!on || !silence) {
    decoy.pause();
    decoy.srcObject = null;
    void silence?.ctx.suspend();
    return;
  }
  void silence.ctx.resume();
  decoy.srcObject = silence.stream;
  void decoy.play().catch(() => {});
}
