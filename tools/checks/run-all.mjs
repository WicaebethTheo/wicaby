// Runs every self-check in tools/checks and exits non-zero if any fails.
// Usage: npm run checks   (or: node tools/checks/run-all.mjs)
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const here = import.meta.dirname;
const checks = [
  ['privacy-check.mjs'],
  // Graphite colour tokens: generated CSS and Kotlin match packages/tokens/tokens.json.
  ['tokens-check.mjs'],
  // Every theme's text meets WCAG AA (4.5:1 body, 3:1 accent controls).
  ['contrast-check.mjs'],
  // Desktop motion: no colour/size transitions, durations only through the --t-* tokens.
  ['motion-check.mjs'],
  ['i18n-check.mjs', '--strict'],
  ['i18n-check.mjs', '--self-test'],
  ['livetv-a11y-check.mjs'],
  ['hdr-check.mjs'],
  // "What's this song?": the Shazam signature against SongRec's reference.
  ['song-id-check.mjs'],
  ['track-check.mjs'],
  // TV web app (docs/tv-web.md): its inflate, the comic ZIP reader over Range requests, page order, the bundle syntax.
  ['tv-web-check.mjs'],
  // Phone web app (docs/mobile-web.md): its PGS subtitle decoder and the text subtitles it reads from Matroska.
  ['mobile-web-check.mjs'],
  ['parity-check.mjs'],
  ['skip-check.mjs'],
  // AniSkip fallback: response parsing and the MAL id + episode a season resolves to (fixtures/aniskip.json).
  ['aniskip-check.mjs'],
  // Community timestamps: TheIntroDB and IntroDB parsing, sanity drops, priority merge (fixtures/community-segments.json).
  ['community-segments-check.mjs'],
  // External ratings: MDBList route and parser (saved sample answer).
  ['ratings-check.mjs'],
  ['home-rows-check.mjs'],
  // Sidebar sections by media type (sidebar redesign spec §3.2).
  ['sidebar-groups-check.mjs'],
  ['livetv-check.mjs'],
  // Client-side IPTV: M3U and XMLTV parsers, loader limits, the mock provider.
  ['iptv-check.mjs'],
  ['tv-home-check.mjs'],
  ['play-on-check.mjs'],
  ['mock-ws-check.mjs'],
  ['sessions-mock-check.mjs'],
  ['cast-mock-check.mjs'],
  ['cast-sender-check.mjs'],
  ['remote-check.mjs'],
  ['syncplay-check.mjs'],
  ['message-check.mjs'],
  ['cast-check.mjs'],
  ['cast-dlna-check.mjs'],
  ['cast-castv2-check.mjs'],
  ['cast-token-check.mjs'],
  ['shortcuts-check.mjs'],
  ['seek-check.mjs'],
  ['quality-check.mjs'],
  ['subtitles-check.mjs'],
  ['livetv-mock-check.mjs'],
  ['livetv-session-check.mjs'],
  ['continue-check.mjs'],
  ['zip-check.mjs'],
  ['comic-cover-check.mjs'],
  ['comic-formats-check.mjs'],
  ['comic-folders-check.mjs'],
  ['download-path-check.mjs'],
  ['bif-check.mjs'],
  ['mesh-selfcheck.mjs'],
  ['lan-mesh-check.mjs'],
  ['vpn-selfcheck.mjs'],
  ['torrents-selfcheck.mjs'],
  ['media-url-check.mjs'],
  ['token-binding-check.mjs'],
  ['vault-check.mjs'],
  ['trakt-check.mjs'],
  ['scrobble-check.mjs'],
  ['mpv-args-check.mjs'],
  ['desktop-comfort-check.mjs'],
  ['linux-desktop-check.mjs'],
  ['desktop-hardening-check.mjs'],
  ['desk-shell-check.mjs'],
  ['player-exit-check.mjs'],
  ['desktop-recovery-check.mjs'],
  ['history-mock-check.mjs'],
  ['profiles-mock-check.mjs'],
  ['access-schedule-mock-check.mjs'],
  ['music-mock-check.mjs'],
  ['music-check.mjs'],
  // Music covers: fallbacks for missing album and artist art, placeholder, sizes, dominant colour (music spec §4.A).
  ['music-art-check.mjs'],
  // Feishin-inspired library UI: release type, album jump, multi-select, quality badge, tint rule (music spec §4.C).
  ['music-ui-check.mjs'],
  ['music-wave5-check.mjs'],
  ['photos-mock-check.mjs'],
  ['photos-check.mjs'],
  // Immich photo source (photos spec PH-11, PH-12).
  ['immich-mock-check.mjs'],
  ['immich-check.mjs'],
  ['tiles-check.mjs'],
  ['release-check.mjs'],
  // Desktop update notice: version compare, asset per install, GitHub answer at the trust boundary.
  ['app-update-check.mjs'],
  ['licence-check.mjs'],
  ['flavour-check.mjs'],
  // File sources (file-sources-spec FS-00 to FS-05, FS-12 UNC).
  ['caps-check.mjs'],
  ['server-kind-check.mjs'],
  ['files-core-check.mjs'],
  ['files-mock-check.mjs'],
  ['files-store-check.mjs'],
  ['files-routes-check.mjs'],
  ['files-playback-check.mjs'],
  ['files-smb-check.mjs'],
  ['files-mdns-check.mjs'],
  // Photo sources on files (EXIF reader vectors, the photo index over a folder and the WebDAV mock).
  ['photo-files-check.mjs'],
  // Plex backend (plex-spec PX-00 to PX-03).
  ['plex-mock-check.mjs'],
  ['plex-map-check.mjs'],
  ['plex-routes-check.mjs', '--self-test'],
  ['plex-routes-check.mjs'],
  // Plex browse and sign-in on the desktop (PX-04 to PX-07).
  ['plex-connections-check.mjs'],
  ['plex-link-check.mjs'],
  ['plex-browse-check.mjs'],
  // Plex playback on the desktop (PX-08 to PX-10).
  ['plex-playback-check.mjs'],
  ['plex-cast-check.mjs'],
  // Plex Live TV and DVR on the desktop (PX-11).
  ['plex-livetv-check.mjs'],
  // Navidrome (OpenSubsonic) music source: vectors and the desktop client against mock-navidrome (music spec §4.B).
  ['subsonic-check.mjs'],
  // README images carry no metadata (tEXt, iTXt, eXIf, caBX, WebP EXIF/XMP).
  ['../screenshots/strip-metadata.mjs', '--self-test'],
  ['../screenshots/strip-metadata.mjs', '--check'],
];

const failed = [];
for (const [script, ...args] of checks) {
  console.log(`\n== ${script} ${args.join(' ')}`.trimEnd());
  // A check that waits forever on a mock's log line fails here, under its name, not at the CI job timeout.
  const r = spawnSync(process.execPath, [path.join(here, script), ...args], { stdio: 'inherit', timeout: 300_000, killSignal: 'SIGKILL' });
  // shortcut: SIGKILL reaches only the check, not a mock it spawned, so later checks may fail on its port; the
  // run still fails. Kill the process tree if that noise ever hides a real failure.
  if (r.error?.code === 'ETIMEDOUT') console.log(`${script}: timed out after 300 s`);
  if (r.status !== 0) failed.push(script);
}

console.log(failed.length ? `\n${failed.length} check(s) failed: ${failed.join(', ')}` : `\nAll ${checks.length} checks passed.`);
process.exit(failed.length ? 1 : 0);
