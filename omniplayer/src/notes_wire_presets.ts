/**
 * 笔记绿线连线存档（preset）侧栏：命名快照列表，点击恢复 edges。
 */
import { invoke } from "@tauri-apps/api/core";
import type { NotesCardSummary } from "./notes_types";
import { hideGroupMetaPopover, showGroupMetaPopover } from "./notes_cards";
import { applyEdges, getCurrentEdges } from "./notes_wires";
import {
  hideFloat,
  placeFloatAtPoint,
  revealFloat,
} from "./omni_float";
import { shellT } from "./shell_i18n";

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

const AUTO_NOTE_KEY = "omnitrace.notes.autoPresetNote";

/** Fired after the 连线存档 list would refresh. */
export const WIRE_PRESETS_UI_EVENT = "omnitrace-wire-presets-changed";

export type WirePresetSummary = { id: string; title: string };

let presetsFile: WirePresetsFile = { v: 1, presets: [] };
let selectedId: string | null = null;
let cardsRef: NotesCardSummary[] = [];
let onApplied: (() => void) | null = null;

function normalizePresetsFile(raw: WirePresetsFile | null | undefined): WirePresetsFile {
  if (!raw || !Array.isArray(raw.presets)) return { v: 1, presets: [] };
  return raw;
}

export function isAutoPresetNoteEnabled(): boolean {
  try {
    const v = localStorage.getItem(AUTO_NOTE_KEY);
    if (v === null) return true;
    return v !== "0" && v !== "false";
  } catch {
    return true;
  }
}

export function setAutoPresetNoteEnabled(on: boolean) {
  try {
    localStorage.setItem(AUTO_NOTE_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
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

async function suggestPresetNote(
  edgeList: string[][],
  cards: NotesCardSummary[],
  modelKey?: string
): Promise<string> {
  return invoke<string>("notes_wire_preset_suggest_note", {
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
    btn.title = shellT("notes.preset.itemHint");
    btn.innerHTML = `
      <span class="notes-preset-item-name">${escapeHtml(p.name)}</span>
      <span class="notes-preset-item-note">${escapeHtml(truncate(p.note || shellT("notes.preset.noNote"), 56))}</span>
      <span class="notes-preset-item-meta">${shellT("notes.preset.edgeCount", { n: String(p.edges.length) })}</span>
    `;
    btn.addEventListener("click", () => {
      void applyPreset(p.id);
    });
    btn.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      showPresetContextMenu(e.clientX, e.clientY, p);
    });
    list.appendChild(btn);
  }
  window.dispatchEvent(new CustomEvent(WIRE_PRESETS_UI_EVENT));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
  let note = hit.note;
  const saveBtn = document.getElementById(
    "notes-preset-save-open"
  ) as HTMLButtonElement | null;
  const autoNote = isAutoPresetNoteEnabled();
  if (autoNote && !note.trim()) {
    if (saveBtn) {
      saveBtn.disabled = true;
    }
    try {
      note = await suggestPresetNote(edgeList, cardsRef);
    } catch (e) {
      console.warn("AI note failed, keeping existing note", e);
    } finally {
      if (saveBtn) saveBtn.disabled = false;
    }
  }
  const now = Date.now();
  await upsertPresetRecord({
    ...hit,
    edges: edgeList,
    note,
    updated_at: now,
  });
  renderPresetList();
}

function hideSaveForm() {
  document.getElementById("notes-preset-save-form")?.classList.add("hidden");
}

function showSaveForm() {
  const form = document.getElementById("notes-preset-save-form");
  if (!form) return;
  form.classList.remove("hidden");
  const nameInput = document.getElementById(
    "notes-preset-save-name"
  ) as HTMLInputElement | null;
  const noteInput = document.getElementById(
    "notes-preset-save-note"
  ) as HTMLTextAreaElement | null;
  if (nameInput) {
    nameInput.value = "";
    nameInput.focus();
  }
  if (noteInput) noteInput.value = "";
}

async function commitSavePreset() {
  const nameInput = document.getElementById(
    "notes-preset-save-name"
  ) as HTMLInputElement | null;
  const noteInput = document.getElementById(
    "notes-preset-save-note"
  ) as HTMLTextAreaElement | null;
  const saveBtn = document.getElementById(
    "notes-preset-save-commit"
  ) as HTMLButtonElement | null;
  const name = nameInput?.value.trim() || "";
  if (!name) {
    nameInput?.focus();
    return;
  }
  const edgeList = getCurrentEdges();
  if (!edgeList.length) {
    alert(shellT("notes.preset.noEdges"));
    return;
  }
  let note = noteInput?.value.trim() || "";
  const autoNote = isAutoPresetNoteEnabled();
  if (autoNote && !note) {
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = shellT("notes.preset.generatingNote");
    }
    try {
      note = await suggestPresetNote(edgeList, cardsRef);
      if (noteInput) noteInput.value = note;
    } catch (e) {
      console.warn("AI note failed, leaving blank", e);
    } finally {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = shellT("notes.preset.saveCommit");
      }
    }
  }
  const now = Date.now();
  const preset: WirePreset = {
    id: newPresetId(),
    name,
    note,
    edges: edgeList,
    created_at: now,
    updated_at: now,
  };
  try {
    await upsertPresetRecord(preset);
    hideSaveForm();
    renderPresetList();
  } catch (e) {
    console.error(e);
    alert(String(e));
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

export function initWirePresetSidebar(opts: { onApplied?: () => void }) {
  onApplied = opts.onApplied || null;
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
    .getElementById("notes-preset-save-commit")
    ?.addEventListener("click", () => void commitSavePreset());
  window.addEventListener("omnitrace-lang", () => renderPresetList());
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
  wrap.className = "notes-general-settings";
  const on = isAutoPresetNoteEnabled();
  wrap.innerHTML = `
    <h3>通用</h3>
    <label class="notes-toggle-row">
      <span>保存连线存档时用 AI 自动写备注</span>
      <input type="checkbox" id="notes-auto-preset-note" ${on ? "checked" : ""} />
    </label>
    <p class="notes-settings-hint">关闭后保存存档只使用你手写的备注（可留空）。需已配置模型且 sidecar 可用时 AI 备注才会生效。</p>
  `;
  wrap
    .querySelector("#notes-auto-preset-note")
    ?.addEventListener("change", (e) => {
      const el = e.target as HTMLInputElement;
      setAutoPresetNoteEnabled(el.checked);
    });
  return wrap;
}
