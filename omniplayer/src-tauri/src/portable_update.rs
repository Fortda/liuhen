//! 便携增量更新：只替换 OmniPlayer.exe（及旁路采集 exe），绝不触碰 OmniDatabase。

use serde::Serialize;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

const UPDATE_MSG: &str =
    "已准备更新，请关闭并重启 OmniPlayer（数据目录 OmniDatabase 不会被改动）";

#[derive(Serialize)]
pub struct PendingPortableUpdate {
    pub path: String,
    pub source: String,
}

fn path_contains_omnibase(path: &Path) -> bool {
    path.components().any(|c| match c {
        Component::Normal(s) => {
            let n = s.to_string_lossy();
            n.eq_ignore_ascii_case("OmniDatabase")
        }
        _ => false,
    })
}

fn is_omniplayer_exe_name(name: &str) -> bool {
    name.eq_ignore_ascii_case("OmniPlayer.exe") || name.eq_ignore_ascii_case("omniplayer.exe")
}

fn same_path(a: &Path, b: &Path) -> bool {
    if let (Ok(ca), Ok(cb)) = (fs::canonicalize(a), fs::canonicalize(b)) {
        return ca == cb;
    }
    a == b
}

#[cfg(windows)]
fn spawn_update_bat(bat_path: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

    Command::new("cmd")
        .args(["/C", &bat_path.to_string_lossy()])
        .creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .spawn()
        .map_err(|e| format!("无法启动更新脚本：{e}"))?;
    Ok(())
}

#[cfg(not(windows))]
fn spawn_update_bat(_bat_path: &Path) -> Result<(), String> {
    Err("便携增量更新仅支持 Windows".into())
}

fn file_len(path: &Path) -> Option<u64> {
    fs::metadata(path).ok().map(|m| m.len())
}

/// 同路径已排除后：长度不同必新；长度相同再比内容，避免安装残留 twin 误报「可更新」。
fn looks_like_newer_exe(path: &Path, current: &Path) -> bool {
    let Some(new_len) = file_len(path) else {
        return false;
    };
    let Some(cur_len) = file_len(current) else {
        return true;
    };
    if new_len != cur_len {
        return true;
    }
    match (fs::read(path), fs::read(current)) {
        (Ok(a), Ok(b)) => a != b,
        _ => true,
    }
}

fn is_usable_update_exe(path: &Path, current: &Path) -> bool {
    path.is_file()
        && !same_path(path, current)
        && !path_contains_omnibase(path)
        && looks_like_newer_exe(path, current)
}

/// 探测 incoming 或仓库 dist 里待换上的 OmniPlayer.exe。
#[tauri::command]
pub fn probe_portable_update() -> Option<PendingPortableUpdate> {
    let current = std::env::current_exe().ok()?;
    let mut cands: Vec<(PathBuf, &'static str)> = Vec::new();
    if let Some(dir) = crate::current_exe_dir() {
        cands.push((dir.join("incoming").join("OmniPlayer.exe"), "incoming"));
    }
    if let Some(db) = crate::read_install_data_root_pointer() {
        if let Some(repo) = db.parent() {
            cands.push((
                repo.join("dist").join("OmniPlayer").join("OmniPlayer.exe"),
                "dist",
            ));
        }
    }
    for (path, source) in cands {
        if is_usable_update_exe(&path, &current) {
            return Some(PendingPortableUpdate {
                path: path.to_string_lossy().into_owned(),
                source: source.to_string(),
            });
        }
    }
    None
}

/// 将新 exe 准备为旁路替换：写 `.new` + `update_omniplayer.bat`，用户重启后生效。
#[tauri::command]
pub fn apply_portable_update(new_exe_path: String) -> Result<String, String> {
    let new_path = PathBuf::from(new_exe_path.trim());
    if !new_path.is_file() {
        return Err(format!("找不到新程序文件：{}", new_path.display()));
    }

    let file_name = new_path
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or_else(|| "无效的文件名".to_string())?;
    if !is_omniplayer_exe_name(file_name) {
        return Err("新文件名必须是 OmniPlayer.exe（或 omniplayer.exe）".into());
    }

    if path_contains_omnibase(&new_path) {
        return Err("拒绝：新程序路径位于 OmniDatabase 内，请勿从数据目录选取更新文件".into());
    }

    let current = std::env::current_exe().map_err(|e| format!("无法解析当前程序路径：{e}"))?;
    if same_path(&current, &new_path) {
        return Err("新文件与当前正在运行的程序是同一文件".into());
    }

    let dir = current
        .parent()
        .ok_or_else(|| "当前程序没有父目录".to_string())?;
    if path_contains_omnibase(dir) {
        return Err("拒绝：当前程序位于 OmniDatabase 内，无法安全更新".into());
    }

    let current_name = current
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "OmniPlayer.exe".into());

    // 旁路备份，失败不阻断
    let bak = dir.join("OmniPlayer.exe.bak");
    let _ = fs::copy(&current, &bak);

    let new_staging = dir.join("OmniPlayer.exe.new");
    fs::copy(&new_path, &new_staging).map_err(|e| format!("复制新程序失败：{e}"))?;

    let rec_src = new_path
        .parent()
        .map(|p| p.join("omnitrace_input.exe"))
        .filter(|p| p.is_file());
    let rec_staging = dir.join("omnitrace_input.exe.new");
    let rec_cur = dir.join("omnitrace_input.exe");
    let rec_old = dir.join("omnitrace_input.exe.old");
    let rec_staged = if let Some(src) = rec_src {
        let _ = fs::copy(&rec_cur, dir.join("omnitrace_input.exe.bak"));
        fs::copy(&src, &rec_staging).map_err(|e| format!("复制采集程序失败：{e}"))?;
        true
    } else {
        false
    };

    let old_path = dir.join(format!("{current_name}.old"));
    let bat_path = dir.join("update_omniplayer.bat");
    let rec_block = if rec_staged {
        format!(
            r#"
:waitrec
if exist "{rec_new}" (
  move /Y "{rec_cur}" "{rec_old}" >nul 2>&1
  move /Y "{rec_new}" "{rec_cur}" >nul 2>&1
  if errorlevel 1 (
    timeout /t 1 /nobreak >nul
    goto waitrec
  )
)
"#,
            rec_new = rec_staging.display(),
            rec_cur = rec_cur.display(),
            rec_old = rec_old.display(),
        )
    } else {
        String::new()
    };
    let bat_body = format!(
        r#"@echo off
chcp 65001 >nul
:wait
timeout /t 1 /nobreak >nul
move /Y "{cur}" "{old}" >nul 2>&1
if errorlevel 1 goto wait
move /Y "{staging}" "{cur}" >nul 2>&1
if errorlevel 1 goto wait
{rec}
start "" "{cur}"
del "%~f0"
"#,
        cur = current.display(),
        old = old_path.display(),
        staging = new_staging.display(),
        rec = rec_block,
    );
    fs::write(&bat_path, bat_body).map_err(|e| format!("写入更新脚本失败：{e}"))?;

    spawn_update_bat(&bat_path)?;
    Ok(UPDATE_MSG.into())
}
