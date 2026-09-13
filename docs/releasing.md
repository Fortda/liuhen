# 发版与公开推送

软件名 **OmniTrace**，项目名 **般若计划**。GitHub：<https://github.com/Fortda/omnitrace>（若登录名不是 `Fortda`，先改 [`omniplayer/src/shell_links.ts`](../omniplayer/src/shell_links.ts)）。

## GitHub Release 的 Assets

网页上 Release 里挂文件的那一块就叫 **Assets**。初版建议挂两个 Windows 文件：

1. **安装包（NSIS）**  
   `cd omniplayer && npm run tauri build`  
   产出大致在 `omniplayer/src-tauri/target/release/bundle/nsis/`，例如 `OmniTrace_0.1.2_x64-setup.exe`。

2. **便携 zip**  
   跑 [`omniplayer/package.ps1`](../omniplayer/package.ps1)（不要 `-Install` 也行），把 `dist/OmniPlayer/` 打成 `OmniTrace-0.1.2-windows-x64.zip`。  
   **不要**把 `OmniDatabase/` 打进 zip。

打 tag 后：GitHub → Releases → Draft a new release → 选 tag `v0.1.2` → 把上面两个文件拖进 Assets。同步改根目录 `CHANGELOG.md`。

## 第一次把代码推到公开 GitHub（orphan）

本地 `master` 的旧提交说明里有完整对话，**不要** `git push origin master` 把那本历史推上去。

在确认工作树已不含密钥、且 `versions/**/PROMPT.md` 已被 ignore 之后：

```text
# 1. 本机先备份当前分支（已有 master 即可）
# 2. 从当前树拉一条没有祖先的分支
git checkout --orphan public-v0
git add -A
git status   # 确认没有 OmniDatabase、providers.json、PROMPT.md
git commit -m "chore: initial public snapshot of OmniTrace 0.1.2"
# 3. 建好空仓库 Fortda/omnitrace 后
git remote add origin https://github.com/Fortda/omnitrace.git
git push -u origin public-v0:main
```

本机原来的 `master` 留着，不要删。之后日常开发可以在 `main`（公开）或继续用私有 `master`；不要把私有历史上的对话 commit cherry-pick 到公开 `main`。

用户没有说「推」之前，不要执行 `git push` / 不要创建 GitHub 仓库。
