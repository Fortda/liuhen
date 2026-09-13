/**
 * 本轮请求参数白名单：只声明「会写进 chat body、且该模型族协议认」的字段。
 * 不追求 LiteLLM/全厂商百科；未知模型只给通用 OpenAI 采样字段。
 */
import type { NotesModelRef } from "./notes_types";

/** 原样写入 reasoning_effort 的档位（Gemini 3 经 LiteLLM 映射为 thinking_level） */
export type EffortWire = "low" | "medium" | "high" | "max" | "xhigh" | "minimal";

export type EffortOption = { id: EffortWire; label: string };

export type TurnParamSchema = {
  /** UI 小标题，说明按哪套协议裁剪 */
  familyLabel: string;
  /** 是否发送 thinking.enabled / disabled */
  thinkingToggle: boolean;
  /** 非空则显示档位并写入 reasoning_effort */
  effortOptions: EffortOption[];
  /** Anthropic / Gemini 2.5：thinking.budget_tokens */
  thinkingBudget: boolean;
  /** Gemini：tools 里加 googleSearch grounding */
  googleSearch: boolean;
  temperature: boolean;
  top_p: boolean;
  max_tokens: boolean;
  /** thinking 开启时 temperature/top_p 无效（DeepSeek 文档） */
  samplingIgnoredWhenThinking: boolean;
  /** effort 区 UI 文案（默认 reasoning_effort） */
  effortFieldLabel: string;
  effortFieldHint: string;
  note: string;
};

const EMPTY: TurnParamSchema = {
  familyLabel: "无模型",
  thinkingToggle: false,
  effortOptions: [],
  thinkingBudget: false,
  googleSearch: false,
  temperature: false,
  top_p: false,
  max_tokens: false,
  samplingIgnoredWhenThinking: false,
  effortFieldLabel: "reasoning_effort",
  effortFieldHint: "原样写入请求体",
  note: "选择模型后显示可调参数",
};

function modelBlob(m: NotesModelRef): string {
  return `${m.model_id} ${m.litellm_model} ${m.proxy_name}`.toLowerCase();
}

function isDeepSeekV4(id: string): boolean {
  return /deepseek-v4|deepseek\/deepseek-v4/.test(id);
}

function isOpenAiReasoning(id: string): boolean {
  return (
    /\bo1\b|\bo3\b|\bo4\b|gpt-5|o1-|o3-|o4-/.test(id) &&
    !/mini-tts|transcribe|realtime/.test(id)
  );
}

function isClaudeThinking(id: string): boolean {
  return /claude-(3-7|4|sonnet-4|opus-4|haiku-4)|claude.*thinking/.test(id);
}

function isGeminiFamily(id: string): boolean {
  return /gemini/.test(id) && !/embed|imagen|veo|tts|aqa/.test(id);
}

function isGemini3(id: string): boolean {
  return /gemini-3/.test(id);
}

function isGemini25(id: string): boolean {
  return /gemini-2\.5/.test(id);
}

/** 当前选中模型 → 参数窗可展示/可下发的字段 */
export function inferTurnParamSchema(
  m: NotesModelRef | null | undefined
): TurnParamSchema {
  if (!m || !m.model_id || m.model_id === "none") return EMPTY;
  const id = modelBlob(m);

  if (isDeepSeekV4(id)) {
    return {
      familyLabel: "DeepSeek V4",
      thinkingToggle: true,
      effortOptions: [
        { id: "low", label: "low" },
        { id: "high", label: "high" },
        { id: "max", label: "max" },
      ],
      thinkingBudget: false,
      googleSearch: false,
      temperature: true,
      top_p: true,
      max_tokens: true,
      samplingIgnoredWhenThinking: true,
      effortFieldLabel: "reasoning_effort",
      effortFieldHint: "原样写入请求体",
      note: "thinking 开启时 temperature / top_p 无效；effort 仅 low / high / max",
    };
  }

  if (/deepseek-reasoner|deepseek-r1|reasoner/.test(id) && /deepseek/.test(id)) {
    return {
      familyLabel: "DeepSeek Reasoner",
      thinkingToggle: false,
      effortOptions: [],
      thinkingBudget: false,
      googleSearch: false,
      temperature: false,
      top_p: false,
      max_tokens: true,
      samplingIgnoredWhenThinking: false,
      effortFieldLabel: "reasoning_effort",
      effortFieldHint: "原样写入请求体",
      note: "Reasoner 固定思考链；不传 temperature / reasoning_effort",
    };
  }

  if (isOpenAiReasoning(id)) {
    return {
      familyLabel: "OpenAI Reasoning",
      thinkingToggle: false,
      effortOptions: [
        { id: "low", label: "low" },
        { id: "medium", label: "medium" },
        { id: "high", label: "high" },
      ],
      thinkingBudget: false,
      googleSearch: false,
      temperature: false,
      top_p: false,
      max_tokens: true,
      samplingIgnoredWhenThinking: false,
      effortFieldLabel: "reasoning_effort",
      effortFieldHint: "原样写入请求体",
      note: "写入 reasoning_effort；不传 temperature / top_p",
    };
  }

  if (isClaudeThinking(id)) {
    return {
      familyLabel: "Anthropic Thinking",
      thinkingToggle: true,
      effortOptions: [],
      thinkingBudget: true,
      googleSearch: false,
      temperature: true,
      top_p: true,
      max_tokens: true,
      samplingIgnoredWhenThinking: false,
      effortFieldLabel: "reasoning_effort",
      effortFieldHint: "原样写入请求体",
      note: "thinking 开时带 budget_tokens；effort 档位不适用于本协议",
    };
  }

  if (isGeminiFamily(id)) {
    const gemini3 = isGemini3(id);
    const gemini25 = isGemini25(id);
    const flashLike = /flash/.test(id);
    const effortOptions: EffortOption[] = gemini3
      ? [
          ...(flashLike ? [{ id: "minimal" as const, label: "minimal" }] : []),
          { id: "low", label: "low" },
          { id: "medium", label: "medium" },
          { id: "high", label: "high" },
        ]
      : [];
    return {
      familyLabel: gemini3 ? "Gemini 3" : gemini25 ? "Gemini 2.5" : "Gemini",
      thinkingToggle: gemini25,
      effortOptions,
      thinkingBudget: gemini25,
      googleSearch: true,
      temperature: true,
      top_p: true,
      max_tokens: true,
      samplingIgnoredWhenThinking: false,
      effortFieldLabel: gemini3 ? "thinking_level" : "reasoning_effort",
      effortFieldHint: gemini3
        ? "经 LiteLLM 映射为 thinking_level（High 等）"
        : "原样写入请求体",
      note: gemini3
        ? "thinking_level 经 reasoning_effort 下发；可开 Google Search grounding"
        : gemini25
          ? "thinking.budget_tokens；可开 Google Search grounding"
          : "通用采样 + Google Search grounding；勿发明 API 不认的字段",
    };
  }

  // 其它 OpenAI 兼容聊天模型
  return {
    familyLabel: "OpenAI-compatible",
    thinkingToggle: false,
    effortOptions: [],
    thinkingBudget: false,
    googleSearch: false,
    temperature: true,
    top_p: true,
    max_tokens: true,
    samplingIgnoredWhenThinking: false,
    effortFieldLabel: "reasoning_effort",
    effortFieldHint: "原样写入请求体",
    note: "仅 temperature / top_p / max_tokens",
  };
}

export function clampEffortToSchema(
  effort: string,
  schema: TurnParamSchema
): EffortWire | "" {
  if (!schema.effortOptions.length) return "";
  if (schema.effortOptions.some((o) => o.id === effort)) {
    return effort as EffortWire;
  }
  // 旧 prefs：extra_high → max（若有），否则 medium → high（DeepSeek）
  if (effort === "extra_high") {
    if (schema.effortOptions.some((o) => o.id === "max")) return "max";
    if (schema.effortOptions.some((o) => o.id === "high")) return "high";
  }
  if (effort === "medium" && !schema.effortOptions.some((o) => o.id === "medium")) {
    if (schema.effortOptions.some((o) => o.id === "high")) return "high";
  }
  if (effort === "minimal" && !schema.effortOptions.some((o) => o.id === "minimal")) {
    if (schema.effortOptions.some((o) => o.id === "low")) return "low";
  }
  return schema.effortOptions[0]?.id ?? "";
}
