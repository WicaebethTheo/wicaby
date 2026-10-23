<script lang="ts">
  // Android LoginScreen (ui/Setup.kt): "Who's watching?" with the server's public users and the accounts saved on
  // this phone, then the password of the one picked (or a name and password for another user). The sign-in logic is
  // the TV web app's (session, profiles and their local PIN).
  import type { UserDto } from '$shared/models';
  import { ApiError } from '$tv/api';
  import { t } from '$tv/i18n.svelte';
  import { clock } from '$tv/format';
  import { clearCache } from '$tv/load.svelte';
  import { checkPin, hasPin } from '$tv/profiles.svelte';
  import { addExtra, apiFor, prefs, signIn, type Server, type Session } from '$tv/session.svelte';
  import { getContext, onMount, tick } from 'svelte';
  import Avatar from '../components/Avatar.svelte';
  import Button from '../components/Button.svelte';
  import NavBar from '../components/NavBar.svelte';
  import Spinner from '../components/Spinner.svelte';
  import TextField from '../components/TextField.svelte';
  import { nav, onBack, SCREEN } from '../lib/nav.svelte';
  import { noteImageTag } from '../lib/user.svelte';

  let { server, add = false }: { server: Server; add?: boolean } = $props();

  // A login page is pushed for one server and never re-targeted: the initial value is the value.
  // svelte-ignore state_referenced_locally
  const api = apiFor(server);
  let users = $state<UserDto[] | null>(null);
  let loadError = $state(false);
  let picked = $state<Entry | null>(null);
  let manual = $state(false);
  let name = $state('');
  let password = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  let passwordField = $state<HTMLInputElement>();
  let nameField = $state<HTMLInputElement>();
  const form = $derived(picked !== null || manual);

  interface Entry {
    user: UserDto;
    saved?: Session;
  }

  // TP-10: this phone's accounts on this server (none while adding an extra server).
  const saved = $derived(add ? [] : prefs.profiles.filter((p) => p.server.id === server.id));
  // The public users, then saved accounts the server hides from its public list.
  const entries = $derived.by<Entry[] | null>(() => {
    if (!users) return loadError && saved.length ? saved.map((s) => ({ user: { Id: s.userId, Name: s.userName }, saved: s })) : null;
    const list: Entry[] = users.map((u) => ({ user: u, saved: saved.find((s) => s.userId === u.Id) }));
    for (const s of saved) if (!list.some((e) => e.user.Id === s.userId)) list.push({ user: { Id: s.userId, Name: s.userName }, saved: s });
    return list;
  });

  async function loadUsers(): Promise<void> {
    loadError = false;
    try {
      users = await api.publicUsers();
      for (const u of users) noteImageTag(u);
    } catch {
      loadError = true;
    }
    if (entries && !entries.length) pick(null);
  }

  function done(session: Session): void {
    // TP-06: another server joins the primary one; back to Settings, whose rows reload with it.
    if (add) {
      addExtra(session);
      clearCache();
      nav.back();
      nav.back();
      return;
    }
    signIn(session);
    nav.reset({ name: 'main' });
  }

  async function login(user: string, pw: string): Promise<void> {
    if (busy) return;
    busy = true;
    error = null;
    try {
      const r = await api.signIn(user, pw);
      noteImageTag(r.User);
      done({ server, userId: r.User.Id, userName: r.User.Name, token: r.AccessToken });
    } catch (e) {
      error = e instanceof ApiError && (e.status === 401 || e.status === 403) ? t('wrong_credentials') : e instanceof ApiError && e.status ? e.message : t('server_unreachable');
    } finally {
      busy = false;
    }
  }

  // A saved account: its token is checked against the server, and the password asked again if it was revoked.
  async function open(s: Session, user: UserDto): Promise<void> {
    if (busy) return;
    busy = true;
    error = null;
    try {
      const me = await apiFor(server, s).get<UserDto>(`/Users/${s.userId}`);
      if (me.Id !== s.userId) throw new ApiError('not this account', 401);
      noteImageTag(me);
      done(s);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
        pick({ user });
        error = t('profile_expired');
      } else error = t('server_unreachable');
    } finally {
      busy = false;
    }
  }

  async function pick(entry: Entry | null): Promise<void> {
    manual = entry === null;
    picked = entry;
    password = '';
    name = '';
    error = null;
    await tick();
    (manual ? nameField : passwordField)?.focus();
  }

  // TP-10: a saved account with a PIN on this phone asks for it first.
  let pinFor = $state<Entry | null>(null);
  let pin = $state('');

  async function submitPin(): Promise<void> {
    const entry = pinFor;
    if (!entry?.saved) return;
    const r = await checkPin(entry.saved, pin);
    pin = '';
    if (r.ok) {
      pinFor = null;
      void open(entry.saved, entry.user);
    } else error = r.waitMs > 0 ? t('pin_wait', clock(Math.ceil(r.waitMs / 1000) * 1000)) : t('pin_wrong');
  }

  function choose(entry: Entry): void {
    error = null;
    if (entry.saved && hasPin(entry.saved)) {
      pinFor = entry;
      pin = '';
    } else if (entry.saved) void open(entry.saved, entry.user);
    else if (entry.user.HasPassword === false) void login(entry.user.Name, '');
    else void pick(entry);
  }

  function back(): boolean {
    if (pinFor) pinFor = null;
    else if (form && entries?.length) {
      picked = null;
      manual = false;
      error = null;
    } else return false;
    return true;
  }

  const screen = getContext<number>(SCREEN);
  onMount(() => {
    void loadUsers();
    return onBack(screen, back);
  });
</script>

<div class="page">
  <NavBar title={server.name} back={nav.depth > 1 || form || !!pinFor} />
  <div class="body">
    {#if pinFor}
      <div class="who">
        <Avatar user={pinFor.user} {api} size={96} />
        <h1 class="title-2">{t('pin_for', pinFor.user.Name)}</h1>
      </div>
      <form
        class="form"
        onsubmit={(e) => {
          e.preventDefault();
          void submitPin();
        }}
      >
        <TextField bind:value={pin} label={t('pin_for', pinFor.user.Name)} type="password" inputmode="numeric" autocomplete="off" enterkeyhint="go" autofocus />
        {#if error}<p class="footnote error" role="alert">{error}</p>{/if}
        <Button text={t('sign_in')} primary wide type="submit" {busy} />
      </form>
    {:else if form}
      <div class="who">
        {#if picked}<Avatar user={picked.user} {api} size={96} />{/if}
        <h1 class="title-2">{picked ? t('password_for', picked.user.Name) : t('other_user')}</h1>
      </div>
      <form
        class="form"
        onsubmit={(e) => {
          e.preventDefault();
          void login(picked ? picked.user.Name : name, password);
        }}
      >
        {#if manual}
          <TextField bind:value={name} bind:field={nameField} label={t('username')} autocomplete="username" enterkeyhint="next" />
        {:else if picked}
          <!-- Lets the iOS password manager pair the password with this account. -->
          <input class="sr-only" type="text" autocomplete="username" value={picked.user.Name} readonly tabindex="-1" aria-hidden="true" />
        {/if}
        <TextField bind:value={password} bind:field={passwordField} label={t('password')} type="password" autocomplete="current-password" enterkeyhint="go" />
        {#if error}<p class="footnote error" role="alert">{error}</p>{/if}
        <Button text={t('sign_in')} primary wide type="submit" {busy} />
      </form>
    {:else}
      <h1 class="large-title">{t('who_is_watching')}</h1>
      {#if entries === null && !loadError}
        <div class="loading"><Spinner /></div>
      {:else}
        <div class="grid">
          {#each entries ?? [] as entry (entry.user.Id)}
            <button class="user pressable" onclick={() => choose(entry)} disabled={busy}>
              <Avatar user={entry.user} {api} size={84} />
              <span class="subhead name">{entry.user.Name}</span>
            </button>
          {/each}
          <button class="user pressable" onclick={() => pick(null)} disabled={busy}>
            <Avatar user={null} {api} size={84} />
            <span class="subhead name label-2">{t('other_user')}</span>
          </button>
        </div>
        {#if error}<p class="footnote error" role="alert">{error}</p>{/if}
      {/if}
    {/if}
  </div>
</div>

<style>
  .page {
    height: 100%;
    position: relative;
  }
  .body {
    height: 100%;
    overflow-y: auto;
    padding: calc(var(--safe-top) + 44px + 28px) max(var(--gutter), var(--safe-right)) calc(var(--safe-bottom) + 24px) max(var(--gutter), var(--safe-left));
    display: flex;
    flex-direction: column;
    gap: 28px;
    max-width: 560px;
    margin: 0 auto;
  }
  .who {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 14px;
    text-align: center;
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
    gap: 24px 12px;
  }
  .user {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    min-width: 0;
  }
  .name {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .loading {
    display: grid;
    place-items: center;
    padding: 48px;
    color: var(--label-2);
  }
  .error {
    color: var(--red);
  }
</style>
