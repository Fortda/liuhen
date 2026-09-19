/**
 * 播放器 / 时间轴滚轮平移与缩放偏好。
 * 设置子页为唯一开关面；播放器与仪表盘 HUD 只读同一 localStorage。
 */
export const PLAYBACK_PREFS_KEY = "omnitrace.playback.v1";
export const PLAYBACK_PREFS_EVENT = "omnitrace-playback-prefs";
const LEGACY_DASH_KEY = "omnitrace.dash.viewPrefs";

export type PlaybackPrefs = {
  /** 播放器时间轴：每格滚轮平移占当前视窗的百分比 */
  playerPanPct: number;
  /** 播放器时间轴：每格缩放相对视窗跨度的百分比 */
  playerZoomPct: number;
  /** 仪表盘 / 笔记时间轴：平移百分比（对应旧 3.5%） */
  timelinePanPct: number;
  /** 仪表盘 / 笔记时间轴：Alt 缩放百分比（对应旧 Alt缩% 8） */
  timelineZoomPct: number;
  /** 滚轮后摩擦惯性 */
  inertia: boolean;
};

/** 比旧硬编码更小：播放器曾约 8% 平移 / 15–18% 缩放；仪表盘曾 3.5% / 8%。 */
export const DEFAULT_PLAYBACK_PREFS: PlaybackPrefs = {
  playerPanPct: 3,
  playerZoomPct: 5,
  timelinePanPct: 2.5,
  timelineZoomPct: 4,
  inertia: true,
};

function clampPct(n: number, lo: number, hi: number): number {
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, Math.round(n * 10) / 10));
}

function clampPrefs(p: Partial<PlaybackPrefs> | null | undefined): PlaybackPrefs {
  const d = DEFAULT_PLAYBACK_PREFS;
  return {
    playerPanPct: clampPct(p?.playerPanPct ?? d.playerPanPct, 0.5, 20),
    playerZoomPct: clampPct(p?.playerZoomPct ?? d.playerZoomPct, 1, 25),
    timelinePanPct: clampPct(p?.timelinePanPct ?? d.timelinePanPct, 0.5, 20),
    timelineZoomPct: clampPct(p?.timelineZoomPct ?? d.timelineZoomPct, 1, 50),
    inertia: p?.inertia !== false,
  };
}

function readLegacyTimelineZoom(): number | null {
  try {
    const raw = localStorage.getItem(LEGACY_DASH_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as { altZoomStepPct?: number };
    if (p.altZoomStepPct != null && Number.isFinite(p.altZoomStepPct)) {
      return Math.max(1, Math.min(50, Math.round(p.altZoomStepPct)));
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function getPlaybackPrefs(): PlaybackPrefs {
  try {
    const raw = localStorage.getItem(PLAYBACK_PREFS_KEY);
    if (raw) {
      return clampPrefs(JSON.parse(raw) as Partial<PlaybackPrefs>);
    }
  } catch {
    /* ignore */
  }
  const legacyZoom = readLegacyTimelineZoom();
  if (legacyZoom != null) {
    return clampPrefs({
      ...DEFAULT_PLAYBACK_PREFS,
      timelineZoomPct: legacyZoom,
    });
  }
  return { ...DEFAULT_PLAYBACK_PREFS };
}

export function setPlaybackPrefs(patch: Partial<PlaybackPrefs>): PlaybackPrefs {
  const next = clampPrefs({ ...getPlaybackPrefs(), ...patch });
  try {
    localStorage.setItem(PLAYBACK_PREFS_KEY, JSON.stringify(next));
  } catch {
    /* ignore quota */
  }
  window.dispatchEvent(new CustomEvent(PLAYBACK_PREFS_EVENT, { detail: next }));
  return next;
}

function bindNum(
  id: string,
  key: keyof Omit<PlaybackPrefs, "inertia">,
  lo: number,
  hi: number
) {
  const el = document.getElementById(id) as HTMLInputElement | null;
  if (!el) return;
  const apply = () => {
    if (!el.value.trim()) return;
    const n = Number(el.value);
    if (!Number.isFinite(n)) return;
    setPlaybackPrefs({ [key]: clampPct(n, lo, hi) });
  };
  el.addEventListener("input", apply);
  el.addEventListener("change", apply);
}

const RESET_KEYS: (keyof PlaybackPrefs)[] = [
  "playerPanPct",
  "playerZoomPct",
  "timelinePanPct",
  "timelineZoomPct",
  "inertia",
];

/** 开口圆环 + 箭头（非闭合圈）。 */
const RESET_ICON =
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>' +
  '<path d="M3 3v5h5"/>' +
  "</svg>";

function isDefaultValue(p: PlaybackPrefs, key: keyof PlaybackPrefs): boolean {
  return p[key] === DEFAULT_PLAYBACK_PREFS[key];
}

function syncPlaybackResetButtons(p: PlaybackPrefs) {
  document.querySelectorAll<HTMLButtonElement>("[data-playback-reset]").forEach((btn) => {
    const key = btn.dataset.playbackReset as keyof PlaybackPrefs | undefined;
    if (!key || !RESET_KEYS.includes(key)) return;
    const atDefault = isDefaultValue(p, key);
    btn.disabled = atDefault;
  });
}

function syncPlaybackSettingsInputs(p: PlaybackPrefs) {
  const setVal = (id: string, v: string | boolean) => {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (!el || document.activeElement === el) return;
    if (typeof v === "boolean") el.checked = v;
    else el.value = v;
  };
  setVal("playback-player-pan", String(p.playerPanPct));
  setVal("playback-player-zoom", String(p.playerZoomPct));
  setVal("playback-timeline-pan", String(p.timelinePanPct));
  setVal("playback-timeline-zoom", String(p.timelineZoomPct));
  setVal("playback-inertia", p.inertia);
  syncPlaybackResetButtons(p);
}

function bindResetButtons() {
  document.querySelectorAll<HTMLButtonElement>("[data-playback-reset]").forEach((btn) => {
    if (!btn.querySelector("svg")) btn.innerHTML = RESET_ICON;
    btn.addEventListener("click", () => {
      const key = btn.dataset.playbackReset as keyof PlaybackPrefs | undefined;
      if (!key || !RESET_KEYS.includes(key)) return;
      setPlaybackPrefs({ [key]: DEFAULT_PLAYBACK_PREFS[key] });
    });
  });
}

export function initPlaybackSettings() {
  const p = getPlaybackPrefs();
  bindResetButtons();
  syncPlaybackSettingsInputs(p);
  bindNum("playback-player-pan", "playerPanPct", 0.5, 20);
  bindNum("playback-player-zoom", "playerZoomPct", 1, 25);
  bindNum("playback-timeline-pan", "timelinePanPct", 0.5, 20);
  bindNum("playback-timeline-zoom", "timelineZoomPct", 1, 50);
  document.getElementById("playback-inertia")?.addEventListener("change", (e) => {
    setPlaybackPrefs({ inertia: (e.target as HTMLInputElement).checked });
  });
  window.addEventListener(PLAYBACK_PREFS_EVENT, () => {
    syncPlaybackSettingsInputs(getPlaybackPrefs());
  });
}
