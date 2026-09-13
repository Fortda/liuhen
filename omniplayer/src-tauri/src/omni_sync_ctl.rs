//! 局域网同步：OmniPlayer 暴露 `input_hist` 供手机睡眠猜测拉取。
//! 端口默认 3180，被占用则试 3181–3189；实际端口写入 control/omni_sync.json。

use crate::dashboard_ctl::{data_root, ensure_day_input_hist_file};
use crate::resolve_data_root;
use chrono::NaiveDate;
use serde_json::json;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicU16, Ordering};
use std::sync::Once;
use std::thread;
use std::time::Duration;

const PORT_BASE: u16 = 3180;
const PORT_LAST: u16 = 3189;

static START_ONCE: Once = Once::new();
static BOUND_PORT: AtomicU16 = AtomicU16::new(0);

pub fn ensure_running() {
    START_ONCE.call_once(|| {
        thread::spawn(|| {
            if let Err(e) = run_server() {
                eprintln!("omni_sync: {e}");
            }
        });
    });
}

pub fn bound_port() -> u16 {
    BOUND_PORT.load(Ordering::Relaxed)
}

#[tauri::command]
pub fn omni_sync_status() -> serde_json::Value {
    let port = bound_port();
    let ips = local_ipv4s();
    let hint = if port == 0 {
        "同步服务未启动或端口未绑定".to_string()
    } else if ips.is_empty() {
        format!("手机填本机局域网 IP，端口 {port}（如 192.168.x.x:{port}）")
    } else {
        format!(
            "手机填 {} （或其它局域网 IP）端口 {}",
            ips.iter()
                .map(|ip| format!("{ip}:{port}"))
                .collect::<Vec<_>>()
                .join(" / "),
            port
        )
    };
    json!({
        "port": port,
        "ips": ips,
        "hint": hint,
    })
}

fn run_server() -> std::io::Result<()> {
    let mut last_err = None;
    for port in PORT_BASE..=PORT_LAST {
        match TcpListener::bind(format!("0.0.0.0:{port}")) {
            Ok(listener) => {
                BOUND_PORT.store(port, Ordering::Relaxed);
                write_sync_meta(port);
                eprintln!("omni_sync listening on 0.0.0.0:{port}");
                for conn in listener.incoming() {
                    if let Ok(stream) = conn {
                        thread::spawn(move || {
                            let _ = handle_conn(stream);
                        });
                    }
                }
                return Ok(());
            }
            Err(e) => {
                last_err = Some(e);
            }
        }
    }
    Err(last_err.unwrap_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::AddrInUse, "omni_sync ports exhausted")
    }))
}

fn write_sync_meta(port: u16) {
    let root = resolve_data_root();
    let control = root.join("control");
    let _ = std::fs::create_dir_all(&control);
    let ips = local_ipv4s();
    let body = json!({
        "port": port,
        "ips": ips,
        "hint": format!("手机填局域网 IP，端口 {}", port),
    });
    let path = control.join("omni_sync.json");
    let _ = std::fs::write(path, body.to_string());
}

fn local_ipv4s() -> Vec<String> {
    use std::net::UdpSocket;
    let mut out = Vec::new();
    // 无第三方依赖：UDP「假连接」拿本机出站网卡地址
    if let Ok(sock) = UdpSocket::bind("0.0.0.0:0") {
        if sock.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = sock.local_addr() {
                if let std::net::IpAddr::V4(v4) = addr.ip() {
                    if !v4.is_loopback() {
                        out.push(v4.to_string());
                    }
                }
            }
        }
    }
    out
}

fn handle_conn(mut stream: TcpStream) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(120))).ok();
    let mut buf = [0u8; 4096];
    let n = stream.read(&mut buf)?;
    if n == 0 {
        return Ok(());
    }
    let req = String::from_utf8_lossy(&buf[..n]);
    let line = req.lines().next().unwrap_or("");
    let path = line.split_whitespace().nth(1).unwrap_or("/");
    if path.starts_with("/api/omni/ping") {
        let host = hostname();
        let port = bound_port();
        let body = json!({
            "ok": true,
            "hostname": host,
            "port": port,
            "ips": local_ipv4s(),
            "data_root": resolve_data_root().to_string_lossy(),
        })
        .to_string();
        write_json(&mut stream, &body)?;
    } else if let Some(date) = path.strip_prefix("/api/omni/input_hist/") {
        let date = date.trim_end_matches(".otih");
        let nd = NaiveDate::parse_from_str(date, "%Y-%m-%d").ok();
        if nd.is_none() {
            write_text(&mut stream, 404, "bad_date")?;
            return Ok(());
        }
        let day = nd.unwrap();
        let root = data_root();
        // 没有缓存则现生（电脑有录像但从未开过仪表盘时）
        let file = ensure_day_input_hist_file(&root, day);
        if !file.is_file() {
            write_text(&mut stream, 404, "no_hist")?;
            return Ok(());
        }
        let bytes = std::fs::read(&file)?;
        if bytes.is_empty() {
            write_text(&mut stream, 404, "empty_hist")?;
            return Ok(());
        }
        write_bytes(&mut stream, &bytes)?;
    } else {
        write_text(&mut stream, 404, "not found")?;
    }
    Ok(())
}

fn hostname() -> String {
    std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .unwrap_or_else(|_| "pc".into())
}

fn write_json(stream: &mut TcpStream, body: &str) -> std::io::Result<()> {
    let hdr = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\nAccess-Control-Allow-Origin: *\r\n\r\n",
        body.len()
    );
    stream.write_all(hdr.as_bytes())?;
    stream.write_all(body.as_bytes())?;
    Ok(())
}

fn write_text(stream: &mut TcpStream, code: u16, msg: &str) -> std::io::Result<()> {
    let status = if code == 404 { "Not Found" } else { "Error" };
    let body = msg;
    let hdr = format!(
        "HTTP/1.1 {code} {status}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(hdr.as_bytes())?;
    stream.write_all(body.as_bytes())?;
    Ok(())
}

fn write_bytes(stream: &mut TcpStream, body: &[u8]) -> std::io::Result<()> {
    let hdr = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(hdr.as_bytes())?;
    stream.write_all(body)?;
    Ok(())
}
