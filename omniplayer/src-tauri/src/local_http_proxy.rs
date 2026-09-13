//! LiteLLM sidecar 本机 HTTP 代理探测与偏好。
//!
//! 壳 WebView 始终直连（见 `webview_loopback`）。这里影响 sidecar 上游
//! 以及按服务商卡片开关的模型发现 / 测试 reqwest（对话 sidecar 仍读 network.json，由卡片 OR 写回）。
//!
//! 探测（不读密钥、不改 Clash 配置）：
//! - Clash Verge Rev 数据目录 yaml 的 mixed-port（若端口在听）
//! - 常见 Clash mixed：7897 / 7890 / 7891
//! - Windows 系统代理（WinINET）且主机为环回
//! - 其它**已在听**的常见本地 HTTP 端口：10809（v2rayN HTTP）、20171、6152
//! - 命名管道 `\\.\pipe\verge-mihomo` 仅作「Clash 在跑」提示（不发 HTTP、不用 secret）
//!
//! 不能枚举世上所有代理软件；不把 1080/10808 等 SOCKS 口写成 HTTP_PROXY。

use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use crate::notes_paths::sidecar_network_path;

const PROBE_MS: u64 = 80;
const CLASH_MIXED_PORTS: [u16; 3] = [7897, 7890, 7891];
/// 仅 HTTP 代理口。10808 多为 v2rayN SOCKS，不用作 HTTP_PROXY。
const OTHER_LOCAL_HTTP_PORTS: [(u16, &'static str); 3] = [
    (10809, "v2rayN HTTP"),
    (20171, "本机 HTTP"),
    (6152, "本机 HTTP"),
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SidecarNetworkSettings {
    #[serde(default = "network_settings_v")]
    pub v: u32,
    /// true：sidecar 与模型发现 reqwest 走探测到的本机 HTTP 代理；false：直连。
    /// 无 network.json 时默认 true：有 Clash 则 Google 能通，没有探测到仍直连。
    #[serde(default = "default_use_local_http_proxy")]
    pub use_local_http_proxy: bool,
}

fn default_use_local_http_proxy() -> bool {
    true
}

fn network_settings_v() -> u32 {
    1
}

impl Default for SidecarNetworkSettings {
    fn default() -> Self {
        Self {
            v: 1,
            use_local_http_proxy: true,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct DetectedLocalProxy {
    pub found: bool,
    pub url: Option<String>,
    pub source: String,
    pub label: String,
    pub clash_pipe: bool,
    pub tun_enabled: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct SidecarNetworkState {
    pub settings: SidecarNetworkSettings,
    pub detected: DetectedLocalProxy,
}

fn port_open(port: u16) -> bool {
    TcpStream::connect_timeout(
        &format!("127.0.0.1:{port}").parse().unwrap(),
        Duration::from_millis(PROBE_MS),
    )
    .is_ok()
}

fn is_loopback_host(host: &str) -> bool {
    let h = host
        .trim()
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_ascii_lowercase();
    h == "localhost" || h == "::1" || h == "127.0.0.1" || h.starts_with("127.")
}

fn clash_verge_dir() -> Option<PathBuf> {
    let appdata = std::env::var_os("APPDATA")?;
    let p = PathBuf::from(appdata).join("io.github.clash-verge-rev.clash-verge-rev");
    p.is_dir().then_some(p)
}

fn yaml_key_u16(text: &str, key: &str) -> Option<u16> {
    let prefix = format!("{key}:");
    for line in text.lines() {
        let t = line.trim();
        let Some(rest) = t.strip_prefix(&prefix) else {
            continue;
        };
        let rest = rest.split('#').next().unwrap_or("").trim();
        if let Ok(n) = rest.parse::<u16>() {
            if n > 0 {
                return Some(n);
            }
        }
    }
    None
}

fn yaml_key_bool(text: &str, key: &str) -> Option<bool> {
    let prefix = format!("{key}:");
    for line in text.lines() {
        let t = line.trim();
        let Some(rest) = t.strip_prefix(&prefix) else {
            continue;
        };
        let rest = rest.split('#').next().unwrap_or("").trim().to_ascii_lowercase();
        return match rest.as_str() {
            "true" | "yes" | "on" => Some(true),
            "false" | "no" | "off" => Some(false),
            _ => None,
        };
    }
    None
}

fn clash_mixed_port_from_files() -> Option<u16> {
    let dir = clash_verge_dir()?;
    for name in ["clash-verge.yaml", "config.yaml", "verge.yaml"] {
        let Ok(raw) = std::fs::read_to_string(dir.join(name)) else {
            continue;
        };
        if let Some(p) = yaml_key_u16(&raw, "mixed-port")
            .or_else(|| yaml_key_u16(&raw, "verge_mixed_port"))
        {
            return Some(p);
        }
    }
    None
}

fn clash_tun_enabled() -> bool {
    let Some(dir) = clash_verge_dir() else {
        return false;
    };
    if let Ok(raw) = std::fs::read_to_string(dir.join("verge.yaml")) {
        if yaml_key_bool(&raw, "enable_tun_mode") == Some(true) {
            return true;
        }
    }
    if let Ok(raw) = std::fs::read_to_string(dir.join("clash-verge.yaml")) {
        // 运行配置里 tun.enable；行扫描够用，不引入 yaml crate
        let mut in_tun = false;
        for line in raw.lines() {
            let t = line.trim();
            if t.starts_with("tun:") {
                in_tun = true;
                continue;
            }
            if in_tun {
                if !line.starts_with(' ') && !line.starts_with('\t') && !t.is_empty() {
                    in_tun = false;
                    continue;
                }
                if let Some(rest) = t.strip_prefix("enable:") {
                    let v = rest.split('#').next().unwrap_or("").trim().to_ascii_lowercase();
                    return v == "true" || v == "yes" || v == "on";
                }
            }
        }
    }
    false
}

/// 列 `\\.\pipe\`，不 Connect、不带 secret。
fn clash_verge_pipe_up() -> bool {
    #[cfg(windows)]
    {
        let Ok(rd) = std::fs::read_dir(r"\\.\pipe\") else {
            return false;
        };
        rd.flatten().any(|e| {
            let name = e.file_name();
            let n = name.to_string_lossy();
            n == "verge-mihomo" || n == "clash-verge-service"
        })
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg(windows)]
fn read_hkcu_dword(sub: &str, name: &str) -> Option<u32> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY_CURRENT_USER, KEY_READ, REG_DWORD,
        REG_VALUE_TYPE,
    };
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

#[cfg(windows)]
fn read_hkcu_sz(sub: &str, name: &str) -> Option<String> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY_CURRENT_USER, KEY_READ, REG_SZ,
        REG_VALUE_TYPE,
    };
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
        let name_w: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let mut kind = REG_VALUE_TYPE(0);
        let mut size = 0u32;
        let _ = RegQueryValueExW(
            hkey,
            PCWSTR(name_w.as_ptr()),
            None,
            Some(&mut kind),
            None,
            Some(&mut size),
        );
        if size == 0 {
            let _ = RegCloseKey(hkey);
            return None;
        }
        let mut buf = vec![0u8; size as usize];
        let ok = RegQueryValueExW(
            hkey,
            PCWSTR(name_w.as_ptr()),
            None,
            Some(&mut kind),
            Some(buf.as_mut_ptr()),
            Some(&mut size),
        );
        let _ = RegCloseKey(hkey);
        if ok != ERROR_SUCCESS || kind != REG_SZ {
            return None;
        }
        let u16s: Vec<u16> = buf
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .take_while(|c| *c != 0)
            .collect();
        String::from_utf16(&u16s).ok()
    }
}

fn parse_wininet_http_proxy(server: &str) -> Option<(String, u16)> {
    let parts: Vec<&str> = if server.contains('=') {
        server
            .split(';')
            .filter_map(|part| {
                let part = part.trim();
                let (k, v) = part.split_once('=')?;
                let k = k.trim().to_ascii_lowercase();
                if k == "http" || k == "https" {
                    Some(v.trim())
                } else {
                    None
                }
            })
            .collect()
    } else {
        vec![server.trim()]
    };
    for raw in parts {
        let raw = raw
            .trim()
            .trim_start_matches("http://")
            .trim_start_matches("https://");
        let (host, port_s) = raw.rsplit_once(':')?;
        let host = host.trim().trim_start_matches('[').trim_end_matches(']');
        if !is_loopback_host(host) {
            continue;
        }
        let port: u16 = port_s.trim().parse().ok()?;
        if port > 0 {
            return Some((host.to_string(), port));
        }
    }
    None
}

#[cfg(windows)]
fn windows_loopback_system_proxy() -> Option<(String, u16)> {
    const SUB: &str = r"Software\Microsoft\Windows\CurrentVersion\Internet Settings";
    if read_hkcu_dword(SUB, "ProxyEnable") != Some(1) {
        return None;
    }
    let server = read_hkcu_sz(SUB, "ProxyServer")?;
    parse_wininet_http_proxy(&server)
}

#[cfg(not(windows))]
fn windows_loopback_system_proxy() -> Option<(String, u16)> {
    None
}

fn http_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

pub fn detect_local_http_proxy() -> DetectedLocalProxy {
    let clash_pipe = clash_verge_pipe_up();
    let tun_enabled = clash_tun_enabled();
    let mut tried: HashSet<u16> = HashSet::new();

    let clash_hit = |port: u16| DetectedLocalProxy {
        found: true,
        url: Some(http_url(port)),
        source: "clash_mixed".into(),
        label: format!("Clash mixed {port}"),
        clash_pipe,
        tun_enabled,
    };

    if let Some(port) = clash_mixed_port_from_files() {
        tried.insert(port);
        if port_open(port) {
            return clash_hit(port);
        }
    }
    for port in CLASH_MIXED_PORTS {
        if !tried.insert(port) {
            continue;
        }
        if port_open(port) {
            return clash_hit(port);
        }
    }

    if let Some((_host, port)) = windows_loopback_system_proxy() {
        if tried.insert(port) && port_open(port) {
            let label = if clash_pipe {
                format!("Clash mixed {port}")
            } else {
                format!("系统代理 127.0.0.1:{port}")
            };
            return DetectedLocalProxy {
                found: true,
                url: Some(http_url(port)),
                source: if clash_pipe {
                    "clash_mixed".into()
                } else {
                    "system_proxy".into()
                },
                label,
                clash_pipe,
                tun_enabled,
            };
        }
    }

    for (port, name) in OTHER_LOCAL_HTTP_PORTS {
        if !tried.insert(port) {
            continue;
        }
        if port_open(port) {
            return DetectedLocalProxy {
                found: true,
                url: Some(http_url(port)),
                source: "known_local".into(),
                label: format!("{name} {port}"),
                clash_pipe,
                tun_enabled,
            };
        }
    }

    let label = if clash_pipe {
        "Clash 在跑，但未检测到 mixed-port".into()
    } else {
        "未检测到".into()
    };
    DetectedLocalProxy {
        found: false,
        url: None,
        source: "none".into(),
        label,
        clash_pipe,
        tun_enabled,
    }
}

pub fn load_network_settings() -> SidecarNetworkSettings {
    let path = sidecar_network_path();
    let Ok(raw) = std::fs::read_to_string(&path) else {
        return SidecarNetworkSettings::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

pub fn save_network_settings(settings: &SidecarNetworkSettings) -> Result<(), String> {
    let path = sidecar_network_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut s = settings.clone();
    s.v = 1;
    let raw = serde_json::to_string_pretty(&s).map_err(|e| e.to_string())?;
    std::fs::write(&path, raw + "\n").map_err(|e| e.to_string())
}

pub fn network_state() -> SidecarNetworkState {
    SidecarNetworkState {
        settings: load_network_settings(),
        detected: detect_local_http_proxy(),
    }
}

fn clear_proxy_env(cmd: &mut Command) {
    for k in [
        "HTTP_PROXY",
        "HTTPS_PROXY",
        "ALL_PROXY",
        "http_proxy",
        "https_proxy",
        "all_proxy",
        "NO_PROXY",
        "no_proxy",
    ] {
        cmd.env_remove(k);
    }
}

/// 给打上游（Google / DeepSeek 等）的 reqwest 用；localhost sidecar 客户端不要调用。
pub fn configure_upstream_reqwest_enabled(
    builder: reqwest::ClientBuilder,
    use_proxy: bool,
) -> reqwest::ClientBuilder {
    if use_proxy {
        if let Some(url) = detect_local_http_proxy().url {
            if let Ok(p) = reqwest::Proxy::all(&url) {
                return builder.proxy(p);
            }
        }
    }
    builder.no_proxy()
}

pub fn configure_upstream_reqwest(builder: reqwest::ClientBuilder) -> reqwest::ClientBuilder {
    configure_upstream_reqwest_enabled(builder, load_network_settings().use_local_http_proxy)
}

/// OFF：直连。ON 且探测到环回 HTTP 代理：指向该 mixed-port。ON 但没探测到：仍直连。
pub fn apply_sidecar_network_env(cmd: &mut Command) {
    clear_proxy_env(cmd);
    let use_proxy = load_network_settings().use_local_http_proxy;
    if use_proxy {
        let det = detect_local_http_proxy();
        if let Some(proxy) = det.url {
            cmd.env("HTTP_PROXY", &proxy);
            cmd.env("HTTPS_PROXY", &proxy);
            cmd.env("http_proxy", &proxy);
            cmd.env("https_proxy", &proxy);
            cmd.env(
                "NO_PROXY",
                "localhost,127.0.0.1,::1,127.0.0.1:4000,127.0.0.1:4001",
            );
            cmd.env("no_proxy", "localhost,127.0.0.1,::1,127.0.0.1:4000,127.0.0.1:4001");
            return;
        }
    }
    cmd.env("HTTP_PROXY", "");
    cmd.env("HTTPS_PROXY", "");
    cmd.env("http_proxy", "");
    cmd.env("https_proxy", "");
    cmd.env("ALL_PROXY", "");
    cmd.env("NO_PROXY", "*");
    cmd.env("no_proxy", "*");
}

#[tauri::command]
pub fn notes_sidecar_network_get() -> Result<SidecarNetworkState, String> {
    Ok(network_state())
}

#[tauri::command]
pub fn notes_sidecar_network_save(
    use_local_http_proxy: bool,
) -> Result<SidecarNetworkState, String> {
    let settings = SidecarNetworkSettings {
        v: 1,
        use_local_http_proxy,
    };
    save_network_settings(&settings)?;
    crate::llm_sidecar_ctl::restart_sidecar_for_network_change();
    Ok(network_state())
}
