/**
 * 笔记绿线：异星工厂式「拿起再点接」。与输入栏同一连通块的卡片 = 下一问历史。
 */
import { invoke } from "@tauri-apps/api/core";
import type { NotesCardSummary } from "./notes_types";

export const COMPOSER_ID = "composer";

export type ChatTurnMessage = {
  role: "user" | "assistant";
  content: string;
  /** 来源卡片创建时间（ms）；供 send_turn 注入时序与排序。 */
  created_at?: number;
  card_id?: string;
};

type ContextGraphFile = {
  v: number;
  edges: string[][];
};

type Pt = { x: number; y: number };

const PORT_OUT = 20;
const PORT_R = 6;
const BULGE = 14;
const MAX_EDGES = 4000;

let edges = new Set<string>();
/** 已拿起一根线，等待点第二个圆点 */
let pending: {
  from: string;
  x: number;
  y: number;
} | null = null;
let hoverId: string | null = null;
let drawRaf = 0;
let saveTimer = 0;
let hintTimer = 0;
let onHint: (() => void) | null = null;
let inited = false;

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}\n${b}` : `${b}\n${a}`;
}

function parseKey(k: string): [string, string] {
  const i = k.indexOf("\n");
  return [k.slice(0, i), k.slice(i + 1)];
}

function layer(): SVGSVGElement | null {
  return document.getElementById("notes-wire-layer") as SVGSVGElement | null;
}

function drawHost(): SVGGElement | null {
  return document.getElementById("notes-wire-draw") as SVGGElement | null;
}

function allCardIds(): string[] {
  return [...document.querySelectorAll(".notes-card[data-card-id]:not(.is-off-thread)")].map(
    (el) => (el as HTMLElement).dataset.cardId || ""
  ).filter(Boolean);
}

function nodeBox(id: string): DOMRect | null {
  if (id === COMPOSER_ID) {
    return document.querySelector(".notes-composer")?.getBoundingClientRect() ?? null;
  }
  const el = document.querySelector(
    `.notes-card[data-card-id="${CSS.escape(id)}"]`
  );
  return el?.getBoundingClientRect() ?? null;
}

function portPos(id: string): Pt | null {
  const svg = layer();
  const box = nodeBox(id);
  if (!svg || !box) return null;
  const origin = svg.getBoundingClientRect();
  return {
    x: box.left - PORT_OUT - origin.left,
    y: box.top + box.height / 2 - origin.top,
  };
}

function clientToLayer(cx: number, cy: number): Pt {
  const origin = layer()?.getBoundingClientRect();
  if (!origin) return { x: cx, y: cy };
  return { x: cx - origin.left, y: cy - origin.top };
}

function portAtClient(cx: number, cy: number): string | null {
  const el = document.elementFromPoint(cx, cy);
  const hit = el?.closest?.("[data-port-id]") as HTMLElement | null;
  return hit?.dataset.portId || null;
}

function neighbors(id: string): string[] {
  const out: string[] = [];
  for (const k of edges) {
    const [a, b] = parseKey(k);
    if (a === id) out.push(b);
    else if (b === id) out.push(a);
  }
  return out;
}

export function componentOf(id: string): Set<string> {
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const n = stack.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const m of neighbors(n)) stack.push(m);
  }
  return seen;
}

export function contextCardIds(): string[] {
  const set = componentOf(COMPOSER_ID);
  set.delete(COMPOSER_ID);
  return [...set];
}

/** 下一问会带上的卡片：优先输入栏连通块；否则带上「最新一张所在的绿线网」。 */
export function pendingHistoryIds(cards: NotesCardSummary[]): string[] {
  const viaComposer = contextCardIds();
  if (viaComposer.length) return viaComposer;
  const sorted = [...cards].sort((a, b) => a.created_at - b.created_at);
  const latest = sorted.length ? sorted[sorted.length - 1] : undefined;
  if (!latest || neighbors(latest.id).length === 0) return [];
  const set = componentOf(latest.id);
  set.delete(COMPOSER_ID);
  return [...set];
}

export function historyMessages(cards: NotesCardSummary[]): ChatTurnMessage[] {
  const ids = new Set(pendingHistoryIds(cards));
  if (!ids.size) return [];
  const ordered = cards
    .filter((c) => ids.has(c.id))
    .sort((a, b) => a.created_at - b.created_at);
  const msgs: ChatTurnMessage[] = [];
  for (const c of ordered) {
    const user = c.user_text.trim();
    const asst = c.assistant_text.trim();
    if (user) {
      msgs.push({
        role: "user",
        content: c.user_text,
        created_at: c.created_at,
        card_id: c.id,
      });
    }
    if (asst) {
      msgs.push({
        role: "assistant",
        content: c.assistant_text,
        created_at: c.created_at,
        card_id: c.id,
      });
    }
  }
  return msgs;
}

function addEdge(a: string, b: string) {
  if (!a || !b || a === b) return;
  if (edges.size >= MAX_EDGES) return;
  edges.add(edgeKey(a, b));
}

function removeEdge(a: string, b: string) {
  edges.delete(edgeKey(a, b));
}

function cardCreatedAt(id: string): number | null {
  if (id === COMPOSER_ID) return null;
  const el = document.querySelector(
    `.notes-card[data-card-id="${CSS.escape(id)}"]`
  ) as HTMLElement | null;
  const raw = el?.dataset.createdAt;
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

type SkipSpan = {
  lo: number;
  hi: number;
  epLo: string;
  epHi: string;
};

/** 跨接边两端时间更早/更晚的卡片 id */
function spanEndpoints(x: string, y: string, tx: number, ty: number): SkipSpan {
  const lo = Math.min(tx, ty);
  const hi = Math.max(tx, ty);
  return {
    lo,
    hi,
    epLo: tx <= ty ? x : y,
    epHi: tx <= ty ? y : x,
  };
}

function spanKey(span: SkipSpan): string {
  return `${span.lo}\n${span.hi}\n${span.epLo}\n${span.epHi}`;
}

/**
 * 时间序「中间卡」插入：若新边一端 M 严格介于某跨接边 X—Y 两端之间，
 * 且新边连接 M 与 X 或 Y，则拆掉该跨接边（如已有 A—C，再连 B—A 时删 A—C）。
 * composer 无 created_at，不参与时间序判定。
 */
function findBridgingSkipSpans(a: string, b: string): SkipSpan[] {
  const tA = cardCreatedAt(a);
  const tB = cardCreatedAt(b);
  const spans: SkipSpan[] = [];
  const seen = new Set<string>();

  for (const k of edges) {
    const [x, y] = parseKey(k);
    const tx = cardCreatedAt(x);
    const ty = cardCreatedAt(y);
    if (tx == null || ty == null) continue;
    const span = spanEndpoints(x, y, tx, ty);

    for (const [, other, tm] of [
      [a, b, tA] as const,
      [b, a, tB] as const,
    ]) {
      if (tm == null || tm <= span.lo || tm >= span.hi) continue;
      if (other !== x && other !== y) continue;
      const key = spanKey(span);
      if (seen.has(key)) break;
      seen.add(key);
      spans.push(span);
      break;
    }
  }
  return spans;
}

/** 跨接边时间窗内所有卡片（含两端与严格介于其间的卡），按 created_at 升序 */
function nodesInSkipSpan(span: SkipSpan): string[] {
  const nodes = new Set<string>([span.epLo, span.epHi]);
  for (const id of allCardIds()) {
    const t = cardCreatedAt(id);
    if (t != null && t > span.lo && t < span.hi) nodes.add(id);
  }
  return [...nodes].sort((u, v) => cardCreatedAt(u)! - cardCreatedAt(v)!);
}

/** 按时间序为相邻卡片补链边；跳过已存在边与同连通块内冗余直连 */
function completeAdjacentChain(sorted: string[]): number {
  let added = 0;
  for (let i = 0; i < sorted.length - 1; i++) {
    const u = sorted[i];
    const v = sorted[i + 1];
    if (!u || !v || u === v) continue;
    if (edges.has(edgeKey(u, v))) continue;
    if (componentOf(u).has(v)) continue;
    addEdge(u, v);
    added++;
  }
  return added;
}

function cardShortLabel(id: string): string {
  const el = document.querySelector(
    `.notes-card[data-card-id="${CSS.escape(id)}"]`
  );
  const time = el?.querySelector(".notes-card-time")?.textContent?.trim();
  return time || id.slice(0, 8);
}

function formatChainFeedback(chains: string[][]): string {
  if (!chains.length) return "已插入中间节点，拆掉跨接";
  const longest = chains.reduce((a, b) => (b.length > a.length ? b : a), chains[0]!);
  if (longest.length <= 4) {
    return `已插入中间节点，链已补全为 ${longest.map(cardShortLabel).join("→")}`;
  }
  return `已插入中间节点，已按时间序补全 ${longest.length} 张卡片的相邻链`;
}

/**
 * 拆掉跨接边并按时间序补全相邻链（如 A—C 跨 B，B 连一端后得 A—B—C）。
 * 返回拆掉条数与补全涉及的链（用于提示）。
 */
function bridgeAndCompleteChain(a: string, b: string): {
  removed: number;
  chains: string[][];
} {
  const spans = findBridgingSkipSpans(a, b);
  if (!spans.length) return { removed: 0, chains: [] };

  let removed = 0;
  for (const span of spans) {
    if (edges.delete(edgeKey(span.epLo, span.epHi))) removed++;
  }

  const chains: string[][] = [];
  for (const span of spans) {
    const sorted = nodesInSkipSpan(span);
    completeAdjacentChain(sorted);
    chains.push(sorted);
  }
  return { removed, chains };
}

function disconnectNode(id: string) {
  for (const k of [...edges]) {
    const [a, b] = parseKey(k);
    if (a === id || b === id) edges.delete(k);
  }
}

function persistSoon() {
  if (saveTimer) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = 0;
    void persistEdgesNow();
  }, 280);
  onHint?.();
}

function persistEdgesNow() {
  const list = [...edges].map(parseKey);
  void invoke("notes_context_graph_save", {
    graph: { v: 1, edges: list },
  }).catch((e) => console.error(e));
}

function showWireFeedback(msg: string) {
  console.info(`[notes-wire] ${msg}`);
  let el = document.getElementById("notes-wire-hint");
  if (!el) {
    el = document.createElement("div");
    el.id = "notes-wire-hint";
    el.setAttribute("role", "status");
    document.querySelector(".notes-stage")?.appendChild(el);
  }
  el.textContent = msg;
  el.classList.add("is-visible");
  if (hintTimer) window.clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => {
    el?.classList.remove("is-visible");
  }, 1800);
}

export function rewireComposerAfterSend(newCardId: string) {
  const attached = neighbors(COMPOSER_ID);
  disconnectNode(COMPOSER_ID);
  for (const n of attached) addEdge(n, newCardId);
  addEdge(newCardId, COMPOSER_ID);
  persistSoon();
  scheduleDrawWires();
}

export function composerIsLive(): boolean {
  return neighbors(COMPOSER_ID).length > 0;
}

export function linkNodes(a: string, b: string) {
  if (!a || !b || a === b) return;
  if (!componentOf(a).has(b)) {
    bridgeAndCompleteChain(a, b);
    if (!componentOf(a).has(b)) addEdge(a, b);
  }
  persistSoon();
  scheduleDrawWires();
}

function cablePath(a: Pt, b: Pt): string {
  const mx = Math.min(a.x, b.x) - BULGE;
  const my = (a.y + b.y) / 2;
  return `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
}

function titleFor(id: string): string {
  if (id === COMPOSER_ID) {
    return "点击拿起线，再点卡片圆点接通。同分量已连通则不可再连。右键拆掉本点所有线。";
  }
  return "点击拿起线，再点另一圆点接通或断开直连。点绿线可拆；右键拆掉本点所有线。";
}

export function drawWires() {
  const g = drawHost();
  const svg = layer();
  if (!g || !svg) return;
  const w = svg.clientWidth || 1;
  const h = svg.clientHeight || 1;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);

  const nodes = [...allCardIds(), COMPOSER_ID];
  const pos = new Map<string, Pt>();
  for (const id of nodes) {
    const p = portPos(id);
    if (p) pos.set(id, p);
  }

  let live = componentOf(COMPOSER_ID);
  if (neighbors(COMPOSER_ID).length === 0) {
    const ids = allCardIds();
    const lastId = ids.length ? ids[ids.length - 1] : undefined;
    if (lastId && neighbors(lastId).length) live = componentOf(lastId);
  }
  const parts: string[] = [];

  for (const k of edges) {
    const [a, b] = parseKey(k);
    const pa = pos.get(a);
    const pb = pos.get(b);
    if (!pa || !pb) continue;
    const d = cablePath(pa, pb);
    const lit = live.has(a) && live.has(b);
    const stroke = lit ? "var(--notes-wire)" : "var(--notes-wire-dim)";
    parts.push(
      `<path d="${d}" fill="none" stroke="${stroke}" stroke-width="2.2" stroke-linecap="round"/>` +
        `<path class="notes-wire-hit" data-edge="${encodeURIComponent(k)}" d="${d}" fill="none" stroke="transparent" stroke-width="14" stroke-linecap="round" style="cursor:pointer"/>`
    );
  }

  if (pending) {
    const from = pos.get(pending.from);
    if (from) {
      const to = { x: pending.x, y: pending.y };
      const d = cablePath(from, to);
      parts.push(
        `<path d="${d}" fill="none" stroke="var(--notes-wire)" stroke-width="2.2" stroke-linecap="round" stroke-dasharray="5 4" stroke-opacity="0.85"/>`
      );
    }
  }

  for (const id of nodes) {
    const p = pos.get(id);
    if (!p) continue;
    const linked = neighbors(id).length > 0;
    const hot = pending?.from === id || hoverId === id;
    const fill = linked || hot ? "var(--notes-wire)" : "var(--panel)";
    const r = hot ? PORT_R + 1.5 : PORT_R;
    const title = titleFor(id);
    parts.push(
      `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${r}" fill="${fill}" stroke="var(--notes-wire)" stroke-width="2"/>` +
        `<circle class="notes-port-hit" data-port-id="${id}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="13" fill="transparent" style="cursor:pointer"><title>${title}</title></circle>`
    );
  }

  g.innerHTML = parts.join("");
}

export function scheduleDrawWires() {
  if (drawRaf) return;
  drawRaf = window.requestAnimationFrame(() => {
    drawRaf = 0;
    drawWires();
  });
}

export function cancelWireDrag() {
  if (!pending) return;
  pending = null;
  hoverId = null;
  document.body.classList.remove("is-notes-wiring");
  scheduleDrawWires();
}

function tryConnect(from: string, to: string) {
  if (!from || !to || from === to) return;
  const key = edgeKey(from, to);
  if (edges.has(key)) {
    removeEdge(from, to);
    persistSoon();
    showWireFeedback("已断开直连");
    return;
  }
  // 同连通分量（已间接连通）禁止再加边，避免成环/冗余
  if (componentOf(from).has(to)) {
    showWireFeedback("已在同一网络，不能再连");
    return;
  }
  const { removed, chains } = bridgeAndCompleteChain(from, to);
  if (!componentOf(from).has(to)) addEdge(from, to);
  persistSoon();
  if (removed > 0) showWireFeedback(formatChainFeedback(chains));
}

function pickUp(from: string, cx: number, cy: number) {
  const pt = clientToLayer(cx, cy);
  pending = { from, x: pt.x, y: pt.y };
  document.body.classList.add("is-notes-wiring");
  scheduleDrawWires();
}

function onPortClick(e: MouseEvent, portId: string) {
  e.preventDefault();
  e.stopPropagation();
  if (!pending) {
    pickUp(portId, e.clientX, e.clientY);
    return;
  }
  if (pending.from === portId) {
    cancelWireDrag();
    return;
  }
  const from = pending.from;
  pending = null;
  hoverId = null;
  document.body.classList.remove("is-notes-wiring");
  tryConnect(from, portId);
  scheduleDrawWires();
}

function onPointerMove(e: PointerEvent) {
  if (!pending) return;
  const pt = clientToLayer(e.clientX, e.clientY);
  pending.x = pt.x;
  pending.y = pt.y;
  hoverId = portAtClient(e.clientX, e.clientY);
  if (hoverId === pending.from) hoverId = null;
  scheduleDrawWires();
}

function onClick(e: MouseEvent) {
  const t = e.target as Element | null;
  const port = t?.closest?.("[data-port-id]") as HTMLElement | null;
  if (port) {
    onPortClick(e, port.dataset.portId || "");
    return;
  }
  const hit = t?.closest?.("[data-edge]") as HTMLElement | null;
  if (hit) {
    e.stopPropagation();
    if (pending) {
      cancelWireDrag();
      return;
    }
    const k = decodeURIComponent(hit.dataset.edge || "");
    if (!k || !edges.has(k)) return;
    edges.delete(k);
    persistSoon();
    scheduleDrawWires();
  }
}

/** SVG 空白穿透，拿起中时点页面其它处取消 */
function onDocClick(e: MouseEvent) {
  if (!pending) return;
  const t = e.target as Element | null;
  if (t?.closest?.("[data-port-id]")) return;
  if (t?.closest?.("[data-edge]")) return;
  cancelWireDrag();
}

function onPointerDown(e: PointerEvent) {
  const t = e.target as Element | null;
  const port = t?.closest?.("[data-port-id]") as HTMLElement | null;
  if (!port) return;
  if (e.button === 2) {
    e.preventDefault();
    disconnectNode(port.dataset.portId || "");
    if (pending?.from === port.dataset.portId) cancelWireDrag();
    persistSoon();
    scheduleDrawWires();
  }
}

function onContextMenu(e: MouseEvent) {
  const t = e.target as Element | null;
  if (t?.closest?.("[data-port-id]")) e.preventDefault();
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape") cancelWireDrag();
}

export async function loadContextGraph() {
  try {
    const g = await invoke<ContextGraphFile>("notes_context_graph_get");
    edges = new Set();
    for (const pair of g?.edges || []) {
      if (pair.length < 2) continue;
      addEdge(String(pair[0]), String(pair[1]));
    }
  } catch (err) {
    console.error(err);
  }
  scheduleDrawWires();
  onHint?.();
}

/** 当前绿线边列表（含 composer）。 */
export function getCurrentEdges(): string[][] {
  return [...edges].map(parseKey);
}

/** 用存档边覆盖当前工作区并立即落盘 context_graph。 */
export function applyEdges(list: string[][]) {
  cancelWireDrag();
  edges = new Set();
  for (const pair of list) {
    if (pair.length < 2) continue;
    addEdge(String(pair[0]), String(pair[1]));
  }
  if (saveTimer) {
    window.clearTimeout(saveTimer);
    saveTimer = 0;
  }
  persistEdgesNow();
  scheduleDrawWires();
  onHint?.();
}

export function initNotesWires(opts: { onHint?: () => void }) {
  if (inited) return;
  inited = true;
  onHint = opts.onHint || null;
  const svg = layer();
  if (!svg) return;
  svg.addEventListener("pointerdown", onPointerDown);
  svg.addEventListener("click", onClick);
  svg.addEventListener("contextmenu", onContextMenu);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("keydown", onKeyDown);
  document.addEventListener("click", onDocClick, true);
  window.addEventListener("resize", scheduleDrawWires);
  const feed = document.getElementById("notes-feed");
  feed?.addEventListener("scroll", scheduleDrawWires, { passive: true });
  const stage = document.querySelector(".notes-stage");
  if (stage && typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => scheduleDrawWires()).observe(stage);
  }
  if (feed && typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => scheduleDrawWires()).observe(feed);
  }
  scheduleDrawWires();
}
