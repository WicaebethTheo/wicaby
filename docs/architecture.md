# Wicaby : architecture

Wicaby est un shell natif léger autour d'une UI web, avec un lecteur natif mpv sous l'interface :

| Couche | Wicaby |
|---|---|
| Shell | Electron 44 (Chromium + Node 22) |
| Vue web | BrowserWindow sur `app://wicaby` |
| UI | Svelte 5 + Vite |
| Pont JS ↔ natif | IPC typé (`contextBridge`), contrat partagé `src/shared/contract.ts` |
| Lecture | `mpv.exe` en processus enfant, IPC JSON sur pipe nommé |
| Serveurs | Emby **et** Jellyfin |
| Hors ligne | File client avec reprise HTTP Range, magasin JSON |

Ce document décrit l'application de bureau. Ses chemins `src/…` sont relatifs à `apps/desktop/`.

## Organisation du dépôt

Monorepo npm (workspaces) : la racine délègue `dev`, `build`, `check` et `dist` à `apps/desktop`, et `npm run checks` lance les auto-tests de `tools/checks`.

```
wicaby/
├─ apps/
│  ├─ desktop/            application Electron (Windows, Linux)
│  │  ├─ src/             main/, preload/, renderer/ (Svelte 5), shared/ (contrat IPC, modèles)
│  │  ├─ native/          mpv-render : module natif Linux (libmpv dans la fenêtre sous Wayland)
│  │  ├─ scripts/         build-main, build-native, dev, fetch-mpv, cdp
│  │  ├─ resources/       icônes
│  │  └─ electron-builder.yml, vite.config.ts, svelte.config.js, tsconfig*.json
│  └─ android/            projet Gradle : :core, :mesh-ui, :tv (Android TV), :mobile
├─ packages/
│  └─ mesh/               nœud Tailscale/NetBird embarqué (Go) : cmd/wicaby-mesh, mesh/, mobile/ (gomobile),
│                         scripts/build-vpn-helper.mjs et scripts/build-mesh-aar.ps1
├─ tools/
│  ├─ mock-server/        mock-emby, mock-jellyfin, mock-qbittorrent, mock-trakt, mock-admin/, cbz-fixture
│  ├─ checks/             *-check.mjs, *-selfcheck.mjs et run-all.mjs (npm run checks)
│  └─ release/            make-update-manifest.mjs (update.json des applis Android)
├─ brand/                 logo et icônes, scripts/make-brand.mjs et make-icon.mjs (npm run icon)
├─ docs/                  architecture, design, i18n, android
├─ vendor/                hors git : mpv/ (npm run fetch-mpv), vpn-helper/ (npm run build:mesh),
│                         android/wicaby-mesh.aar (npm run build:mesh-aar)
└─ release/               hors git : sorties d'electron-builder et APK publiés
```

En développement, Wicaby cherche `mpv.exe` et `wicaby-mesh.exe` dans `vendor/` à la racine du dépôt ; une fois empaqueté, dans `resources/mpv` et `resources/vpn-helper`.

---

## 1. Vue d'ensemble

```
+-----------------------------------------------------------------------------------+
| Wicaby.exe  (Electron main, Node 22, instance unique, AppUserModelID com.wika.wicaby)|
|                                                                                   |
|  index.ts : racine de composition                                                 |
|   │                                                                               |
|   ├─ WindowManager ───────────────────────────────────────────────────────────┐  |
|   │   Fenêtre principale  (Mica, titleBarOverlay = boutons natifs + Snap)      │  |
|   │     app://wicaby/index.html  ── CSP stricte, sandbox, contextIsolation     │  |
|   │     ┌──────────────────────────────────────────────┐                       │  |
|   │     │ UI Svelte 5 (routes, stores $state, router)  │                       │  |
|   │     │ <video> + hls.js (lecteur de secours)        │                       │  |
|   │     └──────────────┬───────────────────────────────┘                       │  |
|   │                    │ window.wicaby  (preload/index.ts, contextBridge)      │  |
|   │                    │ ipcRenderer.invoke / on   ◄── validé par ipc.ts       │  |
|   │                                                                            │  |
|   │   Lecture mpv : deux fenêtres                                              │  |
|   │     video (opaque, HWND → mpv --wid)                                       │  |
|   │       └─ osd (transparente, possédée par video) : même UI, route #/osd     │  |
|   └────────────────────────────────────────────────────────────────────────────┘  |
|                                                                                   |
|   ├─ ConnectionManager ── ApiClient (net.fetch) ── ServerSocket (WebSocket)       |
|   │      CredentialVault (safeStorage / DPAPI)    discovery.ts (UDP 7359, WoL)    |
|   │      emby-connect.ts (connect.emby.media)                                     |
|   ├─ PlaybackService ── MpvPlayer ── MpvController ── mpv.exe (\\.\pipe\wicaby-mpv-…)|
|   │                  └─ HtmlPlayer (adaptateur vers le <video> du renderer)       |
|   ├─ DownloadManager (Range, .part, affiches, file de progression hors ligne)      |
|   ├─ protocols.ts : app://wicaby (UI)   wicaby-media://api|local|poster (médias)  |
|   └─ features : DisplayModeSwitcher (PowerShell + user32), taskbar (thumbar,      |
|                 progression, jump list), powerSaveBlocker, notifications          |
+-----------------------------------------------------------------------------------+
        │ UDP 7359 (Emby + Jellyfin)    │ HTTP(S) API + médias     │ WebSocket
        ▼                               ▼                          ▼
                  Serveur Emby (/emby/…) ou Jellyfin (/…), LAN ou distant
```

Comme Emby, le natif fait ce que le navigateur ne sait pas faire : lecture mpv, fréquence d'affichage, téléchargements en arrière-plan, contrôles système, intégration à la barre des tâches. Différence de fond : la logique métier côté serveur (connexion, lecture, rapports, téléchargements) vit dans le main. L'UI n'est qu'une vue ; elle ne voit jamais un jeton.

---

## 2. Démarrage

1. `registerSchemes()` déclare `app` et `wicaby-media` comme schémas privilégiés (avant `ready`). Suivent `setAppUserModelId` et la suppression du menu.
2. `requestSingleInstanceLock()`. Une deuxième instance transmet ses arguments (`--wicaby-nav=/route` depuis la jump list, `wicaby://item/<id>`) puis se ferme.
3. `bootstrap()` crée les services :
   - logs ;
   - `SettingsService` ;
   - `device.json` (DeviceId) ;
   - `CredentialVault` et `ConnectionManager` ;
   - `WindowManager` et `DownloadManager` ;
   - `DisplayModeSwitcher` ;
   - recherche de mpv (`locateMpv`) et modèle `mpv.conf` ;
   - `PlaybackService`.
4. `handleProtocols()`, puis les gestionnaires de permissions (tout est refusé sauf `fullscreen` et `clipboard-sanitized-write`), puis `registerIpc()`.
5. Les événements des services sont relayés aux fenêtres (`session:changed`, `settings:changed`, `playback:state`, `downloads:changed`, `events:server`, `events:toast`).
6. `createMain()` charge `app://wicaby/index.html?mica=1#/`. Le renderer appelle `initStores()` (lecture initiale de la session, des réglages, de la lecture et des téléchargements, plus abonnements aux événements).
7. `resumeLastSession()` :
   - la session passe à `connecting` ;
   - course des adresses connues (dernière, manuelle, locale, distante) ;
   - validation du jeton stocké (`GET /Users/{id}`) ;
   - session `signed-in` ;
   - `POST /Sessions/Capabilities/Full` ;
   - ouverture du WebSocket.
8. Le garde de routes du renderer dirige vers `/servers`, `/login`, `/home` ou `/downloads` (hors ligne).

---

## 3. Contrat IPC

Toutes les signatures sont dans `src/shared/contract.ts` (`WicabyBridge`, `Channels`). Le preload enveloppe `ipcRenderer.invoke` et nettoie les messages d'erreur. `ipc.ts` rejette tout appel dont `senderFrame.url` n'est pas une page Wicaby, puis valide les types et les tailles des arguments.

| Domaine | Méthodes |
|---|---|
| `app` | `info`, `quit`, `openExternal` (http/https seulement), `openPath(logs \| downloads \| mpv-config)`, `log` |
| `window` | `minimize`, `toggleMaximize`, `close`, `toggleFullscreen`, `getState`, `onState`. Depuis l'OSD : minimise la fenêtre vidéo, et fermer arrête la lecture. |
| `settings` | `get`, `update` (fusion profonde + assainissement), `pickFolder`, `pickMpv`, `onChange` |
| `servers` | `discover`, `list`, `add`, `embyConnect`, `select`, `remove`, `wake` |
| `session` | `get`, `publicUsers`, `login`, `logout`, `disconnect`, `onChange` |
| `api` | `get`, `post`, `del` : proxy vers le serveur actif. Chemin relatif obligatoire ; un 401 déconnecte. |
| `playback` | `play(PlayRequest)`, `command(PlaybackCommand)`, `getState`, `onState` |
| `htmlPlayer` | `onLoad`, `onCommand`, `emit` (accepté uniquement depuis la fenêtre principale) |
| `downloads` | `list`, `add`, `pause`, `resume`, `remove`, `reveal`, `onChange` |
| `events` | `onServerEvent`, `onNavigate`, `onToast` |

Le protocole `wicaby-media://` remplace les URL `?api_key=` :

- `wicaby-media://api/<chemin>` : le main ajoute le préfixe `/emby` si besoin et l'en-tête d'authentification, transmet `Range`, et ajoute le CORS pour hls.js. Sert les images, les flux et les sous-titres.
- `wicaby-media://local/<id>` et `wicaby-media://poster/<id>` : fichiers téléchargés, servis avec support des plages (206).

---

## 4. Lecture

1. L'UI appelle `playback.play({ itemIds, startIndex, startPositionTicks, … })`. Pour un épisode, `playQueueFor()` met en file toute la série.
2. `PlaybackService.startItem()` :
   - **Fichier local** : si l'élément est téléchargé, il est lu directement (chemin pour mpv, `wicaby-media://local` pour `<video>`).
   - **Lecteur** : `auto` choisit mpv s'il est trouvé, sinon `<video>`.
   - **Pistes** : choix selon la langue préférée, puis le défaut du serveur, puis le mode sous-titres.
   - **Négociation** : `POST /Items/{id}/PlaybackInfo` avec le `DeviceProfile` du lecteur. Pour mpv, tout est en lecture directe. Pour `<video>`, MP4/WebM direct et HLS sinon ; une piste audio autre que celle par défaut force le remux.
   - **URL** : lecture directe via `/Videos/{id}/stream?Static=true`, sinon `TranscodingUrl`. Les sous-titres externes passent par `DeliveryUrl`.
3. `ensurePlayer()` :
   - **mpv** :
     - `createPlaybackWindows()` crée les fenêtres vidéo et OSD ;
     - lancement de `mpv.exe --wid=<HWND> --input-ipc-server=\\.\pipe\wicaby-mpv-<uuid> --vo=gpu-next --gpu-api=d3d11 --hwdec=… --ao=wasapi …` ;
     - jeton envoyé par `http-header-fields` ;
     - l'OSD est la fenêtre maîtresse : la vidéo suit ses déplacements et son redimensionnement, et le focus lui revient.
     - sous Linux en session Wayland native, `--wid` est impossible (pas de fenêtre X11) : avec le module `native/mpv-render`, libmpv tourne dans le main et rend dans des tampons GPU (dma-buf) qu'une seule fenêtre dessine sous l'OSD (mode `texture`, SDR seulement, sans la commande mpv pour la vidéo) ; sans module, sans libmpv, sans nœud de rendu utilisable ou avec l'accélération GPU désactivée, mpv s'ouvre dans sa propre fenêtre (`detached`). `WICABY_MPV_RENDER=detached` force la fenêtre de mpv ; `texture` est déjà le choix par défaut et ne passe pas outre un échec de la sonde. Une erreur fatale du rendu en mode `texture` relance l'élément une fois en `detached`, gardé pour le reste de la session. Détails dans [desktop.md](desktop.md#linux-three-render-modes).
   - **HTML** : la fenêtre principale bascule sur `#/player`, qui charge le flux via hls.js ou `src` et renvoie `time`, `ended` et `error`.
4. Pistes avec mpv : après `file-loaded`, la `track-list` est mise en correspondance par `ff-index` avec les index du serveur. Les sous-titres externes sont ajoutés à la demande (`sub-add`). Quand mpv ou `<video>` ne peut pas changer de piste seul (transcodage, audio en HTML), le flux redémarre à la même position.
5. Rapports au serveur :
   - `Sessions/Playing` au démarrage ;
   - `Sessions/Playing/Progress` toutes les 10 s et à chaque pause, saut ou changement de piste ;
   - `Sessions/Playing/Stopped` à l'arrêt, plus `DELETE /Videos/ActiveEncodings` après un transcodage.
6. Autour de la lecture :
   - `powerSaveBlocker` ;
   - fréquence d'affichage adaptée puis restaurée ;
   - boutons de miniature (précédent, lecture/pause, suivant) ;
   - à la fin, épisode suivant si la lecture auto est activée.
7. Télécommande : les messages WebSocket `Play`, `Playstate` et `GeneralCommand` sont traduits en commandes. `DisplayMessage`, `DisplayContent` et `GoHome` sont gérés par l'UI.

---

## 5. Hors ligne

- `downloads.add(ids)` développe les dossiers (série, saison, collection) en éléments jouables et met en file un enregistrement par élément avec son `BaseItem` complet, pour la navigation hors ligne.
- La file traite `maxConcurrent` téléchargements à la fois, sur le serveur actif :
  - `GET /Items/{id}/Download` vers `<fichier>.part` ;
  - reprise avec `Range: bytes=n-` (206) ;
  - puis renommage du fichier et téléchargement de l'affiche (`.poster.jpg`) ;
  - notification Windows à la fin.
- La progression agrégée s'affiche dans la barre des tâches. Les téléchargements interrompus par une fermeture repassent en `queued` au démarrage.
- Si aucune adresse ne répond, la session passe `offline` et l'UI bascule sur la page Téléchargements.
- La lecture hors ligne enregistre position et statut « vu » (seuil de 90 %) dans `pending`. Ils sont envoyés au serveur dès que la session redevient `signed-in`.

---

## 5 bis. Multi-serveur

Wicaby peut être connecté en même temps à plusieurs serveurs Emby et Jellyfin, et mélange leurs contenus.

**Main**

- `ConnectionManager` tient une session par serveur (`Map` par `serverId`). Chaque session a :
  - son `ApiClient`, son utilisateur et son WebSocket ;
  - son état propre (`connecting`, `server-selected`, `signed-in`, `offline`).
- Le **serveur principal** (`activeId` dans `servers.json`) sert aux appels sans `serverId` : jump list, `wicaby://item/<id>`, anciennes routes. Il ne change pas quand on ajoute un serveur, sauf s'il n'est plus connecté.
- `SessionState` garde ses champs historiques, qui décrivent le serveur principal. `sessions[]` liste toutes les sessions. L'état global vaut `signed-in` dès qu'une session est connectée.
- Au démarrage, `resumeSessions()` relance en parallèle toutes les sessions enregistrées (`activeIds`). Un serveur éteint passe `offline` sans bloquer les autres.
- Les jetons restent dans le coffre, un par serveur.
- Le transfert mesh (`setAddressRoute`) est déjà indexé par adresse, donc il couvre déjà plusieurs serveurs.

**Adressage.** Tout ce qui touche un serveur précise son `serverId` ; sans lui, c'est le serveur principal qui répond.

- IPC : `api.get(path, query, serverId?)`, `session.login(user, pw, serverId?)`, `downloads.add(ids, serverId?)`, `comics.open(id, serverId?)`.
- Protocole : `wicaby-media://api/<serverId>/<chemin>`. L'ancienne forme `wicaby-media://api/<chemin>` vise toujours le serveur principal. Les BD : `wicaby-media://comic/<serverId>/<itemId>/<page>`.
- Lecture : `PlayRequest.serverId`. La file, les rapports, le ping, les marqueurs et l'épisode suivant passent par ce serveur. Une commande `Play` reçue par WebSocket lit sur le serveur qui l'a envoyée.
- Les téléchargements (`serverId:itemId`), la progression hors ligne et les liens catégorie → bibliothèque des torrents enregistrent déjà le serveur. Chaque serveur connecté fait avancer sa propre file.

**Renderer**

- Le proxy GET en cache (`lib/api.ts`) inscrit `ServerId` sur chaque élément reçu. Un élément connaît donc toujours son serveur.
- La clé d'identité est `itemKey(item) = <serverId>:<itemId>`. Elle sert aux clés Svelte, aux caches et aux noms de view transition.
- Les routes sont `/item/<serverId>/<itemId>`, `/library/<serverId>/<id>` et `/read/<serverId>/<id>`. Une route à un seul segment vise le serveur principal.
- `apiFor(serverId)` renvoie les appels d'un serveur ; `api` reste celui du serveur principal.
- Accueil :
  - « Continuer », « À suivre » et « Favoris » fusionnent les serveurs et sont triés par date de dernière lecture ;
  - « Nouveautés » garde une rangée par bibliothèque, avec le nom du serveur quand le nom de la bibliothèque est ambigu.
- La recherche et les favoris interrogent tous les serveurs en parallèle.
- Barre latérale : les bibliothèques sont groupées sous un petit titre de serveur dès que plus d'un serveur est connecté. Avec un seul serveur, rien ne change.
- **Doublons** : un film ou une série présent sur plusieurs serveurs (même identifiant Imdb, Tmdb ou Tvdb) n'apparaît qu'une fois dans les rangées fusionnées. La fiche propose « Disponible sur N serveurs » pour choisir le serveur.

---

## 6. Corrections et améliorations par rapport à Emby

**Sécurité**

- **Pas de port CDP.** Emby lançait WebView2 avec `--remote-debugging-port=9321` sans condition, ce qui permettait à n'importe quel processus local d'exécuter du JS avec tous les objets `Native*`. Wicaby n'ouvre aucun port. Les DevTools ne sont actifs qu'en dev ou avec `WICABY_DEVTOOLS=1`.
- **Pas de `--disable-web-security`**, ni d'assouplissement du réseau privé, ni de CORS `*` sur l'origine de l'UI.
- **Coffre DPAPI** pour les jetons (`safeStorage`), au lieu de JSON en clair dans LocalSettings.
- **Jetons absents du renderer** : API par IPC, médias par `wicaby-media://`. Une XSS dans l'UI ne peut pas exfiltrer un jeton, d'autant que la CSP ferme `connect-src`.
- **IPC typé et validé** : contrôle de l'expéditeur, des types et des tailles. Il n'y a plus de canal synchrone `window.prompt()`.
- **Origine `app://wicaby`** avec CSP en en-tête, au lieu de `file://`. La navigation hors de l'application est bloquée, et `window.open` ne s'ouvre dans le navigateur que pour du http(s).
- **Isolation** : `sandbox`, `contextIsolation`, pas de `nodeIntegration`, permissions web refusées.
- **Authentification mpv par en-tête** (`X-Emby-Token` ou `Authorization: MediaBrowser Token=…`), sans `api_key` dans les URL de flux.

**Lecture et serveurs**

- **Emby et Jellyfin** : détection par `ProductName`, préfixe `/emby` et en-têtes d'authentification adaptés, deux sondes de découverte. Emby Theater rejetait les serveurs contenant « jell ».
- **mpv isolé** dans un processus enfant : un crash du décodeur ne fait pas tomber l'application, et on peut remplacer mpv par n'importe quelle build (`npm run fetch-mpv`, Scoop, chemin manuel). `mpv.conf` personnel en option. Exception : le mode `texture` sous Wayland charge libmpv dans le main, sans cette isolation (`WICABY_MPV_RENDER=detached` la rétablit).
- **Fréquence d'affichage sans module natif** : script `Add-Type` vers `ChangeDisplaySettingsExW`, choix d'un multiple exact (23.976 → 24, 48, 120 Hz…), restauration à l'arrêt.
- **Téléchargements sans Premiere** : file côté client avec reprise, compatible avec les deux serveurs.
- **Télécommande** complète (Play, PlayNext, PlayLast, Playstate, volume, pistes, plein écran) et **synchronisation de la progression hors ligne**.

**Intégration Windows**

- Boutons de miniature, progression des téléchargements, jump list (Accueil, Rechercher, Téléchargements, Paramètres).
- **SMTC avec mpv** : la Media Session de Chromium est alimentée par l'OSD. Touches multimédia, overlay volume et écran de verrouillage fonctionnent.
- **Snap Layouts** (boutons natifs via `titleBarOverlay`), **Mica** sous Windows 11, thème OLED noir pur.

---

## 7. Limites connues / à faire

- **HDR Windows** : `features/hdr-mode.ts` active le HDR de Windows au lancement d'un titre HDR/DV (réglage `hdrAutoSwitch`, PowerShell `Add-Type` vers `DisplayConfigSetDeviceInfo`) et le restaure à l'arrêt ou au démarrage suivant après un crash (`hdr-restore.json`). Un basculement fait par l'utilisateur pendant la lecture n'est pris en compte qu'au fichier suivant.
- **Fenêtre OSD transparente** : le redimensionnement par les bords est moins fiable qu'une fenêtre opaque. Le plein écran, l'agrandissement et le magnétisme fonctionnent.
- **Lecteur intégré** : la prise en charge du MKV par Chromium est partielle, et le changement d'audio impose un remux serveur.
- **Fonctions absentes** :
  - mise à jour automatique (electron-updater non branché) ;
  - guide TV en direct et enregistrements ;
  - tableau de bord d'administration du serveur (le web client du serveur reste disponible) ;
  - lecteurs livres, photos et jeux.
- **Téléchargements** : les sous-titres externes ne sont pas téléchargés ; seules les pistes intégrées au fichier sont disponibles hors ligne.
