import type {
  ModuleEvent,
  PlaybackContext,
  PlaybackModule,
  PlaybackModuleInfo,
} from "./types";
import { ImePlaybackModule } from "./ime";

export type { ModuleEvent, ModuleId, PlaybackContext, PlaybackModule, PlaybackModuleInfo } from "./types";
export { PlaybackRegistry, parseModuleEventLine } from "./types";
export { ImePlaybackModule } from "./ime";

export interface WinRect {
  hwnd?: number;
  z: number;
  title: string;
  class?: string;
  bounds: number[];
  minimized?: boolean;
  exe?: string;
}

export interface DisplaySetup {
  virtual: { x: number; y: number; w: number; h: number; monitors: any[] };
  monitor_count?: number;
  monitors?: any[];
  wallpaper_path?: string | null;
  wallpaper_mode?: string;
  different_wallpapers?: boolean;
  wallpaper_source?: string;
  third_party_wallpaper_apps?: string[];
  cursor_size?: number[];
}

export interface TaskbarButton {
  title: string;
  bounds: number[];
  icon_rel?: string | null;
}

export interface TaskbarInfo {
  bounds: number[];
  edge: string;
  secondary?: boolean;
  buttons: TaskbarButton[];
}

/** 焦点窗回放 */
export class FocusPlaybackModule implements PlaybackModule {
  private events: ModuleEvent[] = [];

  info(): PlaybackModuleInfo {
    return {
      id: "focus",
      name: "Focus window",
      version: "0.2.0",
      description: "回放焦点窗口高亮",
      kinds: ["focus_change", "module_hello"],
    };
  }

  load(events: ModuleEvent[]) {
    this.events = events
      .filter((e) => e.kind === "focus_change")
      .sort((a, b) => a.ts - b.ts);
  }

  append(events: ModuleEvent[]) {
    for (const e of events) {
      if (e.kind === "focus_change") this.events.push(e);
    }
    this.events.sort((a, b) => a.ts - b.ts);
  }

  /** 会话缓存：导出已加载焦点事件 */
  exportEvents(): ModuleEvent[] {
    return this.events.slice();
  }

  render(p: PlaybackContext): boolean {
    let active: ModuleEvent | null = null;
    for (const e of this.events) {
      if (e.ts <= p.currentTime) active = e;
      else break;
    }
    if (!active) return false;
    const bounds = active.payload.bounds as number[] | undefined;
    const app = String(active.payload.app ?? "");
    if (!bounds || bounds.length < 4) return false;
    const [x, y, w, h] = bounds;
    const { ctx, scale } = p;
    ctx.strokeStyle = "rgba(0, 255, 200, 0.95)";
    ctx.lineWidth = 3 / scale;
    ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = "#00ffcc";
    ctx.font = `${14 / scale}px Consolas, monospace`;
    ctx.fillText(`焦点 [${app}]`, x + 5, y + 18);
    return true;
  }
}

type WinBoundsPatch = {
  ts: number;
  hwnd: number;
  bounds: number[];
  minimized?: boolean;
};

/** 前后窗叠层 + 任务栏 + 壁纸元数据 */
export class WinMapPlaybackModule implements PlaybackModule {
  private snapshots: ModuleEvent[] = [];
  private taskbarEvents: ModuleEvent[] = [];
  /** 拖动/缩放轨迹（win_bounds），叠在最近 win_snapshot 之上 */
  private boundsPatches: WinBoundsPatch[] = [];
  display: DisplaySetup | null = null;
  wallpaperPath: string | null = null;

  info(): PlaybackModuleInfo {
    return {
      id: "win_map",
      name: "Win map",
      version: "0.3.0",
      description: "Z-order 窗口地图 + 显示器 + 任务栏 + 壁纸 + 移动轨迹",
      kinds: [
        "win_snapshot",
        "win_bounds",
        "display_setup",
        "taskbar",
        "wallpaper",
        "module_hello",
      ],
    };
  }

  load(events: ModuleEvent[]) {
    this.snapshots = [];
    this.taskbarEvents = [];
    this.boundsPatches = [];
    this.display = null;
    this.wallpaperPath = null;
    for (const e of events) this.ingestOne(e);
    this.snapshots.sort((a, b) => a.ts - b.ts);
    this.taskbarEvents.sort((a, b) => a.ts - b.ts);
    this.boundsPatches.sort((a, b) => a.ts - b.ts);
  }

  append(events: ModuleEvent[]) {
    for (const e of events) this.ingestOne(e);
    this.snapshots.sort((a, b) => a.ts - b.ts);
    this.taskbarEvents.sort((a, b) => a.ts - b.ts);
    this.boundsPatches.sort((a, b) => a.ts - b.ts);
  }

  private ingestOne(e: ModuleEvent) {
    if (e.kind === "display_setup") {
      this.display = e.payload as unknown as DisplaySetup;
      if (this.display.wallpaper_path) {
        this.wallpaperPath = String(this.display.wallpaper_path);
      }
    } else if (e.kind === "wallpaper") {
      const backup = e.payload.backup_rel;
      const p = e.payload.path;
      if (typeof backup === "string" && backup) {
        this.wallpaperPath = `win_map:${backup}`;
      } else if (typeof p === "string") {
        this.wallpaperPath = p;
      }
    } else if (e.kind === "win_snapshot") {
      this.snapshots.push(e);
    } else if (e.kind === "win_bounds") {
      const hwnd = Number(e.payload?.hwnd);
      const bounds = e.payload?.bounds as number[] | undefined;
      if (!Number.isFinite(hwnd) || !Array.isArray(bounds) || bounds.length < 4) return;
      this.boundsPatches.push({
        ts: e.ts,
        hwnd,
        bounds: [
          Number(bounds[0]),
          Number(bounds[1]),
          Number(bounds[2]),
          Number(bounds[3]),
        ],
        minimized: Boolean(e.payload?.minimized),
      });
    } else if (e.kind === "taskbar") {
      this.taskbarEvents.push(e);
    }
  }

  /** 最近一条窗口相关事件时间（直播播放头用） */
  latestEventTs(): number {
    let t = 0;
    if (this.snapshots.length) t = Math.max(t, this.snapshots[this.snapshots.length - 1].ts);
    if (this.boundsPatches.length)
      t = Math.max(t, this.boundsPatches[this.boundsPatches.length - 1].ts);
    if (this.taskbarEvents.length)
      t = Math.max(t, this.taskbarEvents[this.taskbarEvents.length - 1].ts);
    return t;
  }

  /** 会话缓存：导出可再 load 的事件列表 */
  exportEvents(): ModuleEvent[] {
    const out: ModuleEvent[] = [];
    if (this.display) {
      out.push({
        v: 1,
        module: "win_map",
        ts: 0,
        kind: "display_setup",
        payload: this.display as unknown as Record<string, unknown>,
      });
    }
    if (this.wallpaperPath) {
      const wp = this.wallpaperPath;
      out.push({
        v: 1,
        module: "win_map",
        ts: 0,
        kind: "wallpaper",
        payload: wp.startsWith("win_map:")
          ? { backup_rel: wp.slice("win_map:".length) }
          : { path: wp },
      });
    }
    out.push(...this.snapshots);
    for (const p of this.boundsPatches) {
      out.push({
        v: 1,
        module: "win_map",
        ts: p.ts,
        kind: "win_bounds",
        payload: {
          hwnd: p.hwnd,
          bounds: p.bounds,
          minimized: p.minimized,
        },
      });
    }
    out.push(...this.taskbarEvents);
    return out;
  }

  windowsAt(time: number): WinRect[] {
    let snap: ModuleEvent | null = null;
    for (const e of this.snapshots) {
      if (e.ts <= time) snap = e;
      else break;
    }
    if (!snap) return [];
    const wins = ((snap.payload.windows as WinRect[]) || []).map((w) => ({
      ...w,
      bounds: [...(w.bounds || [])],
    }));
    // 快照之后的 win_bounds 按序覆盖同 hwnd，形成拖动轨迹
    const snapTs = snap.ts;
    for (const p of this.boundsPatches) {
      if (p.ts <= snapTs) continue;
      if (p.ts > time) break;
      const hit = wins.find((w) => Number(w.hwnd) === p.hwnd);
      if (!hit) continue;
      hit.bounds = [...p.bounds];
      if (p.minimized !== undefined) hit.minimized = p.minimized;
    }
    return wins.sort((a, b) => b.z - a.z);
  }

  taskbarsAt(time: number): TaskbarInfo[] {
    let snap: ModuleEvent | null = null;
    for (const e of this.taskbarEvents) {
      if (e.ts <= time) snap = e;
      else break;
    }
    if (!snap) return [];
    return (snap.payload.taskbars as TaskbarInfo[]) || [];
  }

  render(p: PlaybackContext): boolean {
    const { ctx, scale } = p;
    if (this.display?.virtual) {
      const mons = this.display.virtual.monitors || [];
      for (const m of mons) {
        const x = m.left;
        const y = m.top;
        const w = m.right - m.left;
        const h = m.bottom - m.top;
        ctx.strokeStyle = m.primary
          ? "rgba(255, 200, 80, 0.55)"
          : "rgba(120, 160, 255, 0.45)";
        ctx.lineWidth = 2 / scale;
        ctx.strokeRect(x, y, w, h);
        drawWindowCaption(ctx, x, y, w, h, m.primary ? "主屏" : "副屏", scale, {
          barH: 18,
          barColor: m.primary
            ? "rgba(40, 32, 12, 0.72)"
            : "rgba(16, 28, 48, 0.72)",
          textColor: m.primary ? "#ffc850" : "#9eb6ff",
        });
      }
    }

    const wins = this.windowsAt(p.currentTime);
    for (const win of wins) {
      if (win.minimized) continue;
      // 桌面/任务栏类窗口单独画，避免挡壁纸观感时可半透明
      const isShell =
        win.class === "Shell_TrayWnd" ||
        win.class === "Shell_SecondaryTrayWnd" ||
        win.class === "Progman" ||
        win.class === "WorkerW";
      const [x, y, w, h] = win.bounds;
      if (w <= 0 || h <= 0) continue;
      if (isShell) continue;
      const front = win.z === 0;
      ctx.fillStyle = front
        ? "rgba(40, 80, 120, 0.22)"
        : "rgba(80, 80, 80, 0.12)";
      ctx.fillRect(x, y, w, h);
      const lw = 1 / scale;
      ctx.strokeStyle = front
        ? "rgba(255, 255, 255, 0.55)"
        : "rgba(180, 180, 180, 0.35)";
      ctx.lineWidth = lw;
      // 描边居中会各溢出半线宽 → 内缩，留在窗口 bounds 内
      if (w > lw * 2 && h > lw * 2) {
        ctx.strokeRect(x + lw / 2, y + lw / 2, w - lw, h - lw);
      }
      // 非焦点/被盖住的窗也显示标题；半透明顶栏减轻字字重合干扰
      const label = (win.title || win.exe || win.class || "?").trim();
      drawWindowCaption(ctx, x, y, w, h, label, scale, {
        barColor: front
          ? "rgba(20, 22, 28, 0.82)"
          : "rgba(18, 18, 22, 0.72)",
        textColor: front ? "#f2f2f2" : "#c8c8c8",
      });
    }

    // 任务栏几何（图标由 main 异步贴图）
    for (const bar of this.taskbarsAt(p.currentTime)) {
      const [x, y, w, h] = bar.bounds;
      ctx.fillStyle = "rgba(20, 20, 28, 0.92)";
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = "rgba(255,255,255,0.25)";
      ctx.lineWidth = 1 / scale;
      ctx.strokeRect(x, y, w, h);
      for (const btn of bar.buttons || []) {
        const [bx, by, bw, bh] = btn.bounds;
        ctx.strokeStyle = "rgba(200,200,200,0.35)";
        ctx.strokeRect(bx, by, bw, bh);
      }
    }
    return true;
  }
}

/** 窗口顶栏标题：半透明底。小窗不压窄顶栏，按文字自然宽度外伸，避免字被挡 */
export function drawWindowCaption(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  text: string,
  viewScale: number,
  opts?: {
    barH?: number;
    barColor?: string;
    textColor?: string;
  }
) {
  if (h < 4) return;
  const barH = Math.max(16, Math.min(opts?.barH ?? 24, 24));
  const padX = 8;
  let label = (text || "").replace(/\s+/g, " ").trim();
  if (!label) return;

  const fontPx = Math.max(11, Math.min(13, barH - 9));
  ctx.save();
  ctx.font = `500 ${fontPx / viewScale}px "Noto Sans SC", "Segoe UI", sans-serif`;
  ctx.fillStyle = opts?.textColor ?? "#f2f2f2";
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";

  const naturalW = ctx.measureText(label).width + padX * 2;
  // 窄窗：顶栏按文字自然宽度外伸，不跟窗体一起被压窄；宽窗仍贴窗宽并省略超长标题
  const cap = Math.max(w, 360);
  let barW: number;
  if (naturalW <= w) {
    barW = Math.max(w, 0);
  } else if (naturalW <= cap) {
    barW = naturalW;
  } else {
    barW = cap;
    const maxText = Math.max(0, barW - padX * 2);
    const ell = "…";
    while (label.length > 1 && ctx.measureText(label + ell).width > maxText) {
      label = label.slice(0, -1);
    }
    label = label + ell;
  }

  ctx.fillStyle = opts?.barColor ?? "rgba(20, 22, 28, 0.78)";
  ctx.fillRect(x, y, barW, barH);
  ctx.fillStyle = opts?.textColor ?? "#f2f2f2";
  ctx.fillText(label, x + padX, y + barH / 2);
  ctx.restore();
}

export class StubPlaybackModule implements PlaybackModule {
  constructor(private meta: PlaybackModuleInfo) {}
  info() {
    return this.meta;
  }
  load(_events: ModuleEvent[]) {}
  render(_ctx: PlaybackContext) {
    return false;
  }
}

export function createBuiltinPlaybackModules(): PlaybackModule[] {
  return [
    new WinMapPlaybackModule(),
    new FocusPlaybackModule(),
    new StubPlaybackModule({
      id: "input",
      name: "Input",
      version: "0.3.0",
      description: "物理流 .bin",
      kinds: ["module_hello"],
    }),
    new ImePlaybackModule(),
    new StubPlaybackModule({
      id: "browser",
      name: "Browser",
      version: "0.0.0",
      description: "未实现",
      kinds: ["nav", "title", "url"],
    }),
    new StubPlaybackModule({
      id: "body",
      name: "Body",
      version: "0.1.0",
      description: "机体遥测（本轮不渲染）",
      kinds: [
        "module_hello",
        "inventory_snapshot",
        "device_change",
        "link_change",
        "hk_sample",
        "sensor_unavailable",
      ],
    }),
  ];
}
