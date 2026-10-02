import assert from "node:assert/strict";
import { test } from "node:test";
import { splitJsonlChunk } from "../src/jsonl_tail.ts";

const enc = new TextEncoder();

test("a line split across chunks is emitted only when complete", () => {
  const first = splitJsonlChunk(new Uint8Array(0), enc.encode('{"a":1}\n{"b":'));
  assert.equal(first.text, '{"a":1}');
  const second = splitJsonlChunk(first.carry, enc.encode("2}\n"));
  assert.equal(second.text, '{"b":2}');
  assert.equal(second.carry.length, 0);
});

test("a multibyte character split across chunks stays intact", () => {
  const bytes = enc.encode('{"t":"你"}\n');
  const mid = bytes.length - 4;
  const first = splitJsonlChunk(new Uint8Array(0), bytes.subarray(0, mid));
  assert.equal(first.text, "");
  const second = splitJsonlChunk(first.carry, bytes.subarray(mid));
  assert.equal(second.text, '{"t":"你"}');
});

test("a runaway line without a newline is dropped at the cap", () => {
  const chunk = enc.encode("x".repeat(20));
  const split = splitJsonlChunk(new Uint8Array(0), chunk, 8);
  assert.equal(split.text, "");
  assert.equal(split.carry.length, 0);
});
