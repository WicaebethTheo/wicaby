<script lang="ts">
  import { onMount } from 'svelte';
  import CastBar from './components/CastBar.svelte';
  import CastPicker from './components/CastPicker.svelte';
  import FpsMeter from './components/FpsMeter.svelte';
  import LogoLoader from './components/LogoLoader.svelte';
  import MusicHost from './components/music/MusicHost.svelte';
  import NowPlayingBar from './components/music/NowPlayingBar.svelte';
  import SelectionBar from './components/music/SelectionBar.svelte';
  import TrackMenu from './components/music/TrackMenu.svelte';
  import { musicActive } from './lib/music-ui.svelte';
  import NowPlaying from './routes/NowPlaying.svelte';
  import QueueMenu from './components/QueueMenu.svelte';
  import ResumePrompt from './components/ResumePrompt.svelte';
  import Sidebar from './components/Sidebar.svelte';
  import TitleBar from './components/TitleBar.svelte';
  import Toasts from './components/Toasts.svelte';
  import UpdateNotice from './components/UpdateNotice.svelte';
  import { initAppUpdate } from './lib/app-update.svelte';
  import { w } from './lib/bridge';
  import { initCast } from './lib/cast.svelte';
  import { web } from './lib/platform';
  import { t } from './lib/i18n.svelte';
  import { navigate, router } from './lib/router.svelte';
  import { initSpatialNav } from './lib/spatial';
  import { htmlPlayer, initStores, session, settings } from './lib/stores.svelte';
  import Downloads from './routes/Downloads.svelte';
  import Favorites from './routes/Favorites.svelte';
  import Files from './routes/Files.svelte';
  import Photos from './routes/photos/Photos.svelte';
  import { immich } from './lib/photos/immich.svelte';
  import History from './routes/History.svelte';
  import Home from './routes/Home.svelte';
  import Item from './routes/Item.svelte';
  import Library from './routes/Library.svelte';
  import LiveTv from './routes/LiveTv.svelte';
  import ProgramSheet from './components/ProgramSheet.svelte';
  import Login from './routes/Login.svelte';
  import MiniPlayer from './routes/MiniPlayer.svelte';
  import OsdWindow from './routes/OsdWindow.svelte';
  import Player from './routes/Player.svelte';
  import Reader from './routes/Reader.svelte';
  import Search from './routes/Search.svelte';
  import Servers from './routes/Servers.svelte';
  import Settings from './routes/Settings.svelte';
  import Shuffle from './routes/Shuffle.svelte';
  import Welcome from './routes/Welcome.svelte';
  import Admin from './routes/Admin.svelte';
  import PhotoViewer from './routes/photos/PhotoViewer.svelte';
  import { lonePhoto } from './lib/photos/source.svelte';
  import { dur } from './lib/motion';

  const isOsd = document.documentElement.classList.contains('osd');
  // The music mini player's own window (MU-10): stores and the mini layout only.
  const isMini = document.documentElement.classList.contains('mini');
  const status = $derived(session.value.status);
  const route = $derived(router.route);
  // The built-in player covers the page it was opened from, which stays mounted (inert) underneath: the way
  // back keeps its scroll, focus and data, and Player.svelte fades out over it.
  let lastPage = router.route;
  // The full-screen music player covers the page the same way (music-spec §4.3).
  const page = $derived(route.name === 'player' || route.name === 'now-playing' ? lastPage : (lastPage = route));
  const playing = $derived(route.name === 'player');
  const nowPlaying = $derived(route.name === 'now-playing');
  let returnFocus: HTMLElement | null = null;
  $effect.pre(() => {
    if (playing) returnFocus ??= document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
  });
  $effect(() => {
    if (playing || !returnFocus) return;
    if (returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  });
  const collapsed = $derived(settings.value?.ui.sidebarCollapsed ?? false);

  const RAIL = { open: 248, closed: 72 };
  let pane = $state<HTMLDivElement>();
  let lastCollapsed: boolean | null = null;

  onMount(() => {
    void initStores();
    if (isMini) return;
    initCast();
    if (isOsd) return;
    const offNav = w.events.onNavigate((path) => void navigate(path));
    const offSpatial = initSpatialNav();
    const offUpdate = initAppUpdate();
    return () => {
      offNav();
      offSpatial();
      offUpdate();
    };
  });

  // Sidebar collapse: the pane's left edge jumps to its new place in one layout
  // pass, then slides there on the compositor (FLIP) instead of animating width.
  $effect(() => {
    const c = collapsed;
    const el = pane;
    if (!el) return;
    if (lastCollapsed !== null && lastCollapsed !== c) {
      const css = getComputedStyle(document.documentElement);
      const from = c ? RAIL.open - RAIL.closed : RAIL.closed - RAIL.open;
      el.animate([{ transform: `translate3d(${from}px, 0, 0)` }, { transform: 'translate3d(0, 0, 0)' }], {
        duration: dur('slow'),
        easing: css.getPropertyValue('--ease').trim() || 'ease-out',
      });
    }
    lastCollapsed = c;
  });

  // Open the <video> player whenever main hands it a new stream.
  let seenSeq = 0;
  $effect(() => {
    const seq = htmlPlayer.seq;
    if (isOsd || isMini || seq <= seenSeq) return;
    seenSeq = seq;
    // A track plays in MusicHost's <audio>: the page stays.
    if (router.route.name !== 'player' && !htmlPlayer.load?.audio) navigate('/player');
  });

  // Settings > Général > "Page de démarrage" (libraries load after sign-in, so the id is not checked here).
  function startRoute(): string {
    const start = settings.value?.ui.startPage ?? 'home';
    if (start === 'favorites') return '/favorites';
    return start.startsWith('library:') ? `/library/${start.slice(8)}` : '/home';
  }

  // Route guard driven by the session state owned by main.
  $effect(() => {
    if (isOsd || isMini || !session.ready) return;
    const name = router.route.name;
    if (name === 'player') return;
    // First run (onboarding spec 4): the setup until it is done or skipped. It keeps its page while it adds and
    // signs in to servers.
    const onboarded = settings.value?.ui.onboarded ?? true;
    if (name === 'welcome' && (!onboarded || router.route.query.get('rerun') !== null)) return;
    if (status === 'no-server' && !onboarded) navigate('/welcome', { replace: true });
    else if (status === 'no-server' && name !== 'servers') navigate('/servers', { replace: true });
    else if (status === 'server-selected' && name !== 'login' && name !== 'servers') navigate('/login', { replace: true });
    // The web TV app has no downloads: its offline place is the servers page (Retry, Wake).
    else if (status === 'offline' && !['downloads', 'settings', 'servers', 'read'].includes(name)) navigate(web ? '/servers' : '/downloads', { replace: true });
    // Signed in, /servers and /login stay open: they add or sign in to another server.
    else if (status === 'signed-in' && name === '') navigate(startRoute(), { replace: true });
  });
</script>

{#if isMini}
  <MiniPlayer />
{:else if isOsd}
  <OsdWindow />
{:else if !session.ready || (status === 'connecting' && page.name !== 'welcome')}
  <div class="splash drag">
    <div class="glow" aria-hidden="true"><span></span><span></span><span></span></div>
    <span class="mark"><LogoLoader size={88} /></span>
    <h1 class="wordmark">Wicaby</h1>
    <p class="status">
      {#if status === 'connecting'}{session.value.server?.name ? t('shell.splash.connecting', { server: session.value.server.name }) : t('shell.splash.connectingDefault')}{:else}&nbsp;{/if}
    </p>
  </div>
{:else if page.name === 'read' && (status === 'signed-in' || status === 'offline')}
  {#key page.path}<Reader id={page.params.id} server={page.params.server} />{/key}
{:else if page.name === 'welcome' || status === 'no-server' || status === 'server-selected' || page.name === 'servers' || page.name === 'login'}
  <div class="onboarding">
    <div class="ambient" aria-hidden="true"><span></span><span></span><span></span></div>
    <TitleBar minimal />
    {#if page.name === 'welcome'}<Welcome rerun={page.query.get('rerun') !== null} />{:else if page.name === 'login'}{#key page.params.id}<Login serverId={page.params.id} />{/key}{:else}<Servers />{/if}
  </div>
{:else}
  <div class="shell" style:--rail="{collapsed ? RAIL.closed : RAIL.open}px" inert={playing || nowPlaying}>
    <Sidebar />
    <div class="pane" bind:this={pane}>
      <TitleBar />
      <CastBar />
      <main class="scroller" id="main-scroller" class:with-bar={musicActive()}>
        <!-- Admin switches sections and servers in place (its section list stays put). -->
        {#key page.name === 'admin' ? 'admin' : page.path}
          {#if page.name === 'home'}<Home />
          {:else if page.name === 'library'}<Library id={page.params.id} server={page.params.server} />
          {:else if page.name === 'files'}<Files id={page.params.id} server={page.params.server} />
          {:else if page.name === 'immich'}<Photos lib={{ Id: page.params.id, Name: immich.sources.find((s) => s.id === page.params.id)?.name ?? 'Immich', Type: 'CollectionFolder' }} immich={page.params.id} />
          {:else if page.name === 'livetv'}<LiveTv />
          {:else if page.name === 'iptv'}<LiveTv iptv />
          {:else if page.name === 'item'}<Item id={page.params.id} server={page.params.server} />
          {:else if page.name === 'search'}<Search />
          {:else if page.name === 'favorites'}<Favorites />
          {:else if page.name === 'shuffle'}<Shuffle />
          {:else if page.name === 'history'}<History />
          {:else if page.name === 'downloads'}<Downloads />
          {:else if page.name === 'settings'}<Settings />
          {:else if page.name === 'admin'}<Admin />
          {:else}<Home />{/if}
        {/key}
      </main>
      <NowPlayingBar />
    </div>
    <ProgramSheet />
  </div>
{/if}
{#if !isOsd && playing && session.ready}<Player />{/if}
{#if !isOsd && nowPlaying && session.ready && status === 'signed-in'}<NowPlaying />{/if}

<!-- Main is hidden while mpv plays: the OSD shows the toasts then (admin messages, errors). -->
<Toasts />
{#if !isOsd && !isMini && !playing && !nowPlaying && session.ready}<UpdateNotice />{/if}
{#if !isOsd && !isMini}<ResumePrompt /><QueueMenu /><TrackMenu /><SelectionBar /><CastPicker /><MusicHost />{/if}
{#if !isOsd && !isMini && lonePhoto.assets}<PhotoViewer assets={lonePhoto.assets} start={0} onclose={() => (lonePhoto.assets = null)} />{/if}
{#if settings.value?.ui.fpsMeter}<FpsMeter />{/if}

<style>
  /* ---------- Splash ---------- */
  .splash {
    position: relative;
    height: 100%;
    display: grid;
    place-content: center;
    justify-items: center;
    overflow: hidden;
    background: var(--bg);
  }
  .glow {
    position: absolute;
    inset: 50% auto auto 50%;
    width: 640px;
    height: 360px;
    translate: -50% -50%;
    filter: blur(70px);
    opacity: 0.22;
    pointer-events: none;
  }
  .glow span {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    animation: drift 9s var(--ease-in-out) infinite alternate;
    animation-play-state: var(--loop);
  }
  .glow span:nth-child(1) {
    background: radial-gradient(closest-side, var(--graphite), transparent);
    transform: translate3d(-22%, 0, 0) scale(0.7);
  }
  .glow span:nth-child(2) {
    background: radial-gradient(closest-side, var(--graphite), transparent);
    transform: translate3d(22%, 6%, 0) scale(0.6);
    /* motion-ok: ambient loop, phases differ on purpose */
    animation-delay: -3s;
    /* motion-ok: ambient loop */
    animation-duration: 11s;
  }
  .glow span:nth-child(3) {
    background: radial-gradient(closest-side, var(--graphite), transparent);
    transform: translate3d(0, -14%, 0) scale(0.45);
    opacity: 0.6;
    /* motion-ok: ambient loop */
    animation-delay: -6s;
    /* motion-ok: ambient loop */
    animation-duration: 13s;
  }
  @keyframes drift {
    to {
      transform: translate3d(0, 4%, 0) rotate(28deg) scale(0.85);
    }
  }
  .mark {
    position: relative;
    margin-bottom: 14px;
    color: var(--label);
    animation: rise var(--t-slow) var(--ease-out) both;
  }
  .wordmark {
    position: relative;
    margin: 0;
    font-size: clamp(64px, 8vw, 104px);
    font-weight: 750;
    letter-spacing: -0.045em;
    line-height: 1;
    background: linear-gradient(180deg, #fff 30%, rgb(255 255 255 / 0.62));
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    animation: rise var(--t-slow) var(--ease-out) both;
  }
  /* Light canvas (Light, or a light Hyprland palette): the label colours (white on #f2f2f5 would not show). */
  :global(:is([data-theme='light'], [data-scheme='light'])) .wordmark {
    background: linear-gradient(180deg, var(--label) 30%, var(--label-2));
    -webkit-background-clip: text;
    background-clip: text;
  }
  .status {
    position: relative;
    margin: 18px 0 22px;
    font-size: var(--fs-callout);
    color: var(--label-2);
    animation: fade var(--t-slow) var(--ease-out) var(--t-fast) both;
  }

  /* ---------- Shell ---------- */
  .onboarding {
    position: relative;
    height: 100%;
    display: flex;
    flex-direction: column;
    background: var(--bg);
  }
  .onboarding :global(.titlebar) {
    position: absolute;
    inset: 0 0 auto 0;
  }
  /* Soft graphite light behind the onboarding glass; gradients only, no blur filter. */
  .ambient {
    position: absolute;
    inset: 0;
    overflow: hidden;
    pointer-events: none;
  }
  .ambient span {
    position: absolute;
    width: 70vmax;
    height: 70vmax;
    border-radius: 50%;
    opacity: 0.14;
    animation: wander 24s var(--ease-in-out) infinite alternate;
    animation-play-state: var(--loop);
  }
  .ambient span:nth-child(1) {
    top: -30vmax;
    left: -18vmax;
    background: radial-gradient(closest-side, var(--graphite), transparent);
  }
  .ambient span:nth-child(2) {
    right: -26vmax;
    bottom: -36vmax;
    background: radial-gradient(closest-side, var(--graphite), transparent);
    /* motion-ok: ambient loop */
    animation-duration: 30s;
    animation-direction: alternate-reverse;
  }
  .ambient span:nth-child(3) {
    top: 30%;
    left: 40%;
    width: 44vmax;
    height: 44vmax;
    opacity: 0.07;
    background: radial-gradient(closest-side, var(--graphite), transparent);
    /* motion-ok: ambient loop */
    animation-duration: 36s;
  }
  @keyframes wander {
    to {
      transform: translate3d(8vmax, 6vmax, 0) scale(1.12);
    }
  }
  .shell {
    position: relative;
    height: 100%;
    overflow: hidden;
    /* Without Mica the sidebar sits on a lifted graphite, like the macOS source list. */
    background: var(--bg-elevated);
  }
  :global(html.mica:is([data-theme='graphite'], [data-theme='light']):not([data-reduce-transparency])) .shell {
    background: transparent;
  }
  /* OLED: the sidebar goes true black too; the pane's separator keeps the edge. */
  :global(html[data-theme='oled']) .shell {
    background: var(--bg);
  }
  .pane {
    position: absolute;
    inset: 0 0 0 var(--rail);
    z-index: 1;
    display: flex;
    flex-direction: column;
    background: var(--bg);
    border-top-left-radius: var(--r-md);
    border-bottom-left-radius: var(--r-md);
    box-shadow:
      -1px 0 0 var(--separator),
      -18px 0 40px rgb(0 0 0 / 0.18);
  }
  /* Fills the strip uncovered on the right while the pane slides during a collapse. */
  .pane::after {
    content: '';
    position: absolute;
    inset: 0 auto 0 100%;
    width: 200px;
    background: inherit;
  }
  :global(html.mica:is([data-theme='graphite'], [data-theme='light']):not([data-reduce-transparency])) .pane {
    background: color-mix(in srgb, var(--bg) 92%, transparent);
  }
  .scroller {
    view-transition-name: page;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overflow-x: hidden;
    border-bottom-left-radius: var(--r-md);
  }
  /* The now-playing bar covers the bottom 72 px. */
  .scroller.with-bar {
    padding-bottom: 72px;
  }
  /* Keyboard and gamepad focus never parks a card flush against the pane edge. */
  .scroller :global(:is(a, button, [tabindex])) {
    scroll-margin: 56px 40px;
  }
</style>
