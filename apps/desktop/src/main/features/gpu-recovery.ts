import fs from 'node:fs';
import path from 'node:path';

// Chromium can end up compositing in software on its own when its GPU process cannot start (a driver it trips on, a
// shader cache left by a Mesa update, the GPU sandbox): the whole app is then slow and Linux in-window video is black
// (#14). On Linux, a start that ends in software relaunches once with the next, more conservative set of GPU switches;
// the first level that composites on the GPU is kept for later starts of this Wicaby and Electron version. When none
// does, the app runs in software and says so at start (index.ts).

// 0: the usual switches. 1: GPU caches cleared, no zero-copy, GPU rasterization or hardware video decode (the
// features most often behind a GPU process that dies at start; disable-accelerated-video-decode also skips VA-API's
// set-up before the sandbox). 2: also no GPU sandbox. 3: also another ANGLE backend: GLES on Wayland (Ozone Wayland
// refuses Chromium's Vulkan, and Vulkan with shared textures crashes RADV, electron#54553), Vulkan on X11. Texture
// mode only runs on Wayland, so never at a Vulkan level.
export const GPU_LEVELS = 4;
const STATE_FILE = 'gpu-state.json';
const TEXTURE_FILE = 'texture-check.json';
// Chromium's on-disk GPU caches (in sessionData); a stale one can crash the GPU process after a driver update.
const GPU_CACHES = ['GPUCache', 'ShaderCache', 'GrShaderCache', 'GraphiteDawnCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GPUPersistentCache'];

export interface GpuState {
  // `${app version}/${electron version}`: a new build tries the usual switches again.
  key: string;
  level: number;
  exhausted?: boolean;
}

// No enable-features at level 0: Chromium 152 removed CanvasOopRasterization, VaapiVideoDecoder and
// D3D11VideoDecoder, and AcceleratedVideoDecodeLinuxGL is on by default.
export function gpuSwitches(platform: NodeJS.Platform, level: number, wayland = false): [string, string?][] {
  if (platform === 'win32' || level <= 0) return [['enable-gpu-rasterization'], ['enable-zero-copy'], ['ignore-gpu-blocklist']];
  const s: [string, string?][] = [['ignore-gpu-blocklist'], ['disable-accelerated-video-decode']];
  if (level >= 2) s.push(['disable-gpu-sandbox']);
  if (level >= 3 && wayland) s.push(['use-angle', 'gles']);
  else if (level >= 3) s.push(['use-angle', 'vulkan'], ['enable-features', 'Vulkan,VulkanFromANGLE']);
  return s;
}

// The level this start uses: the saved one for this build, else 0 (also once every level failed).
export function gpuLevel(state: GpuState | null, key: string): number {
  return state && state.key === key && !state.exhausted ? Math.min(Math.max(0, Math.floor(state.level)), GPU_LEVELS - 1) : 0;
}

// After a start: keep the level that composites on the GPU, else try the next one (relaunch), else give up for this build.
export function nextGpuStep(state: GpuState | null, key: string, composited: boolean): { state: GpuState; relaunch: boolean } {
  const level = gpuLevel(state, key);
  const exhausted = state?.key === key && state.exhausted === true;
  if (composited || exhausted) return { state: { key, level, ...(exhausted && !composited ? { exhausted } : {}) }, relaunch: false };
  if (level + 1 < GPU_LEVELS) return { state: { key, level: level + 1 }, relaunch: true };
  return { state: { key, level: 0, exhausted: true }, relaunch: false };
}

export function readGpuState(userData: string): GpuState | null {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(userData, STATE_FILE), 'utf8')) as Partial<GpuState>;
    return typeof v.key === 'string' && typeof v.level === 'number' ? { key: v.key, level: v.level, exhausted: v.exhausted === true } : null;
  } catch {
    return null;
  }
}

// false when it could not be saved: the caller must not relaunch then, or every start would retry the same level.
export function writeGpuState(userData: string, state: GpuState): boolean {
  try {
    fs.writeFileSync(path.join(userData, STATE_FILE), JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export function clearGpuCaches(sessionData: string): void {
  for (const dir of GPU_CACHES) fs.rmSync(path.join(sessionData, dir), { recursive: true, force: true });
}

// Texture mode that failed for good on this machine (the picture check, frames never drawn or delivered, the GPU
// process lost during playback): remembered per build, GPU, driver, render node and switches level, so later starts
// go straight to mpv's own window. Another key (an update, a driver or level change) tries texture mode again.
export function readTextureCheck(userData: string, key: string): string | null {
  try {
    const v = JSON.parse(fs.readFileSync(path.join(userData, TEXTURE_FILE), 'utf8')) as { key?: unknown; failed?: unknown };
    return v.key === key && typeof v.failed === 'string' ? v.failed : null;
  } catch {
    return null;
  }
}

export function writeTextureCheck(userData: string, key: string, failed: string): void {
  try {
    fs.writeFileSync(path.join(userData, TEXTURE_FILE), JSON.stringify({ key, failed: failed.slice(0, 500) }));
  } catch {
    // Best effort: the next start tries texture mode again.
  }
}
