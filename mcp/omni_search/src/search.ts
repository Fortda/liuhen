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

const MAX_QUERY = 2_000;
const MAX_BODY = 512_000;
const TIMEOUT_MS = 12_000;

function encode(s: string): string {
  return encodeURIComponent(s).replace(/%20/g, "+");
}

export function assertHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("invalid search URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("search URL must be http or https");
  }
  return url;
}

export function resolveSearchRequest(
  cfg: SearchConfig,
  query: string
): { engine: string; url: string; headers?: Record<string, string> } {
  const q = encode(query.slice(0, MAX_QUERY));
  if (cfg.engine === "searx") {
    if (!cfg.searx_url.trim()) throw new Error("Configure SearX URL in notes settings");
    const url = `${cfg.searx_url.replace(/\/$/, "")}/search?q=${q}&format=json`;
    assertHttpUrl(url);
    return { engine: "searx", url };
  }
  if (cfg.engine === "brave") {
    if (!cfg.api_key.trim()) throw new Error("Configure Brave API key in notes settings");
    const url = `https://api.search.brave.com/res/v1/web/search?q=${q}`;
    assertHttpUrl(url);
    return { engine: "brave", url, headers: { "X-Subscription-Token": cfg.api_key } };
  }
  if (cfg.engine === "custom") {
    if (!cfg.custom_url.trim()) throw new Error("Configure custom search URL");
    const url = cfg.custom_url.replace(/\{\{?q\}\}?/g, q);
    assertHttpUrl(url);
    return { engine: "custom", url };
  }
  const url = `https://api.duckduckgo.com/?q=${q}&format=json&no_html=1`;
  assertHttpUrl(url);
  return { engine: "duckduckgo", url };
}

async function fetchText(url: string, headers?: Record<string, string>): Promise<string> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  const text = await res.text();
  return text.length > MAX_BODY ? text.slice(0, MAX_BODY) : text;
}

export async function webSearch(query: string): Promise<unknown> {
  const cfg = loadSearchConfig();
  const req = resolveSearchRequest(cfg, query);
  const raw = await fetchText(req.url, req.headers);
  return { engine: req.engine, query: query.slice(0, MAX_QUERY), raw };
}
