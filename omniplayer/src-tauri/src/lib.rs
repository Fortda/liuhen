mod apps_ctl;
mod dashboard_ctl;
mod llm_sidecar_ctl;
mod local_http_proxy;
mod notes_aistudio_import;
mod notes_clue_history;
mod notes_ctl;
mod notes_mcp;
mod notes_model_discovery;
mod notes_paths;
mod notes_pricing;
mod notes_research;
mod notes_vendor;
mod omni_sync_ctl;
mod portable_update;
mod recorder_ctl;
mod shell_launch;
mod webview_loopback;

use base64::Engine;
use chrono::{Datelike, Local};
use serde::Serialize;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// Windows 下采集器正写 bin 时，默认 File::open 会分享冲突；允许读写共享。
pub(crate) fn open_shared_read(path: &Path) -> std::io::Result<File> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        const FILE_SHARE_READ: u32 = 0x1;
        const FILE_SHARE_WRITE: u32 = 0x2;
        const FILE_SHARE_DELETE: u32 = 0x4;
        return OpenOptions::new()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .open(path);
    }
    #[cfg(not(windows))]
    OpenOptions::new().read(true).open(path)
}

#[derive(Serialize)]
pub struct TodayTraces {
    pub data_root: String,
    pub bin_path: Option<String>,
    pub jsonl_path: Option<String>,
    pub focus_events_path: Option<String>,
    pub win_map_events_path: Option<String>,
    pub ime_events_path: Option<String>,
}

/// 文件夹里扫到的一日录像（供播放列表）
#[derive(Serialize, Clone)]
pub struct RecordingDay {
    pub date: String,
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub bin_path: Option<String>,
    pub bin_bytes: u64,
    pub jsonl_path: Option<String>,
    pub focus_events_path: Option<String>,
    pub win_map_events_path: Option<String>,
    pub ime_events_path: Option<String>,
}

fn opt_file(p: PathBuf) -> Option<String> {
    p.is_file().then(|| p.to_string_lossy().into_owned())
}

fn traces_for_ymd(root: &Path, year: i32, month: u32, day: u32) -> RecordingDay {
    let century = (year / 100) + 1;
    let seg = PathBuf::from(format!("Century_{:08}", century))
        .join(format!("Year_{:04}", year))
        .join(format!("Month_{:02}", month));
    let bin = root
        .join("EventData")
        .join(&seg)
        .join(format!("trace_{:02}.bin", day));
    let bin_bytes = std::fs::metadata(&bin).map(|m| m.len()).unwrap_or(0);
    let jsonl = root
        .join("ContextData")
        .join(&seg)
        .join(format!("win_context_{:02}.jsonl", day));
    let focus = root
        .join("ModuleData")
        .join("focus")
        .join(&seg)
        .join(format!("events_{:02}.jsonl", day));
    let win_map = root
        .join("ModuleData")
        .join("win_map")
        .join(&seg)
        .join(format!("events_{:02}.jsonl", day));
    let ime = root
        .join("ModuleData")
        .join("ime")
        .join(&seg)
        .join(format!("events_{:02}.jsonl", day));
    RecordingDay {
        date: format!("{:04}-{:02}-{:02}", year, month, day),
        year,
        month,
        day,
        bin_path: opt_file(bin),
        bin_bytes,
        jsonl_path: opt_file(jsonl),
        focus_events_path: opt_file(focus),
        win_map_events_path: opt_file(win_map),
        ime_events_path: opt_file(ime),
    }
}

#[derive(Serialize)]
pub struct FileChunk {
    /// base64：避免 Vec<u8> 经 IPC 变成 number[] 卡死渲染线程
    pub data_b64: String,
    pub next_offset: u64,
    pub eof: bool,
}

#[derive(Serialize)]
pub struct BinMouseSample {
    pub ts: u64,
    pub x: i32,
    pub y: i32,
}

#[derive(Serialize)]
pub struct BinAdvanceResult {
    pub next_offset: u64,
    pub eof: bool,
    pub dec_ts: u64,
    pub dec_x: i32,
    pub dec_y: i32,
    pub carry_b64: String,
    pub samples: Vec<BinMouseSample>,
    /// 解码时钟已到达/超过 until_ts
    pub reached: bool,
}

fn b64_encode(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn b64_decode(s: &str) -> Result<Vec<u8>, String> {
    if s.is_empty() {
        return Ok(Vec::new());
    }
    base64::engine::general_purpose::STANDARD
        .decode(s)
        .map_err(|e| format!("base64 解码失败: {e}"))
}

fn read_i16_be(buf: &[u8], off: usize) -> i16 {
    i16::from_be_bytes([buf[off], buf[off + 1]])
}

fn read_u64_be(buf: &[u8], off: usize) -> u64 {
    u64::from_be_bytes([
        buf[off],
        buf[off + 1],
        buf[off + 2],
        buf[off + 3],
        buf[off + 4],
        buf[off + 5],
        buf[off + 6],
        buf[off + 7],
    ])
}

fn looks_like_db(p: &Path) -> bool {
    p.join("EventData").is_dir()
        || p.join("ModuleData").is_dir()
        || p.join("ContextData").is_dir()
}

pub(crate) fn current_exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
}

fn path_for_pointer(p: &Path) -> PathBuf {
    let raw = p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    let s = raw.to_string_lossy();
    #[cfg(windows)]
    {
        let t = s.strip_prefix(r"\\?\").unwrap_or(s.as_ref());
        return PathBuf::from(t);
    }
    #[cfg(not(windows))]
    PathBuf::from(s.as_ref())
}

/// 稳定版安装根旁的指针：`{ "path": "<OmniDatabase 绝对路径>" }`。
pub(crate) fn read_install_data_root_pointer() -> Option<PathBuf> {
    let dir = current_exe_dir()?;
    let file = dir.join("data_root.json");
    let raw = std::fs::read_to_string(&file).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let path = v.get("path")?.as_str()?.trim();
    if path.is_empty() {
        return None;
    }
    Some(PathBuf::from(path))
}

pub(crate) fn write_install_data_root_pointer(path: &Path) -> Result<(), String> {
    let dir = current_exe_dir().ok_or_else(|| "NO_EXE_DIR".to_string())?;
    let file = dir.join("data_root.json");
    let body = serde_json::json!({ "path": path.to_string_lossy() }).to_string();
    std::fs::write(&file, body).map_err(|e| format!("WRITE_POINTER:{e}"))?;
    Ok(())
}

/// 用户在设置里选中的目录：已是库则用之；否则在其下使用/创建 `OmniDatabase`。
fn normalize_chosen_data_root(picked: &Path) -> Result<PathBuf, String> {
    if picked.as_os_str().is_empty() {
        return Err("EMPTY_PATH".into());
    }
    if looks_like_db(picked) {
        return Ok(path_for_pointer(picked));
    }
    let nested = picked.join("OmniDatabase");
    if looks_like_db(&nested) {
        return Ok(path_for_pointer(&nested));
    }
    let name = picked
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let target = if name.eq_ignore_ascii_case("OmniDatabase") {
        picked.to_path_buf()
    } else {
        nested
    };
    std::fs::create_dir_all(&target).map_err(|e| format!("CREATE_DIR:{e}"))?;
    Ok(path_for_pointer(&target))
}

/// 开发时优先找仓库 OmniDatabase；稳定版先读 exe 旁指针；公开 zip 回落到用户目录。
fn candidate_data_roots() -> Vec<PathBuf> {
    let mut out = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        out.push(cwd.join("OmniDatabase"));
        out.push(cwd.join("..").join("OmniDatabase"));
        out.push(cwd.join("..").join("..").join("OmniDatabase"));
        out.push(cwd.join("..").join("..").join("..").join("OmniDatabase"));
    }
    if let Some(home) = dirs::home_dir() {
        out.push(home.join("OmniTrace").join("OmniDatabase"));
    }
    if let Some(dl) = dirs::download_dir() {
        out.push(dl.join("OmniTrace").join("OmniDatabase"));
        out.push(dl.join("OmniTrace"));
    }
    out
}

fn pick_existing_data_root(p: &Path, require_db_layout: bool) -> Option<PathBuf> {
    let ok = |canon: &Path| {
        if require_db_layout {
            looks_like_db(canon)
        } else {
            canon.is_dir() || looks_like_db(canon)
        }
    };
    if let Ok(canon) = p.canonicalize() {
        if ok(&canon) {
            return Some(canon);
        }
    } else if ok(p) {
        return Some(p.to_path_buf());
    }
    None
}

pub(crate) fn resolve_data_root() -> PathBuf {
    if let Ok(p) = std::env::var("OMNITRACE_DATA") {
        if let Some(hit) = pick_existing_data_root(Path::new(p.trim()), false) {
            return hit;
        }
    }
    if let Some(p) = read_install_data_root_pointer() {
        if let Some(hit) = pick_existing_data_root(&p, false) {
            return hit;
        }
        // 指针写明了路径但目录尚不存在：仍用它，避免落到下载目录另起一套库
        if !p.as_os_str().is_empty() {
            return p;
        }
    }
    for p in candidate_data_roots() {
        if let Some(hit) = pick_existing_data_root(&p, true) {
            return hit;
        }
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("OmniTrace")
        .join("OmniDatabase")
}

#[tauri::command]
fn get_data_root() -> String {
    resolve_data_root().to_string_lossy().into_owned()
}

/// 设置页改数据存放位置：写 exe 旁 `data_root.json`，不搬移已有库。采集运行中拒绝。
#[tauri::command]
fn set_data_root(path: String) -> Result<String, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("EMPTY_PATH".into());
    }
    if std::env::var("OMNITRACE_DATA")
        .ok()
        .is_some_and(|s| !s.trim().is_empty())
    {
        return Err("ENV_OVERRIDE".into());
    }
    if recorder_ctl::recorder_status().running {
        return Err("RECORDER_RUNNING".into());
    }
    let chosen = normalize_chosen_data_root(Path::new(trimmed))?;
    write_install_data_root_pointer(&chosen)?;
    // 开机自启快捷方式的工作目录是当时的数据根上一级；改位置后重写，避免登录后仍写进旧库。
    if recorder_ctl::recorder_status().autostart {
        let _ = recorder_ctl::autostart_set(true);
    }
    Ok(resolve_data_root().to_string_lossy().into_owned())
}

#[tauri::command]
fn find_today_traces() -> TodayTraces {
    let root = resolve_data_root();
    let now = Local::now();
    let day = traces_for_ymd(&root, now.year(), now.month(), now.day());
    TodayTraces {
        data_root: root.to_string_lossy().into_owned(),
        bin_path: day.bin_path,
        jsonl_path: day.jsonl_path,
        focus_events_path: day.focus_events_path,
        win_map_events_path: day.win_map_events_path,
        ime_events_path: day.ime_events_path,
    }
}

/// 扫描 OmniDatabase/EventData 下已有 trace_*.bin，组装播放列表。
fn list_recordings_blocking() -> Result<Vec<RecordingDay>, String> {
    let root = resolve_data_root();
    let event = root.join("EventData");
    let mut out: Vec<RecordingDay> = Vec::new();
    if !event.is_dir() {
        return Ok(out);
    }

    let centuries = std::fs::read_dir(&event).map_err(|e| e.to_string())?;
    for cent in centuries.flatten() {
        let cent_name = cent.file_name().to_string_lossy().into_owned();
        if !cent_name.starts_with("Century_") || !cent.path().is_dir() {
            continue;
        }
        let years = std::fs::read_dir(cent.path()).map_err(|e| e.to_string())?;
        for year_ent in years.flatten() {
            let year_name = year_ent.file_name().to_string_lossy().into_owned();
            let year: i32 = match year_name
                .strip_prefix("Year_")
                .and_then(|s| s.parse().ok())
            {
                Some(y) if year_ent.path().is_dir() => y,
                _ => continue,
            };
            let months = std::fs::read_dir(year_ent.path()).map_err(|e| e.to_string())?;
            for month_ent in months.flatten() {
                let month_name = month_ent.file_name().to_string_lossy().into_owned();
                let month: u32 = match month_name
                    .strip_prefix("Month_")
                    .and_then(|s| s.parse().ok())
                {
                    Some(m) if month_ent.path().is_dir() => m,
                    _ => continue,
                };
                let files =
                    std::fs::read_dir(month_ent.path()).map_err(|e| e.to_string())?;
                for f in files.flatten() {
                    let name = f.file_name().to_string_lossy().into_owned();
                    let day: u32 = match name
                        .strip_prefix("trace_")
                        .and_then(|s| s.strip_suffix(".bin"))
                        .and_then(|s| s.parse().ok())
                    {
                        Some(d) if f.path().is_file() => d,
                        _ => continue,
                    };
                    let rec = traces_for_ymd(&root, year, month, day);
                    if rec.bin_path.is_some()
                        || rec.focus_events_path.is_some()
                        || rec.win_map_events_path.is_some()
                        || rec.ime_events_path.is_some()
                        || rec.jsonl_path.is_some()
                    {
                        out.push(rec);
                    }
                }
            }
        }
    }

    out.sort_by(|a, b| b.date.cmp(&a.date));
    out.dedup_by(|a, b| a.date == b.date);
    Ok(out)
}

#[tauri::command]
async fn list_recordings() -> Result<Vec<RecordingDay>, String> {
    tauri::async_runtime::spawn_blocking(list_recordings_blocking)
        .await
        .map_err(|e| format!("list_recordings: {e}"))?
}

#[tauri::command]
fn read_trace_file(file_path: String) -> Result<Vec<u8>, String> {
    let mut file = open_shared_read(Path::new(&file_path))
        .map_err(|e| format!("读取物理流失败：{} ({})", file_path, e))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)
        .map_err(|e| format!("读取物理流失败：{} ({})", file_path, e))?;
    Ok(buf)
}

#[tauri::command]
fn read_jsonl_file(file_path: String) -> Result<String, String> {
    std::fs::read_to_string(&file_path)
        .map_err(|e| format!("读取环境流失败：{} ({})", file_path, e))
}

/// 从 offset 读新增字节（直播 tail）。
#[tauri::command]
fn read_file_from_offset(file_path: String, offset: u64) -> Result<FileChunk, String> {
    read_file_chunk(file_path, offset, u64::MAX)
}

/// 限长分块读取（播放器渐进加载，避免一次拉整文件卡死 UI）。
#[tauri::command]
fn read_file_chunk(file_path: String, offset: u64, max_len: u64) -> Result<FileChunk, String> {
    let mut file = open_shared_read(Path::new(&file_path))
        .map_err(|e| format!("打开失败 {}: {}", file_path, e))?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    let len = meta.len();
    if offset >= len {
        return Ok(FileChunk {
            data_b64: String::new(),
            next_offset: len,
            eof: true,
        });
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| e.to_string())?;
    let want = (len - offset).min(max_len.max(1)) as usize;
    let mut buf = vec![0u8; want];
    let n = file.read(&mut buf).map_err(|e| e.to_string())?;
    buf.truncate(n);
    let next = offset + n as u64;
    Ok(FileChunk {
        data_b64: b64_encode(&buf),
        next_offset: next,
        eof: next >= len,
    })
}

/// 在 Rust 侧推进 bin 解码（赶进度不占 JS 主线程）。seek 前可不返回采样。
#[tauri::command]
fn advance_bin_decode(
    file_path: String,
    offset: u64,
    max_bytes: u64,
    until_ts: u64,
    keep_floor_ts: u64,
    seed_ts: u64,
    seed_x: i32,
    seed_y: i32,
    carry_b64: String,
) -> Result<BinAdvanceResult, String> {
    let mut file = open_shared_read(Path::new(&file_path))
        .map_err(|e| format!("打开失败 {}: {}", file_path, e))?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    let len = meta.len();
    if offset >= len && carry_b64.is_empty() {
        return Ok(BinAdvanceResult {
            next_offset: len,
            eof: true,
            dec_ts: seed_ts,
            dec_x: seed_x,
            dec_y: seed_y,
            carry_b64: String::new(),
            samples: Vec::new(),
            reached: seed_ts >= until_ts,
        });
    }

    let mut carry = b64_decode(&carry_b64)?;
    let mut dec_ts = seed_ts;
    let mut dec_x = seed_x;
    let mut dec_y = seed_y;
    let mut samples: Vec<BinMouseSample> = Vec::new();
    let mut cur = offset;
    let budget = max_bytes.max(1) as usize;
    let mut read_total = 0usize;
    const MAX_SAMPLES: usize = 6_000;

    let push_sample = |ts: u64, x: i32, y: i32, samples: &mut Vec<BinMouseSample>| {
        if ts < keep_floor_ts {
            return;
        }
        if samples.len() >= MAX_SAMPLES {
            return;
        }
        samples.push(BinMouseSample { ts, x, y });
    };

    loop {
        // 必须先读盘再判断 until：种子若误用「现在」会立刻 >= until，导致零字节假完成
        if cur < len && read_total < budget {
            let want = (budget - read_total)
                .min((len - cur) as usize)
                .min(256 * 1024);
            if want == 0 {
                break;
            }
            file.seek(SeekFrom::Start(cur))
                .map_err(|e| e.to_string())?;
            let mut buf = vec![0u8; want];
            let n = file.read(&mut buf).map_err(|e| e.to_string())?;
            buf.truncate(n);
            if n == 0 {
                break;
            }
            cur += n as u64;
            read_total += n;
            carry.extend_from_slice(&buf);
        } else if cur >= len {
            if carry.is_empty() {
                break;
            }
            // EOF：尽量吃完 carry
        } else {
            // budget 用尽
            break;
        }

        let merged = carry;
        let mut offset_i = 0usize;
        let mut incomplete: Option<usize> = None;

        while offset_i < merged.len() {
            if samples.len() >= MAX_SAMPLES && dec_ts >= keep_floor_ts {
                incomplete = Some(offset_i);
                break;
            }
            if read_total > 0
                && dec_ts >= until_ts
                && (samples.len() > 0 || dec_ts >= keep_floor_ts)
            {
                incomplete = Some(offset_i);
                break;
            }

            let marker = merged[offset_i];
            let start = offset_i;
            offset_i += 1;

            if marker == 0xff {
                if offset_i + 12 > merged.len() {
                    incomplete = Some(start);
                    break;
                }
                dec_ts = read_u64_be(&merged, offset_i);
                dec_x = read_i16_be(&merged, offset_i + 8) as i32;
                dec_y = read_i16_be(&merged, offset_i + 10) as i32;
                push_sample(dec_ts, dec_x, dec_y, &mut samples);
                offset_i += 12;
            } else if marker == 0xfe || marker == 0xfd || marker == 0xfc || marker == 0xfb {
                if offset_i + 3 > merged.len() {
                    incomplete = Some(start);
                    break;
                }
                dec_ts = dec_ts.saturating_add(merged[offset_i] as u64);
                offset_i += 3;
            } else {
                if offset_i + 2 > merged.len() {
                    incomplete = Some(start);
                    break;
                }
                let dt = marker as u64;
                let dx = merged[offset_i] as i8 as i32;
                let dy = merged[offset_i + 1] as i8 as i32;
                dec_ts = dec_ts.saturating_add(dt);
                dec_x += dx;
                dec_y += dy;
                push_sample(dec_ts, dec_x, dec_y, &mut samples);
                offset_i += 2;
            }
        }

        if let Some(start) = incomplete {
            carry = merged[start..].to_vec();
            break;
        } else {
            carry = Vec::new();
            if cur >= len {
                break;
            }
            if read_total >= budget {
                break;
            }
            continue;
        }
    }

    Ok(BinAdvanceResult {
        next_offset: cur,
        eof: cur >= len && carry.is_empty(),
        dec_ts,
        dec_x,
        dec_y,
        carry_b64: b64_encode(&carry),
        samples,
        reached: read_total > 0 && dec_ts >= until_ts,
    })
}

#[tauri::command]
fn get_file_size(file_path: String) -> Result<u64, String> {
    std::fs::metadata(&file_path)
        .map(|m| m.len())
        .map_err(|e| format!("取文件大小失败 {}: {}", file_path, e))
}

#[tauri::command]
fn read_file_as_data_url(file_path: String) -> Result<String, String> {
    let bytes = std::fs::read(&file_path)
        .map_err(|e| format!("读文件失败 {}: {}", file_path, e))?;
    let lower = file_path.to_lowercase();
    let mime = if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".bmp") {
        "image/bmp"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else {
        "application/octet-stream"
    };
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{};base64,{}", mime, b64))
}

#[tauri::command]
fn resolve_win_map_asset(rel: String) -> Result<String, String> {
    let root = resolve_data_root()
        .join("ModuleData")
        .join("win_map")
        .join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
    if root.is_file() {
        Ok(root.to_string_lossy().into_owned())
    } else {
        Err(format!("资源不存在: {}", root.display()))
    }
}

/// 本机系统指针桌面像素尺寸（与录制侧 cursor_metrics 对齐思路）。
#[tauri::command]
fn get_system_cursor_size() -> [i32; 2] {
    #[cfg(windows)]
    {
        use windows::core::PCWSTR;
        use windows::Win32::Foundation::ERROR_SUCCESS;
        use windows::Win32::System::Registry::{
            RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY_CURRENT_USER, KEY_READ, REG_DWORD,
            REG_VALUE_TYPE,
        };
        use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXCURSOR, SM_CYCURSOR};

        fn dword(sub: &str, name: &str) -> Option<u32> {
            unsafe {
                let mut hkey = std::mem::zeroed();
                let sub_w: Vec<u16> = sub.encode_utf16().chain(std::iter::once(0)).collect();
                if RegOpenKeyExW(
                    HKEY_CURRENT_USER,
                    PCWSTR(sub_w.as_ptr()),
                    0,
                    KEY_READ,
                    &mut hkey,
                ) != ERROR_SUCCESS
                {
                    return None;
                }
                let mut kind = REG_VALUE_TYPE(0);
                let mut data = 0u32;
                let mut size = 4u32;
                let name_w: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
                let ok = RegQueryValueExW(
                    hkey,
                    PCWSTR(name_w.as_ptr()),
                    None,
                    Some(&mut kind as *mut REG_VALUE_TYPE),
                    Some((&mut data as *mut u32).cast()),
                    Some(&mut size),
                );
                let _ = RegCloseKey(hkey);
                if ok == ERROR_SUCCESS && kind == REG_DWORD {
                    Some(data)
                } else {
                    None
                }
            }
        }

        let sm = unsafe { (GetSystemMetrics(SM_CXCURSOR), GetSystemMetrics(SM_CYCURSOR)) };
        let px = if let Some(b) = dword(r"Control Panel\Cursors", "CursorBaseSize") {
            b.clamp(16, 256) as i32
        } else if let Some(level) = dword(r"Software\Microsoft\Accessibility", "CursorSize") {
            let t = (level.clamp(1, 15) as f32 - 1.0) / 14.0;
            (16.0 + t * (128.0 - 16.0)).round() as i32
        } else {
            sm.0.max(sm.1).clamp(16, 256)
        };
        [px, px]
    }
    #[cfg(not(windows))]
    {
        [32, 32]
    }
}

/// 线索板模式：关闭 WebView2 默认右键菜单（框选时仍会弹出）；离开线索板时恢复。
#[tauri::command]
fn set_webview_default_context_menus(
    window: tauri::WebviewWindow,
    enabled: bool,
) -> Result<(), String> {
    #[cfg(windows)]
    {
        window
            .with_webview(move |webview| {
                unsafe {
                    if let Ok(core) = webview.controller().CoreWebView2() {
                        if let Ok(settings) = core.Settings() {
                            let _ = settings.SetAreDefaultContextMenusEnabled(enabled);
                        }
                    }
                }
            })
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    let _ = (window, enabled);
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    webview_loopback::apply_webview_direct_env();
    shell_launch::parse_cli_args();
    omni_sync_ctl::ensure_running();
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            shell_launch::handle_second_instance(app, argv);
        }))
        .setup(|app| {
            // 快捷方式 --page=notes：首启直接摘出笔记窗
            if shell_launch::peek_launch_page().as_deref() == Some("notes") {
                let _ = shell_launch::open_or_focus_notes_window(app.handle());
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_data_root,
            set_data_root,
            find_today_traces,
            list_recordings,
            read_trace_file,
            read_jsonl_file,
            read_file_from_offset,
            read_file_chunk,
            advance_bin_decode,
            get_file_size,
            read_file_as_data_url,
            resolve_win_map_asset,
            recorder_ctl::recorder_status,
            recorder_ctl::recorder_set_running,
            recorder_ctl::autostart_set,
            get_system_cursor_size,
            dashboard_ctl::dashboard_health,
            dashboard_ctl::dashboard_health_snapshot,
            dashboard_ctl::dashboard_stats,
            dashboard_ctl::dashboard_live_feed,
            dashboard_ctl::dashboard_status_charts,
            dashboard_ctl::dashboard_input_histogram,
            dashboard_ctl::dashboard_input_day_series,
            dashboard_ctl::recorder_run_spans,
            dashboard_ctl::dashboard_sleep_guess,
            omni_sync_ctl::omni_sync_status,
            dashboard_ctl::perf_bench_write_report,
            notes_ctl::llm_sidecar_status_cmd,
            notes_ctl::llm_sidecar_ensure_running_cmd,
            notes_ctl::notes_providers_get,
            notes_ctl::notes_providers_save,
            notes_ctl::notes_providers_set_pinned,
            notes_ctl::notes_providers_set_disabled,
            notes_ctl::notes_discover_provider_models,
            notes_ctl::notes_refresh_models_if_stale,
            notes_ctl::notes_pricing_get,
            notes_ctl::notes_pricing_refresh_if_stale,
            notes_ctl::notes_pricing_save,
            notes_ctl::notes_list_models,
            notes_ctl::notes_list_cards,
            notes_ctl::notes_read_card,
            notes_ctl::notes_read_protocol_log,
            notes_ctl::notes_context_graph_get,
            notes_ctl::notes_context_graph_save,
            notes_ctl::notes_wire_presets_get,
            notes_ctl::notes_wire_presets_save,
            notes_ctl::notes_wire_presets_delete,
            notes_ctl::notes_clue_board_load,
            notes_ctl::notes_clue_board_save,
            notes_ctl::notes_clue_board_delete,
            notes_clue_history::notes_clue_history_list,
            notes_clue_history::notes_clue_history_record,
            notes_clue_history::notes_clue_history_rollback,
            notes_clue_history::notes_clue_history_ensure,
            notes_clue_history::notes_clue_history_delete,
            set_webview_default_context_menus,
            notes_ctl::notes_wire_preset_suggest_note,
            notes_ctl::notes_send_turn,
            notes_ctl::notes_save_user_only_card,
            notes_aistudio_import::notes_import_aistudio_export,
            notes_research::notes_research_list,
            notes_research::notes_research_get,
            notes_research::notes_research_open,
            notes_research::notes_research_ingest,
            notes_ctl::notes_test_connection,
            notes_mcp::notes_mcp_prefs_get,
            notes_mcp::notes_mcp_prefs_save,
            notes_mcp::notes_search_config_get,
            notes_mcp::notes_search_config_save,
            llm_sidecar_ctl::notes_litellm_settings_get,
            llm_sidecar_ctl::notes_litellm_settings_save,
            local_http_proxy::notes_sidecar_network_get,
            local_http_proxy::notes_sidecar_network_save,
            shell_launch::shell_get_launch_info,
            shell_launch::shell_consume_launch_page,
            shell_launch::shell_open_notes_window,
            shell_launch::shell_close_notes_window,
            shell_launch::shell_focus_main_window,
            apps_ctl::apps_run_shell,
            apps_ctl::apps_list_dir,
            portable_update::apply_portable_update,
            portable_update::probe_portable_update,
        ])
        .build(tauri::generate_context!())
        .expect("启动 OmniTrace 失败")
        .run(|_app, event| {
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                llm_sidecar_ctl::stop_owned_silent();
            }
        });
}
