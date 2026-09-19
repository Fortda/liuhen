# OmniTrace architecture overview

**般若计划**下的 **OmniTrace**：当前系统长什么样（契约，不是第二份源码说明书）。

专门细节：[notes.md](notes.md)（笔记 / MCP / 线索板）、[dashboard.md](dashboard.md)（仪表盘常数）、[android.md](android.md)（手机旁路）。  
决策见 [docs/adr](../adr/README.md)。发版：[CHANGELOG.md](../../CHANGELOG.md)、[releasing.md](../releasing.md)。

改了契约，同步改本目录对应文件。

---

## 1. 产品是什么

**Windows 采集（WinRecorder）+ 回放/直播（OmniPlayer）+ 仪表盘**；边载 **Android 采集**（`omnitrace_android`，**当前几乎不可用**，本期不进 Windows OmniPlayer）。关于页：情报和信息采集，以及现象世界模型运行日志。数据默认本机 `OmniDatabase/`，**不上传**。公开仓库 MIT：<https://github.com/Fortda/omnitrace>。

- Win 采集：单进程 Rust `omnitrace_input.exe`，进程内插件。
- Android：源码在 `omnitrace_android/`，现状是一堆 bug、几乎没法当日常用。打算以后**本机局域网**和电脑联动；不要把本期 APK 当成品。
- 壳：Tauri 2 + Vite + 原生 TS；无边框标题栏。WebView2 **回环直连**（`--proxy-server=direct://` + `<-loopback>`），避免 Clash 劫持 `localhost`。
- 数据双轨：`OmniDatabase/`——高频压缩 bin + ModuleEvent JSONL。

---

## 2. 进程与启动

```text
OmniPlayer (Tauri 单实例) ──recorder_ctl──► omnitrace_input.exe (单实例，独立后台)
        │  main 窗 ± notes 可摘窗（XOR）              │ 写 → OmniDatabase/
        └── notes ──llm_sidecar──► LiteLLM (:4000)
```

- **稳定版入口**：`%LOCALAPPDATA%\OmniTrace\OmniPlayer.exe`；旁路 `data_root.json` 指数据根。**设置页可改数据存放位置**（写 exe 旁同一指针，不搬移已有库；采集运行中拒绝改）；该开关只在设置。开发机 `-Install` 指仓库 `OmniDatabase/`。公开 **setup.exe**（`OmniTrace-*-windows-x64-setup.exe`）= 每用户向导（默认 `%LOCALAPPDATA%\OmniTrace`、HKCU 卸载、桌面/开始菜单快捷方式）+ 壳与采集 exe + 写指针到 `%USERPROFILE%\OmniTrace\OmniDatabase`；**包内仍无库**。zip 仍提供（同内容便携位 + `安装到本机.bat`）。无指针时 candidate 仍认仓库/已有库（含用户目录与旧的下载目录路径），否则新库落用户目录。壳一律 `resolve_data_root`；禁止 cwd 相对另起空库。正式包须 `custom-protocol`（`package.ps1` 校验）。增量只换 exe（`incoming\` / 关于更新）；绝不改 `OmniDatabase`。安装：朋友用 setup.exe；zip 内 `安装到本机.bat`；开发机 `omniplayer/package.ps1 -Install` / `scripts/install-stable.ps1`。卸载只删程序目录，不删用户库。
- **开发**：`scripts/run-app.bat` 或 `cd omniplayer && npm run tauri dev`。笔记快捷：`scripts/run-app.bat --page=notes`。
- **CLI**：`--page=notes|settings|player|dashboard`；`notes` 时另开 `label=notes` WebView。
- **笔记 XOR 摘窗**：嵌主窗或独立窗，禁止双开同编；摘出/关窗/收回前 `flushNotesPersist`。
- **壳单实例**：第二次启动转发 argv（`--page=notes` → 前置笔记窗）。
- **首屏**：默认设置页；player/dashboard/notes **dynamic import**；LiteLLM sidecar 延至首次发消息。
- **进程解耦**：采集器独立后台（`DETACHED_PROCESS`）；关壳 / 停 `tauri dev` **不**杀采集。设置页只发启停（`--stop` / spawn）。判活读 `control/winrecorder_clock.json` / `module_health.jsonl`。
- **采集单实例**：`control/winrecorder.pid` + tasklist + 心跳。稳定版 spawn 旁路 exe（cwd=数据根上一级）；dev 仍 `cargo build --bin omnitrace_input`。

---

## 3. 仓库布局（当前）

| 路径 | 职责 |
|------|------|
| `src/` | 采集宿主（`bin_host`、`modules`、`capture`、`paths`、`health`、钩子） |
| `omnitrace_android/` | Android 采集 APK（不进 OmniPlayer） |
| `omniplayer/` | 壳：`src/{main,player,dashboard,notes*}.ts` + `src-tauri/` |
| `omniplayer/src/{lod_band,input_series,time_axis}.ts` | LOD / 日瓦片 / 日历尺子 |
| `omniplayer/src/modules/` | 播放侧模组 |
| `OmniDatabase/` | 运行时数据（不进 git） |
| `versions/` | 里程碑 DECISIONS（`PROMPT.md` 不进 git） |
| `mcp/clue_board/`、`mcp/omni_*/` | 线索板 + 笔记 MCP stdio |
| `docs/architecture/` | **人读**架构总览与专门蓝图（本文） |
| `docs/adr/` | 架构决策记录（为什么） |
| `Cargo.toml` / `README.md` | 包名 `omnitrace_input`；人读用法 |

---

## 4. 采集宿主（Rust）

### 4.1 插件契约

- `TraceModule`：`info` / `start` / 可选 `tick` / `stop` / `status`。
- `ModuleRegistry`：注册、enable、start_all、`manifest.json`、500ms `tick_all`。
- ID：`input` | `focus` | `win_map` | `win_settings` | `body` | `network` | `ime` | `browser`。
- **默认启用**：除 `browser`（桩）外全部启用。上列是**当前闭集**（内置编译）。第三方成对插件 ABI 见 §7「以后」（尚未实现）。

### 4.2 各模组（记录侧）

| 模组 | 机制 | 写出 |
|------|------|------|
| input | `rdev` + 写线程 | `EventData/.../trace_DD.bin` |
| focus | 共享 `win_state_hook` | `ModuleData/focus/.../events_DD.jsonl` |
| win_map | 状态钩 + `win_move_hook` + tick | `ModuleData/win_map/...` + icons/wallpapers |
| win_settings | 启动快照 + ~2s diff | `settings_snapshot` / `settings_change` |
| body | 独立线程 10s；tick drain | inventory / device / link / `hk_sample` / unavailable |
| network | Tcp/Udp 表 ~15s；变化写 delta | `conn_snapshot` / `conn_delta`（非抓包） |
| ime | 兄目录 `weasel-omni-probe` 侧路 | `compose_update` / `commit`；写 `data_root.txt` |
| browser | 桩 | hello / Unavailable |

**不变量**：focus 与 win_map **共用** `win_state_hook`（引用计数）；几何走独立 move hook。

### 4.3 键鼠 bin（compressed_bin_v3）

大端；相对压缩 + 绝对锚点。解码：`player.ts`；赶进度：Rust `advance_bin_decode`（共享读；禁止墙钟当种子）。

| 标记 | 含义 |
|------|------|
| `0xFF` | 绝对鼠标：u64 ts + i16 x/y |
| marker=dt(≤250) | 相对鼠标：dt + i8 dx/dy |
| `0xFE` / `0xFD` | 鼠标按钮 / 滚轮 |
| `0xFC` / `0xFB` | 键按下 / 抬起（dt + i16 键码；ASCII 或 VK；修饰键 160–165、92；未知 1..255 透传；`Function`→999） |

相对链依赖前序；针在未缓存时刻须等黄条（不能中段无锚乱跳）。

### 4.4 ModuleEvent JSONL

信封：`{ v:1, module, ts, kind, payload }`；按模组、**本地日历日**滚动。

常见 kind：`module_hello`、`focus_change`、`display_setup`、`wallpaper`、`taskbar`、`win_*`、`settings_*`、`inventory_snapshot`、`device_change`、`link_change`、`hk_sample`、`sensor_unavailable`、`conn_*`、`compose_update`、`commit`。

`body`：明文 SSID/设备名；量化死区 + 60s 强制帧；>8MB 节流；网卡 In/OutOctets 差分；禁周期性 Scan/Inquiry/抓包。`eps.watts` 仅真实功率；GPU 进 `eps.gpu_w`。显示器几何归 win_map。

### 4.5 路径契约

`century = year/100 + 1` → `Century_{:08}`（本地日历）。

- 键鼠：`EventData/Century_…/Year_YYYY/Month_MM/trace_DD.bin`
- 模组：`ModuleData/<module>/Century_…/Year_YYYY/Month_MM/events_DD.jsonl`
- 控制：`OmniDatabase/control/`（pid、tombstone、`winrecorder_clock.json`、`data_root.txt`）
- 健康：`module_health.jsonl`（及 `.otih` 等）

### 4.6 健康与控制

- ~2s 心跳 → `control/module_health.jsonl`（`start`/`beat`/`tombstone`）+ `winrecorder_clock.json`。
- **运行时段重建**：只认 `start`、心跳缺口（>5s → **仅直播开口** stale）、`tombstone`；整文件扫 + mtime/长度缓存。
- 停录 / 点叉 / Ctrl+C / `--stop` 写 tombstone。关机：顶层隐藏窗在 `WM_QUERYENDSESSION` 写 `shutdown`/`logoff`。
- 下次启动：有 beat 无墓碑且墙钟超前 tick ≥60s（或 tick 回退）→ 补 `shutdown_inferred`；同开机 wall≈tick 崩溃 → `missing_tombstone`。5s 仅直播 stale。
- CLI：`--quiet` / `--stop` / `--status` / `--list` / `--enable`。

---

## 5. OmniPlayer 壳

### 5.1 页面边界

| 页 | 职责 |
|----|------|
| 设置 | **唯一** WinRecorder 开关 + 自启 + 数据存放位置 + 外观；**模型服务商在设置子页，Lobe 式左列表右详情**（不在笔记主界面并排）；**播放/时间轴滚动缩放在设置子页**（`localStorage omnitrace.playback.v1`）；**对话存档 AI 命名在设置首页**；默认落地页 |
| 播放器 | 直播/点播、舞台、底栏时间轴（点日段载入） |
| 仪表盘 | 运作轴 / 统计 / 动态 / 睡眠 / 运行状态；可 `seekPlayerToTs` |
| 笔记 | 流式笔记 / 线索板 / 时间轴；MCP 白名单非 coding agent。**细节** → [notes.md](notes.md) |

**壳应用栏（MVP）**：展开钮与横向标签同处应用列顶栏扁平标签条（底 1px 发丝线；`+` / 展开钮无描边框。收起时展开钮在 `#body` 右上，不挨窗控）；`+` 可加对话窗 / 线索板 / Canvas / Browser / Terminal / File。对话窗/线索板：`+` 悬停子菜单选档/选板，点选则在标签条打开该实例（已开则聚焦）；标签=已打开的混合种类窗口。同一 DOM 时切标签会 `switchBoard` / `applyWirePreset`。布局 `localStorage omnitrace.shell.apps.v1`。**细节** → [notes.md](notes.md)。

关于/反馈为模态框。**发布物与数据根分离**；增量只换程序。`main.ts` 只管壳（导航、设置、XOR 摘窗、dynamic import、seek 桥接、应用栏）。Tab：设置|播放器|仪表盘|笔记；仅舞台黑底。笔记浮层 `.omni-float`（细节见 notes）。

### 5.2 Tauri 命令（要点）

- 数据读写 / `advance_bin_decode`；录制 `recorder_*` / `autostart_set`。
- 仪表盘：`dashboard_health`（含 `quick`）、`dashboard_stats`、`dashboard_*` 系列、`recorder_run_spans`、`dashboard_sleep_guess`。
- 笔记：`llm_sidecar_*`、`notes_send_turn`、MCP/线索板相关；`clue_boards.json` 拒空覆盖、UI upsert、history 孤儿救回；版本史 `clue_history/<id>.jsonl`。费用显示货币见 [notes.md](notes.md)。
- 壳/摘窗：`shell_*`；事件 `notes-dock-changed` / `shell-second-instance`。
- 应用栏 MVP：`apps_run_shell`、`apps_list_dir`（见 notes §7）。

### 5.3 播放器不变量（`player.ts`）

- 冷启动可交互；bin 赶进度在 Rust（共享读；种子禁 `Date.now()`）。**黄条/可播 = 物理流解码区间**（非 jsonl endTime）。
- 离开播放器页 **不**清跨日内存缓存。时间轴：rAF 合并重画；**平移仅滚轮**（Alt/Ctrl 缩放 + 摩擦惯性）；针可 scrub；无舞台长按拖移。滚轮步进/缩放灵敏度由设置子页控制（`omnitrace.playback.v1`，默认比旧硬编码更小）。
- 时间显示 = 当日 00:00 起的日内钟。倍速 1…2048× / 自定义；**直播禁用倍速**。
- **直播** = 今日 path + offset **tail**；缺壁纸/display 时当日全文再向前最多 14 日粘性；`day_roll` 写新日文件。
- 无数据 / 追赶中 / 针在缓存外 → **纯黑屏**。

### 5.4 播放侧模组

`modules/`：`win_map` / `focus` / `ime` 完整；`input`/`browser`/`body` 桩（bin 在 `player.ts`）。顺序：win_map → focus → 光标 → ime。`body` 只落盘不画仪表。第三方「读可视化架构 + 舞台演绎」见 §7「以后」；此处不是热加载。

### 5.5 仪表盘（契约）

- 运作轴 / 统计 / 动态 / 睡眠 / 运行状态；口径入口 = 关于 `#about-caliber`。
- **不变量一句**：绿条三点重建；近景日瓦片折线 / 远景直方图；日历尺子；「仅有人操作」= 与有键鼠的 5 分钟格重叠。
- **细节** → [dashboard.md](dashboard.md)。
- **改口径须同步**：代码 + `#about-caliber` + 图上 hint/按钮 + **本段契约句**（常数写 dashboard.md）。禁止只改代码。

### 5.6 性能探针

自模拟 + 读日志；每次只跑专门模块。`npm run perf:scroll` → `omniplayer/perf-bench-last.json`；页内 `__omniPerfBench()` → `OmniDatabase/cache/perf_bench_last.json`。只观测、不改默认 LOD。自动跑键：`localStorage omnitrace.perfBench.v2.done`。

---

## 6. 文档放哪

| 文件 | 作用 |
|------|------|
| [README.md](../../README.md) / [README.en.md](../../README.en.md) | 入门 |
| [CHANGELOG.md](../../CHANGELOG.md) | 发版说明（Keep a Changelog） |
| 本文 + [notes](notes.md) / [dashboard](dashboard.md) / [android](android.md) | 当前系统形状 |
| [docs/adr](../adr/README.md) | 为什么这样（ADR） |
| [docs/releasing.md](../releasing.md) | 打 tag、挂 Release 附件 |

提示词原文、运行时库、API Key、录像不进 Git。

---

## 7. 明确非目标

- 动态壁纸像素级还原；Win11 任务栏 100% 枚举；Secure Desktop IME；抄小狼毫皮肤 / 把 weasel 拷进本 Git。
- 第二套 `omninotes`；双开同编；每模组一 exe；内核驱动进 OmniTrace。
- 完整 browser/body 播放器仪表；`OmniDatabase` / `target` / `node_modules` 进 versions；密钥进 Git。
- 抓包、周期 WiFi/蓝牙扫描、ETW、逐进程 CPU；机体探针塞进 `win_settings`。
- 无限 tool 轮 / 任意 shell；LiteLLM vendoring。
- **暂缓**：接地阅读器（Hermes）。
- 手机：不上架、不录 PCM/预览/截视频、不共用 `trace_DD.bin`、不改 Win `ModuleId`；OmniPlayer 暂不播手机源。

### 以后（尚未实现）

写在 README 路线图里，**不是**当前系统。个人录像默认只在本机磁盘；以后若有分享平台，分享的是模组 / 图表视图 / 皮肤 / 回放可视化，**默认不上传** `OmniDatabase` 轨迹。
- **账单**：电子钱包等账单文件批量导入，落本机，不上传。
- **模组插件接口**：WinRecorder 与 OmniPlayer 同一套（或成对的）插件 ABI——第三方模组能写记录侧数据，并能按约定的「可视化 / 窗体架构」在播放器里演绎（不只是 JSONL）。现在的进程内 `TraceModule` 与播放侧 `modules/` 是内置清单，不是创意工坊热加载。
- **仪表盘创意工坊**：统计图 / 仪表盘视图的分享与安装接口（模组、图表、布局），类似 Steam Workshop；默认不上传用户轨迹。不会把 OmniDatabase 默认同步到别人的服务器。
- **手机局域网联动**：Android 采集与 Windows 壳在本机局域网互通。当前 APK 几乎不可用。

---

## 8. 手机源（契约）

边载 APK；前台服务 + 同进程无障碍。PC 旁路根：`OmniDatabase/sources/<android_id>/`。信封同桌面（`module` 字符串）；高频 `imu_DD.bin`（`OTIM`），**禁** `trace_DD.bin`。健康三点同桌面。壳是 Android 自有 UI，非 OmniPlayer。

**现状**：几乎没法用，大量 bug。上面是目标形状，不是「已经能装来用」。局域网联动见 §7「以后」。

**细节** → [android.md](android.md)。

---

## 9. 从哪打开文件

1. 总览：**本文**；深读按需 [notes](notes.md) / [dashboard](dashboard.md) / [android](android.md)。
2. 宿主：`src/` → `bin_host` → `lifecycle` → `modules` → `paths` / `input_bin` / `health`。
3. 壳：`omniplayer/index.html` → `main` → `player` / `dashboard` / `notes*` → `src-tauri`。
4. 对照真实 `OmniDatabase`（本机，不进 git）。卡顿按 §5.6 跑实验。
5. 改架构：增量修补本文 + 对应专门文件；口径改动同步 §5.5 三处 + dashboard.md。
6. 手机：`omnitrace_android/`（§8 + android.md）。
