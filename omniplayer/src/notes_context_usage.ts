/**
 * Composer「Context Usage」：右下角圆环 + 分段面板。
 * Token 只信卡片 usage；无 usage 时降级为空骨架（不本地分词）。
 * Skills / MCP 经 extras 注入；现默认为空数组，悬停骨架仍通。
 */
import {
  costBreakdownView,
  formatCompactCount,
  formatUsdAmount,
  uiLang,
} from "./notes_cards";
import type { PriceRates, PricingFile } from "./notes_llm";
import type { NotesCardSummary, NotesModelRef } from "./notes_types";
import { pendingHistoryIds } from "./notes_wires";

export type ContextUsageKind =
  | "system"
  | "tools"
  | "rules"
  | "skills"
  | "mcp"
  | "subagent"
  | "conversation"
  | "custom";

export type ContextUsageItem = {
  id: string;
  kind: ContextUsageKind;
  label: string;
  tokens: number;
  costUsd: number | null;
  color: string;
  children?: ContextUsageItem[];
  detail?: string;
};

export type ContextUsageCostSlice = {
  inputTotalUsd: number;
  cacheHitUsd: number;
  cacheMissUsd: number;
  cacheWriteUsd: number;
  outputUsd: number;
  totalUsd: number;
  priced: boolean;
  currency: string;
};

export type ContextUsageSnapshot = {
  usedTokens: number;
  maxTokens: number | null;
  percentFull: number;
  segments: ContextUsageItem[];
  costs: ContextUsageCostSlice;
  source: "card_usage" | "empty";
  modelLabel?: string;
};

export type ContextUsageExtras = {
  skills?: ContextUsageItem[];
  mcp?: ContextUsageItem[];
  systemTokens?: number;
  toolsTokens?: number;
  rulesTokens?: number;
  subagentTokens?: number;
  systemCostUsd?: number | null;
  toolsCostUsd?: number | null;
  rulesCostUsd?: number | null;
  subagentCostUsd?: number | null;
};

const COLORS: Record<ContextUsageKind, string> = {
  system: "#7c6cf0",
  tools: "#3d9a9a",
  rules: "#c9a227",
  skills: "#d4638a",
  mcp: "#e08a3a",
  subagent: "#4a90d9",
  conversation: "#3d9a6a",
  custom: "#8b8f98",
};

function labels() {
  if (uiLang() === "en") {
    return {
      title: "Context Usage",
      full: "Full",
      tokens: "Tokens",
      of: "of",
      unknownMax: "—",
      noUsage: "No usage yet — send a turn to fill from API usage.",
      system: "System prompt",
      tools: "Tool definitions",
      rules: "Rules",
      skills: "Skills",
      mcp: "MCP & dynamic tools",
      subagent: "Subagent",
      conversation: "Conversation",
      costInput: "Input total",
      costHit: "Input cache hit",
      costMiss: "Input (uncached)",
      costWrite: "Input cache write",
      costOut: "Output",
      costTotal: "Total",
      unpriced: "Unpriced",
      hoverTokens: "tokens",
      emptyChild: "None yet",
      close: "Close",
      costTitle: "Cost",
    };
  }
  return {
    title: "上下文用量",
    full: "已满",
    tokens: "Tokens",
    of: "/",
    unknownMax: "—",
    noUsage: "尚无用量 — 发送一轮后按 API usage 填充。",
    system: "系统提示",
    tools: "工具定义",
    rules: "Rules",
    skills: "Skills",
    mcp: "MCP 与动态工具",
    subagent: "Subagent",
    conversation: "对话",
    costInput: "输入合计",
    costHit: "输入缓存命中",
    costMiss: "输入未命中",
    costWrite: "输入缓存写入",
    costOut: "输出",
    costTotal: "总计",
    unpriced: "暂无牌价",
    hoverTokens: "tokens",
    emptyChild: "暂无",
    close: "关闭",
    costTitle: "费用",
  };
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sumTokens(items: ContextUsageItem[] | undefined): number {
  if (!items?.length) return 0;
  return items.reduce((a, x) => a + Math.max(0, x.tokens || 0), 0);
}

function sumCostUsd(items: ContextUsageItem[] | undefined): number | null {
  if (!items?.length) return null;
  let any = false;
  let s = 0;
  for (const x of items) {
    if (x.costUsd != null && Number.isFinite(x.costUsd)) {
      any = true;
      s += x.costUsd;
    }
  }
  return any ? s : null;
}

function makeItem(
  id: string,
  kind: ContextUsageKind,
  label: string,
  tokens: number,
  costUsd: number | null,
  children?: ContextUsageItem[],
  detail?: string
): ContextUsageItem {
  return {
    id,
    kind,
    label,
    tokens: Math.max(0, Math.round(tokens)),
    costUsd,
    color: COLORS[kind],
    children,
    detail,
  };
}

export function lookupModelRates(
  pricing: PricingFile | null | undefined,
  model: NotesModelRef | undefined,
  priceKey?: string | null
): PriceRates | null {
  if (!pricing) return null;
  const keys: string[] = [];
  if (priceKey) keys.push(priceKey);
  if (model) {
    keys.push(
      model.litellm_model,
      model.model_id,
      model.provider_id + "/" + model.model_id
    );
  }
  for (const k of keys) {
    if (!k) continue;
    const hit = pricing.overrides?.[k] || pricing.models[k];
    if (hit) return hit;
  }
  if (model) {
    const needle = model.model_id;
    const pool = { ...pricing.models, ...(pricing.overrides || {}) };
    for (const [k, v] of Object.entries(pool)) {
      if (k === needle || k.endsWith("/" + needle)) return v;
    }
  }
  return null;
}

export function pickContextUsageCard(
  cards: NotesCardSummary[]
): NotesCardSummary | null {
  const pending = new Set(pendingHistoryIds(cards));
  const sorted = [...cards].sort((a, b) => b.created_at - a.created_at);
  const hasUsage = (c: NotesCardSummary) => {
    if (c.status === "streaming") return false;
    const u = c.usage;
    return (
      u.input_tokens != null ||
      u.output_tokens != null ||
      u.cache_read_tokens != null
    );
  };
  if (pending.size) {
    const hit = sorted.find((c) => pending.has(c.id) && hasUsage(c));
    if (hit) return hit;
  }
  return sorted.find(hasUsage) ?? null;
}

export function buildContextUsageSnapshot(
  cards: NotesCardSummary[],
  opts: {
    model?: NotesModelRef;
    pricing?: PricingFile | null;
    extras?: ContextUsageExtras;
  } = {}
): ContextUsageSnapshot {
  const L = labels();
  const extras = opts.extras || {};
  const card = pickContextUsageCard(cards);
  const rates = lookupModelRates(
    opts.pricing,
    opts.model,
    card?.cost.price_key
  );
  const maxTokens =
    rates?.max_input_tokens != null && rates.max_input_tokens > 0
      ? rates.max_input_tokens
      : null;

  const skills = extras.skills ?? [];
  const mcp = extras.mcp ?? [];

  let conversationTokens = 0;
  let conversationCost: number | null = null;
  let costs: ContextUsageCostSlice = {
    inputTotalUsd: 0,
    cacheHitUsd: 0,
    cacheMissUsd: 0,
    cacheWriteUsd: 0,
    outputUsd: 0,
    totalUsd: 0,
    priced: false,
    currency: "USD",
  };
  let source: ContextUsageSnapshot["source"] = "empty";
  let modelLabel = opts.model?.label;

  if (card) {
    source = "card_usage";
    modelLabel = card.model_label || modelLabel;
    const v = costBreakdownView(card);
    conversationTokens = v.inputTokens;
    conversationCost = v.priced ? v.inputUsd : null;
    costs = {
      inputTotalUsd: v.inputUsd,
      cacheHitUsd: v.cacheUsd,
      cacheMissUsd: v.missUsd,
      cacheWriteUsd: v.writeUsd,
      outputUsd: v.outputUsd + v.thinkUsd,
      totalUsd: v.totalUsd,
      priced: v.priced,
      currency: v.currency,
    };
  }

  const skillTokens = sumTokens(skills);
  const mcpTokens = sumTokens(mcp);
  const skillCost = sumCostUsd(skills);
  const mcpCost = sumCostUsd(mcp);

  const segments: ContextUsageItem[] = [
    makeItem(
      "system",
      "system",
      L.system,
      extras.systemTokens ?? 0,
      extras.systemCostUsd ?? null
    ),
    makeItem(
      "tools",
      "tools",
      L.tools,
      extras.toolsTokens ?? 0,
      extras.toolsCostUsd ?? null
    ),
    makeItem(
      "rules",
      "rules",
      L.rules,
      extras.rulesTokens ?? 0,
      extras.rulesCostUsd ?? null
    ),
    makeItem(
      "skills",
      "skills",
      L.skills,
      skillTokens,
      skillCost,
      skills.length ? skills : undefined,
      skills.length ? undefined : L.emptyChild
    ),
    makeItem(
      "mcp",
      "mcp",
      L.mcp,
      mcpTokens,
      mcpCost,
      mcp.length ? mcp : undefined,
      mcp.length ? undefined : L.emptyChild
    ),
    makeItem(
      "subagent",
      "subagent",
      L.subagent,
      extras.subagentTokens ?? 0,
      extras.subagentCostUsd ?? null
    ),
    makeItem(
      "conversation",
      "conversation",
      L.conversation,
      conversationTokens,
      conversationCost
    ),
  ];

  const usedTokens = segments.reduce((a, s) => a + s.tokens, 0);
  const percentFull =
    maxTokens && maxTokens > 0
      ? Math.min(100, (usedTokens / maxTokens) * 100)
      : usedTokens > 0
        ? 100
        : 0;

  return {
    usedTokens,
    maxTokens,
    percentFull,
    segments,
    costs,
    source,
    modelLabel,
  };
}

function fmtCost(n: number | null, priced: boolean, currency: string): string {
  const L = labels();
  if (!priced || n == null) return L.unpriced;
  return formatUsdAmount(n, currency);
}

function hoverTitle(
  it: ContextUsageItem,
  priced: boolean,
  currency: string
): string {
  const L = labels();
  const tok = formatCompactCount(it.tokens) + " " + L.hoverTokens;
  const money =
    priced && it.costUsd != null
      ? " · " + formatUsdAmount(it.costUsd, currency)
      : "";
  const d = it.detail ? " — " + it.detail : "";
  return it.label + ": " + tok + money + d;
}

/** 圆环 SVG（stroke-dasharray 进度）。 */
export function contextUsageRingSvg(percent: number, size = 18): string {
  const p = Math.max(0, Math.min(100, percent));
  const r = 6.5;
  const c = 2 * Math.PI * r;
  const dash = (p / 100) * c;
  return (
    '<svg class="notes-ctx-ring-svg" width="' +
    size +
    '" height="' +
    size +
    '" viewBox="0 0 18 18" aria-hidden="true">' +
    '<circle class="notes-ctx-ring-track" cx="9" cy="9" r="' +
    r +
    '" fill="none" stroke-width="2.2"/>' +
    '<circle class="notes-ctx-ring-fill" cx="9" cy="9" r="' +
    r +
    '" fill="none" stroke-width="2.2" stroke-dasharray="' +
    dash.toFixed(2) +
    " " +
    c.toFixed(2) +
    '" stroke-linecap="round" transform="rotate(-90 9 9)"/>' +
    "</svg>"
  );
}

export function buildContextUsagePanelHtml(
  snap: ContextUsageSnapshot
): string {
  const L = labels();
  const priced = snap.costs.priced;
  const cur = snap.costs.currency;
  const usedStr = formatCompactCount(snap.usedTokens);
  const maxStr =
    snap.maxTokens != null
      ? formatCompactCount(snap.maxTokens)
      : L.unknownMax;
  const pctStr =
    snap.maxTokens != null
      ? snap.percentFull.toFixed(snap.percentFull >= 10 ? 0 : 1) +
        "% " +
        L.full
      : snap.usedTokens > 0
        ? "—% " + L.full
        : "0% " + L.full;

  const barTotal = snap.segments.reduce((a, s) => a + s.tokens, 0) || 1;
  const barHtml = snap.segments
    .filter((s) => s.tokens > 0)
    .map((s) => {
      const w = (s.tokens / barTotal) * 100;
      return (
        '<span class="notes-ctx-bar-seg" data-seg-id="' +
        escapeAttr(s.id) +
        '" style="width:' +
        w.toFixed(2) +
        "%;background:" +
        escapeAttr(s.color) +
        '" title="' +
        escapeAttr(hoverTitle(s, priced, cur)) +
        '"></span>'
      );
    })
    .join("");

  const legendRows = (items: ContextUsageItem[], depth = 0): string =>
    items
      .map((s) => {
        const childHtml =
          s.children && s.children.length
            ? '<div class="notes-ctx-legend-children">' +
              legendRows(s.children, depth + 1) +
              "</div>"
            : "";
        const costCell = priced
          ? '<span class="notes-ctx-legend-cost">' +
            escapeAttr(fmtCost(s.costUsd, priced, cur)) +
            "</span>"
          : '<span class="notes-ctx-legend-cost is-muted">' +
            escapeAttr(L.unpriced) +
            "</span>";
        return (
          '<div class="notes-ctx-legend-row" data-seg-id="' +
          escapeAttr(s.id) +
          '" data-depth="' +
          depth +
          '" title="' +
          escapeAttr(hoverTitle(s, priced, cur)) +
          '" tabindex="0">' +
          '<span class="notes-ctx-swatch" style="background:' +
          escapeAttr(s.color) +
          '" aria-hidden="true"></span>' +
          '<span class="notes-ctx-legend-label">' +
          escapeAttr(s.label) +
          "</span>" +
          '<span class="notes-ctx-legend-tokens">' +
          escapeAttr(formatCompactCount(s.tokens)) +
          "</span>" +
          costCell +
          "</div>" +
          childHtml
        );
      })
      .join("");

  const costRows: { label: string; val: string }[] = [
    {
      label: L.costInput,
      val: fmtCost(snap.costs.inputTotalUsd, priced, cur),
    },
    {
      label: L.costMiss,
      val: fmtCost(snap.costs.cacheMissUsd, priced, cur),
    },
    {
      label: L.costHit,
      val: fmtCost(snap.costs.cacheHitUsd, priced, cur),
    },
  ];
  if (snap.costs.cacheWriteUsd > 0) {
    costRows.push({
      label: L.costWrite,
      val: fmtCost(snap.costs.cacheWriteUsd, priced, cur),
    });
  }
  costRows.push(
    {
      label: L.costOut,
      val: fmtCost(snap.costs.outputUsd, priced, cur),
    },
    {
      label: L.costTotal,
      val: fmtCost(snap.costs.totalUsd, priced, cur),
    }
  );

  const costHtml = costRows
    .map(
      (r) =>
        '<div class="notes-ctx-cost-row"><span>' +
        escapeAttr(r.label) +
        '</span><span class="notes-ctx-cost-val">' +
        escapeAttr(r.val) +
        "</span></div>"
    )
    .join("");

  const note =
    snap.source === "empty"
      ? '<p class="notes-ctx-note">' + escapeAttr(L.noUsage) + "</p>"
      : "";

  const modelLine = snap.modelLabel
    ? '<div class="notes-ctx-model" title="' +
      escapeAttr(snap.modelLabel) +
      '">' +
      escapeAttr(snap.modelLabel) +
      "</div>"
    : "";

  return (
    '<div class="notes-ctx-pop-head">' +
    '<div class="notes-ctx-pop-titles">' +
    '<strong class="notes-ctx-pop-title">' +
    escapeAttr(L.title) +
    "</strong>" +
    modelLine +
    "</div>" +
    '<button type="button" class="notes-ctx-pop-close" aria-label="' +
    escapeAttr(L.close) +
    '">×</button>' +
    "</div>" +
    '<div class="notes-ctx-summary">' +
    '<span class="notes-ctx-pct">' +
    escapeAttr(pctStr) +
    "</span>" +
    '<span class="notes-ctx-used">' +
    escapeAttr(usedStr) +
    " " +
    escapeAttr(L.of) +
    " " +
    escapeAttr(maxStr) +
    " " +
    escapeAttr(L.tokens) +
    "</span>" +
    "</div>" +
    '<div class="notes-ctx-bar" aria-hidden="true">' +
    (barHtml || '<span class="notes-ctx-bar-empty"></span>') +
    "</div>" +
    '<div class="notes-ctx-legend">' +
    legendRows(snap.segments) +
    "</div>" +
    note +
    '<div class="notes-ctx-costs">' +
    '<div class="notes-ctx-costs-title">' +
    escapeAttr(L.costTitle) +
    "</div>" +
    costHtml +
    "</div>"
  );
}

/** 供外部注入 MCP/Skill 占位测试。 */
export function makePlaceholderChild(
  id: string,
  kind: "skills" | "mcp" | "custom",
  label: string,
  tokens: number,
  costUsd: number | null = null
): ContextUsageItem {
  const map: Record<"skills" | "mcp" | "custom", ContextUsageKind> = {
    skills: "skills",
    mcp: "mcp",
    custom: "custom",
  };
  return makeItem(id, map[kind], label, tokens, costUsd);
}
