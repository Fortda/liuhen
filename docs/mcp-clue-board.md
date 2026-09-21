# 线索板 MCP（配置速查）

完整说明见 [`mcp/clue_board/README.md`](../mcp/clue_board/README.md)。

## 用途

供外部 AI（Cursor、Claude Desktop 等）通过 MCP **读取和编辑线索板**，数据与 OmniPlayer 笔记页「线索板」模式共用 `clue_boards.json`。

## 快速配置（Cursor）

复制 `.cursor/mcp.example.json` → `.cursor/mcp.json`（相对命令、不设 env，由服务器探测仓库 `OmniDatabase/`）。若实际库不在仓库内，加绝对路径 env `OMNITRACE_DATA`（exe 旁 `data_root.json` 的 path，或 `%USERPROFILE%\OmniTrace\OmniDatabase`）。改完后启用 `omnitrace-clue-board` 或 Reload Window。

```json
{
  "mcpServers": {
    "omnitrace-clue-board": {
      "command": "node",
      "args": ["mcp/clue_board/dist/index.js"]
    }
  }
}
```

构建：`cd mcp/clue_board && npm install && npm run build`

## Tools 一览

- `clue_board_list` / `clue_board_get`
- `clue_board_create_board`
- `clue_board_create_note` / `clue_board_update_note` / `clue_board_delete_note`（便签可含 `parentId` / `collapsed` / `kind`）
- `clue_board_add_edge` / `clue_board_delete_edge`
- `clue_board_set_active`
- `clue_board_list_history` / `clue_board_rollback`

Resource：`clue-board://active`
