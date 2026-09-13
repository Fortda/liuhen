/**
 * 仪表盘滚动卡顿实验：不经人手滚轮，脚本直接改视窗参数并计量热路径。
 * 运行：node scripts/dash_scroll_bench.mjs
 * 报告：perf-bench-last.json（cwd=omniplayer）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "perf-bench-last.json");

const DAY_MS = 86_400_000;
const SECS = 86_400;

function dateKeyFromTs(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function makeTile(dayStartMs) {
  const mouse = new Uint32Array(SECS);
  const key = new Uint32Array(SECS);
  let mousePeak = 1;
  let keyPeak = 1;
  // 模拟白天活跃：约 8h 有脉冲
  for (let s = 8 * 3600; s < 22 * 3600; s++) {
    if (s % 3 === 0) {
      const m = 200 + (s % 50) * 40;
      mouse[s] = m;
      if (m > mousePeak) mousePeak = m;
    }
    if (s % 7 === 0) {
      const k = 10 + (s % 20);
      key[s] = k;
      if (k > keyPeak) keyPeak = k;
    }
  }
  return {
    date: dateKeyFromTs(dayStartMs),
    dayStartMs,
    secs: SECS,
    mouse,
    key,
    mousePeak,
    keyPeak,
  };
}

function buildSeriesPointsProd(tileCache, viewStart, viewEnd, stepMs) {
  const step = Math.max(1000, Math.floor(stepMs));
  const padSteps = 2;
  const t0 = Math.floor(viewStart / step) * step - padSteps * step;
  const t1 = Math.ceil(viewEnd) + padSteps * step;
  const pts = [];
  const maxPts = 4500;
  const span = Math.max(1, t1 - t0);
  const strideSteps = Math.max(1, Math.ceil(span / step / maxPts));

  const activeTiles = [];
  let cur = new Date(t0);
  cur.setHours(0, 0, 0, 0);
  const end = new Date(t1);
  end.setHours(0, 0, 0, 0);
  for (let i = 0; i < 40; i++) {
    const k = dateKeyFromTs(cur.getTime());
    const tile = tileCache.get(k);
    if (tile && tile.dayStartMs) activeTiles.push(tile);
    if (cur.getTime() >= end.getTime()) break;
    cur.setDate(cur.getDate() + 1);
  }

  if (activeTiles.length === 0) return pts;

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

      const mArr = tile.mouse;
      const kArr = tile.key;
      for (let s = sSec; s < eSec; s++) {
        if (mArr[s] > mouse) mouse = mArr[s];
        if (kArr[s] > key) key = kArr[s];
      }
    }
    pts.push({ ts: ts + step / 2, mouse, key });
  }
  return pts;
}

/** 对照：热环不 new Date，用 dayStart 推秒 */
function buildSeriesPointsNoDate(tile, viewStart, viewEnd, stepMs) {
  const step = Math.max(1000, Math.floor(stepMs));
  const t0 = Math.floor(viewStart / step) * step;
  const t1 = Math.ceil(viewEnd);
  const pts = [];
  const maxPts = 4500;
  const span = Math.max(1, t1 - t0);
  const strideSteps = Math.max(1, Math.ceil(span / step / maxPts));
  const day0 = tile.dayStartMs;

  for (let ts = t0, i = 0; ts <= t1; ts += step, i++) {
    if (i % strideSteps !== 0 && ts + step <= t1) continue;
    let mouse = 0;
    let key = 0;
    const segEnd = ts + step;
    for (let t = ts; t < segEnd; t += 1000) {
      const sec = Math.floor((t - day0) / 1000);
      if (sec < 0 || sec >= tile.secs) continue;
      const m = tile.mouse[sec] || 0;
      const k = tile.key[sec] || 0;
      if (m > mouse) mouse = m;
      if (k > key) key = k;
    }
    pts.push({ ts: ts + step / 2, mouse, key });
  }
  return pts;
}

function pickStep(spanMs, plotW, pxMin = 2) {
  // 简化：对齐 lod 最细升层
  const base = 1000;
  const minInterval = (pxMin * spanMs) / Math.max(1, plotW);
  const cands = [
    1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000,
    1800000, 3600000,
  ];
  if (base >= minInterval) return base;
  for (const s of cands) if (s >= minInterval) return s;
  return cands[cands.length - 1];
}

function fakeLaneDraw(laneCount, segsPerLane, plotW) {
  let ops = 0;
  for (let i = 0; i < laneCount; i++) {
    for (let s = 0; s < segsPerLane; s++) {
      const x0 = (s / segsPerLane) * plotW;
      const x1 = x0 + plotW / segsPerLane;
      ops += Math.max(1, (x1 - x0) | 0); // 近似 fill 工作量
    }
  }
  return ops;
}

function timeMs(fn) {
  const t0 = performance.now();
  const v = fn();
  return { ms: performance.now() - t0, v };
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

function summarize(samples) {
  const a = [...samples].sort((x, y) => x - y);
  const sum = a.reduce((s, x) => s + x, 0);
  return {
    n: a.length,
    min: a[0] ?? 0,
    p50: pct(a, 50),
    p95: pct(a, 95),
    p99: pct(a, 99),
    max: a[a.length - 1] ?? 0,
    mean: a.length ? sum / a.length : 0,
    over16: a.filter((x) => x > 16).length,
    over50: a.filter((x) => x > 50).length,
    over100: a.filter((x) => x > 100).length,
  };
}

function runScenario(name, frames, frameFn) {
  const seriesProd = [];
  const seriesOpt = [];
  const lanes = [];
  const ticks = [];
  const total = [];
  let lastPts = 0;

  for (let i = 0; i < frames; i++) {
    const tFrame0 = performance.now();
    const ctx = frameFn(i);
    const a = timeMs(() =>
      buildSeriesPointsProd(ctx.tileCache, ctx.t0, ctx.t1, ctx.step)
    );
    seriesProd.push(a.ms);
    lastPts = a.v.length;
    const b = timeMs(() =>
      buildSeriesPointsNoDate(ctx.tile, ctx.t0, ctx.t1, ctx.step)
    );
    seriesOpt.push(b.ms);
    const c = timeMs(() => fakeLaneDraw(ctx.lanes, ctx.segs, ctx.plotW));
    lanes.push(c.ms);
    const d = timeMs(() => {
      // 刻度：按带宽估点数 + 字符串
      const n = Math.ceil(ctx.plotW / 8);
      let s = 0;
      for (let k = 0; k < n; k++) s += String(k).length;
      return s;
    });
    ticks.push(d.ms);
    total.push(performance.now() - tFrame0);
  }

  return {
    name,
    frames,
    lastPts,
    seriesProd: summarize(seriesProd),
    seriesOptNoDate: summarize(seriesOpt),
    fakeLanes: summarize(lanes),
    ticksLight: summarize(ticks),
    frameTotal: summarize(total),
  };
}

function main() {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const day0 = dayStart.getTime();
  const tile = makeTile(day0);
  const tileCache = new Map([[tile.date, tile]]);
  const plotW = 1100;

  // 同日下午窗口，对齐你截图量级
  let view0 = day0 + 17 * 3600_000 + 30 * 60_000;
  let span = 10 * 60_000; // 10 分钟

  const scenarios = [];

  // A: 同日平移 180 帧（模拟连滚）
  scenarios.push(
    runScenario("same_day_pan_10min", 180, (i) => {
      view0 += span * 0.028 * (i % 2 === 0 ? 1 : -1);
      const t0 = view0;
      const t1 = view0 + span;
      const step = pickStep(span, plotW);
      return {
        tileCache,
        tile,
        t0,
        t1,
        step,
        plotW,
        lanes: 27,
        segs: 40,
      };
    })
  );

  // B: 同日缩放到更宽再缩回
  view0 = day0 + 17 * 3600_000;
  span = 10 * 60_000;
  scenarios.push(
    runScenario("same_day_zoom_alt8pct", 80, (i) => {
      const r = 0.08;
      span = i % 2 === 0 ? span * (1 + r) : span / (1 + r);
      span = Math.min(6 * 3600_000, Math.max(30_000, span));
      const t0 = view0;
      const t1 = view0 + span;
      const step = pickStep(span, plotW);
      return {
        tileCache,
        tile,
        t0,
        t1,
        step,
        plotW,
        lanes: 27,
        segs: 40,
      };
    })
  );

  // C: 粗步长但仍扫满步内每秒（6h 窗）
  view0 = day0 + 12 * 3600_000;
  span = 6 * 3600_000;
  scenarios.push(
    runScenario("same_day_pan_6h_coarse_step", 120, (i) => {
      view0 += span * 0.02 * (i % 2 === 0 ? 1 : -1);
      if (view0 < day0) view0 = day0;
      if (view0 + span > day0 + DAY_MS) view0 = day0 + DAY_MS - span;
      const t0 = view0;
      const t1 = view0 + span;
      const step = pickStep(span, plotW);
      return {
        tileCache,
        tile,
        t0,
        t1,
        step,
        plotW,
        lanes: 27,
        segs: 80,
      };
    })
  );

  // D: 压力：细步 + 大窗（强制 1s，看 Date 成本）
  view0 = day0 + 10 * 3600_000;
  span = 3 * 3600_000;
  scenarios.push(
    runScenario("stress_force_1s_step_3h", 60, (i) => {
      view0 += 60_000 * (i % 2 === 0 ? 1 : -1);
      return {
        tileCache,
        tile,
        t0: view0,
        t1: view0 + span,
        step: 1000,
        plotW,
        lanes: 27,
        segs: 40,
      };
    })
  );

  const report = {
    utc: new Date().toISOString(),
    note: "模拟信号：直接改视窗；seriesProd≈现网热路径；seriesOptNoDate=去Date对照；fakeLanes≈27轴段填充量级",
    hardGateMs: { frameBudget: 16, hitch: 50, bad: 100 },
    scenarios,
  };

  // 判定：谁经常破门
  const verdicts = [];
  for (const s of scenarios) {
    const gates = [];
    if (s.seriesProd.p95 > 16)
      gates.push(`seriesProd p95=${s.seriesProd.p95.toFixed(2)}ms`);
    if (s.seriesProd.max > 50)
      gates.push(`seriesProd max=${s.seriesProd.max.toFixed(2)}ms`);
    if (s.fakeLanes.p95 > 16)
      gates.push(`fakeLanes p95=${s.fakeLanes.p95.toFixed(2)}ms`);
    const speedup =
      s.seriesOptNoDate.mean > 0
        ? s.seriesProd.mean / s.seriesOptNoDate.mean
        : 0;
    verdicts.push({
      scenario: s.name,
      gates: gates.length ? gates : ["under_16ms_ok"],
      dateKeyCostRatio_mean: Number(speedup.toFixed(2)),
      lastPts: s.lastPts,
      stepHint: "see seriesProd vs seriesOptNoDate",
    });
  }
  report.verdicts = verdicts;

  fs.writeFileSync(OUT, JSON.stringify(report, null, 2), "utf8");
  console.log(JSON.stringify(report, null, 2));
  console.log("\nWROTE", OUT);
}

main();
