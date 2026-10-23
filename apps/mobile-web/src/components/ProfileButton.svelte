<script lang="ts">
  // The account, top right of the tab pages (as the Apple TV app): the user's picture or initial in a glass ring.
  // A tap opens its menu: Settings, switch user, add a server, sign out.
  import { t } from '$tv/i18n.svelte';
  import { api, prefs } from '$tv/session.svelte';
  import LogOut from '@lucide/svelte/icons/log-out';
  import ServerIcon from '@lucide/svelte/icons/server';
  import Settings from '@lucide/svelte/icons/settings';
  import Users from '@lucide/svelte/icons/users';
  import { fade } from 'svelte/transition';
  import { pop } from '../lib/motion';
  import { leave } from '../lib/account';
  import { nav } from '../lib/nav.svelte';
  import { showAlert } from '../lib/overlay.svelte';
  import Avatar from './Avatar.svelte';

  // floating: pinned top right over the page (Home's hero) rather than in a title row. The menu and its scrim are
  // placed against the page, so the button must not sit in a positioned box of its own.
  let { onMedia = false, floating = false }: { onMedia?: boolean; floating?: boolean } = $props();
  const session = $derived(prefs.session);
  let open = $state(false);

  function run(action: () => void): void {
    open = false;
    action();
  }

  function signOut(): void {
    showAlert({
      title: t('sign_out'),
      message: session ? `${session.userName} · ${session.server.name}` : undefined,
      actions: [
        { label: t('sign_out'), destructive: true, run: () => leave(true) },
        { label: t('cancel'), run: () => {} },
      ],
    });
  }
</script>

{#if session}
  <button class="me pressable" class:floating class:on-art={onMedia} aria-label={t('settings_account')} aria-expanded={open} onclick={() => (open = !open)}>
    <Avatar user={{ Id: session.userId, Name: session.userName }} api={api()!} size={30} />
  </button>
  {#if open}
    <div class="scrim" role="presentation" onclick={() => (open = false)} transition:fade={{ duration: 140 }}></div>
    <div class="menu" role="menu" in:pop={{ start: 0.6, duration: 340 }} out:pop={{ start: 0.85, duration: 180 }}>
      <div class="who">
        <Avatar user={{ Id: session.userId, Name: session.userName }} api={api()!} size={44} />
        <span class="text">
          <span class="headline ellipsis">{session.userName}</span>
          <span class="footnote label-2 ellipsis">{session.server.name}</span>
        </span>
      </div>
      <button class="item" role="menuitem" onclick={() => run(() => nav.selectTab('settings'))}><Settings size={19} aria-hidden="true" /><span>{t('tab_settings')}</span></button>
      <button class="item" role="menuitem" onclick={() => run(() => leave(false))}><Users size={19} aria-hidden="true" /><span>{t('switch_user')}</span></button>
      <button class="item" role="menuitem" onclick={() => run(() => nav.push({ name: 'servers', add: true }))}><ServerIcon size={19} aria-hidden="true" /><span>{t('add_server')}</span></button>
      <span class="sep" aria-hidden="true"></span>
      <button class="item destructive" role="menuitem" onclick={() => run(signOut)}><LogOut size={19} aria-hidden="true" /><span>{t('sign_out')}</span></button>
    </div>
  {/if}
{/if}

<style>
  /* The user's picture in a ring: the canvas's fill, or the dark fill over artwork. */
  .me {
    width: 34px;
    height: 34px;
    padding: 2px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    flex: none;
    background: var(--fill-3);
  }
  .me.on-art {
    background: var(--on-art);
  }
  /* Over Home's hero: centred in the top row (app.css --top-bar) as on the other tabs, with the page's side margin. */
  .floating {
    position: absolute;
    top: calc(var(--safe-top) + 5px);
    right: max(var(--gutter), var(--safe-right));
    z-index: 5;
  }
  .scrim {
    position: absolute;
    inset: 0;
    z-index: 40;
  }
  /* A menu as the desktop's and Android's: the raised surface, rounded, icon then label. */
  .menu {
    position: absolute;
    top: calc(var(--top-bar) + 4px);
    right: max(var(--gutter), var(--safe-right));
    width: 260px;
    padding: 6px;
    border-radius: var(--r-lg);
    background: var(--bg-elevated-2);
    box-shadow: var(--shadow-2);
    z-index: 41;
    transform-origin: top right;
  }
  .who {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 10px 12px;
  }
  .text {
    min-width: 0;
    display: flex;
    flex-direction: column;
  }
  .ellipsis {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .item {
    width: 100%;
    min-height: 44px;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 0 10px;
    border-radius: var(--r-sm);
    font-size: var(--fs-callout);
    color: var(--label);
    text-align: left;
  }
  .item :global(svg) {
    color: var(--label-2);
  }
  .item:active {
    background: var(--fill-2);
  }
  .sep {
    display: block;
    height: 0.5px;
    margin: 6px 10px;
    background: var(--separator);
  }
  .destructive,
  .destructive :global(svg) {
    color: var(--red);
  }
</style>
