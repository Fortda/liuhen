# OmniTrace 流式笔记蓝图（细节）

> **公开架构**。总览与契约见 [OVERVIEW.md](OVERVIEW.md) §5.1。  
> 只写笔记 / MCP / 线索板 / 时间轴 / 参数窗等「现在是什么」；改契约时同步改 OVERVIEW 那一句。

---

## 1. 三模式与总边界

笔记页 `#page-notes`（`notes.ts`）顶栏 segmented：**流式笔记** / **线索板** / **时间轴**。

- 流式笔记 = LLM 卡片 + composer；落盘 `notes/cards|logs|config/`；LiteLLM sidecar、providers、pricing、搜索 `search_config.json`。
- 线索板 = `notes_clue_board.ts` + `clue_boards.json`（+ 版本史，见 §4）。
- 时间轴 = `notes_timeline.ts` + `time_view_nav.ts`（同日历尺子挂卡片）。
- 内嵌助手**不是** coding agent：工具白名单（只读数据/蓝图、ADR 草稿、仪表盘三页 UI 前端、线索板含建板/加边/历史回退、按设置搜索、artifacts）；**禁止**自动改架构文档与采集 / `dashboard_ctl`。
- **有 MCP 时** `notes_send_turn` 最多 8 轮 tool 循环 + 协议日志（请求只记摘要，不落整包 messages）；无 MCP 则原单轮。Enter 发送，Shift/Ctrl/Cmd+Enter 换行。
- **工具调用契约**：优先 OpenAI `message.tool_calls`。若模型把 DeepSeek DSML（含 `<｜DSML｜…>` / 双竖线变体 / `calls` / `tool_calls` 块）或常见 `<tool_call>{json}</tool_call>` 写进 **content**（含 8 轮后的**最终流式**正文），Rust 会解析并转成同等 `tool_calls` 再执行；解析失败且正文仍像工具标记时不直接当终答展示。**MCP 活动面板只负责展示**已进入循环的工具回合，不替代本解析。
- **尚未实现**：接地阅读器，见 [OVERVIEW.md](OVERVIEW.md) §7。

---

## 2. 流式笔记 / Composer / 参数窗

- **选模型**：Composer 按钮开本轮模型列表；工具栏显示完整 `provider · model`。菜单底可 **刷新模型**（`notes_refresh_models_if_stale(0)`）与 **编辑模型**（Hermes 式可见开关）。**连接配置**在 **设置 → 语言模型**（Lobe 式左列表右详情；左列主标题=显示名称，副标题=厂商；保存/检测只发现当前卡）；可见性共用 `providers.json` 的 `disabled_model_keys`（缺省空=全开，新发现默认开）。服务商 / API Key / LiteLLM sidecar / `network.json` 仍只在该子页。
- **参数窗**：按当前模型协议白名单只露可下发字段——如 DeepSeek V4 为 thinking + `reasoning_effort` low/high/max（thinking 开时隐藏无效采样）；OpenAI reasoning 为 effort low/medium/high。本轮段随模型协议裁剪（无通用 Fast；effort 原样下发），换模型即换可选项。窗底有 **API 走本地代理**（写 `network.json`，与设置→语言模型同一开关，改完重拉 sidecar）；服务商 Key / LiteLLM 仍链到该子页。
- **代理二分**：`network.json`「API 走本地代理」= 对话 LiteLLM sidecar 的 HTTP_PROXY（参数窗与设置→语言模型两入口）；各服务商卡片右侧「代理」另管该卡保存/拉模型/测试是否走代理。
- **流式状态**：等待时显示「等待服务器响应… / 思考中… / MCP 回合…」。**有 MCP 时 tool 循环为非流式**（长文/思考会久），Rust 每 5s 心跳刷新状态并写入 `request_sent`/`first_byte`，禁止一直空白 TTFB；工具失败显示在卡片状态。**MCP 活动面板**：`notes-stream-status` 可带结构化 `activity`（`phase` / `round` / `thinking` / `tools[]` 含 name·target·status；思考多段用 `---` 拆），整板可折叠（运行中展开、结束后默认收起），按轮折叠思考、工具按名/显式桶归 **Explore / Edited**（桶内保持调用序）；**结束后仍保留**（落盘 `mcp_activity`；旧卡可从协议日志重建）。展示为 Cursor 式无框折叠行（思考下拉、工具紧凑行），展开控件不是描边按钮。`data` 抽屉仍是原始协议日志。**SSE `error` 帧与空正文**一律标 `status=error` 并带回原文（禁止静默空成功）。
- Google 写 yaml 时用 `custom_llm_provider: gemini`、**不**强写 `generativelanguage…/v1beta` api_base（避免 tools/googleSearch 误走 Vertex 404）。参数窗可对 Gemini 开 Google Search grounding（`tools: [{ googleSearch: {} }]`）；Gemini 3 的 `thinking_level` 经 `reasoning_effort` 下发。**Gemini 3.7 / 3.8 Flash** 支持 low/medium/high，**不**发 `minimal`（会 400），也**不**发 `thinking.enabled` / `budget_tokens`。LiteLLM 白名单写回 yaml 在设置子页。
- **MCP 小窗**：逐项开关 + 「告诉 AI 与本软件有关」；prefs `notes/config/mcp_prefs.json` + `localStorage`。线索板 MCP **不**在每轮对话默认 `clue_board_create_board`；仅用户明确要求建板，或用户正在看某块板时用该 `board_id`。
- **NONE 模型**：只落用户话（`notes_save_user_only_card`）。
- **用户气泡**：超约 6 行（`1.55em × 6` ≈ 132px）默认折叠，可展开/收起；短消息不折。流式新发送同样默认折。Composer 工具栏 **色温**（`notes_color_temp.ts`）：击键间隔短偏暖红、长偏冷蓝；只作用于输入框与用户气泡（助手不变）；开关 `localStorage omnitrace.notes.colorTemp`，字形随卡片落盘 `user_glyphs`。
- 绿线历史 + 连线存档侧栏。「+新对话」建空档。无选中存档时「保存当前组合」弹对话框（空名=未命名；可勾选让 AI 写名称和备注）。设置首页：**是否由当时对话的 AI 写存档名/备注**；否则指定总结模型。绿线是连通块的**成员集合**：可视化按 feed/`created_at` 序画相邻折线（A—C 再接入 B → A—B—C，不留跨过已选中卡的弦）；落盘边表与此路径一致。绿线进 `notes_send_turn` 时 **稳定按 `created_at` 升序**，并注入 system 时间戳清单（`[prior_turn_timestamps]`，含 ms / UTC / card_id）；MCP `list_recent_cards` 亦升序。卡片落盘 `mcp_servers` / `mcp_tools`（首次调用序）；**data 抽屉**顶栏标注本卡用过的 MCP。连线存档 JSON `created_at`/`updated_at`（缺则下次保存用 `wire_presets.json` mtime，不编造墙钟）；`updated_at` 仅在该组合内容变更时刷新。左列表标题行可 **是否隐藏备注**（`localStorage omnitrace.notes.preset.hideNotes`）；瓷砖显示 **对话轮数**（该档卡片数，不含 composer）与相对时间（`1h前`/`1d前`，满 10 天改日历日）；悬停 `.omni-float` 出备注全文与时刻，不打开存档。左列表无删除叉；右键「详情 / 删除」。
- 助手卡片右下角费用角标复用 Rust `compute_cost`（牌价 × usage；`input_usd`=未缓存输入，`cache_read_usd`=缓存命中，`output_usd`=输出；无 cache 字段则命中=0）。设置→外观 **笔记费用显示** 人民币/美元（`localStorage omnitrace.notes.cost.currency`）；人民币用可改汇率（默认 **1 USD = 7.2 CNY**，`omnitrace.notes.cost.usdToCny`，非实时牌价）。换算只影响脚注/价表/Context Usage，不改落盘 USD。
- Composer 工具栏 **Context Usage**（`notes_context_usage.ts`）：分段条可扩展 Skills/MCP（`setContextUsageExtras`）；token 只信卡片 usage + 价表 `max_input_tokens`，不本地分词；无 MCP 数据时骨架段为 0。
- **卡片导航刻度**（`notes_card_rail.ts`）：刻度条贴 feed 视口**右缘**、列身竖直居中；`#notes-feed` 滚动时，视口竖直中心最近卡片 ↔ 刻度条竖直中心刻度（可负 offset 使首/末卡居中）；底端 CSS mask 渐隐。悬停简略列表贴右缘刻度左侧；指针进入/离开以透明度与位移缓动（约 200ms），离开播完再卸面板（`prefers-reduced-motion` 瞬时）。
- 模型列表按服务商分组：组头=卡片**自定义显示名称** + 厂商图标；行内 ★ 置顶 → `pinned_model_keys`；Composer/设置开关 → `disabled_model_keys`（均在 `providers.json`）。Google 发现只保留支持 `generateContent` 的对话模型。能力徽章：Gemini 1.5+/2.x/3.x 对话族默认认原生多模态（含音频）。中转：OpenAI 兼容 `GET /v1/models`（优先于裸 `/models`；非 JSON 带 HTTP 状态与截断正文，继续试下一 URL），不耗聊天 token。
- 设置→语言模型 可 **导入 AI Studio/Gemini JSON 导出**（`notes_import_aistudio_export` → `import_source=aistudio`，报告 `notes/config/aistudio_import_report_*.json`）。
- 协议日志抽屉 + 人话/输入信封视图。

---

## 3. 浮层与动效（`.omni-float`）

笔记浮层（模型列表 / 模型详情 / 参数窗 / 费用角标明细 / Context Usage / 漏斗 / 线索板与连线存档右键与列表悬停等）统一走 `.omni-float` + `omni_float.ts`：

- `placeFloatInViewport` **禁止与锚点按钮重叠**；空间不够压 `max-height` 贴上/下方留 `FLOAT_GAP`。
- 动效：CSS 变量 `--omni-float-ms` / `--omni-float-ease` / `--omni-float-from` 与 `html[data-motion]`；当前仅 `pop-a`；偏好 `localStorage omnitrace.motionStyle`；设置→外观「动效风格」；`prefers-reduced-motion` 瞬时。禁止各菜单自写另一套 0.12s。
- 定位夹在**壳窗口内**（边距 12px）。子菜单贴父菜单外沿，不叠盖。
- 卡片脚注 `title` 随 `<html lang>`（当前 `zh-CN`）。

---

## 4. 线索板与版本史

- UI：`notes_clue_board.ts`。便签右上六点球冠叫「把手」；左键拖把手挪便签，**拖把手过程中再按右键 = 平移视口**（便签跟手补偿；松右键停，无惯性）；空白处仍左键长按平移 / 右键菜单或框选；滚轮缩放保留；点文字编辑亦 `is-selected` 蓝光；Ctrl/Cmd+点多选便签；**Ctrl/Cmd+点亦可多选红线连线**（互斥于便签多选）；**多选便签时拖任一角缩放把手，按同 delta 同步缩放**（相对尺寸保留）。左列表竖标签无删除叉；右键「详情 / 多选 / 删除」（仅多于一块板时出删除，确认同前）。Ctrl/Cmd+点列表也可多选。
- 持久化 `clue_boards.json`：**拒写空覆盖**；写文件时先写完整 tmp 再 **copy 覆盖**（禁止先删 dest，避免 Windows 空窗读到 legacy `clue_board.json` 并 mint 新 id）；`clue_boards.json.bak` + 按日 `clue_boards_bak/`。**UI `notes_clue_board_save` = 按 id upsert**（磁盘/history 孤儿有、payload 没有的板一律保留；同板若磁盘 `updated_at` 更新则并入磁盘独有 node/edge id，避免 MCP 加便签被过期 persist 踩掉）。删除走 `notes_clue_board_delete`。MCP 突变在同一进程锁内 load→mutate→replace，成功后 emit `notes-clue-boards-changed`；UI persist 用返回的完整列表补全侧栏。加载时把 `clue_history/<id>.jsonl` 里有、注册表没有的板从最新快照救回（先写 `clue_boards.json.bak_before_restore_*`）。历史仍在 `clue_history/<board_id>.jsonl`。每板 `created_at` / `updated_at`（Unix ms）写在该 JSON；缺则下次保存从该板 history 首/末 `ts` 补，再 history 文件 mtime，再 `clue_boards.json`（或旧 `clue_board.json`）mtime——**不编造墙钟**；详情可显示「未知」。`updated_at` 仅在该板内容（标题/便签/连线/视口）变化时刷新。
- **版本史**（Photoshop 式：一板一史）：每板 append-only `notes/config/clue_history/<board_id>.jsonl`（全量快照 + `actor=human|ai`）；仅记录该板内容变更（便签/连线/视口/标题/回退/初始种子）。**切换板 / `set_active` 不写历史**。回退=恢复目标 seq 快照并追加 `rollback` 行（不截断旧日志）。工具栏「历史」面板与 MCP `clue_board_list_history` / `clue_board_rollback` 共用。
- 独立 stdio：`mcp/clue_board/`（读写 boards + history）。

---

## 5. 笔记时间轴

- 同日历尺子挂卡片于 `created_at`；交互与仪表盘同一契约——滚轮平移、Alt+滚轮光标锚缩放、摩擦惯性、长按≈100ms 拖移、Alt 守卫。
- 过密时按本地日折叠为下引线+当日首条用户前缀；点击回到流式并聚焦该卡。
- 研究资料落盘 `notes/research/Century…/Day_DD/<id>/`（`meta.json` + 原文件），索引 `notes/config/research_index.jsonl`，时间轴橙点并列卡片。
- 顶栏漏斗（`.omni-float`，`notes_timeline_filter` / `notes_timeline_funnel`）可筛图层（卡片/资料）+ 模型 / `import_source` / 失败卡 / 格式 / 动机非空；偏好 `localStorage omnitrace.notes.timelineFilter`。

---

## 6. 相关 Tauri / MCP 入口（笔记向）

- LLM：`llm_sidecar_*`、`notes_send_turn`（可选 `history` + `opts.mcp`）、`notes_save_user_only_card`、`notes_import_aistudio_export`、`notes_mcp_prefs_*`、`notes_search_config_*`、`notes_litellm_settings_*`、`notes_sidecar_network_*`、`notes_providers_set_disabled`、`notes_list_cards`、…
- 密钥与配置：`OmniDatabase/notes/config/`（不进 git）。
- 外部 Cursor：`mcp/omni_{data,arch,dash_ui,search,artifact}/` + `mcp/clue_board/`；内嵌执行在 Rust `notes_mcp.rs`（工具名对齐）。
- 摘窗：`shell_open_notes_window` / `shell_close_notes_window` / `notes-dock-changed` 等（XOR 契约见 [OVERVIEW.md](OVERVIEW.md) §2 / §5.1）。

---

## 7. 壳应用栏（`shell_apps.ts`，MVP）

- 入口：横向标签 + 无框 `+` + 右侧无框 `#btn-shell-apps`，同处应用列顶栏扁平条（`.shell-apps-head`，底 1px 发丝线）。列收起时该钮在 `#body` 右上角同款无框图标，**不**挨标题栏最小化/最大化/关闭。
- `+` 菜单（可搜索）：**对话窗** / 线索板 / Canvas / Browser / Terminal / File。悬停「线索板」「对话窗」出侧向子菜单（可搜索）挑选具体板 / 连线存档；点选后在顶栏标签条打开该实例（已开则聚焦）。标签=已打开窗口（混合种类，点标签切换可见内容）。宽度可拖；`localStorage omnitrace.shell.apps.v1`。
- **对话窗**：复用同一 `#notes-chat-view`（`setChatAppsHosted`）；应用栏内隐藏左侧「连线存档」竖列——选档改走 `+` 子菜单，不在画布里再做一条横向切档。切对话标签时 `applyWirePreset`。笔记页内流式仍保留左侧列表。可开关「仅绿线」（仅当前对话标签显示；`localStorage omnitrace.notes.hideNonGreen`）。
- **线索板**：同一 `#notes-clue-board-view` 可迁入（`setClueAppsHosted`）；应用栏内隐藏左侧板列表——选板改走 `+` 子菜单。多块板各自为标签；因单 DOM，切标签 `switchBoard`（不是画布内第二排 chips）。笔记页内线索板仍保留左侧列表。
- **Browser**：对话框选文件；PDF/图/HTML/文本等 `convertFileSrc` 内嵌；Office 走 `openPath` 系统打开。
- **Terminal**：`apps_run_shell` 单次 PowerShell（非交互 PTY，~12s 超时）+ 可开外部终端。
- **File**：`apps_list_dir` 惰性展开的竖向文件树（默认根 = 上次目录或数据根的上一级工作区）；点文件开/复用 Browser；「打开文件夹」只改根，不作主浏览。
- **Canvas**：本机 textarea 草稿（面板状态进 localStorage）；非完整画布产品。
- Tauri：`apps_run_shell` / `apps_list_dir`；asset protocol 开本地预览。