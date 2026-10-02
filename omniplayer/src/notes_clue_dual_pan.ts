/**
 * 拖便签时用右键（或中键）平移视口。
 * WebView2 在 LMB setPointerCapture 期间常丢掉 button=2 的 pointerdown，
 * 所以开停以 buttons 位图为准，pointerdown 只作尽早 preventDefault。
 *
 * MouseEvent.button: 0 左 / 1 中 / 2 右
 * MouseEvent.buttons: bit0=1 左, bit1=2 右, bit2=4 中
 */

export function isAuxPanButton(button: number): boolean {
  return button === 2 || button === 1;
}

export function wantAuxPanFromButtons(buttons: number): boolean {
  return (buttons & 2) !== 0 || (buttons & 4) !== 0;
}

export function auxPanStep(
  lastX: number,
  lastY: number,
  x: number,
  y: number
): { nextX: number; nextY: number; dpx: number; dpy: number } {
  return {
    nextX: x,
    nextY: y,
    dpx: x - lastX,
    dpy: y - lastY,
  };
}
