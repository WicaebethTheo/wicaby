// Text subtitles inside a Matroska file (SRT, ASS/SSA, WebVTT) as the app's cues (the TV web app's Cue: safe HTML,
// only <i>, <b>, <u> and line breaks kept). ASS styling beyond italics and bold is dropped: the app draws every
// subtitle with the Settings look.
import type { Cue } from '$tv/subtitles';
import type { Frame, Track } from './matroska';

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// A cue without a duration (rare in practice) stays this long.
const FALLBACK_MS = 4000;

function fromSrt(text: string): string {
  return escape(text.trim())
    .replace(/&lt;(\/?)([ibu])&gt;/gi, '<$1$2>')
    .replace(/&lt;\/?[^&]*&gt;/g, '')
    .replace(/\{\\[^}]*\}/g, '')
    .replace(/\r?\n/g, '<br>');
}

// ASS events in Matroska: "ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,Effect,Text" (SSA: "Marked" for
// Layer); the text is the ninth field and may hold commas.
function fromAss(line: string): string {
  const parts = line.split(',');
  const raw = parts.slice(8).join(',');
  let open = { i: false, b: false };
  const html = escape(raw)
    .replace(/\{([^}]*)\}/g, (_, tags: string) => {
      let out = '';
      for (const m of tags.matchAll(/\\([ib])([01])/g)) {
        const tag = m[1] as 'i' | 'b';
        const on = m[2] === '1';
        if (on && !open[tag]) out += `<${tag}>`;
        if (!on && open[tag]) out += `</${tag}>`;
        open = { ...open, [tag]: on };
      }
      return out;
    })
    .replace(/\\N/gi, '<br>')
    .replace(/\\h/g, ' ');
  return html + (open.b ? '</b>' : '') + (open.i ? '</i>' : '');
}

export function subtitleCue(t: Track, f: Frame): Cue | null {
  const text = new TextDecoder().decode(f.data);
  const html = t.codec === 'S_TEXT/ASS' || t.codec === 'S_TEXT/SSA' ? fromAss(text) : fromSrt(text);
  if (!html.replace(/<[^>]+>/g, '').trim()) return null;
  return { startMs: f.ptsMs, endMs: f.ptsMs + (f.durationMs ?? FALLBACK_MS), html };
}
