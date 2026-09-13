/** 关于对话框「统计口径」人话模式切换与 localStorage 持久化。 */

import type { StringTable } from "./shell_i18n_tables";

export const CALIBER_PLAIN_STORAGE_KEY = "omnitrace.shell.caliber_plain";

export function isCaliberPlainMode(): boolean {
  try {
    return localStorage.getItem(CALIBER_PLAIN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function setCaliberPlainMode(on: boolean): void {
  try {
    localStorage.setItem(CALIBER_PLAIN_STORAGE_KEY, on ? "1" : "0");
  } catch {
    /* private mode */
  }
}

/** 人话模式开启时，将 dlg.about.caliber.* 映射到 dlg.about.caliber.plain.*（有则替换）。 */
export function resolveCaliberI18nKey(key: string, table: StringTable): string {
  if (
    !isCaliberPlainMode() ||
    !key.startsWith("dlg.about.caliber.") ||
    key.startsWith("dlg.about.caliber.plain")
  ) {
    return key;
  }
  const plainKey = key.replace(/^dlg\.about\.caliber\./, "dlg.about.caliber.plain.");
  return table[plainKey] ? plainKey : key;
}

export function applyCaliberPlainButton(): void {
  const btn = document.getElementById("btn-caliber-plain");
  if (!btn) return;
  const on = isCaliberPlainMode();
  btn.classList.toggle("is-active", on);
  btn.setAttribute("aria-pressed", on ? "true" : "false");
}

export function initCaliberPlainToggle(onApply: () => void): void {
  const btn = document.getElementById("btn-caliber-plain");
  if (!btn) return;
  applyCaliberPlainButton();

  const toggle = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    setCaliberPlainMode(!isCaliberPlainMode());
    applyCaliberPlainButton();
    onApply();
  };

  btn.addEventListener("click", toggle);
  btn.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") toggle(e);
  });
}
