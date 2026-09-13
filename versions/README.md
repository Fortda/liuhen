# versions/ — 里程碑决策舱

给人粗看、给 AI 检索 **决策摘要**。不要把聊天全文推进 Git。

## 布局

```
versions/
  v0/
    README.md
    2026-08-03_plugin-host-shell/
      DECISIONS.md     # 可提交
      PROMPT.md        # 本机可留，已 gitignore，不要 push
      code/            # 可选源码快照
```

## 何时新开小版

架构转弯、一批功能收口、或明确说「打一版快照」。日常用 git + `CHANGELOG.md`。

## 快照拷贝时排除

`target`、`node_modules`、`dist`、`OmniDatabase`、`.git`、`PROMPT.md`
