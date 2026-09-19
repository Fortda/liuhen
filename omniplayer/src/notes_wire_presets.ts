/**
 * 笔记绿线连线存档（preset）侧栏：命名快照列表，点击恢复 edges。
 */
import { invoke } from "@tauri-apps/api/core";
import type { NotesCardSummary } from "./notes_types";
import {
  formatArchiveListWhen,
  formatGroupMetaTime,
  hideGroupMetaPopover,
  showGroupMetaPopover,
} from "./notes_cards";
import { applyEdges, COMPOSER_ID, getCurrentEdges } from "./notes_wires";
import {
  hideFloat,
  placeFloatAtPoint,
  placeFloatInViewport,
  revealFloat,
} from "./omni_float";
import { shellT } from "./shell_i18n";
import {
  NONE_MODEL_KEY,
  pickArchiveAiModel,
} from "./notes_archive_prefs";

export type WirePreset = {
  id: string;
  name: string;
  note: string;
  edges: string[][];
  created_at: number;
  updated_at: number;
};

export type WirePresetsFile = {
  v: number;
  presets: WirePreset[];
};

export const WIRE_PRESETS_UI_EVENT = "omnitrace-wire-presets-changed";

export type WirePresetSummary = { id: string; title: string };

const HIDE_NOTES_KEY = "omnitrace.notes.preset.hideNotes";
const HOVER_SHOW_MS = 260;
const HOVER_HIDE_MS = 180;

let presetsFile: WirePresetsFile = { v: 1, presets: [] };
let selectedId: string | null = null;
let cardsRef: NotesCardSummary[] = [];
let onApplied: (() => void) | null = null;
let getModelKey: () => string = () => NONE_MODEL_KEY;

function readHideNotesPref(): boolean {
  try {
    return localStorage.getItem(HIDE_NOTES_KEY) === "1";
  } catch {
    return false;
  }
}

function applyHideNotesPref(on: boolean) {
  const sidebar = document.getElementById("notes-preset-sidebar");
  sidebar?.classList.toggle("is-hide-notes", on);
  const input = document.getElementById(
    "notes-preset-hide-notes"
  ) as HTMLInputElement | null;
  if (input) input.checked = on;
}

function writeHideNotesPref(on: boolean) {
  try {
    localStorage.setItem(HIDE_NOTES_KEY, on ? "1" : "0");
  } catch {
    /* private mode */
  }
  applyHideNotesPref(on);
}

function presetCardIds(preset: WirePreset): string[] {
  const ids = new Set<string>();
  for (const pair of preset.edges) {
    if (pair.length < 2) continue;
    if (pair[0] && pair[0] !== COMPOSER_ID) ids.add(pair[0]);
    if (pair[1] && pair[1] !== COMPOSER_ID) ids.add(pair[1]);
  }
  return [...ids];
}

function presetTurnCount(preset: WirePreset): number {
  return presetCardIds(preset).length;
}

function presetWhenMs(preset: WirePreset): number {
  const u = preset.updated_at;
  const c = preset.created_at;
  if (Number.isFinite(u) && u > 0) return u;
  if (Number.isFinite(c) && c > 0) return c;
  return 0;
}

let hoverPopEl: HTMLElement | null = null;
let hoverShowTimer = 0;
let hoverHideTimer = 0;
let hoverPresetId: string | null = null;

function clearHoverTimers() {
  if (hoverShowTimer) {
    window.clearTimeout(hoverShowTimer);
    hoverShowTimer = 0;
  }
  if (hoverHideTimer) {
    window.clearTimeout(hoverHideTimer);
    hoverHideTimer = 0;
  }
}

function hidePresetHoverPopover() {
  clearHoverTimers();
  hoverPresetId = null;
  const el = hoverPopEl;
  if (!el) return;
  hideFloat(el);
}

function hoverRow(label: string, value: string): HTMLElement {
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

function showPresetHoverPopover(anchor: HTMLElement, preset: WirePreset) {
  hideGroupMetaPopover();
  if (!hoverPopEl) {
    hoverPopEl = document.createElement("div");
    hoverPopEl.id = "notes-preset-hover-pop";
    hoverPopEl.className = "omni-float notes-wire-origin-pop notes-preset-hover-pop hidden";
    hoverPopEl.setAttribute("role", "tooltip");
    hoverPopEl.setAttribute("aria-hidden", "true");
    hoverPopEl.addEventListener("mouseenter", () => {
      if (hoverHideTimer) {
        window.clearTimeout(hoverHideTimer);
        hoverHideTimer = 0;
      }
    });
    hoverPopEl.addEventListener("mouseleave", () => {
      hoverHideTimer = window.setTimeout(() => hidePresetHoverPopover(), HOVER_HIDE_MS);
    });
    document.body.appendChild(hoverPopEl);
  }
  const el = hoverPopEl;
  hoverPresetId = preset.id;
  const name = preset.name.trim() || shellT("notes.preset.untitled");
  const note = (preset.note || "").trim() || shellT("notes.preset.noNote");
  const turns = presetTurnCount(preset);
  const created = formatGroupMetaTime(preset.created_at);
  const updated = formatGroupMetaTime(preset.updated_at);
  el.innerHTML = "";
  const head = document.createElement("div");
  head.className = "notes-wire-origin-head";
  const strong = document.createElement("strong");
  strong.textContent = name;
  head.appendChild(strong);
  const body = document.createElement("div");
  body.className = "notes-wire-origin-body";
  body.append(
    hoverRow(shellT("notes.preset.hoverNote"), note),
    hoverRow(shellT("notes.preset.hoverTurns"), String(turns)),
    hoverRow(
      shellT("notes.groupMeta.created"),
      created.rel ? `${created.abs} · ${created.rel}` : created.abs
    ),
    hoverRow(
      shellT("notes.groupMeta.modified"),
      updated.rel ? `${updated.abs} · ${updated.rel}` : updated.abs
    )
  );
  el.append(head, body);
  revealFloat(el);
  const rect = anchor.getBoundingClientRect();
  placeFloatInViewport(el, rect, "right", 280);
  requestAnimationFrame(() => placeFloatInViewport(el, rect, "right", 280));
}

function schedulePresetHover(anchor: HTMLElement, preset: WirePreset) {
  clearHoverTimers();
  if (hoverPresetId === preset.id && hoverPopEl && !hoverPopEl.classList.contains("hidden")) {
    return;
  }
  hoverShowTimer = window.setTimeout(() => {
    hoverShowTimer = 0;
    showPresetHoverPopover(anchor, preset);
  }, HOVER_SHOW_MS);
}

function scheduleHidePresetHover() {
  if (hoverShowTimer) {
    window.clearTimeout(hoverShowTimer);
    hoverShowTimer = 0;
  }
  hoverHideTimer = window.setTimeout(() => hidePresetHoverPopover(), HOVER_HIDE_MS);
}

function normalizePresetsFile(raw: WirePresetsFile | null | undefined): WirePresetsFile {
  if (!raw || !Array.isArray(raw.presets)) return { v: 1, presets: [] };
  return raw;
}

export function isAutoPresetNoteEnabled(): boolean {
  return pickArchiveAiModel(getModelKey()).ok;
}

export function setAutoPresetNoteEnabled(_on: boolean) {
  /* 开关已迁到设置首页 archive naming */
}

export async function loadWirePresets(): Promise<WirePresetsFile> {
  presetsFile = normalizePresetsFile(
    await invoke<WirePresetsFile | null>("notes_wire_presets_get")
  );
  return presetsFile;
}

async function saveWirePresets(file: WirePresetsFile): Promise<WirePresetsFile> {
  presetsFile = normalizePresetsFile(
    await invoke<WirePresetsFile>("notes_wire_presets_save", { file })
  );
  return presetsFile;
}

async function deleteWirePreset(id: string): Promise<WirePresetsFile> {
  presetsFile = normalizePresetsFile(
    await invoke<WirePresetsFile>("notes_wire_presets_delete", {
      presetId: id,
    })
  );
  if (selectedId === id) selectedId = null;
  return presetsFile;
}

function cardSnippetsForEdges(
  edgeList: string[][],
  cards: NotesCardSummary[]
): { id: string; text: string }[] {
  const ids = new Set<string>();
  for (const pair of edgeList) {
    if (pair.length < 2) continue;
    ids.add(pair[0]);
    ids.add(pair[1]);
  }
  ids.delete("composer");
  return cards
    .filter((c) => ids.has(c.id))
    .map((c) => ({ id: c.id, text: c.user_text.trim().slice(0, 200) }));
}

async function suggestPresetMeta(
  edgeList: string[][],
  cards: NotesCardSummary[],
  modelKey?: string
): Promise<{ name: string; note: string }> {
  return invoke<{ name: string; note: string }>("notes_wire_preset_suggest_note", {
    req: {
      edges: edgeList,
      cards: cardSnippetsForEdges(edgeList, cards),
      model_key: modelKey || null,
    },
  });
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  if (t.length <= n) return t;
  return `${t.slice(0, n - 1)}…`;
}

function defaultPresetName(): string {
  const base = shellT("notes.preset.untitled");
  const names = new Set((presetsFile.presets ?? []).map((p) => p.name.trim()));
  if (!names.has(base)) return base;
  let n = 2;
  while (names.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

function newPresetId(): string {
  const now = Date.now();
  return `preset_${now}_${Math.random().toString(16).slice(2, 6)}`;
}

let presetMenuEl: HTMLDivElement | null = null;

function hidePresetContextMenu() {
  hidePresetHoverPopover();
  const el = presetMenuEl;
  presetMenuEl = null;
  if (!el) return;
  hideFloat(el);
  window.setTimeout(() => el.remove(), 200);
}

function showPresetContextMenu(clientX: number, clientY: number, preset: WirePreset) {
  hidePresetContextMenu();
  hideGroupMetaPopover();
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
    hidePresetContextMenu();
    showGroupMetaPopover({
      clientX,
      clientY,
      title: preset.name.trim() || shellT("notes.clue.boards.untitled"),
      createdAt: preset.created_at,
      updatedAt: preset.updated_at,
    });
  });
  menu.appendChild(detailsBtn);

  const delBtn = document.createElement("button");
  delBtn.type = "button";
  delBtn.className = "notes-preset-ctx-item is-danger";
  delBtn.setAttribute("role", "menuitem");
  delBtn.textContent = shellT("notes.groupMeta.delete");
  delBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    hidePresetContextMenu();
    if (!confirm(shellT("notes.preset.deleteConfirm", { name: preset.name }))) return;
    void (async () => {
      try {
        await deleteWirePreset(preset.id);
        renderPresetList();
      } catch (err) {
        console.error(err);
      }
    })();
  });
  menu.appendChild(delBtn);
  document.body.appendChild(menu);
  revealFloat(menu);
  placeFloatAtPoint(menu, clientX, clientY);
  requestAnimationFrame(() => placeFloatAtPoint(menu, clientX, clientY));
  presetMenuEl = menu;
  const onDoc = (ev: MouseEvent) => {
    if (ev.target instanceof Node && menu.contains(ev.target)) return;
    hidePresetContextMenu();
    document.removeEventListener("mousedown", onDoc, true);
  };
  document.addEventListener("mousedown", onDoc, true);
}

function renderPresetList() {
  const list = document.getElementById("notes-preset-list");
  if (!list) return;
  hidePresetContextMenu();
  hidePresetHoverPopover();
  list.innerHTML = "";
  const presets = presetsFile?.presets;
  if (!presets?.length) {
    const empty = document.createElement("p");
    empty.className = "notes-preset-empty";
    empty.textContent = shellT("notes.preset.empty");
    list.appendChild(empty);
    window.dispatchEvent(new CustomEvent(WIRE_PRESETS_UI_EVENT));
    return;
  }
  for (const p of presets) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "notes-preset-item";
    if (p.id === selectedId) btn.classList.add("is-selected");
    btn.dataset.presetId = p.id;
    btn.setAttribute("aria-label", shellT("notes.preset.itemHint"));
    const name = document.createElement("span");
    name.className = "notes-preset-item-name";
    name.textContent = p.name;
    const note = document.createElement("span");
    note.className = "notes-preset-item-note";
    note.textContent = truncate(p.note || shellT("notes.preset.noNote"), 56);
    const meta = document.createElement("span");
    meta.className = "notes-preset-item-meta";
    const turns = document.createElement("span");
    turns.textContent = shellT("notes.preset.turnCount", {
      n: String(presetTurnCount(p)),
    });
    const when = document.createElement("span");
    when.className = "notes-preset-item-when";
    when.textContent = formatArchiveListWhen(presetWhenMs(p));
    meta.append(turns, when);
    btn.append(name, note, meta);
    btn.addEventListener("click", () => {
      hidePresetHoverPopover();
      void applyPreset(p.id);
    });
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      hidePresetHoverPopover();
      showPresetContextMenu(e.clientX, e.clientY, p);
    });
    btn.addEventListener("mouseenter", () => schedulePresetHover(btn, p));
    btn.addEventListener("mouseleave", () => scheduleHidePresetHover());
    list.appendChild(btn);
  }
  window.dispatchEvent(new CustomEvent(WIRE_PRESETS_UI_EVENT));
}

async function applyPreset(id: string) {
  const hit = presetsFile.presets.find((p) => p.id === id);
  if (!hit) return;
  selectedId = id;
  applyEdges(hit.edges);
  onApplied?.();
  renderPresetList();
}

export function listWirePresetSummaries(): WirePresetSummary[] {
  return (presetsFile.presets ?? []).map((p) => ({
    id: p.id,
    title: p.name.trim() || "未命名",
  }));
}

export async function applyWirePreset(id: string): Promise<void> {
  await applyPreset(id);
}

async function upsertPresetRecord(preset: WirePreset): Promise<void> {
  const rest = presetsFile.presets.filter((p) => p.id !== preset.id);
  await saveWirePresets({
    v: 1,
    presets: [preset, ...rest],
  });
  selectedId = preset.id;
}

/** Create an empty archive, select it, and clear canvas wires. */
export async function createWirePreset(): Promise<string> {
  hideSaveForm();
  const now = Date.now();
  const preset: WirePreset = {
    id: newPresetId(),
    name: defaultPresetName(),
    note: "",
    edges: [],
    created_at: now,
    updated_at: now,
  };
  await upsertPresetRecord(preset);
  applyEdges([]);
  onApplied?.();
  renderPresetList();
  return preset.id;
}

export async function saveCurrentWirePreset(name: string, note = ""): Promise<boolean> {
  const trimmed = name.trim();
  if (!trimmed) return false;
  const edgeList = getCurrentEdges();
  if (!edgeList.length) {
    alert(shellT("notes.preset.noEdges"));
    return false;
  }
  const now = Date.now();
  const preset: WirePreset = {
    id: newPresetId(),
    name: trimmed,
    note,
    edges: edgeList,
    created_at: now,
    updated_at: now,
  };
  await upsertPresetRecord(preset);
  renderPresetList();
  return true;
}

function showPresetToast(msg: string, isError = false) {
  const el = document.getElementById("notes-preset-toast");
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle("hidden", !msg);
  el.classList.toggle("is-error", isError);
  if (msg) {
    window.setTimeout(() => {
      if (el.textContent === msg) {
        el.textContent = "";
        el.classList.add("hidden");
      }
    }, 4200);
  }
}

async function maybeAiMeta(
  edgeList: string[][],
  wantAi: boolean,
  existingName: string,
  existingNote: string
): Promise<{ name: string; note: string; skipped?: boolean }> {
  if (!wantAi) {
    return { name: existingName, note: existingNote };
  }
  const pick = pickArchiveAiModel(getModelKey());
  if (!pick.ok) {
    showPresetToast(shellT("notes.preset.aiSkip"), true);
    return { name: existingName, note: existingNote, skipped: true };
  }
  try {
    const meta = await suggestPresetMeta(edgeList, cardsRef, pick.modelKey);
    return {
      name: existingName.trim() || meta.name.trim() || existingName,
      note: existingNote.trim() || meta.note.trim() || existingNote,
    };
  } catch (e) {
    console.warn("AI archive naming failed", e);
    showPresetToast(String(e), true);
    return { name: existingName, note: existingNote, skipped: true };
  }
}

async function saveCurrentToSelectedPreset(): Promise<void> {
  hideSaveForm();
  const edgeList = getCurrentEdges();
  if (!edgeList.length) {
    alert(shellT("notes.preset.noEdges"));
    return;
  }
  const hit = getSelectedWirePreset();
  if (!hit) {
    showSaveForm();
    return;
  }
  const saveBtn = document.getElementById(
    "notes-preset-save-open"
  ) as HTMLButtonElement | null;
  if (saveBtn) saveBtn.disabled = true;
  try {
    const ai = await maybeAiMeta(edgeList, true, hit.name, hit.note);
    const now = Date.now();
    await upsertPresetRecord({
      ...hit,
      name: ai.name.trim() || hit.name,
      edges: edgeList,
      note: ai.note,
      updated_at: now,
    });
    renderPresetList();
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

function hideSaveForm() {
  const overlay = document.getElementById("dlg-archive-save-overlay");
  overlay?.classList.add("hidden");
  overlay?.setAttribute("aria-hidden", "true");
}

function showSaveForm() {
  const overlay = document.getElementById("dlg-archive-save-overlay");
  if (!overlay) return;
  overlay.classList.remove("hidden");
  overlay.setAttribute("aria-hidden", "false");
  const nameInput = document.getElementById(
    "notes-preset-save-name"
  ) as HTMLInputElement | null;
  const noteInput = document.getElementById(
    "notes-preset-save-note"
  ) as HTMLTextAreaElement | null;
  const aiInput = document.getElementById(
    "notes-preset-save-ai"
  ) as HTMLInputElement | null;
  if (nameInput) {
    nameInput.value = "";
    nameInput.focus();
  }
  if (noteInput) noteInput.value = "";
  if (aiInput) aiInput.checked = pickArchiveAiModel(getModelKey()).ok;
}

async function commitSavePreset() {
  const nameInput = document.getElementById(
    "notes-preset-save-name"
  ) as HTMLInputElement | null;
  const noteInput = document.getElementById(
    "notes-preset-save-note"
  ) as HTMLTextAreaElement | null;
  const aiInput = document.getElementById(
    "notes-preset-save-ai"
  ) as HTMLInputElement | null;
  const saveBtn = document.getElementById(
    "notes-preset-save-commit"
  ) as HTMLButtonElement | null;
  const edgeList = getCurrentEdges();
  if (!edgeList.length) {
    alert(shellT("notes.preset.noEdges"));
    return;
  }
  let name = nameInput?.value.trim() || "";
  let note = noteInput?.value.trim() || "";
  const wantAi = aiInput?.checked !== false;
  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = wantAi
      ? shellT("notes.preset.generatingNote")
      : shellT("notes.preset.saveCommit");
  }
  try {
    const ai = await maybeAiMeta(edgeList, wantAi, name, note);
    name = ai.name.trim() || shellT("notes.preset.untitled");
    note = ai.note;
    const now = Date.now();
    const preset: WirePreset = {
      id: newPresetId(),
      name,
      note,
      edges: edgeList,
      created_at: now,
      updated_at: now,
    };
    await upsertPresetRecord(preset);
    hideSaveForm();
    renderPresetList();
  } catch (e) {
    console.error(e);
    alert(String(e));
  } finally {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.textContent = shellT("notes.preset.saveCommit");
    }
  }
}

export function setWirePresetCards(cards: NotesCardSummary[]) {
  cardsRef = cards;
}

export function getSelectedWirePreset(): WirePreset | null {
  if (!selectedId) return null;
  return presetsFile.presets.find((p) => p.id === selectedId) ?? null;
}

export function getSelectedWirePresetId(): string | null {
  return selectedId;
}

export function initWirePresetSidebar(opts: {
  onApplied?: () => void;
  getModelKey?: () => string;
}) {
  onApplied = opts.onApplied || null;
  getModelKey = opts.getModelKey || (() => NONE_MODEL_KEY);
  document
    .getElementById("notes-preset-save-open")
    ?.addEventListener("click", () => void saveCurrentToSelectedPreset());
  document
    .getElementById("notes-preset-new")
    ?.addEventListener("click", () => void createWirePreset());
  document
    .getElementById("notes-preset-save-cancel")
    ?.addEventListener("click", () => hideSaveForm());
  document
    .getElementById("notes-preset-save-cancel-btn")
    ?.addEventListener("click", () => hideSaveForm());
  document
    .getElementById("notes-preset-save-commit")
    ?.addEventListener("click", () => void commitSavePreset());
  document
    .getElementById("dlg-archive-save-overlay")
    ?.addEventListener("click", (e) => {
      if (e.target === e.currentTarget) hideSaveForm();
    });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const overlay = document.getElementById("dlg-archive-save-overlay");
    if (!overlay || overlay.classList.contains("hidden")) return;
    hideSaveForm();
  });
  window.addEventListener("omnitrace-lang", () => renderPresetList());
  applyHideNotesPref(readHideNotesPref());
  document
    .getElementById("notes-preset-hide-notes")
    ?.addEventListener("change", (e) => {
      writeHideNotesPref((e.target as HTMLInputElement).checked);
    });
  document
    .getElementById("notes-preset-list")
    ?.addEventListener("scroll", () => hidePresetHoverPopover(), { passive: true });
  void loadWirePresets()
    .then(() => renderPresetList())
    .catch((e) => console.error(e));
}

export function refreshWirePresetList() {
  void loadWirePresets()
    .then(() => renderPresetList())
    .catch((e) => console.error(e));
}

export function buildAutoPresetNoteToggle(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "hidden";
  return wrap;
}
