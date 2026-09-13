import type { EffortWire } from "./notes_turn_param_schema";

export type EffortLevel = EffortWire;

export type RunPrefs = {
  thinking: boolean;
  effort: EffortLevel;
  /** Anthropic thinking.budget_tokens；空不传 */
  thinking_budget: number | null;
  temperature: number | null;
  max_tokens: number | null;
  top_p: number | null;
  /** Gemini：tools 加入 googleSearch grounding */
  google_search: boolean;
};

const STORAGE_KEY = "omnitrace.notes.runPrefs";

const DEFAULT_PREFS: RunPrefs = {
  thinking: true,
  /** 默认 low，减少 Google 免费额度消耗；参数窗仍可调高 */
  effort: "low",
  thinking_budget: null,
  temperature: null,
  max_tokens: null,
  top_p: null,
  google_search: false,
};

function optionalNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function migrateEffort(raw: unknown): EffortLevel {
  const s = String(raw || "");
  if (s === "extra_high" || s === "xhigh") return "max";
  if (
    s === "low" ||
    s === "medium" ||
    s === "high" ||
    s === "max" ||
    s === "minimal"
  ) {
    return s;
  }
  return DEFAULT_PREFS.effort;
}

export function loadRunPrefs(): RunPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const p = JSON.parse(raw) as Partial<RunPrefs> & { fast?: boolean };
    let temperature = optionalNumber(p.temperature);
    // 旧 Fast 开关：等价于 temperature=0.2
    if (temperature === null && p.fast) temperature = 0.2;
    return {
      thinking: p.thinking === undefined ? DEFAULT_PREFS.thinking : Boolean(p.thinking),
      effort: migrateEffort(p.effort),
      thinking_budget: optionalNumber(p.thinking_budget),
      temperature,
      max_tokens: optionalNumber(p.max_tokens),
      top_p: optionalNumber(p.top_p),
      google_search:
        p.google_search === undefined
          ? DEFAULT_PREFS.google_search
          : Boolean(p.google_search),
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function saveRunPrefs(p: RunPrefs) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
}
