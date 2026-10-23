<script lang="ts">
  // The subtitle look on a frame, changing as the chips below it do.
  import { t } from '$tv/i18n.svelte';
  import Subtitles from '../player/Subtitles.svelte';

  const cues = $derived([{ startMs: 0, endMs: 1, html: t('web_subtitle_sample') }]);
</script>

<div class="frame" aria-hidden="true">
  <Subtitles {cues} contained />
</div>

<style>
  .frame {
    position: relative;
    aspect-ratio: 16 / 9;
    margin: 12px 16px 4px;
    border-radius: var(--r-md);
    overflow: hidden;
    background:
      radial-gradient(120% 90% at 70% 20%, #5b6b7a 0%, transparent 60%),
      linear-gradient(160deg, #2c3a2f 0%, #1a1f2a 55%, #3a2a22 100%);
  }
</style>
