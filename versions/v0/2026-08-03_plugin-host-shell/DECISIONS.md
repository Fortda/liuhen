# 本轮架构决策（原数据）

## 做了什么

- 进程内 `TraceModule` / `ModuleRegistry`；默认 `input` + `focus` + `win_map`。
- 键鼠 → `EventData/.../trace_DD.bin`；壳层 → `ModuleData/{id}/.../events_DD.jsonl` 信封。
- OmniPlayer：直播 tail、虚拟桌面双屏、无边框、contain 自适应、底栏叠层半隐。
- win_map：Z-order、display_setup（含 cursor_size/壁纸）、taskbar、wallpaper 变更；图标尽力抽到 `ModuleData/win_map/icons/`。

## 明确延后

- 第三方动态壁纸像素级还原；Win11 任务栏 100% 按钮枚举；IME；双进程旧方案。

## 验证入口

- 根目录 `cargo run`
- `omniplayer` → `npm run tauri dev` → 直播

## 快照说明

若本目录存在 `code/`，为当时工作区源码拷贝（已排除 target/node_modules 等）。  
没有 `code/` 时以 git 历史 + 当时仓库根为准。
