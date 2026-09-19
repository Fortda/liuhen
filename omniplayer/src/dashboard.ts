import { invoke } from "@tauri-apps/api/core";
import {
  buildSeriesPoints,
  drawSeriesArea,
  ensureSeriesTilesForRange,
  prefetchNeighborTiles,
  SERIES_KEY_FILL,
  SERIES_KEY_STROKE,
  SERIES_MOUSE_FILL,
  SERIES_MOUSE_STROKE,
  SERIES_TILE_SPAN_MAX,
  seriesStepForView,
  seriesStickyPeaks,
  seriesTilesReady,
  setTileLoadedCallback,
} from "./input_series";
import { buildTimeTicks, tickLabelCursor } from "./time_axis";
import { LANE_PX_MIN } from "./lod_band";
import { runHeavyIpc } from "./heavy_ipc";
import {
  getPlaybackPrefs,
  PLAYBACK_PREFS_EVENT,
  setPlaybackPrefs,
} from "./playback_prefs";
import {
  buildStatusChartsHtml,
  fetchStatusCharts,
  paintStatusCharts,
} from "./dashboard_status";

type TimelineSegment = {
  start_ts: number;
  end_ts: number | null;
  focused: boolean;
  status: string;
  stale: boolean;
  end_reason?: string | null;
};

type TimelineLane = {
  id: string;
  label: string;
  kind: string;
  color: string;
  segments: TimelineSegment[];
};

type HealthReport = {
  now_ts: number;
  window_start_ts: number;
  lanes: TimelineLane[];
};

type StatsReport = {
  data_root: string;
  recorder_running: boolean;
  today: any;
  charts: any;
  volume?: any;
};

type InputHistBucket = {
  start_ts: number;
  mouse: number;
  key: number;
};

type InputHistReport = {
  bucket_ms: number;
  start_ts: number;
  end_ts: number;
  buckets: InputHistBucket[];
  mouse_total: number;
  key_total: number;
  grain: string;
};

const MODULE_LABEL: Record<string, string> = {
  input: "input · 键鼠",
  focus: "focus · 焦点",
  win_map: "win_map · 窗口图",
  win_settings: "win_settings · 设置钩子",
  body: "body · 机体遥测",
  ime: "ime · 输入法",
};

/** 时间轴健康轮询间隔；实际拉取另有 HEALTH_MIN_FETCH_MS 节流 */
let healthTimer: number | null = null;
let slowTimer: number | null = null;
let statusTimer: number | null = null;
const HEALTH_POLL_MS = 8000;
const HEALTH_MIN_FETCH_MS = 12_000;
const SLOW_POLL_MS = 4000;
/** 运行状态：仅重读已落盘 JSONL 尾；不加速 body ~10s 采样 */
const STATUS_POLL_MS = 2000;
let healthInflight = false;
/** 离开仪表盘时递增，作废在途 dashboard_health */
let healthAbortGen = 0;
/** 切页连点时不要立刻扫盘（rIC 在空闲时几乎马上开火） */
let healthDebounceTimer: number | null = null;
/** 已有 health IPC 在途时，等它完成再绘 UI */
let healthWaitInflight = false;
let lastHealthFetchAt = 0;
let statsInflight = false;
let statsNeedsRerender = false;
let statusInflight = false;
let dashPanel: string = "health";
/** 统计页「落盘摘要」展开态：定时重绘时要保留，否则一点开就被 innerHTML 合上 */
let statsDetailsOpen = false;
let statsScrollTop = 0;
/** 键鼠柱状图（随视窗缩放换秒/分/时粒度） */
let inputHistCache: InputHistReport | null = null;
let histFetchGen = 0;
let histDebounceTimer: number | null = null;
let lastHistKey = "";
let lastHistAt = 0;
/** 下方程序运行轴是否收起 */
let lanesCollapsed = false;

/** 时间轴交互状态（PR 式缩放/平移 + 可拖标签列宽） */
let healthReportCache: HealthReport | null = null;
let labelColW = 148;
const LABEL_W_MIN = 72;
const LABEL_W_MAX = 360;
/** 有数据的右端（通常≈now） */
let dataEndTs = 0;
/** 墙上「现在」，播放针位置；视窗可越过它看到未来空白 */
let nowTs = 0;
let viewStartTs = 0;
let viewEndTs = 0;
let viewInitialized = false;
let labelDragging = false;
/** 图区按下即左右拖：平移视窗（与滚轮同一 applyPanDelta 契约）；松手 5px 内算点击 */
const AXIS_PAN_CLICK_SLOP = 5;
let axisPanState: {
  x: number;
  y: number;
  plotW: number;
  viewStart: number;
  viewEnd: number;
  pointerId: number;
} | null = null;
function clearAxisPanState() {
  axisPanState = null;
}
let healthFxBound = false;
/** 指针是否在时间轴画布上（用于拦住 Alt 抢菜单焦点） */
let pointerOverHealthCanvas = false;
/** 屏外指帧提示点击区（css 坐标） */
let dashViewOffsetY = 0;
let offscreenHintHit: {
  side: "left" | "right";
  x0: number;
  y0: number;
  x1: number;
  y1: number;
} | null = null;

/** 记录用户最后一次时间轴交互时间，避免交互时后台 IPC 轮询打断平滑体验 */
let lastUserInteractAt = 0;

/** 同缩放平移：2.5× 宽离屏条带，只 drawImage；缩放/竖滚/数据变才重烤 */
const STRIP_OVERSCAN = 2.5;
const STRIP_EDGE_FRAC = 0.12;
let plotStripCanvas: HTMLCanvasElement | null = null;
let plotStrip: {
  dpr: number;
  cssW: number;
  visH: number;
  offsetY: number;
  fullH: number;
  histH: number;
  plotW: number;
  viewSpan: number;
  stripStart: number;
  stripEnd: number;
  lanesCollapsed: boolean;
  labelColW: number;
  laneCount: number;
  maxMouse: number;
  maxKey: number;
  grain: string;
  useTiles: boolean;
} | null = null;
let plotStripInvalid = true;
let pendingTileStripInvalidate = false;

function invalidatePlotStrip() {
  plotStripInvalid = true;
}

/** 滚轮惯性：轻推一下，约 0.2s 内收住（别飞太远） */
let panVel = 0;
let zoomVel = 0;
let zoomAnchorFrac = 0.5;
let inertiaRaf = 0;
let inertiaLast = 0;
/** ≈0.2s 收到 2%：k ≈ -ln(0.02)/0.2 ≈ 19.6 */
const PAN_FRICTION = 19.6;
const ZOOM_FRICTION = 20;

/** 时间轴左键点采集器段 → 跳播放器并 seek */
export type TimelineSeekHandler = (ts: number) => void;
let timelineSeekHandler: TimelineSeekHandler | null = null;
export function setTimelineSeekHandler(fn: TimelineSeekHandler | null) {
  timelineSeekHandler = fn;
}
/** pointerdown 时记下，pointerup 且位移小才算点击（preventDefault 会吞 mouseup） */
let pendingSeek: { ts: number; x: number; y: number } | null = null;

/** 时间轴绘图区左边距；名称列在右侧 */
const PAD_L = 12;
const PAD_B = 12;
const LANE_H = 38;
/** 布局：最上键鼠柱 → 刻度带 → 轴线 → 程序轴 */
const HIST_TOP = 6;
const HIST_H_MIN = 52;
const HIST_H_MAX = 240;
/** 柱图区高度（Shift+滚轮在柱图上可调） */
let histHeightPx = 96;
/** Alt+滚轮：单次相对观察窗跨度变化百分比（与设置子页同一偏好） */
let altZoomStepPct = getPlaybackPrefs().timelineZoomPct;

/** 性能实验：分段计时回调（null=关闭） */
let perfCollect: ((name: string, ms: number) => void) | null = null;
function perfMark(name: string, t0: number) {
  if (perfCollect) perfCollect(name, performance.now() - t0);
}

/** 柱与轴线之间：刻度数字 + 出屏小三角 */
const TICK_BAND = 28;
const HIST_GAP = 12;
const MOUSE_FILL = SERIES_MOUSE_FILL;
const MOUSE_STROKE = SERIES_MOUSE_STROKE;
const KEY_FILL = SERIES_KEY_FILL;
const KEY_STROKE = SERIES_KEY_STROKE;
/** 右侧图例小方块仍用实色 */
const MOUSE_BAR = "#38a8dc";
const KEY_BAR = "#ff9448";

function axisY() {
  return HIST_TOP + histHeightPx + TICK_BAND;
}
/** 最小视窗：可放到毫秒级刻度 */
const MIN_VIEW_SPAN_MS = 80;
/** 最大视窗跨度：约二十年（一次能看见多宽）；平移不再按「现在±20年」封左右 */
const DAY_MS = 86_400_000;
const MAX_VIEW_SPAN_MS = Math.floor(20 * 365.25 * DAY_MS);
/** JS Date 可表示范围（±1e8 天），当作平移硬顶 */
const TS_ABS_MAX = 8.64e15;
/** 初次进入：近 2 小时 + 右侧未来空白 */
const FUTURE_PAD_RATIO = 2.5;
const FUTURE_PAD_MIN_MS = 90 * 60 * 1000;
const INITIAL_PAST_MS = 2 * 60 * 60 * 1000;

function $(id: string) {
  return document.getElementById(id);
}

function pad2(n: number) {
  return n.toString().padStart(2, "0");
}

function pad3(n: number) {
  return n.toString().padStart(3, "0");
}

/** 针头 / 瞬时读数用完整时间；轴上短标签走 time_axis */
function formatTickLabel(ts: number, spanMs: number) {
  const d = new Date(ts);
  const h = pad2(d.getHours());
  const m = pad2(d.getMinutes());
  const s = pad2(d.getSeconds());
  const ms = pad3(d.getMilliseconds());
  if (spanMs <= 3_000) return `${m}:${s}.${ms}`;
  if (spanMs <= 30_000) return `${h}:${m}:${s}.${ms}`;
  if (spanMs <= 15 * 60_000) return `${h}:${m}:${s}`;
  if (spanMs <= 36 * 60 * 60_000) return `${h}:${m}`;
  if (spanMs <= 90 * DAY_MS) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  if (spanMs <= 3 * 365 * DAY_MS) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
  }
  return `${d.getFullYear()}`;
}

function stopInertia() {
  if (inertiaRaf) {
    cancelAnimationFrame(inertiaRaf);
    inertiaRaf = 0;
  }
  panVel = 0;
  zoomVel = 0;
}

function applyPanDelta(deltaMs: number) {
  viewStartTs += deltaMs;
  viewEndTs += deltaMs;
  clampViewToData();
  scheduleTilePrefetch();
}

function afterDashCameraIdle() {
  const span = Math.max(1, viewEndTs - viewStartTs);
  if (span <= SERIES_TILE_SPAN_MAX) {
    void ensureSeriesTilesForRange(viewStartTs, viewEndTs);
    prefetchNeighborTiles(viewStartTs, viewEndTs, 1);
  }
  if (pendingTileStripInvalidate) {
    pendingTileStripInvalidate = false;
    invalidatePlotStrip();
    scheduleHealthRedraw();
    return;
  }
  if (
    plotStrip &&
    (Math.abs(plotStrip.viewSpan - span) > 0.5 ||
      !stripCoversView(viewStartTs, viewEndTs, span))
  ) {
    invalidatePlotStrip();
    scheduleHealthRedraw();
  }
}

function applyZoomFactor(factor: number, frac: number) {
  const span = Math.max(1, viewEndTs - viewStartTs);
  const anchor = viewStartTs + frac * span;
  let newSpan = span * factor;
  newSpan = Math.min(MAX_VIEW_SPAN_MS, Math.max(MIN_VIEW_SPAN_MS, newSpan));
  viewStartTs = anchor - frac * newSpan;
  viewEndTs = viewStartTs + newSpan;
  clampViewToData();
  scheduleTilePrefetch();
}

let tilePrefetchTimer: number | null = null;
function scheduleTilePrefetch() {
  if (inertiaRaf) return;
  if (viewEndTs - viewStartTs > SERIES_TILE_SPAN_MAX) return;
  if (tilePrefetchTimer != null) return;
  tilePrefetchTimer = window.setTimeout(() => {
    tilePrefetchTimer = null;
    if (inertiaRaf) return;
    if (viewEndTs - viewStartTs > SERIES_TILE_SPAN_MAX) return;
    void ensureSeriesTilesForRange(viewStartTs, viewEndTs);
  }, 50);
}

function kickInertia() {
  lastUserInteractAt = performance.now();
  if (inertiaRaf) return;
  inertiaLast = performance.now();
  // 占位：首帧 redraw 时 inertiaRaf 必须已为真，否则月/年缩放每格滚轮都会重烤条带
  inertiaRaf = -1;
  redrawHealthFromCache();
  const step = (t: number) => {
    lastUserInteractAt = performance.now();
    const dt = Math.min(48, t - inertiaLast);
    inertiaLast = t;
    const dtSec = dt / 1000;
    const span = Math.max(1, viewEndTs - viewStartTs);
    // 末段阈值过小直接掐断，避免「蹭蹭蹭」拖很久
    const panEps = Math.max(0.08, span * 2e-7);
    const zoomEps = 0.04;
    let moving = false;
    if (Math.abs(panVel) > panEps) {
      applyPanDelta(panVel * dt);
      panVel *= Math.exp(-PAN_FRICTION * dtSec);
      moving = true;
    } else {
      panVel = 0;
    }
    if (Math.abs(zoomVel) > zoomEps) {
      applyZoomFactor(Math.exp(zoomVel * dtSec), zoomAnchorFrac);
      zoomVel *= Math.exp(-ZOOM_FRICTION * dtSec);
      moving = true;
    } else {
      zoomVel = 0;
    }
    redrawHealthFromCache();
    if (moving) {
      inertiaRaf = requestAnimationFrame(step);
    } else {
      inertiaRaf = 0;
      afterDashCameraIdle();
      scheduleHistRefresh();
    }
  };
  inertiaRaf = requestAnimationFrame(step);
}

/** 把指帧收到视窗内偏左（方便接着看「现在」） */
function centerViewOnNeedle() {
  const span = Math.max(MIN_VIEW_SPAN_MS, viewEndTs - viewStartTs);
  const n = nowTs || Date.now();
  viewStartTs = n - span * 0.35;
  viewEndTs = viewStartTs + span;
  clampViewToData();
  stopInertia();
  redrawHealthFromCache();
}

function dashboardHealthActive(): boolean {
  return (
    !!$("page-dashboard")?.classList.contains("active") && dashPanel === "health"
  );
}

function setHealthLoading(on: boolean, label = "加载时间轴…") {
  const el = $("dash-health-load");
  if (!el) return;
  el.hidden = !on;
  el.classList.toggle("is-loading", on);
  const lab = $("dash-health-load-label");
  if (lab && on) lab.textContent = label;
}

function setHealthMetaHint(text: string) {
  const loading = /加载/.test(text) && !/失败/.test(text);
  setHealthLoading(loading, text);
}

function clearPollingTimersOnly() {
  if (healthTimer != null) {
    window.clearInterval(healthTimer);
    healthTimer = null;
  }
  if (slowTimer != null) {
    window.clearInterval(slowTimer);
    slowTimer = null;
  }
  if (statusTimer != null) {
    window.clearInterval(statusTimer);
    statusTimer = null;
  }
}

function kickHealthLoad() {
  if (dashPanel !== "health") return;
  if (!$("page-dashboard")?.classList.contains("active")) return;
  if (healthDebounceTimer != null) {
    window.clearTimeout(healthDebounceTimer);
    healthDebounceTimer = null;
  }
  const run = () => {
    if (dashPanel !== "health") return;
    if (!$("page-dashboard")?.classList.contains("active")) return;
    void renderHealth({ force: !healthReportCache });
  };
  // 无缓存必须立刻拉，否则 400ms 防抖 + IPC 会叠成「切过去空等一秒」
  if (!healthReportCache) {
    run();
    return;
  }
  healthDebounceTimer = window.setTimeout(run, 400);
}

function moveDashPill(activeBtn?: HTMLElement | null) {
  const pill = $("dash-pill");
  const tabs = $("dash-tabs");
  const btn =
    activeBtn ??
    (document.querySelector("#dash-tabs button.active") as HTMLElement | null);
  if (!pill || !tabs || !btn) return;
  // 横向滑动
  pill.style.width = `${btn.offsetWidth}px`;
  pill.style.height = `${btn.offsetHeight}px`;
  pill.style.transform = `translate(${btn.offsetLeft}px, ${btn.offsetTop}px)`;
}

export function switchDashPanel(panel: string) {
  dashPanel = panel;
  let active: HTMLElement | null = null;
  document.querySelectorAll("#dash-tabs button[data-dash]").forEach((b) => {
    const el = b as HTMLElement;
    const on = el.dataset.dash === panel;
    el.classList.toggle("active", on);
    if (on) active = el;
  });
  document.querySelectorAll(".dash-panel").forEach((p) => {
    p.classList.toggle("active", p.id === `dash-${panel}`);
  });
  moveDashPill(active);
  const statsHost = $("dash-stats-body");
  const liveHost = $("dash-live-body");
  if (panel === "health") {
    if (!healthReportCache) setHealthMetaHint("加载时间轴…");
    else {
      requestAnimationFrame(() => {
        if (dashPanel !== "health") return;
        redrawHealthFromCache();
      });
    }
    kickHealthLoad();
    return;
  }
  setHealthLoading(false);
  if (panel === "stats") {
    void renderStats({ force: !(statsHost && statsHost.childElementCount > 0) });
    return;
  }
  if (panel === "live") {
    void renderStatusCharts({ force: !(liveHost && liveHost.childElementCount > 0) });
    return;
  }
  if (panel === "sleep") {
    void renderSleepGuess({ force: !(($("dash-sleep-body")?.childElementCount ?? 0) > 0) });
    return;
  }
  void refreshDashPanel();
}

async function refreshDashPanel() {
  if (dashPanel === "health") await renderHealth({ force: true });
  else if (dashPanel === "stats") await renderStats();
  else if (dashPanel === "live") await renderStatusCharts();
  else if (dashPanel === "sleep") await renderSleepGuess({ force: true });
}

const rgbaCache = new Map<string, string>();
function hexToRgba(hex: string, a: number) {
  const key = `${hex}|${a}`;
  const hit = rgbaCache.get(key);
  if (hit) return hit;
  const h = hex.replace("#", "");
  const n = h.length === 3
    ? h.split("").map((c) => parseInt(c + c, 16))
    : [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  const out = `rgba(${n[0]}, ${n[1]}, ${n[2]}, ${a})`;
  rgbaCache.set(key, out);
  return out;
}

type LaneIndex = {
  src: TimelineSegment[];
  chron: TimelineSegment[];
  rest: TimelineSegment[];
  focused: TimelineSegment[];
};
const laneIndexById = new Map<string, LaneIndex>();

function getLaneIndex(lane: TimelineLane): LaneIndex {
  const hit = laneIndexById.get(lane.id);
  if (hit && hit.src === lane.segments) return hit;
  const chron = lane.segments.slice().sort((a, b) => a.start_ts - b.start_ts);
  const rest: TimelineSegment[] = [];
  const focused: TimelineSegment[] = [];
  for (let i = 0; i < chron.length; i++) {
    if (chron[i].focused) focused.push(chron[i]);
    else rest.push(chron[i]);
  }
  const idx: LaneIndex = { src: lane.segments, chron, rest, focused };
  laneIndexById.set(lane.id, idx);
  return idx;
}

function firstOverlapIdx(
  chron: TimelineSegment[],
  t0: number,
  now: number
): number {
  let lo = 0;
  let hi = chron.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (chron[mid].start_ts < t0) lo = mid + 1;
    else hi = mid;
  }
  let i = lo;
  while (i > 0) {
    const end = chron[i - 1].end_ts ?? now;
    if (end >= t0) i--;
    else break;
  }
  return i;
}

function drawMergedLaneBars(
  ctx: CanvasRenderingContext2D,
  segs: TimelineSegment[],
  t0: number,
  t1: number,
  span: number,
  plotLeft: number,
  plotW: number,
  now: number,
  barY: number,
  barH: number,
  floorPx: number,
  styleOf: (s: TimelineSegment) => string | null
) {
  let runStyle = "";
  let runX = 0;
  let runW = 0;
  const flush = () => {
    if (runW > 0 && runStyle) {
      ctx.fillStyle = runStyle;
      ctx.fillRect(runX, barY, runW, barH);
    }
    runW = 0;
  };
  const i0 = firstOverlapIdx(segs, t0, now);
  for (let i = i0; i < segs.length; i++) {
    const s = segs[i];
    if (s.start_ts > t1) break;
    const segEnd = s.end_ts ?? now;
    if (segEnd < t0) continue;
    const style = styleOf(s);
    if (!style) continue;
    const x0 = plotLeft + ((Math.max(s.start_ts, t0) - t0) / span) * plotW;
    const x1 = plotLeft + ((Math.min(segEnd, t1) - t0) / span) * plotW;
    const px0 = Math.floor(x0);
    const w = Math.max(floorPx, Math.ceil(x1) - px0);
    if (style === runStyle && px0 <= runX + runW + 1) {
      runW = Math.max(runW, px0 + w - runX);
    } else {
      flush();
      runStyle = style;
      runX = px0;
      runW = w;
    }
  }
  flush();
}

/** 只夹视窗跨度与 JS Date 范围；左右可一直滚 */
function clampViewToData() {
  let span = viewEndTs - viewStartTs;
  if (!Number.isFinite(span) || span <= 0) span = INITIAL_PAST_MS;
  span = Math.min(MAX_VIEW_SPAN_MS, Math.max(MIN_VIEW_SPAN_MS, span));
  let start = Number.isFinite(viewStartTs) ? viewStartTs : Date.now() - span * 0.35;
  if (start < -TS_ABS_MAX) start = -TS_ABS_MAX;
  if (start + span > TS_ABS_MAX) start = TS_ABS_MAX - span;
  viewStartTs = start;
  viewEndTs = start + span;
}

/** histogram IPC 是 u64，纪元前视窗不发请求 */
function ipcMillisRange(t0: number, t1: number): { startTs: number; endTs: number } | null {
  const a = Math.min(t0, t1);
  const b = Math.max(t0, t1);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= 0) return null;
  const startTs = Math.max(0, Math.floor(a));
  const endTs = Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.max(startTs + 1, Math.floor(b))
  );
  return { startTs, endTs };
}

/** 初次：近 2 小时 + 右侧未来空白；之后视窗锁定，只让针走（缩放可自行拉开到年） */
function initStationaryView() {
  const n = nowTs || dataEndTs;
  const future = Math.max(INITIAL_PAST_MS * FUTURE_PAD_RATIO, FUTURE_PAD_MIN_MS);
  viewStartTs = n - INITIAL_PAST_MS;
  viewEndTs = n + future;
  clampViewToData();
}

function fitLabel(ctx: CanvasRenderingContext2D, text: string, maxW: number) {
  if (maxW <= 8) return "…";
  if (ctx.measureText(text).width <= maxW) return text;
  const ell = "…";
  let s = text;
  while (s.length > 1 && ctx.measureText(s + ell).width > maxW) {
    s = s.slice(0, -1);
  }
  return s + ell;
}

function healthLayout(cssW: number) {
  const plotLeft = PAD_L;
  const splitX = Math.max(plotLeft + 40, cssW - labelColW);
  const plotW = Math.max(40, splitX - plotLeft);
  return { plotLeft, splitX, plotW, labelLeft: splitX };
}

/** 视窗跨度 → 柱粒度：秒 / 分 / 时 */
function histBucketMs(spanMs: number): number {
  if (spanMs <= 5 * 60_000) return 1_000;
  if (spanMs <= 6 * 3600_000) return 60_000;
  if (spanMs <= 7 * DAY_MS) return 3600_000;
  if (spanMs <= 90 * DAY_MS) return DAY_MS;
  if (spanMs <= 3 * 365 * DAY_MS) return 7 * DAY_MS;
  return 30 * DAY_MS;
}

function scheduleHistRefresh() {
  // 惯性中先别打 IPC；近景瓦片已齐时只重画
  if (inertiaRaf) return;
  if (histDebounceTimer != null) window.clearTimeout(histDebounceTimer);
  histDebounceTimer = window.setTimeout(() => {
    histDebounceTimer = null;
    if (inertiaRaf) {
      scheduleHistRefresh();
      return;
    }
    void refreshInputHist();
  }, 120);
}

async function refreshInputHist(force = false) {
  if (dashPanel !== "health") return;
  if (!$("page-dashboard")?.classList.contains("active")) return;
  if (!viewInitialized) return;
  const span = Math.max(1, viewEndTs - viewStartTs);

  if (span <= SERIES_TILE_SPAN_MAX) {
    if (!force && seriesTilesReady(viewStartTs, viewEndTs)) {
      if (healthReportCache) {
        drawHealthTimeline(healthReportCache, { updateLegend: false });
      }
      return;
    }
    const gen = ++histFetchGen;
    await ensureSeriesTilesForRange(viewStartTs, viewEndTs);
    if (gen !== histFetchGen) return;
    if (healthReportCache) {
      drawHealthTimeline(healthReportCache, { updateLegend: false });
    }
    return;
  }

  const bucketMs = histBucketMs(span);
  const startTs = Math.floor(viewStartTs / bucketMs) * bucketMs;
  const endTs = Math.ceil(viewEndTs);
  const ipc = ipcMillisRange(startTs, endTs);
  if (!ipc) return;
  const key = `${ipc.startTs}:${ipc.endTs}:${Math.floor(bucketMs)}`;
  const now = Date.now();
  const coversLiveEdge = viewEndTs >= now - DAY_MS;
  if (
    !force &&
    key === lastHistKey &&
    inputHistCache &&
    (!coversLiveEdge || now - lastHistAt < 20_000)
  ) {
    return;
  }
  const gen = ++histFetchGen;
  try {
    const report = await runHeavyIpc("dashboard_input_histogram", () =>
      invoke<InputHistReport>("dashboard_input_histogram", {
        startTs: ipc.startTs,
        endTs: ipc.endTs,
        bucketMs: Math.floor(bucketMs),
      })
    );
    if (gen !== histFetchGen) return;
    inputHistCache = report;
    lastHistKey = key;
    lastHistAt = Date.now();
    invalidatePlotStrip();
    if (healthReportCache) {
      drawHealthTimeline(healthReportCache, { updateLegend: false });
    }
  } catch {
    /* histogram refresh failed; keep last paint */
  }
}

type PlotPaintArgs = {
  ctx: CanvasRenderingContext2D;
  t0: number;
  t1: number;
  span: number;
  lodSpan: number;
  lodPlotW: number;
  plotLeft: number;
  plotW: number;
  offsetY: number;
  visH: number;
  fullH: number;
  AXIS_Y: number;
  lanesTop: number;
  lanes: TimelineLane[];
  report: HealthReport;
  histH: number;
};

function paintPlotWorld(args: PlotPaintArgs): {
  maxMouse: number;
  maxKey: number;
  grain: string;
  useTiles: boolean;
} {
  const {
    ctx,
    t0,
    t1,
    span,
    lodSpan,
    lodPlotW,
    plotLeft,
    plotW,
    offsetY,
    visH,
    fullH,
    AXIS_Y,
    lanesTop,
    lanes,
    report,
    histH,
  } = args;
  const viewBottom = offsetY + visH;
  const baseY = HIST_TOP + histH;
  const useTiles = lodSpan <= SERIES_TILE_SPAN_MAX;
  const buckets = inputHistCache?.buckets || [];
  const peaks = seriesStickyPeaks();
  let maxMouse = useTiles ? peaks.mouse : 1;
  let maxKey = useTiles ? peaks.key : 1;
  if (!useTiles) {
    for (const b of buckets) {
      if (b.mouse > maxMouse) maxMouse = b.mouse;
      if (b.key > maxKey) maxKey = b.key;
    }
  }
  const bucketMs = inputHistCache?.bucket_ms || histBucketMs(lodSpan);
  const tileStep = useTiles ? seriesStepForView(lodSpan, lodPlotW) : 60_000;
  const grain = useTiles
    ? `${Math.round(tileStep / 1000)}秒折线`
    : inputHistCache?.grain || "…";

  ctx.fillStyle = "#f7f5f2";
  ctx.fillRect(plotLeft, offsetY, plotW, visH);

  ctx.strokeStyle = "#e2ddd5";
  ctx.beginPath();
  ctx.moveTo(plotLeft, baseY);
  ctx.lineTo(plotLeft + plotW, baseY);
  ctx.stroke();

  ctx.font = '13px "Cascadia Mono", "Consolas", monospace';
  ctx.textBaseline = "middle";
  for (let i = 0; i <= 2; i++) {
    const t = i / 2;
    const y = baseY - t * (histH - 6);
    ctx.strokeStyle = "rgba(180, 174, 164, 0.55)";
    ctx.setLineDash(i === 0 ? [] : [3, 3]);
    ctx.beginPath();
    ctx.moveTo(plotLeft, y);
    ctx.lineTo(plotLeft + plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  const mousePts: { x: number; y: number }[] = [];
  const keyPts: { x: number; y: number }[] = [];
  const usableH = histH - 6;
  if (useTiles) {
    const raw = buildSeriesPoints(t0, t1, tileStep, plotW);
    for (const p of raw) {
      const x = plotLeft + ((p.ts - t0) / span) * plotW;
      const mh = Math.min(1, p.mouse / maxMouse) * usableH * 0.94;
      const kh = Math.min(1, p.key / maxKey) * usableH * 0.94;
      mousePts.push({ x, y: baseY - mh });
      keyPts.push({ x, y: baseY - kh });
    }
  } else {
    for (const b of buckets) {
      const mid = b.start_ts + bucketMs / 2;
      if (mid < t0 - bucketMs || mid > t1 + bucketMs) continue;
      const x = plotLeft + ((mid - t0) / span) * plotW;
      mousePts.push({
        x,
        y: baseY - (b.mouse / maxMouse) * usableH,
      });
      keyPts.push({
        x,
        y: baseY - (b.key / maxKey) * usableH,
      });
    }
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(plotLeft, HIST_TOP, plotW, histH);
  ctx.clip();
  drawSeriesArea(ctx, mousePts, baseY, MOUSE_FILL, MOUSE_STROKE, false);
  drawSeriesArea(ctx, keyPts, baseY, KEY_FILL, KEY_STROKE, false);
  ctx.restore();

  ctx.strokeStyle = "#c4beb4";
  ctx.fillStyle = "#6a6560";
  ctx.font =
    span <= 30_000
      ? '13px "Cascadia Mono", "Consolas", monospace'
      : '13px "Noto Sans SC", sans-serif';
  ctx.beginPath();
  ctx.moveTo(plotLeft, AXIS_Y);
  ctx.lineTo(plotLeft + plotW, AXIS_Y);
  ctx.stroke();
  const ticks = buildTimeTicks(t0, t1, plotW);
  const labelCursor = tickLabelCursor(12);
  for (const tick of ticks) {
    const x = plotLeft + ((tick.ts - t0) / span) * plotW;
    if (x < plotLeft - 2 || x > plotLeft + plotW + 2) continue;
    const hasLabel = tick.label.length > 0;
    const len = tick.rank === "major" ? 8 : tick.rank === "mid" ? 5 : 3;
    ctx.beginPath();
    ctx.lineWidth = tick.rank === "major" ? 1.35 : 1;
    ctx.moveTo(x, AXIS_Y);
    ctx.lineTo(x, AXIS_Y + len);
    ctx.stroke();
    ctx.lineWidth = 1;
    if (!hasLabel) continue;
    if (tick.rank !== "major" && (x < plotLeft + 8 || x > plotLeft + plotW - 8)) continue;
    if (tick.rank === "major" && (x < plotLeft - 4 || x > plotLeft + plotW + 4)) continue;
    const tw = ctx.measureText(tick.label).width;
    if (!labelCursor.take(x, tw)) continue;
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(tick.label, x, AXIS_Y - 6);
  }

  lanes.forEach((_lane, i) => {
    const y = lanesTop + i * LANE_H;
    if (y + LANE_H < offsetY || y > viewBottom) return;
    ctx.strokeStyle = "#e2ddd5";
    ctx.beginPath();
    ctx.moveTo(plotLeft, y + 16);
    ctx.lineTo(plotLeft + plotW, y + 16);
    ctx.stroke();
  });
  ctx.save();
  ctx.beginPath();
  ctx.rect(plotLeft, lanesTop, plotW, fullH - lanesTop);
  ctx.clip();
  lanes.forEach((lane, i) => {
    const y = lanesTop + i * LANE_H;
    if (y + LANE_H < offsetY || y > viewBottom) return;
    const barH = lane.kind === "recorder" ? 16 : 14;
    const barY = y + 16 - barH / 2;
    const idx = getLaneIndex(lane);
    const now = report.now_ts;
    const floorPx = lane.kind === "app" ? LANE_PX_MIN : 2;

    if (lane.kind === "recorder") {
      drawMergedLaneBars(
        ctx,
        idx.chron,
        t0,
        t1,
        span,
        plotLeft,
        plotW,
        now,
        barY,
        barH,
        floorPx,
        (s) => {
          if (s.stale || s.status === "stale") return "#c45c5c";
          if (s.status === "stopped") return "#9a9590";
          return lane.color;
        }
      );
      const i0 = firstOverlapIdx(idx.chron, t0, now);
      for (let gi = i0; gi < idx.chron.length; gi++) {
        const s = idx.chron[gi];
        if (s.start_ts > t1) break;
        const segEnd = s.end_ts ?? now;
        if (segEnd < t0) continue;
        const x1 = plotLeft + ((Math.min(segEnd, t1) - t0) / span) * plotW;
        if (s.status === "stopped" && s.end_ts && s.end_ts <= t1 && s.end_ts >= t0) {
          ctx.fillStyle = "#5a554f";
          ctx.fillRect(x1 - 2, barY - 2, 2, barH + 4);
        }
        if (s.stale || s.status === "stale") {
          ctx.fillStyle = "#b33b3b";
          ctx.font = 'bold 15px "Segoe UI", sans-serif';
          ctx.textAlign = "left";
          ctx.fillText("!", x1 + 3, barY + 13);
        }
        if (gi + 1 < idx.chron.length) {
          const aEnd = s.end_ts;
          if (aEnd == null) continue;
          const bStart = idx.chron[gi + 1].start_ts;
          if (bStart <= aEnd) continue;
          if (aEnd < t0 || aEnd > t1) continue;
          const lx = Math.round(plotLeft + ((aEnd - t0) / span) * plotW);
          ctx.fillStyle = "rgba(20, 18, 16, 0.92)";
          ctx.fillRect(lx, barY - 2, 1, barH + 4);
          ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
          ctx.fillRect(lx, barY - 1, 1, barH + 2);
        }
      }
    } else {
      const dim = hexToRgba(lane.color, 0.22);
      drawMergedLaneBars(
        ctx,
        idx.rest,
        t0,
        t1,
        span,
        plotLeft,
        plotW,
        now,
        barY + 2,
        barH - 4,
        floorPx,
        () => dim
      );
      drawMergedLaneBars(
        ctx,
        idx.focused,
        t0,
        t1,
        span,
        plotLeft,
        plotW,
        now,
        barY,
        barH,
        floorPx,
        () => lane.color
      );
    }
  });
  ctx.restore();
  return { maxMouse, maxKey, grain, useTiles };
}

function stripLayoutMatches(
  dpr: number,
  visH: number,
  offsetY: number,
  fullH: number,
  plotW: number
): boolean {
  const s = plotStrip;
  if (!s || plotStripInvalid) return false;
  return (
    s.dpr === dpr &&
    s.visH === visH &&
    s.offsetY === offsetY &&
    s.fullH === fullH &&
    s.histH === histHeightPx &&
    s.plotW === plotW &&
    s.lanesCollapsed === lanesCollapsed &&
    s.labelColW === labelColW
  );
}

function stripCoversView(t0: number, t1: number, span: number): boolean {
  const s = plotStrip;
  if (!s) return false;
  if (Math.abs(s.viewSpan - span) > 0.5) return false;
  const stripSpan = s.stripEnd - s.stripStart;
  const margin = stripSpan * STRIP_EDGE_FRAC;
  return t0 >= s.stripStart + margin && t1 <= s.stripEnd - margin;
}

function bakePlotStrip(
  dpr: number,
  visH: number,
  offsetY: number,
  fullH: number,
  plotW: number,
  t0: number,
  span: number,
  AXIS_Y: number,
  lanesTop: number,
  lanes: TimelineLane[],
  report: HealthReport
) {
  const extra = span * (STRIP_OVERSCAN - 1);
  const leftFrac = panVel > 1e-6 ? 0.22 : panVel < -1e-6 ? 0.78 : 0.5;
  const stripStart = t0 - extra * leftFrac;
  const stripEnd = stripStart + span * STRIP_OVERSCAN;
  const stripSpan = stripEnd - stripStart;
  const cssW = Math.max(64, Math.round(plotW * STRIP_OVERSCAN));
  if (!plotStripCanvas) plotStripCanvas = document.createElement("canvas");
  const pw = Math.floor(cssW * dpr);
  const ph = Math.floor(visH * dpr);
  if (plotStripCanvas.width !== pw || plotStripCanvas.height !== ph) {
    plotStripCanvas.width = pw;
    plotStripCanvas.height = ph;
  }
  const sctx = plotStripCanvas.getContext("2d")!;
  sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  sctx.translate(0, -offsetY);
  const painted = paintPlotWorld({
    ctx: sctx,
    t0: stripStart,
    t1: stripEnd,
    span: stripSpan,
    lodSpan: span,
    lodPlotW: plotW,
    plotLeft: 0,
    plotW: cssW,
    offsetY,
    visH,
    fullH,
    AXIS_Y,
    lanesTop,
    lanes,
    report,
    histH: histHeightPx,
  });
  plotStrip = {
    dpr,
    cssW,
    visH,
    offsetY,
    fullH,
    histH: histHeightPx,
    plotW,
    viewSpan: span,
    stripStart,
    stripEnd,
    lanesCollapsed,
    labelColW,
    laneCount: lanes.length,
    maxMouse: painted.maxMouse,
    maxKey: painted.maxKey,
    grain: painted.grain,
    useTiles: painted.useTiles,
  };
  plotStripInvalid = false;
}

function blitPlotStrip(
  ctx: CanvasRenderingContext2D,
  dpr: number,
  plotLeft: number,
  plotW: number,
  t0: number,
  t1: number,
  offsetY: number,
  visH: number
) {
  const s = plotStrip;
  if (!s || !plotStripCanvas) return;
  const stripSpan = Math.max(1, s.stripEnd - s.stripStart);
  const u0 = (t0 - s.stripStart) / stripSpan;
  const u1 = (t1 - s.stripStart) / stripSpan;
  const cu0 = Math.max(0, u0);
  const cu1 = Math.min(1, u1);
  if (cu1 - cu0 <= 1e-6) return;
  const srcX = cu0 * s.cssW;
  const srcW = (cu1 - cu0) * s.cssW;
  const destX = plotLeft + ((cu0 - u0) / (u1 - u0)) * plotW;
  const destW = ((cu1 - cu0) / (u1 - u0)) * plotW;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    plotStripCanvas,
    srcX * dpr,
    0,
    Math.max(1, srcW * dpr),
    visH * dpr,
    destX,
    offsetY,
    Math.max(1, destW),
    visH
  );
}

function drawHealthTimeline(
  report: HealthReport,
  _opts?: { updateLegend?: boolean }
) {
  const canvas = $("dash-health-canvas") as HTMLCanvasElement | null;
  if (!canvas) return;
  if (dashPanel !== "health" || canvas.clientWidth <= 0) return;
  const allLanes = report.lanes?.length ? report.lanes : [];
  // 「收起程序轴」仍保留采集器行，方便点段回放
  const lanes = lanesCollapsed
    ? allLanes.filter((l) => l.kind === "recorder")
    : allLanes;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 800;
  const { plotLeft, splitX, plotW, labelLeft } = healthLayout(cssW);
  const AXIS_Y = axisY();
  const lanesTop = AXIS_Y + HIST_GAP;
  const laneCount = lanes.length;
  const fullH = Math.max(
    220,
    lanesTop + 18 + laneCount * LANE_H + PAD_B
  );
  const frame = $("dash-health-frame");
  const sizer = $("dash-health-sizer");
  if (sizer) sizer.style.height = `${fullH}px`;
  const visH = Math.max(
    220,
    Math.min(fullH, Math.floor(frame?.clientHeight || fullH))
  );
  const offsetY = Math.max(
    0,
    Math.min(Math.max(0, fullH - visH), Math.floor(frame?.scrollTop || 0))
  );
  dashViewOffsetY = offsetY;
  canvas.style.height = `${visH}px`;
  const pixelW = Math.floor(cssW * dpr);
  const pixelH = Math.floor(visH * dpr);
  // 尺寸不变时别重置 canvas buffer（每 2s 健康轮询否则整屏重分配，易闪/卡）
  if (canvas.width !== pixelW || canvas.height !== pixelH) {
    canvas.width = pixelW;
    canvas.height = pixelH;
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.translate(0, -offsetY);

  const t0 = viewStartTs;
  const t1 = Math.max(viewEndTs, t0 + 1);
  const span = t1 - t0;
  const perfT0 = performance.now();
  const histH = histHeightPx;
  const baseY = HIST_TOP + histH;

  const layoutOk = stripLayoutMatches(dpr, visH, offsetY, fullH, plotW);
  const canBlit = layoutOk && stripCoversView(t0, t1, span);
  if (!canBlit) {
    const approxOk = layoutOk && !!plotStripCanvas && !!inertiaRaf;
    if (!approxOk) {
      const bakeT0 = performance.now();
      bakePlotStrip(
        dpr,
        visH,
        offsetY,
        fullH,
        plotW,
        t0,
        span,
        AXIS_Y,
        lanesTop,
        lanes,
        report
      );
      perfMark("plot_strip_bake", bakeT0);
    }
  }
  const maxMouse = plotStrip?.maxMouse ?? 1;
  const maxKey = plotStrip?.maxKey ?? 1;
  const grain = plotStrip?.grain ?? "…";
  const useTiles = plotStrip?.useTiles ?? span <= SERIES_TILE_SPAN_MAX;

  ctx.clearRect(0, offsetY, cssW, visH);
  ctx.fillStyle = "#f7f5f2";
  ctx.fillRect(0, offsetY, cssW, visH);
  blitPlotStrip(ctx, dpr, plotLeft, plotW, t0, t1, offsetY, visH);

  ctx.font = '13px "Cascadia Mono", "Consolas", monospace';
  ctx.textBaseline = "middle";
  for (let i = 0; i <= 2; i++) {
    const t = i / 2;
    const y = baseY - t * (histH - 6);
    ctx.fillStyle = MOUSE_BAR;
    ctx.textAlign = "left";
    ctx.fillText(String(Math.round(maxMouse * t)), plotLeft + 3, y - (i === 2 ? 4 : 0));
    ctx.fillStyle = KEY_BAR;
    ctx.textAlign = "right";
    ctx.fillText(String(Math.round(maxKey * t)), plotLeft + plotW - 3, y - (i === 2 ? 4 : 0));
  }
  ctx.fillStyle = "#6a6560";
  ctx.font = '13px "Noto Sans SC", sans-serif';
  ctx.textAlign = "left";
  ctx.fillText("次", plotLeft + 3, HIST_TOP + 10);

  ctx.fillStyle = "#f0ebe4";
  ctx.fillRect(labelLeft, offsetY, cssW - labelLeft, visH);
  ctx.fillStyle = "#8a847c";
  ctx.fillRect(splitX - 1, offsetY, 2, visH);
  ctx.fillStyle = "#b8b2a8";
  ctx.fillRect(splitX - 2, offsetY, 1, visH);

  ctx.fillStyle = "#5a554f";
  ctx.font = '600 14px "Noto Sans SC", sans-serif';
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText("键鼠活跃", labelLeft + 10, HIST_TOP + 4);
  ctx.font = '13px "Noto Sans SC", sans-serif';
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = MOUSE_FILL;
  ctx.fillRect(labelLeft + 10, HIST_TOP + 24, 14, 9);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = MOUSE_STROKE;
  ctx.strokeRect(labelLeft + 10, HIST_TOP + 24, 14, 9);
  ctx.fillStyle = "#5a554f";
  ctx.fillText(`鼠标 · 满 ${maxMouse}`, labelLeft + 28, HIST_TOP + 22);
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = KEY_FILL;
  ctx.fillRect(labelLeft + 10, HIST_TOP + 42, 14, 9);
  ctx.globalAlpha = 1;
  ctx.strokeStyle = KEY_STROKE;
  ctx.strokeRect(labelLeft + 10, HIST_TOP + 42, 14, 9);
  ctx.fillStyle = "#5a554f";
  ctx.fillText(`键盘 · 满 ${maxKey}`, labelLeft + 28, HIST_TOP + 40);
  ctx.fillStyle = "#6a6560";
  ctx.fillText(
    useTiles ? `矢量折线 · ${grain}` : `叠色 · 每${grain}`,
    labelLeft + 10,
    HIST_TOP + 60
  );

  const viewBottom = offsetY + visH;
  lanes.forEach((lane, i) => {
    const y = lanesTop + i * LANE_H;
    if (y + LANE_H < offsetY || y > viewBottom) return;
    ctx.textAlign = "left";
    ctx.font =
      lane.kind === "recorder"
        ? '650 14px "Noto Sans SC", sans-serif'
        : '600 14px "Noto Sans SC", sans-serif';
    const labelMax = Math.max(8, labelColW - 28);
    const label = fitLabel(ctx, lane.label, labelMax);
    ctx.fillStyle = lane.color;
    ctx.beginPath();
    ctx.arc(labelLeft + 12, y + 16, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = lane.kind === "recorder" ? "#1a1a1a" : "#2a2a2a";
    ctx.fillText(label, labelLeft + 22, y + 16);
  });
  perfMark("draw_composite", perfT0);

  // 「现在」播放针；出屏时只在刻度上方画醒目小三角（无文字）
  const needleTs = nowTs || report.now_ts;
  const nowX = plotLeft + ((needleTs - t0) / span) * plotW;
  offscreenHintHit = null;

  if (nowX >= plotLeft - 1 && nowX <= plotLeft + plotW + 1) {
    ctx.save();
    ctx.strokeStyle = "rgba(198, 40, 40, 0.18)";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(nowX, AXIS_Y);
    ctx.lineTo(nowX, fullH - 6);
    ctx.stroke();
    ctx.strokeStyle = "#c62828";
    ctx.fillStyle = "#c62828";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(nowX, AXIS_Y);
    ctx.lineTo(nowX, fullH - 6);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(nowX, AXIS_Y + 1);
    ctx.lineTo(nowX - 5, AXIS_Y - 8);
    ctx.lineTo(nowX + 5, AXIS_Y - 8);
    ctx.closePath();
    ctx.fill();
    ctx.font = '600 13px "Noto Sans SC", sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    ctx.fillText(formatTickLabel(needleTs, span), nowX, AXIS_Y - 9);
    ctx.restore();
  } else {
    const onLeft = nowX < plotLeft;
    // 出屏三角落在柱图与刻度之间的 TICK_BAND，不压柱、不压数字
    const tipY = HIST_TOP + histHeightPx + 3;
    const baseY = AXIS_Y - 10;
    const midY = (tipY + baseY) / 2;
    const cx = onLeft ? plotLeft + 11 : plotLeft + plotW - 11;
    ctx.save();
    ctx.fillStyle = "rgba(198, 40, 40, 0.2)";
    ctx.beginPath();
    ctx.arc(cx, midY, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#c62828";
    ctx.strokeStyle = "#8e1c1c";
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (onLeft) {
      ctx.moveTo(cx - 7, midY);
      ctx.lineTo(cx + 5, tipY);
      ctx.lineTo(cx + 5, baseY);
    } else {
      ctx.moveTo(cx + 7, midY);
      ctx.lineTo(cx - 5, tipY);
      ctx.lineTo(cx - 5, baseY);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
    offscreenHintHit = {
      side: onLeft ? "left" : "right",
      x0: cx - 12,
      y0: tipY - 2,
      x1: cx + 12,
      y1: baseY + 2,
    };
  }

  perfMark("draw_total", perfT0);
}

function redrawHealthFromCache() {
  if (healthReportCache) drawHealthTimeline(healthReportCache, { updateLegend: false });
}

let dashPaintRaf = 0;
function scheduleHealthRedraw() {
  if (dashPaintRaf) return;
  dashPaintRaf = requestAnimationFrame(() => {
    dashPaintRaf = 0;
    redrawHealthFromCache();
  });
}

function summarizeMs(samples: number[]) {
  const a = [...samples].sort((x, y) => x - y);
  const sum = a.reduce((s, x) => s + x, 0);
  const at = (p: number) =>
    a.length ? a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : 0;
  return {
    n: a.length,
    min: a[0] ?? 0,
    p50: at(50),
    p95: at(95),
    p99: at(99),
    max: a[a.length - 1] ?? 0,
    mean: a.length ? sum / a.length : 0,
    over16: a.filter((x) => x > 16).length,
    over50: a.filter((x) => x > 50).length,
    over100: a.filter((x) => x > 100).length,
  };
}

/**
 * 应用内模拟滚动实验：直接改视窗，计量真 Canvas 分段耗时，写盘供读日志。
 */
export async function runInAppScrollPerfBench(): Promise<string> {
  if (!healthReportCache) {
    throw new Error("无 healthReportCache，请先打开仪表盘时间轴");
  }
  const saved = {
    a: viewStartTs,
    b: viewEndTs,
    collapsed: lanesCollapsed,
  };
  await ensureSeriesTilesForRange(viewStartTs, viewEndTs);

  type Bucket = Record<string, number[]>;
  const runCase = async (
    name: string,
    frames: number,
    step: (i: number) => void,
    opts?: { collapseLanes?: boolean }
  ) => {
    lanesCollapsed = opts?.collapseLanes ?? false;
    const bucket: Bucket = {
      series_build_draw: [],
      ticks: [],
      lanes: [],
      draw_total: [],
    };
    for (let i = 0; i < frames; i++) {
      step(i);
      clampViewToData();
      await ensureSeriesTilesForRange(viewStartTs, viewEndTs);
      perfCollect = (k, ms) => {
        if (!bucket[k]) bucket[k] = [];
        bucket[k].push(ms);
      };
      drawHealthTimeline(healthReportCache!, { updateLegend: false });
      perfCollect = null;
    }
    const out: Record<string, ReturnType<typeof summarizeMs>> = {};
    for (const [k, v] of Object.entries(bucket)) out[k] = summarizeMs(v);
    return { name, frames, spanMs: viewEndTs - viewStartTs, metrics: out };
  };

  // 锚定到「现在」往前一段同日窗口
  const tip = nowTs || Date.now();
  const day0 = new Date(tip);
  day0.setHours(0, 0, 0, 0);
  const base = Math.max(day0.getTime() + 12 * 3600_000, tip - 2 * 3600_000);

  const scenarios = [];

  viewStartTs = base;
  viewEndTs = base + 10 * 60_000;
  scenarios.push(
    await runCase("inapp_same_day_pan_10min", 90, (i) => {
      const span = viewEndTs - viewStartTs;
      const d = span * 0.028 * (i % 2 === 0 ? 1 : -1);
      viewStartTs += d;
      viewEndTs += d;
    })
  );

  viewStartTs = base;
  viewEndTs = base + 10 * 60_000;
  scenarios.push(
    await runCase("inapp_same_day_zoom_alt8", 40, (i) => {
      const span = viewEndTs - viewStartTs;
      const r = 0.08;
      const factor = i % 2 === 0 ? 1 + r : 1 / (1 + r);
      const mid = (viewStartTs + viewEndTs) / 2;
      let next = Math.min(MAX_VIEW_SPAN_MS, Math.max(MIN_VIEW_SPAN_MS, span * factor));
      viewStartTs = mid - next / 2;
      viewEndTs = mid + next / 2;
    })
  );

  viewStartTs = base;
  viewEndTs = base + 10 * 60_000;
  scenarios.push(
    await runCase(
      "inapp_pan_lanes_collapsed",
      60,
      (i) => {
        const span = viewEndTs - viewStartTs;
        const d = span * 0.028 * (i % 2 === 0 ? 1 : -1);
        viewStartTs += d;
        viewEndTs += d;
      },
      { collapseLanes: true }
    )
  );

  viewStartTs = saved.a;
  viewEndTs = saved.b;
  lanesCollapsed = saved.collapsed;
  redrawHealthFromCache();

  const verdicts = scenarios.map((s) => {
    const gates: string[] = [];
    for (const [k, m] of Object.entries(s.metrics)) {
      if (m.p95 > 16) gates.push(`${k} p95=${m.p95.toFixed(1)}ms`);
      if (m.max > 50) gates.push(`${k} max=${m.max.toFixed(1)}ms`);
    }
    return {
      scenario: s.name,
      gates: gates.length ? gates : ["under_16ms_ok"],
      draw_total_p95: s.metrics.draw_total?.p95 ?? 0,
      series_p95: s.metrics.series_build_draw?.p95 ?? 0,
      lanes_p95: s.metrics.lanes?.p95 ?? 0,
    };
  });

  const report = {
    utc: new Date().toISOString(),
    kind: "inapp_canvas",
    note: "模拟信号直接改 viewStart/End；真 Canvas 分段；collapse 对照看程序轴占比",
    hardGateMs: { frameBudget: 16, hitch: 50, bad: 100 },
    scenarios,
    verdicts,
  };
  const json = JSON.stringify(report, null, 2);
  console.info("[omni perf bench]", report);
  try {
    const path = await invoke<string>("perf_bench_write_report", { json });
    console.info("[omni perf bench] wrote", path);
    return path;
  } catch (e) {
    console.warn("[omni perf bench] write failed", e);
    return json;
  }
}

let inAppPerfScheduled = false;
function scheduleInAppPerfBenchOnce() {
  if (inAppPerfScheduled) return;
  try {
    if (localStorage.getItem("omnitrace.perfBench") !== "force") return;
  } catch {
    return;
  }
  inAppPerfScheduled = true;
  window.setTimeout(() => {
    void runInAppScrollPerfBench()
      .then(() => {
        try {
          localStorage.setItem("omnitrace.perfBench.v2.done", "1");
          localStorage.removeItem("omnitrace.perfBench"); // clear force
        } catch {
          /* ignore */
        }
      })
      .catch((e) => console.warn("[omni perf bench]", e));
  }, 1200);
}

// 控制台可手动：window.__omniPerfBench()
(window as unknown as { __omniPerfBench?: () => Promise<string> }).__omniPerfBench =
  runInAppScrollPerfBench;

function focusHealthCanvas() {
  const canvas = $("dash-health-canvas") as HTMLCanvasElement | null;
  if (!canvas) return;
  canvas.tabIndex = 0;
  try {
    canvas.focus({ preventScroll: true });
  } catch {
    canvas.focus();
  }
}

function bindHealthInteractions() {
  if (healthFxBound) return;
  const canvas = $("dash-health-canvas") as HTMLCanvasElement | null;
  if (!canvas) return;
  healthFxBound = true;
  canvas.tabIndex = 0;
  setTileLoadedCallback(() => {
    if (inertiaRaf) {
      pendingTileStripInvalidate = true;
      return;
    }
    invalidatePlotStrip();
    scheduleHealthRedraw();
  });
  $("dash-health-frame")?.addEventListener(
    "scroll",
    () => {
      scheduleHealthRedraw();
    },
    { passive: true }
  );

  canvas.addEventListener("pointerenter", () => {
    pointerOverHealthCanvas = true;
    focusHealthCanvas();
  });
  canvas.addEventListener("pointerleave", () => {
    pointerOverHealthCanvas = false;
  });

  function onAxisPointerMove(e: PointerEvent) {
    if (!axisPanState || e.pointerId !== axisPanState.pointerId) return;
    const dx = e.clientX - axisPanState.x;
    const span = axisPanState.viewEnd - axisPanState.viewStart;
    const delta = (-dx / Math.max(1, axisPanState.plotW)) * span;
    viewStartTs = axisPanState.viewStart + delta;
    viewEndTs = axisPanState.viewEnd + delta;
    clampViewToData();
    scheduleTilePrefetch();
    scheduleHealthRedraw();
    lastUserInteractAt = performance.now();
  }

  function tryFirePendingSeek(e: { clientX: number; clientY: number; button?: number }) {
    if (!pendingSeek) return;
    if (e.button != null && e.button !== 0) return;
    const dx = e.clientX - pendingSeek.x;
    const dy = e.clientY - pendingSeek.y;
    if (dx * dx + dy * dy > AXIS_PAN_CLICK_SLOP * AXIS_PAN_CLICK_SLOP) {
      pendingSeek = null;
      return;
    }
    if (timelineSeekHandler) timelineSeekHandler(pendingSeek.ts);
    pendingSeek = null;
  }

  function onAxisPointerUp(e: PointerEvent) {
    if (!axisPanState || e.pointerId !== axisPanState.pointerId) return;
    window.removeEventListener("pointermove", onAxisPointerMove);
    window.removeEventListener("pointerup", onAxisPointerUp);
    window.removeEventListener("pointercancel", onAxisPointerUp);
    const dx = e.clientX - axisPanState.x;
    const dy = e.clientY - axisPanState.y;
    const wasDrag = dx * dx + dy * dy > AXIS_PAN_CLICK_SLOP * AXIS_PAN_CLICK_SLOP;
    clearAxisPanState();
    if (!labelDragging && canvas) canvas.style.cursor = "default";
    if (wasDrag) pendingSeek = null;
    else tryFirePendingSeek(e);
  }

  canvas.addEventListener("pointerdown", (e) => {
    pendingSeek = null;
    if (e.button !== 0) return;
    focusHealthCanvas();
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top + dashViewOffsetY;
    if (
      offscreenHintHit &&
      x >= offscreenHintHit.x0 &&
      x <= offscreenHintHit.x1 &&
      y >= offscreenHintHit.y0 &&
      y <= offscreenHintHit.y1
    ) {
      e.preventDefault();
      centerViewOnNeedle();
      return;
    }
    const cssW = canvas.clientWidth || 800;
    const { splitX, plotLeft, plotW } = healthLayout(cssW);
    if (Math.abs(x - splitX) <= 5) {
      labelDragging = true;
      stopInertia();
      canvas.style.cursor = "col-resize";
      e.preventDefault();
      return;
    }
    const hit = hitRecorderSegment(x, y, cssW);
    if (hit) {
      pendingSeek = { ts: hit.ts, x: e.clientX, y: e.clientY };
      e.preventDefault();
    }
    if (x >= plotLeft && x < splitX && !hit) {
      clearAxisPanState();
      stopInertia();
      const span = Math.max(1, viewEndTs - viewStartTs);
      axisPanState = {
        x: e.clientX,
        y: e.clientY,
        plotW,
        viewStart: viewStartTs,
        viewEnd: viewStartTs + span,
        pointerId: e.pointerId,
      };
      canvas.style.cursor = "grabbing";
      lastUserInteractAt = performance.now();
      window.addEventListener("pointermove", onAxisPointerMove);
      window.addEventListener("pointerup", onAxisPointerUp);
      window.addEventListener("pointercancel", onAxisPointerUp);
    }
  });

  // Win / WebView：光按 Alt 会把焦点交给菜单栏，松手后滚轮就“失灵”直到再点一下
  window.addEventListener(
    "keydown",
    (e) => {
      if (
        pointerOverHealthCanvas &&
        (e.key === "Alt" || e.code === "AltLeft" || e.code === "AltRight")
      ) {
        e.preventDefault();
      }
    },
    true
  );
  window.addEventListener(
    "keyup",
    (e) => {
      if (
        pointerOverHealthCanvas &&
        (e.key === "Alt" || e.code === "AltLeft" || e.code === "AltRight")
      ) {
        e.preventDefault();
        focusHealthCanvas();
      }
    },
    true
  );

  function hitRecorderSegment(
    x: number,
    y: number,
    cssW: number
  ): { ts: number } | null {
    if (!healthReportCache) return null;
    const allLanes = healthReportCache.lanes || [];
    const lanes = lanesCollapsed
      ? allLanes.filter((l) => l.kind === "recorder")
      : allLanes;
    const { plotLeft, splitX, plotW } = healthLayout(cssW);
    if (x < plotLeft || x >= splitX) return null;
    const AXIS_Y = axisY();
    const lanesTop = AXIS_Y + HIST_GAP;
    const i = Math.floor((y - lanesTop) / LANE_H);
    if (i < 0 || i >= lanes.length) return null;
    const lane = lanes[i];
    if (lane.kind !== "recorder") return null;
    const barH = 16;
    const barY = lanesTop + i * LANE_H + 16 - barH / 2;
    if (y < barY - 2 || y > barY + barH + 2) return null;
    const span = Math.max(1, viewEndTs - viewStartTs);
    const ts = viewStartTs + ((x - plotLeft) / plotW) * span;
    const hit = lane.segments.some((s) => {
      const end = s.end_ts ?? healthReportCache!.now_ts;
      return ts >= s.start_ts && ts <= end;
    });
    return hit ? { ts } : null;
  }

  canvas.addEventListener("mousemove", (e) => {
    if (labelDragging || axisPanState) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top + dashViewOffsetY;
    if (
      offscreenHintHit &&
      x >= offscreenHintHit.x0 &&
      x <= offscreenHintHit.x1 &&
      y >= offscreenHintHit.y0 &&
      y <= offscreenHintHit.y1
    ) {
      canvas.style.cursor = "pointer";
      return;
    }
    const cssW = canvas.clientWidth || 800;
    const { splitX } = healthLayout(cssW);
    if (Math.abs(x - splitX) <= 5) {
      canvas.style.cursor = "col-resize";
      return;
    }
    canvas.style.cursor = hitRecorderSegment(x, y, cssW)
      ? "pointer"
      : "default";
  });

  window.addEventListener("mousemove", (e) => {
    if (!labelDragging) return;
    const rect = canvas.getBoundingClientRect();
    const cssW = canvas.clientWidth || 800;
    // 右侧列宽 = 画布右缘到指针
    labelColW = Math.min(
      LABEL_W_MAX,
      Math.max(LABEL_W_MIN, cssW - (e.clientX - rect.left))
    );
    scheduleHealthRedraw();
  });

  canvas.addEventListener("pointerup", (e) => {
    if (e.button !== 0 || axisPanState) return;
    tryFirePendingSeek(e);
  });

  window.addEventListener("mouseup", () => {
    if (labelDragging) {
      labelDragging = false;
      pendingSeek = null;
    }
  });

  canvas.addEventListener(
    "wheel",
    (e) => {
      if (!healthReportCache) return;
      lastUserInteractAt = performance.now();
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top + dashViewOffsetY;
      const cssW = canvas.clientWidth || 800;
      const { plotLeft, splitX, plotW } = healthLayout(cssW);
      const inPlot = x >= plotLeft && x < splitX;
      const inLabels = x >= splitX;
      const inHist =
        inPlot && y >= HIST_TOP && y <= HIST_TOP + histHeightPx;
      const frame = $("dash-health-frame");

      // 柱图区 Shift+滚轮：调柱状图在屏幕上的高度
      if (inHist && e.shiftKey && !e.altKey) {
        e.preventDefault();
        const grow = e.deltaY < 0;
        histHeightPx = Math.min(
          HIST_H_MAX,
          Math.max(HIST_H_MIN, histHeightPx * (grow ? 1.12 : 0.9))
        );
        redrawHealthFromCache();
        return;
      }

      // 右侧名称列，或（非柱图）轴上按住 Shift：上下滚列表
      if (inLabels || (inPlot && !inHist && e.shiftKey && !e.altKey)) {
        if (frame) {
          frame.scrollTop += e.deltaY;
          e.preventDefault();
        }
        return;
      }

      if (!inPlot) return;

      e.preventDefault();
      const span = Math.max(1, viewEndTs - viewStartTs);
      const frac = Math.min(1, Math.max(0, (x - plotLeft) / plotW));

      // 规范化 deltaY（归一化 100 刻度；支持触控板与各类高精滚轮，绝不吞指令）
      let dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 33;
      else if (e.deltaMode === 2) dy *= 300;

      if (e.altKey) {
        // 放大/缩小：由 Alt 滚轮方向和物理幅度决定
        const prefs = getPlaybackPrefs();
        zoomAnchorFrac = frac;
        const dir = dy < 0 ? -1 : 1;
        const absD = Math.abs(dy);
        const stepPct = prefs.timelineZoomPct;
        const ratio = Math.min(0.8, (absD / 100) * (stepPct / 100));
        const factor = dir < 0 ? 1 / (1 + ratio) : 1 + ratio;
        applyZoomFactor(factor, frac);
        if (prefs.inertia) {
          zoomVel += dir * ratio * 8;
          kickInertia();
        } else {
          redrawHealthFromCache();
        }
      } else {
        const prefs = getPlaybackPrefs();
        const panFrac = Math.max(0.005, prefs.timelinePanPct / 100);
        const dFrac = (dy / 100) * panFrac;
        applyPanDelta(span * dFrac);
        if (prefs.inertia) {
          panVel += span * dFrac * 0.08;
          kickInertia();
        } else {
          redrawHealthFromCache();
        }
      }
    },
    { passive: false }
  );
}

function isHealthReport(v: unknown): v is HealthReport {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as HealthReport).now_ts === "number" &&
    Array.isArray((v as HealthReport).lanes)
  );
}

async function renderHealth(opts?: { force?: boolean; background?: boolean }) {
  const force = opts?.force ?? false;
  const background = opts?.background ?? false;
  if (healthInflight) {
    if (!force) return;
    if (!background && !healthReportCache) setHealthMetaHint("加载时间轴…");
    healthWaitInflight = true;
    return;
  }
  if (!background && !dashboardHealthActive()) return;
  const nowMs = Date.now();
  if (
    !force &&
    !background &&
    healthReportCache &&
    nowMs - lastHealthFetchAt < HEALTH_MIN_FETCH_MS
  ) {
    redrawHealthFromCache();
    return;
  }
  // 用户正在交互/滚动或刚刚滚动完（4秒内），不打扰平滑体验；强制首载除外
  if (
    !force &&
    !background &&
    (inertiaRaf || (lastUserInteractAt > 0 && performance.now() - lastUserInteractAt < 4000))
  ) {
    return;
  }
  // 先用内存缓存瞬间绘出，避免切页白屏/卡顿
  if (!background) {
    if (healthReportCache) redrawHealthFromCache();
    else setHealthMetaHint("加载时间轴…");
  }
  const abortToken = healthAbortGen;
  healthInflight = true;
  try {
    if (!background) bindHealthInteractions();
    if (!healthReportCache) {
      try {
        const snap = await invoke<HealthReport | null>("dashboard_health_snapshot");
        if (snap && abortToken === healthAbortGen && isHealthReport(snap)) {
          healthReportCache = snap;
          if (dashboardHealthActive()) {
            applyHealthReportUi(snap, abortToken);
          }
        }
      } catch {
        // 无快照命令或盘上无文件：走 quick
      }
    }
    if (!healthReportCache) {
      const quick = await runHeavyIpc(
        "dashboard_health_quick",
        () => invoke<HealthReport>("dashboard_health", { quick: true }),
        { cancelled: () => abortToken !== healthAbortGen }
      );
      if (isHealthReport(quick)) {
        healthReportCache = quick;
        if (dashboardHealthActive()) {
          applyHealthReportUi(quick, abortToken);
        }
      }
    }
    const report = await runHeavyIpc(
      "dashboard_health",
      () => invoke<HealthReport>("dashboard_health", { quick: false }),
      { cancelled: () => abortToken !== healthAbortGen }
    );
    if (!isHealthReport(report)) return;
    lastHealthFetchAt = Date.now();
    healthReportCache = report;
    const waited = healthWaitInflight;
    if (waited) healthWaitInflight = false;
    // 后台预热结束时人可能已经在仪表盘：必须画，不能因为 background 直接 return
    if (!dashboardHealthActive()) return;
    requestAnimationFrame(() => {
      if (!dashboardHealthActive()) return;
      applyHealthReportUi(report, abortToken);
    });
  } catch (e) {
    if (e instanceof Error && e.message === "cancelled") return;
    if (!background) {
      setHealthLoading(false);
      setHealthMetaHint(`加载失败：${String(e)}`);
    }
  } finally {
    healthInflight = false;
    if (healthWaitInflight && dashboardHealthActive()) {
      healthWaitInflight = false;
      window.setTimeout(() => {
        if (!dashboardHealthActive()) return;
        if (healthReportCache) redrawHealthFromCache();
        else void renderHealth({ force: true });
      }, 0);
    } else {
      healthWaitInflight = false;
    }
  }
}

function applyHealthReportUi(report: HealthReport, abortToken: number) {
  window.setTimeout(() => {
    if (!dashboardHealthActive()) return;
  if (plotStrip && (report.lanes?.length ?? 0) !== plotStrip.laneCount) {
    invalidatePlotStrip();
  }
  const warmLanes = () => {
    if (abortToken !== healthAbortGen || !dashboardHealthActive()) return;
    for (let i = 0; i < (report.lanes || []).length; i++) {
      getLaneIndex(report.lanes[i]);
    }
  };
  const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number })
    .requestIdleCallback;
  if (idle) idle(warmLanes);
  else warmLanes();
  nowTs = Math.max(report.now_ts, Date.now());
  dataEndTs = nowTs;
  if (!viewInitialized) {
    initStationaryView();
    viewInitialized = true;
  } else {
    clampViewToData();
  }
  if (dashPanel === "health") {
    drawHealthTimeline(report);
    setHealthLoading(false);
    scheduleHistRefresh();
  }
  scheduleInAppPerfBenchOnce();
  }, 0);
}

function formatDurationMs(ms: number) {
  const totalMin = Math.max(0, Math.round(ms / 60000));
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h <= 0) return `${m} 分钟`;
  if (m === 0) return `${h} 小时`;
  return `${h} 小时 ${m} 分钟`;
}

const PIE_COLORS = [
  "#1f6f5b",
  "#3d8f7a",
  "#c4a574",
  "#5a7a9e",
  "#b86b4a",
  "#6b8f5a",
  "#7a6b5a",
  "#4a6b6b",
  "#a08050",
  "#8a847c",
];

function drawFocusUsageChart(
  canvas: HTMLCanvasElement,
  days: { label: string; total_ms: number; is_today?: boolean }[],
  avgMs: number
) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 640;
  const cssH = canvas.clientHeight || 168;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const padL = 44;
  const padR = 10;
  const padT = 12;
  const padB = 28;
  const plotW = cssW - padL - padR;
  const plotH = cssH - padT - padB;
  const maxMs = Math.max(avgMs, ...days.map((d) => d.total_ms), 1);

  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = "#faf8f5";
  ctx.fillRect(0, 0, cssW, cssH);

  // 网格 + Y 刻度
  ctx.strokeStyle = "#e8e4de";
  ctx.fillStyle = "#8a847c";
  ctx.font = '13px "Noto Sans SC", sans-serif';
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= 2; i++) {
    const y = padT + (plotH * i) / 2;
    ctx.beginPath();
    ctx.setLineDash(i === 0 ? [] : [3, 4]);
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);
    const labelMs = maxMs * (1 - i / 2);
    ctx.fillText(formatDurationMs(labelMs).replace(" ", ""), padL - 8, y);
  }

  // 平均线
  if (avgMs > 0) {
    const ay = padT + plotH * (1 - avgMs / maxMs);
    ctx.strokeStyle = "#c4a574";
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(padL, ay);
    ctx.lineTo(padL + plotW, ay);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#a08050";
    ctx.textAlign = "left";
    ctx.fillText("平均", padL + 4, ay - 8);
  }

  const n = Math.max(days.length, 1);
  const slot = plotW / n;
  const barW = Math.min(28, slot * 0.55);
  days.forEach((d, i) => {
    const h = (d.total_ms / maxMs) * plotH;
    const x = padL + slot * i + (slot - barW) / 2;
    const y = padT + plotH - h;
    ctx.fillStyle = d.is_today ? "#1f6f5b" : "#3d8f7a";
    ctx.beginPath();
    const r = 3;
    ctx.moveTo(x, y + h);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.lineTo(x + barW - r, y);
    ctx.quadraticCurveTo(x + barW, y, x + barW, y + r);
    ctx.lineTo(x + barW, y + h);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = "#5a554f";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.font = d.is_today
      ? '600 13px "Noto Sans SC", sans-serif'
      : '13px "Noto Sans SC", sans-serif';
    ctx.fillText(d.label, x + barW / 2, padT + plotH + 8);
  });
}

function drawFocusPieChart(
  canvas: HTMLCanvasElement,
  apps: { app: string; total_ms: number }[]
) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 220;
  const cssH = canvas.clientHeight || 200;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const total = apps.reduce((s, a) => s + a.total_ms, 0);
  const cx = cssW / 2;
  const cy = cssH / 2;
  const R = Math.min(cssW, cssH) * 0.38;
  const r = R * 0.58;

  if (total <= 0 || !apps.length) {
    ctx.strokeStyle = "#e2ddd5";
    ctx.lineWidth = R - r;
    ctx.beginPath();
    ctx.arc(cx, cy, (R + r) / 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = "#8a847c";
    ctx.font = '14px "Noto Sans SC", sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("暂无数据", cx, cy);
    return;
  }

  let angle = -Math.PI / 2;
  apps.forEach((a, i) => {
    const slice = (a.total_ms / total) * Math.PI * 2;
    const color = PIE_COLORS[i % PIE_COLORS.length];
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, angle, angle + slice);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    angle += slice;
  });

  // 甜甜圈中心
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = "#fff";
  ctx.fill();

  ctx.fillStyle = "#1a1a1a";
  ctx.font = '650 15px "Noto Sans SC", sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(formatDurationMs(total).replace(" ", ""), cx, cy - 8);
  ctx.fillStyle = "#6a6560";
  ctx.font = '13px "Noto Sans SC", sans-serif';
  ctx.fillText("合计", cx, cy + 12);
}

type FocusUsageView = {
  days: { label: string; total_ms: number; is_today?: boolean }[];
  apps: { app: string; total_ms: number }[];
  avgMs: number;
  todayMs: number;
  weekMs: number;
  pieData: { app: string; total_ms: number }[];
  appRows: string;
  pieLegend: string;
};

function parseFocusUsage(raw: any): FocusUsageView {
  const days = (raw?.days || []) as {
    label: string;
    total_ms: number;
    is_today?: boolean;
  }[];
  const apps = (raw?.apps || []) as { app: string; total_ms: number }[];
  const avgMs = Number(raw?.avg_ms) || 0;
  const todayMs = Number(raw?.today_ms) || 0;
  const weekMs = Number(raw?.week_total_ms) || 0;
  const maxApp = Math.max(1, ...apps.map((a) => a.total_ms));
  const pieApps = apps.slice(0, 8);
  const pieRestMs = apps.slice(8).reduce((s, a) => s + a.total_ms, 0);
  const pieData =
    pieRestMs > 0
      ? [...pieApps, { app: "其它", total_ms: pieRestMs }]
      : pieApps;
  const pieTotal = pieData.reduce((s, a) => s + a.total_ms, 0) || 1;
  const appRows = apps
    .map((a, i) => {
      const pct = Math.round((a.total_ms / maxApp) * 100);
      const color = PIE_COLORS[i % PIE_COLORS.length];
      return `<div class="focus-app-row">
          <div class="focus-app-top">
            <span class="focus-app-name"><span class="pie-swatch" style="background:${color};display:inline-block;margin-right:6px;vertical-align:-1px"></span>${escapeHtml(a.app)}</span>
            <span class="focus-app-time">${formatDurationMs(a.total_ms)}</span>
          </div>
          <div class="focus-app-track"><div class="focus-app-fill" style="width:${pct}%;background:${color}"></div></div>
        </div>`;
    })
    .join("");
  const pieLegend = pieData
    .map((a, i) => {
      const pct = Math.round((a.total_ms / pieTotal) * 100);
      const color = PIE_COLORS[i % PIE_COLORS.length];
      return `<div class="pie-legend-row">
          <span class="pie-swatch" style="background:${color}"></span>
          <span class="pie-name" title="${escapeHtml(a.app)}">${escapeHtml(a.app)}</span>
          <span class="pie-pct">${pct}%</span>
        </div>`;
    })
    .join("");
  return { days, apps, avgMs, todayMs, weekMs, pieData, appRows, pieLegend };
}

type KeyFreqEntry = { code: number; name: string; count: number };

type KeyFreqView = {
  total: number;
  top: KeyFreqEntry[];
  rows: string;
};

function parseKeyFrequency(raw: any): KeyFreqView {
  const top = (raw?.top || []) as KeyFreqEntry[];
  const total = Number(raw?.total_presses) || top.reduce((s, k) => s + (Number(k.count) || 0), 0);
  const max = Math.max(1, ...top.map((k) => Number(k.count) || 0));
  const rows = top
    .map((k, i) => {
      const count = Number(k.count) || 0;
      const pct = Math.round((count / max) * 100);
      const color = PIE_COLORS[i % PIE_COLORS.length];
      const code = Number(k.code);
      const label = k.name || `VK${code}`;
      return `<div class="focus-app-row">
          <div class="focus-app-top">
            <span class="focus-app-name"><span class="pie-swatch" style="background:${color};display:inline-block;margin-right:6px;vertical-align:-1px"></span>${escapeHtml(label)} <span class="muted">(${code})</span></span>
            <span class="focus-app-time">${formatCount(count)}</span>
          </div>
          <div class="focus-app-track"><div class="focus-app-fill" style="width:${pct}%;background:${color}"></div></div>
        </div>`;
    })
    .join("");
  return { total, top, rows };
}

function drawKeyFreqChart(canvas: HTMLCanvasElement, keys: KeyFreqEntry[]) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 640;
  const cssH = canvas.clientHeight || 168;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const padL = 44;
  const padR = 10;
  const padT = 12;
  const padB = 28;
  const plotW = cssW - padL - padR;
  const plotH = cssH - padT - padB;

  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = "#faf8f5";
  ctx.fillRect(0, 0, cssW, cssH);

  if (!keys.length) {
    ctx.fillStyle = "#8a847c";
    ctx.font = '13px "Noto Sans SC", sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("暂无键盘按下记录", cssW / 2, cssH / 2);
    return;
  }

  const show = keys.slice(0, 10);
  const maxCount = Math.max(1, ...show.map((k) => Number(k.count) || 0));
  const n = show.length;
  const slot = plotW / n;
  const barW = Math.min(28, slot * 0.55);

  ctx.strokeStyle = "#e8e4de";
  ctx.fillStyle = "#8a847c";
  ctx.font = '13px "Noto Sans SC", sans-serif';
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let i = 0; i <= 2; i++) {
    const y = padT + (plotH * i) / 2;
    ctx.beginPath();
    ctx.setLineDash(i === 0 ? [] : [3, 4]);
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);
    const labelN = Math.round(maxCount * (1 - i / 2));
    ctx.fillText(formatCount(labelN), padL - 8, y);
  }

  show.forEach((k, i) => {
    const count = Number(k.count) || 0;
    const h = (count / maxCount) * plotH;
    const x = padL + slot * i + (slot - barW) / 2;
    const y = padT + plotH - h;
    const color = PIE_COLORS[i % PIE_COLORS.length];
    ctx.fillStyle = color;
    ctx.beginPath();
    const r = 3;
    ctx.moveTo(x, y + h);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.lineTo(x + barW - r, y);
    ctx.quadraticCurveTo(x + barW, y, x + barW, y + r);
    ctx.lineTo(x + barW, y + h);
    ctx.closePath();
    ctx.fill();

    const label = (k.name || `VK${k.code}`).slice(0, 4);
    ctx.fillStyle = "#5a554f";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.font = '13px "Noto Sans SC", sans-serif';
    ctx.fillText(label, x + barW / 2, padT + plotH + 8);
  });
}

const SHOW_ACTIVE_FOCUS_KEY = "omnitrace.dash.showActiveFocus";
const STATS_SNAP_PREFIX = "omnitrace.dash.statsSnap.v1.";

type StatsSnapshot = {
  washedAt: number;
  includeActive: boolean;
  report: StatsReport;
};

const statsSnapMem = new Map<string, StatsSnapshot>();

function statsSnapKey(includeActive: boolean) {
  return STATS_SNAP_PREFIX + (includeActive ? "1" : "0");
}

function loadShowActiveFocus(): boolean {
  try {
    return localStorage.getItem(SHOW_ACTIVE_FOCUS_KEY) === "1";
  } catch {
    return false;
  }
}

function saveShowActiveFocus(on: boolean) {
  try {
    localStorage.setItem(SHOW_ACTIVE_FOCUS_KEY, on ? "1" : "0");
  } catch {
    /* ignore quota / private mode */
  }
}

function loadStatsSnapshot(includeActive: boolean): StatsSnapshot | null {
  const k = statsSnapKey(includeActive);
  const mem = statsSnapMem.get(k);
  if (mem) return mem;
  try {
    const raw = localStorage.getItem(k);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StatsSnapshot;
    if (!parsed?.report) return null;
    statsSnapMem.set(k, parsed);
    return parsed;
  } catch {
    return null;
  }
}

function saveStatsSnapshot(includeActive: boolean, report: StatsReport) {
  const snap: StatsSnapshot = {
    washedAt: Date.now(),
    includeActive,
    report,
  };
  const k = statsSnapKey(includeActive);
  statsSnapMem.set(k, snap);
  try {
    localStorage.setItem(k, JSON.stringify(snap));
  } catch {
    /* ignore quota / private mode */
  }
}

function formatWashedClock(ts: number) {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function setStatsProgress(on: boolean, label?: string) {
  const el = $("dash-stats-progress");
  const lab = $("dash-stats-progress-label");
  if (!el) return;
  el.hidden = !on;
  el.classList.toggle("is-loading", on);
  if (lab) lab.textContent = on ? label || "正在洗最新统计…" : "";
}

async function renderStats(opts?: { force?: boolean }) {
  const host = $("dash-stats-body");
  if (!host) return;
  const includeActive = loadShowActiveFocus();
  const force = opts?.force ?? false;
  const snap = loadStatsSnapshot(includeActive);
  let paintedStale = false;
  const empty = host.childElementCount === 0;
  if (snap && empty) {
    applyStatsReport(host, snap.report, includeActive, {
      stale: true,
      washedAt: snap.washedAt,
    });
    paintedStale = true;
  }

  if (statsInflight) {
    statsNeedsRerender = true;
    return;
  }
  statsInflight = true;
  const showProgress = force || empty || paintedStale;
  if (showProgress) {
    setStatsProgress(
      true,
      paintedStale ? "正在洗最新统计…" : "正在洗统计…"
    );
  }
  try {
    const s = await runHeavyIpc("dashboard_stats", () =>
      invoke<StatsReport>("dashboard_stats", {
        includeActiveFocus: includeActive,
        forceRefresh: force,
      })
    );
    if (loadShowActiveFocus() !== includeActive) {
      statsNeedsRerender = true;
      return;
    }
    applyStatsReport(host, s, includeActive, {
      stale: false,
      washedAt: Date.now(),
    });
    saveStatsSnapshot(includeActive, s);
  } catch (e) {
    if (!paintedStale) {
      host.innerHTML = `<p class="muted">${escapeHtml(String(e))}</p>`;
    }
  } finally {
    setStatsProgress(false);
    statsInflight = false;
    if (statsNeedsRerender) {
      statsNeedsRerender = false;
      void renderStats({ force: true });
    }
  }
}

function applyStatsReport(
  host: HTMLElement,
  s: StatsReport,
  includeActive: boolean,
  opts: { stale: boolean; washedAt: number }
) {
  const stale = opts.stale;
  const usage = includeActive
    ? parseFocusUsage(s.charts?.active_focus_usage || {})
    : parseFocusUsage(s.charts?.focus_usage || {});
    const vol = s.volume || {};
    const rows = (s.today?.modules || []) as any[];
    const maxLines = Math.max(1, ...rows.map((r) => Number(r.lines) || 0));
    const bars = rows
      .map((r) => {
        const pct = Math.round(((Number(r.lines) || 0) / maxLines) * 100);
        return `<div class="stat-bar-row">
          <div class="stat-bar-label">${MODULE_LABEL[r.module] || r.module}</div>
          <div class="stat-bar-track"><div class="stat-bar-fill" style="width:${pct}%"></div></div>
          <div class="stat-bar-val">${formatCount(Number(r.lines) || 0)} 条 · ${formatBytes(Number(r.bytes) || 0)}</div>
        </div>`;
      })
      .join("");
    const binBytes = Number(s.charts?.bin_bytes) || 0;
    const todayMouse = Number(s.today?.input_mouse ?? vol.input_mouse_today) || 0;
    const todayKey = Number(s.today?.input_key ?? vol.input_key_today) || 0;

    const prevDetails = host.querySelector(
      ".stat-details"
    ) as HTMLDetailsElement | null;
    if (prevDetails) statsDetailsOpen = prevDetails.open;
    statsScrollTop = host.scrollTop;

    const focusHint = includeActive
      ? "已去掉可能 AFK（无键鼠的 5 分钟格）"
      : "全部焦点窗（含可能 AFK）";
    const appHint = includeActive ? "近 7 日 · 仅有人操作" : "近 7 日";
    const listHint = includeActive ? "只计有键鼠的 5 分钟格" : "列表";
    const emptyFocus =
      includeActive
        ? "<p class='muted'>没有判定为有人操作的焦点。关掉「仅有人操作」可看含可能 AFK 的全部焦点。</p>"
        : "<p class='muted'>暂无焦点数据。打开 WinRecorder 使用一段时间后再看。</p>";

    const keyFreq = parseKeyFrequency(s.charts?.key_frequency || {});
    const emptyKeys =
      keyFreq.top.length
        ? keyFreq.rows
        : "<p class='muted'>近 7 日暂无键盘按下记录。打开 WinRecorder 使用一段时间后再看。</p>";

    host.innerHTML = `
      <div class="stats-toolbar">
        <button type="button" id="btn-toggle-active-focus" class="dash-chip${includeActive ? " active" : ""}" aria-pressed="${includeActive ? "true" : "false"}">仅有人操作（去掉 AFK）</button>
        <span class="dash-chip-meta">${stale ? `上次洗数 ${formatWashedClock(opts.washedAt)}` : "刚刚更新"} · 5 分钟格内无键鼠视为 AFK · <button type="button" class="dash-text-link" data-open-about data-about-anchor="about-caliber-focus">见关于</button></span>
      </div>
      <div class="stats-grid${stale ? " is-stale" : ""}">
        <article class="chart-card wide">
          <div class="chart-card-head">
            <h3>总数据量</h3>
            <span class="hint">OmniDatabase 落盘</span>
          </div>
          <div class="chart-card-kpi">
            <div>
              <div class="k">磁盘</div>
              <div class="big">${formatBytes(Number(vol.total_bytes) || 0)}</div>
              <div class="sub">键鼠 bin ${formatBytes(Number(vol.event_data_bytes) || 0)} · 模组 ${formatBytes(Number(vol.module_data_bytes) || 0)}</div>
            </div>
            <div>
              <div class="k">模组事件</div>
              <div class="big">${formatCount(Number(vol.module_events) || 0)}</div>
              <div class="sub">全部 JSONL 行</div>
            </div>
            <div>
              <div class="k">键鼠累计</div>
              <div class="big">${formatCount((Number(vol.input_mouse) || 0) + (Number(vol.input_key) || 0))}</div>
              <div class="sub">鼠标 ${formatCount(Number(vol.input_mouse) || 0)} · 键盘 ${formatCount(Number(vol.input_key) || 0)}</div>
            </div>
            <div>
              <div class="k">健康心跳</div>
              <div class="big">${formatCount(Number(vol.health_events) || 0)}</div>
              <div class="sub">今日 ${formatCount(Number(vol.health_events_today) || 0)}</div>
            </div>
          </div>
          <p class="muted" style="margin:4px 0 0">健康日志 ${formatBytes(Number(vol.control_bytes) || 0)} · 缓存 ${formatBytes(Number(vol.cache_bytes) || 0)} · 笔记 ${formatBytes(Number(vol.notes_bytes) || 0)}</p>
        </article>
        <article class="chart-card">
          <div class="chart-card-head">
            <h3>近 7 日焦点</h3>
            <span class="hint">${focusHint}</span>
          </div>
          <div class="chart-card-kpi">
            <div>
              <div class="k">日均</div>
              <div class="big">${formatDurationMs(usage.avgMs)}</div>
              <div class="sub">本周 ${formatDurationMs(usage.weekMs)}</div>
            </div>
            <div>
              <div class="k">今日</div>
              <div class="big">${formatDurationMs(usage.todayMs)}</div>
              <div class="sub">${includeActive ? "闲置格已去掉" : "按焦点窗累计"}</div>
            </div>
          </div>
          <canvas id="dash-focus-canvas" class="chart-card-canvas"></canvas>
        </article>
        <article class="chart-card">
          <div class="chart-card-head">
            <h3>应用占比</h3>
            <span class="hint">${appHint}</span>
          </div>
          <div class="pie-wrap">
            <canvas id="dash-focus-pie" class="pie-canvas"></canvas>
            <div class="pie-legend">${
              usage.pieLegend || "<p class='muted'>暂无数据</p>"
            }</div>
          </div>
        </article>
        <article class="chart-card wide">
          <div class="chart-card-head">
            <h3>应用焦点时长</h3>
            <span class="hint">${listHint}</span>
          </div>
          <div class="focus-app-list">${
            usage.appRows || emptyFocus
          }</div>
        </article>
        <article class="chart-card wide">
          <div class="chart-card-head">
            <h3>键盘按键频率</h3>
            <span class="hint">近 7 日 · 仅按下 0xFC</span>
          </div>
          <div class="chart-card-kpi">
            <div>
              <div class="k">按下合计</div>
              <div class="big">${formatCount(keyFreq.total)}</div>
              <div class="sub">Top ${keyFreq.top.length} 键</div>
            </div>
          </div>
          <canvas id="dash-keyfreq-canvas" class="chart-card-canvas"></canvas>
          <div class="focus-app-list" style="margin-top:12px">${emptyKeys}</div>
        </article>
      </div>
      <details class="stat-details"${statsDetailsOpen ? " open" : ""}>
        <summary>落盘摘要（今日模组 JSONL 行数 · 不含键鼠 bin）</summary>
        <p class="muted" style="margin:8px 0 0">一条 = 当日 events_DD.jsonl 一行 ModuleEvent，不按 kind 过滤。input 的键鼠物理流在 EventData bin，见上方键鼠累计。</p>
        <div class="stat-cards" style="margin-top:12px">
          <div class="stat-card"><div class="k">数据存放位置</div><div class="v mono">${escapeHtml(s.data_root)}</div></div>
          <div class="stat-card"><div class="k">今日键鼠 bin</div><div class="v">${formatBytes(binBytes)}</div></div>
          <div class="stat-card"><div class="k">今日键鼠次数</div><div class="v">鼠标 ${formatCount(todayMouse)} · 键盘 ${formatCount(todayKey)}</div></div>
          <div class="stat-card"><div class="k">今日健康心跳</div><div class="v">${formatCount(Number(s.today?.health_events) || 0)} <span class="muted">/ 累计 ${formatCount(Number(s.today?.health_events_total ?? vol.health_events) || 0)}</span></div></div>
          <div class="stat-card"><div class="k">日期</div><div class="v">${s.today?.date ?? "—"}</div></div>
        </div>
        <h3 class="dash-h3">今日各模组事件量</h3>
        <div class="stat-bars">${bars || "<p class='muted'>暂无数据</p>"}</div>
      </details>
    `;

    const details = host.querySelector(
      ".stat-details"
    ) as HTMLDetailsElement | null;
    details?.addEventListener("toggle", () => {
      statsDetailsOpen = !!details.open;
    });
    host.scrollTop = statsScrollTop;

    const canvas = $("dash-focus-canvas") as HTMLCanvasElement | null;
    if (canvas && usage.days.length) drawFocusUsageChart(canvas, usage.days, usage.avgMs);
    const pie = $("dash-focus-pie") as HTMLCanvasElement | null;
    if (pie) drawFocusPieChart(pie, usage.pieData);
    const keyCanvas = $("dash-keyfreq-canvas") as HTMLCanvasElement | null;
    if (keyCanvas) drawKeyFreqChart(keyCanvas, keyFreq.top);

    const meta = document.querySelector("#dash-stats .meta");
    if (meta) {
      const fresh = stale
        ? `上次 ${formatWashedClock(opts.washedAt)}`
        : "刚刚更新";
      const mode = includeActive ? "仅有人操作" : "全部焦点";
      meta.textContent = `${fresh} · ${mode} ${formatDurationMs(usage.todayMs)} · 库 ${formatBytes(Number(vol.total_bytes) || 0)}`;
    }

    const toggleBtn = $("btn-toggle-active-focus");
    toggleBtn?.addEventListener("click", () => {
      saveShowActiveFocus(!includeActive);
      void renderStats({ force: true });
    });
}

let sleepInflight = false;

interface SleepGuessApp {
  label: string;
  duration_ms: number;
}

interface SleepGuessDay {
  day_start_ms: number;
  wake_ts: number;
  mode: string;
  apps: SleepGuessApp[];
}

interface SleepGuessReport {
  days: SleepGuessDay[];
  phone_linked: boolean;
  note?: string | null;
  activity_t0: number;
  activity_t1: number;
  activity_bin_ms: number;
  pc_active: boolean[];
  phone_active: boolean[];
}

function defaultSleepRange(): [number, number] {
  const now = Date.now();
  const today0 = new Date(now);
  today0.setHours(0, 0, 0, 0);
  return [today0.getTime() - 13 * DAY_MS, today0.getTime() + DAY_MS];
}

/** 浅金黄 / 浅天青：低饱和叠在底轨上 */
const SLEEP_PHONE_FILL = "rgba(201, 176, 122, 0.42)";
const SLEEP_PC_FILL = "rgba(138, 175, 189, 0.42)";
const SLEEP_WAKE_MARK = "rgba(198, 40, 40, 0.85)";

function paintSleepActivityStrip(rep: SleepGuessReport) {
  const canvas = $("dash-sleep-strip") as HTMLCanvasElement | null;
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 600;
  const cssH = 56;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  const chrome = getComputedStyle(document.documentElement);
  ctx.fillStyle = chrome.getPropertyValue("--panel").trim() || "#f4f2ee";
  ctx.fillRect(0, 0, cssW, cssH);
  const pad = 8;
  const trackW = Math.max(1, cssW - pad * 2);
  const phoneY = 10;
  const pcY = 28;
  const h = 12;
  ctx.fillStyle = chrome.getPropertyValue("--line").trim() || "#ddd8d0";
  ctx.globalAlpha = 0.55;
  ctx.fillRect(pad, phoneY, trackW, h);
  ctx.fillRect(pad, pcY, trackW, h);
  ctx.globalAlpha = 1;
  const t0 = rep.activity_t0;
  const t1 = Math.max(t0 + 1, rep.activity_t1);
  const span = t1 - t0;
  const bin = Math.max(1, rep.activity_bin_ms || 300_000);
  const n = Math.max(rep.pc_active?.length || 0, rep.phone_active?.length || 0);
  for (let i = 0; i < n; i++) {
    const a = t0 + i * bin;
    const b = Math.min(t1, a + bin);
    const x0 = pad + ((a - t0) / span) * trackW;
    const x1 = pad + ((b - t0) / span) * trackW;
    const w = Math.max(1, x1 - x0);
    if (rep.phone_active?.[i]) {
      ctx.fillStyle = SLEEP_PHONE_FILL;
      ctx.fillRect(x0, phoneY, w, h);
    }
    if (rep.pc_active?.[i]) {
      ctx.fillStyle = SLEEP_PC_FILL;
      ctx.fillRect(x0, pcY, w, h);
    }
  }
  ctx.fillStyle = chrome.getPropertyValue("--muted").trim() || "#888";
  ctx.font = '11px "Noto Sans SC", sans-serif';
  ctx.textBaseline = "middle";
  ctx.fillText("手机", 2, phoneY + h / 2);
  ctx.fillText("电脑", 2, pcY + h / 2);
  for (const d of rep.days || []) {
    if (d.wake_ts < t0 || d.wake_ts > t1) continue;
    const x = pad + ((d.wake_ts - t0) / span) * trackW;
    ctx.strokeStyle = SLEEP_WAKE_MARK;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    ctx.moveTo(x, 6);
    ctx.lineTo(x, cssH - 6);
    ctx.stroke();
  }
}

async function renderSleepGuess(opts?: { force?: boolean }) {
  const host = $("dash-sleep-body");
  if (!host) return;
  if (sleepInflight) return;
  if (!opts?.force && host.childElementCount > 0) return;
  sleepInflight = true;
  try {
    const [t0, t1] = defaultSleepRange();
    const rep = (await invoke("dashboard_sleep_guess", { t0, t1 })) as SleepGuessReport;
    paintSleepActivityStrip(rep);
    if (!rep.days.length) {
      host.innerHTML = rep.note
        ? `<p class="muted">${escapeHtml(rep.note)}</p>`
        : `<p class="muted">这段没有可猜测的起床记录（需凌晨键鼠空闲段 + 清晨活动）。</p>`;
      return;
    }
    const noteHtml = rep.note ? `<p class="muted">${escapeHtml(rep.note)}</p>` : "";
    const rows = rep.days
      .map((d) => {
        const day = new Date(d.day_start_ms);
        const wake = new Date(d.wake_ts);
        const dayStr = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
        const wakeStr = `${wake.getHours().toString().padStart(2, "0")}:${wake.getMinutes().toString().padStart(2, "0")}`;
        const apps =
          d.apps.length > 0
            ? d.apps.map((a) => `${escapeHtml(a.label)} ${formatDurationMs(a.duration_ms)}`).join(" → ")
            : "醒后 30 分钟无焦点段";
        return `<div class="live-row" style="flex-direction:column;align-items:flex-start;gap:4px;margin-bottom:12px">
          <strong>${escapeHtml(dayStr)} · ${escapeHtml(d.mode)} · 猜测起床 ${wakeStr}</strong>
          <span class="live-sum">${apps}</span>
        </div>`;
      })
      .join("");
    host.innerHTML = noteHtml + rows;
  } catch (e) {
    host.innerHTML = `<p class="muted">${escapeHtml(String(e))}</p>`;
  } finally {
    sleepInflight = false;
  }
}

async function renderStatusCharts(opts?: { force?: boolean }) {
  const host = $("dash-live-body");
  if (!host) return;
  if (statusInflight) return;
  if (!opts?.force && host.querySelector("#dash-status-wan")) {
    try {
      const report = await fetchStatusCharts(30);
      paintStatusCharts(host, report);
    } catch {
      /* keep last paint */
    }
    return;
  }
  statusInflight = true;
  try {
    const report = await fetchStatusCharts(30);
    host.innerHTML = buildStatusChartsHtml(report);
    requestAnimationFrame(() => paintStatusCharts(host, report));
  } catch (e) {
    host.innerHTML = `<p class="muted">${escapeHtml(String(e))}</p>`;
  } finally {
    statusInflight = false;
  }
}

function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatCount(n: number) {
  return Math.round(n).toLocaleString("zh-CN");
}

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function saveStoredViewPrefs() {
  setPlaybackPrefs({ timelineZoomPct: altZoomStepPct });
}

function syncTickLodInputs() {
  const zoomEl = $("alt-zoom-pct") as HTMLInputElement | null;
  if (zoomEl && document.activeElement !== zoomEl) {
    zoomEl.value = String(altZoomStepPct);
  }
}

function bindTickLodPanel() {
  altZoomStepPct = getPlaybackPrefs().timelineZoomPct;

  const apply = () => {
    const zoomEl = $("alt-zoom-pct") as HTMLInputElement | null;
    const z = Number(zoomEl?.value);
    if (Number.isFinite(z)) {
      altZoomStepPct = Math.max(1, Math.min(50, Math.round(z)));
    }
    syncTickLodInputs();
    saveStoredViewPrefs();
  };
  const el = $("alt-zoom-pct");
  el?.addEventListener("change", apply);
  el?.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key === "Enter") {
      (e.target as HTMLElement).blur();
      apply();
    }
  });
  window.addEventListener(PLAYBACK_PREFS_EVENT, () => {
    altZoomStepPct = getPlaybackPrefs().timelineZoomPct;
    syncTickLodInputs();
  });
  syncTickLodInputs();
}

function requestOpenAbout(anchor?: string) {
  document.dispatchEvent(
    new CustomEvent("omni:open-about", { detail: { anchor } })
  );
}

export function initDashboard() {
  document.querySelectorAll("#dash-tabs button[data-dash]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const panel = (btn as HTMLElement).dataset.dash;
      if (panel) switchDashPanel(panel);
    });
  });
  $("page-dashboard")?.addEventListener("click", (e) => {
    const t = (e.target as HTMLElement | null)?.closest("[data-open-about]");
    if (!t) return;
    e.preventDefault();
    requestOpenAbout((t as HTMLElement).dataset.aboutAnchor);
  });
  const toggleLanes = $("btn-toggle-lanes");
  toggleLanes?.addEventListener("click", () => {
    lanesCollapsed = !lanesCollapsed;
    toggleLanes.classList.toggle("active", lanesCollapsed);
    toggleLanes.textContent = lanesCollapsed ? "展开程序轴" : "收起程序轴";
    invalidatePlotStrip();
    if (healthReportCache) redrawHealthFromCache();
  });
  bindTickLodPanel();
  moveDashPill();
  window.setTimeout(() => {
    if (healthReportCache) return;
    void invoke<HealthReport | null>("dashboard_health_snapshot")
      .then((snap) => {
        if (snap && !healthReportCache) healthReportCache = snap;
      })
      .catch(() => {});
  }, 0);
  window.addEventListener("resize", () => {
    moveDashPill();
    if (dashPanel === "health") {
      if (healthReportCache) {
        redrawHealthFromCache();
        scheduleHistRefresh();
      } else void renderHealth({ force: true });
    }
    if (dashPanel === "stats") void renderStats({ force: false });
    if (dashPanel === "live") {
      const host = $("dash-live-body");
      if (host?.querySelector("#dash-status-wan")) {
        void renderStatusCharts();
      }
    }
  });
  window.addEventListener("omnitrace-data-root", () => {
    if (dashPanel === "stats") void renderStats({ force: true });
  });
}

export function startDashboardPolling() {
  clearPollingTimersOnly();
  healthTimer = window.setInterval(() => {
    if (!$("page-dashboard")?.classList.contains("active")) return;
    if (dashPanel === "health") void renderHealth();
  }, HEALTH_POLL_MS);
  slowTimer = window.setInterval(() => {
    if (!$("page-dashboard")?.classList.contains("active")) return;
    if (dashPanel === "stats") void refreshDashPanel();
    if (dashPanel === "health") {
      const span = Math.max(1, viewEndTs - viewStartTs);
      // 大跨度不靠定时器猛刷；近一周才跟采集增量
      if (span <= 7 * DAY_MS) void refreshInputHist();
    }
  }, SLOW_POLL_MS);
  statusTimer = window.setInterval(() => {
    if (!$("page-dashboard")?.classList.contains("active")) return;
    if (dashPanel === "live") void renderStatusCharts();
  }, STATUS_POLL_MS);
  window.setTimeout(() => {
    if (!$("page-dashboard")?.classList.contains("active")) return;
    if (dashPanel !== "stats") return;
    void runHeavyIpc("dashboard_stats_prefetch", () =>
      invoke("dashboard_stats", {
        includeActiveFocus: loadShowActiveFocus(),
        forceRefresh: false,
      })
    ).catch(() => {});
  }, 2000);
}

export function stopDashboardPolling() {
  healthAbortGen++;
  if (healthDebounceTimer != null) {
    window.clearTimeout(healthDebounceTimer);
    healthDebounceTimer = null;
  }
  setHealthLoading(false);
  clearPollingTimersOnly();
  stopInertia();
}
