/**
 * 像素带宽 → min/maxInterval → nice 选档。
 * 折线层级：固定 SERIES 2～5（不可被刻度面板改）。
 * 刻度层级：TICK 宽细固定 2～5（壳上不再暴露上下限）。
 */

/** 折线专用（固定） */
export const SERIES_PX_MIN = 2;
export const SERIES_PX_MAX = 5;

/** 焦点窗口条：最短绘制宽（上下限同 1，远缩时仍能看出断点间隙） */
export const LANE_PX_MIN = 1;
export const LANE_PX_MAX = 1;

/** 刻度默认 / 当前（可被 UI 改，不影响折线） */
export const TICK_PX_MIN_DEFAULT = 2;
export const TICK_PX_MAX_DEFAULT = 5;

let tickPxMin = TICK_PX_MIN_DEFAULT;
let tickPxMax = TICK_PX_MAX_DEFAULT;

/** @deprecated 折线请用 SERIES_*；刻度请用 getTickLodPrefs */
export const LOD_PX_MIN = SERIES_PX_MIN;
export const LOD_PX_MAX = SERIES_PX_MAX;

/** 最细层毫秒；日后亚秒可改为 500 */
export const LOD_BASE_MS = 1_000;

const DAY_MS = 86_400_000;

export const LOD_STEP_CANDIDATES_MS: number[] = [
  1_000, 2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000, 600_000,
  900_000, 1_800_000, 3_600_000, 2 * 3_600_000, 3 * 3_600_000, 4 * 3_600_000,
  6 * 3_600_000, 12 * 3_600_000, DAY_MS, 2 * DAY_MS, 7 * DAY_MS, 14 * DAY_MS,
  30 * DAY_MS, 90 * DAY_MS, 365 * DAY_MS, 2 * 365 * DAY_MS, 5 * 365 * DAY_MS,
  10 * 365 * DAY_MS,
];

export type TickLodPrefs = {
  pxMin: number;
  pxMax: number;
};

export function getTickLodPrefs(): TickLodPrefs {
  return { pxMin: tickPxMin, pxMax: tickPxMax };
}

function clampTickBand(min: number, max: number): { min: number; max: number } {
  let a = Math.max(1, Math.min(120, Math.round(min)));
  let b = Math.max(2, Math.min(200, Math.round(max)));
  if (b <= a) b = a + 1;
  return { min: a, max: b };
}

export function setTickLodPrefs(partial: Partial<TickLodPrefs>): TickLodPrefs {
  if (partial.pxMin != null || partial.pxMax != null) {
    const next = clampTickBand(
      partial.pxMin ?? tickPxMin,
      partial.pxMax ?? tickPxMax
    );
    tickPxMin = next.min;
    tickPxMax = next.max;
  }
  return getTickLodPrefs();
}

/**
 * 有字锚带宽：跟短刻度线脱钩。
 * D3 / Matplotlib MaxNLocator / uPlot：时间标签大约 80～160 CSS px，轴上大约 5～10 个字。
 */
export function tickLabelPxBand(): { pxMin: number; pxMax: number } {
  const pxMin = 80;
  const pxMax = 160;
  return { pxMin, pxMax };
}

export function lodPxPerStep(stepMs: number, spanMs: number, plotCssW: number): number {
  return (stepMs / Math.max(1, spanMs)) * Math.max(1, plotCssW);
}

export function pxBandToIntervalMs(
  spanMs: number,
  plotCssW: number,
  pxMin: number,
  pxMax: number
): { minInterval: number; maxInterval: number } {
  const span = Math.max(1, spanMs);
  const w = Math.max(1, plotCssW);
  return {
    minInterval: (pxMin * span) / w,
    maxInterval: (pxMax * span) / w,
  };
}

export type LodPickOpts = {
  baseMs?: number;
  pxMin?: number;
  pxMax?: number;
};

export function pickNiceStepInInterval(
  minInterval: number,
  maxInterval: number,
  baseMs: number,
  cands: number[] = LOD_STEP_CANDIDATES_MS
): number {
  const pool = cands.filter((s) => s >= baseMs);
  if (!pool.length) return baseMs;

  if (baseMs >= minInterval) return baseMs;

  let firstGeMin: number | null = null;
  for (const s of pool) {
    if (s < minInterval) continue;
    if (firstGeMin == null) firstGeMin = s;
    if (s <= maxInterval) return s;
  }
  if (firstGeMin != null) return firstGeMin;
  return pool[pool.length - 1];
}

export function pickLodStepMs(
  spanMs: number,
  plotCssW: number,
  opts: LodPickOpts = {}
): number {
  const baseMs = opts.baseMs ?? LOD_BASE_MS;
  const pxMin = opts.pxMin ?? SERIES_PX_MIN;
  const pxMax = opts.pxMax ?? SERIES_PX_MAX;
  const { minInterval, maxInterval } = pxBandToIntervalMs(
    spanMs,
    plotCssW,
    pxMin,
    pxMax
  );
  return pickNiceStepInInterval(minInterval, maxInterval, baseMs);
}

/** 折线采样：固定 SERIES 带，不受刻度面板影响 */
export function pickSeriesStepMs(spanMs: number, plotCssW: number): number {
  return pickLodStepMs(spanMs, plotCssW, {
    baseMs: LOD_BASE_MS,
    pxMin: SERIES_PX_MIN,
    pxMax: SERIES_PX_MAX,
  });
}

/** @deprecated 用 pickSeriesStepMs；保留别名免旧调用炸掉 */
export function pickMarkStepMs(spanMs: number, plotCssW: number): number {
  return pickSeriesStepMs(spanMs, plotCssW);
}

/** 无字刻度短线：时间轴已改用日历尺子，不再走本函数；保留以免旧调用炸掉 */
export function pickTickMarkStepMs(spanMs: number, plotCssW: number): number {
  return pickLodStepMs(spanMs, plotCssW, {
    baseMs: LOD_BASE_MS,
    pxMin: tickPxMin,
    pxMax: tickPxMax,
  });
}

/** 有字刻度：更疏，且为 tick mark 整数倍 */
export function pickTickLabelStepMs(spanMs: number, plotCssW: number): number {
  const mark = pickTickMarkStepMs(spanMs, plotCssW);
  const lab = tickLabelPxBand();
  let label = pickLodStepMs(spanMs, plotCssW, {
    baseMs: mark,
    pxMin: lab.pxMin,
    pxMax: lab.pxMax,
  });
  if (label < mark) label = mark;
  if (label === mark || label % mark === 0) return label;
  for (const s of LOD_STEP_CANDIDATES_MS) {
    if (s >= label && s % mark === 0) return s;
  }
  return Math.ceil(label / mark) * mark;
}

/** @deprecated 用 pickTickLabelStepMs */
export function pickLabelStepMs(spanMs: number, plotCssW: number): number {
  return pickTickLabelStepMs(spanMs, plotCssW);
}
