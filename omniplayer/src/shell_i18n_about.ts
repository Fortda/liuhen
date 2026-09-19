/** 关于对话框与统计口径文案（中英 HTML 块）。 */

import type { StringTable } from "./shell_i18n_tables";

export const ABOUT_ZH: StringTable = {
  "dlg.about.intro":
    "OmniTrace 是辅助人尽可能记录和模拟世界的软件。它是<strong>般若计划</strong>下的一套<strong>情报和信息采集</strong>与<strong>现象世界模型运行日志</strong>维护、管理的终端；意在扩展感知在现象世界时空因果链网络上的深度与广度。",
  "dlg.about.bullet1":
    "<strong>采集</strong>：WinRecorder（<span class=\"dlg-meta\">omnitrace_input.exe</span>）在后台记录键鼠物理流与窗口环境，作为情报与信息、现象世界模型运行痕迹的一路输入。",
  "dlg.about.bullet2":
    "<strong>回放</strong>：OmniPlayer 播放器与仪表盘，用于回看、对照与从日志中提炼结构。",
  "dlg.about.bullet3":
    "<strong>数据</strong>：全部落在本机 <span class=\"dlg-meta\">OmniDatabase/</span>，不上传。",
  "dlg.about.projectLabel": "项目",
  "dlg.about.projectName": "般若计划",
  "dlg.about.repo": "GitHub 仓库",
  "dlg.about.repoTitle": "在浏览器中打开仓库",
  "dlg.about.versionLabel": "版本",
  "dlg.about.caliber.heading": "统计口径",
  "dlg.about.caliber.plainBtn": "人话",
  "dlg.about.caliber.plainBtnTitle": "切换为通俗说明",
  "dlg.about.caliber.plainBtnAria": "人话模式",
  "dlg.about.caliber.lead":
    "说明仪表盘数字与时间轴（绿条、键鼠折线/直方图、程序轴）如何从本机 <code>OmniDatabase/</code> 加工而来。读图前先读定义。不覆盖播放器舞台的像素还原。",
  "dlg.about.caliber.toc.scope": "覆盖",
  "dlg.about.caliber.toc.time": "时间与日历",
  "dlg.about.caliber.toc.timeline": "时间轴与键鼠",
  "dlg.about.caliber.toc.focus": "焦点与 AFK",
  "dlg.about.caliber.toc.volume": "数据量",
  "dlg.about.caliber.toc.modules": "模组事件与采集",
  "dlg.about.caliber.toc.sleep": "睡眠猜测",
  "dlg.about.caliber.toc.caveats": "局限",
  "dlg.about.caliber.toc.table": "对照表",
  "dlg.about.caliber.scope.title": "覆盖范围",
  "dlg.about.caliber.time.title": "时间与日历",
  "dlg.about.caliber.timeline.title": "时间轴与键鼠",
  "dlg.about.caliber.focus.title": "焦点与 AFK",
  "dlg.about.caliber.volume.title": "数据量",
  "dlg.about.caliber.modules.title": "模组事件与采集",
  "dlg.about.caliber.sleep.title": "睡眠猜测",
  "dlg.about.caliber.caveats.title": "已知局限",
  "dlg.about.caliber.table.title": "指标对照表",
  "dlg.about.caliber.scope.body":
    "<p>覆盖：运作时间轴上的采集绿条、键鼠活跃曲线、程序焦点轴；统计图表的焦点时长、键盘按键频率、今日事件量、总数据量；最新动态的尾部抽样。</p><p>不覆盖：播放器 canvas 上窗口/壁纸/光标/候选窗是否「像素级像当时」；未启用的 <code>browser</code> 桩模组；其它机器或其它目录里的库。</p><p>观察总体：本机当前这份 <code>OmniDatabase/</code>。统计命令按仓库根下的该目录扫盘。</p>",
  "dlg.about.caliber.time.body":
    "<ul><li><strong>日历日</strong>：采集滚动与统计切日均用本机本地时区（<code>chrono::Local</code> / <code>paths.rs</code>），不是 UTC 日。<code>trace_DD.bin</code> / <code>events_DD.jsonl</code> 的 DD 是本地日。</li><li><strong>路径</strong>：<code>Century_{年/100+1，八位}</code> / <code>Year_YYYY</code> / <code>Month_MM</code>。</li><li><strong>「今日」</strong>：本机日历日 00:00 起、次日 00:00 前。健康「今日」另要求信封 <code>ts</code> 落在该区间。</li><li><strong>近 7 日</strong>：含今日在内连续 7 个本地日历日。焦点日均 = 七日合计 / 7（无数据日仍进分母）。</li><li><strong>时间轴视窗</strong>：单次跨度最大约 20 年（<code>20 × 365.25</code> 日）。左右平移不按数据或「现在」封顶，只挡在 JavaScript Date 可表示范围。</li></ul>",
  "dlg.about.caliber.timeline.body":
    "<ul><li><strong>键鼠物理流</strong>：<code>compressed_bin_v3</code> 写入 <code>EventData/…/trace_DD.bin</code>；洗数缓存 <code>cache/input_hist/*.otih</code>（1s 柱）。鼠标柱只计位移（绝对 <code>0xFF</code> 与相对链）；点击 <code>0xFE</code>、滚轮 <code>0xFD</code> 不计。键盘柱为按下 <code>0xFC</code> 与抬起 <code>0xFB</code>。</li><li><strong>运行绿条</strong>：只认三点——<code>start</code>、心跳缺口 &gt;5s、<code>tombstone</code>（<code>control/module_health.jsonl</code> 整文件扫描）。关机推断墓碑算已停；长缺口不一律当干净停止。程序轴淡化段只铺在采集器在线区间。</li><li><strong>键鼠曲线</strong>：近景（视窗 ≤7 天）用日瓦片 1s 折线，每 CSS 列取区间 max，不画贝塞尔。远景（&gt;7 天）用直方图聚合；禁止为月/年视窗拉日瓦片。</li><li><strong>刻度</strong>：日历尺子（秒/分/时/日/月/年各自进位）；过密按字宽避让；日界只写日期。</li><li><strong>键盘按键频率</strong>（统计图）：近 7 日本地日 bin 中键盘<strong>按下</strong>（<code>0xFC</code>）按 Windows VK 聚合；抬起不计。排行截 Top 20；缓存 <code>cache/key_freq/*.otkf</code>，与 <code>.otih</code> 同次扫 bin 增量更新。不受「仅有人操作」开关影响。</li></ul>",
  "dlg.about.caliber.focus.body":
    "<ul><li><strong>焦点段</strong>：<code>focus_change</code> JSONL；无后续事件时单段最多 2 小时（<code>FOCUS_SEGMENT_CAP_MS</code>）。应用名去掉 <code>.exe</code>；标题含「桌面或失去焦点」记为「桌面 / 空闲」。占比图截前 20 个应用。</li><li><strong>有人操作 vs AFK</strong>：一日 288 个 5 分钟格（300s）。格内 <code>.otih</code> 任一 1s 柱 mouse 或 key ≥ 1 视为「有人操作」；否则该格上的焦点视为可能 AFK。仅点击或滚轮不能单独点亮有人操作格。</li><li><strong>「仅有人操作」开关</strong>：默认关 = 近 7 日焦点三张图用<strong>全部</strong> <code>focus_change</code> 段。打开后<strong>同一套三张图</strong>改用「焦点 ∩ 有键鼠的 5 分钟格」，不是另出三张卡。偏好 <code>localStorage omnitrace.dash.showActiveFocus</code>。</li></ul>",
  "dlg.about.caliber.volume.body":
    "<ul><li><strong>总数据量</strong>（<code>build_volume</code>）：<code>OmniDatabase/</code> 整树字节（含 EventData、ModuleData、control、cache、notes、ContextData 等）+ 模组 JSONL 总行 + 键鼠累计（自 2000-01-01 起有 bin 的日，<code>.otih</code> 1s 柱求和）+ 健康累计行。</li><li><strong>健康「今日」</strong>：信封 <code>ts</code> ∈ [当日 00:00, 次日 00:00)。禁止把累计 beat 当作今日。</li><li><strong>统计刷新</strong>：进程内约 12s 缓存；打开统计先画上次洗数快照，同时强制刷新。总数据量与落盘 JSONL 行数不受「仅有人操作」开关影响。</li><li><strong>最新动态</strong>：文件尾抽样（健康尾约 40 行 + focus / win_map / win_settings / body / ime 各尾约 30 行，合并截 60 条），不是全库普查。</li></ul>",
  "dlg.about.caliber.modules.body":
    "<p>默认启用：<code>input</code>、<code>focus</code>、<code>win_map</code>、<code>win_settings</code>、<code>body</code>、<code>ime</code>。<code>browser</code> 为桩，默认关闭。</p><ul><li><strong>今日模组事件量</strong>：当日各模组 <code>events_DD.jsonl</code> 非空且可解析为 JSON 的行，不按 <code>kind</code> 过滤（含 <code>body</code>、<code>ime</code>）。input 键鼠次数另计自 bin，不是 JSONL 行数。</li><li><strong>焦点 / win_map</strong>：共用 <code>win_state_hook</code>（前台事件，非 EnumWindows 轮询）。</li><li><strong>机体</strong>（<code>body</code>）：10s 采样；模拟量 <code>hk_sample</code> 量化死区，无变化最多 60s 一帧；当日 JSONL 超 8 MB 则 housekeeping 降为仅 60s 帧。网卡写 <code>telecom.adapters[]</code>（In/OutOctets 差分 B/s），非抓包。磁盘写 <code>cdh.disk_read_Bps</code>/<code>disk_write_Bps</code>（PDH PhysicalDisk _Total）。不周期性 WiFi 扫描/蓝牙 Inquiry。</li><li><strong>运行状态</strong>：机箱槽位；网络 MB/s↔Mbps；内存 GB；磁盘读/写吞吐双线；功率无源则藏。</li><li><strong>健康心跳</strong>：宿主约 2s 写 <code>beat</code> 到 <code>module_health.jsonl</code>。</li><li><strong>输入法</strong>（<code>ime</code>）：小狼毫侧路写当时可见页（组字串、候选、窗矩形）到 JSONL；锁屏 / UAC 安全桌面不采。</li></ul>",
  "dlg.about.caliber.sleep.body":
    "<ul><li><strong>粗起床</strong>：本地日 03:00–12:00 内最早键鼠活动，或若无则最早 <code>focus_change</code>。</li><li><strong>精起床</strong>：粗起床 ±30 分钟内，取「睡眠三联」最后连续段结束时刻。仅电脑：键鼠连续空闲 ≥10 分钟（<code>.otih</code> 代理熄屏）。有 <code>sources/android_*</code> 旁路时再加手机灭屏；PC 侧暂不解析手机 IMU。</li><li><strong>醒后列表</strong>：精起床起 30 分钟内 <code>focus_change</code> 应用顺序与时长。</li><li><strong>活跃条</strong>：5 分钟格；浅金黄＝旁路手机 GPS fix 或亮屏；浅天青＝本机键鼠；红竖线＝猜测起床。</li><li>手机 APK 可通过局域网从本机 OmniPlayer（默认端口 3180，可协商）拉取 <code>input_hist</code> 做合并判断。</li></ul>",
  "dlg.about.caliber.caveats.body":
    "<ul><li>2026-08 前键盘大量键码为 <code>999</code>，重洗缓存也不会改历史 bin 里的码值；展示侧对已有 VK 会尽量给可读名。Fn 组合、部分 OEM/驱动私有键、以及 rdev 标为 <code>Function</code> 或无效 <code>Unknown</code> 的键仍可能记为 <code>999</code> 或显示 <code>VKnnn</code>——并非只采常用键。</li><li>Windows 日常组字需小狼毫侧路补丁；播放器按结构重画，不是官方候选窗皮肤。</li><li><code>body</code> 不还原窗口画面；风扇转速等在未挂 LibreHardwareMonitor 时经常 <code>unavailable</code>。</li><li>关机或崩溃前，最后一段焦点可能被 2 小时封顶截断。</li><li>折线与直方图是 1s 或更粗聚合，不是逐事件审计。</li><li>盘上若仍有 <code>OmniDatabase/notes/*.json</code>，体积计入总数据量；多开录制会在设置开关处收敛到单实例。</li></ul>",
  "dlg.about.caliber.table.body":
    "<table class=\"caliber-table\"><thead><tr><th>指标</th><th>定义</th><th>数据源</th><th>不是什么</th></tr></thead><tbody><tr><td>今日模组事件量</td><td>当日 <code>events_DD.jsonl</code> 非空可解析行</td><td><code>ModuleData/&lt;mod&gt;/…</code>（含 <code>body</code>、<code>ime</code>）</td><td class=\"not\">不是键鼠次数；不按 kind 过滤</td></tr><tr><td>今日键鼠次数</td><td>当日 1s 柱 mouse / key 分别求和</td><td>bin → <code>.otih</code></td><td class=\"not\">鼠标≠点击数；键盘=按下+抬起</td></tr><tr><td>近 7 日焦点（默认）</td><td><code>focus_change</code> 段长，单段封顶 2h，近 7 日本地日</td><td>focus JSONL</td><td class=\"not\">含可能 AFK；不是注视时长</td></tr><tr><td>近 7 日焦点（仅有人操作）</td><td>同上，再与有键鼠的 5 分钟格求交</td><td>focus JSONL + <code>.otih</code></td><td class=\"not\">与默认不是同一数字；同一套图切换</td></tr><tr><td>键盘按键频率</td><td>近 7 日 bin 按下 <code>0xFC</code> 按 VK 聚合；Top 20</td><td>bin → <code>cache/key_freq/*.otkf</code></td><td class=\"not\">不是按下+抬起；不受 AFK 开关影响</td></tr><tr><td>健康今日</td><td>信封 <code>ts</code> 落在当日的健康行</td><td><code>module_health.jsonl</code></td><td class=\"not\">不是累计心跳</td></tr><tr><td>运行绿条</td><td><code>start</code> / 缺口&gt;5s / <code>tombstone</code> 三点重建</td><td>同上，整文件扫描</td><td class=\"not\">不是按键鼠字节量推断在线</td></tr><tr><td>总磁盘</td><td><code>OmniDatabase/</code> 子树字节和</td><td>目录递归</td><td class=\"not\">不是「有效事件」；含缓存与笔记</td></tr><tr><td>时间轴折线</td><td>近景每 CSS 列取 1s 柱区间 max</td><td>日瓦片 <code>.otih</code></td><td class=\"not\">不是逐事件；远景改直方图</td></tr></tbody></table>",
  "dlg.about.caliber.note":
    "口径随代码。改 <code>dashboard_stats</code> / 焦点清洗 / 开关语义时，必须同步改本节、仪表盘图上 hint、以及 <code>.cursor/ARCHITECTURE_BLUEPRINT.md</code> §5.5。常数：5 分钟格、5s 缺口、2h 封顶、约 2s 心跳、body 10s 采样 / 8 MB 日熔断。",
  "dlg.about.caliber.plain.lead":
    "用大白话说明：仪表盘上的数字、时间轴上的<strong>绿条</strong>（采集器有没有在跑）、<strong>键鼠曲线</strong>和<strong>程序轴</strong>（当时前台是哪个软件），都是从本机录下来的文件夹 <code>OmniDatabase/</code> 算出来的。建议先看懂定义再看图。播放器画面是不是和当时一模一样，不在这里讲。",
  "dlg.about.caliber.plain.toc.scope": "管什么",
  "dlg.about.caliber.plain.toc.time": "哪天算今天",
  "dlg.about.caliber.plain.toc.timeline": "时间轴怎么画",
  "dlg.about.caliber.plain.toc.focus": "前台与离开",
  "dlg.about.caliber.plain.toc.volume": "占多少空间",
  "dlg.about.caliber.plain.toc.modules": "后台记什么",
  "dlg.about.caliber.plain.toc.sleep": "猜起床",
  "dlg.about.caliber.plain.toc.caveats": "别误会",
  "dlg.about.caliber.plain.toc.table": "对照表",
  "dlg.about.caliber.plain.scope.title": "管什么、不管什么",
  "dlg.about.caliber.plain.time.title": "「今天」是哪天",
  "dlg.about.caliber.plain.timeline.title": "时间轴和键鼠",
  "dlg.about.caliber.plain.focus.title": "前台软件与「人不在」",
  "dlg.about.caliber.plain.volume.title": "数据有多少",
  "dlg.about.caliber.plain.modules.title": "后台在记什么",
  "dlg.about.caliber.plain.sleep.title": "猜你几点起床",
  "dlg.about.caliber.plain.caveats.title": "要注意的坑",
  "dlg.about.caliber.plain.table.title": "指标对照表（人话版）",
  "dlg.about.caliber.plain.scope.body":
    "<p><strong>会解释</strong>：运作时间轴上的采集绿条、键鼠活跃曲线、你在用哪个软件的条；统计页里的焦点时长、按键排行、今天记了多少条、硬盘占多大；「最新动态」里最近几条记录。</p><p><strong>不解释</strong>：播放器里窗口、壁纸、光标是不是和当时一模一样；没开用的浏览器采集；别的电脑或别的文件夹里的数据。</p><p>默认只看<strong>这台电脑、当前这份</strong> <code>OmniDatabase/</code>。</p>",
  "dlg.about.caliber.plain.time.body":
    "<ul><li><strong>按你电脑的日历</strong>：「今天」「昨天」都按 Windows 本地时区切日，不是世界协调时 UTC。文件名里的日期也是本地日。</li><li><strong>「今日」</strong>：从今天 0 点到明天 0 点。健康状态里的「今日」还要求那条记录的时间戳落在这个区间。</li><li><strong>「近 7 日」</strong>：含今天在内连续 7 个本地日。算日均时，没数据的日子也算进分母（所以日均可能偏低）。</li><li><strong>时间轴能拖多远</strong>：一次最多大约看 20 年；左右拖不受「有没有数据」限制，只受浏览器能表示的日期范围限制。</li></ul>",
  "dlg.about.caliber.plain.timeline.body":
    "<ul><li><strong>键鼠怎么记</strong>：后台把键鼠动作压成按秒统计的小柱子。鼠标柱子只数<strong>移动</strong>，不算单纯点击和滚轮。键盘柱子把「按下」和「抬起」各算一次。</li><li><strong>绿条</strong>：只根据采集器「启动」「心跳断了超过 5 秒」「正常退出」三种信号判断它在不在线；不是看键鼠多不多。程序轴的灰色段也只铺在采集器在线的时段。</li><li><strong>曲线 vs 直方图</strong>：放大到 7 天以内，用每秒的细折线；拉很远（超过 7 天）就改成粗一点的直方图，避免一次加载太多细节。</li><li><strong>按键频率图</strong>：近 7 天你<strong>按下</strong>了哪些键、各按了多少次，取前 20 名。只数按下，抬起不算。和「仅有人操作」开关无关。</li></ul>",
  "dlg.about.caliber.plain.focus.body":
    "<ul><li><strong>「焦点」是什么</strong>：你前台正在用哪个软件、窗口标题大概是什么。如果很久没换窗口，单段最长只算 2 小时，避免关机后一直挂着同一个软件名。</li><li><strong>AFK（人不在）</strong>：把一天切成 288 个<strong>5 分钟格</strong>。某一格里只要有过鼠标移动或按键，就算「有人在操作」；否则那一格里的前台时长可能是在发呆、看视频、开会没碰键鼠。光点鼠标、只滚轮，不算「有人在操作」。</li><li><strong>「仅有人操作」开关</strong>：默认关——近 7 日焦点三张图包含所有前台时段（含可能发呆的）。打开后<strong>还是这三张图</strong>，但只统计「有人在操作」那几格里的前台时长。偏好会记在浏览器 <code>localStorage</code> 里。</li></ul>",
  "dlg.about.caliber.plain.volume.body":
    "<ul><li><strong>总数据量</strong>：整个 <code>OmniDatabase/</code> 文件夹占硬盘多少字节，加上一些累计计数（模组日志行数、历史键鼠次数、健康记录行数等）。</li><li><strong>健康「今日」</strong>：只数时间戳落在今天的状态行，不把历史累计心跳当成今天。</li><li><strong>刷新</strong>：统计大约 12 秒缓存一次；打开统计页会先显示上次结果再后台刷新。总数据量和日志行数不受「仅有人操作」影响。</li><li><strong>最新动态</strong>：从各日志文件<strong>末尾抽一小段</strong>拼起来给你看，不是把整库扫一遍。</li></ul>",
  "dlg.about.caliber.plain.modules.body":
    "<p>默认会记：键鼠、前台窗口、窗口布局、系统设置、电脑传感器（体温/电量等）、输入法候选。浏览器采集默认关着。</p><ul><li><strong>今日模组事件量</strong>：今天各模块日志里有多少行有效 JSON，一行算一条；不是键鼠次数。</li><li><strong>机体传感器</strong>：大约每 10 秒采一次；没变化时最多 60 秒记一帧。网卡记整机吞吐（不是抓包）。磁盘记整机读/写速度。某天日志超过 8 MB 会降频。不扫 WiFi/蓝牙。</li><li><strong>运行状态</strong>：机箱槽位折线；网络可切 MB/s 与 Mbps；内存用 GB；磁盘是读写吞吐两条线；功率测不到就藏起来。</li><li><strong>健康心跳</strong>：采集器大约每 2 秒写一条「我还活着」。</li><li><strong>输入法</strong>：通过小狼毫侧路记当时候选窗长什么样；锁屏、UAC 弹窗时不记。</li></ul>",
  "dlg.about.caliber.plain.sleep.body":
    "<ul><li><strong>粗起床</strong>：当天上午 3 点到中午 12 点之间，你第一次碰键鼠或切窗口的时间。</li><li><strong>精起床</strong>：在粗起床前后 30 分钟里，找「睡三联」最后一段结束的时刻——电脑侧用「连续 10 分钟没碰键鼠」当熄屏代理；若接了手机旁路，还会看手机灭屏。</li><li><strong>醒后列表</strong>：精起床之后 30 分钟内你依次打开了哪些软件、各多久。</li><li><strong>活跃条</strong>：浅金黄＝手机 GPS/亮屏，浅天青＝电脑键鼠（按 5 分钟格）。</li><li>这不是医学睡眠监测，只是根据键鼠和窗口猜作息。</li></ul>",
  "dlg.about.caliber.plain.caveats.body":
    "<ul><li>较早版本的键盘记录里很多键显示成「未知键码」，历史数据洗不出来，只能尽量显示可读名字。</li><li>Fn 组合键、部分品牌专用键可能仍显示成编号。</li><li>Windows 中文输入要靠小狼毫补丁；播放器画的是结构，不是官方皮肤。</li><li>风扇转速等硬件信息没挂监控软件时经常是「不可用」。</li><li>关机或崩溃时，最后一段「你在用哪个软件」可能被 2 小时上限截断。</li><li>折线和直方图都是按秒或更粗粒度聚合的，不是每一次按键都画一个点。</li></ul>",
  "dlg.about.caliber.plain.table.body":
    "<table class=\"caliber-table\"><thead><tr><th>你看到什么</th><th>人话意思</th><th>从哪来</th><th>不是什么</th></tr></thead><tbody><tr><td>今日模组事件量</td><td>今天各模块日志里记了多少行</td><td>各模块按日分的日志文件</td><td class=\"not\">不是键鼠次数</td></tr><tr><td>今日键鼠次数</td><td>今天鼠标移动、键盘按下+抬起各多少次（按秒加总）</td><td>键鼠录制文件洗出来的缓存</td><td class=\"not\">鼠标≠点击次数</td></tr><tr><td>近 7 日焦点（默认）</td><td>近 7 天前台在各软件待了多久（含可能发呆）</td><td>窗口切换日志</td><td class=\"not\">不是「眼睛盯着屏幕」的时长</td></tr><tr><td>近 7 日焦点（仅有人操作）</td><td>同上，但只算 5 分钟里有碰键鼠的时段</td><td>窗口日志 + 键鼠缓存</td><td class=\"not\">和默认开关是两套数；图是同三张</td></tr><tr><td>键盘按键频率</td><td>近 7 天各键按下次数排行（前 20）</td><td>键鼠录制 + 按键统计缓存</td><td class=\"not\">只数按下；和 AFK 开关无关</td></tr><tr><td>健康今日</td><td>时间戳在今天的状态记录条数</td><td>健康日志</td><td class=\"not\">不是历史累计心跳</td></tr><tr><td>运行绿条</td><td>采集器什么时候在线</td><td>健康日志</td><td class=\"not\">不是按键鼠多少猜在线</td></tr><tr><td>总磁盘</td><td>整个数据库文件夹多大</td><td>扫目录</td><td class=\"not\">含缓存和笔记；不是「有效事件」净重</td></tr><tr><td>时间轴折线</td><td>放大时每秒键鼠强度的折线</td><td>按日洗好的秒级缓存</td><td class=\"not\">拉远会变成直方图</td></tr></tbody></table>",
  "dlg.about.caliber.plain.note":
    "上面是人话版；改统计算法时请同步更新技术版、本节人话版、仪表盘 hint 和架构蓝图。关键数字：5 分钟一格、心跳断 5 秒、焦点单段最长 2 小时、心跳约 2 秒一次。",
  "dlg.feedback.intro1":
    "可在 GitHub 开 Issue，或把下面写好的内容复制后自行发送。此处不会自动联网提交正文。",
  "dlg.feedback.intro2":
    "可写：时间轴、仪表盘、采集器上的异常、复现步骤、大概发生时间。复制内容仍只留在本机剪贴板。",
  "dlg.feedback.placeholder": "例如：仪表盘左右拖到某天后折线卡住……",
  "feedback.copyHeader": "OmniTrace 反馈",
  "feedback.copyVersionLabel": "版本",
};

export const ABOUT_EN: StringTable = {
  "dlg.about.intro":
    "OmniTrace is software that helps people record and simulate the world as fully as they can. It is the software of <strong>Prajna Plan</strong>: a terminal for <strong>intelligence and information capture</strong> and a <strong>phenomenal-world-model operation log</strong> — extending the depth and breadth of perception on the spatiotemporal causal-chain network of the phenomenal world.",
  "dlg.about.bullet1":
    "<strong>Capture</strong>: WinRecorder (<span class=\"dlg-meta\">omnitrace_input.exe</span>) records keyboard/mouse physical streams and window context in the background as one input channel for intelligence, information, and phenomenal-world-model traces.",
  "dlg.about.bullet2":
    "<strong>Replay</strong>: OmniPlayer and the dashboard for reviewing, cross-checking, and extracting structure from logs.",
  "dlg.about.bullet3":
    "<strong>Data</strong>: Everything stays on this machine in <span class=\"dlg-meta\">OmniDatabase/</span> — nothing is uploaded.",
  "dlg.about.projectLabel": "Project",
  "dlg.about.projectName": "Prajna Plan",
  "dlg.about.repo": "GitHub repository",
  "dlg.about.repoTitle": "Open the repository in a browser",
  "dlg.about.versionLabel": "Version",
  "dlg.about.caliber.heading": "Statistics caliber",
  "dlg.about.caliber.plainBtn": "Plain",
  "dlg.about.caliber.plainBtnTitle": "Switch to plain-language explanations",
  "dlg.about.caliber.plainBtnAria": "Plain language mode",
  "dlg.about.caliber.lead":
    "How dashboard numbers and the timeline (green bars, keyboard/mouse line/histogram, program axis) are derived from local <code>OmniDatabase/</code>. Read definitions before interpreting charts. Does not cover pixel-faithful restoration on the player stage.",
  "dlg.about.caliber.toc.scope": "Scope",
  "dlg.about.caliber.toc.time": "Time & calendar",
  "dlg.about.caliber.toc.timeline": "Timeline & input",
  "dlg.about.caliber.toc.focus": "Focus & AFK",
  "dlg.about.caliber.toc.volume": "Data volume",
  "dlg.about.caliber.toc.modules": "Module events",
  "dlg.about.caliber.toc.sleep": "Sleep inference",
  "dlg.about.caliber.toc.caveats": "Limitations",
  "dlg.about.caliber.toc.table": "Reference table",
  "dlg.about.caliber.scope.title": "Coverage",
  "dlg.about.caliber.time.title": "Time & calendar",
  "dlg.about.caliber.timeline.title": "Timeline & input",
  "dlg.about.caliber.focus.title": "Focus & AFK",
  "dlg.about.caliber.volume.title": "Data volume",
  "dlg.about.caliber.modules.title": "Module events & capture",
  "dlg.about.caliber.sleep.title": "Sleep inference",
  "dlg.about.caliber.caveats.title": "Known limitations",
  "dlg.about.caliber.table.title": "Metric reference table",
  "dlg.about.caliber.scope.body":
    "<p>Covers: capture green bars on the operation timeline, keyboard/mouse activity curves, program focus axis; dashboard charts for focus duration, keyboard key frequency, today's event count, total data volume; tail sampling in Latest activity.</p><p>Does not cover: whether windows/wallpaper/cursor/candidate UI on the player canvas look pixel-faithful; the disabled <code>browser</code> stub module; databases on other machines or paths.</p><p>Observation scope: this machine's current <code>OmniDatabase/</code>. Stats commands scan that directory under the repo root.</p>",
  "dlg.about.caliber.time.body":
    "<ul><li><strong>Calendar day</strong>: Capture rollover and stats bucketing use the local timezone (<code>chrono::Local</code> / <code>paths.rs</code>), not UTC day. DD in <code>trace_DD.bin</code> / <code>events_DD.jsonl</code> is the local day.</li><li><strong>Paths</strong>: <code>Century_{floor(year/100)+1, 8 digits}</code> / <code>Year_YYYY</code> / <code>Month_MM</code>.</li><li><strong>\"Today\"</strong>: From local midnight to next midnight. Health \"today\" also requires envelope <code>ts</code> in that interval.</li><li><strong>Last 7 days</strong>: Seven consecutive local calendar days including today. Focus daily average = seven-day total / 7 (days with no data still count in the denominator).</li><li><strong>Timeline window</strong>: Max span about 20 years (<code>20 × 365.25</code> days). Panning is not capped by data or \"now\" — only by JavaScript Date limits.</li></ul>",
  "dlg.about.caliber.timeline.body":
    "<ul><li><strong>Keyboard/mouse stream</strong>: <code>compressed_bin_v3</code> writes <code>EventData/…/trace_DD.bin</code>; wash cache <code>cache/input_hist/*.otih</code> (1s bars). Mouse bars count movement only (absolute <code>0xFF</code> and relative chains); clicks <code>0xFE</code> and wheel <code>0xFD</code> are excluded. Keyboard bars count press <code>0xFC</code> and release <code>0xFB</code>.</li><li><strong>Running green bar</strong>: Three signals only — <code>start</code>, heartbeat gap &gt;5s, <code>tombstone</code> (full scan of <code>control/module_health.jsonl</code>). Shutdown tombstones count as stopped; long gaps are not always treated as clean stops. Program-axis dim segments only span recorder-online intervals.</li><li><strong>Keyboard/mouse curves</strong>: Near view (window ≤7 days) uses daily 1s line tiles — each CSS column takes the interval max, no Bézier. Far view (&gt;7 days) uses histogram aggregation; daily tiles are not loaded for month/year windows.</li><li><strong>Scale</strong>: Calendar ruler (second/minute/hour/day/month/year carry); density-aware label spacing; day boundaries show date only.</li><li><strong>Keyboard key frequency</strong> (stats chart): Last 7 local days — keyboard <strong>press</strong> (<code>0xFC</code>) aggregated by Windows VK; releases excluded. Top 20; cache <code>cache/key_freq/*.otkf</code>, updated incrementally with <code>.otih</code> on the same bin scan. Not affected by the \"active input only\" toggle.</li></ul>",
  "dlg.about.caliber.focus.body":
    "<ul><li><strong>Focus segments</strong>: <code>focus_change</code> JSONL; capped at 2 hours per segment when no follow-up event (<code>FOCUS_SEGMENT_CAP_MS</code>). App names strip <code>.exe</code>; titles containing desktop/lost-focus map to \"Desktop / idle\". Share chart shows top 20 apps.</li><li><strong>Active input vs AFK</strong>: 288 five-minute cells per day (300s). A cell with any 1s bar in <code>.otih</code> where mouse or key ≥ 1 counts as \"active input\"; otherwise focus in that cell is possibly AFK. Clicks or wheel alone cannot light an active-input cell.</li><li><strong>\"Active input only\" toggle</strong>: Default off = last-7-day focus charts use <strong>all</strong> <code>focus_change</code> segments. When on, the <strong>same three charts</strong> use focus ∩ cells with keyboard/mouse activity — not a separate card set. Preference: <code>localStorage omnitrace.dash.showActiveFocus</code>.</li></ul>",
  "dlg.about.caliber.volume.body":
    "<ul><li><strong>Total data volume</strong> (<code>build_volume</code>): <code>OmniDatabase/</code> tree bytes (EventData, ModuleData, control, cache, notes, ContextData, etc.) + total module JSONL lines + cumulative keyboard/mouse (sum of 1s bars in <code>.otih</code> for days with bins since 2000-01-01) + cumulative health rows.</li><li><strong>Health \"today\"</strong>: Envelope <code>ts</code> ∈ [today 00:00, next day 00:00). Cumulative beats must not be counted as today.</li><li><strong>Stats refresh</strong>: ~12s in-process cache; opening stats paints the last wash snapshot first, then forces refresh. Total volume and on-disk JSONL line counts are not affected by the \"active input only\" toggle.</li><li><strong>Latest activity</strong>: Tail sampling (health tail ~40 lines + focus / win_map / win_settings / body / ime each ~30 lines, merged cap 60) — not a full-library scan.</li></ul>",
  "dlg.about.caliber.modules.body":
    "<p>Default enabled: <code>input</code>, <code>focus</code>, <code>win_map</code>, <code>win_settings</code>, <code>body</code>, <code>ime</code>. <code>browser</code> is a stub, off by default.</p><ul><li><strong>Today's module events</strong>: Non-empty, JSON-parseable lines in each module's <code>events_DD.jsonl</code> for the day — no <code>kind</code> filter (includes <code>body</code>, <code>ime</code>). Input keyboard/mouse counts come from bins, not JSONL line counts.</li><li><strong>Focus / win_map</strong>: Shared <code>win_state_hook</code> (foreground events, not EnumWindows polling).</li><li><strong>Body</strong> (<code>body</code>): 10s sampling; analog <code>hk_sample</code> with quantization dead zone — no change yields at most one frame per 60s; if daily JSONL exceeds 8 MB, housekeeping drops to 60s frames only. NIC writes <code>telecom.adapters[]</code> (In/OutOctets → B/s); disk writes <code>cdh.disk_read_Bps</code>/<code>disk_write_Bps</code> (PDH PhysicalDisk _Total); no packet capture; no periodic WiFi scan / Bluetooth inquiry.</li><li><strong>Status page</strong>: chassis slots; net MB/s↔Mbps; memory GB; disk read/write throughput dual lines; hide power if no source.</li><li><strong>Health heartbeat</strong>: Host writes <code>beat</code> to <code>module_health.jsonl</code> about every 2s.</li><li><strong>IME</strong> (<code>ime</code>): Rime side-channel writes visible page state (composition, candidates, window rect) to JSONL; lock screen / UAC secure desktop excluded.</li></ul>",
  "dlg.about.caliber.sleep.body":
    "<ul><li><strong>Coarse wake</strong>: Earliest keyboard/mouse activity between 03:00–12:00 local, or if none, earliest <code>focus_change</code>.</li><li><strong>Fine wake</strong>: Within ±30 minutes of coarse wake, end of the last continuous \"sleep triple\" segment. PC-only: keyboard/mouse idle ≥10 minutes (<code>.otih</code> as screen-off proxy). With <code>sources/android_*</code> side channel, phone screen-off is added; PC does not parse phone IMU yet.</li><li><strong>Post-wake list</strong>: App order and duration from <code>focus_change</code> for 30 minutes after fine wake.</li><li><strong>Activity strip</strong>: 5-minute bins; soft gold = phone GPS/screen-on side channel; soft sky = PC keyboard/mouse; red mark = guessed wake.</li><li>Phone APK can pull <code>input_hist</code> from local OmniPlayer (default port 3180, fallback 3181–3189) over LAN for merged inference.</li></ul>",
  "dlg.about.caliber.caveats.body":
    "<ul><li>Before 2026-08 many keyboard codes were <code>999</code>; re-washing cache does not rewrite historical bin codes — display names VKs when known. Fn combos, some OEM/vendor-private keys, and keys rdev marks <code>Function</code> or invalid <code>Unknown</code> may still be stored as <code>999</code> or shown as <code>VKnnn</code> — not limited to common keys.</li><li>Windows daily composition needs the Rime side-channel patch; the player redraws structure, not official candidate-window chrome.</li><li><code>body</code> does not restore window pixels; fan speed etc. often <code>unavailable</code> without LibreHardwareMonitor.</li><li>Before shutdown or crash, the last focus segment may be truncated by the 2-hour cap.</li><li>Lines and histograms are 1s or coarser aggregates — not per-event audit.</li><li>If <code>OmniDatabase/notes/*.json</code> remains on disk, volume counts toward total data; multiple recorder instances converge to one via the settings toggle.</li></ul>",
  "dlg.about.caliber.table.body":
    "<table class=\"caliber-table\"><thead><tr><th>Metric</th><th>Definition</th><th>Source</th><th>Not</th></tr></thead><tbody><tr><td>Today's module events</td><td>Non-empty parseable lines in <code>events_DD.jsonl</code> for the day</td><td><code>ModuleData/&lt;mod&gt;/…</code> (incl. <code>body</code>, <code>ime</code>)</td><td class=\"not\">Not keyboard/mouse counts; no kind filter</td></tr><tr><td>Today's keyboard/mouse counts</td><td>Sum of daily 1s bars for mouse / key separately</td><td>bin → <code>.otih</code></td><td class=\"not\">Mouse ≠ click count; keyboard = press + release</td></tr><tr><td>Last 7d focus (default)</td><td><code>focus_change</code> segment length, 2h cap, last 7 local days</td><td>focus JSONL</td><td class=\"not\">Includes possible AFK; not gaze duration</td></tr><tr><td>Last 7d focus (active input only)</td><td>Same, intersected with 5-minute cells with input</td><td>focus JSONL + <code>.otih</code></td><td class=\"not\">Different number from default; same chart set toggles</td></tr><tr><td>Keyboard key frequency</td><td>Last 7d bin press <code>0xFC</code> by VK; Top 20</td><td>bin → <code>cache/key_freq/*.otkf</code></td><td class=\"not\">Not press+release; AFK toggle independent</td></tr><tr><td>Health today</td><td>Health rows with envelope <code>ts</code> on today</td><td><code>module_health.jsonl</code></td><td class=\"not\">Not cumulative heartbeat</td></tr><tr><td>Running green bar</td><td>Rebuilt from <code>start</code> / gap&gt;5s / <code>tombstone</code></td><td>Same file, full scan</td><td class=\"not\">Not inferred from input byte volume</td></tr><tr><td>Total disk</td><td>Byte sum of <code>OmniDatabase/</code> subtree</td><td>Directory walk</td><td class=\"not\">Not \"valid events\"; includes cache & notes</td></tr><tr><td>Timeline line</td><td>Near view: per CSS column max over 1s bars</td><td>Daily tile <code>.otih</code></td><td class=\"not\">Not per-event; far view uses histogram</td></tr></tbody></table>",
  "dlg.about.caliber.note":
    "Caliber follows code. When changing <code>dashboard_stats</code>, focus cleaning, or toggle semantics, update this section, dashboard chart hints, and <code>.cursor/ARCHITECTURE_BLUEPRINT.md</code> §5.5 together. Constants: 5-minute cells, 5s gap, 2h cap, ~2s heartbeat, body 10s sample / 8 MB daily fuse.",
  "dlg.about.caliber.plain.lead":
    "In plain language: dashboard numbers and the timeline <strong>green bar</strong> (is the recorder running?), <strong>keyboard/mouse curves</strong>, and <strong>program axis</strong> (which app was in front) all come from the local <code>OmniDatabase/</code> folder. Read the definitions before interpreting charts. Pixel-faithful replay on the player stage is not covered here.",
  "dlg.about.caliber.plain.toc.scope": "What's included",
  "dlg.about.caliber.plain.toc.time": "What counts as today",
  "dlg.about.caliber.plain.toc.timeline": "How the timeline works",
  "dlg.about.caliber.plain.toc.focus": "Foreground & away",
  "dlg.about.caliber.plain.toc.volume": "How much data",
  "dlg.about.caliber.plain.toc.modules": "What's recorded",
  "dlg.about.caliber.plain.toc.sleep": "Wake-up guess",
  "dlg.about.caliber.plain.toc.caveats": "Don't misread",
  "dlg.about.caliber.plain.toc.table": "Quick table",
  "dlg.about.caliber.plain.scope.title": "What's in / out",
  "dlg.about.caliber.plain.time.title": "What \"today\" means",
  "dlg.about.caliber.plain.timeline.title": "Timeline & input",
  "dlg.about.caliber.plain.focus.title": "Foreground apps & AFK",
  "dlg.about.caliber.plain.volume.title": "How much data",
  "dlg.about.caliber.plain.modules.title": "What runs in the background",
  "dlg.about.caliber.plain.sleep.title": "Guessing wake-up time",
  "dlg.about.caliber.plain.caveats.title": "Caveats",
  "dlg.about.caliber.plain.table.title": "Metric table (plain)",
  "dlg.about.caliber.plain.scope.body":
    "<p><strong>Covers</strong>: capture green bars, keyboard/mouse activity curves, which-app-was-front axis; dashboard focus duration, key-frequency ranking, today's event count, total disk use; tail samples in Latest activity.</p><p><strong>Does not cover</strong>: whether the player canvas looks pixel-perfect; the disabled browser stub; data on other machines or paths.</p><p>Scope: <strong>this PC's current</strong> <code>OmniDatabase/</code>.</p>",
  "dlg.about.caliber.plain.time.body":
    "<ul><li><strong>Your local calendar</strong>: \"Today\" and \"yesterday\" use your Windows timezone, not UTC. File date suffixes are local days too.</li><li><strong>\"Today\"</strong>: From local midnight to next midnight. Health \"today\" also requires the record timestamp in that window.</li><li><strong>\"Last 7 days\"</strong>: Seven local calendar days including today. Daily averages divide by 7 even on days with no data.</li><li><strong>Timeline span</strong>: Up to ~20 years per view; panning is only limited by what JavaScript dates can represent.</li></ul>",
  "dlg.about.caliber.plain.timeline.body":
    "<ul><li><strong>Keyboard/mouse</strong>: Stored as per-second bars. Mouse bars count <strong>movement</strong> only — not clicks or wheel alone. Keyboard bars count both press and release.</li><li><strong>Green bar</strong>: Built from recorder start, heartbeat gap &gt;5s, and clean shutdown — not from how busy input is. Dim program-axis segments only span online intervals.</li><li><strong>Line vs histogram</strong>: Zoomed to ≤7 days → per-second line; farther out → coarser histogram.</li><li><strong>Key frequency chart</strong>: Top 20 keys by <strong>press</strong> count over the last 7 local days. Releases don't count. Independent of the \"active input only\" toggle.</li></ul>",
  "dlg.about.caliber.plain.focus.body":
    "<ul><li><strong>Focus</strong>: Which app was in front and roughly what the window title was. One segment caps at 2 hours if nothing changes — avoids hanging after shutdown.</li><li><strong>AFK (away)</strong>: Each day is split into 288 <strong>5-minute cells</strong>. A cell with any mouse move or key press counts as \"someone was using the PC\"; otherwise focus time there may be idle watching, meetings without typing, etc. Clicks or wheel alone don't count.</li><li><strong>\"Active input only\" toggle</strong>: Default off — last-7-day focus charts include all foreground time (possible idle). On — <strong>same three charts</strong>, but only cells where input happened. Saved in browser <code>localStorage</code>.</li></ul>",
  "dlg.about.caliber.plain.volume.body":
    "<ul><li><strong>Total data volume</strong>: Bytes under <code>OmniDatabase/</code> plus some rollups (JSONL line counts, lifetime input totals, health rows).</li><li><strong>Health \"today\"</strong>: Rows whose timestamp falls on today — not lifetime heartbeat count.</li><li><strong>Refresh</strong>: ~12s cache; opening stats shows the last snapshot then refreshes. Totals aren't affected by \"active input only\".</li><li><strong>Latest activity</strong>: A <strong>tail sample</strong> from log ends — not a full-library scan.</li></ul>",
  "dlg.about.caliber.plain.modules.body":
    "<p>By default: keyboard/mouse, foreground window, window layout, system settings, machine sensors (battery/temp, etc.), IME candidates. Browser capture is off.</p><ul><li><strong>Today's module events</strong>: Valid JSON lines in today's module logs — not keyboard/mouse counts.</li><li><strong>Body sensors</strong>: ~10s sampling; unchanged values at most one frame per 60s. NIC records whole-machine throughput (not packet capture). Disk records whole-machine read/write rates. Daily log &gt;8 MB throttles. No WiFi/Bluetooth scans.</li><li><strong>Status page</strong>: chassis slots; net MB/s↔Mbps; memory in GB; disk read/write dual lines; hide power if unavailable.</li><li><strong>Health heartbeat</strong>: ~every 2s the recorder writes \"still alive\".</li><li><strong>IME</strong>: Rime side-channel for candidate UI; lock screen / UAC excluded.</li></ul>",
  "dlg.about.caliber.plain.sleep.body":
    "<ul><li><strong>Coarse wake</strong>: First keyboard/mouse or window change between 03:00–12:00 local.</li><li><strong>Fine wake</strong>: Within ±30 min of coarse wake, end of the last \"sleep triple\" — PC uses 10+ minutes without input as screen-off proxy; optional phone screen-off if linked.</li><li><strong>Post-wake list</strong>: Apps and durations for 30 minutes after fine wake.</li><li>Not medical sleep tracking — just a guess from input and windows.</li></ul>",
  "dlg.about.caliber.plain.caveats.body":
    "<ul><li>Older keyboard logs may show \"unknown\" key codes; re-washing can't fix historical bins.</li><li>Fn combos and vendor-specific keys may still show as numbers.</li><li>Windows composition needs the Rime patch; the player redraws structure, not official chrome.</li><li>Fan speed etc. often \"unavailable\" without hardware monitor software.</li><li>Last focus segment before crash/shutdown may be cut at the 2-hour cap.</li><li>Lines and histograms are per-second or coarser — not every single event.</li></ul>",
  "dlg.about.caliber.plain.table.body":
    "<table class=\"caliber-table\"><thead><tr><th>What you see</th><th>Plain meaning</th><th>Source</th><th>Not</th></tr></thead><tbody><tr><td>Today's module events</td><td>How many log lines modules wrote today</td><td>Per-module daily JSONL</td><td class=\"not\">Not keyboard/mouse counts</td></tr><tr><td>Today's keyboard/mouse counts</td><td>Today's mouse moves and key press+release totals (1s bars summed)</td><td>Bin wash cache</td><td class=\"not\">Mouse ≠ click count</td></tr><tr><td>Last 7d focus (default)</td><td>Time in each app, last 7 days (may include idle)</td><td>Window-change log</td><td class=\"not\">Not eye-on-screen time</td></tr><tr><td>Last 7d focus (active only)</td><td>Same, but only 5-minute cells with input</td><td>Focus log + input cache</td><td class=\"not\">Different number; same three charts</td></tr><tr><td>Keyboard key frequency</td><td>Top 20 keys by press count, last 7 days</td><td>Bin + key-freq cache</td><td class=\"not\">Press only; AFK toggle independent</td></tr><tr><td>Health today</td><td>Status rows timestamped today</td><td>Health log</td><td class=\"not\">Not lifetime heartbeat</td></tr><tr><td>Running green bar</td><td>When the recorder was online</td><td>Health log</td><td class=\"not\">Not inferred from input volume</td></tr><tr><td>Total disk</td><td>Whole database folder size</td><td>Directory walk</td><td class=\"not\">Includes cache & notes</td></tr><tr><td>Timeline line</td><td>Per-second input intensity when zoomed in</td><td>Daily 1s cache</td><td class=\"not\">Histogram when zoomed out</td></tr></tbody></table>",
  "dlg.about.caliber.plain.note":
    "Plain-language view. When stats logic changes, update technical text, this plain view, dashboard hints, and the architecture blueprint. Key numbers: 5-minute cells, 5s heartbeat gap, 2h focus cap, ~2s heartbeat interval.",
  "dlg.feedback.intro1":
    "Open a GitHub Issue, or copy what you write below and send it yourself. This dialog does not submit the text automatically.",
  "dlg.feedback.intro2":
    "You can describe timeline, dashboard, or capture issues, repro steps, and approximate time. Copy stays on the local clipboard.",
  "dlg.feedback.placeholder":
    "e.g. Dashboard line chart freezes after panning to a certain day…",
  "feedback.copyHeader": "OmniTrace feedback",
  "feedback.copyVersionLabel": "Version",
};
