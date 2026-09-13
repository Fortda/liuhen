//! 采集模组心跳 / 墓碑：给仪表盘运作时间轴用。
//!
//! - `start`：模组启动
//! - `beat`：运行中心跳（宿主主循环写入）
//! - `tombstone`：正常关闭收尾；`reason` 区分 clean_stop / user_close / shutdown /
//!   logoff / ctrl_c / shutdown_inferred
//! - 若心跳中断且无墓碑，前端标红感叹号（stale）；同一次开机的崩溃/`taskkill /F` 走这条
//! - 雷霆关机可能赶不及墓碑：下次启动用 tick vs 墙钟推断，补写 `shutdown_inferred`

use crate::module::ModuleId;
use crate::paths::{self, ensure_dir};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::time::{SystemTime, UNIX_EPOCH};

/// 墙钟比 GetTickCount64 多走这么久，才把「无墓碑的上一跨度」推断为关机。
/// 同一次开机崩溃后重开：墙钟与 tick 一起走，差值只有测量误差（毫秒级），即使
/// cargo build 要一分钟也对不齐这条。睡眠/断电期间 tick 暂停或回退，过夜是数小时。
/// 60s 高于 NTP/调度噪声，低于任何真实关机或睡眠后重启。
pub const INFER_WALL_AHEAD_MS: u64 = 60_000;

pub fn health_log_path() -> std::path::PathBuf {
    paths::control_dir().join("module_health.jsonl")
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn tick64() -> u64 {
    #[cfg(windows)]
    {
        unsafe { windows::Win32::System::SystemInformation::GetTickCount64() }
    }
    #[cfg(not(windows))]
    {
        0
    }
}

fn append_with_ts(ts: u64, kind: &str, module: &str, extra: Value) {
    ensure_dir(&paths::control_dir());
    let mut obj = serde_json::Map::new();
    obj.insert("ts".into(), json!(ts));
    obj.insert("kind".into(), json!(kind));
    obj.insert("module".into(), json!(module));
    if let Some(map) = extra.as_object() {
        for (k, v) in map {
            obj.insert(k.clone(), v.clone());
        }
    }
    let line = serde_json::Value::Object(obj).to_string();
    if let Ok(mut f) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(health_log_path())
    {
        let _ = writeln!(f, "{line}");
    }
}

fn append(kind: &str, module: &str, extra: Value) {
    append_with_ts(now_ms(), kind, module, extra);
}

pub fn sync_health_log() {
    if let Ok(f) = OpenOptions::new().append(true).open(health_log_path()) {
        let _ = f.sync_all();
    }
}

pub fn mark_starts(modules: &[ModuleId]) {
    for id in modules {
        append("start", id.as_str(), json!({}));
    }
    persist_clock_sidecar();
}

pub fn mark_beats(modules: &[ModuleId]) {
    for id in modules {
        append("beat", id.as_str(), json!({}));
    }
    persist_clock_sidecar();
}

pub fn mark_tombstones(modules: &[ModuleId], reason: &str) {
    for id in modules {
        append(
            "tombstone",
            id.as_str(),
            json!({ "reason": reason }),
        );
    }
}

fn mark_tombstones_at(module: &str, reason: &str, ts: u64) {
    append_with_ts(ts, "tombstone", module, json!({ "reason": reason }));
}

/// 停止命令侧：对默认启用模组写墓碑（进程被杀前/后都可）。
pub fn mark_default_tombstones(reason: &str) {
    mark_tombstones(
        &[
            ModuleId::Input,
            ModuleId::Focus,
            ModuleId::WinMap,
            ModuleId::WinSettings,
            ModuleId::Body,
            ModuleId::Network,
        ],
        reason,
    );
}

#[derive(Debug, Clone)]
struct ClockSidecar {
    tick64: u64,
    wall_ms: u64,
}

fn persist_clock_sidecar() {
    ensure_dir(&paths::control_dir());
    let path = paths::clock_sidecar_path();
    let obj = json!({
        "pid": std::process::id(),
        "tick64": tick64(),
        "wall_ms": now_ms(),
    });
    let tmp = path.with_extension("json.tmp");
    if fs::write(&tmp, obj.to_string()).is_ok() {
        if fs::rename(&tmp, &path).is_err() {
            let _ = fs::remove_file(&path);
            let _ = fs::rename(&tmp, &path);
        }
    }
}

fn read_clock_sidecar() -> Option<ClockSidecar> {
    let raw = fs::read_to_string(paths::clock_sidecar_path()).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    Some(ClockSidecar {
        tick64: v.get("tick64")?.as_u64()?,
        wall_ms: v.get("wall_ms")?.as_u64()?,
    })
}

/// tick 回退 = 整机重启 / 常见 Fast Startup；墙钟超前 tick 很多 = 断电或睡眠期间 tick 暂停。
pub fn clocks_imply_shutdown(
    last_tick: u64,
    last_wall: u64,
    now_tick: u64,
    now_wall: u64,
) -> bool {
    if now_tick < last_tick {
        return true;
    }
    let wall_gap = now_wall.saturating_sub(last_wall);
    let tick_delta = now_tick.saturating_sub(last_tick);
    wall_gap.saturating_sub(tick_delta) >= INFER_WALL_AHEAD_MS
}

fn read_health_tail() -> Vec<Value> {
    let path = health_log_path();
    let Ok(mut f) = File::open(&path) else {
        return Vec::new();
    };
    let Ok(meta) = f.metadata() else {
        return Vec::new();
    };
    const TAIL_BYTES: u64 = 2 * 1024 * 1024;
    let start = meta.len().saturating_sub(TAIL_BYTES);
    if start > 0 && f.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut text = String::new();
    if f.read_to_string(&mut text).is_err() {
        return Vec::new();
    }
    let body = if start > 0 {
        text.split_once('\n').map(|(_, rest)| rest).unwrap_or("")
    } else {
        text.as_str()
    };
    body.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

/// 健康日志尾部：仍开着的模组 → 最后一次 start/beat 的 ts。
fn open_modules_from_health_tail() -> BTreeMap<String, u64> {
    let mut open: BTreeMap<String, u64> = BTreeMap::new();
    for e in read_health_tail() {
        let kind = e.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        let module = e.get("module").and_then(|v| v.as_str()).unwrap_or("");
        let ts = e.get("ts").and_then(|v| v.as_u64()).unwrap_or(0);
        if module.is_empty() || ts == 0 {
            continue;
        }
        match kind {
            "start" | "beat" => {
                open.insert(module.to_string(), ts);
            }
            "tombstone" => {
                open.remove(module);
            }
            _ => {}
        }
    }
    open
}

/// 新进程启动、上一实例已不在时调用（须在 `mark_starts` 之前）。
/// 有 beat 无墓碑且时钟像关机/休眠 → 按最后心跳 ts 补写 `shutdown_inferred`。
/// 同一次开机且 wall≈tick（崩溃 / `taskkill /F`）不写，留给仪表盘 `missing_tombstone`。
pub fn maybe_infer_prior_shutdown() {
    let Some(prev) = read_clock_sidecar() else {
        return;
    };
    if !clocks_imply_shutdown(prev.tick64, prev.wall_ms, tick64(), now_ms()) {
        return;
    }
    let open = open_modules_from_health_tail();
    if open.is_empty() {
        return;
    }
    for (module, ts) in open {
        mark_tombstones_at(&module, "shutdown_inferred", ts);
    }
    sync_health_log();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_boot_crash_is_not_shutdown() {
        let tick = 3_600_000;
        let wall = 1_700_000_000_000;
        // 崩溃后 45s 才再拉起：墙钟与 tick 一起走
        assert!(!clocks_imply_shutdown(
            tick,
            wall,
            tick + 45_000,
            wall + 45_000
        ));
    }

    #[test]
    fn overnight_poweroff_is_shutdown() {
        let tick = 8 * 3_600_000;
        let wall = 1_700_000_000_000;
        // 关机 8 小时：墙钟 +8h，tick 几乎不动（进程已死、机器断电）
        assert!(clocks_imply_shutdown(
            tick,
            wall,
            tick + 2_000,
            wall + 8 * 3_600_000
        ));
    }

    #[test]
    fn reboot_tick_reset_is_shutdown() {
        let tick = 12 * 3_600_000;
        let wall = 1_700_000_000_000;
        assert!(clocks_imply_shutdown(tick, wall, 8_000, wall + 60_000));
    }

    #[test]
    fn sleep_then_restart_is_shutdown() {
        let tick = 4_000_000;
        let wall = 1_700_000_000_000;
        // GetTickCount64 睡眠期间不增加
        assert!(clocks_imply_shutdown(
            tick,
            wall,
            tick + 5_000,
            wall + 30 * 60_000
        ));
    }

    #[test]
    fn sub_minute_skew_is_not_shutdown() {
        let tick = 1_000_000;
        let wall = 1_700_000_000_000;
        assert!(!clocks_imply_shutdown(
            tick,
            wall,
            tick + 10_000,
            wall + 10_500
        ));
    }
}
