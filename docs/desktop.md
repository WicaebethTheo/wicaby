# Desktop app (`apps/desktop`)

The Windows client is Electron 44 with a Svelte 5 + Vite UI, and plays video with **mpv** running as a child process. It talks to Emby and Jellyfin, to several servers at once. Like Emby Theater, it is a thin native shell around a web UI with a native player under it, but every part is rewritten. For a deeper walkthrough (startup sequence, playback flow), see [architecture.md](architecture.md) (in French).

## Processes and layout

```
apps/desktop/
├─ src/main/        Electron main process (Node): all server logic, playback, storage
│  ├─ index.ts      composition root: builds every service in bootstrap()
│  ├─ ipc.ts        ipcMain handlers, sender and argument validation
│  ├─ protocols.ts  app:// and wicaby-media:// handlers, CSP
│  ├─ connection/   ConnectionManager, ApiClient, discovery (UDP 7359 + WoL), Emby Connect, ServerSocket (WebSocket)
│  ├─ playback/     PlaybackService, MpvPlayer + MpvController, HtmlPlayer, device profiles, track selection, HDR
│  ├─ windows/      WindowManager (main window, mpv video + OSD pair)
│  ├─ downloads/    DownloadManager (Range resume, offline progress queue)
│  ├─ comics/       CBZ reader backend (zip, ComicInfo, page sizes)
│  ├─ torrents/     qBittorrent Web API client and service
│  ├─ vpn/          installed Tailscale/NetBird clients + the embedded mesh node
│  ├─ admin/        item image upload / remote images
│  ├─ features/     display mode, Windows HDR, tray, taskbar, startup, notifications
│  ├─ core/         settings, JSON store, DPAPI vault, logs
│  └─ i18n.ts       main-process translations
├─ src/preload/     contextBridge: exposes window.wicaby
├─ src/renderer/    Svelte 5 UI (routes/, components/, admin/, lib/, locales/)
├─ src/shared/      contract.ts (IPC types + channels), i18n-core, hdr, bif, mpv-args, models
├─ native/          mpv-render/: Linux libmpv render addon (C++, Node-API, binding.gyp), built by build-native.mjs
├─ scripts/         dev.mjs, build-main.mjs, build-native.mjs, fetch-mpv.ps1, cdp.mjs
└─ electron-builder.yml
```

- **Main** owns everything that touches a server or the OS: connections, tokens, playback, reporting, downloads, torrents, the mesh. **The renderer never sees an access token.** API calls go over IPC, and media goes through `wicaby-media://`.
- **Preload** (`src/preload/index.ts`) wraps `ipcRenderer.invoke` and `on` into the typed `WicabyBridge` and exposes it as `window.wicaby`. It strips Electron's "Error invoking remote method" prefix, so the UI can show main's error messages as they are.
- **Renderer** is a single-page Svelte app with a hash router (`lib/router.svelte.ts`) and `$state` stores (`lib/stores.svelte.ts`). The same bundle also renders the player OSD (route `#/osd`, opened with `?osd=1`).

Every window runs with `contextIsolation`, `sandbox`, no `nodeIntegration` and `webSecurity` on. DevTools exist only in unpackaged builds: with the Vite dev server, or with `WICABY_DEVTOOLS=1` on `npm start`. A packaged build ignores both variables, and no remote debugging port is opened. Navigation outside the app is blocked. `window.open` goes to the default browser, for http(s) only. Web permissions are refused except `fullscreen` and `clipboard-sanitized-write`.

## Protocols

Both schemes are registered as privileged before `ready` (`registerSchemes()`).

### `app://wicaby/`

`app://wicaby/` serves the built renderer (`out/renderer`). It is a real secure origin, not `file://`. HTML responses carry this CSP:

```
default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: wicaby-media:; media-src 'self' blob: data: wicaby-media:;
connect-src 'self' wicaby-media:; font-src 'self' data:; worker-src 'self' blob:;
frame-src https://www.youtube-nocookie.com; object-src 'none'; base-uri 'none';
form-action 'none'; frame-ancestors 'none'
```

`connect-src` is closed to the network: an XSS in the UI could not exfiltrate anything. The only frame allowed is YouTube's privacy-enhanced embed, for trailers. Main adds a `Referer: https://com.wika.wicaby/` header on those requests, because YouTube rejects embeds without one.

In development, the main window loads from the Vite dev server instead (`WICABY_DEV_URL`).

### `wicaby-media://`

`wicaby-media://` replaces the `?api_key=` URLs other clients use:

| URL | Serves |
|---|---|
| `wicaby-media://api/<serverId>/<path>` | Server API (images, streams, subtitles, HLS). Main resolves the server's base URL (adds `/emby` when needed), adds the auth headers, forwards `Range`, `Accept`, `If-None-Match` and `If-Modified-Since`, drops `Set-Cookie`, and adds CORS for hls.js. Without the server id, the primary server. |
| `wicaby-media://remote-image/?u=<url>` | Artwork previews from metadata providers (TMDb, TVDb, fanart.tv…) for the admin image picker. Only public http(s) host names (no IP literal, localhost or `.local`), image responses only, size capped. |
| `wicaby-media://local/<id>`, `wicaby-media://poster/<id>` | Downloaded files and posters, with byte ranges (206/416). |
| `wicaby-media://comic/<serverId>/<itemId>/<page>[?thumb]` | Page images of an opened CBZ. |

## IPC contract

`src/shared/contract.ts` declares everything that crosses the process boundary: the `WicabyBridge` interface, every payload type, and the `Channels` map (`domain:action` names). Main, preload and renderer import the same file, so any drift between them fails to compile.

| Domain | What it covers |
|---|---|
| `app` | `info`, `quit`, `openExternal` (http/https only), `openPath(logs \| downloads \| mpv-config \| data)`, `log`, `storage`, `clearStorage` |
| `window` | minimise, maximise, close, fullscreen, state. Called from the OSD, these act on the playback windows, and closing stops playback. |
| `settings` | `get`, `update` (deep merge + sanitising in `SettingsService`), folder and mpv pickers, `audioDevices`, export, import, reset, `onChange` |
| `servers` | `discover`, `list`, `add`, `embyConnect`, `select`, `remove`, `wake` |
| `session` | `get`, `publicUsers`, `login`, `logout`, `disconnect`, `onChange` (all take an optional `serverId`) |
| `api` | `get`, `post`, `del`, `put`, `uploadImage`: a proxy to a server. Paths must be relative. Only GET, POST, DELETE and PUT are accepted. A 401 signs that session out. |
| `playback` | `play(PlayRequest)`, `command(PlaybackCommand)`, `getState`, `onState` |
| `htmlPlayer` | `onLoad`, `onCommand`, `emit`: the bridge to the fallback `<video>` player |
| `downloads` | `list`, `add`, `pause`, `resume`, `remove`, `reveal`, `onChange` |
| `comics` | `open`, `saveProgress` |
| `vpn` | `status`, `connect`, `peers`, and `embedded.{status, logout, onChange}` |
| `torrents` | state and watch mode, test, configure and forget, certificate trust, add, actions, remove, category, alt speed, magnet hand-over |
| `events` | `onServerEvent` (WebSocket messages), `onNavigate`, `onToast` |

`ipc.ts` rejects any call whose `senderFrame.url` is not a Wicaby page (`WindowManager.isAppUrl`). It then checks argument types and sizes before calling a service. `html-player:event` is only accepted from the main window.

To add a call:

1. Declare it in `WicabyBridge` and `Channels`.
2. Implement it in `preload/index.ts`.
3. Handle and validate it in `ipc.ts`.

The compiler points at whatever is missing.

## mpv embedding

### Why mpv runs in its own windows

mpv runs as `mpv.exe`, a child process, and is driven over its JSON IPC on a named pipe (`\\.\pipe\wicaby-mpv-<uuid>`). It renders into a window that Wicaby owns, through `--wid=<HWND>`, with `--vo=gpu-next --gpu-api=d3d11 --ao=wasapi`. A crash in a decoder therefore never takes the app down, and any mpv build can be used.

This setup comes from what Windows HDR playback needs:

- **HDR needs a real HWND.** Every Windows player with working HDR passthrough gives mpv a real HWND with a D3D11 swapchain. The libmpv render API only supports OpenGL and software rendering, so it cannot carry HDR on Windows.
- **No compositor or texture alternative.** Chromium owns Electron's DirectComposition tree, which rules out mpv's composition output mode. Shared-texture import loses HDR, display sync and frame pacing.
- **No foreign child.** Electron cannot host its web contents as a child of a foreign HWND, so the UI cannot sit inside mpv's window.

### The window pair

`WindowManager.createPlaybackWindows()` builds two top-level windows:

- **Video:** a `BaseWindow` with no web contents, frameless and **transparent** (`backgroundColor: '#00000000'`). mpv creates its own child window inside it. Chromium composites a window's own surface *above* its child windows (electron#10547), so any opaque background, or an attached web view, would hide the video. That is why it is a bare transparent `BaseWindow` and not a `BrowserWindow`.
- **OSD:** a transparent, frameless `BrowserWindow`, owned by the video window (`parent: video`). It loads the same UI at `#/osd`, so the controls float above the picture.

How the pair behaves:

- The OSD is the window the user moves, resizes and snaps. The video window follows its bounds, and `settlePlayback()` re-checks both 150 ms after the last move or display change: a monitor with another DPI rescales each window separately.
- Focus that lands on the video window (Alt+Tab, taskbar) is handed to the OSD. While playing, the main window is hidden, and it comes back when playback ends.
- Fullscreen is manual: both windows cover the display's bounds, which also hides the taskbar.
- mpv resizes its child asynchronously and sometimes misses the last resize. `MpvPlayer` compares mpv's `osd-dimensions` with the host and, if they differ, nudges the host by one pixel to make mpv re-read the rectangle.
- A watchdog pings mpv over a second pipe client and kills a hung process.

### What can and cannot change

- `--wid`, the IPC options and the input options are fixed. Neither the user's `mpv.conf` nor "Extra mpv arguments" (`shared/mpv-args.ts` refuses `wid`, `input-ipc-server`, `input-ipc-client`, `idle`, `keep-open`, `force-window` and `terminal`) can change them.
- With "Use mpv.conf", `<userData>/mpv/mpv.conf` (a commented template is created on first run) is loaded after Wicaby's defaults and wins.
- **Finding mpv** (`locateMpv`), in order: the path in settings, `resources/mpv/mpv.exe` (bundled), `vendor/mpv/mpv.exe` at the repo root (development), `PATH`, Scoop, `%LOCALAPPDATA%\Programs\mpv`, then `C:\Program Files\mpv`.

### Linux: three render modes

`--wid` needs an X11 window, which a native Wayland client does not have. `index.ts` picks one mode at startup (`mpvRender`) and logs it with the reason:

| Mode | When | How video reaches the screen |
|---|---|---|
| `wid` | X11 or XWayland (`WICABY_OZONE=x11`), and Windows | the window pair above, mpv as a child process |
| `texture` | native Wayland with GPU acceleration on, when `out/native/wicaby_mpv.node` loads, finds libmpv and its render check passes on a render node | libmpv in the main process renders into GPU buffers that one Wicaby window draws under the OSD |
| `detached` | native Wayland otherwise: no addon, no libmpv, no usable render node, or GPU acceleration off (the setting or `WICABY_DISABLE_GPU=1`) | mpv as a child process in its own window, with its own controls |

The addon is probed once at startup. `probe()` reports whether libmpv loads (and its client API version) and a render check: it opens the render node, creates a GBM device and an EGL display and context, then tears them down. The node is `WICABY_RENDER_NODE` when set, else the first `/dev/dri/renderD*` (sorted) where EGL initialises. The startup log line gives the mode and the actual reason for the choice (for example `libmpv.so.2: cannot open shared object file`, or `GPU acceleration disabled`). With GPU acceleration off, Chromium has no GPU process to import the buffers into, and a failed import gives a black picture with no error, so texture mode is never chosen then.

`WICABY_MPV_RENDER=detached` forces mpv's own window. `texture` is already the default on native Wayland: setting it cannot force texture mode past a failed probe or with GPU acceleration off, and only turns that fallback into a warning in the log (`wid` only means something under X11). Invalid values are ignored. Music always uses the external mpv process (`MpvAudioPlayer`), whatever the mode, so music still needs the mpv command; video in texture mode does not.

**Runtime fallback.** The probe cannot test Chromium's import or every render path. If the render thread reports a fatal error in texture mode, the controller exits before the first frame, or 60 frames in a row cannot be imported or delivered to the playback window (`VideoSurface` `'fatal'`), `PlaybackService` retries the same item at the same position once in `detached` mode (in the built-in player when there is no mpv command) and keeps `detached` for the rest of the session, with a log line. A texture player that fails to start falls back the same way. A ring resize the addon cannot allocate is not fatal: the old ring stays in use, a warning is logged and the next window size change retries.

**Texture mode** (`native/mpv-render`, `playback/libmpv-controller.ts`, `playback/video-surface.ts`):

- The addon is C++ over Node-API, built by node-gyp (`npm run build:native`, the first step of `npm run build` on Linux). Its `binding.gyp` sits in `native/mpv-render/`, never at a package root, where npm would add a hidden `node-gyp rebuild` install script. Node-API is ABI-stable, so the binary built against Node's headers loads in Electron without a rebuild.
- libmpv is `dlopen`ed (`libmpv.so.2`, client API 2.1 or later; `libmpv.so.1` is never tried, every one is client API 1.x) from vendored ISC headers, so the app still starts without it and falls back to `detached`. Texture mode does not need the mpv command: options are not gated on the version of whatever `mpv` is on `PATH`: the version-dependent ones are all passed, any the loaded libmpv refuses is skipped with a log line, and once libmpv runs its own `mpv-version` must be 0.37 or later (otherwise playback falls back to `detached` when an mpv command exists). A user `mpv.conf` is read by Wicaby and applied through the same allow-list as the mpv arguments setting, before Wicaby's forced options, with libmpv's own config loading off (`config=no`), so it cannot override the options Wicaby relies on; `[profile]` sections and lines the allow-list refuses (for example `hwdec`, `slang` or `profile=`) are ignored, with a log line. The addon links only EGL, GLESv2 and GBM; `tools/checks/native-addon-check.mjs` verifies that libmpv is not a `NEEDED` entry.
- A render thread owns an EGL context on the GPU render node (`/dev/dri/renderD128`) and renders each new frame (`vo=libmpv`, render API) into a ring of four GBM buffers. Their dma-buf file descriptors go to Electron's `sharedTexture` API, and the preload of the playback window draws each frame onto a `<canvas>` under the OSD. JS calls only enqueue work, except `setOption` and `initialize()`, which run synchronously (`mpv_initialize` parses the config); the Node main thread never waits on the GPU. A frame's buffer goes back to the ring only once Chromium has released its import of it (`allReferencesReleased`), so mpv never renders into a buffer the GPU is still reading.
- `LibmpvController` has the same surface and events as `MpvController`, so `MpvPlayer` does not know which transport it drives. One window (`createPlaybackWindow`, title `Wicaby PiP` in picture-in-picture) replaces the pair: there is nothing to keep in step.
- Packaging: `asarUnpack: out/native/**/*.node` (a `.node` inside the asar is copied to a temporary file first, which fails on a `noexec` `/tmp`); the deb depends on `libmpv2`, `libgbm1`, `libegl1` and `libgles2` besides `mpv`.

Known limits of texture mode:

- **SDR only.** Frames are 8-bit RGBA, so HDR is tone-mapped to SDR; passthrough is never offered (the HDR hint stays on the target display), as everywhere on Linux.
- **No crash isolation.** libmpv runs inside the main process, so a decoder crash closes Wicaby. `WICABY_MPV_RENDER=detached` brings back the separate mpv process. The runtime fallback above covers render errors that libmpv reports, not crashes.
- **Display sync.** mpv cannot see the output, so `override-display-fps` is set from the refresh rate of the display the playback window is on.
- **Picture-in-picture.** A Wayland client cannot place its window or keep it above others; the compositor decides. Wicaby only resizes the playback window and changes its title to `Wicaby PiP`. On Hyprland, `float` and `pin` are static window-rule effects: they are evaluated once, when a window opens, and not again when its title changes. The playback window opens as `Wicaby` and is renamed on the PiP toggle, so a title rule for `Wicaby PiP` does not float or pin it mid-playback. It only matches a playback window that opens while picture-in-picture is already on. For an ordinary toggle, bind a key that floats and pins the focused window instead (both binds on the same key run together):

  ```ini
  # ~/.config/hypr/hyprland.conf (hyprlang config, Hyprland 0.53 or later)
  bind = SUPER ALT, P, togglefloating
  bind = SUPER ALT, P, pin
  # Static rule: applies only when a window opens already titled "Wicaby PiP".
  windowrule = match:title ^(Wicaby PiP)$, float on, pin on
  ```

  ```lua
  -- ~/.config/hypr/hyprland.lua (Lua config, Hyprland 0.56): the same static rule.
  hl.window_rule({ name = "wicaby-pip", match = { title = "^(Wicaby PiP)$" }, float = true, pin = true })
  ```

  The pre-0.53 form `windowrule = float, title:^(Wicaby PiP)$` is rejected by Hyprland 0.53 and later (`invalid field float: missing a value`). The hyprlang lines and the Lua rule were checked with `Hyprland --verify-config` on 0.56.2; that the rule does not fire on a title change follows from Hyprland's static/dynamic rule split and was not tested in a live session.

## HTML player fallback

The fallback is used when mpv is not found or the user chooses it, globally (`playback.player`: `auto`, `mpv` or `html`) or per content type (`playback.playerByType` for movie, episode, music and live). `auto` means mpv when it is found, else `<video>`. Asking for mpv without it falls back with a toast.

- `playback/html-player.ts` implements the same `ActivePlayer` interface as mpv. It sends `html-player:load` and `html-player:command` to the main window and receives `html-player:event` (`time`, `volume`, `stats`, `ended`, `error`) back. Reporting, queueing, taskbar buttons and remote control therefore share one code path.
- `routes/Player.svelte` plays through hls.js or a plain `src`, always via `wicaby-media://`.
- `shared/device-profile.ts` has three profiles (the third, `tv`, was the earlier web TV app's; the TV web app, [tv-web.md](tv-web.md), builds its own):
  - `mpv` direct-plays almost everything;
  - `html` direct-plays MP4 and WebM and asks for HLS otherwise. An audio track other than the default forces a remux, because `<video>` cannot switch tracks.
- **Limits:** Chromium's Matroska support is partial (`.mkv` is served as `video/webm`). There is no HDR passthrough and no audio bitstreaming.

## Music engine

Music (music spec MU-02, decision D1) does not go through the video player. `main/music/mpv-audio-player.ts` runs mpv with
**no window at all** (`--force-window=no --vid=no --audio-display=no`), audio only, and `main/music/music-playback.ts` (the
music twin of `livetv/live-player.ts`) is what `playback-service.ts` calls into, at a few named hooks.

- **Gapless:** while track *n* plays, *n+1* is appended to mpv's playlist (`loadfile … append` with per-file options:
  auth header, `replaygain`, `replaygain-fallback`), 20 s before the end or at once for a shorter track. When mpv moves on
  by itself, *n* is reported Stopped at its full length, then *n+1* Playing, with no reload. A queue edit replaces the
  prefetched entry; any failure falls back to the plain path (`ended` → next track, a short gap, never a stop).
- **Queue:** `shared/music-queue.ts` (move, remove, jump, play next, shuffle with undo, repeat off/all/one) is shared with
  Android's `core/music/MusicQueue.kt` through `tools/checks/fixtures/music/queue-vectors.json`. Repeat one goes through the
  queue (the same track appended again), not `loop-file`.
- **Loudness (D2):** ReplayGain album mode by default. Tagged files use their tags; untagged ones get the server's
  `NormalizationGain` (Jellyfin; the album's in album mode) or the fallback gain, through `replaygain-fallback`; the preamp
  applies to both. `dynaudnorm` ("Normaliser le volume") is never applied to music.
- **Bit-perfect:** WASAPI exclusive (`audioExclusive`) with ReplayGain off and the volume at 100 % leaves the samples untouched.
- **Built-in fallback:** `playerByType.music = html` plays through an `<audio>` element of the main window
  (`components/music/MusicHost.svelte`), never the player page; one `GainNode` applies the server gain and the preamp. No
  gapless, no ReplayGain tags.
- **SMTC:** the main window owns `navigator.mediaSession` while music plays (title, artists, album, the album's art), with
  the silent keep-alive of `lib/media-session.svelte.ts` for mpv, as the OSD does for video.
- **D8:** the queue is saved to `<userData>/music-queue.json` and comes back, paused, at the next start.
- **Checks:** `music-check.mjs` (LRC and queue vectors) runs in `npm run checks`; `music-engine-check.mjs` drives the app over
  CDP against both mocks (Windows, mpv, never audible: `WICABY_TEST_SILENT=1` gives mpv `--ao=null` and Chromium
  `mute-audio`, only in development builds).

## Music UI

The views (music spec MU-03 to MU-06) sit on that engine; `lib/music-ui.svelte.ts` holds what they share (queue items by
id, the track menu, mix, favourites).

- **Library:** a music library opens `routes/Music.svelte` (from `Library.svelte`): Albums (grid or list, sorts, favourites
  and genre filters), Artists (an "album artists only" toggle: `/Artists/AlbumArtists` or `/Artists`), Songs
  (`components/music/SongList.svelte`, a windowed list: only the rows near the viewport in the DOM, pages of 100 fetched as
  they come into view), Genres (a genre opens its albums, with Mix), Playlists (audio ones) and Folders. Tab, sort, view and
  toggle are kept per library in `localStorage`.
- **Album and artist pages:** `components/music/AlbumTracks.svelte` (disc headers, count and length, a heart and a menu per
  row, the playing row marked); the artist page adds top songs and splits the discography into its albums and "appears on".
  `components/music/TrackMenu.svelte`: play next, add to queue, add to playlist, mix, radio, go to artist or album, favourite.
- **Now playing:** `components/music/NowPlayingBar.svelte` (72 px, at the bottom of the main pane while a track is current),
  `QueuePanel.svelte` (drag by the grip, Alt+↑/↓, Delete, double click to play, clear upcoming, save as playlist, radio) and
  the full-screen `routes/NowPlaying.svelte` (blurred art under a scrim, opaque with reduced transparency; lyrics or queue).
  The window title follows the track.
- **Lyrics:** `components/music/LyricsPane.svelte` from the server only (Jellyfin `/Audio/{id}/Lyrics`; Emby an `lrc` subtitle
  stream, unverified, §3.5). The current line sits at 35 % of the height; a click seeks; a per-track offset (±0.1 s) stays
  on this device. Any failure reads as "no lyrics".
- **Mix and radio:** always `GET /Items/{id}/InstantMix` (track, album, artist, genre, playlist). With radio on, main tops
  the queue up with 20 tracks of the last one's mix once 3 or fewer are left, never one already played this run.
- **Shortcuts:** a `music` context in `shared/shortcuts.ts` (editable in Settings): Space, Ctrl+←/→, ←/→ ±5 s, Shift+←/→
  ±30 s, ↑/↓ volume, M, S, R, L, Q, F, Escape. Plain arrows act only when nothing has focus or in the full-screen player
  (elsewhere they move the focus); nothing fires in a text field.
- **Check:** `tools/checks/music-ui-cdp.mjs` drives both mocks over CDP (Windows, mpv, silent), outside `npm run checks`.

## Multi-server sessions

Wicaby can be signed in to several Emby and Jellyfin servers at once, and it merges their content.

**Main side.**

- `ConnectionManager` keeps one session per `serverId`. Each session has its own `ApiClient`, user, WebSocket and status (`connecting`, `server-selected`, `signed-in`, `offline`).
- The **primary server** (`activeId` in `servers.json`) answers every call made without a `serverId`: jump list, `wicaby://item/<id>`, older routes.
- `SessionState.status/server/user` describe the primary server; `sessions[]` lists them all. The global status is `signed-in` as soon as any session is.
- At startup, every saved session resumes in parallel. A server that is off goes `offline` without blocking the others.
- Tokens stay in the vault, one per server.
- **Addressing.** Each server keeps several addresses: last, manual, local and remote. `probeServer()` races them. When a VPN is connected, it also races the overlay address of a matching peer (same name or known host, or an endpoint equal to the server's LAN IP), 600 ms later, and accepts it only if the same server id answers.

**Addressing in calls.** Everything server-specific takes a `serverId`:

- IPC parameters;
- `wicaby-media://api/<serverId>/…`;
- `PlayRequest.serverId`. The queue, reporting, markers and next episode stay on that server, and a remote `Play` command plays on the server that sent it.

**Renderer side.**

- **Item identity.** `lib/api.ts` stamps `ServerId` on every item. Identity is `itemKey(item) = <serverId>:<itemId>`, and routes are `/item/<serverId>/<itemId>`, `/library/<serverId>/<id>` and `/read/<serverId>/<id>`.
- **Home rows.** "Continue", "Next Up" and "Favourites" merge every server and sort by last played. "Latest" keeps one row per library.
- **Search and favourites** query all servers in parallel.
- **Sidebar.** Libraries are grouped by server once more than one is connected.
- **Duplicates.** A title found on several servers (same Imdb, Tmdb or Tvdb id) appears once, and its page offers "Available on N servers".

## Administration

Admins get a server dashboard without leaving the app. The entry appears in the sidebar when a signed-in session's user `isAdmin` and the app is online. `routes/Admin.svelte` lets you pick among the servers where you are an admin.

- **Sections** (`renderer/admin/sections.ts`, one lazy-loaded component each): Dashboard, Activity, Users, Devices, Libraries, Scheduled tasks, Transcoding, Server settings, Plugins, API keys and Logs. A section whose file does not exist is not listed.
- **Item tools** (`admin/item/`): metadata editor, identify, images (upload or remote, through `api.uploadImage`: JPEG, PNG, WebP or GIF, 20 MB at most), subtitles search, refresh and delete.
- **API.** All admin traffic goes through the `api` proxy. `PUT` is only there for a few Jellyfin configuration routes.
- **Testing.** The mocks in `tools/mock-server/mock-admin/*.mjs` extend `mock-emby.mjs` and `mock-jellyfin.mjs` with the admin endpoints. `MOCK_PENDING_RESTART=1` makes `/System/Info` report a restart required (an update is always offered), for the background alerts below.

## History and Windows integration

- **History** (`routes/History.svelte`, account menu → History). Recently played movies and episodes from every signed-in server (`SortBy=DatePlayed`, Emby and Jellyfin alike), grouped by day, with hours watched this week and this month and the top genres (`shared/history.ts`).
- **Continue watching** (`main/features/continue-watching.ts`). The top 5 resume items across servers appear in a "Continue watching" group of the taskbar jump list and in the tray menu; each opens its item through the `--wicaby-nav` argument. The list is refreshed (debounced 3 s) on sign-in or sign-out, on a server's `UserDataChanged` and at the end of a playback. An entry removed from the jump list by the user is not put back during the session, since Windows would hide the whole group.
- **Admin alerts** (`main/features/admin-alerts.ts`, `shared/admin-alerts.ts`). For servers where the user is an admin, Wicaby reads `GET /System/Info` and `GET /ScheduledTasks` (same routes on Emby and Jellyfin) one minute after startup and then every 15 minutes, and shows a tray notification for a failed scheduled task, a restart required or an update available. The poll is skipped while the main window is visible and focused; a route the server refuses or lacks gives no alert. Each alert is shown once (`admin-alerts.json`). Setting: Windows → `windows.notifyAdmin`.
- **Toast buttons.** A new-episode toast for a single episode has Play and Mark watched buttons, run against the server that announced it.

## Torrents

An optional qBittorrent panel uses the Web API v2 (`main/torrents/`):

- **Configuration.** `settings.torrents.url` and `username`. The password lives in the vault. An empty URL means no polling at all.
- **Polling.** Incremental `/sync/maindata`, every 1.5 s while the list is on screen (`fg`), every 10 s in the background (`bg`, only when completion features need it), and not at all otherwise (`off`).
- **Self-signed HTTPS.** The certificate is shown and, once accepted, pinned by fingerprint per host (`torrents.json`).
- **Away from home.** Each connect calls `ensureRoute` (api-client.ts), as media servers do: direct first, then the embedded mesh forwarder for a peer or a host in a NetBird routed network that does not answer within 1.5 s. The CSRF headers keep the configured origin: the forwarder sends qBittorrent that Host. The WebDAV backend uses the same path for listings and the playback relay. The test result carries `via` (direct/mesh) or the failed `path`.
- **Categories → libraries.** `libraryMap` links a qBittorrent category to a library on a given server. When a torrent completes, Wicaby can notify, ask the server to scan, and look for the new item (after 15 s, 45 s, 2 min, 5 min and 10 min) to offer "Available in <library>".
- **Adding.** Magnet links and `.torrent` files are accepted. Wicaby can register as the Windows `magnet:` handler (`magnetHandler`); the link reaches the running instance through `second-instance`. A magnet on the clipboard is offered too.

## Trakt scrobbling

Wicaby can scrobble what it plays to [Trakt](https://trakt.tv) itself, for servers that don't run the Trakt plugin (`main/features/trakt.ts`, `trakt-client.ts`; Settings → Accounts).

- **Your own Trakt app.** Trakt only accepts registered applications, and Wicaby ships no shared key. Create one at <https://trakt.tv/oauth/applications/new>: any name, **Redirect URI** `urn:ietf:wg:oauth:2.0:oob`, and the `/scrobble` permission ticked. Paste its **Client ID** and **Client Secret** in Settings → Accounts → Trakt, then press Connect.
- **Device code.** Wicaby shows a code; open `trakt.tv/activate`, sign in and enter it. Wicaby polls `/oauth/device/token` at the interval Trakt gives and stores the tokens; it refreshes them before they expire and asks you to connect again if Trakt revokes them. Disconnect revokes the token.
- **Storage.** The client secret, access and refresh tokens are in the DPAPI vault (`trakt:account`), never in `settings.json`, and never logged.
- **Scrobbles.** The playback reports (`PlaybackService`, event `report`) map to `/scrobble/start` (play, unpause), `/scrobble/pause` and `/scrobble/stop`, with the progress in percent (Trakt marks the item watched from 80 %). Only movies and episodes with an IMDb, TMDB or TVDB id are sent; trailers and Live TV never are.
- **Server plugin.** For an admin, Wicaby reads `GET /Plugins` (Emby and Jellyfin): a server with an active Trakt plugin is skipped and the pane says why. Without admin rights the plugin list is unreadable, so each server has a switch (`settings.trakt.offServers`).
- **Testing.** `node tools/mock-server/mock-trakt.mjs 8940` and `WICABY_TRAKT_URL=http://127.0.0.1:8940` on an unpackaged build (a packaged build ignores the variable). The mock approves a device code after two polls; `GET /mock/state` lists the scrobbles. `node tools/checks/trakt-check.mjs` runs the flow headlessly.

## Music scrobbling

Wicaby can scrobble the music it plays, from any source, to ListenBrainz and Last.fm (`main/features/scrobble.ts`, `scrobble-client.ts`; Settings → Music → Scrobbling). Both are off until connected; a server that already scrobbles (plugin, Navidrome) would count every play twice.

- **ListenBrainz.** Paste the user token from <https://listenbrainz.org/settings/>; it is checked with `GET /1/validate-token`.
- **Last.fm.** Wicaby has no registered key: create an API account at <https://www.last.fm/api/account/create> and enter its API key and shared secret under Advanced. Connect calls `auth.getToken`, opens `last.fm/api/auth`, and polls `auth.getSession` until you allow it (10 min at most). Calls are signed (`api_sig`, md5) as the Last.fm docs say.
- **Rule.** Playing now on a track's start (`playing_now`, `track.updateNowPlaying`); one listen at its stop once it was heard for 4 min or half its length, tracks of 30 s or more. Heard time is playback only: seeks and pauses add nothing.
- **Offline queue.** A listen that fails for a reason worth retrying (network, 429, 5xx, Last.fm 8/11/16/29, a refused token) waits in `scrobble-queue.json` (500 at most, oldest dropped) and is sent again after the next listen that goes through, every 15 min, and 30 s after start-up. Disconnecting a service drops its waiting listens.
- **Storage.** The token, secret and session key are in the vault (`scrobble:listenbrainz`, `scrobble:lastfm`), never logged. `node tools/checks/scrobble-check.mjs` runs the rule, payloads, signature, web auth and queue headlessly.

## i18n

French is the reference language and the fallback; English is the other one. `ui.language` (`auto`, `fr` or `en`) defaults to `auto`, which follows Windows: `fr-*` gives French, anything else English. A change applies live in both processes. The full conventions are in [i18n.md](i18n.md).

- **Catalogues:** `src/renderer/locales/{fr,en}/<namespace>.json`. Nested keys are flattened to `namespace.a.b`.
- **Format:** `src/shared/i18n-core.ts` parses an ICU-lite format (`{name}`, `plural` with `#`, `select`).
- **Renderer:** `lib/i18n.svelte.ts` provides `t`, `tParts`, `has` and `fmt` (`Intl`-based numbers, dates, bytes, durations and lists).
- **Main:** `main/i18n.ts` bundles the `common`, `errors` and `main` namespaces, for the tray, taskbar, notifications, dialogs and errors.
- **Check:** `node tools/checks/i18n-check.mjs --strict` (in `npm run checks`) checks catalogue parity, unknown keys and hard-coded French.

## Settings and storage

`core/settings.ts` holds the typed `Settings` (see `contract.ts`) with its defaults. Every update is deep-merged and then sanitised: numbers are clamped and unknown enum values fall back to the default. The result is persisted through `JsonStore`, which coalesces writes and writes to a temp file before renaming it, so a crash never leaves half a file. The settings page (`routes/Settings.svelte`) has these sections:

- General (language, window, notifications, setup assistant), Appearance, and Home & libraries;
- Playback, Video, Audio, Subtitles, Music and Casting;
- Accounts (servers and Trakt), Sources (files, photos, Immich, photo map), Remote access, and Downloads (with torrents);
- Keyboard and System (storage, logs, performance, settings backup);
- About.

Old pane ids still open through `/settings?pane=`: `torrents` → downloads, `windows` → general, `accounts` → server, `advanced` → privacy (System).

Settings can be exported, imported and reset. `system.hardwareAcceleration` is read straight from `settings.json` before `ready`, because Chromium's GPU switches must be set before startup.

Files under `%APPDATA%\Wicaby` (`app.getPath('userData')`):

| File | Content |
|---|---|
| `settings.json` | settings |
| `servers.json` | known servers, addresses, primary and active sessions |
| `vault.bin` | DPAPI-encrypted (`safeStorage`) tokens, the qBittorrent password, a pending mesh auth key, the Trakt client secret and tokens |
| `device.json` | the DeviceId sent to servers |
| `downloads.json` | download queue and offline progress |
| `torrents.json` | pinned certificates, available items |
| `admin-alerts.json` | admin alerts already shown (failed task, restart, update) |
| `mesh/` | embedded node prefs and state ([mesh.md](mesh.md)) |
| `mpv/mpv.conf` | optional user mpv config |
| `cache/comics/` | CBZ cache (size from `system.comicCacheGb`) |
| `logs/` | one `wicaby-<date>.log` per day, the last 7 kept |
| `hdr-restore.json` | Windows HDR state to restore after a crash |

## Build and packaging

**Requirements:**

- Windows 10/11 x64;
- Node.js 24 (the `.nvmrc` version; 22.12 or later also works) with npm;
- PowerShell 5.1 for the helper scripts;
- Go, only to build the mesh helper.

The repo root is an npm workspace (`apps/desktop`), so run npm from the root:

```sh
npm ci
npm run fetch-mpv     # pinned shinchiro mpv build (x86-64-v3, AVX2), SHA-256 checked, into vendor/mpv
# for CPUs without AVX2, run the script directly (npm does not forward -Generic):
#   powershell -File apps/desktop/scripts/fetch-mpv.ps1 -Generic
npm run build:mesh    # optional: vendor/vpn-helper/wicaby-mesh.exe (needs Go)

npm run dev           # Vite (HMR) + esbuild watch; Electron restarts when main changes
npm run check         # svelte-check + tsc on the main/preload config
npm run checks        # every self-check in tools/checks (run-all.mjs, 14 of them)
npm run build         # vite build (renderer) + esbuild (main, preload) + licence folder into apps/desktop/out/
npm run dist          # build + electron-builder --win: NSIS installer and portable exe
npm run dist:portable # build + portable exe only
```

- **Dev runs:** `npm run dev -- <electron args>` passes arguments to Electron, for example `--user-data-dir=<tmp>` to keep a test profile apart, or `--remote-debugging-port=<n>` for `scripts/cdp.mjs`. `WICABY_DEV_PORT` pins the Vite port, so several dev instances can run side by side.
- **Main bundle:** `scripts/build-main.mjs` bundles `src/main/index.ts` and `src/preload/index.ts` to CommonJS (`out/main/index.cjs`, `out/preload/index.cjs`) for Node 24 (Electron 44's Node). Sandboxed preloads can only `require('electron')`, so everything else is inlined.
- **Linux addon:** on Linux, `npm run build` first runs `npm run build:native` (`scripts/build-native.mjs`: node-gyp on `native/mpv-render`, with Node's own headers when they sit next to the binary), and `build-main.mjs` copies `wicaby_mpv.node` to `out/native/`. It needs a C++17 compiler, make, python3, pkg-config and the EGL, GLESv2 and GBM headers ([CONTRIBUTING.md](../CONTRIBUTING.md#desktop-on-linux)); a failed build fails `npm run build`, and `WICABY_SKIP_NATIVE=1` builds without the addon. Release binaries come from a pinned `ubuntu-24.04` runner and link libstdc++ and libgcc statically (`-static-libstdc++ -static-libgcc` in `binding.gyp`), so they need neither a newer glibc than Ubuntu 24.04's nor the runner's `GLIBCXX` version; `native-addon-check.mjs --require` fails when libstdc++ or libgcc_s is a `NEEDED` entry. The libffmpeg symbol rebind (`ffmpeg_rebind.cc`) only does anything inside Electron, which ships its own `libffmpeg.so`; CI runs the check under plain Node (no Electron, no libmpv on the runner), so the rebind and libmpv past `dlopen` are only exercised by the manual `native/mpv-render/test` scripts and real runs. `npm run dev` does not rebuild the addon: run `npm run build:native` after changing it. On Windows the script exits at once.
- **Mock servers:** never test against a real server. Use `node tools/mock-server/mock-emby.mjs 8096 [silent.mkv]` (user `Wika`, password `wicaby`), `mock-jellyfin.mjs` or `mock-qbittorrent.mjs`.

**Packaging** (`electron-builder.yml`):

- Output goes to `release/` at the repo root: `Wicaby-<version>-x64.exe` (NSIS, per-user, installation folder can be changed) and `Wicaby-<version>-portable.exe`. The version comes from `apps/desktop/package.json`.
- `extraResources` copies `out/licenses` (staged by `tools/release/licenses.mjs` at the end of `npm run build`: `LICENSE.txt`, `THIRD_PARTY_NOTICES.md`, the GPL-2.0 and LGPL-2.1 texts and `npm-licenses.txt`, the licences of the imported npm packages read from `node_modules`) to `resources/licenses`, `vendor/mpv` to `resources/mpv` (without `d3dcompiler_43.dll`, `doc/`, `installer/`, `updater.bat` and `mpv-*register.bat`) and `vendor/vpn-helper` to `resources/vpn-helper`. The mpv and helper folders are bundled only when they were filled beforehand. Without mpv the app uses the HTML player, and without the helper it offers no embedded mesh.
- The app is packaged as asar, registers the `wicaby://` protocol, and uses `com.wika.wicaby` as its appId and AppUserModelID.
- The desktop app has no auto-updater. New versions are downloaded from the `wicaby-releases` page ([release.md](release.md)).
- The executables are not code-signed, so Windows SmartScreen may warn on first launch.
