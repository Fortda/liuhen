#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { repoRoot, resolveDataRoot } from "./paths.js";

const server = new McpServer({ name: "omnitrace-omni-arch", version: "0.1.0" });

function slug(s: string): string {
  const out = s.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 64);
  return out || "draft";
}

function jsonText(obj: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }] };
}

server.tool("read_blueprint", "Read ARCHITECTURE_BLUEPRINT.md (read-only).", {}, async () => {
  const path = join(repoRoot(), ".cursor", "ARCHITECTURE_BLUEPRINT.md");
  const text = readFileSync(path, "utf8");
  return jsonText({ path, text });
});

server.tool(
  "write_adr_draft",
  "Write ADR draft under OmniDatabase/notes/adr_drafts/ (does not edit live blueprint).",
  { title: z.string(), body_markdown: z.string() },
  async ({ title, body_markdown }) => {
    const dir = join(resolveDataRoot(), "notes", "adr_drafts");
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
    const file = join(dir, `${ts}_${slug(title)}.md`);
    writeFileSync(file, `# ${title}\n\n${body_markdown}\n`, "utf8");
    return jsonText({ written: file });
  }
);

server.tool(
  "write_arch_suggestion",
  "Write architecture suggestion markdown.",
  { title: z.string(), body_markdown: z.string() },
  async ({ title, body_markdown }) => {
    const dir = join(resolveDataRoot(), "notes", "adr_drafts", "suggestions");
    mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
    const file = join(dir, `${ts}_${slug(title)}.md`);
    writeFileSync(file, `# ${title}\n\n${body_markdown}\n`, "utf8");
    return jsonText({ written: file });
  }
);

await server.connect(new StdioServerTransport());
