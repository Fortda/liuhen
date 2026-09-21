import type {
  ClueBoard,
  ClueBoardEdge,
  ClueBoardFile,
  ClueBoardNode,
  ClueBoardsFile,
  ClueBoardView,
} from "./types.js";
import { newBoardId } from "./types.js";

function normalizeClueView(view: ClueBoardView | null | undefined): void {
  if (!view) return;
  if (!Number.isFinite(view.x)) view.x = 0;
  if (!Number.isFinite(view.y)) view.y = 0;
  view.x = Math.min(50000, Math.max(-50000, view.x));
  view.y = Math.min(50000, Math.max(-50000, view.y));
  if (view.zoom != null) {
    view.zoom = Number.isFinite(view.zoom)
      ? Math.min(2, Math.max(0.25, view.zoom))
      : 1;
  }
}

export function normalizeClueNodesEdges(
  nodes: ClueBoardNode[],
  edges: ClueBoardEdge[],
): { nodes: ClueBoardNode[]; edges: ClueBoardEdge[] } {
  const outNodes: ClueBoardNode[] = [];
  const seenIds = new Set<string>();

  for (let n of nodes) {
    n = { ...n, id: n.id.trim() };
    if (!n.id || n.id.length > 128 || seenIds.has(n.id)) continue;
    seenIds.add(n.id);
    if (!Number.isFinite(n.x)) n.x = 0;
    if (!Number.isFinite(n.y)) n.y = 0;
    if (n.text && n.text.length > 4000) n.text = n.text.slice(0, 4000);
    if (n.color && n.color.length > 32) n.color = [...n.color].slice(0, 32).join("");
    n.rotation = undefined;
    // Match UI clampSize (CLUE_MIN/MAX_W/H): clamp finite sizes; never drop on reload.
    if (n.w != null) {
      n.w = Number.isFinite(n.w) ? Math.min(1600, Math.max(120, n.w)) : undefined;
    }
    if (n.h != null) {
      n.h = Number.isFinite(n.h) ? Math.min(1200, Math.max(72, n.h)) : undefined;
    }
    const aliasedParent = (n as ClueBoardNode & { parent_id?: string | null })
      .parent_id;
    const parentRaw = (n.parentId ?? aliasedParent ?? "").trim();
    n.parentId = parentRaw || undefined;
    n.collapsed = n.collapsed === true ? true : undefined;
    const kind = normalizeClueKind(n.kind);
    n.kind = kind;
    const image = normalizeClueImageRef(n.image);
    if (image) n.image = image;
    else delete n.image;
    outNodes.push(n);
  }
  if (outNodes.length > 500) outNodes.length = 500;
  sanitizeClueParents(outNodes);

  const nodeIds = new Set(outNodes.map((n) => n.id));
  const outEdges: ClueBoardEdge[] = [];
  const seenEdges = new Set<string>();

  for (let e of edges) {
    e = {
      ...e,
      id: e.id.trim(),
      from: e.from.trim(),
      to: e.to.trim(),
    };
    if (!e.id || !e.from || !e.to || e.from === e.to) continue;
    if (!nodeIds.has(e.from) || !nodeIds.has(e.to)) continue;
    if (e.id.length > 128) e.id = e.id.slice(0, 128);
    const key = `${e.from}\0${e.to}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    outEdges.push(e);
    if (outEdges.length >= 2000) break;
  }

  return { nodes: outNodes, edges: outEdges };
}

export function normalizeClueKind(
  raw: string | null | undefined,
): "project" | "research" | undefined {
  const k = (raw ?? "").trim().toLowerCase();
  if (k === "project" || k === "research") return k;
  return undefined;
}

const CLUE_IMAGE_REF =
  /^clue_images\/([A-Za-z0-9_-]{1,80})\.(png|jpg|jpeg|gif|webp|bmp)$/i;

/** `clue_images/<file>` only. Drops data URLs, absolutes, and `..`. */
export function normalizeClueImageRef(
  raw: string | null | undefined,
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
  const m = CLUE_IMAGE_REF.exec(s);
  if (!m) return undefined;
  return `clue_images/${m[1]}.${m[2]!.toLowerCase()}`;
}

export function clueParentWouldCycle(
  nodes: ClueBoardNode[],
  nodeId: string,
  parentId: string,
): boolean {
  if (!parentId || parentId === nodeId) return true;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let cur: string | undefined = parentId;
  const seen = new Set<string>([nodeId]);
  while (cur) {
    if (seen.has(cur)) return true;
    seen.add(cur);
    const p: string | undefined = byId.get(cur)?.parentId?.trim() || undefined;
    cur = p;
  }
  return false;
}

export function applyClueGroupFields(
  nodes: ClueBoardNode[],
  node: ClueBoardNode,
  opts: {
    parentId?: string | null;
    collapsed?: boolean | null;
    kind?: string | null;
  },
): void {
  if (opts.parentId !== undefined) {
    const pid = (opts.parentId ?? "").trim();
    if (!pid) {
      node.parentId = undefined;
    } else {
      if (pid === node.id) throw new Error("parent cannot be self");
      if (!nodes.some((n) => n.id === pid)) {
        throw new Error(`parent not found: ${pid}`);
      }
      const probe = nodes.map((n) =>
        n.id === node.id ? { ...node, parentId: pid } : n,
      );
      if (!probe.some((n) => n.id === node.id)) {
        probe.push({ ...node, parentId: pid });
      }
      if (clueParentWouldCycle(probe, node.id, pid)) {
        throw new Error(`parent would create a cycle: ${pid}`);
      }
      node.parentId = pid;
    }
  }
  if (opts.collapsed !== undefined && opts.collapsed !== null) {
    node.collapsed = opts.collapsed ? true : undefined;
  }
  if (opts.kind !== undefined) {
    if (!opts.kind) {
      node.kind = undefined;
    } else {
      const k = normalizeClueKind(opts.kind);
      if (!k) throw new Error('kind must be "project" or "research"');
      node.kind = k;
    }
  }
}

function sanitizeClueParents(nodes: ClueBoardNode[]): void {
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) {
    const p = (n.parentId ?? "").trim();
    if (!p || p === n.id || !ids.has(p)) {
      n.parentId = undefined;
    } else {
      n.parentId = p;
    }
  }
  for (const n of nodes) {
    const p = n.parentId;
    if (p && clueParentWouldCycle(nodes, n.id, p)) {
      n.parentId = undefined;
    }
  }
}

function normalizeClueBoardEntry(board: ClueBoard): ClueBoard | null {
  let title = (board.title ?? "").trim();
  if (title.length > 120) title = title.slice(0, 120);
  const b: ClueBoard = {
    ...board,
    id: board.id.trim(),
    title,
  };
  if (!b.id || b.id.length > 128) return null;
  const { nodes, edges } = normalizeClueNodesEdges(b.nodes ?? [], b.edges ?? []);
  b.nodes = nodes;
  b.edges = edges;
  if (b.view) normalizeClueView(b.view);
  return b;
}

function defaultClueBoards(): ClueBoardsFile {
  const id = newBoardId();
  const now = Date.now();
  return {
    v: 2,
    active_id: id,
    boards: [
      {
        id,
        title: "",
        nodes: [],
        edges: [],
        view: null,
        created_at: now,
        updated_at: now,
      },
    ],
  };
}

export function normalizeClueBoards(data: ClueBoardsFile): ClueBoardsFile {
  const out: ClueBoardsFile = { ...data, v: 2, boards: [] };
  const seenIds = new Set<string>();

  for (const b of data.boards ?? []) {
    const nb = normalizeClueBoardEntry(b);
    if (nb && !seenIds.has(nb.id)) {
      seenIds.add(nb.id);
      out.boards.push(nb);
    }
  }
  if (out.boards.length > 100) out.boards.length = 100;
  if (out.boards.length === 0) return defaultClueBoards();

  out.active_id = (data.active_id ?? "").trim();
  if (!out.boards.some((b) => b.id === out.active_id)) {
    out.active_id = out.boards[0]!.id;
  }
  return out;
}

function normalizeLegacyBoard(board: ClueBoardFile): ClueBoardFile {
  const b: ClueBoardFile = { ...board, v: 1 };
  const { nodes, edges } = normalizeClueNodesEdges(b.nodes ?? [], b.edges ?? []);
  b.nodes = nodes;
  b.edges = edges;
  if (b.view) normalizeClueView(b.view);
  return b;
}

function legacyBoardToBoards(legacy: ClueBoardFile): ClueBoardsFile {
  const b = normalizeLegacyBoard(legacy);
  const id = newBoardId();
  return {
    v: 2,
    active_id: id,
    boards: [
      {
        id,
        title: "",
        nodes: b.nodes,
        edges: b.edges,
        view: b.view ?? null,
      },
    ],
  };
}

export function parseClueBoardsRaw(raw: string): ClueBoardsFile | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (
      parsed &&
      typeof parsed === "object" &&
      Array.isArray((parsed as ClueBoardsFile).boards) &&
      (parsed as ClueBoardsFile).boards.length > 0
    ) {
      return normalizeClueBoards(parsed as ClueBoardsFile);
    }
    if (parsed && typeof parsed === "object" && "nodes" in parsed) {
      return legacyBoardToBoards(parsed as ClueBoardFile);
    }
  } catch {
    /* ignore */
  }
  return null;
}

export function findBoard(
  data: ClueBoardsFile,
  boardId?: string | null,
): ClueBoard | undefined {
  const id = (boardId ?? data.active_id ?? "").trim();
  if (id) {
    const found = data.boards.find((b) => b.id === id);
    if (found) return found;
  }
  return data.boards[0];
}
