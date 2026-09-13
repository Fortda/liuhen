import { invoke } from "@tauri-apps/api/core";

export type StatusScalarPoint = { ts: number; v: number };
export type StatusWanPoint = {
  ts: number;
  v: number;
  in_bps?: number | null;
  out_bps?: number | null;
  link_mbps?: number | null;
};
export type StatusWanSeries = {
  id: string;
  label: string;
  media: string;
  points: StatusWanPoint[];
};
export type StatusDiskSeries = {
  id: string;
  label: string;
  total_gb: number;
  points: StatusScalarPoint[];
};
export type StatusModuleBucket = { label: string; points: StatusScalarPoint[] };

export type StatusChartsReport = {
  now_ts: number;
  window_start_ts: number;
  recorder_running: boolean;
  body_samples: number;
  wan: StatusWanSeries[];
  cpu: StatusScalarPoint[];
  mem_used_gb: StatusScalarPoint[];
  mem_total_gb: number;
  disk_busy: StatusScalarPoint[];
  /** PhysicalDisk(_Total) 读吞吐 B/s */
  disk_read: StatusScalarPoint[];
  /** PhysicalDisk(_Total) 写吞吐 B/s */
  disk_write: StatusScalarPoint[];
  /** 遗留容量序列；折线主轴已改用 disk_read/write */
  disks: StatusDiskSeries[];
  gpu: StatusScalarPoint[];
  power: StatusScalarPoint[];
  input: StatusScalarPoint[];
  focus_rate: StatusScalarPoint[];
  ime_rate: StatusScalarPoint[];
  module_beats: StatusModuleBucket[];
  note?: string | null;
};

type NetUnit = "MBps" | "Mbps";

const NET_UNIT_KEY = "omnitrace.dash.netUnit";
const LINE_COLORS = [
  "#1f6f5b",
  "#3b6fa0",
  "#c45c5c",
  "#c9a227",
  "#6a7d4e",
  "#b84d6a",
  "#4a7c8c",
  "#8b5a2b",
];

type LineSeries = {
  label: string;
  points: StatusScalarPoint[];
  color: string;
  yMax?: number;
  yOffset?: number;
};

function escapeHtml(s: string) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatClock(ts: number) {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, "0")}:${d
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;
}

function loadNetUnit(): NetUnit {
  try {
    const v = localStorage.getItem(NET_UNIT_KEY);
    if (v === "Mbps" || v === "MBps") return v;
  } catch {
    /* ignore */
  }
  return "MBps";
}

function saveNetUnit(u: NetUnit) {
  try {
    localStorage.setItem(NET_UNIT_KEY, u);
  } catch {
    /* ignore */
  }
}

/** B/s → 显示单位数值 */
function bpsToUnit(bps: number, unit: NetUnit): number {
  if (!Number.isFinite(bps) || bps < 0) return 0;
  if (unit === "Mbps") return (bps * 8) / 1e6;
  return bps / 1e6;
}

function formatRate(bps: number, unit: NetUnit): string {
  const v = bpsToUnit(bps, unit);
  if (v < 0.01) return `0 ${unit === "Mbps" ? "Mbps" : "MB/s"}`;
  if (v < 10) return `${v.toFixed(2)} ${unit === "Mbps" ? "Mbps" : "MB/s"}`;
  return `${v.toFixed(1)} ${unit === "Mbps" ? "Mbps" : "MB/s"}`;
}

function formatGb(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v < 10) return `${v.toFixed(2)} GB`;
  return `${v.toFixed(1)} GB`;
}

function lastPoint(pts: StatusScalarPoint[]): number | null {
  if (!pts.length) return null;
  return pts[pts.length - 1].v;
}

function drawLineChart(
  canvas: HTMLCanvasElement,
  series: LineSeries[],
  windowStart: number,
  windowEnd: number,
  opts?: {
    yUnit?: string;
    yMax?: number;
    fill?: boolean;
    yDecimals?: number;
    staggerFill?: boolean;
  }
) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 640;
  const cssH = canvas.clientHeight || 120;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const padL = 44;
  const padR = 10;
  const padT = 10;
  const padB = 22;
  const plotW = cssW - padL - padR;
  const plotH = cssH - padT - padB;
  const span = Math.max(1, windowEnd - windowStart);

  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = "rgba(250,248,245,0.55)";
  ctx.fillRect(0, 0, cssW, cssH);

  const allY = series.flatMap((s) => s.points.map((p) => p.v + (s.yOffset ?? 0)));
  const maxY =
    opts?.yMax ??
    Math.max(
      ...series.map((s) => s.yMax ?? 0),
      ...allY,
      1
    );

  ctx.strokeStyle = "#e8e4de";
  ctx.fillStyle = "#8a847c";
  ctx.font = '11px "Noto Sans SC", sans-serif';
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  const decimals = opts?.yDecimals ?? 0;
  for (let i = 0; i <= 2; i++) {
    const y = padT + (plotH * i) / 2;
    ctx.beginPath();
    ctx.setLineDash(i === 0 ? [] : [3, 4]);
    ctx.moveTo(padL, y);
    ctx.lineTo(padL + plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);
    const label = maxY * (1 - i / 2);
    const unit = opts?.yUnit ?? "";
    const txt =
      decimals > 0 ? `${label.toFixed(decimals)}${unit}` : `${Math.round(label)}${unit}`;
    ctx.fillText(txt, padL - 4, y);
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText(formatClock(windowStart), padL, padT + plotH + 6);
  ctx.fillText(formatClock(windowEnd), padL + plotW, padT + plotH + 6);

  series.forEach((s, si) => {
    if (!s.points.length) return;
    const color = s.color || LINE_COLORS[si % LINE_COLORS.length];
    const off = s.yOffset ?? 0;
    const pts = [...s.points].sort((a, b) => a.ts - b.ts);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    pts.forEach((p, i) => {
      const x = padL + ((p.ts - windowStart) / span) * plotW;
      const y = padT + plotH * (1 - (p.v + off) / maxY);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    if (opts?.fill || opts?.staggerFill) {
      const last = pts[pts.length - 1];
      const first = pts[0];
      ctx.lineTo(padL + ((last.ts - windowStart) / span) * plotW, padT + plotH);
      ctx.lineTo(padL + ((first.ts - windowStart) / span) * plotW, padT + plotH);
      ctx.closePath();
      ctx.fillStyle = color.length === 7 ? `${color}28` : color;
      ctx.fill();
    }
  });
}

function drawGauge(
  canvas: HTMLCanvasElement,
  value: number,
  max: number,
  color: string,
  label: string
) {
  setGaugeTarget(canvas, value, max, color, label);
}

type GaugeAnim = {
  shown: number;
  target: number;
  max: number;
  color: string;
  label: string;
  raf: number | null;
};

const gaugeAnims = new WeakMap<HTMLCanvasElement, GaugeAnim>();

function setGaugeTarget(
  canvas: HTMLCanvasElement,
  value: number,
  max: number,
  color: string,
  label: string
) {
  const safeMax = max > 0 && Number.isFinite(max) ? max : 1;
  const safeVal = Number.isFinite(value) ? Math.max(0, value) : 0;
  let st = gaugeAnims.get(canvas);
  if (!st) {
    st = {
      shown: safeVal,
      target: safeVal,
      max: safeMax,
      color,
      label,
      raf: null,
    };
    gaugeAnims.set(canvas, st);
    paintGaugeFrame(canvas, st.shown, st.max, st.color, st.label);
    return;
  }
  st.target = safeVal;
  st.max = safeMax;
  st.color = color;
  st.label = label;
  if (st.raf == null) {
    const step = () => {
      const s = gaugeAnims.get(canvas);
      if (!s) return;
      const d = s.target - s.shown;
      const eps = Math.max(0.002 * s.max, 1e-6);
      if (Math.abs(d) < eps) {
        s.shown = s.target;
        s.raf = null;
        paintGaugeFrame(canvas, s.shown, s.max, s.color, s.label);
        return;
      }
      s.shown += d * 0.22;
      paintGaugeFrame(canvas, s.shown, s.max, s.color, s.label);
      s.raf = requestAnimationFrame(step);
    };
    st.raf = requestAnimationFrame(step);
  }
}

/** 角落小仪表：刻度 + 指针 + 当前值；纸本奶油风，不抢折线主位。 */
function paintGaugeFrame(
  canvas: HTMLCanvasElement,
  value: number,
  max: number,
  color: string,
  label: string
) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 76;
  const cssH = canvas.clientHeight || 52;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const cx = cssW * 0.5;
  const cy = cssH * 0.72;
  const r = Math.min(cssW * 0.44, cssH * 0.62);
  const start = Math.PI * 0.85;
  const end = Math.PI * 0.15 + Math.PI * 2;
  const span = end - start;
  const t = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;

  // 底弧
  ctx.lineWidth = 3.5;
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(196, 188, 174, 0.55)";
  ctx.beginPath();
  ctx.arc(cx, cy, r, start, end);
  ctx.stroke();

  // 已走过的弧（淡色）
  if (t > 0.002) {
    ctx.strokeStyle = color.length === 7 ? `${color}55` : color;
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, start + span * t);
    ctx.stroke();
  }

  // 刻度
  const majorN = 4;
  const minorPer = 2;
  for (let i = 0; i <= majorN * minorPer; i++) {
    const u = i / (majorN * minorPer);
    const a = start + span * u;
    const major = i % minorPer === 0;
    const outer = r + 1;
    const inner = r - (major ? 6 : 3.5);
    const cos = Math.cos(a);
    const sin = Math.sin(a);
    ctx.beginPath();
    ctx.strokeStyle = major ? "rgba(60, 52, 42, 0.45)" : "rgba(60, 52, 42, 0.22)";
    ctx.lineWidth = major ? 1.2 : 0.8;
    ctx.lineCap = "butt";
    ctx.moveTo(cx + cos * outer, cy + sin * outer);
    ctx.lineTo(cx + cos * inner, cy + sin * inner);
    ctx.stroke();
  }

  // 指针
  const needleA = start + span * t;
  const tipR = r - 2;
  const hubR = 2.4;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(cx - Math.cos(needleA) * 4, cy - Math.sin(needleA) * 4);
  ctx.lineTo(cx + Math.cos(needleA) * tipR, cy + Math.sin(needleA) * tipR);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cy, hubR, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(250, 248, 245, 0.9)";
  ctx.beginPath();
  ctx.arc(cx, cy, hubR * 0.45, 0, Math.PI * 2);
  ctx.fill();

  // 当前值
  ctx.fillStyle = "#2c2822";
  ctx.font = '600 10px "Noto Sans SC", sans-serif';
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText(label, cx, cy - hubR - 3);
}

function drawBarChart(
  canvas: HTMLCanvasElement,
  points: StatusScalarPoint[],
  windowStart: number,
  windowEnd: number,
  color = "#3d8f7a"
) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 640;
  const cssH = canvas.clientHeight || 100;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const padL = 36;
  const padR = 8;
  const padT = 8;
  const padB = 18;
  const plotW = cssW - padL - padR;
  const plotH = cssH - padT - padB;
  const span = Math.max(1, windowEnd - windowStart);
  const maxY = Math.max(1, ...points.map((p) => p.v));

  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = "rgba(250,248,245,0.55)";
  ctx.fillRect(0, 0, cssW, cssH);

  const bucketMs = 60_000;
  const n = Math.max(1, Math.ceil(span / bucketMs));
  const barW = Math.max(2, (plotW / n) * 0.7);

  points.forEach((p) => {
    const x = padL + ((p.ts - windowStart) / span) * plotW;
    const h = (p.v / maxY) * plotH;
    const y = padT + plotH - h;
    ctx.fillStyle = color;
    ctx.fillRect(x - barW / 2, y, barW, h);
  });
}

function drawModuleBeatBars(canvas: HTMLCanvasElement, modules: StatusModuleBucket[]) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 640;
  const cssH = Math.max(100, modules.length * 26 + 16);
  canvas.style.height = `${cssH}px`;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  ctx.fillStyle = "rgba(250,248,245,0.55)";
  ctx.fillRect(0, 0, cssW, cssH);

  const padL = 100;
  const padR = 12;
  const rowH = 20;
  const gap = 4;
  const plotW = cssW - padL - padR;
  const latest = modules.map((m) => {
    const last = m.points.length ? m.points[m.points.length - 1] : null;
    return { label: m.label, v: last?.v ?? 0 };
  });
  const maxV = Math.max(1, ...latest.map((x) => x.v));

  ctx.font = '12px "Noto Sans SC", sans-serif';
  latest.forEach((m, i) => {
    const y = 10 + i * (rowH + gap);
    ctx.fillStyle = "#5a554f";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(m.label, padL - 8, y + rowH / 2);
    const w = (m.v / maxV) * plotW;
    ctx.fillStyle = LINE_COLORS[i % LINE_COLORS.length];
    ctx.fillRect(padL, y, Math.max(m.v > 0 ? 3 : 0, w), rowH);
    ctx.fillStyle = "#8a847c";
    ctx.textAlign = "left";
    ctx.fillText(String(Math.round(m.v)), padL + w + 6, y + rowH / 2);
  });
}

const EMPTY_STATUS_REPORT = (): StatusChartsReport => {
  const now = Date.now();
  return {
    now_ts: now,
    window_start_ts: now - 30 * 60_000,
    recorder_running: false,
    body_samples: 0,
    wan: [],
    cpu: [],
    mem_used_gb: [],
    mem_total_gb: 0,
    disk_busy: [],
    disk_read: [],
    disk_write: [],
    disks: [],
    gpu: [],
    power: [],
    input: [],
    focus_rate: [],
    ime_rate: [],
    module_beats: [],
    note: null,
  };
};

export async function fetchStatusCharts(windowMinutes = 30): Promise<StatusChartsReport> {
  try {
    const report = await invoke<StatusChartsReport>("dashboard_status_charts", {
      windowMinutes,
    });
    if (!report || typeof report.now_ts !== "number") return EMPTY_STATUS_REPORT();
    // 兼容旧字段名
    const any = report as StatusChartsReport & { mem_pct?: StatusScalarPoint[] };
    if (!any.mem_used_gb && any.mem_pct) {
      any.mem_used_gb = [];
      any.mem_total_gb = 0;
    }
    if (!any.disks) any.disks = [];
    if (!any.disk_busy) any.disk_busy = [];
    if (!any.disk_read) any.disk_read = [];
    if (!any.disk_write) any.disk_write = [];
    if (!any.gpu) any.gpu = [];
    return any;
  } catch {
    return EMPTY_STATUS_REPORT();
  }
}

function slotHtml(opts: {
  id: string;
  title: string;
  hint: string;
  gaugeId: string;
  canvasId: string;
  canvasH?: number;
  extraHead?: string;
  legendId?: string;
  hidden?: boolean;
}): string {
  const h = opts.canvasH ?? 110;
  return `
    <article class="chassis-slot" id="slot-${opts.id}"${opts.hidden ? " hidden" : ""}>
      <div class="chassis-slot-head">
        <h3>${escapeHtml(opts.title)}</h3>
        <div class="chassis-slot-tools">
          ${opts.extraHead ?? ""}
          <span class="hint">${escapeHtml(opts.hint)}</span>
        </div>
      </div>
      <div class="chassis-slot-body">
        <canvas id="${opts.gaugeId}" class="chassis-gauge" width="76" height="52"></canvas>
        <div class="chassis-spark-wrap">
          ${opts.legendId ? `<div id="${opts.legendId}" class="status-legend"></div>` : ""}
          <canvas id="${opts.canvasId}" class="chassis-spark" style="height:${h}px"></canvas>
        </div>
      </div>
    </article>`;
}

export function buildStatusChartsHtml(report: StatusChartsReport): string {
  const unit = loadNetUnit();
  const note = report.note
    ? `<p class="dash-caliber-hint status-note">${escapeHtml(report.note)}</p>`
    : `<p class="dash-caliber-hint status-note muted">网卡为整机吞吐（In+Out octets 差分）；非抓包、非逐进程。磁盘折线=整机读/写 Bytes/sec（PhysicalDisk _Total），非已用容量。</p>`;

  const netToggle = `
    <div class="unit-toggle" role="group" aria-label="网络单位">
      <button type="button" class="unit-btn${unit === "MBps" ? " active" : ""}" data-net-unit="MBps">MB/s</button>
      <button type="button" class="unit-btn${unit === "Mbps" ? " active" : ""}" data-net-unit="Mbps">Mbps</button>
    </div>`;

  const hasPower = report.power.length > 0;
  const hasGpu = report.gpu.length > 0;

  return `
    ${note}
    <div class="chassis-board" id="dash-status-chassis">
      <svg class="chassis-frame" viewBox="0 0 720 420" aria-hidden="true">
        <rect x="24" y="16" width="672" height="388" rx="18" fill="none" stroke="currentColor" stroke-opacity="0.18" stroke-width="2"/>
        <rect x="48" y="40" width="200" height="150" rx="10" fill="currentColor" fill-opacity="0.04" stroke="currentColor" stroke-opacity="0.12"/>
        <rect x="268" y="40" width="200" height="150" rx="10" fill="currentColor" fill-opacity="0.04" stroke="currentColor" stroke-opacity="0.12"/>
        <rect x="488" y="40" width="184" height="150" rx="10" fill="currentColor" fill-opacity="0.04" stroke="currentColor" stroke-opacity="0.12"/>
        <rect x="48" y="210" width="310" height="160" rx="10" fill="currentColor" fill-opacity="0.04" stroke="currentColor" stroke-opacity="0.12"/>
        <rect x="378" y="210" width="294" height="160" rx="10" fill="currentColor" fill-opacity="0.04" stroke="currentColor" stroke-opacity="0.12"/>
        <text x="58" y="58" font-size="11" fill="currentColor" fill-opacity="0.35">CPU</text>
        <text x="278" y="58" font-size="11" fill="currentColor" fill-opacity="0.35">RAM</text>
        <text x="498" y="58" font-size="11" fill="currentColor" fill-opacity="0.35">GPU / PSU</text>
        <text x="58" y="228" font-size="11" fill="currentColor" fill-opacity="0.35">DISK</text>
        <text x="388" y="228" font-size="11" fill="currentColor" fill-opacity="0.35">NIC</text>
      </svg>
      <div class="chassis-slots">
        ${slotHtml({
          id: "cpu",
          title: "CPU",
          hint: "利用率 %",
          gaugeId: "dash-gauge-cpu",
          canvasId: "dash-status-cpu",
        })}
        ${slotHtml({
          id: "mem",
          title: "内存",
          hint: "已用 GB",
          gaugeId: "dash-gauge-mem",
          canvasId: "dash-status-mem",
        })}
        ${slotHtml({
          id: "gpu",
          title: "GPU",
          hint: "NVML 利用率",
          gaugeId: "dash-gauge-gpu",
          canvasId: "dash-status-gpu",
          hidden: !hasGpu,
        })}
        ${slotHtml({
          id: "power",
          title: "整机功率",
          hint: "W",
          gaugeId: "dash-gauge-power",
          canvasId: "dash-status-power",
          hidden: !hasPower,
        })}
        ${slotHtml({
          id: "disk",
          title: "磁盘",
          hint: "读写 MB/s",
          gaugeId: "dash-gauge-disk",
          canvasId: "dash-status-disk",
          canvasH: 130,
          legendId: "dash-status-disk-legend",
        })}
        ${slotHtml({
          id: "wan",
          title: "网络吞吐",
          hint: "整机 In+Out",
          gaugeId: "dash-gauge-wan",
          canvasId: "dash-status-wan",
          canvasH: 140,
          legendId: "dash-status-wan-legend",
          extraHead: netToggle,
        })}
      </div>
    </div>
    <div class="stats-grid status-grid status-aux">
      <article class="chart-card">
        <div class="chart-card-head"><h3>键鼠活跃</h3><span class="hint">次/分钟</span></div>
        <canvas id="dash-status-input" class="chart-card-canvas" style="height:120px"></canvas>
      </article>
      <article class="chart-card">
        <div class="chart-card-head"><h3>焦点切换</h3><span class="hint">次/分钟</span></div>
        <canvas id="dash-status-focus" class="chart-card-canvas" style="height:120px"></canvas>
      </article>
      <article class="chart-card">
        <div class="chart-card-head"><h3>输入法上屏</h3><span class="hint">次/分钟</span></div>
        <canvas id="dash-status-ime" class="chart-card-canvas" style="height:120px"></canvas>
      </article>
      <article class="chart-card wide">
        <div class="chart-card-head"><h3>模组心跳</h3><span class="hint">最近一分钟 beat</span></div>
        <canvas id="dash-status-modules" class="chart-card-canvas"></canvas>
      </article>
    </div>
  `;
}

type HostWithStatus = HTMLElement & {
  __netUnitBound?: boolean;
  __statusReport?: StatusChartsReport;
};

function bindNetUnitToggle(host: HTMLElement) {
  const h = host as HostWithStatus;
  if (h.__netUnitBound) return;
  h.__netUnitBound = true;
  host.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement | null)?.closest?.("[data-net-unit]") as
      | HTMLElement
      | null;
    if (!btn || !host.contains(btn)) return;
    const u = btn.dataset.netUnit as NetUnit;
    if (u !== "MBps" && u !== "Mbps") return;
    saveNetUnit(u);
    host.querySelectorAll("[data-net-unit]").forEach((b) => {
      b.classList.toggle("active", (b as HTMLElement).dataset.netUnit === u);
    });
    const rep = h.__statusReport;
    if (rep) paintStatusCharts(host, rep);
  });
}

export function paintStatusCharts(host: HTMLElement, report: StatusChartsReport) {
  if (!report || typeof report.now_ts !== "number") return;
  (host as HostWithStatus).__statusReport = report;
  const winStart = report.window_start_ts ?? report.now_ts - 30 * 60_000;
  const winEnd = report.now_ts;
  const mins = Math.round((winEnd - winStart) / 60_000);
  const unit = loadNetUnit();

  // CPU
  const cpuLast = lastPoint(report.cpu) ?? 0;
  const cpuGauge = host.querySelector("#dash-gauge-cpu") as HTMLCanvasElement | null;
  if (cpuGauge) drawGauge(cpuGauge, cpuLast, 100, "#1f6f5b", `${Math.round(cpuLast)}%`);
  const cpuCanvas = host.querySelector("#dash-status-cpu") as HTMLCanvasElement | null;
  if (cpuCanvas && report.cpu.length) {
    drawLineChart(
      cpuCanvas,
      [{ label: "CPU", points: report.cpu, color: "#1f6f5b", yMax: 100 }],
      winStart,
      winEnd,
      { yUnit: "%", yMax: 100, fill: true }
    );
  }

  // Memory GB
  const memLast = lastPoint(report.mem_used_gb) ?? 0;
  const memTotal = report.mem_total_gb || Math.max(memLast, 1);
  const memGauge = host.querySelector("#dash-gauge-mem") as HTMLCanvasElement | null;
  if (memGauge) drawGauge(memGauge, memLast, memTotal, "#3b6fa0", formatGb(memLast));
  const memCanvas = host.querySelector("#dash-status-mem") as HTMLCanvasElement | null;
  if (memCanvas && report.mem_used_gb.length) {
    drawLineChart(
      memCanvas,
      [
        {
          label: "已用",
          points: report.mem_used_gb,
          color: "#3b6fa0",
          yMax: memTotal,
        },
      ],
      winStart,
      winEnd,
      { yUnit: "G", yMax: memTotal, fill: true, yDecimals: 1 }
    );
  }

  // GPU
  const gpuSlot = host.querySelector("#slot-gpu") as HTMLElement | null;
  if (gpuSlot) gpuSlot.hidden = report.gpu.length === 0;
  if (report.gpu.length) {
    const gLast = lastPoint(report.gpu) ?? 0;
    const gGauge = host.querySelector("#dash-gauge-gpu") as HTMLCanvasElement | null;
    if (gGauge) drawGauge(gGauge, gLast, 100, "#b84d6a", `${Math.round(gLast)}%`);
    const gCanvas = host.querySelector("#dash-status-gpu") as HTMLCanvasElement | null;
    if (gCanvas) {
      drawLineChart(
        gCanvas,
        [{ label: "GPU", points: report.gpu, color: "#b84d6a", yMax: 100 }],
        winStart,
        winEnd,
        { yUnit: "%", yMax: 100, fill: true }
      );
    }
  }

  // Power
  const powerSlot = host.querySelector("#slot-power") as HTMLElement | null;
  if (powerSlot) powerSlot.hidden = report.power.length === 0;
  if (report.power.length) {
    const pLast = lastPoint(report.power) ?? 0;
    const pMax = Math.max(pLast * 1.2, 50);
    const pGauge = host.querySelector("#dash-gauge-power") as HTMLCanvasElement | null;
    if (pGauge) drawGauge(pGauge, pLast, pMax, "#c9a227", `${Math.round(pLast)} W`);
    const pCanvas = host.querySelector("#dash-status-power") as HTMLCanvasElement | null;
    if (pCanvas) {
      drawLineChart(
        pCanvas,
        [{ label: "功率", points: report.power, color: "#c9a227" }],
        winStart,
        winEnd,
        { yUnit: "W" }
      );
    }
  }

  // Disks — read / write throughput (B/s → MB/s)
  const diskLegend = host.querySelector("#dash-status-disk-legend");
  if (diskLegend) {
    diskLegend.innerHTML = [
      `<span class="status-legend-item"><i style="background:#6a7d4e"></i>读取</span>`,
      `<span class="status-legend-item"><i style="background:#8b5a2b"></i>写入</span>`,
    ].join("");
  }
  const diskReadLast = lastPoint(report.disk_read) ?? 0;
  const diskWriteLast = lastPoint(report.disk_write) ?? 0;
  const diskIoLast = diskReadLast + diskWriteLast;
  const dGauge = host.querySelector("#dash-gauge-disk") as HTMLCanvasElement | null;
  if (dGauge) {
    const display = bpsToUnit(diskIoLast, "MBps");
    const gMax = Math.max(display * 1.4, 1);
    drawGauge(dGauge, display, gMax, "#6a7d4e", formatRate(diskIoLast, "MBps"));
  }
  const diskCanvas = host.querySelector("#dash-status-disk") as HTMLCanvasElement | null;
  if (diskCanvas) {
    const hasRw = report.disk_read.length > 0 || report.disk_write.length > 0;
    if (hasRw) {
      const series: LineSeries[] = [
        {
          label: "读取",
          color: "#6a7d4e",
          points: report.disk_read.map((p) => ({ ts: p.ts, v: bpsToUnit(p.v, "MBps") })),
        },
        {
          label: "写入",
          color: "#8b5a2b",
          points: report.disk_write.map((p) => ({ ts: p.ts, v: bpsToUnit(p.v, "MBps") })),
        },
      ];
      const yMax = Math.max(
        0.1,
        ...series.flatMap((s) => s.points.map((p) => p.v))
      );
      drawLineChart(diskCanvas, series, winStart, winEnd, {
        yUnit: "",
        yMax: yMax * 1.15,
        yDecimals: yMax < 5 ? 2 : 1,
        fill: true,
      });
    } else if (report.disk_busy.length) {
      // 旧 body 尚无 R/W 字段时：暂用 busy% 占位，避免空白
      drawLineChart(
        diskCanvas,
        [{ label: "busy%", points: report.disk_busy, color: "#6a7d4e", yMax: 100 }],
        winStart,
        winEnd,
        { yUnit: "%", yMax: 100, fill: true }
      );
      if (diskLegend) {
        diskLegend.innerHTML = `<span class="status-legend-item"><i style="background:#6a7d4e"></i>busy%（待新版 body 落盘 R/W）</span>`;
      }
      if (dGauge) {
        const busy = lastPoint(report.disk_busy) ?? 0;
        drawGauge(dGauge, busy, 100, "#6a7d4e", `${Math.round(busy)}%`);
      }
    }
  }

  // WAN throughput
  const wanLegend = host.querySelector("#dash-status-wan-legend");
  if (wanLegend) {
    wanLegend.innerHTML = report.wan
      .map(
        (s, i) =>
          `<span class="status-legend-item"><i style="background:${LINE_COLORS[i % LINE_COLORS.length]}"></i>${escapeHtml(s.label)} <span class="muted">${s.media}</span></span>`
      )
      .join("");
  }
  let wanLastBps = 0;
  report.wan.forEach((s) => {
    const last = s.points.length ? s.points[s.points.length - 1].v : 0;
    wanLastBps += last;
  });
  const wGauge = host.querySelector("#dash-gauge-wan") as HTMLCanvasElement | null;
  if (wGauge) {
    const display = bpsToUnit(wanLastBps, unit);
    const gMax = Math.max(display * 1.4, unit === "Mbps" ? 10 : 1);
    drawGauge(wGauge, display, gMax, "#4a7c8c", formatRate(wanLastBps, unit));
  }
  const wanCanvas = host.querySelector("#dash-status-wan") as HTMLCanvasElement | null;
  if (wanCanvas) {
    if (report.wan.length) {
      const series: LineSeries[] = report.wan.map((s, i) => ({
        label: s.label,
        color: LINE_COLORS[i % LINE_COLORS.length],
        points: s.points.map((p) => ({ ts: p.ts, v: bpsToUnit(p.v, unit) })),
      }));
      const yMax = Math.max(1, ...series.flatMap((s) => s.points.map((p) => p.v)), 0.1);
      drawLineChart(wanCanvas, series, winStart, winEnd, {
        yUnit: unit === "Mbps" ? "" : "",
        yMax: yMax * 1.15,
        yDecimals: yMax < 5 ? 2 : 1,
        fill: true,
      });
    } else {
      const ctx = wanCanvas.getContext("2d");
      if (ctx) ctx.clearRect(0, 0, wanCanvas.width, wanCanvas.height);
    }
  }

  const inputCanvas = host.querySelector("#dash-status-input") as HTMLCanvasElement | null;
  if (inputCanvas && report.input.length) {
    drawBarChart(inputCanvas, report.input, winStart, winEnd, "rgba(56, 168, 220, 0.75)");
  }
  const focusCanvas = host.querySelector("#dash-status-focus") as HTMLCanvasElement | null;
  if (focusCanvas && report.focus_rate.length) {
    drawBarChart(focusCanvas, report.focus_rate, winStart, winEnd, "#3d8f7a");
  }
  const imeCanvas = host.querySelector("#dash-status-ime") as HTMLCanvasElement | null;
  if (imeCanvas && report.ime_rate.length) {
    drawBarChart(imeCanvas, report.ime_rate, winStart, winEnd, "#c46b3a");
  }
  const modCanvas = host.querySelector("#dash-status-modules") as HTMLCanvasElement | null;
  if (modCanvas) drawModuleBeatBars(modCanvas, report.module_beats);

  const meta = document.querySelector("#dash-status-meta");
  if (meta) {
    const rec = report.recorder_running ? "采集中" : "未采集";
    meta.textContent = `${rec} · 近 ${mins} 分钟 · body 样本 ${report.body_samples}`;
  }

  bindNetUnitToggle(host);
}
