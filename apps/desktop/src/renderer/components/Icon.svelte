<script lang="ts" module>
  // Lucide icons behind Wicaby's stable `name` API. Namespace access keeps the
  // build tree-shaken, so adding an icon is one line: `name: L.Component`.
  // Icons are static, monochrome glyphs (they take currentColor): no hover
  // motion, no colour of their own. The colour comes from the surrounding text.
  import * as L from '@lucide/svelte';
  import type { Component } from 'svelte';

  type Glyph = Component<L.LucideProps>;

  const ICONS = {
    home: L.House,
    search: L.Search,
    heart: L.Heart,
    download: L.Download,
    settings: L.Settings,
    film: L.Film,
    tv: L.Tv,
    cast: L.Cast,
    laptop: L.Laptop,
    music: L.Music,
    folder: L.Folder,
    book: L.BookOpen,
    collection: L.Layers,
    live: L.Radio,
    play: L.Play,
    pause: L.Pause,
    next: L.SkipForward,
    prev: L.SkipBack,
    back10: L.RotateCcw,
    fwd30: L.RotateCw,
    volume: L.Volume2,
    mute: L.VolumeX,
    speaker: L.Speaker,
    speakerGroup: L.AudioLines,
    calendar: L.Calendar,
    subtitles: L.Captions,
    audio: L.AudioLines,
    fullscreen: L.Maximize,
    pip: L.PictureInPicture2,
    exitFullscreen: L.Minimize,
    aspect: L.Ratio,
    close: L.X,
    minimize: L.Minus,
    chevronLeft: L.ChevronLeft,
    chevronRight: L.ChevronRight,
    chevronDown: L.ChevronDown,
    arrowLeft: L.ArrowLeft,
    arrowRight: L.ArrowRight,
    check: L.Check,
    plus: L.Plus,
    trash: L.Trash,
    pauseCircle: L.CirclePause,
    refresh: L.RefreshCw,
    server: L.Server,
    user: L.User,
    logout: L.LogOut,
    wifiOff: L.WifiOff,
    wifi: L.Wifi,
    power: L.Power,
    star: L.Star,
    info: L.Info,
    gauge: L.Gauge,
    speed: L.Gauge,
    sidebar: L.PanelLeft,
    externalLink: L.ExternalLink,
    folderOpen: L.FolderOpen,
    list: L.List,
    grid: L.LayoutGrid,
    sort: L.ArrowUpDown,
    filter: L.ListFilter,
    eye: L.Eye,
    gamepad: L.Gamepad2,
    globe: L.Globe,
    lock: L.Lock,
    exclamation: L.CircleAlert,
    ellipsis: L.Ellipsis,
    trailer: L.Clapperboard,
    sparkles: L.Sparkles,
    palette: L.Palette,
    hardDrive: L.HardDrive,
    stop: L.Square,
    bubble: L.MessageSquareText,
    bell: L.Bell,
    spread: L.Columns2,
    singlePage: L.RectangleVertical,
    readingDirection: L.ArrowLeftRight,
    fitWidth: L.MoveHorizontal,
    fitHeight: L.MoveVertical,
    fitOriginal: L.Scan,
    zoom: L.ZoomIn,
    network: L.Network,
    record: L.CircleDot,
    recordSeries: L.Repeat,
    grip: L.GripVertical,
    arrowUp: L.ArrowUp,
    arrowDown: L.ArrowDown,
    listPlus: L.ListPlus,
    playNext: L.ListStart,
    queue: L.ListEnd,
    shuffle: L.Shuffle,
    repeat: L.Repeat,
    repeatOne: L.Repeat1,
    lyrics: L.MicVocal,
    equalizer: L.AudioLines,
    customize: L.SlidersHorizontal,
    admin: L.ShieldCog,
    activity: L.Activity,
    users: L.Users,
    device: L.MonitorSmartphone,
    clock: L.Clock,
    moon: L.Moon,
    cpu: L.Cpu,
    chart: L.ChartPie,
    puzzle: L.Puzzle,
    key: L.Key,
    file: L.FileText,
    pencil: L.Pencil,
    image: L.Image,
    upload: L.Upload,
    scanSearch: L.ScanSearch,
    unlock: L.LockOpen,
    images: L.Images,
    presentation: L.Presentation,
    zoomOut: L.ZoomOut,
    monitorPlay: L.MonitorPlay,
    listMusic: L.ListMusic,
    bookHeadphones: L.BookHeadphones,
    bookClosed: L.Book,
  } satisfies Record<string, Glyph>;

  export type IconName = keyof typeof ICONS;

  /** One line weight everywhere, like SF Symbols: 1.5 px whatever the size. */
  const STROKE = 1.5;
</script>

<script lang="ts">
  let {
    name,
    size = 18,
    stroke,
    fill = false,
    // Kept for API compatibility: icons no longer animate.
    animate: _animate = false,
  }: { name: IconName; size?: number; stroke?: number; fill?: boolean; animate?: boolean } = $props();

  const Glyph: Glyph = $derived(ICONS[name]);
  // A stroke of 0 is honoured for solid glyphs (e.g. a filled stop square);
  // every other icon draws at the one shared weight so the set reads as a family.
  const width = $derived(stroke === 0 ? 0 : STROKE);
  // Whole-pixel boxes keep the glyph on the pixel grid.
  const px = $derived(Math.round(size));
</script>

<Glyph class="wi-icon" size={px} strokeWidth={width} absoluteStrokeWidth fill={fill ? 'currentColor' : 'none'} aria-hidden="true" />

<style>
  /* The svg belongs to the Lucide component, so the rule is global. Icons are
     static: no transform, no transition. Inline next to text they sit on the
     text's optical centre; inside flex/grid containers this is ignored. */
  :global(.wi-icon) {
    flex: none;
    display: inline-block;
    vertical-align: middle;
    overflow: visible;
  }
</style>
