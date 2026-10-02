//! Shell apps column helpers (MVP terminal + directory listing).

use serde::Serialize;
use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

const MAX_OUTPUT_CHARS: usize = 48_000;
const DEFAULT_TIMEOUT_MS: u64 = 12_000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppsShellResult {
    pub ok: bool,
    pub code: Option<i32>,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
    pub elapsed_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppsDirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

fn truncate(s: String) -> String {
    if s.chars().count() <= MAX_OUTPUT_CHARS {
        return s;
    }
    let kept: String = s.chars().take(MAX_OUTPUT_CHARS).collect();
    format!("{kept}\n…(truncated)")
}

const MAX_PIPE_BYTES: usize = 256 * 1024;

/// Keep the first `max_bytes` and drop the pipe. Closing it unblocks a writer
/// that would otherwise fill the OS buffer and hang `wait`.
fn read_capped(mut pipe: impl Read, max_bytes: usize) -> (String, bool) {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 8192];
    let mut truncated = false;
    loop {
        match pipe.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => {
                if buf.len() >= max_bytes {
                    truncated = true;
                    break;
                }
                let room = max_bytes - buf.len();
                if n > room {
                    buf.extend_from_slice(&tmp[..room]);
                    truncated = true;
                    break;
                }
                buf.extend_from_slice(&tmp[..n]);
            }
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    (String::from_utf8_lossy(&buf).into_owned(), truncated)
}

fn read_pipe(pipe: impl Read + Send + 'static) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let (text, truncated) = read_capped(pipe, MAX_PIPE_BYTES);
        if truncated {
            format!("{text}\n…(truncated)")
        } else {
            text
        }
    })
}

fn join_output(handle: thread::JoinHandle<String>, wait: Duration) -> String {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let _ = tx.send(handle.join().unwrap_or_default());
    });
    rx.recv_timeout(wait).unwrap_or_default()
}

/// One-shot PowerShell command for the apps Terminal pane (not an interactive PTY).
#[tauri::command]
pub fn apps_run_shell(command: String) -> Result<AppsShellResult, String> {
    let cmd = command.trim();
    if cmd.is_empty() {
        return Err("命令为空".into());
    }
    if cmd.len() > 8_000 {
        return Err("命令过长".into());
    }

    let started = Instant::now();
    let mut child = Command::new("powershell")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            cmd,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .spawn()
        .map_err(|e| format!("启动 PowerShell 失败: {e}"))?;

    let pid = child.id();
    let stdout_h = child
        .stdout
        .take()
        .map(read_pipe)
        .ok_or_else(|| "无法捕获 stdout".to_string())?;
    let stderr_h = child
        .stderr
        .take()
        .map(read_pipe)
        .ok_or_else(|| "无法捕获 stderr".to_string())?;

    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let status = child.wait();
        let _ = tx.send(status);
    });

    match rx.recv_timeout(Duration::from_millis(DEFAULT_TIMEOUT_MS)) {
        Ok(Ok(status)) => {
            let stdout = truncate(join_output(stdout_h, Duration::from_secs(2)));
            let stderr = truncate(join_output(stderr_h, Duration::from_secs(2)));
            Ok(AppsShellResult {
                ok: status.success(),
                code: status.code(),
                stdout,
                stderr,
                timed_out: false,
                elapsed_ms: started.elapsed().as_millis() as u64,
            })
        }
        Ok(Err(e)) => Err(format!("等待进程失败: {e}")),
        Err(_) => {
            let _ = Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid.to_string()])
                .output();
            let _ = rx.recv_timeout(Duration::from_millis(800));
            Ok(AppsShellResult {
                ok: false,
                code: None,
                stdout: truncate(join_output(stdout_h, Duration::from_millis(1500))),
                stderr: format!(
                    "{}\n超时（{DEFAULT_TIMEOUT_MS}ms）",
                    truncate(join_output(stderr_h, Duration::from_millis(1500)))
                ),
                timed_out: true,
                elapsed_ms: started.elapsed().as_millis() as u64,
            })
        }
    }
}

#[tauri::command]
pub fn apps_list_dir(path: String) -> Result<Vec<AppsDirEntry>, String> {
    let p = std::path::Path::new(path.trim());
    if !p.is_dir() {
        return Err("不是目录".into());
    }
    let mut out = Vec::new();
    let rd = std::fs::read_dir(p).map_err(|e| e.to_string())?;
    for ent in rd.flatten() {
        let name = ent.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let meta = ent.metadata().ok();
        let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        out.push(AppsDirEntry {
            name,
            path: ent.path().to_string_lossy().into_owned(),
            is_dir,
        });
        if out.len() >= 400 {
            break;
        }
    }
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::read_capped;
    use std::io::Cursor;

    #[test]
    fn capped_read_stops_before_the_rest_of_the_stream() {
        let data = vec![b'a'; 100];
        let (text, truncated) = read_capped(Cursor::new(data), 16);
        assert!(truncated);
        assert_eq!(text.len(), 16);
        assert!(text.chars().all(|c| c == 'a'));
    }

    #[test]
    fn short_read_is_not_truncated() {
        let (text, truncated) = read_capped(Cursor::new(b"ok".to_vec()), 16);
        assert!(!truncated);
        assert_eq!(text, "ok");
    }
}
