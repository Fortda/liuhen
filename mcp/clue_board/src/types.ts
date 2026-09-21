export type ClueNoteKind = "project" | "research";

export interface ClueBoardNode {
  id: string;
  text?: string;
  x: number;
  y: number;
  color?: string | null;
  rotation?: number | null;
  w?: number | null;
  h?: number | null;
  /** Tree parent for expand/collapse. Missing = root. */
  parentId?: string | null;
  /** When true, hide descendants (and edges to them). */
  collapsed?: boolean | null;
  /** Light tag; mixed on one plane for now (not a 2.5D layer). */
  kind?: ClueNoteKind | string | null;
}

export interface ClueBoardEdge {
  id: string;
  from: string;
  to: string;
}

export interface ClueBoardView {
  x: number;
  y: number;
  zoom?: number | null;
}

export interface ClueBoard {
  id: string;
  title?: string;
  nodes: ClueBoardNode[];
  edges: ClueBoardEdge[];
  view?: ClueBoardView | null;
  /** Unix ms. 0/absent = unknown until seeded from history or file mtime. */
  created_at?: number;
  updated_at?: number;
}

export interface ClueBoardsFile {
  v: number;
  active_id: string;
  boards: ClueBoard[];
}

/** Legacy single-board file (`clue_board.json` v1). */
export interface ClueBoardFile {
  v: number;
  nodes: ClueBoardNode[];
  edges: ClueBoardEdge[];
  view?: ClueBoardView | null;
}

export function newBoardId(): string {
  const ts = Date.now();
  const n = (ts ^ (ts >> 11)) & 0xffff;
  return `board_${ts}_${n.toString(16).padStart(4, "0")}`;
}

export function newNodeId(): string {
  const ts = Date.now();
  const n = (ts ^ (ts >> 11)) & 0xffff;
  return `clue_${ts}_${n.toString(16).padStart(4, "0")}`;
}

export function newEdgeId(): string {
  const ts = Date.now();
  const n = (ts ^ (ts >> 11)) & 0xffff;
  return `edge_${ts}_${n.toString(16).padStart(4, "0")}`;
}
