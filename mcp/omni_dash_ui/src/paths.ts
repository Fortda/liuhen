import { existsSync } from "node:fs";
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
  const fromModule = resolve(__dirname, "..", "..", "..");
  const fromCwd = process.cwd();
  const out = new Set<string>();
  for (const base of [fromModule, fromCwd]) {
    out.add(base);
    out.add(resolve(base, ".."));
    out.add(resolve(base, "..", ".."));
  }
  return [...out];
}

export function repoRoot(): string {
  return repoRootCandidates()[0]!;
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
  return join(repoRoot(), "OmniDatabase");
}

const ALLOWED: Record<string, string> = {
  dashboard_ts: "omniplayer/src/dashboard.ts",
  dashboard_status_ts: "omniplayer/src/dashboard_status.ts",
  index_html: "omniplayer/index.html",
  shell_i18n: "omniplayer/src/shell_i18n.ts",
  shell_i18n_about: "omniplayer/src/shell_i18n_about.ts",
};

export function dashUiPath(fileId: string): string {
  const rel = ALLOWED[fileId];
  if (!rel) throw new Error(`不允许的文件: ${fileId}`);
  return join(repoRoot(), rel);
}
