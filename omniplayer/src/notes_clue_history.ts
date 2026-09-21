/**
 * 线索板 undo/redo 与历史面板：落盘 JSONL（按板），重启可复查；人/AI 分 actor。
 */
import { invoke } from "@tauri-apps/api/core";
import { uiLang } from "./notes_cards";
import { shellT } from "./shell_i18n";

export type ClueBoardSnapshot = {
  nodes: Array<{
    id: string;
    text: string;
    x: number;
    y: number;
    w?: number;
    h?: number;
    color?: string;
    parentId?: string;
    collapsed?: boolean;
    kind?: "project" | "research";
  }>;
  edges: Array<{ id: string; from: string; to: string }>;
  panX: number;
  panY: number;
  zoom: number;
  title?: string;
};

export type HistoryLabel = {
  key: string;
  zh: string;
  en: string;
  action: string;
};

export const CLUE_HISTORY_LABELS = {
  initial: {
    key: "notes.clue.history.initial",
    zh: "初始状态",
    en: "Initial state",
    action: "initial",
  },
  addNode: {
    key: "notes.clue.history.addNode",
    zh: "添加便签",
    en: "Add note",
    action: "add_node",
  },
  deleteNode: {
    key: "notes.clue.history.deleteNode",
    zh: "删除便签",
    en: "Delete note",
    action: "delete_node",
  },
  moveNode: {
    key: "notes.clue.history.moveNode",
    zh: "移动便签",
    en: "Move note",
    action: "move_node",
  },
  resizeNode: {
    key: "notes.clue.history.resizeNode",
    zh: "调整大小",
    en: "Resize note",
    action: "resize_node",
  },
  addEdge: {
    key: "notes.clue.history.addEdge",
    zh: "添加连线",
    en: "Add link",
    action: "add_edge",
  },
  deleteEdge: {
    key: "notes.clue.history.deleteEdge",
    zh: "删除连线",
    en: "Delete link",
    action: "delete_edge",
  },
  editText: {
    key: "notes.clue.history.editText",
    zh: "编辑文本",
    en: "Edit text",
    action: "edit_text",
  },
  /** Legacy only — never emit; kept so old JSONL lines still label. */
  switchBoard: {
    key: "notes.clue.history.switchBoard",
    zh: "切换线索板",
    en: "Switch board",
    action: "switch_board",
  },
  newBoard: {
    key: "notes.clue.history.newBoard",
    zh: "新建线索板",
    en: "New board",
    action: "create_board",
  },
  /** Legacy — delete removes the board's history file; do not record on other boards. */
  deleteBoard: {
    key: "notes.clue.history.deleteBoard",
    zh: "删除线索板",
    en: "Delete board",
    action: "delete_board",
  },
  renameBoard: {
    key: "notes.clue.history.renameBoard",
    zh: "重命名线索板",
    en: "Rename board",
    action: "rename_board",
  },
  collapse: {
    key: "notes.clue.history.collapse",
    zh: "折叠便签",
    en: "Collapse note",
    action: "collapse_node",
  },
  expand: {
    key: "notes.clue.history.expand",
    zh: "展开便签",
    en: "Expand note",
    action: "expand_node",
  },
  setParent: {
    key: "notes.clue.history.setParent",
    zh: "设置父子",
    en: "Set parent",
    action: "set_parent",
  },
  rollback: {
    key: "notes.clue.history.rollback",
    zh: "回退版本",
    en: "Rollback",
    action: "rollback",
  },
} as const satisfies Record<string, HistoryLabel>;

export type ClueHistoryActor = "human" | "ai";

type PersistedEntry = {
  seq: number;
  ts: number;
  actor: string;
  action: string;
  tool?: string | null;
  label_key?: string | null;
  rollback_to_seq?: number | null;
  snapshot: {
    title?: string;
    nodes: ClueBoardSnapshot["nodes"];
    edges: ClueBoardSnapshot["edges"];
    view?: { x: number; y: number; zoom?: number | null } | null;
  };
};

type BoardHistory = {
  entries: PersistedEntry[];
  /** Index into entries for live tip (always last after persist ops). */
  currentIndex: number;
};

const boardHistories = new Map<string, BoardHistory>();
/** Session redo stack: seqs to restore after undo. */
const redoStacks = new Map<string, number[]>();
let activeBoardId = "";
let suppressPush = false;
let persistBusy = false;
let onRestore: ((snap: ClueBoardSnapshot) => void) | null = null;
let onUiUpdate: (() => void) | null = null;
/** Called after IPC rollback so board store / list can sync. */
let onBoardsFile: ((data: unknown) => void) | null = null;
let historyPanelOpen = false;

function cloneSnap(s: ClueBoardSnapshot): ClueBoardSnapshot {
  return JSON.parse(JSON.stringify(s)) as ClueBoardSnapshot;
}

function snapJson(s: ClueBoardSnapshot): string {
  return JSON.stringify({
    nodes: s.nodes,
    edges: s.edges,
    panX: s.panX,
    panY: s.panY,
    zoom: s.zoom,
    title: s.title ?? "",
  });
}

function entryToSnap(e: PersistedEntry): ClueBoardSnapshot {
  const view = e.snapshot.view;
  return {
    nodes: e.snapshot.nodes ?? [],
    edges: e.snapshot.edges ?? [],
    panX: view?.x ?? 0,
    panY: view?.y ?? 0,
    zoom: view?.zoom ?? 1,
    title: e.snapshot.title ?? "",
  };
}

function snapToPayload(snap: ClueBoardSnapshot) {
  return {
    title: snap.title ?? "",
    nodes: snap.nodes,
    edges: snap.edges,
    view: { x: snap.panX, y: snap.panY, zoom: snap.zoom },
  };
}

function historyLabelText(label: HistoryLabel): string {
  const fromShell = shellT(label.key);
  if (fromShell !== label.key) return fromShell;
  return uiLang() === "zh" ? label.zh : label.en;
}

function labelForEntry(e: PersistedEntry): HistoryLabel {
  if (e.label_key) {
    const found = Object.values(CLUE_HISTORY_LABELS).find((l) => l.key === e.label_key);
    if (found) return found;
  }
  const byAction = Object.values(CLUE_HISTORY_LABELS).find((l) => l.action === e.action);
  if (byAction) return byAction;
  if (e.action === "rollback") return CLUE_HISTORY_LABELS.rollback;
  return {
    key: e.label_key || e.action,
    zh: e.action,
    en: e.action,
    action: e.action,
  };
}

/** Navigation must not appear in the history panel (even if old JSONL has them). */
function isNavigationHistoryEntry(e: PersistedEntry): boolean {
  if (e.action === "switch_board" || e.action === "delete_board") return true;
  if (
    e.label_key === CLUE_HISTORY_LABELS.switchBoard.key ||
    e.label_key === CLUE_HISTORY_LABELS.deleteBoard.key
  ) {
    return true;
  }
  return false;
}

function getBoardHistory(boardId = activeBoardId): BoardHistory | null {
  if (!boardId) return null;
  return boardHistories.get(boardId) ?? null;
}

function currentSnapshot(boardId = activeBoardId): ClueBoardSnapshot | null {
  const hist = getBoardHistory(boardId);
  if (!hist || hist.currentIndex < 0) return null;
  const e = hist.entries[hist.currentIndex];
  return e ? entryToSnap(e) : null;
}

export function initClueHistory(opts: {
  onRestore: (snap: ClueBoardSnapshot) => void;
  onUiUpdate: () => void;
  onBoardsFile?: (data: unknown) => void;
}) {
  onRestore = opts.onRestore;
  onUiUpdate = opts.onUiUpdate;
  onBoardsFile = opts.onBoardsFile ?? null;
}

export function captureClueSnapshot(
  nodes: ClueBoardSnapshot["nodes"],
  edges: ClueBoardSnapshot["edges"],
  panX: number,
  panY: number,
  zoom: number,
  title = ""
): ClueBoardSnapshot {
  return cloneSnap({ nodes, edges, panX, panY, zoom, title });
}

async function loadHistoryFromDisk(boardId: string): Promise<BoardHistory> {
  try {
    const list = await invoke<{
      entries: PersistedEntry[];
      current_seq?: number | null;
    }>("notes_clue_history_ensure", { boardId });
    // Drop legacy navigation rows so undo/panel stay content-only (disk may still have them).
    const entries = (list.entries ?? []).filter((e) => !isNavigationHistoryEntry(e));
    return {
      entries,
      currentIndex: entries.length > 0 ? entries.length - 1 : -1,
    };
  } catch (e) {
    console.error(e);
    return { entries: [], currentIndex: -1 };
  }
}

export async function setClueHistoryBoard(boardId: string, _initialSnap?: ClueBoardSnapshot) {
  activeBoardId = boardId;
  redoStacks.set(boardId, []);
  if (boardId) {
    const hist = await loadHistoryFromDisk(boardId);
    boardHistories.set(boardId, hist);
  }
  updateHistoryUi();
}

export function pushClueHistory(label: HistoryLabel, snap: ClueBoardSnapshot) {
  if (suppressPush || !activeBoardId || persistBusy) return;
  void pushClueHistoryAsync(label, snap, "human");
}

export function pushClueHistoryIfChanged(label: HistoryLabel, snap: ClueBoardSnapshot) {
  pushClueHistory(label, snap);
}

async function pushClueHistoryAsync(
  label: HistoryLabel,
  snap: ClueBoardSnapshot,
  actor: ClueHistoryActor
) {
  if (!activeBoardId) return;
  let hist = boardHistories.get(activeBoardId);
  if (!hist) {
    hist = { entries: [], currentIndex: -1 };
    boardHistories.set(activeBoardId, hist);
  }
  const next = cloneSnap(snap);
  const cur = currentSnapshot();
  if (cur && snapJson(cur) === snapJson(next)) return;

  persistBusy = true;
  try {
    const entry = await invoke<PersistedEntry>("notes_clue_history_record", {
      args: {
        board_id: activeBoardId,
        actor,
        action: label.action,
        tool: "ui",
        label_key: label.key,
        snapshot: snapToPayload(next),
      },
    });
    hist.entries.push(entry);
    hist.currentIndex = hist.entries.length - 1;
    redoStacks.set(activeBoardId, []);
    updateHistoryUi();
  } catch (e) {
    console.error(e);
  } finally {
    persistBusy = false;
  }
}

export function canUndoClueHistory(): boolean {
  const hist = getBoardHistory();
  return !!hist && hist.entries.length >= 2;
}

export function canRedoClueHistory(): boolean {
  const stack = redoStacks.get(activeBoardId);
  return !!stack && stack.length > 0;
}

export function undoClueHistory() {
  const hist = getBoardHistory();
  if (!hist || hist.entries.length < 2) return;
  const tip = hist.entries[hist.entries.length - 1];
  const prev = hist.entries[hist.entries.length - 2];
  if (!tip || !prev) return;
  const stack = redoStacks.get(activeBoardId) ?? [];
  stack.push(tip.seq);
  redoStacks.set(activeBoardId, stack);
  void rollbackToSeq(prev.seq);
}

export function redoClueHistory() {
  const stack = redoStacks.get(activeBoardId);
  if (!stack || stack.length === 0) return;
  const seq = stack.pop()!;
  redoStacks.set(activeBoardId, stack);
  void rollbackToSeq(seq, { keepRedoStack: true });
}

export function jumpClueHistory(index: number) {
  const hist = getBoardHistory();
  if (!hist || index < 0 || index >= hist.entries.length) return;
  const entry = hist.entries[index];
  if (!entry) return;
  redoStacks.set(activeBoardId, []);
  void rollbackToSeq(entry.seq);
}

async function rollbackToSeq(seq: number, opts?: { keepRedoStack?: boolean }) {
  if (!activeBoardId || persistBusy) return;
  persistBusy = true;
  suppressPush = true;
  try {
    const result = await invoke<{
      boards: unknown;
      entry: PersistedEntry;
    }>("notes_clue_history_rollback", {
      boardId: activeBoardId,
      seq,
      actor: "human",
    });
    if (!opts?.keepRedoStack) {
      /* jump clears; undo/redo manage their own stack */
    }
    const hist = await loadHistoryFromDisk(activeBoardId);
    boardHistories.set(activeBoardId, hist);
    const tip = hist.entries[hist.currentIndex];
    if (tip) {
      onRestore?.(entryToSnap(tip));
    }
    onBoardsFile?.(result.boards);
    updateHistoryUi();
  } catch (e) {
    console.error(e);
  } finally {
    suppressPush = false;
    persistBusy = false;
  }
}

export function clearClueHistoryBoard(boardId: string) {
  boardHistories.delete(boardId);
  redoStacks.delete(boardId);
  if (activeBoardId === boardId) updateHistoryUi();
}

export function resetAllClueHistory() {
  boardHistories.clear();
  redoStacks.clear();
  activeBoardId = "";
  historyPanelOpen = false;
  updateHistoryUi();
}

export function toggleClueHistoryPanel(): boolean {
  historyPanelOpen = !historyPanelOpen;
  updateHistoryUi();
  return historyPanelOpen;
}

export function isClueHistoryPanelOpen(): boolean {
  return historyPanelOpen;
}

/** Reload history from disk (e.g. after MCP mutation). */
export async function reloadClueHistoryFromDisk(boardId = activeBoardId) {
  if (!boardId) return;
  const hist = await loadHistoryFromDisk(boardId);
  boardHistories.set(boardId, hist);
  if (boardId === activeBoardId) updateHistoryUi();
}

function formatHistoryTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function actorLabel(actor: string): string {
  if (actor === "ai") return shellT("notes.clue.history.actorAi");
  return shellT("notes.clue.history.actorHuman");
}

function updateHistoryUi() {
  const undoBtn = document.getElementById("notes-clue-undo") as HTMLButtonElement | null;
  const redoBtn = document.getElementById("notes-clue-redo") as HTMLButtonElement | null;
  const toggleBtn = document.getElementById(
    "notes-clue-history-toggle"
  ) as HTMLButtonElement | null;
  const panel = document.getElementById("notes-clue-history-panel");
  const list = document.getElementById("notes-clue-history-list");

  if (undoBtn) undoBtn.disabled = !canUndoClueHistory();
  if (redoBtn) redoBtn.disabled = !canRedoClueHistory();
  if (toggleBtn) {
    toggleBtn.setAttribute("aria-pressed", historyPanelOpen ? "true" : "false");
    toggleBtn.classList.toggle("is-active", historyPanelOpen);
  }
  if (panel) {
    panel.classList.toggle("is-open", historyPanelOpen);
    panel.setAttribute("aria-hidden", historyPanelOpen ? "false" : "true");
  }

  if (list) {
    list.replaceChildren();
    const hist = getBoardHistory();
    if (!hist || hist.entries.length === 0) {
      const empty = document.createElement("li");
      empty.className = "notes-clue-history-empty";
      empty.textContent = shellT("notes.clue.history.empty");
      list.appendChild(empty);
    } else {
      hist.entries.forEach((entry, index) => {
        const item = document.createElement("li");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "notes-clue-history-item";
        if (index === hist.currentIndex) btn.classList.add("is-current");
        btn.dataset.historyIndex = String(index);
        btn.dataset.historySeq = String(entry.seq);
        btn.title = shellT("notes.clue.history.rollbackHint");

        const seq = document.createElement("span");
        seq.className = "notes-clue-history-seq";
        seq.textContent = String(entry.seq);

        const actor = document.createElement("span");
        actor.className = `notes-clue-history-actor is-${entry.actor === "ai" ? "ai" : "human"}`;
        actor.textContent = actorLabel(entry.actor);

        const label = document.createElement("span");
        label.className = "notes-clue-history-label";
        let text = historyLabelText(labelForEntry(entry));
        if (entry.rollback_to_seq != null) {
          text = `${text} → #${entry.rollback_to_seq}`;
        }
        label.textContent = text;

        const time = document.createElement("span");
        time.className = "notes-clue-history-time";
        time.textContent = formatHistoryTime(entry.ts);

        btn.append(seq, actor, label, time);
        item.appendChild(btn);
        list.appendChild(item);
      });
      // Keep newest visible
      list.scrollTop = list.scrollHeight;
    }
  }

  onUiUpdate?.();
}

export function bindClueHistoryUi() {
  document.getElementById("notes-clue-undo")?.addEventListener("click", () => undoClueHistory());
  document.getElementById("notes-clue-redo")?.addEventListener("click", () => redoClueHistory());
  document.getElementById("notes-clue-history-toggle")?.addEventListener("click", () => {
    toggleClueHistoryPanel();
  });
  document.getElementById("notes-clue-history-list")?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest(
      "button[data-history-index]"
    ) as HTMLButtonElement | null;
    if (!btn) return;
    const index = Number(btn.dataset.historyIndex);
    if (!Number.isFinite(index)) return;
    jumpClueHistory(index);
  });
}

export function refreshClueHistoryUi() {
  updateHistoryUi();
}
