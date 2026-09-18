/**
 * 流式笔记色温：击键间隔短偏暖红、长偏冷蓝。
 * 只作用于 composer 与用户气泡（助手回复不变）。引擎来自旧 stream tape。
 */
import {
  hideFloat,
  placeFloatInViewport,
  revealFloat,
} from "./omni_float";
import { shellT } from "./shell_i18n";

export const COLOR_TEMP_STORAGE_KEY = "omnitrace.notes.colorTemp";

const COLOR_DT_WARM_MS = 50;
const COLOR_DT_COLD_MS = 950;
const MAX_GLYPHS = 8000;

export type StreamGlyph = {
  ch: string;
  dtMs: number;
  deleted?: boolean;
  ts?: number;
};

/** 落盘 / IPC 形态（Rust `dt_ms`） */
export type UserGlyphWire = {
  ch: string;
  dt_ms: number;
  deleted?: boolean;
  ts?: number | null;
};

let colorTempOn = readColorTempPref();
let liveGlyphs: StreamGlyph[] = [];
let lastLiveTs = 0;
let composing = false;
let popoverOpen = false;
let popoverOutside: ((e: MouseEvent) => void) | null = null;
let onDisplayChange: (() => void) | null = null;

function $(id: string): HTMLElement | null {
  return document.getElementById(id);
}

export function readColorTempPref(): boolean {
  try {
    const v = localStorage.getItem(COLOR_TEMP_STORAGE_KEY);
    if (v === null) return false;
    return v === "1";
  } catch {
    return false;
  }
}

export function isColorTempOn(): boolean {
  return colorTempOn;
}

export function setColorTempOn(on: boolean) {
  colorTempOn = on;
  try {
    localStorage.setItem(COLOR_TEMP_STORAGE_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
  syncColorTempChrome();
  paintComposerTape();
  onDisplayChange?.();
}

export function normalizeGlyphs(raw: unknown): StreamGlyph[] {
  if (!Array.isArray(raw)) return [];
  const out: StreamGlyph[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const g = item as StreamGlyph & { dt_ms?: number };
    const ch = typeof g.ch === "string" ? g.ch : "";
    if (!ch) continue;
    const dtMs =
      typeof g.dtMs === "number"
        ? g.dtMs
        : typeof g.dt_ms === "number"
          ? g.dt_ms
          : 0;
    out.push({
      ch,
      dtMs: Number.isFinite(dtMs) ? Math.max(0, dtMs) : 0,
      deleted: !!g.deleted,
      ts: typeof g.ts === "number" ? g.ts : undefined,
    });
    if (out.length >= MAX_GLYPHS) break;
  }
  return out;
}

export function glyphsToWire(glyphs: StreamGlyph[]): UserGlyphWire[] {
  return glyphs
    .filter((g) => !g.deleted && g.ch)
    .slice(0, MAX_GLYPHS)
    .map((g) => ({
      ch: g.ch,
      dt_ms: Math.round(g.dtMs),
      deleted: false,
      ts: g.ts ?? null,
    }));
}

function sketchFromGlyphs(glyphs: StreamGlyph[]): string {
  return glyphs.filter((g) => !g.deleted).map((g) => g.ch).join("");
}

function dtToRgb(dtMs: number): string {
  const t = Math.min(
    1,
    Math.max(0, (dtMs - COLOR_DT_WARM_MS) / (COLOR_DT_COLD_MS - COLOR_DT_WARM_MS))
  );
  const r = Math.round(210 - t * 160);
  const g = Math.round(62 + t * 28);
  const b = Math.round(42 + t * 168);
  return `rgb(${r},${g},${b})`;
}

function renderGlyphTapeInto(host: HTMLElement, glyphs: StreamGlyph[]) {
  host.replaceChildren();
  for (const g of glyphs) {
    if (g.deleted) continue;
    const span = document.createElement("span");
    span.className = "temp-ch";
    span.style.color = dtToRgb(g.dtMs);
    span.textContent = g.ch;
    host.appendChild(span);
  }
}

export function fillUserTextEl(
  el: HTMLElement,
  text: string,
  glyphs: unknown
) {
  const list = normalizeGlyphs(glyphs);
  if (!colorTempOn || !list.length) {
    el.classList.remove("notes-temp-tape");
    el.textContent = text;
    return;
  }
  const vis = sketchFromGlyphs(list);
  if (vis !== text) {
    el.classList.remove("notes-temp-tape");
    el.textContent = text;
    return;
  }
  el.classList.add("notes-temp-tape");
  renderGlyphTapeInto(el, list);
}

function syncGlyphsToText(text: string, dtMs: number, now: number) {
  const nextChars = [...text];
  const vis = liveGlyphs.filter((g) => !g.deleted);
  let prefix = 0;
  while (
    prefix < vis.length &&
    prefix < nextChars.length &&
    vis[prefix].ch === nextChars[prefix]
  ) {
    prefix += 1;
  }
  const kept: StreamGlyph[] = vis.slice(0, prefix);
  for (let i = prefix; i < nextChars.length; i++) {
    kept.push({ ch: nextChars[i], dtMs, ts: now });
    if (kept.length >= MAX_GLYPHS) break;
  }
  liveGlyphs = kept;
}

export function onComposerInput() {
  const input = $("notes-input") as HTMLTextAreaElement | null;
  if (!input || composing) return;
  const now = Date.now();
  const dt = lastLiveTs ? now - lastLiveTs : 0;
  lastLiveTs = now;
  syncGlyphsToText(input.value, dt, now);
  paintComposerTape();
}

export function paintComposerTape() {
  const composer = document.querySelector(".notes-composer");
  const input = $("notes-input") as HTMLTextAreaElement | null;
  const tape = $("notes-temp-live");
  composer?.classList.toggle("is-color-temp", colorTempOn);
  composer?.classList.toggle("is-ime", composing);
  if (!tape) return;
  if (!colorTempOn || composing || !input || !input.value) {
    tape.replaceChildren();
    return;
  }
  if (sketchFromGlyphs(liveGlyphs) !== input.value) {
    syncGlyphsToText(input.value, lastLiveTs ? 0 : 0, Date.now());
  }
  renderGlyphTapeInto(tape, liveGlyphs);
  tape.scrollTop = input.scrollTop;
  tape.scrollLeft = input.scrollLeft;
}

export function snapshotGlyphsForSend(text: string): UserGlyphWire[] {
  syncGlyphsToText(text, 0, Date.now());
  return glyphsToWire(liveGlyphs);
}

export function takeGlyphsForSend(text: string): UserGlyphWire[] {
  const wire = snapshotGlyphsForSend(text);
  resetLiveGlyphs();
  paintComposerTape();
  return wire;
}

export function resetLiveGlyphs() {
  liveGlyphs = [];
  lastLiveTs = 0;
}

function syncColorTempChrome() {
  const btn = $("notes-color-temp-btn");
  if (!btn) return;
  btn.setAttribute("aria-pressed", colorTempOn ? "true" : "false");
  btn.classList.toggle("is-active", colorTempOn);
  const title = shellT("notes.colorTemp.btnTitle");
  btn.setAttribute("title", title);
  btn.setAttribute("aria-label", title);
  const pop = $("notes-color-temp-popover");
  if (pop && popoverOpen) renderPopover(pop);
}

function renderPopover(host: HTMLElement) {
  host.replaceChildren();
  const head = document.createElement("div");
  head.className = "notes-mcp-pop-head";
  head.textContent = shellT("notes.colorTemp.title");
  host.appendChild(head);

  const note = document.createElement("p");
  note.className = "notes-fwd-note";
  note.textContent = shellT("notes.colorTemp.desc");
  host.appendChild(note);

  const bar = document.createElement("div");
  bar.className = "notes-temp-legend";
  const fast = document.createElement("span");
  fast.textContent = shellT("notes.colorTemp.legendFast");
  const strip = document.createElement("span");
  strip.className = "notes-temp-legend-bar";
  strip.setAttribute("aria-hidden", "true");
  const slow = document.createElement("span");
  slow.textContent = shellT("notes.colorTemp.legendSlow");
  bar.append(fast, strip, slow);
  host.appendChild(bar);

  const sep = document.createElement("div");
  sep.className = "notes-fwd-sep";
  host.appendChild(sep);

  const row = document.createElement("button");
  row.type = "button";
  row.className = "notes-fwd-toggle-row";
  row.setAttribute("aria-pressed", colorTempOn ? "true" : "false");
  const text = document.createElement("span");
  text.className = "notes-fwd-toggle-text";
  const strong = document.createElement("strong");
  strong.textContent = shellT("notes.colorTemp.toggle");
  const small = document.createElement("small");
  small.textContent = shellT("notes.colorTemp.toggleHint");
  text.append(strong, small);
  const sw = document.createElement("span");
  sw.className = "notes-fwd-switch" + (colorTempOn ? " is-on" : "");
  sw.setAttribute("aria-hidden", "true");
  row.append(text, sw);
  row.addEventListener("click", (e) => {
    e.stopPropagation();
    setColorTempOn(!colorTempOn);
  });
  host.appendChild(row);
}

export function closeColorTempPopover() {
  popoverOpen = false;
  const btn = $("notes-color-temp-btn");
  const pop = $("notes-color-temp-popover");
  btn?.setAttribute("aria-expanded", "false");
  hideFloat(pop);
  if (popoverOutside) {
    document.removeEventListener("click", popoverOutside, true);
    popoverOutside = null;
  }
}

function openPopover(anchor: HTMLElement) {
  let pop = $("notes-color-temp-popover");
  if (!pop) {
    pop = document.createElement("div");
    pop.id = "notes-color-temp-popover";
    pop.className = "notes-params-popover omni-float hidden";
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-hidden", "true");
    document.body.appendChild(pop);
  }
  renderPopover(pop);
  revealFloat(pop);
  placeFloatInViewport(pop, anchor.getBoundingClientRect(), "above", 300);
  popoverOpen = true;
  anchor.setAttribute("aria-expanded", "true");
  if (popoverOutside) {
    document.removeEventListener("click", popoverOutside, true);
  }
  popoverOutside = (e: MouseEvent) => {
    const t = e.target as Element | null;
    if (
      t?.closest?.("#notes-color-temp-popover") ||
      t?.closest?.("#notes-color-temp-btn")
    ) {
      return;
    }
    closeColorTempPopover();
  };
  window.setTimeout(() => {
    document.addEventListener("click", popoverOutside!, true);
  }, 0);
}

function bindComposerField() {
  const input = $("notes-input") as HTMLTextAreaElement | null;
  if (!input) return;
  input.addEventListener("compositionstart", () => {
    composing = true;
    paintComposerTape();
  });
  input.addEventListener("compositionend", () => {
    composing = false;
    onComposerInput();
  });
  input.addEventListener(
    "scroll",
    () => {
      const tape = $("notes-temp-live");
      if (tape) {
        tape.scrollTop = input.scrollTop;
        tape.scrollLeft = input.scrollLeft;
      }
    },
    { passive: true }
  );
}

export function initColorTempUi(opts?: { onDisplayChange?: () => void }) {
  onDisplayChange = opts?.onDisplayChange ?? null;
  colorTempOn = readColorTempPref();
  const btn = $("notes-color-temp-btn");
  if (btn) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (popoverOpen) closeColorTempPopover();
      else openPopover(btn);
    });
  }
  bindComposerField();
  syncColorTempChrome();
  paintComposerTape();
  window.addEventListener("omnitrace-lang", () => syncColorTempChrome());
}

export function closeColorTempPopoverOnLeave() {
  closeColorTempPopover();
}
