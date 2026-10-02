import assert from "node:assert/strict";
import { test } from "node:test";
import {
  binStreamStopKind,
  findLastAbsoluteMouseIndex,
  findLastAbsoluteMouseOffset,
  liveChunkCursor,
} from "../src/bin_sync.ts";

const NOW = 1_700_000_000_000;

function absFrame(ts: bigint, x = 1, y = 2): Uint8Array {
  const b = new Uint8Array(13);
  b[0] = 0xff;
  const v = new DataView(b.buffer);
  v.setBigUint64(1, ts, false);
  v.setInt16(9, x, false);
  v.setInt16(11, y, false);
  return b;
}

test("absolute anchor ignores a 0xFF that is not a plausible timestamp", () => {
  const noise = new Uint8Array([0xff, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3]);
  const frame = absFrame(BigInt(NOW - 5_000), 10, 20);
  const data = new Uint8Array(noise.length + frame.length);
  data.set(noise, 0);
  data.set(frame, noise.length);
  assert.equal(findLastAbsoluteMouseIndex(data, NOW), noise.length);
  assert.equal(findLastAbsoluteMouseOffset(data, NOW), noise.length);
});

test("missing anchor decodes from the start", () => {
  const data = new Uint8Array([1, 2, 3, 4, 5, 0xff, 1]);
  assert.equal(findLastAbsoluteMouseIndex(data, NOW), -1);
  assert.equal(findLastAbsoluteMouseOffset(data, NOW), 0);
});

test("live cursor snaps to the new length when the file shrinks", () => {
  assert.deepEqual(liveChunkCursor(5000, 100, 0), {
    offset: 100,
    reset: true,
    ingest: false,
  });
});

test("live cursor advances only when new bytes arrive", () => {
  assert.deepEqual(liveChunkCursor(10, 14, 4), {
    offset: 14,
    reset: false,
    ingest: true,
  });
  assert.deepEqual(liveChunkCursor(14, 14, 0), {
    offset: 14,
    reset: false,
    ingest: false,
  });
});

test("bin stream stops on a truncated tail instead of spinning", () => {
  assert.equal(
    binStreamStopKind({
      nextOffset: 100,
      prevOffset: 100,
      sampleCount: 0,
      eof: false,
      reached: false,
      fileSize: 100,
    }),
    "stall"
  );
  assert.equal(
    binStreamStopKind({
      nextOffset: 100,
      prevOffset: 100,
      sampleCount: 0,
      eof: false,
      reached: false,
      fileSize: 180,
    }),
    "continue"
  );
  assert.equal(
    binStreamStopKind({
      nextOffset: 100,
      prevOffset: 80,
      sampleCount: 0,
      eof: false,
      reached: false,
      fileSize: 100,
    }),
    "continue"
  );
});
