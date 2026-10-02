/** Pure bin-tail helpers shared by the player (no DOM, no IPC). */

/** Index of the last plausible absolute mouse frame (`0xFF`), or -1. */
export function findLastAbsoluteMouseIndex(
  data: Uint8Array,
  now = Date.now()
): number {
  if (data.length < 13) return -1;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let i = data.length - 13; i >= 0; i--) {
    if (data[i] !== 0xff) continue;
    const ts = Number(view.getBigUint64(i + 1, false));
    // Reasonable Unix ms: about 2001–2100, and not past now + 1 minute.
    if (ts > 1_000_000_000_000 && ts < now + 60_000) return i;
  }
  return -1;
}

/** Same search, but 0 means "decode from the start" when no anchor exists. */
export function findLastAbsoluteMouseOffset(
  data: Uint8Array,
  now = Date.now()
): number {
  const i = findLastAbsoluteMouseIndex(data, now);
  return i < 0 ? 0 : i;
}

/**
 * Live tail cursor. A shorter file must not leave the offset past EOF,
 * or every later poll reads nothing. Snap to the new length and drop any
 * partial record (`reset`). Do not rewind to 0: these logs are append-only,
 * and replaying the prefix would duplicate samples already on screen.
 */
export function liveChunkCursor(
  prev: number,
  nextOffset: number,
  byteLength: number
): { offset: number; reset: boolean; ingest: boolean } {
  if (nextOffset < prev && byteLength === 0) {
    return { offset: nextOffset, reset: true, ingest: false };
  }
  if (byteLength > 0) {
    return { offset: nextOffset, reset: false, ingest: true };
  }
  return { offset: prev, reset: false, ingest: false };
}

export type BinStreamStop = "continue" | "eof" | "stall";

/**
 * Stop a VOD decode loop that is no longer consuming bytes.
 * `eof` — caller may mark the stream finished.
 * `stall` — partial trailing record and the file has not grown; do not spin.
 */
export function binStreamStopKind(opts: {
  nextOffset: number;
  prevOffset: number;
  sampleCount: number;
  eof: boolean;
  reached: boolean;
  fileSize: number;
}): BinStreamStop {
  if (opts.nextOffset > opts.prevOffset || opts.sampleCount > 0) return "continue";
  if (opts.eof || opts.reached) return "eof";
  if (opts.fileSize <= opts.nextOffset) return "stall";
  return "continue";
}
