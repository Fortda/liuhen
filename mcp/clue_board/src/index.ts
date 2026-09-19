#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { findBoard } from "./normalize.js";
import { appendFromBoard, listHistory, rollbackHistory } from "./history.js";
import { getDataRootInfo, readClueBoards, withClueBoards } from "./store.js";
import type { ClueBoardNode } from "./types.js";
import { newBoardId, newEdgeId, newNodeId } from "./types.js";

const server = new McpServer({
  name: "omnitrace-clue-board",
  version: "0.1.0",
});

const boardIdSchema = z
  .string()
  .optional()
  .describe("Board id; omit for active board");

function jsonText(obj: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
    isError,
  };
}

function toolError(message: string) {
  return jsonText({ error: message }, true);
}

async function runTool<T>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return toolError(message);
  }
}

server.tool(
  "clue_board_list",
  "List all clue boards (id, title, active flag).",
  {},
  async () =>
    runTool(async () => {
      const data = await readClueBoards();
      const info = getDataRootInfo();
      const boards = data.boards.map((b) => ({
        id: b.id,
        title: b.title ?? "",
        active: b.id === data.active_id,
        node_count: b.nodes.length,
        edge_count: b.edges.length,
      }));
      return jsonText({
        ...info,
        active_id: data.active_id,
        boards,
      });
    }),
);

server.tool(
  "clue_board_get",
  "Get a clue board (nodes, edges, view) by board_id or active board.",
  { board_id: boardIdSchema },
  async ({ board_id }) =>
    runTool(async () => {
      const data = await readClueBoards();
      const board = findBoard(data, board_id);
      if (!board) {
        return toolError(`board not found: ${board_id ?? data.active_id}`);
      }
      return jsonText({
        ...getDataRootInfo(),
        active_id: data.active_id,
        board,
      });
    }),
);

server.tool(
  "clue_board_create_note",
  "Add a sticky note (node) to an existing clue board. Prefer an existing board_id from clue_board_list. Do not call clue_board_create_board first unless the user asked for a new board.",
  {
    board_id: boardIdSchema,
    text: z.string().optional().describe("Note text"),
    x: z.number().optional().describe("X position (default 0)"),
    y: z.number().optional().describe("Y position (default 0)"),
    w: z.number().optional().describe("Width 120–1600 (UI clamp)"),
    h: z.number().optional().describe("Height 72–1200 (UI clamp)"),
    color: z.string().optional().describe("Optional color string"),
  },
  async ({ board_id, text, x, y, w, h, color }) =>
    runTool(async () => {
      const node = await withClueBoards((data) => {
        const board = findBoard(data, board_id);
        if (!board) throw new Error("board not found");
        const n: ClueBoardNode = {
          id: newNodeId(),
          text: text ?? "",
          x: x ?? 0,
          y: y ?? 0,
        };
        if (w != null) n.w = w;
        if (h != null) n.h = h;
        if (color != null) n.color = color;
        board.nodes.push(n);
        appendFromBoard(board, "ai", "add_node", {
          tool: "clue_board_create_note",
          label_key: "notes.clue.history.addNode",
        });
        return n;
      });
      return jsonText({ created: node, ...getDataRootInfo() });
    }),
);

server.tool(
  "clue_board_create_board",
  "Create a new clue board ONLY when the user explicitly asks for a new board. Never call this at the start of a chat. Returns board_id — do not invent ids.",
  {
    title: z.string().optional().describe("Board title"),
    set_active: z
      .boolean()
      .optional()
      .describe("If true (default), make the new board active"),
  },
  async ({ title, set_active }) =>
    runTool(async () => {
      const created = await withClueBoards((data) => {
        const id = newBoardId();
        const now = Date.now();
        const board = {
          id,
          title: title ?? "",
          nodes: [] as ClueBoardNode[],
          edges: [] as { id: string; from: string; to: string }[],
          view: { x: 0, y: 0, zoom: 1 },
          created_at: now,
          updated_at: now,
        };
        data.boards.push(board);
        if (set_active !== false) {
          data.active_id = id;
        }
        appendFromBoard(board, "ai", "create_board", {
          tool: "clue_board_create_board",
          label_key: "notes.clue.history.newBoard",
        });
        return { board_id: id, active: set_active !== false, title: board.title };
      });
      return jsonText({ ...created, ...getDataRootInfo() });
    }),
);

server.tool(
  "clue_board_update_note",
  "Update a note's text, position, or size.",
  {
    board_id: boardIdSchema,
    node_id: z.string().describe("Node id to update"),
    text: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    w: z.number().optional(),
    h: z.number().optional(),
    color: z.string().optional(),
  },
  async ({ board_id, node_id, text, x, y, w, h, color }) =>
    runTool(async () => {
      const updated = await withClueBoards((data) => {
        const board = findBoard(data, board_id);
        if (!board) throw new Error("board not found");
        const node = board.nodes.find((n) => n.id === node_id);
        if (!node) throw new Error(`node not found: ${node_id}`);
        if (text !== undefined) node.text = text;
        if (x !== undefined) node.x = x;
        if (y !== undefined) node.y = y;
        if (w !== undefined) node.w = w;
        if (h !== undefined) node.h = h;
        if (color !== undefined) node.color = color;
        appendFromBoard(board, "ai", "update_note", {
          tool: "clue_board_update_note",
          label_key: "notes.clue.history.editText",
        });
        return { ...node };
      });
      return jsonText({ updated, ...getDataRootInfo() });
    }),
);

server.tool(
  "clue_board_delete_note",
  "Delete a note and its connected edges.",
  {
    board_id: boardIdSchema,
    node_id: z.string().describe("Node id to delete"),
  },
  async ({ board_id, node_id }) =>
    runTool(async () => {
      const result = await withClueBoards((data) => {
        const board = findBoard(data, board_id);
        if (!board) throw new Error("board not found");
        const beforeNodes = board.nodes.length;
        const beforeEdges = board.edges.length;
        board.nodes = board.nodes.filter((n) => n.id !== node_id);
        if (board.nodes.length === beforeNodes) {
          throw new Error(`node not found: ${node_id}`);
        }
        board.edges = board.edges.filter(
          (e) => e.from !== node_id && e.to !== node_id,
        );
        appendFromBoard(board, "ai", "delete_node", {
          tool: "clue_board_delete_note",
          label_key: "notes.clue.history.deleteNode",
        });
        return {
          deleted_node_id: node_id,
          removed_edges: beforeEdges - board.edges.length,
        };
      });
      return jsonText({ ...result, ...getDataRootInfo() });
    }),
);

server.tool(
  "clue_board_add_edge",
  "Add a directed edge (arrow) between two notes.",
  {
    board_id: boardIdSchema,
    from: z.string().describe("Source node id"),
    to: z.string().describe("Target node id"),
    edge_id: z.string().optional().describe("Optional edge id"),
  },
  async ({ board_id, from, to, edge_id }) =>
    runTool(async () => {
      const edge = await withClueBoards((data) => {
        const board = findBoard(data, board_id);
        if (!board) throw new Error("board not found");
        if (!board.nodes.some((n) => n.id === from)) {
          throw new Error(`from node not found: ${from}`);
        }
        if (!board.nodes.some((n) => n.id === to)) {
          throw new Error(`to node not found: ${to}`);
        }
        if (from === to) throw new Error("from and to must differ");
        if (board.edges.some((e) => e.from === from && e.to === to)) {
          throw new Error(`edge already exists: ${from} -> ${to}`);
        }
        const e = { id: edge_id?.trim() || newEdgeId(), from, to };
        board.edges.push(e);
        appendFromBoard(board, "ai", "add_edge", {
          tool: "clue_board_add_edge",
          label_key: "notes.clue.history.addEdge",
        });
        return e;
      });
      return jsonText({ created: edge, ...getDataRootInfo() });
    }),
);

server.tool(
  "clue_board_delete_edge",
  "Delete an edge by id, or by from/to pair.",
  {
    board_id: boardIdSchema,
    edge_id: z.string().optional().describe("Edge id"),
    from: z.string().optional().describe("Source node id (with to)"),
    to: z.string().optional().describe("Target node id (with from)"),
  },
  async ({ board_id, edge_id, from, to }) =>
    runTool(async () => {
      const result = await withClueBoards((data) => {
        const board = findBoard(data, board_id);
        if (!board) throw new Error("board not found");
        const before = board.edges.length;
        if (edge_id) {
          board.edges = board.edges.filter((e) => e.id !== edge_id);
        } else if (from && to) {
          board.edges = board.edges.filter(
            (e) => !(e.from === from && e.to === to),
          );
        } else {
          throw new Error("provide edge_id or both from and to");
        }
        if (board.edges.length === before) {
          throw new Error("edge not found");
        }
        appendFromBoard(board, "ai", "delete_edge", {
          tool: "clue_board_delete_edge",
          label_key: "notes.clue.history.deleteEdge",
        });
        return { deleted: true, edge_id, from, to };
      });
      return jsonText({ ...result, ...getDataRootInfo() });
    }),
);

server.tool(
  "clue_board_set_active",
  "Set the active clue board (UI selection).",
  {
    board_id: z.string().describe("Board id to activate"),
  },
  async ({ board_id }) =>
    runTool(async () => {
      const active_id = await withClueBoards((data) => {
        const id = board_id.trim();
        if (!data.boards.some((b) => b.id === id)) {
          throw new Error(`board not found: ${id}`);
        }
        data.active_id = id;
        return id;
      });
      return jsonText({ active_id, ...getDataRootInfo() });
    }),
);

server.tool(
  "clue_board_list_history",
  "List durable chronological version history for a clue board (survives app restart). Each step has seq, ts, actor (human|ai), action. Use before clue_board_rollback.",
  {
    board_id: boardIdSchema,
  },
  async ({ board_id }) =>
    runTool(async () => {
      const list = await listHistory(board_id);
      return jsonText({ ...list, ...getDataRootInfo() });
    }),
);

server.tool(
  "clue_board_rollback",
  "Restore a clue board to a prior history seq (full snapshot). Appends a rollback audit entry; does not delete older steps. Prefer for undo / version restore. Actor recorded as AI.",
  {
    board_id: boardIdSchema,
    seq: z.number().int().describe("Target history seq from clue_board_list_history"),
  },
  async ({ board_id, seq }) =>
    runTool(async () => {
      const result = await rollbackHistory(board_id, seq);
      return jsonText({ ...result, ...getDataRootInfo() });
    }),
);

server.resource(
  "active-board",
  "clue-board://active",
  {
    description: "JSON snapshot of the active clue board",
    mimeType: "application/json",
  },
  async (uri) => {
    const data = await readClueBoards();
    const board = findBoard(data, data.active_id);
    const payload = {
      uri: uri.href,
      ...getDataRootInfo(),
      active_id: data.active_id,
      board: board ?? null,
    };
    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
