# 留痕线索板 MCP Server

独立 stdio MCP 进程，读写与 OmniPlayer 相同的 `OmniDatabase/notes/config/clue_boards.json`。

## 数据路径

| 项 | 值 |
|---|---|
| 默认文件 | `<OmniDatabase>/notes/config/clue_boards.json` |
| 历史日志 | `<OmniDatabase>/notes/config/clue_history/<board_id>.jsonl`（按板 append-only；含 actor=human\|ai） |
| 旧版迁移 | 若仅有 `clue_board.json`，首次读取时按 v1 结构迁移 |
| 环境变量 | `OMNI_DATABASE` 或 `OMNITRACE_DATA` → 数据根目录 |
| 自动探测 | 仓库内 `OmniDatabase/`、cwd 向上、用户 `Downloads/OmniTrace/OmniDatabase` |

## 安装与构建

```bash
cd mcp/clue_board
npm install
npm run build
```

启动（stdio，供 Cursor / Claude Desktop 调用）：

```bash
node dist/index.js
```

## MCP Tools

| Tool | 说明 |
|------|------|
| `clue_board_list` | 列出所有板：`id`、`title`、`active`、节点/边数量 |
| `clue_board_get` | 获取指定板或 active 板的 `nodes` / `edges` / `view` |
| `clue_board_create_board` | 新建空板（返回 `board_id`，勿臆造 id） |
| `clue_board_create_note` | 添加便签节点（`text`、`x`、`y`、`w`、`h`、`color` 可选） |
| `clue_board_update_note` | 更新节点文本、位置或尺寸 |
| `clue_board_delete_note` | 删除节点及关联边 |
| `clue_board_add_edge` | 添加有向边（`from` → `to`） |
| `clue_board_delete_edge` | 按 `edge_id` 或 `from`+`to` 删除边 |
| `clue_board_set_active` | 切换 `active_id` |
| `clue_board_list_history` | 列出该板持久化版本历史（seq / actor / action；重启不丢） |
| `clue_board_rollback` | 按 seq **全量快照回退**（追加 rollback 审计行，不删旧步骤） |

## MCP Resource

| URI | 说明 |
|-----|------|
| `clue-board://active` | 当前 active 板的 JSON 快照 |

## 并发说明

写操作使用 `proper-lockfile` 对 `clue_boards.json` 加锁，read-modify-write 后 normalize（语义对齐 Tauri `notes_ctl.rs`）。

若 OmniPlayer 线索板页正在编辑，仍可能出现 UI 覆盖 MCP 写入的情况；**建议 MCP 批量操控时暂时不要在前端编辑同一块板**。

## Cursor 配置示例

在项目或用户 MCP 配置中加入（路径按本机仓库位置修改）：

```json
{
  "mcpServers": {
    "omnitrace-clue-board": {
      "command": "node",
      "args": [
        "E:/项目/agenticUI和流式笔记尝试/omnitrace_input/mcp/clue_board/dist/index.js"
      ],
      "env": {
        "OMNI_DATABASE": "E:/项目/agenticUI和流式笔记尝试/omnitrace_input/OmniDatabase"
      }
    }
  }
}
```

也可使用 `npm run start` 前先 `cd mcp/clue_board && npm run build`。

## Claude Desktop 配置示例

`claude_desktop_config.json` 中同样添加 `mcpServers.omnitrace-clue-board` 条目，`command` / `args` / `env` 与上相同。

## 本地 smoke test

```bash
npm run build
npm run test:smoke
```
