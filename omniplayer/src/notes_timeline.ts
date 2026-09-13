/**
 * 笔记时间轴：卡片 + 研究资料标记；交互对齐仪表盘（滚轮平移 / Alt 缩放 / 惯性 / 长按拖）。
 */
import { buildTimeTicks, tickLabelCursor, estimateTickLabelWidth } from "./time_axis";
import type { NotesCardSummary } from "./notes_types";
import type { ResearchMeta } from "./notes_research";
import {
  filterCards,
  filterResearch,
  loadTimelineFilter,
  type TimelineFilter,
  DEFAULT_TIMELINE_FILTER,
} from "./notes_timeline_filter";
import {
  DAY_MS,
  LONG_PRESS_MS,
  CLICK_SLOP_PX,
  clampTimeView,
  applyPanDelta,
  createInertiaState,
  stopInertia,
  handleTimeAxisWheel,
  installAltZoomGuard,
  readAltZoomStepPct,
  type TimeView,
} from "./time_view_nav";

const AXIS_H = 36;
const MARK_Y = 56;
const LEADER_LEN = 48;
const LABEL_MAX = 42;

export type NotesTimelineHandlers = {
  onOpenCard: (cardId: string, createdAt: number) => void;
  onOpenResearch: (id: string) => void;
};

type TimelineItem =
  | { kind: "card"; ts: number; card: NotesCardSummary }
  | { kind: "research"; ts: number; research: ResearchMeta };

type Mark =
  | {
      kind: "single";
      ts: number;
      item: TimelineItem;
      x: number;
    }
  | {
      kind: "day";
      ts: number;
      dayKey: string;
      items: TimelineItem[];
      hasCard: boolean;
      hasResearch: boolean;
      label: string;
      x: number;
    };

let host: HTMLElement | null = null;
let canvas: HTMLCanvasElement | null = null;
let cards: NotesCardSummary[] = [];
let research: ResearchMeta[] = [];
let filter: TimelineFilter = loadTimelineFilter();
let handlers: NotesTimelineHandlers | null = null;
let viewStart = 0;
let viewEnd = 0;
let dpr = 1;
let raf = 0;
let inited = false;
let pointerOver = false;
let altGuard: ReturnType<typeof installAltZoomGuard> | null = null;
const inertia = createInertiaState();

type PanState = {
  pointerId: number;
  startX: number;
  startY: number;
  viewStart: number;
  viewEnd: number;
  armed: boolean;
  timer: number | null;
  moved: boolean;
};

let pan: PanState | null = null;
let pendingClick: { x: number; y: number; marks: Mark[] } | null = null;

function getView(): TimeView {
  return { start: viewStart, end: viewEnd };
}

function setView(v: TimeView) {
  viewStart = v.start;
  viewEnd = v.end;
}

function localDayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

function dayStartMs(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function allItems(): TimelineItem[] {
  const out: TimelineItem[] = [];
  for (const c of filterCards(cards, filter)) {
    if (!Number.isFinite(c.created_at)) continue;
    out.push({ kind: "card", ts: c.created_at, card: c });
  }
  for (const r of filterResearch(research, filter)) {
    if (!Number.isFinite(r.collected_at)) continue;
    out.push({ kind: "research", ts: r.collected_at, research: r });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

function fitToItems() {
  const items = allItems();
  if (!items.length) {
    const n = Date.now();
    const fitted = clampTimeView(n - DAY_MS, n + DAY_MS * 0.25);
    viewStart = fitted.start;
    viewEnd = fitted.end;
    return;
  }
  const times = items.map((i) => i.ts);
  const lo = Math.min(...times);
  const hi = Math.max(...times);
  const pad = Math.max(DAY_MS * 0.15, (hi - lo) * 0.08);
  const fitted = clampTimeView(lo - pad, hi + pad);
  viewStart = fitted.start;
  viewEnd = fitted.end;
}

function scheduleDraw() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    draw();
  });
}

function plotGeom() {
  const w = Math.max(1, canvas?.clientWidth || host?.clientWidth || 800);
  const h = Math.max(1, canvas?.clientHeight || host?.clientHeight || 220);
  const padL = 12;
  const padR = 12;
  const plotW = Math.max(1, w - padL - padR);
  return { w, h, padL, padR, plotW };
}

function xOf(ts: number, padL: number, plotW: number): number {
  const span = Math.max(1, viewEnd - viewStart);
  return padL + ((ts - viewStart) / span) * plotW;
}

function dayLabel(items: TimelineItem[]): string {
  const firstCard = items.find((i) => i.kind === "card");
  if (firstCard && firstCard.kind === "card") {
    const text = (firstCard.card.user_text || "").trim().replace(/\s+/g, " ");
    if (text) {
      return text.length > LABEL_MAX ? `${text.slice(0, LABEL_MAX)}…` : text;
    }
  }
  const firstRes = items.find((i) => i.kind === "research");
  if (firstRes && firstRes.kind === "research") {
    const t = (firstRes.research.title || "").trim() || "(资料)";
    return t.length > LABEL_MAX ? `${t.slice(0, LABEL_MAX)}…` : t;
  }
  return "(空)";
}

function buildMarks(padL: number, plotW: number): Mark[] {
  const span = Math.max(1, viewEnd - viewStart);
  const pxPerMs = plotW / span;
  const dayPx = DAY_MS * pxPerMs;
  const collapse = dayPx < 1;

  const sorted = allItems();
  if (!collapse) {
    return sorted.map((item) => ({
      kind: "single" as const,
      ts: item.ts,
      item,
      x: xOf(item.ts, padL, plotW),
    }));
  }

  const byDay = new Map<string, TimelineItem[]>();
  for (const item of sorted) {
    const k = localDayKey(item.ts);
    const arr = byDay.get(k) || [];
    arr.push(item);
    byDay.set(k, arr);
  }
  const out: Mark[] = [];
  for (const [dayKey, dayItems] of byDay) {
    const earliest = dayItems[0];
    const ts = dayStartMs(earliest.ts) + DAY_MS / 2;
    const hasCard = dayItems.some((i) => i.kind === "card");
    const hasResearch = dayItems.some((i) => i.kind === "research");
    out.push({
      kind: "day",
      ts,
      dayKey,
      items: dayItems,
      hasCard,
      hasResearch,
      label: dayLabel(dayItems),
      x: xOf(ts, padL, plotW),
    });
  }
  return out;
}

function drawDot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: string
) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

function drawDualDot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  left: string,
  right: string
) {
  ctx.fillStyle = left;
  ctx.beginPath();
  ctx.arc(x, y, r, Math.PI / 2, (Math.PI * 3) / 2, false);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = right;
  ctx.beginPath();
  ctx.arc(x, y, r, -Math.PI / 2, Math.PI / 2, false);
  ctx.closePath();
  ctx.fill();
}

function draw() {
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const { w, h, padL, plotW } = plotGeom();
  dpr = Math.max(1, Math.min(2.5, window.devicePixelRatio || 1));
  const bw = Math.round(w * dpr);
  const bh = Math.round(h * dpr);
  if (canvas.width !== bw || canvas.height !== bh) {
    canvas.width = bw;
    canvas.height = bh;
  }
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const styles = getComputedStyle(document.documentElement);
  const bg = styles.getPropertyValue("--bg").trim() || "#f4f4f2";
  const muted = styles.getPropertyValue("--muted").trim() || "#888";
  const fg = styles.getPropertyValue("--fg").trim() || styles.getPropertyValue("--text").trim() || "#222";
  const accent = styles.getPropertyValue("--accent").trim() || "#2d6a4f";
  const researchColor =
    styles.getPropertyValue("--notes-research-mark").trim() || "#c45c2d";
  const border = styles.getPropertyValue("--border").trim() || styles.getPropertyValue("--line").trim() || "#ccc";

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  const axisY = AXIS_H;
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, axisY);
  ctx.lineTo(padL + plotW, axisY);
  ctx.stroke();

  const ticks = buildTimeTicks(viewStart, viewEnd, plotW);
  const cursor = tickLabelCursor(8);
  ctx.font = '11px "Segoe UI", system-ui, sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  for (const t of ticks) {
    const x = xOf(t.ts, padL, plotW);
    if (x < padL - 2 || x > padL + plotW + 2) continue;
    const hick = t.rank === "major" ? 12 : t.rank === "mid" ? 8 : 5;
    ctx.strokeStyle = border;
    ctx.beginPath();
    ctx.moveTo(x, axisY);
    ctx.lineTo(x, axisY - hick);
    ctx.stroke();
    if (!t.label) continue;
    const tw = estimateTickLabelWidth(t.label);
    if (!cursor.take(x, tw)) continue;
    ctx.fillStyle = muted;
    ctx.fillText(t.label, x, 4);
  }

  const marks = buildMarks(padL, plotW);
  for (const m of marks) {
    if (m.x < padL - 20 || m.x > padL + plotW + 20) continue;
    if (m.kind === "single") {
      const color =
        m.item.kind === "research" ? researchColor : accent;
      drawDot(ctx, m.x, MARK_Y, 4.5, color);
    } else {
      const stroke =
        m.hasCard && m.hasResearch
          ? accent
          : m.hasResearch
            ? researchColor
            : accent;
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(m.x, MARK_Y);
      ctx.lineTo(m.x, MARK_Y + LEADER_LEN);
      ctx.stroke();
      if (m.hasCard && m.hasResearch) {
        drawDualDot(ctx, m.x, MARK_Y, 5.5, accent, researchColor);
      } else {
        drawDot(ctx, m.x, MARK_Y, 5.5, m.hasResearch ? researchColor : accent);
      }
      ctx.fillStyle = fg;
      ctx.font = '12px "Segoe UI", system-ui, sans-serif';
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const label = `${m.items.length} · ${m.label}`;
      ctx.fillText(label, m.x + 8, MARK_Y + LEADER_LEN);
    }
  }

  if (!allItems().length) {
    ctx.fillStyle = muted;
    ctx.font = '13px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const hasRaw = cards.length > 0 || research.length > 0;
    ctx.fillText(
      hasRaw ? "当前筛选无结果（可点漏斗放宽）" : "暂无笔记卡片或资料",
      w / 2,
      h / 2
    );
  }

  (canvas as HTMLCanvasElement & { __marks?: Mark[] }).__marks = marks;
}

function hitMark(marks: Mark[], x: number, y: number): Mark | null {
  let best: Mark | null = null;
  let bestD = 14;
  for (const m of marks) {
    if (m.kind === "single") {
      const dx = m.x - x;
      const dy = MARK_Y - y;
      const d = Math.hypot(dx, dy);
      if (d < bestD) {
        bestD = d;
        best = m;
      }
    } else {
      const onLeader =
        Math.abs(m.x - x) < 10 && y >= MARK_Y - 8 && y <= MARK_Y + LEADER_LEN + 14;
      const dx = m.x - x;
      const dy = MARK_Y - y;
      const d = Math.hypot(dx, dy);
      if (onLeader || d < bestD) {
        bestD = Math.min(bestD, onLeader ? 0 : d);
        best = m;
      }
    }
  }
  return best;
}

function clearPan() {
  if (pan?.timer != null) window.clearTimeout(pan.timer);
  pan = null;
  if (canvas) canvas.style.cursor = "default";
}

function openMark(hit: Mark) {
  if (!handlers) return;
  if (hit.kind === "single") {
    if (hit.item.kind === "card") {
      handlers.onOpenCard(hit.item.card.id, hit.item.card.created_at);
    } else {
      handlers.onOpenResearch(hit.item.research.id);
    }
    return;
  }
  const firstCard = hit.items.find((i) => i.kind === "card");
  if (firstCard && firstCard.kind === "card") {
    handlers.onOpenCard(firstCard.card.id, firstCard.card.created_at);
    return;
  }
  const firstRes = hit.items.find((i) => i.kind === "research");
  if (firstRes && firstRes.kind === "research") {
    handlers.onOpenResearch(firstRes.research.id);
  }
}

function onPointerDown(e: PointerEvent) {
  if (!canvas || e.button !== 0) return;
  stopInertia(inertia);
  const rect = canvas.getBoundingClientRect();
  const marks =
    (canvas as HTMLCanvasElement & { __marks?: Mark[] }).__marks || [];
  pendingClick = { x: e.clientX - rect.left, y: e.clientY - rect.top, marks };
  clearPan();
  pan = {
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    viewStart,
    viewEnd,
    armed: false,
    timer: window.setTimeout(() => {
      if (!pan || pan.pointerId !== e.pointerId) return;
      pan.armed = true;
      if (canvas) canvas.style.cursor = "grabbing";
    }, LONG_PRESS_MS),
    moved: false,
  };
  try {
    canvas.setPointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
  e.preventDefault();
}

function onPointerMove(e: PointerEvent) {
  if (!pan || pan.pointerId !== e.pointerId) return;
  const dx = e.clientX - pan.startX;
  const dy = e.clientY - pan.startY;
  if (dx * dx + dy * dy > CLICK_SLOP_PX * CLICK_SLOP_PX) {
    pan.moved = true;
    pendingClick = null;
  }
  if (!pan.armed) return;
  const { plotW } = plotGeom();
  const span = Math.max(1, pan.viewEnd - pan.viewStart);
  const deltaMs = -(dx / Math.max(1, plotW)) * span;
  setView(
    applyPanDelta({ start: pan.viewStart, end: pan.viewEnd }, deltaMs)
  );
  scheduleDraw();
}

function onPointerUp(e: PointerEvent) {
  if (!pan || pan.pointerId !== e.pointerId) return;
  const wasClick = !pan.moved && !pan.armed;
  const click = pendingClick;
  clearPan();
  if (wasClick && click && handlers) {
    const hit = hitMark(click.marks, click.x, click.y);
    if (hit) openMark(hit);
  }
  pendingClick = null;
}

function onWheel(e: WheelEvent) {
  if (!canvas) return;
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const { padL, plotW } = plotGeom();
  handleTimeAxisWheel(e, {
    plotLeft: padL,
    plotW,
    clientX: e.clientX - rect.left,
    altHeld: altGuard?.getAltHeld() ?? false,
    altZoomStepPct: readAltZoomStepPct(),
    getView,
    setView,
    inertia,
    onFrame: scheduleDraw,
  });
}

function onResize() {
  scheduleDraw();
}

export function initNotesTimeline(h: NotesTimelineHandlers) {
  handlers = h;
  host = document.getElementById("notes-timeline-view");
  canvas = document.getElementById("notes-timeline-canvas") as HTMLCanvasElement | null;
  if (!host || !canvas || inited) return;
  inited = true;
  canvas.tabIndex = 0;
  canvas.addEventListener("pointerenter", () => {
    pointerOver = true;
  });
  canvas.addEventListener("pointerleave", () => {
    pointerOver = false;
  });
  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  window.addEventListener("resize", onResize);
  altGuard = installAltZoomGuard({
    isActive: () =>
      !!document.getElementById("page-notes")?.classList.contains("active") &&
      !document.getElementById("notes-timeline-view")?.classList.contains("hidden"),
    isPointerOver: () => pointerOver,
  });
}

export function setNotesTimelineCards(next: NotesCardSummary[], opts?: { refit?: boolean }) {
  cards = next.slice();
  if (opts?.refit !== false) fitToItems();
  scheduleDraw();
}

export function setNotesTimelineResearch(
  next: ResearchMeta[],
  opts?: { refit?: boolean }
) {
  research = next.slice();
  if (opts?.refit !== false) fitToItems();
  scheduleDraw();
}

export function setNotesTimelineFilter(next: TimelineFilter, opts?: { refit?: boolean }) {
  filter = { ...DEFAULT_TIMELINE_FILTER, ...next };
  if (opts?.refit) fitToItems();
  scheduleDraw();
}

export function getNotesTimelineFilter(): TimelineFilter {
  return { ...filter };
}

export function getNotesTimelineFilterSource(): {
  cards: NotesCardSummary[];
  research: ResearchMeta[];
} {
  return { cards: cards.slice(), research: research.slice() };
}

export function enterNotesTimeline(
  nextCards?: NotesCardSummary[],
  nextResearch?: ResearchMeta[]
) {
  if (nextCards) cards = nextCards.slice();
  if (nextResearch) research = nextResearch.slice();
  fitToItems();
  scheduleDraw();
}

export function leaveNotesTimeline() {
  clearPan();
  pendingClick = null;
  stopInertia(inertia);
}

export function resizeNotesTimeline() {
  scheduleDraw();
}
