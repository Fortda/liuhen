# 发版

软件名 **留痕**（英文 Liuhen），计划名 **般若计划**。源码：<https://github.com/Fortda/liuhen>。

若 GitHub 登录名不是 `Fortda`，先改 [`omniplayer/src/shell_links.ts`](../omniplayer/src/shell_links.ts) 里的仓库地址。壳内链接默认打 `Fortda/liuhen`；仓库尚未 `gh repo rename` 时该地址会 404。

## 给下载安装的人

打开 [GitHub Releases](https://github.com/Fortda/liuhen/releases/latest)，下载 **`Liuhen-…-windows-x64-setup.exe`**。下一步、下一步即可。默认装到 `%LOCALAPPDATA%\OmniTrace`（当前用户，一般不用管理员；磁盘目录名未改，兼容旧版）。桌面和开始菜单会有「留痕」快捷方式。

数据在 `%USERPROFILE%\OmniTrace\OmniDatabase`，**不会**打进安装包。卸载（设置 → 应用 → 留痕）只删程序，不删库。

也可以下 **`Liuhen-…-windows-x64.zip`**：解压后双击 **安装到本机.bat**，效果相同。已用 setup.exe 装到本机的，留痕会在启动时检查更新，确认后下载**完整**安装包并安装（不改数据库）。便携 zip 不会在原地自动安装。旧 Release 上的 **`OmniTrace-*`** 安装包文件名仍指向同一类资源。

同一 Release 还可能挂 **`Liuhen-…-android.apk`**：用手机打开文件边载即可。**几乎没法用**，数据只留在手机，不会上传，包里也没有 `OmniDatabase`。局域网和电脑联动是以后的事。没有正式签名（调试证书），系统会提示未知来源。

Windows 可能提示「未知应用」：选 **更多信息 → 仍要运行**（目前没有代码签名）。

逐步说明在仓库根 [README.md](../README.md) 的「安装（Windows）」和「安装（Android）」两节。

若某个 Release 下面没有 setup.exe / zip / APK，说明那一版还没挂上对应安装包，等下一版或按 README 从源码安装。

朋友安装器必须带 `omnitrace_input.exe`。签名发版用的 Tauri NSIS 会把采集器打进安装包；没配签名密钥时退回 `package/omnitrace.nsi`，同样带采集器。不要发布只含播放器的安装包。

## 打一版（维护者）

1. 把根目录 [`CHANGELOG.md`](../CHANGELOG.md) 里 `[Unreleased]` 收成带日期的版本（Keep a Changelog）。
2. 核对 [`omniplayer/src-tauri/tauri.conf.json`](../omniplayer/src-tauri/tauri.conf.json) 的 `version` 与 changelog / tag 一致。
3. 在**公开**仓库的 `main` 上打 tag，例如 `v0.1.3`，并 `push` 该 tag。不要推本机旧 `master`。公开历史从 orphan 快照叠文件树，见下方「公开分支」。
4. **第一次**启用自动更新前，先按下面「更新签名密钥」生成密钥、把公钥写进配置、把私钥放进 GitHub Secrets。公钥和私钥必须是一对；换公钥之后，已经发出去的旧壳将无法校验新包。
5. GitHub Actions 工作流 [`release-windows`](../.github/workflows/release.yml) 会在 Windows 上执行 [`omniplayer/package.ps1`](../omniplayer/package.ps1)，把这些文件挂到该 tag 的 Release（网页上那一块叫 Assets）：
   - `Liuhen-<version>-windows-x64-setup.exe`（Tauri NSIS，播放器 + 采集器；updater 安装的就是它）
   - 同名 `.sig`
   - `latest.json`（静态更新清单，地址固定为 `…/releases/latest/download/latest.json`）
   - `Liuhen-<version>-windows-x64.zip`（便携包，仍发布）
   日常 PR 和推送到 `main` 只跑 [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)（OmniPlayer 前端构建、Windows 采集器测试、MCP 构建/smoke、workflow 语法），不在每次 PR 上打这些安装包。只想编安装包、不挂到 Release：在 Actions 里手动跑 `release-windows`，勾选 **dry_run**。
6. 本机也可先设好下面两个环境变量再跑 `omniplayer/package.ps1`（不必加 `-Install`），得到同样的 setup.exe、`.sig`、`latest.json` 和 zip。没设私钥时脚本仍打 zip，并退回旧的 `omnitrace.nsi` setup.exe——**那一份没有签名，不能当 updater 载荷**。产物都 **不得**含 `OmniDatabase/`，也 **不得**含打包机上的 `data_root.json`。setup.exe 安装时才在目标机写指针（已有指针不会被覆盖）。
7. Android APK：本机跑 [`omnitrace_android/package.ps1`](../omnitrace_android/package.ps1)，得到 `dist/Liuhen-<version>-android.apk`，再拖进同一 Release。包内不得有 `OmniDatabase`。没有上架密钥时用本机 **debug 证书**边载（脚本会写明）。工作流里另有一个 **可选** 的 `android-apk` job（`continue-on-error`）：编成功才挂 APK，失败或没产物 **不挡** Windows 包，也不假装一定有 APK。优先认本机真实 APK。

## 更新签名密钥

自动更新用 Tauri 官方 updater。它校验的是 **minisign** 签名，不是 Windows 的代码签名（SmartScreen 仍会提示未知应用）。官方 updater **不提供**可依赖的二进制差分：Windows 载荷就是完整的 NSIS `setup.exe`。第三方差分插件没有进官方插件，版本也对不齐，所以这里发完整包。

在 `omniplayer/` 下生成一对密钥（私钥不要进 Git，也不要贴进 Issue）：

```powershell
cd omniplayer
npm run tauri signer generate -- -w $env:USERPROFILE\.tauri\liuhen.key
```

命令会写出私钥文件，并在终端打印一行公钥（一长串以 `dW50cnVzdGVk` 开头的文本）。然后：

| 放哪 | 内容 |
|---|---|
| GitHub 仓库 **Settings → Secrets and variables → Actions**，名字 **`TAURI_SIGNING_PRIVATE_KEY`** | 私钥文件的**全部**文本（含注释行）。不是文件路径。 |
| 同一个地方，名字 **`TAURI_SIGNING_PRIVATE_KEY_PASSWORD`** | 生成时设过密码就填密码；没设密码就留空、不必建这个 secret。 |
| [`omniplayer/src-tauri/tauri.conf.json`](../omniplayer/src-tauri/tauri.conf.json) 的 `plugins.updater.pubkey` | 用终端打印的那一行公钥**替换** `REPLACE_WITH_OUTPUT_OF_tauri_signer_generate`。这是公钥，可以进 Git。 |

`plugins.updater.endpoints` 已指向 `https://github.com/Fortda/liuhen/releases/latest/download/latest.json`。不要改成自己的下载服务器。

打 tag 的格式是 **`v` + `tauri.conf.json` 里的 `version`**，例如 version 为 `0.1.6` 时 tag 为 `v0.1.6`。`latest.json` 里的下载地址按这个 tag 写。tag 推上去之后，等 `release-windows` 成功，Release 附件里应能看到 `latest.json`。还没有这个文件时，已安装的壳检查更新会失败并继续启动，不会卡住。

便携 zip 里的 `OmniPlayer.exe` 和安装版是同一个程序。不在 `%LOCALAPPDATA%\OmniTrace`、旁边也没有 `uninstall.exe` 时，壳只提示去发布页下载，不会把 NSIS 装到另一个目录。

提交说明用 [Conventional Commits](https://www.conventionalcommits.org/)，短标题即可。

## 不要进 Git、也不要进安装包

- `OmniDatabase/`、录像、Cookie、API Key、`.env`、更新器私钥（`TAURI_SIGNING_PRIVATE_KEY` 只放 GitHub Secrets 或本机 `~/.tauri/`）
- `versions/**/PROMPT.md`（本机提示词，已 gitignore）
- `target/`、`node_modules/`、`dist/`、`readme图片/`（高清源；README 用 `docs/images/`）
- 任何打包机上的 `data_root.json`（里面是本机绝对路径）

## 公开分支

GitHub 默认分支是 `main`。它和本机旧的 `master` **不是同一条历史**：`main` 从一份公开快照（`public-v0`）起算。日常开发在本机 `master`（或功能分支）上提交；发布时把**文件树**叠到 `public-v0`，再 `git push origin public-v0:main`。不要把本机 `master` 整支 `push` 到 `origin`。
