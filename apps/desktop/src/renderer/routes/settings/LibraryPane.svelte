<script lang="ts">
  import { LIBRARY_SORTS } from '../../../shared/contract';
  import Icon from '../../components/Icon.svelte';
  import Picker from '../../components/Picker.svelte';
  import Segmented from '../../components/Segmented.svelte';
  import Toggle from '../../components/Toggle.svelte';
  import HeroSettings from './HeroSettings.svelte';
  import { libraryRef } from '../../lib/api';
  import { t } from '../../lib/i18n.svelte';
  import { navigate } from '../../lib/router.svelte';
  import { errorMessage, libraries, multiServer, serverName, settings, toast } from '../../lib/stores.svelte';
  import { set } from './shared.svelte';
  import { GROUPS } from '../../lib/sidebar-groups';
  import { MDBLIST_KEY_URL } from '../../../shared/ratings';
  import { w } from '../../lib/bridge';

  const s = $derived(settings.value);

  // External ratings: the MDBList key lives in main's vault and never comes back to the page.
  let ratingsOn = $state(false);
  let ratingsKey = $state('');
  let ratingsBusy = $state(false);
  void w.ratings.configured().then((v) => (ratingsOn = v), () => undefined);
  async function saveRatingsKey(key: string): Promise<void> {
    ratingsBusy = true;
    try {
      ratingsOn = await w.ratings.setKey(key);
      ratingsKey = '';
      if (ratingsOn) toast('success', t('settings.library.ratings.set'));
    } catch (err) {
      toast('error', errorMessage(err));
    } finally {
      ratingsBusy = false;
    }
  }

  const browsable = $derived(libraries.list.filter((l) => !['playlists', 'livetv', 'folders'].includes(l.CollectionType ?? '')));
  const startPages = $derived([
    { value: 'home', label: t('settings.general.startPage.home') },
    { value: 'favorites', label: t('settings.general.startPage.favorites') },
    ...browsable.map((l) => ({ value: `library:${libraryRef(l)}`, label: multiServer() ? `${l.Name} · ${serverName(l.ServerId)}` : l.Name })),
    // A library this account no longer sees keeps a readable entry until it is changed.
    ...(s && s.ui.startPage.startsWith('library:') && !browsable.some((l) => `library:${libraryRef(l)}` === s.ui.startPage)
      ? [{ value: s.ui.startPage, label: t('settings.general.startPage.missing') }]
      : []),
  ]);
</script>

{#if s}
  <h3 class="gh">{t('settings.library.home')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.general.startPage.label')}</div>
        <div class="desc">{t('settings.general.startPage.desc')}</div>
      </div>
      <Picker label={t('settings.general.startPage.label')} value={s.ui.startPage} options={startPages} onchange={(v) => set({ ui: { startPage: v } })} />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('files.home.label')}</div>
        <div class="desc">{t('files.home.desc')}</div>
      </div>
      <Toggle label={t('files.home.label')} checked={s.ui.filesOnHome === true} onchange={(v) => set({ ui: { filesOnHome: v } })} />
    </div>
    <button type="button" class="row link-row" onclick={() => navigate('/home?customize=1')}>
      <div class="txt">
        <div class="lbl">{t('settings.library.customizeHome.label')}</div>
        <div class="desc">{t('settings.library.customizeHome.desc')}</div>
      </div>
      <span class="chev"><Icon name="chevronRight" size={16} /></span>
    </button>
  </div>

  <HeroSettings />

  <h3 class="gh">{t('settings.library.libraries')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.library.sort.label')}</div>
        <div class="desc">{t('settings.library.sort.desc')}</div>
      </div>
      <Picker
        label={t('settings.library.sort.label')}
        value={s.ui.librarySort}
        options={LIBRARY_SORTS.map((k) => ({ value: k, label: t(`settings.library.sorts.${k}`) }))} onchange={(v) => set({ ui: { librarySort: v } })} />
    </div>
    <div class="row">
      <div class="txt"><div class="lbl">{t('settings.library.order.label')}</div></div>
      <Segmented
        label={t('settings.library.order.label')}
        value={s.ui.librarySortDesc ? 'desc' : 'asc'}
        options={[
          { value: 'asc', label: t('settings.library.order.asc') },
          { value: 'desc', label: t('settings.library.order.desc') },
        ]}
        onchange={(v) => set({ ui: { librarySortDesc: v === 'desc' } })}
      />
    </div>
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.library.view.label')}</div>
        <div class="desc">{t('settings.library.view.desc')}</div>
      </div>
      <Segmented
        label={t('settings.library.view.label')}
        value={s.ui.libraryView}
        options={[
          { value: 'poster', label: t('settings.library.view.poster') },
          { value: 'thumb', label: t('settings.library.view.thumb') },
        ]}
        onchange={(v) => set({ ui: { libraryView: v } })}
      />
    </div>
  </div>
  <p class="foot">{t('settings.library.foot')}</p>

  <h3 class="gh">{t('settings.library.sidebar')}</h3>
  <div class="group">
    {#each GROUPS as id (id)}
      {@const label = t(`shell.sidebar.groups.${id}`)}
      <div class="row">
        <div class="txt"><div class="lbl">{label}</div></div>
        <Toggle
          {label}
          checked={!s.ui.sidebarHidden.includes(id)}
          onchange={(v) => set({ ui: { sidebarHidden: v ? s.ui.sidebarHidden.filter((x) => x !== id) : [...s.ui.sidebarHidden, id] } })}
        />
      </div>
    {/each}
  </div>
  <p class="foot">{t('settings.library.sidebarFoot')}</p>

  <h3 class="gh">{t('settings.library.ratings.title')}</h3>
  <div class="group">
    <div class="row">
      <div class="txt">
        <div class="lbl">{t('settings.library.ratings.label')}</div>
        <div class="desc">{t('settings.library.ratings.desc')}</div>
      </div>
      <button type="button" class="btn sm" onclick={() => w.app.openExternal(MDBLIST_KEY_URL)}>{t('settings.library.ratings.get')}</button>
    </div>
    <div class="row">
      <input
        class="field key"
        type="password"
        autocomplete="off"
        spellcheck="false"
        aria-label={t('settings.library.ratings.label')}
        placeholder={ratingsOn ? t('settings.library.ratings.saved') : ''}
        bind:value={ratingsKey}
        onkeydown={(e) => e.key === 'Enter' && ratingsKey.trim() && void saveRatingsKey(ratingsKey)}
      />
      {#if ratingsOn}
        <button type="button" class="btn sm" disabled={ratingsBusy} onclick={() => saveRatingsKey('')}>{t('settings.library.ratings.remove')}</button>
      {/if}
      <button type="button" class="btn sm primary" disabled={ratingsBusy || !ratingsKey.trim()} onclick={() => saveRatingsKey(ratingsKey)}>{t('settings.library.ratings.save')}</button>
    </div>
  </div>
  <p class="foot">{t('settings.library.ratings.hint')}</p>
{/if}

<style>
  .gh {
    margin: 30px 0 8px 2px;
    font-size: var(--fs-footnote);
    font-weight: 500;
    color: var(--label-3);
  }
  .foot {
    margin: 10px 2px 0;
    font-size: var(--fs-footnote);
    color: var(--label-3);
    line-height: 1.5;
  }
  .group {
    border-radius: var(--r-sm);
    background: var(--bg-elevated);
    box-shadow: inset 0 0 0 1px var(--separator);
    overflow: hidden;
  }
  .row {
    position: relative;
    display: flex;
    align-items: center;
    gap: 16px;
    min-height: 58px;
    padding: 12px 18px;
  }
  /* Hairline between rows, inset to the text edge. */
  .row + .row::before {
    content: '';
    position: absolute;
    top: 0;
    left: 18px;
    right: 0;
    height: 1px;
    background: var(--separator);
  }
  .txt {
    min-width: 0;
    flex: 1;
    display: flex;
    flex-direction: column;
  }
  .lbl {
    display: flex;
    align-items: baseline;
    gap: 10px;
    font-size: var(--fs-body);
    font-weight: 500;
    color: var(--label);
  }
  .desc {
    display: block;
    margin-top: 2px;
    font-size: var(--fs-footnote);
    color: var(--label-3);
    line-height: 1.45;
  }
  .key {
    flex: 1;
    min-width: 0;
  }
  .btn.sm {
    height: 30px;
    padding: 0 12px;
    font-size: var(--fs-footnote);
  }
  .link-row {
    width: 100%;
    text-align: left;
    color: var(--label);
  }
  .link-row:hover,
  .link-row:focus-visible {
    background: var(--fill-1);
  }
  .chev {
    flex: none;
    display: grid;
    color: var(--label-3);
  }
  :global(.searching) .foot {
    display: none;
  }
  /* Hairlines only between rows that are still shown. */
  :global(.searching) .row::before {
    display: none;
  }
  :global(.searching) .row:not([hidden]) ~ .row:not([hidden])::before {
    display: block;
  }

  /* Compact density tightens these rows as well. */
  :global(html[data-density='compact']) .row {
    min-height: 50px;
    padding-block: 9px;
  }
</style>
