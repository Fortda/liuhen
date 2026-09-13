//! WinRecorder（采集宿主）启停 + 开机自启，供设置页调用。
//! 采集器以独立后台进程运行；OmniPlayer 只发命令与读 control 面状态，不绑定 Tauri 生命周期。

use crate::resolve_data_root;
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// 脱离父控制台：关 OmniPlayer 或停 `tauri dev` 时不连带杀采集器。
#[cfg(windows)]
const DETACHED_PROCESS: u32 = 0x0000_0008;
/// 新进程组：Ctrl+C 不传给采集器；不依赖 Job breakaway 特权。
#[cfg(windows)]
const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

const HEARTBEAT_STALE_MS: u64 = 5000;

#[derive(Serialize)]
pub struct RecorderStatus {
    pub running: bool,
    pub pid: Option<u32>,
    /// 检测到的 omnitrace_input.exe 进程数（>1 说明异常多开）
    pub instances: u32,
    pub exe: Option<String>,
    pub repo_root: Option<String>,
    pub autostart: bool,
    /// 用户上次显式开关意图（仅记录，不自动启停）
    pub desired: Option<bool>,
}

fn repo_root() -> Option<PathBuf> {
    let mut dir = std::env::current_dir().ok()?;
    for _ in 0..8 {
        let cargo = dir.join("Cargo.toml");
        if cargo.is_file() {
            if let Ok(s) = fs::read_to_string(&cargo) {
                if s.contains("name = \"omnitrace_input\"") {
                    return Some(dir);
                }
            }
        }
        dir = dir.parent()?.to_path_buf();
    }
    None
}

/// 采集宿主以相对路径写 `OmniDatabase/`，工作目录必须是数据根的上一级。
fn recorder_work_dir(data_root: &Path) -> PathBuf {
    let name = data_root.file_name().and_then(|s| s.to_str()).unwrap_or("");
    if name.eq_ignore_ascii_case("OmniDatabase") {
        data_root
            .parent()
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| data_root.to_path_buf())
    } else {
        data_root.to_path_buf()
    }
}

/// 稳定版：OmniPlayer.exe 旁的 omnitrace_input.exe（存在则禁止再 cargo）。
fn bundled_recorder_exe() -> Option<PathBuf> {
    let dir = crate::current_exe_dir()?;
    let cand = dir.join("omnitrace_input.exe");
    if cand.is_file() {
        Some(cand)
    } else {
        None
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn pid_path(data_root: &Path) -> PathBuf {
    data_root.join("control").join("winrecorder.pid")
}

fn clock_path(data_root: &Path) -> PathBuf {
    data_root.join("control").join("winrecorder_clock.json")
}

fn desired_path(data_root: &Path) -> PathBuf {
    data_root.join("control").join("recorder_desired.json")
}

fn read_desired(data_root: &Path) -> Option<bool> {
    let raw = fs::read_to_string(desired_path(data_root)).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    v.get("enabled").and_then(|x| x.as_bool())
}

fn write_desired(data_root: &Path, enabled: bool) {
    let dir = data_root.join("control");
    let _ = fs::create_dir_all(&dir);
    let body = json!({ "enabled": enabled }).to_string();
    let _ = fs::write(desired_path(data_root), body);
}

fn read_clock_pid(data_root: &Path) -> Option<u32> {
    let raw = fs::read_to_string(clock_path(data_root)).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    v.get("pid").and_then(|x| x.as_u64()).map(|p| p as u32)
}

/// 读 control 面心跳：与仪表盘 STALE_MS=5s 对齐。
fn recorder_live_from_control(data_root: &Path) -> (bool, Option<u32>) {
    let now = now_ms();
    if let Ok(raw) = fs::read_to_string(clock_path(data_root)) {
        if let Ok(v) = serde_json::from_str::<Value>(&raw) {
            if let (Some(wall_ms), Some(pid)) = (
                v.get("wall_ms").and_then(|x| x.as_u64()),
                v.get("pid").and_then(|x| x.as_u64()).map(|p| p as u32),
            ) {
                if now.saturating_sub(wall_ms) <= HEARTBEAT_STALE_MS && pid_alive(pid) {
                    return (true, Some(pid));
                }
                // 心跳文件略旧但进程仍存活（tasklist 偶发漏检时的兜底）
                if pid_alive(pid) {
                    return (true, Some(pid));
                }
            }
        }
    }

    let health = data_root.join("control").join("module_health.jsonl");
    if let Some(last_beat) = latest_health_beat_ts(&health) {
        if now.saturating_sub(last_beat) <= HEARTBEAT_STALE_MS {
            if let Some(pid) = read_live_pid(data_root) {
                return (true, Some(pid));
            }
            return (true, None);
        }
    }

    (false, None)
}

fn latest_health_beat_ts(path: &Path) -> Option<u64> {
    let mut f = std::fs::File::open(path).ok()?;
    let len = f.metadata().ok()?.len();
    const TAIL_BYTES: u64 = 256 * 1024;
    let start = len.saturating_sub(TAIL_BYTES);
    f.seek(SeekFrom::Start(start)).ok()?;
    let mut text = String::new();
    f.read_to_string(&mut text).ok()?;
    let body = if start > 0 {
        text.split_once('\n').map(|(_, rest)| rest).unwrap_or("")
    } else {
        text.as_str()
    };
    let mut last: Option<u64> = None;
    for line in body.lines().filter(|l| !l.trim().is_empty()) {
        let v: Value = serde_json::from_str(line).ok()?;
        let kind = v.get("kind")?.as_str()?;
        if kind != "beat" && kind != "start" {
            continue;
        }
        let ts = v.get("ts")?.as_u64()?;
        last = Some(last.map_or(ts, |p| p.max(ts)));
    }
    last
}

fn autostart_lnk_path() -> Option<PathBuf> {
    let appdata = dirs::data_dir()?; // Roaming
    Some(
        appdata
            .join("Microsoft")
            .join("Windows")
            .join("Start Menu")
            .join("Programs")
            .join("Startup")
            .join("OmniTrace-WinRecorder.lnk"),
    )
}

#[cfg(windows)]
fn pid_alive(pid: u32) -> bool {
    use windows::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return false;
        };
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code).is_ok();
        let _ = CloseHandle(handle);
        ok && code == STILL_ACTIVE.0 as u32
    }
}

#[cfg(not(windows))]
fn pid_alive(pid: u32) -> bool {
    let out = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .ok();
    out.map(|o| {
        let text = String::from_utf8_lossy(&o.stdout);
        text.contains(&pid.to_string())
    })
    .unwrap_or(false)
}

fn read_live_pid(data_root: &Path) -> Option<u32> {
    let s = fs::read_to_string(pid_path(data_root)).ok()?;
    let pid: u32 = s.trim().parse().ok()?;
    if pid_alive(pid) {
        Some(pid)
    } else {
        let _ = fs::remove_file(pid_path(data_root));
        None
    }
}

fn find_recorder_exe(root: &Path) -> Option<PathBuf> {
    let candidates = [
        root.join("target/release/omnitrace_input.exe"),
        root.join("target/debug/omnitrace_input.exe"),
    ];
    candidates.into_iter().find(|p| p.is_file())
}

fn ensure_built(root: &Path) -> Result<PathBuf, String> {
    // 每次启停前都 cargo build：旧逻辑「exe 已存在就跳过」会一直跑过期二进制
    // （例如源码已有 win_move_hook，但 target/debug 仍是几天前的 exe → 直播里窗不跟手）
    // 强制产物落到项目 target/，避免环境里的 CARGO_TARGET_DIR 指到别处
    let target_dir = root.join("target");
    let mut cmd = Command::new("cargo");
    cmd.current_dir(root)
        .env("CARGO_TARGET_DIR", &target_dir)
        .args(["build", "--bin", "omnitrace_input"])
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("无法运行 cargo build: {e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("编译 WinRecorder 失败:\n{err}"));
    }
    find_recorder_exe(root).ok_or_else(|| "编译成功但找不到 exe".into())
}

fn count_recorder_instances(data_root: &Path) -> u32 {
    // Prefer in-process Toolhelp over spawning tasklist.exe (~100ms+ each 2s poll).
    #[cfg(windows)]
    let mut n = count_recorder_instances_toolhelp();
    #[cfg(not(windows))]
    let mut n = {
        let out = Command::new("tasklist")
            .args([
                "/FI",
                "IMAGENAME eq omnitrace_input.exe",
                "/FO",
                "CSV",
                "/NH",
            ])
            .output()
            .ok();
        out.map(|o| {
            let t = String::from_utf8_lossy(&o.stdout).to_ascii_lowercase();
            t.lines()
                .filter(|l| l.contains("omnitrace_input.exe"))
                .count() as u32
        })
        .unwrap_or(0)
    };
    if n == 0 {
        if let Some(pid) = read_clock_pid(data_root) {
            if pid_alive(pid) {
                n = 1;
            }
        } else if let Some(pid) = read_live_pid(data_root) {
            if pid_alive(pid) {
                n = 1;
            }
        }
    }
    n
}

#[cfg(windows)]
fn count_recorder_instances_toolhelp() -> u32 {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
        TH32CS_SNAPPROCESS,
    };
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return 0;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        let mut n = 0u32;
        if Process32FirstW(snap, &mut entry).is_ok() {
            loop {
                let end = entry
                    .szExeFile
                    .iter()
                    .position(|&c| c == 0)
                    .unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..end]).to_ascii_lowercase();
                if name == "omnitrace_input.exe" {
                    n += 1;
                }
                if Process32NextW(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
        n
    }
}

fn kill_all_recorders(data_root: &Path) {
    let _ = Command::new("taskkill")
        .args(["/IM", "omnitrace_input.exe", "/T", "/F"])
        .status();
    let _ = fs::remove_file(pid_path(data_root));
    std::thread::sleep(std::time::Duration::from_millis(350));
}

#[cfg(windows)]
fn spawn_recorder_direct(exe: &Path, root: &Path, flags: u32) -> Result<(), std::io::Error> {
    let mut cmd = Command::new(exe);
    cmd.current_dir(root)
        .arg("--quiet")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(flags);
    cmd.spawn().map(|child| drop(child))
}

#[cfg(windows)]
fn spawn_recorder_via_cmd_start(exe: &Path, root: &Path) -> Result<(), std::io::Error> {
    // 完全脱离父 Job/控制台；不请求 CREATE_BREAKAWAY_FROM_JOB。
    let mut cmd = Command::new("cmd");
    cmd.current_dir(root)
        .args([
            "/c",
            "start",
            "",
            "/B",
            "/D",
            &root.to_string_lossy(),
            &exe.to_string_lossy(),
            "--quiet",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
    cmd.spawn().map(|child| drop(child))
}

#[cfg(windows)]
fn spawn_recorder_windows(exe: &Path, root: &Path) -> Result<(), std::io::Error> {
    let strategies: &[(u32, &str)] = &[
        (
            CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP,
            "DETACHED_PROCESS|CREATE_NEW_PROCESS_GROUP",
        ),
        (CREATE_NO_WINDOW | DETACHED_PROCESS, "DETACHED_PROCESS"),
    ];
    let mut last_access_denied: Option<std::io::Error> = None;
    for (flags, _label) in strategies {
        match spawn_recorder_direct(exe, root, *flags) {
            Ok(()) => return Ok(()),
            Err(e) if e.raw_os_error() == Some(5) => {
                last_access_denied = Some(e);
            }
            Err(e) => return Err(e),
        }
    }
    match spawn_recorder_via_cmd_start(exe, root) {
        Ok(()) => Ok(()),
        Err(e) if e.raw_os_error() == Some(5) => Err(last_access_denied.unwrap_or(e)),
        Err(e) => Err(e),
    }
}

fn spawn_recorder_err_msg(e: &std::io::Error, exe: &str) -> String {
    let access_hint = if e.raw_os_error() == Some(5) {
        "（拒绝访问 os error 5：常见于父进程在 Job 内且无 breakaway 权限；已尝试 detached / cmd start）"
    } else {
        ""
    };
    format!("启动 WinRecorder 失败: {e}{access_hint}，exe: {exe}")
}

fn spawn_recorder_process(exe: &Path, work_dir: &Path, data_root: &Path) -> Result<(), String> {
    let exe_hint = exe.display().to_string();
    #[cfg(windows)]
    {
        spawn_recorder_windows(exe, work_dir)
            .map_err(|e| spawn_recorder_err_msg(&e, &exe_hint))?;
    }
    #[cfg(not(windows))]
    {
        let mut cmd = Command::new(exe);
        cmd.current_dir(work_dir)
            .arg("--quiet")
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let child = cmd
            .spawn()
            .map_err(|e| spawn_recorder_err_msg(&e, &exe_hint))?;
        drop(child);
    }
    for _ in 0..40 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        if read_live_pid(data_root).is_some() {
            break;
        }
    }
    Ok(())
}

fn start_recorder(data_root: &Path) -> Result<(), String> {
    if let Some(exe) = bundled_recorder_exe() {
        let work = recorder_work_dir(data_root);
        return spawn_recorder_process(&exe, &work, data_root);
    }
    let root = repo_root().ok_or("找不到项目根目录（Cargo.toml / omnitrace_input）")?;
    let exe = ensure_built(&root)?;
    spawn_recorder_process(&exe, &root, data_root)
}

fn stop_recorder_exe() -> Option<(PathBuf, PathBuf)> {
    let data_root = resolve_data_root();
    let work = recorder_work_dir(&data_root);
    if let Some(exe) = bundled_recorder_exe() {
        return Some((exe, work));
    }
    let root = repo_root()?;
    let exe = find_recorder_exe(&root)?;
    Some((exe, root))
}

fn build_recorder_status(data_root: &Path) -> RecorderStatus {
    let root = repo_root();
    let exe = bundled_recorder_exe().or_else(|| root.as_ref().and_then(|r| find_recorder_exe(r)));
    let pid_file = read_live_pid(data_root);
    let (health_live, health_pid) = recorder_live_from_control(data_root);
    let instances = count_recorder_instances(data_root);
    let clock_pid = read_clock_pid(data_root).filter(|pid| pid_alive(*pid));
    let pid = pid_file.or(health_pid).or(clock_pid);
    let running = instances > 0 || pid_file.is_some() || health_live || clock_pid.is_some();
    let autostart = autostart_lnk_path()
        .map(|p| p.is_file())
        .unwrap_or(false);
    let desired = read_desired(data_root);
    RecorderStatus {
        running,
        pid,
        instances,
        exe: exe.map(|p| p.to_string_lossy().into_owned()),
        repo_root: root.map(|p| p.to_string_lossy().into_owned()),
        autostart,
        desired,
    }
}

#[tauri::command]
pub fn recorder_status() -> RecorderStatus {
    let data_root = resolve_data_root();
    build_recorder_status(&data_root)
}

#[tauri::command]
pub fn recorder_set_running(enabled: bool) -> Result<RecorderStatus, String> {
    let data_root = resolve_data_root();
    write_desired(&data_root, enabled);
    if enabled {
        let n = count_recorder_instances(&data_root);
        let (health_live, _) = recorder_live_from_control(&data_root);
        // 已有正好一个：按钮开着即可，绝不重复启动
        if n == 1 || (n == 0 && health_live) {
            return Ok(build_recorder_status(&data_root));
        }
        // 多开：先清成零，再只启一个
        if n > 1 {
            kill_all_recorders(&data_root);
        } else if read_live_pid(&data_root).is_some() {
            // tasklist 偶发漏检但 pid 仍活着
            return Ok(build_recorder_status(&data_root));
        }
        start_recorder(&data_root)?;
    } else {
        // 走宿主 --stop：先写墓碑再杀进程；再兜底清光，避免残留多开
        if let Some((exe, work)) = stop_recorder_exe() {
            let mut cmd = Command::new(&exe);
            cmd.current_dir(&work).arg("--stop");
            #[cfg(windows)]
            {
                cmd.creation_flags(CREATE_NO_WINDOW);
            }
            let _ = cmd.status();
        }
        if count_recorder_instances(&data_root) > 0 {
            kill_all_recorders(&data_root);
        } else {
            let _ = fs::remove_file(pid_path(&data_root));
        }
    }
    Ok(build_recorder_status(&data_root))
}

#[tauri::command]
pub fn autostart_set(enabled: bool) -> Result<RecorderStatus, String> {
    let lnk = autostart_lnk_path().ok_or("无法定位 Startup 文件夹")?;
    if !enabled {
        let _ = fs::remove_file(&lnk);
        return Ok(recorder_status());
    }

    let data_root = resolve_data_root();
    let work = recorder_work_dir(&data_root);
    let exe = if let Some(bundled) = bundled_recorder_exe() {
        bundled
    } else {
        let root = repo_root().ok_or("找不到项目根目录")?;
        ensure_built(&root)?
    };
    let exe_str = exe.to_string_lossy().replace('\'', "''");
    let work_str = work.to_string_lossy().replace('\'', "''");
    let link = lnk.to_string_lossy().replace('\'', "''");

    let ps = format!(
        "$ws = New-Object -ComObject WScript.Shell; \
         $sc = $ws.CreateShortcut('{link}'); \
         $sc.TargetPath = '{exe}'; \
         $sc.Arguments = '--quiet'; \
         $sc.WorkingDirectory = '{work}'; \
         $sc.WindowStyle = 7; \
         $sc.Description = 'OmniTrace WinRecorder'; \
         $sc.Save()",
        link = link,
        exe = exe_str,
        work = work_str
    );

    let mut cmd = Command::new("powershell");
    cmd.args(["-NoProfile", "-Command", &ps])
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("创建开机自启失败: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "创建开机自启失败: {}",
            String::from_utf8_lossy(&out.stderr)
        ));
    }
    Ok(recorder_status())
}
