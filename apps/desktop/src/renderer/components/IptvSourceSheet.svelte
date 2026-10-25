<script lang="ts">
  // "Add an IPTV source": an M3U playlist (address or file) and, optionally, an XMLTV guide (the playlist's url-tvg
  // is used when the field is empty). Main loads the playlist before storing anything; the addresses go to the
  // credential vault (an Xtream address carries the account) and never come back to this page.
  import { w } from '../lib/bridge';
  import { t } from '../lib/i18n.svelte';
  import { navigate } from '../lib/router.svelte';
  import { errorMessage, toast } from '../lib/stores.svelte';
  import Icon from './Icon.svelte';
  import Sheet from './Sheet.svelte';

  let {
    open,
    onclose,
    onback,
  }: {
    open: boolean;
    onclose: () => void;
    // Opened from Sources › Add: a back chevron returns to it.
    onback?: () => void;
  } = $props();

  let playlist = $state('');
  let guide = $state('');
  let name = $state('');
  let busy = $state(false);
  let error = $state('');

  async function pick(kind: 'playlist' | 'guide'): Promise<void> {
    const file = await w.iptv.pickFile(kind).catch((err) => (toast('error', errorMessage(err)), null));
    if (!file) return;
    if (kind === 'playlist') playlist = file;
    else guide = file;
    error = '';
  }

  async function add(): Promise<void> {
    if (!playlist.trim()) {
      error = t('iptv.add.playlistRequired');
      return;
    }
    busy = true;
    error = '';
    try {
      const info = await w.iptv.add({ playlist: playlist.trim(), guide: guide.trim() || undefined, name: name.trim() || undefined });
      toast('success', t('iptv.add.added', { name: info.name, count: info.channels }));
      close();
      navigate('/iptv?tab=now');
    } catch (err) {
      error = errorMessage(err);
    } finally {
      busy = false;
    }
  }

  function close(): void {
    playlist = guide = name = error = '';
    onclose();
  }

  function back(): void {
    close();
    onback?.();
  }
</script>

<Sheet {open} onclose={close} label={t('iptv.add.title')} width={560} align="top" onback={onback && back}>
  <form class="body" onsubmit={(e) => (e.preventDefault(), void add())}>
    <header class="sheet-head">
      {#if onback}
        <button type="button" class="icon-btn" onclick={back} aria-label={t('common.actions.back')} title={t('common.actions.back')}>
          <Icon name="chevronLeft" size={18} />
        </button>
      {/if}
      <h2 class="title-3">{t('iptv.add.title')}</h2>
    </header>
    <p class="blurb">{t('iptv.add.blurb')}</p>

    <div class="form">
      <label class="field-label" for="iptv-playlist">{t('iptv.add.playlist')}</label>
      <div class="line">
        <input
          id="iptv-playlist"
          class="field"
          type="text"
          spellcheck="false"
          autocomplete="off"
          placeholder="https://…/playlist.m3u"
          bind:value={playlist}
          oninput={() => (error = '')}
          aria-invalid={error ? 'true' : undefined}
          aria-describedby={error ? 'iptv-error' : undefined}
          data-autofocus
        />
        <button type="button" class="btn" onclick={() => pick('playlist')}><Icon name="file" size={15} /> {t('iptv.add.file')}</button>
      </div>
      <p class="hint">{t('iptv.add.playlistHint')}</p>
      <label class="field-label" for="iptv-guide">{t('iptv.add.guide')}</label>
      <div class="line">
        <input id="iptv-guide" class="field" type="text" spellcheck="false" autocomplete="off" placeholder="https://…/guide.xml.gz" bind:value={guide} />
        <button type="button" class="btn" onclick={() => pick('guide')}><Icon name="file" size={15} /> {t('iptv.add.file')}</button>
      </div>
      <p class="hint">{t('iptv.add.guideHint')}</p>
      <label class="field-label" for="iptv-name">{t('iptv.add.name')}</label>
      <input id="iptv-name" class="field" type="text" autocomplete="off" placeholder={t('iptv.add.namePlaceholder')} bind:value={name} />
      {#if error}<p class="error" id="iptv-error" role="alert">{error}</p>{/if}
    </div>

    <p class="hint">{t('iptv.add.limits')}</p>

    <div class="actions">
      <button type="submit" class="btn primary" disabled={busy}>{busy ? t('iptv.add.loading') : t('iptv.add.save')}</button>
    </div>
  </form>
</Sheet>

<style>
  /* The Sources sheets' anatomy (FileSourceSheet.svelte): title level with the close button, labels above fields. */
  .body {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 13px 24px 24px;
  }
  .sheet-head {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 32px;
    padding-right: 40px;
  }
  .sheet-head .title-3 {
    margin: 0;
  }
  .icon-btn {
    display: grid;
    place-items: center;
    width: 32px;
    height: 32px;
    margin-left: -8px;
    flex: none;
    border-radius: 50%;
    color: var(--label-2);
  }
  .icon-btn:hover,
  .icon-btn:focus-visible {
    background: var(--fill-2);
    color: var(--label);
  }
  .blurb {
    margin: -8px 0 0;
    color: var(--label-2);
    font-size: var(--fs-callout);
    line-height: 1.5;
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .field-label {
    font-size: var(--fs-footnote);
    font-weight: 600;
    color: var(--label-2);
  }
  .field-label:not(:first-child) {
    margin-top: 8px;
  }
  .field[aria-invalid='true'] {
    border-color: color-mix(in srgb, var(--danger) 60%, transparent);
  }
  .line {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .line .field {
    flex: 1;
    min-width: 0;
  }
  .line .btn {
    flex: none;
  }
  .error {
    margin: 4px 0 0;
    font-size: var(--fs-footnote);
    color: var(--danger);
  }
  .hint {
    margin: 0;
    font-size: var(--fs-footnote);
    color: var(--label-2);
    line-height: 1.5;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
  .actions .btn {
    min-width: 96px;
  }
</style>
