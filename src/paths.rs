//! 数据目录约定（模组框架层；产品封装可再改根路径）。

use chrono::{Datelike, Local};
use std::fs::create_dir_all;
use std::path::{Path, PathBuf};

/// 默认数据根：工作目录下的 OmniDatabase（与现有采集兼容）
pub fn data_root() -> PathBuf {
    PathBuf::from("OmniDatabase")
}

pub fn ensure_dir(path: &Path) {
    create_dir_all(path).unwrap_or_else(|e| panic!("创建目录失败 {}: {}", path.display(), e));
}

/// 世纪目录片段：Century_xxxxxxxx/Year_yyyy/Month_mm
pub fn century_segments() -> PathBuf {
    let now = Local::now();
    let century = (now.year() / 100) + 1;
    PathBuf::from(format!("Century_{:08}", century))
        .join(format!("Year_{:04}", now.year()))
        .join(format!("Month_{:02}", now.month()))
}

pub fn today_day() -> u32 {
    Local::now().day()
}

/// 本地日历 YYYYMMDD，给 win_map 跨日重写粘性 display/wallpaper 用。
pub fn today_ymd() -> i32 {
    let n = Local::now();
    n.year() * 10000 + (n.month() as i32) * 100 + (n.day() as i32)
}

/// 经典物理流路径（input 模组仍可写旧 bin）
pub fn event_data_dir() -> PathBuf {
    data_root().join("EventData").join(century_segments())
}

/// 经典焦点窗路径（focus 模组）
pub fn context_data_dir() -> PathBuf {
    data_root().join("ContextData").join(century_segments())
}

/// 统一模组事件流：OmniDatabase/ModuleData/{module_id}/Century_.../events_DD.jsonl
pub fn module_data_dir(module_id: &str) -> PathBuf {
    data_root()
        .join("ModuleData")
        .join(module_id)
        .join(century_segments())
}

pub fn module_events_path_today(module_id: &str) -> PathBuf {
    module_data_dir(module_id).join(format!("events_{:02}.jsonl", today_day()))
}

/// 模组清单：OmniDatabase/manifest.json
pub fn manifest_path() -> PathBuf {
    data_root().join("manifest.json")
}

/// 控制面：pid / 简单状态（给设置页启停用）
pub fn control_dir() -> PathBuf {
    data_root().join("control")
}

pub fn pid_path() -> PathBuf {
    control_dir().join("winrecorder.pid")
}

/// 上次心跳的 GetTickCount64 + 墙钟（给下次启动推断关机用；无密钥）。
pub fn clock_sidecar_path() -> PathBuf {
    control_dir().join("winrecorder_clock.json")
}

/// 给小狼毫侧路用：绝对路径，避免 WeaselServer 的工作目录不是仓库根。
pub fn write_data_root_pointer() {
    let abs = std::env::current_dir()
        .map(|c| c.join(data_root()))
        .unwrap_or_else(|_| data_root());
    let abs = std::fs::canonicalize(&abs).unwrap_or(abs);
    let mut text = abs.to_string_lossy().into_owned();
    if let Some(rest) = text.strip_prefix(r"\\?\") {
        text = rest.to_string();
    }
    ensure_dir(&control_dir());
    let _ = std::fs::write(control_dir().join("data_root.txt"), &text);
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let dir = PathBuf::from(local).join("OmniTrace");
        let _ = create_dir_all(&dir);
        let _ = std::fs::write(dir.join("data_root.txt"), &text);
    }
}
