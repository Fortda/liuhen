/** 笔记 LLM 卡片 — 与 Rust notes_ctl 对齐的类型 */

import type { McpStreamActivity } from "./notes_mcp_activity";

export type VendorId = "openai" | "anthropic" | "google" | "deepseek" | "relay";

export type VendorPreset = {
  id: VendorId;
  label: string;
  api_base: string;
};

export const VENDOR_PRESETS: VendorPreset[] = [
  { id: "openai", label: "OpenAI", api_base: "https://api.openai.com/v1" },
  { id: "anthropic", label: "Anthropic", api_base: "https://api.anthropic.com" },
  {
    id: "google",
    label: "Google",
    api_base: "https://generativelanguage.googleapis.com/v1beta",
  },
  { id: "deepseek", label: "DeepSeek", api_base: "https://api.deepseek.com" },
  { id: "relay", label: "中转", api_base: "" },
];

export function presetForVendor(vendor: string): VendorPreset | undefined {
  const v = vendor === "gemini" ? "google" : vendor;
  return VENDOR_PRESETS.find((p) => p.id === v);
}

export type TokenUsage = {
  input_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_creation_tokens?: number | null;
  thinking_tokens?: number | null;
  output_tokens?: number | null;
};

export type TimingsDeltaS = {
  to_first_byte?: number | null;
  to_first_token?: number | null;
  to_completed?: number | null;
  total?: number | null;
};

export type CostBreakdown = {
  input_usd: number;
  output_usd: number;
  cache_read_usd: number;
  cache_write_usd: number;
  thinking_usd: number;
  total_usd: number;
  currency: string;
  priced: boolean;
  price_key?: string | null;
};

export type NotesCardSummary = {
  id: string;
  created_at: number;
  status: string;
  model_label: string;
  user_text: string;
  assistant_text: string;
  timings_delta_s: TimingsDeltaS;
  usage: TokenUsage;
  cost: CostBreakdown;
  from_wire_context?: boolean;
  wire_preset_id?: string | null;
  wire_preset_name?: string | null;
  wire_preset_note?: string | null;
  wire_preset_created_at?: number | null;
  user_images?: string[];
  /** 用户打字色温字形（击键间隔）；缺省=无色温带。 */
  user_glyphs?: Array<{
    ch: string;
    dt_ms?: number;
    dtMs?: number;
    deleted?: boolean;
    ts?: number | null;
  }>;
  error?: string | null;
  stream_status?: string | null;
  /** 流式/MCP 回合活动（落盘 `mcp_activity`；列表摘要带回，结束后仍展示）。 */
  stream_activity?: McpStreamActivity | null;
  /** 本轮实际调用的 MCP server id（首次出现顺序）。 */
  mcp_servers?: string[];
  /** 本轮实际调用的工具名（首次出现顺序）。 */
  mcp_tools?: string[];
  /** 导入来源（如 aistudio）。 */
  import_source?: string | null;
};

export type WireContextInput = {
  from_wire_context: boolean;
  wire_preset_id?: string | null;
  wire_preset_name?: string | null;
  wire_preset_note?: string | null;
  wire_preset_created_at?: number | null;
};

export type NotesModelRef = {
  provider_id: string;
  provider_label: string;
  model_id: string;
  label: string;
  litellm_model: string;
  proxy_name: string;
};

export type NotesProviderModel = {
  id: string;
  label: string;
  litellm_model: string;
};

export type NotesProvider = {
  id: string;
  label: string;
  vendor: string;
  /** @deprecated 旧字段，加载时由 Rust 迁移为 vendor */
  kind?: string;
  api_base: string;
  api_key: string;
  models: NotesProviderModel[];
  models_synced_at?: number | null;
  models_sync_error?: string | null;
  /** 该卡保存/测试是否走本机 HTTP 代理；缺省时 Google 开、其它关 */
  use_local_http_proxy?: boolean | null;
};

export type ProvidersFile = {
  v: number;
  providers: NotesProvider[];
  default_model_key?: string | null;
  recent_model_keys?: string[];
  /** 置顶模型 key（provider_id/model_id）；组内排到该服务商列表最前 */
  pinned_model_keys?: string[];
  /** Composer 隐藏 / 设置页关闭的模型；缺省空=全开，新发现默认开 */
  disabled_model_keys?: string[];
};

export type LlmSidecarStatus = {
  url: string;
  listening: boolean;
  owned: boolean;
  pid: number | null;
  message: string;
};

export type SendTurnStart = {
  card_id: string;
  created_at: number;
};

export function modelKey(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

export function providerVendor(p: NotesProvider): string {
  return p.vendor || p.kind || "openai";
}

export function providerUsesHttpProxy(p: NotesProvider): boolean {
  if (typeof p.use_local_http_proxy === "boolean") return p.use_local_http_proxy;
  const v = providerVendor(p);
  return v === "google" || v === "gemini";
}

/** 卡片主文用短中文；原始 JSON 在协议日志 / data 抽屉。 */
export function humanizeLlmError(raw: string): string {
  const s = (raw || "").trim();
  if (!s) return s;
  // 已人话过的旧卡：去掉「原始：」尾巴，只留首段
  const cut = s.split(/\n\n原始：/)[0]?.trim() || s;
  const lower = cut.toLowerCase();
  const looksVertexName = lower.includes("vertexaiexception");
  const quota =
    lower.includes("resource_exhausted") ||
    lower.includes("exceeded your current quota") ||
    lower.includes("配额/额度") ||
    (lower.includes("ratelimit") && (lower.includes("429") || looksVertexName)) ||
    (lower.includes("429") && (looksVertexName || lower.includes("quota")));
  if (quota) {
    return "额度用尽或触发限速（HTTP 429）。请到 AI Studio 查看额度，或换较低档模型 / 关闭 Google Search 后再试。VertexAIException 仅为 LiteLLM 类名，不等于走了 Vertex。";
  }
  if (looksVertexName && (lower.includes("404") || lower.includes("notfound"))) {
    return "Gemini 返回 404（模型名或路径问题）。VertexAIException 是 LiteLLM 类名误导，不等于 Vertex。详情见 data。";
  }
  if (looksVertexName) {
    return `${cut.slice(0, 200)}${cut.length > 200 ? "…" : ""}（VertexAIException=LiteLLM 类名）`;
  }
  if (cut.length > 240) return `${cut.slice(0, 240)}…`;
  return cut;
}

export function isQuotaLlmError(raw: string): boolean {
  const s = (raw || "").toLowerCase();
  return (
    s.includes("resource_exhausted") ||
    s.includes("exceeded your current quota") ||
    s.includes("配额/额度") ||
    s.includes("额度用尽") ||
    (s.includes("429") && (s.includes("ratelimit") || s.includes("vertex") || s.includes("quota")))
  );
}
