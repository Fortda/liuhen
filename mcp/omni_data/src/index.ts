#!/usr/bin/env node
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolveDataRoot } from "./paths.js";

const server = new McpServer({ name: "omnitrace-omni-data", version: "0.1.0" });

function jsonText(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

function tailJsonl(path: string, max: number): string[] {
  try {
    const raw = readFileSync(path, "utf8");
    const lines = raw.split(/\r?\n/).filter(Boolean);
    return lines.slice(-max);
  } catch {
    return [];
  }
}

function listCardFiles(limit: number): unknown[] {
  const root = join(resolveDataRoot(), "notes", "cards");
  const out: { path: string; mtime: number }[] = [];
  function walk(dir: string) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (name.endsWith(".json")) out.push({ path: p, mtime: st.mtimeMs });
    }
  }
  walk(root);
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit).map(({ path }) => {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return { path, error: "parse_failed" };
    }
  });
}

server.tool("read_data_root", "Return OmniDatabase root path.", {}, async () =>
  jsonText({ data_root: resolveDataRoot() })
);

server.tool(
  "list_recent_cards",
  "List recent note card summaries (read-only).",
  { limit: z.number().int().optional() },
  async ({ limit }) => jsonText({ cards: listCardFiles(limit ?? 20) })
);

server.tool(
  "tail_module_health",
  "Tail module_health.jsonl lines (read-only).",
  { max_lines: z.number().int().optional() },
  async ({ max_lines }) =>
    jsonText({
      lines: tailJsonl(join(resolveDataRoot(), "control/module_health.jsonl"), max_lines ?? 40),
    })
);

const transport = new StdioServerTransport();
await server.connect(transport);
