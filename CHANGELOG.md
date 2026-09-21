# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号尽量按 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.5] - 2026-09-22

### Added

- 线索板：**图片便签**（工具栏 / 右键 / 拖入 / 剪贴板贴图）；字节落在 `notes/config/clue_images/`，节点只存相对引用。
- 线索板：便签 **复制 / 粘贴**（右键与 Ctrl/Cmd+C/V；文本框内有选中文字时 Ctrl+C 仍复制文字）。
- 线索板：拖便签时 **右键平移视口**（与空白处左键平移相同手感；多选拖动时相机移动、便签相对位置不变；用于平移的右键不弹菜单）。
- 笔记 MCP 活动面板：思考 / 读取 / 编辑 / 命令行可见标签，以及 **轮次渐进折叠**（当前轮最细，更早轮收起）。
- 线索板标题栏紧凑 **+** 新建板；MCP / 类型支持 `image`、`parentId` / `collapsed` / `kind`。

### Changed

- 设置 → **检查更新**：发现新版本后直接确认即可 **应用内下载** 增量 `*-windows-x64-update.zip`（或完整 zip）并替换重启，不必打开浏览器下 setup.exe。首次安装或完整向导重装仍用 `Liuhen-*-windows-x64-setup.exe`。
- 检查更新文案写明：优先增量包、不改 `OmniDatabase`；启动时检查只提示，下载安装仍走设置里的「检查更新」。

### Fixed

- 拖便签期间在 textarea / 图片上按右键也能平移画布（window capture 监听，避免被子元素吃掉事件）。

## [0.1.4] - 2026-09-21

### Changed

- 对外显示名改为 **留痕**（英文 Liuhen）。磁盘数据目录仍为 `%USERPROFILE%\OmniTrace\OmniDatabase`，程序目录仍为 `%LOCALAPPDATA%\OmniTrace`，采集 exe 仍为 `omnitrace_input.exe`（兼容旧路径与自动更新）。公开仓库迁至 <https://github.com/Fortda/liuhen>。新发版安装包文件名为 `Liuhen-*-windows-x64-setup.exe`；旧 Release 上的 `OmniTrace-*` 资源仍可用。

### Added

- 设置 → **检查更新**：向 `Fortda/liuhen` 的 GitHub Release 拉取增量包 `Liuhen-*-windows-x64-update.zip`（两 exe + 图标），只换程序文件，不改 `OmniDatabase`。可开「启动时检查更新」。首次安装仍用 setup.exe。
- GitHub Release 可另挂边载 **`Liuhen-*-android.apk`**（与 Windows setup.exe / zip 并列）。几乎没法用；数据只留在手机；包内无 `OmniDatabase`。维护者本机 `omnitrace_android/package.ps1`；Actions 里的 Android 任务是可选的，失败不挡 Windows 包。
- 线索板 MCP：新建板、便签的父子 / 折叠 / 种类，以及操作历史与回退。

## [0.1.3] - 2026-09-19

### Added

- 给朋友的 Windows **setup.exe**（`OmniTrace-*-windows-x64-setup.exe`）：每用户向导、可选目录（默认 `%LOCALAPPDATA%\OmniTrace`）、桌面/开始菜单快捷方式、HKCU 卸载项；含播放器 **和** 采集器；安装时写 `data_root.json` 指向 `%USERPROFILE%\OmniTrace\OmniDatabase`。包内无库。卸载不删库。zip 仍提供。
- 设置 → **滚动与缩放**：播放器 / 时间轴滚轮步进与缩放灵敏度，以及「重置为默认」。
- 设置首页：**对话存档是否由当时对话的 AI 写名称和备注**。
- 设置页可改 **数据存放位置**（写 exe 旁指针，不搬已有库；采集运行中拒绝）。
- 流式笔记「色温」：按击键间隔给用户打的字上色（快暖红 / 慢冷蓝），字形随卡片落盘。
- GitHub Issue 模板（Bug / 想法）；壳内「反馈」可打开 New Issue。

### Changed

- README 安装改为推荐 setup.exe（中英分写）；zip 仍可用。
- README 截图换成高清 PNG（设置 / 播放器 / 仪表盘各页 / 笔记工具与参数）。
- 连线存档绿线按成员集合重排为相邻路径（A—C 再接入 B → A—B—C），不留跨弦。
- 连线存档列表：轮数、相对时间、悬停备注；右键详情/删除。
- 发版脚本与 Actions 同时产出 setup.exe 与 zip。
- ADR-0003：朋友安装器改为含采集器的 NSIS，不再推荐 Tauri 自带的播放器-only setup。

## [0.1.2] - 2026-09-13

公开初版所对应的应用能力快照（本机历史提交未原样上网）。

### Added

- Windows 采集宿主（WinRecorder）与 OmniPlayer 壳：设置、播放器、仪表盘、笔记。
- 流式笔记：MCP / 线索板持久历史、模型设置子页、应用栏分窗。
- 仪表盘运行状态机箱图（网络吞吐、内存、磁盘读写）。
- 契约蓝图拆分：`ARCHITECTURE_BLUEPRINT.md` + NOTES / DASHBOARD / ANDROID。
- 公开仓库文档：MIT、Keep a Changelog、双语 README、`docs/architecture/`。
- Windows 便携 zip +「安装到本机.bat」。

### Security

- 运行时库 `OmniDatabase/`、API Key、提示词原文不进 Git。

[Unreleased]: https://github.com/Fortda/liuhen/compare/v0.1.5...HEAD
[0.1.5]: https://github.com/Fortda/liuhen/releases/tag/v0.1.5
[0.1.4]: https://github.com/Fortda/liuhen/releases/tag/v0.1.4
[0.1.3]: https://github.com/Fortda/liuhen/releases/tag/v0.1.3
[0.1.2]: https://github.com/Fortda/liuhen/releases/tag/v0.1.2
