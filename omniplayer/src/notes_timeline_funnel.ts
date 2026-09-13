/**
 * 时间轴漏斗按钮 + 筛选菜单。
 */
import {
  collectFilterOptions,
  DEFAULT_TIMELINE_FILTER,
  loadTimelineFilter,
  saveTimelineFilter,
  type TimelineFilter,
} from "./notes_timeline_filter";
import {
  getNotesTimelineFilter,
  getNotesTimelineFilterSource,
  setNotesTimelineFilter,
} from "./notes_timeline";
import {
  hideFloat,
  placeFloatInViewport,
  revealFloat,
} from "./omni_float";

const FUNNEL_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M4 5h16l-6 7v5l-4 2v-7L4 5z"/></svg>`;

let funnelBtn: HTMLButtonElement | null = null;
let funnelPop: HTMLDivElement | null = null;
let outsideHandler: ((e: MouseEvent) => void) | null = null;

function ensureFunnelDom() {
  funnelBtn = document.getElementById(
    "notes-timeline-funnel"
  ) as HTMLButtonElement | null;
  if (!funnelBtn) {
    const toolbar = document.querySelector(".notes-timeline-toolbar");
    if (!toolbar) return;
    funnelBtn = document.createElement("button");
    funnelBtn.type = "button";
    funnelBtn.id = "notes-timeline-funnel";
    funnelBtn.className = "notes-btn notes-timeline-funnel-btn";
    funnelBtn.setAttribute("aria-haspopup", "dialog");
    funnelBtn.setAttribute("aria-expanded", "false");
    funnelBtn.title = "筛选";
    funnelBtn.setAttribute("aria-label", "筛选时间轴");
    funnelBtn.innerHTML = FUNNEL_SVG;
    const ingest = document.getElementById("notes-timeline-ingest");
    if (ingest?.parentElement === toolbar) {
      ingest.insertAdjacentElement("afterend", funnelBtn);
    } else {
      toolbar.prepend(funnelBtn);
    }
  }
  if (!(funnelBtn as HTMLButtonElement & { __funnelBound?: boolean }).__funnelBound) {
    (funnelBtn as HTMLButtonElement & { __funnelBound?: boolean }).__funnelBound = true;
    funnelBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (funnelPop && !funnelPop.classList.contains("hidden")) closeFunnel();
      else openFunnel();
    });
  }
}

function closeFunnel() {
  hideFloat(funnelPop);
  funnelBtn?.setAttribute("aria-expanded", "false");
  if (outsideHandler) {
    document.removeEventListener("mousedown", outsideHandler);
    outsideHandler = null;
  }
}

function placeFunnelPop() {
  if (!funnelPop || !funnelBtn) return;
  funnelPop.style.zIndex = "70";
  funnelPop.style.overflow = "auto";
  placeFloatInViewport(
    funnelPop,
    funnelBtn.getBoundingClientRect(),
    "above",
    280
  );
}

function renderFunnelBody(f: TimelineFilter) {
  if (!funnelPop) return;
  const { cards, research } = getNotesTimelineFilterSource();
  const opts = collectFilterOptions(cards, research);

  const modelChecks = opts.modelLabels
    .map((m) => {
      const on = f.modelLabels.length === 0 || f.modelLabels.includes(m);
      return `<label class="notes-funnel-row"><input type="checkbox" data-k="model" data-v="${escapeAttr(m)}" ${on ? "checked" : ""}/><span>${escapeHtml(m)}</span></label>`;
    })
    .join("");

  const sourceChecks = opts.importSources
    .map((s) => {
      const on = f.importSources.length === 0 || f.importSources.includes(s.id);
      return `<label class="notes-funnel-row"><input type="checkbox" data-k="source" data-v="${escapeAttr(s.id)}" ${on ? "checked" : ""}/><span>${escapeHtml(s.label)}</span></label>`;
    })
    .join("");

  const formatChecks = opts.formats
    .map((fmt) => {
      const on = f.formats.length === 0 || f.formats.includes(fmt);
      return `<label class="notes-funnel-row"><input type="checkbox" data-k="format" data-v="${escapeAttr(fmt)}" ${on ? "checked" : ""}/><span>${escapeHtml(fmt)}</span></label>`;
    })
    .join("");

  funnelPop.innerHTML = `
    <div class="notes-funnel-head"><strong>筛选</strong>
      <button type="button" class="notes-btn" data-act="reset">重置</button>
    </div>
    <div class="notes-funnel-sec">
      <div class="notes-funnel-label">图层</div>
      <label class="notes-funnel-row"><input type="checkbox" data-k="layer" data-v="cards" ${f.showCards ? "checked" : ""}/><span>流式卡片</span></label>
      <label class="notes-funnel-row"><input type="checkbox" data-k="layer" data-v="research" ${f.showResearch ? "checked" : ""}/><span>研究资料</span></label>
    </div>
    <div class="notes-funnel-sec">
      <div class="notes-funnel-label">卡片</div>
      <label class="notes-funnel-row"><input type="checkbox" data-k="hideError" ${f.hideErrorCards ? "checked" : ""}/><span>隐藏失败卡</span></label>
      ${modelChecks ? `<div class="notes-funnel-sub">模型</div>${modelChecks}` : `<p class="notes-funnel-empty">暂无模型选项</p>`}
      ${sourceChecks ? `<div class="notes-funnel-sub">导入来源</div>${sourceChecks}` : ""}
    </div>
    <div class="notes-funnel-sec">
      <div class="notes-funnel-label">资料</div>
      <label class="notes-funnel-row"><input type="checkbox" data-k="motive" ${f.motiveNonEmptyOnly ? "checked" : ""}/><span>仅有动机文案</span></label>
      ${formatChecks ? `<div class="notes-funnel-sub">格式</div>${formatChecks}` : `<p class="notes-funnel-empty">暂无格式选项</p>`}
    </div>
  `;

  funnelPop.querySelector('[data-act="reset"]')?.addEventListener("click", () => {
    const next = { ...DEFAULT_TIMELINE_FILTER };
    saveTimelineFilter(next);
    setNotesTimelineFilter(next);
    renderFunnelBody(next);
  });

  funnelPop.querySelectorAll("input[type=checkbox]").forEach((el) => {
    el.addEventListener("change", () => {
      applyFromDom();
    });
  });
}

function applyFromDom() {
  if (!funnelPop) return;
  const cur = getNotesTimelineFilter();
  const next: TimelineFilter = {
    showCards:
      (
        funnelPop.querySelector(
          'input[data-k="layer"][data-v="cards"]'
        ) as HTMLInputElement | null
      )?.checked !== false,
    showResearch:
      (
        funnelPop.querySelector(
          'input[data-k="layer"][data-v="research"]'
        ) as HTMLInputElement | null
      )?.checked !== false,
    hideErrorCards: Boolean(
      (funnelPop.querySelector('input[data-k="hideError"]') as HTMLInputElement | null)
        ?.checked
    ),
    motiveNonEmptyOnly: Boolean(
      (funnelPop.querySelector('input[data-k="motive"]') as HTMLInputElement | null)
        ?.checked
    ),
    modelLabels: [],
    importSources: [],
    formats: [],
  };

  const modelBoxes = [
    ...funnelPop.querySelectorAll('input[data-k="model"]'),
  ] as HTMLInputElement[];
  if (modelBoxes.length) {
    const checked = modelBoxes.filter((b) => b.checked).map((b) => b.dataset.v || "");
    // 全选或全不选 → 视为不过滤
    if (checked.length && checked.length < modelBoxes.length) {
      next.modelLabels = checked;
    }
  }
  const sourceBoxes = [
    ...funnelPop.querySelectorAll('input[data-k="source"]'),
  ] as HTMLInputElement[];
  if (sourceBoxes.length) {
    const checked = sourceBoxes.filter((b) => b.checked).map((b) => b.dataset.v || "");
    if (checked.length && checked.length < sourceBoxes.length) {
      next.importSources = checked;
    }
  }
  const formatBoxes = [
    ...funnelPop.querySelectorAll('input[data-k="format"]'),
  ] as HTMLInputElement[];
  if (formatBoxes.length) {
    const checked = formatBoxes.filter((b) => b.checked).map((b) => b.dataset.v || "");
    if (checked.length && checked.length < formatBoxes.length) {
      next.formats = checked;
    }
  }

  // preserve unused field from cur for future
  void cur;
  saveTimelineFilter(next);
  setNotesTimelineFilter(next);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

function openFunnel() {
  ensureFunnelDom();
  if (!funnelBtn) return;
  if (!funnelPop) {
    funnelPop = document.createElement("div");
    funnelPop.id = "notes-timeline-funnel-pop";
    funnelPop.className = "omni-float notes-funnel-pop hidden";
    funnelPop.setAttribute("role", "dialog");
    funnelPop.setAttribute("aria-label", "时间轴筛选");
    document.body.appendChild(funnelPop);
  }
  const f = loadTimelineFilter();
  setNotesTimelineFilter(f);
  renderFunnelBody(getNotesTimelineFilter());
  placeFunnelPop();
  revealFloat(funnelPop);
  requestAnimationFrame(() => placeFunnelPop());
  funnelBtn.setAttribute("aria-expanded", "true");
  if (!outsideHandler) {
    outsideHandler = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (funnelPop?.contains(t) || funnelBtn?.contains(t)) return;
      closeFunnel();
    };
    document.addEventListener("mousedown", outsideHandler);
  }
}

export function initNotesTimelineFunnel() {
  ensureFunnelDom();
  // apply saved filter on boot
  setNotesTimelineFilter(loadTimelineFilter());
}
