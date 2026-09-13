/** 壳外观：跟随系统 / 浅色 / 深色。仅播放器舞台保持黑底；时间轴跟壳层。 */

export const THEME_STORAGE_KEY = "omnitrace.shell.theme";

export type ThemeChoice = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

function isChoice(v: string | null): v is ThemeChoice {
  return v === "system" || v === "light" || v === "dark";
}

export function readThemeChoice(): ThemeChoice {
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (isChoice(raw)) return raw;
  } catch {
    /* private mode */
  }
  return "system";
}

export function resolvedTheme(choice: ThemeChoice = readThemeChoice()): ResolvedTheme {
  if (choice === "light") return "light";
  if (choice === "dark") return "dark";
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

export function applyTheme(choice: ThemeChoice = readThemeChoice()): ThemeChoice {
  const resolved = resolvedTheme(choice);
  document.documentElement.dataset.theme = resolved;
  try {
    localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    /* ignore */
  }
  document.querySelectorAll(".theme-seg [data-theme]").forEach((btn) => {
    const el = btn as HTMLElement;
    el.classList.toggle("active", el.dataset.theme === choice);
  });
  window.dispatchEvent(new Event("omnitrace-theme"));
  return choice;
}

export function initTheme() {
  applyTheme(readThemeChoice());
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onScheme = () => {
    if (readThemeChoice() === "system") applyTheme("system");
  };
  if (typeof mq.addEventListener === "function") {
    mq.addEventListener("change", onScheme);
  } else {
    mq.addListener(onScheme);
  }
  document.querySelectorAll(".theme-seg [data-theme]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const t = (btn as HTMLElement).dataset.theme;
      if (isChoice(t || "")) applyTheme(t as ThemeChoice);
    });
  });
}
