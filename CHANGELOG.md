# Changelog

本文件遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号尽量按 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- 架构「以后」意图（未实现）：账单批量导入、采集器/播放器成对插件 ABI、仪表盘创意工坊接口（见蓝图 §7）。
- 公开仓库文档：MIT、Keep a Changelog、关于页仓库链接、反馈跳转 GitHub Issue。
- 发版说明：`docs/releasing.md`（NSIS 安装包 + 便携 zip 挂到 Release Assets）。
- 双语 README（`README.md` / `README.en.md`）、公开架构 `docs/architecture/`、界面示意图 `docs/images/`。

### Changed

- Git 协议改为 Conventional Commits；不再把对话原文写入 commit message。
- 关于页文案：情报和信息采集；现象世界模型运行日志。
- 人读架构入口改为 `docs/architecture/OVERVIEW.md`（不再以 `.cursor` 作为对外第一链接）。

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
