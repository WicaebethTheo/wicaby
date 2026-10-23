// The desktop renderer's api module, for the admin sections: after a change they drop the cached GETs, which here
// means reloading what is on screen.
import { changed } from '$tv/load.svelte';

export function invalidateApiCache(): void {
  changed();
}
