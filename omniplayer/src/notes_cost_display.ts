/**
 * Notes cost display: USD list prices converted for UI only.
 * Rate is a user setting (not a live FX API).
 */
export type CostDisplayCurrency = "USD" | "CNY";

export const COST_DISPLAY_EVENT = "omnitrace-cost-display";
const CUR_LS = "omnitrace.notes.cost.currency";
const RATE_LS = "omnitrace.notes.cost.usdToCny";

/** Documented default: 1 USD = 7.2 CNY. Manual, not live FX. */
export const DEFAULT_USD_TO_CNY = 7.2;

export type CostDisplayPrefs = {
  currency: CostDisplayCurrency;
  usdToCny: number;
};

function clampRate(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_USD_TO_CNY;
  return Math.min(100, Math.max(0.01, n));
}

export function getCostDisplayPrefs(): CostDisplayPrefs {
  let currency: CostDisplayCurrency = "USD";
  let usdToCny = DEFAULT_USD_TO_CNY;
  try {
    const c = localStorage.getItem(CUR_LS);
    if (c === "CNY" || c === "USD") currency = c;
    const r = Number(localStorage.getItem(RATE_LS));
    if (Number.isFinite(r) && r > 0) usdToCny = clampRate(r);
  } catch {
    /* private mode */
  }
  return { currency, usdToCny };
}

export function setCostDisplayCurrency(currency: CostDisplayCurrency) {
  try {
    localStorage.setItem(CUR_LS, currency);
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(COST_DISPLAY_EVENT));
}

export function setUsdToCnyRate(rate: number) {
  const n = clampRate(rate);
  try {
    localStorage.setItem(RATE_LS, String(n));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event(COST_DISPLAY_EVENT));
}

export function usdToDisplayAmount(usd: number): { amount: number; currency: CostDisplayCurrency } {
  const p = getCostDisplayPrefs();
  if (p.currency === "CNY") return { amount: usd * p.usdToCny, currency: "CNY" };
  return { amount: usd, currency: "USD" };
}

function fmtNumber(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1) return n.toFixed(2);
  if (abs >= 0.01) return n.toFixed(3);
  return n.toFixed(4);
}

/** Format a USD list-price amount using the Settings display currency. */
export function formatMoneyFromUsd(usd: number): string {
  const { amount, currency } = usdToDisplayAmount(usd);
  if (!Number.isFinite(amount)) return "—";
  if (currency === "CNY") return `¥${fmtNumber(amount)}`;
  return `$${fmtNumber(amount)}`;
}

export function costFxHint(): string {
  const p = getCostDisplayPrefs();
  if (p.currency !== "CNY") return "";
  return `1 USD = ${p.usdToCny} CNY`;
}

export function initCostDisplaySettings() {
  const apply = () => {
    const p = getCostDisplayPrefs();
    document.querySelectorAll(".cost-cur-seg [data-cost-cur]").forEach((btn) => {
      const el = btn as HTMLElement;
      el.classList.toggle("active", el.dataset.costCur === p.currency);
    });
    const rateRow = document.getElementById("settings-cost-rate-row");
    rateRow?.classList.toggle("hidden", p.currency !== "CNY");
    const input = document.getElementById("settings-cost-usd-cny") as HTMLInputElement | null;
    if (input && document.activeElement !== input) input.value = String(p.usdToCny);
  };
  apply();
  document.querySelectorAll(".cost-cur-seg [data-cost-cur]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = (btn as HTMLElement).dataset.costCur;
      if (v === "CNY" || v === "USD") setCostDisplayCurrency(v);
    });
  });
  const input = document.getElementById("settings-cost-usd-cny") as HTMLInputElement | null;
  input?.addEventListener("change", () => {
    setUsdToCnyRate(Number(input.value));
    apply();
  });
  window.addEventListener(COST_DISPLAY_EVENT, apply);
}
