import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import { dirname } from "node:path";
import type { ClueBoard, ClueBoardEdge, ClueBoardNode, ClueBoardView } from "./types.js";
import { clueHistoryPath, ensureNotesConfigDir } from "./paths.js";
import { findBoard } from "./normalize.js";
import { readClueBoards, withClueBoards } from "./store.js";

export type ClueHistoryActor = "human" | "ai";

export interface ClueHistorySnapshot {
  title: string;
  nodes: ClueBoardNode[];
  edges: ClueBoardEdge[];
  view?: ClueBoardView | null;
}

export interface ClueHistoryEntry {
  v: number;
  seq: number;
  ts: number;
  actor: ClueHistoryActor;
  action: string;
  tool?: string;
  label_key?: string;
  rollback_to_seq?: number;
  snapshot: ClueHistorySnapshot;
}

function snapshotFromBoard(board: ClueBoard): ClueHistorySnapshot {
  return {
    title: board.title ?? "",
    nodes: structuredClone(board.nodes),
    edges: structuredClone(board.edges),
    view: board.view ? structuredClone(board.view) : null,
  };
}

function applySnapshot(board: ClueBoard, snap: ClueHistorySnapshot) {
  board.title = snap.title ?? "";
  board.nodes = structuredClone(snap.nodes ?? []);
  board.edges = structuredClone(snap.edges ?? []);
  board.view = snap.view ? structuredClone(snap.view) : null;
}

export function loadHistoryEntries(boardId: string): ClueHistoryEntry[] {
  const path = clueHistoryPath(boardId);
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const out: ClueHistoryEntry[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t) as ClueHistoryEntry);
    } catch {
      /* skip bad line */
    }
  }
  return out;
}

function nextSeq(entries: ClueHistoryEntry[]): number {
  let max = 0;
  for (const e of entries) if (e.seq > max) max = e.seq;
  return max + 1;
}

export function appendHistoryEntry(
  boardId: string,
  actor: ClueHistoryActor | "mcp",
  action: string,
  snapshot: ClueHistorySnapshot,
  opts?: {
    tool?: string;
    label_key?: string;
    rollback_to_seq?: number;
  },
): ClueHistoryEntry {
  ensureNotesConfigDir();
  const path = clueHistoryPath(boardId);
  mkdirSync(dirname(path), { recursive: true });
  const entries = loadHistoryEntries(boardId);
  const entry: ClueHistoryEntry = {
    v: 1,
    seq: nextSeq(entries),
    ts: Date.now(),
    actor: actor === "human" ? "human" : "ai",
    action,
    tool: opts?.tool,
    label_key: opts?.label_key,
    rollback_to_seq: opts?.rollback_to_seq,
    snapshot,
  };
  appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

export function appendFromBoard(
  board: ClueBoard,
  actor: ClueHistoryActor | "mcp",
  action: string,
  opts?: { tool?: string; label_key?: string },
): ClueHistoryEntry {
  return appendHistoryEntry(board.id, actor, action, snapshotFromBoard(board), opts);
}

export function ensureSeeded(board: ClueBoard): ClueHistoryEntry[] {
  let entries = loadHistoryEntries(board.id);
  if (entries.length === 0) {
    const e = appendFromBoard(board, "human", "initial", {
      tool: "ui",
      label_key: "notes.clue.history.initial",
    });
    entries = [e];
  }
  return entries;
}

export function deleteHistory(boardId: string): void {
  const path = clueHistoryPath(boardId);
  if (existsSync(path)) unlinkSync(path);
}

export async function listHistory(boardId?: string) {
  const data = await readClueBoards();
  const bid = (boardId?.trim() || data.active_id).trim();
  const board = findBoard(data, bid);
  if (board) ensureSeeded(board);
  const entries = loadHistoryEntries(bid);
  return {
    board_id: bid,
    path: clueHistoryPath(bid),
    current_seq: entries.length ? entries[entries.length - 1]!.seq : null,
    entries: entries.map((e) => ({
      seq: e.seq,
      ts: e.ts,
      actor: e.actor,
      action: e.action,
      tool: e.tool ?? null,
      label_key: e.label_key ?? null,
      rollback_to_seq: e.rollback_to_seq ?? null,
      node_count: e.snapshot.nodes.length,
      edge_count: e.snapshot.edges.length,
      title: e.snapshot.title,
    })),
    hint: "Use clue_board_rollback with seq to restore a prior version (full snapshot).",
  };
}

export async function rollbackHistory(boardId: string | undefined, seq: number) {
  const data = await readClueBoards();
  const bid = (boardId?.trim() || data.active_id).trim();
  const entries = loadHistoryEntries(bid);
  const target = entries.find((e) => e.seq === seq);
  if (!target) throw new Error(`history seq not found: ${seq}`);
  const last = entries[entries.length - 1];
  if (last && last.seq === seq) {
    return {
      board_id: bid,
      restored_seq: seq,
      new_seq: last.seq,
      active_id: data.active_id,
      entry: {
        seq: last.seq,
        actor: last.actor,
        action: last.action,
        rollback_to_seq: last.rollback_to_seq ?? null,
      },
    };
  }

  const entry = await withClueBoards((file) => {
    const board = findBoard(file, bid);
    if (!board) throw new Error(`board not found: ${bid}`);
    applySnapshot(board, target.snapshot);
    return appendHistoryEntry(bid, "ai", "rollback", target.snapshot, {
      tool: "clue_board_rollback",
      label_key: "notes.clue.history.rollback",
      rollback_to_seq: seq,
    });
  });

  return {
    board_id: bid,
    restored_seq: seq,
    new_seq: entry.seq,
    active_id: data.active_id,
    entry: {
      seq: entry.seq,
      actor: entry.actor,
      action: entry.action,
      rollback_to_seq: entry.rollback_to_seq ?? null,
    },
  };
}
