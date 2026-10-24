# Releasing Wicaby

Wicaby uses two GitHub repositories:

| Repository | Visibility | Holds |
|---|---|---|
| `WicaebethTheo/wicaby` | public | the code, CI, the release workflow, and today the releases (see below) |
| `WicaebethTheo/wicaby-releases` | public | release assets only: installers, APKs, `update.json`, and the source archive and licence texts |

The binaries live in a public repo so that the Android apps can download `update.json` and the APKs **without a token**. Releases are published today on the public code repo itself, `WicaebethTheo/wicaby`, and the apps read from there:

- **Android**: the default update URL (`UpdateLogic.DEFAULT_URL` in `core/update/Updates.kt`) is `https://github.com/WicaebethTheo/wicaby/releases/latest/download/update.json`. Settings → About → "Update URL" overrides it; an empty field means the default. Without an `update.json` asset on the latest release, the apps find nothing (silently).
- **Desktop**: `main/features/app-updates.ts` reads `https://api.github.com/repos/WicaebethTheo/wicaby/releases/latest` (`shared/app-update.ts`) about 30 s after start and every 24 h, and shows "Wicaby X.Y.Z is available" with links to the release page and to the installer for this kind of install (`Wicaby-X.Y.Z-x64.exe`, `Wicaby-X.Y.Z-portable.exe`, then a Linux `.AppImage` or `.deb` named `Wicaby-…`). It only opens assets under `https://github.com/WicaebethTheo/wicaby/releases/download/<tag>/`, so keep the asset names and the repository. To see the notice in a development build, start it with `WICABY_FAKE_VERSION=0.1.0` (ignored by packaged builds).

If releases move to another repository (for example `wicaby-releases` below), change both defaults.

The release workflow only publishes there once the `RELEASES_REPO` [variable](#variables) and the `RELEASES_TOKEN` [secret](#secrets) are both set. Until then it publishes to the Releases of the private code repo, where the assets need a GitHub login: fine for archiving and testing, but the apps' updater cannot read that `update.json`. See [Where a release goes](#where-a-release-goes).

## Before first publish

Before the first public release:

- [ ] Delete the `MAINTAINER NOTE` comments at the top of `CHANGELOG.md`, `SECURITY.md` and `THIRD_PARTY_NOTICES.md` once their items are done.
- [ ] Turn on private vulnerability reporting on `WicaebethTheo/wicaby-releases` (see the note in `SECURITY.md`).
- [ ] Do the [one-time setup](#one-time-setup) below.

## One-time setup

1. Create `WicaebethTheo/wicaby-releases` as a **public** repository and give it at least one commit (a `README.md` is enough). Release tags are created on its default branch, so both the workflow and a manual `gh release create` fail on an empty repository.
2. Set the secrets listed under [Secrets](#secrets) on the code repository, and the `APK_CERT_SHA256` and `RELEASES_REPO` [variables](#variables).

## Cutting a release

1. **Bump the Android versions** that changed:
   - Android TV: `versionCode` (+1) and `versionName` in `apps/android/tv/build.gradle.kts`.
   - Android mobile: `versionCode` (+1) and `versionName` in `apps/android/mobile/build.gradle.kts`.

   The in-app updater only offers an APK whose `versionCode` is higher than the installed one. Forget the bump, and nobody gets the update. The APK names carry each app's own `versionName`.

   The **desktop** version needs no bump for CI: the workflow stamps it from the tag (`v0.2.0` → `0.2.0`, through `npm version … --workspace apps/desktop`), so the tag names the installers. Bump `version` in `apps/desktop/package.json` only for local or manual builds, or to keep the committed number in step.
2. **Write the notes.** Add a `## [0.2.0]` section to `CHANGELOG.md` (Keep a Changelog format). The workflow uses that section twice: as the body of the GitHub release, and as the English in-app notes (`notes.en`) of both apps in `update.json`. `CHANGELOG.md` is English only; a French UI falls back to `notes.en`. Without a matching section, the release body is just "Wicaby v0.2.0", and an app whose `versionCode` changed ships with empty in-app notes (the workflow prints a warning).
3. **Commit, then tag and push:**

   ```sh
   git tag v0.2.0
   git push origin main v0.2.0
   ```

Any tag matching `v*` triggers `.github/workflows/release.yml`, but its first job refuses the release unless the tag has the form `vX.Y.Z` or `vX.Y.Z-<prerelease>` and points at a commit that is on `main` and whose CI run is green (see [`preflight`](#preflight-on-ubuntu-latest)). Keep the Android `versionName`s numeric (`0.5.0`, not `0.5.0-beta`): the manifest script only reads numeric names, so the `android` job fails on any other one. A tag containing `-` (for example `v0.2.0-beta.1`) becomes a **prerelease** on `wicaby-releases` and is never marked "latest", so `releases/latest/download/update.json` keeps serving the last stable release and installed apps do not see it.

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main`, on every pull request and by hand (`workflow_dispatch`). The repo is private, so every minute counts against the account quota, each job is billed rounded up to the minute, and Windows minutes count double. The workflow is shaped by that:

| Job | Runner | Runs when | Does |
|---|---|---|---|
| Changes + repo checks | `ubuntu-latest`, 5 min | always | `privacy-check.mjs` (generic patterns: the local `.dev/` file never exists on CI), `links-check.mjs`, `actionlint` (checksum-verified release binary, with `shellcheck`), and the path filters below |
| Desktop / Linux | `ubuntu-latest`, 30 min | any code change (`apps/`, `packages/`, `tools/`, `brand/`, npm files, workflows, and the root READMEs, `CHANGELOG.md`, `CONTRIBUTING.md`, notices and licences that the self-checks read) | `npm ci`, `npm run check`, `npm run checks`, `npm run build`, the Linux mesh helper, AppImage + deb (3-day artifact) |
| Desktop / Windows | `windows-latest`, 30 min | pushes to `main` that touch the desktop; pull requests only when a Windows-specific file changed (`*.ps1`, `*.bat`, `*.cmd`, `apps/desktop/electron-builder.yml`, `apps/desktop/build/`, `ci.yml`) | `npm ci`, `npm run checks`, `npm run build` (the type-check is the same as on Linux) |
| Mesh helper (Go) | `ubuntu-latest`, 20 min | `packages/mesh/` changed | `go test -race ./...`, the AGPL guard on both build graphs |
| Android | `ubuntu-latest`, 60 min | `apps/android/`, `packages/mesh/` or `flavour-check.mjs` changed | the mesh AAR (cached by its sources), unit tests of both flavours, debug builds, lint, `flavour-check.mjs --gradle` |

A change to `ci.yml` runs every job. A change limited to `docs/`, `SECURITY.md` or the GitHub templates runs only the first job. A manual run runs every job. A new push to the same branch or pull request cancels the run in progress, on `main` too: before tagging an older commit whose run was cancelled, re-run it.

Caches: npm (`actions/setup-node`), Go modules and build cache (`actions/setup-go`), Gradle (`gradle/actions/setup-gradle`, written on `main` only, read by pull requests) and the mesh AAR (`actions/cache`). `release.yml` restores no Go or Gradle cache (npm only): a release is built from clean caches. The workflow token is `contents: read`; only the first job adds `pull-requests: read`, which the path filter needs to list a pull request's files.

No CodeQL: code scanning on a private repository needs the paid GitHub Code Security add-on, and its Kotlin and JavaScript analysis would add a long job to every run. The self-checks, the AGPL guard and the pinned actions cover the risks that matter here.

To check the workflows before a push: `go run github.com/rhysd/actionlint/cmd/actionlint@v1.7.12` at the repo root (with `shellcheck` on `PATH` for the `run:` scripts).

### Dependency updates

`.github/dependabot.yml` opens at most one grouped minor + patch pull request per ecosystem (npm, Gradle, Go modules, GitHub Actions) each month, with a small cap on open pull requests. Majors that need a code migration are ignored and done by hand:

- `typescript`: a new major changes the compiler behind `svelte-check` and `tsc`;
- `@types/node`: must follow the Node major bundled with Electron, not the newest Node; move it when Electron moves;
- `@electron/fuses`: a major changes the API `apps/desktop/build/afterPack.mjs` calls.

Other majors still arrive one per pull request. Security updates do not wait for the schedule.

## What the release workflow does

This section describes `.github/workflows/release.yml`. When you change one, update the other. It has six jobs: `preflight` runs first; `windows`, `linux` and `android` then build in parallel; `assemble` gathers their files with read-only access; `publish`, the only job with write access, creates the release.

### Dry run

Actions → Release → **Run workflow** (`workflow_dispatch`) on any branch runs the same jobs without publishing: no tag, no release, no write. It skips the CI and branch checks, keeps the `package.json` version, skips `windows` unless its **windows** box is ticked (Windows minutes count double), keeps its build artifacts for one day, and stops after `assemble`. With the signing secrets set, a dry run from `main` builds and verifies signed APKs as a real release would; from any other branch it builds unsigned ones. That check lives in `release.yml` itself, so a branch can remove it from its own copy: it keeps an honest dispatch from signing unreviewed code, but only a GitHub Environment (signing secrets moved into one limited to `main` and `v*` tags, `environment:` on the jobs that read them) enforces it. Without any of them it builds **unsigned** APKs named `*-UNSIGNED.apk` and writes no `update.json`; with only some of them it fails. A dry run costs about as many Linux minutes as a release.

### Unsigned builds

A tag push never builds unsigned or debug-signed APKs: if any of the four signing secrets is missing, `preflight` fails within seconds and names each missing secret (never a value). This is the safer of the two options: an unsigned APK cannot be installed over a signed one, and an APK signed with a throwaway key would lock its users out of every later update. Only a dry run may build unsigned APKs, and their names say so.

### Where a release goes

| `RELEASES_TOKEN` secret | `RELEASES_REPO` variable | The release is created on |
|---|---|---|
| set | set (`owner/repo`) | `RELEASES_REPO`, with `RELEASES_TOKEN` |
| any other combination | | this repository, with the workflow's own token (`contents: write` on the `publish` job only); `preflight` warns when only one of the two is set |

Every action in `release.yml` and `ci.yml` is pinned to a commit SHA, with the version in a comment (`actions/checkout@<sha> # v7.0.1`): `publish` hands a write token to `softprops/action-gh-release`, so a moved tag must not change what runs. To update an action, resolve the new tag with `git ls-remote --tags https://github.com/<owner>/<repo>.git` (take the `^{}` line of an annotated tag) and replace both the SHA and the comment.

### `preflight` (on `ubuntu-latest`)

A check of a few seconds, so that a misconfigured release fails before about two hours of build time (Windows minutes count double on a private repo). It fails when:

- the tag does not match `^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$`;
- the tagged commit is not an ancestor of `origin/main` (`git merge-base --is-ancestor`, with a full-history checkout);
- the newest `ci.yml` run of the tagged commit is not `completed` with `success` (read with `gh api …/actions/workflows/ci.yml/runs?head_sha=…`; the job has `actions: read`). A run still in progress counts as not green: wait for it, then re-run the release workflow;
- that run's `Desktop / Linux` and `Android` jobs did not conclude `success` (a job the path filters skipped reads as green but tested nothing): run CI by hand (Actions > CI > Run workflow) on `main`, or on a branch at the tagged commit if `main` has moved on, then re-run the release workflow;
- any of the four signing [secrets](#secrets) is empty (see [Unsigned builds](#unsigned-builds)), or the `APK_CERT_SHA256` [variable](#variables) is not a 64-hex SHA-256;
- `RELEASES_TOKEN` and `RELEASES_REPO` are both set but `RELEASES_REPO` is not `owner/repo`.

It also picks the target repository (see [Where a release goes](#where-a-release-goes)) and hands it, the tag, the version and the signing state to the other jobs. Secrets are only tested for emptiness, never printed.

### `windows` (on `windows-latest`)

1. `npm ci` at the repo root (npm workspaces).
2. Stamps the desktop version from the tag: `npm version "${GITHUB_REF_NAME#v}" --no-git-tag-version --allow-same-version --workspace apps/desktop`.
3. `fetch-mpv.ps1 -Generic` downloads the baseline x86_64 shinchiro mpv build (no AVX2 needed) pinned in `apps/desktop/scripts/fetch-mpv.ps1` (`$MpvTag`, `$MpvCommit` and one SHA-256 per variant; the `-Generic` x86_64 one is what ships) into `vendor/mpv`, and stops if the archive's SHA-256 differs. To move to a newer build, update the tag, the commit and both hashes together (the release page shows a `sha256:` digest next to each asset), and the mpv row of `THIRD_PARTY_NOTICES.md`.
4. `npm run build:mesh` builds `vendor/vpn-helper/wicaby-mesh.exe` and its licence file with `build-vpn-helper.mjs`. It runs `go test ./mesh/` first and the AGPL guard after the build.
5. `npm run dist -w apps/desktop -- --publish never` builds (the last build step, `tools/release/licenses.mjs`, stages `LICENSE.txt`, `THIRD_PARTY_NOTICES.md`, the GPL-2.0 and LGPL-2.1 texts and `npm-licenses.txt` in `apps/desktop/out/licenses/`, which electron-builder copies to `resources/licenses/`), then writes `release/Wicaby-<version>-x64.exe` (NSIS installer) and `release/Wicaby-<version>-portable.exe`, unsigned (`CSC_IDENTITY_AUTO_DISCOVERY=false`).
6. Uploads both `.exe` files as the `windows` workflow artifact.

This is the only job that needs Windows: mpv, the Windows helper and the NSIS installer are Windows builds.

### `android` (on `ubuntu-latest`)

1. Sets up JDK 21 and Go (version from `packages/mesh/go.mod`), then installs `gomobile` and `gobind` at the `golang.org/x/mobile` version pinned in `go.mod`. It does not run `gomobile init`: `gomobile bind` only needs `gobind` on `PATH`, and `init` would replace the pinned `gobind` with `gobind@latest`, which `build-mesh-aar.sh` refuses.
2. `bash packages/mesh/scripts/build-mesh-aar.sh` builds `vendor/android/wicaby-mesh.aar` for arm64-v8a and armeabi-v7a, with the NetBird Android patch and the AGPL guard. It is the bash port of `build-mesh-aar.ps1` (see [mesh.md](mesh.md#android-aar)). A release always rebuilds it; there is no cache.
3. Writes the signing setup from the secrets (`preflight` has already refused a tag push with a missing secret, so a release never ships unsigned APKs):

   ```sh
   cd apps/android
   mkdir -p keystore
   printf '%s' "$KEYSTORE_BASE64" | base64 --decode > keystore/wicaby-release.jks
   {
     echo "storeFile=keystore/wicaby-release.jks"
     echo "storePassword=$KEYSTORE_PASSWORD"
     echo "keyAlias=$KEY_ALIAS"
     echo "keyPassword=$KEY_PASSWORD"
   } > keystore.properties
   ```

   The real step also escapes backslashes for `java.util.Properties` and runs `chmod 600` on both files. Both are gitignored, and an `if: always()` step deletes them after the Gradle build.
4. From `apps/android`: `./gradlew :tv:assembleRelease :mobile:assembleFossRelease :mobile:assembleGplayRelease`. The release workflow runs no unit tests or lint; `ci.yml` runs them on every push to `main` that touches Android, so tag a commit whose CI is green.
5. Fails if Gradle produced any `*-unsigned.apk`, checks each APK with `apksigner verify --print-certs` and fails unless every signer's certificate SHA-256 equals the `APK_CERT_SHA256` [variable](#variables), reads its `versionName` with `aapt2` (and fails if it is not numeric), and copies it under the name the manifest script expects:

   | Gradle output (`<module>/build/outputs/apk/[<flavour>/]release/`) | Release asset |
   |---|---|
   | `tv-armeabi-v7a-release.apk` | `tv/Wicaby-TV-<versionName>-armv7.apk` |
   | `tv-arm64-v8a-release.apk` | `tv/Wicaby-TV-<versionName>-arm64.apk` |
   | `tv-universal-release.apk` | `tv/Wicaby-TV-<versionName>-universal.apk` |
   | `mobile-foss-armeabi-v7a-release.apk` | `mobile/Wicaby-Mobile-<versionName>-armv7.apk` |
   | `mobile-foss-arm64-v8a-release.apk` | `mobile/Wicaby-Mobile-<versionName>-arm64.apk` |
   | `mobile-gplay-armeabi-v7a-release.apk` | `mobile-gplay/Wicaby-Mobile-Cast-<versionName>-armv7.apk` |
   | `mobile-gplay-arm64-v8a-release.apk` | `mobile-gplay/Wicaby-Mobile-Cast-<versionName>-arm64.apk` |

   The mobile app builds no universal APK. `foss` keeps the 0.2.0 asset names and the `mobile` key of `update.json`; `gplay` (Google Cast, no FFmpeg decoder) gets the `mobile-gplay` key, so neither flavour ever updates into the other.
6. Uploads the seven APKs and `wicaby-mesh-THIRD_PARTY_LICENSES.txt` (the licence texts of every Go module in the AAR, written by `build-mesh-aar.sh`) as the `android` workflow artifact.

### `linux` (on `ubuntu-latest`)

Stamps the version like `windows`, builds `vendor/vpn-helper/wicaby-mesh` (linux/amd64, AGPL guard), then runs `dist:linux` in steps: `npm run build -w apps/desktop` with `WICABY_SKIP_NATIVE=1`, the libmpv addon in an `ubuntu:22.04` container (glibc 2.35 floor, checked by `native-addon-check.mjs --require`), then `electron-builder --linux --publish never` writes the AppImage, the deb and the tar.gz, uploaded as the `linux` artifact. mpv is not bundled on Linux.

### `assemble` and `publish` (on `ubuntu-latest`)

`assemble` (read-only token) does steps 1 to 6 below and hands the `release/` folder to `publish` (step 7) as a one-day artifact. In a dry run, `assemble` stops after step 6.

1. Downloads the artifacts: the APKs into `release/tv/`, `release/mobile/` and `release/mobile-gplay/`, the mesh licence file into `release/`, the installers into `release/windows/`, the Linux packages into `release/linux/`.
2. Extracts the `## [X.Y.Z]` section of `CHANGELOG.md` that matches the tag into `release-notes.md` (link definitions and surrounding blank lines removed).
3. Writes `update.json` (next section).
4. Writes the source archive and licence texts that GPL-3.0 section 6 requires next to the binaries, since the code repo is private:
   - `wicaby-<X.Y.Z>-source.tar.gz`: `git archive --prefix=wicaby-<X.Y.Z>/` of the tagged commit;
   - `LICENSE.txt` (a copy of `LICENSE`) and `THIRD_PARTY_NOTICES.md`;
   - `mpv-winbuild-<tag>-source.tar.gz`, for the bundled mpv: the [shinchiro/mpv-winbuild-cmake](https://github.com/shinchiro/mpv-winbuild-cmake) tree at `$MpvTag` and the mpv tree at `$MpvCommit`, both read from `fetch-mpv.ps1` and downloaded from GitHub.
5. Builds the release body: the CHANGELOG section (or "Wicaby vX.Y.Z" when there is none), followed by a short guide to which APK and which `.exe` to pick, a pointer to the source archive, and the pinned shinchiro release and mpv commit.
6. Writes `SHA256SUMS.txt` with the SHA-256 of every other asset.
7. `publish` creates the GitHub Release on the [target repository](#where-a-release-goes) with `softprops/action-gh-release` (pinned by SHA):
   - tag and name: the pushed tag (`Wicaby v0.2.0`);
   - prerelease when the tag contains `-`; only other tags are marked **latest**;
   - assets: `Wicaby-<version>-x64.exe`, `Wicaby-<version>-portable.exe`, the five APKs, `update.json`, `wicaby-<X.Y.Z>-source.tar.gz`, `mpv-winbuild-<tag>-source.tar.gz`, `LICENSE.txt`, `THIRD_PARTY_NOTICES.md`, `wicaby-mesh-THIRD_PARTY_LICENSES.txt` and `SHA256SUMS.txt`. The job fails if any of these patterns matches nothing.

Once the release is published on the public releases repo, `https://github.com/WicaebethTheo/wicaby-releases/releases/latest/download/update.json` serves the new manifest to every installed app. The apps check at most every 6 hours, or on "Check for Updates".

### `update.json`

The `assemble` job first downloads `update.json` from the latest release of the target repository (`gh release download`, with the token of that repository) into `release/update.json`. On the very first release there is none, and the step carries on without it. Then it runs:

```sh
node tools/release/make-update-manifest.mjs \
  https://github.com/WicaebethTheo/wicaby-releases/releases/download/<tag>/ --flat \
  --notes-en "<the CHANGELOG section>"
```

- `--flat` is required: release assets have no folders, so the URLs become `<base><file>` instead of `<base>tv/<file>`.
- Use the **tag** download URL as the base, not `latest/download`. The APK links then stay valid even after a later release becomes "latest". The manifest itself is still fetched through `latest/download/update.json`, so devices always see the newest one.
- `versionCode` is read with `aapt2` from the runner's `ANDROID_HOME`. Each APK gets its SHA-256, which the apps check before installing.
- Notes are chosen per app and per language. `release/<app>/NOTES.en.txt` and `NOTES.fr.txt` win when present, but only in local builds: `release/` is gitignored, so they never exist on the runner. Next come `--notes-en` and `--notes-fr`. When an app's `versionCode` did not change, the notes already in the downloaded manifest are kept as the base. On CI this means an app with a new `versionCode` gets the CHANGELOG section as `notes.en` and no `notes.fr`, and an unchanged app keeps its previous notes. `--notes-en` is only passed when the CHANGELOG has a matching section.

The format is described in [android.md](android.md#updatejson-format).

## Secrets

Set these on the **code** repository (`WicaebethTheo/wicaby`), Settings → Secrets and variables → Actions:

| Secret | Content |
|---|---|
| `KEYSTORE_BASE64` | The release keystore, base64-encoded: `base64 -w0 wicaby-release.jks` (or `[Convert]::ToBase64String([IO.File]::ReadAllBytes('wicaby-release.jks'))` in PowerShell). |
| `KEYSTORE_PASSWORD` | Store password. |
| `KEY_ALIAS` | Key alias (`wicaby` if created as in [android.md](android.md#signing)). |
| `KEY_PASSWORD` | Key password. |
| `RELEASES_TOKEN` | Optional, with the `RELEASES_REPO` variable. A fine-grained personal access token with access to **`WicaebethTheo/wicaby-releases` only**, permission *Contents: Read and write*, to create releases and upload assets there. |

The four signing secrets are required for a tag push. Set them from files, so no value reaches the screen, the shell history or a log:

```sh
base64 -w0 wicaby-release.jks > keystore.b64
gh secret set KEYSTORE_BASE64   -R WicaebethTheo/wicaby < keystore.b64
gh secret set KEYSTORE_PASSWORD -R WicaebethTheo/wicaby < keystore-password.txt
gh secret set KEY_ALIAS         -R WicaebethTheo/wicaby < key-alias.txt
gh secret set KEY_PASSWORD      -R WicaebethTheo/wicaby < key-password.txt
gh secret set RELEASES_TOKEN    -R WicaebethTheo/wicaby < releases-token.txt   # optional
```

In PowerShell, write `keystore.b64` with `[Convert]::ToBase64String([IO.File]::ReadAllBytes('wicaby-release.jks')) | Set-Content -NoNewline keystore.b64`. Delete the files afterwards; `gh secret list -R WicaebethTheo/wicaby` shows the names, never the values.

## Variables

Set on the code repository, Settings → Secrets and variables → Actions → **Variables** (not a secret: a certificate fingerprint is public):

| Variable | Content |
|---|---|
| `RELEASES_REPO` | Optional, with the `RELEASES_TOKEN` secret: the `owner/repo` that receives the releases, e.g. `WicaebethTheo/wicaby-releases`. Set it with `gh variable set RELEASES_REPO -R WicaebethTheo/wicaby --body WicaebethTheo/wicaby-releases`. |
| `APK_CERT_SHA256` | The SHA-256 of the release signing certificate, 64 hex digits (colons and either case are accepted). Print it with `keytool -list -v -keystore apps/android/keystore/wicaby-release.jks -alias <alias>` (the `SHA256:` line), or with `apksigner verify --print-certs <a signed apk>`. Set it with `gh variable set APK_CERT_SHA256 -R WicaebethTheo/wicaby --body <hex>`. |

Rules:

- **Never commit** the keystore, `keystore.properties` or `local.properties`. `.gitignore` covers them, but check `git ls-files` before a push. The desktop credential vault (`vault.bin`) lives in the user profile (`%APPDATA%\Wicaby`), never inside the repo.
- **Back up the keystore and its passwords** outside GitHub. Without the same key, existing installs cannot update, and users must uninstall first, which loses their settings.
- If `RELEASES_TOKEN` expires, the release job fails at the upload step. Create a new token with the same scope and update the secret.

## Android update manifest for a hand-made release

When the release assets are uploaded by hand to `WicaebethTheo/wicaby` (names `Wicaby-TV-foss-X.Y.Z-{armv7,arm64,universal}.apk`, `Wicaby-Mobile-{foss,gplay}-X.Y.Z-{armv7,arm64}.apk`), put the signed APKs in one folder, `release/<version>/`, and write `update.json` next to them:

```sh
node tools/release/make-update-manifest.mjs --flat --dir release/0.10.6
```

Then upload `release/0.10.6/update.json` as a release asset with the APKs (and list it in `SHA256SUMS.txt`). Without a base URL the APK entries are bare file names, which the apps resolve against the manifest URL (`…/releases/latest/download/<file>`). To pin them to the tag, put the tag URL first: `node tools/release/make-update-manifest.mjs https://github.com/WicaebethTheo/wicaby/releases/download/v0.10.6/ --flat --dir release/0.10.6`. Notes come from `release/0.10.6/tv/NOTES.en.txt`-style files when present, or from `--notes-en` / `--notes-fr`. `versionCode` is read with `aapt2` (set `ANDROID_HOME`), else from `build.gradle.kts` when the `versionName` matches.

## Building a release by hand

The same steps work locally, from the repo root, for a test build or if CI is down. On Windows, use the PowerShell scripts through npm; on Linux or macOS, build the AAR with `bash packages/mesh/scripts/build-mesh-aar.sh` (the desktop part needs Windows either way).

```sh
npm ci
# Desktop: the installer names come from apps/desktop/package.json here, so set its version first.
npm version 0.2.0 --no-git-tag-version --allow-same-version --workspace apps/desktop
npm run fetch-mpv && npm run build:mesh && npm run dist          # -> release/Wicaby-0.2.0-*.exe
npm run build:mesh-aar                                           # or: bash packages/mesh/scripts/build-mesh-aar.sh
cd apps/android && ./gradlew :tv:assembleRelease :mobile:assembleFossRelease :mobile:assembleGplayRelease && cd ../..
# copy/rename the APKs into release/tv, release/mobile and release/mobile-gplay (table above), then:
curl -fsSL https://github.com/WicaebethTheo/wicaby-releases/releases/latest/download/update.json -o release/update.json   # keeps unchanged apps' notes
awk -v v=0.2.0 'index($0, "## [" v "]") == 1 { f = 1; next } f && /^## / { exit } f && /^\[[^]]+\]: / { next } f' CHANGELOG.md > release/notes.md
node tools/release/make-update-manifest.mjs https://github.com/WicaebethTheo/wicaby-releases/releases/download/v0.2.0/ --flat \
  --notes-en "$(cat release/notes.md)"
git archive --format=tar.gz --prefix=wicaby-0.2.0/ -o release/wicaby-0.2.0-source.tar.gz v0.2.0
cp LICENSE release/LICENSE.txt && cp THIRD_PARTY_NOTICES.md release/ && cp vendor/android/wicaby-mesh-THIRD_PARTY_LICENSES.txt release/
# mpv source: the tag and commit pinned in apps/desktop/scripts/fetch-mpv.ps1. The 20261011/accb7b2821 below are 0.2.0's; use the current pins.
mkdir -p mpv-winbuild-20261011-source
curl -fsSL https://github.com/shinchiro/mpv-winbuild-cmake/archive/refs/tags/20261011.tar.gz -o mpv-winbuild-20261011-source/mpv-winbuild-cmake-20261011.tar.gz
curl -fsSL https://github.com/mpv-player/mpv/archive/accb7b2821.tar.gz -o mpv-winbuild-20261011-source/mpv-accb7b2821.tar.gz
tar -czf release/mpv-winbuild-20261011-source.tar.gz mpv-winbuild-20261011-source && rm -r mpv-winbuild-20261011-source
(cd release && sha256sum Wicaby-*.exe tv/*.apk mobile/*.apk update.json wicaby-0.2.0-source.tar.gz mpv-winbuild-20261011-source.tar.gz LICENSE.txt THIRD_PARTY_NOTICES.md wicaby-mesh-THIRD_PARTY_LICENSES.txt | sed 's#  [^ ]*/#  #' > SHA256SUMS.txt)
gh release create v0.2.0 -R WicaebethTheo/wicaby-releases --title "Wicaby v0.2.0" --notes-file release/notes.md \
  release/Wicaby-*.exe release/tv/*.apk release/mobile/*.apk release/update.json \
  release/wicaby-0.2.0-source.tar.gz release/mpv-winbuild-20261011-source.tar.gz release/LICENSE.txt release/THIRD_PARTY_NOTICES.md \
  release/wicaby-mesh-THIRD_PARTY_LICENSES.txt release/SHA256SUMS.txt
```

`release/` is gitignored. `apps/android/keystore.properties` must exist locally to get signed APKs; without it, Gradle builds unsigned APKs, which the in-app updater cannot install over a signed copy. For a prerelease, add `--prerelease --latest=false` to `gh release create`.

## Checklist

- [ ] One-time: the [before first publish](#before-first-publish) list is done; `WicaebethTheo/wicaby-releases` exists, is public and has at least one commit; the four signing secrets and `APK_CERT_SHA256` are set, and `RELEASES_TOKEN` with `RELEASES_REPO` for the public repo.
- [ ] TV and mobile `versionCode`/`versionName` bumped where they changed (the desktop version comes from the tag).
- [ ] `CHANGELOG.md` has a `## [X.Y.Z]` section matching the tag.
- [ ] CI is green on the tagged commit (`npm run check`, `npm run checks`, `go test ./...` and the AGPL guard in `packages/mesh`, `./gradlew testDebugUnitTest :mobile:testFossDebugUnitTest :mobile:testGplayDebugUnitTest lint :mobile:lintGplayDebug`).
- [ ] Tag pushed and the release workflow is green.
- [ ] The tag is `vX.Y.Z` (or `vX.Y.Z-<prerelease>`) on a commit of `main`, and the Android `versionName`s are numeric.
- [ ] The release on `wicaby-releases` has 2 exe files, 5 APKs, `update.json`, `wicaby-X.Y.Z-source.tar.gz`, `mpv-winbuild-<tag>-source.tar.gz`, `LICENSE.txt`, `THIRD_PARTY_NOTICES.md`, `wicaby-mesh-THIRD_PARTY_LICENSES.txt` and `SHA256SUMS.txt`, and (for a stable tag) is marked latest.
- [ ] `curl -sL https://github.com/WicaebethTheo/wicaby-releases/releases/latest/download/update.json` returns the new versions without authentication.
- [ ] An installed TV or phone build finds the update under Settings → About → "Check for Updates".
