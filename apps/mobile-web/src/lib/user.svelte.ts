// The signed-in user as the server knows them (/Users/Me), read once per server and account for the session:
// - what they may do there (their Policy); `adminOf` holds the answers once in, for the synchronous checks (the
//   desktop admin's isAdminFor);
// - their picture's tag, which a session does not keep: `imageTags` (kept on the phone, so the saved accounts of
//   the login screen show their picture too) completes any user an Avatar is given without one.
import type { UserDto } from '$shared/models';
import type { Api } from '$tv/api';
import { load, save } from '$tv/storage';

const mes = new Map<string, Promise<UserDto | null>>();
export const adminOf = $state<Record<string, boolean>>({});
export const imageTags = $state<Record<string, string>>(load<Record<string, string>>('userImages', {}));

export const adminKey = (api: Api): string => `${api.serverId ?? api.address}/${api.userId}`;

// A user's picture tag as last seen (a public list, /Users/Me): kept for the next start.
export function noteImageTag(user: Pick<UserDto, 'Id' | 'PrimaryImageTag'>): void {
  const tag = user.PrimaryImageTag;
  if (tag === imageTags[user.Id] || (!tag && !(user.Id in imageTags))) return;
  if (tag) imageTags[user.Id] = tag;
  else delete imageTags[user.Id];
  save('userImages', $state.snapshot(imageTags));
}

export function me(api: Api): Promise<UserDto | null> {
  const key = adminKey(api);
  if (!mes.has(key)) {
    const ask = api.me().then(
      (u) => {
        adminOf[key] = !!(u as { Policy?: { IsAdministrator?: boolean } }).Policy?.IsAdministrator;
        noteImageTag(u);
        return u;
      },
      () => null,
    );
    mes.set(key, ask);
  }
  return mes.get(key)!;
}

export const isAdmin = (api: Api): Promise<boolean> => me(api).then((u) => !!(u as { Policy?: { IsAdministrator?: boolean } } | null)?.Policy?.IsAdministrator);
