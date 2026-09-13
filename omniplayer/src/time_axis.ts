/**
 * 日历尺子刻度：秒/分/时/日/月/年各自进位，大/中/小三档。
 * 用 Date 走格（1 号、整点落在日历边界），禁止 30 天毫秒网格。
 */

const DAY_MS = 86_400_000;
const MONTH_MS = 30.4375 * DAY_MS;
const YEAR_MS = 365.25 * DAY_MS;

const MINOR_MIN_PX = 6;
const MINOR_MAX_PX = 14;
const MID_LABEL_PX = 48;
const MAJOR_MIN_PX = 72;
const MAX_TICKS = 450;

type TickRank = "major" | "mid" | "minor";

type TimeTick = {
  ts: number;
  /** 空字符串 = 只画线不写字 */
  label: string;
  /** 等同 rank === "major"；绘图请用 rank */
  major: boolean;
  rank: TickRank;
};

type Unit = "sec" | "min" | "hour" | "day" | "month" | "year";

type Regime = { unit: Unit; step: number };

const RANK_W: Record<TickRank, number> = { minor: 1, mid: 2, major: 3 };

const CANDIDATES: Regime[] = [
  { unit: "sec", step: 1 },
  { unit: "sec", step: 2 },
  { unit: "sec", step: 5 },
  { unit: "sec", step: 10 },
  { unit: "sec", step: 15 },
  { unit: "sec", step: 30 },
  { unit: "min", step: 1 },
  { unit: "min", step: 2 },
  { unit: "min", step: 5 },
  { unit: "min", step: 10 },
  { unit: "min", step: 15 },
  { unit: "min", step: 30 },
  { unit: "hour", step: 1 },
  { unit: "hour", step: 2 },
  { unit: "hour", step: 3 },
  { unit: "hour", step: 4 },
  { unit: "hour", step: 6 },
  { unit: "hour", step: 12 },
  { unit: "day", step: 1 },
  { unit: "month", step: 1 },
  { unit: "month", step: 2 },
  { unit: "month", step: 3 },
  { unit: "month", step: 6 },
  { unit: "year", step: 1 },
  { unit: "year", step: 2 },
  { unit: "year", step: 5 },
  { unit: "year", step: 10 },
];

function pad2(n: number) {
  return n.toString().padStart(2, "0");
}

function yy(d: Date) {
  return String(d.getFullYear()).slice(-2);
}

function estMs(unit: Unit, step: number): number {
  if (unit === "sec") return step * 1000;
  if (unit === "min") return step * 60_000;
  if (unit === "hour") return step * 3_600_000;
  if (unit === "day") return step * DAY_MS;
  if (unit === "month") return step * MONTH_MS;
  return step * YEAR_MS;
}

function pickRegime(spanMs: number, plotW: number): Regime {
  const pxPerMs = Math.max(1, plotW) / Math.max(1, spanMs);
  for (const c of CANDIDATES) {
    if (estMs(c.unit, c.step) * pxPerMs >= MAJOR_MIN_PX) return c;
  }
  return CANDIDATES[CANDIDATES.length - 1];
}

function pickStepMs(pxPerMs: number, steps: number[]): number | null {
  const rows = steps.map((ms) => ({ ms, px: ms * pxPerMs }));
  const inBand = rows.filter((r) => r.px >= MINOR_MIN_PX && r.px <= MINOR_MAX_PX);
  if (inBand.length) return inBand[0].ms;
  const ge = rows.filter((r) => r.px >= MINOR_MIN_PX);
  return ge.length ? ge[0].ms : null;
}

function tooMany(stepMs: number, spanMs: number): boolean {
  return spanMs / Math.max(1, stepMs) > MAX_TICKS;
}

function put(map: Map<number, TickRank>, ts: number, rank: TickRank) {
  const prev = map.get(ts);
  if (!prev || RANK_W[rank] > RANK_W[prev]) map.set(ts, rank);
}

function walkRange(
  t0: number,
  t1: number,
  floor: (ts: number) => Date,
  next: (d: Date) => Date
): number[] {
  let d = floor(t0);
  if (d.getTime() < t0) d = next(d);
  const out: number[] = [];
  let guard = 0;
  while (d.getTime() <= t1 && guard++ < 2500) {
    const ts = d.getTime();
    if (ts >= t0 && ts <= t1) out.push(ts);
    const n = next(d);
    if (n.getTime() <= d.getTime()) break;
    d = n;
  }
  return out;
}

function floorSec(ts: number, step: number): Date {
  const d = new Date(ts);
  d.setMilliseconds(0);
  d.setSeconds(d.getSeconds() - (d.getSeconds() % step));
  return d;
}

function floorMin(ts: number, step: number): Date {
  const d = new Date(ts);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() - (d.getMinutes() % step));
  return d;
}

function floorHour(ts: number, step: number): Date {
  const d = new Date(ts);
  d.setMinutes(0, 0, 0);
  d.setHours(d.getHours() - (d.getHours() % step));
  return d;
}

function floorDay(ts: number): Date {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d;
}

function floorMonth(ts: number, step: number): Date {
  const d = new Date(ts);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  d.setMonth(d.getMonth() - (d.getMonth() % step));
  return d;
}

function floorYear(ts: number, step: number): Date {
  const d = new Date(ts);
  d.setMonth(0, 1);
  d.setHours(0, 0, 0, 0);
  const y = d.getFullYear();
  d.setFullYear(y - (y % step));
  return d;
}

function collectSecs(t0: number, t1: number, step: number): number[] {
  return walkRange(
    t0,
    t1,
    (ts) => floorSec(ts, step),
    (d) => {
      const n = new Date(d.getTime());
      n.setSeconds(n.getSeconds() + step);
      return n;
    }
  );
}

function collectMins(t0: number, t1: number, step: number): number[] {
  return walkRange(
    t0,
    t1,
    (ts) => floorMin(ts, step),
    (d) => {
      const n = new Date(d.getTime());
      n.setMinutes(n.getMinutes() + step);
      return n;
    }
  );
}

function collectHours(t0: number, t1: number, step: number): number[] {
  return walkRange(
    t0,
    t1,
    (ts) => floorHour(ts, step),
    (d) => {
      const n = new Date(d.getTime());
      n.setHours(n.getHours() + step);
      return n;
    }
  );
}

function collectDays(t0: number, t1: number): number[] {
  return walkRange(t0, t1, floorDay, (d) => {
    const n = new Date(d.getTime());
    n.setDate(n.getDate() + 1);
    return n;
  });
}

function collectMonths(t0: number, t1: number, step: number): number[] {
  return walkRange(
    t0,
    t1,
    (ts) => floorMonth(ts, step),
    (d) => {
      const n = new Date(d.getTime());
      n.setMonth(n.getMonth() + step);
      return n;
    }
  );
}

function collectYears(t0: number, t1: number, step: number): number[] {
  return walkRange(
    t0,
    t1,
    (ts) => floorYear(ts, step),
    (d) => {
      const n = new Date(d.getTime());
      n.setFullYear(n.getFullYear() + step);
      return n;
    }
  );
}

function collectFifteenths(t0: number, t1: number): number[] {
  const start = floorMonth(t0, 1);
  const out: number[] = [];
  let d = new Date(start.getTime());
  d.setDate(15);
  let guard = 0;
  while (d.getTime() <= t1 && guard++ < 2500) {
    const ts = d.getTime();
    if (ts >= t0 && ts <= t1 && d.getDate() === 15) out.push(ts);
    d.setMonth(d.getMonth() + 1, 15);
    d.setHours(0, 0, 0, 0);
  }
  return out;
}

function collectJulFirsts(t0: number, t1: number): number[] {
  const y0 = new Date(t0).getFullYear() - 1;
  const out: number[] = [];
  for (let y = y0; y <= new Date(t1).getFullYear() + 1; y++) {
    const ts = new Date(y, 6, 1, 0, 0, 0, 0).getTime();
    if (ts >= t0 && ts <= t1) out.push(ts);
  }
  return out;
}

function addAll(map: Map<number, TickRank>, tsList: number[], rank: TickRank) {
  for (const ts of tsList) put(map, ts, rank);
}

function fillMarks(
  t0: number,
  t1: number,
  regime: Regime,
  pxPerMs: number
): Map<number, TickRank> {
  const map = new Map<number, TickRank>();
  const span = Math.max(1, t1 - t0);
  const { unit, step } = regime;

  if (unit === "year") {
    addAll(map, collectYears(t0, t1, step), "major");
    if (step === 1) addAll(map, collectJulFirsts(t0, t1), "mid");
    else addAll(map, collectYears(t0, t1, 1), "mid");
    const monthMs = pickStepMs(pxPerMs, [MONTH_MS, 3 * MONTH_MS, 6 * MONTH_MS]);
    if (monthMs && !tooMany(monthMs, span)) {
      const mStep = Math.max(1, Math.round(monthMs / MONTH_MS));
      addAll(map, collectMonths(t0, t1, mStep), "minor");
    }
    return map;
  }

  if (unit === "month") {
    addAll(map, collectMonths(t0, t1, step), "major");
    if (step === 1) addAll(map, collectFifteenths(t0, t1), "mid");
    else addAll(map, collectMonths(t0, t1, 1), "mid");
    if (DAY_MS * pxPerMs >= MINOR_MIN_PX && !tooMany(DAY_MS, span)) {
      addAll(map, collectDays(t0, t1), "minor");
    }
    return map;
  }

  if (unit === "day") {
    addAll(map, collectDays(t0, t1), "major");
    const halfDay = 12 * 3_600_000;
    if (halfDay * pxPerMs >= MINOR_MIN_PX && !tooMany(halfDay, span)) {
      addAll(map, collectHours(t0, t1, 12), "mid");
    }
    const hourMs = pickStepMs(pxPerMs, [
      3_600_000, 2 * 3_600_000, 3 * 3_600_000, 4 * 3_600_000, 6 * 3_600_000,
      12 * 3_600_000,
    ]);
    if (hourMs && !tooMany(hourMs, span)) {
      addAll(map, collectHours(t0, t1, Math.max(1, Math.round(hourMs / 3_600_000))), "minor");
    }
    return map;
  }

  if (unit === "hour") {
    addAll(map, collectHours(t0, t1, step), "major");
    if (step % 2 === 0) {
      const half = step / 2;
      if (half * 3_600_000 * pxPerMs >= MINOR_MIN_PX) {
        addAll(map, collectHours(t0, t1, half), "mid");
      }
    } else if (step === 1) {
      const halfH = 1_800_000;
      if (halfH * pxPerMs >= MINOR_MIN_PX && !tooMany(halfH, span)) {
        addAll(map, collectMins(t0, t1, 30), "mid");
      }
    }
    const minMs = pickStepMs(pxPerMs, [
      60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000,
    ]);
    if (minMs && !tooMany(minMs, span)) {
      addAll(map, collectMins(t0, t1, Math.max(1, Math.round(minMs / 60_000))), "minor");
    }
    return map;
  }

  if (unit === "min") {
    addAll(map, collectMins(t0, t1, step), "major");
    if (step % 2 === 0) {
      const half = step / 2;
      if (half * 60_000 * pxPerMs >= MINOR_MIN_PX) {
        addAll(map, collectMins(t0, t1, half), "mid");
      }
    } else if (step === 1) {
      const halfM = 30_000;
      if (halfM * pxPerMs >= MINOR_MIN_PX && !tooMany(halfM, span)) {
        addAll(map, collectSecs(t0, t1, 30), "mid");
      }
    }
    const secMs = pickStepMs(pxPerMs, [1000, 2000, 5000, 10_000, 15_000, 30_000]);
    if (secMs && !tooMany(secMs, span)) {
      addAll(map, collectSecs(t0, t1, Math.max(1, Math.round(secMs / 1000))), "minor");
    }
    return map;
  }

  addAll(map, collectSecs(t0, t1, step), "major");
  if (step % 2 === 0) {
    const half = step / 2;
    if (half * 1000 * pxPerMs >= MINOR_MIN_PX) {
      addAll(map, collectSecs(t0, t1, half), "mid");
    }
  }
  if (step > 1 && 1000 * pxPerMs >= MINOR_MIN_PX && !tooMany(1000, span)) {
    addAll(map, collectSecs(t0, t1, 1), "minor");
  }
  return map;
}

function isMidnight(d: Date) {
  return (
    d.getHours() === 0 &&
    d.getMinutes() === 0 &&
    d.getSeconds() === 0 &&
    d.getMilliseconds() === 0
  );
}

function isMonthStart(d: Date) {
  return d.getDate() === 1 && isMidnight(d);
}

function isYearStart(d: Date) {
  return d.getMonth() === 0 && isMonthStart(d);
}

function formatMajor(d: Date, unit: Unit, prev: Date | null, first: boolean): string {
  const newYear = first || !prev || prev.getFullYear() !== d.getFullYear();
  const newMonth = newYear || prev!.getMonth() !== d.getMonth();
  const newDay = newMonth || prev!.getDate() !== d.getDate();
  const newHour = newDay || prev!.getHours() !== d.getHours();
  const newMin = newHour || prev!.getMinutes() !== d.getMinutes();

  if (unit === "year") return `${d.getFullYear()}`;

  if (unit === "month") {
    return newYear ? `${d.getFullYear()}/${d.getMonth() + 1}` : `${d.getMonth() + 1}月`;
  }

  if (unit === "day") {
    if (newYear) return `${yy(d)}/${d.getMonth() + 1}/${d.getDate()}`;
    if (newMonth) return `${d.getMonth() + 1}/${d.getDate()}`;
    return `${d.getDate()}`;
  }

  if (unit === "hour") {
    if (isMidnight(d)) {
      if (newYear) return `${yy(d)}/${d.getMonth() + 1}/${d.getDate()}`;
      return `${d.getMonth() + 1}/${d.getDate()}`;
    }
    return `${pad2(d.getHours())}:00`;
  }

  if (unit === "min") {
    if (newHour || d.getMinutes() === 0) {
      return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    }
    if (newMin) return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    return `:${pad2(d.getMinutes())}`;
  }

  if (newMin || d.getSeconds() === 0) {
    return `${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  }
  return pad2(d.getSeconds());
}

function formatMid(d: Date, unit: Unit, majorPx: number): string {
  if (unit === "month" && d.getDate() === 15) return "15";
  if (unit === "year" && d.getMonth() === 6 && d.getDate() === 1) {
    return majorPx >= MID_LABEL_PX * 2 ? "7月" : "";
  }
  if (unit === "year" && isYearStart(d)) return "";
  if (unit === "month" && isMonthStart(d)) return "";
  if (unit === "day" && d.getHours() === 12 && d.getMinutes() === 0) {
    return "12:00";
  }
  if (unit === "hour" && d.getMinutes() === 30) return ":30";
  if (unit === "hour") return `${pad2(d.getHours())}:00`;
  if (unit === "min" && d.getSeconds() === 30) return ":30";
  if (unit === "min") return `:${pad2(d.getMinutes())}`;
  if (unit === "sec") return pad2(d.getSeconds());
  return "";
}

function assignLabels(
  ranks: Map<number, TickRank>,
  unit: Unit,
  majorPx: number
): TimeTick[] {
  const times = [...ranks.keys()].sort((a, b) => a - b);
  const ticks: TimeTick[] = times.map((ts) => ({
    ts,
    label: "",
    major: ranks.get(ts) === "major",
    rank: ranks.get(ts)!,
  }));

  let prevMajor: Date | null = null;
  let firstMajor = true;
  for (const t of ticks) {
    if (t.rank !== "major") continue;
    const d = new Date(t.ts);
    t.label = formatMajor(d, unit, prevMajor, firstMajor);
    prevMajor = d;
    firstMajor = false;
  }

  for (const t of ticks) {
    if (t.rank !== "mid") continue;
    t.label = formatMid(new Date(t.ts), unit, majorPx);
  }
  return ticks;
}

/** 13px 无衬线：汉字≈13、数字/符号≈7.2（略保守，宁疏勿叠） */
function estimateTickLabelWidth(label: string): number {
  let w = 0;
  for (const ch of label) {
    w += ch.charCodeAt(0) > 0x2ff ? 13 : 7.2;
  }
  return w + 10;
}

function sparsifyTickLabels(
  ticks: TimeTick[],
  t0: number,
  t1: number,
  plotCssW: number
) {
  const span = Math.max(1, t1 - t0);
  const w = Math.max(1, plotCssW);
  const xOf = (ts: number) => ((ts - t0) / span) * w;
  const pad = 12;
  const boxes: { l: number; r: number }[] = [];
  const collides = (l: number, r: number) =>
    boxes.some((b) => l < b.r + pad && r > b.l - pad);

  const place = (pred: (t: TimeTick) => boolean) => {
    for (const t of ticks) {
      if (!t.label || !pred(t)) continue;
      const x = xOf(t.ts);
      const hw = estimateTickLabelWidth(t.label) / 2;
      const l = x - hw;
      const r = x + hw;
      if (t.rank !== "major" && (x < 10 || x > w - 10)) {
        t.label = "";
        continue;
      }
      if (x < -hw || x > w + hw || collides(l, r)) {
        t.label = "";
        continue;
      }
      boxes.push({ l, r });
    }
  };
  place((t) => t.rank === "major");
  place((t) => t.rank === "mid");
}

/**
 * 生成尺子刻度：大格日历对齐；中档（如月中 15）；小格够像素才画。
 */
function buildTimeTicks(t0: number, t1: number, plotCssW: number): TimeTick[] {
  const span = Math.max(1, t1 - t0);
  const w = Math.max(1, plotCssW);
  const pxPerMs = w / span;
  const regime = pickRegime(span, w);
  const ranks = fillMarks(t0, t1, regime, pxPerMs);
  const ticks = assignLabels(ranks, regime.unit, estMs(regime.unit, regime.step) * pxPerMs);
  sparsifyTickLabels(ticks, t0, t1, w);
  return ticks;
}

/** 绘制时按 measureText 再避让一层（中心距不够会叠字） */
function tickLabelCursor(padding = 10) {
  let lastRight = -1e9;
  const take = (x: number, width: number): boolean => {
    const left = x - width / 2;
    const right = x + width / 2;
    if (left < lastRight + padding) return false;
    lastRight = right;
    return true;
  };
  return { take: take };
}

/** @deprecated 用 tickLabelCursor + measureText；保留免旧调用炸掉 */
function tickLabelMinGap(label: string, baseGap = 34): number {
  return estimateTickLabelWidth(label) + (baseGap > 40 ? 8 : 0);
}

/** 调试/旁注用 */
function tickLodDebug(spanMs: number, plotCssW: number) {
  const regime = pickRegime(spanMs, plotCssW);
  const px = (estMs(regime.unit, regime.step) / Math.max(1, spanMs)) * Math.max(1, plotCssW);
  return {
    unit: regime.unit,
    majorStep: regime.step,
    majorPx: px,
  };
}

export type { TimeTick, TickRank };
export {
  buildTimeTicks,
  tickLabelCursor,
  estimateTickLabelWidth,
  tickLabelMinGap,
  tickLodDebug,
};
