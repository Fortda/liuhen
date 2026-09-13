/**
 * 笔记 data 抽屉「输入信封」视图：
 * 从协议日志解析 kind=request 的请求体（对面服务器收到的信封），
 * 用双色区分脚本可识别结构 vs LLM 实际消费正文。
 */

import { uiLang } from "./notes_cards";

export type LogDrawerView = "log" | "envelope";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

type LogEvent = {
  kind?: string;
  url?: string;
  body?: Json;
};

type LogRow = {
  ts?: number;
  utc?: string;
  card_id?: string;
  event?: LogEvent;
};

export type EnvelopeLabels = {
  btn: string;
  title: string;
  aria: string;
  drawerTitle: string;
  legendScript: string;
  legendLlm: string;
  empty: string;
  noEnvelopes: string;
  incomplete: string;
  envelopeN: (n: number) => string;
  messages: string;
  meta: string;
};

export function envelopeLabels(lang: "zh" | "en" = uiLang()): EnvelopeLabels {
  if (lang === "en") {
    return {
      btn: "Envelopes",
      title: "Show request envelopes the server received",
      aria: "Input envelopes view",
      drawerTitle: "Input envelopes",
      legendScript: "Script-readable structure (keys, roles, flags, ids)",
      legendLlm: "LLM-consumed text (message / tool content)",
      empty: "(empty log)",
      noEnvelopes: "No request envelopes in this log.",
      incomplete: "This entry has no complete request envelope.",
      envelopeN: (n) => `Envelope #${n}`,
      messages: "messages",
      meta: "request fields",
    };
  }
  return {
    btn: "输入信封",
    title: "查看对面服务器收到的请求信封",
    aria: "输入信封视图",
    drawerTitle: "输入信封",
    legendScript: "脚本可识别结构（字段名、role、开关、id 等）",
    legendLlm: "LLM 实际收到的正文（消息 / 工具文本）",
    empty: "（空日志）",
    noEnvelopes: "本条协议日志里没有 request 信封。",
    incomplete: "本条无完整信封。",
    envelopeN: (n) => `信封 #${n}`,
    messages: "messages",
    meta: "请求字段",
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatClock(ts: number | null | undefined, utc?: string): string {
  if (typeof ts === "number" && Number.isFinite(ts)) {
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  if (utc) {
    const m = utc.match(/T(\d{2}:\d{2}:\d{2})/);
    if (m) return m[1];
  }
  return "--:--:--";
}

function asObj(v: Json | undefined): Record<string, Json> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, Json>;
  }
  return null;
}

function span(cls: string, text: string): string {
  return `<span class="${cls}">${escapeHtml(text)}</span>`;
}

/** 脚本侧结构：键名、标点、非正文标量。 */
function script(text: string): string {
  return span("env-script", text);
}

/** LLM 消费的自然语言 / 工具正文。 */
function llm(text: string): string {
  return span("env-llm", text);
}

function indent(n: number): string {
  return "  ".repeat(n);
}

/** content 字段值（string 或 parts 数组）按 LLM 正文着色。 */
function renderContentValue(v: Json, depth: number): string {
  if (typeof v === "string") {
    return llm(JSON.stringify(v));
  }
  if (Array.isArray(v)) {
    const lines: string[] = [script("[")];
    v.forEach((item, i) => {
      const comma = i < v.length - 1 ? script(",") : "";
      const o = asObj(item);
      if (o && (typeof o.text === "string" || typeof o.content === "string")) {
        lines.push(`${indent(depth + 1)}${script("{")}`);
        const keys = Object.keys(o);
        keys.forEach((k, ki) => {
          const c = ki < keys.length - 1 ? script(",") : "";
          const val =
            k === "text" || k === "content"
              ? llm(JSON.stringify(o[k]))
              : renderScriptValue(o[k], depth + 2);
          lines.push(
            `${indent(depth + 2)}${script(JSON.stringify(k))}${script(": ")}${val}${c}`
          );
        });
        lines.push(`${indent(depth + 1)}${script("}")}${comma}`);
      } else if (typeof item === "string") {
        lines.push(`${indent(depth + 1)}${llm(JSON.stringify(item))}${comma}`);
      } else {
        lines.push(
          `${indent(depth + 1)}${renderScriptValue(item, depth + 1)}${comma}`
        );
      }
    });
    lines.push(`${indent(depth)}${script("]")}`);
    return lines.join("\n");
  }
  return renderScriptValue(v, depth);
}

/** 非 LLM 正文：整棵当脚本结构渲染（嵌套对象/数组递归）。 */
function renderScriptValue(v: Json, depth: number): string {
  if (v === null) return script("null");
  if (typeof v === "boolean" || typeof v === "number") {
    return script(String(v));
  }
  if (typeof v === "string") {
    return script(JSON.stringify(v));
  }
  if (Array.isArray(v)) {
    if (!v.length) return script("[]");
    const lines = [script("[")];
    v.forEach((item, i) => {
      const comma = i < v.length - 1 ? script(",") : "";
      lines.push(
        `${indent(depth + 1)}${renderScriptValue(item, depth + 1)}${comma}`
      );
    });
    lines.push(`${indent(depth)}${script("]")}`);
    return lines.join("\n");
  }
  const o = v as Record<string, Json>;
  const keys = Object.keys(o);
  if (!keys.length) return script("{}");
  const lines = [script("{")];
  keys.forEach((k, i) => {
    const comma = i < keys.length - 1 ? script(",") : "";
    lines.push(
      `${indent(depth + 1)}${script(JSON.stringify(k))}${script(": ")}${renderScriptValue(
        o[k],
        depth + 1
      )}${comma}`
    );
  });
  lines.push(`${indent(depth)}${script("}")}`);
  return lines.join("\n");
}

/**
 * 渲染单条 message：role / name / tool_call_id 等为脚本色；
 * content / tool_calls[].function.arguments 里给人读的正文为 LLM 色。
 */
function renderMessage(msg: Json, depth: number): string {
  const o = asObj(msg);
  if (!o) return renderScriptValue(msg, depth);
  const keys = Object.keys(o);
  const lines = [script("{")];
  keys.forEach((k, i) => {
    const comma = i < keys.length - 1 ? script(",") : "";
    let valHtml: string;
    if (k === "content") {
      valHtml = renderContentValue(o[k], depth + 1);
    } else if (k === "tool_calls" && Array.isArray(o[k])) {
      valHtml = renderToolCalls(o[k] as Json[], depth + 1);
    } else {
      valHtml = renderScriptValue(o[k], depth + 1);
    }
    lines.push(
      `${indent(depth + 1)}${script(JSON.stringify(k))}${script(": ")}${valHtml}${comma}`
    );
  });
  lines.push(`${indent(depth)}${script("}")}`);
  return lines.join("\n");
}

function renderToolCalls(calls: Json[], depth: number): string {
  if (!calls.length) return script("[]");
  const lines = [script("[")];
  calls.forEach((call, i) => {
    const comma = i < calls.length - 1 ? script(",") : "";
    const o = asObj(call);
    if (!o) {
      lines.push(
        `${indent(depth + 1)}${renderScriptValue(call, depth + 1)}${comma}`
      );
      return;
    }
    lines.push(`${indent(depth + 1)}${script("{")}`);
    const keys = Object.keys(o);
    keys.forEach((k, ki) => {
      const c = ki < keys.length - 1 ? script(",") : "";
      if (k === "function" && asObj(o[k])) {
        const fn = asObj(o[k])!;
        const fnKeys = Object.keys(fn);
        const fnLines = [script("{")];
        fnKeys.forEach((fk, fi) => {
          const fc = fi < fnKeys.length - 1 ? script(",") : "";
          const fv =
            fk === "arguments" && typeof fn[fk] === "string"
              ? llm(JSON.stringify(fn[fk]))
              : renderScriptValue(fn[fk], depth + 3);
          fnLines.push(
            `${indent(depth + 3)}${script(JSON.stringify(fk))}${script(": ")}${fv}${fc}`
          );
        });
        fnLines.push(`${indent(depth + 2)}${script("}")}`);
        lines.push(
          `${indent(depth + 2)}${script(JSON.stringify(k))}${script(": ")}${fnLines.join(
            "\n"
          )}${c}`
        );
      } else {
        lines.push(
          `${indent(depth + 2)}${script(JSON.stringify(k))}${script(": ")}${renderScriptValue(
            o[k],
            depth + 2
          )}${c}`
        );
      }
    });
    lines.push(`${indent(depth + 1)}${script("}")}${comma}`);
  });
  lines.push(`${indent(depth)}${script("]")}`);
  return lines.join("\n");
}

function renderBody(body: Record<string, Json>, L: EnvelopeLabels): string {
  const keys = Object.keys(body);
  const metaKeys = keys.filter((k) => k !== "messages");
  const parts: string[] = [];

  if (metaKeys.length) {
    parts.push(`<div class="env-section-label">${escapeHtml(L.meta)}</div>`);
    const metaLines = [script("{")];
    metaKeys.forEach((k, i) => {
      const comma = i < metaKeys.length - 1 ? script(",") : "";
      metaLines.push(
        `${indent(1)}${script(JSON.stringify(k))}${script(": ")}${renderScriptValue(
          body[k],
          1
        )}${comma}`
      );
    });
    metaLines.push(script("}"));
    parts.push(`<pre class="env-json">${metaLines.join("\n")}</pre>`);
  }

  const msgs = body.messages;
  if (Array.isArray(msgs)) {
    parts.push(
      `<div class="env-section-label">${escapeHtml(L.messages)} (${msgs.length})</div>`
    );
    const msgLines = [script("[")];
    msgs.forEach((m, i) => {
      const comma = i < msgs.length - 1 ? script(",") : "";
      msgLines.push(`${indent(1)}${renderMessage(m, 1)}${comma}`);
    });
    msgLines.push(script("]"));
    parts.push(`<pre class="env-json">${msgLines.join("\n")}</pre>`);
  }

  return parts.join("");
}

export type ParsedEnvelope = {
  ts?: number;
  utc?: string;
  url?: string;
  body: Record<string, Json> | null;
  incomplete: boolean;
};

/** 从协议 JSONL 抽出所有 request 信封（按日志顺序 = 时间序）。 */
export function extractRequestEnvelopes(raw: string): ParsedEnvelope[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  const out: ParsedEnvelope[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let row: LogRow;
    try {
      row = JSON.parse(t) as LogRow;
    } catch {
      continue;
    }
    const ev = row.event;
    if (!ev || ev.kind !== "request") continue;
    const body = asObj(ev.body);
    const incomplete = !body || !Array.isArray(body.messages);
    out.push({
      ts: row.ts,
      utc: row.utc,
      url: ev.url,
      body,
      incomplete,
    });
  }
  return out;
}

/** 渲染信封视图 HTML（安全转义）。 */
export function renderEnvelopesHtml(
  raw: string,
  lang: "zh" | "en" = uiLang()
): string {
  const L = envelopeLabels(lang);
  const trimmed = raw.trim();
  if (!trimmed) {
    return `<p class="env-empty">${escapeHtml(L.empty)}</p>`;
  }

  const list = extractRequestEnvelopes(raw);
  if (!list.length) {
    return `<p class="env-empty">${escapeHtml(L.noEnvelopes)}</p>`;
  }

  const legend = `<div class="env-legend" role="note">
  <span class="env-legend-item"><i class="env-swatch env-swatch-script" aria-hidden="true"></i>${escapeHtml(
    L.legendScript
  )}</span>
  <span class="env-legend-item"><i class="env-swatch env-swatch-llm" aria-hidden="true"></i>${escapeHtml(
    L.legendLlm
  )}</span>
</div>`;

  const cards = list
    .map((env, idx) => {
      const clock = formatClock(env.ts, env.utc);
      const headBits = [
        escapeHtml(L.envelopeN(idx + 1)),
        escapeHtml(clock),
      ];
      if (env.url) headBits.push(escapeHtml(env.url));
      if (env.incomplete || !env.body) {
        return `<article class="env-card">
  <header class="env-card-head">${headBits.join(" · ")}</header>
  <p class="env-incomplete">${escapeHtml(L.incomplete)}</p>
</article>`;
      }
      return `<article class="env-card">
  <header class="env-card-head">${headBits.join(" · ")}</header>
  <div class="env-card-body">${renderBody(env.body, L)}</div>
</article>`;
    })
    .join("");

  return `${legend}${cards}`;
}

export function applyEnvelopeButton(active: boolean): void {
  const btn = document.getElementById("btn-protocol-log-envelope");
  if (!btn) return;
  btn.classList.toggle("is-active", active);
  btn.setAttribute("aria-pressed", active ? "true" : "false");
}

export function initEnvelopeToggle(onToggle: (on: boolean) => void): void {
  const btn = document.getElementById("btn-protocol-log-envelope");
  if (!btn) return;

  const toggle = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    const next = !btn.classList.contains("is-active");
    applyEnvelopeButton(next);
    onToggle(next);
  };

  btn.addEventListener("click", toggle);
  btn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") toggle(e);
  });
}
