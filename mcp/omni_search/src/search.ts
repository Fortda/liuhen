import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveDataRoot } from "./paths.js";

export type SearchConfig = {
  v: number;
  engine: string;
  searx_url: string;
  custom_url: string;
  api_key: string;
};

export function loadSearchConfig(): SearchConfig {
  try {
    const raw = readFileSync(
      join(resolveDataRoot(), "notes", "config", "search_config.json"),
      "utf8"
    );
    return JSON.parse(raw) as SearchConfig;
  } catch {
    return { v: 1, engine: "duckduckgo", searx_url: "", custom_url: "", api_key: "" };
  }
}

function encode(s: string): string {
  return encodeURIComponent(s).replace(/%20/g, "+");
}

export async function webSearch(query: string): Promise<unknown> {
  const cfg = loadSearchConfig();
  const q = encode(query);
  if (cfg.engine === "searx") {
    if (!cfg.searx_url.trim()) throw new Error("Configure SearX URL in notes settings");
    const url = `${cfg.searx_url.replace(/\/$/, "")}/search?q=${q}&format=json`;
    const res = await fetch(url);
    return { engine: "searx", query, raw: await res.text() };
  }
  if (cfg.engine === "brave") {
    if (!cfg.api_key.trim()) throw new Error("Configure Brave API key in notes settings");
    const url = `https://api.search.brave.com/res/v1/web/search?q=${q}`;
    const res = await fetch(url, { headers: { "X-Subscription-Token": cfg.api_key } });
    return { engine: "brave", query, raw: await res.text() };
  }
  if (cfg.engine === "custom") {
    if (!cfg.custom_url.trim()) throw new Error("Configure custom search URL");
    const url = cfg.custom_url.replace(/\{\{?q\}\}?/g, q);
    const res = await fetch(url);
    return { engine: "custom", query, raw: await res.text() };
  }
  const url = `https://api.duckduckgo.com/?q=${q}&format=json&no_html=1`;
  const res = await fetch(url);
  return { engine: "duckduckgo", query, raw: await res.text() };
}
