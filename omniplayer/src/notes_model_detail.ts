import type { NotesModelRef, NotesProvider } from "./notes_types";
import { presetForVendor, providerVendor } from "./notes_types";
import type { PriceRates, PricingFile } from "./notes_llm";
import { formatMoneyFromUsd } from "./notes_cost_display";

type Capability = {
  id: string;
  label: string;
  supported: boolean;
  hint: string;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inferContextWindow(modelId: string, litellm: string): string {
  const id = `${modelId} ${litellm}`.toLowerCase();
  if (id.includes("1m") || id.includes("1000k") || id.includes("million"))
    return "1M tokens";
  if (id.includes("2m") || id.includes("2000k")) return "2M tokens";
  if (id.includes("128k")) return "128K tokens";
  if (id.includes("64k")) return "64K tokens";
  if (id.includes("32k")) return "32K tokens";
  if (id.includes("o1") || id.includes("o3")) return "200K tokens";
  if (id.includes("claude")) return "200K tokens";
  if (id.includes("gemini")) return "1M tokens";
  if (id.includes("deepseek")) return "64K tokens";
  if (id.includes("gpt-4o")) return "128K tokens";
  return "—";
}

/** Gemini 对话族（排除 embedding / imagen / veo / tts 等） */
function isGeminiChatModel(id: string): boolean {
  if (!/gemini/.test(id)) return false;
  return !/embed|imagen|veo|tts|aqa|robotics|gemma/.test(id);
}

function inferCapabilities(modelId: string, litellm: string): Capability[] {
  const id = `${modelId} ${litellm}`.toLowerCase();
  const geminiChat = isGeminiChatModel(id);
  // Gemini 1.5+ / 2.x / 3.x 原生多模态：名里通常没有 audio/vision 字样；旧启发式只认子串会误报「无音频」。
  const geminiNativeMm =
    geminiChat &&
    /gemini-1\.5|gemini-2|gemini-3|gemini-exp|gemini-flash|gemini-pro/.test(id);
  const vision =
    geminiNativeMm ||
    /vision|gpt-4o|gpt-4\.1|gpt-4-turbo|claude-3|claude-sonnet-4|claude-opus-4|pro-vision/.test(
      id
    );
  const audio =
    geminiNativeMm ||
    (/audio|whisper|speech|realtime/.test(id) && !/tts/.test(id));
  const video =
    (geminiChat && /gemini-1\.5|gemini-2|gemini-3/.test(id)) || /video/.test(id);
  const tools =
    geminiChat ||
    (!/embed|whisper|tts|dall-e|imagen|veo/.test(id) && !/image-generation/.test(id));
  const reasoning =
    /reason|o1|o3|think|r1|deepseek-reasoner|deepseek-r1|gemini-2\.5|gemini-3/.test(
      id
    );
  // 展示层：Gemini 可用 Google Search grounding（参数窗另有开关）；名含 search 的也算。
  const search = geminiChat || /search|browse|ground/.test(id);
  return [
    {
      id: "vision",
      label: "视觉识别",
      supported: vision,
      hint: vision ? "支持图像输入" : "不支持图像输入",
    },
    {
      id: "video",
      label: "视频识别",
      supported: video,
      hint: video ? "支持视频输入" : "不支持视频输入",
    },
    {
      id: "audio",
      label: "音频识别",
      supported: audio,
      hint: audio ? "支持音频输入" : "不支持音频输入",
    },
    {
      id: "tools",
      label: "工具调用",
      supported: tools,
      hint: tools ? "支持 Tool Calling" : "不支持工具调用",
    },
    {
      id: "reasoning",
      label: "深度思考",
      supported: reasoning,
      hint: reasoning ? "支持推理 / 思考链" : "常规模型",
    },
    {
      id: "search",
      label: "联网搜索",
      supported: search,
      hint: search ? "支持联网搜索" : "不支持联网搜索",
    },
  ];
}

export type RunModeSupport = {
  fast: boolean;
  thinking: boolean;
  effort: boolean;
};

/** 根据模型名推断 Fast / Thinking / Effort 是否可用 */
export function inferRunModes(modelId: string, litellm: string): RunModeSupport {
  const id = `${modelId} ${litellm}`.toLowerCase();
  const thinking =
    /reason|o1\b|o3\b|o4\b|think|r1\b|qwq|magistral|kimi-k2|grok-3|gpt-5|claude-(3-7|4|sonnet-4|opus-4)|gemini-2\.5|deepseek-v4|deepseek-reasoner/.test(
      id
    );
  const effort = thinking;
  const fast =
    thinking || /flash|mini|haiku|fast|turbo|lite|nano/.test(id);
  return { fast, thinking, effort };
}

function modelDescription(m: NotesModelRef, vendorLabel: string): string {
  const id = m.model_id.toLowerCase();
  if (id.includes("flash"))
    return `${m.model_id} 是 ${vendorLabel} 的轻量高速模型，适合日常对话与编码。`;
  if (id.includes("pro") || id.includes("opus"))
    return `${m.model_id} 是 ${vendorLabel} 的高能力模型，适合复杂任务。`;
  if (id.includes("reasoner") || id.includes("r1"))
    return `${m.model_id} 侧重推理与多步思考，响应可能更慢但逻辑更强。`;
  return `${m.model_id}（${vendorLabel}），通过 LiteLLM 路由：${m.litellm_model}`;
}

function formatTokenWindow(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return Number.isInteger(m) ? `${m}M tokens` : `${m.toFixed(1)}M tokens`;
  }
  if (n >= 1000) return `${Math.round(n / 1000)}K tokens`;
  return `${n} tokens`;
}

function resolvePriceKey(
  pricing: PricingFile,
  m: NotesModelRef
): PriceRates | null {
  const keys = [
    m.litellm_model,
    m.model_id,
    `${m.provider_id}/${m.model_id}`,
  ];
  for (const k of keys) {
    if (pricing.overrides?.[k]) return pricing.overrides[k];
    if (pricing.models[k]) return pricing.models[k];
  }
  const needle = m.model_id;
  const pool = { ...pricing.models, ...(pricing.overrides || {}) };
  for (const [k, v] of Object.entries(pool)) {
    if (k === needle || k.endsWith(`/${needle}`)) return v;
  }
  return null;
}

function fmtPrice(n: number, _currency: string): string {
  return `${formatMoneyFromUsd(n)} / 百万 tokens`;
}

function priceRow(label: string, value: string | null): string {
  if (!value) return "";
  return `<div class="notes-detail-price-row"><span>${escapeHtml(label)}</span><span>${escapeHtml(value)}</span></div>`;
}

export function buildModelDetailHtml(
  m: NotesModelRef,
  provider: NotesProvider,
  pricing: PricingFile
): string {
  const vendor = providerVendor(provider);
  const vendorLabel = presetForVendor(vendor)?.label || provider.label;
  const desc = modelDescription(m, vendorLabel);
  const caps = inferCapabilities(m.model_id, m.litellm_model);
  const rates = resolvePriceKey(pricing, m);
  const ctx =
    rates?.max_input_tokens != null
      ? formatTokenWindow(rates.max_input_tokens)
      : inferContextWindow(m.model_id, m.litellm_model);

  const capHtml = caps
    .map(
      (c) => `
    <div class="notes-detail-cap ${c.supported ? "is-on" : "is-off"}">
      <span class="notes-detail-cap-icon" aria-hidden="true">${capIcon(c.id)}</span>
      <span class="notes-detail-cap-label">${escapeHtml(c.label)}</span>
      <span class="notes-detail-cap-hint">${escapeHtml(c.hint)}</span>
    </div>`
    )
    .join("");

  let priceHtml = `<p class="notes-detail-muted">社区价表暂无此模型（只计牌价，不含促销/批量档）。</p>`;
  if (rates) {
    priceHtml = [
      priceRow("输入", fmtPrice(rates.input_per_1m, rates.currency)),
      priceRow("输出", fmtPrice(rates.output_per_1m, rates.currency)),
      rates.cache_read_per_1m != null
        ? priceRow(
            "输入（缓存读取）",
            fmtPrice(rates.cache_read_per_1m, rates.currency)
          )
        : "",
      rates.cache_write_per_1m != null
        ? priceRow(
            "输入（缓存写入）",
            fmtPrice(rates.cache_write_per_1m, rates.currency)
          )
        : "",
      rates.thinking_per_1m != null
        ? priceRow(
            "思考 tokens",
            fmtPrice(rates.thinking_per_1m, rates.currency)
          )
        : "",
      rates.doc_url
        ? `<a class="notes-detail-link" href="${escapeHtml(rates.doc_url)}" target="_blank" rel="noopener">官方定价页</a>`
        : "",
    ].join("");
  }

  const priceSrc =
    pricing.source === "litellm_community"
      ? `价表：LiteLLM 社区${pricing.fetched_at ? ` · ${escapeHtml(pricing.fetched_at.slice(0, 10))}` : ""}（牌价，促销不计）`
      : "价表未同步";

  return `
    <div class="notes-detail-head">
      <div class="notes-detail-title">${escapeHtml(m.model_id)}</div>
      <div class="notes-detail-desc">${escapeHtml(desc)}</div>
    </div>
    <section class="notes-detail-section">
      <div class="notes-detail-section-title"><span class="bar bar-blue"></span>上下文长度</div>
      <div class="notes-detail-kv"><span>${escapeHtml(ctx)}</span></div>
    </section>
    <section class="notes-detail-section">
      <div class="notes-detail-section-title"><span class="bar bar-purple"></span>能力</div>
      <div class="notes-detail-caps">${capHtml}</div>
    </section>
    <section class="notes-detail-section">
      <div class="notes-detail-section-title"><span class="bar bar-orange"></span>价格</div>
      <div class="notes-detail-prices">${priceHtml}</div>
    </section>
    <div class="notes-detail-meta">
      <span>LiteLLM：${escapeHtml(m.litellm_model)}</span><br/>
      <span>${priceSrc}</span>
    </div>
  `;
}

function capIcon(id: string): string {
  switch (id) {
    case "vision":
      return "👁";
    case "video":
      return "▶";
    case "audio":
      return "♪";
    case "tools":
      return "⚙";
    case "reasoning":
      return "✦";
    case "search":
      return "⌁";
    default:
      return "•";
  }
}
