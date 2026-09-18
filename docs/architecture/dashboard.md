# OmniTrace 仪表盘蓝图（细节）

> **公开架构**。总览与契约见 [OVERVIEW.md](OVERVIEW.md) §5.5。  
> **口径同步**：改清洗 / AFK / 开关语义 / 格长等常数时，同一轮改代码 + `index.html` `#about-caliber` + 图上 hint/按钮 + OVERVIEW §5.5 契约句；细节常数以本文为准。  
> **以后（尚未实现）**：统计图 / 仪表盘视图的创意工坊式分享见 [OVERVIEW.md](OVERVIEW.md) §7。默认不上传用户轨迹。

---

## 1. 统计口径入口

- 标题栏「关于」对话框内 `#about-caliber` 分区（静态 HTML，可滚动）。读统计图、时间轴绿条与折线前应对照；图本身不自解释。
- 偏好：`localStorage omnitrace.dash.showActiveFocus`（「仅有人操作」开才算 `active_focus_usage`）。

---

## 2. 运作时间轴

- 键鼠近景：**日瓦片 1s 折线**（永久 `.otih` + `dashboard_input_day_series`，粘性纵轴；区间 max 用 mipmap；**只折线不贝塞尔**，每 CSS 列至多一个 max）。
- 远景（>7 天）仍直方图聚合，**禁止**为月/年视窗拉日瓦片。
- 健康绿条三点重建（见 [OVERVIEW.md](OVERVIEW.md) §4.6）；程序轴段索引缓存并按像素合并。画布只栅格化条带窗口。
- **时间轴刻度是日历尺子**（秒/分/时/日/月/年各自进位与像素门槛，大/中/小三档；月初与 15 号嵌在月界之间；禁止 30 天毫秒格）。
- **同缩放平移**：约 3.2× 宽、2.8× 高离屏条带 `drawImage`（靠近边缘即重烤，惯性平移也烤；缩放惯性仍先拉伸条带）。瓦片 atob+mips 在 Worker；平移中预取行进方向邻日。
- 指针：图区滚轮或**长按（≈100ms）后左右拖**平移；右侧名称列滚轮上下滚程序行；滚轮/惯性 **rAF 合并**。
- 单次视窗跨度最大约 20 年；**左右平移不按数据/现在封顶**（只挡在 JS Date 可表示范围）。
- **首帧**：先画 `OmniDatabase/cache/health_report_last.json`；健康段增量 `cache/health_span_state.json`；无缓存时 `dashboard_health({quick:true})` 只啃 `control/module_health.jsonl` 尾 2MB（不把尾扫写入全集缓存），完整扫在后台落盘。
- 采集器上线区间裁剪 app「假在线」。隐藏时间轴禁止按宽=0 重烤条带。

---

## 3. 统计图

- 近 7 日焦点默认 = 全部 `focus_change` 段（2h 封顶）。
- **「仅有人操作（去掉 AFK）」**：同一套三张图的口径开关（不是另出三卡）。打开后只计与「有键鼠的 5 分钟格」重叠的时长（格=300s，键鼠=当日 `.otih` 1s 柱 mouse+key，点击/滚轮不计鼠标柱）；无键鼠格视为可能 AFK 去掉。总数据量 / 落盘 JSONL 行不受此开关。`dashboard_stats` 缓存按该参数分 key。
- **键盘按键频率**（独立卡）：近 7 日本地日 `trace_DD.bin` 仅计按下 `0xFC` 按 VK 聚合 Top 20；缓存 `cache/key_freq/*.otkf`，与 `.otih` 同次扫 bin；不受 AFK 开关影响。
- 打开统计先画**上次洗数快照**，同时读条强制刷最新（`forceRefresh` 绕过 12s TTL）。切仪表盘子页不重打 IPC：已有 DOM 只显示；`dashboard_stats` 进程内约 12s TTL。
- **今日模组事件量** = 本地日历日 `events_DD.jsonl` 非空可解析行（不按 kind、不 tail；含 `ime`）；input 键鼠次数另计自 `trace_DD.bin`。健康心跳「今日」按信封 ts 落在当日，禁止把累计 beat 当作今日。
- **总数据量** = `OmniDatabase/` 各子树字节（盘上 `notes/*.json` 若还在则计入体积；OmniPlayer 不再编辑这些文件）+ 模组 JSONL 总行 + 键鼠累计 + 健康累计。
- 最新动态轮询（健康尾 + focus/win_map/win_settings/body/ime 各尾，截 60）。

---

## 4. 睡眠猜测

- Tab：近 14 日本地日；粗起床 03:00–12:00 键鼠或焦点；精起床 = 粗起床 ±30min 内睡眠三联（PC：键鼠连续空闲 ≥10min 代理熄屏；有 `sources/android_*` 再加手机灭屏，PC 不解析手机 IMU）结束时刻；醒后 30min 应用/focus 顺序。
- 页内 **活跃条**（5 分钟格，与 AFK 格同宽）：浅金黄＝手机 GPS/惯性（PC 旁路用 GPS/亮屏）；浅天青＝电脑键鼠；红竖线＝猜测起床。
- Android 可局域网从 OmniPlayer 拉 `input_hist` 到 `linked_pc/`（默认 `0.0.0.0:3180`，占用则 3181–3189；`control/omni_sync.json` + `omni_sync_status`；GET 缺 `.otih` 时现生）。
- IPC：`dashboard_sleep_guess`（含 `pc_active`/`phone_active`）。

---

## 5. 运行状态

- Tab：近 30min；**机箱槽位**折线 + 角落刻度/指针小仪表（装饰为主）。
- 网卡=body `hk_sample` 的 `telecom.adapters`（In/OutOctets 差分 B/s，UI 切 MB/s↔Mbps）；内存=已用/总量 GB；磁盘=整机读/写吞吐（PDH `PhysicalDisk(_Total)` Bytes/sec → UI MB/s 双线；非已用容量）；CPU/GPU %；功率无源则藏卡。
- 另含键鼠/焦点/IME 事件率、模组心跳。`dashboard_status_charts`；约 2s 轮询（只重读 JSONL 尾，不加速 body ~10s 采样）；指针可在采样间 lerp。
- **非**抓包、非逐进程字节流量。

---

## 6. 相关 IPC / 缓存路径

- `dashboard_health`（`quick` 可只出采集器轴）、`dashboard_health_snapshot`、`dashboard_stats`、`dashboard_live_feed`、`dashboard_status_charts`、`dashboard_input_histogram`、`dashboard_input_day_series`、`recorder_run_spans`、`dashboard_sleep_guess`、`perf_bench_write_report`。
- 缓存：`OmniDatabase/cache/health_report_last.json`、`health_span_state.json`、`.otih`、`key_freq/*.otkf`、`perf_bench_last.json` 等。
