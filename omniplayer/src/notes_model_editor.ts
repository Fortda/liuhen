/**
 * Composer 模型菜单的 Hermes 式「编辑模型」浮层。
 * 开关写入 providers.json 的 disabled_model_keys（与设置页共用）。
 */
import {
  hideFloat,
  placeFloatInViewport,
  revealFloat,
} from "./omni_float";
import { setDisabledModelKeys } from "./notes_llm";
import {
  applyModelEnable,
  applyProviderEnable,
  isModelEnabled,
  notifyProvidersChanged,
  providerEnableState,
} from "./notes_model_visibility";
import { modelKey, providerVendor, type NotesProvider, type ProvidersFile } from "./notes_types";
import { vendorLogoHtml } from "./notes_vendor_icons";
import { shellT } from "./shell_i18n";

const EDITOR_WIDTH = 360;

let editorOpen = false;
let editorQuery = "";
let editorPf: ProvidersFile | null = null;
let persistTimer: number | null = null;

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function isModelEditorOpen(): boolean {
  return editorOpen;
}

export function closeModelEditor() {
  if (!editorOpen) return;
  editorOpen = false;
  editorQuery = "";
  const search = $("notes-model-editor-search") as HTMLInputElement | null;
  if (search) search.value = "";
  hideFloat($("notes-model-editor"));
  $("notes-edit-models")?.setAttribute("aria-expanded", "false");
}

function schedulePersist(keys: string[]) {
  if (persistTimer != null) window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = null;
    void setDisabledModelKeys(keys)
      .then((next) => {
        editorPf = next;
        notifyProvidersChanged(next);
      })
      .catch((e) => console.error(e));
  }, 80);
}

function applyKeys(keys: string[]) {
  if (!editorPf) return;
  editorPf = { ...editorPf, disabled_model_keys: keys };
  paintEditorList();
  schedulePersist(keys);
}

function paintEditorList() {
  const host = $("notes-model-editor-list");
  const pf = editorPf;
  if (!host || !pf) return;
  host.innerHTML = "";
  const q = editorQuery.trim().toLowerCase();

  let any = false;
  for (const p of pf.providers) {
    const models = q
      ? p.models.filter(
          (m) =>
            m.id.toLowerCase().includes(q) ||
            m.label.toLowerCase().includes(q) ||
            p.label.toLowerCase().includes(q)
        )
      : p.models;
    if (!models.length && (q || !p.models.length)) continue;
    any = true;
    host.appendChild(buildProviderBlock(p, models, pf));
  }
  if (!any) {
    const empty = document.createElement("p");
    empty.className = "notes-sheet-empty";
    empty.textContent = q
      ? `没有匹配「${editorQuery}」的模型`
      : "尚未发现模型。先刷新或到设置里填写密钥。";
    host.appendChild(empty);
  }
}

function buildProviderBlock(
  p: NotesProvider,
  models: NotesProvider["models"],
  pf: ProvidersFile
): HTMLElement {
  const wrap = document.createElement("section");
  wrap.className = "notes-model-editor-group";
  const state = providerEnableState(p, pf);
  const vendor = providerVendor(p);

  const head = document.createElement("button");
  head.type = "button";
  head.className = "notes-model-editor-prov";
  head.innerHTML = `
    <span class="notes-tri-check${
      state === "all" ? " is-on" : state === "mixed" ? " is-mixed" : ""
    }" aria-hidden="true"></span>
    <span class="notes-provider-logo">${vendorLogoHtml(vendor, 16)}</span>
    <span class="notes-model-editor-prov-name">${escapeHtml(p.label || p.id)}</span>
  `;
  head.addEventListener("click", () => {
    const nextEnable = state !== "all";
    applyKeys(applyProviderEnable(pf, p.id, nextEnable));
  });
  wrap.appendChild(head);

  for (const m of models) {
    const key = modelKey(p.id, m.id);
    const on = isModelEnabled(pf, key);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "notes-model-editor-row";
    row.setAttribute("role", "switch");
    row.setAttribute("aria-checked", on ? "true" : "false");
    row.innerHTML = `
      <span class="notes-model-editor-row-name">${escapeHtml(m.id)}</span>
      <span class="notes-fwd-switch${on ? " is-on" : ""}" aria-hidden="true"></span>
    `;
    row.addEventListener("click", () => {
      applyKeys(applyModelEnable(pf, key, !on));
    });
    wrap.appendChild(row);
  }
  return wrap;
}

function positionEditor() {
  const el = $("notes-model-editor");
  const btn = $("notes-model-btn");
  if (!el || !btn) return;
  if (el.parentElement !== document.body) document.body.appendChild(el);
  placeFloatInViewport(el, btn.getBoundingClientRect(), "above", EDITOR_WIDTH);
}

export function syncModelEditor(pf: ProvidersFile) {
  editorPf = pf;
  if (editorOpen) paintEditorList();
}

export function openModelEditor(pf: ProvidersFile) {
  const el = $("notes-model-editor");
  if (!el) return;
  editorPf = pf;
  editorOpen = true;
  $("notes-edit-models")?.setAttribute("aria-expanded", "true");
  const title = $("notes-model-editor-title");
  if (title) title.textContent = shellT("notes.model.editorTitle");
  const search = $("notes-model-editor-search") as HTMLInputElement | null;
  if (search) {
    search.placeholder = shellT("notes.model.editorSearch");
    search.value = editorQuery;
  }
  const add = $("notes-model-editor-add");
  if (add) add.textContent = shellT("notes.model.addProvider");
  paintEditorList();
  const wasHidden = el.classList.contains("hidden");
  el.classList.remove("hidden");
  positionEditor();
  if (wasHidden) revealFloat(el);
  else el.classList.add("is-open");
  requestAnimationFrame(() => {
    positionEditor();
    search?.focus();
  });
}

export function initModelEditor(opts: { onAddProvider: () => void }) {
  $("notes-model-editor-close")?.addEventListener("click", () => closeModelEditor());
  $("notes-model-editor-search")?.addEventListener("input", (e) => {
    editorQuery = (e.target as HTMLInputElement).value;
    paintEditorList();
  });
  $("notes-model-editor-search")?.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") e.preventDefault();
  });
  $("notes-model-editor-add")?.addEventListener("click", () => {
    closeModelEditor();
    opts.onAddProvider();
  });
  window.addEventListener("resize", () => {
    if (editorOpen) positionEditor();
  });
}
