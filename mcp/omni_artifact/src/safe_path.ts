import { isAbsolute, relative, resolve } from "node:path";

export const ARTIFACT_MAX_BYTES = 8 * 1024 * 1024;

export function assertArtifactSize(content: string): void {
  if (Buffer.byteLength(content, "utf8") > ARTIFACT_MAX_BYTES) {
    throw new Error("artifact content too large");
  }
}

export function artifactFileName(filename: string, ext: "html" | "md"): string {
  const cleaned = filename
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 120);
  const base = cleaned || "artifact";
  return base.endsWith(`.${ext}`) ? base : `${base}.${ext}`;
}

export function artifactPath(
  dir: string,
  filename: string,
  ext: "html" | "md"
): string {
  const name = artifactFileName(filename, ext);
  const root = resolve(dir);
  const path = resolve(root, name);
  const rel = relative(root, path);
  if (rel === "" || isAbsolute(rel) || rel.split(/[/\\]/).includes("..")) {
    throw new Error("unsafe artifact filename");
  }
  return path;
}
