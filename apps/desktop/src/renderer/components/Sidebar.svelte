<script lang="ts">
  // Three zones (.dev/sidebar-redesign-spec.md): a fixed head (toggle, Home, Favorites, Downloads), the user's content
  // grouped by media type in the scrolling middle, and a fixed foot (Administration, Settings, connection status).
  // Search lives in the title bar (Ctrl+K / Ctrl+F), so it has no row here.
  import { tick } from 'svelte';
  import { caps, isLocalSource, kindLabel } from '../../shared/server-caps';
  import type { BaseItem } from '../../shared/models';
  import { itemKey, itemPath } from '../lib/api';
  import { navigate, router } from '../lib/router.svelte';
  import { carriesTracks, droppedTracks } from '../lib/music-ui.svelte';
  import { addTo, list as listPlaylists } from '../lib/playlists';
  import { dataVersion, downloads, errorMessage, fileSessions, iptvSessions, libraries, liveTv, onlineSessions, photoSessions, session, settings, toast, updateSettings } from '../lib/stores.svelte';
  import { GROUPS, libraryRows, type GroupId } from '../lib/sidebar-groups';
  import Icon, { type IconName } from './Icon.svelte';
  import { t } from '../lib/i18n.svelte';
  import Logo from './Logo.svelte';
  import { immich, watchImmichSources } from '../lib/photos/immich.svelte';
  import ConnectionStatus from './ConnectionStatus.svelte';
  import { listedServers, type Level } from './ConnectionList.svelte';
  import { web } from '../lib/platform';

  interface Row {
    key: string;
    label: string;
    icon: IconName;
    go: string;
    active: boolean;
    /** Several servers signed in: the row's server name, in its tooltip and accessible name. */
    server?: string;
    /** Another row of the same group has the same label: the server name shows as a suffix. */
    clash?: boolean;
    off?: boolean;
    disabled?: boolean;
    badge?: number;
    kind?: 'photo' | 'immich';
  }

  const collapsed = $derived(settings.value?.ui.sidebarCollapsed ?? false);
  const offline = $derived(session.value.status === 'offline');
  const route = $derived(router.route);
  const activeDownloads = $derived(downloads.list.filter((d) => d.status === 'downloading' || d.status === 'queued').length);
  const server = $derived(session.value.server);
  const online = $derived(onlineSessions());
  const multi = $derived(online.length > 1);
  // The footer counts every signed-in server, so "2 servers / 1 offline" survives one of them going down.
  const signedIn = $derived(listedServers().length);
  // Administration appears only when the user administers at least one signed-in server.
  const isAdmin = $derived(online.some((s) => s.user?.isAdmin && caps(s.server.kind).admin));
  const down = $derived(session.value.sessions.filter((s) => s.status === 'offline' && !isLocalSource(s.server.kind)).length);
  const sources = $derived(fileSessions());
  const sourceIcon = (p?: string): IconName => (p === 'webdav' ? 'globe' : p === 'smb' ? 'server' : 'hardDrive');
  const photoSources = $derived(photoSessions());
  const immichShown = $derived(offline ? [] : immich.sources);
  watchImmichSources();

  const isActive = (name: string, lib?: BaseItem) =>
    route.name === name && (!lib || (route.params.id === lib.Id && (!route.params.server || route.params.server === lib.ServerId)));
  const serverName = (id?: string) => (multi ? online.find((s) => s.server.id === id)?.server.name : undefined);
  const named = (r: Row) => (r.server ? `${r.label} — ${r.server}` : r.label) + (r.off ? ` · ${t('files.manage.offline')}` : '');
  // The rail shows its own tooltip (railTip), so no native one there.
  const tip = (r: Row) => (!collapsed && (r.server || r.off) ? named(r) : undefined);

  const nav = $derived<Row[]>([
    { key: 'home', label: t('shell.nav.home'), icon: 'home', go: '/home', active: isActive('home'), disabled: offline },
    { key: 'favorites', label: t('shell.nav.favorites'), icon: 'heart', go: '/favorites', active: isActive('favorites'), disabled: offline },
    // The web TV app has no downloads, IPTV, file sources or administration (they need the desktop's main process).
    ...(web ? [] : [{ key: 'downloads', label: t('shell.nav.downloads'), icon: 'download' as const, go: '/downloads', active: isActive('downloads'), badge: activeDownloads }]),
  ]);
  const foot = $derived<Row[]>([
    ...(isAdmin && !offline && !web ? [{ key: 'admin', label: t('admin.title'), icon: 'admin' as const, go: '/admin', active: isActive('admin') }] : []),
    { key: 'settings', label: t('shell.nav.settings'), icon: 'settings', go: '/settings', active: isActive('settings') },
  ]);

  // Live TV rows deep-link into the page's tabs; ?tab=channels redirects to now, Scheduled sits with Recordings.
  // The now row says "Channels", so it doesn't repeat its "Live TV" header.
  const LIVE = [['now', 'live', 'shell.sidebar.channels'], ['guide', 'calendar', 'livetv.tabs.guide'], ['recordings', 'record', 'livetv.tabs.recordings']] as const;
  // Several servers: Movies & Shows clusters by kind (films, then series...), so same-name rows sit together.
  const WATCH: IconName[] = ['film', 'tv', 'trailer', 'collection']; // i18n-ignore (icon names)
  const tabOf = (name: string): string => {
    if (route.name !== name) return '';
    const tab = route.query.get('tab');
    return tab === 'guide' ? 'guide' : tab === 'recordings' || tab === 'scheduled' ? 'recordings' : 'now';
  };
  const liveTab = $derived(tabOf('livetv'));
  // IPTV (client-side sources, main/iptv): Channels and Guide of the IPTV page; Add while there is no source.
  const iptvTab = $derived(tabOf('iptv'));
  const hasIptv = $derived(iptvSessions().length > 0);

  // Every content row, by group, in server order then the server's view order.
  const rows = $derived.by(() => {
    const g = Object.fromEntries(GROUPS.map((id) => [id, [] as Row[]])) as Record<GroupId, Row[]>;
    if (!offline) {
      for (const { group, icon, lib } of libraryRows(libraries.list, musicLib?.ServerId))
        g[group].push({ key: itemKey(lib), label: lib.Name ?? '', icon, go: itemPath(lib, 'library'), active: isActive('library', lib), server: serverName(lib.ServerId) });
      if (multi) g.watch.sort((a, b) => WATCH.indexOf(a.icon) - WATCH.indexOf(b.icon));
      // Live TV needs the desktop's tuner handling (zap lists, reminders): not on the web TV app yet.
      if (liveTv.available && !web)
        for (const [id, icon, key] of LIVE) g.live.push({ key: id, label: t(key), icon, go: `/livetv?tab=${id}`, active: liveTab === id });
    }
    // TV en direct is always there: without a server tuner (or offline) one row opens its setup page.
    if (!g.live.length && !web) g.live.push({ key: 'live-setup', label: t('shell.sidebar.liveSetup'), icon: 'live', go: '/livetv', active: route.name === 'livetv' });
    if (web) {
      // No client-side IPTV on the web TV app.
    } else if (hasIptv) for (const [id, icon, key] of LIVE.slice(0, 2)) g.iptv.push({ key: id, label: t(key), icon, go: `/iptv?tab=${id}`, active: iptvTab === id });
    else g.iptv.push({ key: 'iptv-add', label: t('shell.sidebar.iptvAdd'), icon: 'plus', go: '/iptv', active: route.name === 'iptv' });
    for (const s of photoSources)
      g.photos.push({ key: s.server.id, label: s.server.name, icon: 'images', go: `/library/${s.server.id}/p.`, active: route.name === 'library' && route.params.server === s.server.id, off: s.status === 'offline', kind: 'photo' });
    for (const s of immichShown) g.photos.push({ key: s.id, label: s.name, icon: 'images', go: `/immich/${s.id}`, active: route.name === 'immich' && route.params.id === s.id, kind: 'immich' });
    for (const s of sources)
      g.files.push({ key: s.server.id, label: s.server.name, icon: sourceIcon(s.server.files?.protocol), go: `/files/${s.server.id}/p.`, active: route.name === 'files' && route.params.server === s.server.id, off: s.status === 'offline' });
    // The suffix only where it tells two rows apart; the tooltip and accessible name carry the server on every row.
    for (const list of Object.values(g)) for (const r of list) r.clash = !!r.server && list.some((x) => x !== r && x.label === r.label);
    return g;
  });
  const hidden = $derived(settings.value?.ui.sidebarHidden ?? []);
  const shown = $derived(GROUPS.filter((id) => rows[id].length > 0 && !hidden.includes(id)));

  // Folded groups, remembered on this device. The rail ignores folds (a folded group would be unreachable there),
  // and a folded group still shows its active row.
  const FOLDS_KEY = 'wicaby.sidebar.folded';
  let folds = $state<string[]>(readFolds());
  function readFolds(): string[] {
    try {
      const v: unknown = JSON.parse(localStorage.getItem(FOLDS_KEY) ?? '[]');
      return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
    } catch {
      return [];
    }
  }
  function toggleGroup(id: GroupId): void {
    folds = folds.includes(id) ? folds.filter((x) => x !== id) : [...folds, id];
    try {
      localStorage.setItem(FOLDS_KEY, JSON.stringify(folds));
    } catch {
      // Best effort: the choice lasts this session.
    }
  }
  const shut = (id: GroupId) => !collapsed && folds.includes(id);

  function toggle() {
    void updateSettings({ ui: { sidebarCollapsed: !collapsed } });
  }

  // Audio playlists of the first music library's server (music spec C5): All Playlists, a plain Music row, then up to
  // 20 playlists nested under it, each taking tracks dropped on it (C3). The Music group's fold hides them all.
  const MAX_PLAYLISTS = 20;
  const musicLib = $derived(libraries.list.find((l) => l.CollectionType === 'music'));
  const playlistsView = $derived(libraries.list.find((l) => l.CollectionType === 'playlists' && l.ServerId === musicLib?.ServerId));
  let playlists = $state<BaseItem[]>([]);
  let dropOn = $state('');
  const allPlaylists = $derived(playlistsView ? itemPath(playlistsView, 'library') : musicLib ? `${itemPath(musicLib, 'library')}?tab=playlists` : '');
  const allActive = $derived(playlistsView ? isActive('library', playlistsView) : !!musicLib && isActive('library', musicLib) && route.query.get('tab') === 'playlists');
  const playlistOn = $derived(route.name === 'item' && playlists.some((p) => p.Id === route.params.id));
  const playlistsShown = $derived(!offline && !!musicLib && (playlists.length > 0 || !!playlistsView));
  $effect(() => {
    const sid = musicLib?.ServerId;
    void dataVersion.library;
    if (!sid || offline) return void (playlists = []);
    let live = true;
    listPlaylists('playlist', sid)
      .then((r) => live && (playlists = r.Items.filter((p) => p.MediaType === 'Audio')))
      .catch(() => live && (playlists = []));
    return () => (live = false);
  });
  async function dropTracks(e: DragEvent, p: BaseItem): Promise<void> {
    dropOn = '';
    const d = droppedTracks(e);
    if (!d) return;
    e.preventDefault();
    try {
      if (d.serverId && d.serverId !== p.ServerId) throw new Error(t('item.errors.queueOtherServer'));
      await addTo('playlist', p.Id, { Id: d.ids[0], ServerId: p.ServerId }, d.ids);
      toast('success', t('music.drop.added', { count: d.ids.length, name: p.Name }));
    } catch (err) {
      toast('error', errorMessage(err));
    }
  }

  // The active row stays in view (a gamepad user opening a library from Home sees it highlighted), also when the
  // libraries arrive after a deep link and when the rail expands.
  let scroller = $state<HTMLElement>();
  $effect(() => {
    void route.path;
    void liveTab;
    void iptvTab;
    void libraries.list;
    void collapsed;
    void tick().then(() => {
      const el = scroller?.querySelector('[aria-current="page"]');
      if (!scroller || !el) return;
      const a = el.getBoundingClientRect();
      const b = scroller.getBoundingClientRect();
      if (a.top < b.top) scroller.scrollTop += a.top - b.top - 8;
      else if (a.bottom > b.bottom) scroller.scrollTop += a.bottom - b.bottom + 8;
    });
  });

  // Rail tooltip: the row's name beside it on hover and on keyboard or gamepad focus (a native title never shows on
  // focus). A top-layer popover, so neither the scroll area nor the content pane clips it.
  let railTip = $state<HTMLElement>();
  let railText = $state('');
  function showTip(e: Event): void {
    const b = (e.target as HTMLElement).closest<HTMLElement>('.link');
    // No popover API (Chromium before 114, the web TV app on older TVs): no tooltip, and no :popover-open selector to throw.
    if (!collapsed || !railTip?.showPopover || !b || (e.type === 'focusin' && !b.matches(':focus-visible'))) return;
    const r = b.getBoundingClientRect();
    railText = b.getAttribute('aria-label') ?? '';
    railTip.style.left = `${r.right + 8}px`;
    railTip.style.top = `${r.top + r.height / 2}px`;
    if (!railTip.matches(':popover-open')) railTip.showPopover();
  }
  const hideTip = () => void (railTip?.hidePopover && railTip.matches(':popover-open') && railTip.hidePopover());
  $effect(() => {
    if (!collapsed) hideTip();
  });

  function statusLine(level: Level): string {
    if (signedIn > 1 && down > 0) return t('shell.sidebar.someOffline', { count: down });
    if (level === 'warn') return t('shell.status.level.warn');
    if (signedIn > 1) return t('shell.sidebar.allConnected');
    const kind = kindLabel(server?.kind, t('files.kind'));
    // "Emby / Connected", not "Emby / Emby · connected", when the server kept its default name.
    if (kind === server?.name) return t(offline ? 'shell.status.server.offline' : 'shell.status.server.connected');
    return t('shell.sidebar.serverState', { kind, state: offline ? 'offline' : 'online' });
  }
</script>

{#snippet link(r: Row)}
  <li data-immich={r.kind === 'immich' || undefined}>
    <button
      class="link"
      class:active={r.active}
      aria-current={r.active ? 'page' : undefined}
      aria-label={collapsed || r.server || r.off ? named(r) : undefined}
      title={tip(r)}
      disabled={r.disabled}
      data-photo-source={r.kind === 'photo' || undefined}
      onclick={() => navigate(r.go)}
    >
      <span class="glyph">
        <Icon name={r.icon} size={18} />
        {#if r.badge}<span class="dot-badge" class:show={collapsed}></span>{/if}
        {#if r.off}<span class="dot-badge off show" aria-hidden="true"></span>{/if}
      </span>
      <span class="label fades" class:dim={r.off}>{r.label}</span>
      {#if r.badge}<span class="badge tabular fades">{r.badge}</span>{/if}
      {#if r.clash}<span class="suffix tabular fades" aria-hidden="true">{r.server}</span>{/if}
    </button>
  </li>
{/snippet}

<!-- svelte-ignore a11y_no_noninteractive_element_interactions (the rail tooltip only mirrors the hovered or focused row's name) -->
<nav class="sidebar" class:collapsed aria-label={t('shell.nav.aria')} onmouseover={showTip} onfocusin={showTip} onmouseout={hideTip} onfocusout={hideTip}>
  <div class="head">
    <div class="top drag">
      <button class="toggle no-drag" onclick={toggle} aria-label={collapsed ? t('shell.sidebar.show') : t('shell.sidebar.hide')} title={collapsed ? t('shell.sidebar.show') : t('shell.sidebar.hide')}>
        <Icon name="sidebar" size={18} />
      </button>
      <span class="word fades"><Logo size={18} mono />Wicaby</span>
    </div>
    <ul class="group">
      {#each nav as r (r.key)}{@render link(r)}{/each}
    </ul>
  </div>

  <div class="scroll" bind:this={scroller} onscroll={hideTip}>
    <div class="list">
      {#each shown as id (id)}
        {@const isShut = shut(id)}
        <section aria-labelledby="sb-h-{id}">
          <h2 class="gh">
            <button class="ghead" id="sb-h-{id}" aria-expanded={!isShut} aria-controls="sb-{id}" class:shut={isShut} onclick={() => toggleGroup(id)}>
              <span class="gname">{t(`shell.sidebar.groups.${id}`)}</span>
              <Icon name="chevronDown" size={12} />
            </button>
          </h2>
          <ul class="group" id="sb-{id}" data-files={id === 'files' || undefined}>
            {#each rows[id].filter((r) => !isShut || r.active) as r (r.key)}{@render link(r)}{/each}
            {#if id === 'music' && playlistsShown && (!isShut || allActive || playlistOn)}
              {#if !isShut || allActive}
                {@render link({ key: 'all-playlists', label: t('music.sidebar.all'), icon: 'listMusic', go: allPlaylists, active: allActive })}
              {/if}
              <!-- The playlists nest under All Playlists; the rail leaves them out (identical rows carry no information). -->
              {#if !collapsed && playlists.length}
                <li>
                  <ul class="group" data-sidebar-playlists>
                    {#each playlists.slice(0, MAX_PLAYLISTS) as p (p.Id)}
                      {@const on = route.name === 'item' && route.params.id === p.Id}
                      {#if !isShut || on}
                        <li>
                          <button
                            class="link child"
                            class:active={on}
                            class:drop={dropOn === p.Id}
                            aria-current={on ? 'page' : undefined}
                            data-playlist={p.Id}
                            onclick={() => navigate(itemPath(p))}
                            ondragover={(e) => carriesTracks(e) && (e.preventDefault(), (dropOn = p.Id))}
                            ondragleave={() => dropOn === p.Id && (dropOn = '')}
                            ondrop={(e) => dropTracks(e, p)}
                          >
                            <span class="label">{p.Name}</span>
                          </button>
                        </li>
                      {/if}
                    {/each}
                  </ul>
                </li>
              {/if}
            {/if}
          </ul>
        </section>
      {/each}
    </div>
  </div>

  <div class="foot">
    <ul class="group end">
      {#each foot as r (r.key)}{@render link(r)}{/each}
    </ul>
    {#if signedIn > 1 || server}
      <ConnectionStatus>
        {#snippet children(level: Level)}
          <span class="server-text fades">
            <span class="server-name">{signedIn > 1 ? t('shell.sidebar.servers', { count: signedIn }) : server?.name}</span>
            <span class="server-sub">{statusLine(level)}</span>
          </span>
        {/snippet}
      </ConnectionStatus>
    {/if}
  </div>
  <span class="rail-tip" popover="manual" bind:this={railTip} aria-hidden="true">{railText}</span>
</nav>

<style>
  /* The sidebar keeps its full width at all times; when collapsed, the content pane slides over it and only the
     72 px icon column stays visible. Labels fade, then leave the tab order and spatial navigation (visibility). */
  .sidebar {
    position: absolute;
    inset: 0 auto 0 0;
    width: var(--sidebar);
    display: flex;
    flex-direction: column;
    /* Focus ring: monochrome, about 4.6:1 on the sidebar and 3.4:1 on the focus fill (WCAG 1.4.11 asks 3:1). */
    --ring: inset 0 0 0 1px rgb(235 235 245 / 0.5);
  }
  .fades {
    transition: opacity var(--t-med) var(--ease);
  }
  .collapsed .fades {
    opacity: 0;
    visibility: hidden;
    transition:
      opacity var(--t-fast) var(--ease),
      visibility 0s linear var(--t-fast);
  }

  .head {
    flex: none;
  }
  .head > .group,
  .foot > .group {
    padding: 0 12px;
  }
  .top {
    height: var(--titlebar);
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 0 0 16px;
  }
  .toggle {
    display: grid;
    place-items: center;
    width: 40px;
    height: 32px;
    border-radius: var(--r-xs);
    color: var(--label-2);
  }
  .toggle:hover {
    background: var(--fill-1);
    color: var(--label);
  }
  .toggle:active {
    background: var(--fill-3);
  }
  .toggle:focus-visible {
    background: var(--fill-3);
    box-shadow: var(--ring);
    color: var(--label);
  }
  .word {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    font-size: var(--fs-headline);
    font-weight: 650;
    letter-spacing: -0.02em;
    color: var(--label);
  }

  /* The middle scrolls; a hairline shows under the head and above the foot only while content passes beneath,
     driven by the scroll position itself (no JS, no time-based animation; no hairline where unsupported). */
  .scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    /* The 12 px scrollbar track is always reserved and serves as the right inset, so rows keep their width
       whether or not the list overflows. */
    scrollbar-gutter: stable;
  }
  .collapsed .scroll {
    scrollbar-width: none;
  }
  .scroll::before,
  .scroll::after {
    content: '';
    position: sticky;
    z-index: 1;
    display: block;
    height: 1px;
    margin-left: 12px;
    background: var(--separator);
    opacity: 0;
    animation: edge linear both;
  }
  /* A rule of its own: the CSS minifier would fold it into the shorthand above, which Chromium then drops. */
  .sidebar .scroll::before,
  .sidebar .scroll::after {
    animation-timeline: scroll();
  }
  .scroll::before {
    top: 0;
    margin-bottom: -1px;
    animation-range: 0 12px;
  }
  .scroll::after {
    bottom: 0;
    margin-top: -1px;
    animation-direction: reverse;
    animation-range: calc(100% - 12px) 100%;
  }
  @keyframes edge {
    to {
      opacity: 1;
    }
  }
  .list {
    padding: 0 0 12px 12px;
  }
  .collapsed .list {
    padding-right: 12px;
  }

  .group {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .foot {
    flex: none;
    padding-top: 8px;
  }
  .foot > .group {
    margin-bottom: 4px;
  }

  /* Group header: quiet caption aligned with the glyphs, the whole row toggles it. The chevron shows on hover or
     focus, and stays while the group is folded so a folded group is discoverable. */
  .gh {
    margin: 0;
    font: inherit;
  }
  .ghead {
    position: relative;
    display: flex;
    align-items: center;
    width: 100%;
    height: 28px;
    margin-top: 16px;
    padding: 0 12px 0 15px;
    border-radius: var(--r-xs);
    color: var(--label-2);
    font-size: var(--fs-caption);
    font-weight: 600;
    letter-spacing: 0.02em;
    text-align: left;
    white-space: nowrap;
  }
  .gname {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .ghead :global(.wi-icon) {
    color: var(--label-3);
    opacity: 0;
    transition: transform var(--t-fast) var(--ease);
  }
  .ghead:is(:hover, :focus-visible) {
    color: var(--label);
  }
  .ghead:focus-visible {
    background: var(--fill-3);
    box-shadow: var(--ring);
  }
  .ghead:is(:hover, :focus-visible, .shut) :global(.wi-icon) {
    opacity: 1;
  }
  .ghead.shut :global(.wi-icon) {
    transform: rotate(-90deg);
  }
  /* Rail: each header becomes a short centred hairline; the only way the groups survive in icon-only mode. */
  .collapsed .ghead {
    visibility: hidden;
    height: 25px;
    margin-top: 0;
  }
  .ghead::after {
    content: '';
    position: absolute;
    left: 12px;
    top: 12px;
    width: 24px;
    height: 1px;
    background: var(--separator);
    visibility: visible;
    opacity: 0;
  }
  .collapsed .ghead::after {
    opacity: 1;
  }

  .link {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    height: 32px;
    padding: 0 8px 0 4px;
    border-radius: var(--r-xs);
    color: var(--label-2);
    font-size: var(--fs-callout);
    font-weight: 500;
    text-align: left;
    white-space: nowrap;
  }
  /* States switch instantly (the owner dislikes fades on these rows) and stay monochrome: hover < selection <
     focus in fill, and focus adds the ring, so the keyboard or gamepad cursor beats the selection, even on it. */
  .link:hover {
    background: var(--fill-1);
    color: var(--label);
  }
  .link.active {
    background: var(--fill-2);
    color: var(--label);
  }
  .link:active {
    background: var(--fill-3);
  }
  .link:focus-visible {
    background: var(--fill-3);
    box-shadow: var(--ring);
    color: var(--label);
  }
  .link.drop {
    box-shadow: inset 0 0 0 2px var(--accent);
  }
  .collapsed .link {
    width: 48px;
  }
  .link:disabled {
    opacity: 0.35;
    pointer-events: none;
  }
  /* Playlists: icon-less rows nested under All Playlists, 12 px deeper than its label. */
  .link.child {
    height: 28px;
    padding-left: 62px;
  }
  .glyph {
    position: relative;
    display: grid;
    place-items: center;
    width: 40px;
    flex: none;
  }
  .label {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .suffix {
    flex: none;
    max-width: 9ch;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: var(--fs-caption);
    font-weight: 400;
    color: var(--label-2);
  }
  .badge {
    min-width: 20px;
    height: 18px;
    padding: 0 6px;
    border-radius: 999px;
    background: var(--fill-3);
    color: var(--label);
    font-size: var(--fs-caption);
    font-weight: 650;
    display: grid;
    place-items: center;
  }
  .dot-badge {
    position: absolute;
    top: -1px;
    right: 8px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--label);
    box-shadow: 0 0 0 2px var(--bg-elevated);
    opacity: 0;
    transition: opacity var(--t-fast) var(--ease);
  }
  .dot-badge.show {
    opacity: 1;
  }
  .dot-badge.off {
    background: var(--label-3);
  }
  .dim {
    color: var(--label-3);
  }

  .server-text {
    display: flex;
    flex-direction: column;
    min-width: 0;
    line-height: 1.3;
  }
  .server-name {
    font-size: var(--fs-footnote);
    font-weight: 560;
    color: var(--label-2);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .server-sub {
    font-size: var(--fs-caption);
    color: var(--label-2);
  }

  /* Rail tooltip (railTip): a quiet label beside the hovered or focused glyph, no motion. */
  .rail-tip {
    position: fixed;
    inset: auto;
    margin: 0;
    transform: translateY(-50%);
    padding: 4px 8px;
    border: 0;
    border-radius: var(--r-xs);
    background: var(--bg-elevated);
    box-shadow: var(--shadow-2), inset 0 0 0 1px var(--hairline);
    color: var(--label);
    font-size: var(--fs-footnote);
    font-weight: 500;
    white-space: nowrap;
    pointer-events: none;
  }
</style>
