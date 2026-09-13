/**
 * 笔记 Composer「参数」小窗：本轮请求（当前模型协议白名单）+ 上游 API 代理开关。
 * LiteLLM 转发器与服务商 Key 仍在设置 → 语言模型（同一 network.json）。
 */
import { invoke } from "@tauri-apps/api/core";
import {
  loadRunPrefs,
  saveRunPrefs,
  type EffortLevel,
  type RunPrefs,
} from "./notes_run_prefs";
import {
  clampEffortToSchema,
  inferTurnParamSchema,
  type TurnParamSchema,
} from "./notes_turn_param_schema";
import type { NotesModelRef } from "./notes_types";
import {
  hideFloat,
  placeFloatInViewport,
  revealFloat,
} from "./omni_float";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export type LitellmSettings = {
  v: number;
  drop_params: boolean;
  num_retries: number;
  request_timeout: number;
  allowed_fails: number;
  cooldown_time: number;
};

const DEFAULT_LITELLM: LitellmSettings = {
  v: 1,
  drop_params: true,
  num_retries: 2,
  request_timeout: 600,
  allowed_fails: 3,
  cooldown_time: 60,
};

export type DetectedLocalProxy = {
  found: boolean;
  url: string | null;
  source: string;
  label: string;
  clash_pipe: boolean;
  tun_enabled: boolean;
};

export type SidecarNetworkState = {
  settings: { v: number; use_local_http_proxy: boolean };
  detected: DetectedLocalProxy;
};

const DEFAULT_NETWORK: SidecarNetworkState = {
  settings: { v: 1, use_local_http_proxy: true },
  detected: {
    found: false,
    url: null,
    source: "none",
    label: "未检测到",
    clash_pipe: false,
    tun_enabled: false,
  },
};

function cloneDefaultNetwork(): SidecarNetworkState {
  return {
    settings: { ...DEFAULT_NETWORK.settings },
    detected: { ...DEFAULT_NETWORK.detected },
  };
}

const SAVE_DEBOUNCE_MS = 320;

type Accessors = {
  getRunPrefs: () => RunPrefs;
  setRunPrefs: (p: RunPrefs) => void;
  getModel: () => NotesModelRef | null | undefined;
};

let accessors: Accessors | null = null;
let litellmSettings: LitellmSettings = { ...DEFAULT_LITELLM };
let sidecarNetwork: SidecarNetworkState = cloneDefaultNetwork();
let popoverOpen = false;
let outsideHandler: ((e: MouseEvent) => void) | null = null;
let saveTimer: number | null = null;
let litellmSaveTimer: number | null = null;

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

export function bindForwarderPrefsAccess(a: Accessors) {
  accessors = a;
}

export async function loadLitellmSettings(): Promise<LitellmSettings> {
  try {
    litellmSettings = await invoke<LitellmSettings>("notes_litellm_settings_get");
  } catch {
    litellmSettings = { ...DEFAULT_LITELLM };
  }
  return litellmSettings;
}

async function loadSidecarNetwork(): Promise<SidecarNetworkState> {
  try {
    sidecarNetwork = await invoke<SidecarNetworkState>("notes_sidecar_network_get");
  } catch {
    sidecarNetwork = cloneDefaultNetwork();
  }
  return sidecarNetwork;
}

async function persistSidecarNetwork(useLocalHttpProxy: boolean) {
  try {
    sidecarNetwork = await invoke<SidecarNetworkState>("notes_sidecar_network_save", {
      useLocalHttpProxy,
    });
  } catch (e) {
    console.error(e);
    await loadSidecarNetwork();
  }
  refreshForwarderPopoverIfOpen();
  void refreshApiProxySettingsCard();
}

async function persistLitellmSettings(next: LitellmSettings) {
  litellmSettings = next;
  try {
    litellmSettings = await invoke<LitellmSettings>("notes_litellm_settings_save", {
      settings: next,
    });
  } catch (e) {
    console.error(e);
  }
}

function scheduleLitellmSave() {
  if (litellmSaveTimer) window.clearTimeout(litellmSaveTimer);
  litellmSaveTimer = window.setTimeout(() => {
    litellmSaveTimer = null;
    void persistLitellmSettings(litellmSettings);
  }, SAVE_DEBOUNCE_MS);
}

function patchRunPrefs(patch: Partial<RunPrefs>) {
  if (!accessors) return;
  const next = { ...accessors.getRunPrefs(), ...patch };
  accessors.setRunPrefs(next);
  saveRunPrefs(next);
}

function currentSchema(): TurnParamSchema {
  return inferTurnParamSchema(accessors?.getModel());
}

function scheduleRunPrefsFromInputs(schema: TurnParamSchema) {
  if (saveTimer) window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    const tempEl = $("notes-fwd-temperature") as HTMLInputElement | null;
    const maxEl = $("notes-fwd-max-tokens") as HTMLInputElement | null;
    const topEl = $("notes-fwd-top-p") as HTMLInputElement | null;
    const budgetEl = $("notes-fwd-thinking-budget") as HTMLInputElement | null;
    const parseOpt = (el: HTMLInputElement | null): number | null => {
      if (!el) return null;
      const t = el.value.trim();
      if (!t) return null;
      const n = Number(t);
      return Number.isFinite(n) ? n : null;
    };
    const patch: Partial<RunPrefs> = {};
    if (schema.temperature) patch.temperature = parseOpt(tempEl);
    if (schema.max_tokens) {
      const n = parseOpt(maxEl);
      patch.max_tokens = n === null ? null : Math.floor(n);
    }
    if (schema.top_p) patch.top_p = parseOpt(topEl);
    if (schema.thinkingBudget) {
      const n = parseOpt(budgetEl);
      patch.thinking_budget = n === null ? null : Math.floor(n);
    }
    patchRunPrefs(patch);
  }, SAVE_DEBOUNCE_MS);
}

function closeForwarderPopover() {
  popoverOpen = false;
  const btn = $("notes-params-btn");
  const pop = $("notes-params-popover");
  btn?.setAttribute("aria-expanded", "false");
  hideFloat(pop);
  if (outsideHandler) {
    document.removeEventListener("click", outsideHandler, true);
    outsideHandler = null;
  }
}

function proxyHintText(): string {
  const det = sidecarNetwork.detected;
  const parts: string[] = [];
  if (sidecarNetwork.settings.use_local_http_proxy) {
    if (det.found) {
      parts.push(`当前走 ${det.label}`);
    } else {
      parts.push("Clash 未检测到 mixed-port");
      if (det.label && det.label !== "未检测到") parts.push(det.label);
    }
  } else {
    parts.push(`当前上游直连。探测：${det.label}`);
  }
  if (det.tun_enabled) {
    parts.push(
      "Clash TUN 开启时壳回环直连可能仍被劫持，请把 localhost / 127.0.0.1 加入 Clash 绕过列表（本软件不改 Clash 配置）。"
    );
  }
  parts.push("Studio 网页能开不代表 API 能通。");
  return parts.join(" ");
}

function appendApiProxyToggle(host: HTMLElement, hintClass: string) {
  const net = sidecarNetwork;
  const row = document.createElement("button");
  row.type = "button";
  row.className = "notes-fwd-toggle-row";
  row.setAttribute("role", "switch");
  row.setAttribute("aria-label", "API 走本地代理");
  row.setAttribute("aria-checked", net.settings.use_local_http_proxy ? "true" : "false");
  row.innerHTML = `
    <span class="notes-fwd-toggle-text">
      <strong>API 走本地代理</strong>
      <small>拉模型列表和对话上游走 Clash mixed-port；壳界面仍直连。Google 直连会超时。</small>
    </span>
    <span class="notes-fwd-switch ${net.settings.use_local_http_proxy ? "is-on" : ""}" aria-hidden="true"></span>
  `;
  const hint = document.createElement("div");
  hint.className = hintClass;
  hint.textContent = proxyHintText();
  row.addEventListener("click", (e) => {
    e.stopPropagation();
    const next = !sidecarNetwork.settings.use_local_http_proxy;
    sidecarNetwork = {
      ...sidecarNetwork,
      settings: { ...sidecarNetwork.settings, use_local_http_proxy: next },
    };
    row.setAttribute("aria-checked", next ? "true" : "false");
    row.querySelector(".notes-fwd-switch")?.classList.toggle("is-on", next);
    hint.textContent = proxyHintText();
    refreshForwarderPopoverIfOpen();
    void persistSidecarNetwork(next);
  });
  host.appendChild(row);
  host.appendChild(hint);
}

function fillApiProxySettingsCard(slot: HTMLElement) {
  slot.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "notes-proxy-banner";
  wrap.setAttribute("data-proxy-banner", "1");
  const head = document.createElement("h3");
  head.className = "notes-settings-subhead";
  head.style.margin = "0";
  head.textContent = "上游代理（专用开关）";
  wrap.appendChild(head);
  const intro = document.createElement("p");
  intro.className = "notes-settings-hint";
  intro.textContent =
    "只影响拉模型 / 测试 / 对话上游（Clash mixed-port），不影响壳界面。关着时 Google 官方接口会直连超时。各服务商卡片右侧「代理」另管该卡保存/拉模型。";
  wrap.appendChild(intro);
  appendApiProxyToggle(wrap, "notes-settings-hint");
  slot.appendChild(wrap);
}

async function refreshApiProxySettingsCard() {
  const slot = document.getElementById("notes-proxy-settings-slot");
  if (!slot) return;
  await loadSidecarNetwork();
  fillApiProxySettingsCard(slot);
}

/** 设置 → 语言模型：保存/拉模型之前就能看到并打开代理。 */
export async function mountApiProxySettingsCard(slot: HTMLElement) {
  slot.id = "notes-proxy-settings-slot";
  await loadSidecarNetwork();
  fillApiProxySettingsCard(slot);
}

function fillLitellmSettingsCard(slot: HTMLElement) {
  slot.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "notes-litellm-card";
  wrap.setAttribute("data-litellm-card", "1");
  const head = document.createElement("h3");
  head.className = "notes-settings-subhead";
  head.style.margin = "0";
  head.textContent = "LiteLLM 转发器";
  wrap.appendChild(head);
  const intro = document.createElement("p");
  intro.className = "notes-settings-hint";
  intro.textContent = "本机 sidecar（:4000）的转发参数，与当前选哪一只模型无关。写进 litellm_settings.json。";
  wrap.appendChild(intro);

  const s = litellmSettings;
  const mkToggleRow = (
    label: string,
    hint: string,
    on: boolean,
    onClick: () => void
  ) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "notes-fwd-toggle-row";
    row.setAttribute("aria-checked", on ? "true" : "false");
    row.innerHTML = `
      <span class="notes-fwd-toggle-text">
        <strong>${label}</strong>
        <small>${hint}</small>
      </span>
      <span class="notes-fwd-switch ${on ? "is-on" : ""}" aria-hidden="true"></span>
    `;
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    wrap.appendChild(row);
  };

  mkToggleRow(
    "drop_params",
    "丢弃上游不认识的参数（写进 litellm_settings）",
    s.drop_params,
    () => {
      litellmSettings = { ...litellmSettings, drop_params: !s.drop_params };
      scheduleLitellmSave();
      fillLitellmSettingsCard(slot);
    }
  );

  const mkProxyNum = (
    id: string,
    key: "num_retries" | "request_timeout" | "allowed_fails" | "cooldown_time",
    label: string,
    hint: string
  ) => {
    const row = document.createElement("label");
    row.className = "notes-fwd-num-row";
    const val = String(s[key] ?? "");
    row.innerHTML = `
      <span class="notes-fwd-field-label">${label}<small>${hint}</small></span>
      <input type="number" id="${id}" inputmode="numeric" step="1" min="0" value="${val}" />
    `;
    wrap.appendChild(row);
    const input = row.querySelector("input");
    input?.addEventListener("change", () => {
      const t = input.value.trim();
      const n = Number(t);
      if (!Number.isFinite(n) || n < 0) {
        input.value = String(litellmSettings[key]);
        return;
      }
      litellmSettings = { ...litellmSettings, [key]: Math.floor(n) };
      scheduleLitellmSave();
    });
  };

  mkProxyNum("notes-ll-num-retries", "num_retries", "num_retries", "失败重试次数");
  mkProxyNum(
    "notes-ll-request-timeout",
    "request_timeout",
    "request_timeout",
    "秒"
  );
  mkProxyNum(
    "notes-ll-allowed-fails",
    "allowed_fails",
    "allowed_fails",
    "冷却前允许失败次数"
  );
  mkProxyNum(
    "notes-ll-cooldown-time",
    "cooldown_time",
    "cooldown_time",
    "冷却秒数"
  );

  slot.appendChild(wrap);
}

export async function mountLitellmSettingsCard(slot: HTMLElement) {
  slot.id = "notes-litellm-settings-slot";
  await loadLitellmSettings();
  fillLitellmSettingsCard(slot);
}

function numAttr(v: number | null | undefined): string {
  return v === null || v === undefined ? "" : String(v);
}

function renderForwarderPopoverContent(host: HTMLElement) {
  const prefs = accessors?.getRunPrefs() ?? loadRunPrefs();
  const schema = currentSchema();
  const thinkingOn = schema.thinkingToggle && prefs.thinking;
  const samplingBlocked =
    schema.samplingIgnoredWhenThinking && thinkingOn;

  host.innerHTML = "";
  const head = document.createElement("div");
  head.className = "notes-fwd-pop-head";
  head.textContent = "参数";
  host.appendChild(head);

  const reqHead = document.createElement("div");
  reqHead.className = "notes-fwd-section-label";
  reqHead.textContent = `本轮请求 · ${schema.familyLabel}`;
  host.appendChild(reqHead);

  if (schema.note) {
    const note = document.createElement("div");
    note.className = "notes-fwd-note";
    note.textContent = schema.note;
    host.appendChild(note);
  }

  const hasRequestControls =
    schema.thinkingToggle ||
    schema.effortOptions.length > 0 ||
    schema.thinkingBudget ||
    schema.googleSearch ||
    schema.temperature ||
    schema.top_p ||
    schema.max_tokens;

  if (!hasRequestControls) {
    const empty = document.createElement("div");
    empty.className = "notes-fwd-note";
    empty.textContent = "当前模型没有可下发的本轮参数（或未选模型）。";
    host.appendChild(empty);
  }

  const mkToggleRow = (
    label: string,
    hint: string,
    on: boolean,
    onClick: () => void
  ) => {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "notes-fwd-toggle-row";
    row.setAttribute("aria-checked", on ? "true" : "false");
    row.innerHTML = `
      <span class="notes-fwd-toggle-text">
        <strong>${label}</strong>
        <small>${hint}</small>
      </span>
      <span class="notes-fwd-switch ${on ? "is-on" : ""}" aria-hidden="true"></span>
    `;
    row.addEventListener("click", (e) => {
      e.stopPropagation();
      onClick();
    });
    host.appendChild(row);
  };

  if (schema.thinkingToggle) {
    mkToggleRow(
      "thinking",
      "写入 thinking.type = enabled / disabled",
      prefs.thinking,
      () => {
        patchRunPrefs({ thinking: !prefs.thinking });
        refreshForwarderPopoverIfOpen();
      }
    );
  }

  if (schema.effortOptions.length) {
    const effortWrap = document.createElement("div");
    effortWrap.className = "notes-fwd-effort-wrap";
    if (schema.thinkingToggle && !prefs.thinking) {
      effortWrap.classList.add("is-disabled");
    }
    const effortLabel = document.createElement("div");
    effortLabel.className = "notes-fwd-field-label";
    effortLabel.innerHTML = `${escapeHtml(schema.effortFieldLabel)}<small>${escapeHtml(
      schema.effortFieldHint
    )}</small>`;
    effortWrap.appendChild(effortLabel);
    const effortBtns = document.createElement("div");
    effortBtns.className = "notes-fwd-effort-btns";
    const active = clampEffortToSchema(prefs.effort, schema) || schema.effortOptions[0].id;
    for (const opt of schema.effortOptions) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "notes-fwd-chip" + (active === opt.id ? " is-active" : "");
      b.textContent = opt.label;
      b.disabled = schema.thinkingToggle && !prefs.thinking;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (schema.thinkingToggle && !prefs.thinking) return;
        patchRunPrefs({ effort: opt.id as EffortLevel });
        refreshForwarderPopoverIfOpen();
      });
      effortBtns.appendChild(b);
    }
    effortWrap.appendChild(effortBtns);
    host.appendChild(effortWrap);
  }

  if (schema.googleSearch) {
    mkToggleRow(
      "Google Search",
      "写入 tools: [{ googleSearch: {} }]（LiteLLM → Gemini grounding）",
      prefs.google_search,
      () => {
        patchRunPrefs({ google_search: !prefs.google_search });
        refreshForwarderPopoverIfOpen();
      }
    );
  }

  const mkNum = (
    id: string,
    label: string,
    hint: string,
    value: string,
    disabled: boolean
  ) => {
    const row = document.createElement("label");
    row.className = "notes-fwd-num-row";
    if (disabled) row.classList.add("is-disabled");
    row.innerHTML = `
      <span class="notes-fwd-field-label">${label}<small>${hint}</small></span>
      <input type="number" id="${id}" inputmode="decimal" step="any" value="${value}" ${
        disabled ? "disabled" : ""
      } placeholder="不传" />
    `;
    host.appendChild(row);
    const input = row.querySelector("input");
    input?.addEventListener("input", () => scheduleRunPrefsFromInputs(schema));
    input?.addEventListener("change", () => scheduleRunPrefsFromInputs(schema));
  };

  if (schema.thinkingBudget) {
    mkNum(
      "notes-fwd-thinking-budget",
      "budget_tokens",
      "thinking.budget_tokens；空 = 不传",
      numAttr(prefs.thinking_budget),
      schema.thinkingToggle && !prefs.thinking
    );
  }

  if (schema.temperature) {
    mkNum(
      "notes-fwd-temperature",
      "temperature",
      samplingBlocked ? "thinking 开启时上游忽略" : "空 = 不传",
      numAttr(prefs.temperature),
      samplingBlocked
    );
  }
  if (schema.max_tokens) {
    mkNum(
      "notes-fwd-max-tokens",
      "max_tokens",
      "空 = 不传",
      numAttr(prefs.max_tokens),
      false
    );
  }
  if (schema.top_p) {
    mkNum(
      "notes-fwd-top-p",
      "top_p",
      samplingBlocked
        ? "thinking 开启时上游忽略"
        : "核采样：只从累计概率质量内采样下一 token（如 0.9）；空 = 不传",
      numAttr(prefs.top_p),
      samplingBlocked
    );
  }

  const proxyHead = document.createElement("div");
  proxyHead.className = "notes-fwd-section-label";
  proxyHead.textContent = "上游代理";
  host.appendChild(proxyHead);
  appendApiProxyToggle(host, "notes-fwd-note");

  const goSettings = document.createElement("button");
  goSettings.type = "button";
  goSettings.className = "notes-fwd-goto-settings";
  goSettings.textContent = "服务商 / LiteLLM：设置 → 语言模型";
  goSettings.addEventListener("click", (e) => {
    e.stopPropagation();
    closeForwarderPopover();
    window.dispatchEvent(new CustomEvent("omnitrace-open-llm-settings"));
  });
  host.appendChild(goSettings);
}

async function openForwarderPopover(anchor: HTMLElement) {
  await loadSidecarNetwork();
  let pop = $("notes-params-popover");
  if (!pop) {
    pop = document.createElement("div");
    pop.id = "notes-params-popover";
    pop.className = "notes-params-popover omni-float hidden";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-hidden", "true");
    document.body.appendChild(pop);
  }
  renderForwarderPopoverContent(pop);
  revealFloat(pop);
  placeFloatInViewport(pop, anchor.getBoundingClientRect(), "above", 300);
  popoverOpen = true;
  anchor.setAttribute("aria-expanded", "true");
  if (outsideHandler) {
    document.removeEventListener("click", outsideHandler, true);
  }
  outsideHandler = (e: MouseEvent) => {
    const t = e.target as Element | null;
    if (
      t?.closest?.("#notes-params-popover") ||
      t?.closest?.("#notes-params-btn")
    ) {
      return;
    }
    closeForwarderPopover();
  };
  window.setTimeout(() => {
    document.addEventListener("click", outsideHandler!, true);
  }, 0);
}

export function refreshForwarderPopoverIfOpen() {
  if (!popoverOpen) return;
  const pop = $("notes-params-popover");
  const btn = $("notes-params-btn");
  if (!pop || !btn) return;
  renderForwarderPopoverContent(pop);
  placeFloatInViewport(pop, btn.getBoundingClientRect(), "above", 300);
}

export function closeForwarderPopoverOnLeave() {
  closeForwarderPopover();
}

export function notifyForwarderRunPrefsChanged() {
  refreshForwarderPopoverIfOpen();
}

/** 发送前：按 schema 裁剪，只带上游会认的字段 */
export function buildTurnOptsFromPrefs(
  prefs: RunPrefs,
  model: NotesModelRef | null | undefined
): {
  thinking: boolean;
  thinking_toggle: boolean;
  effort: string;
  thinking_budget: number | null;
  temperature: number | null;
  max_tokens: number | null;
  top_p: number | null;
  google_search: boolean;
} {
  const schema = inferTurnParamSchema(model);
  const thinking = schema.thinkingToggle ? prefs.thinking : false;
  const effort =
    schema.effortOptions.length && (!schema.thinkingToggle || thinking)
      ? clampEffortToSchema(prefs.effort, schema)
      : "";
  return {
    thinking,
    thinking_toggle: schema.thinkingToggle,
    effort,
    thinking_budget:
      schema.thinkingBudget && (!schema.thinkingToggle || thinking)
        ? prefs.thinking_budget
        : null,
    temperature:
      schema.temperature && !(schema.samplingIgnoredWhenThinking && thinking)
        ? prefs.temperature
        : null,
    max_tokens: schema.max_tokens ? prefs.max_tokens : null,
    top_p:
      schema.top_p && !(schema.samplingIgnoredWhenThinking && thinking)
        ? prefs.top_p
        : null,
    google_search: schema.googleSearch ? prefs.google_search : false,
  };
}

export function initForwarderPrefsUi() {
  const btn = $("notes-params-btn");
  if (!btn) return;
  void loadSidecarNetwork();
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (popoverOpen) closeForwarderPopover();
    else void openForwarderPopover(btn);
  });
}
