/**
 * 壳内浮层：统一定位（不盖住锚点）与 reveal/hide；动效风格 data-motion。
 */

export const FLOAT_MARGIN = 12;
export const FLOAT_GAP = 8;
export const FLOAT_MS = 180;

export const MOTION_STORAGE_KEY = "omnitrace.motionStyle";
export type MotionStyle = "pop-a";

export function readMotionStyle(): MotionStyle {
  try {
    const raw = localStorage.getItem(MOTION_STORAGE_KEY);
    if (raw === "pop-a") return raw;
  } catch {
    /* private mode */
  }
  return "pop-a";
}

export function applyMotionStyle(style: MotionStyle = readMotionStyle()): MotionStyle {
  document.documentElement.dataset.motion = style;
  try {
    localStorage.setItem(MOTION_STORAGE_KEY, style);
  } catch {
    /* ignore */
  }
  document.querySelectorAll(".motion-seg [data-motion]").forEach((btn) => {
    const el = btn as HTMLElement;
    el.classList.toggle("active", el.dataset.motion === style);
  });
  return style;
}

export function initMotionStyle() {
  applyMotionStyle(readMotionStyle());
  document.querySelectorAll(".motion-seg [data-motion]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const m = (btn as HTMLElement).dataset.motion;
      if (m === "pop-a") applyMotionStyle(m);
    });
  });
}

export function revealFloat(el: HTMLElement) {
  el.classList.remove("hidden");
  el.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.add("is-open"));
  });
}

export function hideFloat(el: HTMLElement | null) {
  if (!el || el.classList.contains("hidden")) return;
  el.classList.remove("is-open");
  window.setTimeout(() => {
    if (!el.classList.contains("is-open")) {
      el.classList.add("hidden");
      el.setAttribute("aria-hidden", "true");
    }
  }, FLOAT_MS);
}

function overlapsAnchor(
  left: number,
  top: number,
  w: number,
  h: number,
  anchor: DOMRect,
  gap: number
): boolean {
  const r = left + w;
  const b = top + h;
  // expand anchor by gap — any intersection means "covers" the button hit area
  const al = anchor.left - gap;
  const at = anchor.top - gap;
  const ar = anchor.right + gap;
  const ab = anchor.bottom + gap;
  return !(r <= al || left >= ar || b <= at || top >= ab);
}

/**
 * 把浮层夹在视口内；prefer=above/left/right。
 * 矩形禁止与锚点（含 FLOAT_GAP）重叠：空间不够则压 max-height 贴上方或下方。
 */
export function placeFloatInViewport(
  el: HTMLElement,
  anchor: DOMRect,
  prefer: "above" | "left" | "right",
  width: number
) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const m = FLOAT_MARGIN;
  const g = FLOAT_GAP;
  const w = Math.min(width, Math.max(96, vw - m * 2));
  el.style.position = "fixed";
  el.style.width = `${Math.round(w)}px`;
  el.style.maxWidth = `${vw - m * 2}px`;
  el.style.right = "auto";
  el.style.bottom = "auto";

  let left: number;
  if (prefer === "left") {
    left = anchor.left - w - g;
    if (left < m) left = anchor.right + g;
  } else if (prefer === "right") {
    left = anchor.right + g;
    if (left + w > vw - m) left = anchor.left - w - g;
  } else {
    left = anchor.right - w;
  }
  left = Math.max(m, Math.min(left, vw - w - m));

  const spaceAbove = Math.max(0, anchor.top - m - g);
  const spaceBelow = Math.max(0, vh - m - (anchor.bottom + g));

  if (prefer === "above") {
    // 先不设死 maxHeight，量自然高度
    el.style.maxHeight = `${vh - m * 2}px`;
    const natural = Math.min(el.getBoundingClientRect().height || 120, vh - m * 2);

    let side: "above" | "below";
    if (natural <= spaceAbove) side = "above";
    else if (natural <= spaceBelow) side = "below";
    else side = spaceAbove >= spaceBelow ? "above" : "below";

    const avail = side === "above" ? spaceAbove : spaceBelow;
    const maxH = Math.max(48, Math.min(vh - m * 2, avail > 0 ? avail : vh - m * 2));
    el.style.maxHeight = `${Math.round(maxH)}px`;
    if (getComputedStyle(el).overflow === "visible") {
      el.style.overflow = "auto";
    }

    const h = Math.min(el.getBoundingClientRect().height || Math.min(natural, maxH), maxH);
    let top = side === "above" ? anchor.top - g - h : anchor.bottom + g;

    // 二次校正：仍重叠则强制贴更大一侧并再压高度
    if (overlapsAnchor(left, top, w, h, anchor, g)) {
      side = spaceAbove >= spaceBelow ? "above" : "below";
      const avail2 = side === "above" ? spaceAbove : spaceBelow;
      const maxH2 = Math.max(48, avail2);
      el.style.maxHeight = `${Math.round(maxH2)}px`;
      const h2 = Math.min(el.getBoundingClientRect().height || maxH2, maxH2);
      top = side === "above" ? anchor.top - g - h2 : anchor.bottom + g;
      top = Math.max(m, Math.min(top, vh - m - h2));
      // 若仍碰锚点（极端矮视口），宁可贴边也不叠按钮
      if (overlapsAnchor(left, top, w, h2, anchor, 0)) {
        top = side === "above" ? Math.max(m, anchor.top - g - h2) : anchor.bottom + g;
      }
      el.style.left = `${Math.round(left)}px`;
      el.style.top = `${Math.round(top)}px`;
      const ox =
        left + w / 2 <= anchor.left + anchor.width / 2 ? "right" : "left";
      const oy = side === "above" ? "bottom" : "top";
      el.style.transformOrigin = `${oy} ${ox}`;
      return;
    }

    top = Math.max(m, Math.min(top, vh - m - h));
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
    const ox = left + w / 2 <= anchor.left + anchor.width / 2 ? "right" : "left";
    const oy = side === "above" ? "bottom" : "top";
    el.style.transformOrigin = `${oy} ${ox}`;
    return;
  }

  // left / right：竖直对齐锚点顶，夹视口；水平已在锚点外侧
  el.style.maxHeight = `${vh - m * 2}px`;
  let h = Math.min(el.getBoundingClientRect().height || 120, vh - m * 2);
  let top = anchor.top;
  if (top + h > vh - m) top = Math.max(m, vh - m - h);
  if (top < m) top = m;
  // 若因水平夹边落到与锚点重叠（极窄窗），改贴更大竖直空隙
  if (overlapsAnchor(left, top, w, h, anchor, g)) {
    if (spaceBelow >= spaceAbove) {
      const maxH = Math.max(48, spaceBelow);
      el.style.maxHeight = `${Math.round(maxH)}px`;
      h = Math.min(el.getBoundingClientRect().height || maxH, maxH);
      top = anchor.bottom + g;
    } else {
      const maxH = Math.max(48, spaceAbove);
      el.style.maxHeight = `${Math.round(maxH)}px`;
      h = Math.min(el.getBoundingClientRect().height || maxH, maxH);
      top = anchor.top - g - h;
    }
  }
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  const ox = left + w / 2 <= anchor.left + anchor.width / 2 ? "right" : "left";
  const oy = top + h / 2 <= anchor.top + anchor.height / 2 ? "bottom" : "top";
  el.style.transformOrigin = `${oy} ${ox}`;
}

/** 右键菜单：以指针为锚，夹在视口内。 */
export function placeFloatAtPoint(el: HTMLElement, clientX: number, clientY: number) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const m = FLOAT_MARGIN;
  el.style.position = "fixed";
  el.style.right = "auto";
  el.style.bottom = "auto";
  el.style.maxHeight = `${vh - m * 2}px`;
  const rect = el.getBoundingClientRect();
  let left = clientX;
  let top = clientY;
  if (left + rect.width > vw - m) left = Math.max(m, vw - rect.width - m);
  if (top + rect.height > vh - m) top = Math.max(m, vh - rect.height - m);
  left = Math.max(m, left);
  top = Math.max(m, top);
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
  el.style.transformOrigin = "top left";
}
