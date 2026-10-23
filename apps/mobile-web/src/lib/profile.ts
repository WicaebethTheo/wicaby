// The signed-in user's own account on the server (Emby web's Profile page): their password and their picture.
// Emby and Jellyfin differ on the routes (as the desktop admin's users/userAdmin.ts); a picture goes up as its
// base64 text with the image's type, as every image upload to these servers.
import { ApiError, type Api } from '$tv/api';
import { noteImageTag } from './user.svelte';

export function changePassword(api: Api, current: string, next: string): Promise<void> {
  const body = { CurrentPw: current, NewPw: next, ResetPassword: false };
  return api.isEmby ? api.request('POST', `/Users/${api.userId}/Password`, undefined, { Id: api.userId, ...body }) : api.request('POST', '/Users/Password', { userId: api.userId }, body);
}

// A photo from the library or the camera, square-cropped from its centre and sent at 512 px: a phone's 12 MP
// picture is 5 MB of base64 otherwise, and the server would keep it whole.
async function squareJpeg(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const size = Math.min(512, side);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  canvas.getContext('2d')!.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode'))), 'image/jpeg', 0.9));
}

export async function setAvatar(api: Api, file: File): Promise<void> {
  const blob = await squareJpeg(file);
  const data = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
  const url = api.isEmby ? api.url(`/Users/${api.userId}/Images/Primary`) : api.url('/UserImage', { userId: api.userId! });
  const res = await fetch(url, { method: 'POST', headers: { ...api.authHeaders(), 'Content-Type': 'image/jpeg' }, body: btoa(bin) });
  if (!res.ok) throw new ApiError('upload failed', res.status);
  await refreshTag(api);
}

export async function removeAvatar(api: Api): Promise<void> {
  await (api.isEmby ? api.request('DELETE', `/Users/${api.userId}/Images/Primary`) : api.request('DELETE', '/UserImage', { userId: api.userId! }));
  await refreshTag(api);
}

// The new tag changes every Avatar's URL, so the old picture is not served from the cache.
async function refreshTag(api: Api): Promise<void> {
  const u = await api.me();
  noteImageTag({ Id: u.Id, PrimaryImageTag: u.PrimaryImageTag ?? undefined });
}
