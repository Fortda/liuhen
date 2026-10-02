/**
 * Live JSONL is read in capped chunks. A line (or a UTF-8 sequence) may
 * end in the middle of a chunk. Hold the trailing bytes until a newline.
 */

const DEFAULT_MAX_CARRY = 1024 * 1024;

export function splitJsonlChunk(
  carry: Uint8Array,
  chunk: Uint8Array,
  maxCarry = DEFAULT_MAX_CARRY
): { text: string; carry: Uint8Array } {
  const merged = new Uint8Array(carry.length + chunk.length);
  merged.set(carry, 0);
  merged.set(chunk, carry.length);
  let lastNl = -1;
  for (let i = merged.length - 1; i >= 0; i--) {
    if (merged[i] === 0x0a) {
      lastNl = i;
      break;
    }
  }
  if (lastNl < 0) {
    if (merged.length > maxCarry) return { text: "", carry: new Uint8Array(0) };
    return { text: "", carry: merged };
  }
  const text = new TextDecoder().decode(merged.subarray(0, lastNl));
  const rest = merged.subarray(lastNl + 1);
  if (rest.length > maxCarry) return { text, carry: new Uint8Array(0) };
  return { text, carry: rest };
}
