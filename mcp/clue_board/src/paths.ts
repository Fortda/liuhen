import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

function looksLikeDb(p: string): boolean {
  return (
    existsSync(join(p, "EventData")) ||
    existsSync(join(p, "ModuleData")) ||
    existsSync(join(p, "ContextData"))
  );
}

function repoRootCandidates(): string[] {
  // mcp/clue_board/src -> repo root is ../../../
  const fromModule = resolve(__dirname, "..", "..", "..");
  const fromCwd = process.cwd();
  const out = new Set<string>();
  for (const base of [fromModule, fromCwd]) {
    out.add(base);
    out.add(resolve(base, ".."));
    out.add(resolve(base, "..", ".."));
    out.add(resolve(base, "..", "..", ".."));
  }
  return [...out];
}

export function resolveDataRoot(): string {
  for (const key of ["OMNI_DATABASE", "OMNITRACE_DATA"]) {
    const v = process.env[key]?.trim();
    if (v) return resolve(v);
  }

  for (const base of repoRootCandidates()) {
    const candidate = join(base, "OmniDatabase");
    if (looksLikeDb(candidate)) return resolve(candidate);
  }

  const userOmni = join(homedir(), "OmniTrace", "OmniDatabase");
  if (looksLikeDb(userOmni) || existsSync(userOmni)) return userOmni;

  const dl = join(homedir(), "Downloads", "OmniTrace", "OmniDatabase");
  if (looksLikeDb(dl)) return dl;

  // Fallback: repo OmniDatabase even if empty (MCP can create notes/config)
  return resolve(repoRootCandidates()[0]!, "OmniDatabase");
}

export function clueBoardsPath(): string {
  return join(resolveDataRoot(), "notes", "config", "clue_boards.json");
}

export function clueBoardLegacyPath(): string {
  return join(resolveDataRoot(), "notes", "config", "clue_board.json");
}

export function clueHistoryDir(): string {
  return join(resolveDataRoot(), "notes", "config", "clue_history");
}

export function clueHistoryPath(boardId: string): string {
  const safe =
    boardId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128) || "board";
  return join(clueHistoryDir(), `${safe}.jsonl`);
}

/** Directory of clue-board image bytes (`notes/config/clue_images`). */
export function clueImagesDir(): string {
  return join(dirname(clueBoardsPath()), "clue_images");
}

export function ensureNotesConfigDir(): void {
  const dir = dirname(clueBoardsPath());
  mkdirSync(dir, { recursive: true });
  mkdirSync(clueHistoryDir(), { recursive: true });
}
