<script lang="ts">
  // Android ServerScreen (ui/Setup.kt): type the server's address, or reopen the saved one. HTTPS only: an app served
  // over HTTPS cannot reach a plain HTTP server (mixed content), and the token must never cross the network in clear.
  // No LAN discovery: a web page cannot send the UDP broadcast Emby and Jellyfin answer on.
  import Server from '@lucide/svelte/icons/server';
  import { candidates, probe } from '$tv/api';
  import { t } from '$tv/i18n.svelte';
  import { prefs, setServer, type Server as SavedServer } from '$tv/session.svelte';
  import AppMark from '../components/AppMark.svelte';
  import Button from '../components/Button.svelte';
  import TextField from '../components/TextField.svelte';
  import { nav } from '../lib/nav.svelte';

  let { add = false }: { add?: boolean } = $props();

  let address = $state('');
  let busy = $state(false);
  let error = $state<string | null>(null);
  const saved = $derived(add ? null : prefs.server);
  // The dev server (npm run dev) also reaches the local mock servers over plain HTTP.
  const allowHttp = import.meta.env.DEV;

  // The HTTPS candidates of what was typed (Android Api.candidates), raced; the first server that answers wins.
  async function find(input: string): Promise<Awaited<ReturnType<typeof probe>>> {
    const list = candidates(input).filter((a) => allowHttp || /^https:/i.test(a));
    if (!list.length) return null;
    return new Promise((resolve) => {
      let pending = list.length;
      for (const a of list)
        void probe(a).then((found) => {
          if (found) resolve(found);
          else if (--pending === 0) resolve(null);
        });
    });
  }

  async function connect(input: string): Promise<void> {
    if (!input.trim() || busy) return;
    if (!allowHttp && /^http:\/\//i.test(input.trim())) {
      error = t('web_https_required');
      return;
    }
    busy = true;
    error = null;
    try {
      const found = await find(input);
      if (!found) {
        error = t('server_unreachable');
        return;
      }
      const server: SavedServer = { id: found.info.Id, name: found.info.ServerName ?? found.info.Id, address: found.address, kind: found.kind };
      if (add) {
        if (server.id === prefs.server?.id) error = t('server_is_main');
        else nav.push({ name: 'login', server, add: true });
        return;
      }
      setServer(server);
      nav.push({ name: 'login', server });
    } finally {
      busy = false;
    }
  }
</script>

<div class="page">
  <div class="intro">
    <AppMark size={72} />
    <h1 class="large-title">{t(add ? 'add_server' : 'welcome')}</h1>
    <p class="callout label-2">{t(add ? 'other_servers_hint' : 'welcome_sub')}</p>
  </div>
  <form
    class="form"
    onsubmit={(e) => {
      e.preventDefault();
      void connect(address);
    }}
  >
    <TextField bind:value={address} label={t('address_hint')} type="url" inputmode="url" autocomplete="url" enterkeyhint="go" />
    {#if error}<p class="footnote error" role="alert">{error}</p>{/if}
    <Button text={t('connect')} primary wide type="submit" {busy} />
  </form>
  {#if saved}
    <section class="saved">
      <h2 class="footnote label-2 eyebrow">{t('saved_server')}</h2>
      <button class="row pressable" onclick={() => connect(saved.address)}>
        <Server size={22} aria-hidden="true" />
        <span class="text">
          <span class="headline">{saved.name}</span>
          <span class="footnote label-2">{saved.address}</span>
        </span>
        <span class="footnote label-3">{saved.kind === 'emby' ? 'Emby' : 'Jellyfin'}</span>
      </button>
    </section>
  {/if}
</div>

<style>
  .page {
    height: 100%;
    overflow-y: auto;
    padding: calc(var(--safe-top) + 48px) max(var(--gutter), var(--safe-right)) calc(var(--safe-bottom) + 24px) max(var(--gutter), var(--safe-left));
    display: flex;
    flex-direction: column;
    gap: 32px;
    max-width: 560px;
    margin: 0 auto;
  }
  .intro {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .intro h1 {
    margin-top: 12px;
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .error {
    color: var(--red);
  }
  .eyebrow {
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin: 0 0 8px 16px;
  }
  .row {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px 16px;
    border-radius: var(--r-md);
    background: var(--bg-elevated);
    text-align: left;
    color: var(--label-2);
  }
  .text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    color: var(--label);
  }
  .text span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
