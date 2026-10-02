import assert from "node:assert/strict";
import { test } from "node:test";
import { b64ToU32, buildMaxMips } from "../src/series_decode.ts";

function u32ToB64(values: number[]): string {
  const buf = new Uint8Array(values.length * 4);
  const view = new DataView(buf.buffer);
  values.forEach((v, i) => view.setUint32(i * 4, v, true));
  let s = "";
  for (const b of buf) s += String.fromCharCode(b);
  return btoa(s);
}

test("b64ToU32 reads little-endian seconds and ignores a bad payload", () => {
  const out = b64ToU32(u32ToB64([1, 5, 3]), 4);
  assert.deepEqual([...out], [1, 5, 3, 0]);
  assert.equal(b64ToU32("@@@", 3).length, 3);
  assert.deepEqual([...b64ToU32("@@@", 3)], [0, 0, 0]);
  assert.equal(b64ToU32("", 2).length, 2);
});

test("max mipmap keeps the larger sample", () => {
  const mips = buildMaxMips(new Uint32Array([1, 4, 2, 9, 3]));
  assert.deepEqual([...mips[1]], [4, 9, 3]);
});
