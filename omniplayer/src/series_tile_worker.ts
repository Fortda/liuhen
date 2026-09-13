import { buildMaxMips, b64ToU32 } from "./series_decode";

type Req = { id: number; secs: number; mouse_b64: string; key_b64: string };

type WorkerScope = {
  onmessage: ((ev: MessageEvent<Req>) => void) | null;
  postMessage: (msg: unknown, transfer: Transferable[]) => void;
};

const worker = self as unknown as WorkerScope;

worker.onmessage = (ev: MessageEvent<Req>) => {
  const { id, secs, mouse_b64, key_b64 } = ev.data;
  const n = Math.max(1, secs | 0);
  const mouse = b64ToU32(mouse_b64, n);
  const key = b64ToU32(key_b64, n);
  const mouseMips = buildMaxMips(mouse);
  const keyMips = buildMaxMips(key);
  const mouseMipRest = mouseMips.slice(1).map((a) => a.buffer);
  const keyMipRest = keyMips.slice(1).map((a) => a.buffer);
  const transfer: Transferable[] = [
    mouse.buffer,
    key.buffer,
    ...mouseMipRest,
    ...keyMipRest,
  ];
  worker.postMessage(
    {
      id,
      mouse: mouse.buffer,
      key: key.buffer,
      mouseMipRest,
      keyMipRest,
    },
    transfer
  );
};
