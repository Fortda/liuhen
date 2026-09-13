/**
 * Shell apps column — Cursor-like expand + multi-pane host (cream/paper aesthetic).
 * Pane kinds: clue (real reparent), browser/file/terminal (usable MVP), canvas (light stub).
 */
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import {
  hideFloat,
  placeFloatInViewport,
  revealFloat,
} from "./omni_float";
import { shellT } from "./shell_i18n";
import {
  CLUE_BOARDS_UI_EVENT,
  createClueBoard,
  deleteClueBoard,
  enterClueBoardMode,
  flushClueBoardSave,
  getActiveClueBoardId,
  initClueBoard,
  isClueAppsHosted,
  leaveClueBoardMode,
  listClueBoardSummaries,
  renameClueBoard,
  setClueAppsHosted,
  switchClueBoard,
} from "./notes_clue_board";
import {
  applyHideNonGreenFilter,
  isChatAppsHosted,
  isHideNonGreenOn,
  setChatAppsHosted,
  setHideNonGreen,
} from "./notes";
import {
  applyWirePreset,
  listWirePresetSummaries,
  saveCurrentWirePreset,
  WIRE_PRESETS_UI_EVENT,
  getSelectedWirePresetId,
} from "./notes_wire_presets";

export const APPS_STORAGE_KEY = "omnitrace.shell.apps.v1";
const FILE_ROOT_KEY = "omnitrace.shell.apps.fileRoot";

export type AppsPaneKind =
  | "chat"
  | "clue"
  | "canvas"
  | "browser"
  | "terminal"
  | "file";

type AppsDirEntry = { name: string; path: string; isDir: boolean };

type AppsPaneState = {
  id: string;
  kind: AppsPaneKind;
  /** Browser file or File-pane tree root */
  path?: string;
  /** Canvas scratch text */
  canvasText?: string;
  /** Clue-board instance this tab shows */
  boardId?: string;
  /** Wire-preset id; omit = live current thread */
  threadId?: string;
};

type AppsLayoutState = {
  expanded: boolean;
  width: number;
  panes: AppsPaneState[];
  activeId: string | null;
};

type NotesLoader = () => Promise<unknown>;

type CatalogItem = {
  kind: AppsPaneKind;
  labelKey: string;
  hintKey: string;
  icon: string;
};

const CATALOG: CatalogItem[] = [
  {
    kind: "chat",
    labelKey: "shell.apps.kind.chat",
    hintKey: "shell.apps.kind.chatHint",
    icon: "☰",
  },
  {
    kind: "clue",
    labelKey: "shell.apps.kind.clue",
    hintKey: "shell.apps.kind.clueHint",
    icon: "◎",
  },
  {
    kind: "canvas",
    labelKey: "shell.apps.kind.canvas",
    hintKey: "shell.apps.kind.canvasHint",
    icon: "✎",
  },
  {
    kind: "browser",
    labelKey: "shell.apps.kind.browser",
    hintKey: "shell.apps.kind.browserHint",
    icon: "◉",
  },
  {
    kind: "terminal",
    labelKey: "shell.apps.kind.terminal",
    hintKey: "shell.apps.kind.terminalHint",
    icon: "›_",
  },
  {
    kind: "file",
    labelKey: "shell.apps.kind.file",
    hintKey: "shell.apps.kind.fileHint",
    icon: "▤",
  },
];

const DEFAULT_WIDTH = 420;
const MIN_WIDTH = 280;
const MAX_WIDTH_RATIO = 0.62;
const PICKER_HOVER_OPEN_MS = 180;
const PICKER_HOVER_CLOSE_MS = 260;

let ensureNotes: NotesLoader | null = null;
let layout: AppsLayoutState = {
  expanded: false,
  width: DEFAULT_WIDTH,
  panes: [],
  activeId: null,
};
let menuEl: HTMLElement | null = null;
let menuFilter = "";
let idSeq = 1;
let cluePickerEl: HTMLElement | null = null;
let cluePickerFilter = "";
let threadPickerEl: HTMLElement | null = null;
let threadPickerFilter = "";
let submenuKind: "clue" | "chat" | null = null;
let submenuHoverTimer = 0;
let submenuCloseTimer = 0;
const paneEls = new Map<string, HTMLElement>();
const fileCaches = new Map<string, Map<string, AppsDirEntry[]>>();
const fileExpanded = new Map<string, Set<string>>();
const fileSelected = new Map<string, string>();

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function uid(): string {
  idSeq += 1;
  return `pane-${Date.now().toString(36)}-${idSeq}`;
}

function kindLabel(kind: AppsPaneKind): string {
  return shellT(`shell.apps.kind.${kind}`) || kind;
}

function pathBasename(p: string): string {
  const s = p.replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  return i >= 0 ? s.slice(i + 1) : s;
}

function pathParent(p: string): string | null {
  const s = p.replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"));
  if (i <= 0) return null;
  return s.slice(0, i);
}

function isPaneKind(v: string): v is AppsPaneKind {
  return (
    v === "chat" ||
    v === "clue" ||
    v === "canvas" ||
    v === "browser" ||
    v === "terminal" ||
    v === "file"
  );
}

function normalizePane(raw: unknown): AppsPaneState | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Partial<AppsPaneState>;
  if (typeof p.id !== "string" || typeof p.kind !== "string" || !isPaneKind(p.kind)) {
    return null;
  }
  const pane: AppsPaneState = { id: p.id, kind: p.kind };
  if (typeof p.path === "string") pane.path = p.path;
  if (typeof p.canvasText === "string") pane.canvasText = p.canvasText;
  if (typeof p.boardId === "string" && p.boardId) pane.boardId = p.boardId;
  if (typeof p.threadId === "string" && p.threadId) pane.threadId = p.threadId;
  return pane;
}

function getActivePane(): AppsPaneState | undefined {
  if (layout.activeId) {
    const hit = layout.panes.find((p) => p.id === layout.activeId);
    if (hit) return hit;
  }
  return layout.panes[layout.panes.length - 1];
}

function readLayout(): AppsLayoutState {
  try {
    const raw = localStorage.getItem(APPS_STORAGE_KEY);
    if (!raw) return layout;
    const parsed = JSON.parse(raw) as Partial<AppsLayoutState>;
    const panes = Array.isArray(parsed.panes)
      ? parsed.panes.map(normalizePane).filter((p): p is AppsPaneState => !!p)
      : [];
    const activeId =
      typeof parsed.activeId === "string" && panes.some((p) => p.id === parsed.activeId)
        ? parsed.activeId
        : panes[panes.length - 1]?.id ?? null;
    return {
      expanded: !!parsed.expanded,
      width:
        typeof parsed.width === "number" && parsed.width >= MIN_WIDTH
          ? parsed.width
          : DEFAULT_WIDTH,
      panes,
      activeId,
    };
  } catch {
    return layout;
  }
}

function persistLayout() {
  try {
    localStorage.setItem(APPS_STORAGE_KEY, JSON.stringify(layout));
  } catch {
    /* private mode */
  }
}

function persistFileRoot(path: string) {
  try {
    localStorage.setItem(FILE_ROOT_KEY, path);
  } catch {
    /* private mode */
  }
}

function clampWidth(w: number): number {
  const max = Math.max(MIN_WIDTH, Math.floor(window.innerWidth * MAX_WIDTH_RATIO));
  return Math.max(MIN_WIDTH, Math.min(max, Math.round(w)));
}

function placeAppsToggle(expanded: boolean) {
  const btn = $("btn-shell-apps");
  const head = document.querySelector("#shell-apps .shell-apps-head");
  const launcher = $("shell-apps-launcher");
  if (!btn) return;
  if (expanded && head) {
    head.appendChild(btn);
    launcher?.classList.add("hidden");
    launcher?.setAttribute("aria-hidden", "true");
  } else if (launcher) {
    launcher.appendChild(btn);
    launcher.classList.remove("hidden");
    launcher.setAttribute("aria-hidden", "false");
  }
}

function setExpanded(on: boolean) {
  layout.expanded = on;
  document.body.classList.toggle("shell-apps-open", on);
  const col = $("shell-apps");
  const btn = $("btn-shell-apps") as HTMLButtonElement | null;
  if (col) {
    col.classList.toggle("hidden", !on);
    col.setAttribute("aria-hidden", on ? "false" : "true");
    col.style.width = `${clampWidth(layout.width)}px`;
  }
  if (btn) {
    btn.setAttribute("aria-pressed", on ? "true" : "false");
    btn.title = on ? shellT("shell.apps.hide") : shellT("shell.apps.show");
    btn.setAttribute(
      "aria-label",
      on ? shellT("shell.apps.hide") : shellT("shell.apps.show")
    );
  }
  persistLayout();
  placeAppsToggle(on);
  if (on) renderPanes();
  else {
    closeMenu();
    void teardownClueHost();
    teardownChatHost();
  }
  syncCluePlaceholder();
  syncChatPlaceholder();
}

function syncCluePlaceholder() {
  const ph = $("notes-clue-apps-placeholder");
  if (!ph) return;
  const notesClue =
    document
      .querySelector("#notes-mode-seg [data-notes-mode='clue']")
      ?.classList.contains("active") ?? false;
  const show = isClueAppsHosted() && notesClue;
  ph.classList.toggle("hidden", !show);
}

function syncChatPlaceholder() {
  const ph = $("notes-chat-apps-placeholder");
  if (!ph) return;
  const notesStream =
    document
      .querySelector("#notes-mode-seg [data-notes-mode='stream']")
      ?.classList.contains("active") ?? false;
  const show = isChatAppsHosted() && notesStream;
  ph.classList.toggle("hidden", !show);
}

async function ensureNotesReady() {
  if (ensureNotes) await ensureNotes();
  initClueBoard();
}

function clueHomeParent(): HTMLElement | null {
  return document.querySelector(".notes-wrap") as HTMLElement | null;
}

function stashSharedViews() {
  const stash = $("shell-apps-clue-stash") || document.body;
  const board = $("notes-clue-board-view");
  if (board?.closest("#shell-apps-panes")) {
    stash.appendChild(board);
    board.classList.add("hidden");
  }
  const chat = $("notes-chat-view");
  if (chat?.closest("#shell-apps-panes")) {
    stash.appendChild(chat);
    chat.classList.add("hidden");
  }
}

async function mountClueInto(host: HTMLElement) {
  await ensureNotesReady();
  const board = $("notes-clue-board-view");
  if (!board) return;
  if (board.parentElement !== host) {
    host.appendChild(board);
  }
  board.classList.remove("hidden");
  setClueAppsHosted(true);
  await enterClueBoardMode();
  const pane = getActivePane();
  if (pane?.kind === "clue") {
    if (pane.boardId) await switchClueBoard(pane.boardId);
    else {
      const cur = getActiveClueBoardId();
      if (cur) {
        pane.boardId = cur;
        persistLayout();
      }
    }
  }
  syncCluePlaceholder();
  renderChromeTabs();
}

async function mountChatInto(host: HTMLElement) {
  await ensureNotesReady();
  const chat = $("notes-chat-view");
  if (!chat) return;
  if (chat.parentElement !== host) {
    host.appendChild(chat);
  }
  chat.classList.remove("hidden");
  setChatAppsHosted(true);
  const pane = getActivePane();
  if (pane?.kind === "chat" && pane.threadId) {
    await applyWirePreset(pane.threadId);
  }
  syncChatPlaceholder();
  renderChromeTabs();
  applyHideNonGreenFilter();
}

async function parkClueIfNeeded() {
  if (!layout.panes.some((p) => p.kind === "clue")) return;
  if (getActivePane()?.kind === "clue") return;
  await ensureNotesReady();
  const board = $("notes-clue-board-view");
  const stash = $("shell-apps-clue-stash") || document.body;
  if (board && board.parentElement !== stash) {
    stash.appendChild(board);
    board.classList.add("hidden");
  }
  setClueAppsHosted(true);
  await enterClueBoardMode();
  syncCluePlaceholder();
}

async function parkChatIfNeeded() {
  if (!layout.panes.some((p) => p.kind === "chat")) return;
  if (getActivePane()?.kind === "chat") return;
  await ensureNotesReady();
  const chat = $("notes-chat-view");
  const stash = $("shell-apps-clue-stash") || document.body;
  if (chat && chat.parentElement !== stash) {
    stash.appendChild(chat);
    chat.classList.add("hidden");
  }
  setChatAppsHosted(true);
  syncChatPlaceholder();
}

function teardownChatHost() {
  if (!isChatAppsHosted()) return;
  const chat = $("notes-chat-view");
  const home = clueHomeParent();
  if (chat && home && chat.parentElement !== home) {
    const cluePh = $("notes-clue-apps-placeholder");
    if (cluePh && cluePh.parentElement === home) {
      home.insertBefore(chat, cluePh);
    } else {
      const clueView = $("notes-clue-board-view");
      if (clueView && clueView.parentElement === home) {
        home.insertBefore(chat, clueView);
      } else {
        home.appendChild(chat);
      }
    }
  }
  if (chat) {
    const notesStream =
      document
        .querySelector("#notes-mode-seg [data-notes-mode='stream']")
        ?.classList.contains("active") ?? false;
    chat.classList.toggle("hidden", !notesStream);
  }
  setChatAppsHosted(false);
  syncChatPlaceholder();
}

async function teardownClueHost() {
  if (!isClueAppsHosted()) return;
  const board = $("notes-clue-board-view");
  const home = clueHomeParent();
  if (board && home && board.parentElement !== home) {
    const timeline = $("notes-timeline-view");
    if (timeline && timeline.parentElement === home) {
      home.insertBefore(board, timeline);
    } else {
      home.appendChild(board);
    }
  }
  if (board) {
    const notesClue =
      document
        .querySelector("#notes-mode-seg [data-notes-mode='clue']")
        ?.classList.contains("active") ?? false;
    board.classList.toggle("hidden", !notesClue);
  }
  setClueAppsHosted(false);
  if (
    !(
      document
        .querySelector("#notes-mode-seg [data-notes-mode='clue']")
        ?.classList.contains("active") ?? false
    )
  ) {
    leaveClueBoardMode();
  }
  syncCluePlaceholder();
}

function closeMenu() {
  hideFloat(menuEl);
  const plus = $("shell-apps-plus") as HTMLButtonElement | null;
  if (plus) plus.setAttribute("aria-expanded", "false");
  closeCluePicker();
  closeThreadPicker();
}

function openMenu() {
  const plus = $("shell-apps-plus");
  if (!plus || !menuEl) return;
  menuFilter = "";
  const input = menuEl.querySelector(
    ".shell-apps-menu-search"
  ) as HTMLInputElement | null;
  if (input) input.value = "";
  renderMenuList();
  placeFloatInViewport(menuEl, plus.getBoundingClientRect(), "above", 280);
  revealFloat(menuEl);
  plus.setAttribute("aria-expanded", "true");
  requestAnimationFrame(() => input?.focus());
}

function bindSubmenuRow(btn: HTMLButtonElement, kind: "clue" | "chat") {
  btn.classList.add("has-submenu");
  btn.setAttribute("aria-haspopup", "menu");
  const caret = document.createElement("span");
  caret.className = "shell-apps-menu-caret";
  caret.setAttribute("aria-hidden", "true");
  caret.textContent = ">";
  btn.appendChild(caret);
  btn.addEventListener("pointerenter", () => {
    window.clearTimeout(submenuCloseTimer);
    window.clearTimeout(submenuHoverTimer);
    submenuHoverTimer = window.setTimeout(() => {
      void openKindSubmenu(kind, btn);
    }, PICKER_HOVER_OPEN_MS);
  });
  btn.addEventListener("pointerleave", () => {
    window.clearTimeout(submenuHoverTimer);
    scheduleCloseSubmenu();
  });
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    void openKindSubmenu(kind, btn);
  });
}

function renderMenuList() {
  if (!menuEl) return;
  closeCluePicker();
  closeThreadPicker();
  const list = menuEl.querySelector(".shell-apps-menu-list");
  if (!list) return;
  const q = menuFilter.trim().toLowerCase();
  list.innerHTML = "";
  for (const item of CATALOG) {
    const label = shellT(item.labelKey);
    const hint = shellT(item.hintKey);
    if (
      q &&
      !label.toLowerCase().includes(q) &&
      !hint.toLowerCase().includes(q) &&
      !item.kind.includes(q)
    ) {
      continue;
    }
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "shell-apps-menu-item";
    btn.dataset.kind = item.kind;
    btn.innerHTML = `<span class="shell-apps-menu-ico" aria-hidden="true">${item.icon}</span><span class="shell-apps-menu-copy"><span class="shell-apps-menu-label">${label}</span><span class="shell-apps-menu-hint">${hint}</span></span>`;
    if (item.kind === "clue" || item.kind === "chat") {
      bindSubmenuRow(btn, item.kind);
    } else {
      btn.addEventListener("pointerenter", () => {
        window.clearTimeout(submenuHoverTimer);
        scheduleCloseSubmenu();
      });
      btn.addEventListener("click", () => {
        closeMenu();
        void addPane(item.kind);
      });
    }
    list.appendChild(btn);
  }
  if (!list.childElementCount) {
    const empty = document.createElement("div");
    empty.className = "shell-apps-menu-empty";
    empty.textContent = shellT("shell.apps.menuEmpty");
    list.appendChild(empty);
  }
}

async function addPane(kind: AppsPaneKind) {
  if (kind === "clue" || kind === "chat") return;
  const pane: AppsPaneState = { id: uid(), kind };
  layout.panes.push(pane);
  layout.activeId = pane.id;
  persistLayout();
  if (!layout.expanded) setExpanded(true);
  else renderPanes();
  if (kind === "browser") {
    await pickBrowserFile(pane.id);
  }
}

async function openClueInstance(boardId: string) {
  if (!boardId) return;
  const existing = layout.panes.find(
    (p) => p.kind === "clue" && p.boardId === boardId
  );
  if (existing) {
    if (!layout.expanded) setExpanded(true);
    await activatePane(existing.id);
    return;
  }
  const showingClue =
    layout.expanded && getActivePane()?.kind === "clue" && isClueAppsHosted();
  const pane: AppsPaneState = { id: uid(), kind: "clue", boardId };
  layout.panes.push(pane);
  layout.activeId = pane.id;
  persistLayout();
  if (!layout.expanded) {
    setExpanded(true);
    return;
  }
  if (showingClue) {
    await switchClueBoard(boardId);
    renderChromeTabs();
    syncChatChromeExtras();
    return;
  }
  renderPanes();
}

async function openChatInstance(threadId: string | null) {
  const existing = layout.panes.find((p) => {
    if (p.kind !== "chat") return false;
    return threadId ? p.threadId === threadId : !p.threadId;
  });
  if (existing) {
    if (!layout.expanded) setExpanded(true);
    await activatePane(existing.id);
    return;
  }
  const showingChat =
    layout.expanded && getActivePane()?.kind === "chat" && isChatAppsHosted();
  const pane: AppsPaneState = { id: uid(), kind: "chat" };
  if (threadId) pane.threadId = threadId;
  layout.panes.push(pane);
  layout.activeId = pane.id;
  persistLayout();
  if (!layout.expanded) {
    setExpanded(true);
    return;
  }
  if (showingChat) {
    if (threadId) await applyWirePreset(threadId);
    renderChromeTabs();
    syncChatChromeExtras();
    applyHideNonGreenFilter();
    return;
  }
  renderPanes();
}

async function activatePane(id: string) {
  const pane = layout.panes.find((p) => p.id === id);
  if (!pane) return;
  const prev = getActivePane();
  const already =
    prev?.id === pane.id &&
    !!document.querySelector(`.shell-apps-pane[data-pane-id="${id}"]`);
  if (already) {
    renderChromeTabs();
    return;
  }
  const prevKind = prev?.kind;
  layout.activeId = pane.id;
  persistLayout();
  if (prevKind === "clue" && pane.kind === "clue" && isClueAppsHosted()) {
    if (pane.boardId) await switchClueBoard(pane.boardId);
    renderChromeTabs();
    syncChatChromeExtras();
    return;
  }
  if (prevKind === "chat" && pane.kind === "chat" && isChatAppsHosted()) {
    if (pane.threadId) await applyWirePreset(pane.threadId);
    renderChromeTabs();
    syncChatChromeExtras();
    applyHideNonGreenFilter();
    return;
  }
  renderPanes();
}

async function removePane(id: string) {
  const pane = layout.panes.find((p) => p.id === id);
  const idx = layout.panes.findIndex((p) => p.id === id);
  layout.panes = layout.panes.filter((p) => p.id !== id);
  paneEls.delete(id);
  fileCaches.delete(id);
  fileExpanded.delete(id);
  fileSelected.delete(id);
  if (layout.activeId === id) {
    const neighbor =
      layout.panes[idx] || layout.panes[idx - 1] || layout.panes[layout.panes.length - 1];
    layout.activeId = neighbor?.id ?? null;
  }
  persistLayout();
  if (pane?.kind === "clue" && !layout.panes.some((p) => p.kind === "clue")) {
    await flushClueBoardSave().catch(() => {});
    await teardownClueHost();
  }
  if (pane?.kind === "chat" && !layout.panes.some((p) => p.kind === "chat")) {
    teardownChatHost();
  }
  renderPanes();
}

function renderPanes() {
  const host = $("shell-apps-panes");
  if (!host) return;
  stashSharedViews();
  host.replaceChildren();
  renderChromeTabs();
  if (!layout.panes.length) {
    const empty = document.createElement("div");
    empty.className = "shell-apps-empty";
    empty.textContent = shellT("shell.apps.empty");
    host.appendChild(empty);
    syncChatChromeExtras();
    return;
  }
  const active = getActivePane();
  if (!active) return;
  layout.activeId = active.id;
  let el = paneEls.get(active.id);
  if (!el) {
    el = buildPaneEl(active);
    paneEls.set(active.id, el);
  }
  host.appendChild(el);
  const body = el.querySelector(".shell-apps-pane-body") as HTMLElement | null;
  if (active.kind === "clue" && body) void mountClueInto(body);
  if (active.kind === "chat" && body) void mountChatInto(body);
  void parkClueIfNeeded();
  void parkChatIfNeeded();
  syncChatChromeExtras();
}

function buildPaneEl(pane: AppsPaneState): HTMLElement {
  const el = document.createElement("section");
  el.className = "shell-apps-pane";
  el.dataset.paneId = pane.id;
  el.dataset.kind = pane.kind;

  const body = document.createElement("div");
  body.className = "shell-apps-pane-body";

  if (
    pane.kind !== "clue" &&
    pane.kind !== "chat" &&
    pane.kind !== "file" &&
    pane.kind !== "browser"
  ) {
    const bar = document.createElement("div");
    bar.className = "shell-apps-pane-bar";
    const title = document.createElement("span");
    title.className = "shell-apps-pane-title";
    title.textContent = paneTabTitle(pane);
    bar.append(title);
    el.append(bar, body);
  } else {
    el.append(body);
  }

  switch (pane.kind) {
    case "clue":
      body.classList.add("is-clue-host");
      break;
    case "chat":
      body.classList.add("is-chat-host");
      break;
    case "canvas":
      fillCanvas(body, pane);
      break;
    case "browser":
      fillBrowser(body, pane);
      break;
    case "terminal":
      fillTerminal(body);
      break;
    case "file":
      fillFile(body, pane);
      break;
  }
  return el;
}

function paneTabTitle(pane: AppsPaneState): string {
  if (pane.kind === "clue") {
    const board = listClueBoardSummaries().find((b) => b.id === pane.boardId);
    return board?.title || kindLabel("clue");
  }
  if (pane.kind === "chat") {
    if (!pane.threadId) return shellT("shell.apps.chat.currentThread");
    const thread = listWirePresetSummaries().find((t) => t.id === pane.threadId);
    return thread?.title || kindLabel("chat");
  }
  if ((pane.kind === "file" || pane.kind === "browser") && pane.path) {
    return pathBasename(pane.path) || kindLabel(pane.kind);
  }
  return kindLabel(pane.kind);
}

function beginChromeRename(id: string, nameEl: HTMLElement) {
  const input = document.createElement("input");
  input.type = "text";
  input.className = "shell-apps-clue-tab-rename";
  const current = listClueBoardSummaries().find((b) => b.id === id);
  input.value =
    current?.title === shellT("notes.clue.boards.untitled") ? "" : current?.title || "";
  input.maxLength = 120;
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  const commit = () => {
    renameClueBoard(id, input.value);
  };
  input.addEventListener("blur", () => commit(), { once: true });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      input.blur();
    } else if (e.key === "Escape") {
      e.preventDefault();
      input.value = current?.title || "";
      input.blur();
    }
  });
}

function renderChromeTabs() {
  const strip = $("shell-apps-tabstrip");
  if (!strip) return;
  strip.replaceChildren();
  const activeId = getActivePane()?.id;
  for (const pane of layout.panes) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "shell-apps-clue-tab";
    tab.dataset.paneId = pane.id;
    tab.dataset.kind = pane.kind;
    tab.classList.toggle("is-active", pane.id === activeId);
    if (pane.kind === "clue" && pane.boardId) {
      tab.title = shellT("notes.clue.boards.renameHint");
    }
    const name = document.createElement("span");
    name.className = "shell-apps-clue-tab-name";
    name.textContent = paneTabTitle(pane);
    tab.appendChild(name);
    const close = document.createElement("span");
    close.className = "shell-apps-tab-x";
    close.setAttribute("aria-label", shellT("shell.apps.closePane"));
    close.textContent = "×";
    close.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      void removePane(pane.id);
    });
    tab.appendChild(close);
    tab.addEventListener("click", () => {
      void activatePane(pane.id);
    });
    if (pane.kind === "clue" && pane.boardId) {
      tab.addEventListener("dblclick", (e) => {
        e.preventDefault();
        e.stopPropagation();
        beginChromeRename(pane.boardId!, name);
      });
    }
    strip.appendChild(tab);
  }
  syncChatChromeExtras();
}

function syncChatChromeExtras() {
  const head = document.querySelector("#shell-apps .shell-apps-head");
  if (!head) return;
  let lab = head.querySelector(".shell-apps-hide-green") as HTMLElement | null;
  const show = getActivePane()?.kind === "chat";
  if (!show) {
    lab?.remove();
    return;
  }
  if (!lab) {
    lab = document.createElement("label");
    lab.className = "shell-apps-hide-green";
    const input = document.createElement("input");
    input.type = "checkbox";
    const span = document.createElement("span");
    lab.append(input, span);
    const toggle = $("btn-shell-apps");
    if (toggle && head.contains(toggle)) head.insertBefore(lab, toggle);
    else head.appendChild(lab);
    input.addEventListener("change", () => {
      setHideNonGreen(input.checked);
    });
  }
  const input = lab.querySelector("input") as HTMLInputElement;
  const span = lab.querySelector("span");
  input.checked = isHideNonGreenOn();
  if (span) span.textContent = shellT("shell.apps.chat.hideNonGreen");
  lab.title = shellT("shell.apps.chat.hideNonGreenHint");
}

function submenuAnchorHovered(): boolean {
  return !!menuEl?.querySelector(".shell-apps-menu-item.is-submenu-open:hover");
}

function pickerHovered(): boolean {
  return !!(
    (cluePickerEl && !cluePickerEl.classList.contains("hidden") && cluePickerEl.matches(":hover")) ||
    (threadPickerEl && !threadPickerEl.classList.contains("hidden") && threadPickerEl.matches(":hover"))
  );
}

function scheduleCloseSubmenu() {
  window.clearTimeout(submenuCloseTimer);
  submenuCloseTimer = window.setTimeout(() => {
    if (submenuAnchorHovered() || pickerHovered()) return;
    closeCluePicker();
    closeThreadPicker();
  }, PICKER_HOVER_CLOSE_MS);
}

async function openKindSubmenu(kind: "clue" | "chat", anchor: HTMLButtonElement) {
  await ensureNotesReady();
  submenuKind = kind;
  menuEl
    ?.querySelectorAll(".shell-apps-menu-item.is-submenu-open")
    .forEach((el) => el.classList.remove("is-submenu-open"));
  anchor.classList.add("is-submenu-open");
  if (kind === "clue") {
    closeThreadPicker();
    openCluePicker(anchor);
  } else {
    closeCluePicker();
    openThreadPicker(anchor);
  }
}

function closeCluePicker() {
  window.clearTimeout(submenuHoverTimer);
  hideFloat(cluePickerEl);
  if (submenuKind === "clue") {
    submenuKind = null;
    menuEl
      ?.querySelectorAll('.shell-apps-menu-item[data-kind="clue"]')
      .forEach((el) => el.classList.remove("is-submenu-open"));
  }
}

function renderCluePickerList() {
  if (!cluePickerEl) return;
  const list = cluePickerEl.querySelector(".shell-apps-clue-picker-list");
  if (!list) return;
  const q = cluePickerFilter.trim().toLowerCase();
  const active = getActivePane();
  const boards = listClueBoardSummaries();
  list.replaceChildren();
  let n = 0;
  for (const board of boards) {
    if (q && !board.title.toLowerCase().includes(q)) continue;
    n += 1;
    const row = document.createElement("div");
    row.className = "shell-apps-clue-picker-item";
    row.classList.toggle(
      "is-active",
      active?.kind === "clue" && active.boardId === board.id
    );
    row.setAttribute("role", "option");
    row.setAttribute(
      "aria-selected",
      active?.kind === "clue" && active.boardId === board.id ? "true" : "false"
    );
    const name = document.createElement("button");
    name.type = "button";
    name.className = "shell-apps-clue-picker-item-name";
    name.textContent = board.title;
    name.addEventListener("click", () => {
      closeMenu();
      void openClueInstance(board.id);
    });
    row.appendChild(name);
    if (boards.length > 1) {
      const del = document.createElement("button");
      del.type = "button";
      del.className = "shell-apps-clue-picker-item-del";
      del.setAttribute("aria-label", shellT("notes.clue.boards.delete"));
      del.textContent = "×";
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        void deleteClueBoard(board.id);
      });
      row.appendChild(del);
    }
    list.appendChild(row);
  }
  if (!n) {
    const empty = document.createElement("div");
    empty.className = "shell-apps-clue-picker-empty";
    empty.textContent = shellT("shell.apps.clue.pickerEmpty");
    list.appendChild(empty);
  }
}

function ensureCluePickerDom() {
  if (cluePickerEl) return;
  cluePickerEl = document.createElement("div");
  cluePickerEl.id = "shell-apps-clue-picker";
  cluePickerEl.className = "omni-float shell-apps-clue-picker hidden";
  cluePickerEl.setAttribute("aria-hidden", "true");
  cluePickerEl.innerHTML = `
    <div class="shell-apps-clue-picker-search-wrap">
      <input type="search" class="shell-apps-clue-picker-search" placeholder="" autocomplete="off" />
    </div>
    <div class="shell-apps-clue-picker-list" role="listbox"></div>
    <div class="shell-apps-clue-picker-foot">
      <button type="button" class="shell-apps-clue-picker-new"></button>
    </div>
  `;
  document.body.appendChild(cluePickerEl);
  const input = cluePickerEl.querySelector(
    ".shell-apps-clue-picker-search"
  ) as HTMLInputElement;
  input.placeholder = shellT("shell.apps.clue.pickerSearch");
  input.addEventListener("input", () => {
    cluePickerFilter = input.value;
    renderCluePickerList();
  });
  const neu = cluePickerEl.querySelector(
    ".shell-apps-clue-picker-new"
  ) as HTMLButtonElement;
  neu.textContent = shellT("shell.apps.clue.newBoard");
  neu.addEventListener("click", () => {
    void createClueBoard().then((id) => {
      closeMenu();
      if (id) void openClueInstance(id);
    });
  });
  cluePickerEl.addEventListener("pointerenter", () => {
    window.clearTimeout(submenuCloseTimer);
  });
  cluePickerEl.addEventListener("pointerleave", () => scheduleCloseSubmenu());
}

function openCluePicker(anchor: HTMLElement) {
  ensureCluePickerDom();
  if (!cluePickerEl) return;
  cluePickerFilter = "";
  const input = cluePickerEl.querySelector(
    ".shell-apps-clue-picker-search"
  ) as HTMLInputElement | null;
  if (input) input.value = "";
  renderCluePickerList();
  placeFloatInViewport(cluePickerEl, anchor.getBoundingClientRect(), "left", 280);
  revealFloat(cluePickerEl);
  requestAnimationFrame(() => input?.focus());
}

function closeThreadPicker() {
  window.clearTimeout(submenuHoverTimer);
  hideFloat(threadPickerEl);
  if (submenuKind === "chat") {
    submenuKind = null;
    menuEl
      ?.querySelectorAll('.shell-apps-menu-item[data-kind="chat"]')
      .forEach((el) => el.classList.remove("is-submenu-open"));
  }
}

function renderThreadPickerList() {
  if (!threadPickerEl) return;
  const list = threadPickerEl.querySelector(".shell-apps-clue-picker-list");
  if (!list) return;
  const q = threadPickerFilter.trim().toLowerCase();
  const active = getActivePane();
  const threads = listWirePresetSummaries();
  list.replaceChildren();
  let n = 0;
  const currentTitle = shellT("shell.apps.chat.currentThread");
  if (!q || currentTitle.toLowerCase().includes(q)) {
    n += 1;
    const row = document.createElement("div");
    row.className = "shell-apps-clue-picker-item";
    row.classList.toggle("is-active", active?.kind === "chat" && !active.threadId);
    const name = document.createElement("button");
    name.type = "button";
    name.className = "shell-apps-clue-picker-item-name";
    name.textContent = currentTitle;
    name.addEventListener("click", () => {
      closeMenu();
      void openChatInstance(null);
    });
    row.appendChild(name);
    list.appendChild(row);
  }
  for (const thread of threads) {
    if (q && !thread.title.toLowerCase().includes(q)) continue;
    n += 1;
    const row = document.createElement("div");
    row.className = "shell-apps-clue-picker-item";
    row.classList.toggle(
      "is-active",
      active?.kind === "chat" && active.threadId === thread.id
    );
    const name = document.createElement("button");
    name.type = "button";
    name.className = "shell-apps-clue-picker-item-name";
    name.textContent = thread.title;
    name.addEventListener("click", () => {
      closeMenu();
      void openChatInstance(thread.id);
    });
    row.appendChild(name);
    list.appendChild(row);
  }
  if (!n) {
    const empty = document.createElement("div");
    empty.className = "shell-apps-clue-picker-empty";
    empty.textContent = shellT("shell.apps.chat.pickerEmpty");
    list.appendChild(empty);
  }
}

function ensureThreadPickerDom() {
  if (threadPickerEl) return;
  threadPickerEl = document.createElement("div");
  threadPickerEl.id = "shell-apps-thread-picker";
  threadPickerEl.className = "omni-float shell-apps-clue-picker hidden";
  threadPickerEl.setAttribute("aria-hidden", "true");
  threadPickerEl.innerHTML = `
    <div class="shell-apps-clue-picker-search-wrap">
      <input type="search" class="shell-apps-clue-picker-search" placeholder="" autocomplete="off" />
    </div>
    <div class="shell-apps-clue-picker-list" role="listbox"></div>
    <div class="shell-apps-clue-picker-foot">
      <button type="button" class="shell-apps-clue-picker-new"></button>
    </div>
  `;
  document.body.appendChild(threadPickerEl);
  const input = threadPickerEl.querySelector(
    ".shell-apps-clue-picker-search"
  ) as HTMLInputElement;
  input.placeholder = shellT("shell.apps.chat.pickerSearch");
  input.addEventListener("input", () => {
    threadPickerFilter = input.value;
    renderThreadPickerList();
  });
  const neu = threadPickerEl.querySelector(
    ".shell-apps-clue-picker-new"
  ) as HTMLButtonElement;
  neu.textContent = shellT("shell.apps.chat.saveThread");
  neu.addEventListener("click", () => {
    const name = window.prompt(shellT("shell.apps.chat.saveName"));
    if (!name) return;
    void saveCurrentWirePreset(name).then((ok) => {
      if (!ok) return;
      const id = getSelectedWirePresetId();
      closeMenu();
      if (id) void openChatInstance(id);
      else {
        renderThreadPickerList();
        renderChromeTabs();
      }
    });
  });
  threadPickerEl.addEventListener("pointerenter", () => {
    window.clearTimeout(submenuCloseTimer);
  });
  threadPickerEl.addEventListener("pointerleave", () => scheduleCloseSubmenu());
}

function openThreadPicker(anchor: HTMLElement) {
  ensureThreadPickerDom();
  if (!threadPickerEl) return;
  threadPickerFilter = "";
  const input = threadPickerEl.querySelector(
    ".shell-apps-clue-picker-search"
  ) as HTMLInputElement | null;
  if (input) input.value = "";
  renderThreadPickerList();
  placeFloatInViewport(threadPickerEl, anchor.getBoundingClientRect(), "left", 280);
  revealFloat(threadPickerEl);
  requestAnimationFrame(() => input?.focus());
}

function fillCanvas(body: HTMLElement, pane: AppsPaneState) {
  const wrap = document.createElement("div");
  wrap.className = "shell-apps-canvas";
  const hint = document.createElement("div");
  hint.className = "shell-apps-stub-badge";
  hint.textContent = shellT("shell.apps.canvas.badge");
  const ta = document.createElement("textarea");
  ta.className = "shell-apps-canvas-ta";
  ta.placeholder = shellT("shell.apps.canvas.placeholder");
  ta.value = pane.canvasText || "";
  ta.addEventListener("input", () => {
    pane.canvasText = ta.value;
    persistLayout();
  });
  wrap.append(hint, ta);
  body.appendChild(wrap);
}

function paneBodyEl(id: string): HTMLElement | null {
  const root =
    paneEls.get(id) ??
    document.querySelector(`.shell-apps-pane[data-pane-id="${id}"]`);
  const body = root?.querySelector(".shell-apps-pane-body");
  return body instanceof HTMLElement ? body : null;
}

function isInlinePreviewable(path: string): boolean {
  const lower = path.toLowerCase();
  return /\.(pdf|png|jpe?g|gif|webp|svg|html?|txt|md|csv|json|xml)$/i.test(
    lower
  );
}

async function pickBrowserFile(paneId: string) {
  try {
    const selected = await open({
      multiple: false,
      filters: [
        {
          name: "Documents",
          extensions: [
            "pdf",
            "png",
            "jpg",
            "jpeg",
            "gif",
            "webp",
            "svg",
            "html",
            "htm",
            "txt",
            "md",
            "csv",
            "json",
            "doc",
            "docx",
            "xls",
            "xlsx",
            "ppt",
            "pptx",
          ],
        },
      ],
    });
    const path = typeof selected === "string" ? selected : null;
    if (!path) return;
    const pane = layout.panes.find((p) => p.id === paneId);
    if (!pane) return;
    pane.path = path;
    persistLayout();
    const body = paneBodyEl(paneId);
    if (body) {
      body.innerHTML = "";
      fillBrowser(body, pane);
      renderChromeTabs();
      return;
    }
    renderPanes();
  } catch (e) {
    console.error("[shell-apps] open file failed", e);
  }
}

function fillBrowser(body: HTMLElement, pane: AppsPaneState) {
  const toolbar = document.createElement("div");
  toolbar.className = "shell-apps-browser-bar";
  const openBtn = document.createElement("button");
  openBtn.type = "button";
  openBtn.className = "shell-apps-mini-btn";
  openBtn.textContent = shellT("shell.apps.browser.open");
  openBtn.addEventListener("click", () => void pickBrowserFile(pane.id));
  const sysBtn = document.createElement("button");
  sysBtn.type = "button";
  sysBtn.className = "shell-apps-mini-btn";
  sysBtn.textContent = shellT("shell.apps.browser.system");
  sysBtn.disabled = !pane.path;
  sysBtn.addEventListener("click", () => {
    if (pane.path) void openPath(pane.path).catch(console.error);
  });
  const pathLab = document.createElement("div");
  pathLab.className = "shell-apps-path";
  pathLab.textContent = pane.path || shellT("shell.apps.browser.noFile");
  pathLab.title = pane.path || "";
  toolbar.append(openBtn, sysBtn, pathLab);
  body.appendChild(toolbar);

  if (!pane.path) {
    const empty = document.createElement("div");
    empty.className = "shell-apps-pane-empty";
    empty.textContent = shellT("shell.apps.browser.empty");
    body.appendChild(empty);
    return;
  }

  if (isInlinePreviewable(pane.path)) {
    try {
      const frame = document.createElement("iframe");
      frame.className = "shell-apps-browser-frame";
      frame.title = kindLabel("browser");
      frame.src = convertFileSrc(pane.path);
      body.appendChild(frame);
    } catch (e) {
      const err = document.createElement("div");
      err.className = "shell-apps-pane-empty";
      err.textContent = `${shellT("shell.apps.browser.previewFail")} ${String(e)}`;
      body.appendChild(err);
    }
  } else {
    const tip = document.createElement("div");
    tip.className = "shell-apps-pane-empty";
    tip.innerHTML = `${shellT("shell.apps.browser.officeTip")}<br/><button type="button" class="shell-apps-mini-btn shell-apps-office-open">${shellT("shell.apps.browser.system")}</button>`;
    tip
      .querySelector(".shell-apps-office-open")
      ?.addEventListener("click", () => {
        if (pane.path) void openPath(pane.path).catch(console.error);
      });
    body.appendChild(tip);
  }
}

function fillTerminal(body: HTMLElement) {
  const wrap = document.createElement("div");
  wrap.className = "shell-apps-term";
  const badge = document.createElement("div");
  badge.className = "shell-apps-stub-badge";
  badge.textContent = shellT("shell.apps.terminal.badge");
  const out = document.createElement("pre");
  out.className = "shell-apps-term-out";
  out.textContent = shellT("shell.apps.terminal.welcome");
  const row = document.createElement("div");
  row.className = "shell-apps-term-row";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "shell-apps-term-input";
  input.placeholder = shellT("shell.apps.terminal.placeholder");
  input.spellcheck = false;
  const run = document.createElement("button");
  run.type = "button";
  run.className = "shell-apps-mini-btn primary";
  run.textContent = shellT("shell.apps.terminal.run");
  const external = document.createElement("button");
  external.type = "button";
  external.className = "shell-apps-mini-btn";
  external.textContent = shellT("shell.apps.terminal.external");
  external.addEventListener("click", () => {
    void openPath("wt.exe").catch(() =>
      openPath("cmd.exe").catch(console.error)
    );
  });

  async function exec() {
    const cmd = input.value.trim();
    if (!cmd) return;
    out.textContent += `\n› ${cmd}\n`;
    input.value = "";
    run.disabled = true;
    try {
      const res = await invoke<{
        ok: boolean;
        code: number | null;
        stdout: string;
        stderr: string;
        timedOut: boolean;
        elapsedMs: number;
      }>("apps_run_shell", { command: cmd });
      if (res.stdout) out.textContent += res.stdout;
      if (res.stderr) out.textContent += (res.stdout ? "\n" : "") + res.stderr;
      out.textContent += `\n[${res.timedOut ? "timeout" : res.ok ? "ok" : "fail"} · ${res.elapsedMs}ms${res.code != null ? ` · code ${res.code}` : ""}]\n`;
    } catch (e) {
      out.textContent += `error: ${e instanceof Error ? e.message : String(e)}\n`;
    } finally {
      run.disabled = false;
      out.scrollTop = out.scrollHeight;
      input.focus();
    }
  }

  run.addEventListener("click", () => void exec());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void exec();
    }
  });
  row.append(input, run, external);
  wrap.append(badge, out, row);
  body.appendChild(wrap);
}

async function pickFileRoot(paneId: string) {
  try {
    const selected = await open({ directory: true, multiple: false });
    const path = typeof selected === "string" ? selected : null;
    if (!path) return;
    const pane = layout.panes.find((p) => p.id === paneId);
    if (!pane) return;
    pane.path = path;
    persistFileRoot(path);
    persistLayout();
    fileCaches.delete(paneId);
    fileExpanded.delete(paneId);
    const body = paneBodyEl(paneId);
    if (body) {
      body.innerHTML = "";
      fillFile(body, pane);
      renderChromeTabs();
      return;
    }
    renderPanes();
  } catch (e) {
    console.error("[shell-apps] pick dir failed", e);
  }
}

async function defaultFileRoot(): Promise<string | null> {
  try {
    const last = localStorage.getItem(FILE_ROOT_KEY);
    if (last) return last;
  } catch {
    /* ignore */
  }
  try {
    const dataRoot = await invoke<string>("get_data_root");
    if (!dataRoot) return null;
    const trimmed = dataRoot.replace(/[\\/]+$/, "");
    if (/OmniDatabase$/i.test(trimmed)) {
      const parent = pathParent(trimmed);
      if (parent) {
        try {
          await invoke("apps_list_dir", { path: parent });
          return parent;
        } catch {
          /* fall through */
        }
      }
    }
    return trimmed;
  } catch {
    return null;
  }
}

function openFileInBrowser(path: string) {
  let browser = layout.panes.find((p) => p.kind === "browser");
  if (!browser) {
    browser = { id: uid(), kind: "browser", path };
    layout.panes.push(browser);
    layout.activeId = browser.id;
    persistLayout();
    renderPanes();
    return;
  }
  browser.path = path;
  persistLayout();
  const body = paneBodyEl(browser.id);
  if (body) {
    body.innerHTML = "";
    fillBrowser(body, browser);
  }
  void activatePane(browser.id);
}

async function ensureDirEntries(
  paneId: string,
  dirPath: string
): Promise<AppsDirEntry[]> {
  let cache = fileCaches.get(paneId);
  if (!cache) {
    cache = new Map();
    fileCaches.set(paneId, cache);
  }
  const hit = cache.get(dirPath);
  if (hit) return hit;
  const entries = await invoke<AppsDirEntry[]>("apps_list_dir", { path: dirPath });
  cache.set(dirPath, entries);
  return entries;
}

function makeTreeRow(
  depth: number,
  name: string,
  isDir: boolean,
  expanded: boolean,
  selected: boolean
): HTMLButtonElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = `shell-apps-tree-row ${isDir ? "is-dir" : "is-file"}`;
  row.classList.toggle("is-selected", selected);
  row.style.setProperty("--depth", String(depth));
  const twist = document.createElement("span");
  twist.className = "shell-apps-tree-twist";
  twist.textContent = isDir ? (expanded ? "▾" : "▸") : "";
  const label = document.createElement("span");
  label.className = "shell-apps-tree-name";
  label.textContent = name;
  row.append(twist, label);
  return row;
}

async function paintTree(
  host: HTMLElement,
  pane: AppsPaneState,
  dirPath: string,
  depth: number,
  displayName: string,
  expanded: Set<string>
) {
  const isOpen = expanded.has(dirPath);
  const row = makeTreeRow(depth, displayName, true, isOpen, false);
  row.title = dirPath;
  row.addEventListener("click", () => {
    if (expanded.has(dirPath)) expanded.delete(dirPath);
    else expanded.add(dirPath);
    void renderFileTree(host, pane);
  });
  host.appendChild(row);
  if (!isOpen) return;
  try {
    const entries = await ensureDirEntries(pane.id, dirPath);
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "shell-apps-tree-empty";
      empty.style.setProperty("--depth", String(depth + 1));
      empty.textContent = shellT("shell.apps.file.emptyDir");
      host.appendChild(empty);
      return;
    }
    const selected = fileSelected.get(pane.id);
    for (const ent of entries) {
      if (ent.isDir) {
        await paintTree(host, pane, ent.path, depth + 1, ent.name, expanded);
      } else {
        const fileRow = makeTreeRow(depth + 1, ent.name, false, false, selected === ent.path);
        fileRow.title = ent.path;
        fileRow.addEventListener("click", () => {
          fileSelected.set(pane.id, ent.path);
          host
            .querySelectorAll(".shell-apps-tree-row.is-selected")
            .forEach((el) => el.classList.remove("is-selected"));
          fileRow.classList.add("is-selected");
          openFileInBrowser(ent.path);
        });
        host.appendChild(fileRow);
      }
    }
  } catch (e) {
    const err = document.createElement("div");
    err.className = "shell-apps-tree-empty";
    err.textContent = `${shellT("shell.apps.file.listFail")}: ${
      e instanceof Error ? e.message : String(e)
    }`;
    host.appendChild(err);
  }
}

async function renderFileTree(tree: HTMLElement, pane: AppsPaneState) {
  const root = pane.path;
  tree.replaceChildren();
  if (!root) {
    const empty = document.createElement("div");
    empty.className = "shell-apps-tree-empty";
    empty.textContent = shellT("shell.apps.file.empty");
    tree.appendChild(empty);
    return;
  }
  let expanded = fileExpanded.get(pane.id);
  if (!expanded) {
    expanded = new Set([root]);
    fileExpanded.set(pane.id, expanded);
  } else if (!expanded.has(root)) {
    expanded.add(root);
  }
  await paintTree(tree, pane, root, 0, pathBasename(root) || root, expanded);
}

function fillFile(body: HTMLElement, pane: AppsPaneState) {
  const toolbar = document.createElement("div");
  toolbar.className = "shell-apps-browser-bar";
  const pick = document.createElement("button");
  pick.type = "button";
  pick.className = "shell-apps-mini-btn";
  pick.textContent = shellT("shell.apps.file.openFolder");
  pick.addEventListener("click", () => void pickFileRoot(pane.id));
  const pathLab = document.createElement("div");
  pathLab.className = "shell-apps-path";
  pathLab.textContent = pane.path || shellT("shell.apps.file.noDir");
  pathLab.title = pane.path || "";
  toolbar.append(pick, pathLab);
  body.appendChild(toolbar);

  const tree = document.createElement("div");
  tree.className = "shell-apps-tree";
  body.appendChild(tree);

  void (async () => {
    if (!pane.path) {
      const guessed = await defaultFileRoot();
      if (guessed) {
        pane.path = guessed;
        persistFileRoot(guessed);
        persistLayout();
        pathLab.textContent = guessed;
        pathLab.title = guessed;
        renderChromeTabs();
      }
    }
    await renderFileTree(tree, pane);
  })();
}

function bindResize(handle: HTMLElement) {
  let dragging = false;
  let startX = 0;
  let startW = 0;
  handle.addEventListener("pointerdown", (e) => {
    if (!layout.expanded) return;
    dragging = true;
    startX = e.clientX;
    startW = clampWidth(layout.width);
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add("shell-apps-resizing");
  });
  handle.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const next = clampWidth(startW + (startX - e.clientX));
    layout.width = next;
    const col = $("shell-apps");
    if (col) col.style.width = `${next}px`;
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("shell-apps-resizing");
    persistLayout();
  };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

function ensureMenuDom() {
  if (menuEl) return;
  menuEl = document.createElement("div");
  menuEl.id = "shell-apps-menu";
  menuEl.className = "omni-float shell-apps-menu hidden";
  menuEl.setAttribute("aria-hidden", "true");
  menuEl.innerHTML = `
    <div class="shell-apps-menu-search-wrap">
      <input type="search" class="shell-apps-menu-search" placeholder="" autocomplete="off" />
    </div>
    <div class="shell-apps-menu-list" role="menu"></div>
  `;
  document.body.appendChild(menuEl);
  const input = menuEl.querySelector(
    ".shell-apps-menu-search"
  ) as HTMLInputElement;
  input.placeholder = shellT("shell.apps.menuSearch");
  input.addEventListener("input", () => {
    menuFilter = input.value;
    renderMenuList();
  });
  document.addEventListener("pointerdown", (e) => {
    const t = e.target as Node;
    const inMenu = !!(menuEl && menuEl.contains(t));
    const inPlus = !!$("shell-apps-plus")?.contains(t);
    const inClue = !!(cluePickerEl && cluePickerEl.contains(t));
    const inThread = !!(threadPickerEl && threadPickerEl.contains(t));
    if (menuEl && !menuEl.classList.contains("hidden")) {
      if (!inMenu && !inPlus && !inClue && !inThread) closeMenu();
    } else {
      if (cluePickerEl && !cluePickerEl.classList.contains("hidden") && !inClue) {
        closeCluePicker();
      }
      if (threadPickerEl && !threadPickerEl.classList.contains("hidden") && !inThread) {
        closeThreadPicker();
      }
    }
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const pickerOpen =
      (cluePickerEl && !cluePickerEl.classList.contains("hidden")) ||
      (threadPickerEl && !threadPickerEl.classList.contains("hidden"));
    if (pickerOpen) {
      closeCluePicker();
      closeThreadPicker();
      return;
    }
    if (menuEl && !menuEl.classList.contains("hidden")) closeMenu();
  });
}

function refreshI18n() {
  const btn = $("btn-shell-apps");
  if (btn) {
    btn.title = layout.expanded
      ? shellT("shell.apps.hide")
      : shellT("shell.apps.show");
    btn.setAttribute(
      "aria-label",
      layout.expanded ? shellT("shell.apps.hide") : shellT("shell.apps.show")
    );
  }
  const plus = $("shell-apps-plus");
  if (plus) {
    plus.setAttribute("aria-label", shellT("shell.apps.add"));
    plus.title = shellT("shell.apps.add");
  }
  const search = menuEl?.querySelector(
    ".shell-apps-menu-search"
  ) as HTMLInputElement | null;
  if (search) search.placeholder = shellT("shell.apps.menuSearch");
  const pickerSearch = cluePickerEl?.querySelector(
    ".shell-apps-clue-picker-search"
  ) as HTMLInputElement | null;
  if (pickerSearch) pickerSearch.placeholder = shellT("shell.apps.clue.pickerSearch");
  const pickerNew = cluePickerEl?.querySelector(
    ".shell-apps-clue-picker-new"
  ) as HTMLButtonElement | null;
  if (pickerNew) pickerNew.textContent = shellT("shell.apps.clue.newBoard");
  const ph = $("notes-clue-apps-placeholder");
  if (ph) ph.textContent = shellT("shell.apps.clueMoved");
  const chatPh = $("notes-chat-apps-placeholder");
  if (chatPh) chatPh.textContent = shellT("shell.apps.chatMoved");
  const tSearch = threadPickerEl?.querySelector(
    ".shell-apps-clue-picker-search"
  ) as HTMLInputElement | null;
  if (tSearch) tSearch.placeholder = shellT("shell.apps.chat.pickerSearch");
  const tNew = threadPickerEl?.querySelector(
    ".shell-apps-clue-picker-new"
  ) as HTMLButtonElement | null;
  if (tNew) tNew.textContent = shellT("shell.apps.chat.saveThread");
  if (layout.expanded) renderPanes();
  if (menuEl && !menuEl.classList.contains("hidden")) renderMenuList();
  if (cluePickerEl && !cluePickerEl.classList.contains("hidden")) renderCluePickerList();
  if (threadPickerEl && !threadPickerEl.classList.contains("hidden")) renderThreadPickerList();
}

function pruneMissingInstances(kind: "clue" | "chat") {
  const boards = kind === "clue" ? listClueBoardSummaries() : null;
  const threads = kind === "chat" ? listWirePresetSummaries() : null;
  const before = layout.panes.length;
  layout.panes = layout.panes.filter((p) => {
    if (kind === "clue" && p.kind === "clue" && p.boardId && boards) {
      return boards.some((b) => b.id === p.boardId);
    }
    if (kind === "chat" && p.kind === "chat" && p.threadId && threads) {
      return threads.some((t) => t.id === p.threadId);
    }
    return true;
  });
  if (layout.panes.length === before) {
    renderChromeTabs();
    return;
  }
  for (const id of [...paneEls.keys()]) {
    if (!layout.panes.some((p) => p.id === id)) paneEls.delete(id);
  }
  if (layout.activeId && !layout.panes.some((p) => p.id === layout.activeId)) {
    layout.activeId = layout.panes[layout.panes.length - 1]?.id ?? null;
  }
  persistLayout();
  if (kind === "clue" && !layout.panes.some((p) => p.kind === "clue")) {
    void teardownClueHost();
  }
  if (kind === "chat" && !layout.panes.some((p) => p.kind === "chat")) {
    teardownChatHost();
  }
  renderPanes();
}

export function initShellApps(notesLoader: NotesLoader) {
  ensureNotes = notesLoader;
  layout = readLayout();
  ensureMenuDom();
  ensureCluePickerDom();
  ensureThreadPickerDom();

  const btn = $("btn-shell-apps");
  btn?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    setExpanded(!layout.expanded);
  });

  $("shell-apps-plus")?.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (menuEl && !menuEl.classList.contains("hidden")) closeMenu();
    else openMenu();
  });

  const handle = $("shell-apps-resize");
  if (handle) bindResize(handle);

  window.addEventListener("omnitrace-lang", () => refreshI18n());
  window.addEventListener(CLUE_BOARDS_UI_EVENT, () => {
    pruneMissingInstances("clue");
    if (cluePickerEl && !cluePickerEl.classList.contains("hidden")) {
      renderCluePickerList();
    }
  });
  window.addEventListener(WIRE_PRESETS_UI_EVENT, () => {
    pruneMissingInstances("chat");
    if (threadPickerEl && !threadPickerEl.classList.contains("hidden")) {
      renderThreadPickerList();
    }
  });
  window.addEventListener("resize", () => {
    if (!layout.expanded) return;
    layout.width = clampWidth(layout.width);
    const col = $("shell-apps");
    if (col) col.style.width = `${layout.width}px`;
  });

  document
    .getElementById("notes-mode-seg")
    ?.addEventListener("click", () => {
      requestAnimationFrame(() => {
        syncCluePlaceholder();
        syncChatPlaceholder();
      });
    });

  refreshI18n();
  if (layout.expanded) setExpanded(true);
  else setExpanded(false);
}

/** Call before notes persist flush on window close if needed */
export async function flushShellApps(): Promise<void> {
  if (isClueAppsHosted()) {
    await flushClueBoardSave().catch(() => {});
  }
  persistLayout();
}
