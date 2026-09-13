/**
 * 笔记「协议日志」人话翻译：确定性映射表 + 流式行折叠。
 * 维护：扩展 KIND / SSE 分支即可；不要接在线 LLM。
 */

import { uiLang } from "./notes_cards";

export const PROTOCOL_LOG_PLAIN_STORAGE_KEY = "omnitrace.notes.protocol_log_plain";

export function isProtocolLogPlainMode(): boolean {
  try {
    return localStorage.getItem(PROTOCOL_LOG_PLAIN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setProtocolLogPlainMode(on: boolean): void {
  try {
    localStorage.setItem(PROTOCOL_LOG_PLAIN_STORAGE_KEY, on ? "1" : "0");
  } catch {
    /* private mode */
  }
}

export function applyProtocolLogPlainButton(): void {
  const btn = document.getElementById("btn-protocol-log-plain");
  if (!btn) return;
  const on = isProtocolLogPlainMode();
  btn.classList.toggle("is-active", on);
  btn.setAttribute("aria-pressed", on ? "true" : "false");
}

/** 按钮文案 / title（与统计口径「人话」同手感；文案走壳 i18n 时由 applyShellLang 覆盖 data-i18n）。 */
export function protocolLogPlainLabels(lang: "zh" | "en" = uiLang()): {
  btn: string;
  title: string;
  aria: string;
  drawerTitle: string;
  close: string;
} {
  if (lang === "en") {
    return {
      btn: "Plain",
      title: "Switch to plain-language log",
      aria: "Plain language mode",
      drawerTitle: "Protocol log",
      close: "Close",
    };
  }
  return {
    btn: "人话",
    title: "切换为通俗说明",
    aria: "人话模式",
    drawerTitle: "协议日志",
    close: "关闭",
  };
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

type LogEvent = {
  kind?: string;
  url?: string;
  body?: Json;
  status?: number;
  data?: string;
  raw?: Json;
};

type LogRow = {
  ts?: number;
  utc?: string;
  card_id?: string;
  event?: LogEvent;
};

type ContentBurst = {
  startTs: number | null;
  endTs: number | null;
  chunks: number;
  chars: number;
  preview: string;
};

type Strings = {
  empty: string;
  badLine: (snip: string) => string;
  unknown: (kind: string, snip: string) => string;
  request: (p: {
    host: string;
    model: string;
    msgs: number;
    stream: boolean;
    effort: string | null;
    lastUser: string | null;
  }) => string;
  httpError: (status: number, msg: string) => string;
  usage: (p: {
    prompt: number | null;
    cached: number | null;
    completion: number | null;
    reasoning: number | null;
    total: number | null;
  }) => string;
  streamStart: (model: string | null) => string;
  streamBurst: (p: {
    chunks: number;
    chars: number;
    preview: string;
    range: string;
  }) => string;
  streamEnd: (reason: string) => string;
  sseUsage: (p: {
    prompt: number | null;
    completion: number | null;
    total: number | null;
  }) => string;
  sseOther: (snip: string) => string;
};

const ZH: Strings = {
  empty: "（空日志）",
  badLine: (s) => `无法解析的行：${s}`,
  unknown: (k, s) => `未知事件：${k || "?"} · ${s}`,
  request: ({ host, model, msgs, stream, effort, lastUser }) => {
    const bits = [
      `发出聊天请求`,
      `连到 ${host}`,
      `模型 ${model}`,
      `${msgs} 条消息`,
      stream ? "流式" : "非流式",
    ];
    if (effort) bits.push(`思考强度 ${effort}`);
    let line = bits.join(" · ");
    if (lastUser) line += `\n  最近一句用户：${lastUser}`;
    return line;
  },
  httpError: (status, msg) =>
    `请求失败 · HTTP ${status}${msg ? ` · ${msg}` : ""}`,
  usage: ({ prompt, cached, completion, reasoning, total }) => {
    const bits = ["用量结算"];
    if (prompt != null) {
      bits.push(
        cached != null && cached > 0
          ? `输入 ${prompt}（缓存命中 ${cached}）`
          : `输入 ${prompt}`
      );
    }
    if (completion != null) {
      bits.push(
        reasoning != null && reasoning > 0
          ? `输出 ${completion}（含思考 ${reasoning}）`
          : `输出 ${completion}`
      );
    }
    if (total != null) bits.push(`合计 ${total} tokens`);
    return bits.join(" · ");
  },
  streamStart: (model) =>
    model ? `开始收到回复（流式）· 模型 ${model}` : "开始收到回复（流式）",
  streamBurst: ({ chunks, chars, preview, range }) => {
    const head = range
      ? `流式输出 ${range}`
      : "流式输出";
    return `${head} · ${chunks} 片 · 约 ${chars} 字${
      preview ? `\n  预览：${preview}` : ""
    }`;
  },
  streamEnd: (reason) => `流式结束 · 原因 ${reason}`,
  sseUsage: ({ prompt, completion, total }) => {
    const bits = ["流中附带用量"];
    if (prompt != null) bits.push(`输入 ${prompt}`);
    if (completion != null) bits.push(`输出 ${completion}`);
    if (total != null) bits.push(`合计 ${total}`);
    return bits.join(" · ");
  },
  sseOther: (s) => `流式片段 · ${s}`,
};

const EN: Strings = {
  empty: "(empty log)",
  badLine: (s) => `Unparseable line: ${s}`,
  unknown: (k, s) => `Unknown event: ${k || "?"} · ${s}`,
  request: ({ host, model, msgs, stream, effort, lastUser }) => {
    const bits = [
      "Chat request sent",
      `to ${host}`,
      `model ${model}`,
      `${msgs} messages`,
      stream ? "streaming" : "non-streaming",
    ];
    if (effort) bits.push(`thinking ${effort}`);
    let line = bits.join(" · ");
    if (lastUser) line += `\n  Last user message: ${lastUser}`;
    return line;
  },
  httpError: (status, msg) =>
    `Request failed · HTTP ${status}${msg ? ` · ${msg}` : ""}`,
  usage: ({ prompt, cached, completion, reasoning, total }) => {
    const bits = ["Usage settled"];
    if (prompt != null) {
      bits.push(
        cached != null && cached > 0
          ? `input ${prompt} (cache hit ${cached})`
          : `input ${prompt}`
      );
    }
    if (completion != null) {
      bits.push(
        reasoning != null && reasoning > 0
          ? `output ${completion} (reasoning ${reasoning})`
          : `output ${completion}`
      );
    }
    if (total != null) bits.push(`total ${total} tokens`);
    return bits.join(" · ");
  },
  streamStart: (model) =>
    model
      ? `Reply stream started · model ${model}`
      : "Reply stream started",
  streamBurst: ({ chunks, chars, preview, range }) => {
    const head = range ? `Streamed text ${range}` : "Streamed text";
    return `${head} · ${chunks} chunks · ~${chars} chars${
      preview ? `\n  Preview: ${preview}` : ""
    }`;
  },
  streamEnd: (reason) => `Stream finished · reason ${reason}`,
  sseUsage: ({ prompt, completion, total }) => {
    const bits = ["Usage in stream"];
    if (prompt != null) bits.push(`in ${prompt}`);
    if (completion != null) bits.push(`out ${completion}`);
    if (total != null) bits.push(`total ${total}`);
    return bits.join(" · ");
  },
  sseOther: (s) => `SSE chunk · ${s}`,
};

function strings(lang: "zh" | "en"): Strings {
  return lang === "en" ? EN : ZH;
}

function clip(s: string, max = 72): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
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

function hostFromUrl(url: string | undefined): string {
  if (!url) return "?";
  try {
    const u = new URL(url);
    return u.host || url;
  } catch {
    return clip(url, 40);
  }
}

function asObj(v: Json | undefined): Record<string, Json> | null {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    return v as Record<string, Json>;
  }
  return null;
}

function num(v: Json | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function str(v: Json | undefined): string | null {
  return typeof v === "string" ? v : null;
}

function extractHttpErrorMsg(body: Json | undefined): string {
  if (body == null) return "";
  if (typeof body === "string") {
    try {
      return extractHttpErrorMsg(JSON.parse(body) as Json);
    } catch {
      return clip(body, 160);
    }
  }
  const o = asObj(body);
  if (!o) return clip(JSON.stringify(body), 160);
  const err = asObj(o.error);
  if (err) {
    const msg = err.message;
    if (typeof msg === "string") return clip(msg, 160);
    if (msg && typeof msg === "object") {
      const nested = asObj(msg);
      if (nested && typeof nested.error === "string") {
        return clip(nested.error, 160);
      }
      return clip(JSON.stringify(msg), 160);
    }
  }
  return clip(JSON.stringify(body), 160);
}

function lastUserPreview(body: Json | undefined): string | null {
  const o = asObj(body);
  const msgs = o?.messages;
  if (!Array.isArray(msgs)) return null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = asObj(msgs[i] as Json);
    if (!m) continue;
    if (str(m.role) === "user") {
      const c = str(m.content);
      return c ? clip(c, 96) : null;
    }
  }
  return null;
}

function parseSsePayload(data: string | undefined): Json | null {
  if (!data || data === "[DONE]") return null;
  try {
    return JSON.parse(data) as Json;
  } catch {
    return null;
  }
}

function deltaContent(payload: Json | null): {
  text: string;
  role: string | null;
  finish: string | null;
  model: string | null;
  usage: Record<string, Json> | null;
} {
  const empty = {
    text: "",
    role: null as string | null,
    finish: null as string | null,
    model: null as string | null,
    usage: null as Record<string, Json> | null,
  };
  const o = asObj(payload);
  if (!o) return empty;
  const model = str(o.model);
  const usage = asObj(o.usage);
  const choices = o.choices;
  if (!Array.isArray(choices) || !choices.length) {
    return { ...empty, model, usage };
  }
  const ch0 = asObj(choices[0] as Json);
  if (!ch0) return { ...empty, model, usage };
  const finish = str(ch0.finish_reason);
  const delta = asObj(ch0.delta) || asObj(ch0.message);
  const text = delta ? str(delta.content) || "" : "";
  const role = delta ? str(delta.role) : null;
  return { text, role, finish, model, usage };
}

function withTime(clock: string, body: string): string {
  return `[${clock}] ${body}`;
}

function flushBurst(
  out: string[],
  burst: ContentBurst | null,
  L: Strings
): ContentBurst | null {
  if (!burst || burst.chunks === 0) return null;
  const start = formatClock(burst.startTs);
  const end = formatClock(burst.endTs);
  const range =
    burst.startTs != null &&
    burst.endTs != null &&
    burst.endTs !== burst.startTs
      ? `${start}–${end}`
      : "";
  const clock = formatClock(burst.startTs ?? burst.endTs);
  out.push(
    withTime(
      clock,
      L.streamBurst({
        chunks: burst.chunks,
        chars: burst.chars,
        preview: burst.preview ? clip(burst.preview, 80) : "",
        range,
      })
    )
  );
  return null;
}

/**
 * 把协议 JSONL 批量译成人话。流式 token 行会折叠成一段摘要。
 */
export function humanizeProtocolLog(
  raw: string,
  lang: "zh" | "en" = uiLang()
): string {
  const L = strings(lang);
  const trimmed = raw.trim();
  if (!trimmed) return L.empty;

  const lines = trimmed.split(/\r?\n/);
  const out: string[] = [];
  let burst: ContentBurst | null = null;
  let announcedStream = false;

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;

    let row: LogRow;
    try {
      row = JSON.parse(t) as LogRow;
    } catch {
      burst = flushBurst(out, burst, L);
      out.push(L.badLine(clip(t, 120)));
      continue;
    }

    const ev = row.event || {};
    const kind = ev.kind || "";
    const clock = formatClock(row.ts, row.utc);

    if (kind === "sse_line") {
      const payload = parseSsePayload(ev.data);
      const d = deltaContent(payload);

      if (d.usage && !d.text && !d.finish) {
        burst = flushBurst(out, burst, L);
        out.push(
          withTime(
            clock,
            L.sseUsage({
              prompt: num(d.usage.prompt_tokens),
              completion: num(d.usage.completion_tokens),
              total: num(d.usage.total_tokens),
            })
          )
        );
        continue;
      }

      if (d.finish && !d.text) {
        burst = flushBurst(out, burst, L);
        out.push(withTime(clock, L.streamEnd(d.finish)));
        continue;
      }

      if (d.text) {
        if (!announcedStream) {
          burst = flushBurst(out, burst, L);
          out.push(withTime(clock, L.streamStart(d.model)));
          announcedStream = true;
        }
        if (!burst) {
          burst = {
            startTs: row.ts ?? null,
            endTs: row.ts ?? null,
            chunks: 0,
            chars: 0,
            preview: "",
          };
        }
        burst.endTs = row.ts ?? burst.endTs;
        burst.chunks += 1;
        burst.chars += d.text.length;
        if (burst.preview.length < 80) {
          burst.preview = clip(burst.preview + d.text, 80);
        }
        continue;
      }

      // 空 delta 等：跳过噪声，避免刷屏
      if (payload == null) {
        burst = flushBurst(out, burst, L);
        out.push(withTime(clock, L.sseOther(clip(String(ev.data || ""), 80))));
      }
      continue;
    }

    burst = flushBurst(out, burst, L);

    if (kind === "request") {
      const body = ev.body;
      const o = asObj(body);
      const model = (o && str(o.model)) || "?";
      const msgs = Array.isArray(o?.messages) ? o!.messages.length : 0;
      const stream = Boolean(o?.stream);
      const effort = o ? str(o.reasoning_effort) : null;
      out.push(
        withTime(
          clock,
          L.request({
            host: hostFromUrl(ev.url),
            model,
            msgs,
            stream,
            effort,
            lastUser: lastUserPreview(body),
          })
        )
      );
      announcedStream = false;
      continue;
    }

    if (kind === "http_error") {
      const status =
        typeof ev.status === "number" ? ev.status : Number(ev.status) || 0;
      out.push(
        withTime(clock, L.httpError(status, extractHttpErrorMsg(ev.body)))
      );
      continue;
    }

    if (kind === "usage") {
      const rawU = asObj(ev.raw) || {};
      const prompt = num(rawU.prompt_tokens);
      const completion = num(rawU.completion_tokens);
      const total = num(rawU.total_tokens);
      const pdet = asObj(rawU.prompt_tokens_details);
      const cdet = asObj(rawU.completion_tokens_details);
      const cached = pdet ? num(pdet.cached_tokens) : null;
      const reasoning = cdet ? num(cdet.reasoning_tokens) : null;
      out.push(
        withTime(
          clock,
          L.usage({ prompt, cached, completion, reasoning, total })
        )
      );
      continue;
    }

    out.push(
      withTime(
        clock,
        L.unknown(kind, clip(JSON.stringify(ev), 100))
      )
    );
  }

  flushBurst(out, burst, L);
  return out.length ? out.join("\n\n") : L.empty;
}

/** 按当前人话开关渲染协议日志正文。 */
export function renderProtocolLogText(raw: string): string {
  if (!raw.trim()) return strings(uiLang()).empty;
  if (isProtocolLogPlainMode()) return humanizeProtocolLog(raw, uiLang());
  return raw;
}

export function initProtocolLogPlainToggle(onApply: () => void): void {
  const btn = document.getElementById("btn-protocol-log-plain");
  if (!btn) return;
  applyProtocolLogPlainButton();

  const toggle = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    setProtocolLogPlainMode(!isProtocolLogPlainMode());
    applyProtocolLogPlainButton();
    onApply();
  };

  btn.addEventListener("click", toggle);
  btn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") toggle(e);
  });
}
