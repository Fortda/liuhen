#!/usr/bin/env node
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolveDataRoot } from "./paths.js";
import {
  MAX_CARD_LIMIT,
  MAX_HEALTH_LINES,
  clampPositiveInt,
  listRecentCardPaths,
  readCardJson,
  tailJsonlLines,
} from "./read.js";

const server = new McpServer({ name: "omnitrace-omni-data", version: "0.1.0" });

function jsonText(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

function listCardFiles(limit: number | undefined): unknown[] {
  const n = clampPositiveInt(limit, 20, MAX_CARD_LIMIT);
  return listRecentCardPaths(resolveDataRoot(), n).map((path) => readCardJson(path));
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
      lines: tailJsonlLines(
        join(resolveDataRoot(), "control/module_health.jsonl"),
        clampPositiveInt(max_lines, 40, MAX_HEALTH_LINES)
      ),
    })
);

const transport = new StdioServerTransport();
await server.connect(transport);
