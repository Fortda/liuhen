# 草稿：GitHub 个人主页 README（贴到 Fortda/Fortda，不是本软件仓库）

> **这份文件不属于 OmniTrace 产品文档。**  
> 根目录 `README.md` / `README.en.md` 继续给人介绍软件。  
> 本文只是个人品牌主页的**可粘贴草稿**，等你在 GitHub 上新建公开仓库 **[Fortda/Fortda](https://github.com/Fortda/Fortda)** 之后，把下面「可粘贴正文」整段复制成该仓库根目录的 `README.md`。  
> 目前 `https://github.com/Fortda/Fortda` 还不存在（404），这是预期状态。

不要 `git commit` / `git push` 本文当正式发版。公开 OmniTrace 时仍走 orphan 初版，见 [releasing.md](releasing.md)。

---

## 0. 「俩名字」其实是三层，不是账号裂开了

GitHub 允许、也鼓励同一人同时有多套名字。它们职责不同，互不替代。

| 层 | Nagi 那边 | 你这边 | 改哪里 | 出现在哪 |
|---|---|---|---|---|
| **登录名 / username** | `Nagi-ovo`（URL 里的那个） | `Fortda` | 账号设置；改了所有 URL 都会变 | `github.com/Fortda` |
| **显示名 / Name** | `Jesse Zhang`（头像旁大字） | 现在是空的，GitHub 只显示 Fortda | Profile → **Name**，随时改，**不必改登录名** | 个人页标题、贡献列表 |
| **仓库名** | `voyager` | 计划：`omnitrace` | 建库时的 repo name | `github.com/Fortda/omnitrace` |
| **产品名** | Voyager | **OmniTrace** | 代码、关于页、README 标题 | 软件窗口、安装目录 |
| **项目 / 计划名** | （个人站 nagi.fun） | **般若计划**（Prajna Plan） | 文案层；不是 GitHub 字段 | README 副标题、关于页 |

所以：

1. **Nagi-ovo vs Jesse Zhang**：登录马甲 vs 对外真名。你可以继续只用 Fortda，也可以在 Name 里填真名或笔名，**账号不用拆成两个**。
2. **Fortda vs omnitrace**：人 vs 仓库。人是 Fortda，软件仓库叫 omnitrace，很正常。`com.fortd.omnitrace` 也是「作者域名 + 产品」而不是两个身份。
3. **般若计划 vs OmniTrace**：计划伞 vs 当前这款软件。公开仓库叫 omnitrace，介绍里写「般若计划下的 OmniTrace」即可。

GitHub 主页上你还会看到两个容易混的词：

- **Profile README**：特殊仓库 `Fortda/Fortda` 根目录的 `README.md`，渲染在 `https://github.com/Fortda` 头顶。
- **Release Assets**：某个软件仓库发版时挂的安装包（本仓库的 [releasing.md](releasing.md) 说的就是这个）。**不是**主页图片目录。

主页说的 **assets**，是 profile 仓库里的 `assets/` 文件夹（Nagi 把 GIF、产品 logo、简历 PDF 放在 `Nagi-ovo/Nagi-ovo/assets/`）。和 OmniTrace 的 `docs/images/`、GitHub Release 附件是三件不同的事。

---

## 1. 主页 README 怎么生效（GitHub 的特殊仓库）

官方规则（[Managing your profile README](https://docs.github.com/en/account-and-profile/how-tos/profile-customization/managing-your-profile-readme)）：

1. 新建**公开**仓库，名字必须**恰好等于登录名**：`Fortda` → `https://github.com/Fortda/Fortda`。
2. 根目录有非空的 `README.md`。
3. GitHub 自动把它铺到个人主页。没有单独的「主页编辑器」。

旁边还可以有：

| 仓库 | URL | 干什么 |
|---|---|---|
| `Fortda/Fortda` | [github.com/Fortda](https://github.com/Fortda) | **人**的主页 README + `assets/` |
| `Fortda/omnitrace` | [github.com/Fortda/omnitrace](https://github.com/Fortda/omnitrace) | **软件**源码与产品 README（本仓库） |
| `Fortda/Fortda.github.io`（可选） | `https://fortda.github.io` | 真正的个人网站；Nagi 的 [nagi.fun](https://nagi.fun) 就是这类站点 + 自定义域名 |

Nagi 的结构（只抄骨架，不抄身份）：

```text
github.com/Nagi-ovo                 ← 登录名
  Name: Jesse Zhang                 ← 显示名
  Nagi-ovo/Nagi-ovo                 ← profile README + assets/ + 定时脚本
  Nagi-ovo/voyager                  ← 产品仓库
  voyager.nagi.fun                  ← 产品文档站（VitePress → GitHub Pages + CNAME）
  nagi.fun / blog.nagi.fun          ← 个人站与博客（另一套，Svelte；不是 Voyager 文档）
```

你对应的最小集：

```text
github.com/Fortda
  Name: （可选）Fortda 或真名
  Bio: 已有「憧憬成为超级智慧生命体的我想要解构现象世界」——可以留着
  Fortda/Fortda                     ← 先做这个（主页）
  Fortda/omnitrace                  ← 软件（orphan 公开，勿推旧 master）
  文档站                            ← 以后再说；现在 docs/architecture 已经够用
```

### `assets/` 怎么用

在 **Fortda/Fortda** 里建 `assets/`，主页 README 用相对路径引用：

```markdown
<img src="assets/icon.png" width="88" alt="OmniTrace">
```

GitHub 会从 profile 仓库取图。Nagi 还用了 `blob/main/assets/hi.gif?raw=true` 这种绝对 URL，效果一样，只是更长。

**不要**把个人主页 GIF 塞进本软件仓库的 `docs/images/`。那边是产品 README 的示意图，有隐私约束（见 [images/README.md](images/README.md)）。

等 `Fortda/omnitrace` 公开后，也可以热链产品图标：

`https://raw.githubusercontent.com/Fortda/omnitrace/main/docs/images/icon.png`

公开之前这条会 404，所以草稿正文里先不放死链。

### Shields、访问计数、打字机 SVG 在干什么

这些都不是 GitHub 内置功能，而是 README 里嵌的 **图片 URL**。打开主页时，GitHub 的 Camo 代理去拉一张 SVG，看起来像徽章。

| 类型 | 典型来源 | 建议 |
|---|---|---|
| 静态徽章 | [shields.io](https://shields.io) `img.shields.io/badge/...` | 可以用。本仓库产品 README 已用 MIT / GitHub 色条。 |
| 动态仓库数据 | shields 的 GitHub stars/license 接口 | **等 omnitrace 真的公开再开**。现在 Fortda 是 0 个公开库，徽章会很难看或报错。 |
| 贡献统计卡 | [github-readme-stats](https://github.com/anuraghazra/github-readme-stats)（Nagi 还自己在 Vercel 上挂了一份） | 同样等有公开提交再考虑。 |
| 访问计数 | komarev 的 `komarev.com/ghpvc` | 计的是页面命中，不是独立访客；可当玩具，**不要填假的 base 数字**。草稿默认不加。 |
| 打字机 SVG | [readme-typing-svg](https://github.com/DenverCoder1/readme-typing-svg) | 第三方服务生成动画字。结构可以学，文案用你自己的。草稿默认不加，以免一上来就像模板站。 |
| WakaTime 编码时长 | Nagi 的 `updateme.yml` | 要 API key，和 OmniTrace 无关。别抄。 |

Nagi 主页更「活」的部分，是仓库里的 `build_readme.py`：GitHub Actions 定时去拉博客 API 和 Releases，把 HTML 片段写回 README。你现在没有公开 Release、也没有 nagi.fun 那种博客，**不必上这套流水线**。手写一段稳住即可。

---

## 2. 产品文档站（Voyager 那种 guide/timeline）以后怎么做

[voyager.nagi.fun/guide/timeline](https://voyager.nagi.fun/guide/timeline) 不是 GitHub 主页，而是 **Voyager 仓库里的 VitePress 站点**：

- 源码：`voyager/docs/`（中文 `docs/guide/`，英文 `docs/en/guide/` 等十来个语言）
- 配置：`docs/.vitepress/config.mts`，`siteUrl = https://voyager.nagi.fun`
- 发布：`.github/workflows/deploy-docs.yml` → `bun run docs:build` → **GitHub Pages**
- 自定义域名：仓库根 `CNAME` 内容为 `voyager.nagi.fun`（DNS 指到 GitHub Pages）

对照 OmniTrace：

| Voyager 文档页 | 你现在已有的人读文档 | 以后文档站上的近似路由 |
|---|---|---|
| `/guide/timeline`（功能说明） | [architecture/OVERVIEW.md](architecture/OVERVIEW.md) 的播放/时间轴不变量 | `/guide/player` 或 `/guide/timeline` |
| 安装指南 | 根 README「安装」+ [releasing.md](releasing.md) | `/guide/install` |
| 架构总览 | [architecture/](architecture/README.md) | `/guide/architecture` |
| 决策记录 | [adr/](adr/README.md) | `/guide/adr` 或保持 GitHub 链接 |

**现在不要另起一座文档站。** 人读契约已经在 `docs/architecture/` + `docs/adr/` + `CHANGELOG.md`。再并行搞 VitePress 容易两份互相漂。

等软件公开、安装说明稳定之后，再在 **omnitrace 仓库内**加 VitePress（常见做法：`docs-site/` 或给现有 markdown 加 `.vitepress`，注意别覆盖现在的 `docs/architecture`）。托管优先：

1. **GitHub Pages**（和 Voyager 一样，零域名成本）：`https://fortda.github.io/omnitrace/`  
   VitePress 的 `base` 设成 `'/omnitrace/'`。
2. 或者 **Cloudflare Pages** 连同一仓库，构建命令 `npx vitepress build`。
3. 自定义域名（`omnitrace.xxx`）完全可选。没有 `nagi.fun` 也能做出同等观感。

---

## 3. 不要从 Nagi 抄的东西

只抄**信息架构**（人 / 产品仓库 / 文档站分离；profile 仓库放 `assets/`；文档用 VitePress）。下面这些不要搬：

- 个人事实：Imperial、MRes、RL、人形机器人、Jesse Zhang、伦敦、简历 PDF
- 口号：「成为榜样而不是偶像」以及博客标题、封面图
- 产品与许可证：Voyager / Shiori / Komorebi、GPL-3.0、Chrome 商店徽章、云同步 Gemini
- 数字：两万星、611 followers、WakaTime 时长、访客计数的 base 注水
- 栈装扮：硬上十语言文档、Vercel 自建 stats、定时刷 README——你还没有对应的内容源
- 视觉素材：`nagi.gif` / `hi.gif` / 他的产品 logo

你自己的材料已经够用：登录名 Fortda、bio、般若计划、OmniTrace、local-first、MIT、关于页那句「情报和信息采集 / 现象世界模型运行日志」、邮箱 `fortdadesu@outlook.com`。

---

## 4. 你在 GitHub 网页上要做的事（手工，无需 token）

1. 打开 [github.com/new](https://github.com/new)。Repository name 填 **`Fortda`**（必须与登录名一致）。Public。勾选 Add a README。
2. （可选）Settings → Profile：Name 填显示名；Website 暂时空着；Bio 可保留现有一句。
3. 把下面「可粘贴正文」覆盖进 `Fortda/Fortda` 的 `README.md`。
4. （可选）在该仓库建 `assets/`，放入一张干净的图标（可从本仓库 `docs/images/icon.png` 拷贝，**不要**拷个人桌面截图）。
5. 软件仓库仍是以后的 `Fortda/omnitrace`，用 orphan 初版，**不要**把本机旧 `master` 推上去。

---

## 5. 可粘贴正文（只复制这一节进 Fortda/Fortda）

复制下面代码块**内部**（不要包含 \`\`\` 围栏，也不要带上第 0–4 节说明），覆盖为 `Fortda/Fortda` 仓库根目录的 `README.md`。

```markdown
<p align="center">
  <strong>Fortda</strong>
</p>

<p align="center">
  憧憬成为超级智慧生命体的我想要解构现象世界
</p>

<p align="center">
  Building a local-first log of the phenomenal world — capture, replay, notes.
</p>

<p align="center">
  <a href="https://github.com/Fortda/omnitrace"><img src="https://img.shields.io/badge/Prajna-OmniTrace-1f6f5b" alt="般若计划 · OmniTrace"></a>
  <a href="https://github.com/Fortda/omnitrace"><img src="https://img.shields.io/badge/data-local--first-2c2a27" alt="local-first"></a>
  <img src="https://img.shields.io/badge/license-MIT-1f6f5b" alt="MIT">
</p>

---

### Now

**[OmniTrace](https://github.com/Fortda/omnitrace)** — 般若计划（Prajna Plan）里正在做的那一件。

Windows 上的本机采集、回放与笔记壳。关于页的原话：情报和信息采集，以及现象世界模型运行日志。

Local-first：数据默认只写本机 `OmniDatabase/`，不上传。公开源码 MIT。远程同步还没有，也先不装成有。

- 采集：后台 WinRecorder（关壳不停录）
- 壳：OmniPlayer（设置 / 回放与直播 / 仪表盘 / 流式笔记）
- 边载：Android 采集 APK（本期不进 Windows 壳）

仓库：<https://github.com/Fortda/omnitrace>

人读架构（现在就在 GitHub 里，不必等独立文档站）：[docs/architecture](https://github.com/Fortda/omnitrace/blob/main/docs/architecture/OVERVIEW.md)

---

### Not this page

This profile is the person (**Fortda**). The software lives in **omnitrace**.  
这里是人；软件在那个仓库。安装包以后挂在 omnitrace 的 GitHub Release Assets 上，不挂在这个主页仓库。

Mail: [fortdadesu@outlook.com](mailto:fortdadesu@outlook.com)
```

粘贴后若要加头像式图标：把图放到 `Fortda/Fortda/assets/icon.png`，在第一段 `<p align="center">` 之前插入：

```html
<p align="center">
  <img src="assets/icon.png" width="88" height="88" alt="OmniTrace">
</p>
```

Stars / 访客 / 打字机徽章等 omnitrace **真的公开且有提交**之后再加。在 0 个公开仓库时加动态统计卡，会像空壳。
