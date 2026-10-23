<!--
  MAINTAINER NOTE (staging draft; delete this comment before publishing).
  Before tagging v0.2.0:
  - fill in the dependency upgrades below (the TODO comment under "Changed");
  - clear the release blockers listed at the top of THIRD_PARTY_NOTICES.md and SECURITY.md.
-->

# Changelog

All notable changes to Wicaby are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Wicaby is versioned as a whole: a release tag (`vX.Y.Z`) covers the Windows desktop app, the
Android TV app, the Android mobile app and the mesh helper. The Android apps also carry their own
`versionName` and `versionCode` (used by the in-app updater); they are listed in each entry.

## [Unreleased]

### Added

- Phone web app (`apps/mobile-web`) for iPhone and iPad (iOS 17.1+): Wicaby installed from Safari to the Home
  Screen, laid out like the Android mobile app on the TV web app's logic. Home with a large resume for what was
  watched lately, libraries in your own order, details pages and Emby's title menu, search, the player with the
  Android gestures, downloads, AirPlay, the account's server-side track preferences, the profile picture and the
  password, and administration. MKV files play without conversion (remuxed on the phone for Safari, Dolby Vision
  and Dolby Digital Plus kept), with their SRT, ASS and Blu-ray PGS subtitles drawn by the app instead of burnt in
  by the server. Published on GitHub Pages by the `Phone web app` workflow; see `docs/mobile-web.md`.

### Fixed

- TV web app with Emby 4.8 and later: lists now ask for the play dates by name (`UserDataLastPlayedDate`,
  `UserDataPlayCount`), which Emby otherwise leaves out, so Continue watching is sorted by when each title was
  last watched.

## [0.12.0] - 2026-10-22

Android TV 0.12.0 (versionCode 40), Android mobile 0.12.0 (versionCode 37).

### Added

- TV web app (`apps/tv-web`) for Samsung Tizen 4+ and LG webOS 4+ TVs, from 2018 models on: the Android TV app
  rebuilt for TVs that only run web apps, with its screens, its D-pad model and its strings. Home, search,
  libraries, details, settings; the player plays through AVPlay on Tizen and the TV's own decoders on webOS, with a
  device profile built from what the TV reports, tracks, its own subtitles, quality presets, chapters, trickplay,
  skip intro and credits, up next, speed, sleep timer and playback info; music with synced lyrics; Live TV with the
  guide, zapping, number entry and recordings; photos; a comic reader for CBZ and image EPUB; several servers at
  once; Trakt scrobbling. Also, as on Android TV: the settings in the shared categories, the profile menu and watch
  history, "Who is watching?" with profile PINs, local and remote server addresses, "Play on Wicaby" and remote
  control, the screensaver and the music ambient layout, series track memory, remembered speed and picture
  format, and the rows reloading on return, on server changes and every 5 minutes; and 0.11.0's Quick Connect,
  AniSkip, external ratings, SDH and AD tracks, ListenBrainz and Last.fm scrobbling and SyncPlay. It installs under
  the web TV app's ids, so it updates an installed web TV build in place and takes over its device, its servers and
  their accounts, and its MDBList key (its other settings start from the defaults). Test builds only: the unsigned `.wgt` and
  the `.ipk` are workflow artifacts. See docs/tv-web.md.
- Android TV player: a "Next Episode" button (or "Up Next" in a play queue) in the control bar, shown when there is a
  next item; it plays it the way the Up Next card does. Holding the remote's Next key no longer skips several items.
- Desktop music: a Stop button beside Play/Pause in the bar and the full-screen player. Stop ends the playback, reports
  it to the server and hides the bar; the queue is no longer restored at the next start after a Stop.
- Desktop comics: a books library opens on a "Folders" view that follows the server's folder tree (breadcrumbs, parent
  folder; a folder shows its own image or its first book's cover). "All Books" keeps the flat list; the choice is
  remembered per library.
- Community timestamps (desktop, TV web app, Android TV, Android mobile): Settings > Playback > "Community timestamps" fills in the intro, recap,
  end credits and preview the server has no markers for, from TheIntroDB and IntroDB (the TV web app asks TheIntroDB
  only: IntroDB does not allow cross-origin requests). The server's own markers win, then TheIntroDB, IntroDB and
  AniSkip; each kind follows its usual Ask / Auto / Off setting, and the credits drive Up Next. Off by default: it
  sends the watched title's TMDB, TVDB or IMDb id and the episode numbers to these services.
- Settings > Home & libraries > "Episodes in Search" (Android TV, TV web app): off, typing a series' name lists the
  series without every one of its episodes.

### Removed

- Web TV app (`apps/webtv`), with its workflow, its GitHub Pages demo and docs/webtv.md: the TV web app replaces it.

## [0.11.2] - 2026-10-20

Android TV 0.11.2 (versionCode 39), Android mobile 0.11.2 (versionCode 36); no Android change.

### Fixed

- Desktop: resuming the same title again in one session started from the position it had before the last
  viewing (#14). Pages now reload the position as soon as the server has the stop report.

## [0.11.1] - 2026-10-20

Android TV 0.11.1 (versionCode 38), Android mobile 0.11.1 (versionCode 35); no Android change.

### Fixed

- Linux: in a Wayland session Wicaby now runs as a native Wayland app by default, since under XWayland the
  window never showed on hybrid Intel + NVIDIA setups (#14). Video plays in mpv's own window there, with
  mpv's controls, instead of the built-in player; `WICABY_OZONE=x11` brings back the embedded player.

## [0.11.0] - 2026-10-20

Android TV 0.11.0 (versionCode 37), Android mobile 0.11.0 (versionCode 34).

### Added

- Quick Connect sign-in on Jellyfin (all apps): the login screen shows a 6-digit code to approve from a device that
  is already signed in, so no password has to be typed with a remote. Desktop, mobile and the TV web app can also
  approve another device's code from Settings > Accounts.
- AniSkip for anime (desktop, Android): when the server has no intro or credits markers, the opening, ending and
  recap times come from the community AniSkip database (needs a MyAnimeList or AniList id; off by default).
- External ratings (all apps): IMDb, Rotten Tomatoes, Metacritic, Letterboxd and TMDb scores on movie and series
  pages, with a free MDBList API key (off until a key is set; answers cached for 7 days).
- Accessibility tracks (all apps): SDH and AD badges in the track pickers, a "Prefer SDH subtitles" setting, and an
  audio description setting (Prefer / Avoid / No preference). With Avoid, the default, an audio description track is
  never picked automatically when a normal track exists in the same language.
- Music scrobbling to ListenBrainz and Last.fm (desktop, Android), for every music source, with an offline queue.
  Off until an account is connected.
- Watch together with Jellyfin SyncPlay (all apps): create or join a group; play, pause and seek apply to everyone.
- "What's this song?" (desktop with mpv, Android in direct play): identifies the music playing in a film or series
  through Shazam, with links and "Find in my library". Only a short audio fingerprint is sent.

### Fixed

- Linux (AppImage) on Wayland ([#14](https://github.com/WicaebethTheo/wicaby/issues/14)): the window icon loads,
  the window is shown even if it never reports ready, `WICABY_OZONE=x11|wayland|auto` picks the display backend,
  `WICABY_DISABLE_GPU=1` turns off GPU acceleration of the interface, and on native Wayland video falls back to the
  built-in player because mpv cannot be embedded there. mpv start-up failures no longer blame the server.

- Android TV: the focused tab's pill in the top bar keeps its rounded ends on the first and last text tabs (Home,
  the last library) instead of being cut flat by the scrolling row
  ([#12](https://github.com/WicaebethTheo/wicaby/issues/12)).

## [0.10.15] - 2026-10-19

Android TV 0.10.15 (versionCode 36), Android mobile 0.10.15 (versionCode 33).

### Fixed

- Desktop player: the volume slider follows the pointer live and no longer bounces on release; arrow keys and
  the wheel add up their steps and unmute. The seek knob no longer snaps back to the old position after a drag,
  a key, chapter or digit seek. Controls hide again after a menu closes or a long scrub. The skip flash shows the
  real step, the bar no longer changes width at one hour, the skip-intro pill fades out, and the live timeshift
  bar can be dragged.
- Desktop music and casting: no snap-back on the music and cast seek bars; the music volume no longer bounces,
  respects mute and the 150 % boost; the equalizer shows its value while dragging and no longer drops audio on
  each arrow step; queue rows keep focus after a removal and no longer jump back after a drag; lyrics stay
  centred after a resize.
- Desktop browsing: going back to Search, a library or Home returns to where you were; switching seasons starts
  at episode 1; the watched check reacts at once; the Home banner no longer switches title on reload; changing
  the sort or filter scrolls to the top; Undo toasts stay up under the pointer; recent searches no longer fill up
  with half-typed terms; the title-bar search follows the search page.
- Desktop settings: dropdown menus are no longer cut off by their group; leaving search scrolls to the top;
  shortcut recording stops when clicking elsewhere; the reset confirmation no longer disarms under the cursor.
- Android TV: the seek bar no longer pushes the title and clock up on every press nor snaps back; libraries keep
  their scroll position on Back; favourite and watched react at once; series open on the season of the next
  episode; the episode row no longer blinks while moving across seasons; the sleep countdown no longer jiggles
  the buttons.
- Phones: the player controls no longer fade out under the finger while scrubbing; no snap-back on the video,
  music and cast seek bars; the music play/pause icon is right while buffering; favourite and watched react at
  once; pull to refresh shows that it refreshes.
- Web TV (test): remote fast-forward and rewind add up, use the seek step setting and show on screen; holding
  Back no longer exits the app; changing the audio track keeps the speed and no longer replays the last second.

## [0.10.14] - 2026-10-19

Android TV 0.10.14 (versionCode 35), Android mobile 0.10.14 (versionCode 32).

### Changed

- Settings use the same categories, in the same order, on desktop, Android TV and phones: General, Appearance,
  Home & libraries, Playback, Video, Audio, Subtitles, Music, Casting, Accounts, Sources, Remote access,
  Downloads, Keyboard, System, About. Each app shows only the categories it has settings for. No setting was
  removed and stored settings are kept.
- Desktop: new Video, Music, Casting and Sources panes; Torrents moved into Downloads, Trakt into Accounts, the
  window and notification options into General, Privacy and Advanced into System. Duplicate rows (automatic
  update check, logs, data folder) now appear once. Old `?pane=` links still open the right pane.
- Android TV: Interface and Trakt are no longer separate sections; every group has a title. Clearing remembered
  settings, resetting rows or tabs, signing out, disconnecting Trakt and removing Immich now ask for confirmation.
- Phones: Settings is a list of categories, each opening its own page, instead of one long page.
- Clearer labels: "Control from other devices" (was "Allow remote control"), "ReplayGain preamp" and
  "Equalizer preamp".

### Fixed

- Android TV: the settings section list scrolls, so every section stays reachable with the remote.

## [0.10.13] - 2026-10-19

### Added

- Desktop: the comic reader opens CBR (RAR 4 and RAR 5), CB7 (7z), CBT (tar), PDF and image EPUB books, as well
  as CBZ. The file's contents decide the format, so a CBR named .cbz still opens. RAR, 7z and tar are read by
  libarchive (BSD) in a separate worker, with the same page, size and entry limits as CBZ; no UnRAR code is
  used. PDF pages are drawn by pdf.js. Password-protected archives and DRM books show a clear message, and so do
  text EPUBs (novels), which the reader does not open.
- Desktop: books without a server cover show their first page in every format: CBZ, EPUB, CBR and CBT are read
  with a few Range requests (a CBR or CBT cover needs at most its first 8 MiB), PDF draws page 1. A CB7 shows
  its cover once it has been opened.
- Android TV and mobile: the comic reader opens the same formats, CBR (RAR 4 and RAR 5), CB7, CBT, PDF and image
  EPUB, as well as CBZ. RAR, 7z and tar are read by libarchive (BSD, through libarchive-android) and extracted
  once into the comic cache with the same limits; PDF pages are drawn by Android's own PDF renderer. Covers:
  CBZ, EPUB, CBR and CBT from the server with Range requests, CB7 and PDF once the book has been opened.
- Web TV app (preview, not released): the desktop interface for LG webOS 6+ and Samsung Tizen 6.5+ TVs, with Emby
  and Jellyfin, remote navigation (arrows, OK, Back, media keys) and the TV's own video decoders. Every push to main
  builds an LG `.ipk` and an unsigned Samsung `.wgt` as workflow artifacts, and a browser demo with a built-in demo
  server on GitHub Pages. See docs/webtv.md.
- Web TV demo: the first visit opens signed in to the built-in demo server, with a Demo badge and a
  "Connect your server" button.
- Web TV app: a 10-foot look on TVs (the layout drawn 1.5 times larger, an always visible focus ring, no
  scrollbars), also in a browser with `?tv=webos`; the CSS is rewritten for Chromium 79 to 85 so component styles,
  focus states and item backdrops survive on webOS 6 and Tizen 6.5 (checked in Chromium 79 and 85 snapshots).
- Web TV app: a title the TV has to transcode resumes at its resume point (it restarted at 0:00 and reported that
  position back); the remote's focus scrolls into view on Chromium 79 to 85; glass buttons get an opaque fill
  without blur; flex gaps are replaced by margins on webOS 6; the search field's Ctrl K hint is hidden on TVs. On
  the Pages demo a real server's sign-in is kept for the browser tab only (the github.io origin is shared).
- New themes on every app: Slate (graphite with a cool tint), Cinema (warm tones for evening viewing) and High
  Contrast (sharper text, no transparency). Graphite stays the default, and body text meets the WCAG AA contrast
  level in every theme.
- Desktop and Android mobile: a Light theme, and Automatic, which follows the system's light or dark mode. Video,
  photos, comics and item pages stay dark.
- Android mobile (Android 12 and later): a Wallpaper accent colour taken from your wallpaper; the rest of the app keeps
  its theme. It comes first among the colours, and the chosen colour's name shows under them.
- Desktop and Android mobile, Light theme: switches and sliders have a darker track so they stand out on the pale
  background. On the desktop, an item page keeps its artwork dark while the cast, episodes and similar titles below sit
  on the light background, the Home artwork fades into the page instead of stopping on a hard line, and white channel
  logos in the TV guide show as dark logos instead of sitting on black blocks.
- High Contrast: text fields, segmented controls, search, guide cells and settings groups get visible outlines, and
  the keyboard focus shows as a ring on the desktop.
- Android TV: in Settings and the setup, moving down to the themes lands on the selected one, the focused theme card is
  no longer cut at the edges, and the longer French theme names fit. The one-time theme suggestion on Home is easier to read,
  moves you to the row below once you choose, and still shows if you only looked at the themes during setup.
- Android mobile: Theme, Accent and Language are now at the top of Settings, the theme list opens on your current
  theme with a clearer check mark, and the back arrow in the setup is visible in the Light theme.
- Desktop: the theme cards in Settings show keyboard focus with a clear ring.
- Android TV: Home suggests the OLED or Cinema theme once. Settings and the setup show every theme as a small preview.
- Navidrome (and other OpenSubsonic servers): add one in Sources > Add a Source > Navidrome with its address, then
  your user name and password. Its music opens in the usual music player, with your favourites (Navidrome's stars)
  and playlists kept on the server, lyrics, the queue and plays sent to Navidrome. Desktop, Android TV and mobile.
  The password is kept in the app's encrypted storage and never sent itself (token and salt sign-in); casting
  Navidrome music works from the desktop through the cast relay only.
- Settings > Audio > Music source (desktop), Settings > Music (phone) and Settings > Playback (TV): choose which
  server the Music section shows (Emby, Jellyfin, Plex or Navidrome), or Automatic for all of them. On desktop, the
  Music page also has a quick switch when several servers have music.

### Changed

- Android TV: the player's quality control now reads "Quality · Original" or "Quality · 1080p" instead of a bare
  "Original" or "1080p · 8 Mbps", and the sleep timer control reads "Minuterie" in French.
- Android TV and phones: clearer wording across the app, mostly in French: "Lecture directe" instead of "Direct" in
  the Quality sheet, "Débit maximal" and "À distance" in the bitrate settings, "Adapter la fréquence d’affichage",
  "Continuer à regarder" when the app asks if you're still watching, "Épisodes spéciaux" for season 0, one episode
  code format (S1 É2), shorter setting descriptions, and Title Case for English row and button labels.
- Desktop and phones: the same episode code format (kept on one line), "Lecture directe" / "Direct Play" tag,
  "Reste 42 min" in French, "Keep Watching" under "Are you still watching?", one name for the "Merge Continue Watching
  and Up Next" setting, and Title Case for "Now Playing" and "Similar Artists".
- Android TV: clearer French hints for the home rows, tab bar, subtitle and bitrate settings, "Fréquence seule" in the
  display mode options, and a plainer message when recording needs Emby Premiere.
- Desktop: Home no longer keeps the processor busy while you are not using it. The hero holds a still image, changes
  slides with a short crossfade and shows the current slide as a still pill; Home shelves no longer slide in card by
  card.
- Desktop: hover, selection and focus colours now change at once instead of fading.
- Desktop: scrollbars are the thin system ones, shown while the pointer is over the page; scrolling stays smoother.
- Desktop: going back to a page no longer replays its cards' entrance, and Library and Music animate at most their
  first 12 cards.
- Desktop: with "Reduce motion", loading spinners keep turning, more slowly, and background animations stop.
- Desktop: the window background and the window buttons follow the theme (black with OLED).
- Desktop: moving the keyboard or gamepad focus across cards no longer loads every title's details and backdrop
  on the way; only the card you stop on is preloaded, like with the mouse.
- Desktop: item, Favorites and History pages no longer reload on every background connection update.
- Desktop: generated comic book covers no longer slow down the app while you scroll a large comics library.
- Android TV: the player redraws less often during playback, which helps on low-end TVs.
- Android TV: moving across Home rows is smoother: a focus move no longer redraws the whole Home, and the backdrop
  fades once from one picture to the next instead of fading to an empty screen first (smaller backdrops on low-end
  TVs).
- Android TV: focus and selection colours change at once instead of fading, and the focus lift is a little smaller
  and no longer bounces. Opening a panel blurs the screen behind it at once, with no blur on low-end TVs.
- Android TV: posters fade in faster, and appear without a fade on low-end TVs. The Live TV guide scrolls more
  smoothly, also right after installing the app.
- Android: image fades follow the system "Animator duration scale". On mobile, a press no longer bounces and the
  Home banner's page dots no longer stretch.
- Mesh file shares: very large SMB folders are listed without reading every entry first.
- Desktop: Electron updated to 44.9.0.
- Mesh helper (Windows, Linux, Android): NetBird client updated to 0.81.2, with pion/dtls v3 3.1.14 and quic-go
  0.64.0.
- Desktop: bundled mpv player updated to the shinchiro build `20261018` (mpv `git-01e2533f31`).
- Desktop: the app loads about 31% less code at start (2.40 MB down to 1.66 MB): the HLS player and the photo map
  load when first used.
- Desktop: Navidrome covers are cached, and sorted Navidrome album grids load once instead of once per page.
- Desktop: idle Home uses less processor time (gamepad polling, hero backdrops, blur previews).
- Android TV: more of the app starts precompiled (code run outside the startup profile: 3,529 methods down to
  1,941), and the TV no longer fetches an emoji font at every start.
- Android: Navidrome libraries load with at most six requests at a time.
- Mesh file shares: SMB copies use 1 MiB reads, and an unreachable host fails at once for 5 seconds instead of
  being dialled again by every request.

### Fixed

- Themes: white channel logos stay white in the live player's guide overlay on the Light theme; Reduce
  transparency also makes the player, hero and photo viewer panels opaque on Light; the mini player follows
  theme changes; macOS no longer shows the Windows and Mica wording on the theme cards; leaving the phone
  player or comic reader on Light no longer flashes a dark frame on the screen behind.
- Android: the Live TV guide follows a theme change at once instead of after a restart.
- Android: an IPTV channel whose playlist sets a user agent or referrer with accented or control characters no
  longer stops playback; that value is ignored.
- Android TV: the recordings list of a Plex server with 500 recordings or more no longer loads forever.
- Android mobile: a crash while a download was saved no longer makes the app forget every download.
- Desktop: seeking often in a video from a WebDAV share no longer piles up connections until playback stalls.
- Desktop: a settings or server file that cannot be read is kept beside the original (`.corrupt-` and the time)
  instead of being overwritten, and a file emptied to `{}` no longer stops the app from starting.
- Desktop: a failed save (full disk, locked file) no longer crashes the app, and is tried again; quitting saves
  everything else even when one save fails.
- Mesh: browser sign-in to a NetBird server that cannot be reached for a moment is tried again, instead of stopping
  with "this NetBird server offers no browser sign-in".
- Android TV: "Play on Wicaby" from another device now works when you have left the app or it is in the
  background (for example while music plays): a notification offers to play it.
- Android TV: switching to another profile in "Who is watching?" clears the previous profile's titles from the
  launcher's "Watch Next" row.
- Android: adding a server or changing networks no longer waits about 6 seconds for an address that does not
  answer when another one already did.
- Android: leaving the player during a quality or subtitle change no longer shows a "failed" message on the next
  screen.
- Android: SMB shares on a Tailscale or NetBird device work again after Remote Access is turned off and on.
- Mesh file shares: two requests that reconnect an SMB share at the same time no longer break each other's
  playback.
- Mesh: a network hiccup during NetBird browser sign-in no longer replaces the code on screen while you confirm it.
- Mesh: offline NetBird devices are no longer shown as online, and server discovery no longer waits on them.
- Desktop: a video playing in the built-in player no longer restarts from the beginning when a server comes back
  online.
- Desktop: removing the server that is playing now stops playback, without waiting long on a server that does not
  answer.
- Desktop: switching subtitles quickly in the built-in player no longer shows two subtitle tracks at once.
- Desktop: error messages raised in a dialog are now read by screen readers and their buttons can be clicked
  while the dialog is open.
- Desktop: a server that fails to list its libraries once (still waking up, busy) no longer leaves them missing
  from the sidebar and Home until you reconnect.
- Desktop: leaving the Servers page while linking a Plex account with a code stops checking for the link.
- Desktop: a comic book download that stalls now fails after a minute instead of hanging until restart, and a
  book larger than 8 GB (or than the comics cache, if larger) is refused instead of filling the disk.
- Android: the comic book reader lets the screen turn off (or the TV screensaver start) after 10 minutes without
  a page turn or key press.
- Android: keeping the playback stats open with Remote Access on no longer moves a NetBird network server's
  traffic onto the mesh for the rest of the session.
- Mesh file shares: browsing posters while a film plays no longer fails with "HTTP 503"; requests wait for a free
  slot, and a paused player that holds a connection gives it back after a minute.
- Desktop: a settings file with a damaged section or window position no longer stops the app from starting, and a
  startup error shows a message and quits instead of leaving a hidden process behind.
- Desktop: one outdated keyboard shortcut no longer resets all your custom shortcuts at start.
- Desktop (Linux): the saved sign-ins are no longer set aside when the system keyring is not ready yet at start.
- Desktop: the update notice finds the Windows installer and portable downloads again.
- Desktop: releases bundle an mpv build that also plays on processors without AVX2.
- Desktop: a Navidrome server follows you to its new address when your network changes, and several expired
  requests at once sign you out at most once.
- Desktop: cancelled or stalled media requests stop holding server connections; Emby Connect gives up after 15
  seconds.
- Desktop: HLS videos in the built-in player start instead of staying paused.
- Desktop: comic covers that failed on a network error are tried again later, and CBR and CB7 books with
  uncompressed pages open.
- Desktop: the music grid sorted at random no longer loads pages forever, a pushed session update no longer sends
  Library and Files back to the first page, and Escape in a picker closes only the menu.
- Desktop: quick gamepad taps are no longer missed.
- Android mobile: downloads from two servers that use the same item number no longer overwrite each other.
- Android: grids no longer crash when the server repeats a title across pages; signing out or changing server
  stops the previous account's music.
- Android: an offline server comes back sooner after it wakes up, and cancelled screens no longer mark a server
  offline.
- Android: large comic books (omnibus CBZ or PDF) can be downloaded again, and a cancelled book is closed.
- Web TV app: offline servers reconnect on their own, and player errors are shown.

### Security

- Desktop: downloads and comic books from a server that redirects them to another host (a .strm file, a remote
  path) no longer send your server sign-in along; the other host is asked without it.
- Desktop: when the server does not say in time whether a stream redirects, the player asks once more and, without an
  answer, shows "The server didn't answer, try again" instead of risking sending your server sign-in to another host.
- Desktop: the Emby Connect sign-in no longer follows redirects with its access key.
- Mesh file shares (Windows, Linux, Android): an SMB share opened with a user name now requires signed replies, so
  someone on the same network cannot change what you read. A share that only allows guest access must be added
  with the user name guest.
- Desktop: your server sign-in goes to a Tailscale or NetBird device only when that device carries the server's own
  address; a device that only has a matching name (anyone can call a device "jellyfin") asks you to sign in.
- Desktop: a Plex server on a plain HTTP address in the 100.64/10 range or on a .lan or .home.arpa name asks before
  your Plex sign-in is sent, like other local addresses.
- Desktop and Android: a Navidrome sign-in is no longer passed to another host when a stream or cover redirects
  there, and on Android only stream, download and cover links are signed.
- Android: "Connect a TV" is not offered for Navidrome, because the pairing link is not encrypted and a Navidrome
  sign-in carries the account password.
- Android: other apps can no longer queue items in Wicaby's media sessions, web pages can no longer open a Live TV
  channel through a wicaby://live link, and plex.tv, Trakt and GitHub accept only the system's certificates.
- Android TV: a remote "Play" of music while the app is in the background asks first, like video.
- Android: sign-in screens warn before you type a password on a plain HTTP address outside your home network.
- Web TV app: a server that answers with a known server's Id from another address no longer gets its sign-in.
- Mesh file shares: a server reached through a routed home network is only dialled through the mesh, so a foreign
  Wi-Fi that reuses your home addresses never receives your SMB sign-in.
- Desktop: archives, EPUB books, photo thumbnails, download posters and Immich originals are read within size limits,
  so a hostile file cannot fill the memory or the disk; Immich originals keep a safe file name and extension.
- Android: server answers are read within a size limit, and comic book downloads stop when the disk gets full.

## [0.10.12] - 2026-10-18

Security updates in the mesh helper. Windows and Linux desktop **0.10.12**, Android TV app **0.10.12** (`versionCode`
33), Android mobile app **0.10.12** (`versionCode` 30).

### Security

- Mesh helper (Windows, Linux, Android): pion/dtls v3 updated to 3.1.4 and gopacket to 1.6.1, which fix denial of
  service and nonce issues reported by Dependabot. pion/stun v3, pion/stun v2 and pion/dtls v2 stay as NetBird
  0.80/0.81 pins them (the fixed pion/stun 3.1.5 needs a NetBird release that moves to pion/transport v4).

## [0.10.11] - 2026-10-18

Android TV contributions from SEC844: a reorderable tab bar, watched titles out of the hero, a clearer watched
button. Windows and Linux desktop **0.10.11**, Android TV app **0.10.11** (`versionCode` 32), Android mobile app
**0.10.11** (`versionCode` 29).

### Added

- Android TV: Settings > Home > Hide Watched in Featured keeps watched movies and series out of the home
  screen's hero carousel. It falls back to every title when nothing unwatched is left
  ([#8](https://github.com/WicaebethTheo/wicaby/issues/8)).
- Android TV: Settings > Interface > Tab Bar reorders the tabs between Home and Search (libraries, Live TV, IPTV,
  Files, Torrents…) and hides the unused ones, per server and user, like the home rows. Home, Search and Settings
  always stay ([#6](https://github.com/WicaebethTheo/wicaby/issues/6)).

### Fixed

- Android TV: the details page's watched button now shows its state, like the favorite heart: a filled check
  circle once watched, a plain check otherwise. The state only changed the button's background before, which the
  white focus colour hid ([#7](https://github.com/WicaebethTheo/wicaby/issues/7)).

## [0.10.10] - 2026-10-16

The NetBird sign-in fix from 0.10.9, now actually in the apps (the embedded mesh helper was not rebuilt in 0.10.9).
Windows and Linux desktop **0.10.10**, Android TV app **0.10.10** (`versionCode` 31), Android mobile app **0.10.10**
(`versionCode` 28).

### Fixed

- Remote access on Windows and Android: the NetBird helper shipped in 0.10.9 still predated the expired-sign-in fix,
  so it kept retrying instead of offering to sign in again. It is rebuilt with the fix.
- Desktop log: the dropped-frames line no longer shows a negative buffer right after a seek.

## [0.10.9] - 2026-10-16

Smoother playback on Windows, NetBird sign-in and passthrough fixes. Windows and Linux desktop **0.10.9**, Android TV
app **0.10.9** (`versionCode` 30), Android mobile app **0.10.9** (`versionCode` 27).

### Fixed

- Desktop player on Windows: far fewer random freezes of about a quarter of a second (a few dropped frames and, on
  longer ones, a short audio dropout). mpv now keeps one high-resolution timer for its whole run instead of requesting
  and releasing it hundreds of times per second. On a real test bench, dropped frames went from about 70 to about 4
  per 4 minutes, with and without subtitles, and audio dropouts from about 7 to none.
- Remote access: an expired NetBird sign-in now asks you to sign in again; the helper used to retry the login every
  minute without ever showing the sign-in link.
- Desktop: an audio output that refuses passthrough (AC3, DTS, TrueHD to analog speakers) is remembered until Wicaby
  restarts, so the next files start straight in PCM instead of restarting their audio after a failed attempt.

### Changed

- Desktop log: each burst of dropped video frames is logged with the position and how much is buffered, to find what
  makes mpv stall.

## [0.10.8] - 2026-10-15

Smooth Playback off by default, an Android 6 fix for IPTV. Windows and Linux desktop **0.10.8**, Android TV app
**0.10.8** (`versionCode` 29), Android mobile app **0.10.8** (`versionCode` 26).

### Changed

- Desktop: Smooth Playback is off by default (it was on in 0.10.7, and is turned off once on update); turn it on in
  Settings → Playback if mpv drops a frame now and then.

### Fixed

- Android TV on Android 6: the IPTV screens no longer crash (a set type that needs Android 7).

## [0.10.7] - 2026-10-15

History on Emby, Smooth Playback and pages centred on wide windows. Windows and Linux desktop **0.10.7**, Android TV
app **0.10.7** (`versionCode` 28), Android mobile app **0.10.7** (`versionCode` 25).

### Added

- Desktop: **Smooth Playback** in Settings → Playback, on by default. mpv times frames to the display
  (`video-sync=display-resample`) instead of dropping one now and then to follow the sound card's clock; an ⓘ next to
  it explains why.
- Desktop: a GitHub link next to the avatar in the title bar. When a new version is out it becomes an **Update**
  button that downloads it.

### Fixed

- History on Emby showed nothing: Emby can sort never-played items first on the last-played date, so Wicaby now asks
  for played and in-progress items (desktop, Android TV and mobile).
- Desktop full-screen player: the Similar tab no longer reloads with new songs while it is open, and the quality
  badge loads once per track instead of on every position update.
- Desktop: Settings, Administration and the Live TV setup page are centred on wide windows instead of hugging the
  left edge; the update check switch in Settings → General works (it said "Coming Soon").

## [0.10.6] - 2026-10-14

IPTV, Live TV always in the sidebar, and update notices. Windows and Linux desktop **0.10.6**, Android TV app
**0.10.6** (`versionCode` 27), Android mobile app **0.10.6** (`versionCode` 24).

### Added

- Update notices. The Windows and Linux desktop app checks GitHub for a newer release about 30 seconds after start
  and then once a day, and says "Wicaby X.Y.Z is available" with Download (the installer, portable exe, AppImage or
  .deb that matches this copy), Release Notes and Later (that version is not shown again). Settings → About shows the
  version, a Check for Updates button and a switch to turn the automatic check off. Nothing is downloaded or
  installed by itself.
- Android TV and mobile: the in-app updater now reads Wicaby's GitHub releases by default (`update.json` asset), so
  installed apps offer new versions without typing an update URL first. A custom URL in Settings → About still wins.
- Release tooling: `tools/release/make-update-manifest.mjs --flat --dir release/<version>` writes `update.json` from
  the APKs as they are named on the GitHub release (`Wicaby-TV-foss-…`, `Wicaby-Mobile-foss-…`,
  `Wicaby-Mobile-gplay-…`), see `docs/release.md`.
- Desktop: an IPTV section in the sidebar, right under Live TV. Add an M3U or M3U8 channel list (an address, including
  Xtream-style `get.php` ones, or a file) and, optionally, an XMLTV guide (`.xml` or `.xml.gz`; the list's `url-tvg`
  is used otherwise). No server is involved: the channels and the guide use the Live TV pages (now playing, guide grid,
  search, favourites kept on this computer, hidden channels), the list's groups become filters, and channels play
  live in mpv with the list's user agent and referrer. Lists refresh every 12 hours or on demand; addresses are kept in
  the credential vault and the cached list is encrypted. No recording or catch-up yet. IPTV sources are also listed
  and added in Sources.
- Desktop: the Live TV section is always in the sidebar. Without a server tuner it opens a setup page that explains
  where live TV comes from and links each server's own Live TV settings (Emby, Jellyfin, Plex), or IPTV.
- Android TV and mobile: the same two sections. Live TV is always in the TV top bar and in the phone's Libraries,
  with a setup page (links to the server's Live TV settings) when no server has a tuner; IPTV sits right after it.
  Sources are added with the TV's text fields or the phone's form, and use the existing channel list, guide grid,
  group lenses, favourites, number zapping and live player (HLS or MPEG-TS, with the list's user agent and referrer).
  Addresses and the cached list are kept in the app's encrypted vault.

### Changed

- Android TV: the live overlay, the guide over the video and the detail panel follow the source of the channel
  playing (they read the signed-in server's channels before).
- Desktop: logs mask the user and password of Xtream-style IPTV addresses.

## [0.10.5] - 2026-10-14

Music casting and a new desktop sidebar. Windows and Linux desktop **0.10.5**, Android TV app **0.10.5**
(`versionCode` 26), Android mobile app **0.10.5** (`versionCode` 23).

### Fixed

- Android TV and mobile: album covers from an Emby server show again. The cover lookup sent the same query name
  twice, which Emby 4.10 rejects with an error.
- Desktop: starting a song on the Music page no longer reloads the list and scrolls back to the top.

### Changed

- Desktop: the sidebar groups libraries by media type (Movies & Shows, Live TV, Music, Photos, Books & Comics, Files),
  with collapsible groups that remember their state. Home, Favorites and Downloads stay at the top, and
  Administration, Settings and the connection status stay at the bottom while the libraries scroll. Search lives in
  the title bar only (`Ctrl` + `K`). The keyboard and gamepad focus is visible on the selected row, the collapsed rail
  shows dividers between groups and a tooltip on hover or focus, and the OLED theme turns the sidebar black too.

### Added

- Music casting. The music player has a Cast button: in the desktop now-playing bar and full-screen player, and in the
  Android mobile and TV players. It sends the whole queue, from the current song and position, to another app, to a
  Chromecast or Google TV, to a speaker or speaker group with Chromecast built in (desktop, and the Android `gplay`
  build), or to a DLNA/UPnP TV, speaker or AV receiver. Speakers and speaker groups get their own icons and appear
  for songs only. Songs advance on the device by themselves; DLNA renderers that support it get the next song in
  advance, for gapless playback. The device's screen and app show the title, artist, album and cover. Play/pause,
  previous/next, seek and volume stay in sync with the bar. A song whose format the device cannot play is transcoded
  by the server to MP3; FLAC above 96 kHz or 24 bit is transcoded for Chromecast. As for video, the server token never
  reaches the device.
- Amazon Echo is not a cast target: Echo speakers support neither DLNA nor Google Cast, and Alexa Cast is open only to
  Amazon's partner apps. To play on an Echo, pair it over Bluetooth with the computer or phone, or use your server's
  Alexa skill.

## [0.10.4] - 2026-10-14

Covers on Emby albums without art, a new music library and a Sources screen. Windows and Linux desktop **0.10.4**,
Android TV app **0.10.4** (`versionCode` 25), Android mobile app **0.10.4** (`versionCode` 22).

### Fixed

- Android TV and mobile: comic covers from an Emby server show again. Emby answers a request for the last bytes of a
  file (`Range: bytes=-N`) with its first bytes, so the archive's table of contents was never found; Wicaby now notices
  and asks for the end of the file by offset.
- Music, on desktop, Android TV and mobile: an album whose cover only shows once a track plays (Emby keeps no cover
  for an album whose art is embedded in its tracks) now shows its first track's art in the library. An artist without
  an image borrows one of its albums' covers. Each is looked up once, a few at a time, and kept for the session; with
  no art at all, a tile shows the initials on a colour from the name.

### Added

- Music library ideas taken from Feishin: an Album, EP, Single or Compilation label, "More by" the artist and a ▶ per
  disc on album pages, similar artists on artist pages, and a tint from the cover (desktop, Android TV and mobile).
  On desktop: play next and add to queue on album cards, a full-size cover, `Ctrl`/`Shift`-click selection with a bar
  and drag onto the queue or a playlist, playlists in the sidebar, covers and extra columns in Songs, an album link and
  remaining time in the bar, a crossfade, format badge and "Similar" tab in the full-screen player, and the shortcuts
  `Ctrl` + `L` (the playing track's album) and `Ctrl` + `Alt` + `→`/`←` (next or previous album in the queue). On
  Android mobile, long-press to select tracks on an album page.

### Changed

- Desktop: the Servers page is now **Sources**, one list of your Emby, Jellyfin and Plex servers, folders and shares,
  and photo sources, with remote access on the same page. **Add Source** opens a sheet that picks the kind of source
  (Emby or Jellyfin, Plex, a folder or share, photos, or a device reached through Tailscale or NetBird) and lists the
  servers found on this network.

## [0.10.3] - 2026-10-14

Photo libraries from your own files. Windows and Linux desktop **0.10.3**, Android TV app **0.10.3** (`versionCode`
24), Android mobile app **0.10.3** (`versionCode` 21).

### Added

- Photo sources from a folder, an SMB share or a WebDAV server, on desktop, Android TV and mobile: **Settings > Photo
  sources** offers "Folder on this computer" (a folder picked with the system picker on Android), "SMB share" and
  "WebDAV" next to Immich. Wicaby indexes the photos once (date, orientation, camera and, only with the map on,
  location from their EXIF), then re-reads only the files that changed; folders become albums. The timeline, grid,
  viewer, slideshow, albums, favourites and "On this day" work as with Immich. Thumbnails are made on demand and cached.

### Fixed

- Android TV and mobile: a photo source's thumbnails no longer load the whole photo into memory (up to 64 MB each,
  several at once). The file is streamed and decoded straight at the thumbnail's size, with a 20 s limit per
  thumbnail and at most two at once on TV (three on phones), so an 8000x6000 photo costs a 500x375 bitmap in the grid.

### Changed

- Android TV and mobile: a comic cover that cannot be read from the archive now leaves one line in the system log (tag
  `WicabyComicCover`): the error and, for each request, the HTTP status, the Content-Range numbers and the bytes read;
  a book skipped for its format or a server cover is logged once per session with its extension. The line never holds
  the address, the book or the token.

## [0.10.2] - 2026-10-14

Music and trailer fixes on Android, playback info. Windows and Linux desktop **0.10.2**, Android TV app **0.10.2**
(`versionCode` 23), Android mobile app **0.10.2** (`versionCode` 20).

### Added

- Android TV: an artist opens their page, as on desktop and mobile, instead of playing at once: their art over the
  backdrop, **Play** and **Shuffle** (focus starts on Play), then rows of albums, **Singles & EPs** and **Appears on**.
  OK on an album opens the album page; Back returns to the artist.
- Android TV and mobile: **Playback info** is now a top-level entry (a column of the TV player's track menu, an (i)
  button in the mobile player's top bar) instead of a toggle inside "Sync…". The panel catches up with the desktop
  overlay: direct play, direct stream or transcode with the server's reasons in plain words, video level and bit depth,
  audio sample rate, subtitle format, and the server with its path (local network, remote or mesh); larger text on TV.

### Fixed

- Android TV and mobile: music played nothing on Emby (the server answered 400 to every track). The stream now carries
  the app's device id and a play session id, as desktop and the video player do, and the track's own media source id
  (an Emby source id is not the item id): the music lists now ask the server for it. The Playing, Progress and Stopped
  reports carry the stream's play session id.
- Android TV and mobile: a video no decoder of the device can play (a VC-1 trailer, for one) no longer plays as sound
  over a black screen: the server converts it, as after a decoder error. ExoPlayer drops such a track without an
  error, which is why the TV showed nothing.

## [0.10.1] - 2026-10-13

LAN services through the VPN, TV fixes. Windows and Linux desktop **0.10.1**, Android TV app **0.10.1** (`versionCode`
22), Android mobile app **0.10.1** (`versionCode` 19).

### Added

- qBittorrent and WebDAV away from home, on desktop: Wicaby connects directly first and, when the home-network address
  doesn't answer within 1.5 s, goes through its own Tailscale/NetBird connection, provided the host is a device of your
  network or sits inside a NetBird network route. **Test Connection** says which way worked ("Connected (direct)" or
  "Connected via NetBird/Tailscale") or which step failed. See [Remote access](docs/remote-access.md).
- Android TV and mobile: NetBird network routes. Hosts inside a route (the home network behind a routing peer) are
  tried directly first, then through Wicaby's own NetBird connection; qBittorrent works that way too.

### Fixed

- Android TV: on a series page, the seasons row keeps its own scroll rule, so moving through the seasons with the D-pad
  never shifts the row by the page's scroll or strands the focus. 0.10.0 already shipped this; a test now guards every
  row of the page.
- Android TV and mobile: qBittorrent through the mesh no longer fails its CSRF check (the headers named the local
  forwarder instead of the configured address).

## [0.10.0] - 2026-10-13

Plex Live TV, Immich and music extras. Windows and Linux desktop **0.10.0**, Android TV app **0.10.0** (`versionCode`
21), Android mobile app **0.10.0** (`versionCode` 18).

### Added

- Plex Live TV and DVR, on desktop, Android TV and mobile: the guide, tuning a channel, recordings, and recording or
  cancelling a series, in the same Live TV screens as Emby and Jellyfin. The section shows only when the server owner
  has a Plex Pass and a DVR with a tuner. It follows Plex's public documentation and has not yet been tried with a real
  Plex tuner.
- Immich as a photo source, on desktop, Android TV and mobile: connect a server with its address and an API key
  (Immich 2.0 or later). Its photos form their own library next to those from Emby or Jellyfin, with the timeline,
  albums (shared ones marked), People, memories and, on desktop, the map. A permission the key lacks hides that part
  and says which one. The key stays encrypted on the device (the vault on desktop, the Android Keystore on Android)
  and is only sent to that server, in a header.
- Music:
  - Desktop: a mini player (`Ctrl` + `Shift` + `M`), a small always-on-top window that reopens where you left it.
  - Desktop and Android mobile: an equalizer with Flat, Bass, Vocal and Treble presets, 10 bands and a preamp. Flat adds
    no filter, so bit-perfect output stays bit-perfect; on Android it is off, and says why, during passthrough.
  - Android Auto (the Google Play build): Recent, Playlists, Albums and Artists to browse in the car.
  - Lyrics from LRCLIB (lrclib.net) when the server has none, **off by default** (Settings, Audio on desktop;
    Settings on the phone). When on, it sends the song's artist, title, album and length, and keeps the answer for 30
    days.
- README: screenshots of Photos, Music and Plex. Every screenshot shows the same frozen moment and carries no metadata;
  `npm run checks` fails on an image that does.

### Fixed

- Comic covers on Emby: covers taken from the book itself show again (Emby's longer Range answers were refused).
- Android mobile: NetBird browser sign-in works; a failed connection to the management server names the step that
  failed, and on Android 17 a management server on the local network asks for the local network permission.

## [0.9.0] - 2026-10-13

Plex on Android TV and mobile. Windows and Linux desktop **0.9.0**, Android TV app **0.9.0** (`versionCode` 20),
Android mobile app **0.9.0** (`versionCode` 16).

### Added

- Android TV and mobile: Plex servers, as on desktop. Wicaby is an unofficial client, not affiliated with Plex.
  - Link a Plex account with a code (plex.tv/link or a QR code), no password form. Your servers and the ones shared
    with you are added; shared servers show by default and each one can be hidden. Plex Home profiles appear in
    "Who is watching?", and a protected profile always asks for its PIN.
  - Connections: local addresses first, then remote, then Plex's relay (with a badge). Servers that require secure
    connections are never reached over http; an unencrypted local address gets your Plex access only after you
    confirm it. Tokens are kept in the Android Keystore-backed storage, never in an address.
  - Browse, play and resume through the server's decision (direct play or HLS from the resume point), multi-part
    films as one queue, track choices saved to Plex, progress reported once, Skip intro from Plex markers and BIF
    trickplay. The plex.tv watchlist shows as Favorites.
  - Mobile: downloads only when the server allows them, otherwise Wicaby says why.
  - For the server owner, "Refresh metadata". Admin, Live TV, casting and "Play on" are not available on Plex
    servers on Android.
  - Plex Pass gates are detected and explained, never worked around.
- The Android Plex mapping passes the same test vectors as desktop.

## [0.8.0] - 2026-10-13

Plex on desktop. Windows and Linux desktop **0.8.0**, Android TV app **0.8.0** (`versionCode` 19), Android mobile app
**0.8.0** (`versionCode` 15).

### Added

- Desktop: Plex servers, next to Emby, Jellyfin and file sources. Wicaby is an unofficial client, not affiliated
  with Plex.
  - Link a Plex account with a code (plex.tv/link or a QR code), no password form. Your servers and the ones shared
    with you are added; shared servers show by default and each one can be hidden. Plex Home profiles appear in the
    profile picker, and a protected profile always asks for its PIN.
  - Connections: local addresses first, then remote, then Plex's relay (with a badge). Servers that require secure
    connections are never reached over http; an unencrypted local address gets your Plex access only after you
    confirm it. The account token goes only to plex.tv, and each server's token stays in the vault.
  - Browse: Plex's own Home rows, libraries, search, shows, editions, Continue Watching, Up Next, playlists,
    collections, the plex.tv watchlist as Favorites, music in the music player and photos in Photos.
  - Playback through the server's decision (direct play or HLS from the resume point), multi-part films as one queue,
    track choices saved to Plex, progress reported once, Skip intro from Plex markers, BIF trickplay, and casting to
    a Chromecast or a DLNA TV through the relay.
  - For the server owner, "Refresh metadata". The Admin panel, Live TV, "Play on", mix and radio, subtitle search
    and comics are not available on Plex servers.
  - Plex Pass gates (remote playback, Live TV, intro detection, hardware transcoding) are detected and explained,
    never worked around.
- About: "unofficial client, not affiliated with Plex", and a Plex entry in the third-party notices.

### Fixed

- Android TV: music stops when the profile picker locks at startup and on sign-out.


## [0.7.0] - 2026-10-13

Music. Windows and Linux desktop **0.7.0**, Android TV app **0.7.0** (`versionCode` 18), Android mobile app
**0.7.0** (`versionCode` 14).

### Added

- All platforms: a full music player for Emby and Jellyfin music libraries.
  - Albums, artists (with an "album artists only" toggle), songs, genres and playlists; album pages with disc
    headers, artist pages with top songs and the discography split into albums and "appears on".
  - A queue you can edit while it plays: play next, add to queue, move, remove, clear upcoming, shuffle (turning
    it off restores the order), repeat all or one, and save the queue as a playlist.
  - Mix and radio from a song, album, artist, genre or playlist, through the server's instant mix. Radio tops the
    queue up as it runs low.
  - Favourites, add to playlist and go to artist or album from every track's menu.
  - Synced lyrics from the server, when it has them (click a line to jump there on desktop).
  - Loudness: ReplayGain in album mode by default, with the server's gain for untagged files and a preamp.
- Desktop: music plays through mpv with no window, audio only: gapless playback, ReplayGain, and bit-perfect
  output with WASAPI exclusive mode. A now-playing bar, a queue panel, a full-screen player with lyrics, music
  keyboard shortcuts (editable in Settings), media keys and Windows media controls. The queue comes back,
  paused, at the next start. The built-in player stays as a simpler fallback (no gapless, no ReplayGain tags).
- Android mobile: a music section with a mini player, a full-screen now playing with lyrics and the queue, and
  lock-screen and notification controls.
- Android TV: music rows (recent albums, recently played, playlists, artists, genres), a now-playing screen
  built for the remote with queue editing, music that keeps playing after Home or Back, and an ambient view after
  2 minutes without a key, also shown by the screensaver while music plays.

### Changed

- Android TV: the basic music views of 0.4.1 grow into the new music player.

## [0.6.0] - 2026-10-13

File sources. Windows and Linux desktop **0.6.0**, Android TV app **0.6.0** (`versionCode` 17), Android mobile
app **0.6.0** (`versionCode` 13).

### Added

- All platforms: file sources. Browse and play videos straight from a folder, a WebDAV server (Nextcloud,
  Synology, QNAP, TrueNAS, `rclone serve webdav`…) or an SMB share, next to your Emby and Jellyfin servers,
  with no server and no scan.
  - Folders first, then videos, in natural order (`E2` before `E10`), sortable by name, date modified or size.
  - Titles, years and episode numbers from the NFO file when there is one, otherwise from the file name;
    posters, backgrounds and subtitles from the files next to the video.
  - Playback progress is kept on the device, with a Continue row for files. A file that changed since you
    last watched it starts again from the beginning.
  - "Show file sources on Home" (off by default) adds files in progress to Home's Continue Watching.
  - "Find on this network" lists WebDAV and SMB servers that announce themselves (mDNS). A reply only fills
    the form; nothing connects until you press Test.
  - Self-signed WebDAV certificates: Wicaby shows the fingerprint and trusts it for that source only after
    you accept it, and warns if it changes. A plain `http://` address needs an explicit acknowledgement.
  - Passwords are kept in the app's encrypted storage and never appear in logs, addresses or settings
    exports.
- Desktop: a Files section in the sidebar, folders picked with the system dialog, WebDAV through a local
  relay (the player never sees the password), and SMB shares by their `\\STORAGE\media` path on Windows, with
  your Windows session credentials. SMB is not available on Linux yet.
- Android TV: a Files tab with a folder grid built for the remote. Sources are added in Settings.
- Android mobile: a Files section in Libraries, with local folders from the system picker.
- Android: SMB 2 and 3 shares through a small gateway in the built-in network library (go-smb2).

### Changed

- The apps now decide what to show per source type (Admin, Live TV, casting, favourites, transcoding…) from
  one table of capabilities, which the Plex support will reuse.

## [0.5.1] - 2026-10-13 (Android)

Android only: Android TV app **0.5.1** (`versionCode` 16), Android mobile app **0.5.1** (`versionCode` 12). The
desktop stays at 0.5.0.

### Fixed

- Android TV: in a photo library, OK on the Albums or Favourites tab could send the focus to the top bar and
  open Home. The tab buttons now stay on screen while a tab loads, and the selected one is marked in the accent
  colour.
- Android TV: Up from the top of a library page moved to the Home tab instead of that library's tab.
- Android TV: the Memories screensaver asks the server for at most 30 photos per year.

## [0.5.0] - 2026-10-12

Photos. Windows and Linux desktop **0.5.0**, Android TV app **0.5.0** (`versionCode` 15), Android mobile app
**0.5.0** (`versionCode` 11).

### Added

- All platforms: Emby and Jellyfin photo libraries (and home-video libraries) open in a Photos timeline with
  Timeline, Albums and Favourites tabs, month headers, and video clips with their duration.
- All platforms: a photo viewer with zoom, previous and next, favourite, and an info panel with the date
  taken, camera, exposure, dimensions and, when the photo has one, its position. Videos play in the player.
- All platforms: a slideshow with a fade and an optional Ken Burns effect, a choice of interval, and the
  screen kept awake while it runs.
- All platforms: an "On This Day" row on the home screen with photos taken on today's date in earlier years.
- Desktop: a justified, virtualised timeline with three thumbnail sizes, a date scrubber, keyboard
  navigation, a shuffle order for the slideshow and "Save original".
- Desktop: an optional photo map, off by default. Turn it on in Settings > Privacy & Storage; it fetches
  OpenStreetMap tiles through the app, with the attribution shown, and the tile address can be changed.
  Places are never looked up by name.
- Android mobile: pinch between three thumbnail sizes, a fast scroller, swipe through photos, swipe down to
  close, and long-press to select photos for a slideshow or favourites.
- Android TV: a photo grid built for the remote (Page or Channel +/−, or hold Down, to change month), and a
  screensaver that can show your photos, one album or "On This Day" in place of the film artwork, which stays
  the default.

## [0.4.4] - 2026-10-12

A welcome wizard and a Remote access settings page. Windows and Linux desktop **0.4.4**, Android TV app
**0.4.4** (`versionCode` 14), Android mobile app **0.4.4** (`versionCode` 10).

### Added

- All platforms: a short welcome wizard on first launch: language (System, Français, English), look (Dark or
  OLED, accent color), where the server is (this network, an address, or remote access), sign-in, a few
  optional extras, and a summary of the servers and the remote-access device. Every step can be skipped and
  each choice is saved at once; Settings > Run Setup Again opens it again. Existing installs skip it.
- All platforms: a Remote access settings page: status and last error, this device's name and address, the
  devices on your network (online first), routed networks, sign out or switch between Tailscale and NetBird,
  and Copy Diagnostics with addresses, keys and codes hidden. "Find Servers" probes the online devices for a
  media server, only when asked. On the desktop, the sidebar connection popover links to it and an installed
  Tailscale or NetBird app shows under Advanced; on Android TV, the diagnostics are shown as a QR code.
- Android mobile: several servers at once, as on the TV and the desktop: Settings > Other Servers adds or
  removes one, and Home, Libraries and Search merge them.
- Android mobile: OLED (pure black) theme.
- Android TV: a setting to hide the Wicaby rows from the launcher's home screen.

## [0.4.3] - 2026-10-12

Playback robustness, address switching and a smoother player exit. Windows and Linux desktop **0.4.3**,
Android TV app **0.4.3** (`versionCode` 13), Android mobile app **0.4.3** (`versionCode` 9).

### Added

- Android TV and mobile: Settings > Server addresses: a local and a remote address per server, learned from
  the server or typed in. Wicaby uses the one that answers and switches when the network changes.
- Desktop: after a wake from sleep or a network change (another Wi-Fi, a cable, a VPN up or down), each
  signed-in server is probed and moves to whichever of its addresses answers, with its session; a server
  that was unreachable at startup comes back once it answers. Nobody is signed out.

### Changed

- Desktop: leaving the player no longer flashes the desktop. Playback pauses, the picture fades to black
  and uncovers the item page, which stays mounted with the focus back on Play; entering fades in on the
  first frame. Reduced motion gives an instant switch.

### Fixed

- Android TV and mobile: a direct play the device cannot open or decode is retried once with the server
  converting it ("Switching to server conversion…"); after an out-of-memory error (a 4K remux on a TV
  with a 192 MB heap), at 20 Mb/s.
- Android TV and mobile: a dropped stream reloads at its position with backoff ("Reconnecting…") instead of
  ending on an error; the error screen has a Retry and no longer leaves a session open on the server.
- Desktop: a stream that errors, ends early or stalls reopens at its position with backoff while the
  server is probed ("Reconnecting…", with Retry after a minute); a direct-play file that fails to open or
  decode is retried once with a server transcode.
- Android TV and mobile: Home rows set to thumbnails before 0.4.3 show as posters again (a stale setting kept
  a Latest row in thumbnails); the order and hidden rows are kept.

## [0.4.2] - 2026-10-12

Quick fixes from the Plezy issue triage and the first Infuse-inspired ideas. Windows and Linux desktop
**0.4.2**, Android TV app **0.4.2** (`versionCode` 12), Android mobile app **0.4.2** (`versionCode` 8).

### Added

- Desktop: hold the Seek forward key (→) or the mouse button on the picture to play at 2×; letting go
  restores the speed. Not for live TV or while audio is sent as a bitstream.
- Android TV and mobile: audio delay (50 ms steps) and subtitle offset (100 ms steps) in the player's
  Audio and subtitles menu, under "Sync…". Remembered per video; "Whole series" carries them to the other
  episodes. The audio delay also works with HDMI passthrough.
- Android TV and mobile: a playback stats panel (container, codecs, decoder, HDR, bitrate, play method and
  transcode reason, buffer, dropped frames), turned on from the same "Sync…" sheet.

### Fixed

- Android TV and mobile: the video buffer is capped by the device's memory (16 to 128 MB) instead of Media3's
  ~130 MB default, which could crash 32-bit TVs on high-bitrate files; the live TV 16 MB cap now applies too.
- Android TV and mobile: speeds other than 1× are disabled, with the reason, while the audio goes out as
  HDMI passthrough (the speed did not apply there).
- Android TV: the remote's fast-forward and rewind keys step 10 s like ←/→ instead of jumping whole chapters.
- Android TV and mobile: https servers behind a private CA work once its root CA is installed on the device
  (user-installed CAs are trusted; Tailscale and NetBird stay on the system store).
- Android TV and mobile: Home and Continue Watching reload on return from the player or another app, after a
  server change (UserDataChanged, LibraryChanged) and every 5 minutes while on show.
- Android TV: a shuffle plays every entry from the start instead of its resume point.
- Android TV and mobile: "Open in an external player" passes the external subtitle files (MX Player, Vimu, VLC).
- Android TV: clearing "watched" removes only the latest play from the Trakt history instead of every play;
  removing an entry from the History screen does the same.
- Android mobile: the player follows the system rotation lock.
- Android TV and mobile: the next episode skips specials unless the server places them by air date.
- Desktop: the display may sleep while playback is paused (VOD; a paused live channel only keeps the app
  awake for its timeshift). It is blocked again on play, also after the sleep timer's pause.
- Desktop: audio and subtitle languages follow the server user's preferences by default instead of French;
  settings still holding the old untouched defaults move over once. A film remembers its audio and subtitle
  pick on resume.
- Desktop: interlaced recordings, DVD rips and 1080i TS are deinterlaced (mpv `deinterlace=auto`; Linux
  needs mpv 0.39 or later).
- Desktop: mpv no longer registers its own Windows media session next to Wicaby's.
- Desktop: Enter skips the intro even when a player button kept focus after a mouse click.
- Desktop: a subtitle delay no longer carries over to the next episode unless its memory is set to "Per Title"
  (Settings > Playback).
- Desktop: refresh-rate matching picks 23.976 Hz for 23.976 fps (and 59.94 Hz for 29.97 or 59.94 fps)
  when the display offers it, instead of 24 or 60 Hz.

## [0.4.1] - 2026-10-12

One version for every app: Windows and Linux desktop **0.4.1**, Android TV app **0.4.1**
(`versionCode` 11), Android mobile app **0.4.1** (`versionCode` 7). Everything since 0.3.1 is
summed up here; the desktop hotfixes 0.3.2 to 0.3.4 keep their own entries below.

### Added

- Linux desktop (x64 `.deb`, AppImage and `.tar.gz`, SDR only), playing through the
  distribution's mpv 0.37 or later. Desktop integration: media keys and media controls through
  MPRIS, launch at login through an XDG autostart entry, notifications (a click replaces the
  action buttons Linux notification servers do not show), refresh-rate matching with `xrandr`
  (X11) or `kscreen-doctor` (KDE Plasma on Wayland). Windows-only settings (Windows HDR, HDR
  passthrough) are hidden on Linux and the texts that named Windows follow the platform.
- Android TV parity with the desktop app (logic in `:core`, so the phone app can reuse it):
  - night mode, dialogue enhancement, loudness normalization and a volume boost to 150 %, in
    Settings and from the player's Audio Effects sheet;
  - subtitle styling as on desktop (size, font, color, legibility, position, optional ASS
    scaling), and Dark or OLED (pure black) themes with eight accent colors;
  - shuffle and a play queue, with "Play next" and "Add to queue" from "Play on";
  - item actions: "Add to Playlist…", "Add to Collection…" and "Mark Previous Episodes as
    Watched";
  - several servers at once, merged in home rows, search and libraries ("Available on 2
    servers"); a server that stops answering is left out and comes back on its own;
  - customizable home rows, with posters or thumbnails for Recently Added;
  - watch history and statistics across every signed-in server, with the desktop's queries;
  - "Who's Watching?" profiles at start and from "Switch User", with an optional PIN;
  - parental access schedules: refusals outside the allowed hours show today's hours, on Emby
    and Jellyfin, at sign-in and for a saved account;
  - Trakt: device-code sign-in, scrobbling and watched sync, per server;
  - voice search for Live TV channels and programmes.
- Android TV: an A–Z jump rail beside library grids sorted by name. LEFT from the first column
  opens it on the current title's letter, UP/DOWN scroll the grid live, OK or RIGHT jumps to the
  letter's first title, BACK returns. The server counts where each letter starts, so a jump lands
  anywhere in a large library without loading it.
- Android TV: basic music. Music libraries show albums, artists and songs; an album, artist,
  playlist or song plays all its tracks as a queue, with the album art full screen, the queue
  position and the next track, and the media keys play, pause and skip. A fuller music player is
  planned.
- Comics: the first page is the cover when the server has none (desktop, TV and mobile), read
  with HTTP range requests, never the whole archive.
- Mocks and checks: Trakt, public users and profiles, per-user access schedules, watch history,
  a small silent music library, A–Z name bounds and comic covers.

### Fixed

- Android TV, security: the PIN of a "Who's Watching?" profile could be bypassed. Until the picker
  has opened an account the TV now has no session at all: no server socket or remote control,
  and launcher rows (Watch Next, channels), reminders, the screensaver and "Play" sent from
  another app wait or do nothing; "Switch User" cannot be left with Back. PIN tries are
  rate-limited (after 5 wrong tries each try waits, from 30 s up to 1 h).
- Android TV: D-pad RIGHT on the last card of a row or grid (LEFT on the first) no longer jumps to
  another row or the tab bar.
- Android TV and mobile: admin messages show in an in-app banner, browsing or playing, and as a
  toast while the app is in the background. Mobile showed them only during playback; with "Allow
  remote control" off, both apps dropped them.

## [0.3.4] - 2026-10-12

Windows desktop app.

### Added

- Connection status on the sidebar dot: green, orange or red for all connections, and a popover
  (hover or keyboard focus) with each signed-in server (state, address, local / remote / VPN route,
  latency, realtime socket), the VPN (node, mesh IP and name, NetBird routed networks) and
  qBittorrent. Each row opens its settings pane.

### Fixed

- Admin messages ("Send a message" from a server dashboard) show during mpv playback: the player
  window shows notifications, which went to the hidden main window before. They also show with
  "Allow remote control" off (a message is not remote control) and stay up for the sender's
  timeout (3 to 30 s).

## [0.3.3] - 2026-10-12

Windows desktop app and mesh helper.

### Added

- NetBird network routes on Windows: a server in a network a NetBird peer routes (for example the
  home LAN behind a routing peer) is reached through NetBird when it does not answer directly.
  Exit nodes (default routes) are never used.

## [0.3.2] - 2026-10-12

Windows desktop app hotfix.

### Fixed

- NetBird: a self-hosted management server typed in "Self-Hosted NetBird Server or Setup Key" is
  used. The button no longer reopens the earlier login.netbird.io page; it connects with the server
  and key in the fields, the node restarts on it, and a registration made with another server is
  dropped so the sign-in starts afresh. The saved server shows in the field.
- Home loads faster: each row appears as soon as its own answer arrives instead of waiting for
  every other row, and a saved server that is unreachable no longer restarts the loading.
- Home no longer breaks (and could not be reopened) when a server lists the same item twice; a
  row that fails leaves the rest of the page working. Repeats are also dropped in library pages
  and in cast and crew lists.
- No more "An object could not be cloned" error during playback when the Cast list updates, nor
  when removing a second card from Continue Watching.

## [0.3.0] - 2026-10-12

Android TV app **0.3.0** (`versionCode` 8), Android mobile app **0.3.0** (`versionCode` 4).

### Added

- Cast everywhere: one Cast button on Windows and on phones, with a
  picker in three sections (apps, DLNA/UPnP TVs and players, Chromecast and Google TV), a
  remote while casting and "Play here" to take playback back. AirPlay is not supported.
- "Play on" through the Sessions API: Windows and phones send to any Wicaby, Emby or Jellyfin
  session, including the DLNA renderers the server exposes; the phone app now also receives,
  with a notification when it is in the background.
- DLNA/UPnP sender on Windows (with a LAN stream relay, so the TV never gets the access token)
  and on phones, with SSDP discovery and Sony and Samsung quirks.
- Desktop: Chromecast and Google TV over the open CASTV2 protocol, with Jellyfin's receiver app
  for Jellyfin and the Default Media Receiver (with VTT subtitles) for Emby.
- Android mobile: a `gplay` flavour (`Wicaby-Mobile-Cast-*`) with Google Cast through Google
  Play services and Media3 `CastPlayer`; it has no FFmpeg audio decoder. The default `foss`
  flavour keeps FFmpeg and contains no Google code.
- A disposable Jellyfin token per cast through Quick Connect, revoked when the cast ends.
- Mocks and checks: Sessions-API remote control, DLNA renderers (generic, Sony, Samsung) and a
  CASTV2 device, all on loopback.

### Changed

- Licence: one identifier, GPL-3.0-or-later, plus a section 7 additional permission for linking
  with Google Play services in the `gplay` flavour only (`LICENSE-EXCEPTION.md`).

### Fixed

- Android 17: Wicaby declares and requests the local network permission, so LAN servers,
  discovery and casting keep working; remote servers work without it.
- Desktop: the "Play on" receiver validates every remote command, and an "Allow remote control"
  setting turns it off.

## [0.2.0] - 2026-10-11

First public release. Android TV app **0.2.0** (`versionCode` 7), Android mobile app **0.2.0**
(`versionCode` 3).

### Added

#### Desktop (Windows)

- Windows media client for Emby and Jellyfin, rewritten from Emby Theater: Electron main
  process with a typed IPC contract, Svelte 5 UI, `mpv` playback in a child process with a video
  window and a transparent on-screen display, and an HTML5 / hls.js fallback player.
- Server discovery on the LAN, Emby Connect, Wake-on-LAN, remote control, taskbar thumbnail
  buttons, jump list, media keys (SMTC) and refresh-rate matching.
- Resumable offline downloads.
- Multi-server: several Emby and Jellyfin servers signed in at once, with a merged home and
  search, provider-id de-duplication with a server chooser, a sidebar grouped per server and
  per-server sign-in and sign-out.
- Browse pages: hero carousel, shelves, an Apple TV-style item page and cached navigation.
- Live TV with a guide and recordings, playlists and collections, and a customisable home.
- Skip intro and credits (Emby chapter markers, Jellyfin media segments), next-episode card,
  "still watching?" prompt, trickplay thumbnails on the scrubber (BIF and Jellyfin tile sheets)
  and a chapter picker.
- Playback engine: an mpv watchdog that falls back to the HTML player at the same position,
  reconnects and larger caches for remote servers, audio passthrough, volume boost up to 150 %,
  night mode and dialogue boost, one track-selection engine (forced tracks, per-series memory),
  and subtitle styling with Geist through libass.
- HDR10, HDR10+, HLG and Dolby Vision in mpv: tone mapping with peak detection on SDR
  displays, passthrough once mpv reports an HDR output, Dolby Vision reshaping through
  libplacebo, and an optional Windows HDR auto-switch that restores the previous state on stop
  or after a crash.
- Aspect modes (fit, fill, stretch, zoom, original), trailers (local trailers, and YouTube
  through the privacy-enhanced `youtube-nocookie.com` embed), an optional cinema mode, and
  Dolby Vision / HDR10+ / HDR10 / HLG chips per version on the item page.
- CBZ comic reader with manga right-to-left and webtoon modes driven by `ComicInfo.xml`, spreads,
  and progress saved to the server.
- Remote access: detects and drives installed Tailscale and NetBird clients, or runs Wicaby's
  own embedded mesh node (see Mesh below).
- qBittorrent integration (Web API v2, qBittorrent 4.x and 5.x): live list, actions, add by
  magnet link or `.torrent` file, and library mapping that triggers a library scan when a
  download completes.
- Server administration for server administrators: dashboard with live sessions and remote
  control, activity log, scheduled tasks, users and policies, devices, libraries with a
  server-side folder browser, item metadata, images, identify, subtitles and delete, server and
  network settings, transcoding, plugins, API keys and logs, for both Emby and Jellyfin.
- Windows integration: tray icon with a mini player, start with Windows, close to tray and
  notifications.
- Much richer settings: density, poster size, zoom, quality per network, resume behaviour,
  audio device, privacy, advanced options and search.
- English and French UI: per-namespace catalogues, live language switch, `Intl` formatting, a
  glossary and a strict catalogue checker (`tools/checks/i18n-check.mjs --strict`).
- New logo (a W with a blue play triangle) rolled out to the Windows icons, the in-app logo,
  and a monochrome variant for the sidebar.

#### Android TV

- Wicaby for Android TV (Kotlin, Compose for TV, Media3): server add and discovery, profile
  picker and sign-in, home with hero and rows, libraries, item pages with seasons, search, and
  settings with an accent colour.
- A device profile built from the device's decoders (sizes, profiles, levels, HDR and Dolby
  Vision capabilities, with known-broken devices excluded); passthrough re-read for every
  playback; display-mode switching.
- FFmpeg audio decoding (AC-3, E-AC-3, DTS, TrueHD and more) and full ASS/SSA subtitle styling
  through libass; image subtitles burned in when transcoding.
- Skip intro, next episode, and the Android TV "Watch Next" row.
- tvOS-style floating top bar, exit confirmation, sectioned settings, a Torrents tab and
  remote access with QR-code sign-in.
- English and French, with an in-app language picker (per-app locales on Android 13+).
- CBZ comic reader (D-pad, spreads, right-to-left, webtoon).
- Version picker for multi-source items, used by playback information, streams and downloads.
- In-app updates for sideloaded APKs from an `update.json` manifest, on by default and pointing
  at the public releases page. The APK's SHA-256 is checked whenever the manifest lists one
  (the published manifests always do), and installation goes through `PackageInstaller`.
- Fit, fill, stretch and zoom in the player; trailers (YouTube opens externally or as a QR
  code); Dolby Vision (with profile), HDR10+, HDR10 and HLG badges.
- A universal APK alongside the per-ABI APKs, for 32-bit Android TVs.

#### Mobile (Android phones and tablets)

- Wicaby for phones and tablets: a Material 3 app in the Graphite style with an adaptive
  navigation bar or rail, gesture player, picture-in-picture, background playback, offline
  downloads and torrents.
- Shared `:core` module (UI-free) with the TV app, and a shared `:mesh-ui` remote-access panel.
- English and French with an in-app language picker; CBZ comic reader (swipe, pinch to zoom).
- Version picker, in-app updates, aspect modes, trailers and HDR / Dolby Vision badges, as on
  TV.

#### Mesh (`packages/mesh`)

- `wicaby-mesh`, an embedded Tailscale (`tsnet`) or NetBird (`client/embed`) node written in
  Go. It runs in userspace, needs no installation or administrator rights, and shows up in the
  tailnet or NetBird network as its own node.
- Each media server is reached through a loopback-only forwarder
  (`http://127.0.0.1:<port>/<random token>`) that only dials current peers of the mesh.
- A gomobile AAR for Android (arm64-v8a and armeabi-v7a) with Android network-interface
  listing.
- The build scripts collect every linked module's licence into `THIRD_PARTY_LICENSES.txt` and
  fail if any AGPL NetBird package (`management/`, `signal/`, `relay/`, `combined/`) is linked.

### Changed

- Repository reorganised into a monorepo: `apps/desktop` (Electron), `apps/android` (Gradle root;
  the Android TV module `:app` is renamed `:tv`, application ids unchanged so installed apps keep
  updating), `packages/mesh` (Go), `tools/mock-server`, `tools/checks` (one runner:
  `npm run checks`), `tools/release`, `brand` and `docs/`. The root `package.json` is an
  npm workspaces root that delegates `dev`, `start`, `build`, `check` and `dist` to
  `apps/desktop`.
- Added `.editorconfig`, `.gitattributes` (LF for sources, CRLF for PowerShell and batch
  scripts) and `.nvmrc` (Node 22).
- Licensed under GPL-3.0-or-later, with `THIRD_PARTY_NOTICES.md`, `CONTRIBUTING.md` and `SECURITY.md`.
<!-- TODO: add the dependency upgrades (Electron, Svelte/Vite, Media3, Compose, Go modules, mpv)
     here once they are merged, before tagging v0.2.0. -->
- Desktop: Graphite design system (Apple-style tokens, Mica sidebar, view transitions, GPU-only
  motion), redesigned shell and onboarding with a profile picker, and a redesigned player OSD,
  settings and downloads.
- Desktop: neutral, static, monochrome icons across browse, settings and the OSD; no accent-,
  pink- or yellow-coloured glyphs and no coloured squares behind settings icons.
- Desktop: the blue focus ring is gone; focused controls show a fill or a lift instead.
- Desktop: calm sidebar with a static fill on the active row and no fade on hover or selection;
  the window chrome switches instantly and only the page cross-fades during navigation.
- Desktop: neutral palette everywhere, audio and subtitle delay readouts, and the formal "vous"
  form in the French UI.
- Desktop: Jellyfin uses the modern `/User*` routes; Emby keeps its own.
- Desktop: GET responses from the server are cached for two minutes, so going back is instant.
- Desktop: a user-supplied `mpv.conf` now really wins when "Use mpv.conf" is on, including over
  the audio output.
- Android: release APKs are split per ABI (about 55 MB instead of 175 MB).

### Fixed

- Desktop: black video in mpv. Chromium composites a window's own surface above its child
  windows, so the mpv host is now a transparent window; `nvdec` maps to `nvdec-copy` with
  `d3d11va` and software fallbacks.
- Desktop: a 401 response no longer signs the user out unless `GET /Users/{id}` confirms the
  token is no longer valid.
- Desktop: title-bar search; the search page follows `?q=` without remounting.
- Desktop: aborted view transitions no longer break the router.
- Desktop: two selected sidebar rows briefly drawn at once during page transitions.
- Desktop: a vetoed quit no longer leaves close-to-tray disabled.
- Desktop: when the audio device refuses passthrough (for example TrueHD to plain speakers),
  mpv no longer waits forever; Wicaby clears `audio-spdif` and reopens the track as PCM.
- Desktop: both playback windows realign after any move, resize or display change, and mpv is
  nudged when its render size disagrees with the host window.
- Desktop: Jellyfin 12 compatibility (the WebSocket token is passed as `ApiKey`).
- Desktop: on Jellyfin, Next Up no longer lists items that are already in Continue Watching.
- Android: JSON decoding is lenient, so Emby's numeric Studios ids no longer break item pages
  ("Impossible de charger le contenu").
- Android: text fields stay above the on-screen keyboard, and the login column no longer
  overlaps.

### Security

- Desktop: server access tokens are stored in a vault encrypted with Windows DPAPI (Electron
  `safeStorage`), bound to the Windows user account; Emby Theater kept them as plain JSON.
- Desktop: the renderer runs sandboxed with context isolation and no Node integration, behind
  a Content Security Policy that allows only the app's own scripts (inline styles are allowed); navigation away from the app and new windows are blocked,
  and web permissions are limited to fullscreen and clipboard writes.
- Desktop: server images, streams and subtitles go through the `wicaby-media://` protocol,
  which adds authentication in the main process, so the renderer does not hold the session
  token.
- Desktop: the qBittorrent password is kept in the vault, bound to its host and user; a
  self-signed certificate is accepted only after the user trusts its fingerprint for that host.
- Desktop: the YouTube trailer embed is limited to `youtube-nocookie.com` by a narrow
  `frame-src` rule.
- Android: access tokens are sealed with an AES-GCM key held in the Android Keystore, and app
  backups are disabled.
- Android: downloaded updates are checked against the SHA-256 in the manifest, when it lists
  one, before installation; Android also requires the same signing key as the installed app.
- Mesh: loopback-only forwarders with an unguessable path token and a live peer allow-list;
  secrets reach the helper on stdin, never in its command line or environment; log upload to
  Tailscale is compiled out of the Android library.
- Release: the bundled mpv build is pinned (shinchiro `20261011`, mpv `git-accb7b2821`) and its
  SHA-256 checked on download; a release needs a green CI run on its commit, every APK must be
  signed by the expected certificate, and the workflows' actions are pinned to commit SHAs.
- Release: the Windows app ships its licence texts in `resources/licenses/`, and each release
  publishes the matching mpv source archive next to Wicaby's own.

[Unreleased]: https://github.com/WicaebethTheo/wicaby/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/WicaebethTheo/wicaby-releases/releases/tag/v0.3.0
[0.2.0]: https://github.com/WicaebethTheo/wicaby-releases/releases/tag/v0.2.0
