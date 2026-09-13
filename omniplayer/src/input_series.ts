/**
 * 键鼠活跃曲线：日瓦片（1 秒计数，来自永久 .otih）+ 相机式投影。
 * 采样：每 CSS 列至多一个 max；只折线，不贝塞尔。
 * 解码：Worker 里 atob + mipmap，主线程惯性期间不跟瓦片回调整轴重绘。
 */
import { invoke } from "@tauri-apps/api/core";
import { runHeavyIpc } from "./heavy_ipc";
import { pickSeriesStepMs } from "./lod_band";
import { decodeDaySeriesB64 } from "./series_decode";

export type DaySeriesTile = {
  date: string;
  dayStartMs: number;
  secs: number;
  mouse: Uint32Array;
  key: Uint32Array;
  mousePeak: number;
  keyPeak: number;
  mouseMips: Uint32Array[];
  keyMips: Uint32Array[];
};

/** [lo, hi) 区间 max；短窗走线性，长窗走二分金字塔 */
function mipsRangeMax(levels: Uint32Array[], lo: number, hi: number): number {
  const src = levels[0];
  if (lo < 0) lo = 0;
  if (hi > src.length) hi = src.length;
  if (lo >= hi) return 0;
  const span = hi - lo;
  if (span <= 32) {
    let m = 0;
    for (let s = lo; s < hi; s++) {
      const v = src[s];
      if (v > m) m = v;
    }
    return m;
  }
  let max = 0;
  let i = lo;
  while (i < hi) {
    let lvl = 0;
    let step = 1;
    while (
      lvl + 1 < levels.length &&
      (i & ((step << 1) - 1)) === 0 &&
      i + (step << 1) <= hi
    ) {
      lvl++;
      step <<= 1;
    }
    const v = levels[lvl][i >> lvl];
    if (v > max) max = v;
    i += step;
  }
  return max;
}

const DAY_MS = 86_400_000;
/** 瓦片 IPC 不扫 2000 年以前的日历日（避免 viewStart=0 时误拉 1969 等） */
export const MIN_SERIES_TILE_MS = Date.UTC(2000, 0, 1);
/** 近景用瓦片；更宽仍用旧直方图 */
export const SERIES_TILE_SPAN_MAX = 7 * DAY_MS;

const tileCache = new Map<string, DaySeriesTile>();
const inflight = new Map<string, Promise<DaySeriesTile | null>>();

let onTileLoadedCb: (() => void) | null = null;
export function setTileLoadedCallback(cb: (() => void) | null) {
  onTileLoadedCb = cb;
}

/** 纵轴粘性峰值：平移不改山峰相对高度 */
let stickyMousePeak = 1;
let stickyKeyPeak = 1;

export function resetSeriesStickyPeaks() {
  stickyMousePeak = 1;
  stickyKeyPeak = 1;
}

function dateKeyFromTs(ts: number): string {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function datesTouchingRange(t0: number, t1: number): string[] {
  if (!Number.isFinite(t0) || !Number.isFinite(t1)) return [];
  const lo = Math.max(Math.min(t0, t1), MIN_SERIES_TILE_MS);
  const hi = Math.max(lo, Math.max(t0, t1));
  if (hi < MIN_SERIES_TILE_MS) return [];
  const out: string[] = [];
  let cur = new Date(lo);
  cur.setHours(0, 0, 0, 0);
  const end = new Date(hi);
  end.setHours(0, 0, 0, 0);
  for (let i = 0; i < 40; i++) {
    out.push(dateKeyFromTs(cur.getTime()));
    if (cur.getTime() >= end.getTime()) break;
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

type DecodeOk = {
  mouse: Uint32Array;
  key: Uint32Array;
  mouseMips: Uint32Array[];
  keyMips: Uint32Array[];
};

let tileWorker: Worker | null = null;
let tileWorkerFailed = false;
let decodeSeq = 0;
const decodeWait = new Map<
  number,
  { resolve: (v: DecodeOk) => void; reject: (e: unknown) => void }
>();

function attachWorker(w: Worker) {
  w.onmessage = (ev: MessageEvent) => {
    const msg = ev.data as {
      id: number;
      mouse: ArrayBuffer;
      key: ArrayBuffer;
      mouseMipRest: ArrayBuffer[];
      keyMipRest: ArrayBuffer[];
    };
    const p = decodeWait.get(msg.id);
    if (!p) return;
    decodeWait.delete(msg.id);
    const mouse = new Uint32Array(msg.mouse);
    const key = new Uint32Array(msg.key);
    p.resolve({
      mouse,
      key,
      mouseMips: [mouse, ...msg.mouseMipRest.map((b) => new Uint32Array(b))],
      keyMips: [key, ...msg.keyMipRest.map((b) => new Uint32Array(b))],
    });
  };
  w.onerror = () => {
    tileWorkerFailed = true;
  };
}

function getTileWorker(): Worker | null {
  if (tileWorkerFailed) return null;
  if (tileWorker) return tileWorker;
  try {
    tileWorker = new Worker(
      new URL("./series_tile_worker.ts", import.meta.url),
      { type: "module" }
    );
    attachWorker(tileWorker);
    return tileWorker;
  } catch {
    tileWorkerFailed = true;
    tileWorker = null;
    return null;
  }
}

function decodeDaySeries(
  mouseB64: string,
  keyB64: string,
  secs: number
): Promise<DecodeOk> {
  const w = getTileWorker();
  if (!w) {
    return Promise.resolve(decodeDaySeriesB64(mouseB64, keyB64, secs));
  }
  const id = ++decodeSeq;
  return new Promise((resolve) => {
    decodeWait.set(id, { resolve, reject: () => resolve(decodeDaySeriesB64(mouseB64, keyB64, secs)) });
    try {
      w.postMessage({ id, secs, mouse_b64: mouseB64, key_b64: keyB64 });
    } catch (e) {
      decodeWait.delete(id);
      resolve(decodeDaySeriesB64(mouseB64, keyB64, secs));
    }
  });
}

async function fetchDayTile(
  date: string,
  opts?: { playerScope?: boolean }
): Promise<DaySeriesTile | null> {
  const hit = tileCache.get(date);
  if (hit) return hit;
  let p = inflight.get(date);
  if (!p) {
    p = (async () => {
      try {
        const raw = await runHeavyIpc(
          `day_series:${date}`,
          () =>
            invoke<{
              date: string;
              day_start_ms: number;
              secs: number;
              mouse_b64: string;
              key_b64: string;
              mouse_peak: number;
              key_peak: number;
            }>("dashboard_input_day_series", { date }),
          { playerScope: opts?.playerScope }
        );
        const secs = Math.max(1, Number(raw.secs) || 86400);
        const decoded = await decodeDaySeries(
          raw.mouse_b64,
          raw.key_b64,
          secs
        );
        const tile: DaySeriesTile = {
          date: raw.date || date,
          dayStartMs: Number(raw.day_start_ms) || 0,
          secs,
          mouse: decoded.mouse,
          key: decoded.key,
          mousePeak: Number(raw.mouse_peak) || 0,
          keyPeak: Number(raw.key_peak) || 0,
          mouseMips: decoded.mouseMips,
          keyMips: decoded.keyMips,
        };
        const isNew = !tileCache.has(tile.date);
        tileCache.set(tile.date, tile);
        stickyMousePeak = Math.max(stickyMousePeak, tile.mousePeak, 1);
        stickyKeyPeak = Math.max(stickyKeyPeak, tile.keyPeak, 1);
        if (isNew && onTileLoadedCb) {
          onTileLoadedCb();
        }
        return tile;
      } catch (e) {
        console.warn("[input series]", date, e);
        return null;
      } finally {
        inflight.delete(date);
      }
    })();
    inflight.set(date, p);
  }
  return p;
}

/** 只拉视窗碰到的日历日；邻日预取用 prefetchNeighborTiles */
export async function ensureSeriesTilesForRange(
  viewStart: number,
  viewEnd: number,
  opts?: { playerScope?: boolean }
): Promise<boolean> {
  const dates = datesTouchingRange(viewStart, viewEnd);
  let any = false;
  for (const d of dates) {
    const t = await fetchDayTile(d, { playerScope: opts?.playerScope });
    if (t) any = true;
  }
  return any;
}

/** 滑停后再补左右邻日，不堵平移 rAF */
export function prefetchNeighborTiles(
  viewStart: number,
  viewEnd: number,
  padDays = 1
): void {
  void ensureSeriesTilesForRange(
    viewStart - padDays * DAY_MS,
    viewEnd + padDays * DAY_MS
  );
}

export function seriesTilesReady(viewStart: number, viewEnd: number): boolean {
  return datesTouchingRange(viewStart, viewEnd).every((d) => tileCache.has(d));
}

/** @deprecated 跨度阈值已废；保留给远景旁注。折线请用 seriesStepForView */
export function seriesStepMs(spanMs: number): number {
  return pickSeriesStepMs(spanMs, 800);
}

/**
 * 折线采样步长：SERIES 2～5px 带；远景不低于 1 CSS 像素/点。
 */
export function seriesStepForView(spanMs: number, plotCssW: number): number {
  const band = pickSeriesStepMs(spanMs, plotCssW);
  const pxMs = spanMs / Math.max(1, plotCssW);
  return Math.max(band, pxMs);
}

export type SeriesPt = { ts: number; mouse: number; key: number };

/**
 * 从已缓存瓦片采样折线点。步长内取 max；点数不超过 plot 像素列。
 */
export function buildSeriesPoints(
  viewStart: number,
  viewEnd: number,
  stepMs: number,
  plotCssW = 800
): SeriesPt[] {
  const step = Math.max(1000, Math.floor(stepMs));
  const padSteps = 2;
  const t0 = Math.floor(viewStart / step) * step - padSteps * step;
  const t1 = Math.ceil(viewEnd) + padSteps * step;
  const pts: SeriesPt[] = [];
  const maxPts = Math.max(64, Math.min(4500, Math.ceil(plotCssW) + 4));
  const span = Math.max(1, t1 - t0);
  const strideSteps = Math.max(1, Math.ceil(span / step / maxPts));

  const activeTiles: DaySeriesTile[] = [];
  const dates = datesTouchingRange(t0, t1);
  for (let d = 0; d < dates.length; d++) {
    const tile = tileCache.get(dates[d]);
    if (tile && tile.dayStartMs) {
      activeTiles.push(tile);
    }
  }

  if (activeTiles.length === 0) {
    return pts;
  }

  for (let ts = t0, i = 0; ts <= t1; ts += step, i++) {
    if (i % strideSteps !== 0 && ts + step <= t1) continue;
    let mouse = 0;
    let key = 0;
    const segEnd = ts + step;

    for (let j = 0; j < activeTiles.length; j++) {
      const tile = activeTiles[j];
      const tileStart = tile.dayStartMs;
      const tileEnd = tileStart + tile.secs * 1000;
      if (segEnd <= tileStart || ts >= tileEnd) continue;

      const sSec = Math.max(0, Math.floor((ts - tileStart) / 1000));
      const eSec = Math.min(tile.secs, Math.ceil((segEnd - tileStart) / 1000));

      const mm = mipsRangeMax(tile.mouseMips, sSec, eSec);
      const kk = mipsRangeMax(tile.keyMips, sSec, eSec);
      if (mm > mouse) mouse = mm;
      if (kk > key) key = kk;
    }

    pts.push({ ts: ts + step / 2, mouse, key });
  }
  return pts;
}

export function seriesStickyPeaks(): { mouse: number; key: number } {
  return { mouse: stickyMousePeak, key: stickyKeyPeak };
}

/** 只折线，禁止二次贝塞尔 */
export function seriesDrawSmooth(_stepMs?: number): boolean {
  return false;
}

function strokeSeriesPath(
  ctx: CanvasRenderingContext2D,
  pts: { x: number; y: number }[]
) {
  if (pts.length < 1) return;
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
}

/**
 * 面积+描边。只折线（一列像素一个 max），不随密度改贝塞尔。
 */
export function drawSeriesArea(
  ctx: CanvasRenderingContext2D,
  pts: { x: number; y: number }[],
  baseY: number,
  fill: string,
  stroke: string,
  _smooth = false
) {
  if (pts.length < 1) return;

  ctx.beginPath();
  ctx.moveTo(pts[0].x, baseY);
  ctx.lineTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.lineTo(pts[pts.length - 1].x, baseY);
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.beginPath();
  strokeSeriesPath(ctx, pts);
  ctx.strokeStyle = stroke;
  ctx.lineWidth = 1.2;
  ctx.lineJoin = "miter";
  ctx.lineCap = "butt";
  ctx.stroke();
}

export const SERIES_MOUSE_FILL = "rgba(56, 168, 220, 0.42)";
export const SERIES_MOUSE_STROKE = "rgba(80, 190, 255, 0.95)";
export const SERIES_KEY_FILL = "rgba(255, 148, 72, 0.42)";
export const SERIES_KEY_STROKE = "rgba(255, 170, 90, 0.95)";
