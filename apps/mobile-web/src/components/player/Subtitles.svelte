<script lang="ts">
  // The text subtitles over the picture, in the Settings look (size, style, colour, position), scaled to the
  // video's height so they read the same in portrait and landscape, raised over the controls while they show.
  // `contained`: in a small frame (the Settings preview), without the screen's safe areas.
  import { settings } from '$tv/settings.svelte';
  import type { Cue } from '$tv/subtitles';
  import { drawPgs, type PgsPart, type PgsPicture } from '../../media/pgs';

  let { cues, raised = false, contained = false }: { cues: Cue[]; raised?: boolean; contained?: boolean } = $props();

  const SIZES = [0.75, 1, 1.25, 1.5];
  const COLORS = ['#fff', '#ffe14d', '#d1d1d6'];
  const POSITIONS = [4, 9, 16];
  const FONTS = ['inherit', '-apple-system, system-ui, sans-serif', 'ui-serif, "New York", Georgia, serif'];
  const at = <T,>(list: T[], i: number): T => list[Math.max(0, Math.min(list.length - 1, i))];
  const style = $derived(settings.subtitleStyle.value);

  // PGS pictures sit where the disc put them on its frame, the frame fitted in the screen as the video is.
  const pictures = $derived(cues.flatMap((c) => ((c as Cue & { pgs?: PgsPicture }).pgs ? [(c as Cue & { pgs: PgsPicture }).pgs] : [])));
  const texts = $derived(pictures.length ? cues.filter((c) => !(c as Cue & { pgs?: PgsPicture }).pgs) : cues);
  let boxW = $state(0);
  let boxH = $state(0);
  function place(p: PgsPicture, part: PgsPart): string {
    const k = Math.min(boxW / p.frameWidth, boxH / p.frameHeight);
    const x = (boxW - p.frameWidth * k) / 2 + part.x * k;
    const y = (boxH - p.frameHeight * k) / 2 + part.y * k;
    return `left:${x}px;top:${y}px;width:${part.width * k}px;height:${part.height * k}px`;
  }
  function paint(canvas: HTMLCanvasElement, [part, palette]: [PgsPart, Uint32Array]) {
    drawPgs(canvas, part, palette);
  }
</script>

{#if pictures.length}
  <div class="pictures" bind:clientWidth={boxW} bind:clientHeight={boxH} aria-hidden="true">
    {#each pictures as p (p)}
      {#each p.parts as part, i (i)}
        <canvas use:paint={[part, p.palette]} style={place(p, part)}></canvas>
      {/each}
    {/each}
  </div>
{/if}

{#if texts.length}
  <div class="layer" class:raised class:contained style:font-family={at(FONTS, settings.subtitleFont.value)} style:--size={at(SIZES, settings.subtitleSize.value)} style:--pos="{at(POSITIONS, settings.subtitlePosition.value)}%">
    {#each texts as cue (cue.startMs + cue.html)}
      <span class="cue" class:outline={style === 0} class:shadow={style === 1} class:box={style === 2} style:color={at(COLORS, settings.subtitleColor.value)}>{@html cue.html}</span>
    {/each}
  </div>
{/if}

<style>
  .layer {
    position: absolute;
    left: max(16px, var(--safe-left));
    right: max(16px, var(--safe-right));
    bottom: calc(var(--pos) + var(--safe-bottom));
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    pointer-events: none;
    text-align: center;
    transition: transform var(--t-med) var(--ease);
  }
  .layer.raised {
    transform: translateY(-110px);
  }
  .pictures {
    position: absolute;
    inset: 0;
    pointer-events: none;
  }
  .pictures canvas {
    position: absolute;
  }
  .contained {
    left: 12px;
    right: 12px;
    bottom: var(--pos);
  }
  .contained .cue {
    font-size: calc(var(--size) * 15px);
  }
  .cue {
    font-size: calc(var(--size) * clamp(16px, 4.6vmin, 34px));
    font-weight: 600;
    line-height: 1.25;
    max-width: 92%;
  }
  .outline {
    -webkit-text-stroke: 0;
    text-shadow:
      0 0 3px #000,
      0 0 3px #000,
      1px 1px 2px #000,
      -1px -1px 2px #000;
  }
  .shadow {
    text-shadow: 2px 2px 6px rgb(0 0 0 / 0.9);
  }
  .box {
    background: rgb(0 0 0 / 0.72);
    padding: 2px 10px;
    border-radius: 6px;
  }
</style>
