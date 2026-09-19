# versions/ — 里程碑决策

这里放阶段性决策摘要。日常发版说明走根目录 `CHANGELOG.md`。

## 布局

```
versions/
  v0/
    README.md
    2026-08-03_plugin-host-shell/
      DECISIONS.md     # 可提交
      PROMPT.md        # 本机可留，已 gitignore
      code/            # 可选源码快照
```

## 何时新开小版

架构转弯、一批功能收口、或明确打一版快照。

## 快照不要拷进去的

`target`、`node_modules`、`dist`、`OmniDatabase`、`.git`、`PROMPT.md`
