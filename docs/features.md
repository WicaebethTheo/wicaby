# Wicaby features in detail

The [README](../README.md) gives the short version. This page lists everything the apps do, platform by platform, plus how Wicaby treats your data. For how each part is built, see [desktop.md](desktop.md), [android.md](android.md) and [mesh.md](mesh.md).

| | Windows and Linux | Android TV | Phones and tablets |
|---|---|---|---|
| **Interface** | Electron + Svelte 5 | Jetpack Compose for TV | Compose Material 3 |
| **Player** | mpv (built-in fallback player) | Media3 ExoPlayer + FFmpeg audio + libass | Media3 ExoPlayer + FFmpeg audio + libass |
| **Runs on** | Windows 10 or 11, x64; Linux x64 with mpv 0.37+ | Android 6.0+ (Google TV, Fire TV) | Android 8.0+ |

## All platforms

- **Emby and Jellyfin.** Wicaby finds servers on your network (UDP discovery) or takes a typed address, and detects which server it is talking to.
- **Your library.** One merged Continue Watching row, Up Next and Recently Added rows, libraries with sorting and filters, search and favorites.
- **Smart playback.** Resume points, skip intro and credits (Emby chapter markers or Jellyfin media segments; optionally AniSkip, TheIntroDB and IntroDB community timestamps, off by default), and an Up Next countdown that plays the next episode.
- **Versions and tracks.** Pick between multiple versions of a title (4K / 1080p, cuts, dubs), plus audio and subtitle tracks. Your choices are remembered per title and passed to the server.
- **Player controls.** Stepped seeking, a sleep timer, quality presets, and subtitle search and download from inside the player, and "What's this song?": a button names the music playing in a film or episode with Shazam, with links to Shazam, Spotify, YouTube and Apple Music, and Play Later when the track is in your server's music (desktop with mpv; on Android for a direct play or a downloaded file).
- **HDR awareness.** Detail pages show the dynamic range (Dolby Vision with its profile, HDR10+, HDR10, HLG).
- **Live TV.** A channel guide over several days with day and time-of-day filters, channel groups and favorites, zapping by number, a channel banner and a mini-guide in the player, reminders, and recordings, including series recordings.
- **Trailers.** Local trailers play in the player without touching the film's progress. YouTube trailers play in a privacy-enhanced embed on desktop (youtube-nocookie.com) and open in YouTube or the browser on Android (as a QR code on TVs without either).
- **Comics.** A CBZ reader with two-page spreads, manga (right-to-left) order, vertical webtoon scrolling and progress synced to the server.
- **Welcome wizard.** On first launch, six short steps: language (System, Français or English), look (a theme and an accent color), where your server is (this network, an address, or remote access), sign-in, a few optional extras, and a summary. Every step can be skipped and each choice is saved at once. "Run Setup Again" in Settings (General on desktop, Interface on Android TV, About on phones) opens it again; existing installs skip it.
- **English and French** interfaces.

## Desktop (Windows)

**Playback with mpv**
- Direct play of almost any format through mpv (`gpu-next`, Direct3D 11). Hardware decoding through D3D11VA (zero-copy), with an NVDEC fallback on NVIDIA.
- **HDR:** HDR passthrough or tone mapping. Wicaby can also turn Windows HDR on for HDR and Dolby Vision titles and restore it afterwards.
- **Display:** refresh-rate matching to the content's frame rate (e.g. 24, 25, 50, 60 Hz) to remove judder.
- **Audio:** WASAPI exclusive mode and bitstream passthrough for AC3, E-AC3, DTS, DTS-HD and TrueHD. Also loudness normalization, a volume boost up to 150 %, dynamic range compression ("Reduce Loud Sounds") and dialogue enhancement.
- **Subtitles:** smart modes (forced only, foreign audio only, always). Size, font, color, position and legibility can be styled, optionally overriding ASS styling.
- **Scrubbing:** thumbnails from Emby BIF files and Jellyfin trickplay tiles.
- **Picture and speed:** aspect modes (fit, fill, stretch, zoom, original), playback speed, and a playback info overlay.
- **Your own mpv:** bring your own `mpv.conf` and extra mpv arguments, or point Wicaby at any mpv build.
- **Fallback:** a built-in player (Chromium + hls.js) for when mpv isn't installed. The server transcodes as needed.

**Library and Live TV**
- Several servers at once, with titles found on more than one server shown once ("Available on 2 servers").
- Customizable home rows, poster or thumbnail views, playlists and collections ("Add to Playlist…", "Add to Collection…").
- Configurable featured banner on Home (Settings > Home and libraries): Automatic (what you are watching, else what is new), Random, Recently Added, Continue Watching, Favorites, Top Rated or Unwatched, from chosen libraries or collections, with excluded genres, 5 to 20 titles and the time per title. Sources other than Automatic need an Emby or Jellyfin server.
- **Live TV:** the full guide, an "On now" view, recordings and scheduled recordings, series rules, and channel reordering.
- **Remote control:** other Emby/Jellyfin clients can "Play on…" Wicaby, and progress is reported to the server.

**Windows integration**
- **Look:** Mica (Windows 11 22H2 or later, on the Graphite and Light themes) and Snap Layouts (Windows 11). Themes: Graphite, OLED (pure black), Slate (cool), Cinema (warm), High Contrast, Light (media pages and the player stay dark), and Automatic (follows the system light or dark mode), with eight accent colors. On Linux, a Hyprland theme also takes its colors from the desktop: the current Omarchy theme's `colors.toml` (canvas, text, accent and named colors, light or dark), or else Hyprland's active border color as the accent over Graphite; it follows `omarchy theme set` live, and the accent picker is locked while it is on.
- **Taskbar:** thumbnail toolbar buttons, download progress, and a jump list.
- **System:** media keys and system media controls (SMTC), even with mpv.
- **Background:** close to the notification area, launch at sign-in, and notifications for finished downloads and new episodes.
- **Links:** `wicaby://item/<id>` deep links.
- **Input:** keyboard, mouse and gamepad, with spatial navigation. Keyboard shortcuts can be rebound in Settings.

## Desktop (Linux)

The same app as on Windows (x64 `.deb`, AppImage or `.tar.gz`). What differs:

- **mpv from your distribution, 0.37 or later** (the `.deb` depends on it; the AppImage and `.tar.gz` look in `PATH`). Options newer than the installed mpv are left out. Rendering uses Vulkan or OpenGL; hardware decoding through VA-API (Intel, AMD), NVDEC (NVIDIA) or Vulkan.
- **SDR only.** HDR titles are tone-mapped; the HDR switches are hidden.
- **Video in the player window:** under X11 or XWayland, mpv is embedded in an X11 window as on Windows. In a native Wayland session, libmpv renders inside Wicaby's player window, under its controls, when libmpv (`libmpv2`) is installed; otherwise mpv plays in its own window with its own controls. `WICABY_MPV_RENDER=detached` keeps mpv in its own process and window. See [desktop.md](desktop.md#linux-three-render-modes).
- **Audio:** PipeWire, PulseAudio or ALSA, with device choice, exclusive mode and passthrough (PCM fallback when the output refuses it).
- **Display:** refresh-rate matching through `xrandr` in an X11 session and `kscreen-doctor` on KDE Plasma (Wayland). Elsewhere the setting is disabled and says why.
- **Desktop integration:** media keys and desktop media controls through MPRIS, a system-tray icon (on GNOME, with the AppIndicator extension), launch at login through `~/.config/autostart`, and notifications. Notification servers show no buttons, so a click opens the item instead (a Live TV reminder tunes in).
- **Launcher:** Home, Search, Downloads and Settings actions in the desktop entry; `wicaby://` and `magnet:` links.
- **Credentials:** encrypted by the system keyring (GNOME Keyring, KWallet) through Chromium. Without one, sign-ins stay in memory until Wicaby closes, unless you choose in Settings › System to keep them on disk unencrypted.
- **Not on Linux:** Mica, the taskbar toolbar and jump list, Windows HDR switching, automatic updates (install the new package).

## Android TV

- Compose for TV interface with a floating tab bar, a hero carousel on the home screen (Settings > Interface > Home can keep watched titles out of it), and a backdrop screensaver.
- **Customizable home:** in Settings > Interface > Home, show, hide and reorder the rows (Continue Watching, Up Next, Upcoming, Live TV on now, Recently Added for every library, Because You Watched), and show each Recently Added row as posters or thumbnails.
- **Customizable tab bar:** in Settings > Interface > Tab Bar, reorder the tabs between Home and Search (libraries, Live TV, IPTV, Files, Torrents) and hide the ones you don't use.
- **Look:** Graphite, OLED (pure black), Slate, Cinema or High Contrast theme and eight accent colors, switched live in Settings > Interface > Appearance. Until a theme is chosen, Home suggests OLED or Cinema once.
- Runs on Android TV and Google TV from Android 6.0. It also installs on Fire TV, phones and tablets (landscape, touch-enabled).
- Media3 ExoPlayer with the FFmpeg audio extension and libass for styled subtitles. Image subtitles (PGS, VobSub, DVB) play in direct play.
- **Subtitle style:** size, font, color, legibility and position in Settings; size and position also from the player's track panel. An "Apply to ASS subtitles" option scales ASS text too (libass exposes only the size); off, ASS is left as authored.
- Probes the device's decoders and the TV's HDR support to build an accurate device profile. Known broken HDR combinations are excluded.
- **HDMI passthrough** per codec (AC3, E-AC3, DTS, TrueHD). It is re-checked for every playback, so it follows the TV or AV receiver currently connected.
- **Audio effects**, as on desktop: loudness normalization, a volume boost to 150 % behind a limiter, "Reduce Loud Sounds" (night mode) and dialogue enhancement. Set in Settings or from the player's Audio Effects sheet, during playback. They apply to decoded sound only; with HDMI passthrough the sheet shows them disabled and says why.
- Optional refresh-rate and resolution matching.
- Picture formats: fit, fill, stretch and zoom. Trickplay thumbnails while seeking.
- "Are you still watching?" after three episodes in a row.
- **Shuffle and play queue:** "Shuffle" on series, seasons, libraries, collections and playlists plays them as a queue that replaces Up Next; the player's queue sheet jumps to or removes an entry, and "Play next" / "Add to queue" sent from another app ("Play on") join the queue.
- **Live TV** built for the remote: the guide grid, channel up/down, number entry, the channel banner and the mini-guide, and recordings.
- **Voice search for Live TV:** the Search tab, typed or spoken, also finds channels by name or number ("France 2", "chaîne 5") and current or upcoming programmes. A channel starts playing; a programme opens the guide on it, where OK records it or sets a reminder.
- **Watch Next:** paused titles appear in the launcher's "Continue watching" row. The Wicaby rows on the launcher's home screen can be turned off in Settings.
- Trailers on a TV without a browser are shown as a QR code.
- **Item actions:** the "…" button on an item page offers "Add to Playlist…" and "Add to Collection…" (an existing one, or "New…" named with the TV keyboard) and, on an episode, "Mark Previous Episodes as Watched".
- **Several servers at once**, as on desktop: add more servers in Settings > Accounts. Home rows, search and libraries merge them, a title found on more than one server is shown once, and its page offers "Available on 2 servers" to pick the server it plays from.
- **History**, from the profile menu, as on desktop: time watched over the last 7 and 30 days, top genres, and recently played titles by day, across every signed-in server (each card names its server when there are several). A title plays again, opens its page, or is removed from the history (marked unwatched on its server).
- **A–Z jump rail** beside library grids sorted by name: LEFT from the first column opens it on the current title's letter, UP/DOWN scroll the grid live, OK or RIGHT jumps to that letter's first title, BACK returns. The server counts where each letter starts, so it jumps anywhere in a large library without loading it.
- **Music:** music rows, a now-playing screen for the remote, music that plays on in the background, and an ambient view (see [Music](#music)).
- **"Who's Watching?" profiles:** at start and from "Switch User", the server's public users with their avatars plus the accounts already signed in on this TV. A saved account opens without its password, behind an optional 4-digit PIN set in Settings > Accounts (stored salted and hashed; after 5 wrong tries each new try waits, from 30 s up to 1 h). Until the picker has opened an account the TV has no session: launcher rows, reminders, the screensaver and remote "Play" from another app wait or do nothing, and "Switch User" cannot be left with Back. A Settings option skips the picker when the TV has only one account. Emby and Jellyfin.
- **Parental access schedules** (set in the desktop admin and enforced by the server): when the server refuses sign-in or playback outside the allowed hours, the TV says so with today's hours ("Access allowed from 8:00 AM to 8:00 PM"), and the player shows the time left once access ends within 15 minutes.
- **Trakt**, as on desktop, in Settings > Trakt: your own Trakt app is authorized with a device code shown with a QR code to trakt.tv/activate. Plays are scrobbled (start, pause, stop), "Watched" set or cleared on an item page updates the Trakt history, and each server can be turned off (a server with the Trakt plugin is skipped). The client secret and tokens are sealed by the Android Keystore.
- In-app updates for sideloaded installs (see [Updates for sideloaded APKs](../apps/android/README.md#updates-for-sideloaded-apks)).

## Mobile (Android phones and tablets)

- Material 3 with the same themes as the desktop (Graphite, OLED, Slate, Cinema, High Contrast, Light, Automatic; the player and the comic reader stay dark) and eight accent colors, plus the wallpaper's color (Material You) on Android 12 and later. Phones get a bottom bar; tablets, foldables and landscape phones get a navigation rail.
- Predictive back, and posters that morph into the detail page.
- **Player gestures:**
  - double-tap to seek ±10 s;
  - drag to scrub, with trickplay previews;
  - vertical drags for brightness and volume;
  - pinch to change the picture format.
- Picture-in-Picture, and background audio with lock-screen and notification controls.
- **Live TV** with live gestures, a mini-guide sheet, a tablet guide and recordings.
- **Offline downloads** with WorkManager:
  - resumable, Wi-Fi only by default;
  - each copy keeps its streams, chapters and artwork, so intro skip works in airplane mode;
  - watch progress syncs when the network returns.
- **Several servers at once:** add more in Settings > Other Servers. Home, Libraries and Search merge them, and two libraries with the same name each show their server.
- Comic reader with swipe, pinch and double-tap zoom, and two-page spreads on tablets.
- From Android 8.0.

## Photos

Emby and Jellyfin photo libraries, and home-video libraries, open in a Photos timeline instead of a poster grid.

- **Timeline, Albums and Favourites** tabs, with month headers. Video clips show their duration and play in the player.
- **Viewer:** zoom, previous and next, favourite, and an info panel with the date taken, file name, camera, exposure (aperture, shutter speed, focal length, ISO), dimensions, altitude and, when the photo has one, its position as coordinates. Fields the server does not send are left out.
- **Slideshow:** a fade between photos, an optional Ken Burns effect, and a choice of interval; the screen stays awake while it runs.
- **On This Day:** a home row with the photos taken on today's date in earlier years.
- **Desktop:**
  - a justified timeline that stays fast with tens of thousands of photos, three thumbnail sizes (`Ctrl` + wheel, `Ctrl` `+`/`-`) and a date scrubber on the right edge;
  - keyboard: arrows to move, `Enter` to open, `F` for favourite, `S` for a slideshow from the focused photo, `I` for info;
  - a slideshow in date order or shuffled, and "Save original" to the Downloads folder;
  - **a photo map, off by default.** Turn it on in Settings > Sources. Photos with a position are grouped on OpenStreetMap tiles, fetched and cached by the app with the attribution always shown; the tile address can be changed to another service or your own tile server. Places are never looked up by name.
- **Android mobile:** pinch between three thumbnail sizes, a fast scroller with the month, swipe between photos, swipe down to close, and long-press to select photos for a slideshow or to add them to favourites.
- **Immich:** add an Immich server (2.0 or later) with its address and an API key: in Settings > Library on desktop, in Settings on Android. Its photos form their own library with the timeline, albums, People, memories and, on desktop, the map. A permission the key lacks hides that part and names it. The key stays encrypted on the device and goes only to that server, in a header.
- **Android TV:** a grid built for the remote (Page or Channel +/−, or hold Down, to jump a month), a ×2 zoom, and the slideshow on the Play/Pause key. The screensaver can show your photos, one album or "On This Day" (Settings > Screen Saver); film and show artwork stays the default.

## Music

Emby, Jellyfin, Plex and Navidrome music libraries open in a music player instead of a poster grid.

- **Music source:** Settings › Audio › Music source (desktop), Settings › Music (phone) or Settings › Playback (TV) picks the server whose music and playlists the Music section shows; Automatic keeps all of them. On Android the choice is kept per profile. A chosen server that is offline or has no music library changes nothing. On desktop, the Music page has a quick switch when several servers have music.

- **Library:** Albums (grid or list, sorts, favourite and genre filters), Artists (with an "album artists only" toggle), Songs, Genres and Playlists. Album pages show disc headers, the track count and length; artist pages add top songs and split the discography into albums and "appears on".
- **Covers:** an album the server keeps no cover for (Emby, when the only art is embedded in the tracks) shows its first track's art, and an artist without an image shows the art of one of its albums. Each is looked up once, a few at a time, and kept for the session. With no art at all, a tile shows the initials on a colour taken from the name. Album pages, the full-screen player and the TV now-playing screen take a tint from the cover.
- **Albums:** an Album, EP, Single or Compilation label (guessed from the track count and length, since Emby and Jellyfin send none), "More by" the artist under the tracks, and ▶ on each disc header. Artist pages add a similar-artists row.
- **Queue:** play next, add to queue, move, remove, clear upcoming, shuffle (turning it off restores the order), repeat all or one, and save the queue as a playlist. Every track has a menu with these actions, add to playlist, favourite, mix, and go to artist or album.
- **Mix and radio:** the server's instant mix from a song, album, artist, genre or playlist. With radio on, the queue is topped up from the last track's mix when 3 or fewer tracks are left, never with one already played.
- **Lyrics** come from the server (Jellyfin's lyrics, or an Emby `lrc` subtitle stream). Synced lyrics follow the song. When the server has none, Wicaby can look them up on LRCLIB (lrclib.net), **off by default**: turn on "Look up lyrics online (LRCLIB)" in Settings › Audio (desktop) or Settings (Android phone). It then sends the artist, title, album and length of the song to lrclib.net, shows "Lyrics from LRCLIB" under them, and keeps the answer for 30 days. Off, nothing is looked up online.
- **Loudness:** ReplayGain in album mode by default. Untagged files use the server's gain when it sends one (Jellyfin), plus the preamp. There is no crossfade.
- **Plays** are reported to your server like any other item; scrobbling to other services is left to server plugins.
- **Desktop:**
  - music plays through mpv with no window, audio only: gapless, ReplayGain, and bit-perfect output with WASAPI exclusive mode (ReplayGain off and the volume at 100 %);
  - a now-playing bar, a queue panel (drag, `Alt` + `↑`/`↓`, `Delete`), and a full-screen player with lyrics or the queue; click a lyric line to jump there, and adjust the timing per song;
  - music shortcuts, editable in Settings: `Space`, `Ctrl` + `←`/`→` for previous and next, `←`/`→` and `Shift` + `←`/`→` to seek, `↑`/`↓` volume, `M`, `S`, `R`, `L`, `Q`, `F`;
  - `Ctrl` + `L` opens the playing track's album, and `Ctrl` + `Alt` + `→`/`←` jump to the next or previous album in the queue;
  - album cards show "play next" and "add to queue" next to play on hover; click an album cover to see it full size;
  - select tracks with `Ctrl`-click or `Shift`-click, then play them, queue them or add them to a playlist from the bar that appears, or drag them onto the queue panel or a playlist in the sidebar (your audio playlists are listed there);
  - the Songs tab can show covers, plus the plays and date added on wide windows;
  - in the now-playing bar, a link to the album, the track menu on right-click, a click on the duration to show the time left, and the mouse wheel on the volume (±5);
  - the full-screen player crossfades between songs, shows the format (codec, bit depth and sample rate, bitrate), and has a third tab of similar songs; click the open tab again to hide the panel;
  - media keys, Windows media controls and a window title that follows the song;
  - the queue comes back, paused, at the next start;
  - a mini player (`Ctrl` + `Shift` + `M`, or the button in the now-playing bar): a small window that stays on top, with the art, the song and previous / play / next; it opens where you left it, and closing it brings the main window back (with "Close to Notification Area" on, the main window goes there while it is open);
  - an equalizer in Settings › Audio: Flat, Bass, Vocal, Treble or your own 10 bands, and a preamp. Flat adds no filter at all, so bit-perfect output stays bit-perfect; boosts take headroom off the preamp when "Prevent clipping" is on;
  - the built-in player is a simpler fallback: no gapless, no ReplayGain tags and no equalizer.
- **Android mobile:** a music section with five tabs, a mini player above the navigation, a full-screen now playing with lyrics, the queue and the equalizer (the same presets and 10 bands; it works on decoded audio, so it is off, and says why, while the sound goes to an amplifier in passthrough), and lock-screen and notification controls. Long-press a track on an album page to select several.
- **Android Auto** (the Google Play build only): Recent, Playlists, Albums and Artists to browse in the car; picking a song plays its album or list from there. Only Android Auto may browse the library.
- **Android TV:** music rows (recent albums, recently played, playlists, artists, genres), a now-playing screen built for the remote with queue editing (`←`/`→` to move, hold OK to remove), and music that keeps playing after Home or Back. The screen is allowed to sleep: after 2 minutes without a key it turns to an ambient view, which the screensaver also shows while music plays.

## Navidrome

On desktop (Windows and Linux), Android TV and Android mobile. Wicaby talks to Navidrome, and to other OpenSubsonic or Subsonic servers (gonic, Airsonic), through the documented Subsonic API; the label says Navidrome for all of them.

- **Adding it:** Sources › Add a Source › Navidrome (desktop), or the server address in Setup (Android): the address, then your user name and password. Wicaby checks them with the server before saving. Navidrome's default port is 4533, so type it (for example `http://nas:4533`).
- **Sign-in:** token and salt (`t = md5(password + salt)`, a new salt per request); the password itself is never sent, and is kept in the app's encrypted storage (Windows DPAPI, the Android Keystore) because the token needs it. URLs with the token never appear in logs, and on Android, images and streams are signed on the way out so cached addresses carry no credentials. An LDAP account on Navidrome refuses token sign-in: Wicaby says so and does not fall back to sending the password.
- **What works:** artists, albums, songs, genres and playlists in the music player; favourites are Navidrome's stars (on songs, albums and artists) and show in every Subsonic app; playlists can be created (also from the queue), added to, reordered and edited (only by their owner); lyrics from the server (synced with OpenSubsonic's songLyrics); mix from similar songs; plays are scrobbled to Navidrome (now playing, then one play past half the song or 4 minutes).
- **Casting:** from the desktop through the cast relay only ("Stream through this computer" in the casting settings, on by default), which signs the requests on this computer: the TV never gets the password's token. With the relay off, and on Android, casting Navidrome music is refused with a message.
- **Not supported:** videos, Live TV, the Admin panel, "Play on", renaming or deleting a playlist from Wicaby, ratings, Navidrome's saved play queue, and a server reached at another address than the one it was added with.

## IPTV (desktop)

An M3U or M3U8 channel list (Xtream-style addresses too) and an XMLTV guide, added from the Servers page or the IPTV page and watched in the Live TV pages. No server is involved: the list and the guide are fetched by the app.

- **Playback:** mpv only (the built-in player plays neither MPEG-TS nor rtsp); IPTV channels open in mpv even when the built-in player is the default. Live viewing only: no recording, no catch-up, no casting.
- **Stream addresses:** http(s) (HLS or MPEG-TS) and rtsp(s). Lines with udp, rtp, rtmp, file or other addresses are skipped; a list with nothing else is refused with a message saying so.
- **Freebox:** add `http://mafreebox.freebox.fr/freeboxtv/playlist.m3u` from a computer on the Freebox network itself (Wi-Fi or Ethernet; not from outside, not with the box in bridge mode, not behind another router). The box lists up to 4 qualities per channel (auto, HD, standard, low bitrate): Wicaby keeps one channel each, in HD when there is one, with the box's number and name ("France 2", number 2). The picture comes over UDP only: allow mpv through the firewall when Windows asks, or channels fail after about 12 s. The list has no guide ids or logos; a guide matches channels by name (for example "France 2"). Channels the box keeps for the Freebox Player (paid options) do not play.

## File sources

Videos straight from a folder, a WebDAV server or an SMB share, next to your Emby and Jellyfin servers. There is no scan and no server: Wicaby browses the folders as they are.

- **Sources:**
  - **a folder on this device**, chosen with the system picker only (never a typed path); on Android TV only when the TV has a documents picker;
  - **WebDAV** over https (or http after an explicit acknowledgement) with a user name and password: Nextcloud, Synology, QNAP, TrueNAS, `rclone serve webdav`…;
  - **SMB 2 and 3 shares.** On Windows, a `\\STORAGE\media` path with your Windows session credentials (or the ones saved in Windows Credential Manager). On Android, through a small gateway in the built-in network library (go-smb2) that listens on the device only. SMB is not available on desktop Linux yet.
- **Browsing:** folders first, then videos, in natural order (`E2` before `E10`, `Season 2` before `Season 10`), or by date modified or size. Hidden files and NAS system folders (`@eaDir`, `#recycle`…) are left out, and a folder shows at most 10,000 items.
- **What a video shows:** title, year, plot and episode numbers from its NFO file when there is one, otherwise from the file name (`S01E02`, `1x02`, dated and anime episodes). Posters, backgrounds and subtitles (`.srt`, `.ass`, `.vtt`… with language, forced and SDH) come from the files next to it. Duration and tracks are read the first time the file plays.
- **Progress** is kept on the device, per source. Each source has its own Continue row; "Show file sources on Home" (off by default) also adds files in progress to Home's Continue Watching. A file that changed since you last watched it starts again from the beginning.
- **Adding a source:** desktop in Settings or on the Servers page, Android TV in Settings, phones in Libraries. Test checks the address before saving. "Find on this network" lists WebDAV and SMB servers that announce themselves (mDNS); a reply only fills the form.
- **Security:**
  - passwords live in the app's encrypted storage (Windows DPAPI, the Android Keystore) and never appear in logs, addresses shown on screen or settings exports;
  - a self-signed WebDAV certificate is trusted only after you check its fingerprint, for that one source; a changed certificate stops playback until you decide again;
  - on desktop, WebDAV plays through a relay on this computer, so the player never sees the password.
- **Not supported yet:** search across files, downloads, casting and Trakt for file items, NFS, FTP and cloud drives. Files the device cannot decode cannot be converted.

## Plex

On desktop (Windows and Linux), Android TV and Android mobile. Wicaby is an unofficial client, not affiliated with or endorsed by Plex. It talks to Plex Media Server through its documented HTTP API.

- **Linking:** Servers › Plex account › Link with a code. Enter the code at plex.tv/link or scan the QR code; there is no password form. Your servers and the ones shared with you are added; shared servers show by default with their owner, and each one can be hidden (it stays stored). The list is cached, so startup never waits on plex.tv.
- **Profiles:** Plex Home users appear in the profile picker. A protected profile always asks for its PIN.
- **Connections:** Wicaby tries the addresses plex.tv lists, local first, then remote, then Plex's relay (shown with a badge; Plex limits its bandwidth). A server that requires secure connections is never reached over http, and an unencrypted local address gets your Plex access only after you confirm it.
- **Tokens:** the account token goes only to plex.tv. Each server gets only its own access token, kept in the encrypted vault and sent in a header, never in an address.
- **What works:**
  - Home rows from the server's own hubs, libraries with sorting and filters, search, shows (also with seasons hidden), editions, Continue Watching and Up Next;
  - played and unplayed, playlists and collections, and your plex.tv watchlist as Favorites;
  - music libraries in the music player, photo libraries in Photos, trailers and extras, downloads when the server allows them;
  - for the server owner, "Refresh metadata" in the item menu; everything else stays in Plex Web.
- **Playback:**
  - the server decides for every quality: direct play when this device can, otherwise conversion to HLS, which starts at your resume point;
  - multi-part films play as one queue; a missing file is hidden;
  - audio and subtitle choices are saved to Plex too, so other Plex apps agree;
  - progress goes to Plex with exactly one stop report, so history has no duplicates; a server that ends the stream shows its reason;
  - Skip intro and credits from Plex markers, and BIF trickplay thumbnails;
  - casting to a Chromecast, or to a DLNA TV for files it plays as they are, through the cast relay, so the token never leaves this computer.
- **On Android TV and mobile:** the same linking (a QR code on TV, a link screen on mobile), Home profiles with their PIN, connections, browsing and playback as above. Tokens stay in the Android Keystore-backed storage. On mobile, downloads only when the server allows them. Casting a Plex item and "Play on" are not available on Android yet.
- **Live TV and DVR:** the guide, tuning, recordings and series recordings, in the usual Live TV screens, when the server owner has a Plex Pass and a DVR with a tuner. It follows Plex's public documentation and has not yet been tried with a real Plex tuner.
- **Not supported:** the Admin panel, "Play on" and remote control of Plex sessions (Wicaby is not a Plex player target), mix and radio, subtitle search, comics, cinema intros (prerolls), Wake-on-LAN and access schedules. A request Wicaby cannot translate fails with a clear error, never a wrong answer.
- **Plex Pass.** Wicaby detects these gates and explains them; it never works around them.
  - Playing away from the server's network needs a Plex Pass (yours or the owner's) or a Remote Watch Pass. On the server's network it still works.
  - Live TV and DVR, intro and credits detection (so the Skip intro button) and hardware transcoding need a Plex Pass on the server owner's account.
  - When a remote quality is over the account's limit, Wicaby retries once at the limit, then asks for a lower quality.

## Casting and "Play on"

Windows and phones have one Cast button. It opens a single list with three sections: other apps, DLNA TVs and players, then Chromecast and Google TV. Android TV only receives. **AirPlay is not supported.**

- **Apps ("Play on").** Other Wicaby apps, the official Emby and Jellyfin apps, and the devices your server exposes as sessions (including DLNA TVs it found itself). While a title plays elsewhere, a remote offers play/pause, seeking, volume, and audio and subtitle tracks when the device supports them, and "Play here" brings the title back at the same position.
- **Receiving "Play on".** Windows, Android TV and phones can all be driven from another app. A phone in the background asks first with a notification, which expires after 60 s.
- **DLNA/UPnP** (Windows and phones). TVs and players found on the local network, one title at a time. On Windows, the stream goes through this computer by default ("Stream through this computer"), so the TV never receives your access token. The first cast can trigger a Windows Defender Firewall prompt: allow it, or the TV can't reach the computer and the cast stops with an explanation.
- **Chromecast and Google TV.**
  - Windows: built in, over the open Cast protocol. Jellyfin titles open Jellyfin's own receiver app; Emby titles play in the default media receiver, with subtitles.
  - Android: only in the Cast build (`Wicaby-Mobile-Cast-*`, the `gplay` flavour), through Google Play services. The default build contains no Google code and has no Chromecast section; the Cast build has no FFmpeg audio decoder, so the server converts those audio formats.
- **Live TV.** Channels go only to apps, which tune them themselves.
- **Short-lived tokens on Jellyfin.** When Quick Connect is enabled on the server, a TV or Chromecast that needs a token gets a disposable one, revoked when the cast ends.
- **Android 17.** Wicaby asks for the local network permission before it looks for servers or TVs on your network. Remote servers (https, remote access) work without it.
- DLNA and UPnP are trademarks of their respective owners; Wicaby is not certified.

## Server admin (desktop)

When you are an administrator, Wicaby includes a full administration area. You don't need to open the server's web dashboard.

- **Dashboard:** server version, now playing, active devices, and restart or shutdown.
- **Activity log** with filters.
- **Users:** create users (copying permissions from an existing account), then manage profile, role, remote access, playback limits, library and channel access, parental controls, Live TV and deletion rights.
- **Devices.**
- **Libraries:** add, edit and monitor libraries, with a server-side folder browser.
- **Scheduled tasks:** run or stop tasks and edit their triggers.
- **Transcoding** settings, with the server's hardware codec information.
- **Server settings:** general and network settings, with a restart banner when one is needed.
- **Plugins:** enable, disable or uninstall, and manage repositories.
- **API keys:** create and revoke.
- **Server logs** viewer.
- **Per-item tools:** edit metadata, identify, manage images, refresh metadata, search subtitles, and delete from the server.

## Remote access

Wicaby can reach your server away from home over **Tailscale** or **NetBird**, without installing either app. The setup guide is [remote-access.md](remote-access.md); the design is in [mesh.md](mesh.md).

- **How it works.** The Tailscale (`tsnet`) and NetBird (`client/embed`) clients are compiled into Wicaby: on Windows in a small helper (`wicaby-mesh.exe`), on Android in a native library. They run in userspace: no system VPN, no virtual network adapter, no routing changes.
- **One node, one purpose.** Wicaby joins your network as a device of its own and only uses it to reach your media server. The helper exposes nothing but token-protected loopback forwarders to the servers Wicaby asks for.
- **Signing in.** On Windows, in your browser. On Android TV, by scanning a QR code with your phone. Self-hosted control servers (Headscale on Android, self-hosted NetBird on both) and keys (a Tailscale auth key on Android, a NetBird setup key on both) are under advanced options.
- **Finding the server.** Wicaby lists the devices on your network; "Find Servers" probes the online ones for a media server on ports 8096 and 8920. It only runs when you ask.
- **Remote access page** (Settings > Remote Access on every platform, also linked from the desktop's connection popover): status and last error, this device's name and address, the devices on your network with online ones first, routed networks (NetBird), signing out, and switching between Tailscale and NetBird. "Copy Diagnostics" copies a report with every address, key, sign-in code and private host name hidden; Android TV shows it as a QR code to scan with a phone.
- **Already use the app?** On Windows, Wicaby also detects an installed Tailscale or NetBird client and can use that instead; it is listed under Advanced on the Remote access page. Bitrate limits are separate for local and remote connections.
- **Android version.** Remote access needs Android 8.0 or later. On an older TV the app works, without the built-in remote access.

## Downloads and torrents

- **Offline mode** (desktop and mobile):
  - original files are downloaded in a queue and resume after interruptions (HTTP Range);
  - Wicaby switches to your downloads when the server can't be reached;
  - progress made offline syncs back later.
- **qBittorrent** (desktop, Android TV and mobile): monitor and control your qBittorrent through its Web UI.
- **Desktop-only extras:**
  - speeds, queue order, alternative speed limits, sequential download and categories;
  - add magnet links and `.torrent` files by drag and drop;
  - open magnet links from the browser, with a confirmation;
  - link categories to libraries, so a finished torrent triggers a library scan.

## Privacy

- **No telemetry, no analytics, no crash reporting.** Wicaby talks only to:
  - your servers;
  - plex.tv, only when you link a Plex account (sign-in, your server list, the watchlist);
  - the services you choose to use: Emby Connect, your qBittorrent, Tailscale or NetBird, and the update URL you configure;
  - YouTube (youtube-nocookie.com), only when you play a YouTube trailer on desktop.
  - the map tile service (OpenStreetMap by default), only after you turn the photo map on (desktop). It sees which areas you look at, not your photos.
  - LRCLIB (lrclib.net), only after you turn on online lyrics, and only for a song your server has no lyrics for. It sees the artist, title, album and length of that song.
  - TheIntroDB (api.theintrodb.org) and IntroDB (api.introdb.app), only after you turn on "Community timestamps" in Settings › Playback, and only for a movie or episode your server lacks skip markers for. They see that title's TMDB, TVDB or IMDb id and the season and episode numbers (the TV web app asks TheIntroDB only).
  - Shazam (amp.shazam.com), only when you press "What's this song?" in the player (a notice says so the first time). It receives an audio fingerprint of about 12 seconds (frequency peaks, not the sound) and a fixed, made-up location; the cover art comes from Apple's image server.
- **Tailscale log upload is disabled.** The embedded node sets `TS_NO_LOGS_NO_SUPPORT`, so no diagnostics go to Tailscale's log servers.
- **Tokens stay protected.**
  - Windows: access tokens are encrypted with DPAPI and never reach the UI process. mpv gets them in an HTTP header, not in stream URLs.
  - Linux: the same, encrypted by the system keyring; without one they are kept in memory only unless you choose otherwise.
  - Android: tokens are encrypted with an Android Keystore key.
- **Casting to a Chromecast (desktop):** Wicaby cannot check that a device on your network really is a Chromecast (only Google's own SDK authenticates devices). A device pretending to be one would receive what a Chromecast receives: a stream address through this computer's relay, which carries no token, or, for the Jellyfin receiver app, your server's address and an access token, as Jellyfin's own web app sends.
- **Casting from a phone:** a DLNA TV or a Chromecast fetches the stream from your server itself, so its address carries a token: a disposable one on Jellyfin with Quick Connect enabled, otherwise your access token. On Windows, the relay keeps the token on the computer.
- **Local data:** logs stay on your device (the last 7 daily log files on Windows) and can be cleared from Settings › System.

## Screenshots and the demo

Every image in the README comes from the mock servers in `tools/mock-server`: the demo dataset (Blender Foundation open movies, CC BY), an IPTV-scale Live TV, generated photos, invented music made of silence, the Navidrome mock, and the Plex mock (a fake plex.tv and Plex Media Server). No real server was used, and nothing plays during the captures. Every shot shows the same moment, Friday 9 October at 20:30, so the clocks, the guide and the end times never tell when it was taken, and no image carries metadata (text chunks, EXIF, C2PA). To regenerate them:

- `node tools/screenshots/desktop.mjs`: the desktop screenshots (`SHOTS_CLOCK` sets another moment);
- `node tools/screenshots/desktop.mjs --frames`: the animated demo (`docs/screenshots/demo.webp`), assembled by the bundled mpv;
- `powershell -File tools/screenshots/android.ps1`: the Android TV and phone screenshots, on one emulator at a time, with its clock set to the same moment (`-Clock`);
- `node tools/screenshots/strip-metadata.mjs`: strips metadata from the images in `docs/screenshots` (both scripts run it; `npm run checks` fails if an image still carries any).
