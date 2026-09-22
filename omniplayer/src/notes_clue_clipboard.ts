/**
 * Clue-board copy/paste helpers. Image bytes are not stored here — only a
 * relative `image` ref (`clue_images/<file>`). History snapshots keep that ref.
 */

export type ClueClipboardNode = {
  id: string;
  text?: string;
  x: number;
  y: number;
  w?: number;
  h?: number;
  color?: string;
  parentId?: string | null;
  collapsed?: boolean;
  kind?: string | null;
  image?: string | null;
  glyphs?: Array<{
    ch: string;
    dt_ms: number;
    deleted?: boolean;
    ts?: number | null;
  }> | null;
};

export type ClueClipboardEdge = {
  id: string;
  from: string;
  to: string;
};

export type ClueClipboardPayload = {
  v: 1;
  nodes: ClueClipboardNode[];
  edges: ClueClipboardEdge[];
};

const IMAGE_REF =
  /^clue_images\/([A-Za-z0-9_-]{1,80})\.(png|jpg|jpeg|gif|webp|bmp)$/i;

/** Safe relative ref under notes/config. Rejects data URLs, absolutes, and `..`. */
export function normalizeClueImageRef(
  raw: string | null | undefined
): string | undefined {
  if (raw == null) return undefined;
  const s = String(raw).trim().replace(/\\/g, "/");
  if (!s || s.length > 180) return undefined;
  if (
    s.includes("..") ||
    s.includes(":") ||
    s.startsWith("/") ||
    s.toLowerCase().startsWith("data:")
  ) {
    return undefined;
  }
  const m = IMAGE_REF.exec(s);
  if (!m) return undefined;
  return `clue_images/${m[1]}.${m[2]!.toLowerCase()}`;
}

export function encodeClueClipboardHtml(payload: ClueClipboardPayload): string {
  const b64 = utf8ToB64(JSON.stringify(payload));
  return `<div data-omnitrace-clue="${b64}"></div>`;
}

export function decodeClueClipboardHtml(html: string): ClueClipboardPayload | null {
  const m = html.match(/data-omnitrace-clue=["']([A-Za-z0-9+/=]+)["']/);
  if (!m?.[1]) return null;
  try {
    const parsed = JSON.parse(b64ToUtf8(m[1])) as ClueClipboardPayload;
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.nodes)) return null;
    if (!Array.isArray(parsed.edges)) parsed.edges = [];
    return parsed;
  } catch {
    return null;
  }
}

export function clueClipboardPlainText(
  nodes: Array<{ text?: string; image?: string | null }>
): string {
  const lines = nodes
    .map((n) => {
      const text = (n.text ?? "").trim();
      if (text) return text;
      if (normalizeClueImageRef(n.image)) return "[image]";
      return "";
    })
    .filter((line) => line.length > 0);
  return lines.join("\n");
}

/**
 * New ids, slight translation, parent/kind/internal edges kept inside the set.
 * Parents and edges that point outside the copied set are dropped.
 */
export function remapCluePaste<
  N extends {
    id: string;
    x: number;
    y: number;
    parentId?: string | null;
  },
  E extends { id: string; from: string; to: string },
>(
  nodes: N[],
  edges: E[],
  opts: {
    dx: number;
    dy: number;
    newNodeId: () => string;
    newEdgeId: () => string;
  }
): { nodes: N[]; edges: E[] } {
  const idMap = new Map<string, string>();
  for (const n of nodes) {
    const id = (n.id ?? "").trim();
    if (!id || idMap.has(id)) continue;
    idMap.set(id, opts.newNodeId());
  }
  const outNodes: N[] = [];
  for (const n of nodes) {
    const id = (n.id ?? "").trim();
    const nid = idMap.get(id);
    if (!nid) continue;
    const parent = (n.parentId ?? "").trim();
    const nextParent = parent && idMap.has(parent) ? idMap.get(parent) : undefined;
    outNodes.push({
      ...n,
      id: nid,
      x: n.x + opts.dx,
      y: n.y + opts.dy,
      parentId: nextParent,
    });
  }
  const outEdges: E[] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    const from = idMap.get(e.from);
    const to = idMap.get(e.to);
    if (!from || !to || from === to) continue;
    const key = `${from}\0${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    outEdges.push({ ...e, id: opts.newEdgeId(), from, to });
  }
  return { nodes: outNodes, edges: outEdges };
}

export type ClueShortcutAction =
  | "ignore"
  | "browser-text"
  | "copy-notes"
  | "paste-board"
  | "paste-field";

/**
 * Ctrl/Cmd+C copies selected notes unless a text field has a character selection
 * (then the browser copies that text). Ctrl/Cmd+V: board paste when not in a field;
 * in a field, keydown arms a paste-field fallback (image attach) while the `paste`
 * event prefers clipboard image on the focused note, else normal text paste.
 */
export function clueShortcutAction(opts: {
  clueMode: boolean;
  mod: boolean;
  key: string;
  fieldFocused: boolean;
  fieldHasCharSelection: boolean;
  selectedNoteCount: number;
}): ClueShortcutAction {
  if (!opts.clueMode || !opts.mod) return "ignore";
  const key = opts.key.toLowerCase();
  if (key === "c") {
    if (opts.fieldFocused && opts.fieldHasCharSelection) return "browser-text";
    if (opts.selectedNoteCount > 0) return "copy-notes";
    return "ignore";
  }
  if (key === "v") {
    if (opts.fieldFocused) return "paste-field";
    return "paste-board";
  }
  return "ignore";
}

/**
 * When focus is in a note body field and the paste payload includes an image,
 * attach that image to the note instead of inserting text (or spawning a card).
 */
export function clueNoteFieldPasteIntent(opts: {
  noteFieldFocused: boolean;
  hasClipboardImage: boolean;
}): "attach-image" | "browser-text" {
  if (opts.noteFieldFocused && opts.hasClipboardImage) return "attach-image";
  return "browser-text";
}

export function isTextEditingField(el: EventTarget | null): boolean {
  if (typeof HTMLTextAreaElement !== "undefined" && el instanceof HTMLTextAreaElement) {
    return !el.readOnly && !el.disabled;
  }
  if (typeof HTMLInputElement !== "undefined" && el instanceof HTMLInputElement) {
    if (el.readOnly || el.disabled) return false;
    const type = (el.type || "text").toLowerCase();
    return ![
      "button",
      "submit",
      "reset",
      "checkbox",
      "radio",
      "file",
      "range",
      "color",
      "image",
    ].includes(type);
  }
  return (
    typeof HTMLElement !== "undefined" &&
    el instanceof HTMLElement &&
    el.isContentEditable
  );
}

/** True only when the focused field has a non-empty character selection. */
export function fieldHasCharacterSelection(el: EventTarget | null): boolean {
  if (
    (typeof HTMLTextAreaElement !== "undefined" && el instanceof HTMLTextAreaElement) ||
    (typeof HTMLInputElement !== "undefined" && el instanceof HTMLInputElement)
  ) {
    const start = el.selectionStart;
    const end = el.selectionEnd;
    return start != null && end != null && start !== end;
  }
  if (
    typeof HTMLElement !== "undefined" &&
    el instanceof HTMLElement &&
    el.isContentEditable
  ) {
    const sel = el.ownerDocument.getSelection();
    if (!sel || sel.isCollapsed) return false;
    const node = sel.anchorNode;
    return !!node && (node === el || el.contains(node));
  }
  return false;
}

function utf8ToB64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function b64ToUtf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}
