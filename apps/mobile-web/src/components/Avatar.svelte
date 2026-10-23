<script lang="ts">
  // A user's picture, or their initial on a neutral disc (none: "another user"). A user given without their
  // picture's tag (a saved session) takes the one last seen for them (lib/user).
  import type { Api } from '$tv/api';
  import type { UserDto } from '$shared/models';
  import User from '@lucide/svelte/icons/user';
  import { imageTags } from '../lib/user.svelte';

  let { user, api, size = 84 }: { user: Pick<UserDto, 'Id' | 'Name' | 'PrimaryImageTag'> | null; api: Api; size?: number } = $props();
  const src = $derived(user ? api.userImage({ Id: user.Id, PrimaryImageTag: user.PrimaryImageTag ?? imageTags[user.Id] }, Math.ceil(size * (window.devicePixelRatio || 2))) : undefined);
  let failed = $state(false);
  $effect(() => {
    void src;
    failed = false;
  });
</script>

<span class="disc" style:width="{size}px" style:height="{size}px" style:font-size="{size * 0.42}px">
  {#if src && !failed}
    <img {src} alt="" decoding="async" onerror={() => (failed = true)} />
  {:else if user}
    <span aria-hidden="true">{user.Name.slice(0, 1).toUpperCase()}</span>
  {:else}
    <User size={size * 0.42} aria-hidden="true" />
  {/if}
</span>

<style>
  .disc {
    display: grid;
    place-items: center;
    border-radius: 50%;
    overflow: hidden;
    background: var(--fill-3);
    color: var(--label-2);
    font-weight: 600;
    flex: none;
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
</style>
