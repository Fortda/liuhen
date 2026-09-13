//! 仪表盘：健康时间轴 / 统计 / 最新动态

use chrono::{Datelike, Duration as ChronoDuration, Local, NaiveDate, TimeZone};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use base64::Engine;

/// 键鼠柱永久缓存写互斥（避免并发重建踩文件）
static INPUT_HIST_CACHE_LOCK: Mutex<()> = Mutex::new(());
/// 进程内日柱缓存：避免每次 histogram 都读 ~700KB .otih
static INPUT_HIST_RAM: LazyLock<Mutex<HashMap<String, DayHistRamEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
/// 统计图表切页会连打 dashboard_stats；全库扫盘约 1s+，短 TTL 避免堵住 health/live。
/// key = include_active_focus：关=全部焦点，开=同一套图去掉可能 AFK（无键鼠 5 分钟格）。
const STATS_CACHE_TTL: Duration = Duration::from_secs(12);
struct StatsCacheEntry {
    at: Instant,
    report: StatsReport,
}
static STATS_CACHE: LazyLock<Mutex<HashMap<bool, StatsCacheEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
const INPUT_HIST_MAGIC: &[u8; 4] = b"OTIH";
const INPUT_HIST_VER: u32 = 1;
const KEY_FREQ_MAGIC: &[u8; 4] = b"OTKF";
const KEY_FREQ_VER: u32 = 1;
const KEY_FREQ_TOP_N: usize = 20;
const INPUT_HIST_FINE_MS: u64 = 1_000;
const SECS_PER_DAY: usize = 86_400;

/// 单段焦点无后续事件时的封顶，避免关机前一条挂一夜
const FOCUS_SEGMENT_CAP_MS: u64 = 2 * 60 * 60 * 1000;
/// 活跃焦点洗数：5 分钟格。格内 otih 1s 柱 mouse+key≥1 才把重叠的焦点时长算进去。
const ACTIVE_FOCUS_BIN_MS: u64 = 300_000;
const ACTIVE_FOCUS_BINS_PER_DAY: usize = 288;

const STALE_MS: u64 = 5000;
const MODULES: &[&str] = &["input", "focus", "win_map", "win_settings", "body", "ime"];

#[derive(Serialize, Deserialize, Clone)]
pub struct HealthSegment {
    pub module: String,
    pub start_ts: u64,
    pub end_ts: Option<u64>,
    /// running | stopped | stale
    pub status: String,
    pub stale: bool,
    /// tombstone.reason：clean_stop / user_close / shutdown / logoff / ctrl_c / shutdown_inferred …
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_reason: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct TimelineSegment {
    pub start_ts: u64,
    pub end_ts: Option<u64>,
    /// app 轴：焦点=true 实色，非焦点=false 淡化；采集器轴可忽略
    pub focused: bool,
    pub status: String,
    pub stale: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_reason: Option<String>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct TimelineLane {
    pub id: String,
    pub label: String,
    /// recorder | app
    pub kind: String,
    pub color: String,
    pub segments: Vec<TimelineSegment>,
}

#[derive(Serialize, Deserialize, Clone)]
pub struct HealthReport {
    pub now_ts: u64,
    pub window_start_ts: u64,
    pub lanes: Vec<TimelineLane>,
    /// 兼容旧字段（前端已改用 lanes）
    pub segments: Vec<HealthSegment>,
    pub modules: Vec<String>,
}

/// 健康报告扫盘贵；短 TTL 避免切页连打把播放器 IPC 堵住。
const HEALTH_REPORT_TTL: Duration = Duration::from_secs(12);
struct HealthReportCacheEntry {
    at: Instant,
    report: HealthReport,
}
static HEALTH_REPORT_CACHE: LazyLock<Mutex<Option<HealthReportCacheEntry>>> =
    LazyLock::new(|| Mutex::new(None));

/// 软件轴配色（避开大面积紫；按 app 名哈希取色）
const APP_COLORS: &[&str] = &[
    "#2f7a66", "#c45c5c", "#c9a227", "#3b6fa0", "#c46b3a", "#5a8f3c", "#b84d6a",
    "#4a7c8c", "#8b5a2b", "#6a7d4e", "#a05a5a", "#3d8a7a", "#b07a3a", "#5c6b8a",
    "#7a5c4a", "#2d6b8a", "#8a6b3d", "#4e7a5c", "#a05040", "#3a6b6b",
];

#[derive(Serialize, Clone)]
pub struct StatsReport {
    pub data_root: String,
    pub recorder_running: bool,
    pub today: Value,
    pub charts: Value,
    pub volume: Value,
}

#[derive(Serialize)]
pub struct LiveFeedItem {
    pub ts: u64,
    pub source: String,
    pub kind: String,
    pub summary: String,
}

#[derive(Serialize)]
pub struct LiveFeedReport {
    pub items: Vec<LiveFeedItem>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn data_root() -> PathBuf {
    // 与壳全局一致：稳定版走 exe 旁 data_root.json，禁止相对路径落到安装目录空库。
    crate::resolve_data_root()
}

fn century_segments(now: chrono::DateTime<Local>) -> PathBuf {
    let century = (now.year() / 100) + 1;
    PathBuf::from(format!("Century_{:08}", century))
        .join(format!("Year_{:04}", now.year()))
        .join(format!("Month_{:02}", now.month()))
}

fn health_path() -> PathBuf {
    data_root().join("control").join("module_health.jsonl")
}

fn read_jsonl_tail(path: &Path, max_lines: usize) -> Vec<Value> {
    let Ok(mut f) = File::open(path) else {
        return Vec::new();
    };
    let Ok(meta) = f.metadata() else {
        return Vec::new();
    };
    let len = meta.len();
    // 只啃文件尾部，禁止整文件读进内存（长年健康日志会把命令拖死）
    const TAIL_BYTES: u64 = 2 * 1024 * 1024;
    let start = len.saturating_sub(TAIL_BYTES);
    if f.seek(SeekFrom::Start(start)).is_err() {
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
    let mut lines: Vec<&str> = body
        .lines()
        .filter(|l| !l.trim().is_empty())
        .collect();
    if lines.len() > max_lines {
        lines = lines.split_off(lines.len() - max_lines);
    }
    lines
        .into_iter()
        .filter_map(|l| serde_json::from_str(l).ok())
        .collect()
}

/// 健康日志 → 运行段缓存：jsonl 只追加时从 parsed_len 续读，避免心跳改 mtime 就整文件重扫。
struct HealthSpanState {
    /// 已消化的完整行字节数（不含文件尾半行）
    parsed_len: u64,
    file_len: u64,
    modified: SystemTime,
    closed: Vec<HealthSegment>,
    /// module → (start_ts, last_beat_ts)
    open: BTreeMap<String, (u64, u64)>,
}

static HEALTH_SPAN_CACHE: LazyLock<Mutex<Option<HealthSpanState>>> =
    LazyLock::new(|| Mutex::new(None));

#[derive(Serialize, Deserialize)]
struct HealthSpanDisk {
    parsed_len: u64,
    closed: Vec<HealthSegment>,
    open: Vec<(String, u64, u64)>,
}

fn health_span_disk_path() -> PathBuf {
    data_root().join("cache").join("health_span_state.json")
}

fn health_report_snapshot_path() -> PathBuf {
    data_root().join("cache").join("health_report_last.json")
}

fn health_span_ready() -> bool {
    if let Ok(g) = HEALTH_SPAN_CACHE.lock() {
        if g.is_some() {
            return true;
        }
    }
    health_span_disk_path().is_file()
}

fn load_health_span_disk(file_len: u64, modified: SystemTime) -> Option<HealthSpanState> {
    let buf = fs::read(health_span_disk_path()).ok()?;
    let disk: HealthSpanDisk = serde_json::from_slice(&buf).ok()?;
    if disk.parsed_len > file_len {
        return None;
    }
    Some(HealthSpanState {
        parsed_len: disk.parsed_len,
        file_len,
        modified,
        closed: disk.closed,
        open: disk
            .open
            .into_iter()
            .map(|(m, a, b)| (m, (a, b)))
            .collect(),
    })
}

fn persist_health_span_cache() {
    let guard = HEALTH_SPAN_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let Some(state) = guard.as_ref() else {
        return;
    };
    let disk = HealthSpanDisk {
        parsed_len: state.parsed_len,
        closed: state.closed.clone(),
        open: state
            .open
            .iter()
            .map(|(m, (a, b))| (m.clone(), *a, *b))
            .collect(),
    };
    let path = health_span_disk_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let tmp = path.with_extension("json.tmp");
    if let Ok(buf) = serde_json::to_vec(&disk) {
        if fs::write(&tmp, buf).is_ok() {
            let _ = fs::rename(&tmp, path);
        }
    }
}

fn load_health_report_snapshot() -> Option<HealthReport> {
    let buf = fs::read(health_report_snapshot_path()).ok()?;
    serde_json::from_slice(&buf).ok()
}

fn save_health_report_snapshot(report: &HealthReport) {
    let path = health_report_snapshot_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let tmp = path.with_extension("json.tmp");
    if let Ok(buf) = serde_json::to_vec(report) {
        if fs::write(&tmp, buf).is_ok() {
            let _ = fs::rename(&tmp, path);
        }
    }
}

fn finish_health_segments(
    closed: &[HealthSegment],
    open: &BTreeMap<String, (u64, u64)>,
    now: u64,
) -> Vec<HealthSegment> {
    let mut out = closed.to_vec();
    for (module, (start, last)) in open {
        let stale = now.saturating_sub(*last) > STALE_MS;
        out.push(HealthSegment {
            module: module.clone(),
            start_ts: *start,
            end_ts: if stale { Some(*last) } else { None },
            status: if stale {
                "stale".into()
            } else {
                "running".into()
            },
            stale,
            end_reason: if stale {
                Some("heartbeat_gap".into())
            } else {
                None
            },
        });
    }
    out.sort_by(|a, b| {
        a.module
            .cmp(&b.module)
            .then(a.start_ts.cmp(&b.start_ts))
    });
    out
}

fn close_open_module(
    out: &mut Vec<HealthSegment>,
    open: &mut BTreeMap<String, (u64, u64)>,
    module: &str,
    end_ts: u64,
    status: &str,
    stale: bool,
    end_reason: Option<&str>,
) {
    let Some((start, last)) = open.remove(module) else {
        return;
    };
    let end = end_ts.max(last).max(start);
    if end <= start {
        return;
    }
    out.push(HealthSegment {
        module: module.to_string(),
        start_ts: start,
        end_ts: Some(end),
        status: status.into(),
        stale,
        end_reason: end_reason.map(|s| s.to_string()),
    });
}

/// 用户模型：起始点 + 心跳异常中断点 + 终止点 → 运行时段。
/// 不依赖「有多少键鼠数据」；也不因只读文件尾而丢掉老会话。
fn apply_health_line(
    e: &Value,
    open: &mut BTreeMap<String, (u64, u64)>,
    closed: &mut Vec<HealthSegment>,
) {
    let kind = e.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    let module = e.get("module").and_then(|v| v.as_str()).unwrap_or("");
    let ts = e.get("ts").and_then(|v| v.as_u64()).unwrap_or(0);
    if module.is_empty() || ts == 0 {
        return;
    }
    match kind {
        "start" => {
            // 新进程开录却没写 tombstone：先把旧开段按最后心跳收成中断
            if open.contains_key(module) {
                let last = open.get(module).map(|(_, l)| *l).unwrap_or(ts);
                close_open_module(closed, open, module, last, "stale", true, Some("missing_tombstone"));
            }
            open.insert(module.to_string(), (ts, ts));
        }
        "beat" => {
            if let Some((start, last)) = open.get(module).copied() {
                if ts.saturating_sub(last) > STALE_MS {
                    // 心跳缺口 = 异常中断点
                    close_open_module(closed, open, module, last, "stale", true, Some("heartbeat_gap"));
                    open.insert(module.to_string(), (ts, ts));
                } else {
                    open.insert(module.to_string(), (start, ts));
                }
            } else {
                // 日志从中段开始：把首个 beat 当起始点
                open.insert(module.to_string(), (ts, ts));
            }
        }
        "tombstone" => {
            let reason = e
                .get("reason")
                .and_then(|v| v.as_str())
                .unwrap_or("clean_stop");
            // shutdown / logoff / shutdown_inferred 一律已停，不当 stale
            if open.contains_key(module) {
                close_open_module(closed, open, module, ts, "stopped", false, Some(reason));
            } else {
                // 孤立墓碑：仍记一个极短停止点，避免完全看不见
                closed.push(HealthSegment {
                    module: module.to_string(),
                    start_ts: ts.saturating_sub(1),
                    end_ts: Some(ts),
                    status: "stopped".into(),
                    stale: false,
                    end_reason: Some(reason.to_string()),
                });
            }
        }
        _ => {}
    }
}

fn apply_health_bytes(
    data: &[u8],
    open: &mut BTreeMap<String, (u64, u64)>,
    closed: &mut Vec<HealthSegment>,
) -> usize {
    let mut consumed = 0usize;
    let mut start = 0usize;
    while let Some(rel) = data[start..].iter().position(|&b| b == b'\n') {
        let end = start + rel + 1;
        consumed = end;
        let text = std::str::from_utf8(&data[start..end])
            .unwrap_or("")
            .trim();
        start = end;
        if text.is_empty() {
            continue;
        }
        if let Ok(e) = serde_json::from_str::<Value>(text) {
            apply_health_line(&e, open, closed);
        }
    }
    consumed
}

fn read_path_from(path: &Path, offset: u64) -> Vec<u8> {
    let Ok(mut f) = File::open(path) else {
        return Vec::new();
    };
    if offset > 0 && f.seek(SeekFrom::Start(offset)).is_err() {
        return Vec::new();
    }
    let mut buf = Vec::new();
    let _ = f.read_to_end(&mut buf);
    buf
}

fn scan_health_span_state(path: &Path) -> HealthSpanState {
    let modified = fs::metadata(path)
        .and_then(|m| m.modified())
        .unwrap_or(SystemTime::UNIX_EPOCH);
    let file_len = fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let mut closed: Vec<HealthSegment> = Vec::new();
    let mut open: BTreeMap<String, (u64, u64)> = BTreeMap::new();
    let buf = read_path_from(path, 0);
    let consumed = apply_health_bytes(&buf, &mut open, &mut closed);
    HealthSpanState {
        parsed_len: consumed as u64,
        file_len,
        modified,
        closed,
        open,
    }
}

fn health_segments_now(now: u64) -> Vec<HealthSegment> {
    let path = health_path();
    let meta = fs::metadata(&path).ok();
    let file_len = meta.as_ref().map(|m| m.len()).unwrap_or(0);
    let modified = meta
        .and_then(|m| m.modified().ok())
        .unwrap_or(SystemTime::UNIX_EPOCH);

    let mut guard = HEALTH_SPAN_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let ram_ok = guard.as_ref().is_some_and(|s| file_len >= s.parsed_len);
    if !ram_ok {
        *guard = load_health_span_disk(file_len, modified);
        if guard.is_none() {
            *guard = Some(scan_health_span_state(&path));
        }
    }
    if let Some(state) = guard.as_mut() {
        if file_len > state.parsed_len {
            let buf = read_path_from(&path, state.parsed_len);
            let n = apply_health_bytes(&buf, &mut state.open, &mut state.closed);
            state.parsed_len += n as u64;
            state.file_len = file_len;
            state.modified = modified;
        } else {
            state.file_len = file_len;
            state.modified = modified;
        }
    }
    let Some(state) = guard.as_ref() else {
        return Vec::new();
    };
    let out = finish_health_segments(&state.closed, &state.open, now);
    out
}

/// 冷启动首帧：只啃健康日志尾，不写入 HEALTH_SPAN_CACHE（避免把半段当成全集）。
fn health_segments_tail(now: u64) -> Vec<HealthSegment> {
    const TAIL: u64 = 2 * 1024 * 1024;
    let path = health_path();
    let file_len = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let start = file_len.saturating_sub(TAIL);
    let buf = read_path_from(&path, start);
    let slice = if start > 0 {
        match buf.iter().position(|&b| b == b'\n') {
            Some(i) => &buf[i + 1..],
            None => &buf[..],
        }
    } else {
        &buf[..]
    };
    let mut closed = Vec::new();
    let mut open = BTreeMap::new();
    apply_health_bytes(slice, &mut open, &mut closed);
    finish_health_segments(&closed, &open, now)
}

fn color_for_app(app: &str) -> String {
    let mut h: u32 = 2166136261;
    for b in app.as_bytes() {
        h ^= u32::from(*b);
        h = h.wrapping_mul(16777619);
    }
    APP_COLORS[(h as usize) % APP_COLORS.len()].to_string()
}

/// 片段状态优先级：running > stale > stopped
fn segment_rank(s: &HealthSegment) -> u8 {
    if s.status == "running" {
        2
    } else if s.stale || s.status == "stale" {
        1
    } else {
        0
    }
}

fn is_shutdown_end_reason(reason: Option<&str>) -> bool {
    matches!(
        reason,
        Some("shutdown") | Some("logoff") | Some("shutdown_inferred")
    )
}

fn push_recorder_seg(
    out: &mut Vec<TimelineSegment>,
    start: u64,
    end: Option<u64>,
    rank: u8,
    end_reason: Option<String>,
) {
    if let Some(e) = end {
        if e <= start {
            return;
        }
    }
    let shutdown = is_shutdown_end_reason(end_reason.as_deref());
    let (status, stale) = if shutdown {
        ("stopped", false)
    } else {
        match rank {
            2 => ("running", false),
            1 => ("stale", true),
            _ => ("stopped", false),
        }
    };
    out.push(TimelineSegment {
        start_ts: start,
        end_ts: end,
        focused: true,
        status: status.into(),
        stale,
        end_reason,
    });
}

fn best_end_reason(segments: &[HealthSegment], start: u64, end: u64) -> Option<String> {
    let overlapping: Vec<&HealthSegment> = segments
        .iter()
        .filter(|s| {
            let e = s.end_ts.unwrap_or(end);
            e >= start && s.start_ts <= end
        })
        .collect();
    overlapping
        .iter()
        .find_map(|s| {
            s.end_reason
                .as_deref()
                .filter(|r| is_shutdown_end_reason(Some(r)))
                .map(|r| r.to_string())
        })
        .or_else(|| {
            overlapping
                .iter()
                .find(|s| s.status == "stopped" && !s.stale)
                .and_then(|s| s.end_reason.clone())
        })
}

fn active_recorder_rank(n_run: i32, n_stale: i32, n_stop: i32) -> Option<u8> {
    if n_run + n_stale + n_stop <= 0 {
        None
    } else if n_run > 0 {
        Some(2)
    } else if n_stale > 0 {
        Some(1)
    } else {
        Some(0)
    }
}

/// 四模组健康片段 → 单条「采集器」轴。
/// 按时间重叠取最高状态，避免「历史上有过中断」把当前运行误标成 stale。
fn merge_recorder_lane(segments: &[HealthSegment], now: u64) -> TimelineLane {
    let mut points: Vec<(u64, i32, i32, i32)> = Vec::new();
    for s in segments {
        let end = s.end_ts.unwrap_or(now);
        if end <= s.start_ts {
            continue;
        }
        let (dr, ds, dd) = match segment_rank(s) {
            2 => (1, 0, 0),
            1 => (0, 1, 0),
            _ => (0, 0, 1),
        };
        points.push((s.start_ts, dr, ds, dd));
        points.push((end, -dr, -ds, -dd));
    }
    points.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| (a.1 + a.2 + a.3).cmp(&(b.1 + b.2 + b.3)))
    });

    let mut n_run = 0i32;
    let mut n_stale = 0i32;
    let mut n_stop = 0i32;
    let mut cur_start: Option<u64> = None;
    let mut cur_rank: u8 = 0;
    let mut merged: Vec<TimelineSegment> = Vec::new();

    for (ts, dr, ds, dd) in points {
        let prev_rank = active_recorder_rank(n_run, n_stale, n_stop);
        n_run += dr;
        n_stale += ds;
        n_stop += dd;
        let next_rank = active_recorder_rank(n_run, n_stale, n_stop);
        if prev_rank == next_rank {
            continue;
        }
        if let (Some(start), Some(pr)) = (cur_start, prev_rank) {
            let reason = best_end_reason(segments, start, ts);
            if let Some(nr) = next_rank {
                if ts > start {
                    push_recorder_seg(&mut merged, start, Some(ts), pr, reason);
                }
                cur_start = Some(ts);
                cur_rank = nr;
            } else {
                push_recorder_seg(&mut merged, start, Some(ts), pr, reason);
                cur_start = None;
            }
        } else if let Some(nr) = next_rank {
            cur_start = Some(ts);
            cur_rank = nr;
        }
    }

    let currently_running = segments.iter().any(|s| s.status == "running");
    if let Some(start) = cur_start {
        if currently_running && cur_rank == 2 {
            push_recorder_seg(&mut merged, start, None, 2, None);
        } else {
            let end = segments
                .iter()
                .filter_map(|s| s.end_ts)
                .max()
                .unwrap_or(start);
            let reason = best_end_reason(segments, start, end.max(start));
            push_recorder_seg(
                &mut merged,
                start,
                Some(end.max(start)),
                cur_rank,
                reason,
            );
        }
    }

    TimelineLane {
        id: "recorder".into(),
        label: "采集器".into(),
        kind: "recorder".into(),
        color: "#1f6f5b".into(),
        segments: merged,
    }
}

/// 采集真正还在跑 → now；否则收到最后一次健康活动，禁止焦点条继续「长」到现在。
fn recording_horizon(segments: &[HealthSegment], now: u64) -> (bool, u64) {
    if segments.iter().any(|s| s.status == "running") {
        return (true, now);
    }
    let mut h = 0u64;
    for s in segments {
        h = h.max(s.end_ts.unwrap_or(s.start_ts));
    }
    (false, h)
}

fn dates_covering_window(window_start: u64, now: u64) -> Vec<NaiveDate> {
    let start = Local
        .timestamp_millis_opt(window_start as i64)
        .single()
        .map(|d| d.date_naive())
        .unwrap_or_else(|| Local::now().date_naive());
    let end = Local
        .timestamp_millis_opt(now as i64)
        .single()
        .map(|d| d.date_naive())
        .unwrap_or(start);
    let mut dates = Vec::new();
    let mut day = start;
    // 安全上限：避免一次扫过多日文件拖死刷新
    while day <= end && dates.len() < 800 {
        dates.push(day);
        day += ChronoDuration::days(1);
    }
    dates
}

#[derive(Clone)]
struct FocusFileRamEntry {
    mtime: SystemTime,
    parsed_len: u64,
    events: Vec<(u64, String)>,
}

static FOCUS_FILE_RAM: LazyLock<Mutex<HashMap<PathBuf, FocusFileRamEntry>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

fn parse_focus_bytes(data: &[u8], events: &mut Vec<(u64, String)>) -> usize {
    let mut consumed = 0usize;
    let mut start = 0usize;
    while let Some(rel) = data[start..].iter().position(|&b| b == b'\n') {
        let end = start + rel + 1;
        consumed = end;
        let text = std::str::from_utf8(&data[start..end])
            .unwrap_or("")
            .trim();
        start = end;
        if text.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_str::<Value>(text) else {
            continue;
        };
        if v.get("kind").and_then(|k| k.as_str()) != Some("focus_change") {
            continue;
        }
        let ts = v.get("ts").and_then(|t| t.as_u64()).unwrap_or(0);
        let app = v
            .pointer("/payload/app")
            .and_then(|x| x.as_str())
            .unwrap_or("");
        let title = v
            .pointer("/payload/title")
            .and_then(|x| x.as_str())
            .unwrap_or("");
        events.push((ts, normalize_focus_app(app, title)));
    }
    consumed
}

fn load_focus_file_cached(path: &Path) -> Vec<(u64, String)> {
    let Ok(meta) = fs::metadata(path) else {
        return Vec::new();
    };
    let mtime = meta.modified().unwrap_or(UNIX_EPOCH);
    let len = meta.len();

    if let Ok(mut guard) = FOCUS_FILE_RAM.lock() {
        if let Some(entry) = guard.get(path) {
            if len >= entry.parsed_len {
                if len == entry.parsed_len && entry.mtime == mtime {
                    return entry.events.clone();
                }
                let mut events = entry.events.clone();
                let off = entry.parsed_len;
                let buf = read_path_from(path, off);
                let n = parse_focus_bytes(&buf, &mut events);
                let parsed_len = off + n as u64;
                guard.insert(
                    path.to_path_buf(),
                    FocusFileRamEntry {
                        mtime,
                        parsed_len,
                        events: events.clone(),
                    },
                );
                return events;
            }
        }
    }

    let buf = read_path_from(path, 0);
    let mut events = Vec::new();
    let parsed_len = parse_focus_bytes(&buf, &mut events) as u64;
    if let Ok(mut guard) = FOCUS_FILE_RAM.lock() {
        guard.insert(
            path.to_path_buf(),
            FocusFileRamEntry {
                mtime,
                parsed_len,
                events: events.clone(),
            },
        );
    }

    events
}

fn load_focus_events_in_window(root: &Path, window_start: u64, now: u64) -> Vec<(u64, String)> {
    let mut events: Vec<(u64, String)> = Vec::new();
    for date in dates_covering_window(window_start, now) {
        let path = focus_events_path(root, date);
        for (ts, key) in load_focus_file_cached(&path) {
            if ts >= window_start && ts <= now {
                events.push((ts, key));
            }
        }
    }
    events.sort_by_key(|(ts, _)| *ts);
    events
}

/// 采集器实际上线区间（各模组健康片段并集），用于裁掉停录空隙里的「假在线」。
fn recorder_up_intervals(segments: &[HealthSegment], now: u64) -> Vec<(u64, u64)> {
    let mut raw: Vec<(u64, u64)> = segments
        .iter()
        .map(|s| (s.start_ts, s.end_ts.unwrap_or(now)))
        .filter(|(a, b)| b > a)
        .collect();
    if raw.is_empty() {
        return Vec::new();
    }
    raw.sort_by_key(|x| x.0);
    let mut merged = Vec::new();
    let (mut cur_s, mut cur_e) = raw[0];
    for &(s, e) in raw.iter().skip(1) {
        if s <= cur_e.saturating_add(1) {
            cur_e = cur_e.max(e);
        } else {
            merged.push((cur_s, cur_e));
            cur_s = s;
            cur_e = e;
        }
    }
    merged.push((cur_s, cur_e));
    merged
}

fn clip_span_to_ups(start: u64, end: u64, ups: &[(u64, u64)]) -> Vec<(u64, u64)> {
    let mut out = Vec::new();
    if end <= start {
        return out;
    }
    for &(u0, u1) in ups {
        let s = start.max(u0);
        let e = end.min(u1);
        if e > s {
            out.push((s, e));
        }
    }
    out
}

fn ts_in_ups(ts: u64, ups: &[(u64, u64)]) -> bool {
    ups.iter().any(|&(a, b)| ts >= a && ts < b)
}

/// 各软件轴：焦点段实色；淡化段只铺在「采集器在线」区间内，绝不跨停录空隙补全。
fn build_app_lanes(
    events: &[(u64, String)],
    window_start: u64,
    horizon: u64,
    recorder_live: bool,
    ups: &[(u64, u64)],
) -> Vec<TimelineLane> {
    if events.is_empty() || horizon == 0 || ups.is_empty() {
        return Vec::new();
    }

    // 仅保留采集在线期间的焦点事件
    let events: Vec<(u64, String)> = events
        .iter()
        .filter(|(ts, _)| *ts <= horizon && *ts >= window_start && ts_in_ups(*ts, ups))
        .cloned()
        .collect();
    if events.is_empty() {
        return Vec::new();
    }

    let mut focus_iv: BTreeMap<String, Vec<(u64, u64)>> = BTreeMap::new();
    let mut first_seen: BTreeMap<String, u64> = BTreeMap::new();
    for i in 0..events.len() {
        let (ts, ref app) = events[i];
        first_seen.entry(app.clone()).or_insert(ts);
        let end = events
            .get(i + 1)
            .map(|(t, _)| *t)
            .unwrap_or(horizon)
            .min(horizon);
        let mut dur_end = end;
        if dur_end.saturating_sub(ts) > FOCUS_SEGMENT_CAP_MS {
            dur_end = ts + FOCUS_SEGMENT_CAP_MS;
        }
        // 焦点段也裁进在线区间（防止跨空隙）
        for (s, e) in clip_span_to_ups(ts, dur_end, ups) {
            focus_iv.entry(app.clone()).or_default().push((s, e));
        }
    }

    let mut apps: Vec<String> = first_seen.keys().cloned().collect();
    apps.sort_by(|a, b| {
        let idle = |s: &str| s == "桌面 / 空闲";
        idle(a)
            .cmp(&idle(b))
            .then_with(|| {
                let ta: u64 = focus_iv
                    .get(a)
                    .map(|v| v.iter().map(|(s, e)| e.saturating_sub(*s)).sum())
                    .unwrap_or(0);
                let tb: u64 = focus_iv
                    .get(b)
                    .map(|v| v.iter().map(|(s, e)| e.saturating_sub(*s)).sum())
                    .unwrap_or(0);
                tb.cmp(&ta)
            })
            .then(a.cmp(b))
    });

    let mut lanes = Vec::new();
    for app in apps {
        let color = color_for_app(&app);
        let first = first_seen.get(&app).copied().unwrap_or(window_start);
        let spans = focus_iv.get(&app).cloned().unwrap_or_default();
        let mut segments: Vec<TimelineSegment> = Vec::new();

        // 淡化：每个在线区间内，从首次出现起铺到该段结束（不跨空隙）
        for (u0, u1) in ups {
            let fade_from = first.max(window_start).max(*u0);
            let fade_to = (*u1).min(horizon);
            if fade_to > fade_from {
                segments.push(TimelineSegment {
                    start_ts: fade_from,
                    end_ts: Some(fade_to),
                    focused: false,
                    status: "idle".into(),
                    stale: false,
                    end_reason: None,
                });
            }
        }
        for (s, e) in spans {
            if e > s {
                segments.push(TimelineSegment {
                    start_ts: s,
                    end_ts: Some(e),
                    focused: true,
                    status: "focus".into(),
                    stale: false,
                    end_reason: None,
                });
            }
        }
        if recorder_live {
            if let Some((ts, cur)) = events.last() {
                if cur == &app && horizon.saturating_sub(*ts) < FOCUS_SEGMENT_CAP_MS {
                    if let Some(last) = segments.iter_mut().rev().find(|x| x.focused) {
                        last.end_ts = None;
                    }
                }
            }
        }

        lanes.push(TimelineLane {
            id: format!("app:{app}"),
            label: app,
            kind: "app".into(),
            color,
            segments,
        });
    }
    lanes
}

#[tauri::command]
pub async fn dashboard_health(quick: Option<bool>) -> HealthReport {
    let quick = quick.unwrap_or(false);
    tauri::async_runtime::spawn_blocking(move || dashboard_health_blocking(quick))
        .await
        .expect("dashboard_health worker panicked")
}

/// 上次完整健康报告（RAM 或盘上快照）。同步、不扫 jsonl。
#[tauri::command]
pub fn dashboard_health_snapshot() -> Option<HealthReport> {
    if let Ok(guard) = HEALTH_REPORT_CACHE.lock() {
        if let Some(hit) = guard.as_ref() {
            return Some(hit.report.clone());
        }
    }
    load_health_report_snapshot()
}

fn dashboard_health_blocking(quick: bool) -> HealthReport {
    let now = now_ms();
    if !quick {
        if let Ok(guard) = HEALTH_REPORT_CACHE.lock() {
            if let Some(hit) = guard.as_ref() {
                if hit.at.elapsed() < HEALTH_REPORT_TTL {
                    let mut report = hit.report.clone();
                    report.now_ts = now;
                    return report;
                }
            }
        }
    }
    // 细粒度焦点仍只拉近 14 天；采集器绿条用完整健康扫描（缓存），不因 tail 丢老会话
    let window_start = now.saturating_sub(14 * 24 * 60 * 60 * 1000);
    let root = data_root();
    let span_ready = health_span_ready();
    let segments = if quick && !span_ready {
        health_segments_tail(now)
    } else {
        health_segments_now(now)
    };
    let recorder = merge_recorder_lane(&segments, now);
    let ups = recorder_up_intervals(&segments, now);
    // quick：只出采集器轴，跳过 14 天焦点 jsonl（冷启动可达数秒）
    let focus_ev = if quick {
        Vec::new()
    } else {
        load_focus_events_in_window(&root, window_start, now)
    };
    let (recorder_live, mut horizon) = recording_horizon(&segments, now);
    if !recorder_live && horizon == 0 {
        horizon = ups.last().map(|(_, e)| *e).unwrap_or(0);
    }
    let mut lanes = vec![recorder];
    if !quick {
        lanes.extend(build_app_lanes(
            &focus_ev,
            window_start,
            horizon,
            recorder_live,
            &ups,
        ));
    }

    let report = HealthReport {
        now_ts: now,
        window_start_ts: window_start,
        lanes,
        segments: Vec::new(),
        modules: MODULES.iter().map(|s| (*s).to_string()).collect(),
    };
    if !quick {
        persist_health_span_cache();
        save_health_report_snapshot(&report);
        if let Ok(mut guard) = HEALTH_REPORT_CACHE.lock() {
            *guard = Some(HealthReportCacheEntry {
                at: Instant::now(),
                report: report.clone(),
            });
        }
    }
    report
}

/// 播放器时间轴：采集器运行时段 = start / 心跳缺口 / tombstone（完整健康日志，带缓存）
#[tauri::command]
pub fn recorder_run_spans() -> Vec<TimelineSegment> {
    let now = now_ms();
    let segments = health_segments_now(now);
    merge_recorder_lane(&segments, now).segments
}

#[derive(Serialize, Clone)]
pub struct InputHistBucket {
    pub start_ts: u64,
    pub mouse: u64,
    pub key: u64,
}

#[derive(Serialize)]
pub struct InputHistReport {
    pub bucket_ms: u64,
    pub start_ts: u64,
    pub end_ts: u64,
    pub buckets: Vec<InputHistBucket>,
    pub mouse_total: u64,
    pub key_total: u64,
    pub grain: String,
}

fn event_data_path(root: &Path, date: NaiveDate) -> PathBuf {
    let century = (date.year() / 100) + 1;
    root.join("EventData")
        .join(format!("Century_{:08}", century))
        .join(format!("Year_{:04}", date.year()))
        .join(format!("Month_{:02}", date.month()))
        .join(format!("trace_{:02}.bin", date.day()))
}

fn grain_label(bucket_ms: u64) -> String {
    if bucket_ms < 60_000 {
        format!("{}秒", (bucket_ms / 1000).max(1))
    } else if bucket_ms < 3600_000 {
        format!("{}分钟", (bucket_ms / 60_000).max(1))
    } else if bucket_ms < 86_400_000 {
        format!("{}小时", (bucket_ms / 3600_000).max(1))
    } else if bucket_ms < 7 * 86_400_000 {
        format!("{}天", (bucket_ms / 86_400_000).max(1))
    } else if bucket_ms < 30 * 86_400_000 {
        format!("{}周", (bucket_ms / (7 * 86_400_000)).max(1))
    } else {
        format!("{}月", (bucket_ms / (30 * 86_400_000)).max(1))
    }
}

fn input_hist_cache_dir(root: &Path) -> PathBuf {
    root.join("cache").join("input_hist")
}

pub(crate) fn input_hist_cache_path(root: &Path, day: NaiveDate) -> PathBuf {
    input_hist_cache_dir(root).join(format!(
        "{:04}-{:02}-{:02}.otih",
        day.year(),
        day.month(),
        day.day()
    ))
}

fn key_freq_cache_dir(root: &Path) -> PathBuf {
    root.join("cache").join("key_freq")
}

fn key_freq_cache_path(root: &Path, day: NaiveDate) -> PathBuf {
    key_freq_cache_dir(root).join(format!(
        "{:04}-{:02}-{:02}.otkf",
        day.year(),
        day.month(),
        day.day()
    ))
}

/// Windows VK 可读名（与采集侧 `key_to_u16` 对齐；999 为未知；其余未列 VK 显示 VK 数字）。
fn vk_name(code: i16) -> String {
    match code {
        8 => "Backspace".into(),
        9 => "Tab".into(),
        13 => "Enter".into(),
        16 => "Shift".into(),
        17 => "Ctrl".into(),
        18 => "Alt".into(),
        19 => "Pause".into(),
        20 => "CapsLock".into(),
        27 => "Esc".into(),
        32 => "Space".into(),
        33 => "PageUp".into(),
        34 => "PageDown".into(),
        35 => "End".into(),
        36 => "Home".into(),
        37 => "←".into(),
        38 => "↑".into(),
        39 => "→".into(),
        40 => "↓".into(),
        44 => "PrintScreen".into(),
        45 => "Insert".into(),
        46 => "Delete".into(),
        48..=57 => format!("{}", code - 48),
        65..=90 => format!("{}", code as u8 as char),
        91 => "Win".into(),
        92 => "RWin".into(),
        93 => "Apps".into(),
        95 => "Sleep".into(),
        96..=105 => format!("Num{}", code - 96),
        106 => "Num*".into(),
        107 => "Num+".into(),
        109 => "Num-".into(),
        110 => "Num.".into(),
        111 => "Num/".into(),
        112..=135 => format!("F{}", code - 111),
        144 => "NumLock".into(),
        145 => "ScrollLock".into(),
        160 => "LShift".into(),
        161 => "RShift".into(),
        162 => "LCtrl".into(),
        163 => "RCtrl".into(),
        164 => "LAlt".into(),
        165 => "RAlt".into(),
        166 => "BrowserBack".into(),
        167 => "BrowserFwd".into(),
        168 => "BrowserRefresh".into(),
        169 => "BrowserStop".into(),
        170 => "BrowserSearch".into(),
        171 => "BrowserFav".into(),
        172 => "BrowserHome".into(),
        173 => "VolumeMute".into(),
        174 => "VolumeDown".into(),
        175 => "VolumeUp".into(),
        176 => "NextTrack".into(),
        177 => "PrevTrack".into(),
        178 => "MediaStop".into(),
        179 => "PlayPause".into(),
        180 => "LaunchMail".into(),
        181 => "MediaSelect".into(),
        182 => "LaunchApp1".into(),
        183 => "LaunchApp2".into(),
        186 => ";".into(),
        187 => "=".into(),
        188 => ",".into(),
        189 => "-".into(),
        190 => ".".into(),
        191 => "/".into(),
        192 => "`".into(),
        219 => "[".into(),
        220 => "\\".into(),
        221 => "]".into(),
        222 => "'".into(),
        226 => "Intl\\".into(),
        999 => "未知".into(),
        _ => format!("VK{}", code),
    }
}

fn load_day_key_presses(path: &Path) -> Option<(u64, HashMap<i16, u32>)> {
    let data = fs::read(path).ok()?;
    const HDR: usize = 4 + 4 + 8 + 4;
    if data.len() < HDR || &data[0..4] != KEY_FREQ_MAGIC {
        return None;
    }
    if read_u32_le(&data, 4)? != KEY_FREQ_VER {
        return None;
    }
    let processed = read_u64_le(&data, 8)?;
    let n = read_u32_le(&data, 16)? as usize;
    let mut out = HashMap::new();
    let mut o = HDR;
    for _ in 0..n {
        if o + 6 > data.len() {
            return None;
        }
        let code = i16::from_le_bytes([data[o], data[o + 1]]);
        let count = read_u32_le(&data, o + 2)?;
        out.insert(code, count);
        o += 6;
    }
    Some((processed, out))
}

fn save_day_key_presses(path: &Path, processed: u64, presses: &HashMap<i16, u32>) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut out = Vec::new();
    out.extend_from_slice(KEY_FREQ_MAGIC);
    out.extend_from_slice(&KEY_FREQ_VER.to_le_bytes());
    out.extend_from_slice(&processed.to_le_bytes());
    out.extend_from_slice(&(presses.len() as u32).to_le_bytes());
    for (code, count) in presses {
        out.extend_from_slice(&code.to_le_bytes());
        out.extend_from_slice(&count.to_le_bytes());
    }
    let tmp = path.with_extension("otkf.tmp");
    {
        let mut f = File::create(&tmp)?;
        f.write_all(&out)?;
        f.flush()?;
    }
    fs::rename(&tmp, path).or_else(|_| {
        let _ = fs::remove_file(path);
        fs::rename(&tmp, path)
    })
}

fn day_local_start_ms(day: NaiveDate) -> u64 {
    let Some(naive) = day.and_hms_opt(0, 0, 0) else {
        return 0;
    };
    match Local.from_local_datetime(&naive) {
        chrono::LocalResult::Single(dt) | chrono::LocalResult::Ambiguous(dt, _) => {
            dt.timestamp_millis() as u64
        }
        chrono::LocalResult::None => 0,
    }
}

struct DayHistRamEntry {
    source_len: u64,
    hist: DayInputHist,
    /// 与 hist.processed 对齐的按下键频（仅 0xFC）
    key_presses: HashMap<i16, u32>,
}

struct DayInputHist {
    day_start_ms: u64,
    /// 源 bin 已完整解析到的字节偏移（遇半截记录不前进）
    processed: u64,
    last_ts: u64,
    mouse: Vec<u32>,
    key: Vec<u32>,
}

impl Clone for DayInputHist {
    fn clone(&self) -> Self {
        Self {
            day_start_ms: self.day_start_ms,
            processed: self.processed,
            last_ts: self.last_ts,
            mouse: self.mouse.clone(),
            key: self.key.clone(),
        }
    }
}

impl DayInputHist {
    fn empty(day_start_ms: u64) -> Self {
        Self {
            day_start_ms,
            processed: 0,
            last_ts: 0,
            // 无数据日不要预分配 86400 槽，否则年视图扫几千天空日会把进程拖死
            mouse: Vec::new(),
            key: Vec::new(),
        }
    }
}

fn read_u32_le(buf: &[u8], off: usize) -> Option<u32> {
    Some(u32::from_le_bytes(buf.get(off..off + 4)?.try_into().ok()?))
}

fn read_u64_le(buf: &[u8], off: usize) -> Option<u64> {
    Some(u64::from_le_bytes(buf.get(off..off + 8)?.try_into().ok()?))
}

fn load_day_input_hist(path: &Path) -> Option<DayInputHist> {
    let data = fs::read(path).ok()?;
    // magic(4)+ver(4)+day_start(8)+processed(8)+last_ts(8)+fine_ms(4)+secs(4)+mouse+key
    const HDR: usize = 4 + 4 + 8 + 8 + 8 + 4 + 4;
    if data.len() < HDR {
        return None;
    }
    if &data[0..4] != INPUT_HIST_MAGIC {
        return None;
    }
    if read_u32_le(&data, 4)? != INPUT_HIST_VER {
        return None;
    }
    let day_start_ms = read_u64_le(&data, 8)?;
    let processed = read_u64_le(&data, 16)?;
    let last_ts = read_u64_le(&data, 24)?;
    let fine_ms = read_u32_le(&data, 32)? as u64;
    let secs = read_u32_le(&data, 36)? as usize;
    if fine_ms != INPUT_HIST_FINE_MS || secs != SECS_PER_DAY {
        return None;
    }
    let body = secs * 4 * 2;
    if data.len() < HDR + body {
        return None;
    }
    let mut mouse = vec![0u32; secs];
    let mut key = vec![0u32; secs];
    let mut o = HDR;
    for v in mouse.iter_mut() {
        *v = read_u32_le(&data, o)?;
        o += 4;
    }
    for v in key.iter_mut() {
        *v = read_u32_le(&data, o)?;
        o += 4;
    }
    Some(DayInputHist {
        day_start_ms,
        processed,
        last_ts,
        mouse,
        key,
    })
}

fn save_day_input_hist(path: &Path, hist: &DayInputHist) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let mut mouse = hist.mouse.clone();
    let mut key = hist.key.clone();
    mouse.resize(SECS_PER_DAY, 0);
    key.resize(SECS_PER_DAY, 0);
    let mut out = Vec::with_capacity(64 + SECS_PER_DAY * 8);
    out.extend_from_slice(INPUT_HIST_MAGIC);
    out.extend_from_slice(&INPUT_HIST_VER.to_le_bytes());
    out.extend_from_slice(&hist.day_start_ms.to_le_bytes());
    out.extend_from_slice(&hist.processed.to_le_bytes());
    out.extend_from_slice(&hist.last_ts.to_le_bytes());
    out.extend_from_slice(&(INPUT_HIST_FINE_MS as u32).to_le_bytes());
    out.extend_from_slice(&(SECS_PER_DAY as u32).to_le_bytes());
    for v in &mouse {
        out.extend_from_slice(&v.to_le_bytes());
    }
    for v in &key {
        out.extend_from_slice(&v.to_le_bytes());
    }
    let tmp = path.with_extension("otih.tmp");
    {
        let mut f = File::create(&tmp)?;
        f.write_all(&out)?;
        f.flush()?;
    }
    fs::rename(&tmp, path).or_else(|_| {
        let _ = fs::remove_file(path);
        fs::rename(&tmp, path)
    })
}

fn bump_sec_hist(hist: &mut DayInputHist, ts: u64, is_key: bool) {
    if hist.mouse.len() < SECS_PER_DAY {
        hist.mouse.resize(SECS_PER_DAY, 0);
        hist.key.resize(SECS_PER_DAY, 0);
    }
    if ts < hist.day_start_ms {
        return;
    }
    let sec = ((ts - hist.day_start_ms) / INPUT_HIST_FINE_MS) as usize;
    if sec >= SECS_PER_DAY {
        return;
    }
    if is_key {
        hist.key[sec] = hist.key[sec].saturating_add(1);
    } else {
        hist.mouse[sec] = hist.mouse[sec].saturating_add(1);
    }
}

/// 解析 bin 字节流；半截记录不消耗。返回 (新偏移, last_ts)。
fn accumulate_trace_bytes(
    data: &[u8],
    mut i: usize,
    mut ts: u64,
    hist: &mut DayInputHist,
    mut key_presses: Option<&mut HashMap<i16, u32>>,
) -> (usize, u64) {
    while i < data.len() {
        let mark = i;
        let marker = data[i];
        i += 1;
        if marker == 0xFF {
            if i + 12 > data.len() {
                return (mark, ts);
            }
            let mut buf = [0u8; 8];
            buf.copy_from_slice(&data[i..i + 8]);
            ts = u64::from_be_bytes(buf);
            i += 12; // ts + x + y
            bump_sec_hist(hist, ts, false);
        } else if marker == 0xFE || marker == 0xFD || marker == 0xFC || marker == 0xFB {
            if i + 3 > data.len() {
                return (mark, ts);
            }
            let dt = data[i] as u64;
            if marker == 0xFC {
                if let Some(ref mut map) = key_presses {
                    let code = i16::from_be_bytes([data[i + 1], data[i + 2]]);
                    map.entry(code).and_modify(|c| *c += 1).or_insert(1);
                }
            }
            ts = ts.saturating_add(dt);
            let is_key = marker == 0xFC || marker == 0xFB;
            i += 3;
            if is_key {
                bump_sec_hist(hist, ts, true);
            }
            // 点击/滚轮不计入鼠标柱
        } else {
            if i + 2 > data.len() {
                return (mark, ts);
            }
            ts = ts.saturating_add(marker as u64);
            i += 2;
            bump_sec_hist(hist, ts, false);
        }
    }
    (i, ts)
}

/// 确保某日 `.otih` 已生成（局域网同步用）；不向外暴露内部 hist 结构。
pub(crate) fn ensure_day_input_hist_file(root: &Path, day: NaiveDate) -> PathBuf {
    let _ = ensure_day_input_hist(root, day);
    input_hist_cache_path(root, day)
}

/// 加载或增量重建某日 1 秒粒度键鼠柱（落盘 `OmniDatabase/cache/input_hist/` + 进程 RAM）。
fn ensure_day_input_hist(root: &Path, day: NaiveDate) -> DayInputHist {
    let day_key = format!("{:04}-{:02}-{:02}", day.year(), day.month(), day.day());
    let bin_path = event_data_path(root, day);
    let source_len = fs::metadata(&bin_path).map(|m| m.len()).unwrap_or(0);

    // 热路径：RAM 命中且源文件长度未变 → 直接用洗好的柱，不读盘不扫 bin
    if let Ok(ram) = INPUT_HIST_RAM.lock() {
        if let Some(ent) = ram.get(&day_key) {
            if ent.source_len == source_len && ent.hist.processed == source_len {
                return ent.hist.clone();
            }
        }
    }

    let _guard = INPUT_HIST_CACHE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    // 双检：拿锁后再看一次 RAM（别的请求可能刚写完）
    if let Ok(ram) = INPUT_HIST_RAM.lock() {
        if let Some(ent) = ram.get(&day_key) {
            if ent.source_len == source_len && ent.hist.processed == source_len {
                return ent.hist.clone();
            }
        }
    }

    let cache_path = input_hist_cache_path(root, day);
    let key_cache_path = key_freq_cache_path(root, day);
    let day_start_ms = day_local_start_ms(day);

    let mut hist = load_day_input_hist(&cache_path)
        .filter(|h| h.day_start_ms == day_start_ms && h.processed <= source_len)
        .unwrap_or_else(|| DayInputHist::empty(day_start_ms));

    let mut key_presses = load_day_key_presses(&key_cache_path)
        .filter(|(p, _)| *p == hist.processed)
        .map(|(_, m)| m)
        .unwrap_or_default();

    if source_len == 0 {
        if hist.processed != 0 {
            hist = DayInputHist::empty(day_start_ms);
            let _ = save_day_input_hist(&cache_path, &hist);
        }
        key_presses.clear();
        let _ = save_day_key_presses(&key_cache_path, 0, &key_presses);
        if let Ok(mut ram) = INPUT_HIST_RAM.lock() {
            ram.insert(
                day_key,
                DayHistRamEntry {
                    source_len: 0,
                    hist: hist.clone(),
                    key_presses,
                },
            );
        }
        return hist;
    }

    if hist.processed > source_len {
        hist = DayInputHist::empty(day_start_ms);
        key_presses.clear();
    }

    if key_presses.is_empty() && hist.processed > 0 && hist.processed == source_len {
        // 旧版 .otih 无配套 .otkf：整文件重扫仅计按下键频
        let mut dummy = DayInputHist::empty(day_start_ms);
        if let Ok(mut f) = File::open(&bin_path) {
            let mut chunk = Vec::new();
            if f.read_to_end(&mut chunk).is_ok() && !chunk.is_empty() {
                accumulate_trace_bytes(
                    &chunk,
                    0,
                    0,
                    &mut dummy,
                    Some(&mut key_presses),
                );
            }
        }
        let _ = save_day_key_presses(&key_cache_path, source_len, &key_presses);
    }

    if hist.processed != source_len {
        let Ok(mut f) = File::open(&bin_path) else {
            return hist;
        };
        if f.seek(SeekFrom::Start(hist.processed)).is_err() {
            hist = DayInputHist::empty(day_start_ms);
            key_presses.clear();
            if f.seek(SeekFrom::Start(0)).is_err() {
                return hist;
            }
        }
        let mut chunk = Vec::new();
        if f.read_to_end(&mut chunk).is_err() || chunk.is_empty() {
            return hist;
        }
        let (consumed, last_ts) = accumulate_trace_bytes(
            &chunk,
            0,
            hist.last_ts,
            &mut hist,
            Some(&mut key_presses),
        );
        hist.processed = hist.processed.saturating_add(consumed as u64);
        hist.last_ts = last_ts;
        let _ = save_day_input_hist(&cache_path, &hist);
        let _ = save_day_key_presses(&key_cache_path, hist.processed, &key_presses);
    }

    if let Ok(mut ram) = INPUT_HIST_RAM.lock() {
        ram.insert(
            day_key,
            DayHistRamEntry {
                source_len,
                hist: hist.clone(),
                key_presses,
            },
        );
    }
    hist
}

fn day_key_presses(root: &Path, day: NaiveDate) -> HashMap<i16, u32> {
    ensure_day_input_hist(root, day);
    let day_key = format!("{:04}-{:02}-{:02}", day.year(), day.month(), day.day());
    if let Ok(ram) = INPUT_HIST_RAM.lock() {
        if let Some(ent) = ram.get(&day_key) {
            return ent.key_presses.clone();
        }
    }
    HashMap::new()
}

/// 近 7 日本地日键盘按下（0xFC）键频 Top N。
fn build_key_frequency(root: &Path) -> Value {
    let today = Local::now().date_naive();
    let mut merged: HashMap<i16, u64> = HashMap::new();
  for offset in (0..7).rev() {
        let date = today - ChronoDuration::days(offset);
        for (code, count) in day_key_presses(root, date) {
            *merged.entry(code).or_insert(0) += count as u64;
        }
    }
    let total_presses = merged.values().sum::<u64>();
    let mut keys: Vec<Value> = merged
        .into_iter()
        .map(|(code, count)| {
            json!({
                "code": code,
                "name": vk_name(code),
                "count": count,
            })
        })
        .collect();
    keys.sort_by(|a, b| {
        b.get("count")
            .and_then(|v| v.as_u64())
            .cmp(&a.get("count").and_then(|v| v.as_u64()))
    });
    let top = keys.iter().take(KEY_FREQ_TOP_N).cloned().collect::<Vec<_>>();
    json!({
        "days": 7,
        "total_presses": total_presses,
        "top": top,
    })
}

fn fold_day_hist_into(
    hist: &DayInputHist,
    range_start: u64,
    range_end: u64,
    bucket_ms: u64,
    base_ts: u64,
    mouse: &mut [u64],
    key: &mut [u64],
) {
    if bucket_ms == 0 || mouse.is_empty() || hist.mouse.is_empty() {
        return;
    }
    let n = mouse.len();
    let avail = hist.mouse.len().min(hist.key.len()).min(SECS_PER_DAY);
    let day_end = hist.day_start_ms.saturating_add(86_400_000);
    let from = range_start.max(hist.day_start_ms);
    let to = range_end.min(day_end.saturating_sub(1));
    if from > to {
        return;
    }
    let sec0 = ((from - hist.day_start_ms) / INPUT_HIST_FINE_MS) as usize;
    let sec1 = ((to - hist.day_start_ms) / INPUT_HIST_FINE_MS) as usize;
    for sec in sec0..=sec1.min(avail.saturating_sub(1)) {
        let ts = hist.day_start_ms + sec as u64 * INPUT_HIST_FINE_MS;
        if ts < range_start || ts > range_end {
            continue;
        }
        let idx = ((ts.saturating_sub(base_ts)) / bucket_ms) as usize;
        if idx >= n {
            continue;
        }
        mouse[idx] = mouse[idx].saturating_add(hist.mouse[sec] as u64);
        key[idx] = key[idx].saturating_add(hist.key[sec] as u64);
    }
}

/// 只枚举区间内真实存在的 trace_DD.bin，避免年视图对几千天空日 metadata+空分配。
fn list_bin_days_in_range(root: &Path, start: NaiveDate, end: NaiveDate) -> Vec<NaiveDate> {
    let mut out = Vec::new();
    if end < start {
        return out;
    }
    let event = root.join("EventData");
    let Ok(centuries) = fs::read_dir(&event) else {
        return out;
    };
    for cent in centuries.flatten() {
        let cent_path = cent.path();
        if !cent_path.is_dir() {
            continue;
        }
        let Ok(years) = fs::read_dir(&cent_path) else {
            continue;
        };
        for year_ent in years.flatten() {
            let year_path = year_ent.path();
            if !year_path.is_dir() {
                continue;
            }
            let year_name = year_ent.file_name().to_string_lossy().into_owned();
            let Some(year_s) = year_name.strip_prefix("Year_") else {
                continue;
            };
            let Ok(year) = year_s.parse::<i32>() else {
                continue;
            };
            let Ok(months) = fs::read_dir(&year_path) else {
                continue;
            };
            for month_ent in months.flatten() {
                let month_path = month_ent.path();
                if !month_path.is_dir() {
                    continue;
                }
                let month_name = month_ent.file_name().to_string_lossy().into_owned();
                let Some(month_s) = month_name.strip_prefix("Month_") else {
                    continue;
                };
                let Ok(month) = month_s.parse::<u32>() else {
                    continue;
                };
                let Ok(files) = fs::read_dir(&month_path) else {
                    continue;
                };
                for file_ent in files.flatten() {
                    let name = file_ent.file_name().to_string_lossy().into_owned();
                    let Some(day_s) = name
                        .strip_prefix("trace_")
                        .and_then(|s| s.strip_suffix(".bin"))
                    else {
                        continue;
                    };
                    let Ok(day) = day_s.parse::<u32>() else {
                        continue;
                    };
                    if !file_ent.path().is_file() {
                        continue;
                    }
                    let Some(date) = NaiveDate::from_ymd_opt(year, month, day) else {
                        continue;
                    };
                    if date >= start && date <= end {
                        out.push(date);
                    }
                }
            }
        }
    }
    out.sort_unstable();
    out.dedup();
    out
}

#[tauri::command]
pub async fn dashboard_input_histogram(
    start_ts: u64,
    end_ts: u64,
    bucket_ms: u64,
) -> InputHistReport {
    tauri::async_runtime::spawn_blocking(move || {
        dashboard_input_histogram_blocking(start_ts, end_ts, bucket_ms)
    })
    .await
    .expect("dashboard_input_histogram worker panicked")
}

fn dashboard_input_histogram_blocking(
    start_ts: u64,
    end_ts: u64,
    bucket_ms: u64,
) -> InputHistReport {
    let mut bucket_ms = bucket_ms.max(1);
    let end_ts = end_ts.max(start_ts + 1);
    // 限制桶数，防止过细缩放把内存/JSON 打爆
    const MAX_BUCKETS: u64 = 900;
    loop {
        let n = (end_ts.saturating_sub(start_ts) / bucket_ms) + 1;
        if n <= MAX_BUCKETS {
            break;
        }
        bucket_ms = (bucket_ms.saturating_mul(2)).max(bucket_ms + 1);
    }
    let base_ts = (start_ts / bucket_ms) * bucket_ms;
    let n = ((end_ts.saturating_sub(base_ts) / bucket_ms) + 1) as usize;
    let mut mouse = vec![0u64; n];
    let mut key = vec![0u64; n];

    let root = data_root();
    let start_date = Local
        .timestamp_millis_opt(base_ts as i64)
        .single()
        .map(|d| d.date_naive())
        .unwrap_or_else(|| Local::now().date_naive());
    let end_date = Local
        .timestamp_millis_opt(end_ts as i64)
        .single()
        .map(|d| d.date_naive())
        .unwrap_or(start_date);

    for day in list_bin_days_in_range(&root, start_date, end_date) {
        let hist = ensure_day_input_hist(&root, day);
        fold_day_hist_into(
            &hist,
            base_ts,
            end_ts,
            bucket_ms,
            base_ts,
            &mut mouse,
            &mut key,
        );
    }

    let mut buckets = Vec::with_capacity(n);
    let mut mouse_total = 0u64;
    let mut key_total = 0u64;
    for i in 0..n {
        let m = mouse[i];
        let k = key[i];
        mouse_total += m;
        key_total += k;
        buckets.push(InputHistBucket {
            start_ts: base_ts + i as u64 * bucket_ms,
            mouse: m,
            key: k,
        });
    }

    InputHistReport {
        bucket_ms,
        start_ts: base_ts,
        end_ts,
        buckets,
        mouse_total,
        key_total,
        grain: grain_label(bucket_ms),
    }
}

#[derive(Serialize)]
pub struct InputDaySeries {
    pub date: String,
    pub day_start_ms: u64,
    pub secs: u32,
    /// little-endian u32 × secs（1 秒粒度鼠标计数）
    pub mouse_b64: String,
    pub key_b64: String,
    pub mouse_peak: u32,
    pub key_peak: u32,
}

fn pack_u32_le_b64(xs: &[u32]) -> String {
    let mut bytes = Vec::with_capacity(xs.len() * 4);
    for v in xs {
        bytes.extend_from_slice(&v.to_le_bytes());
    }
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// 单日 1 秒矢量序列（永久 .otih 缓存）；前端按日瓦片常驻，平移不再重洗。
#[tauri::command]
pub async fn dashboard_input_day_series(date: String) -> Result<InputDaySeries, String> {
    tauri::async_runtime::spawn_blocking(move || dashboard_input_day_series_blocking(date))
        .await
        .map_err(|e| format!("dashboard_input_day_series: {e}"))?
}

fn dashboard_input_day_series_blocking(date: String) -> Result<InputDaySeries, String> {
    let day = NaiveDate::parse_from_str(date.trim(), "%Y-%m-%d")
        .map_err(|e| format!("日期无效 {date}: {e}"))?;
    let root = data_root();
    let hist = ensure_day_input_hist(&root, day);
    let mut mouse = hist.mouse.clone();
    let mut key = hist.key.clone();
    mouse.resize(SECS_PER_DAY, 0);
    key.resize(SECS_PER_DAY, 0);
    let mouse_peak = mouse.iter().copied().max().unwrap_or(0);
    let key_peak = key.iter().copied().max().unwrap_or(0);
    Ok(InputDaySeries {
        date: format!("{:04}-{:02}-{:02}", day.year(), day.month(), day.day()),
        day_start_ms: hist.day_start_ms,
        secs: SECS_PER_DAY as u32,
        mouse_b64: pack_u32_le_b64(&mouse),
        key_b64: pack_u32_le_b64(&key),
        mouse_peak,
        key_peak,
    })
}

/// 性能实验报告落盘（供 Cursor 读日志，不经拍视频）
#[tauri::command]
pub fn perf_bench_write_report(json: String) -> Result<String, String> {
    let root = data_root();
    let dir = root.join("cache");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let path = dir.join("perf_bench_last.json");
    fs::write(&path, json.as_bytes()).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

fn file_meta(path: &Path) -> Value {
    match fs::metadata(path) {
        Ok(m) => json!({
            "exists": true,
            "bytes": m.len(),
            "path": path.to_string_lossy(),
        }),
        Err(_) => json!({ "exists": false, "bytes": 0, "path": path.to_string_lossy() }),
    }
}

/// 非空且能解析的 JSONL 行（一条 ModuleEvent / 健康信封）。空行不计。
fn count_jsonl_events(path: &Path) -> u64 {
    let Ok(f) = fs::File::open(path) else {
        return 0;
    };
    let mut n = 0u64;
    for line in BufReader::new(f).lines().flatten() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if serde_json::from_str::<Value>(t).is_ok() {
            n += 1;
        }
    }
    n
}

fn jsonl_ts(text: &str) -> Option<u64> {
    serde_json::from_str::<Value>(text)
        .ok()
        .and_then(|v| v.get("ts").and_then(|t| t.as_u64()))
}

fn apply_health_count_bytes(
    data: &[u8],
    day_start: u64,
    day_end: u64,
    total: &mut u64,
    today: &mut u64,
) -> usize {
    let mut consumed = 0usize;
    let mut start = 0usize;
    while let Some(rel) = data[start..].iter().position(|&b| b == b'\n') {
        let end = start + rel + 1;
        consumed = end;
        let text = std::str::from_utf8(&data[start..end])
            .unwrap_or("")
            .trim();
        start = end;
        if text.is_empty() {
            continue;
        }
        let Some(ts) = jsonl_ts(text) else {
            continue;
        };
        *total = total.saturating_add(1);
        if ts >= day_start && ts < day_end {
            *today = today.saturating_add(1);
        }
    }
    consumed
}

/// 从文件尾往回数「ts 落在 [day_start, day_end)」的健康行；碰到更早的 ts 或文件头即停。
fn count_health_today_tail(path: &Path, day_start: u64, day_end: u64) -> u64 {
    let Ok(meta) = fs::metadata(path) else {
        return 0;
    };
    let len = meta.len();
    if len == 0 {
        return 0;
    }
    let mut window = 2 * 1024 * 1024u64;
    loop {
        let start = len.saturating_sub(window);
        let buf = read_path_from(path, start);
        let body: &[u8] = if start > 0 {
            match buf.iter().position(|&b| b == b'\n') {
                Some(i) => &buf[i + 1..],
                None => {
                    if start == 0 {
                        buf.as_slice()
                    } else if window >= len {
                        buf.as_slice()
                    } else {
                        window = window.saturating_mul(2).min(len);
                        continue;
                    }
                }
            }
        } else {
            buf.as_slice()
        };
        let mut count = 0u64;
        let mut oldest: Option<u64> = None;
        for line in body.split(|&b| b == b'\n') {
            let text = std::str::from_utf8(line).unwrap_or("").trim();
            if text.is_empty() {
                continue;
            }
            let Some(ts) = jsonl_ts(text) else {
                continue;
            };
            oldest = Some(oldest.map(|o| o.min(ts)).unwrap_or(ts));
            if ts >= day_start && ts < day_end {
                count = count.saturating_add(1);
            }
        }
        if start == 0 || oldest.map(|o| o < day_start).unwrap_or(true) {
            return count;
        }
        if window >= len {
            return count;
        }
        window = window.saturating_mul(2).min(len);
    }
}

struct HealthCountState {
    parsed_len: u64,
    total: u64,
    today_date: NaiveDate,
    today: u64,
}

static HEALTH_COUNT_CACHE: LazyLock<Mutex<Option<HealthCountState>>> =
    LazyLock::new(|| Mutex::new(None));

/// 健康日志：累计行数 + 本地日历日行数（按信封 ts，禁止把历史 beat 算进今日）。
fn health_event_counts(today: NaiveDate, day_start: u64, day_end: u64) -> (u64, u64) {
    let path = health_path();
    let file_len = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let mut guard = HEALTH_COUNT_CACHE
        .lock()
        .unwrap_or_else(|e| e.into_inner());

    let need_full = match guard.as_ref() {
        None => true,
        Some(s) => file_len < s.parsed_len,
    };
    if need_full {
        let buf = read_path_from(&path, 0);
        let mut total = 0u64;
        let mut today_n = 0u64;
        let consumed = apply_health_count_bytes(&buf, day_start, day_end, &mut total, &mut today_n);
        *guard = Some(HealthCountState {
            parsed_len: consumed as u64,
            total,
            today_date: today,
            today: today_n,
        });
        return (today_n, total);
    }

    let date_changed = guard.as_ref().map(|s| s.today_date != today).unwrap_or(false);
    if date_changed {
        if let Some(state) = guard.as_mut() {
            state.today_date = today;
            state.today = count_health_today_tail(&path, day_start, day_end);
        }
    }

    let parsed_len = guard.as_ref().map(|s| s.parsed_len).unwrap_or(0);
    if file_len > parsed_len {
        let buf = read_path_from(&path, parsed_len);
        if let Some(state) = guard.as_mut() {
            let mut add_total = 0u64;
            let mut add_today = 0u64;
            let n = apply_health_count_bytes(
                &buf,
                day_start,
                day_end,
                &mut add_total,
                &mut add_today,
            );
            state.parsed_len = parsed_len + n as u64;
            state.total = state.total.saturating_add(add_total);
            if !date_changed {
                state.today = state.today.saturating_add(add_today);
            }
        }
    }

    guard
        .as_ref()
        .map(|s| (s.today, s.total))
        .unwrap_or((0, 0))
}

fn dir_bytes(dir: &Path) -> u64 {
    fn rec(dir: &Path, n: &mut u64) {
        let Ok(rd) = fs::read_dir(dir) else {
            return;
        };
        for ent in rd.flatten() {
            let p = ent.path();
            if p.is_dir() {
                rec(&p, n);
            } else if let Ok(m) = fs::metadata(&p) {
                if m.is_file() {
                    *n = n.saturating_add(m.len());
                }
            }
        }
    }
    let mut n = 0u64;
    rec(dir, &mut n);
    n
}

fn count_all_module_jsonl(root: &Path) -> (u64, u64) {
    fn rec(dir: &Path, lines: &mut u64, bytes: &mut u64) {
        let Ok(rd) = fs::read_dir(dir) else {
            return;
        };
        for ent in rd.flatten() {
            let p = ent.path();
            if p.is_dir() {
                rec(&p, lines, bytes);
                continue;
            }
            let name = ent.file_name().to_string_lossy().into_owned();
            if !(name.starts_with("events_") && name.ends_with(".jsonl")) {
                continue;
            }
            if let Ok(m) = fs::metadata(&p) {
                *bytes = bytes.saturating_add(m.len());
            }
            *lines = lines.saturating_add(count_jsonl_events(&p));
        }
    }
    let mut lines = 0u64;
    let mut bytes = 0u64;
    rec(&root.join("ModuleData"), &mut lines, &mut bytes);
    (lines, bytes)
}

fn sum_u32_slice(xs: &[u32]) -> u64 {
    xs.iter().fold(0u64, |a, &v| a.saturating_add(v as u64))
}

/// 当日键鼠次数：与时间轴同一套 1s 柱（绝对/相对鼠标 + 键按下/抬起；点击/滚轮不计鼠标柱）。
fn day_input_totals(root: &Path, day: NaiveDate) -> (u64, u64) {
    let day_key = format!("{:04}-{:02}-{:02}", day.year(), day.month(), day.day());
    let source_len = fs::metadata(event_data_path(root, day))
        .map(|m| m.len())
        .unwrap_or(0);
    if let Ok(ram) = INPUT_HIST_RAM.lock() {
        if let Some(ent) = ram.get(&day_key) {
            if ent.source_len == source_len && ent.hist.processed == source_len {
                return (sum_u32_slice(&ent.hist.mouse), sum_u32_slice(&ent.hist.key));
            }
        }
    }
    let hist = ensure_day_input_hist(root, day);
    (sum_u32_slice(&hist.mouse), sum_u32_slice(&hist.key))
}

fn all_input_totals(root: &Path, today: NaiveDate) -> (u64, u64) {
    let start = NaiveDate::from_ymd_opt(2000, 1, 1).unwrap_or(today);
    let mut mouse = 0u64;
    let mut key = 0u64;
    for day in list_bin_days_in_range(root, start, today) {
        let (m, k) = day_input_totals(root, day);
        mouse = mouse.saturating_add(m);
        key = key.saturating_add(k);
    }
    (mouse, key)
}

fn build_volume(root: &Path, today: NaiveDate, health_today: u64, health_total: u64) -> Value {
    let event_data_bytes = dir_bytes(&root.join("EventData"));
    let module_data_bytes = dir_bytes(&root.join("ModuleData"));
    let control_bytes = dir_bytes(&root.join("control"));
    let cache_bytes = dir_bytes(&root.join("cache"));
    let notes_bytes = dir_bytes(&root.join("notes"));
    let context_bytes = dir_bytes(&root.join("ContextData"));
    let known = event_data_bytes
        .saturating_add(module_data_bytes)
        .saturating_add(control_bytes)
        .saturating_add(cache_bytes)
        .saturating_add(notes_bytes)
        .saturating_add(context_bytes);
    let total_bytes = dir_bytes(root);
    let other_bytes = total_bytes.saturating_sub(known);
    let (module_events, _jsonl_bytes) = count_all_module_jsonl(root);
    let (input_mouse, input_key) = all_input_totals(root, today);
    let (input_mouse_today, input_key_today) = day_input_totals(root, today);
    json!({
        "total_bytes": total_bytes,
        "event_data_bytes": event_data_bytes,
        "module_data_bytes": module_data_bytes,
        "control_bytes": control_bytes,
        "cache_bytes": cache_bytes,
        "notes_bytes": notes_bytes,
        "context_bytes": context_bytes,
        "other_bytes": other_bytes,
        "module_events": module_events,
        "health_events": health_total,
        "health_events_today": health_today,
        "input_mouse": input_mouse,
        "input_key": input_key,
        "input_mouse_today": input_mouse_today,
        "input_key_today": input_key_today,
        "bin_bytes_total": event_data_bytes,
    })
}

fn focus_events_path(root: &Path, date: NaiveDate) -> PathBuf {
    let century = (date.year() / 100) + 1;
    root.join("ModuleData")
        .join("focus")
        .join(format!("Century_{:08}", century))
        .join(format!("Year_{:04}", date.year()))
        .join(format!("Month_{:02}", date.month()))
        .join(format!("events_{:02}.jsonl", date.day()))
}

fn weekday_cn(date: NaiveDate) -> &'static str {
    match date.weekday().number_from_monday() {
        1 => "周一",
        2 => "周二",
        3 => "周三",
        4 => "周四",
        5 => "周五",
        6 => "周六",
        _ => "周日",
    }
}

fn normalize_focus_app(app: &str, title: &str) -> String {
    let t = title.trim();
    if t.contains("桌面或失去焦点") || t.is_empty() && app.eq_ignore_ascii_case("System") {
        return "桌面 / 空闲".into();
    }
    let a = app.trim();
    if a.is_empty() || a == "?" {
        if t.is_empty() {
            "未知".into()
        } else {
            t.chars().take(48).collect()
        }
    } else {
        // 去掉常见 .exe 后缀，接近手机「应用名」
        a.trim_end_matches(".exe")
            .trim_end_matches(".EXE")
            .to_string()
    }
}

/// 当日 288 个 5 分钟格：格内任意一秒 mouse 或 key 柱 >0 则该格「有键鼠」。
/// 与时间轴同一套 otih（相对/绝对鼠标 + 键按下/抬起；点击/滚轮不进鼠标柱）。
fn active_5min_bins(hist: &DayInputHist) -> Vec<bool> {
    let mut bins = vec![false; ACTIVE_FOCUS_BINS_PER_DAY];
    let secs = hist.mouse.len().min(hist.key.len()).min(SECS_PER_DAY);
    let bin_secs = (ACTIVE_FOCUS_BIN_MS / INPUT_HIST_FINE_MS) as usize;
    if bin_secs == 0 {
        return bins;
    }
    for sec in 0..secs {
        if hist.mouse[sec] > 0 || hist.key[sec] > 0 {
            let b = sec / bin_secs;
            if b < bins.len() {
                bins[b] = true;
            }
        }
    }
    bins
}

fn clip_focus_to_active_bins(start: u64, end: u64, day_start: u64, bins: &[bool]) -> u64 {
    if end <= start || bins.is_empty() || day_start == 0 {
        return 0;
    }
    let day_end = day_start.saturating_add(86_400_000);
    let t0 = start.max(day_start);
    let t1 = end.min(day_end);
    if t1 <= t0 {
        return 0;
    }
    let bin_ms = ACTIVE_FOCUS_BIN_MS;
    let b0 = ((t0 - day_start) / bin_ms) as usize;
    let b1 = ((t1 - 1 - day_start) / bin_ms) as usize;
    let last = bins.len().saturating_sub(1);
    let mut acc = 0u64;
    for b in b0.min(last)..=b1.min(last) {
        if !bins[b] {
            continue;
        }
        let bs = day_start + b as u64 * bin_ms;
        let be = bs + bin_ms;
        let s = t0.max(bs);
        let e = t1.min(be);
        if e > s {
            acc = acc.saturating_add(e - s);
        }
    }
    acc
}

/// 从一日 focus jsonl 累计：按 app 时长 + 当日总时长。
/// `active_bins` 为 Some 时只保留与「有键鼠的 5 分钟格」重叠的焦点时长。
fn accumulate_focus_day(
    path: &Path,
    day_start: u64,
    day_end_ts: u64,
    now_ts: u64,
    app_ms: &mut BTreeMap<String, u64>,
    active_bins: Option<&[bool]>,
) -> u64 {
    let Ok(f) = fs::File::open(path) else {
        return 0;
    };
    let mut events: Vec<(u64, String)> = Vec::new();
    for line in BufReader::new(f).lines().flatten() {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if v.get("kind").and_then(|k| k.as_str()) != Some("focus_change") {
            continue;
        }
        let ts = v.get("ts").and_then(|t| t.as_u64()).unwrap_or(0);
        if ts == 0 {
            continue;
        }
        let app = v
            .pointer("/payload/app")
            .and_then(|x| x.as_str())
            .unwrap_or("");
        let title = v
            .pointer("/payload/title")
            .and_then(|x| x.as_str())
            .unwrap_or("");
        events.push((ts, normalize_focus_app(app, title)));
    }
    events.sort_by_key(|(ts, _)| *ts);

    let mut day_total = 0u64;
    let horizon = now_ts.min(day_end_ts);
    for i in 0..events.len() {
        let (ts, ref key) = events[i];
        if ts >= horizon {
            break;
        }
        let next = events
            .get(i + 1)
            .map(|(t, _)| *t)
            .unwrap_or(horizon)
            .min(horizon);
        let mut dur = next.saturating_sub(ts);
        if dur == 0 {
            continue;
        }
        if dur > FOCUS_SEGMENT_CAP_MS {
            dur = FOCUS_SEGMENT_CAP_MS;
        }
        let credited = match active_bins {
            Some(bins) => clip_focus_to_active_bins(ts, ts.saturating_add(dur), day_start, bins),
            None => dur,
        };
        if credited == 0 {
            continue;
        }
        *app_ms.entry(key.clone()).or_insert(0) += credited;
        day_total += credited;
    }
    day_total
}

/// 近 7 日焦点。`active_only`：只计落在「有键鼠的 5 分钟格」里的片段（见 ACTIVE_FOCUS_BIN_MS）。
fn build_focus_usage(root: &Path, now_ts: u64, active_only: bool) -> Value {
    let today = Local::now().date_naive();
    let mut days = Vec::new();
    let mut app_ms: BTreeMap<String, u64> = BTreeMap::new();
    let mut week_total = 0u64;

    for offset in (0..7).rev() {
        let date = today - ChronoDuration::days(offset);
        let path = focus_events_path(root, date);
        let day_start = day_local_start_ms(date);
        let day_end = day_start.saturating_add(86_400_000).saturating_sub(1);
        let bins = if active_only {
            let hist = ensure_day_input_hist(root, date);
            Some(active_5min_bins(&hist))
        } else {
            None
        };
        let mut day_apps: BTreeMap<String, u64> = BTreeMap::new();
        let day_total = accumulate_focus_day(
            &path,
            day_start,
            day_end,
            now_ts,
            &mut day_apps,
            bins.as_deref(),
        );
        for (k, v) in day_apps {
            *app_ms.entry(k).or_insert(0) += v;
        }
        week_total += day_total;
        let is_today = offset == 0;
        days.push(json!({
            "date": date.format("%Y-%m-%d").to_string(),
            "label": if is_today { "今日".to_string() } else { weekday_cn(date).to_string() },
            "total_ms": day_total,
            "is_today": is_today,
        }));
    }

    let mut apps: Vec<Value> = app_ms
        .into_iter()
        .map(|(app, total_ms)| json!({ "app": app, "total_ms": total_ms }))
        .collect();
    apps.sort_by(|a, b| {
        b.get("total_ms")
            .and_then(|v| v.as_u64())
            .cmp(&a.get("total_ms").and_then(|v| v.as_u64()))
    });
    apps.truncate(20);

    let avg_ms = week_total / 7;
    let today_ms = days
        .last()
        .and_then(|d| d.get("total_ms"))
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    json!({
        "days": days,
        "apps": apps,
        "avg_ms": avg_ms,
        "today_ms": today_ms,
        "week_total_ms": week_total,
        "active_only": active_only,
        "bin_ms": ACTIVE_FOCUS_BIN_MS,
    })
}

#[tauri::command]
pub async fn dashboard_stats(
    include_active_focus: Option<bool>,
    force_refresh: Option<bool>,
) -> StatsReport {
    tauri::async_runtime::spawn_blocking(move || {
        dashboard_stats_blocking(include_active_focus, force_refresh)
    })
    .await
    .expect("dashboard_stats worker panicked")
}

fn dashboard_stats_blocking(
    include_active_focus: Option<bool>,
    force_refresh: Option<bool>,
) -> StatsReport {
    let include_active = include_active_focus.unwrap_or(false);
    let force = force_refresh.unwrap_or(false);
    if !force {
        if let Ok(g) = STATS_CACHE.lock() {
            if let Some(e) = g.get(&include_active) {
                if e.at.elapsed() < STATS_CACHE_TTL {
                    return e.report.clone();
                }
            }
        }
    }
    let root = data_root();
    let now = Local::now();
    let now_ts = now_ms();
    let today = now.date_naive();
    let seg = century_segments(now);
    let day = now.day();
    let day_start = day_local_start_ms(today);
    let day_end = day_start.saturating_add(86_400_000);

    let bin = root
        .join("EventData")
        .join(&seg)
        .join(format!("trace_{:02}.bin", day));
    let mut module_rows = Vec::new();
    let mut event_counts = Vec::new();
    for id in MODULES {
        let p = root
            .join("ModuleData")
            .join(id)
            .join(&seg)
            .join(format!("events_{:02}.jsonl", day));
        let lines = count_jsonl_events(&p);
        let meta = file_meta(&p);
        module_rows.push(json!({
            "module": id,
            "lines": lines,
            "bytes": meta.get("bytes").cloned().unwrap_or(json!(0)),
            "exists": meta.get("exists").cloned().unwrap_or(json!(false)),
        }));
        event_counts.push(json!({ "label": id, "value": lines }));
    }

    let (health_today, health_total) = health_event_counts(today, day_start, day_end);
    let bin_meta = file_meta(&bin);
    let recorder_running = root.join("control").join("winrecorder.pid").exists();
    let (input_mouse_today, input_key_today) = day_input_totals(&root, today);

    let focus_usage = build_focus_usage(&root, now_ts, false);
    let active_focus_usage = if include_active {
        build_focus_usage(&root, now_ts, true)
    } else {
        json!({})
    };
    let key_frequency = build_key_frequency(&root);
    let volume = build_volume(&root, today, health_today, health_total);

    let report = StatsReport {
        data_root: root.to_string_lossy().into_owned(),
        recorder_running,
        today: json!({
            "date": now.format("%Y-%m-%d").to_string(),
            "bin": bin_meta,
            "modules": module_rows,
            "health_events": health_today,
            "health_events_total": health_total,
            "input_mouse": input_mouse_today,
            "input_key": input_key_today,
        }),
        charts: json!({
            "events_by_module": event_counts,
            "bin_bytes": bin_meta.get("bytes").cloned().unwrap_or(json!(0)),
            "focus_usage": focus_usage,
            "active_focus_usage": active_focus_usage,
            "key_frequency": key_frequency,
        }),
        volume,
    };
    if let Ok(mut g) = STATS_CACHE.lock() {
        g.insert(
            include_active,
            StatsCacheEntry {
                at: Instant::now(),
                report: report.clone(),
            },
        );
    }
    report
}

#[tauri::command]
pub fn dashboard_live_feed() -> LiveFeedReport {
    let root = data_root();
    let now = Local::now();
    let seg = century_segments(now);
    let day = now.day();
    let mut items: Vec<LiveFeedItem> = Vec::new();

    for e in read_jsonl_tail(&health_path(), 40) {
        let ts = e.get("ts").and_then(|v| v.as_u64()).unwrap_or(0);
        let kind = e.get("kind").and_then(|v| v.as_str()).unwrap_or("?");
        let module = e.get("module").and_then(|v| v.as_str()).unwrap_or("?");
        items.push(LiveFeedItem {
            ts,
            source: "health".into(),
            kind: kind.into(),
            summary: format!("{module} · {kind}"),
        });
    }

    for id in ["focus", "win_map", "win_settings", "body", "ime"] {
        let p = root
            .join("ModuleData")
            .join(id)
            .join(&seg)
            .join(format!("events_{:02}.jsonl", day));
        for e in read_jsonl_tail(&p, 30) {
            let ts = e.get("ts").and_then(|v| v.as_u64()).unwrap_or(0);
            let kind = e.get("kind").and_then(|v| v.as_str()).unwrap_or("event");
            let summary = match kind {
                "focus_change" => format!(
                    "焦点 → {}",
                    e.pointer("/payload/app")
                        .and_then(|v| v.as_str())
                        .unwrap_or("?")
                ),
                "settings_change" => format!(
                    "设置变更 {}",
                    e.pointer("/payload/id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                ),
                "wallpaper" => format!(
                    "壁纸 {}",
                    e.pointer("/payload/reason")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                ),
                "hk_sample" => {
                    let mode = e
                        .pointer("/payload/volume_mode")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    let watts = e
                        .pointer("/payload/eps/watts")
                        .and_then(|v| v.as_f64());
                    match watts {
                        Some(w) => format!("机体采样 {mode} {w:.0} W"),
                        None => format!("机体采样 {mode}"),
                    }
                }
                "inventory_snapshot" => "机体清单".into(),
                "device_change" => format!(
                    "设备 {}",
                    e.pointer("/payload/action")
                        .and_then(|v| v.as_str())
                        .unwrap_or("?")
                ),
                "link_change" => format!(
                    "链路 {} {}",
                    e.pointer("/payload/media")
                        .and_then(|v| v.as_str())
                        .unwrap_or("?"),
                    e.pointer("/payload/ssid")
                        .or_else(|| e.pointer("/payload/adapter"))
                        .or_else(|| e.pointer("/payload/name"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                ),
                "sensor_unavailable" => format!(
                    "传感器不可用 {}",
                    e.pointer("/payload/channel")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                ),
                "compose_update" => {
                    let pre = e
                        .pointer("/payload/preedit")
                        .and_then(|v| v.as_str())
                        .unwrap_or("");
                    if pre.is_empty() {
                        "输入法组字".into()
                    } else {
                        format!("组字 {pre}")
                    }
                }
                "commit" => format!(
                    "上屏 {}",
                    e.pointer("/payload/text")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                ),
                other => other.to_string(),
            };
            items.push(LiveFeedItem {
                ts,
                source: id.into(),
                kind: kind.into(),
                summary,
            });
        }
    }

    items.sort_by(|a, b| b.ts.cmp(&a.ts));
    items.truncate(60);
    LiveFeedReport { items }
}

const SLEEP_WAKE_MARGIN_MS: u64 = 30 * 60 * 1000;
const SLEEP_WAKE_POST_MS: u64 = 30 * 60 * 1000;
const SLEEP_PC_IDLE_MS: u64 = 10 * 60 * 1000;
const SLEEP_WAKE_SEARCH_START_H: u64 = 3;
const SLEEP_WAKE_SEARCH_END_H: u64 = 12;

#[derive(Serialize, Clone)]
pub struct SleepGuessApp {
    pub label: String,
    pub duration_ms: u64,
}

#[derive(Serialize, Clone)]
pub struct SleepGuessDay {
    pub day_start_ms: u64,
    pub wake_ts: u64,
    pub mode: String,
    pub apps: Vec<SleepGuessApp>,
}

#[derive(Serialize)]
pub struct SleepGuessReport {
    pub days: Vec<SleepGuessDay>,
    pub phone_linked: bool,
    pub note: Option<String>,
    /// 睡眠活跃条：5 分钟格（与 AFK 格同宽）
    pub activity_t0: u64,
    pub activity_t1: u64,
    pub activity_bin_ms: u64,
    pub pc_active: Vec<bool>,
    pub phone_active: Vec<bool>,
}

#[tauri::command]
pub fn dashboard_sleep_guess(t0: u64, t1: u64) -> SleepGuessReport {
    let root = data_root();
    let phone_root = android_source_root(&root);
    let phone_linked = phone_root.is_some();
    let mut days = Vec::new();
    let mut d = ms_to_local_date(t0);
    let end_date = ms_to_local_date(t1.saturating_sub(1));
    while d <= end_date {
        let day_start = day_local_start_ms(d);
        let day_end = day_start.saturating_add(86_400_000);
        if day_end <= t0 || day_start >= t1 {
            d += ChronoDuration::days(1);
            continue;
        }
        if let Some(day) = sleep_guess_one_day(&root, phone_root.as_deref(), d, t0, t1) {
            days.push(day);
        }
        d += ChronoDuration::days(1);
    }
    let (act_t0, act_t1, pc_active, phone_active) =
        sleep_activity_bins(&root, phone_root.as_deref(), t0, t1);
    let note = if phone_linked {
        Some("PC 侧未解析手机 IMU；黄条用旁路 GPS/亮屏。联动时用手机灭屏 + PC 键鼠空闲。".into())
    } else {
        Some("无手机旁路：将 APK 数据放到 OmniDatabase/sources/<android_id>/。青条为电脑键鼠。".into())
    };
    let empty = days.is_empty();
    SleepGuessReport {
        days,
        phone_linked,
        note: if empty { note } else { None },
        activity_t0: act_t0,
        activity_t1: act_t1,
        activity_bin_ms: ACTIVE_FOCUS_BIN_MS,
        pc_active,
        phone_active,
    }
}

/// 所选段内按 5 分钟格：电脑键鼠 / 手机 GPS·亮屏。
fn sleep_activity_bins(
    root: &Path,
    phone_root: Option<&Path>,
    t0: u64,
    t1: u64,
) -> (u64, u64, Vec<bool>, Vec<bool>) {
    let bin = ACTIVE_FOCUS_BIN_MS;
    if t1 <= t0 || bin == 0 {
        return (t0, t1, Vec::new(), Vec::new());
    }
    let act_t0 = (t0 / bin) * bin;
    let n = ((t1.saturating_sub(act_t0) + bin - 1) / bin) as usize;
    let n = n.min(14 * ACTIVE_FOCUS_BINS_PER_DAY);
    let mut pc = vec![false; n];
    let mut phone = vec![false; n];
    let mut d = ms_to_local_date(act_t0);
    let end_date = ms_to_local_date(t1.saturating_sub(1));
    while d <= end_date {
        let day_start = day_local_start_ms(d);
        let day_end = day_start.saturating_add(86_400_000);
        if day_end <= act_t0 || day_start >= t1 {
            d += ChronoDuration::days(1);
            continue;
        }
        let hist = ensure_day_input_hist(root, d);
        let day_bins = active_5min_bins(&hist);
        for (i, on) in day_bins.iter().enumerate() {
            if !*on {
                continue;
            }
            let ts = day_start + i as u64 * bin;
            if ts < act_t0 || ts >= t1 {
                continue;
            }
            let idx = ((ts - act_t0) / bin) as usize;
            if idx < pc.len() {
                pc[idx] = true;
            }
        }
        if let Some(phone_base) = phone_root {
            mark_phone_active_bins(phone_base, d, day_start, act_t0, t1, bin, &mut phone);
        }
        d += ChronoDuration::days(1);
    }
    let act_t1 = act_t0.saturating_add(n as u64 * bin);
    (act_t0, act_t1, pc, phone)
}

fn mark_phone_active_bins(
    phone: &Path,
    date: NaiveDate,
    day_start: u64,
    act_t0: u64,
    t1: u64,
    bin: u64,
    out: &mut [bool],
) {
    // GPS fix → 该格黄
    let gps_path = module_events_path(phone, "gps", date);
    if let Ok(f) = fs::File::open(gps_path) {
        for line in BufReader::new(f).lines().flatten() {
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if v.get("kind").and_then(|k| k.as_str()) != Some("fix") {
                continue;
            }
            let ts = v.get("ts").and_then(|t| t.as_u64()).unwrap_or(0);
            if ts < act_t0 || ts >= t1 {
                continue;
            }
            let idx = ((ts - act_t0) / bin) as usize;
            if idx < out.len() {
                out[idx] = true;
            }
        }
    }
    // 亮屏段 → 黄（代理「手机活跃」；PC 不解析 IMU）
    let on_spans = phone_screen_on_spans(phone, date, day_start, day_start.saturating_add(86_400_000));
    for (a, b) in on_spans {
        let mut ts = a.max(act_t0);
        let end = b.min(t1);
        while ts < end {
            let idx = ((ts - act_t0) / bin) as usize;
            if idx < out.len() {
                out[idx] = true;
            }
            ts = ts.saturating_add(bin);
        }
    }
}

fn phone_screen_on_spans(phone: &Path, date: NaiveDate, day_start: u64, day_end: u64) -> Vec<(u64, u64)> {
    let off = phone_screen_off_spans(phone, date, day_start, day_end);
    invert_spans(&off, day_start, day_end)
}

fn invert_spans(off: &[(u64, u64)], day_start: u64, day_end: u64) -> Vec<(u64, u64)> {
    if day_end <= day_start {
        return Vec::new();
    }
    let mut sorted = off.to_vec();
    sorted.sort_by_key(|(a, _)| *a);
    let mut out = Vec::new();
    let mut cur = day_start;
    for (a, b) in sorted {
        let a = a.max(day_start).min(day_end);
        let b = b.max(day_start).min(day_end);
        if a > cur {
            out.push((cur, a));
        }
        cur = cur.max(b);
    }
    if day_end > cur {
        out.push((cur, day_end));
    }
    out
}

fn android_source_root(root: &Path) -> Option<PathBuf> {
    let sources = root.join("sources");
    let Ok(rd) = fs::read_dir(sources) else {
        return None;
    };
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() && e.file_name().to_string_lossy().starts_with("android_") {
            return Some(p);
        }
    }
    None
}

fn ms_to_local_date(ms: u64) -> NaiveDate {
    let secs = (ms / 1000) as i64;
    Local.timestamp_opt(secs, 0)
        .single()
        .map(|dt| dt.date_naive())
        .unwrap_or_else(|| Local::now().date_naive())
}

fn module_events_path(base: &Path, module: &str, date: NaiveDate) -> PathBuf {
    let century = (date.year() / 100) + 1;
    base.join("ModuleData")
        .join(module)
        .join(format!("Century_{:08}", century))
        .join(format!("Year_{:04}", date.year()))
        .join(format!("Month_{:02}", date.month()))
        .join(format!("events_{:02}.jsonl", date.day()))
}

fn sleep_guess_one_day(
    root: &Path,
    phone_root: Option<&Path>,
    date: NaiveDate,
    t0: u64,
    t1: u64,
) -> Option<SleepGuessDay> {
    let day_start = day_local_start_ms(date);
    let day_end = day_start.saturating_add(86_400_000);
    if day_end <= t0 || day_start >= t1 {
        return None;
    }
    let hour_ms = 60 * 60 * 1000;
    let search_start = day_start.saturating_add(SLEEP_WAKE_SEARCH_START_H * hour_ms);
    let search_end = day_start.saturating_add(SLEEP_WAKE_SEARCH_END_H * hour_ms).min(day_end);
    if search_end <= search_start {
        return None;
    }
    let hist = ensure_day_input_hist(root, date);
    let pc_idle = pc_idle_spans_from_hist(&hist, day_start, day_end);
    let phone_off = phone_root.map(|p| phone_screen_off_spans(p, date, day_start, day_end));
    let rough = first_input_active(&hist, search_start, search_end)
        .or_else(|| first_focus_in_range(root, date, search_start, search_end));
    let rough = rough?;
    let win0 = rough.saturating_sub(SLEEP_WAKE_MARGIN_MS).max(day_start);
    let win1 = rough.saturating_add(SLEEP_WAKE_MARGIN_MS).min(day_end).min(t1);
    let mut sleep = pc_idle.clone();
    if let Some(off) = phone_off {
        sleep = intersect_spans(&sleep, &off);
    }
    let wake_ts = find_last_sleep_end(&sleep, win0, win1, rough).unwrap_or(rough);
    let post_end = wake_ts
        .saturating_add(SLEEP_WAKE_POST_MS)
        .min(day_end)
        .min(t1);
    if post_end <= wake_ts {
        return None;
    }
    let apps = focus_app_chain(root, date, wake_ts, post_end);
    let mode = if phone_root.is_some() {
        "手机 + 电脑（键鼠空闲 ≥10 分钟代理）"
    } else {
        "仅电脑猜测"
    };
    Some(SleepGuessDay {
        day_start_ms: day_start,
        wake_ts,
        mode: mode.into(),
        apps,
    })
}

fn pc_idle_spans_from_hist(hist: &DayInputHist, day_start: u64, day_end: u64) -> Vec<(u64, u64)> {
    let min_idle = (SLEEP_PC_IDLE_MS / INPUT_HIST_FINE_MS) as usize;
    let secs = hist.mouse.len().min(hist.key.len()).min(SECS_PER_DAY);
    let mut out = Vec::new();
    let mut i = 0;
    while i < secs {
        while i < secs && (hist.mouse[i] > 0 || hist.key[i] > 0) {
            i += 1;
        }
        let start = i;
        while i < secs && hist.mouse[i] == 0 && hist.key[i] == 0 {
            i += 1;
        }
        if i - start >= min_idle {
            let a = day_start + start as u64 * INPUT_HIST_FINE_MS;
            let b = day_start + i as u64 * INPUT_HIST_FINE_MS;
            if b > a {
                out.push((a.max(day_start), b.min(day_end)));
            }
        }
    }
    out
}

fn phone_screen_off_spans(phone: &Path, date: NaiveDate, day_start: u64, day_end: u64) -> Vec<(u64, u64)> {
    let path = module_events_path(phone, "device", date);
    let mut on_edges: Vec<(u64, bool)> = Vec::new();
    if let Ok(f) = File::open(&path) {
        for line in BufReader::new(f).lines().flatten() {
            let Ok(v) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if v.get("kind").and_then(|k| k.as_str()) != Some("screen") {
                continue;
            }
            let ts = v.get("ts").and_then(|t| t.as_u64()).unwrap_or(0);
            let on = v
                .pointer("/payload/on")
                .and_then(|x| x.as_bool())
                .unwrap_or(false);
            on_edges.push((ts, on));
        }
    }
    on_edges.sort_by_key(|x| x.0);
    let mut on_spans = Vec::new();
    let mut on = false;
    let mut start = 0u64;
    for (ts, flag) in on_edges {
        if flag && !on {
            on = true;
            start = ts;
        } else if !flag && on {
            on = false;
            if ts > start {
                on_spans.push((start, ts));
            }
        }
    }
    if on && day_end > start {
        on_spans.push((start, day_end));
    }
    subtract_span(day_start, day_end, &on_spans)
}

fn subtract_span(day_start: u64, day_end: u64, cut: &[(u64, u64)]) -> Vec<(u64, u64)> {
    let mut base = vec![(day_start, day_end)];
    for (c0, c1) in cut {
        let mut next = Vec::new();
        for (a, b) in base {
            if *c1 <= a || *c0 >= b {
                next.push((a, b));
                continue;
            }
            if *c0 > a {
                next.push((a, *c0));
            }
            if *c1 < b {
                next.push((*c1, b));
            }
        }
        base = next;
    }
    base
}

fn intersect_spans(a: &[(u64, u64)], b: &[(u64, u64)]) -> Vec<(u64, u64)> {
    let mut out = Vec::new();
    for (a0, a1) in a {
        for (b0, b1) in b {
            let lo = (*a0).max(*b0);
            let hi = (*a1).min(*b1);
            if hi > lo {
                out.push((lo, hi));
            }
        }
    }
    merge_spans(out)
}

fn merge_spans(mut spans: Vec<(u64, u64)>) -> Vec<(u64, u64)> {
    if spans.is_empty() {
        return spans;
    }
    spans.sort_by_key(|x| x.0);
    let mut out = vec![spans[0]];
    for (s, e) in spans.into_iter().skip(1) {
        let last = out.last_mut().unwrap();
        if s <= last.1 {
            last.1 = last.1.max(e);
        } else {
            out.push((s, e));
        }
    }
    out
}

fn first_input_active(hist: &DayInputHist, from: u64, to: u64) -> Option<u64> {
    let day_start = hist.day_start_ms;
    let from_sec = ((from.saturating_sub(day_start)) / INPUT_HIST_FINE_MS) as usize;
    let to_sec = ((to.saturating_sub(day_start)) / INPUT_HIST_FINE_MS) as usize;
    let secs = hist.mouse.len().min(hist.key.len()).min(SECS_PER_DAY);
    for sec in from_sec..to_sec.min(secs) {
        if hist.mouse[sec] > 0 || hist.key[sec] > 0 {
            return Some(day_start + sec as u64 * INPUT_HIST_FINE_MS);
        }
    }
    None
}

fn first_focus_in_range(root: &Path, date: NaiveDate, from: u64, to: u64) -> Option<u64> {
    let path = focus_events_path(root, date);
    let Ok(f) = File::open(&path) else {
        return None;
    };
    for line in BufReader::new(f).lines().flatten() {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if v.get("kind").and_then(|k| k.as_str()) != Some("focus_change") {
            continue;
        }
        let ts = v.get("ts").and_then(|t| t.as_u64()).unwrap_or(0);
        if ts >= from && ts < to {
            return Some(ts);
        }
    }
    None
}

fn find_last_sleep_end(sleep: &[(u64, u64)], win0: u64, win1: u64, rough: u64) -> Option<u64> {
    let mut best: Option<u64> = None;
    for (a, b) in sleep {
        if *b <= win0 || *a >= win1 {
            continue;
        }
        let end = (*b).min(win1);
        if end <= rough {
            best = Some(best.map_or(end, |x| x.max(end)));
        }
    }
    best.or_else(|| {
        sleep
            .iter()
            .filter(|(a, b)| *a < win1 && *b > win0)
            .map(|(_, b)| (*b).min(win1))
            .max()
    })
}

fn focus_app_chain(root: &Path, date: NaiveDate, wake: u64, end: u64) -> Vec<SleepGuessApp> {
    let path = focus_events_path(root, date);
    let Ok(f) = File::open(&path) else {
        return Vec::new();
    };
    let mut events: Vec<(u64, String)> = Vec::new();
    for line in BufReader::new(f).lines().flatten() {
        let Ok(v) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if v.get("kind").and_then(|k| k.as_str()) != Some("focus_change") {
            continue;
        }
        let ts = v.get("ts").and_then(|t| t.as_u64()).unwrap_or(0);
        if ts < wake - 3_600_000 || ts >= end {
            continue;
        }
        let app = v
            .pointer("/payload/app")
            .and_then(|x| x.as_str())
            .unwrap_or("");
        let title = v
            .pointer("/payload/title")
            .and_then(|x| x.as_str())
            .unwrap_or("");
        events.push((ts, normalize_focus_app(app, title)));
    }
    events.sort_by_key(|x| x.0);
    let mut segs: Vec<(String, u64, u64)> = Vec::new();
    for i in 0..events.len() {
        let (ts, label) = &events[i];
        if *ts < wake {
            continue;
        }
        let next_ts = events
            .get(i + 1)
            .map(|x| x.0)
            .unwrap_or(end)
            .min(end);
        if next_ts > *ts {
            segs.push((label.clone(), *ts, next_ts));
        }
    }
    let mut by: BTreeMap<String, u64> = BTreeMap::new();
    for (label, s, e) in segs {
        if e <= wake {
            continue;
        }
        let a = s.max(wake);
        let b = e.min(end);
        if b > a {
            by.entry(label).and_modify(|d| *d += b - a).or_insert(b - a);
        }
    }
    let mut out: Vec<SleepGuessApp> = by
        .into_iter()
        .map(|(label, duration_ms)| SleepGuessApp {
            label,
            duration_ms,
        })
        .collect();
    out.sort_by(|a, b| b.duration_ms.cmp(&a.duration_ms));
    out
}

const STATUS_DEFAULT_WINDOW_MIN: u32 = 30;

#[derive(Serialize, Clone)]
pub struct StatusScalarPoint {
    pub ts: u64,
    pub v: f64,
}

#[derive(Serialize, Clone)]
pub struct StatusWanPoint {
    pub ts: u64,
    /// 合计吞吐 B/s（in+out）；前端换算 MB/s 或 Mbps。
    pub v: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub in_bps: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub out_bps: Option<f64>,
    /// 链路协商速率 Mbps（非瞬时吞吐）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub link_mbps: Option<f64>,
}

#[derive(Serialize, Clone)]
pub struct StatusWanSeries {
    pub id: String,
    pub label: String,
    pub media: String,
    pub points: Vec<StatusWanPoint>,
}

#[derive(Serialize, Clone)]
pub struct StatusDiskSeries {
    pub id: String,
    pub label: String,
    pub total_gb: f64,
    pub points: Vec<StatusScalarPoint>,
}

#[derive(Serialize, Clone)]
pub struct StatusModuleBucket {
    pub label: String,
    pub points: Vec<StatusScalarPoint>,
}

#[derive(Serialize)]
pub struct StatusChartsReport {
    pub now_ts: u64,
    pub window_start_ts: u64,
    pub recorder_running: bool,
    pub body_samples: usize,
    pub wan: Vec<StatusWanSeries>,
    pub cpu: Vec<StatusScalarPoint>,
    /// 已用内存 GB（物理）。
    pub mem_used_gb: Vec<StatusScalarPoint>,
    /// 最近一拍的总量 GB（折线常数）；无采样则 0。
    pub mem_total_gb: f64,
    pub disk_busy: Vec<StatusScalarPoint>,
    /// PhysicalDisk(_Total) 读吞吐 B/s（新版 body `cdh.disk_read_Bps`）。
    pub disk_read: Vec<StatusScalarPoint>,
    /// PhysicalDisk(_Total) 写吞吐 B/s（新版 body `cdh.disk_write_Bps`）。
    pub disk_write: Vec<StatusScalarPoint>,
    /// 遗留：各逻辑盘已用容量 GB（容量监视；运行状态折线已改用 disk_read/write）。
    pub disks: Vec<StatusDiskSeries>,
    pub gpu: Vec<StatusScalarPoint>,
    pub power: Vec<StatusScalarPoint>,
    pub input: Vec<StatusScalarPoint>,
    pub focus_rate: Vec<StatusScalarPoint>,
    pub ime_rate: Vec<StatusScalarPoint>,
    pub module_beats: Vec<StatusModuleBucket>,
    pub note: Option<String>,
}

fn module_events_path_today(module: &str) -> PathBuf {
    let now = Local::now();
    let seg = century_segments(now);
    let day = now.day();
    data_root()
        .join("ModuleData")
        .join(module)
        .join(seg)
        .join(format!("events_{:02}.jsonl", day))
}

fn ensure_wan_series<'a>(
    wan_map: &'a mut BTreeMap<String, StatusWanSeries>,
    id: &str,
    label: &str,
    media: &str,
) -> &'a mut StatusWanSeries {
    wan_map.entry(id.to_string()).or_insert_with(|| StatusWanSeries {
        id: id.to_string(),
        label: label.to_string(),
        media: media.to_string(),
        points: Vec::new(),
    })
}

fn ingest_inventory_adapters(
    payload: &Value,
    wan_map: &mut BTreeMap<String, StatusWanSeries>,
) {
    let Some(arr) = payload.get("adapters").and_then(|v| v.as_array()) else {
        return;
    };
    for a in arr {
        let media = a.get("type").and_then(|v| v.as_str()).unwrap_or("");
        if media != "wifi" && media != "ethernet" {
            continue;
        }
        let name = a.get("name").and_then(|v| v.as_str()).unwrap_or("?");
        let guid = a.get("guid").and_then(|v| v.as_str()).unwrap_or("");
        if guid.is_empty() {
            continue;
        }
        ensure_wan_series(wan_map, guid, name, media);
    }
}

fn bucket_event_rates(
    path: &Path,
    window_start: u64,
    kind: &str,
    max_lines: usize,
) -> Vec<StatusScalarPoint> {
    let mut buckets: BTreeMap<u64, f64> = BTreeMap::new();
    for e in read_jsonl_tail(path, max_lines) {
        let ts = e.get("ts").and_then(|v| v.as_u64()).unwrap_or(0);
        if ts < window_start {
            continue;
        }
        if e.get("kind").and_then(|v| v.as_str()) != Some(kind) {
            continue;
        }
        let bucket = (ts / 60_000) * 60_000;
        *buckets.entry(bucket).or_insert(0.0) += 1.0;
    }
    buckets
        .into_iter()
        .map(|(ts, v)| StatusScalarPoint { ts, v })
        .collect()
}

fn dashboard_status_charts_blocking(window_ms: u64) -> StatusChartsReport {
    let now = now_ms();
    let window_start = now.saturating_sub(window_ms);
    let root = data_root();
    let recorder_running = root.join("control").join("winrecorder.pid").exists();

    let mut wan_map: BTreeMap<String, StatusWanSeries> = BTreeMap::new();
    let mut cpu = Vec::new();
    let mut mem_used_gb = Vec::new();
    let mut mem_total_gb = 0.0f64;
    let mut disk_busy = Vec::new();
    let mut disk_read = Vec::new();
    let mut disk_write = Vec::new();
    let mut disk_map: BTreeMap<String, StatusDiskSeries> = BTreeMap::new();
    let mut gpu = Vec::new();
    let mut power = Vec::new();
    let mut body_samples = 0usize;

    let body_path = module_events_path_today("body");
    for e in read_jsonl_tail(&body_path, 1200) {
        let ts = e.get("ts").and_then(|v| v.as_u64()).unwrap_or(0);
        if ts < window_start {
            continue;
        }
        let kind = e.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        let payload = e.get("payload").cloned().unwrap_or(Value::Null);
        match kind {
            "inventory_snapshot" => {
                ingest_inventory_adapters(&payload, &mut wan_map);
            }
            "hk_sample" => {
                body_samples += 1;
                if let Some(v) = payload.pointer("/cdh/cpu_pct").and_then(|x| x.as_f64()) {
                    cpu.push(StatusScalarPoint { ts, v });
                }
                if let (Some(used), Some(total)) = (
                    payload.pointer("/cdh/mem_used_mb").and_then(|x| x.as_i64()),
                    payload.pointer("/cdh/mem_total_mb").and_then(|x| x.as_i64()),
                ) {
                    if total > 0 {
                        let ug = used as f64 / 1024.0;
                        let tg = total as f64 / 1024.0;
                        mem_used_gb.push(StatusScalarPoint { ts, v: ug });
                        mem_total_gb = tg;
                    }
                }
                if let Some(v) = payload.pointer("/cdh/disk_busy_pct").and_then(|x| x.as_f64()) {
                    disk_busy.push(StatusScalarPoint { ts, v });
                }
                if let Some(v) = payload.pointer("/cdh/disk_read_Bps").and_then(|x| x.as_f64()) {
                    if v.is_finite() && v >= 0.0 {
                        disk_read.push(StatusScalarPoint { ts, v });
                    }
                }
                if let Some(v) = payload.pointer("/cdh/disk_write_Bps").and_then(|x| x.as_f64()) {
                    if v.is_finite() && v >= 0.0 {
                        disk_write.push(StatusScalarPoint { ts, v });
                    }
                }
                if let Some(arr) = payload.pointer("/cdh/disks").and_then(|x| x.as_array()) {
                    for d in arr {
                        let id = d
                            .get("id")
                            .and_then(|x| x.as_str())
                            .unwrap_or("?")
                            .to_string();
                        let free = d.get("free_gb").and_then(|x| x.as_i64()).unwrap_or(0) as f64;
                        let total = d.get("total_gb").and_then(|x| x.as_i64()).unwrap_or(0) as f64;
                        let used = (total - free).max(0.0);
                        let series =
                            disk_map
                                .entry(id.clone())
                                .or_insert_with(|| StatusDiskSeries {
                                    id: id.clone(),
                                    label: id.clone(),
                                    total_gb: total,
                                    points: Vec::new(),
                                });
                        series.total_gb = total;
                        series.points.push(StatusScalarPoint { ts, v: used });
                    }
                }
                if let Some(arr) = payload.pointer("/cdh/gpu").and_then(|x| x.as_array()) {
                    // 多 GPU 时取最大 util；无 util 则跳过
                    let mut best: Option<f64> = None;
                    for g in arr {
                        if let Some(u) = g.get("util_pct").and_then(|x| x.as_f64()) {
                            best = Some(best.map_or(u, |b| b.max(u)));
                        }
                    }
                    if let Some(v) = best {
                        gpu.push(StatusScalarPoint { ts, v });
                    }
                }
                if let Some(w) = payload.pointer("/eps/watts").and_then(|x| x.as_f64()) {
                    if w.is_finite() && w > 0.0 {
                        power.push(StatusScalarPoint { ts, v: w });
                    }
                }
                if let Some(tel) = payload.get("telecom") {
                    if let Some(adapters) = tel.get("adapters").and_then(|v| v.as_array()) {
                        for a in adapters {
                            let guid = a.get("guid").and_then(|x| x.as_str()).unwrap_or("");
                            if guid.is_empty() {
                                continue;
                            }
                            let name = a.get("name").and_then(|x| x.as_str()).unwrap_or(guid);
                            let media = a.get("media").and_then(|x| x.as_str()).unwrap_or("ethernet");
                            let in_bps = a.get("in_Bps").and_then(|x| x.as_f64()).unwrap_or(0.0);
                            let out_bps = a.get("out_Bps").and_then(|x| x.as_f64()).unwrap_or(0.0);
                            let link = a.get("link_mbps").and_then(|x| x.as_f64());
                            let series = ensure_wan_series(&mut wan_map, guid, name, media);
                            series.points.push(StatusWanPoint {
                                ts,
                                v: in_bps + out_bps,
                                in_bps: Some(in_bps),
                                out_bps: Some(out_bps),
                                link_mbps: link,
                            });
                        }
                    } else {
                        // 旧 hk_sample：无 adapters 时仍可读信号%，但不伪造吞吐
                        if let Some(wifi_q) = tel.get("wifi_q").and_then(|v| v.as_array()) {
                            for (i, _q) in wifi_q.iter().enumerate() {
                                let id = format!("legacy-wifi-{i}");
                                let label = format!("Wi-Fi {}", i + 1);
                                let _ = ensure_wan_series(&mut wan_map, &id, &label, "wifi");
                            }
                        }
                    }
                }
            }
            "link_change" => {
                let media = payload.get("media").and_then(|v| v.as_str()).unwrap_or("");
                if media != "wifi" && media != "ethernet" {
                    continue;
                }
                let guid = payload.get("guid").and_then(|v| v.as_str()).unwrap_or("");
                let adapter = payload.get("adapter").and_then(|v| v.as_str()).unwrap_or("");
                if guid.is_empty() {
                    continue;
                }
                let label = if adapter.is_empty() {
                    guid
                } else {
                    adapter
                };
                ensure_wan_series(&mut wan_map, guid, label, media);
            }
            _ => {}
        }
    }

    let mut wan: Vec<StatusWanSeries> = wan_map.into_values().collect();
    for s in &mut wan {
        s.points.sort_by_key(|p| p.ts);
    }
    wan.sort_by(|a, b| a.label.cmp(&b.label));

    let mut disks: Vec<StatusDiskSeries> = disk_map.into_values().collect();
    for s in &mut disks {
        s.points.sort_by_key(|p| p.ts);
    }
    disks.sort_by(|a, b| a.label.cmp(&b.label));

    let hist = dashboard_input_histogram_blocking(window_start, now, 60_000);
    let input: Vec<StatusScalarPoint> = hist
        .buckets
        .iter()
        .map(|b| StatusScalarPoint {
            ts: b.start_ts,
            v: (b.mouse + b.key) as f64,
        })
        .collect();

    let focus_path = module_events_path_today("focus");
    let focus_rate = bucket_event_rates(&focus_path, window_start, "focus_change", 400);
    let ime_path = module_events_path_today("ime");
    let ime_rate = bucket_event_rates(&ime_path, window_start, "commit", 400);

    let mut mod_buckets: BTreeMap<String, BTreeMap<u64, f64>> = BTreeMap::new();
    for e in read_jsonl_tail(&health_path(), 600) {
        let ts = e.get("ts").and_then(|v| v.as_u64()).unwrap_or(0);
        if ts < window_start {
            continue;
        }
        if e.get("kind").and_then(|v| v.as_str()) != Some("beat") {
            continue;
        }
        let module = e
            .get("module")
            .and_then(|v| v.as_str())
            .unwrap_or("?")
            .to_string();
        let bucket = (ts / 60_000) * 60_000;
        *mod_buckets
            .entry(module)
            .or_default()
            .entry(bucket)
            .or_insert(0.0) += 1.0;
    }
    let mut module_beats: Vec<StatusModuleBucket> = mod_buckets
        .into_iter()
        .map(|(label, buckets)| StatusModuleBucket {
            label,
            points: buckets
                .into_iter()
                .map(|(ts, v)| StatusScalarPoint { ts, v })
                .collect(),
        })
        .collect();
    module_beats.sort_by(|a, b| a.label.cmp(&b.label));

    let note = if !recorder_running {
        Some(
            "采集器未运行：图为历史窗口内已有落盘。网卡吞吐需新版 body（In/OutOctets 差分），非抓包/非逐进程流量。"
                .into(),
        )
    } else if body_samples == 0 {
        Some(
            "body 模组尚无 hk_sample：请确认 WinRecorder 已启用 body。等待约 10s 采样。"
                .into(),
        )
    } else if wan.is_empty() {
        Some("窗口内未检测到以太网/Wi-Fi 网卡序列。".into())
    } else {
        None
    };

    StatusChartsReport {
        now_ts: now,
        window_start_ts: window_start,
        recorder_running,
        body_samples,
        wan,
        cpu,
        mem_used_gb,
        mem_total_gb,
        disk_busy,
        disk_read,
        disk_write,
        disks,
        gpu,
        power,
        input,
        focus_rate,
        ime_rate,
        module_beats,
        note,
    }
}

#[tauri::command]
pub async fn dashboard_status_charts(window_minutes: Option<u32>) -> StatusChartsReport {
    let mins = window_minutes.unwrap_or(STATUS_DEFAULT_WINDOW_MIN).clamp(5, 120);
    let window_ms = mins as u64 * 60 * 1000;
    tauri::async_runtime::spawn_blocking(move || dashboard_status_charts_blocking(window_ms))
        .await
        .expect("dashboard_status_charts worker panicked")
}
