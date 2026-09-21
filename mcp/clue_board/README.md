# 留痕线索板 MCP Server

独立 stdio MCP 进程，读写与 OmniPlayer 相同的 `OmniDatabase/notes/config/clue_boards.json`。

## 数据路径

| 项 | 值 |
|---|---|
| 默认文件 | `<OmniDatabase>/notes/config/clue_boards.json` |
| 图片文件 | `<OmniDatabase>/notes/config/clue_images/<file>`（节点只存相对引用 `image`，不是 base64） |
| 历史日志 | `<OmniDatabase>/notes/config/clue_history/<board_id>.jsonl`（按板 append-only；含 actor=human\|ai；快照只含 `image` 引用，不嵌二进制，回退不删图片文件） |
| 旧版迁移 | 若仅有 `clue_board.json`，首次读取时按 v1 结构迁移 |
| 环境变量 | `OMNI_DATABASE` 或 `OMNITRACE_DATA` → 数据根（**必须用绝对路径**；相对路径会跟进程 cwd 走，可能写到错库） |
| 自动探测 | 仓库 `OmniDatabase/`（按模块路径，不依赖 cwd）→ `%USERPROFILE%/OmniTrace/OmniDatabase` → `Downloads/OmniTrace/OmniDatabase` |

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
| `clue_board_create_note` | 添加便签节点（`text`、`x`、`y`、`w`、`h`、`color`、`parent_id`、`collapsed`、`kind`、`image` 可选；`image` 必须是已存在的 `clue_images/<file>` 引用） |
| `clue_board_update_note` | 更新节点文本、位置、尺寸、父子、折叠、kind 或 `image` 引用 |
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

## Cursor 项目配置（本仓库）

Cursor 读 **`.cursor/mcp.json`**（与 `.cursor/mcp.example.json` 相同：相对仓库根启动 `node mcp/clue_board/dist/index.js`）。`dist/` 不进 git，先 `cd mcp/clue_board && npm install && npm run build`。

**不要**把 `OMNITRACE_DATA` 设成相对路径 `OmniDatabase`（cwd 若不是仓库根会写到别的目录）。默认不设 env：服务器按自身文件位置探测仓库 `OmniDatabase/`（本机 OmniPlayer `data_root.json` 也指向这里）；没有仓库库则用 `%USERPROFILE%\OmniTrace\OmniDatabase`。

若要强制另一套库，在 `mcp.json` 里加**绝对路径**：

```json
"env": { "OMNITRACE_DATA": "D:/path/to/OmniDatabase" }
```

（exe 旁 `data_root.json` 的 `path`，或用户目录库。）

改完后：**Cursor Settings → MCP → 启用 `omnitrace-clue-board`**（新服务器常默认关），或 Reload Window。

## Cursor / Claude Desktop 绝对路径示例

路径按本机仓库位置修改：

```json
{
  "mcpServers": {
    "omnitrace-clue-board": {
      "command": "node",
      "args": [
        "E:/项目/agenticUI和流式笔记尝试/omnitrace_input/mcp/clue_board/dist/index.js"
      ],
      "env": {
        "OMNITRACE_DATA": "E:/项目/agenticUI和流式笔记尝试/omnitrace_input/OmniDatabase"
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
