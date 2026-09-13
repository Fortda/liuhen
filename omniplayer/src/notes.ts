/**
 * 笔记页：LLM 卡片 + LiteLLM sidecar + 绿线历史。连接配置在设置 → 语言模型。
 */
import {
  formatTs,
  formatRelativeTs,
  cardMetricParts,
  dataLogTip,
  listCards,
  readProtocolLog,
  cardShowsWireOrigin,
  wireOriginBtnTitle,
  wireOriginPopoverContent,
  WIRE_MOLECULE_ICON_SVG,
  cardHasCostBadge,
  costBadgeLabel,
  buildCostPopoverHtml,
  type CostBadgeMode,
  type CostRateHints,
} from "./notes_cards";
import {
  applyProtocolLogPlainButton,
  initProtocolLogPlainToggle,
  isProtocolLogPlainMode,
  renderProtocolLogText,
} from "./protocol_log_humanize";
import {
  applyEnvelopeButton,
  initEnvelopeToggle,
  renderEnvelopesHtml,
  type LogDrawerView,
} from "./protocol_log_envelopes";
import { COST_DISPLAY_EVENT } from "./notes_cost_display";
import {
  activityFromProtocolLog,
  buildMcpActivityEl,
  finalizeActivityForDone,
  hasMcpActivity,
  snapshotActivityOpenState,
  type McpStreamActivity,
} from "./notes_mcp_activity";
import {
  buildContextUsagePanelHtml,
  buildContextUsageSnapshot,
  contextUsageRingSvg,
  makePlaceholderChild,
  type ContextUsageExtras,
} from "./notes_context_usage";
import {
  bindProgressHandler,
  bindStreamHandlers,
  ensureSidecar,
  getPricing,
  getProviders,
  listModels,
  refreshModelsIfStale,
  refreshModelsNow,
  refreshPricingIfStale,
  setPinnedModelKeys,
  sendTurn,
  saveUserOnlyCard,
  sidecarStatus,
  type NotesProgressEvent,
  type PricingFile,
  type PriceRates,
} from "./notes_llm";
import {
  appendCardUserImages,
  clearComposerImages,
  closeComposerAttachPopover,
  getComposerImagePaths,
  initComposerAttachUi,
} from "./notes_composer_attach";
import {
  fillAssistantBubble,
  isAssistantMarkdownOn,
  setAssistantMarkdownOn,
} from "./notes_markdown";
import {
  bindMcpContextUsageSink,
  closeMcpPopoverOnLeave,
  initMcpPrefsUi,
  mcpServerIdForTool,
  mcpServerLabel,
  mcpTurnOpts,
} from "./notes_mcp_prefs";
import {
  bindForwarderPrefsAccess,
  buildTurnOptsFromPrefs,
  closeForwarderPopoverOnLeave,
  initForwarderPrefsUi,
  notifyForwarderRunPrefsChanged,
} from "./notes_forwarder_prefs";
import { initCardRail, updateCardRail } from "./notes_card_rail";
import {
  getSelectedWirePreset,
  initWirePresetSidebar,
  refreshWirePresetList,
  setWirePresetCards,
} from "./notes_wire_presets";
import {
  cancelWireDrag,
  composerIsLive,
  historyMessages,
  initNotesWires,
  linkNodes,
  loadContextGraph,
  pendingHistoryIds,
  rewireComposerAfterSend,
  scheduleDrawWires,
} from "./notes_wires";
import {
  enterClueBoardMode,
  flushClueBoardSave,
  initClueBoard,
  isClueAppsHosted,
  leaveClueBoardMode,
  scheduleDrawClueWires,
} from "./notes_clue_board";
import { initNotesAistudioImport } from "./notes_import";
import type { ResearchMeta } from "./notes_research";
import {
  enterNotesTimeline,
  initNotesTimeline,
  leaveNotesTimeline,
  resizeNotesTimeline,
  setNotesTimelineCards,
  setNotesTimelineResearch,
} from "./notes_timeline";
import { initNotesTimelineFunnel } from "./notes_timeline_funnel";
import { buildModelDetailHtml } from "./notes_model_detail";
import {
  closeModelEditor,
  initModelEditor,
  isModelEditorOpen,
  openModelEditor,
  syncModelEditor,
} from "./notes_model_editor";
import { initLlmSettingsHost, paintLlmSettings } from "./notes_llm_settings";
import {
  onProvidersChanged,
  realModelSyncFails,
  visiblePickerModels,
} from "./notes_model_visibility";
import {
  FLOAT_GAP,
  FLOAT_MARGIN,
  hideFloat,
  placeFloatInViewport,
  revealFloat,
} from "./omni_float";
import {
  loadRunPrefs,
  type RunPrefs,
} from "./notes_run_prefs";
import { vendorLogoHtml } from "./notes_vendor_icons";
import type {
  LlmSidecarStatus,
  NotesCardSummary,
  NotesModelRef,
  NotesProvider,
  ProvidersFile,
  WireContextInput,
} from "./notes_types";
import {
  modelKey,
  providerVendor,
  humanizeLlmError,
  isQuotaLlmError,
} from "./notes_types";
import { shellT } from "./shell_i18n";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";

const MODELS_STALE_MS = 24 * 60 * 60 * 1000;
const NOTES_MODE_KEY = "omnitrace.notes.mode";

type NotesMode = "stream" | "clue" | "timeline";

let notesMode: NotesMode = readNotesMode();
let researchItems: ResearchMeta[] = [];

let sidecarWarm: LlmSidecarStatus | null = null;
let sidecarEnsurePromise: Promise<LlmSidecarStatus> | null = null;
let currentModelKey = "";
const NONE_MODEL_KEY = "none";
let cards: NotesCardSummary[] = [];
const HIDE_NON_GREEN_KEY = "omnitrace.notes.hideNonGreen";
let chatAppsHosted = false;

export function setChatAppsHosted(v: boolean) {
  chatAppsHosted = v;
  const view = document.getElementById("notes-chat-view");
  if (!view) return;
  if (v) view.dataset.appsHost = "1";
  else delete view.dataset.appsHost;
}

export function isChatAppsHosted(): boolean {
  return chatAppsHosted;
}

export function isHideNonGreenOn(): boolean {
  try {
    return localStorage.getItem(HIDE_NON_GREEN_KEY) === "1";
  } catch {
    return false;
  }
}

export function setHideNonGreen(on: boolean) {
  try {
    localStorage.setItem(HIDE_NON_GREEN_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
  applyHideNonGreenFilter();
}

export function applyHideNonGreenFilter() {
  const on = isHideNonGreenOn();
  let keep: Set<string> | null = null;
  if (on) {
    const via = pendingHistoryIds(cards);
    if (via.length) keep = new Set(via);
  }
  document.querySelectorAll(".notes-card[data-card-id]").forEach((el) => {
    const id = (el as HTMLElement).dataset.cardId;
    el.classList.toggle("is-off-thread", !!(keep && id && !keep.has(id)));
  });
  const visible = keep ? cards.filter((c) => keep.has(c.id)) : cards;
  updateCardRail([...visible].sort((a, b) => a.created_at - b.created_at));
  scheduleDrawWires();
}

const CARD_RELATIVE_TIME_MS = 45_000;
/** 用户气泡超过这么多行才折叠（14px × 1.55 ≈ 132px）。 */
const USER_BUBBLE_COLLAPSE_LINES = 6;
const userBubbleExpanded = new Set<string>();
let userBubbleFoldObservers: ResizeObserver[] = [];
let cardRelativeTimeTimer: number | null = null;
let progressBusy = false;
let compactHideTimer: number | null = null;
let modelPopoverOpen = false;
let modelPopoverOutsideHandler: ((e: MouseEvent) => void) | null = null;
const providerCollapsed = new Set<string>();
let pricingCache: PricingFile | null = null;
let detailHoverTimer: number | null = null;
let detailHideTimer: number | null = null;
let detailAnchorEl: HTMLElement | null = null;
let pickerModels: NotesModelRef[] = [];
let lastModels: NotesModelRef[] = [];
let pickerProviders: ProvidersFile | null = null;
let modelSearchQuery = "";
let runPrefs: RunPrefs = loadRunPrefs();
const MODEL_POPOVER_WIDTH = 260;
const MODEL_DETAIL_WIDTH = 288;

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function readNotesMode(): NotesMode {
  try {
    const v = localStorage.getItem(NOTES_MODE_KEY);
    if (v === "clue" || v === "stream" || v === "timeline") return v;
  } catch {
    /* ignore */
  }
  return "stream";
}

function persistNotesMode(mode: NotesMode) {
  notesMode = mode;
  try {
    localStorage.setItem(NOTES_MODE_KEY, mode);
  } catch {
    /* ignore */
  }
}

function syncNotesModeSeg() {
  document.querySelectorAll("#notes-mode-seg [data-notes-mode]").forEach((btn) => {
    const el = btn as HTMLElement;
    el.classList.toggle("active", el.dataset.notesMode === notesMode);
  });
}

function applyNotesMode(mode: NotesMode, opts?: { skipPersist?: boolean }) {
  if (!opts?.skipPersist) persistNotesMode(mode);
  syncNotesModeSeg();

  const stream = mode === "stream";
  const clue = mode === "clue";
  const timeline = mode === "timeline";
  const clueHosted = isClueAppsHosted();
  const chatHosted = isChatAppsHosted();
  $("notes-chat-view")?.classList.toggle("hidden", chatHosted ? false : !stream);
  // When clue board / chat is reparented into shell apps, keep it visible there.
  $("notes-clue-board-view")?.classList.toggle("hidden", clueHosted ? false : !clue);
  $("notes-timeline-view")?.classList.toggle("hidden", !timeline);
  $("notes-stream-status")?.classList.toggle("hidden", !stream);
  $("notes-clue-apps-placeholder")?.classList.toggle(
    "hidden",
    !(clue && clueHosted)
  );
  $("notes-chat-apps-placeholder")?.classList.toggle(
    "hidden",
    !(stream && chatHosted)
  );

  if (stream) {
    if (!clueHosted) leaveClueBoardMode();
    leaveNotesTimeline();
    hideResearchDetail();
    scheduleDrawWires();
  } else if (clue) {
    cancelWireDrag();
    closeRunPopover();
    leaveNotesTimeline();
    hideResearchDetail();
    void enterClueBoardMode();
  } else {
    cancelWireDrag();
    closeRunPopover();
    if (!clueHosted) leaveClueBoardMode();
    void (async () => {
      await refreshResearch({ refit: true });
      enterNotesTimeline(cards, researchItems);
    })();
  }
}

function focusCardInStream(cardId: string, _createdAt: number) {
  applyNotesMode("stream");
  requestAnimationFrame(() => {
    const el = document.querySelector(
      `.notes-card[data-card-id="${CSS.escape(cardId)}"]`
    ) as HTMLElement | null;
    if (!el) return;
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("is-timeline-focus");
    window.setTimeout(() => el.classList.remove("is-timeline-focus"), 1600);
  });
}

function initNotesModeToggle() {
  syncNotesModeSeg();
  document.querySelectorAll("#notes-mode-seg [data-notes-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = (btn as HTMLElement).dataset.notesMode;
      if (mode !== "stream" && mode !== "clue" && mode !== "timeline") return;
      if (mode === notesMode) return;
      applyNotesMode(mode);
    });
  });
}

function showSettingsAlert(text: string, kind: "error" | "ok" = "error") {
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

function isLlmSettingsOpen(): boolean {
  const el = $("settings-llm");
  return !!el && !el.classList.contains("hidden");
}

function scheduleHideCompact(delayMs = 900) {
  if (compactHideTimer != null) window.clearTimeout(compactHideTimer);
  compactHideTimer = window.setTimeout(() => hideCompactTask(), delayMs);
}

function showCompactTask(
  label: string,
  progress?: number,
  mode: "busy" | "ok" | "error" = "busy"
) {
  const wrap = $("notes-inline-task");
  const labelEl = $("notes-inline-task-label");
  const bar = $("notes-inline-task-bar");
  if (!wrap || !labelEl || !bar) return;
  if (compactHideTimer != null) {
    window.clearTimeout(compactHideTimer);
    compactHideTimer = null;
  }
  wrap.classList.remove("hidden", "is-error");
  if (mode === "error") wrap.classList.add("is-error");
  labelEl.textContent = label;
  const fill = bar.firstElementChild as HTMLElement | null;
  if (typeof progress === "number" && progress > 0) {
    bar.classList.remove("indeterminate");
    if (fill) fill.style.width = `${Math.min(100, progress)}%`;
  } else {
    bar.classList.add("indeterminate");
    if (fill) fill.style.width = "";
  }
}

function hideCompactTask() {
  if (compactHideTimer != null) {
    window.clearTimeout(compactHideTimer);
    compactHideTimer = null;
  }
  $("notes-inline-task")?.classList.add("hidden");
}

function handleNotesProgress(ev: NotesProgressEvent) {
  if (ev.done) {
    progressBusy = false;
    if (ev.error) {
      showCompactTask(ev.message || "失败", 100, "error");
      if (isLlmSettingsOpen()) {
        showSettingsAlert(ev.message || "失败", "error");
      }
      scheduleHideCompact(isLlmSettingsOpen() ? 14000 : 4500);
    } else {
      const alertEl = $("notes-settings-alert");
      const blockingAlert =
        isLlmSettingsOpen() &&
        !!alertEl &&
        !alertEl.classList.contains("hidden") &&
        !alertEl.classList.contains("is-ok");
      if (blockingAlert) return;
      showCompactTask(ev.message || "完成", 100, "ok");
      scheduleHideCompact(1100);
    }
    return;
  }
  progressBusy = true;
  showCompactTask(ev.message, ev.progress > 0 ? ev.progress : undefined, "busy");
}

function modelLabelForKey(key: string, models: NotesModelRef[]): string {
  const hit = models.find(
    (m) => modelKey(m.provider_id, m.model_id) === key
  );
  return hit?.label || key || "选模型";
}

function currentModelRef(): NotesModelRef | undefined {
  return lastModels.find(
    (m) => modelKey(m.provider_id, m.model_id) === currentModelKey
  );
}

function updateModelBtn(models: NotesModelRef[]) {
  lastModels = models;
  const btn = $("notes-model-btn");
  const labelEl = btn?.querySelector(".notes-composer-model-label");
  if (currentModelKey === NONE_MODEL_KEY) {
    const label = "NONE";
    if (labelEl) labelEl.textContent = label;
    if (btn) {
      btn.title = "仅保存用户话，不调用模型";
      btn.setAttribute("aria-label", `选模型：${label}`);
    }
    syncRunPrefUi();
    syncContextUsageRing();
    return;
  }
  const hit = models.find(
    (m) => modelKey(m.provider_id, m.model_id) === currentModelKey
  );
  const label = hit?.label || hit?.model_id || "选模型";
  if (labelEl) labelEl.textContent = label;
  if (btn) {
    btn.title = label;
    btn.setAttribute("aria-label", `选模型：${label}`);
  }
  syncRunPrefUi();
  syncContextUsageRing();
}

function autoGrowNotesInput() {
  const input = $("notes-input") as HTMLTextAreaElement | null;
  if (!input) return;
  input.style.height = "auto";
  const next = Math.min(input.scrollHeight, 160);
  input.style.height = `${Math.max(next, 22)}px`;
  scheduleDrawWires();
}

const COPY_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;

async function copyWithFeedback(btn: HTMLButtonElement, text: string) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    btn.classList.add("is-copied");
    btn.title = "已复制";
    window.setTimeout(() => {
      btn.classList.remove("is-copied");
      btn.title = "复制";
    }, 1200);
  } catch {
    btn.classList.add("is-error");
    window.setTimeout(() => btn.classList.remove("is-error"), 1200);
  }
}

function createWireOriginBtn(c: NotesCardSummary): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "notes-card-wire-origin-btn";
  btn.title = wireOriginBtnTitle(c);
  btn.setAttribute("aria-label", wireOriginBtnTitle(c));
  btn.innerHTML = WIRE_MOLECULE_ICON_SVG;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    openWireOriginPopover(btn, c);
  });
  return btn;
}

let wireOriginPopoverEl: HTMLElement | null = null;
let wireOriginOutsideHandler: ((e: MouseEvent) => void) | null = null;

function closeWireOriginPopover() {
  if (wireOriginOutsideHandler) {
    document.removeEventListener("click", wireOriginOutsideHandler, true);
    wireOriginOutsideHandler = null;
  }
  hideFloat(wireOriginPopoverEl);
}

function openWireOriginPopover(anchor: HTMLElement, c: NotesCardSummary) {
  closeCostPopover();
  closeCtxPopover();
  if (!wireOriginPopoverEl) {
    wireOriginPopoverEl = document.createElement("div");
    wireOriginPopoverEl.id = "notes-wire-origin-pop";
    wireOriginPopoverEl.className = "omni-float notes-wire-origin-pop hidden";
    wireOriginPopoverEl.setAttribute("role", "dialog");
    wireOriginPopoverEl.setAttribute("aria-hidden", "true");
    document.body.appendChild(wireOriginPopoverEl);
  }
  const pop = wireOriginPopoverContent(c);
  const rows = pop.lines
    .map(
      (row) =>
        `<div class="notes-wire-origin-row"><span class="notes-wire-origin-label">${escapeHtml(row.label)}</span><span class="notes-wire-origin-value">${escapeHtml(row.value)}</span></div>`
    )
    .join("");
  const hint = pop.hint
    ? `<p class="notes-wire-origin-hint">${escapeHtml(pop.hint)}</p>`
    : "";
  wireOriginPopoverEl.innerHTML = `<div class="notes-wire-origin-head"><strong>${escapeHtml(pop.title)}</strong><button type="button" class="notes-wire-origin-close" aria-label="关闭">×</button></div><div class="notes-wire-origin-body">${rows}${hint}</div>`;
  wireOriginPopoverEl
    .querySelector(".notes-wire-origin-close")
    ?.addEventListener("click", () => closeWireOriginPopover());
  revealFloat(wireOriginPopoverEl);
  placeFloatInViewport(
    wireOriginPopoverEl,
    anchor.getBoundingClientRect(),
    "above",
    280
  );
  if (wireOriginOutsideHandler) {
    document.removeEventListener("click", wireOriginOutsideHandler, true);
  }
  wireOriginOutsideHandler = (e: MouseEvent) => {
    const t = e.target as Element | null;
    if (t?.closest?.("#notes-wire-origin-pop") || t?.closest?.(".notes-card-wire-origin-btn")) {
      return;
    }
    closeWireOriginPopover();
  };
  window.setTimeout(() => {
    document.addEventListener("click", wireOriginOutsideHandler!, true);
  }, 0);
}

function wireContextForSend(history: { role: string; content: string }[]): WireContextInput | null {
  const fromWireContext = history.length > 0 || composerIsLive();
  if (!fromWireContext) return null;
  const preset = getSelectedWirePreset();
  return {
    from_wire_context: true,
    wire_preset_id: preset?.id ?? null,
    wire_preset_name: preset?.name ?? null,
    wire_preset_note: preset?.note ?? null,
    wire_preset_created_at: preset?.created_at ?? null,
  };
}

function createCopyBtn(text: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "notes-card-copy-btn";
  btn.title = "复制";
  btn.setAttribute("aria-label", "复制");
  btn.innerHTML = COPY_ICON_SVG;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    void copyWithFeedback(btn, text);
  });
  return btn;
}

function disconnectUserBubbleFoldObservers() {
  for (const ro of userBubbleFoldObservers) ro.disconnect();
  userBubbleFoldObservers = [];
}

function pruneUserBubbleExpanded() {
  const ids = new Set(cards.map((c) => c.id));
  for (const id of [...userBubbleExpanded]) {
    if (!ids.has(id)) userBubbleExpanded.delete(id);
  }
}

function syncUserFoldBtn(btn: HTMLButtonElement, expanded: boolean) {
  const key = expanded ? "notes.card.userCollapse" : "notes.card.userExpand";
  btn.setAttribute("data-i18n", key);
  btn.textContent = shellT(key);
  btn.setAttribute("aria-expanded", expanded ? "true" : "false");
}

function userTextLikelyLong(text: string): boolean {
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lines++;
  }
  if (lines > USER_BUBBLE_COLLAPSE_LINES) return true;
  return text.length > USER_BUBBLE_COLLAPSE_LINES * 40;
}

function userBubbleOverflows(textEl: HTMLElement): boolean {
  const cs = getComputedStyle(textEl);
  const font = parseFloat(cs.fontSize) || 14;
  const rawLh = cs.lineHeight;
  const parsedLh = parseFloat(rawLh);
  const lh =
    rawLh === "normal" || !Number.isFinite(parsedLh) ? font * 1.55 : parsedLh;
  return textEl.scrollHeight > lh * USER_BUBBLE_COLLAPSE_LINES + 1;
}

function applyUserBubbleFold(
  user: HTMLElement,
  textEl: HTMLElement,
  btn: HTMLButtonElement,
  cardId: string
) {
  if (!user.isConnected) return;
  if (textEl.scrollHeight === 0 || textEl.clientWidth === 0) return;
  const over = userBubbleOverflows(textEl);
  user.classList.toggle("is-collapsible", over);
  if (!over) {
    user.classList.remove("is-collapsed");
    return;
  }
  const expanded = userBubbleExpanded.has(cardId);
  user.classList.toggle("is-collapsed", !expanded);
  syncUserFoldBtn(btn, expanded);
}

function bindUserBubbleFold(
  user: HTMLElement,
  textEl: HTMLElement,
  btn: HTMLButtonElement,
  cardId: string
) {
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    if (userBubbleExpanded.has(cardId)) userBubbleExpanded.delete(cardId);
    else userBubbleExpanded.add(cardId);
    applyUserBubbleFold(user, textEl, btn, cardId);
  });
  const ro = new ResizeObserver(() => {
    applyUserBubbleFold(user, textEl, btn, cardId);
  });
  userBubbleFoldObservers.push(ro);
  requestAnimationFrame(() => {
    if (!textEl.isConnected) return;
    ro.observe(textEl);
  });
}

let costPopoverEl: HTMLElement | null = null;
let costPopoverCard: NotesCardSummary | null = null;
let costPopoverMode: CostBadgeMode = "cost";
let costPopoverPinned = false;
let costPopoverOutsideHandler: ((e: MouseEvent) => void) | null = null;
let costHoverTimer: number | null = null;
let costLeaveTimer: number | null = null;

function clearCostTimers() {
  if (costHoverTimer != null) {
    window.clearTimeout(costHoverTimer);
    costHoverTimer = null;
  }
  if (costLeaveTimer != null) {
    window.clearTimeout(costLeaveTimer);
    costLeaveTimer = null;
  }
}

function ratesHintsForCard(c: NotesCardSummary): CostRateHints | null {
  const key = c.cost.price_key;
  if (!key || !pricingCache) return null;
  const r: PriceRates | undefined =
    pricingCache.overrides?.[key] || pricingCache.models[key];
  if (!r) return null;
  return {
    input: r.input_per_1m,
    output: r.output_per_1m,
    cache_read: r.cache_read_per_1m,
    currency: r.currency,
  };
}

function closeCostPopover() {
  clearCostTimers();
  costPopoverPinned = false;
  costPopoverCard = null;
  if (costPopoverOutsideHandler) {
    document.removeEventListener("click", costPopoverOutsideHandler, true);
    costPopoverOutsideHandler = null;
  }
  hideFloat(costPopoverEl);
}

/** 未来 MCP/Skill 注入点；现为空，悬停骨架仍可用。 */
let contextUsageExtras: ContextUsageExtras = {};
let ctxPopoverEl: HTMLElement | null = null;
let ctxTipEl: HTMLElement | null = null;
let ctxPopoverPinned = false;
let ctxPopoverOutsideHandler: ((e: MouseEvent) => void) | null = null;
let ctxHoverTimer: number | null = null;
let ctxLeaveTimer: number | null = null;

function clearCtxTimers() {
  if (ctxHoverTimer != null) {
    window.clearTimeout(ctxHoverTimer);
    ctxHoverTimer = null;
  }
  if (ctxLeaveTimer != null) {
    window.clearTimeout(ctxLeaveTimer);
    ctxLeaveTimer = null;
  }
}

function hideCtxTip() {
  hideFloat(ctxTipEl);
}

function showCtxTip(text: string, anchor: DOMRect) {
  if (!ctxTipEl) {
    ctxTipEl = document.createElement("div");
    ctxTipEl.id = "notes-ctx-tip";
    ctxTipEl.className = "omni-float notes-ctx-tip hidden";
    ctxTipEl.setAttribute("role", "tooltip");
    document.body.appendChild(ctxTipEl);
  }
  ctxTipEl.textContent = text;
  revealFloat(ctxTipEl);
  placeFloatInViewport(ctxTipEl, anchor, "above", 220);
}

function closeCtxPopover() {
  clearCtxTimers();
  ctxPopoverPinned = false;
  hideCtxTip();
  if (ctxPopoverOutsideHandler) {
    document.removeEventListener("click", ctxPopoverOutsideHandler, true);
    ctxPopoverOutsideHandler = null;
  }
  const btn = $("notes-ctx-usage-btn");
  btn?.setAttribute("aria-expanded", "false");
  hideFloat(ctxPopoverEl);
}

function currentCtxSnapshot() {
  return buildContextUsageSnapshot(cards, {
    model: currentModelRef(),
    pricing: pricingCache,
    extras: contextUsageExtras,
  });
}

function syncContextUsageRing() {
  const btn = $("notes-ctx-usage-btn");
  if (!btn) return;
  const snap = currentCtxSnapshot();
  const pct =
    snap.maxTokens != null ? snap.percentFull : snap.usedTokens > 0 ? 8 : 0;
  btn.innerHTML = contextUsageRingSvg(pct);
  const title =
    snap.maxTokens != null
      ? `上下文用量 ${snap.percentFull.toFixed(0)}%`
      : snap.usedTokens > 0
        ? `上下文用量 ${snap.usedTokens} tokens`
        : "上下文用量";
  btn.title = title;
  btn.setAttribute("aria-label", title);
  if (
    ctxPopoverEl &&
    !ctxPopoverEl.classList.contains("hidden") &&
    ctxPopoverPinned
  ) {
    fillCtxPopover(btn);
  }
}

function bindCtxSegmentHover(root: HTMLElement) {
  const highlight = (id: string | null) => {
    root.querySelectorAll("[data-seg-id]").forEach((el) => {
      el.classList.toggle(
        "is-hot",
        !!id && (el as HTMLElement).dataset.segId === id
      );
    });
  };
  root.querySelectorAll("[data-seg-id]").forEach((node) => {
    const el = node as HTMLElement;
    const id = el.dataset.segId || "";
    el.addEventListener("mouseenter", () => {
      highlight(id);
      const title = el.getAttribute("title");
      if (title) showCtxTip(title, el.getBoundingClientRect());
    });
    el.addEventListener("mouseleave", () => {
      highlight(null);
      hideCtxTip();
    });
    el.addEventListener("focus", () => {
      highlight(id);
      const title = el.getAttribute("title");
      if (title) showCtxTip(title, el.getBoundingClientRect());
    });
    el.addEventListener("blur", () => {
      highlight(null);
      hideCtxTip();
    });
  });
}

function fillCtxPopover(anchor: HTMLElement) {
  if (!ctxPopoverEl) {
    ctxPopoverEl = document.createElement("div");
    ctxPopoverEl.id = "notes-ctx-pop";
    ctxPopoverEl.className = "omni-float notes-ctx-pop hidden";
    ctxPopoverEl.setAttribute("role", "dialog");
    ctxPopoverEl.setAttribute("aria-hidden", "true");
    document.body.appendChild(ctxPopoverEl);
    ctxPopoverEl.addEventListener("mouseenter", () => clearCtxTimers());
    ctxPopoverEl.addEventListener("mouseleave", () => {
      if (ctxPopoverPinned) return;
      ctxLeaveTimer = window.setTimeout(() => closeCtxPopover(), 180);
    });
  }
  const snap = currentCtxSnapshot();
  ctxPopoverEl.innerHTML = buildContextUsagePanelHtml(snap);
  ctxPopoverEl
    .querySelector(".notes-ctx-pop-close")
    ?.addEventListener("click", () => closeCtxPopover());
  bindCtxSegmentHover(ctxPopoverEl);
  revealFloat(ctxPopoverEl);
  placeFloatInViewport(
    ctxPopoverEl,
    anchor.getBoundingClientRect(),
    "above",
    320
  );
}

function openCtxPopover(anchor: HTMLElement, pin: boolean) {
  closeCostPopover();
  closeWireOriginPopover();
  clearCtxTimers();
  ctxPopoverPinned = pin;
  fillCtxPopover(anchor);
  anchor.setAttribute("aria-expanded", "true");
  if (ctxPopoverOutsideHandler) {
    document.removeEventListener("click", ctxPopoverOutsideHandler, true);
  }
  ctxPopoverOutsideHandler = (e: MouseEvent) => {
    const t = e.target as Element | null;
    if (
      t?.closest?.("#notes-ctx-pop") ||
      t?.closest?.("#notes-ctx-usage-btn")
    ) {
      return;
    }
    closeCtxPopover();
  };
  window.setTimeout(() => {
    document.addEventListener("click", ctxPopoverOutsideHandler!, true);
  }, 0);
}

function initContextUsageUi() {
  const btn = $("notes-ctx-usage-btn");
  if (!btn) return;
  syncContextUsageRing();
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open =
      ctxPopoverEl &&
      !ctxPopoverEl.classList.contains("hidden") &&
      ctxPopoverPinned;
    if (open) {
      closeCtxPopover();
      return;
    }
    openCtxPopover(btn, true);
  });
  btn.addEventListener("mouseenter", () => {
    clearCtxTimers();
    ctxHoverTimer = window.setTimeout(() => {
      if (ctxPopoverPinned) return;
      openCtxPopover(btn, false);
    }, 220);
  });
  btn.addEventListener("mouseleave", () => {
    clearCtxTimers();
    if (ctxPopoverPinned) return;
    ctxLeaveTimer = window.setTimeout(() => closeCtxPopover(), 180);
  });
}

/** 供后续 MCP/Skill 模块写入用量；立即刷新圆环。 */
export function setContextUsageExtras(extras: ContextUsageExtras) {
  contextUsageExtras = extras || {};
  syncContextUsageRing();
}

function fillCostPopover(c: NotesCardSummary, anchor: HTMLElement) {
  if (!costPopoverEl) {
    costPopoverEl = document.createElement("div");
    costPopoverEl.id = "notes-cost-pop";
    costPopoverEl.className = "omni-float notes-cost-pop hidden";
    costPopoverEl.setAttribute("role", "dialog");
    costPopoverEl.setAttribute("aria-hidden", "true");
    document.body.appendChild(costPopoverEl);
    costPopoverEl.addEventListener("mouseenter", () => {
      clearCostTimers();
    });
    costPopoverEl.addEventListener("mouseleave", () => {
      if (costPopoverPinned) return;
      costLeaveTimer = window.setTimeout(() => closeCostPopover(), 180);
    });
  }
  costPopoverCard = c;
  costPopoverEl.innerHTML = buildCostPopoverHtml(
    c,
    costPopoverMode,
    ratesHintsForCard(c)
  );
  costPopoverEl
    .querySelector(".notes-cost-pop-close")
    ?.addEventListener("click", () => closeCostPopover());
  costPopoverEl.querySelectorAll(".notes-cost-mode-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const mode = (btn as HTMLElement).dataset.mode as CostBadgeMode;
      if (mode !== "cost" && mode !== "token") return;
      costPopoverMode = mode;
      if (costPopoverCard) fillCostPopover(costPopoverCard, anchor);
    });
  });
  revealFloat(costPopoverEl);
  placeFloatInViewport(
    costPopoverEl,
    anchor.getBoundingClientRect(),
    "above",
    300
  );
}

function openCostPopover(anchor: HTMLElement, c: NotesCardSummary, pin: boolean) {
  closeCtxPopover();
  closeWireOriginPopover();
  clearCostTimers();
  costPopoverPinned = pin;
  if (!costPopoverCard || costPopoverCard.id !== c.id) {
    costPopoverMode = c.cost.priced ? "cost" : "token";
  }
  fillCostPopover(c, anchor);
  if (costPopoverOutsideHandler) {
    document.removeEventListener("click", costPopoverOutsideHandler, true);
  }
  costPopoverOutsideHandler = (e: MouseEvent) => {
    const t = e.target as Element | null;
    if (
      t?.closest?.("#notes-cost-pop") ||
      t?.closest?.(".notes-card-cost-badge")
    ) {
      return;
    }
    closeCostPopover();
  };
  window.setTimeout(() => {
    document.addEventListener("click", costPopoverOutsideHandler!, true);
  }, 0);
}

function createCostBadge(c: NotesCardSummary): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "notes-card-cost-badge";
  btn.dataset.cardId = c.id;
  const label = costBadgeLabel(c);
  btn.textContent = label;
  btn.title = c.cost.priced ? "费用明细" : "用量明细";
  btn.setAttribute("aria-label", btn.title);
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const open =
      costPopoverEl &&
      !costPopoverEl.classList.contains("hidden") &&
      costPopoverCard?.id === c.id;
    if (open && costPopoverPinned) {
      closeCostPopover();
      return;
    }
    openCostPopover(btn, c, true);
  });
  btn.addEventListener("mouseenter", () => {
    clearCostTimers();
    costHoverTimer = window.setTimeout(() => {
      if (costPopoverPinned && costPopoverCard?.id === c.id) return;
      openCostPopover(btn, c, false);
    }, 220);
  });
  btn.addEventListener("mouseleave", () => {
    clearCostTimers();
    if (costPopoverPinned) return;
    costLeaveTimer = window.setTimeout(() => closeCostPopover(), 180);
  });
  return btn;
}

function renderCard(c: NotesCardSummary): HTMLElement {
  const el = document.createElement("article");
  el.className = "notes-card";
  el.dataset.cardId = c.id;
  el.dataset.createdAt = String(c.created_at);
  if (c.status === "streaming") el.classList.add("is-streaming");

  const body = document.createElement("div");
  body.className = "notes-card-body";
  if (cardShowsWireOrigin(c)) {
    body.appendChild(createWireOriginBtn(c));
  }

  const head = document.createElement("div");
  head.className = "notes-card-head";
  head.innerHTML = `<span class="notes-card-time">${formatTs(c.created_at)}<span class="notes-card-time-relative">${formatRelativeTs(c.created_at)}</span></span><span class="notes-card-model">${escapeHtml(c.model_label)}</span>`;

  const messages = document.createElement("div");
  messages.className = "notes-card-messages";

  const userWrap = document.createElement("div");
  userWrap.className = "notes-card-user-wrap";
  const user = document.createElement("div");
  user.className = "notes-card-user";
  const userText = document.createElement("div");
  userText.className = "notes-card-user-text";
  userText.textContent = c.user_text;
  const userFade = document.createElement("div");
  userFade.className = "notes-card-user-fade";
  userFade.setAttribute("aria-hidden", "true");
  const userFold = document.createElement("button");
  userFold.type = "button";
  userFold.className = "notes-card-user-fold";
  userText.id = `notes-user-text-${c.id}`;
  userFold.setAttribute("aria-controls", userText.id);
  const userExpanded = userBubbleExpanded.has(c.id);
  if (!userExpanded && userTextLikelyLong(c.user_text)) {
    user.classList.add("is-collapsed", "is-collapsible");
  }
  syncUserFoldBtn(userFold, userExpanded);
  user.append(userText, userFade, userFold);
  bindUserBubbleFold(user, userText, userFold, c.id);
  userWrap.append(user, createCopyBtn(c.user_text));
  void appendCardUserImages(userWrap, c.user_images);

  const assistantWrap = document.createElement("div");
  assistantWrap.className = "notes-card-assistant-wrap";
  const assistant = document.createElement("div");
  assistant.className = "notes-card-assistant";
  const mdOn = isAssistantMarkdownOn();
  let assistantText = "";
  if (c.status === "error") {
    assistant.classList.add("is-error");
    assistantText = humanizeLlmError((c.error || "").trim()) || "（失败）";
    fillAssistantBubble(assistant, assistantText, { markdown: false, plain: true });
  } else if (c.status === "streaming" && !c.assistant_text) {
    if (hasMcpActivity(c.stream_activity)) {
      // 有活动面板时助手区不再塞粗状态文案，只留极短占位
      assistant.classList.add("is-placeholder", "is-activity-await");
      assistantText = "";
      fillAssistantBubble(assistant, "", { markdown: false, plain: true });
      assistant.hidden = true;
    } else {
      assistant.classList.add("is-placeholder");
      assistantText = (c.stream_status || "").trim() || "等待服务器响应…";
      fillAssistantBubble(assistant, assistantText, { markdown: false, plain: true });
    }
  } else if (c.status === "streaming") {
    // 流式中保持原文，避免每帧重排 markdown（长消息友好）
    assistantText = c.assistant_text || "";
    fillAssistantBubble(assistant, assistantText, { markdown: false, plain: true });
  } else {
    assistantText = c.assistant_text || "";
    fillAssistantBubble(assistant, assistantText, { markdown: mdOn });
  }
  if (assistantText && c.status !== "streaming") assistantWrap.append(assistant, createCopyBtn(assistantText));
  else assistantWrap.appendChild(assistant);

  messages.append(userWrap, assistantWrap);

  if (hasMcpActivity(c.stream_activity)) {
    const live = c.status === "streaming";
    const act = buildMcpActivityEl(
      c.stream_activity as McpStreamActivity,
      (c.stream_status || "").trim() || (live ? "进行中…" : "已完成"),
      { completed: !live }
    );
    // 活动面板插在用户气泡与助手之间（结束后仍保留，可展开思考）
    messages.insertBefore(act, assistantWrap);
  }

  const footer = document.createElement("div");
  footer.className = "notes-card-footer";

  const metrics = document.createElement("div");
  metrics.className = "notes-card-metrics";
  for (const p of cardMetricParts(c)) {
    const span = document.createElement("span");
    span.textContent = p.text;
    span.title = p.tip;
    metrics.appendChild(span);
  }

  const footActions = document.createElement("div");
  footActions.className = "notes-card-foot-actions";

  const mdBtn = document.createElement("button");
  mdBtn.type = "button";
  mdBtn.className = "notes-card-data-btn notes-card-md-btn" + (mdOn ? " is-active" : "");
  mdBtn.textContent = mdOn ? "md" : "raw";
  mdBtn.title = mdOn
    ? "Markdown 渲染（点切换为原文）"
    : "原文（点切换为 Markdown）";
  mdBtn.setAttribute("aria-label", mdBtn.title);
  mdBtn.setAttribute("aria-pressed", mdOn ? "true" : "false");
  mdBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    setAssistantMarkdownOn(!isAssistantMarkdownOn());
    renderFeed();
  });

  const dataBtn = document.createElement("button");
  dataBtn.type = "button";
  dataBtn.className = "notes-card-data-btn";
  dataBtn.textContent = "data";
  dataBtn.title = dataLogTip();
  dataBtn.setAttribute("aria-label", dataLogTip());
  dataBtn.addEventListener("click", () => void openLogDrawer(c.id, c.created_at));

  footActions.append(mdBtn, dataBtn);
  footer.append(metrics, footActions);
  body.append(head, messages, footer);
  if (cardHasCostBadge(c)) {
    body.appendChild(createCostBadge(c));
    body.classList.add("has-cost-badge");
  }
  el.appendChild(body);
  return el;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function refreshCardRelativeTimes() {
  document.querySelectorAll(".notes-card[data-created-at]").forEach((el) => {
    const rel = el.querySelector(".notes-card-time-relative");
    if (!rel) return;
    const ts = Number((el as HTMLElement).dataset.createdAt);
    if (!Number.isFinite(ts)) return;
    rel.textContent = formatRelativeTs(ts);
  });
}

function ensureCardRelativeTimeTicker() {
  if (cardRelativeTimeTimer != null) return;
  cardRelativeTimeTimer = window.setInterval(
    refreshCardRelativeTimes,
    CARD_RELATIVE_TIME_MS
  );
}

function renderFeed() {
  const feed = $("notes-feed");
  if (!feed) return;
  closeCostPopover();
  closeCtxPopover();
  disconnectUserBubbleFoldObservers();
  pruneUserBubbleExpanded();
  feed.innerHTML = "";
  const sorted = [...cards].sort((a, b) => a.created_at - b.created_at);
  for (const c of sorted) {
    feed.appendChild(renderCard(c));
  }
  feed.scrollTop = feed.scrollHeight;
  refreshCardRelativeTimes();
  ensureCardRelativeTimeTicker();
  updateCardRail(sorted);
  scheduleDrawWires();
  syncComposerHint();
  setWirePresetCards(cards);
  syncContextUsageRing();
  applyHideNonGreenFilter();
}

function upsertCard(summary: NotesCardSummary) {
  const i = cards.findIndex((c) => c.id === summary.id);
  const prevAct = i >= 0 ? cards[i].stream_activity : null;
  const merged: NotesCardSummary = {
    ...summary,
    stream_activity:
      summary.stream_activity ??
      (summary.status === "streaming" ? prevAct : finalizeActivityForDone(prevAct)) ??
      null,
  };
  if (i >= 0) cards[i] = merged;
  else cards.push(merged);
  renderFeed();
}

function patchStreamingCard(
  cardId: string,
  assistantText: string,
  done?: NotesCardSummary
) {
  const i = cards.findIndex((c) => c.id === cardId);
  if (done) {
    if (i >= 0) cards[i] = done;
    else cards.push(done);
    renderFeed();
    return;
  }
  if (i >= 0) {
    cards[i] = {
      ...cards[i],
      assistant_text: assistantText,
      status: "streaming",
      stream_status: assistantText ? null : cards[i].stream_status,
      error: null,
    };
  }
  const el = document.querySelector(
    `.notes-card[data-card-id="${CSS.escape(cardId)}"]`
  );
  const assistant = el?.querySelector(".notes-card-assistant") as HTMLElement | null;
  if (assistant) {
    if (assistantText) {
      assistant.hidden = false;
      assistant.classList.remove("is-placeholder", "is-error", "is-activity-await");
      // 流式补丁只用纯文本，结束后 renderFeed 再按 md 偏好渲染
      fillAssistantBubble(assistant, assistantText, { markdown: false, plain: true });
    } else {
      assistant.classList.add("is-placeholder");
      assistant.classList.remove("is-error");
      const act = i >= 0 ? cards[i].stream_activity : null;
      if (hasMcpActivity(act)) {
        assistant.hidden = true;
        assistant.classList.add("is-activity-await");
        fillAssistantBubble(assistant, "", { markdown: false, plain: true });
      } else {
        assistant.hidden = false;
        fillAssistantBubble(
          assistant,
          (i >= 0 && cards[i].stream_status) || "等待服务器响应…",
          { markdown: false, plain: true }
        );
      }
    }
    scheduleDrawWires();
    return;
  }
  renderFeed();
}

function ensureCardActivitySlot(cardId: string): {
  cardEl: Element;
  messages: HTMLElement;
  assistant: HTMLElement | null;
} | null {
  const cardEl = document.querySelector(
    `.notes-card[data-card-id="${CSS.escape(cardId)}"]`
  );
  if (!cardEl) return null;
  const messages = cardEl.querySelector(".notes-card-messages") as HTMLElement | null;
  const assistant = cardEl.querySelector(
    ".notes-card-assistant"
  ) as HTMLElement | null;
  if (!messages) return null;
  return { cardEl, messages, assistant };
}

function syncCardActivityDom(
  cardId: string,
  activity: McpStreamActivity | null | undefined,
  statusText: string,
  hasAssistantText: boolean,
  opts?: { completed?: boolean }
) {
  const slot = ensureCardActivitySlot(cardId);
  if (!slot) return false;
  const { messages, assistant } = slot;
  let actEl = messages.querySelector(".notes-card-activity") as HTMLElement | null;
  if (hasMcpActivity(activity)) {
    const completed = Boolean(opts?.completed);
    const next = buildMcpActivityEl(
      activity as McpStreamActivity,
      statusText || (completed ? "已完成" : "进行中…"),
      {
        completed,
        openState: snapshotActivityOpenState(actEl),
      }
    );
    if (actEl) actEl.replaceWith(next);
    else {
      const assistantWrap = messages.querySelector(".notes-card-assistant-wrap");
      if (assistantWrap) messages.insertBefore(next, assistantWrap);
      else messages.appendChild(next);
    }
    if (assistant && !hasAssistantText) {
      assistant.hidden = true;
      assistant.classList.add("is-placeholder", "is-activity-await");
      fillAssistantBubble(assistant, "", { markdown: false, plain: true });
    }
  } else if (actEl) {
    actEl.remove();
  }
  return true;
}

function patchStreamStatus(
  cardId: string,
  statusText: string,
  activity?: McpStreamActivity | null
) {
  const i = cards.findIndex((c) => c.id === cardId);
  if (i >= 0) {
    cards[i] = {
      ...cards[i],
      stream_status: statusText,
      status: "streaming",
      stream_activity:
        activity !== undefined ? activity : cards[i].stream_activity,
    };
  }
  const hasText = Boolean(i >= 0 && cards[i].assistant_text);
  const act =
    i >= 0 ? cards[i].stream_activity : activity ?? null;
  if (syncCardActivityDom(cardId, act, statusText, hasText)) {
    if (!hasText && !hasMcpActivity(act)) {
      const assistant = document.querySelector(
        `.notes-card[data-card-id="${CSS.escape(cardId)}"] .notes-card-assistant`
      ) as HTMLElement | null;
      if (assistant) {
        assistant.hidden = false;
        assistant.classList.add("is-placeholder");
        assistant.classList.remove("is-error", "is-activity-await");
        fillAssistantBubble(assistant, statusText, { markdown: false, plain: true });
      }
    } else if (hasText) {
      const assistant = document.querySelector(
        `.notes-card[data-card-id="${CSS.escape(cardId)}"] .notes-card-assistant`
      ) as HTMLElement | null;
      if (assistant) {
        assistant.hidden = false;
        assistant.classList.remove("is-placeholder", "is-activity-await");
      }
    }
    scheduleDrawWires();
    return;
  }
  if (i >= 0) renderFeed();
}

async function refreshCards() {
  cards = await listCards(120);
  renderFeed();
  if (notesMode === "timeline") setNotesTimelineCards(cards, { refit: false });
  void hydrateActivitiesFromLogs();
}

/** 旧卡无 mcp_activity 落盘时，从协议日志补工具轨迹。 */
async function hydrateActivitiesFromLogs() {
  const need = cards.filter(
    (c) =>
      !hasMcpActivity(c.stream_activity) &&
      ((c.mcp_tools?.length ?? 0) > 0 || (c.mcp_servers?.length ?? 0) > 0)
  );
  if (!need.length) return;
  let changed = false;
  await Promise.all(
    need.map(async (c) => {
      try {
        const raw = await readProtocolLog(c.id, c.created_at);
        const act = activityFromProtocolLog(raw);
        if (!hasMcpActivity(act)) return;
        const i = cards.findIndex((x) => x.id === c.id);
        if (i < 0 || hasMcpActivity(cards[i].stream_activity)) return;
        cards[i] = { ...cards[i], stream_activity: act };
        changed = true;
      } catch {
        /* ignore */
      }
    })
  );
  if (changed) renderFeed();
}

async function refreshResearch(opts?: { refit?: boolean }) {
  try {
    researchItems = await invoke<ResearchMeta[]>("notes_research_list");
  } catch {
    researchItems = [];
  }
  if (notesMode === "timeline") {
    setNotesTimelineResearch(researchItems, { refit: opts?.refit !== false });
  }
}

function hideResearchDetail() {
  hideFloat($("notes-research-detail"));
}

function showResearchDetail(meta: ResearchMeta) {
  const el = $("notes-research-detail");
  if (!el) {
    window.alert(
      `${meta.title}\n格式：${meta.format}\n收入：${formatTs(meta.collected_at)}\n动机：${meta.motive || "（无）"}`
    );
    return;
  }
  el.innerHTML = `
    <h3>${escapeHtml(meta.title || meta.id)}</h3>
    <p class="notes-research-meta">格式：${escapeHtml(meta.format || "—")}
收入：${escapeHtml(formatTs(meta.collected_at))}
动机：${escapeHtml(meta.motive || "（无）")}
文件：${escapeHtml(meta.orig_filename || "—")}</p>
    <div class="notes-research-actions">
      <button type="button" class="notes-btn" data-act="open">打开原文件</button>
      <button type="button" class="notes-btn" data-act="close">关闭</button>
    </div>`;
  el.querySelector('[data-act="close"]')?.addEventListener("click", () => {
    hideResearchDetail();
  });
  el.querySelector('[data-act="open"]')?.addEventListener("click", () => {
    void (async () => {
      try {
        const path = await invoke<string>("notes_research_open", { id: meta.id });
        await openPath(path);
      } catch (e) {
        window.alert(`打开失败：${String(e)}`);
      }
    })();
  });
  const canvas = $("notes-timeline-canvas");
  const anchor = canvas?.getBoundingClientRect() ?? {
    left: 24,
    right: 320,
    top: 80,
    bottom: 200,
    width: 296,
    height: 120,
    x: 24,
    y: 80,
    toJSON() {
      return {};
    },
  };
  revealFloat(el);
  placeFloatInViewport(el, anchor as DOMRect, "above", 360);
}

async function openResearchById(id: string) {
  try {
    const meta = await invoke<ResearchMeta>("notes_research_get", { id });
    showResearchDetail(meta);
  } catch (e) {
    window.alert(`资料不存在：${String(e)}`);
  }
}

async function ingestResearchFile() {
  const selected = await open({
    multiple: false,
    title: "收入研究资料",
  });
  if (!selected || Array.isArray(selected)) return;
  const motive =
    window.prompt("收入动机（为何收这份资料）", "") ?? "";
  try {
    await invoke<ResearchMeta>("notes_research_ingest", {
      sourcePath: selected,
      title: null,
      motive,
    });
    await refreshResearch({ refit: true });
  } catch (e) {
    window.alert(`收入失败：${String(e)}`);
  }
}

/** 当前抽屉里的协议日志原文（切换人话/原文/信封时复用，不重读盘）。 */
let protocolLogRaw = "";
/** data 抽屉视图：协议日志（原文/人话）或输入信封。 */
let logDrawerView: LogDrawerView = "log";
/** 当前 data 抽屉对应卡片（用于 MCP 标注）。 */
let logDrawerCardId: string | null = null;

function mcpUsageFromProtocolLog(raw: string): {
  servers: string[];
  tools: string[];
} {
  const tools: string[] = [];
  const servers: string[] = [];
  const seenT = new Set<string>();
  const seenS = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const row = JSON.parse(t) as {
        event?: { kind?: string; name?: string; server?: string };
      };
      if (row.event?.kind !== "tool_call") continue;
      const name = (row.event.name || "").trim();
      if (!name || seenT.has(name)) continue;
      seenT.add(name);
      tools.push(name);
      const sid =
        (row.event.server || "").trim() || mcpServerIdForTool(name) || "";
      if (sid && !seenS.has(sid)) {
        seenS.add(sid);
        servers.push(sid);
      }
    } catch {
      /* skip bad line */
    }
  }
  return { servers, tools };
}

function paintLogDrawerMcp(card: NotesCardSummary | null, logRaw: string) {
  const el = $("notes-log-mcp");
  if (!el) return;
  let servers = card?.mcp_servers?.filter(Boolean) ?? [];
  let tools = card?.mcp_tools?.filter(Boolean) ?? [];
  if (!servers.length && !tools.length) {
    const fromLog = mcpUsageFromProtocolLog(logRaw);
    servers = fromLog.servers;
    tools = fromLog.tools;
  }
  if (!servers.length && !tools.length) {
    el.classList.add("is-empty");
    el.textContent = "MCP：未使用";
    return;
  }
  el.classList.remove("is-empty");
  const serverPart = servers.length
    ? servers.map((id) => mcpServerLabel(id)).join(" · ")
    : "（未知服务）";
  const toolPart = tools.length ? tools.join(", ") : "—";
  el.innerHTML = `<strong>MCP</strong>：${escapeHtml(serverPart)}<br/><span>工具：${escapeHtml(toolPart)}</span>`;
}

function paintProtocolLogBody() {
  const pre = $("notes-log-body");
  const envEl = $("notes-log-envelopes");
  const titleEl = document.querySelector(
    "#notes-log-drawer .notes-log-head-title strong"
  ) as HTMLElement | null;
  if (!pre) return;

  const envelopeOn = logDrawerView === "envelope";
  applyEnvelopeButton(envelopeOn);
  applyProtocolLogPlainButton();

  if (titleEl) {
    const titleKey = envelopeOn ? "notes.log.envelopeTitle" : "notes.log.title";
    titleEl.setAttribute("data-i18n", titleKey);
    titleEl.textContent = shellT(titleKey);
  }

  const card =
    (logDrawerCardId && cards.find((c) => c.id === logDrawerCardId)) || null;
  paintLogDrawerMcp(card, protocolLogRaw);

  if (envelopeOn) {
    pre.classList.add("hidden");
    if (envEl) {
      envEl.classList.remove("hidden");
      envEl.innerHTML = renderEnvelopesHtml(protocolLogRaw);
    }
    return;
  }

  if (envEl) {
    envEl.classList.add("hidden");
    envEl.innerHTML = "";
  }
  pre.classList.remove("hidden");
  const plain = isProtocolLogPlainMode();
  pre.classList.toggle("is-plain", plain);
  pre.textContent = renderProtocolLogText(protocolLogRaw);
}

async function openLogDrawer(cardId: string, createdAt: number) {
  const drawer = $("notes-log-drawer");
  const pre = $("notes-log-body");
  if (!drawer || !pre) return;
  logDrawerView = "log";
  logDrawerCardId = cardId;
  try {
    protocolLogRaw = await readProtocolLog(cardId, createdAt);
  } catch (e) {
    protocolLogRaw = String(e);
  }
  paintProtocolLogBody();
  drawer.classList.remove("hidden");
  drawer.setAttribute("aria-hidden", "false");
}

function closeLogDrawer() {
  const drawer = $("notes-log-drawer");
  drawer?.classList.add("hidden");
  drawer?.setAttribute("aria-hidden", "true");
  logDrawerView = "log";
  logDrawerCardId = null;
  applyEnvelopeButton(false);
}

function closeRunPopover() {
  closeModelSheet();
}

function syncRunPrefUi(opts?: { skipForwarder?: boolean }) {
  if (!opts?.skipForwarder) notifyForwarderRunPrefsChanged();
}

function positionModelPopover() {
  const pop = $("notes-model-popover");
  const btn = $("notes-model-btn");
  if (!pop || !btn) return;
  placeFloatInViewport(
    pop,
    btn.getBoundingClientRect(),
    "above",
    MODEL_POPOVER_WIDTH
  );
  const pane = $("notes-model-detail-pane");
  if (pane && !pane.classList.contains("hidden")) positionModelDetailPane();
}

function closeModelSheet() {
  closeModelEditor();
  const pop = $("notes-model-popover");
  if (!pop || pop.classList.contains("hidden")) {
    $("notes-model-btn")?.setAttribute("aria-expanded", "false");
    return;
  }
  hideModelDetailPane();
  modelPopoverOpen = false;
  $("notes-model-btn")?.setAttribute("aria-expanded", "false");
  hideFloat(pop);
  setPickerStatus("");
  const search = $("notes-model-search") as HTMLInputElement | null;
  if (search) search.value = "";
  modelSearchQuery = "";
  if (modelPopoverOutsideHandler) {
    document.removeEventListener("mousedown", modelPopoverOutsideHandler);
    modelPopoverOutsideHandler = null;
  }
}

function positionModelDetailPane() {
  const pane = $("notes-model-detail-pane");
  const pop = $("notes-model-popover");
  if (!pane || pane.classList.contains("hidden") || !pop) return;

  // 挂到 body，避免 composer / overflow 祖先裁切 fixed 浮层
  if (pane.parentElement !== document.body) {
    document.body.appendChild(pane);
  }

  const margin = FLOAT_MARGIN;
  const gap = FLOAT_GAP;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const maxHeight = Math.max(160, vh - margin * 2);

  pane.style.position = "fixed";
  pane.style.zIndex = "60";
  pane.style.width = `${MODEL_DETAIL_WIDTH}px`;
  pane.style.maxWidth = `${Math.max(160, vw - margin * 2)}px`;
  pane.style.maxHeight = `${maxHeight}px`;
  pane.style.overflow = "auto";
  pane.style.bottom = "auto";
  pane.style.right = "auto";

  const popRect = pop.getBoundingClientRect();
  const anchorRect = detailAnchorEl?.getBoundingClientRect() ?? popRect;
  // 先压 max-height 再量，避免未 clamp 的自然高度把 top 算到窗外
  const paneRect = pane.getBoundingClientRect();
  const paneWidth = Math.min(
    paneRect.width > 0 ? paneRect.width : MODEL_DETAIL_WIDTH,
    vw - margin * 2
  );
  const paneHeight = Math.min(
    paneRect.height > 0 ? paneRect.height : maxHeight,
    maxHeight
  );

  const leftOfList = popRect.left - gap - paneWidth;
  const rightOfList = popRect.right + gap;
  const fitsLeft = leftOfList >= margin;
  const fitsRight = rightOfList + paneWidth <= vw - margin;

  let left: number;
  if (fitsLeft) {
    left = leftOfList;
  } else if (fitsRight) {
    left = rightOfList;
  } else {
    const leftSpace = popRect.left - gap - margin;
    const rightSpace = vw - margin - popRect.right - gap;
    if (leftSpace >= rightSpace) {
      left = Math.max(margin, popRect.left - gap - paneWidth);
    } else {
      left = Math.min(vw - margin - paneWidth, popRect.right + gap);
    }
  }

  left = Math.max(margin, Math.min(left, vw - margin - paneWidth));
  let top = anchorRect.top;
  if (top + paneHeight > vh - margin) {
    top = vh - margin - paneHeight;
  }
  if (top < margin) top = margin;
  // 仍超高则贴顶，靠 overflow:auto 滚完
  if (top + paneHeight > vh - margin) {
    top = margin;
  }

  pane.style.left = `${Math.round(left)}px`;
  pane.style.top = `${Math.round(top)}px`;
  pane.style.transformOrigin =
    left + paneWidth / 2 < popRect.left + popRect.width / 2
      ? "right center"
      : "left center";
}

async function ensurePricing(): Promise<PricingFile> {
  if (!pricingCache) {
    try {
      pricingCache = await getPricing();
    } catch {
      pricingCache = { v: 2, models: {} };
    }
    syncContextUsageRing();
  }
  return pricingCache;
}

function applyPricingCache(p: PricingFile) {
  pricingCache = p;
  syncContextUsageRing();
}

function hideModelDetailPane() {
  if (detailHoverTimer) {
    window.clearTimeout(detailHoverTimer);
    detailHoverTimer = null;
  }
  if (detailHideTimer) {
    window.clearTimeout(detailHideTimer);
    detailHideTimer = null;
  }
  detailAnchorEl = null;
  hideFloat($("notes-model-detail-pane"));
}

function showModelDetailPane(
  m: NotesModelRef,
  provider: NotesProvider,
  anchorEl?: HTMLElement
) {
  if (detailHideTimer) {
    window.clearTimeout(detailHideTimer);
    detailHideTimer = null;
  }
  detailAnchorEl = anchorEl ?? null;
  void ensurePricing().then((pricing) => {
    const pane = $("notes-model-detail-pane");
    if (!pane) return;
    pane.innerHTML = buildModelDetailHtml(m, provider, pricing);
    const wasHidden = pane.classList.contains("hidden");
    pane.classList.remove("hidden");
    positionModelDetailPane();
    requestAnimationFrame(() => {
      positionModelDetailPane();
      requestAnimationFrame(() => positionModelDetailPane());
    });
    if (wasHidden) revealFloat(pane);
    else pane.classList.add("is-open");
  });
}

function scheduleHideModelDetail() {
  if (detailHideTimer) window.clearTimeout(detailHideTimer);
  detailHideTimer = window.setTimeout(() => hideModelDetailPane(), 160);
}

function openModelPopoverAnimated() {
  const pop = $("notes-model-popover");
  if (!pop) return;
  const wasHidden = pop.classList.contains("hidden");
  pop.classList.remove("hidden");
  pop.setAttribute("aria-hidden", "false");
  positionModelPopover();
  if (wasHidden) revealFloat(pop);
  else pop.classList.add("is-open");
  modelPopoverOpen = true;
  $("notes-model-btn")?.setAttribute("aria-expanded", "true");
  if (!modelPopoverOutsideHandler) {
    modelPopoverOutsideHandler = (e: MouseEvent) => {
      const popEl = $("notes-model-popover");
      const detailEl = $("notes-model-detail-pane");
      const editorEl = $("notes-model-editor");
      const btn = $("notes-model-btn");
      const t = e.target as Node | null;
      if (!popEl || !t) return;
      if (
        popEl.contains(t) ||
        detailEl?.contains(t) ||
        editorEl?.contains(t) ||
        btn?.contains(t)
      ) {
        return;
      }
      closeModelSheet();
    };
    document.addEventListener("mousedown", modelPopoverOutsideHandler);
  }
}

function providersNeedRefresh(pf: ProvidersFile, maxAgeMs = MODELS_STALE_MS): boolean {
  const now = Date.now();
  return pf.providers.some((p) => {
    if (!p.api_key.trim()) return false;
    if (!p.models_synced_at) return true;
    return now - p.models_synced_at > maxAgeMs;
  });
}

function buildNoneModelBtn(): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "notes-model-item notes-model-none";
  if (currentModelKey === NONE_MODEL_KEY) btn.classList.add("active");
  btn.innerHTML = `<span class="notes-model-name">NONE</span><span class="notes-model-sub">仅保存用户话</span>`;
  btn.addEventListener("click", () => {
    currentModelKey = NONE_MODEL_KEY;
    updateModelBtn(lastModels);
    closeModelSheet();
  });
  return btn;
}

async function openModelSheet(
  models: NotesModelRef[],
  providers: ProvidersFile,
  opts?: { animate?: boolean }
) {
  const sheet = $("notes-model-popover");
  const list = $("notes-model-list");
  if (!sheet || !list) return;
  pickerModels = models;
  pickerProviders = providers;
  list.innerHTML = "";
  list.appendChild(buildNoneModelBtn());
  hideModelDetailPane();
  void ensurePricing();

  const listed = visiblePickerModels(models, providers);
  const q = modelSearchQuery.trim().toLowerCase();
  const noneVisible = !q || "none".includes(q);
  const visible = q
    ? listed.filter(
        (m) =>
          m.model_id.toLowerCase().includes(q) ||
          m.label.toLowerCase().includes(q) ||
          m.provider_label.toLowerCase().includes(q)
      )
    : listed;

  if (!listed.length) {
    if (!noneVisible) {
      list.innerHTML = `<p class="notes-sheet-empty">没有匹配「${escapeHtml(modelSearchQuery)}」的模型</p>`;
    } else {
      const hints: string[] = [];
      for (const p of providers.providers) {
        if (p.models_sync_error) {
          hints.push(`${p.label}：${p.models_sync_error}`);
        }
      }
      const hint = document.createElement("p");
      hint.className = "notes-sheet-empty";
      const hiddenHint =
        models.length && !listed.length
          ? "已发现的模型都关着，点「编辑模型」打开。"
          : "";
      hint.innerHTML = `尚无 LLM 模型时可使用 NONE 仅落盘用户话。${
        hiddenHint ? `<br>${escapeHtml(hiddenHint)}` : ""
      }${hints.length ? `<br>${escapeHtml(hints.join("；"))}` : ""}`;
      list.appendChild(hint);
    }
    if (opts?.animate !== false) openModelPopoverAnimated();
    else {
      sheet.classList.remove("hidden");
      sheet.classList.add("is-open");
      positionModelPopover();
    }
    return;
  }

  if (!visible.length && !noneVisible) {
    list.innerHTML = "";
    list.appendChild(buildNoneModelBtn());
    const empty = document.createElement("p");
    empty.className = "notes-sheet-empty";
    empty.textContent = `没有匹配「${modelSearchQuery}」的模型`;
    list.appendChild(empty);
    if (opts?.animate !== false) openModelPopoverAnimated();
    else {
      sheet.classList.remove("hidden");
      sheet.classList.add("is-open");
      positionModelPopover();
    }
    return;
  }

  const byProvider = new Map<string, NotesModelRef[]>();
  for (const m of visible) {
    const arr = byProvider.get(m.provider_id) || [];
    arr.push(m);
    byProvider.set(m.provider_id, arr);
  }
  for (const p of providers.providers) {
    const group = byProvider.get(p.id);
    if (!group?.length) {
      if (p.api_key.trim() && p.models_sync_error) {
        const err = document.createElement("p");
        err.className = "notes-sheet-empty";
        err.textContent = `${p.label}：${p.models_sync_error}`;
        list.appendChild(err);
      }
      continue;
    }
    list.appendChild(buildProviderGroup(p, group, providers));
  }

  if (opts?.animate !== false) openModelPopoverAnimated();
  else {
    sheet.classList.remove("hidden");
    sheet.classList.add("is-open");
    positionModelPopover();
  }
}

function buildProviderGroup(
  p: NotesProvider,
  models: NotesModelRef[],
  providers: ProvidersFile
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "notes-provider-group";
  const collapsed = providerCollapsed.has(p.id);
  const vendor = providerVendor(p);
  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "notes-provider-toggle";
  toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  // 组头：自定义「显示名称」+ 厂商图标（不是 vendor 英文名）
  toggle.innerHTML = `
    <span class="notes-provider-logo">${vendorLogoHtml(vendor, 18)}</span>
    <span class="notes-provider-name">${escapeHtml(p.label || p.id)}</span>
    <span class="notes-provider-chevron${collapsed ? "" : " is-open"}" aria-hidden="true">›</span>
  `;
  const body = document.createElement("div");
  body.className = `notes-provider-models${collapsed ? " is-collapsed" : ""}`;
  const inner = document.createElement("div");
  inner.className = "notes-provider-models-inner";
  const pinned = providers.pinned_model_keys || [];
  const sorted = [...models].sort((a, b) => {
    const ka = modelKey(a.provider_id, a.model_id);
    const kb = modelKey(b.provider_id, b.model_id);
    const ia = pinned.indexOf(ka);
    const ib = pinned.indexOf(kb);
    const aPin = ia >= 0;
    const bPin = ib >= 0;
    if (aPin && bPin) return ia - ib;
    if (aPin !== bPin) return aPin ? -1 : 1;
    return a.model_id.localeCompare(b.model_id);
  });
  for (const m of sorted) {
    inner.appendChild(modelOptionBtn(m, providers, p));
  }
  body.appendChild(inner);
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    const nowCollapsed = !body.classList.contains("is-collapsed");
    body.classList.toggle("is-collapsed", nowCollapsed);
    toggle
      .querySelector(".notes-provider-chevron")
      ?.classList.toggle("is-open", !nowCollapsed);
    toggle.setAttribute("aria-expanded", nowCollapsed ? "false" : "true");
    if (nowCollapsed) providerCollapsed.add(p.id);
    else providerCollapsed.delete(p.id);
  });
  wrap.appendChild(toggle);
  wrap.appendChild(body);
  return wrap;
}

async function togglePinnedModel(key: string, providers: ProvidersFile) {
  const cur = [...(providers.pinned_model_keys || [])];
  const i = cur.indexOf(key);
  if (i >= 0) cur.splice(i, 1);
  else cur.unshift(key);
  try {
    const next = await setPinnedModelKeys(cur);
    pickerProviders = next;
    if (modelPopoverOpen) {
      openModelSheet(pickerModels, next, { animate: false });
    }
  } catch (e) {
    console.error(e);
  }
}

function modelOptionBtn(
  m: NotesModelRef,
  providers: ProvidersFile,
  provider: NotesProvider
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "notes-model-item";
  const key = modelKey(m.provider_id, m.model_id);
  if (key === currentModelKey) btn.classList.add("active");
  const pinned = (providers.pinned_model_keys || []).includes(key);
  btn.innerHTML = `
    <span class="notes-model-name">${escapeHtml(m.model_id)}</span>
    <span class="notes-model-pin${pinned ? " is-pinned" : ""}" role="button" tabindex="0" aria-label="${
      pinned ? "取消置顶" : "置顶"
    }" title="${pinned ? "取消置顶" : "置顶到本组顶部"}" aria-pressed="${
      pinned ? "true" : "false"
    }">★</span>
  `;
  const pinBtn = btn.querySelector(".notes-model-pin") as HTMLElement | null;
  const onPin = (e: Event) => {
    e.stopPropagation();
    e.preventDefault();
    void togglePinnedModel(key, providers);
  };
  pinBtn?.addEventListener("click", onPin);
  pinBtn?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") onPin(e);
  });
  btn.addEventListener("mouseenter", () => {
    if (detailHoverTimer) window.clearTimeout(detailHoverTimer);
    detailHoverTimer = window.setTimeout(() => {
      showModelDetailPane(m, provider, btn);
    }, 100);
  });
  btn.addEventListener("mouseleave", () => {
    if (detailHoverTimer) {
      window.clearTimeout(detailHoverTimer);
      detailHoverTimer = null;
    }
    scheduleHideModelDetail();
  });
  btn.addEventListener("focus", () => showModelDetailPane(m, provider, btn));
  btn.addEventListener("blur", () => scheduleHideModelDetail());
  btn.addEventListener("click", () => {
    currentModelKey = key;
    void listModels().then((models) => updateModelBtn(models));
    closeModelSheet();
  });
  return btn;
}

function setPickerStatus(text: string, kind: "ok" | "error" | "busy" | "" = "") {
  const el = $("notes-model-picker-status");
  if (!el) return;
  const msg = text.trim();
  if (!msg) {
    el.hidden = true;
    el.textContent = "";
    el.classList.remove("is-error", "is-ok");
    return;
  }
  el.hidden = false;
  el.textContent = msg;
  el.classList.toggle("is-error", kind === "error");
  el.classList.toggle("is-ok", kind === "ok");
}

async function applyPickerProviders(pf: ProvidersFile) {
  pickerProviders = pf;
  const models = await listModels();
  pickerModels = models;
  if (modelPopoverOpen) openModelSheet(models, pf, { animate: false });
  syncModelEditor(pf);
  updateModelBtn(models);
}

async function refreshPickerModels(force: boolean) {
  if (progressBusy) return;
  try {
    progressBusy = true;
    setPickerStatus(force ? "正在刷新模型…" : "刷新过期模型…", "busy");
    showCompactTask(force ? "刷新模型列表…" : "刷新过期模型…");
    const updated = force
      ? await refreshModelsNow()
      : await refreshModelsIfStale(MODELS_STALE_MS);
    await applyPickerProviders(updated);
    const fails = realModelSyncFails(updated);
    if (fails.length) {
      const msg = fails.map((p) => `${p.label}：${p.models_sync_error}`).join("；");
      setPickerStatus(msg, "error");
      showCompactTask(msg, 100, "error");
      scheduleHideCompact(4500);
    } else {
      setPickerStatus("模型已更新", "ok");
      showCompactTask("模型已更新", 100, "ok");
      scheduleHideCompact(900);
    }
  } catch (e) {
    console.error(e);
    const msg = e instanceof Error ? e.message : String(e);
    setPickerStatus(`刷新失败：${msg}`, "error");
    showCompactTask("刷新失败，显示缓存列表", 100, "error");
    scheduleHideCompact(2800);
  } finally {
    progressBusy = false;
  }
}

async function showModelPicker() {
  const pf = await getProviders();
  const models = await listModels();
  const needRefresh = providersNeedRefresh(pf);
  openModelSheet(models, pf, { animate: !modelPopoverOpen });
  if (!needRefresh || progressBusy) return;
  await refreshPickerModels(false);
}

function syncComposerHint() {
  const input = $("notes-input") as HTMLTextAreaElement | null;
  if (!input) return;
  const n = pendingHistoryIds(cards).length;
  input.placeholder =
    n > 0
      ? `提问（将带上 ${n} 张卡片的历史）…`
      : "单轮提问（接线后带上历史）…";
  syncContextUsageRing();
}

async function handleSend() {
  const input = $("notes-input") as HTMLTextAreaElement | null;
  const sendBtn = $("notes-send") as HTMLButtonElement | null;
  if (!input || !sendBtn) return;
  const text = input.value.trim();
  const imagePaths = getComposerImagePaths();
  if (!text && !imagePaths.length) return;
  if (!currentModelKey) {
    currentModelKey = NONE_MODEL_KEY;
  }
  sendBtn.disabled = true;
  input.disabled = true;
  try {
    const history = historyMessages(cards);
    const historyIds = pendingHistoryIds(cards);
    const wireContext = wireContextForSend(history);

    if (currentModelKey === NONE_MODEL_KEY) {
      showCompactTask("保存用户话…");
      const start = await saveUserOnlyCard(text, imagePaths);
      if (composerIsLive()) rewireComposerAfterSend(start.card_id);
      else if (historyIds.length) {
        const sorted = [...cards]
          .filter((c) => historyIds.includes(c.id))
          .sort((a, b) => a.created_at - b.created_at);
        const tip = sorted.length ? sorted[sorted.length - 1] : undefined;
        if (tip) linkNodes(tip.id, start.card_id);
      }
      cards.push({
        id: start.card_id,
        created_at: start.created_at,
        status: "done",
        model_label: "NONE",
        user_text: text,
        assistant_text: "",
        user_images: imagePaths.length ? [...imagePaths] : undefined,
        timings_delta_s: {},
        usage: {},
        cost: { priced: false, currency: "USD", total_usd: 0, input_usd: 0, output_usd: 0, cache_read_usd: 0, cache_write_usd: 0, thinking_usd: 0 },
        from_wire_context: wireContext?.from_wire_context ?? false,
        wire_preset_id: wireContext?.wire_preset_id ?? null,
        wire_preset_name: wireContext?.wire_preset_name ?? null,
        wire_preset_note: wireContext?.wire_preset_note ?? null,
        wire_preset_created_at: wireContext?.wire_preset_created_at ?? null,
      });
      renderFeed();
      input.value = "";
      clearComposerImages();
      autoGrowNotesInput();
      showCompactTask("已保存", 100, "ok");
      scheduleHideCompact(700);
      return;
    }

    ensureSidecarInBackground();
    progressBusy = true;
    showCompactTask("发送请求…");
    const turnOpts = buildTurnOptsFromPrefs(runPrefs, currentModelRef());
    const start = await sendTurn(
      text,
      currentModelKey,
      {
        ...turnOpts,
        wire_context: wireContext,
        mcp: mcpTurnOpts(),
        image_paths: imagePaths,
      },
      history
    );
    if (composerIsLive()) rewireComposerAfterSend(start.card_id);
    else if (historyIds.length) {
      const sorted = [...cards]
        .filter((c) => historyIds.includes(c.id))
        .sort((a, b) => a.created_at - b.created_at);
      const tip = sorted.length ? sorted[sorted.length - 1] : undefined;
      if (tip) linkNodes(tip.id, start.card_id);
    }
    cards.push({
      id: start.card_id,
      created_at: start.created_at,
      status: "streaming",
      model_label: modelLabelForKey(currentModelKey, await listModels()),
      user_text: text,
      assistant_text: "",
      stream_status: "等待服务器响应…",
      user_images: imagePaths.length ? [...imagePaths] : undefined,
      timings_delta_s: {},
      usage: {},
      cost: { priced: false, currency: "USD", total_usd: 0, input_usd: 0, output_usd: 0, cache_read_usd: 0, cache_write_usd: 0, thinking_usd: 0 },
      from_wire_context: wireContext?.from_wire_context ?? false,
      wire_preset_id: wireContext?.wire_preset_id ?? null,
      wire_preset_name: wireContext?.wire_preset_name ?? null,
      wire_preset_note: wireContext?.wire_preset_note ?? null,
      wire_preset_created_at: wireContext?.wire_preset_created_at ?? null,
    });
    renderFeed();
    input.value = "";
    clearComposerImages();
    autoGrowNotesInput();
  } catch (e) {
    console.error(e);
  } finally {
    sendBtn.disabled = false;
    input.disabled = false;
    input.focus();
  }
}

export function initNotes() {
  initCardRail();
  initNotesWires({ onHint: syncComposerHint });
  initWirePresetSidebar({
    onApplied: () => {
      syncComposerHint();
      applyHideNonGreenFilter();
    },
  });
  initClueBoard();
  initNotesTimeline({
    onOpenCard: (cardId, createdAt) => focusCardInStream(cardId, createdAt),
    onOpenResearch: (id) => {
      void openResearchById(id);
    },
  });
  initNotesTimelineFunnel();
  $("notes-timeline-ingest")?.addEventListener("click", () => {
    void ingestResearchFile();
  });
  initNotesAistudioImport({
    onImported: () => {
      void refreshCards();
    },
  });
  initNotesModeToggle();
  initContextUsageUi();
  bindMcpContextUsageSink((labels) => {
    setContextUsageExtras({
      mcp: labels.map((label, i) =>
        makePlaceholderChild(`mcp-${i}`, "mcp", label, 0, 0)
      ),
    });
  });
  initMcpPrefsUi();
  bindForwarderPrefsAccess({
    getRunPrefs: () => runPrefs,
    setRunPrefs: (p) => {
      runPrefs = p;
      syncRunPrefUi({ skipForwarder: true });
    },
    getModel: () => currentModelRef(),
  });
  initForwarderPrefsUi();
  initComposerAttachUi();
  initLlmSettingsHost({
    isBusy: () => progressBusy,
    setBusy: (v) => {
      progressBusy = v;
    },
    showTask: showCompactTask,
    hideTask: scheduleHideCompact,
    onProvidersSaved: (pf) => {
      void applyPickerProviders(pf);
      currentModelKey = pf.default_model_key || currentModelKey;
    },
  });
  initModelEditor({
    onAddProvider: () => {
      closeModelSheet();
      window.dispatchEvent(new CustomEvent("omnitrace-open-llm-settings"));
    },
  });
  onProvidersChanged((pf) => {
    pickerProviders = pf;
    if (modelPopoverOpen) {
      void listModels().then((models) => {
        pickerModels = models;
        openModelSheet(models, pf, { animate: false });
      });
    }
    syncModelEditor(pf);
  });
  syncRunPrefUi();
  $("notes-send")?.addEventListener("click", () => void handleSend());
  $("notes-input")?.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    if (e.shiftKey || e.ctrlKey || e.metaKey) return;
    e.preventDefault();
    void handleSend();
  });
  $("notes-input")?.addEventListener("input", () => autoGrowNotesInput());
  $("notes-model-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (modelPopoverOpen) closeModelSheet();
    else void showModelPicker();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (isModelEditorOpen()) {
      closeModelEditor();
      return;
    }
    if (!modelPopoverOpen) return;
    closeModelSheet();
  });
  $("notes-model-search")?.addEventListener("input", (e) => {
    modelSearchQuery = (e.target as HTMLInputElement).value;
    if (pickerProviders) openModelSheet(pickerModels, pickerProviders, { animate: false });
  });
  $("notes-model-search")?.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter") e.preventDefault();
  });
  $("notes-add-api")?.addEventListener("click", () => {
    closeModelSheet();
    window.dispatchEvent(new CustomEvent("omnitrace-open-llm-settings"));
  });
  $("notes-refresh-models")?.addEventListener("click", (e) => {
    e.stopPropagation();
    void refreshPickerModels(true);
  });
  $("notes-edit-models")?.addEventListener("click", (e) => {
    e.stopPropagation();
    const pf = pickerProviders;
    if (!pf) {
      void getProviders().then((fresh) => openModelEditor(fresh));
      return;
    }
    if (isModelEditorOpen()) closeModelEditor();
    else openModelEditor(pf);
  });
  $("notes-log-close")?.addEventListener("click", closeLogDrawer);
  initProtocolLogPlainToggle(() => {
    if (logDrawerView === "envelope") {
      logDrawerView = "log";
    }
    if (!$("notes-log-drawer")?.classList.contains("hidden")) {
      paintProtocolLogBody();
    } else {
      applyProtocolLogPlainButton();
    }
  });
  initEnvelopeToggle((on) => {
    logDrawerView = on ? "envelope" : "log";
    if (!$("notes-log-drawer")?.classList.contains("hidden")) {
      paintProtocolLogBody();
    } else {
      applyEnvelopeButton(on);
    }
  });
  window.addEventListener("resize", () => {
    scheduleDrawWires();
    scheduleDrawClueWires();
    if (notesMode === "timeline") resizeNotesTimeline();
    if (modelPopoverOpen) {
      positionModelPopover();
      const pane = $("notes-model-detail-pane");
      if (pane && !pane.classList.contains("hidden")) positionModelDetailPane();
    }
  });
  $("notes-model-list")?.addEventListener(
    "scroll",
    () => {
      const pane = $("notes-model-detail-pane");
      if (pane && !pane.classList.contains("hidden")) positionModelDetailPane();
    },
    { passive: true }
  );
  const detailPane = $("notes-model-detail-pane");
  detailPane?.addEventListener("mouseenter", () => {
    if (detailHideTimer) {
      window.clearTimeout(detailHideTimer);
      detailHideTimer = null;
    }
  });
  detailPane?.addEventListener("mouseleave", () => scheduleHideModelDetail());

  void bindProgressHandler((ev) => handleNotesProgress(ev));

  void bindStreamHandlers({
    onChunk: (p) => patchStreamingCard(p.card_id, p.assistant_text),
    onStatus: (p) =>
      patchStreamStatus(p.card_id, p.status_text, p.activity ?? null),
    onDone: (p) => {
      const card = p.card as NotesCardSummary | undefined;
      if (card) {
        const prev = cards.find((c) => c.id === card.id)?.stream_activity;
        upsertCard({
          ...card,
          stream_status: null,
          stream_activity:
            card.stream_activity ?? finalizeActivityForDone(prev) ?? null,
        });
      } else void refreshCards();
    },
    onError: (p) => {
      const friendly = humanizeLlmError(p.error || "");
      const i = cards.findIndex((c) => c.id === p.card_id);
      if (i >= 0) {
        cards[i] = {
          ...cards[i],
          status: "error",
          error: friendly || p.error,
          stream_status: null,
          stream_activity: finalizeActivityForDone(cards[i].stream_activity),
          assistant_text: cards[i].assistant_text || "",
        };
        renderFeed();
      }
      if (isQuotaLlmError(p.error || "") || isQuotaLlmError(friendly)) {
        showCompactTask(
          "额度用尽：可换 gemini-2.5-flash / 关 Google Search；详情见卡片 data。额度页 aistudio.google.com",
          100,
          "error"
        );
        scheduleHideCompact(12000);
      } else {
        showCompactTask(`请求失败：${friendly || p.error}`, 100, "error");
        scheduleHideCompact(8000);
      }
      void refreshCards();
    },
  });

  autoGrowNotesInput();
  window.addEventListener("omnitrace-lang", () => refreshCardRelativeTimes());
  window.addEventListener(COST_DISPLAY_EVENT, () => {
    for (const c of cards) {
      const btn = document.querySelector(
        `.notes-card-cost-badge[data-card-id="${CSS.escape(c.id)}"]`
      );
      if (btn) btn.textContent = costBadgeLabel(c);
    }
    if (
      costPopoverEl &&
      costPopoverCard &&
      !costPopoverEl.classList.contains("hidden")
    ) {
      const badge = document.querySelector(
        `.notes-card-cost-badge[data-card-id="${CSS.escape(costPopoverCard.id)}"]`
      ) as HTMLElement | null;
      if (badge) fillCostPopover(costPopoverCard, badge);
    }
    syncContextUsageRing();
  });
  ensureCardRelativeTimeTicker();
  applyNotesMode(notesMode, { skipPersist: true });
}

export async function mountLlmSettings() {
  const pf = await getProviders();
  await paintLlmSettings(pf);
}

function updateSidecarStatusEl(message: string) {
  const statusEl = $("notes-sidecar-status");
  if (statusEl) statusEl.textContent = message;
}

/** 后台拉起 sidecar，不阻塞笔记页首屏；发送时 Rust 仍会 ensure。 */
function ensureSidecarInBackground(): void {
  if (sidecarWarm?.listening) {
    updateSidecarStatusEl(sidecarWarm.message);
    return;
  }
  if (sidecarEnsurePromise) return;

  sidecarEnsurePromise = (async () => {
    try {
      const quick = await sidecarStatus();
      if (quick.listening) {
        sidecarWarm = quick;
        updateSidecarStatusEl(quick.message);
        return quick;
      }

      updateSidecarStatusEl("连接中…");
      showCompactTask("连接 sidecar");

      const st = await ensureSidecar();
      sidecarWarm = st;
      updateSidecarStatusEl(st.message);
      if (st.listening) {
        showCompactTask("sidecar 已就绪", 100, "ok");
        scheduleHideCompact(500);
      } else {
        showCompactTask(st.message || "连接失败", 100, "error");
        scheduleHideCompact(4500);
      }
      return st;
    } catch (e) {
      const msg = String(e);
      updateSidecarStatusEl(msg);
      showCompactTask(msg, 100, "error");
      scheduleHideCompact(4500);
      throw e;
    } finally {
      sidecarEnsurePromise = null;
    }
  })();
}

export async function enterNotesPage() {
  const statusEl = $("notes-sidecar-status");
  if (sidecarWarm?.listening) {
    updateSidecarStatusEl(sidecarWarm.message);
  } else if (statusEl) {
    statusEl.textContent = "未连接";
  }

  void refreshPricingIfStale(MODELS_STALE_MS)
    .then((p) => applyPricingCache(p))
    .catch(() => undefined);

  try {
    const [pf, models, freshCards] = await Promise.all([
      getProviders(),
      listModels(),
      listCards(120),
    ]);
    cards = freshCards;
    currentModelKey =
      currentModelKey || pf.default_model_key || NONE_MODEL_KEY;
    updateModelBtn(models);
    renderFeed();
    void hydrateActivitiesFromLogs();
    await loadContextGraph();
    refreshWirePresetList();
    syncComposerHint();
  } catch (e) {
    if (statusEl) statusEl.textContent = String(e);
  }
}

export function leaveNotesPage() {
  closeRunPopover();
  closeCostPopover();
  closeCtxPopover();
  closeMcpPopoverOnLeave();
  closeForwarderPopoverOnLeave();
  closeComposerAttachPopover();
  closeLogDrawer();
  cancelWireDrag();
  if (!isClueAppsHosted()) leaveClueBoardMode();
  leaveNotesTimeline();
}

/** 摘窗前把线索板 debounce 写盘冲干净。 */
export async function flushNotesPersist(): Promise<void> {
  await flushClueBoardSave();
}
