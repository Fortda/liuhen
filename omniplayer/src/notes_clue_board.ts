/**
 * 笔记「线索板」模式：浅底钉板 + 白色便签 + 有向箭头连线（与流式笔记绿线独立）。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { hideGroupMetaPopover, showGroupMetaPopover, uiLang } from "./notes_cards";
import { shellT } from "./shell_i18n";
import {
  evaluatePanCurve,
  getPanInertiaDuration,
  initCluePanTuner,
  showCluePanTuner,
} from "./notes_clue_pan_tuner";
import {
  bindClueHistoryUi,
  captureClueSnapshot,
  CLUE_HISTORY_LABELS,
  clearClueHistoryBoard,
  initClueHistory,
  pushClueHistory,
  redoClueHistory,
  refreshClueHistoryUi,
  reloadClueHistoryFromDisk,
  setClueHistoryBoard,
  undoClueHistory,
  type ClueBoardSnapshot,
  type HistoryLabel,
} from "./notes_clue_history";
import {
  hideFloat,
  placeFloatAtPoint,
  revealFloat,
} from "./omni_float";

export type ClueNode = {
  id: string;
  text: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  color?: string;
};

export type ClueEdge = {
  id: string;
  from: string;
  to: string;
};

type ClueBoardView = {
  x: number;
  y: number;
  zoom?: number;
};

type ClueBoard = {
  id: string;
  title: string;
  nodes: ClueNode[];
  edges: ClueEdge[];
  view?: ClueBoardView;
  /** ms epoch; 0/absent = unknown until seeded from history or file mtime */
  created_at?: number;
  updated_at?: number;
};

type ClueBoardsFile = {
  v: number;
  active_id: string;
  boards: ClueBoard[];
};

const SAVE_DEBOUNCE_MS = 320;
const BULGE = 28;
/** 箭头尖端相对 port 外缘的内缩量（canvas px）；0=贴边，负值略 overlap */
const WIRE_PORT_GAP = -0.5;
const PAN_CLICK_SLOP = 5;
const CLUE_MIN_W = 120;
const CLUE_MIN_H = 72;
const CLUE_MAX_W = 1600;
const CLUE_MAX_H = 1200;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 2.0;
const ZOOM_STEP = 0.05;
/** zoom ≤ 此值时便签折叠为图谱式圆点 + 下方注解 */
const ZOOM_DOT_MODE = 0.5;
const CLUE_DOT_LABEL_MAX = 10;
const CLUE_DOT_R = 5;
/** 点阵模式：圆点/标签用屏幕像素下限，zoom out 时不同比缩小 */
const CLUE_DOT_SCREEN_R_MIN = 6;
const CLUE_DOT_LABEL_SCREEN_PX = 12;
const CLUE_DOT_BORDER_SCREEN_PX = 2;
const CLUE_DOT_LABEL_MARGIN_TOP_PX = 5;
const CLUE_DOT_LABEL_MAX_WIDTH_PX = 120;
const ZOOM_WHEEL_SENS = 0.0012;
const ZOOM_TOAST_MS = 2500;
/** Leaflet easeLinearity；初速 = 甩动速度 × LINEARITY */
const PAN_EASE_LINEARITY = 0.32;
/** 防快速甩动时飞太远（px/s） */
const PAN_INERTIA_MAX_SPEED = 1500;
const PAN_MIN_VELOCITY = 8;
const PAN_SAMPLE_WINDOW_MS = 50;
/** 与 canvas font-size 1em 对齐；视口网格间距 = 本值 × zoom */
const CLUE_GRID_BASE_PX = 14;
/** 与 index.html `.notes-clue-canvas` / `.notes-clue-text` 基准字号对齐 */
const CLUE_CANVAS_FONT_PX = 14;
const CLUE_TEXT_FONT_PX = 13;
const CLUE_TEXT_MIN_FONT_PX = 8;
const CLUE_NODE_PAD_PX = 8;
/** 内容区最小高度 = 便签最小高度 − 上下 padding，保证视觉四边 8px 一致 */
const CLUE_TEXT_MIN_H_PX = CLUE_MIN_H - CLUE_NODE_PAD_PX * 2;
const CLUE_DEFAULT_MAX_W = 240;
const TEXT_HISTORY_DEBOUNCE_MS = 500;
let nodes: ClueNode[] = [];
let edges: ClueEdge[] = [];
let boards: ClueBoard[] = [];
let clueAppsHosted = false;

/** Fired after the board registry UI would refresh (switch / rename / create / load). */
export const CLUE_BOARDS_UI_EVENT = "omnitrace-clue-boards-changed";

export type ClueBoardSummary = { id: string; title: string };

export function setClueAppsHosted(v: boolean) {
  clueAppsHosted = v;
  const view = document.getElementById("notes-clue-board-view");
  if (!view) return;
  if (v) view.dataset.appsHost = "1";
  else delete view.dataset.appsHost;
}

export function isClueAppsHosted(): boolean {
  return clueAppsHosted;
}

export function listClueBoardSummaries(): ClueBoardSummary[] {
  return boards.map((b) => ({ id: b.id, title: boardDisplayTitle(b) }));
}

export function getActiveClueBoardId(): string {
  return activeBoardId;
}

export async function switchClueBoard(id: string): Promise<void> {
  await switchBoard(id);
}

export async function createClueBoard(): Promise<string> {
  await createBoard();
  return activeBoardId;
}

export async function deleteClueBoard(id: string): Promise<void> {
  await deleteBoard(id);
}

export function renameClueBoard(id: string, title: string): void {
  const board = boards.find((b) => b.id === id);
  if (!board) return;
  const next = title.trim();
  if (next === board.title) {
    renderBoardList();
    return;
  }
  board.title = next;
  recordClueHistory(CLUE_HISTORY_LABELS.renameBoard);
  renderBoardList();
  scheduleSave();
}

let activeBoardId = "";
const selectedIds = new Set<string>();
const selectedEdgeIds = new Set<string>();
let pendingFrom: string | null = null;
let pendingPt: { x: number; y: number } | null = null;
let pendingClient: { x: number; y: number } | null = null;
let saveTimer = 0;
/** Bumped on disk reload so an in-flight persist cannot apply a stale snapshot. */
let persistGen = 0;
let drawRaf = 0;
let inited = false;
let loaded = false;

type GripPressState = {
  ids: string[];
  startX: number;
  startY: number;
  origins: Map<string, { x: number; y: number }>;
  pointerId: number;
  moved: boolean;
  el: HTMLElement;
  gripEl: HTMLElement;
};

type ResizeState = {
  ids: string[];
  startX: number;
  startY: number;
  origins: Map<string, { w: number; h: number }>;
  handleEl: HTMLElement;
  pointerId: number;
};

type PanState = {
  startX: number;
  startY: number;
  origPanX: number;
  origPanY: number;
  pointerId: number;
};

type MarqueeState = {
  startX: number;
  startY: number;
  pointerId: number;
};

type EdgePressState = {
  edgeId: string;
  startX: number;
  startY: number;
  pointerId: number;
  button: number;
  additive: boolean;
};

type LeftPressState = {
  startX: number;
  startY: number;
  pointerId: number;
  didPan: boolean;
};

type RightPressState = {
  startX: number;
  startY: number;
  pointerId: number;
  didMarquee: boolean;
};

let gripPress: GripPressState | null = null;
/** 左键拖把手时按住右键平移视口：记录上一帧 client，松右键即停（无惯性）。 */
let gripPanLast: { x: number; y: number } | null = null;
let resize: ResizeState | null = null;
let panX = 0;
let panY = 0;
let zoom = 1;
let panVelX = 0;
let panVelY = 0;
let inertiaV0X = 0;
let inertiaV0Y = 0;
let inertiaElapsed = 0;
let panSamples: Array<{ x: number; y: number; t: number }> = [];
let inertiaRaf = 0;
let inertiaLast = 0;
let panState: PanState | null = null;
let marqueeState: MarqueeState | null = null;
let marqueeEl: HTMLElement | null = null;
let edgePress: EdgePressState | null = null;
let suppressBoardClick = false;
let leftPress: LeftPressState | null = null;
let rightPress: RightPressState | null = null;
let ctxMenuEl: HTMLElement | null = null;
let ctxMenuCanvasPt: { x: number; y: number } | null = null;
let ctxMenuEdgeId: string | null = null;
let textCtxMenuEl: HTMLElement | null = null;
let textCtxTarget: HTMLTextAreaElement | null = null;
let zoomToastTimer = 0;
let clueModeActive = false;
let suppressNativeMenuUntil = 0;
const SUPPRESS_NATIVE_MENU_MS = 600;
let textHistoryTimer = 0;

function syncSelectionClasses() {
  document.querySelectorAll(".notes-clue-node").forEach((el) => {
    const id = (el as HTMLElement).dataset.clueId;
    el.classList.toggle("is-selected", id != null && selectedIds.has(id));
  });
}

function boardDisplayTitle(board: ClueBoard): string {
  const title = board.title.trim();
  return title || shellT("notes.clue.boards.untitled");
}

function syncCurrentBoardToStore() {
  const board = boards.find((b) => b.id === activeBoardId);
  if (!board) return;
  board.nodes = nodes;
  board.edges = edges;
  board.view = { x: panX, y: panY, zoom };
}

function currentClueSnapshot(): ClueBoardSnapshot {
  const board = boards.find((b) => b.id === activeBoardId);
  return captureClueSnapshot(
    nodes,
    edges,
    panX,
    panY,
    zoom,
    board?.title ?? ""
  );
}

function recordClueHistory(label: HistoryLabel) {
  pushClueHistory(label, currentClueSnapshot());
}

function restoreFromSnapshot(snap: ClueBoardSnapshot) {
  nodes = normalizeLoadedNodes(snap.nodes ?? []);
  edges = snap.edges ?? [];
  clearSelection();
  cancelWirePick();
  stopPanInertia();
  panX = snap.panX;
  panY = snap.panY;
  zoom = clampZoom(snap.zoom);
  const board = boards.find((b) => b.id === activeBoardId);
  if (board && snap.title != null) {
    board.title = snap.title;
  }
  applyPanTransform();
  renderNodes();
  renderBoardList();
  scheduleDrawClueWires();
  scheduleSave();
}

function flushTextHistoryTimer() {
  if (!textHistoryTimer) return;
  window.clearTimeout(textHistoryTimer);
  textHistoryTimer = 0;
  recordClueHistory(CLUE_HISTORY_LABELS.editText);
}

function scheduleTextHistory() {
  if (textHistoryTimer) window.clearTimeout(textHistoryTimer);
  textHistoryTimer = window.setTimeout(() => {
    textHistoryTimer = 0;
    recordClueHistory(CLUE_HISTORY_LABELS.editText);
  }, TEXT_HISTORY_DEBOUNCE_MS);
}

function applyBoardData(board: ClueBoard) {
  nodes = normalizeLoadedNodes(board.nodes ?? []);
  edges = board.edges ?? [];
  clearSelection();
  cancelWirePick();
  stopPanInertia();
  if (
    board.view &&
    Number.isFinite(board.view.x) &&
    Number.isFinite(board.view.y)
  ) {
    panX = board.view.x;
    panY = board.view.y;
    zoom = clampZoom(board.view.zoom ?? 1);
  } else {
    panX = 0;
    panY = 0;
    zoom = 1;
  }
  applyPanTransform();
  renderNodes();
  scheduleDrawClueWires();
}

function boardListEl(): HTMLElement | null {
  return $("notes-clue-board-list");
}

let boardListMenuEl: HTMLDivElement | null = null;
let boardListMultiMode = false;
const selectedBoardIds = new Set<string>();

function setBoardListMultiMode(on: boolean) {
  boardListMultiMode = on;
  document.body.classList.toggle("clue-board-multiselect", on);
  if (!on) selectedBoardIds.clear();
  renderBoardList();
}

function toggleBoardListSelection(id: string) {
  if (selectedBoardIds.has(id)) selectedBoardIds.delete(id);
  else selectedBoardIds.add(id);
  renderBoardList();
}

function hideBoardListMenu() {
  const el = boardListMenuEl;
  boardListMenuEl = null;
  if (!el) return;
  hideFloat(el);
  window.setTimeout(() => el.remove(), 200);
}

function showBoardListMenu(clientX: number, clientY: number, board: ClueBoard) {
  hideBoardListMenu();
  hideClueContextMenu();
  hideGroupMetaPopover();
  if (boardListMultiMode && !selectedBoardIds.has(board.id)) {
    selectedBoardIds.add(board.id);
    renderBoardList();
  }
  const menu = document.createElement("div");
  menu.className = "omni-float notes-preset-ctx-menu";
  menu.setAttribute("role", "menu");

  const detailsBtn = document.createElement("button");
  detailsBtn.type = "button";
  detailsBtn.className = "notes-preset-ctx-item";
  detailsBtn.setAttribute("role", "menuitem");
  detailsBtn.textContent = shellT("notes.groupMeta.details");
  detailsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    hideBoardListMenu();
    showGroupMetaPopover({
      clientX,
      clientY,
      title: boardDisplayTitle(board),
      createdAt: board.created_at,
      updatedAt: board.updated_at,
    });
  });
  menu.appendChild(detailsBtn);

  const multiBtn = document.createElement("button");
  multiBtn.type = "button";
  multiBtn.className = "notes-preset-ctx-item";
  multiBtn.setAttribute("role", "menuitem");
  multiBtn.textContent = boardListMultiMode
    ? shellT("notes.clue.boards.multiSelectOff")
    : shellT("notes.clue.boards.multiSelect");
  multiBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    hideBoardListMenu();
    if (boardListMultiMode) {
      setBoardListMultiMode(false);
    } else {
      selectedBoardIds.add(board.id);
      setBoardListMultiMode(true);
    }
  });
  menu.appendChild(multiBtn);

  const selectedCount = selectedBoardIds.size;
  const canDeleteMany =
    boardListMultiMode && selectedCount > 0 && boards.length > 1;
  if (canDeleteMany) {
    const delSel = document.createElement("button");
    delSel.type = "button";
    delSel.className = "notes-preset-ctx-item is-danger";
    delSel.setAttribute("role", "menuitem");
    delSel.textContent = shellT("notes.clue.boards.deleteSelected");
    delSel.addEventListener("click", (e) => {
      e.stopPropagation();
      hideBoardListMenu();
      void deleteSelectedBoards();
    });
    menu.appendChild(delSel);
  } else if (boards.length > 1) {
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "notes-preset-ctx-item is-danger";
    delBtn.setAttribute("role", "menuitem");
    delBtn.textContent = shellT("notes.groupMeta.delete");
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      hideBoardListMenu();
      void deleteBoard(board.id);
    });
    menu.appendChild(delBtn);
  }

  document.body.appendChild(menu);
  revealFloat(menu);
  placeFloatAtPoint(menu, clientX, clientY);
  requestAnimationFrame(() => placeFloatAtPoint(menu, clientX, clientY));
  boardListMenuEl = menu;
  const onDoc = (ev: MouseEvent) => {
    if (ev.target instanceof Node && menu.contains(ev.target)) return;
    hideBoardListMenu();
    document.removeEventListener("mousedown", onDoc, true);
  };
  document.addEventListener("mousedown", onDoc, true);
}

function renderBoardList() {
  const host = boardListEl();
  if (!host) return;
  hideBoardListMenu();
  host.replaceChildren();
  for (const board of boards) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "notes-clue-board-item";
    item.dataset.boardId = board.id;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", board.id === activeBoardId ? "true" : "false");
    item.title = shellT("notes.clue.boards.renameHint");
    item.classList.toggle("is-active", board.id === activeBoardId);
    const checked = selectedBoardIds.has(board.id);
    item.classList.toggle("is-checked", checked);

    const check = document.createElement("span");
    check.className = "notes-clue-board-item-check";
    check.setAttribute("aria-hidden", "true");
    item.appendChild(check);

    const name = document.createElement("span");
    name.className = "notes-clue-board-item-name";
    name.textContent = boardDisplayTitle(board);
    item.appendChild(name);

    host.appendChild(item);
  }
  window.dispatchEvent(new CustomEvent(CLUE_BOARDS_UI_EVENT));
}

async function flushSave(): Promise<void> {
  if (saveTimer) {
    window.clearTimeout(saveTimer);
    saveTimer = 0;
  }
  syncCurrentBoardToStore();
  await persistNow();
}

async function switchBoard(id: string) {
  if (!id || id === activeBoardId) return;
  // Flush pending text edits onto the current board's history, then leave.
  // Navigation itself must NOT become a history step (Photoshop-style per board).
  flushTextHistoryTimer();
  await flushSave();
  const board = boards.find((b) => b.id === id);
  if (!board) return;
  activeBoardId = id;
  applyBoardData(board);
  await setClueHistoryBoard(activeBoardId, currentClueSnapshot());
  renderBoardList();
  scheduleSave();
}

async function createBoard() {
  flushTextHistoryTimer();
  await flushSave();
  const id = newId("board");
  const now = Date.now();
  const board: ClueBoard = {
    id,
    title: "",
    nodes: [],
    edges: [],
    view: { x: 0, y: 0, zoom: 1 },
    created_at: now,
    updated_at: now,
  };
  boards.push(board);
  activeBoardId = id;
  applyBoardData(board);
  await setClueHistoryBoard(activeBoardId, currentClueSnapshot());
  // Seed this board's own history only (ensure may already write `initial`).
  recordClueHistory(CLUE_HISTORY_LABELS.newBoard);
  renderBoardList();
  scheduleSave();
}

async function deleteBoard(id: string) {
  if (boards.length <= 1) return;
  if (!window.confirm(shellT("notes.clue.boards.deleteConfirm"))) return;
  if (activeBoardId === id) {
    flushTextHistoryTimer();
  }
  await flushSave();
  clearClueHistoryBoard(id);
  const wasViewing = activeBoardId === id;
  try {
    await invoke("notes_clue_history_delete", { boardId: id });
  } catch {
    /* ignore */
  }
  try {
    const saved = await invoke<ClueBoardsFile>("notes_clue_board_delete", {
      boardId: id,
    });
    if (saved?.boards) {
      boards = saved.boards;
      activeBoardId = saved.active_id || boards[0]?.id || "";
    } else {
      boards = boards.filter((b) => b.id !== id);
    }
  } catch (e) {
    console.error(e);
    showHint(t("删除失败", "Delete failed"));
    return;
  }
  if (wasViewing || !boards.some((b) => b.id === activeBoardId)) {
    activeBoardId = boards.some((b) => b.id === activeBoardId)
      ? activeBoardId
      : boards[0]?.id ?? "";
    const next = boards.find((b) => b.id === activeBoardId);
    if (next) {
      applyBoardData(next);
      await setClueHistoryBoard(activeBoardId, currentClueSnapshot());
    }
  }
  renderBoardList();
}

async function deleteSelectedBoards() {
  const ids = [...selectedBoardIds].filter((id) => boards.some((b) => b.id === id));
  const keep = boards.length - ids.length;
  if (ids.length === 0 || keep < 1) return;
  if (
    !window.confirm(
      shellT("notes.clue.boards.deleteSelectedConfirm", { n: String(ids.length) })
    )
  ) {
    return;
  }
  for (const id of ids) {
    if (boards.length <= 1) break;
    if (activeBoardId === id) flushTextHistoryTimer();
    await flushSave();
    clearClueHistoryBoard(id);
    try {
      await invoke("notes_clue_history_delete", { boardId: id });
    } catch {
      /* ignore */
    }
    try {
      const saved = await invoke<ClueBoardsFile>("notes_clue_board_delete", {
        boardId: id,
      });
      if (saved?.boards) {
        boards = saved.boards;
        activeBoardId = saved.active_id || boards[0]?.id || "";
      } else {
        boards = boards.filter((b) => b.id !== id);
      }
    } catch (e) {
      console.error(e);
      showHint(t("删除失败", "Delete failed"));
      break;
    }
  }
  selectedBoardIds.clear();
  setBoardListMultiMode(false);
  const next = boards.find((b) => b.id === activeBoardId) ?? boards[0];
  if (next) {
    activeBoardId = next.id;
    applyBoardData(next);
    await setClueHistoryBoard(activeBoardId, currentClueSnapshot());
  }
  renderBoardList();
}

function beginRenameBoard(id: string, item: HTMLElement) {
  const board = boards.find((b) => b.id === id);
  if (!board) return;
  const nameEl = item.querySelector(".notes-clue-board-item-name");
  if (!(nameEl instanceof HTMLElement)) return;
  const input = document.createElement("input");
  input.type = "text";
  input.className = "notes-clue-board-item-rename";
  input.value = board.title;
  input.maxLength = 120;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  const commit = () => {
    const next = input.value.trim();
    if (next !== board.title) {
      board.title = next;
      recordClueHistory(CLUE_HISTORY_LABELS.renameBoard);
    }
    renderBoardList();
    scheduleSave();
  };
  input.addEventListener("blur", () => commit(), { once: true });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      input.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      input.value = board.title;
      input.blur();
    }
  });
}

function onBoardListClick(e: MouseEvent) {
  const item = (e.target as HTMLElement).closest(
    ".notes-clue-board-item"
  ) as HTMLElement | null;
  const id = item?.dataset.boardId;
  if (!id) return;
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    if (!boardListMultiMode) {
      selectedBoardIds.add(activeBoardId);
      if (id !== activeBoardId) selectedBoardIds.add(id);
      setBoardListMultiMode(true);
      return;
    }
    toggleBoardListSelection(id);
    return;
  }
  if (boardListMultiMode) {
    toggleBoardListSelection(id);
    return;
  }
  void switchBoard(id);
}

function onBoardListContextMenu(e: MouseEvent) {
  const item = (e.target as HTMLElement).closest(
    ".notes-clue-board-item"
  ) as HTMLElement | null;
  const id = item?.dataset.boardId;
  if (!id) return;
  const board = boards.find((b) => b.id === id);
  if (!board) return;
  e.preventDefault();
  e.stopPropagation();
  showBoardListMenu(e.clientX, e.clientY, board);
}

function onBoardListDblClick(e: MouseEvent) {
  const item = (e.target as HTMLElement).closest(
    ".notes-clue-board-item"
  ) as HTMLElement | null;
  const id = item?.dataset.boardId;
  if (!id) return;
  beginRenameBoard(id, item);
}

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}


function t(zh: string, en: string): string {
  return uiLang() === "zh" ? zh : en;
}

function newId(prefix: string): string {
  const ts = Date.now();
  const n = (ts ^ (ts >> 11)) & 0xffff;
  return `${prefix}_${ts}_${n.toString(16).padStart(4, "0")}`;
}

function boardEl(): HTMLElement | null {
  return $("notes-clue-board");
}

function canvasEl(): HTMLElement | null {
  return $("notes-clue-canvas");
}

function panEl(): HTMLElement | null {
  return $("notes-clue-pan");
}

function nodesHost(): HTMLElement | null {
  return $("notes-clue-nodes");
}

function wireLayer(): SVGSVGElement | null {
  return $("notes-clue-wire-layer") as SVGSVGElement | null;
}

function wireDraw(): SVGGElement | null {
  return $("notes-clue-wire-draw") as SVGGElement | null;
}

function nodeById(id: string): ClueNode | undefined {
  return nodes.find((n) => n.id === id);
}

function layoutPx(v: number): number {
  return v * zoom;
}

function dotScreenRadius(): number {
  return Math.max(layoutPx(CLUE_DOT_R), CLUE_DOT_SCREEN_R_MIN);
}

function dotLabelFontPx(): number {
  return Math.max(layoutPx(11), CLUE_DOT_LABEL_SCREEN_PX);
}

function isDotMode(): boolean {
  return zoom <= ZOOM_DOT_MODE;
}

function clueDotLabel(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "…";
  return [...trimmed].slice(0, CLUE_DOT_LABEL_MAX).join("");
}

function nodeLogicalSize(n: ClueNode, el?: HTMLElement | null): { w: number; h: number } {
  if (el && !isDotMode()) {
    const w = el.offsetWidth / Math.max(zoom, 1e-6);
    const h = el.offsetHeight / Math.max(zoom, 1e-6);
    if (w > 0 && h > 0) return { w, h };
  }
  return {
    w: n.w ?? CLUE_DEFAULT_MAX_W,
    h: n.h ?? CLUE_MIN_H,
  };
}

function nodeLogicalCenter(n: ClueNode, el?: HTMLElement | null): { cx: number; cy: number } {
  const { w, h } = nodeLogicalSize(n, el);
  return { cx: n.x + w / 2, cy: n.y + h / 2 };
}

function syncDotModeClass() {
  const dot = isDotMode();
  boardEl()?.classList.toggle("is-dot-mode", dot);
  canvasEl()?.classList.toggle("is-dot-mode", dot);
  if (dot) clearPortHover();
}

function clueTextFontPx(): number {
  return Math.max(CLUE_TEXT_MIN_FONT_PX, Math.round(CLUE_TEXT_FONT_PX * zoom));
}

function clueCanvasFontPx(): number {
  return Math.max(CLUE_TEXT_MIN_FONT_PX, Math.round(CLUE_CANVAS_FONT_PX * zoom));
}

function portLayoutCenter(id: string): { x: number; y: number } | null {
  const n = nodeById(id);
  const el = document.querySelector(
    `.notes-clue-node[data-clue-id="${CSS.escape(id)}"]`
  ) as HTMLElement | null;
  if (!n || !el) return null;
  const cr = canvasEl()?.getBoundingClientRect();
  if (!cr) return null;
  if (isDotMode()) {
    const dot = el.querySelector(".notes-clue-dot") as HTMLElement | null;
    if (dot) {
      const dr = dot.getBoundingClientRect();
      return {
        x: dr.left + dr.width / 2 - cr.left,
        y: dr.top + dr.height / 2 - cr.top,
      };
    }
    const center = nodeLogicalCenter(n, el);
    return { x: layoutPx(center.cx), y: layoutPx(center.cy) };
  }
  const port = el.querySelector(".notes-clue-port") as HTMLElement | null;
  if (!port) return null;
  const pr = port.getBoundingClientRect();
  return {
    x: pr.left + pr.width / 2 - cr.left,
    y: pr.top + pr.height / 2 - cr.top,
  };
}

function portGeometry(id: string): { x: number; y: number; r: number } | null {
  const center = portLayoutCenter(id);
  if (!center) return null;
  return {
    x: center.x,
    y: center.y,
    r: isDotMode() ? dotScreenRadius() : layoutPx(portRadius()),
  };
}

function portPos(id: string): { x: number; y: number } | null {
  const g = portGeometry(id);
  return g ? { x: g.x, y: g.y } : null;
}

function clueBoardCssPx(name: string, fallback: number): number {
  const board = boardEl();
  if (!board) return fallback;
  const v = getComputedStyle(board).getPropertyValue(name).trim();
  if (!v) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

function portRadius(): number {
  return clueBoardCssPx("--notes-clue-port-r", 6);
}

function portHitRadius(): number {
  return clueBoardCssPx("--notes-clue-port-hit", 16);
}

function wirePointOnPortEdge(
  center: { x: number; y: number },
  toward: { x: number; y: number },
  radius: number
): { x: number; y: number } {
  const dx = toward.x - center.x;
  const dy = toward.y - center.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return center;
  const inset = radius + WIRE_PORT_GAP;
  return {
    x: center.x + (dx / len) * inset,
    y: center.y + (dy / len) * inset,
  };
}

function shortenWireEndpoints(
  geomA: { x: number; y: number; r: number },
  geomB: { x: number; y: number; r: number }
): { a: { x: number; y: number }; b: { x: number; y: number } } {
  return {
    a: wirePointOnPortEdge(geomA, geomB, geomA.r),
    b: wirePointOnPortEdge(geomB, geomA, geomB.r),
  };
}

function portPickupAtClient(clientX: number, clientY: number): string | null {
  const hitR = portHitRadius();
  let best: { id: string; d: number } | null = null;
  for (const n of nodes) {
    const el = document.querySelector(
      `.notes-clue-node[data-clue-id="${CSS.escape(n.id)}"]`
    ) as HTMLElement | null;
    if (!el) continue;
    const anchor = isDotMode()
      ? (el.querySelector(".notes-clue-dot") as HTMLElement | null)
      : (el.querySelector(".notes-clue-port") as HTMLElement | null);
    if (!anchor) continue;
    const ar = anchor.getBoundingClientRect();
    const cx = ar.left + ar.width / 2;
    const cy = ar.top + ar.height / 2;
    const d = Math.hypot(clientX - cx, clientY - cy);
    if (d <= hitR && (!best || d < best.d)) best = { id: n.id, d };
  }
  return best?.id ?? null;
}

function portPickupFromTarget(target: EventTarget | null): string | null {
  const el = (target as Element | null)?.closest?.(
    ".notes-clue-port-pickup-hit"
  ) as SVGElement | null;
  return el?.dataset.clueId ?? null;
}

function tryPortPickupFromEvent(e: PointerEvent | MouseEvent): boolean {
  const id = portPickupFromTarget(e.target) ?? portPickupAtClient(e.clientX, e.clientY);
  if (!id) return false;
  e.preventDefault();
  e.stopPropagation();
  clearEdgePress();
  onPortClick(id, e.clientX, e.clientY);
  suppressBoardClick = true;
  return true;
}

function syncPortClasses() {
  document.querySelectorAll(".notes-clue-node").forEach((el) => {
    const id = (el as HTMLElement).dataset.clueId;
    if (!id) return;
    const linked = edges.some((e) => e.from === id || e.to === id);
    const hot = pendingFrom === id;
    const port = el.querySelector(".notes-clue-port");
    if (port) {
      port.classList.toggle("is-linked", linked);
      port.classList.toggle("is-hot", hot);
    }
    const dot = el.querySelector(".notes-clue-dot");
    if (dot) {
      dot.classList.toggle("is-linked", linked);
      dot.classList.toggle("is-hot", hot);
    }
  });
}

function portElForClueId(id: string): HTMLElement | null {
  return document.querySelector(
    `.notes-clue-node[data-clue-id="${CSS.escape(id)}"] .notes-clue-port`
  ) as HTMLElement | null;
}

function clearPortHover() {
  document.querySelectorAll(".notes-clue-port.is-hover").forEach((el) => {
    el.classList.remove("is-hover");
  });
}

function setPortHover(id: string | null) {
  document.querySelectorAll(".notes-clue-port.is-hover").forEach((el) => {
    const nodeId = (el.closest(".notes-clue-node") as HTMLElement | null)?.dataset.clueId;
    if (nodeId !== id) el.classList.remove("is-hover");
  });
  if (id && !isDotMode()) portElForClueId(id)?.classList.add("is-hover");
}

function onWirePortPickupPointerOver(e: PointerEvent) {
  if (isDotMode()) return;
  const hit = (e.target as Element | null)?.closest?.(".notes-clue-port-pickup-hit");
  if (!hit) return;
  const id = (hit as SVGElement).dataset.clueId;
  if (id) setPortHover(id);
}

function onWirePortPickupPointerOut(e: PointerEvent) {
  if (isDotMode()) return;
  const hit = (e.target as Element | null)?.closest?.(".notes-clue-port-pickup-hit");
  if (!hit) return;
  const related = e.relatedTarget as Element | null;
  if (related?.closest?.(".notes-clue-port-pickup-hit")) return;
  if (related?.closest?.(".notes-clue-port")) return;
  clearPortHover();
}

function canvasBounds(): { w: number; h: number } {
  const board = boardEl();
  const baseW = board?.clientWidth ?? 800;
  const baseH = board?.clientHeight ?? 600;
  let maxX = baseW;
  let maxY = baseH;
  for (const n of nodes) {
    const el = document.querySelector(
      `.notes-clue-node[data-clue-id="${CSS.escape(n.id)}"]`
    ) as HTMLElement | null;
    const nw = el?.offsetWidth ?? layoutPx(n.w ?? 200);
    const nh = el?.offsetHeight ?? layoutPx(n.h ?? 100);
    maxX = Math.max(maxX, layoutPx(n.x) + nw + layoutPx(120));
    maxY = Math.max(maxY, layoutPx(n.y) + nh + layoutPx(120));
  }
  return { w: maxX, h: maxY };
}

function snapZoom(z: number): number {
  return Math.round(z / ZOOM_STEP) * ZOOM_STEP;
}

function clampZoom(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return snapZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z)));
}

function stopPanInertia() {
  if (inertiaRaf) {
    window.cancelAnimationFrame(inertiaRaf);
    inertiaRaf = 0;
  }
  panVelX = 0;
  panVelY = 0;
  inertiaV0X = 0;
  inertiaV0Y = 0;
  inertiaElapsed = 0;
  panSamples = [];
  inertiaLast = 0;
}

function prunePanSamples(now: number) {
  while (panSamples.length > 1 && now - panSamples[0].t > PAN_SAMPLE_WINDOW_MS) {
    panSamples.shift();
  }
}

function recordPanSample() {
  const now = performance.now();
  panSamples.push({ x: panX, y: panY, t: now });
  prunePanSamples(now);
}

/** Leaflet Map.Drag：最近 50ms 位移 × easeLinearity → 初速（px/s） */
function computeReleaseVelocity(): { vx: number; vy: number } {
  prunePanSamples(performance.now());
  if (panSamples.length < 2) return { vx: 0, vy: 0 };
  const first = panSamples[0];
  const last = panSamples[panSamples.length - 1];
  const durationSec = (last.t - first.t) / 1000;
  if (durationSec <= 0) return { vx: 0, vy: 0 };
  let vx = ((last.x - first.x) / durationSec) * PAN_EASE_LINEARITY;
  let vy = ((last.y - first.y) / durationSec) * PAN_EASE_LINEARITY;
  const speed = Math.hypot(vx, vy);
  if (speed > PAN_INERTIA_MAX_SPEED) {
    const scale = PAN_INERTIA_MAX_SPEED / speed;
    vx *= scale;
    vy *= scale;
  }
  return { vx, vy };
}

function tickPanInertia(t: number) {
  if (!inertiaLast) inertiaLast = t;
  const dt = Math.min(48, t - inertiaLast);
  inertiaLast = t;
  const dtSec = dt / 1000;
  inertiaElapsed += dtSec;
  const duration = getPanInertiaDuration();
  const tNorm = duration > 0 ? Math.min(1, inertiaElapsed / duration) : 1;
  const factor = evaluatePanCurve(tNorm);
  panVelX = inertiaV0X * factor;
  panVelY = inertiaV0Y * factor;
  panX += panVelX * dtSec;
  panY += panVelY * dtSec;
  applyPanTransform();
  refreshPendingPt();
  scheduleDrawClueWires();
  const speed = Math.hypot(panVelX, panVelY);
  if (speed > PAN_MIN_VELOCITY && tNorm < 1 && factor > 0.02) {
    inertiaRaf = window.requestAnimationFrame(tickPanInertia);
  } else {
    panVelX = 0;
    panVelY = 0;
    inertiaRaf = 0;
    inertiaLast = 0;
    inertiaElapsed = 0;
    panSamples = [];
    scheduleSave();
  }
}

function startPanInertia() {
  const { vx, vy } = computeReleaseVelocity();
  if (Math.hypot(vx, vy) <= PAN_MIN_VELOCITY) return;
  if (inertiaRaf) {
    window.cancelAnimationFrame(inertiaRaf);
    inertiaRaf = 0;
  }
  inertiaV0X = vx;
  inertiaV0Y = vy;
  panVelX = vx;
  panVelY = vy;
  inertiaElapsed = 0;
  panSamples = [];
  inertiaLast = performance.now();
  inertiaRaf = window.requestAnimationFrame(tickPanInertia);
}

function snapPanAxis(v: number): number {
  const dpr = window.devicePixelRatio || 1;
  return Math.round(v * dpr) / dpr;
}

function modPositive(v: number, period: number): number {
  if (period <= 0) return 0;
  return ((v % period) + period) % period;
}

/**
 * 视口上画无限网格，但偏移与 #notes-clue-pan 的 translate 同号：
 * screen = world*zoom + pan → 地面钉在世界坐标，拖拽像相机相对地面移动（地图手感）。
 */
function applyViewportGrid() {
  const board = boardEl();
  if (!board) return;
  const period = CLUE_GRID_BASE_PX * zoom;
  const tx = snapPanAxis(panX);
  const ty = snapPanAxis(panY);
  board.style.setProperty("--notes-clue-grid-size", `${period}px`);
  board.style.setProperty("--notes-clue-grid-pos-x", `${modPositive(tx, period)}px`);
  board.style.setProperty("--notes-clue-grid-pos-y", `${modPositive(ty, period)}px`);
  // 纸纹 tile 180px，用完整 pan 取模，勿与网格 period 混用
  board.style.setProperty("--notes-clue-paper-pos-x", `${modPositive(tx, 180)}px`);
  board.style.setProperty("--notes-clue-paper-pos-y", `${modPositive(ty, 180)}px`);
}

function applyDotNodeLayout(el: HTMLElement, n: ClueNode) {
  const center = nodeLogicalCenter(n, el);
  const dotR = dotScreenRadius();
  const dotSize = dotR * 2;
  el.style.left = `${layoutPx(center.cx) - dotR}px`;
  el.style.top = `${layoutPx(center.cy) - dotR}px`;
  el.style.width = `${dotSize}px`;
  el.style.height = `${dotSize}px`;
  el.style.minWidth = "0";
  el.style.minHeight = "0";
  el.style.maxWidth = "none";
  el.style.padding = "0";

  const dot = el.querySelector(".notes-clue-dot") as HTMLElement | null;
  if (dot) {
    dot.style.width = `${dotSize}px`;
    dot.style.height = `${dotSize}px`;
    dot.style.borderWidth = `${CLUE_DOT_BORDER_SCREEN_PX}px`;
  }

  const label = el.querySelector(".notes-clue-dot-label") as HTMLElement | null;
  if (label) {
    label.textContent = clueDotLabel(n.text);
    label.style.fontSize = `${dotLabelFontPx()}px`;
    label.style.marginTop = `${CLUE_DOT_LABEL_MARGIN_TOP_PX}px`;
    label.style.maxWidth = `${CLUE_DOT_LABEL_MAX_WIDTH_PX}px`;
  }
}

function applyNodeLayout(el: HTMLElement, n: ClueNode) {
  if (isDotMode()) {
    applyDotNodeLayout(el, n);
    return;
  }

  const sized = n.w != null && Number.isFinite(n.w);
  el.style.left = `${layoutPx(n.x)}px`;
  el.style.top = `${layoutPx(n.y)}px`;
  el.style.padding = `${layoutPx(CLUE_NODE_PAD_PX)}px`;
  el.style.minWidth = `${layoutPx(CLUE_MIN_W)}px`;
  el.style.minHeight = `${layoutPx(CLUE_MIN_H)}px`;
  if (sized) {
    el.style.maxWidth = "";
    el.style.width = `${layoutPx(n.w!)}px`;
  } else {
    el.style.maxWidth = `${layoutPx(CLUE_DEFAULT_MAX_W)}px`;
    el.style.width = "";
  }
  if (n.h != null && Number.isFinite(n.h)) {
    el.style.height = `${layoutPx(n.h)}px`;
  } else {
    el.style.height = "";
  }

  const port = el.querySelector(".notes-clue-port") as HTMLElement | null;
  if (port) {
    port.style.width = `${layoutPx(12)}px`;
    port.style.height = `${layoutPx(12)}px`;
    port.style.top = `${layoutPx(-10)}px`;
    port.style.borderWidth = `${Math.max(1, layoutPx(2))}px`;
  }

  const del = el.querySelector(".notes-clue-del") as HTMLElement | null;
  if (del) {
    const delSize = layoutPx(20);
    const delGap = layoutPx(5);
    del.style.width = `${delSize}px`;
    del.style.height = `${delSize}px`;
    del.style.fontSize = `${layoutPx(14)}px`;
    del.style.top = `${delGap}px`;
    del.style.right = `${-delGap - delSize}px`;
    del.style.left = "";
    del.style.transform = "";
    del.style.borderRadius = `${layoutPx(5)}px`;
    del.style.borderWidth = `${Math.max(1, layoutPx(1))}px`;
  }

  const resizeEl = el.querySelector(".notes-clue-resize") as HTMLElement | null;
  if (resizeEl) {
    const resizeHit = layoutPx(14);
    const resizeArm = layoutPx(8);
    const resizeLine = Math.max(1, layoutPx(1.5));
    const resizeOffset = layoutPx(-1);
    resizeEl.style.left = "100%";
    resizeEl.style.top = "100%";
    resizeEl.style.bottom = "";
    resizeEl.style.right = "";
    resizeEl.style.setProperty("--notes-clue-resize-hit", `${resizeHit}px`);
    resizeEl.style.setProperty("--notes-clue-resize-arm", `${resizeArm}px`);
    resizeEl.style.setProperty("--notes-clue-resize-line", `${resizeLine}px`);
    resizeEl.style.setProperty("--notes-clue-resize-offset", `${resizeOffset}px`);
  }

  const grip = el.querySelector(".notes-clue-grip") as HTMLElement | null;
  if (grip) {
    const dot = Math.max(1, layoutPx(2));
    const gap = Math.max(1, layoutPx(2));
    const padX = layoutPx(5);
    const dotsW = 3 * dot + 2 * gap;
    const gripW = Math.max(dotsW + padX * 2, layoutPx(24));
    const gripH = Math.ceil(gripW / 2);
    grip.style.setProperty("--notes-clue-grip-width", `${gripW}px`);
    grip.style.setProperty("--notes-clue-grip-height", `${gripH}px`);
    grip.style.setProperty("--notes-clue-grip-dot", `${dot}px`);
    grip.style.setProperty("--notes-clue-grip-gap", `${gap}px`);
    grip.style.right = "-1px";
  }

  const ta = el.querySelector(".notes-clue-text") as HTMLTextAreaElement | null;
  if (ta) {
    ta.style.fontSize = `${clueTextFontPx()}px`;
    ta.style.minHeight = `${layoutPx(CLUE_TEXT_MIN_H_PX)}px`;
  }
}

/** 布局级 zoom：坐标与字号按 zoom 重排，不用 CSS zoom / transform scale 压字 */
function applyClueLayoutZoom() {
  const canvas = canvasEl();
  if (canvas) canvas.style.fontSize = `${clueCanvasFontPx()}px`;
  document.querySelectorAll(".notes-clue-node").forEach((el) => {
    const id = (el as HTMLElement).dataset.clueId;
    if (resize && id && resize.ids.includes(id)) return;
    const n = id ? nodeById(id) : undefined;
    if (n) applyNodeLayout(el as HTMLElement, n);
  });
  const empty = $("notes-clue-empty");
  if (empty) {
    empty.style.fontSize = `${clueCanvasFontPx()}px`;
    empty.style.padding = `${layoutPx(24)}px`;
  }
}

function applyPanTransform() {
  const pan = panEl();
  if (!pan) return;
  const tx = snapPanAxis(panX);
  const ty = snapPanAxis(panY);
  pan.style.transform = `translate3d(${tx}px, ${ty}px, 0)`;
  applyViewportGrid();
  syncDotModeClass();
  applyClueLayoutZoom();
}

function clearPanState() {
  panState = null;
  boardEl()?.classList.remove("is-panning");
}

function clientToCanvas(clientX: number, clientY: number): { x: number; y: number } {
  const board = boardEl();
  if (!board) return { x: 0, y: 0 };
  const br = board.getBoundingClientRect();
  const z = Math.max(zoom, 1e-6);
  return {
    x: (clientX - br.left - panX) / z,
    y: (clientY - br.top - panY) / z,
  };
}

function scheduleSave() {
  if (saveTimer) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = 0;
    void persistNow();
  }, SAVE_DEBOUNCE_MS);
}

function normalizeLoadedNodes(raw: Array<ClueNode & { rotation?: number }>): ClueNode[] {
  return (raw ?? []).map(({ rotation: _rot, ...n }) => {
    const out: ClueNode = {
      id: n.id,
      text: n.text ?? "",
      x: n.x,
      y: n.y,
    };
    if (n.color != null && n.color !== "") out.color = n.color;
    if (n.w != null && Number.isFinite(n.w)) {
      out.w = Math.min(CLUE_MAX_W, Math.max(CLUE_MIN_W, n.w));
    }
    if (n.h != null && Number.isFinite(n.h)) {
      out.h = Math.min(CLUE_MAX_H, Math.max(CLUE_MIN_H, n.h));
    }
    return out;
  });
}

async function persistNow() {
  syncCurrentBoardToStore();
  const gen = persistGen;
  const viewing = activeBoardId;
  try {
    const saved = await invoke<ClueBoardsFile>("notes_clue_board_save", {
      data: {
        v: 2,
        active_id: activeBoardId,
        boards,
      } satisfies ClueBoardsFile,
    });
    if (gen !== persistGen) return;
    if (saved?.boards?.length) {
      const localById = new Map(boards.map((b) => [b.id, b]));
      boards = saved.boards.map((sb) => {
        const local = localById.get(sb.id);
        if (local && sb.id === viewing) {
          return {
            ...local,
            created_at: sb.created_at,
            updated_at: sb.updated_at,
          };
        }
        return sb;
      });
      for (const local of localById.values()) {
        if (!boards.some((b) => b.id === local.id)) boards.push(local);
      }
      if (viewing && boards.some((b) => b.id === viewing)) {
        activeBoardId = viewing;
      }
      const diskView = saved.boards.find((b) => b.id === activeBoardId);
      if (diskView) {
        const extraNodes = normalizeLoadedNodes(diskView.nodes ?? []);
        const seenN = new Set(nodes.map((n) => n.id));
        let extra = false;
        for (const n of extraNodes) {
          if (!seenN.has(n.id)) {
            nodes.push(n);
            extra = true;
          }
        }
        const seenE = new Set(edges.map((e) => e.id));
        for (const e of diskView.edges ?? []) {
          if (e?.id && !seenE.has(e.id)) {
            edges.push(e);
            extra = true;
          }
        }
        if (extra) {
          syncCurrentBoardToStore();
          renderNodes();
          scheduleDrawClueWires();
          updateEmptyState();
        }
      }
      renderBoardList();
    }
  } catch (e) {
    console.error(e);
    const msg = e instanceof Error ? e.message : String(e);
    showHint(t(`保存失败：${msg}`, `Save failed: ${msg}`));
  }
}

function updateEmptyState() {
  const empty = $("notes-clue-empty");
  if (!empty) return;
  empty.classList.toggle("hidden", nodes.length > 0);
}

function showHint(msg: string) {
  const el = $("notes-clue-hint");
  if (!el) return;
  el.textContent = msg;
  el.classList.add("is-visible");
  window.setTimeout(() => el.classList.remove("is-visible"), 2000);
}

function showZoomToast() {
  const el = $("notes-clue-zoom-toast");
  if (!el) return;
  const pct = Math.round(zoom * 100);
  el.textContent = `${pct}%`;
  el.setAttribute("aria-hidden", "false");
  el.classList.add("is-visible");
  if (zoomToastTimer) window.clearTimeout(zoomToastTimer);
  zoomToastTimer = window.setTimeout(() => {
    zoomToastTimer = 0;
    el.classList.remove("is-visible");
    el.setAttribute("aria-hidden", "true");
  }, ZOOM_TOAST_MS);
}

/** Frame all notes into the current board viewport (pan + zoom). */
function fitClueViewToContent() {
  const board = boardEl();
  if (!board || nodes.length === 0) {
    stopPanInertia();
    panX = 0;
    panY = 0;
    zoom = 1;
    return;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of nodes) {
    const { w, h } = nodeLogicalSize(n);
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + w);
    maxY = Math.max(maxY, n.y + h);
  }
  const pad = 48;
  const vw = Math.max(160, board.clientWidth);
  const vh = Math.max(120, board.clientHeight);
  const cw = Math.max(1, maxX - minX);
  const ch = Math.max(1, maxY - minY);
  const z = clampZoom(Math.min((vw - pad * 2) / cw, (vh - pad * 2) / ch, 1));
  stopPanInertia();
  zoom = z;
  panX = (vw - cw * z) / 2 - minX * z;
  panY = (vh - ch * z) / 2 - minY * z;
}

function resetClueView() {
  fitClueViewToContent();
  applyPanTransform();
  refreshPendingPt();
  scheduleDrawClueWires();
  scheduleSave();
  showZoomToast();
}

function refreshPendingPt() {
  if (!pendingFrom || !pendingClient) return;
  pendingPt = clientToCanvas(pendingClient.x, pendingClient.y);
}

function onWirePointerMove(e: PointerEvent) {
  if (!pendingFrom) return;
  pendingClient = { x: e.clientX, y: e.clientY };
  refreshPendingPt();
  scheduleDrawClueWires();
}

function pickUpWire(fromId: string, clientX: number, clientY: number) {
  pendingFrom = fromId;
  pendingClient = { x: clientX, y: clientY };
  refreshPendingPt();
  document.body.classList.add("is-clue-wiring");
  scheduleDrawClueWires();
  syncPortClasses();
  showHint(t("再点另一枚圆点完成连线", "Click another port to connect"));
}

function cancelWirePick() {
  pendingFrom = null;
  pendingPt = null;
  pendingClient = null;
  document.body.classList.remove("is-clue-wiring");
  syncPortClasses();
  scheduleDrawClueWires();
}

function clearMarqueeState() {
  marqueeState = null;
  if (marqueeEl) {
    marqueeEl.classList.remove("is-active");
    marqueeEl.style.width = "0";
    marqueeEl.style.height = "0";
  }
  boardEl()?.classList.remove("is-marqueeing");
}

function ensureMarqueeEl(): HTMLElement | null {
  if (marqueeEl) return marqueeEl;
  const board = boardEl();
  if (!board) return null;
  marqueeEl = document.createElement("div");
  marqueeEl.className = "notes-clue-marquee";
  marqueeEl.setAttribute("aria-hidden", "true");
  board.appendChild(marqueeEl);
  return marqueeEl;
}

function boardPoint(clientX: number, clientY: number): { x: number; y: number } {
  const board = boardEl();
  if (!board) return { x: 0, y: 0 };
  const br = board.getBoundingClientRect();
  return { x: clientX - br.left, y: clientY - br.top };
}

function nodeBoardRect(n: ClueNode): { left: number; top: number; right: number; bottom: number } | null {
  const el = document.querySelector(
    `.notes-clue-node[data-clue-id="${CSS.escape(n.id)}"]`
  ) as HTMLElement | null;
  if (isDotMode()) {
    const { w, h } = nodeLogicalSize(n, el);
    return {
      left: layoutPx(n.x) + panX,
      top: layoutPx(n.y) + panY,
      right: layoutPx(n.x + w) + panX,
      bottom: layoutPx(n.y + h) + panY,
    };
  }
  if (!el) return null;
  return {
    left: layoutPx(n.x) + panX,
    top: layoutPx(n.y) + panY,
    right: layoutPx(n.x) + panX + el.offsetWidth,
    bottom: layoutPx(n.y) + panY + el.offsetHeight,
  };
}

function rectsIntersect(
  a: { left: number; top: number; right: number; bottom: number },
  b: { left: number; top: number; right: number; bottom: number }
): boolean {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function nodesInMarquee(
  x0: number,
  y0: number,
  x1: number,
  y1: number
): string[] {
  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  const right = Math.max(x0, x1);
  const bottom = Math.max(y0, y1);
  const marquee = { left, top, right, bottom };
  const hits: string[] = [];
  for (const n of nodes) {
    const nr = nodeBoardRect(n);
    if (nr && rectsIntersect(marquee, nr)) hits.push(n.id);
  }
  return hits;
}

function updateMarqueeVisual(x0: number, y0: number, x1: number, y1: number) {
  const el = ensureMarqueeEl();
  if (!el) return;
  const left = Math.min(x0, x1);
  const top = Math.min(y0, y1);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  el.style.width = `${Math.abs(x1 - x0)}px`;
  el.style.height = `${Math.abs(y1 - y0)}px`;
  el.classList.add("is-active");
}

function isBoardInteractiveTarget(target: HTMLElement): boolean {
  return !!target.closest(
    ".notes-clue-toolbar, .notes-clue-history-panel, .notes-clue-history-tools, button, textarea, .notes-clue-grip, .notes-clue-resize, .notes-clue-dot"
  );
}

function extendSuppressNativeMenu(ms = SUPPRESS_NATIVE_MENU_MS) {
  suppressNativeMenuUntil = Math.max(
    suppressNativeMenuUntil,
    performance.now() + ms
  );
}

function shouldSuppressNativeClueMenu(): boolean {
  if (marqueeState) return true;
  if (rightPress?.didMarquee) return true;
  if (gripPress || gripPanLast) return true;
  return performance.now() < suppressNativeMenuUntil;
}

function isClueTextarea(target: HTMLElement): HTMLTextAreaElement | null {
  return target.closest("textarea.notes-clue-text") as HTMLTextAreaElement | null;
}

function isClueBoardSurfaceTarget(target: HTMLElement): boolean {
  return !!target.closest(
    "#notes-clue-board-view, #notes-clue-board, #notes-clue-pan, #notes-clue-canvas, .notes-clue-node, .notes-clue-port, .notes-clue-wire-layer, .notes-clue-marquee"
  );
}

function blockClueNativePointerDown(e: PointerEvent) {
  if (e.button !== 2) return;
  const target = e.target as HTMLElement;
  if (isClueTextarea(target)) return;
  e.preventDefault();
}

/** 线索板内右键：拦截 WebView 默认菜单并弹出自定义项（空白/连线/便签 textarea）。 */
function handleClueContextMenu(e: MouseEvent): boolean {
  if (!clueModeActive) return false;
  const target = e.target as HTMLElement;
  if (target.closest(".notes-clue-board-item, #notes-clue-board-list, .notes-preset-ctx-menu, #notes-group-meta-pop")) {
    return false;
  }
  if (shouldSuppressNativeClueMenu()) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    return true;
  }
  const ta = isClueTextarea(target);
  if (ta) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    hideClueContextMenu();
    showTextareaContextMenu(e, ta);
    return true;
  }
  const edgeHit = edgeHitFromTarget(target);
  const edgeId = edgeHit?.dataset.edgeId;
  if (edgeId) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    selectEdge(edgeId);
    showEdgeClueContextMenu(e.clientX, e.clientY, edgeId);
    suppressBoardClick = true;
    return true;
  }
  if (!isClueBoardSurfaceTarget(target)) return false;
  if (isBoardInteractiveTarget(target)) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    return true;
  }
  e.preventDefault();
  e.stopPropagation();
  e.stopImmediatePropagation();
  hideClueContextMenu();
  showBlankClueContextMenu(e.clientX, e.clientY);
  suppressBoardClick = true;
  return true;
}

function onDocClueContextMenuCapture(e: Event) {
  handleClueContextMenu(e as MouseEvent);
}

function onDocCluePointerDownCapture(e: PointerEvent) {
  if (!clueModeActive || e.button !== 2) return;
  const target = e.target as HTMLElement;
  if (!isClueBoardSurfaceTarget(target)) return;
  if (isClueTextarea(target)) return;
  e.preventDefault();
}

function edgeHitFromTarget(target: EventTarget | null): SVGPathElement | null {
  return (target as Element | null)?.closest?.(".notes-clue-edge-hit") as SVGPathElement | null;
}

function clearEdgePress() {
  edgePress = null;
  window.removeEventListener("pointerup", onEdgePointerUp);
  window.removeEventListener("pointercancel", onEdgePointerUp);
}

function onEdgePointerUp(e: PointerEvent) {
  if (!edgePress || e.pointerId !== edgePress.pointerId) return;
  window.removeEventListener("pointerup", onEdgePointerUp);
  window.removeEventListener("pointercancel", onEdgePointerUp);
  const dx = e.clientX - edgePress.startX;
  const dy = e.clientY - edgePress.startY;
  const edgeId = edgePress.edgeId;
  const additive = edgePress.additive;
  edgePress = null;
  if (pendingFrom) return;
  if (tryPortPickupFromEvent(e)) return;
  if (dx * dx + dy * dy <= PAN_CLICK_SLOP * PAN_CLICK_SLOP) {
    if (additive) toggleSelectEdge(edgeId);
    else selectEdge(edgeId);
    suppressBoardClick = true;
  }
}

function onWireEdgePointerDown(e: PointerEvent) {
  if (e.button === 2) {
    blockClueNativePointerDown(e);
    if (tryPortPickupFromEvent(e)) return;
    const hit = edgeHitFromTarget(e.target);
    const edgeId = hit?.dataset.edgeId;
    if (!hit || !edgeId) return;
    e.preventDefault();
    e.stopPropagation();
    hideClueContextMenu();
    clearEdgePress();
    edgePress = {
      edgeId,
      startX: e.clientX,
      startY: e.clientY,
      pointerId: e.pointerId,
      button: 2,
      additive: e.ctrlKey || e.metaKey,
    };
    window.addEventListener("pointerup", onEdgePointerUp);
    window.addEventListener("pointercancel", onEdgePointerUp);
    return;
  }
  if (e.button !== 0) return;
  if (tryPortPickupFromEvent(e)) return;
  if (pendingFrom) return;
  const hit = edgeHitFromTarget(e.target);
  const edgeId = hit?.dataset.edgeId;
  if (!hit || !edgeId) return;
  e.preventDefault();
  e.stopPropagation();
  clearEdgePress();
  edgePress = {
    edgeId,
    startX: e.clientX,
    startY: e.clientY,
    pointerId: e.pointerId,
    button: 0,
    additive: e.ctrlKey || e.metaKey,
  };
  window.addEventListener("pointerup", onEdgePointerUp);
  window.addEventListener("pointercancel", onEdgePointerUp);
}

function selectEdge(id: string | null) {
  if (pendingFrom) cancelWirePick();
  selectedEdgeIds.clear();
  if (id) selectedEdgeIds.add(id);
  selectedIds.clear();
  syncSelectionClasses();
  scheduleDrawClueWires();
}

function toggleSelectEdge(id: string) {
  if (pendingFrom) cancelWirePick();
  if (selectedEdgeIds.has(id)) selectedEdgeIds.delete(id);
  else selectedEdgeIds.add(id);
  selectedIds.clear();
  syncSelectionClasses();
  scheduleDrawClueWires();
}

function selectNode(id: string | null) {
  if (pendingFrom) cancelWirePick();
  selectedIds.clear();
  if (id) selectedIds.add(id);
  selectedEdgeIds.clear();
  syncSelectionClasses();
  scheduleDrawClueWires();
}

function toggleSelectNode(id: string) {
  if (pendingFrom) cancelWirePick();
  if (selectedIds.has(id)) selectedIds.delete(id);
  else selectedIds.add(id);
  selectedEdgeIds.clear();
  syncSelectionClasses();
  scheduleDrawClueWires();
}

function selectNodes(ids: string[]) {
  if (pendingFrom) cancelWirePick();
  selectedIds.clear();
  for (const id of ids) selectedIds.add(id);
  selectedEdgeIds.clear();
  syncSelectionClasses();
  scheduleDrawClueWires();
}

function clearSelection() {
  selectedIds.clear();
  selectedEdgeIds.clear();
  syncSelectionClasses();
  scheduleDrawClueWires();
}

function hideClueContextMenu() {
  if (!ctxMenuEl) return;
  hideFloat(ctxMenuEl);
  ctxMenuCanvasPt = null;
  ctxMenuEdgeId = null;
}

function hideTextareaContextMenu() {
  textCtxTarget = null;
  if (!textCtxMenuEl) return;
  hideFloat(textCtxMenuEl);
}

function ensureTextareaContextMenu(): HTMLElement {
  if (textCtxMenuEl) return textCtxMenuEl;
  const menu = document.createElement("div");
  menu.id = "notes-clue-text-ctx-menu";
  menu.className = "omni-float notes-clue-ctx-menu hidden";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-hidden", "true");

  for (const [action, zh, en] of [
    ["cut", "剪切", "Cut"],
    ["copy", "复制", "Copy"],
    ["paste", "粘贴", "Paste"],
  ] as const) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.action = action;
    btn.setAttribute("role", "menuitem");
    btn.textContent = t(zh, en);
    menu.appendChild(btn);
  }

  document.body.appendChild(menu);
  menu.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button[data-action]") as
      | HTMLButtonElement
      | null;
    if (!btn || btn.disabled || !textCtxTarget) return;
    e.stopPropagation();
    const ta = textCtxTarget;
    hideTextareaContextMenu();
    ta.focus();
    if (btn.dataset.action === "cut") document.execCommand("cut");
    else if (btn.dataset.action === "copy") document.execCommand("copy");
    else if (btn.dataset.action === "paste") document.execCommand("paste");
  });
  textCtxMenuEl = menu;
  return menu;
}

function refreshTextareaContextMenuState(ta: HTMLTextAreaElement) {
  const menu = ensureTextareaContextMenu();
  const hasSelection =
    ta.selectionStart != null &&
    ta.selectionEnd != null &&
    ta.selectionStart !== ta.selectionEnd;
  const cutBtn = menu.querySelector<HTMLButtonElement>('button[data-action="cut"]');
  const copyBtn = menu.querySelector<HTMLButtonElement>('button[data-action="copy"]');
  const pasteBtn = menu.querySelector<HTMLButtonElement>('button[data-action="paste"]');
  if (cutBtn) cutBtn.disabled = !hasSelection;
  if (copyBtn) copyBtn.disabled = !hasSelection && ta.value.length === 0;
  if (pasteBtn) pasteBtn.disabled = false;
}

function showTextareaContextMenu(e: MouseEvent, ta: HTMLTextAreaElement) {
  const menu = ensureTextareaContextMenu();
  textCtxTarget = ta;
  refreshTextareaContextMenuState(ta);
  revealFloat(menu);
  placeFloatAtPoint(menu, e.clientX, e.clientY);
  requestAnimationFrame(() => placeFloatAtPoint(menu, e.clientX, e.clientY));
}

function ensureClueContextMenu(): HTMLElement {
  if (ctxMenuEl) return ctxMenuEl;
  const menu = document.createElement("div");
  menu.id = "notes-clue-ctx-menu";
  menu.className = "omni-float notes-clue-ctx-menu hidden";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-hidden", "true");

  const newNoteBtn = document.createElement("button");
  newNoteBtn.type = "button";
  newNoteBtn.dataset.action = "new-note";
  newNoteBtn.setAttribute("role", "menuitem");
  newNoteBtn.textContent = shellT("notes.clue.ctx.newNote");

  const delEdgeBtn = document.createElement("button");
  delEdgeBtn.type = "button";
  delEdgeBtn.dataset.action = "delete-edge";
  delEdgeBtn.setAttribute("role", "menuitem");
  delEdgeBtn.textContent = shellT("notes.clue.ctx.deleteEdge");

  menu.append(newNoteBtn, delEdgeBtn);
  document.body.appendChild(menu);

  menu.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button[data-action]") as
      | HTMLButtonElement
      | null;
    if (!btn || btn.disabled) return;
    e.stopPropagation();
    const action = btn.dataset.action;
    const pt = ctxMenuCanvasPt;
    const edgeId = ctxMenuEdgeId;
    hideClueContextMenu();
    if (action === "new-note" && pt) addClueNodeAt(pt.x, pt.y);
    else if (action === "delete-edge" && edgeId) deleteEdgeById(edgeId);
  });

  ctxMenuEl = menu;
  return menu;
}

function refreshClueContextMenuLabels() {
  const menu = ensureClueContextMenu();
  const newNoteBtn = menu.querySelector<HTMLButtonElement>('button[data-action="new-note"]');
  const delEdgeBtn = menu.querySelector<HTMLButtonElement>('button[data-action="delete-edge"]');
  if (newNoteBtn) newNoteBtn.textContent = shellT("notes.clue.ctx.newNote");
  if (delEdgeBtn) delEdgeBtn.textContent = shellT("notes.clue.ctx.deleteEdge");
}

function openClueContextMenu(clientX: number, clientY: number, mode: "blank" | "edge") {
  const menu = ensureClueContextMenu();
  refreshClueContextMenuLabels();
  const newNoteBtn = menu.querySelector<HTMLButtonElement>('button[data-action="new-note"]');
  const delEdgeBtn = menu.querySelector<HTMLButtonElement>('button[data-action="delete-edge"]');
  if (newNoteBtn) newNoteBtn.hidden = mode !== "blank";
  if (delEdgeBtn) delEdgeBtn.hidden = mode !== "edge";
  revealFloat(menu);
  placeFloatAtPoint(menu, clientX, clientY);
  requestAnimationFrame(() => placeFloatAtPoint(menu, clientX, clientY));
}

function showBlankClueContextMenu(clientX: number, clientY: number) {
  ctxMenuCanvasPt = clientToCanvas(clientX, clientY);
  ctxMenuEdgeId = null;
  openClueContextMenu(clientX, clientY, "blank");
}

function showEdgeClueContextMenu(clientX: number, clientY: number, edgeId: string) {
  ctxMenuCanvasPt = null;
  ctxMenuEdgeId = edgeId;
  openClueContextMenu(clientX, clientY, "edge");
}

function clearLeftPressState() {
  leftPress = null;
  window.removeEventListener("pointermove", onLeftPointerMove);
  window.removeEventListener("pointerup", onLeftPointerUp);
  window.removeEventListener("pointercancel", onLeftPointerUp);
}

function clearRightPressState() {
  rightPress = null;
  window.removeEventListener("pointermove", onRightPointerMove);
  window.removeEventListener("pointerup", onRightPointerUp);
  window.removeEventListener("pointercancel", onRightPointerUp);
}

function clampSize(w: number, h: number): { w: number; h: number } {
  return {
    w: Math.min(CLUE_MAX_W, Math.max(CLUE_MIN_W, w)),
    h: Math.min(CLUE_MAX_H, Math.max(CLUE_MIN_H, h)),
  };
}

function endGripPan() {
  if (!gripPanLast) return;
  gripPanLast = null;
  if (!panState) boardEl()?.classList.remove("is-panning");
  extendSuppressNativeMenu();
}

function cancelGripPress() {
  endGripPan();
  if (!gripPress) return;
  gripPress.gripEl.classList.remove("is-grabbing");
  gripPress = null;
}

function beginGripPan(e: PointerEvent) {
  if (!gripPress || gripPanLast) return;
  extendSuppressNativeMenu();
  stopPanInertia();
  clearRightPressState();
  clearMarqueeState();
  hideClueContextMenu();
  gripPanLast = { x: e.clientX, y: e.clientY };
  boardEl()?.classList.add("is-panning");
}

function onGripPointerMove(e: PointerEvent) {
  if (!gripPress || e.pointerId !== gripPress.pointerId) return;
  // 拖把手时按住右键：平移视口，并补偿 start 使便签仍跟手
  if (gripPanLast && e.buttons & 2) {
    const dpx = e.clientX - gripPanLast.x;
    const dpy = e.clientY - gripPanLast.y;
    gripPanLast = { x: e.clientX, y: e.clientY };
    if (dpx || dpy) {
      panX += dpx;
      panY += dpy;
      gripPress.startX += dpx;
      gripPress.startY += dpy;
      applyPanTransform();
      refreshPendingPt();
    }
  } else if (gripPanLast) {
    endGripPan();
  }
  const dx = e.clientX - gripPress.startX;
  const dy = e.clientY - gripPress.startY;
  if (Math.abs(dx) > 3 || Math.abs(dy) > 3) gripPress.moved = true;
  for (const id of gripPress.ids) {
    const hit = nodeById(id);
    const orig = gripPress.origins.get(id);
    const el = document.querySelector(
      `.notes-clue-node[data-clue-id="${CSS.escape(id)}"]`
    ) as HTMLElement | null;
    if (!hit || !orig || !el) continue;
    hit.x = orig.x + dx / zoom;
    hit.y = orig.y + dy / zoom;
    applyNodeLayout(el, hit);
  }
  scheduleDrawClueWires();
}

function beginNodeDrag(
  wrap: HTMLElement,
  gripEl: HTMLElement,
  nodeId: string,
  e: PointerEvent
): boolean {
  if (e.button !== 0) return false;
  if (pendingFrom) cancelWirePick();
  stopPanInertia();
  if (e.ctrlKey || e.metaKey) {
    toggleSelectNode(nodeId);
    if (!selectedIds.has(nodeId)) return false;
  } else if (!selectedIds.has(nodeId)) {
    selectNode(nodeId);
  }
  cancelGripPress();
  gripEl.classList.add("is-grabbing");
  const dragIds =
    selectedIds.has(nodeId) && selectedIds.size > 1 ? [...selectedIds] : [nodeId];
  const origins = new Map<string, { x: number; y: number }>();
  for (const id of dragIds) {
    const hit = nodeById(id);
    if (hit) origins.set(id, { x: hit.x, y: hit.y });
  }
  gripPress = {
    ids: dragIds,
    startX: e.clientX,
    startY: e.clientY,
    origins,
    pointerId: e.pointerId,
    moved: false,
    el: wrap,
    gripEl,
  };
  gripEl.setPointerCapture(e.pointerId);
  window.addEventListener("pointermove", onGripPointerMove);
  window.addEventListener("pointerup", onGripPointerUp);
  window.addEventListener("pointercancel", onGripPointerUp);
  return true;
}

function onGripPointerUp(e: PointerEvent) {
  if (!gripPress || e.pointerId !== gripPress.pointerId) return;
  // 同 pointer 上松右键：只结束把手期间的视口平移
  if (e.button === 2) {
    endGripPan();
    return;
  }
  if (e.button !== 0 && e.type !== "pointercancel") return;
  window.removeEventListener("pointermove", onGripPointerMove);
  window.removeEventListener("pointerup", onGripPointerUp);
  window.removeEventListener("pointercancel", onGripPointerUp);
  try {
    gripPress.gripEl.releasePointerCapture(e.pointerId);
  } catch {
    /* already released */
  }
  const { moved } = gripPress;
  cancelGripPress();
  if (moved) {
    recordClueHistory(CLUE_HISTORY_LABELS.moveNode);
    scheduleSave();
  }
}

function applyResizeVisual(el: HTMLElement, w: number, h: number) {
  el.classList.add("has-size");
  el.style.maxWidth = "none";
  el.style.width = `${layoutPx(w)}px`;
  el.style.height = `${layoutPx(h)}px`;
}

function nodeElById(id: string): HTMLElement | null {
  return document.querySelector(
    `.notes-clue-node[data-clue-id="${CSS.escape(id)}"]`
  ) as HTMLElement | null;
}

function onResizePointerMove(e: PointerEvent) {
  if (!resize || e.pointerId !== resize.pointerId) return;
  const dx = (e.clientX - resize.startX) / zoom;
  const dy = (e.clientY - resize.startY) / zoom;
  for (const id of resize.ids) {
    const hit = nodeById(id);
    const orig = resize.origins.get(id);
    const el = nodeElById(id);
    if (!hit || !orig || !el) continue;
    const next = clampSize(orig.w + dx, orig.h + dy);
    hit.w = next.w;
    hit.h = next.h;
    applyResizeVisual(el, next.w, next.h);
  }
  scheduleDrawClueWires();
}

function onResizePointerUp(e: PointerEvent) {
  if (!resize || e.pointerId !== resize.pointerId) return;
  window.removeEventListener("pointermove", onResizePointerMove);
  window.removeEventListener("pointerup", onResizePointerUp);
  window.removeEventListener("pointercancel", onResizePointerUp);
  try {
    resize.handleEl.releasePointerCapture(e.pointerId);
  } catch {
    /* already released */
  }
  for (const id of resize.ids) {
    const hit = nodeById(id);
    const el = nodeElById(id);
    if (hit && el) applyNodeLayout(el, hit);
  }
  resize = null;
  recordClueHistory(CLUE_HISTORY_LABELS.resizeNode);
  scheduleSave();
}

function renderNodes() {
  const host = nodesHost();
  if (!host) return;
  host.innerHTML = "";
  for (const n of nodes) {
    const wrap = document.createElement("div");
    wrap.className = "notes-clue-node";
    wrap.dataset.clueId = n.id;
    if (n.w != null && Number.isFinite(n.w)) wrap.classList.add("has-size");
    if (n.h != null && Number.isFinite(n.h)) wrap.classList.add("has-size");
    if (selectedIds.has(n.id)) wrap.classList.add("is-selected");

    const port = document.createElement("button");
    port.type = "button";
    port.className = "notes-clue-port";
    port.title = t("点击圆点拿起红线，再点另一枚圆点连接", "Click port, then another port to link");
    port.setAttribute("aria-label", t("连线", "Link"));

    const grip = document.createElement("div");
    grip.className = "notes-clue-grip";
    grip.title = t("把手：拖动便签", "Handle: drag note");
    grip.setAttribute("aria-label", t("把手", "Handle"));
    const gripCap = document.createElement("span");
    gripCap.className = "notes-clue-grip-cap";
    gripCap.setAttribute("aria-hidden", "true");
    const gripDots = document.createElement("span");
    gripDots.className = "notes-clue-grip-dots";
    gripDots.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 6; i++) {
      const dot = document.createElement("span");
      dot.className = "notes-clue-grip-dot";
      gripDots.appendChild(dot);
    }
    grip.append(gripCap, gripDots);

    const del = document.createElement("button");
    del.type = "button";
    del.className = "notes-clue-del";
    del.title = t("删除线索", "Delete clue");
    del.setAttribute("aria-label", t("删除", "Delete"));
    del.textContent = "×";

    const ta = document.createElement("textarea");
    ta.className = "notes-clue-text";
    ta.value = n.text;
    ta.placeholder = t("写下线索…", "Write a clue…");
    ta.rows = 3;

    const resizeHandle = document.createElement("div");
    resizeHandle.className = "notes-clue-resize";
    resizeHandle.title = t("拖动调整大小", "Drag to resize");
    resizeHandle.setAttribute("aria-label", t("调整大小", "Resize"));

    const dotEl = document.createElement("div");
    dotEl.className = "notes-clue-dot";
    dotEl.title = t("点击圆点拿起红线，再点另一枚圆点连接", "Click port, then another port to link");
    dotEl.setAttribute("aria-label", t("线索节点", "Clue node"));

    const dotLabel = document.createElement("div");
    dotLabel.className = "notes-clue-dot-label";
    dotLabel.setAttribute("aria-hidden", "true");

    ta.addEventListener("input", () => {
      const hit = nodeById(n.id);
      if (hit) {
        hit.text = ta.value;
        scheduleSave();
        scheduleTextHistory();
      }
      dotLabel.textContent = clueDotLabel(ta.value);
    });
    ta.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      if (pendingFrom) cancelWirePick();
      if (e.button !== 0) return;
      if (e.ctrlKey || e.metaKey) toggleSelectNode(n.id);
      else selectNode(n.id);
    });
    ta.addEventListener("focus", () => {
      if (pendingFrom) cancelWirePick();
      if (!selectedIds.has(n.id)) selectNode(n.id);
    });
    ta.addEventListener("dblclick", (e) => e.stopPropagation());

    port.addEventListener("pointerdown", (e) => {
      if (e.button === 2) blockClueNativePointerDown(e);
    });
    port.addEventListener("contextmenu", onClueViewContextMenu);
    port.addEventListener("pointerenter", () => {
      if (!isDotMode()) port.classList.add("is-hover");
    });
    port.addEventListener("pointerleave", () => {
      port.classList.remove("is-hover");
    });

    port.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onPortClick(n.id, e.clientX, e.clientY);
    });

    dotEl.addEventListener("contextmenu", onClueViewContextMenu);
    dotEl.addEventListener("pointerdown", (e) => {
      if (e.button === 2) {
        e.preventDefault();
        e.stopPropagation();
        if (gripPress) beginGripPan(e);
        else blockClueNativePointerDown(e);
        return;
      }
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      beginNodeDrag(wrap, dotEl, n.id, e);
    });
    dotEl.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (pendingFrom) {
        onPortClick(n.id, e.clientX, e.clientY);
        return;
      }
      if (selectedIds.has(n.id) && !e.ctrlKey && !e.metaKey) {
        onPortClick(n.id, e.clientX, e.clientY);
        return;
      }
      if (e.ctrlKey || e.metaKey) toggleSelectNode(n.id);
      else selectNode(n.id);
    });

    del.addEventListener("click", (e) => {
      e.stopPropagation();
      deleteNode(n.id);
    });

    grip.addEventListener("pointerdown", (e) => {
      if (e.button === 2) {
        e.preventDefault();
        e.stopPropagation();
        if (gripPress) beginGripPan(e);
        else blockClueNativePointerDown(e);
        return;
      }
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      beginNodeDrag(wrap, grip, n.id, e);
    });

    resizeHandle.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 || isDotMode()) return;
      e.preventDefault();
      e.stopPropagation();
      if (pendingFrom) cancelWirePick();
      // 与拖把手一致：已在多选内则保留，否则单选本便签
      if (!selectedIds.has(n.id)) selectNode(n.id);
      const resizeIds =
        selectedIds.has(n.id) && selectedIds.size > 1 ? [...selectedIds] : [n.id];
      const origins = new Map<string, { w: number; h: number }>();
      for (const id of resizeIds) {
        const hit = nodeById(id);
        const el = id === n.id ? wrap : nodeElById(id);
        if (!hit || !el) continue;
        const size = nodeLogicalSize(hit, el);
        origins.set(id, size);
        applyResizeVisual(el, size.w, size.h);
      }
      resize = {
        ids: resizeIds,
        startX: e.clientX,
        startY: e.clientY,
        origins,
        handleEl: resizeHandle,
        pointerId: e.pointerId,
      };
      resizeHandle.setPointerCapture(e.pointerId);
      window.addEventListener("pointermove", onResizePointerMove);
      window.addEventListener("pointerup", onResizePointerUp);
      window.addEventListener("pointercancel", onResizePointerUp);
    });

    wrap.addEventListener("contextmenu", onClueViewContextMenu);

    wrap.addEventListener("click", (e) => {
      if (
        (e.target as HTMLElement).closest(
          "button, textarea, .notes-clue-grip, .notes-clue-resize, .notes-clue-dot"
        )
      ) {
        return;
      }
      if (e.ctrlKey || e.metaKey) toggleSelectNode(n.id);
      else selectNode(n.id);
    });

    wrap.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest("textarea, button, .notes-clue-grip, .notes-clue-resize, .notes-clue-dot")) return;
      if (pendingFrom) cancelWirePick();
      deleteNode(n.id);
    });

    wrap.append(port, grip, del, ta, resizeHandle, dotEl, dotLabel);
    applyNodeLayout(wrap, n);
    host.appendChild(wrap);
  }
  syncPortClasses();
  updateEmptyState();
  applyClueLayoutZoom();
}

function cablePath(a: { x: number; y: number }, b: { x: number; y: number }): string {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2 - layoutPx(BULGE);
  return `M ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${mx.toFixed(1)} ${my.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
}

export function scheduleDrawClueWires() {
  if (drawRaf) return;
  drawRaf = window.requestAnimationFrame(() => {
    drawRaf = 0;
    drawClueWires();
  });
}

export function drawClueWires() {
  const svg = wireLayer();
  const g = wireDraw();
  const canvas = canvasEl();
  if (!svg || !g || !canvas) return;
  const { w, h } = canvasBounds();
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.style.width = `${w}px`;
  svg.style.height = `${h}px`;
  canvas.style.width = `${w}px`;
  canvas.style.minHeight = `${h}px`;

  const parts: string[] = [
    `<defs>` +
      `<marker id="clue-arrowhead" markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#b33b3b"/></marker>` +
      `<marker id="clue-arrowhead-sel" markerWidth="8" markerHeight="8" refX="8" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#0078d4"/></marker>` +
      `</defs>`,
  ];

  for (const e of edges) {
    const ga = portGeometry(e.from);
    const gb = portGeometry(e.to);
    if (!ga || !gb) continue;
    const { a, b } = shortenWireEndpoints(ga, gb);
    const d = cablePath(a, b);
    const sel = selectedEdgeIds.has(e.id);
    const edgeCls = sel ? "notes-clue-edge is-selected" : "notes-clue-edge";
    const stroke = sel ? "#0078d4" : "#b33b3b";
    const sw = (sel ? 2.8 : 1.6) * zoom;
    const marker = sel ? "url(#clue-arrowhead-sel)" : "url(#clue-arrowhead)";
    parts.push(
      `<path class="${edgeCls}" d="${d}" fill="none" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round" marker-end="${marker}"/>` +
        `<path class="notes-clue-edge-hit${sel ? " is-selected" : ""}" data-edge-id="${e.id}" d="${d}" fill="none" stroke="transparent" stroke-width="12"/>`
    );
  }

  if (pendingFrom && pendingPt) {
    const fromGeom = portGeometry(pendingFrom);
    if (fromGeom) {
      const pendingLayout = { x: layoutPx(pendingPt.x), y: layoutPx(pendingPt.y) };
      const from = wirePointOnPortEdge(fromGeom, pendingLayout, fromGeom.r);
      const d = cablePath(from, pendingLayout);
      parts.push(
        `<path d="${d}" fill="none" stroke="#b33b3b" stroke-width="${(1.6 * zoom).toFixed(2)}" stroke-dasharray="${(5 * zoom).toFixed(1)} ${(4 * zoom).toFixed(1)}" stroke-opacity="0.85" marker-end="url(#clue-arrowhead)"/>`
      );
    }
  }

  const pickupR = portHitRadius();
  for (const n of nodes) {
    const p = portPos(n.id);
    if (!p) continue;
    if (isDotMode() && !pendingFrom) continue;
    parts.push(
      `<circle class="notes-clue-port-pickup-hit" data-clue-id="${n.id}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${pickupR.toFixed(2)}" fill="transparent"/>`
    );
  }

  g.innerHTML = parts.join("");
}

function onPortClick(id: string, clientX: number, clientY: number) {
  if (!pendingFrom) {
    pickUpWire(id, clientX, clientY);
    return;
  }
  if (pendingFrom === id) {
    cancelWirePick();
    return;
  }
  const dup = edges.some((e) => e.from === pendingFrom && e.to === id);
  if (dup) {
    showHint(t("这两枚之间已有箭头", "Arrow already exists"));
    cancelWirePick();
    return;
  }
  edges.push({ id: newId("edge"), from: pendingFrom, to: id });
  cancelWirePick();
  recordClueHistory(CLUE_HISTORY_LABELS.addEdge);
  scheduleSave();
  scheduleDrawClueWires();
  showHint(t("已钉上红线", "Linked"));
}

function deleteNode(id: string) {
  nodes = nodes.filter((n) => n.id !== id);
  edges = edges.filter((e) => e.from !== id && e.to !== id);
  selectedIds.delete(id);
  pruneSelectedEdgeIds();
  if (pendingFrom === id) cancelWirePick();
  renderNodes();
  recordClueHistory(CLUE_HISTORY_LABELS.deleteNode);
  scheduleSave();
  scheduleDrawClueWires();
}

function pruneSelectedEdgeIds() {
  for (const id of [...selectedEdgeIds]) {
    if (!edges.some((e) => e.id === id)) selectedEdgeIds.delete(id);
  }
}

function deleteSelectedNodes() {
  if (selectedIds.size === 0) return;
  const ids = [...selectedIds];
  for (const id of ids) {
    nodes = nodes.filter((n) => n.id !== id);
    edges = edges.filter((e) => e.from !== id && e.to !== id);
    if (pendingFrom === id) cancelWirePick();
    selectedIds.delete(id);
  }
  pruneSelectedEdgeIds();
  renderNodes();
  recordClueHistory(CLUE_HISTORY_LABELS.deleteNode);
  scheduleSave();
  scheduleDrawClueWires();
}

function deleteEdgeById(id: string) {
  if (!edges.some((e) => e.id === id)) return;
  edges = edges.filter((e) => e.id !== id);
  selectedEdgeIds.delete(id);
  syncPortClasses();
  recordClueHistory(CLUE_HISTORY_LABELS.deleteEdge);
  scheduleSave();
  scheduleDrawClueWires();
  showHint(t("已删除连线", "Link deleted"));
}

function deleteSelectedEdges() {
  if (selectedEdgeIds.size === 0) return;
  const ids = new Set(selectedEdgeIds);
  edges = edges.filter((e) => !ids.has(e.id));
  selectedEdgeIds.clear();
  syncPortClasses();
  recordClueHistory(CLUE_HISTORY_LABELS.deleteEdge);
  scheduleSave();
  scheduleDrawClueWires();
  showHint(t("已删除连线", "Link deleted"));
}

function deleteEdgesForSelected() {
  if (selectedIds.size === 0) return;
  const ids = new Set(selectedIds);
  edges = edges.filter((e) => !ids.has(e.from) && !ids.has(e.to));
  recordClueHistory(CLUE_HISTORY_LABELS.deleteEdge);
  scheduleSave();
  scheduleDrawClueWires();
  showHint(t("已清除选中线索的连线", "Cleared links for selected clues"));
}

export function addClueNode() {
  const board = boardEl();
  if (!board) return;
  const pad = 48;
  const visW = board.clientWidth / zoom;
  const visH = board.clientHeight / zoom;
  const w = Math.max(320, visW - 200);
  const h = Math.max(240, visH - 160);
  addClueNodeAt(
    -panX / zoom + pad + Math.random() * w,
    -panY / zoom + pad + Math.random() * h
  );
}

function addClueNodeAt(canvasX: number, canvasY: number) {
  const node: ClueNode = {
    id: newId("clue"),
    text: "",
    x: canvasX,
    y: canvasY,
  };
  nodes.push(node);
  selectNode(node.id);
  renderNodes();
  recordClueHistory(CLUE_HISTORY_LABELS.addNode);
  scheduleSave();
  scheduleDrawClueWires();
  const ta = document.querySelector(
    `.notes-clue-node[data-clue-id="${CSS.escape(node.id)}"] .notes-clue-text`
  ) as HTMLTextAreaElement | null;
  ta?.focus();
}

async function loadBoard() {
  persistGen += 1;
  if (saveTimer) {
    window.clearTimeout(saveTimer);
    saveTimer = 0;
  }
  try {
    const data = await invoke<ClueBoardsFile>("notes_clue_board_load");
    boards = data.boards ?? [];
    activeBoardId = data.active_id || boards[0]?.id || "";
    if (boards.length === 0) {
      const id = newId("board");
      const now = Date.now();
      boards = [
        {
          id,
          title: "",
          nodes: [],
          edges: [],
          view: { x: 0, y: 0, zoom: 1 },
          created_at: now,
          updated_at: now,
        },
      ];
      activeBoardId = id;
    }
    if (!boards.some((b) => b.id === activeBoardId)) {
      activeBoardId = boards[0].id;
    }
    const active = boards.find((b) => b.id === activeBoardId) ?? boards[0];
    applyBoardData(active);
    loaded = true;
    renderBoardList();
    await setClueHistoryBoard(activeBoardId, currentClueSnapshot());
  } catch (e) {
    console.error(e);
  }
}

function onMarqueePointerMove(e: PointerEvent) {
  if (!marqueeState || e.pointerId !== marqueeState.pointerId) return;
  const pt = boardPoint(e.clientX, e.clientY);
  updateMarqueeVisual(marqueeState.startX, marqueeState.startY, pt.x, pt.y);
}

function onMarqueePointerUp(e: PointerEvent) {
  if (!marqueeState || e.pointerId !== marqueeState.pointerId) return;
  window.removeEventListener("pointermove", onMarqueePointerMove);
  window.removeEventListener("pointerup", onMarqueePointerUp);
  window.removeEventListener("pointercancel", onMarqueePointerUp);
  try {
    boardEl()?.releasePointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
  const pt = boardPoint(e.clientX, e.clientY);
  const dx = pt.x - marqueeState.startX;
  const dy = pt.y - marqueeState.startY;
  if (dx * dx + dy * dy > PAN_CLICK_SLOP * PAN_CLICK_SLOP) {
    const hits = nodesInMarquee(
      marqueeState.startX,
      marqueeState.startY,
      pt.x,
      pt.y
    );
    selectNodes(hits);
    suppressBoardClick = true;
  }
  extendSuppressNativeMenu();
  clearMarqueeState();
}

function onBoardPointerMove(e: PointerEvent) {
  if (!panState || e.pointerId !== panState.pointerId) return;
  // 屏幕像素 1:1：鼠标 client 位移 = pan 位移（不除以 zoom）
  panX = panState.origPanX + (e.clientX - panState.startX);
  panY = panState.origPanY + (e.clientY - panState.startY);
  recordPanSample();
  applyPanTransform();
  refreshPendingPt();
  scheduleDrawClueWires();
}

function beginBoardPanFromLeft(e: PointerEvent) {
  const board = boardEl();
  if (!board || !leftPress || pendingFrom) return;
  stopPanInertia();
  leftPress.didPan = true;
  clearMarqueeState();
  panState = {
    startX: leftPress.startX,
    startY: leftPress.startY,
    origPanX: panX,
    origPanY: panY,
    pointerId: leftPress.pointerId,
  };
  panSamples = [{ x: panX, y: panY, t: performance.now() }];
  panVelX = 0;
  panVelY = 0;
  board.classList.add("is-panning");
  try {
    board.setPointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
  window.addEventListener("pointermove", onBoardPointerMove);
  window.addEventListener("pointerup", onBoardPointerUp);
  window.addEventListener("pointercancel", onBoardPointerUp);
  onBoardPointerMove(e);
}

function onLeftPointerMove(e: PointerEvent) {
  if (!leftPress || e.pointerId !== leftPress.pointerId) return;
  if (pendingFrom) return;
  const dx = e.clientX - leftPress.startX;
  const dy = e.clientY - leftPress.startY;
  if (!leftPress.didPan && dx * dx + dy * dy > PAN_CLICK_SLOP * PAN_CLICK_SLOP) {
    beginBoardPanFromLeft(e);
    return;
  }
  if (leftPress.didPan) onBoardPointerMove(e);
}

function onLeftPointerUp(e: PointerEvent) {
  if (!leftPress || e.pointerId !== leftPress.pointerId) return;
  const { didPan } = leftPress;
  if (pendingFrom) {
    if (!didPan) cancelWirePick();
    clearLeftPressState();
    return;
  }
  if (didPan) onBoardPointerUp(e);
  clearLeftPressState();
}

function beginBoardMarqueeFromRight(e: PointerEvent) {
  const board = boardEl();
  if (!board || !rightPress) return;
  if (pendingFrom) cancelWirePick();
  stopPanInertia();
  rightPress.didMarquee = true;
  clearMarqueeState();
  extendSuppressNativeMenu();
  const pt = boardPoint(rightPress.startX, rightPress.startY);
  marqueeState = {
    startX: pt.x,
    startY: pt.y,
    pointerId: rightPress.pointerId,
  };
  board.classList.add("is-marqueeing");
  updateMarqueeVisual(pt.x, pt.y, pt.x, pt.y);
  try {
    board.setPointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
  window.addEventListener("pointermove", onMarqueePointerMove);
  window.addEventListener("pointerup", onMarqueePointerUp);
  window.addEventListener("pointercancel", onMarqueePointerUp);
  onMarqueePointerMove(e);
}

function onRightPointerMove(e: PointerEvent) {
  if (!rightPress || e.pointerId !== rightPress.pointerId) return;
  const dx = e.clientX - rightPress.startX;
  const dy = e.clientY - rightPress.startY;
  if (!rightPress.didMarquee && dx * dx + dy * dy > PAN_CLICK_SLOP * PAN_CLICK_SLOP) {
    extendSuppressNativeMenu();
    beginBoardMarqueeFromRight(e);
    return;
  }
  if (rightPress.didMarquee) {
    extendSuppressNativeMenu();
    onMarqueePointerMove(e);
  }
}

function onRightPointerUp(e: PointerEvent) {
  if (!rightPress || e.pointerId !== rightPress.pointerId) return;
  const { didMarquee } = rightPress;
  if (didMarquee) {
    onMarqueePointerUp(e);
  } else if (e.button === 2) {
    suppressBoardClick = true;
  }
  clearRightPressState();
}

function onBoardPointerDown(e: PointerEvent) {
  hideClueContextMenu();
  hideTextareaContextMenu();
  const target = e.target as HTMLElement;

  if (e.button === 2) {
    e.preventDefault();
    e.stopPropagation();
    if (gripPress) {
      beginGripPan(e);
      return;
    }
    if (isClueTextarea(target)) return;
    if (isBoardInteractiveTarget(target)) return;
    if (edgeHitFromTarget(e.target)) return;
    clearRightPressState();
    rightPress = {
      startX: e.clientX,
      startY: e.clientY,
      pointerId: e.pointerId,
      didMarquee: false,
    };
    window.addEventListener("pointermove", onRightPointerMove);
    window.addEventListener("pointerup", onRightPointerUp);
    window.addEventListener("pointercancel", onRightPointerUp);
    return;
  }

  if (isBoardInteractiveTarget(target)) return;

  if (e.button !== 0) return;

  if (target.closest(".notes-clue-node")) return;
  if (target.closest(".notes-clue-toolbar")) return;
  if (edgeHitFromTarget(e.target)) return;

  clearLeftPressState();
  leftPress = {
    startX: e.clientX,
    startY: e.clientY,
    pointerId: e.pointerId,
    didPan: false,
  };
  window.addEventListener("pointermove", onLeftPointerMove);
  window.addEventListener("pointerup", onLeftPointerUp);
  window.addEventListener("pointercancel", onLeftPointerUp);
}

function onBoardPointerUp(e: PointerEvent) {
  if (!panState || e.pointerId !== panState.pointerId) return;
  window.removeEventListener("pointermove", onBoardPointerMove);
  window.removeEventListener("pointerup", onBoardPointerUp);
  window.removeEventListener("pointercancel", onBoardPointerUp);
  try {
    boardEl()?.releasePointerCapture(e.pointerId);
  } catch {
    /* ignore */
  }
  const dx = e.clientX - panState.startX;
  const dy = e.clientY - panState.startY;
  const moved = dx * dx + dy * dy > PAN_CLICK_SLOP * PAN_CLICK_SLOP;
  if (moved) {
    suppressBoardClick = true;
    startPanInertia();
    if (Math.hypot(panVelX, panVelY) <= PAN_MIN_VELOCITY) {
      scheduleSave();
    }
  }
  panSamples = [];
  clearPanState();
}

function onBoardWheel(e: WheelEvent) {
  const board = boardEl();
  if (!board) return;
  const target = e.target as HTMLElement;
  // 工具栏按钮仍交给自身；便签 textarea 滚轮一律走画板缩放（禁止滚动正文）
  if (target.closest(".notes-clue-toolbar, .notes-clue-history-panel, .notes-clue-pan-tuner")) {
    return;
  }
  if (target.closest("button") && !target.closest(".notes-clue-node")) return;
  e.preventDefault();
  e.stopPropagation();
  stopPanInertia();
  const br = board.getBoundingClientRect();
  const mx = e.clientX - br.left;
  const my = e.clientY - br.top;
  const oldZoom = zoom;
  const factor = Math.exp(-e.deltaY * ZOOM_WHEEL_SENS);
  const newZoom = clampZoom(oldZoom * factor);
  if (newZoom === oldZoom) return;
  const ratio = newZoom / oldZoom;
  // 光标下世界点不动：screen = world*zoom + pan → pan' = m - (m - pan) * (z'/z)
  panX = mx - (mx - panX) * ratio;
  panY = my - (my - panY) * ratio;
  zoom = newZoom;
  applyPanTransform();
  refreshPendingPt();
  scheduleDrawClueWires();
  scheduleSave();
  showZoomToast();
}

function onBoardClick(e: MouseEvent) {
  if (suppressBoardClick) {
    suppressBoardClick = false;
    if (pendingFrom) cancelWirePick();
    return;
  }
  if (tryPortPickupFromEvent(e)) return;
  const hit = edgeHitFromTarget(e.target);
  if (hit?.dataset.edgeId) {
    e.stopPropagation();
    if (!pendingFrom) {
      if (e.ctrlKey || e.metaKey) toggleSelectEdge(hit.dataset.edgeId);
      else selectEdge(hit.dataset.edgeId);
    }
    return;
  }
  if ((e.target as HTMLElement).closest(".notes-clue-node")) return;
  clearSelection();
  if (pendingFrom) cancelWirePick();
}

function onClueViewContextMenu(e: MouseEvent) {
  handleClueContextMenu(e);
}

function onDocPointerDown(e: PointerEvent) {
  const target = e.target as HTMLElement;
  if (
    !target.closest(
      "#notes-clue-ctx-menu, #notes-clue-text-ctx-menu, .notes-preset-ctx-menu, #notes-group-meta-pop"
    )
  ) {
    hideClueContextMenu();
    hideTextareaContextMenu();
    hideBoardListMenu();
  }
}

function onKeyDown(e: KeyboardEvent) {
  const mod = e.ctrlKey || e.metaKey;
  if (clueModeActive && mod && e.key.toLowerCase() === "z") {
    e.preventDefault();
    if (e.shiftKey) redoClueHistory();
    else undoClueHistory();
    return;
  }
  if (clueModeActive && mod && e.key.toLowerCase() === "y") {
    e.preventDefault();
    redoClueHistory();
    return;
  }
  if (e.key === "Escape") {
    if (ctxMenuEl?.classList.contains("is-open")) {
      hideClueContextMenu();
      return;
    }
    if (textCtxMenuEl?.classList.contains("is-open")) {
      hideTextareaContextMenu();
      return;
    }
    if (boardListMenuEl) {
      hideBoardListMenu();
      return;
    }
    if (pendingFrom) {
      cancelWirePick();
      return;
    }
  }
  if (e.key !== "Delete" && e.key !== "Backspace") return;
  const active = document.activeElement;
  if (
    active instanceof HTMLInputElement ||
    active instanceof HTMLTextAreaElement
  ) {
    return;
  }
  if (selectedIds.size > 0) {
    e.preventDefault();
    deleteSelectedNodes();
    return;
  }
  if (selectedEdgeIds.size > 0) {
    e.preventDefault();
    deleteSelectedEdges();
  }
}

export function initClueBoard() {
  if (inited) return;
  inited = true;
  initCluePanTuner();
  initClueHistory({
    onRestore: restoreFromSnapshot,
    onUiUpdate: () => {},
    onBoardsFile: (data) => {
      const file = data as ClueBoardsFile | null;
      if (!file?.boards) return;
      boards = file.boards;
      if (file.active_id) activeBoardId = file.active_id;
      renderBoardList();
    },
  });
  bindClueHistoryUi();

  $("notes-clue-add")?.addEventListener("click", () => addClueNode());
  $("notes-clue-clear-links")?.addEventListener("click", () => deleteEdgesForSelected());
  $("notes-clue-reset-view")?.addEventListener("click", () => resetClueView());
  $("notes-clue-board-new")?.addEventListener("click", () => void createBoard());
  boardListEl()?.addEventListener("click", onBoardListClick);
  boardListEl()?.addEventListener("dblclick", onBoardListDblClick);
  boardListEl()?.addEventListener("contextmenu", onBoardListContextMenu);

  const board = boardEl();
  const canvas = canvasEl();
  const view = $("notes-clue-board-view");
  const wires = wireLayer();

  board?.addEventListener("pointerdown", onBoardPointerDown);
  board?.addEventListener("click", onBoardClick);
  // capture：便签 textarea 上的滚轮先被拦下，避免正文滚动抢事件
  board?.addEventListener("wheel", onBoardWheel, { passive: false, capture: true });
  wires?.addEventListener("pointerdown", onWireEdgePointerDown);
  wires?.addEventListener("pointerover", onWirePortPickupPointerOver);
  wires?.addEventListener("pointerout", onWirePortPickupPointerOut);
  view?.addEventListener("contextmenu", onClueViewContextMenu, true);
  board?.addEventListener("contextmenu", onClueViewContextMenu, true);
  canvas?.addEventListener("contextmenu", onClueViewContextMenu, true);
  wires?.addEventListener("contextmenu", onClueViewContextMenu, true);
  document.addEventListener("pointerdown", onDocPointerDown, true);
  window.addEventListener("pointermove", onWirePointerMove);
  document.addEventListener("keydown", onKeyDown);

  window.addEventListener("resize", () => scheduleDrawClueWires());
  window.addEventListener("omnitrace-lang", () => {
    renderNodes();
    renderBoardList();
    refreshClueContextMenuLabels();
    refreshClueHistoryUi();
  });

  void listen("notes-clue-boards-changed", () => {
    persistGen += 1;
    if (saveTimer) {
      window.clearTimeout(saveTimer);
      saveTimer = 0;
    }
    void loadBoard().then(() => reloadClueHistoryFromDisk());
  });
}

async function setClueWebviewContextMenus(enabled: boolean) {
  try {
    await invoke("set_webview_default_context_menus", { enabled });
  } catch {
    /* 浏览器 dev 或无 Tauri */
  }
}

function bindClueModeGuards() {
  if (clueModeActive) return;
  clueModeActive = true;
  document.addEventListener("contextmenu", onDocClueContextMenuCapture, true);
  document.addEventListener("pointerdown", onDocCluePointerDownCapture, true);
  void setClueWebviewContextMenus(false);
}

function unbindClueModeGuards() {
  if (!clueModeActive) return;
  clueModeActive = false;
  suppressNativeMenuUntil = 0;
  document.removeEventListener("contextmenu", onDocClueContextMenuCapture, true);
  document.removeEventListener("pointerdown", onDocCluePointerDownCapture, true);
  void setClueWebviewContextMenus(true);
}

export async function enterClueBoardMode() {
  initClueBoard();
  showCluePanTuner(true);
  bindClueModeGuards();
  if (!loaded) await loadBoard();
  else {
    applyPanTransform();
    renderNodes();
    scheduleDrawClueWires();
    await setClueHistoryBoard(activeBoardId, currentClueSnapshot());
  }
  refreshClueHistoryUi();
}

export async function flushClueBoardSave(): Promise<void> {
  await flushSave();
}

export function leaveClueBoardMode() {
  flushTextHistoryTimer();
  void flushSave();
  showCluePanTuner(false);
  unbindClueModeGuards();
  cancelWirePick();
  cancelGripPress();
  clearEdgePress();
  clearLeftPressState();
  clearRightPressState();
  hideClueContextMenu();
  hideTextareaContextMenu();
  stopPanInertia();
  clearPanState();
  clearMarqueeState();
  window.removeEventListener("pointermove", onLeftPointerMove);
  window.removeEventListener("pointerup", onLeftPointerUp);
  window.removeEventListener("pointercancel", onLeftPointerUp);
  window.removeEventListener("pointermove", onBoardPointerMove);
  window.removeEventListener("pointerup", onBoardPointerUp);
  window.removeEventListener("pointercancel", onBoardPointerUp);
  window.removeEventListener("pointermove", onMarqueePointerMove);
  window.removeEventListener("pointerup", onMarqueePointerUp);
  window.removeEventListener("pointercancel", onMarqueePointerUp);
  if (resize) {
    window.removeEventListener("pointermove", onResizePointerMove);
    window.removeEventListener("pointerup", onResizePointerUp);
    window.removeEventListener("pointercancel", onResizePointerUp);
    resize = null;
  }
  clearSelection();
}
