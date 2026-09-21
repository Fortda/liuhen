# ADR-0003：公开初版（MIT、Keep a Changelog、公开 `main`）

- **日期**：2026-09-14
- **范围**：仓库许可、发版说明、公开 git 历史（不改采集数据格式）

## 1. 要解决什么

把 **般若计划 / OmniTrace** 以 MIT 开源。本机旧提交说明和部分本机文件含不宜公开的材料，不能把旧 `master` 原样推到 GitHub。

## 2. 决策

### 决定做

1. 许可 **MIT**，版权人 Fortda。
2. 对外发版说明用根目录 **Keep a Changelog**（`CHANGELOG.md`）。
3. 日常提交用 **Conventional Commits**，说明保持简短。
4. `versions/**/PROMPT.md` **gitignore**，只留本机。
5. 公开 GitHub 仓库名 **omnitrace**；项目名「般若计划」，软件名 OmniTrace。
6. 公开默认分支 `main` 从一份无旧祖先的快照起算，不推送本机旧 `master`。发版步骤见 [`docs/releasing.md`](../releasing.md)。
7. 打 `v*` tag 时用 GitHub Actions 编 Windows **setup.exe + zip**，挂到该 Release 的 Assets。日常 PR 不强跑这套构建。
8. 给外行朋友的安装物是 **`OmniTrace-*-windows-x64-setup.exe`**：每用户向导（默认 `%LOCALAPPDATA%\OmniTrace`，尽量不抬 UAC）、含播放器 **和** 采集器、HKCU 卸载项、桌面/开始菜单快捷方式、exe 旁 `data_root.json` 指向 `%USERPROFILE%\OmniTrace\OmniDatabase`。包内仍无库；卸载不删库。zip 仍提供。

### 决定不做 / 延后

- 不改 crate / 包名 `omnitrace_input`。
- 不为每次提交跑完整 Windows 打包 CI。
- 不把 **Tauri 自带**、只打播放器的 NSIS 当推荐下载。朋友安装器用 `omniplayer/package/omnitrace.nsi` 打 Dist 全量（`package.ps1`）。

## 3. 后果

- 本机旧 `master` 仍可留作私有考古。
- 公开克隆者只看到初版树和此后的短提交。
- 普通人下载走 GitHub Release 的 **setup.exe**（或 zip），不需要装 Rust / Node。
- 后来对外显示名改为 **留痕**（Liuhen），公开仓库 `Fortda/liuhen`；磁盘目录与 exe 文件名仍按本 ADR 兼容旧路径。本文件保留公开初版当时的决定。
