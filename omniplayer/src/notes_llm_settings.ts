/**
 * 设置 → 语言模型：Lobe 式左列表右详情。
 * 模型开关与 Composer「编辑模型」共用 disabled_model_keys。
 */
import {
  saveProviders,
  setDisabledModelKeys,
  testConnection,
} from "./notes_llm";
import {
  applyModelEnable,
  applyProviderEnable,
  isModelEnabled,
  notifyProvidersChanged,
  providerEnableState,
  providerIsConfigured,
  realModelSyncFails,
} from "./notes_model_visibility";
import {
  modelKey,
  presetForVendor,
  providerUsesHttpProxy,
  providerVendor,
  VENDOR_PRESETS,
  type NotesProvider,
  type ProvidersFile,
  type VendorId,
} from "./notes_types";
import {
  buildSearchSettingsSection,
  getSearchConfig,
  type SearchConfig,
} from "./notes_mcp_prefs";
import {
  mountApiProxySettingsCard,
  mountLitellmSettingsCard,
} from "./notes_forwarder_prefs";
import { buildAutoPresetNoteToggle } from "./notes_wire_presets";
import { vendorLogoHtml } from "./notes_vendor_icons";
import { shellT } from "./shell_i18n";

const SEL_LS = "omnitrace.notes.llmSettings.sel";

type NavFilter = "all" | "on" | "off";

export type LlmSettingsHost = {
  isBusy: () => boolean;
  setBusy: (v: boolean) => void;
  showTask: (
    label: string,
    progress?: number,
    mode?: "busy" | "ok" | "error"
  ) => void;
  hideTask: (delayMs?: number) => void;
  onProvidersSaved: (pf: ProvidersFile) => void;
};

let host: LlmSettingsHost | null = null;
let draft: ProvidersFile = { v: 2, providers: [] };
let selectedId: string | null = null;
let navFilter: NavFilter = "all";
let navQuery = "";
let modelQuery = "";
let lastSearchCfg: SearchConfig | undefined;

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

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

export function initLlmSettingsHost(h: LlmSettingsHost) {
  host = h;
}

function readSel(): string | null {
  try {
    return localStorage.getItem(SEL_LS);
  } catch {
    return null;
  }
}

function writeSel(id: string | null) {
  selectedId = id;
  try {
    if (id) localStorage.setItem(SEL_LS, id);
    else localStorage.removeItem(SEL_LS);
  } catch {
    /* ignore */
  }
}

function showAlert(text: string, kind: "error" | "ok" = "error") {
  const el = $("notes-settings-alert");
  if (!el) return;
  const msg = text.trim();
  if (!msg) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.classList.remove("hidden");
  el.classList.toggle("is-ok", kind === "ok");
  el.textContent = msg;
}

function hideAlert() {
  showAlert("");
}

function modelSyncHint(prov: NotesProvider): string {
  if (prov.models_sync_error) return prov.models_sync_error;
  if (prov.models.length) return `已发现 ${prov.models.length} 个模型`;
  if (!prov.api_key.trim()) return "请填写 API Key 后保存";
  return "尚未获取模型列表";
}

function vendorLabelOf(vendor: string): string {
  return presetForVendor(vendor)?.label || vendor;
}

function beginBusy(task?: string): boolean {
  if (!host) return false;
  if (host.isBusy()) {
    host.showTask("请等待当前请求结束…");
    return false;
  }
  host.setBusy(true);
  if (task) host.showTask(task);
  return true;
}

function endBusy() {
  host?.setBusy(false);
}

function selectedProvider(): { prov: NotesProvider; idx: number } | null {
  const idx = draft.providers.findIndex((p) => p.id === selectedId);
  if (idx < 0) return null;
  return { prov: draft.providers[idx], idx };
}

function ensureSelection() {
  if (selectedId && draft.providers.some((p) => p.id === selectedId)) return;
  const remembered = readSel();
  if (remembered && draft.providers.some((p) => p.id === remembered)) {
    selectedId = remembered;
    return;
  }
  writeSel(draft.providers[0]?.id ?? null);
}

function filteredNav(): NotesProvider[] {
  const q = navQuery.trim().toLowerCase();
  return draft.providers.filter((p) => {
    const on = providerIsConfigured(p);
    if (navFilter === "on" && !on) return false;
    if (navFilter === "off" && on) return false;
    if (!q) return true;
    return (
      p.label.toLowerCase().includes(q) ||
      p.id.toLowerCase().includes(q) ||
      providerVendor(p).toLowerCase().includes(q)
    );
  });
}

function flushDetailToDraft() {
  const hit = selectedProvider();
  const pane = $("llm-lobe-detail");
  if (!hit || !pane) return;
  const g = (f: string) =>
    (pane.querySelector(`[data-f="${f}"]`) as HTMLInputElement | null)
      ?.value?.trim() || "";
  const vendor = g("vendor") || providerVendor(hit.prov);
  const preset = presetForVendor(vendor);
  draft.providers[hit.idx] = {
    ...hit.prov,
    label: g("label") || preset?.label || hit.prov.label,
    vendor,
    api_base: g("api_base") || preset?.api_base || hit.prov.api_base,
    api_key: g("api_key"),
    use_local_http_proxy:
      pane.querySelector('[data-f="use_proxy"]')?.getAttribute("aria-checked") ===
      "true",
  };
}

export async function paintLlmSettings(pf: ProvidersFile) {
  draft = {
    ...pf,
    providers: pf.providers.map((p) => ({ ...p, models: [...p.models] })),
    disabled_model_keys: [...(pf.disabled_model_keys || [])],
    pinned_model_keys: [...(pf.pinned_model_keys || [])],
  };
  ensureSelection();
  const cfg = await getSearchConfig();
  lastSearchCfg = cfg;
  const proxySlot = $("notes-proxy-settings-slot");
  if (proxySlot) await mountApiProxySettingsCard(proxySlot);
  const litellmSlot = $("notes-litellm-settings-slot");
  if (litellmSlot) await mountLitellmSettingsCard(litellmSlot);
  renderLobe(lastSearchCfg);
  const fails = realModelSyncFails(draft);
  if (fails.length) {
    showAlert(
      fails.map((p) => `${p.label}：${p.models_sync_error}`).join("\n"),
      "error"
    );
  } else {
    hideAlert();
  }
}

function renderLobe(searchCfg: SearchConfig | undefined = lastSearchCfg) {
  const hostEl = $("notes-settings-form");
  if (!hostEl) return;
  hostEl.innerHTML = "";
  hostEl.appendChild(buildAutoPresetNoteToggle());

  const split = document.createElement("div");
  split.className = "llm-lobe";

  split.appendChild(buildNav());
  split.appendChild(buildDetail());
  hostEl.appendChild(split);

  if (searchCfg) {
    hostEl.appendChild(
      buildSearchSettingsSection(searchCfg, () => {
        host?.showTask("搜索设置已保存", 100, "ok");
        host?.hideTask(900);
        void paintLlmSettings(draft);
      })
    );
  }
}

function buildNav(): HTMLElement {
  const nav = document.createElement("aside");
  nav.className = "llm-lobe-nav";

  const filters = document.createElement("div");
  filters.className = "llm-lobe-filters";
  for (const [id, label] of [
    ["all", shellT("settings.llm.nav.all")],
    ["on", shellT("settings.llm.nav.enabled")],
    ["off", shellT("settings.llm.nav.disabled")],
  ] as const) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `llm-lobe-filter${navFilter === id ? " is-on" : ""}`;
    btn.textContent = label;
    btn.addEventListener("click", () => {
      flushDetailToDraft();
      navFilter = id;
      renderLobe();
    });
    filters.appendChild(btn);
  }
  nav.appendChild(filters);

  const search = document.createElement("input");
  search.type = "search";
  search.className = "llm-lobe-nav-search";
  search.placeholder = shellT("settings.llm.nav.search");
  search.value = navQuery;
  search.addEventListener("input", () => {
    navQuery = search.value;
    const list = nav.querySelector(".llm-lobe-list");
    if (list) {
      list.replaceWith(buildNavList());
    }
  });
  nav.appendChild(search);
  nav.appendChild(buildNavList());

  const add = document.createElement("button");
  add.type = "button";
  add.className = "llm-lobe-add";
  add.textContent = shellT("settings.llm.add");
  add.addEventListener("click", () => {
    flushDetailToDraft();
    const preset = VENDOR_PRESETS[0];
    const id = `prov_${preset.id}_${Date.now()}`;
    draft.providers.push({
      id,
      label: preset.label,
      vendor: preset.id,
      api_base: preset.api_base,
      api_key: "",
      models: [],
      use_local_http_proxy: preset.id === "google",
    });
    writeSel(id);
    renderLobe();
  });
  nav.appendChild(add);
  return nav;
}

function buildNavList(): HTMLElement {
  const list = document.createElement("div");
  list.className = "llm-lobe-list";
  const rows = filteredNav();
  if (!rows.length) {
    const empty = document.createElement("p");
    empty.className = "notes-settings-hint";
    empty.textContent = "没有匹配的服务商";
    list.appendChild(empty);
    return list;
  }
  for (const p of rows) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `llm-lobe-item${p.id === selectedId ? " is-sel" : ""}`;
    const on = providerIsConfigured(p);
    const vLabel = vendorLabelOf(providerVendor(p));
    btn.innerHTML = `
      <span class="notes-provider-logo">${vendorLogoHtml(providerVendor(p), 18)}</span>
      <span class="llm-lobe-item-copy">
        <span class="llm-lobe-item-name">${escapeHtml(p.label || p.id)}</span>
        <span class="llm-lobe-item-sub">${escapeHtml(vLabel)} · ${
      on ? `${p.models.length} 模型` : "未启用"
    }</span>
      </span>
      <span class="llm-lobe-dot${on ? " is-on" : ""}" aria-hidden="true"></span>
    `;
    btn.addEventListener("click", () => {
      if (p.id === selectedId) return;
      flushDetailToDraft();
      writeSel(p.id);
      renderLobe();
    });
    list.appendChild(btn);
  }
  return list;
}

function vendorOptions(selected: string): string {
  const norm = selected === "gemini" ? "google" : selected;
  return VENDOR_PRESETS.map((p) => {
    const sel = norm === p.id ? "selected" : "";
    return `<option value="${p.id}" ${sel}>${p.label}</option>`;
  }).join("");
}

function buildDetail(): HTMLElement {
  const pane = document.createElement("div");
  pane.id = "llm-lobe-detail";
  pane.className = "llm-lobe-detail";
  const hit = selectedProvider();
  if (!hit) {
    pane.innerHTML = `<p class="notes-settings-hint">左侧添加服务商，或点一项编辑。</p>`;
    return pane;
  }
  const { prov, idx } = hit;
  const vendor = providerVendor(prov);
  const proxyOn = providerUsesHttpProxy(prov);
  const enableState = providerEnableState(prov, draft);

  const head = document.createElement("div");
  head.className = "llm-lobe-detail-head";
  head.innerHTML = `
    <div class="llm-lobe-detail-title">
      <span class="notes-provider-logo">${vendorLogoHtml(vendor, 22)}</span>
      <strong>${escapeHtml(prov.label || prov.id)}</strong>
      <span class="llm-lobe-item-sub">${escapeHtml(vendorLabelOf(vendor))}</span>
    </div>
  `;
  const master = document.createElement("button");
  master.type = "button";
  master.className = "llm-lobe-master";
  master.setAttribute("role", "switch");
  master.setAttribute(
    "aria-checked",
    enableState === "none" ? "false" : "true"
  );
  master.title = "启用该服务商下的模型（出现在 Composer 列表）";
  master.innerHTML = `<span class="notes-fwd-switch${
    enableState === "all" ? " is-on" : enableState === "mixed" ? " is-mixed" : ""
  }" aria-hidden="true"></span>`;
  master.addEventListener("click", () => {
    void persistDisabled(applyProviderEnable(draft, prov.id, enableState !== "all"));
  });
  head.appendChild(master);
  pane.appendChild(head);

  const form = document.createElement("div");
  form.className = "llm-lobe-form";
  form.innerHTML = `
    <label>服务商
      <select data-f="vendor">${vendorOptions(vendor)}</select>
    </label>
    <label>显示名称 <input type="text" data-f="label" value="${escapeAttr(prov.label)}" /></label>
    <label>API Key <input type="password" data-f="api_key" value="${escapeAttr(
      prov.api_key.length > 200 ? "" : prov.api_key
    )}" placeholder="只粘贴密钥，不要粘终端日志" autocomplete="off" /></label>
    <label>API 代理地址 <input type="text" data-f="api_base" value="${escapeAttr(
      prov.api_base
    )}" placeholder="${vendor === "relay" ? "https://你的中转/v1" : ""}" /></label>
    <p class="notes-provider-sync${
      prov.models_sync_error ? " is-error" : ""
    }">${escapeHtml(modelSyncHint(prov))}</p>
  `;
  const vendorSel = form.querySelector('[data-f="vendor"]') as HTMLSelectElement;
  const labelInput = form.querySelector('[data-f="label"]') as HTMLInputElement;
  labelInput?.addEventListener("input", () => {
    const next =
      labelInput.value.trim() ||
      presetForVendor(vendor)?.label ||
      hit.prov.label;
    draft.providers[idx].label = next;
    const nameEl = document.querySelector(
      ".llm-lobe-item.is-sel .llm-lobe-item-name"
    );
    if (nameEl) nameEl.textContent = next;
    const titleEl = pane.querySelector(".llm-lobe-detail-title strong");
    if (titleEl) titleEl.textContent = next;
  });
  vendorSel?.addEventListener("change", () => {
    const v = vendorSel.value as VendorId;
    const preset = presetForVendor(v);
    if (!preset) return;
    const baseInput = form.querySelector('[data-f="api_base"]') as HTMLInputElement;
    if (
      labelInput &&
      (!labelInput.value || VENDOR_PRESETS.some((p) => p.label === labelInput.value))
    ) {
      labelInput.value = preset.label;
      draft.providers[idx].label = preset.label;
      const nameEl = document.querySelector(
        ".llm-lobe-item.is-sel .llm-lobe-item-name"
      );
      if (nameEl) nameEl.textContent = preset.label;
      const titleEl = pane.querySelector(".llm-lobe-detail-title strong");
      if (titleEl) titleEl.textContent = preset.label;
    }
    draft.providers[idx].vendor = v;
    const vLabel = vendorLabelOf(v);
    const titleSub = pane.querySelector(".llm-lobe-detail-title .llm-lobe-item-sub");
    if (titleSub) titleSub.textContent = vLabel;
    const navSub = document.querySelector(".llm-lobe-item.is-sel .llm-lobe-item-sub");
    if (navSub) {
      const row = draft.providers[idx];
      const on = providerIsConfigured(row);
      navSub.textContent = `${vLabel} · ${on ? `${row.models.length} 模型` : "未启用"}`;
    }
    if (baseInput) {
      const official = VENDOR_PRESETS.filter((p) => p.api_base).map((p) => p.api_base);
      if (v === "relay") {
        if (!baseInput.value.trim() || official.includes(baseInput.value.trim())) {
          baseInput.value = "";
        }
        baseInput.placeholder = "https://你的中转/v1";
      } else {
        baseInput.placeholder = "";
        if (
          !baseInput.value.trim() ||
          official.includes(baseInput.value.trim()) ||
          vendor === "relay"
        ) {
          baseInput.value = preset.api_base;
        }
      }
    }
  });
  pane.appendChild(form);

  const extras = document.createElement("div");
  extras.className = "llm-lobe-extras";
  const proxyBtn = document.createElement("button");
  proxyBtn.type = "button";
  proxyBtn.className = `notes-btn notes-proxy-card-btn${proxyOn ? " is-on" : ""}`;
  proxyBtn.dataset.f = "use_proxy";
  proxyBtn.setAttribute("role", "switch");
  proxyBtn.setAttribute("aria-checked", proxyOn ? "true" : "false");
  proxyBtn.title = "保存/测试该服务商时是否走本机 Clash 代理";
  proxyBtn.textContent = "代理";
  proxyBtn.addEventListener("click", () => {
    const next = proxyBtn.getAttribute("aria-checked") !== "true";
    proxyBtn.setAttribute("aria-checked", next ? "true" : "false");
    proxyBtn.classList.toggle("is-on", next);
  });
  extras.appendChild(proxyBtn);
  pane.appendChild(extras);

  const actions = document.createElement("div");
  actions.className = "notes-provider-actions";
  actions.innerHTML = `
    <button type="button" class="notes-btn primary llm-save">${shellT("settings.llm.save")}</button>
    <button type="button" class="notes-btn danger llm-del">${shellT("settings.llm.delete")}</button>
  `;
  actions.querySelector(".llm-save")?.addEventListener("click", () => {
    void saveSelected();
  });
  actions.querySelector(".llm-del")?.addEventListener("click", () => {
    draft.providers.splice(idx, 1);
    writeSel(draft.providers[0]?.id ?? null);
    renderLobe();
  });
  pane.appendChild(actions);

  pane.appendChild(buildConnectivity(prov));
  pane.appendChild(buildModelList(prov));
  return pane;
}

function pickTestModelId(p: NotesProvider): string | undefined {
  if (!p.models?.length) return undefined;
  const skip = /antigravity|computer-use|deep-research|imagen|veo|lyria/i;
  const enabled = p.models.filter((m) => isModelEnabled(draft, modelKey(p.id, m.id)));
  const pool = enabled.length ? enabled : p.models;
  const prefer = pool.find(
    (m) => !skip.test(m.id) && /gemini-2|flash|deepseek-chat|gpt-|claude/i.test(m.id)
  );
  if (prefer) return prefer.id;
  return pool.find((m) => !skip.test(m.id))?.id || pool[0]?.id;
}

function buildConnectivity(prov: NotesProvider): HTMLElement {
  const box = document.createElement("section");
  box.className = "llm-lobe-check";
  const label = document.createElement("h3");
  label.className = "notes-settings-subhead";
  label.textContent = shellT("settings.llm.check");
  box.appendChild(label);

  const row = document.createElement("div");
  row.className = "llm-lobe-check-row";
  const sel = document.createElement("select");
  sel.className = "llm-lobe-check-sel";
  const pick = pickTestModelId(prov);
  for (const m of prov.models) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.id;
    if (m.id === pick) opt.selected = true;
    sel.appendChild(opt);
  }
  if (!prov.models.length) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "先获取模型列表";
    sel.appendChild(opt);
  }
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "notes-btn";
  btn.textContent = shellT("settings.llm.checkRun");
  btn.addEventListener("click", () => void testSelected(sel.value));
  row.appendChild(sel);
  row.appendChild(btn);
  box.appendChild(row);
  return box;
}

function buildModelList(prov: NotesProvider): HTMLElement {
  const box = document.createElement("section");
  box.className = "llm-lobe-models";
  const head = document.createElement("div");
  head.className = "llm-lobe-models-head";
  const title = document.createElement("h3");
  title.className = "notes-settings-subhead";
  title.textContent = shellT("settings.llm.models");
  head.appendChild(title);
  const tools = document.createElement("div");
  tools.className = "llm-lobe-models-tools";
  const search = document.createElement("input");
  search.type = "search";
  search.className = "llm-lobe-model-search";
  search.placeholder = shellT("settings.llm.models.search");
  search.value = modelQuery;
  search.addEventListener("input", () => {
    modelQuery = search.value;
    const body = box.querySelector(".llm-lobe-model-body");
    if (body) body.replaceWith(buildModelBody(prov));
  });
  const fetchBtn = document.createElement("button");
  fetchBtn.type = "button";
  fetchBtn.className = "notes-btn";
  fetchBtn.textContent = shellT("settings.llm.models.fetch");
  fetchBtn.addEventListener("click", () => void rediscoverSelected());
  tools.appendChild(search);
  tools.appendChild(fetchBtn);
  head.appendChild(tools);
  box.appendChild(head);
  box.appendChild(buildModelBody(prov));
  return box;
}

function buildModelBody(prov: NotesProvider): HTMLElement {
  const body = document.createElement("div");
  body.className = "llm-lobe-model-body";
  const q = modelQuery.trim().toLowerCase();
  const models = q
    ? prov.models.filter(
        (m) => m.id.toLowerCase().includes(q) || m.label.toLowerCase().includes(q)
      )
    : prov.models;
  if (!models.length) {
    const empty = document.createElement("p");
    empty.className = "notes-settings-hint";
    empty.textContent = prov.models.length
      ? `没有匹配「${modelQuery}」的模型`
      : "还没有模型。点「获取模型列表」。";
    body.appendChild(empty);
    return body;
  }
  for (const m of models) {
    const key = modelKey(prov.id, m.id);
    const on = isModelEnabled(draft, key);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "llm-lobe-model-row";
    row.setAttribute("role", "switch");
    row.setAttribute("aria-checked", on ? "true" : "false");
    row.innerHTML = `
      <span>${escapeHtml(m.id)}</span>
      <span class="notes-fwd-switch${on ? " is-on" : ""}" aria-hidden="true"></span>
    `;
    row.addEventListener("click", () => {
      void persistDisabled(applyModelEnable(draft, key, !on));
    });
    body.appendChild(row);
  }
  return body;
}

async function persistDisabled(keys: string[]) {
  flushDetailToDraft();
  try {
    const next = await setDisabledModelKeys(keys);
    draft = {
      ...draft,
      disabled_model_keys: next.disabled_model_keys || [],
    };
    notifyProvidersChanged(next);
    host?.onProvidersSaved(next);
    renderLobe();
  } catch (e) {
    console.error(e);
  }
}

async function saveSelected() {
  flushDetailToDraft();
  const hit = selectedProvider();
  const label = hit?.prov.label || "当前服务商";
  if (!beginBusy(`保存「${label}」…`)) return;
  try {
    hideAlert();
    const saved = await saveProviders(draft, hit?.prov.id ?? null);
    host?.setBusy(true);
    draft = saved;
    host?.onProvidersSaved(saved);
    notifyProvidersChanged(saved);
    await paintLlmSettings(saved);
    const clicked = hit ? saved.providers.find((p) => p.id === hit.prov.id) : undefined;
    const clickedErr = (clicked?.models_sync_error || "").trim();
    const fails = realModelSyncFails(saved).filter((p) =>
      hit ? p.id === hit.prov.id : true
    );
    if (clickedErr === "未填写 API Key") {
      showAlert(`${clicked?.label || "当前服务商"}：未填写 API Key`, "error");
      host?.showTask("未填写 API Key", 100, "error");
      host?.hideTask(14000);
    } else if (fails.length) {
      const msg = fails.map((p) => `${p.label}：${p.models_sync_error}`).join("\n");
      showAlert(`保存了密钥，但拉模型失败。\n${msg}`, "error");
      host?.showTask(`拉模型失败：${fails[0].models_sync_error}`, 100, "error");
      host?.hideTask(14000);
    } else {
      showAlert(`已保存「${clicked?.label || label}」`, "ok");
      host?.showTask(`已保存「${clicked?.label || label}」`, 100, "ok");
      host?.hideTask(1200);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    showAlert(`保存失败：${msg}`, "error");
    host?.showTask(`保存失败：${msg}`, 100, "error");
    host?.hideTask(14000);
  } finally {
    endBusy();
  }
}

async function rediscoverSelected() {
  flushDetailToDraft();
  const hit = selectedProvider();
  if (!hit) return;
  if (!beginBusy("获取模型列表…")) return;
  try {
    hideAlert();
    const saved = await saveProviders(draft, hit.prov.id);
    host?.setBusy(true);
    host?.onProvidersSaved(saved);
    notifyProvidersChanged(saved);
    await paintLlmSettings(saved);
    const p = saved.providers.find((x) => x.id === hit.prov.id);
    const err = (p?.models_sync_error || "").trim();
    if (err) {
      showAlert(`获取模型失败：${err}`, "error");
      host?.showTask(`获取模型失败：${err}`, 100, "error");
      host?.hideTask(14000);
    } else {
      const n = p?.models.length ?? 0;
      showAlert(`已获取 ${n} 个模型`, "ok");
      host?.showTask(`已获取 ${n} 个模型`, 100, "ok");
      host?.hideTask(1200);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    showAlert(`获取模型失败：${msg}`, "error");
    host?.showTask(`获取模型失败：${msg}`, 100, "error");
    host?.hideTask(14000);
  } finally {
    endBusy();
  }
}

async function testSelected(modelId: string) {
  flushDetailToDraft();
  const hit = selectedProvider();
  if (!hit) return;
  if (!beginBusy("保存并获取模型…")) return;
  try {
    const saved = await saveProviders(draft, hit.prov.id);
    host?.setBusy(true);
    await paintLlmSettings(saved);
    host?.onProvidersSaved(saved);
    notifyProvidersChanged(saved);
    const p = saved.providers.find((x) => x.id === hit.prov.id);
    const mid = modelId || pickTestModelId(p || hit.prov);
    if (!p || !mid) {
      const err =
        (p?.models_sync_error || "").trim() || "请先保存并成功获取至少一个模型";
      showAlert(`${p?.label || "当前服务商"}：${err}`, "error");
      host?.showTask(err, 100, "error");
      host?.hideTask(14000);
      return;
    }
    host?.showTask(`连通性检查 · ${mid}…`);
    const msg = await testConnection(modelKey(p.id, mid));
    host?.setBusy(true);
    showAlert(msg, "ok");
    host?.showTask(msg, 100, "ok");
    host?.hideTask(2500);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    showAlert(`测试失败：${msg}`, "error");
    host?.showTask(`测试失败：${msg}`, 100, "error");
    host?.hideTask(14000);
  } finally {
    endBusy();
  }
}
