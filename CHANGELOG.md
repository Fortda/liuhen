# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号尽量按 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Changed

- 对外显示名改为 **留痕**（英文 Liuhen）。磁盘数据目录仍为 `%USERPROFILE%\OmniTrace\OmniDatabase`，程序目录仍为 `%LOCALAPPDATA%\OmniTrace`，采集 exe 仍为 `omnitrace_input.exe`（兼容旧路径与自动更新）。公开仓库迁至 <https://github.com/Fortda/liuhen>。新发版安装包文件名为 `Liuhen-*-windows-x64-setup.exe`；旧 Release 上的 `OmniTrace-*` 资源仍可用。

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

[Unreleased]: https://github.com/Fortda/liuhen/compare/v0.1.3...HEAD
[0.1.3]: https://github.com/Fortda/liuhen/releases/tag/v0.1.3
[0.1.2]: https://github.com/Fortda/liuhen/releases/tag/v0.1.2
