# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号尽量按 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- 架构「以后」意图（未实现）：账单批量导入、采集器/播放器成对插件 ABI、仪表盘创意工坊接口（见蓝图 §7）。
- 公开仓库文档：MIT、Keep a Changelog、关于页仓库链接、反馈跳转 GitHub Issue。
- 发版说明：`docs/releasing.md`（Windows zip 挂到 GitHub Release）。
- 双语 README（`README.md` / `README.en.md`）、公开架构 `docs/architecture/`、界面示意图 `docs/images/`。
- README 界面截图：设置、播放器、仪表盘四页、流式笔记 / 线索板 / 笔记时间轴。
- 给普通人的 Windows 安装：GitHub Release 下载 `OmniTrace-*-windows-x64.zip`，解压后「安装到本机.bat」。
- 打 `v*` tag 时 GitHub Actions 编该 zip 并挂到 Release 附件。

### Changed

- Git 提交改用 Conventional Commits。
- 关于页文案：情报和信息采集；现象世界模型运行日志。
- README：般若计划定位句、中英 README 徽章、各模块用途与键鼠日志警告。
- 公开文档改成给人看的说明（发版、ADR、架构），去掉对话记录体。
- 人读架构入口改为 `docs/architecture/OVERVIEW.md`（不再以 `.cursor` 作为对外第一链接）。
- README / 蓝图写明：Windows 壳仍在打磨；Android 当前几乎不可用；局域网联动是以后的事。
- 不再把仓库根两个本机双击启动脚本（`打开 OmniTrace.bat` / `打开 OmniTrace 笔记.bat`）放进 Git。

## [0.1.2] - 2026-09-13

公开初版所对应的应用能力快照（本机历史提交未原样上网）。

### Added

- Windows 采集宿主（WinRecorder）与 OmniPlayer 壳：设置、播放器、仪表盘、笔记。
- 流式笔记：MCP / 线索板持久历史、模型设置子页、应用栏分窗。
- 仪表盘运行状态机箱图（网络吞吐、内存、磁盘读写）。
- 契约蓝图拆分：`ARCHITECTURE_BLUEPRINT.md` + NOTES / DASHBOARD / ANDROID。

### Security

- 运行时库 `OmniDatabase/`、API Key、提示词原文不进 Git。

[Unreleased]: https://github.com/Fortda/omnitrace/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/Fortda/omnitrace/releases/tag/v0.1.2
