import { invoke } from "@tauri-apps/api/core";
import {
  hideFloat,
  placeFloatAtPoint,
  revealFloat,
} from "./omni_float";
import { shellT } from "./shell_i18n";
import type { NotesCardSummary } from "./notes_types";
import { costFxHint, formatMoneyFromUsd } from "./notes_cost_display";

export async function listCards(limit = 80): Promise<NotesCardSummary[]> {
  return invoke<NotesCardSummary[]>("notes_list_cards", { limit });
}

export async function readProtocolLog(
  cardId: string,
  createdAt: number
): Promise<string> {
  return invoke<string>("notes_read_protocol_log", {
    cardId,
    createdAt,
  });
}

export function formatTs(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** Relative label for card header; uses same instant as `formatTs` (request-send `created_at`). */
export function formatRelativeTs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const diffMs = Math.max(0, Date.now() - ms);
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffMs / 60_000);
  const diffH = Math.floor(diffMs / 3_600_000);
  const diffD = Math.floor(diffMs / 86_400_000);

  if (diffSec < 10) return shellT("notes.card.timeJustNow");
  if (diffSec < 60) return shellT("notes.card.timeSeconds", { n: diffSec });
  if (diffMin < 60) return shellT("notes.card.timeMinutes", { n: diffMin });
  if (diffH < 24) return shellT("notes.card.timeHours", { n: diffH });
  return shellT("notes.card.timeDays", { n: diffD });
}

function isUsableTs(ms: number | null | undefined): ms is number {
  return ms != null && Number.isFinite(ms) && ms > 0;
}

export function formatGroupMetaTime(ms: number | null | undefined): {
  abs: string;
  rel: string;
} {
  if (!isUsableTs(ms)) {
    return { abs: shellT("notes.groupMeta.unknownTime"), rel: "" };
  }
  return { abs: formatTs(ms), rel: formatRelativeTs(ms) };
}

const ARCHIVE_REL_DAY_CUTOFF = 10;

/** Compact list time: `1h前` / `1d前`, then calendar date (same cutoff as the notes right-hand rail). */
export function formatArchiveListWhen(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const diffMs = Math.max(0, Date.now() - ms);
  const diffMin = Math.floor(diffMs / 60_000);
  const diffH = Math.floor(diffMs / 3_600_000);
  const diffD = Math.floor(diffMs / 86_400_000);
  if (diffD < ARCHIVE_REL_DAY_CUTOFF) {
    if (diffMin < 1) return shellT("notes.card.timeJustNow");
    if (diffMin < 60) return shellT("notes.card.timeMinutes", { n: diffMin });
    if (diffH < 24) return shellT("notes.preset.relHours", { n: Math.max(1, diffH) });
    return shellT("notes.preset.relDays", { n: Math.max(1, diffD) });
  }
  const d = new Date(ms);
  const now = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  if (d.getFullYear() === now.getFullYear()) {
    return shellT("notes.preset.dateMD", { m: d.getMonth() + 1, d: d.getDate() });
  }
  return shellT("notes.preset.dateYMD", {
    y: d.getFullYear(),
    m: p(d.getMonth() + 1),
    d: p(d.getDate()),
  });
}

let groupMetaPopEl: HTMLElement | null = null;
let groupMetaOutside: ((e: MouseEvent) => void) | null = null;

export function hideGroupMetaPopover() {
  if (groupMetaOutside) {
    document.removeEventListener("mousedown", groupMetaOutside, true);
    groupMetaOutside = null;
  }
  const el = groupMetaPopEl;
  groupMetaPopEl = null;
  if (!el) return;
  hideFloat(el);
  window.setTimeout(() => el.remove(), 200);
}

/** Small 详情 popover: created / last-modified for a left-list group. */
export function showGroupMetaPopover(opts: {
  clientX: number;
  clientY: number;
  title: string;
  createdAt?: number | null;
  updatedAt?: number | null;
}) {
  hideGroupMetaPopover();
  const el = document.createElement("div");
  el.id = "notes-group-meta-pop";
  el.className = "omni-float notes-wire-origin-pop notes-group-meta-pop hidden";
  el.setAttribute("role", "dialog");
  el.setAttribute("aria-hidden", "true");

  const head = document.createElement("div");
  head.className = "notes-wire-origin-head";
  const strong = document.createElement("strong");
  strong.textContent = opts.title;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "notes-wire-origin-close";
  close.setAttribute("aria-label", shellT("notes.log.close"));
  close.textContent = "×";
  close.addEventListener("click", () => hideGroupMetaPopover());
  head.append(strong, close);

  const body = document.createElement("div");
  body.className = "notes-wire-origin-body";
  const rows: Array<{ label: string; ms: number | null | undefined }> = [
    { label: shellT("notes.groupMeta.created"), ms: opts.createdAt },
    { label: shellT("notes.groupMeta.modified"), ms: opts.updatedAt },
  ];
  for (const row of rows) {
    const wrap = document.createElement("div");
    wrap.className = "notes-wire-origin-row";
    const lab = document.createElement("span");
    lab.className = "notes-wire-origin-label";
    lab.textContent = row.label;
    const val = document.createElement("span");
    val.className = "notes-wire-origin-value";
    const fmt = formatGroupMetaTime(row.ms);
    val.textContent = fmt.abs;
    wrap.append(lab, val);
    if (fmt.rel) {
      const rel = document.createElement("span");
      rel.className = "notes-group-meta-rel";
      rel.textContent = fmt.rel;
      wrap.appendChild(rel);
    }
    body.appendChild(wrap);
  }

  el.append(head, body);
  document.body.appendChild(el);
  revealFloat(el);
  placeFloatAtPoint(el, opts.clientX, opts.clientY);
  requestAnimationFrame(() => placeFloatAtPoint(el, opts.clientX, opts.clientY));
  groupMetaPopEl = el;
  groupMetaOutside = (ev: MouseEvent) => {
    if (ev.target instanceof Node && el.contains(ev.target)) return;
    hideGroupMetaPopover();
  };
  document.addEventListener("mousedown", groupMetaOutside, true);
}

export function formatDelta(s?: number | null): string {
  if (s == null || !Number.isFinite(s)) return "—";
  if (s < 1) return `${Math.round(s * 1000)}ms`;
  return `${s.toFixed(2)}s`;
}

export function formatCost(c: NotesCardSummary["cost"]): string {
  if (!c.priced) return "—";
  return formatMoneyFromUsd(c.total_usd);
}

export function formatUsdAmount(n: number, _currency = "USD"): string {
  if (!Number.isFinite(n)) return "—";
  return formatMoneyFromUsd(n);
}

/** Lobe 风格缩写：83.0k / 1.2M */
export function formatCompactCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n >= 1_000_000) {
    const v = n / 1_000_000;
    return `${v >= 10 ? Math.round(v) : v.toFixed(1)}M`;
  }
  if (n >= 1000) {
    const v = n / 1000;
    return `${v >= 100 ? Math.round(v) : v.toFixed(1)}k`;
  }
  return String(Math.round(n));
}

export type CostBadgeMode = "cost" | "token";

export type CostSegmentKey = "miss" | "cache" | "output";

export type CostBreakdownView = {
  missTokens: number;
  cacheTokens: number;
  outputTokens: number;
  writeTokens: number;
  thinkTokens: number;
  inputTokens: number;
  missUsd: number;
  cacheUsd: number;
  writeUsd: number;
  outputUsd: number;
  thinkUsd: number;
  inputUsd: number;
  totalUsd: number;
  priced: boolean;
  currency: string;
  cacheRate: number | null;
  ttft: number | null;
  tps: number | null;
};

/** 从卡片 usage/cost 拆成展示口径（与 Rust compute_cost 一致）。 */
export function costBreakdownView(c: NotesCardSummary): CostBreakdownView {
  const u = c.usage ?? {};
  const cost = c.cost ?? {
    input_usd: 0,
    output_usd: 0,
    cache_read_usd: 0,
    cache_write_usd: 0,
    thinking_usd: 0,
    total_usd: 0,
    currency: "USD",
    priced: false,
  };
  const inputTokens = u.input_tokens ?? 0;
  const cacheTokens = u.cache_read_tokens ?? 0;
  const writeTokens = u.cache_creation_tokens ?? 0;
  const outputTokens = u.output_tokens ?? 0;
  const thinkTokens = u.thinking_tokens ?? 0;
  // prompt 一般已含 cache；无 cache 字段时 miss = 全部输入
  const missTokens =
    u.input_tokens != null
      ? Math.max(0, inputTokens - cacheTokens - writeTokens)
      : 0;
  const missUsd = cost.input_usd || 0;
  const cacheUsd = cost.cache_read_usd || 0;
  const writeUsd = cost.cache_write_usd || 0;
  const outputUsd = cost.output_usd || 0;
  const thinkUsd = cost.thinking_usd || 0;
  const inputUsd = missUsd + cacheUsd + writeUsd;
  const cacheRate =
    inputTokens > 0 ? Math.min(1, cacheTokens / inputTokens) : null;
  const d = c.timings_delta_s ?? {};
  const ttft = d.to_first_token ?? null;
  const total = d.total ?? d.to_completed ?? null;
  let tps: number | null = null;
  if (outputTokens > 0 && total != null && total > 0) {
    const gen = ttft != null && ttft < total ? total - ttft : total;
    if (gen > 0) tps = outputTokens / gen;
  }
  return {
    missTokens,
    cacheTokens,
    outputTokens,
    writeTokens,
    thinkTokens,
    inputTokens,
    missUsd,
    cacheUsd,
    writeUsd,
    outputUsd,
    thinkUsd,
    inputUsd,
    totalUsd: cost.total_usd || 0,
    priced: Boolean(cost.priced),
    currency: cost.currency || "USD",
    cacheRate,
    ttft,
    tps,
  };
}

export function cardHasCostBadge(c: NotesCardSummary): boolean {
  if (c.status === "streaming") return false;
  const u = c.usage ?? {};
  const cost = c.cost;
  return (
    Boolean(cost?.priced) ||
    u.input_tokens != null ||
    u.output_tokens != null ||
    u.cache_read_tokens != null
  );
}

export function costBadgeLabel(c: NotesCardSummary): string {
  const v = costBreakdownView(c);
  if (v.priced) return `🪙 ${formatUsdAmount(v.totalUsd, v.currency)}`;
  const tokens = v.inputTokens + v.outputTokens;
  if (tokens > 0) return `🪙 ${formatCompactCount(tokens)}`;
  return "🪙 —";
}

type CostPopLabels = {
  cost: string;
  token: string;
  miss: string;
  cache: string;
  write: string;
  output: string;
  think: string;
  inputTotal: string;
  cacheRate: string;
  total: string;
  rates: string;
  ttft: string;
  tps: string;
  unpriced: string;
  close: string;
  fx: string;
};

function costPopLabels(): CostPopLabels {
  if (uiLang() === "en") {
    return {
      cost: "Cost",
      token: "Tokens",
      miss: "Input (uncached)",
      cache: "Input cache hit",
      write: "Input cache write",
      output: "Output",
      think: "Reasoning",
      inputTotal: "Input total",
      cacheRate: "Cache rate",
      total: "Total",
      rates: "List price / 1M",
      ttft: "TTFT",
      tps: "TPS",
      unpriced: "Unpriced",
      close: "Close",
      fx: "Display FX",
    };
  }
  return {
    cost: "费用",
    token: "Token",
    miss: "未缓存输入",
    cache: "输入缓存命中",
    write: "输入缓存写入",
    output: "输出",
    think: "思考",
    inputTotal: "输入合计",
    cacheRate: "缓存率",
    total: "总消耗",
    rates: "牌价 / 百万",
    ttft: "TTFT",
    tps: "TPS",
    unpriced: "暂无牌价",
    close: "关闭",
    fx: "显示汇率",
  };
}

export type CostRateHints = {
  input?: number | null;
  output?: number | null;
  cache_read?: number | null;
  currency?: string;
};

export function buildCostPopoverHtml(
  c: NotesCardSummary,
  mode: CostBadgeMode,
  rates?: CostRateHints | null
): string {
  const L = costPopLabels();
  const v = costBreakdownView(c);
  const fmtVal = (usd: number, tokens: number) =>
    mode === "cost"
      ? v.priced
        ? formatUsdAmount(usd)
        : L.unpriced
      : formatCompactCount(tokens);

  const segMiss = mode === "cost" ? v.missUsd : v.missTokens;
  const segCache = mode === "cost" ? v.cacheUsd : v.cacheTokens;
  const segOut =
    mode === "cost" ? v.outputUsd + v.thinkUsd : v.outputTokens;
  const segSum = segMiss + segCache + segOut;
  const pct = (n: number) => (segSum > 0 ? (n / segSum) * 100 : 0);
  const wMiss = pct(segMiss);
  const wCache = pct(segCache);
  const wOut = pct(segOut);

  const rows: { key: CostSegmentKey | "write" | "think" | "inputTotal"; label: string; val: string; swatch?: string }[] = [
    {
      key: "inputTotal",
      label: L.inputTotal,
      val:
        mode === "cost"
          ? v.priced
            ? formatUsdAmount(v.inputUsd)
            : L.unpriced
          : formatCompactCount(v.inputTokens),
    },
    {
      key: "miss",
      label: L.miss,
      val: fmtVal(v.missUsd, v.missTokens),
      swatch: "miss",
    },
    {
      key: "cache",
      label: L.cache,
      val: fmtVal(v.cacheUsd, v.cacheTokens),
      swatch: "cache",
    },
  ];
  if (v.writeTokens > 0 || v.writeUsd > 0) {
    rows.push({
      key: "write",
      label: L.write,
      val: fmtVal(v.writeUsd, v.writeTokens),
    });
  }
  rows.push({
    key: "output",
    label: L.output,
    val: fmtVal(v.outputUsd, v.outputTokens),
    swatch: "output",
  });
  if (v.thinkTokens > 0 || v.thinkUsd > 0) {
    rows.push({
      key: "think",
      label: L.think,
      val: fmtVal(v.thinkUsd, v.thinkTokens),
    });
  }

  const rowHtml = rows
    .map((r) => {
      const sw = r.swatch
        ? `<span class="notes-cost-swatch is-${r.swatch}" aria-hidden="true"></span>`
        : `<span class="notes-cost-swatch is-empty" aria-hidden="true"></span>`;
      return `<div class="notes-cost-row">${sw}<span class="notes-cost-row-label">${escapeAttr(r.label)}</span><span class="notes-cost-row-val">${escapeAttr(r.val)}</span></div>`;
    })
    .join("");

  const footParts: string[] = [];
  if (v.cacheRate != null) {
    footParts.push(
      `<span>${escapeAttr(L.cacheRate)} ${(v.cacheRate * 100).toFixed(1)}%</span>`
    );
  }
  footParts.push(
    `<span><strong>${escapeAttr(L.total)}</strong> ${
      mode === "cost"
        ? v.priced
          ? escapeAttr(formatUsdAmount(v.totalUsd))
          : escapeAttr(L.unpriced)
        : escapeAttr(
            formatCompactCount(v.inputTokens + v.outputTokens)
          )
    }</span>`
  );
  if (v.ttft != null) {
    footParts.push(`<span>${escapeAttr(L.ttft)} ${escapeAttr(formatDelta(v.ttft))}</span>`);
  }
  if (v.tps != null) {
    footParts.push(`<span>${escapeAttr(L.tps)} ${v.tps.toFixed(1)}</span>`);
  }

  let ratesHtml = "";
  if (rates && (rates.input != null || rates.output != null || rates.cache_read != null)) {
    const bits: string[] = [];
    if (rates.input != null) {
      bits.push(`${L.miss} ${fmtRate(rates.input)}`);
    }
    if (rates.cache_read != null) {
      bits.push(`${L.cache} ${fmtRate(rates.cache_read)}`);
    }
    if (rates.output != null) {
      bits.push(`${L.output} ${fmtRate(rates.output)}`);
    }
    ratesHtml = `<div class="notes-cost-rates"><span class="notes-cost-rates-label">${escapeAttr(L.rates)}</span> ${escapeAttr(bits.join(" · "))}</div>`;
  }
  const fx = costFxHint();
  if (fx) {
    ratesHtml += `<div class="notes-cost-rates"><span class="notes-cost-rates-label">${escapeAttr(L.fx)}</span> ${escapeAttr(fx)}</div>`;
  }

  return `<div class="notes-cost-pop-head">
  <strong class="notes-cost-pop-model" title="${escapeAttr(c.model_label)}">${escapeAttr(c.model_label)}</strong>
  <div class="notes-cost-mode" role="tablist">
    <button type="button" class="notes-cost-mode-btn${mode === "cost" ? " is-active" : ""}" data-mode="cost" role="tab" aria-selected="${mode === "cost"}">${escapeAttr(L.cost)}</button>
    <button type="button" class="notes-cost-mode-btn${mode === "token" ? " is-active" : ""}" data-mode="token" role="tab" aria-selected="${mode === "token"}">${escapeAttr(L.token)}</button>
  </div>
  <button type="button" class="notes-cost-pop-close" aria-label="${escapeAttr(L.close)}">×</button>
</div>
<div class="notes-cost-bar" aria-hidden="true">
  <span class="notes-cost-bar-seg is-miss" style="width:${wMiss.toFixed(2)}%"></span>
  <span class="notes-cost-bar-seg is-cache" style="width:${wCache.toFixed(2)}%"></span>
  <span class="notes-cost-bar-seg is-output" style="width:${wOut.toFixed(2)}%"></span>
</div>
<div class="notes-cost-pop-body">${rowHtml}</div>
<div class="notes-cost-pop-foot">${footParts.join("")}${ratesHtml}</div>`;
}

function fmtRate(per1m: number): string {
  return `${formatMoneyFromUsd(per1m)} / 1M`;
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 随 `<html lang>`：zh* 中文，其余英文。 */
export function uiLang(): "zh" | "en" {
  const raw = (
    document.documentElement.lang ||
    navigator.language ||
    "zh-CN"
  ).toLowerCase();
  return raw.startsWith("zh") ? "zh" : "en";
}

type MetricTips = {
  ttfb: string;
  ttft: string;
  total: string;
  input: string;
  cache: string;
  cacheWrite: string;
  think: string;
  output: string;
  cost: string;
  costNone: string;
  data: string;
  totalLabel: string;
};

function metricTips(): MetricTips {
  if (uiLang() === "en") {
    return {
      ttfb: "Time to first byte",
      ttft: "Time to first token",
      total: "Total latency",
      input: "Input tokens",
      cache: "Cache-read tokens",
      cacheWrite: "Cache-write tokens",
      think: "Reasoning tokens",
      output: "Output tokens",
      cost: "Cost (list price × usage)",
      costNone: "Unpriced (no matching list rate)",
      data: "Protocol log",
      totalLabel: "total",
    };
  }
  return {
    ttfb: "首字节",
    ttft: "首 token",
    total: "总耗时",
    input: "输入 tokens",
    cache: "缓存读取 tokens",
    cacheWrite: "缓存写入 tokens",
    think: "思考 tokens",
    output: "输出 tokens",
    cost: "费用（牌价 × usage）",
    costNone: "暂无牌价",
    data: "协议日志",
    totalLabel: "总",
  };
}

export type MetricPart = { key: string; text: string; tip: string };

export function cardMetricParts(c: NotesCardSummary): MetricPart[] {
  const L = metricTips();
  const d = c.timings_delta_s ?? {};
  const u = c.usage ?? {};
  const parts: MetricPart[] = [
    { key: "ttfb", text: `TTFB ${formatDelta(d.to_first_byte)}`, tip: L.ttfb },
    { key: "ttft", text: `TTFT ${formatDelta(d.to_first_token)}`, tip: L.ttft },
    { key: "total", text: `${L.totalLabel} ${formatDelta(d.total)}`, tip: L.total },
  ];
  if (u.input_tokens != null) {
    parts.push({ key: "in", text: `in ${u.input_tokens}`, tip: L.input });
  }
  if (u.cache_read_tokens != null) {
    parts.push({ key: "cache", text: `cache ${u.cache_read_tokens}`, tip: L.cache });
  }
  if (u.cache_creation_tokens != null) {
    parts.push({
      key: "cachew",
      text: `cwrite ${u.cache_creation_tokens}`,
      tip: L.cacheWrite,
    });
  }
  if (u.thinking_tokens != null) {
    parts.push({ key: "think", text: `think ${u.thinking_tokens}`, tip: L.think });
  }
  if (u.output_tokens != null) {
    parts.push({ key: "out", text: `out ${u.output_tokens}`, tip: L.output });
  }
  // 费用改由右下角角标 + 弹出明细展示，脚注不再重复 total cost
  return parts;
}

export function dataLogTip(): string {
  return metricTips().data;
}

/** 卡片是否因绿线连通上下文生成（显示连线归属图标）。 */
export function cardShowsWireOrigin(c: NotesCardSummary): boolean {
  return Boolean(c.from_wire_context);
}

/** 连线上下文归属角标：三圆点 + 两连线（简化分子结构）。 */
export const WIRE_MOLECULE_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><line x1="5.5" y1="15.5" x2="12" y2="8.5"/><line x1="12" y1="8.5" x2="18.5" y2="15.5"/><circle cx="5.5" cy="15.5" r="2.4" fill="currentColor" stroke="none"/><circle cx="12" cy="8.5" r="2.4" fill="currentColor" stroke="none"/><circle cx="18.5" cy="15.5" r="2.4" fill="currentColor" stroke="none"/></svg>`;

type WireOriginLabels = {
  btnTitle: string;
  popTitle: string;
  name: string;
  note: string;
  created: string;
  noNote: string;
  unsaved: string;
  unsavedHint: string;
  deleted: string;
};

function wireOriginLabels(): WireOriginLabels {
  if (uiLang() === "en") {
    return {
      btnTitle: "Wire context",
      popTitle: "Wire preset",
      name: "Name",
      note: "Note",
      created: "Preset created",
      noNote: "(no note)",
      unsaved: "Unsaved wire session",
      unsavedHint: "Sent while wires were connected; not saved as a preset.",
      deleted: "(preset removed)",
    };
  }
  return {
    btnTitle: "连线上下文",
    popTitle: "连线存档",
    name: "名称",
    note: "备注",
    created: "存档创建",
    noNote: "（无备注）",
    unsaved: "未保存的连线会话",
    unsavedHint: "发送时处于绿线连通上下文，尚未保存为连线存档。",
    deleted: "（存档已删除）",
  };
}

export function wireOriginBtnTitle(c: NotesCardSummary): string {
  const L = wireOriginLabels();
  if (c.wire_preset_name) {
    return uiLang() === "en"
      ? `Wire preset: ${c.wire_preset_name}`
      : `连线存档：${c.wire_preset_name}`;
  }
  return L.btnTitle;
}

export type WireOriginPopover = {
  title: string;
  lines: { label: string; value: string }[];
  hint?: string;
};

export function wireOriginPopoverContent(c: NotesCardSummary): WireOriginPopover {
  const L = wireOriginLabels();
  if (c.wire_preset_id || c.wire_preset_name) {
    const name = c.wire_preset_name?.trim() || L.deleted;
    const note = c.wire_preset_note?.trim() || L.noNote;
    const lines: { label: string; value: string }[] = [
      { label: L.name, value: name },
      { label: L.note, value: note },
    ];
    if (c.wire_preset_created_at) {
      lines.push({
        label: L.created,
        value: formatTs(c.wire_preset_created_at),
      });
    }
    return { title: L.popTitle, lines };
  }
  return {
    title: L.unsaved,
    lines: [],
    hint: L.unsavedHint,
  };
}
