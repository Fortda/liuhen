/**
 * 笔记「线索板」模式：浅底钉板 + 白色便签 + 有向箭头连线（与流式笔记绿线独立）。
 */
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  formatArchiveListWhen,
  formatGroupMetaTime,
  hideGroupMetaPopover,
  showGroupMetaPopover,
  uiLang,
} from "./notes_cards";
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
  fetchClueHistoryActivity,
  formatClueHistoryActivityTime,
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
  clueClipboardPlainText,
  clueNoteFieldPasteIntent,
  clueShortcutAction,
  decodeClueClipboardHtml,
  encodeClueClipboardHtml,
  fieldHasCharacterSelection,
  isTextEditingField,
  normalizeClueImageRef,
  remapCluePaste,
  type ClueClipboardPayload,
} from "./notes_clue_clipboard";
import {
  hideFloat,
  placeFloatAtPoint,
  placeFloatInViewport,
  revealFloat,
} from "./omni_float";
import {
  auxPanStep,
  isAuxPanButton,
  wantAuxPanFromButtons,
} from "./notes_clue_dual_pan";
import {
  attachGlyphField,
  bindColorTempAnchor,
  normalizeGlyphs,
  type GlyphFieldHandle,
  type UserGlyphWire,
} from "./notes_color_temp";

export type ClueNoteKind = "project" | "research";

export type ClueNode = {
  id: string;
  text: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  color?: string;
  parentId?: string;
  collapsed?: boolean;
  kind?: ClueNoteKind;
  /** Relative ref `clue_images/<file>` under notes/config. Not base64. */
  image?: string;
  /** 色温 / 退格字形带；与流式笔记 user_glyphs 同形。 */
  glyphs?: UserGlyphWire[];
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
const CLUE_IMAGE_W = 280;
const CLUE_IMAGE_H = 220;
const CLUE_PASTE_STEP = 28;
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
/**
 * 左键拖便签时按住右键（或中键后备）平移视口。
 * 不依赖单独的 RMB pointerId：WebView2 在 LMB capture 期间常不发 button=2 的 pointerdown，
 * 改由 pointermove / mousemove 上的 `buttons` 位图驱动（bit1=RMB，bit2=MMB）。
 */
type GripPanState = {
  lastX: number;
  lastY: number;
  didPan: boolean;
  /** 累计屏幕位移，超 slop 则吞 contextmenu */
  totalDx: number;
  totalDy: number;
};
let gripPan: GripPanState | null = null;
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
let ctxMenuNodeId: string | null = null;
let textCtxMenuEl: HTMLElement | null = null;
let textCtxTarget: HTMLTextAreaElement | null = null;
let zoomToastTimer = 0;
let clueModeActive = false;
let suppressNativeMenuUntil = 0;
const SUPPRESS_NATIVE_MENU_MS = 600;
let textHistoryTimer = 0;
/** Per-note glyph tape handles; rebuilt in renderNodes. */
const glyphFieldById = new Map<string, GlyphFieldHandle>();
/** Repeated Ctrl+V steps further from the copied originals. Reset on copy. */
let pasteSeq = 0;
let memoryClipboard: ClueClipboardPayload | null = null;
/** True when OS clipboard write failed and in-app paste should trust memoryClipboard. */
let memoryClipboardUnsynced = false;
/** Set when Ctrl+V should hit the board; cleared if the paste event handles it. */
let pendingPasteFallback = false;
/** Note id armed by Ctrl+V in a note textarea; cleared when paste attaches or pastes text. */
let pendingFieldImagePaste: string | null = null;
let imageFileInput: HTMLInputElement | null = null;
let pendingImagePoint: { x: number; y: number } | null = null;
const imageSrcCache = new Map<string, string>();

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
/** Anchor for Shift+click range select (file-manager style). */
let boardListAnchorId: string | null = null;

const BOARD_HOVER_SHOW_MS = 260;
const BOARD_HOVER_HIDE_MS = 180;
const BOARD_HOVER_ACTIVITY_LIMIT = 8;

let boardHoverPopEl: HTMLElement | null = null;
let boardHoverShowTimer = 0;
let boardHoverHideTimer = 0;
let boardHoverBoardId: string | null = null;
let boardHoverFetchGen = 0;

function setBoardListMultiMode(on: boolean) {
  boardListMultiMode = on;
  document.body.classList.toggle("clue-board-multiselect", on);
  if (!on) {
    selectedBoardIds.clear();
    boardListAnchorId = null;
  }
  renderBoardList();
}

function toggleBoardListSelection(id: string) {
  if (selectedBoardIds.has(id)) selectedBoardIds.delete(id);
  else selectedBoardIds.add(id);
  boardListAnchorId = id;
  renderBoardList();
}

function selectBoardRange(fromId: string, toId: string) {
  const ids = boards.map((b) => b.id);
  const a = ids.indexOf(fromId);
  const b = ids.indexOf(toId);
  if (a < 0 || b < 0) return;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  selectedBoardIds.clear();
  for (let i = lo; i <= hi; i++) selectedBoardIds.add(ids[i]!);
}

function selectAllBoardsInList() {
  for (const board of boards) selectedBoardIds.add(board.id);
  boardListMultiMode = true;
  document.body.classList.toggle("clue-board-multiselect", true);
  renderBoardList();
}

function isBoardListPanelFocused(): boolean {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  return Boolean(
    active.closest("#notes-clue-board-list, #notes-clue-sidebar")
  );
}

function boardWhenMs(board: ClueBoard): number {
  const u = board.updated_at;
  const c = board.created_at;
  if (u != null && Number.isFinite(u) && u > 0) return u;
  if (c != null && Number.isFinite(c) && c > 0) return c;
  return 0;
}

function boardNoteCount(board: ClueBoard): number {
  return board.nodes?.length ?? 0;
}

function boardEdgeCount(board: ClueBoard): number {
  return board.edges?.length ?? 0;
}

function clearBoardHoverTimers() {
  if (boardHoverShowTimer) {
    window.clearTimeout(boardHoverShowTimer);
    boardHoverShowTimer = 0;
  }
  if (boardHoverHideTimer) {
    window.clearTimeout(boardHoverHideTimer);
    boardHoverHideTimer = 0;
  }
}

function hideBoardHoverPopover() {
  clearBoardHoverTimers();
  boardHoverBoardId = null;
  boardHoverFetchGen += 1;
  const el = boardHoverPopEl;
  if (!el) return;
  hideFloat(el);
}

function boardHoverRow(label: string, value: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "notes-wire-origin-row";
  const lab = document.createElement("span");
  lab.className = "notes-wire-origin-label";
  lab.textContent = label;
  const val = document.createElement("span");
  val.className = "notes-wire-origin-value";
  val.textContent = value;
  wrap.append(lab, val);
  return wrap;
}

function ensureBoardHoverPopover(): HTMLElement {
  if (!boardHoverPopEl) {
    boardHoverPopEl = document.createElement("div");
    boardHoverPopEl.id = "notes-clue-board-hover-pop";
    boardHoverPopEl.className =
      "omni-float notes-wire-origin-pop notes-clue-board-hover-pop hidden";
    boardHoverPopEl.setAttribute("role", "tooltip");
    boardHoverPopEl.setAttribute("aria-hidden", "true");
    boardHoverPopEl.addEventListener("mouseenter", () => {
      if (boardHoverHideTimer) {
        window.clearTimeout(boardHoverHideTimer);
        boardHoverHideTimer = 0;
      }
    });
    boardHoverPopEl.addEventListener("mouseleave", () => {
      boardHoverHideTimer = window.setTimeout(
        () => hideBoardHoverPopover(),
        BOARD_HOVER_HIDE_MS
      );
    });
    document.body.appendChild(boardHoverPopEl);
  }
  return boardHoverPopEl;
}

async function showBoardHoverPopover(anchor: HTMLElement, board: ClueBoard) {
  hideGroupMetaPopover();
  const el = ensureBoardHoverPopover();
  boardHoverBoardId = board.id;
  const gen = ++boardHoverFetchGen;
  const name = boardDisplayTitle(board);
  const created = formatGroupMetaTime(board.created_at);
  const updated = formatGroupMetaTime(board.updated_at);
  el.innerHTML = "";
  const head = document.createElement("div");
  head.className = "notes-wire-origin-head";
  const strong = document.createElement("strong");
  strong.textContent = name;
  head.appendChild(strong);
  const body = document.createElement("div");
  body.className = "notes-wire-origin-body";
  body.append(
    boardHoverRow(
      shellT("notes.clue.boards.hoverNotes"),
      String(boardNoteCount(board))
    ),
    boardHoverRow(
      shellT("notes.clue.boards.hoverEdges"),
      String(boardEdgeCount(board))
    ),
    boardHoverRow(
      shellT("notes.groupMeta.created"),
      created.rel ? `${created.abs} · ${created.rel}` : created.abs
    ),
    boardHoverRow(
      shellT("notes.groupMeta.modified"),
      updated.rel ? `${updated.abs} · ${updated.rel}` : updated.abs
    )
  );

  const activityHead = document.createElement("div");
  activityHead.className = "notes-clue-board-hover-activity-head";
  activityHead.textContent = shellT("notes.clue.boards.hoverActivity");
  const activityList = document.createElement("ul");
  activityList.className = "notes-clue-board-hover-activity";
  const activityLoading = document.createElement("li");
  activityLoading.className = "notes-clue-board-hover-activity-empty";
  activityLoading.textContent = shellT("notes.clue.boards.hoverActivityLoading");
  activityList.appendChild(activityLoading);
  body.append(activityHead, activityList);
  el.append(head, body);
  revealFloat(el);
  const rect = anchor.getBoundingClientRect();
  placeFloatInViewport(el, rect, "right", 300);
  requestAnimationFrame(() => placeFloatInViewport(el, rect, "right", 300));

  const items = await fetchClueHistoryActivity(
    board.id,
    BOARD_HOVER_ACTIVITY_LIMIT
  );
  if (gen !== boardHoverFetchGen || boardHoverBoardId !== board.id) return;
  activityList.replaceChildren();
  if (!items.length) {
    const empty = document.createElement("li");
    empty.className = "notes-clue-board-hover-activity-empty";
    empty.textContent = shellT("notes.clue.boards.hoverActivityEmpty");
    activityList.appendChild(empty);
    return;
  }
  // Newest first for scanability
  for (const item of [...items].reverse()) {
    const li = document.createElement("li");
    li.className = "notes-clue-board-hover-activity-item";
    const when = document.createElement("span");
    when.className = "notes-clue-board-hover-activity-time";
    when.textContent = formatClueHistoryActivityTime(item.ts);
    const act = document.createElement("span");
    act.className = "notes-clue-board-hover-activity-label";
    act.textContent = `${item.actorLabel} · ${item.label}`;
    li.append(when, act);
    activityList.appendChild(li);
  }
  placeFloatInViewport(el, rect, "right", 300);
}

function scheduleBoardHover(anchor: HTMLElement, board: ClueBoard) {
  clearBoardHoverTimers();
  if (
    boardHoverBoardId === board.id &&
    boardHoverPopEl &&
    !boardHoverPopEl.classList.contains("hidden")
  ) {
    return;
  }
  boardHoverShowTimer = window.setTimeout(() => {
    boardHoverShowTimer = 0;
    void showBoardHoverPopover(anchor, board);
  }, BOARD_HOVER_SHOW_MS);
}

function scheduleHideBoardHover() {
  if (boardHoverShowTimer) {
    window.clearTimeout(boardHoverShowTimer);
    boardHoverShowTimer = 0;
  }
  boardHoverHideTimer = window.setTimeout(
    () => hideBoardHoverPopover(),
    BOARD_HOVER_HIDE_MS
  );
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
  hideBoardHoverPopover();
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
      boardListAnchorId = board.id;
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
  hideBoardHoverPopover();
  host.replaceChildren();
  host.tabIndex = 0;
  for (const board of boards) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "notes-clue-board-item";
    item.dataset.boardId = board.id;
    item.setAttribute("role", "option");
    item.setAttribute(
      "aria-selected",
      board.id === activeBoardId ? "true" : "false"
    );
    item.title = shellT("notes.clue.boards.renameHint");
    item.classList.toggle("is-active", board.id === activeBoardId);
    const checked = selectedBoardIds.has(board.id);
    item.classList.toggle("is-checked", checked);

    const check = document.createElement("span");
    check.className = "notes-clue-board-item-check";
    check.setAttribute("aria-hidden", "true");
    item.appendChild(check);

    const body = document.createElement("span");
    body.className = "notes-clue-board-item-body";

    const name = document.createElement("span");
    name.className = "notes-clue-board-item-name";
    name.textContent = boardDisplayTitle(board);
    body.appendChild(name);

    const meta = document.createElement("span");
    meta.className = "notes-clue-board-item-meta";
    const counts = document.createElement("span");
    counts.className = "notes-clue-board-item-counts";
    counts.textContent = shellT("notes.clue.boards.tileMeta", {
      notes: String(boardNoteCount(board)),
      edges: String(boardEdgeCount(board)),
    });
    const when = document.createElement("span");
    when.className = "notes-clue-board-item-when";
    const whenMs = boardWhenMs(board);
    when.textContent = whenMs
      ? formatArchiveListWhen(whenMs)
      : shellT("notes.groupMeta.unknownTime");
    meta.append(counts, when);
    body.appendChild(meta);
    item.appendChild(body);

    item.addEventListener("mouseenter", () => scheduleBoardHover(item, board));
    item.addEventListener("mouseleave", () => scheduleHideBoardHover());

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
  hideBoardHoverPopover();
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
  hideBoardHoverPopover();

  if (e.shiftKey) {
    e.preventDefault();
    const anchor =
      boardListAnchorId && boards.some((b) => b.id === boardListAnchorId)
        ? boardListAnchorId
        : activeBoardId || boards[0]?.id || id;
    selectBoardRange(anchor, id);
    boardListMultiMode = true;
    document.body.classList.toggle("clue-board-multiselect", true);
    renderBoardList();
    return;
  }

  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    if (!boardListMultiMode) {
      selectedBoardIds.add(activeBoardId);
      if (id !== activeBoardId) selectedBoardIds.add(id);
      boardListAnchorId = id;
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

  boardListAnchorId = id;
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

function parseClueKind(raw: unknown): ClueNoteKind | undefined {
  return raw === "project" || raw === "research" ? raw : undefined;
}

function nodeParentId(n: ClueNode | undefined | null): string | undefined {
  const p = (n?.parentId ?? "").trim();
  return p || undefined;
}

function childrenOf(id: string): ClueNode[] {
  return nodes.filter((n) => nodeParentId(n) === id);
}

function descendantIds(id: string): string[] {
  const out: string[] = [];
  const stack = childrenOf(id).map((n) => n.id);
  const seen = new Set<string>([id]);
  while (stack.length) {
    const cur = stack.pop()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    out.push(cur);
    for (const c of childrenOf(cur)) stack.push(c.id);
  }
  return out;
}

function hiddenNodeIdSet(): Set<string> {
  const hidden = new Set<string>();
  for (const n of nodes) {
    if (!n.collapsed) continue;
    for (const id of descendantIds(n.id)) hidden.add(id);
  }
  return hidden;
}

function wouldCycleParent(nodeId: string, parentId: string): boolean {
  if (!parentId || parentId === nodeId) return true;
  let cur: string | undefined = parentId;
  const seen = new Set<string>([nodeId]);
  while (cur) {
    if (seen.has(cur)) return true;
    seen.add(cur);
    cur = nodeParentId(nodeById(cur));
  }
  return false;
}

function dragIdsWithDescendants(ids: string[]): string[] {
  const set = new Set<string>();
  for (const id of ids) {
    set.add(id);
    for (const d of descendantIds(id)) set.add(d);
  }
  return [...set];
}

function setNodeParent(childId: string, parentId: string | null): boolean {
  const child = nodeById(childId);
  if (!child) return false;
  if (parentId) {
    if (!nodeById(parentId) || wouldCycleParent(childId, parentId)) return false;
    child.parentId = parentId;
  } else {
    delete child.parentId;
  }
  return true;
}

function toggleNodeCollapsed(id: string) {
  const n = nodeById(id);
  if (!n || descendantIds(id).length === 0) return;
  const next = !n.collapsed;
  if (next) n.collapsed = true;
  else delete n.collapsed;
  renderNodes();
  recordClueHistory(next ? CLUE_HISTORY_LABELS.collapse : CLUE_HISTORY_LABELS.expand);
  scheduleSave();
  scheduleDrawClueWires();
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

function clueDotLabel(text: string, n?: ClueNode): string {
  const trimmed = text.trim();
  let base = trimmed ? [...trimmed].slice(0, CLUE_DOT_LABEL_MAX).join("") : n?.image ? t("图", "Img") : "…";
  if (n?.collapsed) {
    const count = descendantIds(n.id).length;
    if (count > 0) base = `${base} ·${count}`;
  }
  return base;
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
  const hidden = hiddenNodeIdSet();
  for (const n of nodes) {
    if (hidden.has(n.id)) continue;
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
    label.textContent = clueDotLabel(n.text, n);
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

function normalizeLoadedNodes(
  raw: Array<ClueNode & { rotation?: number; parent_id?: string }>
): ClueNode[] {
  const out = (raw ?? []).map(({ rotation: _rot, parent_id, ...n }) => {
    const kind = parseClueKind(n.kind);
    const parentRaw = (n.parentId ?? parent_id ?? "").trim();
    const node: ClueNode = {
      id: n.id,
      text: n.text ?? "",
      x: n.x,
      y: n.y,
    };
    if (n.color != null && n.color !== "") node.color = n.color;
    if (n.w != null && Number.isFinite(n.w)) {
      node.w = Math.min(CLUE_MAX_W, Math.max(CLUE_MIN_W, n.w));
    }
    if (n.h != null && Number.isFinite(n.h)) {
      node.h = Math.min(CLUE_MAX_H, Math.max(CLUE_MIN_H, n.h));
    }
    if (parentRaw) node.parentId = parentRaw;
    if (n.collapsed === true) node.collapsed = true;
    if (kind) node.kind = kind;
    const image = normalizeClueImageRef(n.image);
    if (image) node.image = image;
    const glyphs = normalizeGlyphs((n as ClueNode & { glyphs?: unknown }).glyphs);
    if (glyphs.length) node.glyphs = glyphs.map((g) => ({
      ch: g.ch,
      dt_ms: Math.round(g.dtMs),
      deleted: !!g.deleted,
      ts: g.ts ?? null,
    }));
    return node;
  });
  const ids = new Set(out.map((n) => n.id));
  for (const n of out) {
    const p = nodeParentId(n);
    if (!p || p === n.id || !ids.has(p) || wouldCycleParentOn(out, n.id, p)) {
      delete n.parentId;
    }
  }
  return out;
}

function wouldCycleParentOn(list: ClueNode[], nodeId: string, parentId: string): boolean {
  if (!parentId || parentId === nodeId) return true;
  const byId = new Map(list.map((n) => [n.id, n]));
  let cur: string | undefined = parentId;
  const seen = new Set<string>([nodeId]);
  while (cur) {
    if (seen.has(cur)) return true;
    seen.add(cur);
    cur = nodeParentId(byId.get(cur));
  }
  return false;
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
  const hidden = hiddenNodeIdSet();
  const visible = nodes.filter((n) => !hidden.has(n.id));
  if (!board || visible.length === 0) {
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
  for (const n of visible) {
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
  const hidden = hiddenNodeIdSet();
  const hits: string[] = [];
  for (const n of nodes) {
    if (hidden.has(n.id)) continue;
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
    ".notes-clue-toolbar, .notes-clue-history-panel, .notes-clue-history-tools, button, textarea, .notes-clue-grip, .notes-clue-resize, .notes-clue-dot, .notes-clue-fold"
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
  // 拖便签期间一律吞右键菜单；刚松右键后若发生过平移再延一段时间
  if (gripPress || gripPan) return true;
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
  const nodeEl = target.closest(".notes-clue-node") as HTMLElement | null;
  if (nodeEl?.dataset.clueId) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const id = nodeEl.dataset.clueId;
    if (!selectedIds.has(id)) selectNode(id);
    showNodeClueContextMenu(e.clientX, e.clientY, id);
    suppressBoardClick = true;
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
  ctxMenuNodeId = null;
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

  const addImageBtn = document.createElement("button");
  addImageBtn.type = "button";
  addImageBtn.dataset.action = "add-image";
  addImageBtn.setAttribute("role", "menuitem");
  addImageBtn.textContent = shellT("notes.clue.ctx.addImage");

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.dataset.action = "copy";
  copyBtn.setAttribute("role", "menuitem");
  copyBtn.textContent = shellT("notes.clue.ctx.copy");

  const pasteBtn = document.createElement("button");
  pasteBtn.type = "button";
  pasteBtn.dataset.action = "paste";
  pasteBtn.setAttribute("role", "menuitem");
  pasteBtn.textContent = shellT("notes.clue.ctx.paste");

  const delEdgeBtn = document.createElement("button");
  delEdgeBtn.type = "button";
  delEdgeBtn.dataset.action = "delete-edge";
  delEdgeBtn.setAttribute("role", "menuitem");
  delEdgeBtn.textContent = shellT("notes.clue.ctx.deleteEdge");

  const collapseBtn = document.createElement("button");
  collapseBtn.type = "button";
  collapseBtn.dataset.action = "toggle-fold";
  collapseBtn.setAttribute("role", "menuitem");

  const adoptBtn = document.createElement("button");
  adoptBtn.type = "button";
  adoptBtn.dataset.action = "adopt-selected";
  adoptBtn.setAttribute("role", "menuitem");

  const attachBtn = document.createElement("button");
  attachBtn.type = "button";
  attachBtn.dataset.action = "attach-selected";
  attachBtn.setAttribute("role", "menuitem");

  const clearParentBtn = document.createElement("button");
  clearParentBtn.type = "button";
  clearParentBtn.dataset.action = "clear-parent";
  clearParentBtn.setAttribute("role", "menuitem");

  menu.append(
    newNoteBtn,
    addImageBtn,
    copyBtn,
    pasteBtn,
    delEdgeBtn,
    collapseBtn,
    adoptBtn,
    attachBtn,
    clearParentBtn
  );
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
    const nodeId = ctxMenuNodeId;
    hideClueContextMenu();
    if (action === "new-note" && pt) addClueNodeAt(pt.x, pt.y);
    else if (action === "add-image") {
      const node = nodeId ? nodeById(nodeId) : undefined;
      const at =
        pt ??
        (node ? { x: node.x + CLUE_PASTE_STEP, y: node.y + CLUE_PASTE_STEP } : null);
      openImageFilePicker(at);
    } else if (action === "copy") void copySelectedNotes();
    else if (action === "paste") void pasteClueFromClipboard(pt);
    else if (action === "delete-edge" && edgeId) deleteEdgeById(edgeId);
    else if (action === "toggle-fold" && nodeId) toggleNodeCollapsed(nodeId);
    else if (action === "adopt-selected" && nodeId) adoptSelectedAsChildren(nodeId);
    else if (action === "attach-selected" && nodeId) attachNodeToSelected(nodeId);
    else if (action === "clear-parent" && nodeId) clearNodeParent(nodeId);
  });

  ctxMenuEl = menu;
  return menu;
}

function refreshClueContextMenuLabels() {
  const menu = ensureClueContextMenu();
  const newNoteBtn = menu.querySelector<HTMLButtonElement>('button[data-action="new-note"]');
  const addImageBtn = menu.querySelector<HTMLButtonElement>('button[data-action="add-image"]');
  const copyBtn = menu.querySelector<HTMLButtonElement>('button[data-action="copy"]');
  const pasteBtn = menu.querySelector<HTMLButtonElement>('button[data-action="paste"]');
  const delEdgeBtn = menu.querySelector<HTMLButtonElement>('button[data-action="delete-edge"]');
  const collapseBtn = menu.querySelector<HTMLButtonElement>('button[data-action="toggle-fold"]');
  const adoptBtn = menu.querySelector<HTMLButtonElement>('button[data-action="adopt-selected"]');
  const attachBtn = menu.querySelector<HTMLButtonElement>('button[data-action="attach-selected"]');
  const clearParentBtn = menu.querySelector<HTMLButtonElement>('button[data-action="clear-parent"]');
  if (newNoteBtn) newNoteBtn.textContent = shellT("notes.clue.ctx.newNote");
  if (addImageBtn) addImageBtn.textContent = shellT("notes.clue.ctx.addImage");
  if (copyBtn) copyBtn.textContent = shellT("notes.clue.ctx.copy");
  if (pasteBtn) pasteBtn.textContent = shellT("notes.clue.ctx.paste");
  if (delEdgeBtn) delEdgeBtn.textContent = shellT("notes.clue.ctx.deleteEdge");
  if (collapseBtn) {
    const n = ctxMenuNodeId ? nodeById(ctxMenuNodeId) : undefined;
    collapseBtn.textContent = n?.collapsed
      ? shellT("notes.clue.ctx.expand")
      : shellT("notes.clue.ctx.collapse");
  }
  if (adoptBtn) adoptBtn.textContent = shellT("notes.clue.ctx.adoptSelected");
  if (attachBtn) attachBtn.textContent = shellT("notes.clue.ctx.attachSelected");
  if (clearParentBtn) clearParentBtn.textContent = shellT("notes.clue.ctx.clearParent");
}

function openClueContextMenu(
  clientX: number,
  clientY: number,
  mode: "blank" | "edge" | "node"
) {
  const menu = ensureClueContextMenu();
  refreshClueContextMenuLabels();
  const newNoteBtn = menu.querySelector<HTMLButtonElement>('button[data-action="new-note"]');
  const addImageBtn = menu.querySelector<HTMLButtonElement>('button[data-action="add-image"]');
  const copyBtn = menu.querySelector<HTMLButtonElement>('button[data-action="copy"]');
  const pasteBtn = menu.querySelector<HTMLButtonElement>('button[data-action="paste"]');
  const delEdgeBtn = menu.querySelector<HTMLButtonElement>('button[data-action="delete-edge"]');
  const collapseBtn = menu.querySelector<HTMLButtonElement>('button[data-action="toggle-fold"]');
  const adoptBtn = menu.querySelector<HTMLButtonElement>('button[data-action="adopt-selected"]');
  const attachBtn = menu.querySelector<HTMLButtonElement>('button[data-action="attach-selected"]');
  const clearParentBtn = menu.querySelector<HTMLButtonElement>('button[data-action="clear-parent"]');
  if (newNoteBtn) newNoteBtn.hidden = mode !== "blank";
  if (addImageBtn) addImageBtn.hidden = mode === "edge";
  if (copyBtn) {
    copyBtn.hidden = mode === "edge";
    copyBtn.disabled = selectedIds.size === 0;
  }
  if (pasteBtn) pasteBtn.hidden = mode === "edge";
  if (delEdgeBtn) delEdgeBtn.hidden = mode !== "edge";
  const nodeMode = mode === "node";
  const node = ctxMenuNodeId ? nodeById(ctxMenuNodeId) : undefined;
  const others = [...selectedIds].filter((id) => id !== ctxMenuNodeId);
  if (collapseBtn) {
    collapseBtn.hidden = !nodeMode || descendantIds(ctxMenuNodeId ?? "").length === 0;
  }
  if (adoptBtn) {
    adoptBtn.hidden = !nodeMode;
    adoptBtn.disabled = others.length === 0;
  }
  if (attachBtn) {
    attachBtn.hidden = !nodeMode;
    attachBtn.disabled = others.length !== 1;
  }
  if (clearParentBtn) {
    clearParentBtn.hidden = !nodeMode || !nodeParentId(node);
  }
  revealFloat(menu);
  placeFloatAtPoint(menu, clientX, clientY);
  requestAnimationFrame(() => placeFloatAtPoint(menu, clientX, clientY));
}

function showBlankClueContextMenu(clientX: number, clientY: number) {
  ctxMenuCanvasPt = clientToCanvas(clientX, clientY);
  ctxMenuEdgeId = null;
  ctxMenuNodeId = null;
  openClueContextMenu(clientX, clientY, "blank");
}

function showEdgeClueContextMenu(clientX: number, clientY: number, edgeId: string) {
  ctxMenuCanvasPt = null;
  ctxMenuEdgeId = edgeId;
  ctxMenuNodeId = null;
  openClueContextMenu(clientX, clientY, "edge");
}

function showNodeClueContextMenu(clientX: number, clientY: number, nodeId: string) {
  ctxMenuCanvasPt = null;
  ctxMenuEdgeId = null;
  ctxMenuNodeId = nodeId;
  openClueContextMenu(clientX, clientY, "node");
}

function adoptSelectedAsChildren(parentId: string) {
  const others = [...selectedIds].filter((id) => id !== parentId);
  if (!nodeById(parentId) || others.length === 0) return;
  let changed = 0;
  for (const id of others) {
    if (setNodeParent(id, parentId)) changed += 1;
  }
  if (!changed) {
    showHint(t("无法设为子项（会成环）", "Could not nest (would cycle)"));
    return;
  }
  renderNodes();
  recordClueHistory(CLUE_HISTORY_LABELS.setParent);
  scheduleSave();
  scheduleDrawClueWires();
  showHint(t("已收为子项", "Nested under this note"));
}

function attachNodeToSelected(nodeId: string) {
  const others = [...selectedIds].filter((id) => id !== nodeId);
  if (others.length !== 1) return;
  const parentId = others[0]!;
  if (!setNodeParent(nodeId, parentId)) {
    showHint(t("无法挂到所选便签下", "Could not attach to selected note"));
    return;
  }
  renderNodes();
  recordClueHistory(CLUE_HISTORY_LABELS.setParent);
  scheduleSave();
  scheduleDrawClueWires();
  showHint(t("已挂到所选便签下", "Attached under selected note"));
}

function clearNodeParent(nodeId: string) {
  if (!setNodeParent(nodeId, null)) return;
  renderNodes();
  recordClueHistory(CLUE_HISTORY_LABELS.setParent);
  scheduleSave();
  scheduleDrawClueWires();
  showHint(t("已取消父子", "Parent cleared"));
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

function applyGripPanDelta(dpx: number, dpy: number) {
  if (!gripPress || (!dpx && !dpy)) return;
  panX += dpx;
  panY += dpy;
  // 相机动、便签跟手：补偿 start，世界相对位置不变
  gripPress.startX += dpx;
  gripPress.startY += dpy;
  if (gripPan) {
    gripPan.totalDx += dpx;
    gripPan.totalDy += dpy;
    if (
      gripPan.totalDx * gripPan.totalDx + gripPan.totalDy * gripPan.totalDy >
      PAN_CLICK_SLOP * PAN_CLICK_SLOP
    ) {
      gripPan.didPan = true;
    }
  }
  applyPanTransform();
  refreshPendingPt();
}

function endGripPan() {
  if (!gripPan) return;
  const didPan = gripPan.didPan;
  gripPan = null;
  if (!panState) boardEl()?.classList.remove("is-panning");
  if (didPan) extendSuppressNativeMenu();
}

function cancelGripPress() {
  endGripPan();
  detachGripAuxListeners();
  if (!gripPress) return;
  gripPress.gripEl.classList.remove("is-grabbing");
  gripPress = null;
}

function startGripPanAt(clientX: number, clientY: number) {
  if (!gripPress || gripPan) return;
  extendSuppressNativeMenu();
  stopPanInertia();
  clearRightPressState();
  clearMarqueeState();
  hideClueContextMenu();
  hideTextareaContextMenu();
  gripPan = {
    lastX: clientX,
    lastY: clientY,
    didPan: false,
    totalDx: 0,
    totalDy: 0,
  };
  boardEl()?.classList.add("is-panning");
}

function beginGripPan(e: PointerEvent) {
  if (!gripPress || gripPan) return;
  if (!isAuxPanButton(e.button)) return;
  startGripPanAt(e.clientX, e.clientY);
}

/**
 * 拖便签期间用 buttons 位图开/停辅键平移。
 * 不要求先收到 button=2 的 pointerdown（LMB setPointerCapture 时 WebView2 常丢该事件）。
 */
function syncGripPanFromButtons(clientX: number, clientY: number, buttons: number) {
  if (!gripPress) return;
  if (!wantAuxPanFromButtons(buttons)) {
    if (gripPan) endGripPan();
    return;
  }
  if (!gripPan) {
    startGripPanAt(clientX, clientY);
    return;
  }
  // pointermove + 兼容 mousemove 同帧去重，避免双倍平移
  if (clientX === gripPan.lastX && clientY === gripPan.lastY) return;
  const step = auxPanStep(gripPan.lastX, gripPan.lastY, clientX, clientY);
  gripPan.lastX = step.nextX;
  gripPan.lastY = step.nextY;
  applyGripPanDelta(step.dpx, step.dpy);
}

/** pointerdown 若能到达则尽早 preventDefault；真正平移仍以 buttons 为准。 */
function onGripAuxPointerDown(e: PointerEvent) {
  if (!gripPress || !isAuxPanButton(e.button)) return;
  if (!clueModeActive) return;
  e.preventDefault();
  e.stopPropagation();
  beginGripPan(e);
}

/** 鼠标事件后备：部分 WebView 在 capture 下只更新 buttons / 只走 mouse*。 */
function onGripAuxMouseDown(e: MouseEvent) {
  if (!gripPress || !isAuxPanButton(e.button)) return;
  if (!clueModeActive) return;
  e.preventDefault();
  e.stopPropagation();
  startGripPanAt(e.clientX, e.clientY);
}

function onGripAuxMouseMove(e: MouseEvent) {
  if (!gripPress) return;
  syncGripPanFromButtons(e.clientX, e.clientY, e.buttons);
}

function onGripAuxMouseUp(e: MouseEvent) {
  if (!gripPress || !gripPan) return;
  if (!isAuxPanButton(e.button) && e.type !== "mouseup") return;
  if (!wantAuxPanFromButtons(e.buttons)) endGripPan();
}

function attachGripAuxListeners() {
  window.addEventListener("pointerdown", onGripAuxPointerDown, true);
  window.addEventListener("mousedown", onGripAuxMouseDown, true);
  window.addEventListener("mousemove", onGripAuxMouseMove, true);
  window.addEventListener("mouseup", onGripAuxMouseUp, true);
}

function detachGripAuxListeners() {
  window.removeEventListener("pointerdown", onGripAuxPointerDown, true);
  window.removeEventListener("mousedown", onGripAuxMouseDown, true);
  window.removeEventListener("mousemove", onGripAuxMouseMove, true);
  window.removeEventListener("mouseup", onGripAuxMouseUp, true);
}

function onGripPointerMove(e: PointerEvent) {
  if (!gripPress || e.pointerId !== gripPress.pointerId) return;
  // 先按 buttons 处理辅键平移（与便签拖同帧；相机补偿后再算便签位移）
  syncGripPanFromButtons(e.clientX, e.clientY, e.buttons);
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
  const dragIds = dragIdsWithDescendants(
    selectedIds.has(nodeId) && selectedIds.size > 1 ? [...selectedIds] : [nodeId]
  );
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
  // capture + mouse 后备：拖便签期间辅键平移（含 textarea/图片上）
  attachGripAuxListeners();
  return true;
}

function onGripPointerUp(e: PointerEvent) {
  if (!gripPress) return;
  // 同 pointer 上松右键/中键：只结束辅键视口平移（鼠标常共用 pointerId）
  if (e.pointerId === gripPress.pointerId && isAuxPanButton(e.button)) {
    endGripPan();
    return;
  }
  if (e.pointerId !== gripPress.pointerId) return;
  if (e.button !== 0 && e.type !== "pointercancel") return;
  window.removeEventListener("pointermove", onGripPointerMove);
  window.removeEventListener("pointerup", onGripPointerUp);
  window.removeEventListener("pointercancel", onGripPointerUp);
  detachGripAuxListeners();
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
  for (const h of glyphFieldById.values()) h.destroy();
  glyphFieldById.clear();
  const hidden = hiddenNodeIdSet();
  for (const id of [...selectedIds]) {
    if (hidden.has(id)) selectedIds.delete(id);
  }
  host.innerHTML = "";
  for (const n of nodes) {
    if (hidden.has(n.id)) continue;
    const wrap = document.createElement("div");
    wrap.className = "notes-clue-node";
    wrap.dataset.clueId = n.id;
    if (n.kind) wrap.dataset.kind = n.kind;
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

    const textWrap = document.createElement("div");
    textWrap.className = "notes-clue-text-wrap";
    const tape = document.createElement("div");
    tape.className = "notes-clue-temp-live notes-temp-tape";
    tape.setAttribute("aria-hidden", "true");
    const ta = document.createElement("textarea");
    ta.className = "notes-clue-text";
    ta.value = n.text;
    ta.placeholder = n.image
      ? t("说明…", "Caption…")
      : t("写下线索…", "Write a clue…");
    ta.rows = n.image ? 1 : 3;
    textWrap.append(tape, ta);

    const imageRef = normalizeClueImageRef(n.image);
    let imgEl: HTMLImageElement | null = null;
    if (imageRef) {
      wrap.classList.add("has-image");
      imgEl = document.createElement("img");
      imgEl.className = "notes-clue-image";
      imgEl.alt = "";
      imgEl.draggable = false;
      imgEl.addEventListener("dragstart", (ev) => ev.preventDefault());
      void fillClueImage(imgEl, imageRef);
    }

    const glyphHandle = attachGlyphField({
      input: ta,
      tape,
      wrap: textWrap,
      initial: n.glyphs,
      onChange: (wire) => {
        const hit = nodeById(n.id);
        if (!hit) return;
        if (wire.length) hit.glyphs = wire;
        else delete hit.glyphs;
      },
    });
    glyphFieldById.set(n.id, glyphHandle);

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
      glyphHandle.onInput();
      dotLabel.textContent = clueDotLabel(ta.value, hit ?? n);
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
          "button, textarea, .notes-clue-grip, .notes-clue-resize, .notes-clue-dot, .notes-clue-fold"
        )
      ) {
        return;
      }
      if (e.ctrlKey || e.metaKey) toggleSelectNode(n.id);
      else selectNode(n.id);
    });

    wrap.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest("textarea, button, .notes-clue-grip, .notes-clue-resize, .notes-clue-dot, .notes-clue-fold, .notes-clue-image")) return;
      if (pendingFrom) cancelWirePick();
      deleteNode(n.id);
    });

    const descCount = descendantIds(n.id).length;
    const meta = document.createElement("div");
    meta.className = "notes-clue-meta";
    if (n.kind) {
      const kindEl = document.createElement("span");
      kindEl.className = "notes-clue-kind";
      kindEl.textContent = n.kind === "project"
        ? shellT("notes.clue.kind.project")
        : shellT("notes.clue.kind.research");
      meta.appendChild(kindEl);
    }
    if (descCount > 0) {
      const fold = document.createElement("button");
      fold.type = "button";
      fold.className = "notes-clue-fold";
      fold.dataset.collapsed = n.collapsed ? "1" : "0";
      const chev = n.collapsed ? "▸" : "▾";
      fold.textContent = `${chev} ${descCount}`;
      fold.title = n.collapsed
        ? t(`展开 ${descCount} 条下级`, `Expand ${descCount} nested notes`)
        : t(`折叠 ${descCount} 条下级`, `Collapse ${descCount} nested notes`);
      fold.setAttribute("aria-label", fold.title);
      fold.setAttribute("aria-expanded", n.collapsed ? "false" : "true");
      fold.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        toggleNodeCollapsed(n.id);
      });
      fold.addEventListener("pointerdown", (e) => e.stopPropagation());
      meta.appendChild(fold);
    }
    if (meta.childNodes.length > 0) {
      wrap.append(port, grip, del, ...(imgEl ? [imgEl] : []), textWrap, meta, resizeHandle, dotEl, dotLabel);
    } else {
      wrap.append(port, grip, del, ...(imgEl ? [imgEl] : []), textWrap, resizeHandle, dotEl, dotLabel);
    }
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
  for (const n of nodes) {
    if (n.parentId === id) delete n.parentId;
  }
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
  const idSet = new Set(ids);
  for (const n of nodes) {
    if (n.parentId && idSet.has(n.parentId) && !idSet.has(n.id)) delete n.parentId;
  }
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

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function uniqueClueId(prefix: string, seq: number): string {
  const ts = Date.now();
  const n = (ts ^ seq ^ (ts >> 11)) & 0xffff;
  return `${prefix}_${ts}_${seq.toString(16)}_${n.toString(16).padStart(4, "0")}`;
}

function viewCenterForImage(): { x: number; y: number } {
  const board = boardEl();
  if (!board) return { x: 80, y: 80 };
  const visW = board.clientWidth / zoom;
  const visH = board.clientHeight / zoom;
  return {
    x: -panX / zoom + visW / 2 - CLUE_IMAGE_W / 2,
    y: -panY / zoom + visH / 2 - CLUE_IMAGE_H / 2,
  };
}

async function fillClueImage(img: HTMLImageElement, ref: string) {
  const cached = imageSrcCache.get(ref);
  if (cached) {
    img.src = cached;
    return;
  }
  try {
    const abs = await invoke<string>("notes_clue_image_abs", { imageRef: ref });
    const url = convertFileSrc(abs);
    imageSrcCache.set(ref, url);
    if (img.isConnected) img.src = url;
  } catch {
    img.classList.add("is-missing");
  }
}

async function saveClueImageBlob(file: Blob): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  const ref = await invoke<string>("notes_clue_image_save", {
    dataBase64: bytesToBase64(buf),
  });
  const norm = normalizeClueImageRef(ref);
  if (!norm) throw new Error("bad image ref");
  return norm;
}

async function addImageFilesAt(files: File[], origin: { x: number; y: number }) {
  const images = files.filter(
    (f) => f.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name)
  );
  if (!images.length) {
    showHint(t("不是图片", "Not an image"));
    return;
  }
  const added: string[] = [];
  for (let i = 0; i < images.length; i++) {
    try {
      const image = await saveClueImageBlob(images[i]!);
      const node: ClueNode = {
        id: uniqueClueId("clue", i + 1),
        text: "",
        x: origin.x + i * CLUE_PASTE_STEP,
        y: origin.y + i * CLUE_PASTE_STEP,
        w: CLUE_IMAGE_W,
        h: CLUE_IMAGE_H,
        image,
      };
      nodes.push(node);
      added.push(node.id);
    } catch (err) {
      console.error(err);
      showHint(t("图片未能保存", "Could not save image"));
    }
  }
  if (!added.length) return;
  selectNodes(added);
  renderNodes();
  recordClueHistory(CLUE_HISTORY_LABELS.addImage);
  scheduleSave();
  scheduleDrawClueWires();
}

/** Note id when `el` is (inside) a clue note body textarea; else null. */
function clueNoteIdFromField(el: EventTarget | null): string | null {
  if (!(el instanceof HTMLElement)) return null;
  const ta = el.closest("textarea.notes-clue-text");
  if (!ta) return null;
  const node = ta.closest(".notes-clue-node");
  const id = node instanceof HTMLElement ? node.dataset.clueId?.trim() : "";
  return id || null;
}

/** Save clipboard/file image onto an existing note (`image` path ref only). */
async function attachImageBlobToNote(nodeId: string, blob: Blob) {
  const hit = nodeById(nodeId);
  if (!hit) return;
  const active = document.activeElement;
  const restoreFocus =
    active instanceof HTMLTextAreaElement &&
    active.classList.contains("notes-clue-text") &&
    clueNoteIdFromField(active) === nodeId;
  const selStart = restoreFocus ? active.selectionStart : null;
  const selEnd = restoreFocus ? active.selectionEnd : null;
  try {
    const image = await saveClueImageBlob(blob);
    hit.image = image;
    if (hit.w == null || !Number.isFinite(hit.w)) hit.w = CLUE_IMAGE_W;
    if (hit.h == null || !Number.isFinite(hit.h)) hit.h = CLUE_IMAGE_H;
    selectNode(nodeId);
    renderNodes();
    recordClueHistory(CLUE_HISTORY_LABELS.addImage);
    scheduleSave();
    scheduleDrawClueWires();
    if (restoreFocus) {
      const ta = document.querySelector(
        `.notes-clue-node[data-clue-id="${CSS.escape(nodeId)}"] .notes-clue-text`
      ) as HTMLTextAreaElement | null;
      if (ta) {
        ta.focus();
        if (selStart != null && selEnd != null) {
          try {
            ta.setSelectionRange(selStart, selEnd);
          } catch {
            /* ignore */
          }
        }
      }
    }
    showHint(t("已贴图到便签", "Image attached to note"));
  } catch (err) {
    console.error(err);
    showHint(t("图片未能保存", "Could not save image"));
  }
}

function ensureImageFileInput(): HTMLInputElement {
  if (imageFileInput) return imageFileInput;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/png,image/jpeg,image/gif,image/webp,image/bmp";
  input.multiple = true;
  input.hidden = true;
  input.addEventListener("change", () => {
    const files = [...(input.files ?? [])];
    const pt = pendingImagePoint ?? viewCenterForImage();
    pendingImagePoint = null;
    input.value = "";
    if (files.length) void addImageFilesAt(files, pt);
  });
  document.body.appendChild(input);
  imageFileInput = input;
  return input;
}

function openImageFilePicker(pt: { x: number; y: number } | null) {
  pendingImagePoint = pt;
  const input = ensureImageFileInput();
  input.value = "";
  input.click();
}

function clipboardPayloadFromSelection(): ClueClipboardPayload | null {
  const ids = [...selectedIds];
  if (!ids.length) return null;
  const set = new Set(ids);
  const picked = nodes.filter((n) => set.has(n.id));
  if (!picked.length) return null;
  return {
    v: 1,
    nodes: picked.map((n) => ({ ...n })),
    edges: edges
      .filter((e) => set.has(e.from) && set.has(e.to))
      .map((e) => ({ ...e })),
  };
}

async function copySelectedNotes() {
  const payload = clipboardPayloadFromSelection();
  if (!payload) return;
  memoryClipboard = payload;
  pasteSeq = 0;
  const html = encodeClueClipboardHtml(payload);
  const plain = clueClipboardPlainText(payload.nodes) || "[image]";
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob([plain], { type: "text/plain" }),
        "text/html": new Blob([html], { type: "text/html" }),
      }),
    ]);
    memoryClipboardUnsynced = false;
  } catch (err) {
    console.error(err);
    memoryClipboardUnsynced = true;
  }
  const count = payload.nodes.length;
  showHint(
    count > 1
      ? t(`已复制 ${count} 条`, `Copied ${count} notes`)
      : t("已复制便签", "Copied note")
  );
}

async function readClipboardForClue(): Promise<{
  payload: ClueClipboardPayload | null;
  image: Blob | null;
}> {
  try {
    const items = await navigator.clipboard.read();
    let payload: ClueClipboardPayload | null = null;
    let image: Blob | null = null;
    let plain = "";
    for (const item of items) {
      if (!payload && item.types.includes("text/html")) {
        const html = await (await item.getType("text/html")).text();
        payload = decodeClueClipboardHtml(html);
      }
      if (!plain && item.types.includes("text/plain")) {
        plain = await (await item.getType("text/plain")).text();
      }
      if (!image) {
        const mime = item.types.find((type) => type.startsWith("image/"));
        if (mime) image = await item.getType(mime);
      }
    }
    if (
      !payload &&
      memoryClipboard &&
      !image &&
      (memoryClipboardUnsynced ||
        plain.trim() === (clueClipboardPlainText(memoryClipboard.nodes) || "[image]"))
    ) {
      payload = memoryClipboard;
    }
    if (payload?.nodes.length) return { payload, image: null };
    if (image) return { payload: null, image };
    return { payload: null, image: null };
  } catch {
    return { payload: memoryClipboard, image: null };
  }
}

function pastePayload(payload: ClueClipboardPayload, anchor: { x: number; y: number } | null) {
  let dx: number;
  let dy: number;
  if (anchor && payload.nodes.length) {
    const minX = Math.min(...payload.nodes.map((n) => n.x));
    const minY = Math.min(...payload.nodes.map((n) => n.y));
    dx = anchor.x - minX;
    dy = anchor.y - minY;
  } else {
    pasteSeq += 1;
    dx = CLUE_PASTE_STEP * pasteSeq;
    dy = CLUE_PASTE_STEP * pasteSeq;
  }
  let seq = 0;
  const remapped = remapCluePaste(payload.nodes, payload.edges, {
    dx,
    dy,
    newNodeId: () => uniqueClueId("clue", ++seq),
    newEdgeId: () => uniqueClueId("edge", ++seq),
  });
  const added: ClueNode[] = [];
  for (const n of remapped.nodes) {
    const node: ClueNode = {
      id: n.id,
      text: n.text ?? "",
      x: n.x,
      y: n.y,
    };
    if (n.w != null && Number.isFinite(n.w)) node.w = n.w;
    if (n.h != null && Number.isFinite(n.h)) node.h = n.h;
    if (n.color) node.color = n.color;
    if (n.parentId) node.parentId = n.parentId;
    if (n.collapsed) node.collapsed = true;
    const kind = parseClueKind(n.kind);
    if (kind) node.kind = kind;
    const image = normalizeClueImageRef(n.image);
    if (image) node.image = image;
    if (n.glyphs?.length) {
      const glyphs = normalizeGlyphs(n.glyphs);
      if (glyphs.length) {
        node.glyphs = glyphs.map((g) => ({
          ch: g.ch,
          dt_ms: Math.round(g.dtMs),
          deleted: !!g.deleted,
          ts: g.ts ?? null,
        }));
      }
    }
    added.push(node);
  }
  if (!added.length) {
    showHint(t("没有可粘贴的便签", "Nothing to paste"));
    return;
  }
  nodes.push(...added);
  edges.push(...remapped.edges);
  selectNodes(added.map((n) => n.id));
  renderNodes();
  recordClueHistory(CLUE_HISTORY_LABELS.paste);
  scheduleSave();
  scheduleDrawClueWires();
  showHint(t("已粘贴", "Pasted"));
}

async function pasteClueFromClipboard(anchor: { x: number; y: number } | null) {
  const read = await readClipboardForClue();
  applyClipboardRead(read, anchor);
}

function applyClipboardRead(
  read: { payload: ClueClipboardPayload | null; image: Blob | null },
  anchor: { x: number; y: number } | null
) {
  if (read.payload?.nodes.length) {
    pastePayload(read.payload, anchor);
    return;
  }
  if (read.image) {
    const file = new File([read.image], "clipboard-image", {
      type: read.image.type || "image/png",
    });
    void addImageFilesAt([file], anchor ?? viewCenterForImage());
    return;
  }
  showHint(t("剪贴板没有便签或图片", "Clipboard has no notes or image"));
}

function onCluePaste(e: ClipboardEvent) {
  if (!clueModeActive) return;
  const target = e.target instanceof Element ? e.target : null;
  const data = e.clipboardData;
  const imageItem = [...(data?.items ?? [])].find((item) => item.type.startsWith("image/"));
  const imageFile = imageItem?.getAsFile() ?? null;
  const noteId =
    clueNoteIdFromField(target) ?? clueNoteIdFromField(document.activeElement);
  if (noteId) {
    if (
      clueNoteFieldPasteIntent({
        noteFieldFocused: true,
        hasClipboardImage: !!imageFile,
      }) === "attach-image" &&
      imageFile
    ) {
      pendingPasteFallback = false;
      pendingFieldImagePaste = null;
      e.preventDefault();
      void attachImageBlobToNote(noteId, imageFile);
      return;
    }
    // Text paste stays with the browser; clear async image fallback if text is present.
    const plain = data?.getData("text/plain") ?? "";
    const html = data?.getData("text/html") ?? "";
    if (plain || html) pendingFieldImagePaste = null;
    return;
  }
  if (isTextEditingField(document.activeElement) || isTextEditingField(target)) return;
  const html = data?.getData("text/html") ?? "";
  const plain = data?.getData("text/plain") ?? "";
  let payload = decodeClueClipboardHtml(html);
  if (
    !payload &&
    memoryClipboard &&
    !imageFile &&
    (memoryClipboardUnsynced ||
      plain.trim() === (clueClipboardPlainText(memoryClipboard.nodes) || "[image]"))
  ) {
    payload = memoryClipboard;
  }
  if (!payload?.nodes.length && !imageFile) return;
  pendingPasteFallback = false;
  e.preventDefault();
  if (payload?.nodes.length) {
    pastePayload(payload, null);
    return;
  }
  if (imageFile) void addImageFilesAt([imageFile], viewCenterForImage());
}

function onClueDragOver(e: DragEvent) {
  if (!e.dataTransfer?.types.includes("Files")) return;
  e.preventDefault();
}

function onClueDrop(e: DragEvent) {
  const files = [...(e.dataTransfer?.files ?? [])];
  if (!files.some((f) => f.type.startsWith("image/") || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name))) {
    return;
  }
  e.preventDefault();
  void addImageFilesAt(files, clientToCanvas(e.clientX, e.clientY));
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

  if (e.button === 2 || e.button === 1) {
    e.preventDefault();
    e.stopPropagation();
    if (gripPress) {
      beginGripPan(e);
      return;
    }
    if (e.button === 1) return;
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
  if (
    clueModeActive &&
    mod &&
    e.key.toLowerCase() === "a" &&
    isBoardListPanelFocused() &&
    !isTextEditingField(document.activeElement)
  ) {
    e.preventDefault();
    selectAllBoardsInList();
    return;
  }
  const active = document.activeElement;
  const shortcut = clueShortcutAction({
    clueMode: clueModeActive,
    mod,
    key: e.key,
    fieldFocused: isTextEditingField(active),
    fieldHasCharSelection: fieldHasCharacterSelection(active),
    selectedNoteCount: selectedIds.size,
  });
  if (shortcut === "copy-notes") {
    e.preventDefault();
    void copySelectedNotes();
    return;
  }
  if (shortcut === "paste-field") {
    const noteId = clueNoteIdFromField(active);
    if (!noteId) return;
    pendingFieldImagePaste = noteId;
    requestAnimationFrame(() => {
      if (pendingFieldImagePaste !== noteId) return;
      pendingFieldImagePaste = null;
      void (async () => {
        const read = await readClipboardForClue();
        if (read.image) await attachImageBlobToNote(noteId, read.image);
      })();
    });
    return;
  }
  if (shortcut === "paste-board") {
    pendingPasteFallback = true;
    requestAnimationFrame(() => {
      if (!pendingPasteFallback) return;
      pendingPasteFallback = false;
      void pasteClueFromClipboard(null);
    });
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
    if (boardHoverPopEl && !boardHoverPopEl.classList.contains("hidden")) {
      hideBoardHoverPopover();
      return;
    }
    if (boardListMultiMode) {
      setBoardListMultiMode(false);
      return;
    }
    if (pendingFrom) {
      cancelWirePick();
      return;
    }
  }
  if (e.key !== "Delete" && e.key !== "Backspace") return;
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

/** 色温 / 退格开关变化时重绘线索便签字形带。 */
export function repaintClueGlyphFields() {
  for (const h of glyphFieldById.values()) h.paint();
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
  $("notes-clue-add-image")?.addEventListener("click", () => openImageFilePicker(null));
  bindColorTempAnchor($("notes-clue-color-temp-btn"));
  $("notes-clue-clear-links")?.addEventListener("click", () => deleteEdgesForSelected());
  $("notes-clue-reset-view")?.addEventListener("click", () => resetClueView());
  $("notes-clue-board-new")?.addEventListener("click", () => void createBoard());
  boardListEl()?.addEventListener("click", onBoardListClick);
  boardListEl()?.addEventListener("dblclick", onBoardListDblClick);
  boardListEl()?.addEventListener("contextmenu", onBoardListContextMenu);
  boardListEl()?.addEventListener(
    "scroll",
    () => hideBoardHoverPopover(),
    { passive: true }
  );

  const board = boardEl();
  const canvas = canvasEl();
  const view = $("notes-clue-board-view");
  const wires = wireLayer();

  board?.addEventListener("pointerdown", onBoardPointerDown);
  board?.addEventListener("click", onBoardClick);
  board?.addEventListener("dragover", onClueDragOver);
  board?.addEventListener("drop", onClueDrop);
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
  document.addEventListener("paste", onCluePaste, true);

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
