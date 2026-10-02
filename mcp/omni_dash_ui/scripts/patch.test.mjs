import assert from "node:assert/strict";
import { test } from "node:test";
import { applyUniquePatch } from "../dist/patch.js";

test("unique patch replaces one occurrence", () => {
  assert.equal(applyUniquePatch("alpha beta", "beta", "gamma"), "alpha gamma");
});

test("empty or repeated needles are rejected", () => {
  assert.throws(() => applyUniquePatch("abc", "", "x"), /empty/);
  assert.throws(() => applyUniquePatch("a a", "a", "b"), /not unique/);
  assert.throws(() => applyUniquePatch("abc", "missing", "x"), /not found/);
});
