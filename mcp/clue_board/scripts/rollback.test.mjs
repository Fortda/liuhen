import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const dir = mkdtempSync(join(tmpdir(), "omni-clue-"));
process.env.OMNI_DATABASE = dir;

const { withClueBoards, readClueBoards } = await import("../dist/store.js");
const { appendFromBoard, rollbackHistory } = await import("../dist/history.js");

test("rollback restores the locked snapshot", async () => {
  let seq = 0;
  await withClueBoards((data) => {
    const board = data.boards[0];
    board.nodes.push({ id: "n1", text: "first", x: 0, y: 0 });
    seq = appendFromBoard(board, "human", "add").seq;
  });
  await withClueBoards((data) => {
    const board = data.boards[0];
    board.nodes[0].text = "second";
    appendFromBoard(board, "ai", "edit");
  });
  const rolled = await rollbackHistory(undefined, seq);
  assert.equal(rolled.restored_seq, seq);
  const data = await readClueBoards();
  assert.equal(data.boards[0].nodes[0].text, "first");
  rmSync(dir, { recursive: true, force: true });
});
