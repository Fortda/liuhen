/**
 * 笔记时间轴漏斗筛选（图层 + 细筛）。
 */
import type { NotesCardSummary } from "./notes_types";
import type { ResearchMeta } from "./notes_research";

const STORAGE_KEY = "omnitrace.notes.timelineFilter";

export type TimelineFilter = {
  showCards: boolean;
  showResearch: boolean;
  /** 空 = 全部模型 */
  modelLabels: string[];
  /** 空 = 全部来源；含字面量 "__none__" 表示无 import_source */
  importSources: string[];
  /** true = 隐藏 status===error 的卡 */
  hideErrorCards: boolean;
  /** 空 = 全部格式 */
  formats: string[];
  /** true = 只要动机非空的资料 */
  motiveNonEmptyOnly: boolean;
};

export const DEFAULT_TIMELINE_FILTER: TimelineFilter = {
  showCards: true,
  showResearch: true,
  modelLabels: [],
  importSources: [],
  hideErrorCards: false,
  formats: [],
  motiveNonEmptyOnly: false,
};

export function loadTimelineFilter(): TimelineFilter {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_TIMELINE_FILTER };
    const p = JSON.parse(raw) as Partial<TimelineFilter>;
    return {
      showCards: p.showCards !== false,
      showResearch: p.showResearch !== false,
      modelLabels: Array.isArray(p.modelLabels) ? p.modelLabels.map(String) : [],
      importSources: Array.isArray(p.importSources)
        ? p.importSources.map(String)
        : [],
      hideErrorCards: Boolean(p.hideErrorCards),
      formats: Array.isArray(p.formats) ? p.formats.map(String) : [],
      motiveNonEmptyOnly: Boolean(p.motiveNonEmptyOnly),
    };
  } catch {
    return { ...DEFAULT_TIMELINE_FILTER };
  }
}

export function saveTimelineFilter(f: TimelineFilter) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(f));
}

export function filterCards(
  cards: NotesCardSummary[],
  f: TimelineFilter
): NotesCardSummary[] {
  if (!f.showCards) return [];
  return cards.filter((c) => {
    if (f.hideErrorCards && c.status === "error") return false;
    if (f.modelLabels.length) {
      const label = (c.model_label || "").trim();
      if (!f.modelLabels.includes(label)) return false;
    }
    if (f.importSources.length) {
      const src = (c.import_source || "").trim();
      const key = src || "__none__";
      if (!f.importSources.includes(key)) return false;
    }
    return true;
  });
}

export function filterResearch(
  items: ResearchMeta[],
  f: TimelineFilter
): ResearchMeta[] {
  if (!f.showResearch) return [];
  return items.filter((r) => {
    if (f.formats.length) {
      const fmt = (r.format || "").toLowerCase();
      if (!f.formats.map((x) => x.toLowerCase()).includes(fmt)) return false;
    }
    if (f.motiveNonEmptyOnly && !(r.motive || "").trim()) return false;
    return true;
  });
}

export function collectFilterOptions(
  cards: NotesCardSummary[],
  research: ResearchMeta[]
): {
  modelLabels: string[];
  importSources: { id: string; label: string }[];
  formats: string[];
} {
  const models = new Set<string>();
  const sources = new Map<string, string>();
  for (const c of cards) {
    const m = (c.model_label || "").trim();
    if (m) models.add(m);
    const src = (c.import_source || "").trim();
    if (src) sources.set(src, src);
    else sources.set("__none__", "（无导入来源）");
  }
  const formats = new Set<string>();
  for (const r of research) {
    const f = (r.format || "").trim();
    if (f) formats.add(f);
  }
  return {
    modelLabels: [...models].sort((a, b) => a.localeCompare(b, "zh")),
    importSources: [...sources.entries()]
      .map(([id, label]) => ({ id, label }))
      .sort((a, b) => a.label.localeCompare(b.label, "zh")),
    formats: [...formats].sort((a, b) => a.localeCompare(b, "zh")),
  };
}
