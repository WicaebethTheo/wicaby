// Server kind branches (file-sources-spec FS-00): with a third kind ('files', and 'plex' later) a test that means
// "is Jellyfin" by saying "is not Emby" sends the new kind down the Jellyfin path. In apps/desktop/src:
// - `!== 'emby'`, `!isEmby` and the inline label `'Jellyfin' : 'Emby'` fail (use shared/server-caps.ts caps() or
//   kindLabel());
// - `=== 'emby'` is allowed only in the files listed below, each audited: the 'files' kind never reaches them
//   (admin, Live TV, cast, the server socket and discovery) or is handled before (FilesClient overrides the
//   ApiClient dialect; playback-service loadExtras checks caps().localUserData). A new one must be audited and listed.
// - 'plex' (plex-spec PX-02): the same files were audited for it. Until the Plex client exists (PX-06) no plex session
//   can be built, and then PlexClient overrides prefix, auth and media URLs like FilesClient; the Emby-or-else
//   branches a plex session would still reach are its own work packages: server-socket (PX-06 notifications),
//   playback-service loadExtras (PX-09: Plex segments + BIF), cast targets (caps.sessionsRemote is false).
// Android is not scanned yet (its FS-00 half is not done). Usage: node tools/checks/server-kind-check.mjs
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..', 'apps', 'desktop', 'src');
const ALLOWED_EMBY_EQ = {
  'main/cast/targets.ts': 2,
  'main/connection/api-client.ts': 3,
  'main/connection/connection-manager.ts': 1,
  'main/connection/discovery.ts': 1,
  'main/connection/server-socket.ts': 2,
  'main/playback/playback-service.ts': 1,
  'renderer/admin/Devices.svelte': 1,
  'renderer/admin/libraries/FolderBrowser.svelte': 1,
  'renderer/admin/Plugins.svelte': 2,
  'renderer/admin/Transcoding.svelte': 2,
  'renderer/admin/users/UserEditor.svelte': 1,
  // heroQueryable: Emby or Jellyfin, every other kind (files, plex, navidrome) is false.
  'renderer/lib/hero-feed.ts': 1,
  // canShuffle: Emby or Jellyfin, every other kind (files, plex, navidrome) is false.
  'renderer/lib/shuffle.ts': 1,
  'renderer/lib/livetv/store.svelte.ts': 2,
  'shared/livetv/dialect.ts': 9,
  'shared/livetv/model.ts': 3,
  'shared/livetv/timers.ts': 1,
};
const BANNED = [
  [/!==\s*['"]emby['"]/, "`!== 'emby'` (means Jellyfin? use caps())"],
  [/!isEmby\b/, '`!isEmby`'],
  [/['"]Jellyfin['"]\s*:\s*['"]Emby['"]/, "inline kind label (use kindLabel())"],
];

const problems = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|svelte)$/.test(e.name)) scan(p);
  }
}
function scan(file) {
  const rel = path.relative(root, file).replace(/\\/g, '/');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let eqEmby = 0;
  lines.forEach((line, i) => {
    for (const [re, why] of BANNED) if (re.test(line)) problems.push(`${rel}:${i + 1}: ${why}`);
    eqEmby += (line.match(/===\s*['"]emby['"]/g) ?? []).length;
  });
  const allowed = ALLOWED_EMBY_EQ[rel] ?? 0;
  if (eqEmby > allowed) problems.push(`${rel}: ${eqEmby} \`=== 'emby'\` test(s), ${allowed} audited: a 'files' (or 'plex') source takes the else branch there`);
}
walk(root);
if (problems.length) {
  console.error(`server-kind-check: ${problems.length} problem(s)\n${problems.join('\n')}`);
  process.exit(1);
}
console.log('server-kind-check: ok');
