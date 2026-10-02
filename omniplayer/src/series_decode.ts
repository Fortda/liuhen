/** 日瓦片 base64 → U32 + max-mipmap（主线程与 Worker 共用，无 IPC）。 */

export function b64ToU32(b64: string, secs: number): Uint32Array {
  const nsec = Number.isFinite(secs) && secs > 0 ? Math.floor(secs) : 0;
  const out = new Uint32Array(nsec);
  if (!b64 || nsec === 0) return out;
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    return out;
  }
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const n = Math.min(nsec, Math.floor(u8.length / 4));
  if (n === 0) return out;
  const view = new DataView(u8.buffer, u8.byteOffset, n * 4);
  for (let i = 0; i < n; i++) out[i] = view.getUint32(i * 4, true);
  return out;
}

export function buildMaxMips(src: Uint32Array): Uint32Array[] {
  const levels: Uint32Array[] = [src];
  let cur = src;
  while (cur.length > 4) {
    const n = (cur.length + 1) >> 1;
    const nxt = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      const i2 = i << 1;
      const a = cur[i2];
      const b = i2 + 1 < cur.length ? cur[i2 + 1] : 0;
      nxt[i] = a > b ? a : b;
    }
    levels.push(nxt);
    cur = nxt;
  }
  return levels;
}

export function decodeDaySeriesB64(
  mouseB64: string,
  keyB64: string,
  secs: number
): {
  mouse: Uint32Array;
  key: Uint32Array;
  mouseMips: Uint32Array[];
  keyMips: Uint32Array[];
} {
  const mouse = b64ToU32(mouseB64, secs);
  const key = b64ToU32(keyB64, secs);
  return {
    mouse,
    key,
    mouseMips: buildMaxMips(mouse),
    keyMips: buildMaxMips(key),
  };
}
