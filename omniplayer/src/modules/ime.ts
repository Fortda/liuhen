import type {
  ModuleEvent,
  PlaybackContext,
  PlaybackModule,
  PlaybackModuleInfo,
} from "./types";

type ImeCandidate = {
  text: string;
  comment?: string;
  label?: string;
};

type ComposePayload = {
  preedit?: string;
  sel_start?: number;
  sel_end?: number;
  cursor?: number;
  highlighted?: number;
  page?: number;
  total_pages?: number;
  last_page?: boolean;
  caret?: number[];
  cand_visible?: boolean;
  composing?: boolean;
  ascii_mode?: boolean;
  schema_id?: string;
  layout?: string;
  candidates?: ImeCandidate[];
};

export class ImePlaybackModule implements PlaybackModule {
  private frames: ModuleEvent[] = [];

  info(): PlaybackModuleInfo {
    return {
      id: "ime",
      name: "IME",
      version: "0.1.0",
      description: "按当时可见页重画组字条和候选窗（不抄皮肤像素）",
      kinds: ["compose_update", "commit", "module_hello"],
    };
  }

  load(events: ModuleEvent[]) {
    this.frames = events
      .filter((e) => e.kind === "compose_update")
      .sort((a, b) => a.ts - b.ts);
  }

  append(events: ModuleEvent[]) {
    for (const e of events) {
      if (e.kind === "compose_update") this.frames.push(e);
    }
    this.frames.sort((a, b) => a.ts - b.ts);
  }

  exportEvents(): ModuleEvent[] {
    return this.frames.slice();
  }

  latestEventTs(): number {
    if (!this.frames.length) return 0;
    return this.frames[this.frames.length - 1].ts;
  }

  render(p: PlaybackContext): boolean {
    let active: ModuleEvent | null = null;
    for (const e of this.frames) {
      if (e.ts <= p.currentTime) active = e;
      else break;
    }
    if (!active) return false;
    const pl = active.payload as ComposePayload;
    if (pl.ascii_mode && !pl.composing && !pl.cand_visible) return false;
    const cands = Array.isArray(pl.candidates) ? pl.candidates : [];
    const preedit = String(pl.preedit || "");
    if (!pl.composing && !pl.cand_visible && !preedit && !cands.length) return false;

    const { ctx, scale, virtualScreen } = p;
    const caret = Array.isArray(pl.caret) ? pl.caret : [];
    let x = Number(caret[0]);
    let y = Number(caret[1]) + Math.max(0, Number(caret[3]) || 0);
    if (!Number.isFinite(x) || !Number.isFinite(y) || (x === 0 && y === 0)) {
      x = 80;
      y = 80;
    }

    const vertical = String(pl.layout || "vertical").startsWith("vertical");
    const rowH = 22;
    const pad = 8;
    const fontPx = Math.max(12, 13 / Math.max(scale, 0.5));
    ctx.save();
    ctx.font = `500 ${fontPx}px "Noto Sans SC", "Microsoft YaHei", "Segoe UI", sans-serif`;
    ctx.textBaseline = "middle";

    const hi = Number(pl.highlighted) || 0;
    const candLabels = cands.map((c, i) => {
      const lab = String(c.label || `${i + 1}.`);
      const extra = c.comment ? `  ${c.comment}` : "";
      return `${lab} ${c.text || ""}${extra}`;
    });

    let boxW: number;
    let boxH: number;
    if (vertical) {
      let maxW = preedit ? ctx.measureText(preedit).width : 0;
      for (const s of candLabels) maxW = Math.max(maxW, ctx.measureText(s).width);
      boxW = Math.max(140, maxW + pad * 2);
      boxH = (preedit ? rowH : 0) + candLabels.length * rowH + pad;
    } else {
      const candW = candLabels.reduce((w, s) => w + ctx.measureText(s).width + pad * 2, 0);
      const preW = preedit ? ctx.measureText(preedit).width + pad * 2 : 0;
      boxW = Math.max(160, preW, candW);
      boxH = (preedit ? rowH : 0) + (candLabels.length ? rowH : 0) + pad;
    }

    const vw = virtualScreen?.width || 1920;
    const vh = virtualScreen?.height || 1080;
    if (x + boxW > vw) x = Math.max(0, vw - boxW - 4);
    if (y + boxH > vh) y = Math.max(0, vh - boxH - 4);

    ctx.fillStyle = "rgba(32, 34, 40, 0.92)";
    ctx.fillRect(x, y, boxW, boxH);
    ctx.strokeStyle = "rgba(220, 220, 220, 0.55)";
    ctx.lineWidth = 1 / scale;
    ctx.strokeRect(x + 0.5 / scale, y + 0.5 / scale, boxW, boxH);

    let yCursor = y + pad / 2;
    if (preedit) {
      ctx.fillStyle = "#f4e4b0";
      ctx.fillText(preedit, x + pad, yCursor + rowH / 2);
      yCursor += rowH;
    }

    if (vertical) {
      candLabels.forEach((s, i) => {
        if (i === hi) {
          ctx.fillStyle = "rgba(80, 140, 220, 0.45)";
          ctx.fillRect(x + 2, yCursor, boxW - 4, rowH);
        }
        ctx.fillStyle = "#f2f2f2";
        ctx.fillText(s, x + pad, yCursor + rowH / 2);
        yCursor += rowH;
      });
    } else {
      let xCursor = x + pad;
      candLabels.forEach((s, i) => {
        const w = ctx.measureText(s).width + pad;
        if (i === hi) {
          ctx.fillStyle = "rgba(80, 140, 220, 0.45)";
          ctx.fillRect(xCursor - 4, yCursor, w + 4, rowH);
        }
        ctx.fillStyle = "#f2f2f2";
        ctx.fillText(s, xCursor, yCursor + rowH / 2);
        xCursor += w + pad;
      });
    }
    ctx.restore();
    return true;
  }
}
