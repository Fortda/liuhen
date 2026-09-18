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
7. 打 `v*` tag 时用 GitHub Actions 编 Windows 便携 zip，挂到该 Release 的 Assets。日常 PR 不强跑这套构建。

### 决定不做 / 延后

- 不改 crate / 包名 `omnitrace_input`。
- 不为每次提交跑完整 Windows 打包 CI。
- Tauri NSIS `setup.exe` 暂不作为推荐下载（常缺采集器）。

## 3. 后果

- 本机旧 `master` 仍可留作私有考古。
- 公开克隆者只看到初版树和此后的短提交。
- 普通人下载走 GitHub Release 的 zip，不需要装 Rust / Node。
