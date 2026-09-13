import { existsSync, readFileSync, statSync } from "node:fs";
import { clueBoardLegacyPath, clueBoardsPath, clueHistoryPath } from "./paths.js";
import type { ClueBoard, ClueBoardsFile } from "./types.js";

function fileMtimeMs(path: string): number | null {
  try {
    const t = statSync(path).mtimeMs;
    return Number.isFinite(t) && t > 0 ? Math.round(t) : null;
  } catch {
    return null;
  }
}

function historyTsRange(boardId: string): { first: number | null; last: number | null } {
  const path = clueHistoryPath(boardId);
  if (!existsSync(path)) return { first: null, last: null };
  let first: number | null = null;
  let last: number | null = null;
  let firstSeq = Number.POSITIVE_INFINITY;
  let lastSeq = -1;
  const raw = readFileSync(path, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t) as { seq?: number; ts?: number };
      const seq = typeof e.seq === "number" ? e.seq : 0;
      const ts = typeof e.ts === "number" ? e.ts : 0;
      if (!(ts > 0)) continue;
      if (seq < firstSeq) {
        firstSeq = seq;
        first = ts;
      }
      if (seq >= lastSeq) {
        lastSeq = seq;
        last = ts;
      }
    } catch {
      /* skip bad line */
    }
  }
  return { first, last };
}

function seedBoardTimestamps(board: ClueBoard, boardsMtime: number | null): void {
  if ((board.created_at ?? 0) > 0 && (board.updated_at ?? 0) > 0) return;
  const { first, last } = historyTsRange(board.id);
  const histMtime = fileMtimeMs(clueHistoryPath(board.id));
  if (!(board.created_at && board.created_at > 0)) {
    board.created_at = first ?? histMtime ?? boardsMtime ?? 0;
  }
  if (!(board.updated_at && board.updated_at > 0)) {
    board.updated_at = last ?? histMtime ?? boardsMtime ?? board.created_at ?? 0;
  }
}

function contentEq(a: ClueBoard, b: ClueBoard): boolean {
  return (
    (a.title ?? "") === (b.title ?? "") &&
    JSON.stringify(a.nodes) === JSON.stringify(b.nodes) &&
    JSON.stringify(a.edges) === JSON.stringify(b.edges) &&
    JSON.stringify(a.view ?? null) === JSON.stringify(b.view ?? null)
  );
}

/** Seed missing times (history first/last ts → history mtime → boards file mtime). Bump updated_at only when that board's content changed. New ids get `now`. */
export function stampClueBoards(
  data: ClueBoardsFile,
  existing: ClueBoardsFile | null,
  now: number,
): void {
  const boardsMtime =
    fileMtimeMs(clueBoardsPath()) ?? fileMtimeMs(clueBoardLegacyPath());
  const existingMap = new Map((existing?.boards ?? []).map((b) => [b.id, b]));
  for (const b of data.boards) {
    const old = existingMap.get(b.id);
    if (old) {
      if (!(b.created_at && b.created_at > 0)) b.created_at = old.created_at ?? 0;
      seedBoardTimestamps(b, boardsMtime);
      if (!contentEq(b, old)) {
        b.updated_at = now;
      } else if (!(b.updated_at && b.updated_at > 0)) {
        b.updated_at = old.updated_at ?? 0;
        seedBoardTimestamps(b, boardsMtime);
      }
    } else {
      if (!(b.created_at && b.created_at > 0)) b.created_at = now;
      if (!(b.updated_at && b.updated_at > 0)) b.updated_at = now;
    }
  }
}

export function seedMissingClueBoardTimes(data: ClueBoardsFile): void {
  const boardsMtime =
    fileMtimeMs(clueBoardsPath()) ?? fileMtimeMs(clueBoardLegacyPath());
  for (const b of data.boards) seedBoardTimestamps(b, boardsMtime);
}
