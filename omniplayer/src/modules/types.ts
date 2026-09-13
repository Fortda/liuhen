/** OmniPlayer 播放侧模组接口（与采集侧 ModuleEvent 信封对齐） */

export type ModuleId = "input" | "focus" | "win_map" | "ime" | "browser" | "win_settings" | "body";

export interface ModuleEvent {
  v: number;
  module: ModuleId;
  /** UTC ms */
  ts: number;
  kind: string;
  payload: Record<string, unknown>;
}

export interface PlaybackContext {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  /** 当前播放头 UTC ms */
  currentTime: number;
  virtualScreen: { width: number; height: number };
  scale: number;
}

export interface PlaybackModuleInfo {
  id: ModuleId;
  name: string;
  version: string;
  description: string;
  /** 该模组能处理的 kind 前缀或列表（文档用） */
  kinds: string[];
}

/**
 * 播放器模组：吃统一信封，往画布（或旁路 UI）画。
 * 未实现的模组可注册为 stub，load 时忽略未知 kind。
 */
export interface PlaybackModule {
  info(): PlaybackModuleInfo;
  load(events: ModuleEvent[]): void;
  append?(events: ModuleEvent[]): void;
  exportEvents?(): ModuleEvent[];
  latestEventTs?(): number;
  render(ctx: PlaybackContext): boolean;
  dispose?(): void;
}

export class PlaybackRegistry {
  private modules = new Map<ModuleId, PlaybackModule>();

  register(mod: PlaybackModule) {
    this.modules.set(mod.info().id, mod);
  }

  get(id: ModuleId) {
    return this.modules.get(id);
  }

  list(): PlaybackModuleInfo[] {
    return [...this.modules.values()].map((m) => m.info());
  }

  /** 按 module 字段分发事件到各模组 */
  loadAll(events: ModuleEvent[]) {
    const byModule = new Map<ModuleId, ModuleEvent[]>();
    for (const e of events) {
      const list = byModule.get(e.module) ?? [];
      list.push(e);
      byModule.set(e.module, list);
    }
    for (const [id, list] of byModule) {
      this.modules.get(id)?.load(list);
    }
  }

  renderAll(ctx: PlaybackContext) {
    // 固定绘制顺序：win_map → focus → browser → 光标 → ime
    const order: ModuleId[] = ["win_map", "focus", "browser", "ime", "input"];
    for (const id of order) {
      this.modules.get(id)?.render(ctx);
    }
  }
}

export function parseModuleEventLine(line: string): ModuleEvent | null {
  try {
    const o = JSON.parse(line);
    if (!o || typeof o.ts !== "number" || !o.module || !o.kind) return null;
    return o as ModuleEvent;
  } catch {
    return null;
  }
}
