/**
 * 时间轴视窗导航契约（与仪表盘一致）：
 * - 滚轮 = 平移；Alt+滚轮 = 光标锚缩放
 * - 摩擦惯性；长按约 100ms 后拖 = 平移
 * - WebView 上需自管 Alt，避免进系统菜单
 */

import { getPlaybackPrefs } from "./playback_prefs";

export const DAY_MS = 86_400_000;
/** 最小视窗：可放到毫秒级刻度（同仪表盘） */
export const MIN_VIEW_SPAN_MS = 80;
/** 最大视窗跨度：约二十年 */
export const MAX_VIEW_SPAN_MS = Math.floor(20 * 365.25 * DAY_MS);
/** JS Date 可表示范围硬顶 */
export const TS_ABS_MAX = 8.64e15;
export const TS_ABS_MIN = -8.64e15;

/** ≈0.2s 收到 2%：k ≈ -ln(0.02)/0.2 ≈ 19.6 */
export const PAN_FRICTION = 19.6;
export const ZOOM_FRICTION = 20;

export const LONG_PRESS_MS = 100;
export const CLICK_SLOP_PX = 6;

export function readAltZoomStepPct(): number {
  return getPlaybackPrefs().timelineZoomPct;
}

export type TimeView = { start: number; end: number };

export function clampTimeView(start: number, end: number): TimeView {
  let span = Math.max(MIN_VIEW_SPAN_MS, Math.min(MAX_VIEW_SPAN_MS, end - start));
  let s = start;
  let e = s + span;
  if (s < TS_ABS_MIN) {
    s = TS_ABS_MIN;
    e = s + span;
  }
  if (e > TS_ABS_MAX) {
    e = TS_ABS_MAX;
    s = e - span;
  }
  return { start: s, end: e };
}

export function applyPanDelta(view: TimeView, deltaMs: number): TimeView {
  return clampTimeView(view.start + deltaMs, view.end + deltaMs);
}

export function applyZoomFactor(
  view: TimeView,
  factor: number,
  frac: number
): TimeView {
  const span = Math.max(1, view.end - view.start);
  const f = Math.min(1, Math.max(0, frac));
  const anchor = view.start + f * span;
  let newSpan = span * factor;
  newSpan = Math.min(MAX_VIEW_SPAN_MS, Math.max(MIN_VIEW_SPAN_MS, newSpan));
  return clampTimeView(anchor - f * newSpan, anchor - f * newSpan + newSpan);
}

/** 规范化 wheel deltaY（像素刻度） */
export function normalizeWheelDeltaY(e: WheelEvent): number {
  let dy = e.deltaY;
  if (e.deltaMode === 1) dy *= 33;
  else if (e.deltaMode === 2) dy *= 300;
  return dy;
}

export type InertiaState = {
  panVel: number;
  zoomVel: number;
  zoomAnchorFrac: number;
  raf: number;
  last: number;
};

export function createInertiaState(): InertiaState {
  return { panVel: 0, zoomVel: 0, zoomAnchorFrac: 0.5, raf: 0, last: 0 };
}

export function stopInertia(state: InertiaState) {
  if (state.raf) {
    cancelAnimationFrame(state.raf);
    state.raf = 0;
  }
  state.panVel = 0;
  state.zoomVel = 0;
}

/**
 * 启动/续跑惯性。onFrame 在每帧应用完 pan/zoom 后调用（负责 redraw）。
 * onIdle 在完全停下后调用一次。
 */
export function kickInertia(
  state: InertiaState,
  getView: () => TimeView,
  setView: (v: TimeView) => void,
  onFrame: () => void,
  onIdle?: () => void
) {
  if (state.raf) return;
  state.last = performance.now();
  state.raf = -1;
  onFrame();
  const step = (t: number) => {
    const dt = Math.min(48, t - state.last);
    state.last = t;
    const dtSec = dt / 1000;
    let view = getView();
    const span = Math.max(1, view.end - view.start);
    const panEps = Math.max(0.08, span * 2e-7);
    const zoomEps = 0.04;
    let moving = false;
    if (Math.abs(state.panVel) > panEps) {
      view = applyPanDelta(view, state.panVel * dt);
      setView(view);
      state.panVel *= Math.exp(-PAN_FRICTION * dtSec);
      moving = true;
    } else {
      state.panVel = 0;
    }
    if (Math.abs(state.zoomVel) > zoomEps) {
      view = applyZoomFactor(
        getView(),
        Math.exp(state.zoomVel * dtSec),
        state.zoomAnchorFrac
      );
      setView(view);
      state.zoomVel *= Math.exp(-ZOOM_FRICTION * dtSec);
      moving = true;
    } else {
      state.zoomVel = 0;
    }
    onFrame();
    if (moving) {
      state.raf = requestAnimationFrame(step);
    } else {
      state.raf = 0;
      onIdle?.();
    }
  };
  state.raf = requestAnimationFrame(step);
}

/** 处理一格滚轮：返回是否已 preventDefault 消费 */
export function handleTimeAxisWheel(
  e: WheelEvent,
  opts: {
    plotLeft: number;
    plotW: number;
    clientX: number;
    altHeld: boolean;
    altZoomStepPct?: number;
    getView: () => TimeView;
    setView: (v: TimeView) => void;
    inertia: InertiaState;
    onFrame: () => void;
    onIdle?: () => void;
  }
): boolean {
  const dy = normalizeWheelDeltaY(e);
  const frac = Math.min(
    1,
    Math.max(0, (opts.clientX - opts.plotLeft) / Math.max(1, opts.plotW))
  );
  const view = opts.getView();
  const span = Math.max(1, view.end - view.start);
  const prefs = getPlaybackPrefs();
  const stepPct = opts.altZoomStepPct ?? prefs.timelineZoomPct;
  const wantZoom = opts.altHeld || e.altKey || e.ctrlKey || e.metaKey;

  if (wantZoom) {
    opts.inertia.zoomAnchorFrac = frac;
    const dir = dy < 0 ? -1 : 1;
    const absD = Math.abs(dy);
    const ratio = Math.min(0.8, (absD / 100) * (stepPct / 100));
    const factor = dir < 0 ? 1 / (1 + ratio) : 1 + ratio;
    opts.setView(applyZoomFactor(view, factor, frac));
    if (prefs.inertia) {
      opts.inertia.zoomVel += dir * ratio * 8;
      kickInertia(opts.inertia, opts.getView, opts.setView, opts.onFrame, opts.onIdle);
    } else {
      opts.onFrame();
    }
  } else {
    const panFrac = Math.max(0.005, prefs.timelinePanPct / 100);
    const dFrac = (dy / 100) * panFrac;
    const delta = span * dFrac;
    opts.setView(applyPanDelta(view, delta));
    if (prefs.inertia) {
      opts.inertia.panVel += delta * 0.08;
      kickInertia(opts.inertia, opts.getView, opts.setView, opts.onFrame, opts.onIdle);
    } else {
      opts.onFrame();
    }
  }
  return true;
}

/** 指针在目标上时拦截 Alt，返回 { altHeld, dispose } */
export function installAltZoomGuard(opts: {
  isActive: () => boolean;
  isPointerOver: () => boolean;
}): { getAltHeld: () => boolean; dispose: () => void } {
  let altHeld = false;
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Alt" && e.key !== "AltGraph" && e.code !== "AltLeft" && e.code !== "AltRight")
      return;
    if (!opts.isActive() || !opts.isPointerOver()) return;
    e.preventDefault();
    e.stopPropagation();
    altHeld = true;
  };
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key !== "Alt" && e.key !== "AltGraph" && e.code !== "AltLeft" && e.code !== "AltRight")
      return;
    if (altHeld) {
      e.preventDefault();
      e.stopPropagation();
    }
    altHeld = false;
  };
  const onBlur = () => {
    altHeld = false;
  };
  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("blur", onBlur);
  return {
    getAltHeld: () => altHeld,
    dispose: () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    },
  };
}
