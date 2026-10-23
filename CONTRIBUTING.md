# Contributing to Wicaby

Thanks for helping. This guide covers the toolchain, the repository layout, the mock servers,
the checks that must pass, and the rules for translations, design and commits.

Wicaby is licensed under the [GNU GPL v3.0 or later](LICENSE) (`GPL-3.0-or-later`). By sending a change you agree that it is
distributed under that licence, together with the section 7 additional permission for Google Play
services in [LICENSE-EXCEPTION.md](LICENSE-EXCEPTION.md), which the Android `gplay` flavour needs.

## Ground rules

- **Test against mocks, not other people's servers.** Never point a test or a script at a
  server, TV or device you do not own. The mock servers in `tools/mock-server/` cover sign-in,
  browsing, playback reporting, admin, Live TV, comics and qBittorrent.
- **Keep automated tests silent.** Use a silent sample file, or run mpv with `--ao=null`, when a
  test really plays media.
- **Never commit secrets** (see [Secrets and local files](#secrets-and-local-files)).
- Report security problems privately, as described in [SECURITY.md](SECURITY.md), not in an
  issue or a pull request.

## Prerequisites

| Tool | Version | Needed for |
|---|---|---|
| Windows 10 or 11 (x64) | | the desktop app, and the PowerShell build scripts |
| [Node.js](https://nodejs.org/) | the version in [`.nvmrc`](.nvmrc) (22) | desktop app, mocks, checks, release tools |
| Windows PowerShell 5.1 or PowerShell 7 | | `npm run fetch-mpv`, `npm run build:mesh`, `npm run build:mesh-aar` |
| [Go](https://go.dev/dl/) | the `go` line in `packages/mesh/go.mod` (Go downloads that toolchain if yours is older) | the mesh helper and the Android mesh library |
| JDK | 21 (17 is the minimum) | Android builds |
| Android SDK | platform 37, build-tools, and NDK `28.2.13676358` | Android apps and the mesh AAR |
| gomobile and gobind | from `golang.org/x/mobile` | the Android mesh AAR |

[fnm](https://github.com/Schniz/fnm) reads `.nvmrc`, so `fnm use` picks the right Node version.
[nvm-windows](https://github.com/coreybutler/nvm-windows) does not read `.nvmrc`; run
`nvm install 22` and then `nvm use 22`. Go installs with
`winget install -e --id GoLang.Go`. Android Studio installs the JDK and SDK; add the NDK with
`sdkmanager --install "ndk/28.2.13676358"`.

## Repository layout

```
wicaby/
├─ apps/
│  ├─ desktop/        Electron + Svelte 5 app for Windows (src/main, src/preload, src/renderer, src/shared)
│  ├─ android/        Gradle root: :core (shared, no UI), :mesh-ui, :livetv-ui, :tv (Android TV), :mobile
│  ├─ tv-web/         Svelte 5 app for Samsung Tizen and LG webOS TVs (docs/tv-web.md)
│  └─ mobile-web/     Svelte 5 installable web app for iPhone (docs/mobile-web.md)
├─ packages/
│  └─ mesh/           Go mesh helper: Tailscale tsnet + NetBird client/embed; scripts/build-*.ps1
├─ tools/
│  ├─ mock-server/    mock Emby, Jellyfin and qBittorrent servers
│  ├─ checks/         self-checks, run together by `npm run checks`
│  └─ release/        make-update-manifest.mjs (update.json for the Android updater)
├─ brand/             logo masters, Android icons, scripts/make-brand.mjs
├─ docs/              architecture.md, design.md, i18n.md, android.md, screenshots/
├─ vendor/            not in git: mpv/, vpn-helper/, android/wicaby-mesh.aar
└─ release/           not in git: installers and APKs
```

## Setup

### Desktop

```powershell
git clone https://github.com/WicaebethTheo/wicaby.git
cd wicaby
npm ci                   # installs the npm workspaces (apps/desktop) from the root lockfile
npm run fetch-mpv        # downloads the pinned shinchiro mpv build (x86-64-v3) into vendor/mpv
npm run build:mesh       # optional: builds vendor/vpn-helper/wicaby-mesh.exe (needs Go)
npm run dev              # Vite with HMR + esbuild in watch mode + Electron
```

On a CPU without AVX2 (x86-64-v3), fetch the generic build instead. The npm script cannot pass
the switch through, so call the script directly:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File apps/desktop/scripts/fetch-mpv.ps1 -Generic
```

Other root scripts: `npm run build`, `npm start` (runs the last build), `npm run dist` (NSIS
installer and portable build in `release/`), `npm run dist:portable` and `npm run icon`.

To keep your everyday profile out of development, give each dev instance its own profile and
port:

```powershell
$env:WICABY_DEV_PORT = '5180'
npm run dev -- --user-data-dir=.dev/ud-mytest
```

`WICABY_DEVTOOLS=1` enables DevTools in a production build.

### Android

The Android apps link the embedded mesh library, so build it once before the first Gradle build:

```powershell
go install golang.org/x/mobile/cmd/gomobile@latest
go install golang.org/x/mobile/cmd/gobind@latest
gomobile init
npm run build:mesh-aar   # vendor/android/wicaby-mesh.aar (arm64-v8a + armeabi-v7a)
```

For an x86_64 emulator, build the AAR with the `-Emulator` switch instead (calling the `.ps1`
directly fails under the default execution policy):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File packages/mesh/scripts/build-mesh-aar.ps1 -Emulator
```

Then open `apps/android` in Android Studio, or build from the command line:

```powershell
cd apps/android
.\gradlew.bat :tv:assembleDebug :mobile:assembleDebug
```

Android Studio writes `apps/android/local.properties` (`sdk.dir=…`). Without
`apps/android/keystore.properties`, release builds are produced unsigned. More details, including
installing on a device and the update manifest, are in [`apps/android/README.md`](apps/android/README.md).

### Mesh

```powershell
cd packages/mesh
go test ./...
```

`npm run build:mesh` and `npm run build:mesh-aar` run the forwarder tests, build the binary,
collect every linked module's licence into `THIRD_PARTY_LICENSES.txt`, and fail if an AGPL
NetBird package (`management/`, `signal/`, `relay/`, `combined/`) gets linked. Do not weaken
that guard.

## Mock servers

All mocks keep their state in memory; restarting one resets it. The Emby and Jellyfin mocks
listen on every interface, so the Android emulator reaches them at `http://10.0.2.2:<port>`; the
qBittorrent mock listens on `127.0.0.1` only.

| Command | Default port | Sign-in |
|---|---|---|
| `node tools/mock-server/mock-emby.mjs [port] [video-file]` | 8096 | user `Wika`, password `wicaby` |
| `node tools/mock-server/mock-jellyfin.mjs [port] [video-file]` | 8096 | user `Wika`, password `wicaby`, or Quick Connect |
| `node tools/mock-server/mock-qbittorrent.mjs [port]` | 8250 | `admin` / `adminadmin` |

The Emby and Jellyfin mocks share the same default port: give one of them another port when you
run both. In Wicaby, add the server by address, for example `http://127.0.0.1:8096`.

- **mock-emby** speaks the `/emby` prefix and `X-Emby-Token` auth, and serves the admin
  endpoints from `tools/mock-server/mock-admin/`. Pass a video file (ideally a silent one) to
  make streams play; without it, stream requests answer 404 and only the browsing and reporting
  flows work.
- **mock-jellyfin** behaves like a default Jellyfin 12: legacy auth schemes, legacy routes and
  Emby-only routes are rejected, and every rejected or unknown call is logged with a
  `LEGACY` / `EMBY-ONLY` / `UNMAPPED` tag, so a run's log doubles as a bug list. Mock-only
  helpers: `GET /Mock/State`, `POST /Mock/Broadcast`, `POST /Mock/QuickConnect/Approve?code=…`.
- **mock-qbittorrent** simulates the qBittorrent Web API v2; nothing is downloaded.
  `GET /mock/expire` drops every session to test re-login.

Environment variables:

| Variable | Mock | Effect |
|---|---|---|
| `MOCK_SERVER_ID`, `MOCK_NAME` | Emby, Jellyfin | Server id and name, so several mocks can run side by side as distinct servers (multi-server tests). |
| `MOCK_DURATION_S` | Emby, Jellyfin | Length of the test video in seconds, so intro/credits markers and trickplay fall inside it. |
| `MOCK_SKIP_MODE` | Emby | The user's `IntroSkipMode` (default `ShowButton`). |
| `MOCK_PGS=1` | Emby (demo dataset) | The films' second subtitle track is a Blu-ray PGS track (the phone web app's PGS check). |
| `MOCK_MUSIC=1` | Emby, Jellyfin | The music library of `tools/mock-server/music-fixture.mjs` (on by default with `MOCK_DATASET=demo`). Every track streams as generated silence. |
| `MOCK_MUSIC_SCALE=big` | Emby, Jellyfin | 1,000 more songs (metadata only) for scroll tests. |
| `MOCK_ADMIN_FLAVOR=jellyfin` | Emby (admin) | Jellyfin-shaped transcoding configuration and plugin list. |
| `MOCK_QBIT_VERSION` | qBittorrent | `4.6.7` speaks the 4.x API (pause/resume); the default `5.0.4` speaks API 2.11 (stop/start). |
| `MOCK_QBIT_NOQUEUE=1` | qBittorrent | Answers 409 to priority changes, like qBittorrent with queueing off. |
| `MOCK_QBIT_TLS=<dir>` | qBittorrent | Serves HTTPS with `key.pem` and `cert.pem` from that folder (self-signed certificate flow). |

Example, two servers at once in PowerShell. Each mock stays in the foreground, so run them in
two terminals:

```powershell
# terminal 1
$env:MOCK_NAME = 'Emby A'; node tools/mock-server/mock-emby.mjs 8301
# terminal 2
$env:MOCK_NAME = 'Jellyfin B'; node tools/mock-server/mock-jellyfin.mjs 8302
```

The two mocks already have different default server ids. Set `MOCK_SERVER_ID` only when you run
two copies of the same mock.

## Checks

Run these before opening a pull request.

| Command | What it checks |
|---|---|
| `npm run check` | `svelte-check` on the renderer and `tsc` on the main process (`apps/desktop`), and on the TV and phone web apps with their strings checks (`apps/tv-web`, `apps/mobile-web`). |
| `npm run checks` | Every self-check in `tools/checks` (`run-all.mjs`): `i18n-check --strict`, HDR, track selection, ZIP, BIF, mesh, VPN, torrents, and the TV and phone web apps. |
| `npm run build:tv`, then `node apps/tv-web/scripts/smoke.mjs --engine 53` | The TV web app's build, run on the oldest TV engine (see [docs/tv-web.md](docs/tv-web.md)). |
| `npm run build:mobile`, then `node apps/mobile-web/scripts/player-check.mjs` | The phone web app's build, and its player end to end in Chromium (see [docs/mobile-web.md](docs/mobile-web.md)). |
| `npm run build` | The desktop renderer, main process and preload build. |
| `.\gradlew.bat :core:testDebugUnitTest :mobile:testFossDebugUnitTest :mobile:testGplayDebugUnitTest lint` (in `apps/android`) | Android unit tests (including the translation-parity tests) and lint. |
| `go test ./...` (in `packages/mesh`) | Mesh helper tests, including the forwarder allow-list. |

## Translations (i18n)

Wicaby ships in **French and English**, and every user-facing string must exist in both. Read
[docs/i18n.md](docs/i18n.md) before touching UI text; it holds the API, the writing rules, the
style guide and the FR → EN glossary.

- **Desktop:** strings live in `apps/desktop/src/renderer/locales/{fr,en}/<namespace>.json`.
  Use `t()` / `tParts()` in the renderer and `t()` in the main process. No concatenated
  sentences, the same placeholders in both languages, plurals through ICU-lite, and no HTML in
  catalogues.
- `node tools/checks/i18n-check.mjs --strict` (part of `npm run checks`) must pass: same keys in
  both languages, no empty values, matching placeholders, valid plurals, no unknown keys, and no
  hard-coded French left in `.svelte` / `.ts` files. Mark a deliberate literal with
  `// i18n-ignore`.
- **Android:** French is the default (`res/values`) and English is `res/values-en`, in `:core`,
  `:mesh-ui`, `:livetv-ui`, `:tv` and `:mobile`. Lint treats `MissingTranslation` as an error, and the
  translation-parity unit tests must pass.
- **TV web app:** it has no catalogue of its own; it reads the Android TV app's (`:tv`, `:core`, `:livetv-ui`) at
  build time. A new string goes into those Android files, and `npm run check:tv` fails on a key they lack.
- **Phone web app:** it reads the same catalogues plus `:mobile`'s; the few words only the web app says go into
  `apps/mobile-web/res/values` and `res/values-en` as `web_*` keys, in the Android format. `npm run check:mobile`
  fails on a key no catalogue has, and on a `res` key missing in one language or with other placeholders.
- Server data (titles, overviews, genres, names) is never translated.
- A new term goes into the glossary in `docs/i18n.md` in the same change.

## Design

The desktop and Android apps follow the **Graphite** design system in
[docs/design.md](docs/design.md). In short:

- Content first: neutral, translucent chrome; artwork carries the colour. One accent colour,
  used only for primary actions, selection, progress and focus.
- Use the tokens in `apps/desktop/src/renderer/app.css` (colours, materials, radii, shadows,
  durations, easing) rather than raw values. The Android apps mirror them in Compose.
- Geist and Geist Mono only; sentence case; never all-caps headlines.
- Animate only `transform`, `opacity` and `filter`, with the duration tokens (they respect
  reduced motion).
- Icons: Lucide through `components/Icon.svelte`, monochrome and static. No coloured squares
  behind icons, no accent-coloured icons in navigation or lists, no wiggle or bounce.
- Every interactive element must be reachable with the arrow keys (spatial navigation), and on
  Android TV with the D-pad.

Attach before/after screenshots to any pull request that changes the UI, taken against a mock
server.

## Commit style

Follow the existing history (`git log`):

- **Subject:** one line, imperative mood, capitalised, no trailing period, about 72 characters
  at most. Prefix it with the area when that helps: `Android: …`, `Player: …`, `Settings: …`,
  `Mesh: …`. Examples from the history:
  - `Add CBZ comic reader`
  - `Fix title-bar search: the search page follows ?q= without remounting`
  - `Android: English/French, comic reader on TV and mobile, IME-safe text entry`
- **Body:** wrapped at 72 columns. Explain *why* and anything non-obvious (root cause,
  trade-offs, licences, compatibility). Lists are fine.
- One logical change per commit. Moves (`git mv`) go in their own commit, separate from edits,
  so history follows the files.
- Keep the checks green on every commit.
- Add a line to the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md) for user-visible changes.

## Secrets and local files

Never commit:

- the Android signing keystore (`*.jks`, `*.keystore`, `apps/android/keystore*`) or
  `apps/android/keystore.properties`;
- `local.properties` (`apps/android/local.properties`, `packages/mesh/android/sample/local.properties`);
- the desktop credential vault, settings or logs from a user-data folder;
- mesh auth keys, server tokens, qBittorrent passwords, or real server addresses and user names
  in fixtures (use documentation ranges such as `192.0.2.x`);
- anything under `vendor/`, `release/`, `.dev/` or build outputs.

`.gitignore` covers these paths. Check `git status` and `git diff --cached` before committing.
If a secret ever lands in a commit, do not just delete it in a follow-up commit: tell the
maintainer, rotate the secret, and the history will be rewritten.
