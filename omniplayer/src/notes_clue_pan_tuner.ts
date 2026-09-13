/**
 * 线索板平移惯性调试面板：速度衰减曲线 + 阻尼系数（仅线索板模式）。
 */
import { shellT } from "./shell_i18n";

export type PanCurvePoint = { t: number; v: number };

const LS_CURVE = "omnitrace.clue.pan_curve";
const LS_DAMPING = "omnitrace.clue.pan_damping";

/** 阻尼=1 时的惯性总时长（秒）；阻尼越大时长越短、滑行越短 */
const BASE_INERTIA_DURATION_SEC = 0.72;

const CHART_W = 220;
const CHART_H = 120;
const PAD_L = 28;
const PAD_R = 10;
const PAD_T = 10;
const PAD_B = 22;

const DEFAULT_POINTS: PanCurvePoint[] = [
  { t: 0, v: 1 },
  { t: 0.14, v: 0.86 },
  { t: 0.42, v: 0.32 },
  { t: 1, v: 0 },
];

const DEFAULT_DAMPING = 1;

let points: PanCurvePoint[] = DEFAULT_POINTS.map((p) => ({ ...p }));
let damping = DEFAULT_DAMPING;
let inited = false;
let dragIdx = -1;

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function plotW(): number {
  return CHART_W - PAD_L - PAD_R;
}

function plotH(): number {
  return CHART_H - PAD_T - PAD_B;
}

function tToX(t: number): number {
  return PAD_L + t * plotW();
}

function vToY(v: number): number {
  return PAD_T + (1 - v) * plotH();
}

function xToT(x: number): number {
  return Math.max(0, Math.min(1, (x - PAD_L) / plotW()));
}

function yToV(y: number): number {
  return Math.max(0, Math.min(1, 1 - (y - PAD_T) / plotH()));
}

function sortPoints() {
  points.sort((a, b) => a.t - b.t);
  points[0] = { t: 0, v: Math.max(0, Math.min(1, points[0]?.v ?? 1)) };
  const last = points.length - 1;
  points[last] = { t: 1, v: 0 };
}

function loadPersisted() {
  try {
    const raw = localStorage.getItem(LS_CURVE);
    if (raw) {
      const parsed = JSON.parse(raw) as PanCurvePoint[];
      if (Array.isArray(parsed) && parsed.length >= 2) {
        points = parsed.map((p) => ({
          t: Math.max(0, Math.min(1, Number(p.t) || 0)),
          v: Math.max(0, Math.min(1, Number(p.v) || 0)),
        }));
        sortPoints();
      }
    }
    const d = localStorage.getItem(LS_DAMPING);
    if (d != null) {
      const n = Number(d);
      if (Number.isFinite(n) && n > 0) damping = n;
    }
  } catch {
    /* private mode / bad json */
  }
}

function persist() {
  try {
    localStorage.setItem(LS_CURVE, JSON.stringify(points));
    localStorage.setItem(LS_DAMPING, String(damping));
  } catch {
    /* private mode */
  }
}

/** 分段线性：t∈[0,1] 上的归一化速度倍率 */
export function evaluatePanCurve(tNorm: number): number {
  const t = Math.max(0, Math.min(1, tNorm));
  if (t <= points[0].t) return points[0].v;
  const last = points[points.length - 1];
  if (t >= last.t) return last.v;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t;
      if (span <= 1e-6) return b.v;
      const u = (t - a.t) / span;
      return a.v + (b.v - a.v) * u;
    }
  }
  return 0;
}

/** 惯性阶段总时长（秒）；阻尼↑ → 时长↓ → 滑行距离↓ */
export function getPanInertiaDuration(): number {
  return BASE_INERTIA_DURATION_SEC / Math.max(0.05, damping);
}

export function getPanDamping(): number {
  return damping;
}

function curvePathD(): string {
  if (points.length < 2) return "";
  const segs = points.map((p, i) => {
    const cmd = i === 0 ? "M" : "L";
    return `${cmd}${tToX(p.t).toFixed(1)},${vToY(p.v).toFixed(1)}`;
  });
  return segs.join(" ");
}

function renderChart() {
  const path = $("notes-clue-pan-curve-path");
  const handles = $("notes-clue-pan-curve-handles");
  const dampingInput = $("notes-clue-pan-damping") as HTMLInputElement | null;
  if (!path || !handles) return;

  path.setAttribute("d", curvePathD());

  handles.innerHTML = "";
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const locked = i === 0 || i === points.length - 1;
    const c = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    c.setAttribute("cx", String(tToX(p.t)));
    c.setAttribute("cy", String(vToY(p.v)));
    c.setAttribute("r", locked ? "3.5" : "5.5");
    c.classList.add("notes-clue-pan-handle");
    if (locked) c.classList.add("is-locked");
    else {
      c.classList.add("is-draggable");
      c.dataset.idx = String(i);
    }
    handles.appendChild(c);
  }

  if (dampingInput && document.activeElement !== dampingInput) {
    dampingInput.value = String(Math.round(damping * 100) / 100);
  }
}

function applyAxisLabels() {
  const yLabel = $("notes-clue-pan-curve-ylabel");
  const xLabel = $("notes-clue-pan-curve-xlabel");
  if (yLabel) yLabel.textContent = shellT("notes.clue.panTuner.velocity");
  if (xLabel) xLabel.textContent = shellT("notes.clue.panTuner.time");
  const hint = $("notes-clue-pan-tuner-hint");
  if (hint) hint.textContent = shellT("notes.clue.panTuner.hint");
  const title = document.querySelector(
    "#notes-clue-pan-tuner [data-i18n='notes.clue.panTuner.title']"
  );
  if (title) title.textContent = shellT("notes.clue.panTuner.title");
  const dampLbl = document.querySelector(
    "#notes-clue-pan-tuner [data-i18n='notes.clue.panTuner.damping']"
  );
  if (dampLbl) dampLbl.textContent = shellT("notes.clue.panTuner.damping");
}

function onDampingInput() {
  const el = $("notes-clue-pan-damping") as HTMLInputElement | null;
  if (!el) return;
  const n = Number(el.value);
  if (!Number.isFinite(n) || n <= 0) return;
  damping = Math.max(0.1, Math.min(5, n));
  el.value = String(Math.round(damping * 100) / 100);
  persist();
}

function onHandlePointerDown(e: PointerEvent) {
  const target = e.target as SVGElement;
  if (!target.classList.contains("is-draggable")) return;
  const idx = Number(target.dataset.idx);
  if (!Number.isFinite(idx)) return;
  dragIdx = idx;
  const svg = $("notes-clue-pan-curve-svg");
  svg?.setPointerCapture(e.pointerId);
  e.preventDefault();
  e.stopPropagation();
}

function onHandlePointerMove(e: PointerEvent) {
  if (dragIdx < 0) return;
  const svg = $("notes-clue-pan-curve-svg");
  if (!svg) return;
  const rect = svg.getBoundingClientRect();
  const sx = ((e.clientX - rect.left) / rect.width) * CHART_W;
  const sy = ((e.clientY - rect.top) / rect.height) * CHART_H;

  const prevT = points[dragIdx - 1]?.t ?? 0;
  const nextT = points[dragIdx + 1]?.t ?? 1;
  const minGap = 0.04;
  let t = xToT(sx);
  t = Math.max(prevT + minGap, Math.min(nextT - minGap, t));
  const v = yToV(sy);

  points[dragIdx] = { t, v };
  renderChart();
}

function onHandlePointerUp(e: PointerEvent) {
  if (dragIdx < 0) return;
  sortPoints();
  const svg = $("notes-clue-pan-curve-svg");
  if (svg?.hasPointerCapture(e.pointerId)) {
    svg.releasePointerCapture(e.pointerId);
  }
  dragIdx = -1;
  renderChart();
  persist();
}

function bindToggle() {
  const panel = $("notes-clue-pan-tuner");
  const btn = $("notes-clue-pan-tuner-toggle");
  btn?.addEventListener("click", () => {
    const collapsed = panel?.classList.toggle("is-collapsed");
    btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
  });
}

export function initCluePanTuner() {
  if (inited) return;
  inited = true;
  loadPersisted();

  const svg = $("notes-clue-pan-curve-svg");
  const dampingInput = $("notes-clue-pan-damping");

  svg?.addEventListener("pointerdown", onHandlePointerDown);
  svg?.addEventListener("pointermove", onHandlePointerMove);
  svg?.addEventListener("pointerup", onHandlePointerUp);
  svg?.addEventListener("pointercancel", onHandlePointerUp);

  dampingInput?.addEventListener("change", onDampingInput);
  dampingInput?.addEventListener("input", onDampingInput);

  bindToggle();
  applyAxisLabels();
  renderChart();

  window.addEventListener("omnitrace-lang", () => {
    applyAxisLabels();
  });
}

export function showCluePanTuner(visible: boolean) {
  $("notes-clue-pan-tuner")?.classList.toggle("hidden", !visible);
}
