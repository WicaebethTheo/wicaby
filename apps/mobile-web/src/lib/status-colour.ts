// The status bar's colour (app.css .status-colour): iOS paints the status bar with it, solid (its only way without
// the blur). The canvas by default; the player's black over a video; at the top of Home, the colour along the top
// edge of the featured title's artwork, so the artwork seems to run on under the clock.
import type { BaseItem } from '$shared/models';
import type { Api } from '$tv/api';

let page: string | null = null;
let player = false;

function apply(): void {
  const root = document.documentElement.style;
  const c = player ? '#000' : page;
  if (c) root.setProperty('--status-colour', c);
  else root.removeProperty('--status-colour');
}

export function setPageStatusColour(c: string | null): void {
  page = c;
  apply();
}

export function setPlayerStatus(on: boolean): void {
  player = on;
  apply();
}

// ---- The colour along an artwork's top edge ----

const B83 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz#$%*+,-.:;=?@[]^_{|}~';
const b83 = (s: string) => [...s].reduce((v, ch) => v * 83 + B83.indexOf(ch), 0);
const toLinear = (v: number) => {
  const x = v / 255;
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
};
const toSrgb = (v: number) => {
  const x = Math.max(0, Math.min(1, v));
  return Math.round((x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055) * 255);
};

// A BlurHash's top row, averaged across: at y = 0 every vertical cosine is 1 and the horizontal ones average out, so
// it is the sum of the first column's components.
export function blurhashTop(hash: string | undefined): string | undefined {
  if (!hash || hash.length < 6) return undefined;
  const size = b83(hash[0]);
  const nx = (size % 9) + 1;
  const ny = Math.floor(size / 9) + 1;
  if (hash.length !== 4 + 2 * nx * ny) return undefined;
  const maxAc = (b83(hash[1]) + 1) / 166;
  const dc = b83(hash.slice(2, 6));
  const rgb = [toLinear(dc >> 16), toLinear((dc >> 8) & 255), toLinear(dc & 255)];
  const signPow = (v: number) => Math.sign(v) * v * v;
  for (let j = 1; j < ny; j++) {
    const at = 4 + 2 * (j * nx - 1);
    const v = b83(hash.slice(at, at + 2));
    const q = [Math.floor(v / 361), Math.floor(v / 19) % 19, v % 19];
    for (let k = 0; k < 3; k++) rgb[k] += signPow((q[k] - 9) / 9) * maxAc;
  }
  return `rgb(${toSrgb(rgb[0])},${toSrgb(rgb[1])},${toSrgb(rgb[2])})`;
}

const sampled = new Map<string, Promise<string | undefined>>();

// The artwork itself, read at 48 px wide (the server allows the page's origin, as for every call): the average of
// its top rows. Undefined when it cannot be read (an image the canvas may not read).
function sampleTop(url: string): Promise<string | undefined> {
  let p = sampled.get(url);
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => {
        try {
          const w = 48;
          const h = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * w));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
          ctx.drawImage(img, 0, 0, w, h);
          const rows = Math.max(1, Math.round(h * 0.04));
          const d = ctx.getImageData(0, 0, w, rows).data;
          const sum = [0, 0, 0];
          for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) sum[k] += toLinear(d[i + k]);
          const n = d.length / 4;
          resolve(`rgb(${toSrgb(sum[0] / n)},${toSrgb(sum[1] / n)},${toSrgb(sum[2] / n)})`);
        } catch {
          resolve(undefined);
        }
      };
      img.onerror = () => resolve(undefined);
      img.src = url;
    });
    sampled.set(url, p);
  }
  return p;
}

// The colour along the top of a title's backdrop: read from the image, else its BlurHash.
export async function backdropTop(api: Api, item: BaseItem): Promise<string | undefined> {
  const url = api.backdrop(item, 48);
  const read = url ? await sampleTop(url) : undefined;
  if (read) return read;
  const tag = item.BackdropImageTags?.[0];
  const hashes = item.ImageBlurHashes?.Backdrop;
  return blurhashTop((tag && hashes?.[tag]) || (hashes ? Object.values(hashes)[0] : undefined));
}

// Between two rgb() colours, [t] of the way (the status bar follows a slide being swiped).
export function mixRgb(a: string, b: string, t: number): string {
  const pa = a.match(/\d+/g)?.map(Number) ?? [0, 0, 0];
  const pb = b.match(/\d+/g)?.map(Number) ?? pa;
  const c = pa.map((v, k) => Math.round(v + (pb[k] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// A CSS colour as rgb() (the canvas token is a hex): through the browser's own parsing.
export function toRgb(c: string): string {
  const probe = document.createElement('span');
  probe.style.color = c;
  document.body.appendChild(probe);
  const out = getComputedStyle(probe).color;
  probe.remove();
  return out;
}
