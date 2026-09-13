# ADR-0001：进程内插件框架 + OmniPlayer 直播预览 + Win 壳层

- **日期**：2026-08-03
- **版本**：omnitrace_input 0.2.x / OmniPlayer 无边框 PotPlayer 式 UI

## 1. 用户提示词（摘要，多轮合并）

```
- 不要先封装；先搞模组接口框架。
- 模组应像游戏 mod：高度融合同一进程，不要两个独立软件各跑各的。
- 键鼠继续二进制压缩、零假设不失真；窗口等可另定格式。
- 尽量用钩子记窗口；终端调试局限，要用 OmniPlayer 热更新 + 直播式同步预览。
- 帧率要能跟上刷新；做前后窗口；壁纸/任务栏；双屏；光标用 Win 默认箭头且像素尺寸对齐系统。
- 读取底边栏位置大小与图标；启动记壁纸，变更再记；点任务栏时要能显示桌面。
- UI 学 PotPlayer：画面自适应窗口，控件不挡内容；去掉系统标题栏（若 Tauri 支持）。
- 256k 上下文不够：每版留存代码决策，并附上提示词与架构记录。
```

## 2. 背景

早期是 `omnitrace_input` + `win_context` 两个进程、相对路径写库；后又有过产品化封装尝试。用户明确要 **自用开发优先、插件融合、播放器可视化迭代**，并扩展到桌面壳层（壁纸/任务栏/多屏）。

## 3. 决策

### 决定做

1. **进程内插件**：`TraceModule` + `ModuleRegistry` 同进程加载；默认启用 `input` + `focus` + `win_map`。
2. **双轨数据**：
   - 键鼠：`OmniDatabase/EventData/.../trace_DD.bin`（压缩二进制，零假设坐标/时间）
   - 壳/窗：`OmniDatabase/ModuleData/{module}/.../events_DD.jsonl`（统一信封 `ModuleEvent`）
3. **OmniPlayer**：`tauri dev` 热更新；「直播」tail 文件；虚拟桌面坐标渲染双屏。
4. **win_map**：Z-order 快照、`display_setup`（虚拟桌面+光标尺寸+壁纸路径）、`taskbar`、`wallpaper` 变更。
5. **播放器 UI**：`decorations: false`；画面 contain letterbox；底栏叠层半隐，不挤压内容区。
6. **ADR 落盘**：本目录记录提示词与决策，对抗对话截断。

### 决定不做 / 延后

- 完整复刻第三方动态壁纸画面（无统一 API）。
- Win11 XAML 任务栏 100% 枚举每个按钮（系统限制，尽力而为）。
- 品牌输入法 / Ctrl+Alt+Del 安全桌面。
- 再优先做安装封装（用户说过先不封装）。

## 4. 实现要点

| 模块 | 作用 |
|------|------|
| `input` | 全局钩子 + bin 压缩写盘（同进程线程） |
| `focus` | 焦点窗（现轮询；目标可改 SetWinEventHook） |
| `win_map` | 窗叠层 + 显示器 + 壁纸 + 任务栏/图标 |

关键路径：

- 采集：`src/module/*`, `src/modules/*`, `src/capture/input_bin.rs`, `src/win_enum.rs`, `src/shell.rs`, `src/bin_host.rs`
- 播放：`omniplayer/src/main.ts`, `omniplayer/src/modules/*`, `omniplayer/index.html`, `omniplayer/src-tauri/*`

信封：`{ v, module, ts, kind, payload }`

## 5. 验证

- [ ] 项目根 `cargo run`（需停旧进程避免 exe 锁）
- [ ] `omniplayer` 下 `npm run tauri dev`，点「直播」
- [ ] 双屏边框、壁纸底图、任务栏条、箭头光标尺寸
- [ ] 无边框拖拽 / 最小化最大化关闭

## 6. 后果与下一刀

- 焦点仍偏轮询；窗口侧可改为 `SetWinEventHook`。
- Win11 任务栏图标可能不全。
- 下一版改动请新增 `ADR-0002-...md`，并贴上**该版**用户原文提示词。
