# 发版

软件名 **留痕**（英文 Liuhen），计划名 **般若计划**。源码：<https://github.com/Fortda/liuhen>。

若 GitHub 登录名不是 `Fortda`，先改 [`omniplayer/src/shell_links.ts`](../omniplayer/src/shell_links.ts) 里的仓库地址。壳内链接默认打 `Fortda/liuhen`；仓库尚未 `gh repo rename` 时该地址会 404。

## 给下载安装的人

打开 [GitHub Releases](https://github.com/Fortda/liuhen/releases/latest)，下载 **`Liuhen-…-windows-x64-setup.exe`**。下一步、下一步即可。默认装到 `%LOCALAPPDATA%\OmniTrace`（当前用户，一般不用管理员；磁盘目录名未改，兼容旧版）。桌面和开始菜单会有「留痕」快捷方式。

数据在 `%USERPROFILE%\OmniTrace\OmniDatabase`，**不会**打进安装包。卸载（设置 → 应用 → 留痕）只删程序，不删库。

也可以下 **`Liuhen-…-windows-x64.zip`**：解压后双击 **安装到本机.bat**，效果相同。旧 Release 上的 **`OmniTrace-*`** 安装包文件名仍指向同一类资源。

Windows 可能提示「未知应用」：选 **更多信息 → 仍要运行**（目前没有代码签名）。

逐步说明在仓库根 [README.md](../README.md) 的「安装」一节。

若某个 Release 下面没有 setup.exe / zip，说明那一版还没挂上安装包，等下一版或按 README 从源码安装。

不要用 Tauri 自己打出来、只含播放器的 `setup.exe`。朋友安装器必须带 `omnitrace_input.exe`。

## 打一版（维护者）

1. 把根目录 [`CHANGELOG.md`](../CHANGELOG.md) 里 `[Unreleased]` 收成带日期的版本（Keep a Changelog）。
2. 核对 [`omniplayer/src-tauri/tauri.conf.json`](../omniplayer/src-tauri/tauri.conf.json) 的 `version` 与 changelog / tag 一致。
3. 在**公开**仓库的 `main` 上打 tag，例如 `v0.1.3`，并 `push` 该 tag。不要推本机旧 `master`。公开历史从 orphan 快照叠文件树，见下方「公开分支」。
4. GitHub Actions 工作流 [`release-windows`](../.github/workflows/release.yml) 会在 Windows 上执行 [`omniplayer/package.ps1`](../omniplayer/package.ps1)，把 `dist/Liuhen-<version>-windows-x64-setup.exe` 和 `.zip` 挂到该 tag 的 Release（网页上那一块叫 Assets）。
5. 本机也可先跑 `omniplayer/package.ps1`（不必加 `-Install`），再把 **setup.exe + zip** 拖进 Release 附件。二者都 **不得**含 `OmniDatabase/`，也 **不得**含打包机上的 `data_root.json`。setup.exe 安装时才在目标机写指针。

提交说明用 [Conventional Commits](https://www.conventionalcommits.org/)，短标题即可。

## 不要进 Git、也不要进安装包

- `OmniDatabase/`、录像、Cookie、API Key、`.env`
- `versions/**/PROMPT.md`（本机提示词，已 gitignore）
- `target/`、`node_modules/`、`dist/`、`readme图片/`（高清源；README 用 `docs/images/`）
- 任何打包机上的 `data_root.json`（里面是本机绝对路径）

## 公开分支

GitHub 默认分支是 `main`。它和本机旧的 `master` **不是同一条历史**：`main` 从一份公开快照（`public-v0`）起算。日常开发在本机 `master`（或功能分支）上提交；发布时把**文件树**叠到 `public-v0`，再 `git push origin public-v0:main`。不要把本机 `master` 整支 `push` 到 `origin`。
