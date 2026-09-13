#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { dashUiPath } from "./paths.js";

const server = new McpServer({ name: "omnitrace-omni-dash-ui", version: "0.1.0" });
const fileId = z.enum([
  "dashboard_ts",
  "dashboard_status_ts",
  "index_html",
  "shell_i18n",
  "shell_i18n_about",
]);

function jsonText(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

server.tool(
  "read_dash_ui_file",
  "Read whitelisted dashboard UI source file.",
  { file_id: fileId },
  async ({ file_id }) => {
    const path = dashUiPath(file_id);
    const text = readFileSync(path, "utf8");
    return jsonText({ file_id, path, text });
  }
);

server.tool(
  "apply_dash_ui_patch",
  "Replace old_string with new_string in whitelisted file.",
  { file_id: fileId, old_string: z.string(), new_string: z.string() },
  async ({ file_id, old_string, new_string }) => {
    const path = dashUiPath(file_id);
    const text = readFileSync(path, "utf8");
    if (!text.includes(old_string)) throw new Error("old_string not found");
    writeFileSync(path, text.replace(old_string, new_string), "utf8");
    return jsonText({ patched: path });
  }
);

await server.connect(new StdioServerTransport());
