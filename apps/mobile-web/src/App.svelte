<script lang="ts">
  // The app shell (Android MainActivity + MainShell): the page layer, the tab bar while signed in, a title's menu,
  // the dialog layer, the toasts and snackbars, and the update banner.
  import { skipPicker } from '$tv/profiles.svelte';
  import { prefs } from '$tv/session.svelte';
  import { settings } from '$tv/settings.svelte';
  import AlertSheet from './components/AlertSheet.svelte';
  import ItemMenu from './components/ItemMenu.svelte';
  import Pages from './components/Pages.svelte';
  import TabBar from './components/TabBar.svelte';
  import Snackbar from './components/Snackbar.svelte';
  import Toast from './components/Toast.svelte';
  import UpdateBanner from './components/UpdateBanner.svelte';
  import { itemAdmin, itemMenu } from './lib/item-menu.svelte';
  import { isFullScreen, nav, stack } from './lib/nav.svelte';
  import { overlay } from './lib/overlay.svelte';
  import Login from './screens/Login.svelte';
  import Main from './screens/Main.svelte';
  import Pending from './screens/Pending.svelte';
  import Servers from './screens/Servers.svelte';
  import { applyTheme } from './lib/theme';
  import { startDownloads } from './lib/downloads.svelte';

  // Pages past Home load on first use, each in its own chunk (the player brings the remux engine); the service
  // worker has them all precached, so opening one never waits on the network.
  const Detail = () => import('./screens/Detail.svelte');
  const Folder = () => import('./screens/Folder.svelte');
  const Player = () => import('./screens/Player.svelte');
  const SettingsPage = () => import('./screens/SettingsPage.svelte');
  const Admin = () => import('./screens/Admin.svelte');
  const Person = () => import('./screens/Person.svelte');
  const Favorites = () => import('./screens/Favorites.svelte');
  const ItemAdminHost = () => import('./components/ItemAdminHost.svelte');

  // The offline answers for downloaded titles, and the download queue where it stopped.
  startDownloads();

  // The theme and accent follow Settings at once, on every page.
  $effect(() => applyTheme(settings.theme.value, settings.accent.value));

  // MainActivity's start route: the session, else the saved server's sign-in, else the server page.
  // TP-10: "Who's watching?" first, unless this phone has one account without a PIN and the picker is skipped.
  if (prefs.session) nav.reset(skipPicker(prefs.session) ? { name: 'main' } : { name: 'login', server: prefs.session.server });
  else if (prefs.server) nav.reset({ name: 'login', server: prefs.server });
  else nav.reset({ name: 'servers' });

  const top = $derived(stack[stack.length - 1]);
  const tabs = $derived(stack[0]?.route.name === 'main' && !(top && isFullScreen(top.route)));
</script>

<Pages>
  {#snippet page(e)}
    {#if e.route.name === 'servers'}
      <Servers add={e.route.add} />
    {:else if e.route.name === 'login'}
      <Login server={e.route.server} add={e.route.add} />
    {:else if e.route.name === 'main'}
      <Main />
    {:else if e.route.name === 'detail'}
      {@const r = e.route}
      {#await Detail() then m}<m.default id={r.id} serverId={r.serverId} />{/await}
    {:else if e.route.name === 'player'}
      {@const r = e.route}
      {#await Player() then m}<m.default id={r.id} fromStart={r.fromStart} trailer={r.trailer} queue={r.queue} serverId={r.serverId} startMs={r.startMs} tracks={r.tracks} />{/await}
    {:else if e.route.name === 'folder'}
      {@const r = e.route}
      {#await Folder() then m}<m.default id={r.id} title={r.title} serverId={r.serverId} />{/await}
    {:else if e.route.name === 'settings'}
      {@const r = e.route}
      {#await SettingsPage() then m}<m.default page={r.page} />{/await}
    {:else if e.route.name === 'browse'}
      {@const r = e.route}
      {#await Folder() then m}<m.default id="" title={r.title} query={r.query} serverId={r.serverId} />{/await}
    {:else if e.route.name === 'person'}
      {@const r = e.route}
      {#await Person() then m}<m.default id={r.id} serverId={r.serverId} name={r.title} />{/await}
    {:else if e.route.name === 'favorites'}
      {#await Favorites() then m}<m.default />{/await}
    {:else if e.route.name === 'admin'}
      {@const r = e.route}
      {#await Admin() then m}<m.default section={r.section} />{/await}
    {:else}
      <Pending route={e.route} />
    {/if}
  {/snippet}
</Pages>
{#if tabs}<TabBar />{/if}
{#if itemMenu.item}{#key itemMenu.item}<ItemMenu item={itemMenu.item} ctx={itemMenu.ctx} />{/key}{/if}
{#if itemAdmin.item}{#await ItemAdminHost() then m}<m.default />{/await}{/if}
{#if overlay.alert}<AlertSheet alert={overlay.alert} />{/if}
<Toast />
<Snackbar />
<UpdateBanner />
<div class="status-colour" aria-hidden="true"></div>
