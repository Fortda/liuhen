import type { NotesCardSummary } from "./notes_types";

const VIEWPORT_H_MAX = 400;
const FADE_ZONE = 50;
const TICK_LEN_MAX = 14;
const TICK_LEN_MIN = 4;
/** Hermes 密度：刻度间距小，命中区铺满格子无死区 */
const TICK_PITCH = 5;
const PREVIEW_PITCH = 22;
const PREVIEW_MAX_CHARS = 52;
const MIN_VIEWPORT_H = 48;
/** leave 防抖：允许指针从刻度桥接到预览，避免缝隙闪关 */
const HIDE_DELAY_MS = 60;
/** hover in/out 与 CSS `--notes-rail-motion-ms` 对齐 */
const RAIL_MOTION_MS = 200;

let scrollOffset = 0;
let bound = false;
let currentCards: NotesCardSummary[] = [];
let hoverIndex: number | null = null;
let previewVisible = false;
let viewportH = VIEWPORT_H_MAX;
let hideTimer: number | null = null;
let hideAnimTimer: number | null = null;
let showAnimRaf = 0;
/** 预览正在播 leave，DOM 仍在，待动画结束再 hidden */
let previewHiding = false;
/** 刻度条 + 预览面板（不含嵌套 viewport，避免重复 enter/leave） */
let hoverRoots: HTMLElement[] = [];
/** 抑制 feed↔rail 互推：rail 主动滚 feed 时跳过 syncFromFeed */
let suppressFeedSync = false;
let feedSyncRaf = 0;

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function formatRailDate(ts: number): string {
  const now = Date.now();
  const diffMs = Math.max(0, now - ts);
  const diffMin = Math.floor(diffMs / 60_000);
  const diffH = Math.floor(diffMs / 3_600_000);
  const diffD = Math.floor(diffMs / 86_400_000);

  if (diffD < 10) {
    if (diffMin < 60) return `${Math.max(1, diffMin)} 分钟前`;
    if (diffH < 24) return `${diffH} 小时前`;
    return `${diffD} 天前`;
  }
  const d = new Date(ts);
  const nowD = new Date(now);
  if (d.getFullYear() === nowD.getFullYear()) {
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  }
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}

function previewText(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  if (!t) return "（空）";
  if (t.length <= PREVIEW_MAX_CHARS) return t;
  return `${t.slice(0, PREVIEW_MAX_CHARS)}…`;
}

type Layout = {
  totalH: number;
  minOffset: number;
  maxOffset: number;
  viewportH: number;
};

/** 内容少时紧凑（按预览行高），最多 400px；offset 按预览行高钳制，避免滚出空白 */
function computeLayout(n: number): Layout {
  if (n <= 0) {
    return { totalH: 0, minOffset: 0, maxOffset: 0, viewportH: MIN_VIEWPORT_H };
  }
  const tickTotal = n * TICK_PITCH;
  const previewTotal = n * PREVIEW_PITCH;
  const vh = Math.min(
    VIEWPORT_H_MAX,
    Math.max(MIN_VIEWPORT_H, previewTotal)
  );
  if (previewTotal <= vh) {
    return { totalH: tickTotal, minOffset: 0, maxOffset: 0, viewportH: vh };
  }
  const tickMinOffset = TICK_PITCH / 2 - vh / 2;
  const tickMaxOffset = (n - 1) * TICK_PITCH + TICK_PITCH / 2 - vh / 2;
  const previewMinOffset = 0;
  const previewMaxOffset = Math.max(
    0,
    (n - vh / PREVIEW_PITCH) * TICK_PITCH
  );
  const minOffset = Math.max(tickMinOffset, previewMinOffset);
  const maxOffset = Math.min(tickMaxOffset, previewMaxOffset);
  return {
    totalH: tickTotal,
    minOffset: Math.min(minOffset, maxOffset),
    maxOffset: Math.max(minOffset, maxOffset),
    viewportH: vh,
  };
}

function clampOffset(offset: number, layout: Layout): number {
  return Math.max(layout.minOffset, Math.min(offset, layout.maxOffset));
}

function applyViewportHeight(vh: number) {
  viewportH = vh;
  const host = $("notes-card-rail-host");
  if (!host) return;
  host.style.setProperty("--notes-rail-h", `${vh}px`);
}

/** 避开 #notes-feed 原生滚动条；测不到时用固定回退 */
function applyFeedScrollbarGap() {
  const host = $("notes-card-rail-host");
  const feed = $("notes-feed");
  if (!host) return;
  let gap = 14;
  if (feed) {
    const sb = feed.offsetWidth - feed.clientWidth;
    gap = sb > 0 ? sb + 4 : 14;
  }
  host.style.setProperty("--notes-rail-edge-gap", `${gap}px`);
}

function itemOffset(): number {
  return scrollOffset / TICK_PITCH;
}

function tickY(i: number): number {
  return (i - itemOffset()) * TICK_PITCH + TICK_PITCH / 2;
}

function previewY(i: number): number {
  return (i - itemOffset()) * PREVIEW_PITCH + PREVIEW_PITCH / 2;
}

function indexFromTickY(localY: number, n: number): number {
  if (n <= 0) return -1;
  const i = Math.floor((localY + scrollOffset) / TICK_PITCH);
  return Math.max(0, Math.min(n - 1, i));
}

function edgeFactors(y: number): { opacity: number; tickLen: number } {
  if (y < 0 || y > viewportH) return { opacity: 0, tickLen: 0 };
  const edge = Math.min(y, viewportH - y);
  const t = edge < FADE_ZONE ? edge / FADE_ZONE : 1;
  return {
    opacity: t,
    tickLen: TICK_LEN_MIN + (TICK_LEN_MAX - TICK_LEN_MIN) * t,
  };
}

function centeredIndex(n: number): number {
  if (n <= 0) return -1;
  return indexFromTickY(viewportH / 2, n);
}

function scrollToCard(cardId: string) {
  const feed = $("notes-feed");
  const card = feed?.querySelector(
    `.notes-card[data-card-id="${CSS.escape(cardId)}"]`
  ) as HTMLElement | null;
  if (!card) return;
  suppressFeedSync = true;
  card.scrollIntoView({
    block: "center",
    behavior: prefersReducedMotion() ? "auto" : "smooth",
  });
  window.setTimeout(() => {
    suppressFeedSync = false;
  }, prefersReducedMotion() ? 50 : 420);
}

function centerOnIndex(i: number, layout: Layout) {
  scrollOffset = clampOffset(
    i * TICK_PITCH + TICK_PITCH / 2 - layout.viewportH / 2,
    layout
  );
}

/** feed 视口竖直中心最近的卡片 → currentCards 下标 */
function indexAtFeedCenter(): number {
  const feed = $("notes-feed");
  const n = currentCards.length;
  if (!feed || n <= 0) return -1;
  const feedRect = feed.getBoundingClientRect();
  const centerY = feedRect.top + feedRect.height / 2;
  let best = -1;
  let bestDist = Infinity;
  const nodes = feed.querySelectorAll(
    ".notes-card[data-card-id]"
  ) as NodeListOf<HTMLElement>;
  for (const el of nodes) {
    const id = el.dataset.cardId;
    if (!id) continue;
    const i = currentCards.findIndex((c) => c.id === id);
    if (i < 0) continue;
    const r = el.getBoundingClientRect();
    const mid = (r.top + r.bottom) / 2;
    const dist = Math.abs(mid - centerY);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

function syncRailFromFeed() {
  if (suppressFeedSync) return;
  const n = currentCards.length;
  if (n <= 0) return;
  const i = indexAtFeedCenter();
  if (i < 0) return;
  const layout = computeLayout(n);
  const next = clampOffset(
    i * TICK_PITCH + TICK_PITCH / 2 - layout.viewportH / 2,
    layout
  );
  if (Math.abs(next - scrollOffset) < 0.5 && centeredIndex(n) === i) return;
  scrollOffset = next;
  renderRail();
}

function scheduleSyncFromFeed() {
  if (feedSyncRaf) return;
  feedSyncRaf = window.requestAnimationFrame(() => {
    feedSyncRaf = 0;
    syncRailFromFeed();
  });
}

function nodeInHoverZone(node: EventTarget | null): boolean {
  if (!(node instanceof Node)) return false;
  return hoverRoots.some((z) => z.contains(node));
}

function clearHideTimer() {
  if (hideTimer != null) {
    window.clearTimeout(hideTimer);
    hideTimer = null;
  }
}

function clearHideAnimTimer() {
  if (hideAnimTimer != null) {
    window.clearTimeout(hideAnimTimer);
    hideAnimTimer = null;
  }
}

function cancelShowAnimRaf() {
  if (showAnimRaf) {
    window.cancelAnimationFrame(showAnimRaf);
    showAnimRaf = 0;
  }
}

function railMotionMs(): number {
  return prefersReducedMotion() ? 0 : RAIL_MOTION_MS;
}

function finishHidePreview() {
  hideAnimTimer = null;
  previewHiding = false;
  previewVisible = false;
  const host = $("notes-card-rail-host");
  const panel = host?.querySelector(
    ".notes-rail-preview-panel"
  ) as HTMLElement | null;
  host?.classList.remove("is-preview-open");
  if (panel) {
    panel.hidden = true;
    panel.classList.remove("is-visible");
  }
  hoverIndex = null;
  renderRail();
}

function setPreviewVisible(visible: boolean, immediate = false) {
  const host = $("notes-card-rail-host");
  const panel = host?.querySelector(
    ".notes-rail-preview-panel"
  ) as HTMLElement | null;

  if (visible) {
    clearHideTimer();
    clearHideAnimTimer();
    cancelShowAnimRaf();
    const wasHiding = previewHiding;
    previewHiding = false;
    const alreadyOpen =
      previewVisible &&
      !wasHiding &&
      !!panel &&
      !panel.hidden &&
      panel.classList.contains("is-visible");
    previewVisible = true;
    host?.classList.add("is-preview-open");
    if (alreadyOpen) return;
    if (!panel) {
      renderRail();
      return;
    }
    const wasHidden = panel.hidden;
    panel.hidden = false;
    renderRail();
    if (immediate || prefersReducedMotion()) {
      panel.classList.add("is-visible");
      return;
    }
    if (wasHidden) {
      panel.classList.remove("is-visible");
      void panel.offsetWidth;
    }
    showAnimRaf = window.requestAnimationFrame(() => {
      showAnimRaf = 0;
      panel.classList.add("is-visible");
    });
    return;
  }

  if (!previewVisible && !previewHiding) return;
  if (previewHiding && !immediate) return;

  clearHideTimer();
  cancelShowAnimRaf();
  host?.classList.remove("is-preview-open");

  const skipAnim =
    immediate || prefersReducedMotion() || !panel || panel.hidden;
  if (skipAnim) {
    clearHideAnimTimer();
    finishHidePreview();
    return;
  }

  panel.classList.remove("is-visible");
  previewHiding = true;
  clearHideAnimTimer();
  hideAnimTimer = window.setTimeout(finishHidePreview, railMotionMs());
}

/** 只改悬停高亮，避免 innerHTML 重建打坏 pointer leave 追踪 */
function paintHover() {
  const host = $("notes-card-rail-host");
  if (!host) return;
  const focusIdx = centeredIndex(currentCards.length);
  host.querySelectorAll<HTMLElement>(".notes-rail-tick").forEach((tick) => {
    const i = Number(tick.dataset.index);
    tick.classList.toggle("is-hover", i === hoverIndex);
    tick.classList.toggle("is-centered", i === focusIdx);
  });
  host.querySelectorAll<HTMLElement>(".notes-rail-preview-cell").forEach((cell) => {
    const i = Number(cell.dataset.index);
    cell.classList.toggle("is-centered", i === focusIdx);
    cell.classList.toggle("is-hover", i === hoverIndex && i !== focusIdx);
  });
}

function renderRail() {
  const host = $("notes-card-rail-host");
  const track = host?.querySelector(".notes-rail-track") as HTMLElement | null;
  const previewInner = host?.querySelector(
    ".notes-rail-preview-inner"
  ) as HTMLElement | null;
  const datesHost = host?.querySelector(".notes-rail-dates") as HTMLElement | null;
  const thumb = host?.querySelector(
    ".notes-rail-preview-thumb"
  ) as HTMLElement | null;
  const thumbWrap = host?.querySelector(
    ".notes-rail-preview-thumb-wrap"
  ) as HTMLElement | null;
  if (!host || !track || !previewInner || !datesHost || !thumb || !thumbWrap) return;

  const cards = currentCards;
  const n = cards.length;
  if (!n) {
    host.hidden = true;
    return;
  }

  host.hidden = false;

  const layout = computeLayout(n);
  applyViewportHeight(layout.viewportH);
  scrollOffset = clampOffset(scrollOffset, layout);
  const focusIdx = centeredIndex(n);

  track.innerHTML = "";
  previewInner.innerHTML = "";
  datesHost.innerHTML = "";

  for (let i = 0; i < n; i++) {
    const y = tickY(i);
    const { opacity, tickLen } = edgeFactors(y);
    const forceTick = i === hoverIndex || i === focusIdx;
    if (opacity > 0.02 || forceTick) {
      const tick = document.createElement("div");
      tick.className = "notes-rail-tick";
      tick.dataset.index = String(i);
      if (i === hoverIndex) tick.classList.add("is-hover");
      if (i === focusIdx) tick.classList.add("is-centered");
      tick.style.top = `${y}px`;
      tick.style.width = `${forceTick && opacity <= 0.02 ? TICK_LEN_MAX : tickLen}px`;
      tick.style.opacity = String(forceTick ? Math.max(opacity, 0.35) : opacity);
      track.appendChild(tick);
    }

    if (!previewVisible) continue;
    const py = previewY(i);
    const pFade = edgeFactors(py);
    if (pFade.opacity <= 0.02) continue;

    const card = cards[i];
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "notes-rail-preview-cell";
    cell.dataset.index = String(i);
    cell.dataset.cardId = card.id;
    if (i === focusIdx) cell.classList.add("is-centered");
    if (i === hoverIndex && i !== focusIdx) cell.classList.add("is-hover");
    cell.style.top = `${py - PREVIEW_PITCH / 2}px`;
    cell.style.height = `${PREVIEW_PITCH}px`;
    cell.style.opacity = String(pFade.opacity);
    cell.textContent = previewText(card.user_text);
    previewInner.appendChild(cell);

    const date = document.createElement("div");
    date.className = "notes-rail-date";
    date.style.top = `${py}px`;
    date.style.opacity = String(pFade.opacity);
    date.textContent = formatRailDate(card.created_at);
    datesHost.appendChild(date);
  }

  const span = layout.maxOffset - layout.minOffset;
  if (previewVisible && span > 0) {
    thumbWrap.style.display = "";
    const ratio = layout.viewportH / Math.max(layout.viewportH + span, 1);
    const thumbH = Math.max(16, ratio * (layout.viewportH - 8));
    const maxTop = layout.viewportH - 8 - thumbH;
    const top = ((scrollOffset - layout.minOffset) / span) * maxTop;
    thumb.style.height = `${thumbH}px`;
    thumb.style.top = `${top}px`;
  } else {
    thumbWrap.style.display = "none";
  }
}

function pickIndexFromEvent(e: MouseEvent, n: number): number {
  const viewport = document.querySelector(
    ".notes-rail-viewport"
  ) as HTMLElement | null;
  if (!viewport || n <= 0) return -1;
  const rect = viewport.getBoundingClientRect();
  const y = e.clientY - rect.top;
  if (y < 0 || y > rect.height) return -1;
  return indexFromTickY(y, n);
}

function onViewportMove(e: MouseEvent) {
  const i = pickIndexFromEvent(e, currentCards.length);
  if (i < 0) return;
  if (hoverIndex === i) return;
  hoverIndex = i;
  paintHover();
}

function onViewportClick(e: MouseEvent) {
  const n = currentCards.length;
  const i = pickIndexFromEvent(e, n);
  if (i < 0) return;
  const layout = computeLayout(n);
  centerOnIndex(i, layout);
  scrollToCard(currentCards[i].id);
  renderRail();
}

function onWheel(e: WheelEvent) {
  const layout = computeLayout(currentCards.length);
  if (layout.maxOffset <= layout.minOffset) {
    e.preventDefault();
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  scrollOffset = clampOffset(scrollOffset + e.deltaY * 0.5, layout);
  renderRail();
}

export function updateCardRail(cards: NotesCardSummary[]) {
  currentCards = cards;
  const host = $("notes-card-rail-host");
  if (!host) return;
  applyFeedScrollbarGap();
  if (!cards.length) {
    host.hidden = true;
    scrollOffset = 0;
    hoverIndex = null;
    setPreviewVisible(false, true);
    return;
  }
  const layout = computeLayout(cards.length);
  scrollOffset = clampOffset(scrollOffset, layout);
  renderRail();
  scheduleSyncFromFeed();
}

export function initCardRail() {
  if (bound) return;
  bound = true;

  const host = $("notes-card-rail-host");
  const viewport = host?.querySelector(".notes-rail-viewport") as HTMLElement | null;
  const panel = host?.querySelector(".notes-rail-preview-panel") as HTMLElement | null;
  const ticksWrap = host?.querySelector(".notes-rail-ticks-wrap") as HTMLElement | null;
  const previewInner = host?.querySelector(
    ".notes-rail-preview-inner"
  ) as HTMLElement | null;
  if (!host || !viewport) return;

  hoverRoots = [ticksWrap, panel].filter(Boolean) as HTMLElement[];

  const showPreview = () => {
    clearHideTimer();
    setPreviewVisible(true);
  };

  const scheduleHidePreview = () => {
    if (hideTimer != null) return;
    hideTimer = window.setTimeout(() => {
      hideTimer = null;
      if (previewVisible) setPreviewVisible(false);
    }, HIDE_DELAY_MS);
  };

  const onZoneEnter = () => showPreview();
  const onZoneLeave = (e: PointerEvent) => {
    if (nodeInHoverZone(e.relatedTarget)) return;
    scheduleHidePreview();
  };

  for (const z of hoverRoots) {
    z.addEventListener("pointerenter", onZoneEnter);
    z.addEventListener("pointerleave", onZoneLeave);
  }

  /** 单元格悬停/点击委托到稳定父节点，避免每次 render 重绑 + 重建触发 leave 丢失 */
  previewInner?.addEventListener("pointerover", (e) => {
    const cell = (e.target as Element | null)?.closest?.(
      ".notes-rail-preview-cell"
    ) as HTMLElement | null;
    if (!cell || !previewInner.contains(cell)) return;
    const i = Number(cell.dataset.index);
    if (!Number.isFinite(i) || hoverIndex === i) return;
    hoverIndex = i;
    const host = $("notes-card-rail-host");
    const tick = host?.querySelector(
      `.notes-rail-tick[data-index="${CSS.escape(String(i))}"]`
    );
    if (!tick) renderRail();
    else paintHover();
  });

  previewInner?.addEventListener("pointerout", (e) => {
    const cell = (e.target as Element | null)?.closest?.(
      ".notes-rail-preview-cell"
    ) as HTMLElement | null;
    if (!cell || !previewInner.contains(cell)) return;
    const related = e.relatedTarget;
    if (related instanceof Node && cell.contains(related)) return;
    if (
      related instanceof Node &&
      (related as Element).closest?.(".notes-rail-preview-cell")
    ) {
      return;
    }
    hoverIndex = null;
    paintHover();
  });

  previewInner?.addEventListener("click", (e) => {
    const cell = (e.target as Element | null)?.closest?.(
      ".notes-rail-preview-cell"
    ) as HTMLElement | null;
    if (!cell || !previewInner.contains(cell)) return;
    e.stopPropagation();
    const i = Number(cell.dataset.index);
    const cardId = cell.dataset.cardId;
    if (!Number.isFinite(i) || !cardId) return;
    const layout = computeLayout(currentCards.length);
    centerOnIndex(i, layout);
    scrollToCard(cardId);
    renderRail();
  });

  /** leave 追踪若被打坏：指针已在区外则关；桥接缝隙由 HIDE_DELAY 吸收 */
  const onDocPointerMove = (e: PointerEvent) => {
    if (!previewVisible) return;
    if (nodeInHoverZone(e.target)) {
      clearHideTimer();
      return;
    }
    scheduleHidePreview();
  };

  const onDocPointerDown = (e: PointerEvent) => {
    if (!previewVisible) return;
    if (nodeInHoverZone(e.target)) return;
    clearHideTimer();
    setPreviewVisible(false);
  };

  document.addEventListener("pointermove", onDocPointerMove, true);
  document.addEventListener("pointerdown", onDocPointerDown, true);

  $("notes-feed")?.addEventListener(
    "scroll",
    () => {
      if (previewVisible || previewHiding) {
        clearHideTimer();
        setPreviewVisible(false, true);
      }
      scheduleSyncFromFeed();
    },
    { passive: true }
  );

  viewport.addEventListener("mousemove", onViewportMove);
  viewport.addEventListener("click", onViewportClick);

  host.addEventListener("wheel", onWheel, { passive: false });
  viewport.addEventListener("wheel", onWheel, { passive: false });
  panel?.addEventListener("wheel", onWheel, { passive: false });

  applyFeedScrollbarGap();

  window.addEventListener("resize", () => {
    applyFeedScrollbarGap();
    renderRail();
    scheduleSyncFromFeed();
  });
}
