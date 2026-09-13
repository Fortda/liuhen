/**
 * Smoke test: list + get active board (no MCP client required).
 * Run after `npm run build` from mcp/clue_board.
 */
import { readClueBoards } from "../dist/store.js";
import { getDataRootInfo } from "../dist/store.js";
import { findBoard } from "../dist/normalize.js";

const info = getDataRootInfo();
console.log("data_root:", info.data_root);
console.log("clue_boards_path:", info.clue_boards_path);

const data = await readClueBoards();
console.log("active_id:", data.active_id);
console.log(
  "boards:",
  data.boards.map((b) => ({ id: b.id, title: b.title, nodes: b.nodes.length })),
);

const active = findBoard(data, data.active_id);
console.log("active board nodes:", active?.nodes.length ?? 0);
console.log("smoke test OK");
