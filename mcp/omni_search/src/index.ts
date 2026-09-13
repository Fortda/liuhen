#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { webSearch } from "./search.js";

const server = new McpServer({ name: "omnitrace-omni-search", version: "0.1.0" });

server.tool(
  "web_search",
  "Search the web using user-configured engine in notes settings.",
  { query: z.string() },
  async ({ query }) => ({
    content: [{ type: "text" as const, text: JSON.stringify(await webSearch(query), null, 2) }],
  })
);

await server.connect(new StdioServerTransport());
