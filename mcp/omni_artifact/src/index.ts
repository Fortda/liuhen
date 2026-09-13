#!/usr/bin/env node
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolveDataRoot } from "./paths.js";

const server = new McpServer({ name: "omnitrace-omni-artifact", version: "0.1.0" });

server.tool(
  "write_artifact",
  "Write HTML or Markdown artifact to OmniDatabase/notes/artifacts/.",
  {
    filename: z.string(),
    format: z.enum(["html", "markdown"]),
    content: z.string(),
  },
  async ({ filename, format, content }) => {
    const ext = format === "html" ? "html" : "md";
    const safe = filename.replace(/[^a-zA-Z0-9._-]+/g, "_");
    const dir = join(resolveDataRoot(), "notes", "artifacts");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, safe.endsWith(`.${ext}`) ? safe : `${safe}.${ext}`);
    writeFileSync(path, content, "utf8");
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ written: path }, null, 2) }],
    };
  }
);

await server.connect(new StdioServerTransport());
