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

export function resolveDataRoot(): string {
  for (const key of ["OMNI_DATABASE", "OMNITRACE_DATA"]) {
    const v = process.env[key]?.trim();
    if (v) return resolve(v);
  }
  for (const base of repoRootCandidates()) {
    const candidate = join(base, "OmniDatabase");
    if (looksLikeDb(candidate)) return resolve(candidate);
  }
  const dl = join(homedir(), "Downloads", "OmniTrace", "OmniDatabase");
  if (looksLikeDb(dl)) return dl;
  return resolve(repoRootCandidates()[0]!, "OmniDatabase");
}
