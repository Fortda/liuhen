//! LiteLLM 本地 sidecar：笔记页协议转发（OpenAI 兼容 /v1/chat/completions）。

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime};

use crate::notes_paths::{
    litellm_config_path, litellm_settings_path, notes_config_dir, providers_config_path,
};

pub const LLM_SIDECAR_PORT: u16 = 4000;
pub const LLM_SIDECAR_URL: &str = "http://127.0.0.1:4000";
const START_WAIT: Duration = Duration::from_secs(45);

struct SidecarState {
    child: Option<Child>,
    owned_pid: Option<u32>,
    config_mtime_loaded: Option<SystemTime>,
}

static SIDECAR: Mutex<SidecarState> = Mutex::new(SidecarState {
    child: None,
    owned_pid: None,
    config_mtime_loaded: None,
});

static RESOLVED_PYTHON: Mutex<Option<PathBuf>> = Mutex::new(None);

#[derive(Debug, Clone, Serialize)]
pub struct LlmSidecarStatus {
    pub url: String,
    pub listening: bool,
    pub owned: bool,
    pub pid: Option<u32>,
    pub message: String,
}


fn port_open_on(port: u16) -> bool {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}")
            .parse()
            .ok()
            .unwrap(),
        Duration::from_millis(500),
    )
    .is_ok()
}

pub(crate) fn apply_sidecar_network_env(cmd: &mut Command) {
    crate::local_http_proxy::apply_sidecar_network_env(cmd);
}

/// 参数窗切换「API 走本地代理」后重拉 sidecar，使 HTTP_PROXY 立即生效。
pub(crate) fn restart_sidecar_for_network_change() {
    if !sidecar_listening() {
        return;
    }
    stop_all_sidecar();
    let _ = llm_sidecar_ensure_running();
}

fn port_open() -> bool {
    port_open_on(LLM_SIDECAR_PORT)
}

pub fn sidecar_listening() -> bool {
    port_open()
}

fn find_python_candidates() -> Vec<PathBuf> {
    let mut out = Vec::new();
    // Prefer newer Pythons first (litellm 新版本在 3.10 上可能 import 失败)
    let extras = [
        r"C:\Users\fortd\AppData\Local\Programs\Python\Python313\python.exe",
        r"C:\Users\fortd\AppData\Local\Programs\Python\Python312\python.exe",
        r"C:\Users\fortd\AppData\Local\Programs\Python\Python311\python.exe",
        r"C:\Users\fortd\AppData\Local\Programs\Python\Python310\python.exe",
    ];
    for p in extras {
        let pb = PathBuf::from(p);
        if pb.is_file() {
            out.push(pb);
        }
    }
    for cmd in ["python", "python3", "py"] {
        let p = PathBuf::from(cmd);
        if Command::new(&p)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
        {
            out.push(p);
        }
    }
    // dedupe by resolved executable when possible
    let mut seen = std::collections::HashSet::new();
    out.retain(|p| {
        let key = python_executable(p);
        seen.insert(key)
    });
    out
}

pub(crate) fn resolve_python_with_litellm() -> Result<PathBuf, String> {
    if let Ok(guard) = RESOLVED_PYTHON.lock() {
        if let Some(py) = guard.as_ref() {
            if python_has_litellm(py) {
                return Ok(py.clone());
            }
        }
    }
    let candidates = find_python_candidates();
    if candidates.is_empty() {
        return Err(
            "找不到 Python。请安装 Python 3.11+，然后执行：python -m pip install litellm".into(),
        );
    }
    let mut tried = Vec::new();
    for py in &candidates {
        let (ok, detail) = python_litellm_probe(py);
        let exe = python_executable(py);
        if ok {
            if let Ok(mut guard) = RESOLVED_PYTHON.lock() {
                *guard = Some(py.clone());
            }
            return Ok(py.clone());
        }
        tried.push(format!("{exe} → {detail}"));
    }
    let first_exe = python_executable(&candidates[0]);
    Err(format!(
        "未找到可用的 litellm（含 proxy）。探测结果：\n{}\n建议（需代理 extras，不是只装 litellm）：\n  \"{}\" -m pip install \"litellm[proxy]==1.55.8\"\nPython 3.11+ 也可：\n  \"{}\" -m pip install \"litellm[proxy]\"\n然后重启 OmniPlayer。",
        tried.join("\n"),
        python_executable(
            &candidates
                .iter()
                .find(|p| python_executable(p).contains("Python310"))
                .cloned()
                .unwrap_or_else(|| candidates[0].clone())
        ),
        first_exe
    ))
}

fn python_executable(py: &PathBuf) -> String {
    Command::new(py)
        .args(["-c", "import sys; print(sys.executable)"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| py.display().to_string())
}

fn python_has_litellm(py: &PathBuf) -> bool {
    python_litellm_probe(py).0
}

fn python_litellm_probe(py: &PathBuf) -> (bool, String) {
    // 仅 import litellm 不够：sidecar 需要 proxy 额外依赖（backoff 等）
    let out = Command::new(py)
        .args([
            "-c",
            "import litellm,backoff; from litellm.proxy import proxy_cli; print(getattr(litellm,'__version__','ok'))",
        ])
        .output();
    match out {
        Ok(o) if o.status.success() => {
            let ver = String::from_utf8_lossy(&o.stdout).trim().to_string();
            (true, ver)
        }
        Ok(o) => {
            let err = String::from_utf8_lossy(&o.stderr).trim().to_string();
            let short = if err.len() > 220 {
                format!("{}…", &err[..220])
            } else if err.is_empty() {
                String::from_utf8_lossy(&o.stdout).trim().to_string()
            } else {
                err
            };
            (false, short)
        }
        Err(e) => (false, e.to_string()),
    }
}

fn sidecar_stderr_path() -> PathBuf {
    notes_config_dir().join("litellm_sidecar.stderr.log")
}

/// litellm 1.55.x 等版本没有 `python -m litellm`（无 `__main__`）。
/// 优先 Scripts/litellm.exe，否则 `python -m litellm.proxy.proxy_cli`。
fn litellm_cli_near(python: &PathBuf) -> Option<PathBuf> {
    let parent = python.parent()?;
    let win = parent.join("Scripts").join("litellm.exe");
    if win.is_file() {
        return Some(win);
    }
    let unix = parent.join("bin").join("litellm");
    if unix.is_file() {
        return Some(unix);
    }
    None
}

fn spawn_litellm(config: &PathBuf) -> Result<Child, String> {
    let py = resolve_python_with_litellm()?;
    let config_s = config.to_string_lossy().into_owned();
    let port_s = LLM_SIDECAR_PORT.to_string();
    let err_path = sidecar_stderr_path();
    if let Some(parent) = err_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let err_file = std::fs::File::create(&err_path)
        .map_err(|e| format!("无法写 sidecar stderr 日志: {e}"))?;

    let (mut cmd, _entry) = if let Some(cli) = litellm_cli_near(&py) {
        let mut c = Command::new(&cli);
        c.args([
            "--config",
            &config_s,
            "--port",
            &port_s,
            "--host",
            "127.0.0.1",
        ]);
        (c, format!("exe:{}", cli.display()))
    } else {
        let mut c = Command::new(&py);
        c.args([
            "-m",
            "litellm.proxy.proxy_cli",
            "--config",
            &config_s,
            "--port",
            &port_s,
            "--host",
            "127.0.0.1",
        ]);
        (c, format!("proxy_cli:{}", py.display()))
    };
    cmd.current_dir(notes_config_dir());
    // Windows 默认 GBK 读 yaml 会炸 UTF-8 注释；强制 UTF-8 模式
    cmd.env("PYTHONUTF8", "1");
    cmd.env("PYTHONIOENCODING", "utf-8");
    apply_sidecar_network_env(&mut cmd);
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::from(err_file));
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
        .map_err(|e| format!("启动 LiteLLM 失败: {e}（需 pip install litellm）"))
}

pub fn llm_sidecar_status() -> LlmSidecarStatus {
    let listening = sidecar_listening();
    let guard = SIDECAR.lock().ok();
    let (owned, pid) = guard
        .as_ref()
        .map(|g| (g.owned_pid.is_some(), g.owned_pid))
        .unwrap_or((false, None));
    let message = if listening {
        if owned {
            "LiteLLM 已在本机 4000 监听（本进程拉起）".into()
        } else {
            "LiteLLM 已在 4000 监听（已有实例）".into()
        }
    } else {
        "4000 无人监听".into()
    };
    LlmSidecarStatus {
        url: LLM_SIDECAR_URL.into(),
        listening,
        owned,
        pid,
        message,
    }
}

fn config_mtime() -> Option<SystemTime> {
    std::fs::metadata(litellm_config_path())
        .ok()
        .and_then(|m| m.modified().ok())
}

fn config_proxy_names() -> Vec<String> {
    let Ok(raw) = std::fs::read_to_string(litellm_config_path()) else {
        return Vec::new();
    };
    raw.lines()
        .filter_map(|line| {
            let t = line.trim();
            t.strip_prefix("- model_name:")
                .map(|name| name.trim().to_string())
        })
        .collect()
}

fn fetch_sidecar_model_ids() -> Option<Vec<String>> {
    let mut stream = TcpStream::connect_timeout(
        &format!("127.0.0.1:{LLM_SIDECAR_PORT}")
            .parse()
            .ok()?,
        Duration::from_millis(1200),
    )
    .ok()?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
    let req = format!(
        "GET /v1/models HTTP/1.1\r\nHost: 127.0.0.1:{LLM_SIDECAR_PORT}\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(req.as_bytes()).ok()?;
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    let body = text.split("\r\n\r\n").nth(1)?;
    let v: serde_json::Value = serde_json::from_str(body.trim()).ok()?;
    let ids = v
        .get("data")?
        .as_array()?
        .iter()
        .filter_map(|m| m.get("id").and_then(|x| x.as_str()).map(str::to_string))
        .collect();
    Some(ids)
}

fn sidecar_config_stale() -> bool {
    let expected = config_proxy_names();
    if expected.is_empty() {
        return false;
    }
    let Some(actual) = fetch_sidecar_model_ids() else {
        return true;
    };
    let actual_set: HashSet<String> = actual.into_iter().collect();
    let stale = !expected.iter().all(|name| actual_set.contains(name));
    stale
}

fn stop_all_sidecar() {
    stop_owned_silent();
    kill_process_listening_on_port(LLM_SIDECAR_PORT);
    for _ in 0..20 {
        if !port_open() {
            break;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    if let Ok(mut g) = SIDECAR.lock() {
        g.config_mtime_loaded = None;
    }
}

#[cfg(windows)]
fn kill_process_listening_on_port(port: u16) {
    let needle = format!(":{port}");
    let Ok(output) = Command::new("netstat").args(["-ano"]).output() else {
        return;
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let mut pids = HashSet::new();
    for line in text.lines() {
        if !line.contains("LISTENING") || !line.contains(&needle) {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if let Some(pid) = parts.last() {
            if pid.chars().all(|c| c.is_ascii_digit()) {
                pids.insert(pid.to_string());
            }
        }
    }
    for pid in pids {
        let _ = Command::new("taskkill")
            .args(["/F", "/PID", &pid])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
}

#[cfg(not(windows))]
fn kill_process_listening_on_port(_port: u16) {}

fn sidecar_config_mtime_changed() -> bool {
    let Ok(g) = SIDECAR.lock() else {
        return true;
    };
    match (g.config_mtime_loaded, config_mtime()) {
        (Some(loaded), Some(now)) => loaded != now,
        (None, Some(_)) => true,
        _ => false,
    }
}

pub fn reload_sidecar_after_config_change() -> Result<(), String> {
    if !litellm_config_path().is_file() {
        return Ok(());
    }
    let need =
        !sidecar_listening() || sidecar_config_stale() || sidecar_config_mtime_changed();
    if !need {
        return Ok(());
    }
    if sidecar_listening() {
        stop_all_sidecar();
    }
    llm_sidecar_ensure_running().map(|_| ())
}

fn read_stderr_tail(max_chars: usize) -> String {
    let path = sidecar_stderr_path();
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return String::new();
    };
    if raw.len() <= max_chars {
        return raw;
    }
    raw[raw.len() - max_chars..].to_string()
}

pub fn llm_sidecar_ensure_running() -> Result<LlmSidecarStatus, String> {
    // 生成器代码可能已变（如 Google 去掉 api_base）；启动前按 providers 同步 yaml。
    // 内容不变则不写盘，避免无谓重启。
    let yaml_rewritten = if providers_config_path().is_file() {
        match rewrite_litellm_config_from_disk() {
            Ok(changed) => changed,
            Err(e) => {
                eprintln!("rewrite litellm_config before ensure: {e}");
                false
            }
        }
    } else {
        false
    };
    if sidecar_listening() {
        if yaml_rewritten || sidecar_config_stale() {
            stop_all_sidecar();
        } else {
            return Ok(llm_sidecar_status());
        }
    }
    let config = litellm_config_path();
    if !config.is_file() {
        return Err(format!(
            "缺少 {}。请先在笔记设置里添加 LLM API。",
            config.display()
        ));
    }
    let child = spawn_litellm(&config)?;
    let pid = child.id();
    {
        let mut g = SIDECAR
            .lock()
            .map_err(|_| "sidecar lock poisoned".to_string())?;
        g.child = Some(child);
        g.owned_pid = Some(pid);
        g.config_mtime_loaded = config_mtime();
    }
    let deadline = Instant::now() + START_WAIT;
    let mut last_exit: Option<i32> = None;
    while Instant::now() < deadline {
        if sidecar_listening() {
            return Ok(LlmSidecarStatus {
                url: LLM_SIDECAR_URL.into(),
                listening: true,
                owned: true,
                pid: Some(pid),
                message: format!("已拉起 LiteLLM（PID {pid}）"),
            });
        }
        if let Ok(mut g) = SIDECAR.lock() {
            if let Some(ch) = g.child.as_mut() {
                if let Ok(Some(status)) = ch.try_wait() {
                    last_exit = status.code();
                    break;
                }
            }
        }
        std::thread::sleep(Duration::from_millis(400));
    }
    let stderr_tail = read_stderr_tail(1200);
    if let Some(code) = last_exit {
        return Err(format!(
            "LiteLLM 进程已退出（PID {pid}，code {code}）。stderr：{}",
            if stderr_tail.trim().is_empty() {
                "（空）请确认 pip install litellm"
            } else {
                stderr_tail.trim()
            }
        ));
    }
    Err(format!(
        "已启动 LiteLLM（PID {pid}）但 {START_WAIT:?} 内 4000 仍无响应。stderr：{} | 配置：{}",
        if stderr_tail.trim().is_empty() {
            "（空）"
        } else {
            stderr_tail.trim()
        },
        config.display()
    ))
}

pub fn stop_owned_silent() {
    let mut g = match SIDECAR.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if let Some(mut child) = g.child.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
    g.owned_pid = None;
    g.config_mtime_loaded = None;
}

/// 从 providers.json 生成 LiteLLM proxy config（供 sidecar 读）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LitellmSettings {
    #[serde(default = "litellm_settings_v")]
    pub v: u32,
    #[serde(default = "default_true")]
    pub drop_params: bool,
    #[serde(default = "default_num_retries")]
    pub num_retries: u32,
    #[serde(default = "default_request_timeout")]
    pub request_timeout: u32,
    #[serde(default = "default_allowed_fails")]
    pub allowed_fails: u32,
    #[serde(default = "default_cooldown_time")]
    pub cooldown_time: u32,
}

fn litellm_settings_v() -> u32 {
    1
}
fn default_true() -> bool {
    true
}
fn default_num_retries() -> u32 {
    2
}
fn default_request_timeout() -> u32 {
    600
}
fn default_allowed_fails() -> u32 {
    3
}
fn default_cooldown_time() -> u32 {
    60
}

impl Default for LitellmSettings {
    fn default() -> Self {
        Self {
            v: 1,
            drop_params: true,
            num_retries: 2,
            request_timeout: 600,
            allowed_fails: 3,
            cooldown_time: 60,
        }
    }
}

pub fn load_litellm_settings() -> LitellmSettings {
    let path = litellm_settings_path();
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return LitellmSettings::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

pub fn save_litellm_settings(settings: &LitellmSettings) -> Result<(), String> {
    let path = litellm_settings_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let raw = serde_json::to_string_pretty(settings).map_err(|e| e.to_string())?;
    std::fs::write(&path, raw + "\n").map_err(|e| e.to_string())
}

fn append_litellm_settings_yaml(lines: &mut Vec<String>, s: &LitellmSettings) {
    lines.push(String::new());
    lines.push("litellm_settings:".into());
    lines.push(format!("  drop_params: {}", if s.drop_params { "true" } else { "false" }));
    lines.push(format!("  num_retries: {}", s.num_retries));
    lines.push(format!("  request_timeout: {}", s.request_timeout));
    lines.push(String::new());
    lines.push("router_settings:".into());
    lines.push(format!("  allowed_fails: {}", s.allowed_fails));
    lines.push(format!("  cooldown_time: {}", s.cooldown_time));
}

/// Returns true if the on-disk yaml file was rewritten (content differed).
pub fn write_litellm_config_from_providers(providers_json: &str) -> Result<bool, String> {
    let v: serde_json::Value = serde_json::from_str(providers_json).map_err(|e| e.to_string())?;
    let providers = v
        .get("providers")
        .and_then(|p| p.as_array())
        .ok_or("providers.json 缺少 providers 数组")?;
    let mut lines: Vec<String> = vec![
        "# generated by OmniPlayer notes - do not commit".into(),
        "model_list:".into(),
    ];
    for p in providers {
        let pid = p.get("id").and_then(|x| x.as_str()).unwrap_or("");
        let api_base = p.get("api_base").and_then(|x| x.as_str()).unwrap_or("");
        let api_key = p.get("api_key").and_then(|x| x.as_str()).unwrap_or("");
        let kind = p
            .get("vendor")
            .or_else(|| p.get("kind"))
            .and_then(|x| x.as_str())
            .unwrap_or("openai");
        let litellm_vendor = crate::notes_vendor::litellm_prefix(kind);
        let models = p.get("models").and_then(|x| x.as_array());
        let Some(models) = models else { continue };
        for m in models {
            let mid = m.get("id").and_then(|x| x.as_str()).unwrap_or("");
            let litellm = m
                .get("litellm_model")
                .and_then(|x| x.as_str())
                .unwrap_or(mid);
            let proxy_name = format!("{pid}__{mid}");
            let full_model = if litellm.contains('/') {
                litellm.to_string()
            } else {
                format!("{litellm_vendor}/{litellm}")
            };
            lines.push(format!("  - model_name: {proxy_name}"));
            lines.push("    litellm_params:".into());
            lines.push(format!("      model: {full_model}"));
            if !api_key.is_empty() {
                lines.push(format!("      api_key: {api_key}"));
            }
            // Google AI Studio：强制 gemini 供应商，勿写 generativelanguage api_base。
            // 写 api_base=…/v1beta 时 LiteLLM 会拼成 v1beta:streamGenerateContent → 404 VertexAIException。
            if litellm_vendor == "gemini" {
                lines.push("      custom_llm_provider: gemini".into());
            } else if !api_base.is_empty() {
                lines.push(format!("      api_base: {api_base}"));
            }
        }
    }
    if lines.len() <= 2 {
        return Err("没有可用模型。请在笔记设置里至少添加一个 provider + model。".into());
    }
    append_litellm_settings_yaml(&mut lines, &load_litellm_settings());
    let path = litellm_config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let new_body = lines.join("\n") + "\n";
    let old_body = std::fs::read_to_string(&path).unwrap_or_default();
    let changed = old_body != new_body;
    if changed {
        std::fs::write(&path, new_body).map_err(|e| e.to_string())?;
    }
    Ok(changed)
}

/// 仅根据当前 providers.json + litellm_settings.json 重写 yaml（settings 变更时用）。
/// Returns true if yaml content changed on disk.
pub fn rewrite_litellm_config_from_disk() -> Result<bool, String> {
    let path = providers_config_path();
    let raw = std::fs::read_to_string(&path).map_err(|e| {
        format!(
            "读取 providers.json 失败（{}）：{}",
            path.display(),
            e
        )
    })?;
    write_litellm_config_from_providers(&raw)
}

#[tauri::command]
pub fn notes_litellm_settings_get() -> Result<LitellmSettings, String> {
    Ok(load_litellm_settings())
}

#[tauri::command]
pub fn notes_litellm_settings_save(settings: LitellmSettings) -> Result<LitellmSettings, String> {
    let mut s = settings;
    s.v = 1;
    save_litellm_settings(&s)?;
    // providers 可能尚未配置：只落 json，yaml 有则重写
    if providers_config_path().is_file() {
        match rewrite_litellm_config_from_disk() {
            Ok(_changed) => {
                let _ = reload_sidecar_after_config_change();
            }
            Err(e) => {
                // settings 已保存；yaml 失败时仍返回 settings，附带日志语义由前端 toast 可选
                eprintln!("rewrite litellm_config after settings save: {e}");
            }
        }
    }
    Ok(load_litellm_settings())
}
