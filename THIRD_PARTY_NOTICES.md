<!--
  MAINTAINER NOTE (staging draft; delete this comment before publishing).
  This file describes the 0.2.0 release as it must ship. Release blockers that make it true:
  1. Done: resources/licenses/ (tools/release/licenses.mjs + electron-builder.yml extraResources).
  2. Done: the vendor/mpv filter in electron-builder.yml.
  3. Android licence files. release.yml must attach LICENSE.txt, THIRD_PARTY_NOTICES.md and
     wicaby-mesh-THIRD_PARTY_LICENSES.txt to every wicaby-releases release. Better, and planned
     next: package the same files as :core assets (assets/licenses/) and show them in a real
     licences screen. The apps currently strip /META-INF/{AL2.0,LGPL2.1}, which is fine only
     once those texts ship by another route.
  4. GPL source. release.yml attaches wicaby-<tag>-source.tar.gz and
     mpv-winbuild-<tag>-source.tar.gz (shinchiro's recipes at the pinned tag + mpv at the pinned
     commit). Still missing: the source of FFmpeg and the other libraries linked into mpv.exe
     at the exact revisions shinchiro built (its recipes track upstream heads).
  5. Versions. After phase 2, re-check the versions below against the real build: Electron,
     electron-builder, the shinchiro tag and its mpv/FFmpeg versions, and regenerate the Go
     module table from the new vendor/vpn-helper/THIRD_PARTY_LICENSES.txt and
     vendor/android/wicaby-mesh-THIRD_PARTY_LICENSES.txt.
  6. FFmpeg in mpv must be configured without --enable-nonfree (check the shinchiro release's
     ffmpeg.cmake); strings in the checked mpv.exe show x264/x265 and no libfdk-aac.
  7. Demo media. The table below was built from demo-assets/sources.mjs and the live Wikimedia
     Commons metadata (2026-10-11). Diff it against the final generated ATTRIBUTION.json and
     commit ATTRIBUTION.md to tools/mock-server/demo/.
  8. Plex (plex-spec D-8). TODO(owner): before any public release that includes the Plex backend, read the
     current plex.tv Terms of Service and the Plex trademark guidelines by hand (both refuse automated reads)
     for clauses on third-party clients, rate limits and account sharing, and confirm the "works with Plex
     Media Server" wording below and in the store listings.
-->

# Third-party notices

Wicaby is free software under the [GNU General Public License v3.0 or later](LICENSE)
(SPDX: `GPL-3.0-or-later`), with a section 7 additional permission for linking with Google Play
services that only the optional `gplay` Android flavour uses (see
[LICENSE-EXCEPTION.md](LICENSE-EXCEPTION.md)). Its binaries bundle or link the third-party components listed below,
each under its own licence. This file names every component that ships inside a Wicaby
release, with its version as of the 0.2.0 release and its licence. Tools that are only used to
build Wicaby (Vite, esbuild, TypeScript, svelte-check, electron-builder, Gradle, the Android
Gradle Plugin, the Kotlin compiler, Go and gomobile themselves) do not ship and are not listed;
the only exception is the small part of electron-builder that does ship (the NSIS stubs and
`elevate.exe`).

## Where the full licence texts are

- **Windows app** (installed folder or portable build):
  - next to `Wicaby.exe`: `LICENSE.electron.txt` (Electron, MIT) and `LICENSES.chromium.html`
    (Chromium and everything it bundles, including its FFmpeg and the Vulkan and SwiftShader
    libraries);
  - `resources/licenses/`: `LICENSE.txt` (Wicaby; also the GPL-3.0 text), this
    `THIRD_PARTY_NOTICES.md`, the GPL-2.0 and LGPL-2.1 texts that cover mpv and the libraries
    linked into it, `npm-licenses.txt`, the licence files of the renderer libraries (Svelte,
    clsx, esm-env, hls.js, Lucide, Geist, pdf.js) and of their npm dependencies, and
    `libarchive-wasm.txt`, the texts for libarchive-wasm and the C libraries in its WebAssembly;
  - `resources/vpn-helper/THIRD_PARTY_LICENSES.txt`: every Go module linked into the mesh
    helper.
- **Linux app** (AppImage, deb or tar.gz; the deb installs to `/opt/Wicaby`): the same files,
  next to the `wicaby` executable and in `resources/`, except mpv, which is not bundled (see
  [mpv on Linux](#mpv-on-linux)).
- **Android apps:** Settings → About lists the main licences (the TV app shows a short list:
  FFmpeg, libass, Geist, AndroidX, Coil, libarchive; the mobile app shows one line, which in the `gplay`
  flavour names Google Play services instead of FFmpeg, followed by the section 7 permission). The only full licence
  text inside the APK is the Geist licence (`assets/OFL-Geist.txt`). The complete texts are
  published with every release on
  [`WicaebethTheo/wicaby-releases`](https://github.com/WicaebethTheo/wicaby-releases/releases) as
  `LICENSE.txt`, `THIRD_PARTY_NOTICES.md` and `wicaby-mesh-THIRD_PARTY_LICENSES.txt` (every Go
  module linked into the Android mesh library).
- Each component's upstream repository, linked below.

## Source code for GPL components

Several components below are under the GPL: mpv and the FFmpeg linked into it on Windows, and
the Jellyfin Media3 FFmpeg decoder on Android. Anyone who receives a Wicaby binary is entitled to
the complete corresponding source code under GPL-3.0. Because the Wicaby code repository is
private, the source is published next to the binaries, on the same release page of
[`WicaebethTheo/wicaby-releases`](https://github.com/WicaebethTheo/wicaby-releases/releases), for as
long as that release is offered:

- **Wicaby:** `wicaby-<version>-source.tar.gz`, the full tree of the release tag. It includes
  the build scripts, among them `packages/mesh/scripts/build-mesh-aar.ps1`, which applies the
  one-line NetBird patch used by the Android mesh library.
- **mpv (Windows):** built by
  [shinchiro/mpv-winbuild-cmake](https://github.com/shinchiro/mpv-winbuild-cmake). The release
  notes of each Wicaby release name the exact shinchiro release used (for 0.2.0: `20261011`,
  `git-accb7b2821`), and `mpv-winbuild-<shinchiro tag>-source.tar.gz` holds shinchiro's build
  scripts at that release and the mpv source at that commit. The build scripts name the
  upstream repository of FFmpeg and of every library linked into `mpv.exe`.
- **Jellyfin Media3 FFmpeg decoder (Android):** unmodified; source at
  [jellyfin/jellyfin-androidx-media](https://github.com/jellyfin/jellyfin-androidx-media),
  tag `1.9.0+1`.

---

## Windows desktop app

### Runtime

| Component | Version | Licence | Notes |
|---|---|---|---|
| [Electron](https://github.com/electron/electron) | 44.7.0 | MIT | Application runtime. Licence in `LICENSE.electron.txt`. |
| ↳ [Chromium](https://www.chromium.org/) | bundled with Electron 44.7.0 | BSD-3-Clause, plus the licences of its third-party code | Full list in `LICENSES.chromium.html`. |
| ↳ [Node.js](https://github.com/nodejs/node) | bundled with Electron 44.7.0 | MIT, plus the licences of its bundled dependencies | |
| ↳ FFmpeg (`ffmpeg.dll`) | bundled with Electron 44.7.0 | LGPL-2.1-or-later | Chromium's media decoders, used by the fallback HTML player. |
| ↳ [SwiftShader](https://github.com/google/swiftshader) (`vk_swiftshader.dll`, `vk_swiftshader_icd.json`) | bundled with Electron 44.7.0 | Apache-2.0 | Chromium's software Vulkan renderer. |
| ↳ [Vulkan loader](https://github.com/KhronosGroup/Vulkan-Loader) (`vulkan-1.dll`) | bundled with Electron 44.7.0 | Apache-2.0 | |
| ↳ `d3dcompiler_47.dll` | bundled with Electron 44.7.0 | Microsoft redistributable (Windows SDK redistribution terms) | Microsoft's HLSL compiler, redistributed by Chromium. Not open source. |
| ↳ `dxcompiler.dll` | bundled with Electron 44.7.0 | [DirectX Shader Compiler](https://github.com/microsoft/DirectXShaderCompiler): University of Illinois/NCSA Open Source License (LLVM-based) | Used by Chromium's WebGPU backend. |
| ↳ `dxil.dll` | bundled with Electron 44.7.0 | Microsoft redistributable (DirectX Shader Compiler binary licence) | Signs compiled DXIL shaders. Not open source. |
| [NSIS](https://nsis.sourceforge.io/) | through electron-builder 26.17.0 | zlib/libpng (some parts bzip2 licence) | Installer and uninstaller stubs only. |
| [elevate](https://github.com/jpassing/elevate) (`resources/elevate.exe`) | through electron-builder 26.17.0 | MIT | Added by electron-builder to the installed app; restarts the installer with administrator rights when needed. |

### Renderer (bundled into `out/renderer` by Vite)

| Component | Version | Licence | Notes |
|---|---|---|---|
| [Svelte](https://github.com/sveltejs/svelte) | 5.57.2 | MIT | UI framework (runtime). |
| ↳ [clsx](https://github.com/lukeed/clsx), [esm-env](https://github.com/benmccann/esm-env) | 2.1.1, 1.2.2 | MIT | Runtime helpers that Svelte imports. |
| [hls.js](https://github.com/video-dev/hls.js) | 1.7.3 | Apache-2.0 | HLS in the fallback HTML player. The package has no `NOTICE` file; its licence text ships in `resources/licenses/`. |
| [Lucide](https://github.com/lucide-icons/lucide) (`@lucide/svelte`) | 1.55.0 | ISC, Copyright (c) 2026 Lucide Icons and Contributors | Icons. The icons derived from [Feather](https://github.com/feathericons/feather) are MIT, Copyright (c) 2013-present Cole Bemis. |
| [Geist and Geist Mono](https://github.com/vercel/geist-font) (`@fontsource-variable/geist`, `@fontsource-variable/geist-mono`) | 5.3.0 | SIL Open Font License 1.1 | Copyright 2024 The Geist Project Authors. Also copied into mpv's font folder for subtitles. |
| [pdf.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`) | 6.4.299 | Apache-2.0, Copyright Mozilla Foundation | Draws the pages of PDF comics in a hidden window (`pdf.html`, with its worker `pdf.worker.min.mjs`). No CMaps or standard fonts are shipped. The package has no `NOTICE` file; its licence text ships in `resources/licenses/`. |
| [Leaflet](https://github.com/Leaflet/Leaflet) | 1.9.4 | BSD-2-Clause, Copyright (c) 2010-2023 Volodymyr Agafonkin, Copyright (c) 2010-2011 CloudMade | The opt-in photo map. Its map tiles are not part of Wicaby: they come from the tile server set in the settings (OpenStreetMap by default, © OpenStreetMap contributors, ODbL), shown with their attribution. |

### Main process (bundled into `out/main` by esbuild)

| Component | Version | Licence | Notes |
|---|---|---|---|
| [libarchive-wasm](https://github.com/ofk/libarchive-wasm) (`out/main/archive-worker.cjs`, `out/main/libarchive.wasm`) | 1.2.0 | MIT, Copyright (c) 2021 ofk | Reads RAR (4 and 5), 7z and tar comics in a worker thread. Its WebAssembly build links the libraries below; their texts are in `resources/licenses/libarchive-wasm.txt`. |
| ↳ [libarchive](https://github.com/libarchive/libarchive) | 3.7.7 | BSD-2-Clause (a few files: BSD-3-Clause, public domain, or CC0-1.0/OpenSSL/Apache-2.0) | The RAR 4 and RAR 5 readers are libarchive's own BSD code (RAR 5: Copyright (c) 2018 Grzegorz Antoniak). No UnRAR code is used anywhere in Wicaby: the UnRAR licence is not GPL compatible. |
| ↳ [zlib](https://zlib.net/) | 1.3.1 | Zlib | |
| ↳ [bzip2](https://sourceware.org/bzip2/) | 1.0.8 | bzip2-1.0.6 | |
| ↳ [XZ Utils](https://tukaani.org/xz/) (liblzma) | 5.6.4 | 0BSD | 7z LZMA and LZMA2. |

### mpv (`resources/mpv`)

| Component | Version | Licence | Notes |
|---|---|---|---|
| [mpv](https://github.com/mpv-player/mpv) | git master as built by shinchiro, release `20261018` (`git-01e2533f31`) | GPL-2.0-or-later (GPL build) | Downloaded by `npm run fetch-mpv` from [shinchiro/mpv-winbuild-cmake](https://github.com/shinchiro/mpv-winbuild-cmake) (releases bundle the baseline x86_64 build; a source build takes x86-64-v3 unless `-Generic` is passed). Runs as a separate process. The combined binary is distributed under GPL-3.0. |
| [FFmpeg](https://ffmpeg.org/) | statically linked into `mpv.exe`, as pinned by the shinchiro release | GPL (built with GPL components such as x264 and x265) | |
| Libraries statically linked into `mpv.exe` | as pinned by the shinchiro release | various | Found in the checked build: [libplacebo](https://code.videolan.org/videolan/libplacebo) (LGPL-2.1-or-later), [libass](https://github.com/libass/libass) (ISC), FreeType (FTL / GPL-2.0), HarfBuzz (MIT), FriBidi (LGPL-2.1-or-later), [x264](https://code.videolan.org/videolan/x264) and [x265](https://bitbucket.org/multicoreware/x265_git) (GPL-2.0-or-later), dav1d (BSD-2-Clause), libvpx (BSD-3-Clause), libaom (BSD-2-Clause), SVT-AV1 (BSD-3-Clause-Clear), Rubber Band (GPL-2.0-or-later), libbluray (LGPL-2.1-or-later), libdvdnav / libdvdread (GPL-2.0-or-later), libcurl (curl licence), OpenSSL (Apache-2.0), [libssh](https://www.libssh.org/) (LGPL-2.1), [SRT](https://github.com/Haivision/srt) (MPL-2.0), [VapourSynth](https://github.com/vapoursynth/vapoursynth) (LGPL-2.1), LuaJIT (MIT), Little CMS (MIT), libarchive (BSD-2-Clause), zimg (WTFPL), uchardet (MPL-1.1 / GPL-2.0 / LGPL-2.1), shaderc and SPIRV-Cross (Apache-2.0), the Vulkan loader (Apache-2.0), OpenAL Soft (LGPL-2.0-or-later), SDL2 (zlib), libjpeg-turbo (IJG / BSD-3-Clause / zlib), zlib (zlib) and libopenmpt (BSD-3-Clause). This list comes from the strings in the binary and may be incomplete; the authoritative list is the package list of the shinchiro release used, which is part of the mpv source bundle. |

The shinchiro archive also contains `d3dcompiler_43.dll`, a proprietary Microsoft DirectX
redistributable. Wicaby leaves it out of the package: mpv loads `d3dcompiler_47.dll` first,
which Windows 10 and 11 provide and which Electron already ships. The archive's `doc/`,
`installer/`, `updater.bat`, `mpv-register.bat` and `mpv-unregister.bat` are left out as well.

#### mpv on Linux

The Linux packages do not contain mpv, libmpv or FFmpeg; they use the mpv installed on the system
(0.37 or later, GPL-2.0-or-later or LGPL-2.1-or-later depending on how the distribution built
it), whose licence and source come from the distribution that ships it. Two ways:

- Music, the `wid` and `detached` video modes: the `mpv` command runs as a separate process
  (the AppImage and the tar.gz find it in `PATH`).
- Video in a native Wayland session (`texture` mode): the addon below `dlopen()`s the system
  `libmpv.so.2` into the Electron main process. libmpv is never bundled or linked at build time.

The deb declares `Depends: mpv (>= 0.37), libmpv2 (>= 0.37), libgbm1, libegl1, libgles2`.

#### Linux libmpv addon (`resources/app.asar.unpacked/out/native/wicaby_mpv.node`)

| Component | Version | Licence | Notes |
|---|---|---|---|
| [node-addon-api](https://github.com/nodejs/node-addon-api) | 8.9.2 | MIT, Copyright (c) 2017 Node.js API collaborators | Header-only C++ wrapper of Node-API (`napi.h`, `napi-inl.h`); its inline code is compiled into the addon. |
| mpv client API headers (`client.h`, `render.h`, `render_gl.h`) | vendored in `apps/desktop/native/mpv-render/include/mpv` | ISC, Copyright (C) 2017 the mpv developers | Only the declarations are used; the library itself is the system libmpv above. |
| GCC runtime ([libstdc++](https://gcc.gnu.org/onlinedocs/libstdc++/), libgcc) | as shipped by the Ubuntu 24.04 build runner | GPL-3.0-or-later with the GCC Runtime Library Exception 3.1 | Linked statically into the addon (`-static-libstdc++ -static-libgcc`). The exception allows this for code compiled with GCC, whatever the licence of the result. |

node-addon-api's MIT licence:

> Permission is hereby granted, free of charge, to any person obtaining a copy of this software
> and associated documentation files (the "Software"), to deal in the Software without
> restriction, including without limitation the rights to use, copy, modify, merge, publish,
> distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
> Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or
> substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
> BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
> NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
> DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

### Mesh helper (`resources/vpn-helper/wicaby-mesh.exe`)

Built from `packages/mesh` with Go. The Go modules it links are listed in
[Go modules](#go-modules-mesh-helper-and-android-mesh-library), column "Windows". The most
important ones:

- [Tailscale](https://github.com/tailscale/tailscale) (`tailscale.com` v1.104.1), BSD-3-Clause,
  © Tailscale Inc & AUTHORS;
- [NetBird](https://github.com/netbirdio/netbird) client (`github.com/netbirdio/netbird`
  v0.81.2), BSD-3-Clause for the client code Wicaby links. NetBird's `management/`,
  `signal/`, `relay/` and `combined/` directories are AGPL-3.0 and are **not linked**: both
  build scripts fail if `go list -deps` shows any package from them;
- the `golang.org/x/*` modules (`crypto`, `exp`, `net`, `oauth2`, `sync`, `sys`, `term`,
  `text`, `time`), BSD-3-Clause, © The Go Authors;
- the Go standard library and runtime, BSD-3-Clause, © The Go Authors.

---

## Android apps (TV and mobile)

### Libraries

| Component | Version | Licence | Used by |
|---|---|---|---|
| [AndroidX Media3](https://github.com/androidx/media) (`media3-exoplayer`, `-exoplayer-hls`, `-datasource-okhttp`, `-ui`, `-session`) | 1.11.1 | Apache-2.0 | TV, mobile |
| [Jellyfin Media3 FFmpeg decoder](https://github.com/jellyfin/jellyfin-androidx-media) (`org.jellyfin.media3:media3-ffmpeg-decoder`) | 1.9.0+1 | **GPL-3.0** | TV, mobile `foss` (not in `gplay`: no section 7 permission from its authors). FFmpeg audio decoding (AC-3, E-AC-3, DTS, TrueHD…). Because of it the distributed TV and `foss` APKs are GPL-3.0 works. |
| [AndroidX Media3 Cast](https://github.com/androidx/media) (`media3-cast`) and [AndroidX MediaRouter](https://developer.android.com/jetpack/androidx/releases/mediarouter) | 1.11.1, MediaRouter 1.8.1 | Apache-2.0 | mobile `gplay` only. Google Cast. |
| Google Play services (`com.google.android.gms:play-services-cast-framework`, `play-services-cast`, `-base`, `-basement`, `-tasks`, `-flags`) | 22.3.1 (Cast) | proprietary, [Android Software Development Kit License Agreement](https://developer.android.com/studio/terms) | mobile `gplay` only, linked under the section 7 permission in [LICENSE-EXCEPTION.md](LICENSE-EXCEPTION.md). Google Cast. |
| [ass-media](https://github.com/peerless2012/libass-android) (`io.github.peerless2012:ass-media`, with `ass-kt`) | 0.5.1 | MIT | TV, mobile. ASS/SSA subtitles. |
| ↳ native libraries in `ass-kt` | as built by ass-kt 0.5.1 | various | [libass](https://github.com/libass/libass) (ISC), FreeType (FTL / GPL-2.0), HarfBuzz (MIT), FriBidi (LGPL-2.1-or-later), Fontconfig (MIT-style), [Expat](https://github.com/libexpat/libexpat) (MIT), libunibreak (zlib), and the LLVM `libc++_shared.so` (Apache-2.0 WITH LLVM-exception). |
| [OkHttp](https://github.com/square/okhttp) and [Okio](https://github.com/square/okio) | OkHttp 5.5.0 | Apache-2.0 | TV, mobile |
| [Coil](https://github.com/coil-kt/coil) (`coil-compose`, `coil-network-okhttp`) | 3.6.3 | Apache-2.0 | TV, mobile. `coil-svg` is debug-only and does not ship. |
| [libarchive-android](https://github.com/zhanghai/libarchive-android) (`me.zhanghai.android.libarchive:library`) | 1.1.6 | Apache-2.0 | TV, mobile. Reads RAR (4 and 5), 7z and tar comics (`libarchive-jni.so`). |
| ↳ native libraries in `libarchive-jni.so` | as built by libarchive-android 1.1.6 | various | [libarchive](https://github.com/libarchive/libarchive) 3.8.1 (BSD-2-Clause; its RAR 4 and RAR 5 readers are libarchive's own code, no UnRAR code), [bzip2](https://sourceware.org/bzip2/) (bzip2-1.0.6), [XZ Utils](https://tukaani.org/xz/) liblzma (0BSD), [LZ4](https://github.com/lz4/lz4) (BSD-2-Clause), [Zstandard](https://github.com/facebook/zstd) (BSD-3-Clause, taken from its BSD/GPL-2.0 dual licence) and [Mbed TLS](https://github.com/Mbed-TLS/mbedtls) (Apache-2.0, taken from its Apache-2.0/GPL-2.0-or-later dual licence). PDF comics use the platform's `PdfRenderer`, no library. |
| [kotlinx.serialization](https://github.com/Kotlin/kotlinx.serialization) (`kotlinx-serialization-json`) | 1.11.0 | Apache-2.0 | TV, mobile |
| [kotlinx.coroutines](https://github.com/Kotlin/kotlinx.coroutines) | transitive | Apache-2.0 | TV, mobile |
| [Kotlin standard library](https://github.com/JetBrains/kotlin) | 2.4.21 | Apache-2.0 | TV, mobile |
| [ZXing core](https://github.com/zxing/zxing) (`com.google.zxing:core`) | 3.5.3 | Apache-2.0 | TV, mobile (`:mesh-ui`, QR codes) |
| [Jetpack Compose](https://developer.android.com/jetpack/androidx/releases/compose) (BOM 2026.09.00: runtime, foundation, ui; Material 3, Material 3 adaptive and adaptive navigation suite on mobile) | BOM 2026.09.00 | Apache-2.0 | TV, mobile |
| [Compose for TV Material](https://developer.android.com/jetpack/androidx/releases/tv) (`androidx.tv:tv-material`) | 1.1.0 | Apache-2.0 | TV |
| AndroidX `activity-compose` 1.13.0, `appcompat` 1.7.1, `annotation` 1.9.1, `datastore-preferences` 1.2.1, `lifecycle-viewmodel` (and `-compose`, `runtime-compose` on mobile) 2.9.4 | listed | Apache-2.0 | TV, mobile |
| AndroidX `tvprovider` | 1.1.0 | Apache-2.0 | TV (Watch Next) |
| AndroidX `navigation-compose` 2.10.2, `work-runtime-ktx` 2.12.0, `profileinstaller` 1.4.1 | listed | Apache-2.0 | mobile |
| [Geist and Geist Mono](https://github.com/vercel/geist-font) (TTF in `:core` `res/font`) | static TTF cuts (regular, medium, semibold, bold; mono regular, medium) | SIL Open Font License 1.1 | TV, mobile. Copyright 2024 The Geist Project Authors. |

### Mesh library (`wicaby-mesh.aar`)

The gomobile binding of `packages/mesh/mobile` (arm64-v8a and armeabi-v7a), linked into both
apps. It contains:

- the Go modules listed in [Go modules](#go-modules-mesh-helper-and-android-mesh-library),
  column "Android" (Tailscale `tailscale.com` v1.104.1 and the NetBird client v0.81.2, both
  BSD-3-Clause, with the same AGPL guard as on Windows; the NetBird copy carries a one-line
  nil-check patch applied by `build-mesh-aar.ps1`);
- the Java glue generated by [gomobile](https://github.com/golang/mobile)
  (`golang.org/x/mobile`), BSD-3-Clause, © The Go Authors.

---

## Go modules (mesh helper and Android mesh library)

Generated from the licence files that `npm run build:mesh` and `npm run build:mesh-aar` collect
from the exact build graph (`go list -deps`). Forks applied through `replace` in
`packages/mesh/go.mod` are listed under the fork's path.

| Module | Version | Licence | Windows | Android |
|---|---|---|:-:|:-:|
| Go standard library | go1.27.2 | BSD-3-Clause | x | x |
| `codeberg.org/cunicu/circl` | v0.0.0-20230801113412-fec58fc7b5f6 | BSD-3-Clause | x | x |
| `cunicu.li/go-rosenpass` | v0.5.42 | Apache-2.0 | x | x |
| `filippo.io/edwards25519` | v1.2.0 | BSD-3-Clause | x | x |
| `github.com/alexbrainman/sspi` | v0.0.0-20250919150558-7d374ff0d59e | BSD-3-Clause | x |  |
| `github.com/anmitsu/go-shlex` | v0.0.0-20200514113438-38f4b401e2be | MIT | x | x |
| `github.com/aws/aws-sdk-go-v2` | v1.46.0 | Apache-2.0 | x |  |
| `github.com/aws/aws-sdk-go-v2/config` | v1.33.3 | Apache-2.0 | x |  |
| `github.com/aws/aws-sdk-go-v2/credentials` | v1.20.3 | Apache-2.0 | x |  |
| `github.com/aws/aws-sdk-go-v2/feature/ec2/imds` | v1.19.2 | Apache-2.0 | x |  |
| `github.com/aws/aws-sdk-go-v2/internal/configsources` | v1.5.2 | Apache-2.0 | x |  |
| `github.com/aws/aws-sdk-go-v2/internal/endpoints/v2` | v2.8.2 | Apache-2.0 | x |  |
| `github.com/aws/aws-sdk-go-v2/internal/v4a` | v1.5.2 | Apache-2.0 | x |  |
| `github.com/aws/aws-sdk-go-v2/service/internal/accept-encoding` | v1.13.19 | Apache-2.0 | x |  |
| `github.com/aws/aws-sdk-go-v2/service/internal/presigned-url` | v1.14.2 | Apache-2.0 | x |  |
| `github.com/aws/aws-sdk-go-v2/service/route53` | v1.42.3 | Apache-2.0 | x |  |
| `github.com/aws/aws-sdk-go-v2/service/signin` | v1.9.0 | Apache-2.0 | x |  |
| `github.com/aws/aws-sdk-go-v2/service/sso` | v1.37.0 | Apache-2.0 | x |  |
| `github.com/aws/aws-sdk-go-v2/service/ssooidc` | v1.42.0 | Apache-2.0 | x |  |
| `github.com/aws/aws-sdk-go-v2/service/sts` | v1.49.0 | Apache-2.0 | x |  |
| `github.com/aws/smithy-go` | v1.28.1 | Apache-2.0 | x |  |
| `github.com/beorn7/perks` | v1.0.1 | MIT | x | x |
| `github.com/caddyserver/certmagic` | v0.21.3 | Apache-2.0 | x |  |
| `github.com/caddyserver/zerossl` | v0.1.3 | MIT | x |  |
| `github.com/cenkalti/backoff/v4` | v4.3.0 | MIT | x | x |
| `github.com/cespare/xxhash/v2` | v2.3.0 | MIT | x | x |
| `github.com/cilium/ebpf` | v0.22.0 | MIT |  | x |
| `github.com/coder/websocket` | v1.8.15 | ISC | x | x |
| `github.com/creachadair/msync` | v0.10.1 | BSD-2-Clause | x |  |
| `github.com/creack/pty` | v1.1.24 | MIT |  | x |
| `github.com/dblohm7/wingoes` | v0.0.0-20260526185140-fb298caac7ca | BSD-3-Clause | x |  |
| `github.com/DeRuina/timberjack` | v1.4.2 | MIT | x | x |
| `github.com/fsnotify/fsnotify` | v1.10.1 | BSD-3-Clause | x | x |
| `github.com/fxamacker/cbor/v2` | v2.9.3 | MIT | x | x |
| `github.com/gaissmai/bart` | v0.29.0 | MIT | x | x |
| `github.com/geoffgarside/ber` | v1.1.0 | BSD-3-Clause | x | x |
| `github.com/gliderlabs/ssh` | v0.3.8 | BSD-3-Clause | x | x |
| `github.com/go-json-experiment/json` | v0.0.0-20260820222146-c27c302e5fc3 | BSD-3-Clause | x | x |
| `github.com/go-ole/go-ole` | v1.3.0 | MIT | x |  |
| `github.com/godbus/dbus/v5` | v5.2.2 | BSD-2-Clause |  | x |
| `github.com/golang-jwt/jwt/v5` | v5.3.1 | MIT | x | x |
| `github.com/golang/groupcache` | v0.0.0-20241129210726-2c02b8208cf8 | Apache-2.0 | x | x |
| `github.com/golang/protobuf` | v1.5.4 | BSD-3-Clause | x | x |
| `github.com/google/btree` | v1.1.3 | Apache-2.0 | x | x |
| `github.com/google/go-tpm` | v0.9.8 | Apache-2.0 | x | x |
| `github.com/google/gopacket` | v1.1.19 | BSD-3-Clause | x | x |
| `github.com/google/uuid` | v1.6.0 | BSD-3-Clause | x | x |
| `github.com/gopacket/gopacket` | v1.6.1 | BSD-3-Clause |  | x |
| `github.com/grpc-ecosystem/grpc-gateway/v2` | v2.26.3 | BSD-3-Clause | x | x |
| `github.com/hashicorp/errwrap` | v1.1.0 | MPL-2.0 | x | x |
| `github.com/hashicorp/go-multierror` | v1.1.1 | MPL-2.0 | x | x |
| `github.com/hashicorp/go-version` | v1.9.0 | MPL-2.0 | x | x |
| `github.com/hdevalence/ed25519consensus` | v0.2.0 | BSD-3-Clause | x | x |
| `github.com/hirochachacha/go-smb2` | v1.1.0 | BSD-2-Clause | x | x |
| `github.com/huin/goupnp` | v1.3.0 | BSD-2-Clause | x | x |
| `github.com/jackpal/go-nat-pmp` | v1.0.2 | Apache-2.0 | x | x |
| `github.com/jmespath/go-jmespath` | v0.4.0 | Apache-2.0 | x |  |
| `github.com/klauspost/compress` | v1.20.0 | BSD-3-Clause, Apache-2.0, MIT (per package) | x | x |
| `github.com/klauspost/cpuid/v2` | v2.3.0 | MIT | x |  |
| `github.com/koron/go-ssdp` | v0.0.4 | MIT | x | x |
| `github.com/kr/fs` | v0.1.0 | BSD-3-Clause | x | x |
| `github.com/libdns/libdns` | v0.2.2 | MIT | x |  |
| `github.com/libdns/route53` | v1.5.0 | MIT | x |  |
| `github.com/libp2p/go-netroute` | v0.4.0 | BSD-3-Clause | x | x |
| `github.com/mdlayher/genetlink` | v1.4.0 | MIT |  | x |
| `github.com/mdlayher/netlink` | v1.11.2 | MIT |  | x |
| `github.com/mdlayher/socket` | v0.7.0 | MIT |  | x |
| `github.com/mholt/acmez/v2` | v2.0.1 | Apache-2.0 | x |  |
| `github.com/miekg/dns` | v1.1.73 | BSD-3-Clause | x | x |
| `github.com/mitchellh/go-ps` | v1.0.0 | MIT | x |  |
| `github.com/mitchellh/hashstructure/v2` | v2.0.2 | MIT | x | x |
| `github.com/munnerz/goautoneg` | v0.0.0-20191010083416-a7dc8b61c822 | BSD-3-Clause | x | x |
| `github.com/netbirdio/go-nat` | v0.0.0-20260821095157-6b2c8c5c74e8 | Apache-2.0 | x | x |
| `github.com/netbirdio/ice/v4` | v4.0.0-20250908184934-6202be846b51 | MIT | x | x |
| `github.com/netbirdio/netbird` | v0.81.2 | BSD-3-Clause | x | x |
| `github.com/netbirdio/wireguard-go` | v0.0.0-20261008122457-d2b1ce9bfee9 | MIT | x | x |
| `github.com/pion/dtls/v2` | v2.2.10 | MIT | x | x |
| `github.com/pion/dtls/v3` | v3.1.14 | MIT | x | x |
| `github.com/pion/logging` | v0.2.4 | MIT | x | x |
| `github.com/pion/mdns/v2` | v2.0.7 | MIT | x | x |
| `github.com/pion/randutil` | v0.1.0 | MIT | x | x |
| `github.com/pion/stun/v2` | v2.0.0 | MIT | x | x |
| `github.com/pion/stun/v3` | v3.1.0 | MIT | x | x |
| `github.com/pion/transport/v2` | v2.2.4 | MIT | x | x |
| `github.com/pion/transport/v3` | v3.1.1 | MIT | x | x |
| `github.com/pion/transport/v5` | v5.0.0 | MIT | x | x |
| `github.com/pion/turn/v3` | v3.0.1 | MIT | x | x |
| `github.com/pion/turn/v4` | v4.1.1 | MIT | x | x |
| `github.com/pires/go-proxyproto` | v0.15.0 | Apache-2.0 | x | x |
| `github.com/pkg/sftp` | v1.13.11 | BSD-2-Clause | x | x |
| `github.com/prometheus/client_golang` | v1.24.1 | Apache-2.0 | x | x |
| `github.com/prometheus/client_model` | v0.6.3 | Apache-2.0 | x | x |
| `github.com/prometheus/common` | v0.71.0 | Apache-2.0 | x | x |
| `github.com/prometheus/procfs` | v0.21.1 | Apache-2.0 |  | x |
| `github.com/quic-go/quic-go` | v0.64.0 | MIT | x | x |
| `github.com/shirou/gopsutil/v4` | v4.25.8 | BSD-3-Clause | x |  |
| `github.com/sirupsen/logrus` | v1.10.1 | MIT | x | x |
| `github.com/skratchdot/open-golang` | v0.0.0-20200116055534-eef842397966 | MIT | x | x |
| `github.com/tailscale/certstore` | v0.1.1-0.20260409135935-3638fb84b77d | MIT | x |  |
| `github.com/tailscale/go-winio` | v0.0.0-20231025203758-c4f33415bf55 | MIT | x |  |
| `github.com/tailscale/hujson` | v0.0.0-20260727124030-b80ff77dac4f | BSD-3-Clause | x |  |
| `github.com/tailscale/web-client-prebuilt` | v0.0.0-20260917222731-e0ed2d0d0fea | BSD-3-Clause | x |  |
| `github.com/tailscale/wireguard-go` | v0.0.0-20260928213032-417aef361226 | MIT | x | x |
| `github.com/things-go/go-socks5` | v0.0.4 | MIT | x | x |
| `github.com/vishvananda/netlink` | v1.3.1 | Apache-2.0 |  | x |
| `github.com/vishvananda/netns` | v0.0.5 | Apache-2.0 |  | x |
| `github.com/wlynxg/anet` | v0.0.5 | BSD-3-Clause | x | x |
| `github.com/x448/float16` | v0.8.4 | MIT | x | x |
| `github.com/yusufpapurcu/wmi` | v1.2.4 | MIT | x |  |
| `github.com/zeebo/blake3` | v0.2.3 | CC0-1.0 | x |  |
| `go.uber.org/multierr` | v1.11.0 | MIT | x |  |
| `go.uber.org/zap` | v1.28.0 | MIT | x |  |
| `go4.org/mem` | v0.0.0-20240501181205-ae6ca9944745 | Apache-2.0 | x | x |
| `go4.org/netipx` | v0.0.0-20260823151212-3075585bcbeb | BSD-3-Clause | x | x |
| `golang.org/x/crypto` | v0.58.0 | BSD-3-Clause | x | x |
| `golang.org/x/exp` | v0.0.0-20260908205506-85c1c2202aba | BSD-3-Clause | x | x |
| `golang.org/x/net` | v0.61.0 | BSD-3-Clause | x | x |
| `golang.org/x/oauth2` | v0.37.0 | BSD-3-Clause | x | x |
| `golang.org/x/sync` | v0.24.0 | BSD-3-Clause | x | x |
| `golang.org/x/sys` | v0.49.0 | BSD-3-Clause | x | x |
| `golang.org/x/term` | v0.47.0 | BSD-3-Clause | x | x |
| `golang.org/x/text` | v0.43.0 | BSD-3-Clause | x | x |
| `golang.org/x/time` | v0.16.0 | BSD-3-Clause | x | x |
| `golang.zx2c4.com/wintun` | v0.0.0-20230126152724-0fa3db229ce2 | MIT | x |  |
| `golang.zx2c4.com/wireguard/wgctrl` | v0.0.0-20241231184526-a9ab2273dd10 | MIT | x | x |
| `golang.zx2c4.com/wireguard/windows` | v1.0.1 | MIT | x |  |
| `google.golang.org/genproto/googleapis/api` | v0.0.0-20260706201446-f0a921348800 | Apache-2.0 | x | x |
| `google.golang.org/genproto/googleapis/rpc` | v0.0.0-20260706201446-f0a921348800 | Apache-2.0 | x | x |
| `google.golang.org/grpc` | v1.84.0 | Apache-2.0 | x | x |
| `google.golang.org/protobuf` | v1.36.12 | BSD-3-Clause | x | x |
| `gopkg.in/yaml.v3` | v3.0.1 | MIT, Apache-2.0 | x | x |
| `gvisor.dev/gvisor` | v0.0.0-20260915211658-a6f909f08a72 | Apache-2.0 | x | x |
| `tailscale.com` | v1.104.1 | BSD-3-Clause | x | x |

The MPL-2.0 modules (`github.com/hashicorp/*`) are used unmodified; their source is available
from their upstream repositories.

---

## Brand assets

The Wicaby logo and icons in `brand/` are original work, part of Wicaby and covered by its
licence.

## Plex

Plex is a trademark of Plex, Inc. Wicaby is an unofficial client, not affiliated with or endorsed by Plex.
Wicaby works with Plex Media Server through its publicly documented HTTP API
([developer.plex.tv](https://developer.plex.tv/pms/), whose specification is published under the Apache License 2.0).
No Plex software, code, logo or icon ships with Wicaby, and none was decompiled or reverse engineered. Features that
Plex reserves to Plex Pass or a Remote Watch Pass are detected and explained, never worked around.

## SongRec ("What's this song?")

The Shazam audio signature (`apps/desktop/src/shared/song-id.ts`, `apps/android/core/.../songid/ShazamSignature.kt`)
and the recognition request are ported from [SongRec](https://github.com/marin-m/SongRec) by Marin M. and
contributors, GNU General Public License v3.0, the same licence as Wicaby. Shazam is a trademark of Apple Inc.;
Wicaby is not affiliated with or endorsed by Shazam or Apple.

## Immich

Wicaby can connect to an Immich server through its public REST API. No Immich code is included: the requests are
written by hand from the published API reference, and no Immich package, SDK or asset is a dependency.

## Demo media in screenshots

The screenshots in `docs/screenshots/` and the README show a mock library
(`MOCK_DATASET=demo` in `tools/mock-server`) whose artwork comes from the Blender Foundation's
open movies. No real server or personal library was used, and the films themselves are not
distributed with Wicaby. Logos and title treatments are not used, because Blender Studio
excludes them from its Creative Commons licence.

Each image is licensed individually; an image's licence can differ from the film's (for
example, the Blender Studio header images are CC BY 4.0 under the
[studio terms](https://studio.blender.org/terms-and-conditions), even for films released under
CC BY 3.0). The list below covers every image in the demo dataset. The same data, with the
exact download URLs, is in `tools/mock-server/demo/ATTRIBUTION.md`.

| Image | Film | Source | Author | Licence | Credit | Changes |
|---|---|---|---|---|---|---|
| `big-buck-bunny/poster.jpg` | Big Buck Bunny (2008) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Big_buck_bunny_poster_big.jpg) | (c) copyright Blender Foundation \| peach.blender.org | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | (c) copyright Blender Foundation \| www.bigbuckbunny.org | cropped and scaled to 600×900 JPEG |
| `big-buck-bunny/backdrop.jpg` | Big Buck Bunny (2008) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Bbb-splash.png) | (c) copyright Blender Foundation / peach.blender.org | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | (c) copyright Blender Foundation \| www.bigbuckbunny.org | cropped and scaled to 1920×1080 JPEG |
| `elephants-dream/poster.jpg` | Elephants Dream (2006) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:ElephantsDreamPoster.jpg) | Bassam Kurdali, Andy Goralczyk, and the Blender Foundation | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | Bassam Kurdali, Andy Goralczyk, and the Blender Foundation | cropped and scaled to 600×900 JPEG |
| `elephants-dream/backdrop.jpg` | Elephants Dream (2006) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Elephants_Dream_s5_both.jpg) | Ton Roosendaal et al. | [CC BY 2.5](https://creativecommons.org/licenses/by/2.5/) | Ton Roosendaal et al. | cropped and scaled to 1920×1080 JPEG |
| `sintel/poster.jpg` | Sintel (2010) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Sintel_poster.jpg) | (c) copyright Blender Foundation \| durian.blender.org | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | © copyright Blender Foundation – durian.blender.org | cropped and scaled to 600×900 JPEG |
| `sintel/backdrop.jpg` | Sintel (2010) | [Blender Studio](https://studio.blender.org/projects/sintel/) | Blender Foundation (Durian open movie project) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | (c) copyright Blender Foundation \| durian.blender.org | cropped and scaled to 1920×1080 JPEG |
| `tears-of-steel/poster.jpg` | Tears of Steel (2012) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Tos-poster.png) | (CC) Blender Foundation \| Project Mango | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | (CC) Blender Foundation \| Project Mango | cropped and scaled to 600×900 JPEG |
| `tears-of-steel/backdrop.jpg` | Tears of Steel (2012) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Tears_of_Steel_frame_04_3e.jpg) | (CC) Blender Foundation \| Project Mango | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | (CC) Blender Foundation \| Project Mango | cropped and scaled to 1920×1080 JPEG |
| `cosmos-laundromat/poster.jpg` | Cosmos Laundromat: First Cycle (2015) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:CosmosLaundromatPoster.jpg) | Andy Goralczyk and the Blender Foundation | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | CC-BY 2015, Blender Foundation, cloud.blender.org | cropped and scaled to 600×900 JPEG |
| `cosmos-laundromat/backdrop.jpg` | Cosmos Laundromat: First Cycle (2015) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Franck_the_caterpillar.jpg) | Blender Foundation | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | Blender Foundation | cropped and scaled to 1920×1080 JPEG |
| `spring/poster.jpg` | Spring (2019) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Spring2019PillarPosterBlender.jpg) | Francesco Siddi | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | Blender Cloud | cropped and scaled to 600×900 JPEG |
| `spring/backdrop.jpg` | Spring (2019) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Spring-concept_art-Autumn_02.png) | Andy Goralczyk / Blender Foundation | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | Andy Goralczyk / Blender Foundation | cropped and scaled to 1920×1080 JPEG |
| `caminandes/poster.jpg` | Caminandes (2013) | [Blender Studio](https://studio.blender.org/projects/caminandes-2/gallery/?asset=2351) | Francesco Siddi / Blender Foundation | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | (CC) Blender Foundation \| studio.blender.org | cropped and scaled to 600×900 JPEG |
| `caminandes/backdrop.jpg` | Caminandes (2013) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Caminandes_gran_dillama.png) | Francesco Siddi, Pablo Vazquez | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | Francesco Siddi, Pablo Vazquez | cropped and scaled to 1920×1080 JPEG |
| `caminandes/ep1-llama-drama.jpg` | Caminandes (2013) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Pablo_Vazquez_-_Caminandes_-_Episode_1_-_Llama_Drama_-_Cover_thumbnail.png) | Pablo Vazquez, Beorn Leonard, Francesco Siddi | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | Pablo Vazquez, Beorn Leonard, Francesco Siddi | cropped and scaled to 1920×1080 JPEG |
| `caminandes/ep2-gran-dillama.jpg` | Caminandes (2013) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Blender_Foundation_-_Caminandes_-_Episode_2_-_Gran_Dillama_-_The_Earth_and_the_Sun_turn_dark_while_Koro_accidentally_electrocuted_by_an_electric_fence.png) | Blender Foundation | [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/) | Blender Foundation, caminandes.com | cropped and scaled to 1920×1080 JPEG |
| `caminandes/ep3-llamigos.jpg` | Caminandes (2013) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Blender_Foundation_-_Caminandes_-_Episode_3_-_Llamigos_-_Koro_and_Oti_share_more_food_to_eat_at_night.png) | Blender Foundation | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | Blender Foundation, caminandes.com | cropped and scaled to 1920×1080 JPEG |
| `glass-half/poster.jpg` | Glass Half (2015) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Glass_Half_-_screenshot-Min_and_Max_artwork_style.png) | Blender Foundation | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | Blender Foundation | portrait crop of a still, scaled to 600×900 JPEG |
| `glass-half/backdrop.jpg` | Glass Half (2015) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Glass_Half_-_screenshot-Min_and_Max_artwork_nature.png) | Blender Foundation | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | Blender Foundation | cropped and scaled to 1920×1080 JPEG |
| `hero/poster.jpg` | Hero (2018) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Hero_-_screenshot-hero_red.png) | Blender Foundation | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | Blender Foundation | portrait crop of a still, scaled to 600×900 JPEG |
| `hero/backdrop.jpg` | Hero (2018) | [Blender Studio](https://studio.blender.org/projects/hero/) | Daniel Martinez Lara / Blender Foundation | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | (CC) Blender Foundation \| studio.blender.org | cropped and scaled to 1920×1080 JPEG |
| `coffee-run/poster.jpg` | Coffee Run (2020) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Coffee_Run-movie_poster.png) | Hjalti Hjalmarsson (Blender Cloud) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | Hjalti Hjalmarsson (Blender Cloud) | cropped and scaled to 600×900 JPEG |
| `coffee-run/backdrop.jpg` | Coffee Run (2020) | [Blender Studio](https://studio.blender.org/projects/coffee-run/) | Blender Foundation (Coffee Run, dir. Hjalti Hjálmarsson) | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | (CC) Blender Foundation \| studio.blender.org | cropped and scaled to 1920×1080 JPEG |
| `sprite-fright/poster.jpg` | Sprite Fright (2021) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Sprite_Fright-movie_poster.jpg) | Blender Studio | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | Blender Studio | cropped and scaled to 600×900 JPEG |
| `sprite-fright/backdrop.jpg` | Sprite Fright (2021) | [Blender Studio](https://studio.blender.org/projects/sprite-fright/) | Blender Studio | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | (CC) Blender Foundation \| studio.blender.org | cropped and scaled to 1920×1080 JPEG |
| `charge/poster.jpg` | Charge (2022) | [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Charge-movie_poster.jpg) | Blender Studio | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | Blender Studio | cropped and scaled to 600×900 JPEG |
| `charge/backdrop.jpg` | Charge (2022) | [Blender Studio](https://studio.blender.org/projects/charge/) | Blender Studio | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | (CC) Blender Foundation \| studio.blender.org | cropped and scaled to 1920×1080 JPEG |
| `wing-it/poster.jpg` | Wing It! (2023) | [Blender Studio](https://studio.blender.org/blog/creating-the-poster-for-wing-it/) | Rik Schutte, Vivien Lulkowski / Blender Studio | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | (CC) Blender Foundation \| studio.blender.org | cropped and scaled to 600×900 JPEG |
| `wing-it/backdrop.jpg` | Wing It! (2023) | [Blender Studio](https://studio.blender.org/projects/wing-it/) | Blender Studio | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | (CC) Blender Foundation \| studio.blender.org | cropped and scaled to 1920×1080 JPEG |

General credit: **(CC) Blender Foundation | blender.org / studio.blender.org**.
