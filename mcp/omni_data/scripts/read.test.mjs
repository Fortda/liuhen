import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  clampPositiveInt,
  isInsideRoot,
  listRecentCardPaths,
  tailJsonlLines,
  tailText,
} from "../dist/read.js";

test("clamp rejects zero and negative limits", () => {
  assert.equal(clampPositiveInt(undefined, 40, 500), 40);
  assert.equal(clampPositiveInt(0, 40, 500), 40);
  assert.equal(clampPositiveInt(-5, 20, 100), 20);
  assert.equal(clampPositiveInt(10_000, 20, 100), 100);
  assert.equal(clampPositiveInt(3, 20, 100), 3);
});

test("tail reads the end of a large file and keeps the last lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "omni-tail-"));
  const path = join(dir, "health.jsonl");
  const lines = [];
  for (let i = 0; i < 4000; i++) lines.push(`{"i":${i},"pad":"${"x".repeat(40)}"}`);
  writeFileSync(path, lines.join("\n") + "\n");
  const text = tailText(path, 8 * 1024);
  assert.ok(text.length < 16 * 1024);
  assert.equal(text.includes('"i":0,'), false);
  const got = tailJsonlLines(path, 2);
  assert.equal(got.length, 2);
  assert.match(got[1], /"i":3999/);
  rmSync(dir, { recursive: true, force: true });
});

test("card walk does not follow a symlink outside the cards directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "omni-cards-"));
  const outside = mkdtempSync(join(tmpdir(), "omni-out-"));
  const cards = join(dir, "notes", "cards");
  mkdirSync(cards, { recursive: true });
  writeFileSync(join(cards, "keep.json"), '{"id":"keep"}\n');
  writeFileSync(join(outside, "secret.json"), '{"id":"secret"}\n');
  symlinkSync(outside, join(cards, "leak"), "dir");
  const paths = listRecentCardPaths(dir, 20);
  assert.ok(paths.some((p) => p.endsWith("keep.json")));
  assert.equal(paths.some((p) => p.includes("secret.json")), false);
  assert.equal(isInsideRoot(cards, outside), false);
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});
