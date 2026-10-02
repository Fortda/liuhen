import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { artifactPath, assertArtifactSize } from "../dist/safe_path.js";

test("artifact names cannot escape the artifacts directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "omni-art-"));
  for (const name of ["../../etc/passwd", "..", "../secret.html", "foo/../../../x", ""]) {
    const path = artifactPath(dir, name, "html");
    const rel = relative(dir, path);
    assert.equal(rel.startsWith(".."), false);
    assert.equal(rel.includes("/") || rel.includes("\\"), false);
  }
  rmSync(dir, { recursive: true, force: true });
});

test("oversized artifact content is rejected", () => {
  assert.doesNotThrow(() => assertArtifactSize("hello"));
  assert.throws(() => assertArtifactSize("x".repeat(8 * 1024 * 1024 + 1)));
});
