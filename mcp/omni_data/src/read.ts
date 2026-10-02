import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";

export const MAX_CARD_LIMIT = 100;
export const MAX_HEALTH_LINES = 500;
const TAIL_BYTES = 256 * 1024;

/** `slice(0, n)` and `slice(-n)` both mis-handle 0 and negatives. */
export function clampPositiveInt(
  raw: number | undefined,
  fallback: number,
  max: number
): number {
  if (raw == null || !Number.isFinite(raw)) return fallback;
  const n = Math.floor(raw);
  if (n <= 0) return fallback;
  return Math.min(n, max);
}

export function isInsideRoot(rootReal: string, targetReal: string): boolean {
  const rel = relative(rootReal, targetReal);
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return !rel.split(/[/\\]/).includes("..");
}

export function tailText(path: string, maxBytes = TAIL_BYTES): string {
  let fd: number | undefined;
  try {
    const len = statSync(path).size;
    const start = len > maxBytes ? len - maxBytes : 0;
    const want = len - start;
    if (want <= 0) return "";
    fd = openSync(path, "r");
    const buf = Buffer.alloc(want);
    let off = 0;
    while (off < want) {
      const n = readSync(fd, buf, off, want - off, start + off);
      if (n <= 0) break;
      off += n;
    }
    let text = buf.subarray(0, off).toString("utf8");
    if (start > 0) {
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    }
    return text;
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

export function tailJsonlLines(path: string, max: number): string[] {
  const lines = tailText(path)
    .split(/\r?\n/)
    .filter((line) => line.length > 0);
  if (lines.length <= max) return lines;
  return lines.slice(lines.length - max);
}

function safeReal(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

export function listRecentCardPaths(dataRoot: string, limit: number): string[] {
  const cards = join(dataRoot, "notes", "cards");
  const rootReal = safeReal(cards);
  if (!rootReal) return [];
  const out: { path: string; mtime: number }[] = [];
  const seen = new Set<string>();

  const walk = (dir: string) => {
    const dirReal = safeReal(dir);
    if (!dirReal || seen.has(dirReal) || !isInsideRoot(rootReal, dirReal)) return;
    seen.add(dirReal);
    let entries: string[];
    try {
      entries = readdirSync(dirReal);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = join(dirReal, name);
      let st;
      try {
        st = lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        const real = safeReal(p);
        if (!real || !isInsideRoot(rootReal, real)) continue;
        let target;
        try {
          target = lstatSync(real);
        } catch {
          continue;
        }
        if (target.isDirectory()) walk(real);
        else if (name.endsWith(".json")) out.push({ path: real, mtime: target.mtimeMs });
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (name.endsWith(".json")) out.push({ path: p, mtime: st.mtimeMs });
    }
  };

  walk(rootReal);
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit).map((item) => item.path);
}

export function readCardJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { path, error: "parse_failed" };
  }
}
