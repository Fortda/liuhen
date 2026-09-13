import {
  copyFileSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import lockfile from "proper-lockfile";
import type { ClueBoard, ClueBoardsFile } from "./types.js";
import { parseClueBoardsRaw, normalizeClueBoards } from "./normalize.js";
import { newBoardId } from "./types.js";
import {
  clueBoardLegacyPath,
  clueBoardsPath,
  clueHistoryDir,
  clueHistoryPath,
  ensureNotesConfigDir,
  resolveDataRoot,
} from "./paths.js";
import { seedMissingClueBoardTimes, stampClueBoards } from "./timestamps.js";

const LOCK_OPTS = {
  retries: { retries: 8, minTimeout: 50, maxTimeout: 500 },
  stale: 10_000,
};

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

function clueBoardsTextScore(data: ClueBoardsFile): number {
  let n = 0;
  for (const b of data.boards) {
    for (const node of b.nodes) {
      if ((node.text ?? "").trim()) n += 1;
    }
  }
  return n;
}

function mergeLegacyWhenPrimaryEmpty(
  primary: ClueBoardsFile,
  legacy: ClueBoardsFile,
): ClueBoardsFile {
  if (clueBoardsTextScore(primary) > 0 || clueBoardsTextScore(legacy) === 0) {
    return primary;
  }
  const seen = new Set(legacy.boards.map((b) => b.id));
  const boards = [...legacy.boards];
  for (const b of primary.boards) {
    if (!seen.has(b.id)) {
      seen.add(b.id);
      boards.push(b);
    }
  }
  return normalizeClueBoards({
    v: 2,
    active_id: legacy.active_id,
    boards,
  });
}

function boardFromLatestHistory(boardId: string): ClueBoard | null {
  let raw = "";
  try {
    raw = readFileSync(clueHistoryPath(boardId), "utf8");
  } catch {
    return null;
  }
  let firstTs = 0;
  let last: {
    ts?: number;
    snapshot?: {
      title?: string;
      nodes?: ClueBoard["nodes"];
      edges?: ClueBoard["edges"];
      view?: ClueBoard["view"];
    };
  } | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t) as { ts?: number; snapshot?: ClueBoard };
      if (!firstTs && typeof e.ts === "number" && e.ts > 0) firstTs = e.ts;
      last = e;
    } catch {
      /* skip */
    }
  }
  if (!last?.snapshot) return null;
  return {
    id: boardId,
    title: last.snapshot.title ?? "",
    nodes: last.snapshot.nodes ?? [],
    edges: last.snapshot.edges ?? [],
    view: last.snapshot.view ?? null,
    created_at: firstTs,
    updated_at: typeof last.ts === "number" ? last.ts : firstTs,
  };
}

function mergeHistoryOrphans(data: ClueBoardsFile): number {
  const present = new Set(data.boards.map((b) => b.id));
  let added = 0;
  let names: string[] = [];
  try {
    names = readdirSync(clueHistoryDir());
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.startsWith("board_") || !name.endsWith(".jsonl")) continue;
    const id = name.slice(0, -".jsonl".length);
    if (!id || present.has(id)) continue;
    const board = boardFromLatestHistory(id);
    if (!board) continue;
    data.boards.push(board);
    present.add(id);
    added += 1;
  }
  return added;
}

function finalizeRead(data: ClueBoardsFile): ClueBoardsFile {
  seedMissingClueBoardTimes(data);
  const added = mergeHistoryOrphans(data);
  if (added > 0) {
    seedMissingClueBoardTimes(data);
    const normalized = normalizeClueBoards(data);
    writeFileSync(clueBoardsPath(), JSON.stringify(normalized, null, 2), "utf8");
    return normalized;
  }
  if (!data.boards.length) return defaultClueBoards();
  return data;
}

function readClueBoardsUnlocked(): ClueBoardsFile {
  let primary: ClueBoardsFile | null = null;
  try {
    primary = parseClueBoardsRaw(readFileSync(clueBoardsPath(), "utf8"));
  } catch {
    /* missing or invalid */
  }
  if (!primary) {
    try {
      primary = parseClueBoardsRaw(readFileSync(`${clueBoardsPath()}.bak`, "utf8"));
    } catch {
      /* no bak */
    }
  }

  let legacy: ClueBoardsFile | null = null;
  try {
    legacy = parseClueBoardsRaw(readFileSync(clueBoardLegacyPath(), "utf8"));
  } catch {
    /* missing */
  }

  if (primary && legacy) {
    const before = clueBoardsTextScore(primary);
    const merged = mergeLegacyWhenPrimaryEmpty(primary, legacy);
    if (clueBoardsTextScore(merged) > before) {
      return finalizeRead(merged);
    }
    return finalizeRead(merged);
  }
  if (primary) {
    return finalizeRead(primary);
  }
  if (legacy) {
    return finalizeRead(legacy);
  }
  const empty: ClueBoardsFile = { v: 2, active_id: "", boards: [] };
  return finalizeRead(empty);
}

function writeClueBoardsUnlocked(data: ClueBoardsFile): ClueBoardsFile {
  ensureNotesConfigDir();
  const normalized = normalizeClueBoards(data);
  const path = clueBoardsPath();
  const incomingScore = clueBoardsTextScore(normalized);
  let existing: ClueBoardsFile | null = null;
  try {
    existing = parseClueBoardsRaw(readFileSync(path, "utf8"));
    if (existing) {
      const existingScore = clueBoardsTextScore(existing);
      if (existingScore > 0 && incomingScore === 0) {
        throw new Error(
          `refusing to overwrite clue_boards.json (${existingScore} text nodes) with empty content`,
        );
      }
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("refusing to overwrite")) throw e;
    /* missing / invalid existing → allow write */
  }
  stampClueBoards(normalized, existing, Date.now());
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(normalized, null, 2), "utf8");
  try {
    copyFileSync(path, `${path}.bak`);
  } catch {
    /* dest may not exist yet */
  }
  copyFileSync(tmp, path);
  try {
    unlinkSync(tmp);
  } catch {
    /* ignore */
  }
  return normalized;
}

export async function withClueBoards<T>(
  mutate: (data: ClueBoardsFile) => T | Promise<T>,
): Promise<T> {
  ensureNotesConfigDir();
  const path = clueBoardsPath();
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(path, LOCK_OPTS);
  } catch {
    // File may not exist yet; lock on path still works with proper-lockfile
    release = await lockfile.lock(path, { ...LOCK_OPTS, realpath: false });
  }

  try {
    const data = readClueBoardsUnlocked();
    const result = await mutate(data);
    writeClueBoardsUnlocked(data);
    return result;
  } finally {
    if (release) await release();
  }
}

export async function readClueBoards(): Promise<ClueBoardsFile> {
  ensureNotesConfigDir();
  const path = clueBoardsPath();
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(path, { ...LOCK_OPTS, realpath: false });
  } catch {
    return readClueBoardsUnlocked();
  }
  try {
    return readClueBoardsUnlocked();
  } finally {
    if (release) await release();
  }
}

export function getDataRootInfo(): { data_root: string; clue_boards_path: string } {
  return {
    data_root: resolveDataRoot(),
    clue_boards_path: clueBoardsPath(),
  };
}
