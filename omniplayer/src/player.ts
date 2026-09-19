/** OmniPlayer 播放器模块（重写入口）：舞台 / 时间轴 / 载入 / 直播 */
import { invoke } from "@tauri-apps/api/core";
import {
  buildSeriesPoints,
  drawSeriesArea,
  ensureSeriesTilesForRange,
  MIN_SERIES_TILE_MS,
  SERIES_KEY_FILL,
  SERIES_KEY_STROKE,
  SERIES_MOUSE_FILL,
  SERIES_MOUSE_STROKE,
  SERIES_TILE_SPAN_MAX,
  seriesDrawSmooth,
  seriesStepForView,
  seriesStickyPeaks,
  seriesTilesReady,
} from "./input_series";
import { buildTimeTicks, tickLabelCursor } from "./time_axis";
import {
  createBuiltinPlaybackModules,
  PlaybackRegistry,
  WinMapPlaybackModule,
  ImePlaybackModule,
  type ModuleEvent,
} from "./modules";
import { cancelPlayerHeavyIpc, runHeavyIpc } from "./heavy_ipc";
import { getPlaybackPrefs } from "./playback_prefs";

export type RecordingDay = {
  date: string;
  year: number;
  month: number;
  day: number;
  bin_path: string | null;
  bin_bytes: number;
  jsonl_path: string | null;
  focus_events_path: string | null;
  win_map_events_path: string | null;
  ime_events_path: string | null;
};

const playbackRegistry = new PlaybackRegistry();
for (const m of createBuiltinPlaybackModules()) {
  playbackRegistry.register(m);
}
const winMapMod = playbackRegistry.get("win_map") as WinMapPlaybackModule | undefined;
const imeMod = playbackRegistry.get("ime") as ImePlaybackModule | undefined;

let canvas: HTMLCanvasElement;
let ctx: CanvasRenderingContext2D;

let windowHistory: any[] = [];
let mouseTrace: { ts: number; x: number; y: number }[] = [];

/** 虚拟桌面（双屏等）；默认先当单 1080p，收到 display_setup 后覆盖 */
let desk = { x: 0, y: 0, w: 1920, h: 1080 };
/** 显示器几何（来自 display_setup.virtual.monitors） */
let deskMonitors: {
  left: number;
  top: number;
  right: number;
  bottom: number;
  primary?: boolean;
}[] = [];
/** 系统光标像素尺寸（SM_CXCURSOR） */
let cursorSizePx = 32;
let wallpaperImg: HTMLImageElement | null = null;
let wallpaperPathLoaded = "";
/** 每屏壁纸（优先）；无则按 deskMonitors + wallpaperImg 分屏画 */
type MonitorWp = {
  key: string;
  bounds: [number, number, number, number];
  img: HTMLImageElement | null;
  srcKey: string;
};
let monitorWallpapers: MonitorWp[] = [];
const iconImgCache = new Map<string, HTMLImageElement>();

let isPlaying = false;
/** 回放倍速（直播时无效） */
let playbackSpeed = 1;
let liveMode = false;
let startTime = 0;
let endTime = 0;
let currentTime = 0;

let timeSlider: HTMLInputElement;
let timeDisplay: HTMLElement;
let btnPlay: HTMLButtonElement;
let btnLive: HTMLButtonElement;
let speedSelect: HTMLSelectElement | null = null;
let speedCustomEl: HTMLElement | null = null;
let speedAmountEl: HTMLInputElement | null = null;
let speedUnitEl: HTMLSelectElement | null = null;
let speedEffEl: HTMLElement | null = null;

function formatSpeedEff(mult: number) {
  if (mult >= 1_000_000) return `×${(mult / 1_000_000).toFixed(mult % 1_000_000 === 0 ? 0 : 2)}M`;
  if (mult >= 10_000) return `×${Math.round(mult).toLocaleString("en-US")}`;
  if (mult >= 100 || Number.isInteger(mult)) return `×${Math.round(mult)}`;
  return `×${mult.toFixed(2)}`;
}

function applyPlaybackSpeedFromUi() {
  if (!speedSelect) return;
  const mode = speedSelect.value;
  if (mode === "custom") {
    speedCustomEl?.classList.add("show");
    const amount = Number(speedAmountEl?.value);
    const unit = Number(speedUnitEl?.value);
    const a = Number.isFinite(amount) && amount > 0 ? amount : 1;
    const u = Number.isFinite(unit) && unit > 0 ? unit : 1;
    playbackSpeed = a * u;
  } else {
    speedCustomEl?.classList.remove("show");
    const v = Number(mode);
    playbackSpeed = Number.isFinite(v) && v > 0 ? v : 1;
  }
  if (speedEffEl) {
    speedEffEl.textContent = formatSpeedEff(playbackSpeed);
    speedEffEl.style.display = mode === "custom" ? "" : "none";
  }
}

function syncSpeedSelectUi() {
  const off = liveMode;
  if (speedSelect) speedSelect.disabled = off;
  if (speedAmountEl) speedAmountEl.disabled = off;
  if (speedUnitEl) speedUnitEl.disabled = off;
}

let defaultDataRoot = "";
/** 当前载入的录像日 */
let loadedDate = "";
/** 已扫描到的录像日（供时间轴色段） */
let playlist: RecordingDay[] = [];
/** 后台仍在缓存（不锁 UI；可边缓存边 seek/播） */
let playlistLoadBusy = false;
let loadGen = 0;
/** 针指到尚未缓存的时刻：等黄条追上再落地 */
let pendingSeekTs: number | null = null;

/**
 * 0–1：当日已缓存相对全日的大致比例（亮绿条长度）；
 * 未读完前不必到 1——够播就停。
 */
let cacheRatio = 0;
let loadOverlayEl: HTMLElement | null = null;
let loadLabelEl: HTMLElement | null = null;
let loadFillEl: HTMLElement | null = null;
let loadPctEl: HTMLElement | null = null;

const READ_CHUNK = 48 * 1024;
/** 内容时钟预取：播头前方至少留这么多（加载侧不再乘高倍速） */
const PREFETCH_AHEAD_MS = 90_000;
/** 冷启动先追上针后这么长，够播就停，其余 idle 慢补 */
const PLAYABLE_AHEAD_MS = 45_000;
/** idle 阶段最多补到针后这么远，不一次啃整天 */
const PREFETCH_BOOT_MS = 2 * 60_000;
/**
 * 赶往 seek 点时：此时间之前不往 mouseTrace 塞点（Rust 侧同样跳过），
 * 近针才密采样。
 */
let mouseKeepFloorTs = 0;
let binEpoch = 0;
/** 解码时钟前沿（解除等缓存；时间轴上条=缓存覆盖，下条=采集运行） */
let decodeFrontierTs = 0;

/** 采集器运行时段（与仪表盘同源，进入播放器即拉，无需点日） */
type RecorderRunSpan = {
  start_ts: number;
  end_ts: number | null;
  status?: string;
  stale?: boolean;
};
let recorderSpans: RecorderRunSpan[] = [];
let recorderSpanTimer: number | null = null;

/** 键鼠曲线：近景日瓦片折线；远景仍走直方图 IPC */
type PlayerHistBucket = { start_ts: number; mouse: number; key: number };
type PlayerHistReport = {
  bucket_ms: number;
  buckets: PlayerHistBucket[];
  mouse_total?: number;
  key_total?: number;
  grain?: string;
};
let playerHistCache: PlayerHistReport | null = null;
let playerHistFetchGen = 0;
let playerHistDebounce: number | null = null;
let lastPlayerHistKey = "";
let lastPlayerHistAt = 0;
const TL_MOUSE_FILL = SERIES_MOUSE_FILL;
const TL_MOUSE_STROKE = SERIES_MOUSE_STROKE;
const TL_KEY_FILL = SERIES_KEY_FILL;
const TL_KEY_STROKE = SERIES_KEY_STROKE;

type EnvStreamCursor = {
  path: string;
  offset: number;
  eof: boolean;
  carry: string;
  /** 本文件已吞进去的最大 ts；预取停点按文件算，避免 win_map 挡住 ime/focus */
  lastTs: number;
};

type DayStreamState = {
  binOffset: number;
  binEof: boolean;
  binTotal: number;
  env: EnvStreamCursor[];
};

/** 离开播放器页之前保留的按日会话缓存（内存） */
type DaySessionCache = {
  rec: RecordingDay;
  mouseTrace: { ts: number; x: number; y: number }[];
  windowHistory: any[];
  winMapEvents: ModuleEvent[];
  focusEvents: ModuleEvent[];
  imeEvents: ModuleEvent[];
  decTs: number;
  decX: number;
  decY: number;
  decCarry: Uint8Array;
  startTime: number;
  endTime: number;
  currentTime: number;
  decodeFrontierTs: number;
  stream: DayStreamState;
  desk: typeof desk;
  deskMonitors: typeof deskMonitors;
  wallpaperPathLoaded: string;
  monitorWallpapers: MonitorWp[];
};

const daySessionCaches = new Map<string, DaySessionCache>();
let activeStream: DayStreamState | null = null;
let activeRec: RecordingDay | null = null;

/** 播放器底部时间轴视窗 */
let tlViewStart = 0;
let tlViewEnd = 0;
let tlViewReady = false;
let tlFxBound = false;
let tlCanvas: HTMLCanvasElement | null = null;
/** 顶栏+底栏是否显示（点舞台切换） */
let playerChromeVisible = true;
/** pointerdown 记下起点；mouseup 位移小则点击 seek（无长按拖平移） */
let tlClickPending: { x: number; y: number; ts: number } | null = null;
/** 按住针头拖 scrub：指针捕获期间持续 requestSeek */
let tlScrubbing = false;
let tlScrubRaf = 0;
let tlScrubPendingTs: number | null = null;
/** 滚轮惯性：与仪表盘同款摩擦约 0.2s */
let tlPanVel = 0;
let tlZoomVel = 0;
let tlZoomAnchorFrac = 0.5;
let tlInertiaRaf = 0;
let tlInertiaLast = 0;
const TL_PAN_FRICTION = 19.6;
const TL_ZOOM_FRICTION = 20;
const TL_NEEDLE_R = 6;
const TL_CLICK_SLOP = 5;
const TL_MIN_SPAN = 30_000;
/** 一次能看见的最大跨度约二十年；平移不按录像区间封左右 */
const TL_MAX_SPAN = Math.floor(20 * 365.25 * 24 * 60 * 60 * 1000);
const TL_DAY = 86_400_000;
const TL_TS_ABS_MAX = 8.64e15;

/** 赶进度：短歇，把控制权还给 UI */
function yieldRace(): Promise<void> {
  return new Promise((r) => setTimeout(r, 8));
}

/** AE 式慢补：明显让出主线程，不把窗口啃死 */
function yieldIdle(): Promise<void> {
  return new Promise((r) => setTimeout(r, 72));
}

/** 针在缓存前方：预取应立刻切 race，别继续 idle 磨洋工 */
function prefetchUrgent(): boolean {
  if (pendingSeekTs == null) return false;
  const front = playableCacheEnd();
  return pendingSeekTs > front + 250;
}

function u8ToB64(bytes: Uint8Array): string {
  if (!bytes.length) return "";
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(s);
}

function b64ToU8(b64: string): Uint8Array {
  if (!b64) return new Uint8Array(0);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function setLoadUi(show: boolean, label?: string, ratio?: number) {
  if (!loadOverlayEl) {
    loadOverlayEl = document.getElementById("load-overlay");
    loadLabelEl = document.getElementById("load-label");
    loadFillEl = document.getElementById("load-bar-fill");
    loadPctEl = document.getElementById("load-pct");
  }
  if (!loadOverlayEl) return;
  loadOverlayEl.classList.toggle("show", show);
  if (label != null && loadLabelEl) loadLabelEl.textContent = label;
  if (ratio != null) {
    const pct = Math.max(0, Math.min(100, Math.round(ratio * 100)));
    if (loadFillEl) loadFillEl.style.width = `${pct}%`;
    if (loadPctEl) loadPctEl.textContent = `${pct}%`;
  }
}

function dayBoundsMs(dateStr: string): { t0: number; t1: number } {
  const [y, m, d] = dateStr.split("-").map(Number);
  const t0 = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
  const t1 = new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
  return { t0, t1 };
}

function playlistDataRange(): { min: number; max: number } | null {
  if (!playlist.length && !(endTime > startTime)) return null;
  let min = Infinity;
  let max = -Infinity;
  for (const r of playlist) {
    const b = dayBoundsMs(r.date);
    min = Math.min(min, b.t0);
    max = Math.max(max, b.t1);
  }
  if (endTime > startTime) {
    min = Math.min(min, startTime);
    max = Math.max(max, endTime);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
  return { min, max };
}

function clampTlView() {
  const span = Math.max(TL_MIN_SPAN, Math.min(TL_MAX_SPAN, tlViewEnd - tlViewStart));
  let start = Number.isFinite(tlViewStart) ? tlViewStart : Date.now() - span;
  if (start < -TL_TS_ABS_MAX) start = -TL_TS_ABS_MAX;
  if (start + span > TL_TS_ABS_MAX) start = TL_TS_ABS_MAX - span;
  tlViewStart = start;
  tlViewEnd = start + span;
}

function stopTlInertia() {
  if (tlInertiaRaf) {
    cancelAnimationFrame(tlInertiaRaf);
    tlInertiaRaf = 0;
  }
  tlPanVel = 0;
  tlZoomVel = 0;
}

function applyTlPanDelta(deltaMs: number) {
  tlViewStart += deltaMs;
  tlViewEnd += deltaMs;
  clampTlView();
}

function applyTlZoomFactor(factor: number, frac: number) {
  const span = Math.max(1, tlViewEnd - tlViewStart);
  const anchor = tlViewStart + span * frac;
  let next = span * factor;
  next = Math.max(TL_MIN_SPAN, Math.min(TL_MAX_SPAN, next));
  tlViewStart = anchor - next * frac;
  tlViewEnd = tlViewStart + next;
  clampTlView();
}

function kickTlInertia() {
  if (tlInertiaRaf) return;
  tlInertiaLast = performance.now();
  tlInertiaRaf = -1;
  drawPlayerTimeline();
  const step = (t: number) => {
    const dt = Math.min(48, t - tlInertiaLast);
    tlInertiaLast = t;
    const dtSec = dt / 1000;
    const span = Math.max(1, tlViewEnd - tlViewStart);
    const panEps = Math.max(0.08, span * 2e-7);
    const zoomEps = 0.04;
    let moving = false;
    if (Math.abs(tlPanVel) > panEps) {
      applyTlPanDelta(tlPanVel * dt);
      tlPanVel *= Math.exp(-TL_PAN_FRICTION * dtSec);
      moving = true;
    } else {
      tlPanVel = 0;
    }
    if (Math.abs(tlZoomVel) > zoomEps) {
      applyTlZoomFactor(Math.exp(tlZoomVel * dtSec), tlZoomAnchorFrac);
      tlZoomVel *= Math.exp(-TL_ZOOM_FRICTION * dtSec);
      moving = true;
    } else {
      tlZoomVel = 0;
    }
    drawPlayerTimeline();
    if (moving) {
      tlInertiaRaf = requestAnimationFrame(step);
    } else {
      tlInertiaRaf = 0;
      schedulePlayerHistRefresh();
    }
  };
  tlInertiaRaf = requestAnimationFrame(step);
}

function ensureTlView(forceFocusLoaded = false) {
  const range = playlistDataRange();
  const now = Date.now();
  if (!tlViewReady || forceFocusLoaded) {
    if (loadedDate && endTime > startTime) {
      const pad = Math.max((endTime - startTime) * 0.15, 5 * 60_000);
      tlViewStart = startTime - pad;
      tlViewEnd = endTime + pad;
    } else if (loadedDate) {
      const b = dayBoundsMs(loadedDate);
      const pad = (b.t1 - b.t0) * 0.08;
      tlViewStart = b.t0 - pad;
      tlViewEnd = b.t1 + pad;
    } else if (range) {
      tlViewEnd = range.max;
      tlViewStart = Math.max(range.min, range.max - 3 * 24 * 60 * 60 * 1000);
    } else {
      tlViewEnd = now + 60 * 60_000;
      tlViewStart = now - 6 * 60 * 60_000;
    }
    tlViewReady = true;
  }
  clampTlView();
}

function xToTlTs(x: number, cssW: number) {
  const span = Math.max(1, tlViewEnd - tlViewStart);
  return tlViewStart + (x / Math.max(1, cssW)) * span;
}

function tlTsToX(ts: number, cssW: number) {
  const span = Math.max(1, tlViewEnd - tlViewStart);
  return ((ts - tlViewStart) / span) * cssW;
}

function hitPlaylistDay(ts: number): RecordingDay | null {
  const date = dateKeyFromTs(ts);
  return playlist.find((r) => r.date === date) ?? null;
}

/** 已解码物理流覆盖：seek / 黄条只认这个，不用窗口 jsonl 的 endTime 冒充已缓存 */
function playableCacheEnd(): number {
  let t = 0;
  if (mouseTrace.length) t = Math.max(t, mouseTrace[mouseTrace.length - 1].ts);
  if (decodeFrontierTs > 1_000_000_000_000) t = Math.max(t, decodeFrontierTs);
  return t;
}

function playableCacheStart(date = loadedDate): number {
  if (date && date === loadedDate) {
    if (mouseTrace.length) return mouseTrace[0].ts;
    if (mouseKeepFloorTs > 0) return mouseKeepFloorTs;
  }
  if (date) return dayBoundsMs(date).t0;
  return startTime > 0 ? startTime : 0;
}

function cacheRangeForDate(date: string): { t0: number; t1: number } | null {
  if (date === loadedDate) {
    const t1 = playableCacheEnd();
    if (t1 <= 0) return null;
    const t0 = playableCacheStart(date);
    if (!(t1 > t0)) return null;
    return { t0, t1 };
  }
  const c = daySessionCaches.get(date);
  if (!c) return null;
  const t1 = Math.max(
    c.endTime > c.startTime ? c.endTime : 0,
    c.decodeFrontierTs > 1_000_000_000_000 ? c.decodeFrontierTs : 0
  );
  if (t1 <= 0) return null;
  const t0 = c.startTime > 0 ? c.startTime : dayBoundsMs(date).t0;
  if (!(t1 > t0)) return null;
  return { t0, t1 };
}

function fillTlRange(
  ctx: CanvasRenderingContext2D,
  t0: number,
  t1: number,
  cssW: number,
  y: number,
  h: number,
  fill: string
) {
  if (!(t1 > t0)) return;
  if (t1 < tlViewStart || t0 > tlViewEnd) return;
  const x0 = Math.max(0, tlTsToX(t0, cssW));
  const x1 = Math.min(cssW, tlTsToX(t1, cssW));
  const w = Math.max(2, x1 - x0);
  ctx.fillStyle = fill;
  ctx.fillRect(x0, y, w, h);
}

function playerHistBucketMs(spanMs: number): number {
  if (spanMs <= 5 * 60_000) return 1_000;
  if (spanMs <= 6 * 3600_000) return 60_000;
  if (spanMs <= 7 * TL_DAY) return 3600_000;
  if (spanMs <= 90 * TL_DAY) return TL_DAY;
  if (spanMs <= 3 * 365 * TL_DAY) return 7 * TL_DAY;
  return 30 * TL_DAY;
}

function schedulePlayerHistRefresh() {
  if (playerHistDebounce != null) window.clearTimeout(playerHistDebounce);
  playerHistDebounce = window.setTimeout(() => {
    playerHistDebounce = null;
    void refreshPlayerInputHist();
  }, 120);
}

async function refreshPlayerInputHist(force = false) {
  if (!document.getElementById("page-player")?.classList.contains("active")) return;
  ensureTlView();
  if (tlViewEnd < MIN_SERIES_TILE_MS || tlViewStart < MIN_SERIES_TILE_MS) return;
  const span = Math.max(1, tlViewEnd - tlViewStart);

  // 近景：按日瓦片拉取（永久 .otih）；已齐则只重画
  if (span <= SERIES_TILE_SPAN_MAX) {
    if (!force && seriesTilesReady(tlViewStart, tlViewEnd)) {
      drawPlayerTimeline();
      return;
    }
    const gen = ++playerHistFetchGen;
    await ensureSeriesTilesForRange(tlViewStart, tlViewEnd, { playerScope: true });
    if (gen !== playerHistFetchGen) return;
    drawPlayerTimeline();
    return;
  }

  const bucketMs = playerHistBucketMs(span);
  const startTs = Math.floor(tlViewStart / bucketMs) * bucketMs;
  const endTs = Math.ceil(tlViewEnd);
  if (!Number.isFinite(endTs) || endTs <= 0) return;
  const ipcStart = Math.max(0, Math.floor(startTs));
  const ipcEnd = Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.max(ipcStart + 1, Math.floor(endTs))
  );
  const key = `${ipcStart}:${ipcEnd}:${bucketMs}`;
  const now = Date.now();
  const coversLive = tlViewEnd >= now - TL_DAY;
  if (
    !force &&
    key === lastPlayerHistKey &&
    playerHistCache &&
    (!coversLive || now - lastPlayerHistAt < 20_000)
  ) {
    return;
  }
  const gen = ++playerHistFetchGen;
  try {
    const report = await invoke<PlayerHistReport>("dashboard_input_histogram", {
      startTs: ipcStart,
      endTs: ipcEnd,
      bucketMs: Math.floor(bucketMs),
    });
    if (gen !== playerHistFetchGen) return;
    playerHistCache = report;
    lastPlayerHistKey = key;
    lastPlayerHistAt = Date.now();
    drawPlayerTimeline();
  } catch (e) {
    console.warn("[player hist]", e);
  }
}

let tlPaintRaf = 0;
let lastTlPaintAt = 0;
const TL_MIN_FRAME_MS = 1000 / 60;
/** 滚轮/拖针：跟 vsync，不 60Hz 封顶（高刷新上封顶会一顿一顿） */
function drawPlayerTimeline() {
  if (tlPaintRaf) return;
  tlPaintRaf = requestAnimationFrame(() => {
    tlPaintRaf = 0;
    lastTlPaintAt = performance.now();
    paintPlayerTimeline();
  });
}
/** 播放走针：最多约 60Hz 整轴重画 */
function drawPlayerTimelineClock() {
  if (performance.now() - lastTlPaintAt < TL_MIN_FRAME_MS) return;
  drawPlayerTimeline();
}

function cssVar(name: string, fallback: string) {
  const v = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return v || fallback;
}

/** 时间轴跟壳层配色，不跟舞台黑底 */
function tlChrome() {
  return {
    bg: cssVar("--panel", "#f7f5f2"),
    slot: cssVar("--tabs-bg", "#e2ddd5"),
    line: cssVar("--line", "#d0cbc3"),
    muted: cssVar("--muted", "#6a6560"),
    text: cssVar("--text", "#2a2a2a"),
    run: cssVar("--accent", "#1f6f5b"),
    stale: "#c9a227",
    stopped: "#9a9590",
  };
}

function paintPlayerTimeline() {
  if (!tlCanvas) tlCanvas = document.getElementById("player-timeline") as HTMLCanvasElement | null;
  const canvas = tlCanvas;
  if (!canvas) return;
  ensureTlView();
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 600;
  const cssH = canvas.clientHeight || 72;
  if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const span = Math.max(1, tlViewEnd - tlViewStart);
  const chrome = tlChrome();
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = chrome.bg;
  ctx.fillRect(0, 0, cssW, cssH);

  // 上：键鼠活跃曲线 → 中：缓存条 → 下：有日+采集时段；针头圆留给顶部
  const headH = TL_NEEDLE_R + 2;
  const engH = 28;
  const cacheH = 5;
  const barH = 8;
  const gap = 2;
  const engTop = headH + 1;
  const engBase = engTop + engH;
  const cacheTop = engBase + gap;
  const barTop = cacheTop + cacheH + gap;
  const axisY = barTop + barH + 2;

  // 活跃曲线槽：最细折线；缩小后平滑曲线；远景直方图
  ctx.fillStyle = chrome.slot;
  ctx.fillRect(0, engTop, cssW, engH);
  {
    const usableH = engH - 2;
    const mousePts: { x: number; y: number }[] = [];
    const keyPts: { x: number; y: number }[] = [];
    let smooth = true;
    let tileStep = 60_000;

    if (span <= SERIES_TILE_SPAN_MAX && seriesTilesReady(tlViewStart, tlViewEnd)) {
      tileStep = seriesStepForView(span, cssW);
      smooth = seriesDrawSmooth(tileStep);
      const raw = buildSeriesPoints(tlViewStart, tlViewEnd, tileStep);
      const peaks = seriesStickyPeaks();
      for (const p of raw) {
        const x = tlTsToX(p.ts, cssW);
        const mh = Math.min(1, p.mouse / peaks.mouse) * usableH * 0.94;
        const kh = Math.min(1, p.key / peaks.key) * usableH * 0.94;
        mousePts.push({ x, y: engBase - mh });
        keyPts.push({ x, y: engBase - kh });
      }
    } else {
      const buckets = playerHistCache?.buckets || [];
      const bucketMs = playerHistCache?.bucket_ms || playerHistBucketMs(span);
      let maxMouse = 1;
      let maxKey = 1;
      for (const b of buckets) {
        if (b.mouse > maxMouse) maxMouse = b.mouse;
        if (b.key > maxKey) maxKey = b.key;
      }
      for (const b of buckets) {
        const mid = b.start_ts + bucketMs / 2;
        if (mid < tlViewStart - bucketMs || mid > tlViewEnd + bucketMs) continue;
        const x = tlTsToX(mid, cssW);
        mousePts.push({ x, y: engBase - (b.mouse / maxMouse) * usableH });
        keyPts.push({ x, y: engBase - (b.key / maxKey) * usableH });
      }
    }

    ctx.save();
    ctx.beginPath();
    ctx.rect(0, engTop, cssW, engH);
    ctx.clip();
    drawSeriesArea(ctx, mousePts, engBase, TL_MOUSE_FILL, TL_MOUSE_STROKE, smooth);
    drawSeriesArea(ctx, keyPts, engBase, TL_KEY_FILL, TL_KEY_STROKE, smooth);
    ctx.restore();
    ctx.strokeStyle = chrome.line;
    ctx.beginPath();
    ctx.moveTo(0, engBase);
    ctx.lineTo(cssW, engBase);
    ctx.stroke();
  }

  // 缓存条槽底
  ctx.fillStyle = chrome.slot;
  ctx.fillRect(0, cacheTop, cssW, cacheH);

  // 会话缓存日 + 当前日
  for (const date of daySessionCaches.keys()) {
    if (date === loadedDate) continue;
    const r = cacheRangeForDate(date);
    if (!r) continue;
    fillTlRange(ctx, r.t0, r.t1, cssW, cacheTop, cacheH, "rgba(36, 132, 185, 0.28)");
  }
  if (loadedDate) {
    const r = cacheRangeForDate(loadedDate);
    if (r) {
      fillTlRange(ctx, r.t0, r.t1, cssW, cacheTop, cacheH, "rgba(36, 132, 185, 0.45)");
      if (endTime > startTime) {
        fillTlRange(
          ctx,
          startTime,
          endTime,
          cssW,
          cacheTop,
          cacheH,
          "rgba(31, 111, 91, 0.7)"
        );
      }
    }
  }

  // 磁盘有日
  for (const rec of playlist) {
    const b = dayBoundsMs(rec.date);
    if (b.t1 < tlViewStart || b.t0 > tlViewEnd) continue;
    const x0 = Math.max(0, tlTsToX(b.t0, cssW));
    const x1 = Math.min(cssW, tlTsToX(b.t1, cssW));
    const w = Math.max(2, x1 - x0);
    const active = rec.date === loadedDate;
    ctx.fillStyle = active ? "rgba(59, 111, 160, 0.42)" : "rgba(59, 111, 160, 0.22)";
    ctx.fillRect(x0, barTop, w, barH);
  }

  // 采集器运行时段
  {
    const now = Date.now();
    for (const s of recorderSpans) {
      const t0 = s.start_ts;
      const t1 = s.end_ts == null ? now : s.end_ts;
      if (!(t1 > t0)) continue;
      fillTlRange(
        ctx,
        t0,
        t1,
        cssW,
        barTop - 1,
        barH + 2,
        s.stale || s.status === "stale"
          ? chrome.stale
          : s.status === "stopped"
            ? chrome.stopped
            : chrome.run
      );
    }
  }

  // 刻度线 + 尺子进位文案
  ctx.strokeStyle = chrome.line;
  ctx.beginPath();
  ctx.moveTo(0, axisY);
  ctx.lineTo(cssW, axisY);
  ctx.stroke();
  ctx.fillStyle = chrome.muted;
  ctx.font =
    span <= 30_000
      ? '12px "Cascadia Mono", "Consolas", monospace'
      : '12px "Noto Sans SC", sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  const ticks = buildTimeTicks(tlViewStart, tlViewEnd, cssW);
  const labelCursor = tickLabelCursor(12);
  for (const tick of ticks) {
    const x = tlTsToX(tick.ts, cssW);
    if (x < -2 || x > cssW + 2) continue;
    const hasLabel = tick.label.length > 0;
    const len = tick.rank === "major" ? 6 : tick.rank === "mid" ? 4 : 2;
    ctx.strokeStyle = chrome.line;
    ctx.lineWidth = tick.rank === "major" ? 1.25 : 1;
    ctx.beginPath();
    ctx.moveTo(x, axisY);
    ctx.lineTo(x, axisY + len);
    ctx.stroke();
    ctx.lineWidth = 1;
    if (!hasLabel) continue;
    if (tick.rank !== "major" && (x < 16 || x > cssW - 16)) continue;
    if (tick.rank === "major" && (x < -4 || x > cssW + 4)) continue;
    if (!labelCursor.take(x, ctx.measureText(tick.label).width)) continue;
    ctx.fillStyle = chrome.muted;
    ctx.fillText(tick.label, x, axisY + 5);
  }

  // 播放针：圆头 + 竖线穿过曲线+双条
  const needle = needleDisplayTs();
  if (needle > 0) {
    const nx = tlTsToX(needle, cssW);
    const waiting = prefetchUrgent();
    if (nx >= -8 && nx <= cssW + 8) {
      ctx.strokeStyle = waiting ? "#c9a227" : "#c62828";
      ctx.fillStyle = waiting ? "#c9a227" : "#c62828";
      ctx.lineWidth = 1.25;
      const tipY = engTop;
      ctx.beginPath();
      ctx.moveTo(nx, tipY);
      ctx.lineTo(nx, axisY);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(nx, TL_NEEDLE_R, TL_NEEDLE_R, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = waiting ? "#a8861a" : "#8e1f1f";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}

function needleDisplayTs() {
  return pendingSeekTs ?? currentTime;
}

/** 针可去空白处读秒；仅当指到「当日未读完的缓存前方」才挂 pending 等预取 */
function rewindBinForSeek(ts: number) {
  mouseKeepFloorTs = Math.max(0, ts - 90_000);
  binEpoch++;
  if (activeStream) {
    activeStream.binOffset = 0;
    activeStream.binEof = false;
  }
  resetDecoder(0);
}

function requestSeek(ts: number) {
  if (liveMode) return;
  currentTime = ts;
  const cacheEnd = playableCacheEnd();
  const cacheStart = playableCacheStart();
  const inCache =
    cacheEnd > cacheStart && ts >= cacheStart && ts <= cacheEnd + 16;
  const onLoadedDay =
    !!loadedDate && hitPlaylistDay(ts)?.date === loadedDate;
  const sameDayAhead =
    onLoadedDay &&
    cacheEnd > 0 &&
    ts > cacheEnd &&
    !dayFullyStreamed(activeStream);
  const sameDayBehind =
    onLoadedDay &&
    !!activeStream &&
    (!inCache && ts < cacheStart);
  const coldCatchUp =
    onLoadedDay &&
    !(cacheEnd > cacheStart) &&
    (playlistLoadBusy || !!activeStream) &&
    !dayFullyStreamed(activeStream);
  if (inCache) {
    pendingSeekTs = null;
  } else if (sameDayBehind) {
    pendingSeekTs = ts;
    rewindBinForSeek(ts);
    void ensurePlaybackPrefetch();
  } else if (sameDayAhead || coldCatchUp) {
    pendingSeekTs = ts;
    if (ts > cacheEnd) {
      const floor = ts - 10 * 60_000;
      if (floor > mouseKeepFloorTs + 60_000) mouseKeepFloorTs = floor;
    }
    void ensurePlaybackPrefetch();
  } else {
    pendingSeekTs = null;
  }
  updateTimeDisplay();
  renderFrame();
  drawPlayerTimeline();
}

function tryResolvePendingSeek() {
  if (pendingSeekTs == null) return;
  const frontier = playableCacheEnd();
  if (frontier <= 0) return;
  if (pendingSeekTs <= frontier) {
    // 解码前沿已盖住针：不必再等 mouseTrace 填满 start/end
    if (!(endTime > startTime) || pendingSeekTs < startTime) {
      currentTime = Math.min(pendingSeekTs, frontier);
    } else {
      currentTime = pendingSeekTs;
    }
    pendingSeekTs = null;
    updateTimeDisplay();
    renderFrame();
    drawPlayerTimeline();
  }
}

function updateScrubberChrome() {
  drawPlayerTimeline();
}

function focusTlOnLoaded() {
  tlViewReady = false;
  ensureTlView(true);
  drawPlayerTimeline();
}

async function seekOrLoadAtTs(ts: number) {
  if (liveMode) return;
  const rec = hitPlaylistDay(ts);
  // 同一天：有缓存只 seek；空壳强制再 load
  if (rec && rec.date === loadedDate) {
    const day0 = dayBoundsMs(rec.date).t0;
    const hasCache =
      endTime > startTime ||
      decodeFrontierTs > day0 ||
      (!!activeStream && activeStream.binOffset > 0);
    if (hasCache) {
      requestSeek(ts);
      return;
    }
    await loadRecording(rec, ts);
    return;
  }
  // 空白：指帧过去读秒，不换日
  if (!rec) {
    requestSeek(ts);
    return;
  }
  // 点到另一天：才换日加载（拖拽用 requestSeek，不会换日）
  await loadRecording(rec, ts);
}

function bindPlayerTimelineFx() {
  if (tlFxBound) return;
  const canvas = document.getElementById("player-timeline") as HTMLCanvasElement | null;
  if (!canvas) return;
  tlFxBound = true;
  tlCanvas = canvas;
  canvas.tabIndex = 0;

  let tlHover = false;
  /** 自管 Alt：系统菜单模式会把 e.altKey 弄丢/乱跳 */
  let altZoomHeld = false;

  const pointerOverTimeline = (clientX: number, clientY: number) => {
    const r = canvas.getBoundingClientRect();
    return (
      clientX >= r.left &&
      clientX <= r.right &&
      clientY >= r.top &&
      clientY <= r.bottom
    );
  };

  canvas.addEventListener("pointerenter", () => {
    tlHover = true;
  });
  canvas.addEventListener("pointerleave", () => {
    tlHover = false;
  });

  // 悬停时间轴时吞掉 Alt，避免 Windows/WebView 进菜单、抢走焦点
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Alt" && e.key !== "AltGraph") return;
      if (!document.getElementById("page-player")?.classList.contains("active")) return;
      if (!tlHover) return;
      e.preventDefault();
      e.stopPropagation();
      altZoomHeld = true;
    },
    true
  );
  window.addEventListener(
    "keyup",
    (e) => {
      if (e.key !== "Alt" && e.key !== "AltGraph") return;
      if (altZoomHeld) {
        e.preventDefault();
        e.stopPropagation();
      }
      altZoomHeld = false;
    },
    true
  );
  window.addEventListener("blur", () => {
    altZoomHeld = false;
  });

  const onWheel = (e: WheelEvent) => {
    if (!document.getElementById("page-player")?.classList.contains("active")) return;
    if (!tlHover && !pointerOverTimeline(e.clientX, e.clientY)) return;

    e.preventDefault();
    e.stopPropagation();

    ensureTlView();
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const cssW = canvas.clientWidth || 1;
    const span = Math.max(1, tlViewEnd - tlViewStart);
    const frac = Math.min(1, Math.max(0, x / cssW));
    // Alt（自管）或 Ctrl：缩放；裸滚轮：平移
    const prefs = getPlaybackPrefs();
    const wantZoom = altZoomHeld || e.altKey || e.ctrlKey || e.metaKey;
    if (wantZoom) {
      const ratio = Math.max(0.01, prefs.playerZoomPct / 100);
      const factor = e.deltaY < 0 ? 1 / (1 + ratio) : 1 + ratio;
      applyTlZoomFactor(factor, frac);
      tlZoomAnchorFrac = frac;
      if (prefs.inertia) {
        const ln = Math.log(factor);
        tlZoomVel += ln * 0.55;
        kickTlInertia();
      } else {
        drawPlayerTimeline();
      }
    } else {
      const dir = e.deltaY > 0 ? 1 : -1;
      const notches = Math.max(1, Math.min(3, Math.round(Math.abs(e.deltaY) / 100)));
      const panFrac = Math.max(0.005, prefs.playerPanPct / 100);
      const delta = span * panFrac * dir * notches;
      applyTlPanDelta(delta);
      if (prefs.inertia) {
        tlPanVel += delta * 0.08;
        kickTlInertia();
      } else {
        drawPlayerTimeline();
      }
    }
  };
  window.addEventListener("wheel", onWheel, { passive: false, capture: true });

  const focusTimeline = () => {
    try {
      canvas.focus({ preventScroll: true });
    } catch {
      canvas.focus();
    }
  };

  const flushScrubSeek = () => {
    tlScrubRaf = 0;
    if (tlScrubPendingTs == null || liveMode) return;
    const ts = tlScrubPendingTs;
    tlScrubPendingTs = null;
    requestSeek(ts);
  };

  const queueScrubSeek = (ts: number) => {
    tlScrubPendingTs = ts;
    if (tlScrubRaf) return;
    tlScrubRaf = requestAnimationFrame(flushScrubSeek);
  };

  const hitNeedleHead = (x: number, y: number, cssW: number) => {
    const needle = needleDisplayTs();
    if (!(needle > 0)) return false;
    const nx = tlTsToX(needle, cssW);
    const hitR = TL_NEEDLE_R + 10;
    const dx = x - nx;
    const dy = y - TL_NEEDLE_R;
    return dx * dx + dy * dy <= hitR * hitR;
  };

  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    focusTimeline();
    ensureTlView();
    stopTlInertia();
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const cssW = canvas.clientWidth || 1;
    if (!liveMode && hitNeedleHead(x, y, cssW)) {
      tlScrubbing = true;
      tlClickPending = null;
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      queueScrubSeek(xToTlTs(x, cssW));
      return;
    }
    tlClickPending = {
      x: e.clientX,
      y: e.clientY,
      ts: xToTlTs(x, cssW),
    };
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!tlScrubbing) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const cssW = canvas.clientWidth || 1;
    queueScrubSeek(xToTlTs(x, cssW));
  });

  const endTimelinePointer = (e: PointerEvent) => {
    if (tlScrubbing) {
      tlScrubbing = false;
      try {
        canvas.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      flushScrubSeek();
      tlClickPending = null;
      return;
    }
    if (!tlClickPending || e.button !== 0) return;
    const dx = e.clientX - tlClickPending.x;
    const dy = e.clientY - tlClickPending.y;
    const pending = tlClickPending;
    tlClickPending = null;
    if (dx * dx + dy * dy > TL_CLICK_SLOP * TL_CLICK_SLOP) return;
    if (!liveMode) void seekOrLoadAtTs(pending.ts);
  };
  canvas.addEventListener("pointerup", endTimelinePointer);
  canvas.addEventListener("pointercancel", () => {
    tlScrubbing = false;
    tlClickPending = null;
    tlScrubPendingTs = null;
  });

  window.addEventListener("resize", () => {
    if (document.getElementById("page-player")?.classList.contains("active")) {
      drawPlayerTimeline();
    }
  });
  window.addEventListener("omnitrace-theme", () => drawPlayerTimeline());
}

/** 直播 tail 状态 */
let liveBinPath = "";
let liveBinOffset = 0;
let liveJsonlPath = "";
let liveJsonlOffset = 0;
let liveWinMapPath = "";
let liveWinMapOffset = 0;
let liveImePath = "";
let liveImeOffset = 0;
let livePollBusy = false;
let lastLivePollMs = 0;

/** 增量解码状态（直播追加用） */
let decTs = 0;
let decX = 0;
let decY = 0;
let decCarry: Uint8Array = new Uint8Array(0);

function formatTime(ms: number) {
  if (isNaN(ms) || ms < 0) return "00:00.00";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  const centis = Math.floor((ms % 1000) / 10)
    .toString()
    .padStart(2, "0");
  // 从「当天 0 点」起算时会超过 60 分，必须带小时，否则会变成几千万分钟
  if (hours > 0) {
    return `${hours}:${minutes}:${seconds}.${centis}`;
  }
  return `${minutes}:${seconds}.${centis}`;
}

/** 播放器时间读数的「零点」：已载入日的 0:00，否则针所在日的 0:00 */
function displayDayOriginTs(forTs: number): number {
  const key =
    loadedDate ||
    (forTs > 0 ? dateKeyFromTs(forTs) : "") ||
    hitPlaylistDay(forTs)?.date ||
    "";
  if (key) return dayBoundsMs(key).t0;
  return 0;
}

function displayDayEndTs(origin: number): number {
  if (origin <= 0) return 0;
  return origin + 86_400_000 - 1;
}

/** 本机系统时钟 HH:MM:SS */
function formatClockNow() {
  const d = new Date();
  const hh = d.getHours().toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  const ss = d.getSeconds().toString().padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function initCanvas() {
  const el = document.getElementById("omni-canvas") as HTMLCanvasElement | null;
  if (!el) return;
  canvas = el;
  const ctx2 = canvas.getContext("2d");
  if (!ctx2) return;
  ctx = ctx2;
  const stage = document.getElementById("stage") as HTMLElement;
  const cssW = stage?.clientWidth || window.innerWidth;
  const cssH = stage?.clientHeight || window.innerHeight;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(cssW * dpr));
  canvas.height = Math.max(1, Math.floor(cssH * dpr));
  canvas.style.width = cssW + "px";
  canvas.style.height = cssH + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function resetDecoder(seedTs: number) {
  decTs = seedTs;
  decX = 0;
  decY = 0;
  decCarry = new Uint8Array(0);
  mouseTrace = [];
  decodeFrontierTs = 0;
}

function shouldKeepMouseSample(ts: number): boolean {
  // seek 前完全不留点（直播 / 近针由 Rust advance 或此处密采样）
  return ts >= mouseKeepFloorTs;
}

/** 把新字节拼上残留，解出完整事件；解不完的留在 carry */
function appendBinBytes(chunk: Uint8Array) {
  const merged = new Uint8Array(decCarry.length + chunk.length);
  merged.set(decCarry, 0);
  merged.set(chunk, decCarry.length);
  const view = new DataView(merged.buffer, merged.byteOffset, merged.byteLength);
  let offset = 0;

  while (offset < merged.length) {
    const marker = merged[offset];
    const start = offset;
    offset += 1;

    if (marker === 0xff) {
      if (offset + 12 > merged.length) {
        decCarry = merged.slice(start);
        return;
      }
      decTs = Number(view.getBigUint64(offset, false));
      decX = view.getInt16(offset + 8, false);
      decY = view.getInt16(offset + 10, false);
      if (shouldKeepMouseSample(decTs)) {
        mouseTrace.push({ ts: decTs, x: decX, y: decY });
      }
      if (decTs > decodeFrontierTs) decodeFrontierTs = decTs;
      offset += 12;
    } else if (
      marker === 0xfe ||
      marker === 0xfd ||
      marker === 0xfc ||
      marker === 0xfb
    ) {
      if (offset + 3 > merged.length) {
        decCarry = merged.slice(start);
        return;
      }
      decTs += merged[offset];
      offset += 3;
    } else {
      if (offset + 2 > merged.length) {
        decCarry = merged.slice(start);
        return;
      }
      const dt = marker;
      const dx = view.getInt8(offset);
      const dy = view.getInt8(offset + 1);
      decTs += dt;
      decX += dx;
      decY += dy;
      if (shouldKeepMouseSample(decTs)) {
        mouseTrace.push({ ts: decTs, x: decX, y: decY });
      }
      if (decTs > decodeFrontierTs) decodeFrontierTs = decTs;
      offset += 2;
    }
  }
  decCarry = new Uint8Array(0);
}

/** 从后往前找最近一条绝对鼠标帧 0xFF（直播用，避开被写坏的相对坐标段） */
function findLastAbsoluteMouseOffset(data: Uint8Array): number {
  if (data.length < 13) return 0;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const now = Date.now();
  for (let i = data.length - 13; i >= 0; i--) {
    if (data[i] !== 0xff) continue;
    try {
      const ts = Number(view.getBigUint64(i + 1, false));
      // 合理 Unix ms：约 2001–2100，且不超过「现在 + 1 分钟」
      if (ts > 1_000_000_000_000 && ts < now + 60_000) {
        return i;
      }
    } catch {
      /* continue */
    }
  }
  return 0;
}

function calculateTimeBounds(opts?: { keepPlayhead?: boolean }) {
  let min = Infinity,
    max = 0;
  if (mouseTrace.length > 0) {
    min = Math.min(min, mouseTrace[0].ts);
    max = Math.max(max, mouseTrace[mouseTrace.length - 1].ts);
  }
  for (const win of windowHistory) {
    if (typeof win.ts === "number") {
      min = Math.min(min, win.ts);
      max = Math.max(max, win.ts);
    }
  }
  const winLatest = winMapMod?.latestEventTs?.() ?? 0;
  if (winLatest > 0) max = Math.max(max, winLatest);
  const imeEv = imeMod?.exportEvents?.() ?? [];
  if (imeEv.length) {
    min = Math.min(min, imeEv[0].ts);
    max = Math.max(max, imeEv[imeEv.length - 1].ts);
  }
  // 赶进度：解码前沿算进可播右界；不要把 min 强行拉到当天 0 点（会把关机空档也涂绿）
  if (decodeFrontierTs > 1_000_000_000_000) {
    max = Math.max(max, decodeFrontierTs);
  }
  if (min !== Infinity) {
    const prevCurrent = currentTime;
    startTime = min;
    endTime = max;
    if (!liveMode) {
      if (pendingSeekTs != null) {
        // 追赶中：播头钉在目标，勿被缓存 frontier 钳回早晨
        currentTime = pendingSeekTs;
      } else if (opts?.keepPlayhead && prevCurrent >= startTime) {
        currentTime = Math.min(endTime, Math.max(startTime, prevCurrent));
      } else {
        currentTime = startTime;
      }
    }
    const duration = Math.max(0, endTime - startTime);
    if (timeSlider) {
      timeSlider.min = "0";
      timeSlider.max = String(Math.max(1, duration));
      if (!liveMode && !opts?.keepPlayhead) timeSlider.value = "0";
    }
    updateTimeDisplay();
  }
  updateScrubberChrome();
}

function updateTimeDisplay() {
  if (!timeDisplay || !timeSlider) return;
  if (liveMode) {
    // 直播：显示本机系统时钟，不显示「载入至今」时长
    timeDisplay.innerText = formatClockNow();
    timeSlider.disabled = true;
    timeSlider.value = timeSlider.max || "0";
    drawPlayerTimelineClock();
    return;
  }
  timeSlider.disabled = false;
  const showTs = needleDisplayTs();
  const day0 = displayDayOriginTs(showTs || currentTime || Date.now());
  const dayEnd = displayDayEndTs(day0);
  // 从当天 0:00 起算，绝不拿 Unix 绝对时间去减 0
  const relativeTime = day0 > 0 ? Math.max(0, showTs - day0) : 0;
  const totalDuration =
    day0 > 0
      ? Math.max(
          0,
          (endTime > startTime ? Math.min(endTime, dayEnd) : dayEnd) - day0
        )
      : Math.max(0, endTime - startTime);
  const waitMark =
    prefetchUrgent() && !dayFullyStreamed(activeStream) ? " · 等缓存" : "";
  timeDisplay.innerText = `${formatTime(relativeTime)} / ${formatTime(
    totalDuration
  )}${waitMark}`;
  if (day0 > 0) {
    timeSlider.min = "0";
    timeSlider.max = String(Math.max(1, dayEnd - day0));
    timeSlider.value = String(Math.max(0, Math.min(dayEnd - day0, showTs - day0)));
  } else {
    timeSlider.value = Math.max(0, currentTime - startTime).toString();
  }
  drawPlayerTimelineClock();
}

function togglePlayPause() {
  if (liveMode) return;
  // 允许在空白处按播放继续读秒；无任何缓存时仍需先有数据或正在预取
  if (!(endTime > startTime) && !playlistLoadBusy && currentTime <= 0) return;
  isPlaying = !isPlaying;
  btnPlay.innerText = isPlaying ? "⏸" : "▶";
  lastTime = performance.now();
}

function findLastKnownMouse(time: number) {
  if (mouseTrace.length === 0) return null;
  let left = 0,
    right = mouseTrace.length - 1;
  let bestMatch = null;
  while (left <= right) {
    const mid = Math.floor((left + right) / 2);
    if (mouseTrace[mid].ts <= time) {
      bestMatch = mouseTrace[mid];
      left = mid + 1;
    } else {
      right = mid - 1;
    }
  }
  return bestMatch;
}

function hasPlaybackSceneAt(ts: number): boolean {
  if (liveMode) {
    return (
      mouseTrace.length > 0 ||
      windowHistory.length > 0 ||
      (winMapMod?.latestEventTs?.() ?? 0) > 0 ||
      (imeMod?.latestEventTs?.() ?? 0) > 0
    );
  }
  if (prefetchUrgent()) return false;
  if (!(endTime > startTime)) return false;
  if (ts < startTime || ts > endTime) return false;
  return true;
}

function renderFrame() {
  const stage = document.getElementById("stage") as HTMLElement;
  const viewW = stage?.clientWidth || window.innerWidth;
  const viewH = stage?.clientHeight || window.innerHeight;

  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, viewW, viewH);

  if (!hasPlaybackSceneAt(currentTime)) {
    return;
  }

  const vw = Math.max(1, desk.w);
  const vh = Math.max(1, desk.h);
  // PotPlayer：contain 自适应，黑边 letterbox，不裁切
  const scale = Math.min(viewW / vw, viewH / vh);

  ctx.save();
  ctx.translate(viewW / 2, viewH / 2);
  ctx.scale(scale, scale);
  ctx.translate(-(desk.x + vw / 2), -(desk.y + vh / 2));

  drawDesktopWallpapers(ctx);

  winMapMod?.render({
    canvas,
    ctx,
    currentTime,
    virtualScreen: { width: vw, height: vh },
    scale,
  });

  // 任务栏按钮图标
  const bars = winMapMod?.taskbarsAt(currentTime) || [];
  for (const bar of bars) {
    for (const btn of bar.buttons || []) {
      if (!btn.icon_rel) continue;
      const img = iconImgCache.get(btn.icon_rel);
      if (!img) {
        void ensureIcon(btn.icon_rel);
        continue;
      }
      const [bx, by, bw, bh] = btn.bounds;
      const s = Math.min(bw, bh) * 0.7;
      ctx.drawImage(img, bx + (bw - s) / 2, by + (bh - s) / 2, s, s);
    }
  }

  let activeWindow: {
    ts?: number;
    app?: string;
    title?: string;
    bounds?: number[];
  } | null = null;
  for (const win of windowHistory) {
    if (win.ts <= currentTime) activeWindow = win;
    else break;
  }
  if (activeWindow?.bounds) {
    // 焦点流更新慢；拖动时几何以 win_map（含 win_bounds）为准，避免原地再留一个「残影窗」
    let [x, y, w, h] = activeWindow.bounds;
    const mapWins = winMapMod?.windowsAt(currentTime) || [];
    const titleHint = String(activeWindow.title || "").trim();
    const appHint = String(activeWindow.app || "").trim().toLowerCase();
    const matched =
      mapWins.find(
        (w) => titleHint && String(w.title || "").trim() === titleHint
      ) ||
      mapWins.find(
        (w) =>
          appHint &&
          String(w.exe || "")
            .toLowerCase()
            .includes(appHint.replace(/\.exe$/i, ""))
      ) ||
      mapWins.find((w) => w.z === 0);
    if (matched?.bounds && matched.bounds.length >= 4) {
      [x, y, w, h] = matched.bounds as [number, number, number, number];
    }
    const lw = 1 / scale;
    ctx.strokeStyle = "rgba(94, 224, 196, 0.95)";
    ctx.lineWidth = lw;
    if (w > lw * 2 && h > lw * 2) {
      ctx.strokeRect(x + lw / 2, y + lw / 2, w - lw, h - lw);
    }
    // 标题已由 win_map 顶栏画过；此处只描绿框，不再叠第二块顶栏
  }

  const lastKnownMouse = findLastKnownMouse(currentTime);
  if (lastKnownMouse) {
    const tailDuration = 800;
    const t0 = currentTime - tailDuration;
    let lo = 0;
    let hi = mouseTrace.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (mouseTrace[mid].ts < t0) lo = mid + 1;
      else hi = mid;
    }
    let right = 0;
    hi = mouseTrace.length;
    let l2 = 0;
    while (l2 < hi) {
      const mid = (l2 + hi) >> 1;
      if (mouseTrace[mid].ts <= currentTime) l2 = mid + 1;
      else hi = mid;
    }
    right = l2;
    const n = right - lo;
    if (n > 1) {
      ctx.beginPath();
      const maxPts = 64;
      if (n <= maxPts) {
        ctx.moveTo(mouseTrace[lo].x, mouseTrace[lo].y);
        for (let i = lo + 1; i < right; i++) ctx.lineTo(mouseTrace[i].x, mouseTrace[i].y);
      } else {
        const step = (n - 1) / (maxPts - 1);
        const p0 = mouseTrace[lo];
        ctx.moveTo(p0.x, p0.y);
        for (let k = 1; k < maxPts; k++) {
          const p = mouseTrace[lo + Math.round(k * step)];
          ctx.lineTo(p.x, p.y);
        }
      }
      ctx.strokeStyle = "rgba(0, 200, 255, 0.45)";
      ctx.lineWidth = 2 / scale;
      ctx.stroke();
    }
  }
  if (lastKnownMouse) {
    // 在桌面坐标里按系统指针像素画；外层 scale 会随播放窗口一起缩放
    drawWinCursor(ctx, lastKnownMouse.x, lastKnownMouse.y);
  }

  imeMod?.render({
    canvas,
    ctx,
    currentTime,
    virtualScreen: { width: vw, height: vh },
    scale,
  });

  ctx.restore();
}

/**
 * 经典 Windows 箭头。
 * 高度对齐系统指针桌面像素（cursorSizePx），随画面 contain 缩放，
 * 不再强行钉死屏幕像素（否则窗口缩小时指针会显得巨大）。
 */
function drawWinCursor(ctx: CanvasRenderingContext2D, x: number, y: number) {
  // 路径包围盒大约高 25、宽 16 → 用高度对齐系统尺寸
  const pathH = 25;
  const s = Math.max(8, cursorSizePx) / pathH;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(s, s);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, 21);
  ctx.lineTo(5, 16);
  ctx.lineTo(9, 25);
  ctx.lineTo(13, 23);
  ctx.lineTo(9, 14);
  ctx.lineTo(16, 14);
  ctx.closePath();
  ctx.lineJoin = "miter";
  ctx.miterLimit = 2;
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#000000";
  // 描边随缩放保持约 1 桌面像素视觉宽度
  ctx.lineWidth = 1.1;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

let lastTime = performance.now();
const PLAY_GEN = ((window as unknown as { __omniPlayGen?: number }).__omniPlayGen =
  ((window as unknown as { __omniPlayGen?: number }).__omniPlayGen || 0) + 1);
let playbackLoopStarted = false;
function playbackLoop() {
  if ((window as unknown as { __omniPlayGen?: number }).__omniPlayGen !== PLAY_GEN) {
    return;
  }
  const now = performance.now();
  const deltaMs = now - lastTime;
  lastTime = now;
  const playerVisible =
    !!document.getElementById("page-player")?.classList.contains("active");

  if (isPlaying && !liveMode) {
    tryResolvePendingSeek();
    const frontier = playableCacheEnd();
    currentTime += deltaMs * playbackSpeed;
    // 未读完：卡在缓存条前沿等预取。已读完或空白：继续往前读秒，不自动跳下一天
    if (
      frontier > 0 &&
      currentTime > frontier &&
      !dayFullyStreamed(activeStream)
    ) {
      currentTime = frontier;
      if (!playlistLoadBusy) void ensurePlaybackPrefetch();
    } else if (
      !playlistLoadBusy &&
      !dayFullyStreamed(activeStream) &&
      frontier > 0 &&
      frontier - currentTime < PREFETCH_AHEAD_MS * 0.6
    ) {
      void ensurePlaybackPrefetch();
    }
    updateTimeDisplay();
    if (playerVisible) {
      renderFrame();
    }
  } else if (liveMode) {
    // 播放头跟「已收到的最新事件钟」走，避免 Date.now() 与落盘时间错位把轨迹抽飞
    if (endTime > 0) currentTime = endTime;
    if (now - lastLivePollMs >= 16) {
      lastLivePollMs = now;
      void livePollOnce();
    }
    cacheRatio = 1;
    updateTimeDisplay();
    if (playerVisible) {
      renderFrame();
    }
  }
  requestAnimationFrame(playbackLoop);
}

/** 单屏内 cover：保持壁纸比例，裁切填满该显示器（类似 Win「填充」） */
function drawImageCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  dx: number,
  dy: number,
  dw: number,
  dh: number
) {
  const iw = img.naturalWidth || img.width;
  const ih = img.naturalHeight || img.height;
  if (iw <= 0 || ih <= 0 || dw <= 0 || dh <= 0) return;
  const sc = Math.max(dw / iw, dh / ih);
  const sw = dw / sc;
  const sh = dh / sc;
  const sx = (iw - sw) / 2;
  const sy = (ih - sh) / 2;
  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
}

function drawDesktopWallpapers(ctx: CanvasRenderingContext2D) {
  const vw = Math.max(1, desk.w);
  const vh = Math.max(1, desk.h);
  ctx.fillStyle = "#12304a";
  ctx.fillRect(desk.x, desk.y, vw, vh);

  const perScreen = monitorWallpapers.filter((m) => m.img && m.img.complete);
  if (perScreen.length > 0) {
    for (const mw of perScreen) {
      const [l, t, r, b] = mw.bounds;
      try {
        drawImageCover(ctx, mw.img!, l, t, Math.max(1, r - l), Math.max(1, b - t));
      } catch {
        ctx.fillStyle = "#1a3a5c";
        ctx.fillRect(l, t, Math.max(1, r - l), Math.max(1, b - t));
      }
    }
    return;
  }

  // 旧日志只有一张 wallpaper_path：仍按显示器几何分屏画，绝不跨双屏拉伸
  if (wallpaperImg && wallpaperImg.complete) {
    const mons =
      deskMonitors.length > 0
        ? deskMonitors
        : [
            {
              left: desk.x,
              top: desk.y,
              right: desk.x + desk.w,
              bottom: desk.y + desk.h,
            },
          ];
    for (const m of mons) {
      const l = m.left;
      const t = m.top;
      const w = Math.max(1, m.right - m.left);
      const h = Math.max(1, m.bottom - m.top);
      try {
        drawImageCover(ctx, wallpaperImg, l, t, w, h);
      } catch {
        ctx.fillStyle = "#1a3a5c";
        ctx.fillRect(l, t, w, h);
      }
    }
  }
}

function monitorsFromPayload(payload: any): any[] {
  if (Array.isArray(payload?.monitors) && payload.monitors.length) {
    return payload.monitors;
  }
  const vm = payload?.virtual?.monitors;
  if (!Array.isArray(vm) || !vm.length) return [];
  const path =
    (typeof payload?.wallpaper_path === "string" && payload.wallpaper_path) ||
    (typeof payload?.path === "string" && payload.path) ||
    "";
  return vm.map((m: any, i: number) => ({
    index: i,
    primary: !!m.primary,
    bounds: [m.left, m.top, m.right, m.bottom],
    wallpaper_path: path || null,
    path: path || null,
    backup_rel: m.backup_rel || null,
  }));
}

function applyDisplayFromPayload(payload: any) {
  const v = payload?.virtual;
  if (v && typeof v.w === "number" && typeof v.h === "number") {
    desk = {
      x: v.x ?? 0,
      y: v.y ?? 0,
      w: Math.max(1, v.w),
      h: Math.max(1, v.h),
    };
  }
  if (Array.isArray(v?.monitors)) {
    deskMonitors = v.monitors.map((m: any) => ({
      left: Number(m.left),
      top: Number(m.top),
      right: Number(m.right),
      bottom: Number(m.bottom),
      primary: !!m.primary,
    }));
  }
  if (Array.isArray(payload?.cursor_size) && payload.cursor_size[0] > 0) {
    cursorSizePx = Number(payload.cursor_size[0]);
  }
  const mons = monitorsFromPayload(payload);
  if (mons.length) {
    void applyMonitorWallpapers(mons);
  } else if (typeof payload?.wallpaper_path === "string" && payload.wallpaper_path) {
    void ensureWallpaper(payload.wallpaper_path);
  }
}

async function refreshSystemCursorSize() {
  try {
    const sz = await invoke<[number, number]>("get_system_cursor_size");
    if (sz?.[0] > 0) {
      cursorSizePx = Number(sz[0]);
      renderFrame();
    }
  } catch {
    /* 非桌面环境忽略 */
  }
}

async function applyMonitorWallpapers(monitors: any[]) {
  const next: MonitorWp[] = [];
  for (const m of monitors) {
    const bounds = m?.bounds;
    if (!Array.isArray(bounds) || bounds.length < 4) continue;
    const b: [number, number, number, number] = [
      Number(bounds[0]),
      Number(bounds[1]),
      Number(bounds[2]),
      Number(bounds[3]),
    ];
    const key =
      String(m.device_path || m.index || "") +
      `@${b[0]},${b[1]},${b[2]},${b[3]}`;
    let srcKey = "";
    let img: HTMLImageElement | null = null;
    if (typeof m.backup_rel === "string" && m.backup_rel) {
      srcKey = `rel:${m.backup_rel}`;
      img = await loadWallpaperByRel(m.backup_rel);
    } else if (typeof m.wallpaper_path === "string" && m.wallpaper_path) {
      srcKey = `path:${m.wallpaper_path}`;
      img = await loadWallpaperByPath(m.wallpaper_path);
    } else if (typeof m.path === "string" && m.path) {
      srcKey = `path:${m.path}`;
      img = await loadWallpaperByPath(m.path);
    }
    const prev = monitorWallpapers.find((x) => x.key === key && x.srcKey === srcKey);
    next.push({
      key,
      bounds: b,
      srcKey,
      img: img || prev?.img || null,
    });
  }
  if (next.length) {
    monitorWallpapers = next;
    renderFrame();
  }
}

async function loadWallpaperByRel(rel: string): Promise<HTMLImageElement | null> {
  try {
    const abs = await invoke<string>("resolve_win_map_asset", { rel });
    return await loadWallpaperByPath(abs);
  } catch {
    return null;
  }
}

async function loadWallpaperByPath(path: string): Promise<HTMLImageElement | null> {
  if (!path) return null;
  try {
    const url = await invoke<string>("read_file_as_data_url", { filePath: path });
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej();
      img.src = url;
    });
    return img;
  } catch {
    return null;
  }
}

async function ensureWallpaperAsset(rel: string) {
  if (!rel || rel === wallpaperPathLoaded) return;
  try {
    const abs = await invoke<string>("resolve_win_map_asset", { rel });
    await ensureWallpaper(abs);
  } catch {
    /* 备份缺失时忽略 */
  }
}

async function ensureWallpaper(path: string) {
  if (!path || path === wallpaperPathLoaded) return;
  try {
    const url = await invoke<string>("read_file_as_data_url", { filePath: path });
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej();
      img.src = url;
    });
    wallpaperImg = img;
    wallpaperPathLoaded = path;
    // 旧数据无 per-monitor 列表时，用几何分屏补齐
    if (!monitorWallpapers.some((m) => m.img) && deskMonitors.length) {
      void applyMonitorWallpapers(
        deskMonitors.map((m, i) => ({
          index: i,
          primary: !!m.primary,
          bounds: [m.left, m.top, m.right, m.bottom],
          path,
          wallpaper_path: path,
        }))
      );
    } else {
      renderFrame();
    }
  } catch {
    /* 壁纸文件可能被权限挡住，忽略 */
  }
}

async function ensureIcon(rel: string): Promise<HTMLImageElement | null> {
  if (iconImgCache.has(rel)) return iconImgCache.get(rel)!;
  try {
    const abs = await invoke<string>("resolve_win_map_asset", { rel });
    const url = await invoke<string>("read_file_as_data_url", { filePath: abs });
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej();
      img.src = url;
    });
    iconImgCache.set(rel, img);
    return img;
  } catch {
    return null;
  }
}

function ingestModuleJsonl(text: string, append: boolean) {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const focusEv: ModuleEvent[] = [];
  const winEv: ModuleEvent[] = [];
  const imeEv: ModuleEvent[] = [];
  for (const l of lines) {
    try {
      const o = JSON.parse(l);
      if (o.module === "focus" && o.kind === "focus_change") {
        focusEv.push(o);
        windowHistory.push({
          ts: o.ts,
          app: o.payload?.app,
          title: o.payload?.title,
          bounds: o.payload?.bounds,
        });
      } else if (o.module === "win_map") {
        winEv.push(o);
        if (o.kind === "display_setup") applyDisplayFromPayload(o.payload);
        if (o.kind === "wallpaper") {
          const mons = monitorsFromPayload(o.payload);
          if (mons.length) {
            void applyMonitorWallpapers(mons);
          } else if (typeof o.payload?.backup_rel === "string" && o.payload.backup_rel) {
            void ensureWallpaperAsset(o.payload.backup_rel);
          } else if (typeof o.payload?.path === "string") {
            // 旧格式：只有 path → 仍按 deskMonitors 分屏
            void ensureWallpaper(o.payload.path).then(() => renderFrame());
          }
        }
      } else if (o.module === "ime") {
        imeEv.push(o);
      } else if (typeof o.ts === "number" && o.bounds) {
        // 旧 win_context
        windowHistory.push(o);
      }
    } catch {
      /* skip */
    }
  }
  if (!append) {
    // already rebuilding lists from full text in callers that set append false
  }
  windowHistory.sort((a, b) => a.ts - b.ts);
  if (!append) {
    winMapMod?.load(winEv);
    const focusMod = playbackRegistry.get("focus") as any;
    focusMod?.load?.(focusEv);
    imeMod?.load(imeEv);
  } else {
    winMapMod?.append?.(winEv);
    const focusMod = playbackRegistry.get("focus") as any;
    focusMod?.append?.(focusEv);
    imeMod?.append?.(imeEv);
  }
}

function ingestJsonlText(text: string, append: boolean) {
  if (!append) {
    windowHistory = [];
    winMapMod?.load([]);
  }
  ingestModuleJsonl(text, append);
}

function envLatestTs(): number {
  let t = 0;
  if (windowHistory.length) t = Math.max(t, windowHistory[windowHistory.length - 1].ts);
  t = Math.max(t, winMapMod?.latestEventTs?.() ?? 0);
  t = Math.max(t, imeMod?.latestEventTs?.() ?? 0);
  return t;
}

function contentFrontierTs(): number {
  let t = 0;
  if (mouseTrace.length) t = Math.max(t, mouseTrace[mouseTrace.length - 1].ts);
  t = Math.max(t, envLatestTs());
  return t;
}

function dayFullyStreamed(stream: DayStreamState | null): boolean {
  if (!stream) return false;
  if (activeRec?.bin_path && !stream.binEof) return false;
  return stream.env.every((e) => e.eof);
}

function updateCacheRatioForDay(date: string) {
  const b = dayBoundsMs(date);
  const span = Math.max(1, b.t1 - b.t0);
  if (!(endTime > startTime)) {
    cacheRatio = 0;
    return;
  }
  cacheRatio = Math.min(1, Math.max(0, (endTime - b.t0) / span));
  if (dayFullyStreamed(activeStream)) cacheRatio = 1;
}

function prefetchTargetTs(fromTs: number): number {
  // 加载预取不跟 2048× 倍速暴涨，否则会一次狂读半天
  const speed = Math.max(1, Math.min(playbackSpeed, 4));
  return fromTs + PREFETCH_AHEAD_MS * speed;
}

/** 流式停点：针位 + 够播窗；idle 时再略伸一点 */
function streamStopTs(baseUntil: number, pace: "race" | "idle"): number {
  const needle = Math.max(currentTime, pendingSeekTs ?? 0);
  const pad = pace === "race" ? PLAYABLE_AHEAD_MS : PREFETCH_AHEAD_MS;
  return Math.floor(Math.max(baseUntil, needle + pad));
}

/** 每种 kind 只留全文最后一行。直播截尾后用来补回 display_setup / wallpaper。 */
function lastJsonlLinesByKind(text: string, kinds: string[]): string {
  const found = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    for (const k of kinds) {
      if (line.includes(`"kind":"${k}"`)) found.set(k, line);
    }
  }
  return kinds
    .map((k) => found.get(k))
    .filter((x): x is string => !!x)
    .join("\n");
}

function dateFromWinMapPath(path: string): Date | null {
  const y = path.match(/Year_(\d{4})/i);
  const m = path.match(/Month_(\d{2})/i);
  const d = path.match(/events_(\d{2})\.jsonl/i);
  if (!y || !m || !d) return null;
  return new Date(Number(y[1]), Number(m[1]) - 1, Number(d[1]));
}

function winMapPathForDate(templatePath: string, d: Date): string {
  const y = d.getFullYear();
  const mo = d.getMonth() + 1;
  const day = d.getDate();
  const century = Math.floor(y / 100) + 1;
  return templatePath
    .replace(/Century_\d+/i, `Century_${String(century).padStart(8, "0")}`)
    .replace(/Year_\d+/i, `Year_${String(y).padStart(4, "0")}`)
    .replace(/Month_\d+/i, `Month_${String(mo).padStart(2, "0")}`)
    .replace(/events_\d+\.jsonl/i, `events_${String(day).padStart(2, "0")}.jsonl`);
}

/** 当日 jsonl 若无 display_setup/wallpaper（跨日未重写），向前一天取最后一条。 */
async function ingestStickyWinMapFromPrevDays(winMapPath: string): Promise<void> {
  const start = dateFromWinMapPath(winMapPath);
  if (!start) return;
  let setup = "";
  let wp = "";
  for (let i = 1; i <= 14; i++) {
    const d = new Date(start.getTime());
    d.setDate(d.getDate() - i);
    const p = winMapPathForDate(winMapPath, d);
    let text = "";
    try {
      text = await invoke<string>("read_jsonl_file", { filePath: p });
    } catch {
      continue;
    }
    if (!text) continue;
    if (!setup) setup = lastJsonlLinesByKind(text, ["display_setup"]);
    if (!wp) wp = lastJsonlLinesByKind(text, ["wallpaper"]);
    if (setup && wp) break;
  }
  const lines = [setup, wp].filter(Boolean).join("\n");
  if (lines) ingestJsonlText(lines + "\n", true);
}

function lastTsInJsonlBlock(text: string): number {
  let t = 0;
  for (const l of text.split("\n")) {
    if (!l.trim()) continue;
    try {
      const o = JSON.parse(l);
      if (typeof o.ts === "number" && o.ts > t) t = o.ts;
    } catch {
      /* skip */
    }
  }
  return t;
}

async function streamEnvUntil(
  cur: EnvStreamCursor,
  untilTs: number,
  append: boolean,
  gen: number,
  opts?: { quiet?: boolean; pace?: "race" | "idle" }
) {
  if (cur.eof) return;
  const quiet = !!opts?.quiet;
  const pace = opts?.pace ?? (quiet ? "idle" : "race");
  let total = 0;
  try {
    total = await invoke<number>("get_file_size", { filePath: cur.path });
  } catch {
    total = 0;
  }
  const dec = new TextDecoder();
  let lastPaint = 0;
  while (!cur.eof) {
    if (gen !== loadGen) return;
    if (prefetchUrgent()) return;
    const stopAt = streamStopTs(untilTs, pace);
    if (append && cur.lastTs >= stopAt) return;
    const chunk = await invoke<{
      data_b64: string;
      next_offset: number;
      eof: boolean;
    }>("read_file_chunk", {
      filePath: cur.path,
      offset: cur.offset,
      maxLen: READ_CHUNK,
    });
    if (gen !== loadGen) return;
    const bytes = b64ToU8(chunk.data_b64);
    cur.carry += dec.decode(bytes, { stream: !chunk.eof });
    const parts = cur.carry.split("\n");
    cur.carry = chunk.eof ? "" : parts.pop() ?? "";
    const block = parts.join("\n");
    if (block.trim()) {
      ingestModuleJsonl(block, true);
      cur.lastTs = Math.max(cur.lastTs, lastTsInJsonlBlock(block));
    }
    if (chunk.eof && cur.carry.trim()) {
      ingestModuleJsonl(cur.carry, true);
      cur.lastTs = Math.max(cur.lastTs, lastTsInJsonlBlock(cur.carry));
      cur.carry = "";
    }
    cur.offset = chunk.next_offset;
    cur.eof = chunk.eof;
    const now = performance.now();
    if (!quiet && now - lastPaint > 400) {
      lastPaint = now;
      calculateTimeBounds({ keepPlayhead: true });
      tryResolvePendingSeek();
      renderFrame();
      updateTimeDisplay();
      drawPlayerTimeline();
    } else if (quiet && now - lastPaint > 120) {
      lastPaint = now;
      tryResolvePendingSeek();
      drawPlayerTimeline();
    }
    if (prefetchUrgent() || pace === "race") await yieldRace();
    else await yieldIdle();
    if (total > 0 && cur.offset >= total && chunk.eof) cur.eof = true;
  }
}

async function streamBinUntil(
  path: string,
  stream: DayStreamState,
  untilTs: number,
  gen: number,
  reset: boolean,
  opts?: { quiet?: boolean; pace?: "race" | "idle" }
) {
  if (stream.binEof || !path) return;
  const quiet = !!opts?.quiet;
  const pace = opts?.pace ?? (quiet ? "idle" : "race");
  if (reset) {
    // 禁止用 Date.now()：会被当成已超过历史 seek，Rust 端零字节假完成
    resetDecoder(0);
    stream.binOffset = 0;
    stream.binEof = false;
    decodeFrontierTs = 0;
  }
  if (stream.binTotal <= 0) {
    try {
      stream.binTotal = await invoke<number>("get_file_size", { filePath: path });
    } catch {
      stream.binTotal = 0;
    }
  }
  const epoch = binEpoch;
  let ticks = 0;
  let lastUi = 0;
  while (!stream.binEof) {
    if (gen !== loadGen || epoch !== binEpoch) return;
    const stopAt = streamStopTs(untilTs, pace);
    if (decTs >= stopAt && mouseTrace.length > 8) return;

    const lag = stopAt - decTs;
    const racing = pace === "race" || prefetchUrgent() || lag > 20_000;
    // 赶进度时 Rust 一次多啃；够播后小块慢补
    const maxBytes = racing ? 1024 * 1024 : 64 * 1024;

    const prevOff = stream.binOffset;
    let r: {
      next_offset: number;
      eof: boolean;
      dec_ts: number;
      dec_x: number;
      dec_y: number;
      carry_b64: string;
      samples: { ts: number; x: number; y: number }[];
      reached: boolean;
    };
    try {
      const raw = await invoke<Record<string, unknown>>("advance_bin_decode", {
        filePath: path,
        offset: Math.floor(Math.max(0, stream.binOffset)),
        maxBytes: Math.floor(maxBytes),
        untilTs: Math.floor(Math.max(0, stopAt)),
        keepFloorTs: Math.floor(Math.max(0, mouseKeepFloorTs)),
        seedTs: Math.floor(Math.max(0, decTs)),
        seedX: Math.trunc(decX),
        seedY: Math.trunc(decY),
        carryB64: u8ToB64(decCarry),
      });
      // 兼容 snake / camel（避免字段读成 undefined 导致永不推进）
      r = {
        next_offset: Number(raw.next_offset ?? raw.nextOffset ?? prevOff),
        eof: !!(raw.eof ?? false),
        dec_ts: Number(raw.dec_ts ?? raw.decTs ?? decTs),
        dec_x: Number(raw.dec_x ?? raw.decX ?? decX),
        dec_y: Number(raw.dec_y ?? raw.decY ?? decY),
        carry_b64: String(raw.carry_b64 ?? raw.carryB64 ?? ""),
        samples: (raw.samples as { ts: number; x: number; y: number }[]) || [],
        reached: !!(raw.reached ?? false),
      };
    } catch (e) {
      showError(e);
      return;
    }
    if (gen !== loadGen || epoch !== binEpoch) return;
    decTs = r.dec_ts;
    decX = r.dec_x;
    decY = r.dec_y;
    decCarry = b64ToU8(r.carry_b64);
    stream.binOffset = r.next_offset;
    stream.binEof = r.eof;
    if (r.dec_ts > decodeFrontierTs && r.dec_ts > 1_000_000_000_000) {
      decodeFrontierTs = r.dec_ts;
    }
    if (r.samples.length) {
      for (const s of r.samples) {
        mouseTrace.push({ ts: s.ts, x: s.x, y: s.y });
      }
    }
    ticks++;

    // 无字节进度且声称到达 → 停，避免死循环
    if (r.next_offset <= prevOff && !r.samples.length && (r.reached || r.eof)) {
      stream.binEof = stream.binEof || r.eof;
      break;
    }

    const now = performance.now();
    if (now - lastUi > (racing ? 60 : 400)) {
      lastUi = now;
      calculateTimeBounds({ keepPlayhead: true });
      tryResolvePendingSeek();
      drawPlayerTimeline();
      if (!quiet || prefetchUrgent()) {
        renderFrame();
        updateTimeDisplay();
      }
    } else if (racing && now - lastUi > 16) {
      lastUi = now;
      drawPlayerTimeline();
    }

    if (r.reached && (mouseTrace.length > 8 || r.dec_ts >= stopAt)) return;
    if (!r.samples.length && r.eof) return;
    if (!racing && r.reached) return;

    if (racing) await yieldRace();
    else await yieldIdle();
  }
}

function dateKeyFromTs(ts: number) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

function clearPlaybackBuffers() {
  mouseTrace = [];
  windowHistory = [];
  winMapMod?.load([]);
  (playbackRegistry.get("focus") as { load?: (e: ModuleEvent[]) => void } | undefined)?.load?.(
    []
  );
  imeMod?.load([]);
  wallpaperImg = null;
  wallpaperPathLoaded = "";
  monitorWallpapers = [];
  resetDecoder(0);
  startTime = 0;
  endTime = 0;
  currentTime = 0;
  cacheRatio = 0;
  activeStream = null;
  activeRec = null;
  updateScrubberChrome();
}

function clearDaySessionCaches() {
  daySessionCaches.clear();
  clearPlaybackBuffers();
  loadedDate = "";
  pendingSeekTs = null;
  loadGen++;
  playlistLoadBusy = false;
  setLoadUi(false);
  drawPlayerTimeline();
}

function stashCurrentDaySession() {
  if (!loadedDate || liveMode || !activeRec || !activeStream) return;
  const focusMod = playbackRegistry.get("focus") as
    | { exportEvents?: () => ModuleEvent[] }
    | undefined;
  daySessionCaches.set(loadedDate, {
    rec: activeRec,
    mouseTrace: mouseTrace.slice(),
    windowHistory: windowHistory.slice(),
    winMapEvents: winMapMod?.exportEvents?.() ?? [],
    focusEvents: focusMod?.exportEvents?.() ?? [],
    imeEvents: imeMod?.exportEvents?.() ?? [],
    decTs,
    decX,
    decY,
    decCarry: decCarry.slice(),
    startTime,
    endTime,
    currentTime,
    decodeFrontierTs,
    stream: {
      binOffset: activeStream.binOffset,
      binEof: activeStream.binEof,
      binTotal: activeStream.binTotal,
      env: activeStream.env.map((e) => ({
        ...e,
        lastTs: e.lastTs ?? 0,
      })),
    },
    desk: { ...desk },
    deskMonitors: deskMonitors.map((m) => ({ ...m })),
    wallpaperPathLoaded,
    monitorWallpapers: monitorWallpapers.slice(),
  });
}

function restoreDaySession(date: string): boolean {
  const c = daySessionCaches.get(date);
  if (!c) return false;
  mouseTrace = c.mouseTrace.slice();
  windowHistory = c.windowHistory.slice();
  winMapMod?.load(c.winMapEvents);
  (playbackRegistry.get("focus") as { load?: (e: ModuleEvent[]) => void } | undefined)?.load?.(
    c.focusEvents
  );
  imeMod?.load(c.imeEvents ?? []);
  decTs = c.decTs;
  decX = c.decX;
  decY = c.decY;
  decCarry = c.decCarry.slice();
  startTime = c.startTime;
  endTime = c.endTime;
  currentTime = c.currentTime;
  decodeFrontierTs = c.decodeFrontierTs || c.endTime || c.decTs || 0;
  desk = { ...c.desk };
  deskMonitors = c.deskMonitors.map((m) => ({ ...m }));
  wallpaperPathLoaded = c.wallpaperPathLoaded;
  monitorWallpapers = c.monitorWallpapers.slice();
  activeRec = c.rec;
  activeStream = {
    binOffset: c.stream.binOffset,
    binEof: c.stream.binEof,
    binTotal: c.stream.binTotal,
    env: c.stream.env.map((e) => ({
      ...e,
      lastTs: e.lastTs ?? 0,
    })),
  };
  loadedDate = date;
  updateCacheRatioForDay(date);
  updateTimeDisplay();
  renderFrame();
  drawPlayerTimeline();
  return true;
}

function newStreamState(rec: RecordingDay): DayStreamState {
  const envPaths = [
    rec.win_map_events_path,
    rec.focus_events_path ?? rec.jsonl_path,
    rec.ime_events_path,
  ].filter(Boolean) as string[];
  return {
    binOffset: 0,
    binEof: !rec.bin_path,
    binTotal: rec.bin_bytes || 0,
    env: envPaths.map((path) => ({
      path,
      offset: 0,
      eof: false,
      carry: "",
      lastTs: 0,
    })),
  };
}

async function refreshRecorderSpans() {
  try {
    const segs = await invoke<RecorderRunSpan[]>("recorder_run_spans");
    recorderSpans = Array.isArray(segs) ? segs : [];
  } catch {
    recorderSpans = [];
  }
  drawPlayerTimeline();
}

function startRecorderSpanPolling() {
  stopRecorderSpanPolling();
  if (recorderSpans.length === 0) {
    void refreshRecorderSpans();
  }
  recorderSpanTimer = window.setInterval(() => {
    if (!document.getElementById("page-player")?.classList.contains("active")) return;
    void refreshRecorderSpans();
  }, 4000);
}

function stopRecorderSpanPolling() {
  if (recorderSpanTimer != null) {
    window.clearInterval(recorderSpanTimer);
    recorderSpanTimer = null;
  }
}

let lastPlaylistRefreshedAt = 0;
let playlistRefreshTimer: number | null = null;
let playlistDwellTimer: number | null = null;
let playlistLoadGen = 0;
let playerHistBootTimer: number | null = null;

function isPlayerPageActive(): boolean {
  return !!document.getElementById("page-player")?.classList.contains("active");
}

function cancelPlayerBackgroundLoad() {
  playlistLoadGen++;
  cancelPlayerHeavyIpc();
  if (playlistRefreshTimer != null) {
    window.clearTimeout(playlistRefreshTimer);
    playlistRefreshTimer = null;
  }
  if (playlistDwellTimer != null) {
    window.clearTimeout(playlistDwellTimer);
    playlistDwellTimer = null;
  }
  if (playerHistBootTimer != null) {
    window.clearTimeout(playerHistBootTimer);
    playerHistBootTimer = null;
  }
}

function schedulePlaylistRefresh(force = false) {
  if (!isPlayerPageActive()) return;
  if (playlistRefreshTimer != null) window.clearTimeout(playlistRefreshTimer);
  const token = playlistLoadGen;
  const run = () => {
    playlistRefreshTimer = null;
    if (token !== playlistLoadGen || !isPlayerPageActive()) return;
    void refreshPlaylist(force);
  };
  const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
    .requestIdleCallback;
  if (ric) ric(run, { timeout: 3000 });
  else playlistRefreshTimer = window.setTimeout(run, 200);
}

async function refreshPlaylist(force = false) {
  const token = playlistLoadGen;
  const now = performance.now();
  if (!force && playlist.length > 0 && now - lastPlaylistRefreshedAt < 30_000) {
    if (isPlayerPageActive()) drawPlayerTimeline();
    return;
  }
  if (!isPlayerPageActive()) return;
  lastPlaylistRefreshedAt = now;
  try {
    if (!defaultDataRoot) {
      defaultDataRoot = await runHeavyIpc(
        "get_data_root",
        () => invoke<string>("get_data_root"),
        {
          cancelled: () => token !== playlistLoadGen || !isPlayerPageActive(),
          playerScope: true,
        }
      );
    }
  } catch {
    /* keep */
  }
  if (token !== playlistLoadGen || !isPlayerPageActive()) return;
  try {
    playlist = await runHeavyIpc(
      "list_recordings",
      () => invoke<RecordingDay[]>("list_recordings"),
      {
        cancelled: () => token !== playlistLoadGen || !isPlayerPageActive(),
        playerScope: true,
      }
    );
  } catch (e) {
    if (token !== playlistLoadGen) return;
    if (e instanceof Error && e.message === "cancelled") return;
    showError(e);
    playlist = [];
  }
  if (token !== playlistLoadGen || !isPlayerPageActive()) return;
  void refreshRecorderSpans();
  drawPlayerTimeline();
  schedulePlayerHistRefresh();
}

/** 把当前日流式补到 untilTs。pace=race 先尽快够播；idle 再慢补（AE 式）。 */
async function streamDayUntil(
  untilTs: number,
  gen: number,
  opts?: { quiet?: boolean; pace?: "race" | "idle"; env?: boolean }
) {
  if (!activeRec || !activeStream) return;
  const rec = activeRec;
  const stream = activeStream;
  const quiet = !!opts?.quiet;
  const pace = opts?.pace ?? (quiet ? "idle" : "race");
  const doEnv = opts?.env !== false;
  const note = (msg: string) => {
    if (!quiet) setLoadUi(true, msg, Math.max(0.05, cacheRatio || 0.05));
  };

  const raceBin = async () => {
    if (!rec.bin_path || stream.binEof) return;
    const racing = pace === "race" || prefetchUrgent();
    note(`预取物理流`);
    await streamBinUntil(
      rec.bin_path,
      stream,
      untilTs,
      gen,
      stream.binOffset === 0 && mouseTrace.length === 0,
      { quiet, pace: racing ? "race" : pace }
    );
    if (gen !== loadGen) return;
    calculateTimeBounds({ keepPlayhead: true });
    updateCacheRatioForDay(rec.date);
    tryResolvePendingSeek();
  };

  await raceBin();
  if (gen !== loadGen) return;

  if (doEnv) {
    for (const cur of stream.env) {
      if (gen !== loadGen) return;
      if (prefetchUrgent()) await raceBin();
      if (cur.eof) continue;
      const name = cur.path.includes("win_map")
        ? "窗口环境"
        : cur.path.includes("focus")
          ? "焦点环境"
          : cur.path.includes("ime")
            ? "输入法"
            : "环境流";
      note(`预取${name}`);
      await streamEnvUntil(cur, untilTs, true, gen, { quiet, pace: "idle" });
      if (gen !== loadGen) return;
      if (prefetchUrgent()) await raceBin();
      calculateTimeBounds({ keepPlayhead: true });
      updateCacheRatioForDay(rec.date);
    }
  }
  if (prefetchUrgent()) await raceBin();

  if (gen !== loadGen) return;
  calculateTimeBounds({ keepPlayhead: true });
  tryResolvePendingSeek();
  updateCacheRatioForDay(rec.date);
  updateTimeDisplay();
  renderFrame();
  drawPlayerTimeline();
}

/** 后台静默续缓存：慢补；针在前方时强制 race */
async function ensurePlaybackPrefetch() {
  if (liveMode || !activeRec || !activeStream) return;
  if (dayFullyStreamed(activeStream)) return;
  // 已有 race/idle 在跑：streamStopTs / prefetchUrgent 会把当前循环拉去赶针
  if (playlistLoadBusy) return;
  const from = Math.max(
    currentTime,
    pendingSeekTs ?? 0,
    contentFrontierTs() || currentTime
  );
  const until = prefetchTargetTs(from);
  if (
    contentFrontierTs() >= until &&
    activeStream.env.every((e) => e.eof || e.lastTs >= until)
  ) {
    return;
  }

  const gen = loadGen;
  const pace = prefetchUrgent() ? "race" : "idle";
  playlistLoadBusy = true;
  try {
    await streamDayUntil(until, gen, {
      quiet: true,
      pace,
      env: pace === "idle",
    });
  } catch (e) {
    if (gen === loadGen) showError(e);
  } finally {
    if (gen === loadGen) {
      playlistLoadBusy = false;
      setLoadUi(false);
      tryResolvePendingSeek();
      drawPlayerTimeline();
      // 针仍在前方则继续赶
      if (prefetchUrgent()) void ensurePlaybackPrefetch();
    }
  }
}

async function loadRecording(rec: RecordingDay, seekTs?: number) {
  const day0 = dayBoundsMs(rec.date).t0;
  const hasUsefulCache = () =>
    endTime > startTime ||
    decodeFrontierTs > day0 ||
    (!!activeStream && activeStream.binOffset > 0);

  // 同一天正在预取：只改针；若空壳卡死则中止重来
  if (playlistLoadBusy && loadedDate === rec.date) {
    if (seekTs != null) requestSeek(seekTs);
    if (hasUsefulCache()) return;
    loadGen++;
    playlistLoadBusy = false;
  }

  stopLive();

  // 同日已有会话：有缓存则 seek+续预取；空壳则当作冷启动
  if (loadedDate === rec.date && activeStream && activeRec && hasUsefulCache()) {
    if (seekTs != null) requestSeek(seekTs);
    const need = prefetchTargetTs(seekTs ?? currentTime);
    if (!dayFullyStreamed(activeStream) && contentFrontierTs() < need) {
      void ensurePlaybackPrefetch();
    }
    return;
  }

  if (loadedDate === rec.date) {
    daySessionCaches.delete(rec.date);
  }

  // 换日：先把当前日塞进会话缓存
  if (loadedDate && loadedDate !== rec.date) {
    stashCurrentDaySession();
  }

  // 目标日命中会话缓存 → 瞬时恢复
  if (loadedDate !== rec.date && daySessionCaches.has(rec.date)) {
    ++loadGen;
    restoreDaySession(rec.date);
    pendingSeekTs = seekTs ?? null;
    if (seekTs != null) requestSeek(seekTs);
    const need = prefetchTargetTs(
      seekTs ?? (currentTime || dayBoundsMs(rec.date).t0)
    );
    if (!dayFullyStreamed(activeStream) && contentFrontierTs() < need) {
      void ensurePlaybackPrefetch();
    } else {
      tryResolvePendingSeek();
      setLoadUi(false);
    }
    return;
  }

  // 新日冷启动：立刻可交互；Rust 赶进度够播后，再 idle 慢补（AE 式）
  const gen = ++loadGen;
  clearPlaybackBuffers();
  activeRec = rec;
  activeStream = newStreamState(rec);
  loadedDate = rec.date;
  pendingSeekTs = seekTs ?? null;
  playlistLoadBusy = true;
  updateScrubberChrome();

  const bootFrom = seekTs ?? dayBoundsMs(rec.date).t0;
  mouseKeepFloorTs = Math.max(0, bootFrom - 90_000);
  const playableUntil = bootFrom + PLAYABLE_AHEAD_MS;
  const idleUntil = Math.max(bootFrom + PREFETCH_BOOT_MS, prefetchTargetTs(bootFrom));

  const hasFiles = !!(rec.bin_path || (activeStream.env.length > 0));
  if (!hasFiles) {
    playlistLoadBusy = false;
    setLoadUi(true, `${rec.date} 没有可播文件`, 1);
    return;
  }
  setLoadUi(false);
  currentTime = bootFrom;
  updateTimeDisplay();
  drawPlayerTimeline();

  void (async () => {
    try {
      if (rec.win_map_events_path) {
        await ingestStickyWinMapFromPrevDays(rec.win_map_events_path);
        if (gen !== loadGen) return;
      }
      // 1) 只赶物理流到够播，环境流先别抢
      await streamDayUntil(playableUntil, gen, {
        quiet: true,
        pace: "race",
        env: false,
      });
      if (gen !== loadGen) return;
      tryResolvePendingSeek();
      calculateTimeBounds({ keepPlayhead: true });
      renderFrame();
      drawPlayerTimeline();

      // 2) idle 慢补：多留一点预取 + 环境
      playlistLoadBusy = true;
      await streamDayUntil(idleUntil, gen, {
        quiet: true,
        pace: "idle",
        env: true,
      });
    } catch (e) {
      if (gen === loadGen) showError(e);
    } finally {
      if (gen === loadGen) {
        playlistLoadBusy = false;
        setLoadUi(false);
        tryResolvePendingSeek();
        calculateTimeBounds({ keepPlayhead: true });
        updateTimeDisplay();
        renderFrame();
        drawPlayerTimeline();
        void ensurePlaybackPrefetch();
      }
    }
  })();
}

function showError(e: unknown) {
  console.error(e);
  setLoadUi(true, `错误：${String(e)}`, 0);
  window.setTimeout(() => {
    if (!playlistLoadBusy) setLoadUi(false);
  }, 4000);
}

async function livePollOnce() {
  if (!liveMode || livePollBusy) return;
  livePollBusy = true;
  try {
    if (liveBinPath) {
      const chunk = await invoke<{
        data_b64: string;
        next_offset: number;
      }>("read_file_from_offset", {
        filePath: liveBinPath,
        offset: liveBinOffset,
      });
      const bytes = b64ToU8(chunk.data_b64);
      if (bytes.length > 0) {
        appendBinBytes(bytes);
        liveBinOffset = chunk.next_offset;
      }
    }
    for (const [path, getOff, setOff] of [
      [
        liveJsonlPath,
        () => liveJsonlOffset,
        (n: number) => {
          liveJsonlOffset = n;
        },
      ],
      [
        liveWinMapPath,
        () => liveWinMapOffset,
        (n: number) => {
          liveWinMapOffset = n;
        },
      ],
      [
        liveImePath,
        () => liveImeOffset,
        (n: number) => {
          liveImeOffset = n;
        },
      ],
    ] as const) {
      if (!path) continue;
      const chunk = await invoke<{
        data_b64: string;
        next_offset: number;
      }>("read_file_from_offset", {
        filePath: path,
        offset: getOff(),
      });
      const bytes = b64ToU8(chunk.data_b64);
      if (bytes.length > 0) {
        const text = new TextDecoder().decode(bytes);
        ingestJsonlText(text, true);
        setOff(chunk.next_offset);
      }
    }
    // 播放头取「鼠标 / 焦点 / 窗口事件」里最晚的时间，避免只跟鼠标时窗轨迹被卡住
    let latest = 0;
    if (mouseTrace.length > 0) {
      latest = Math.max(latest, mouseTrace[mouseTrace.length - 1].ts);
      if (!startTime) startTime = mouseTrace[0].ts;
    }
    if (windowHistory.length > 0) {
      latest = Math.max(latest, windowHistory[windowHistory.length - 1].ts);
      if (!startTime) startTime = windowHistory[0].ts;
    }
    const winLatest = winMapMod?.latestEventTs?.() ?? 0;
    if (winLatest > 0) latest = Math.max(latest, winLatest);
    const imeLatest = imeMod?.latestEventTs?.() ?? 0;
    if (imeLatest > 0) latest = Math.max(latest, imeLatest);
    if (latest > 0) {
      endTime = latest;
      currentTime = latest;
    }
  } catch (e) {
    showError(e);
  } finally {
    livePollBusy = false;
  }
}

async function startLive() {
  stashCurrentDaySession();
  const today = await invoke<{
    data_root: string;
    bin_path: string | null;
    jsonl_path: string | null;
    focus_events_path: string | null;
    win_map_events_path: string | null;
    ime_events_path: string | null;
  }>("find_today_traces");

  defaultDataRoot = today.data_root;
  liveBinPath = today.bin_path ?? "";
  liveJsonlPath = today.focus_events_path ?? today.jsonl_path ?? "";
  liveWinMapPath = today.win_map_events_path ?? "";
  liveImePath = today.ime_events_path ?? "";

  if (!liveBinPath && !liveJsonlPath && !liveWinMapPath && !liveImePath) {
    setLoadUi(true, "还没有今日文件：请先启动采集器", 0);
    window.setTimeout(() => setLoadUi(false), 3500);
    return false;
  }

  stashCurrentDaySession();
  clearPlaybackBuffers();

  if (liveBinPath) {
    const all = await invoke<number[]>("read_trace_file", {
      filePath: liveBinPath,
    });
    const bytes = new Uint8Array(all);
    // 只从最近绝对坐标关键帧解起，丢掉此前可能已错乱的相对位移链
    const syncAt = findLastAbsoluteMouseOffset(bytes);
    resetDecoder(Date.now());
    appendBinBytes(bytes.subarray(syncAt));
    liveBinOffset = bytes.length;
  }
  windowHistory = [];
  winMapMod?.load([]);
  for (const p of [liveWinMapPath, liveJsonlPath, liveImePath]) {
    if (!p) continue;
    const allText = await invoke<string>("read_jsonl_file", { filePath: p });
    // 直播：大文件只吃尾部，避免旧 LOCATIONCHANGE 洪水 JSONL 拖死解析
    const tailChars = 512_000;
    const truncated = allText.length > tailChars;
    const text = truncated ? allText.slice(allText.length - tailChars) : allText;
    const cut = text.indexOf("\n");
    const safe = truncated && cut >= 0 ? text.slice(cut + 1) : text;
    if (p === liveWinMapPath) {
      const fileHasWp = allText.includes('"kind":"wallpaper"');
      const fileHasSetup = allText.includes('"kind":"display_setup"');
      if (!fileHasWp || !fileHasSetup) {
        await ingestStickyWinMapFromPrevDays(p);
      }
    }
    if (truncated && p === liveWinMapPath) {
      const need: string[] = [];
      if (!safe.includes('"kind":"display_setup"')) need.push("display_setup");
      if (!safe.includes('"kind":"wallpaper"')) need.push("wallpaper");
      if (need.length) {
        const seed = lastJsonlLinesByKind(allText, need);
        if (seed) ingestJsonlText(seed + "\n", true);
      }
    }
    ingestJsonlText(safe, true);
    const bytes = new TextEncoder().encode(allText).length;
    if (p === liveWinMapPath) liveWinMapOffset = bytes;
    if (p === liveJsonlPath) liveJsonlOffset = bytes;
    if (p === liveImePath) liveImeOffset = bytes;
  }

  calculateTimeBounds();
  currentTime = endTime > 0 ? endTime : Date.now();
  liveMode = true;
  isPlaying = false;
  btnPlay.innerText = "▶";
  btnLive.innerText = "⏹ 停直播";
  btnLive.style.color = "#ff4466";
  syncSpeedSelectUi();
  updateTimeDisplay();
  lastLivePollMs = 0;
  return true;
}

function stopLive() {
  liveMode = false;
  timeSlider.disabled = false;
  // 停直播后回到事件时间轴末尾，便于回看刚录的段
  if (mouseTrace.length) {
    currentTime = mouseTrace[mouseTrace.length - 1].ts;
  } else if (endTime > 0) {
    currentTime = endTime;
  }
  btnLive.innerText = "🔴 直播";
  btnLive.style.color = "";
  syncSpeedSelectUi();
  updateTimeDisplay();
  renderFrame();
}


export function initPlayer(appWin: {
  isFullscreen: () => Promise<boolean>;
  setFullscreen: (v: boolean) => Promise<void>;
}) {
  initCanvas();
  timeSlider = document.getElementById("time-slider") as HTMLInputElement;
  timeDisplay = document.getElementById("time-display")!;
  btnPlay = document.getElementById("btn-play") as HTMLButtonElement;
  btnLive = document.getElementById("btn-live") as HTMLButtonElement;
  speedSelect = document.getElementById("playback-speed") as HTMLSelectElement | null;
  speedCustomEl = document.getElementById("speed-custom");
  speedAmountEl = document.getElementById("speed-amount") as HTMLInputElement | null;
  speedUnitEl = document.getElementById("speed-unit") as HTMLSelectElement | null;
  speedEffEl = document.getElementById("speed-eff");
  speedSelect?.addEventListener("change", () => applyPlaybackSpeedFromUi());
  speedAmountEl?.addEventListener("input", () => applyPlaybackSpeedFromUi());
  speedUnitEl?.addEventListener("change", () => applyPlaybackSpeedFromUi());
  applyPlaybackSpeedFromUi();
  syncSpeedSelectUi();

  void runHeavyIpc("get_data_root", () => invoke<string>("get_data_root"))
    .then((root) => {
      defaultDataRoot = root;
      console.info(
        "[plugins]",
        playbackRegistry.list().map((i) => i.id).join(", "),
        "data_root=",
        defaultDataRoot
      );
    })
    .catch(() => {
      defaultDataRoot = "";
    });
  window.addEventListener("omnitrace-data-root", ((ev: Event) => {
    const path = (ev as CustomEvent<string>).detail;
    defaultDataRoot = typeof path === "string" && path ? path : "";
    lastPlaylistRefreshedAt = 0;
    if (isPlayerPageActive()) void refreshPlaylist(true);
  }) as EventListener);
  void refreshSystemCursorSize();

  window.addEventListener("resize", () => {
    initCanvas();
    renderFrame();
  });

  btnPlay.addEventListener("click", () => togglePlayPause());

  const timelineUiEl = document.getElementById("timeline-ui");
  const btnFullscreen = document.getElementById(
    "btn-fullscreen"
  ) as HTMLButtonElement | null;

  function setPlayerChrome(show: boolean) {
    playerChromeVisible = show;
    timelineUiEl?.classList.toggle("chrome-hidden", !show);
    document.getElementById("titlebar")?.classList.toggle("chrome-hidden", !show);
  }

  async function refreshFullscreenBtn() {
    if (!btnFullscreen) return;
    try {
      const fs = await appWin.isFullscreen();
      btnFullscreen.textContent = fs ? "⛶ 退出全屏" : "⛶ 全屏";
      btnFullscreen.title = fs ? "退出全屏 (Enter)" : "全屏 (Enter)";
    } catch {
      /* ignore */
    }
  }

  async function togglePlayerFullscreen() {
    try {
      const fs = await appWin.isFullscreen();
      await appWin.setFullscreen(!fs);
      await refreshFullscreenBtn();
    } catch (e) {
      showError(e);
    }
  }

  btnFullscreen?.addEventListener("click", (e) => {
    e.stopPropagation();
    void togglePlayerFullscreen();
  });
  void refreshFullscreenBtn();

  // 单击画面（非控件区）显隐顶栏 + 底部进度条
  const stageEl = document.getElementById("stage");
  let stagePtrDown: { x: number; y: number } | null = null;
  stageEl?.addEventListener("pointerdown", (e) => {
    const t = e.target as HTMLElement | null;
    if (!t || t.closest("#timeline-ui") || t.closest("#load-overlay.show")) {
      stagePtrDown = null;
      return;
    }
    stagePtrDown = { x: e.clientX, y: e.clientY };
  });
  stageEl?.addEventListener("pointerup", (e) => {
    if (!stagePtrDown) return;
    const dx = e.clientX - stagePtrDown.x;
    const dy = e.clientY - stagePtrDown.y;
    stagePtrDown = null;
    if (dx * dx + dy * dy > 25) return;
    const t = e.target as HTMLElement | null;
    if (t?.closest("#timeline-ui") || t?.closest("#load-overlay.show")) return;
    setPlayerChrome(!playerChromeVisible);
  });

  window.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement | null;
    const tag = t?.tagName;
    if (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "SELECT" ||
      t?.isContentEditable
    ) {
      return;
    }
    if (!document.getElementById("page-player")?.classList.contains("active")) {
      return;
    }
    if (e.code === "Space" || e.key === " ") {
      e.preventDefault();
      togglePlayPause();
      return;
    }
    if (e.key === "Escape") {
      if (!playerChromeVisible) {
        e.preventDefault();
        setPlayerChrome(true);
        return;
      }
    }
    if (e.key === "Enter") {
      e.preventDefault();
      void togglePlayerFullscreen();
    }
  });

  btnLive.addEventListener("click", async () => {
    try {
      if (liveMode) {
        stopLive();
      } else {
        await startLive();
        loadedDate = dateKeyFromTs(Date.now());
        cacheRatio = 1;
        focusTlOnLoaded();
      }
    } catch (e) {
      showError(e);
    }
  });

  if (!playbackLoopStarted) {
    playbackLoopStarted = true;
    requestAnimationFrame(playbackLoop);
  }
}

export function enterPlayerPage() {
  initCanvas();
  void refreshSystemCursorSize();
  void refreshRecorderSpans();
  if (playlist.length === 0) {
    playlistDwellTimer = window.setTimeout(() => {
      playlistDwellTimer = null;
      if (!isPlayerPageActive()) return;
      schedulePlaylistRefresh();
    }, 1200);
  } else if (performance.now() - lastPlaylistRefreshedAt > 30_000) {
    playlistDwellTimer = window.setTimeout(() => {
      playlistDwellTimer = null;
      if (!isPlayerPageActive()) return;
      schedulePlaylistRefresh();
    }, 1200);
  }
  bindPlayerTimelineFx();
  startRecorderSpanPolling();
  lastTime = performance.now();
  requestAnimationFrame(() => {
    if (!document.getElementById("page-player")?.classList.contains("active")) return;
    renderFrame();
    drawPlayerTimeline();
    updateTimeDisplay();
    // 日瓦片：进页即刷，不再空等 2s
    if (playerHistBootTimer != null) window.clearTimeout(playerHistBootTimer);
    playerHistBootTimer = window.setTimeout(() => {
      playerHistBootTimer = null;
      if (!isPlayerPageActive()) return;
      schedulePlayerHistRefresh();
    }, 80);
  });
}

export function leavePlayerPage() {
  cancelPlayerBackgroundLoad();
  stopRecorderSpanPolling();
  stopTlInertia();
  tlViewReady = false;
  playerHistFetchGen++;
  playerChromeVisible = true;
  document.getElementById("titlebar")?.classList.remove("chrome-hidden");
  document.getElementById("timeline-ui")?.classList.remove("chrome-hidden");
}

export async function seekPlayerToTs(ts: number) {
  const date = dateKeyFromTs(ts);
  if (!playlist.length) await refreshPlaylist();
  let rec = playlist.find((r) => r.date === date);
  if (!rec) {
    await refreshPlaylist();
    rec = playlist.find((r) => r.date === date);
  }
  if (!rec) {
    setLoadUi(true, `没有 ${date} 的录像`, 0);
    window.setTimeout(() => setLoadUi(false), 3000);
    return;
  }
  await loadRecording(rec, ts);
  if (endTime > startTime) {
    isPlaying = true;
    btnPlay.innerText = "⏸";
    lastTime = performance.now();
  }
}

if (!playbackLoopStarted) {
  playbackLoopStarted = true;
  requestAnimationFrame(playbackLoop);
}

export { loadRecording, refreshPlaylist, clearDaySessionCaches };
