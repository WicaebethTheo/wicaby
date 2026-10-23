# Phone web app (iPhone)

`apps/mobile-web` is Wicaby for the iPhone, as an installable web app (a PWA): added to the Home Screen from Safari,
it opens full screen like an app, keeps its sign-in and updates itself. It is the official way to run Wicaby on iOS
and iPadOS, where an app outside the App Store would have to be signed again every seven days.

It is the TV web app's logic (`apps/tv-web/src/lib`: the API client, playback sessions, track choice, Home rows,
caches, multi-server, Trakt) under a phone interface laid out like the Android mobile app's, in Wicaby's own look
(Graphite, Geist, one accent). The handful of TV modules tied to the remote and the TV platform (focus, navigation,
overlays, the device profile, the platform layer) are swapped at build time for phone ones by a small Vite plugin
(`tvSeams` in `vite.config.ts`); the TV code is not edited for the phone. The desktop's admin sections are reused
the same way (`desktopSeams`, `src/desktop/`).

## What it does

- **Home:** the hero (or, for what was watched in the last days, a large "Resume" with the progress), Continue
  watching in large cards, next up, upcoming, recently added per library (series posters or episode thumbnails),
  because you watched; rows can be reordered and hidden.
- **Browse:** libraries in the user's own order (long press to drag), each as a virtualized grid with Emby's sorts
  and filters, collections, playlists, history, favourites, genres, people, search.
- **Details pages:** versions, audio and subtitle choice, seasons and episodes, cast and crew, extras, similar; the
  long-press menu of a title holds what Emby's own menu does (mark watched, playlists and collections, media info,
  identify and edit metadata for admins, split versions, share).
- **The player:** the Android mobile app's gestures (tap zones, double-tap seek, swipe seek with trickplay, pinch
  to fill), tracks, quality and version, chapters, speed, sleep timer, up next, playback info, AirPlay.
- **Offline:** downloads kept in the app's storage, played without the server.
- **Settings:** appearance (themes, accent, text size, poster size), Home, playback and subtitles, with the
  account's server-side preferences (audio and subtitle languages, subtitle mode, remembered choices); the profile
  picture and the password; several servers; administration for admins.

## How it plays media

The aim is the lightest work for the server, in this order (`src/lib/device-profile.ts`):

1. **Direct play** of the MP4 and MOV files Safari opens itself.
2. **Matroska remuxed on the phone:** MKV and WebM files are read straight from the server with Range requests,
   demuxed (`src/media/matroska.ts`) and remuxed to fragmented MP4 (`src/media/mp4.ts`, `src/media/remux.ts`) for
   Safari's ManagedMediaSource (iOS 17.1+). H.264, HEVC (Main 10, Dolby Vision), AV1 where the chip decodes it,
   AAC, Dolby Digital and Dolby Digital Plus (Atmos kept), FLAC and Opus play this way with no conversion.
   Text subtitles (SRT, ASS) and Blu-ray image subtitles (PGS, `src/media/pgs.ts`) are read from the file and drawn
   by the app, so the server never burns them into a transcode.
3. **Audio only converted:** for DTS, TrueHD or Vorbis, the server sends Matroska with the video copied and the
   audio converted, which the phone remuxes.
4. **The server's HLS:** for AirPlay, and for iOS before 17.1.
5. **A video transcode** only for what the iPhone cannot decode (MPEG-2, AV1 on older chips, DVD and DVB
   subtitles burnt in).

The player shows how the title plays (direct, remuxed, converted) in its top line and in playback info.

## Develop

```powershell
npm ci
$env:MOCK_DATASET = 'demo'; node tools/mock-server/mock-emby.mjs 8096 path\to\clip.mkv
npm run dev:mobile                                       # Vite on http://localhost:5399 (and the LAN address)
```

In the app, use the address `http://127.0.0.1:8096`, user `Wika`, password `wicaby` (plain `http://` is allowed
on the dev server only). A phone on the same network can open the LAN address Vite prints; a Home Screen install
needs the HTTPS build.

Tools in `apps/mobile-web/scripts` (outputs in `.dev/`):

| Command | What it does |
|---|---|
| `npm run shots -w apps/mobile-web [-- scene…]` | Screenshots in Playwright's WebKit at an iPhone's size, against the mock (`.dev/shots`). |
| `node apps/mobile-web/scripts/player-check.mjs [file.mkv…]` | Plays each MKV of `.dev/media` end to end in an installed Chromium (Brave or Chrome; `PLAYER_BROWSER` to choose): remuxed on the phone, plays, seeks. |
| `node apps/mobile-web/scripts/remux-check.mjs` | Remuxes each MKV of `.dev/media` with the app's code; ffmpeg must decode the result frame for frame (`FFMPEG_DIR` if ffmpeg is not on the PATH). |
| `node apps/mobile-web/scripts/pgs-check.mjs` | Muxes a generated PGS track with ffmpeg and checks the app decodes it pixel for pixel; also writes `.dev/media/pgs/h264-pgs.mkv` for `PLAYER_PGS=1 node apps/mobile-web/scripts/player-check.mjs pgs/h264-pgs.mkv`. |
| `node apps/mobile-web/scripts/reorder-check.mjs` | Drags a library with real touch events (Chromium's DevTools protocol) and checks the order is kept. |

Playwright's WebKit on Windows has no MediaSource and draws no backdrop blur, so the player is checked in Chromium
and the look on a real iPhone.

Checks: `npm run check:mobile` (svelte-check, the service worker's types and the strings) and
`node tools/checks/mobile-web-check.mjs` (part of `npm run checks`: the PGS decoder and the text subtitles).

## Strings

The app reads the Android catalogues at build time (`scripts/android-strings.mjs`: `:tv`, `:livetv-ui`, `:core`,
then `:mobile`, whose wording wins), so it speaks like the Android apps in French and English. The few words only
the web app says live in `apps/mobile-web/res/values` (French) and `res/values-en` (English), in the same format,
as `web_*` keys. `npm run check:mobile` fails on a key no catalogue has, and on a `res` key missing in one language
or with other placeholders.

## Hosting and install

The app is a static site: the `Phone web app` workflow checks and builds it on every change, and publishes it on
the repository's GitHub Pages from `main` (Settings > Pages > Source: GitHub Actions). Only the app shell is served
from there; the phone talks to the media server directly, never through Pages. Any other HTTPS static host works
the same way (`npm run build:mobile`, then publish `apps/mobile-web/dist`).

To install it, open the address in **Safari** on the iPhone, tap **Share**, then **Add to Home Screen**. Updates
install in the background; a banner offers to reload into the new version, and Settings > About can check for one.

## Server requirements

- **HTTPS.** The app is served over HTTPS, so the server must be reached over HTTPS too (a reverse proxy with a
  valid certificate); Safari refuses an `http://` server from an HTTPS page.
- **Cross-origin requests.** The app calls the server from Safari: Emby and Jellyfin answer cross-origin requests
  by default. Direct play reads files with Range requests, which they also allow.
- Sign-in tokens stay in the app's storage, scoped to the address the app is served from: serve it from its own
  host (a subdomain of its own, or Pages under a user or organisation with no other Pages site), so no other site
  shares that storage. The password is sent once to the server and never kept.

## Limits

- **Safari's rules for Home Screen apps:** no Chromecast (Safari has no Google Cast; AirPlay works, through the
  server's HLS for remuxed titles), no picture in picture (WebKit bug 303885), no setting the volume or the
  brightness from the app, downloads kept within Safari's storage quota.
- **iOS 26 and later:** the status bar stays opaque (with a translucent one iOS blurs the content under the clock).
  A video's sound would also show the app itself in the Dynamic Island while it is open; the player keeps it out
  (`src/lib/media-element.ts`).
- **Not on the phone yet:** music, Live TV, photos and the comic reader (their routes show a placeholder), Plex and
  IPTV sources, the mesh VPN and the other Android-only features.

## Tested on

- **iPhone:** an iPhone 15 Pro Max on iOS 27, installed from Safari, against Emby over HTTPS.
- **Engines:** Playwright's WebKit (screens) and Chromium (playback) against the mock servers.
