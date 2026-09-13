# ADR-0003：公开初版（MIT、Keep a Changelog、不推对话历史）

- **日期**：2026-09-14
- **范围**：仓库许可、发版说明、Git 历史如何上网（不改采集数据格式）

## 1. 背景

本仓库长期用 commit message 分区粘贴完整对话，便于私有洗数据。要把 **般若计划 / OmniTrace** 以 MIT 开源时，那些 message 和 `versions/**/PROMPT.md` 含私人语料，不能原样 `push`。

## 2. 决策

### 决定做

1. 许可 **MIT**，版权人 Fortda。
2. 对外发版说明用根目录 **Keep a Changelog**（`CHANGELOG.md`）。
3. 日常提交用 **Conventional Commits**；禁止再往 commit 里贴对话全文。
4. `versions/**/PROMPT.md` **gitignore**，只留本机。
5. 公开 GitHub 仓库名 **omnitrace**；项目名「般若计划」，软件名 OmniTrace。
6. 第一次上网用 **orphan 初版提交**，不推含对话归档的旧 `master`。步骤见 [`docs/releasing.md`](../releasing.md)。

### 决定不做 / 延后

- 不改 crate / 包名 `omnitrace_input`。
- 不在本 ADR 执行 `git push`（须用户另说）。
- 不强制 GitHub Actions CI。

## 3. 后果

- 本机旧 `master` 仍可当私有考古库。
- 公开克隆者看不到历史对话；只看到初版树 + 此后的短提交。
