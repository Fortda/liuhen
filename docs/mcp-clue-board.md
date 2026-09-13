# 线索板 MCP（配置速查）

完整说明见 [`mcp/clue_board/README.md`](../mcp/clue_board/README.md)。

## 用途

供外部 AI（Cursor、Claude Desktop 等）通过 MCP **读取和编辑线索板**，数据与 OmniPlayer 笔记页「线索板」模式共用 `clue_boards.json`。

## 快速配置（Cursor）

`.cursor/mcp.json` 或 Cursor Settings → MCP：

```json
{
  "mcpServers": {
    "omnitrace-clue-board": {
      "command": "node",
      "args": ["<repo>/mcp/clue_board/dist/index.js"],
      "env": {
        "OMNI_DATABASE": "<repo>/OmniDatabase"
      }
    }
  }
}
```

构建：`cd mcp/clue_board && npm install && npm run build`

## Tools 一览

- `clue_board_list` / `clue_board_get`
- `clue_board_create_note` / `clue_board_update_note` / `clue_board_delete_note`
- `clue_board_add_edge` / `clue_board_delete_edge`
- `clue_board_set_active`

Resource：`clue-board://active`
