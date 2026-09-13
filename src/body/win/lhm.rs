//! LibreHardwareMonitor Report API：本机若开了 http://127.0.0.1:8085/data.json 则抽数字通道。
//! 不随包装驱动；超时 100ms；禁止把整份 JSON 落盘。

use crate::body::quantize::{quantize, FAN_RPM_STEP, TEMP_C_STEP, WATT_STEP};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_millis(100);
const MAX_BODY: usize = 256 * 1024;
const MAX_SENSORS: usize = 24;

pub fn probe_present() -> bool {
    sample_compact().is_some()
}

pub fn sample_compact() -> Option<Value> {
    let raw = http_get_local(8085, "/data.json")?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    let mut sensors = Vec::new();
    walk(&v, &mut Vec::new(), &mut sensors);
    if sensors.is_empty() {
        return None;
    }
    let mut sig_parts: Vec<String> = sensors
        .iter()
        .filter_map(|s| {
            let n = s.get("n")?.as_str()?;
            let t = s.get("t")?.as_str()?;
            let q = s.get("q")?.as_i64()?;
            Some(format!("{n}:{t}:{q}"))
        })
        .collect();
    sig_parts.sort();
    Some(json!({
        "sig": sig_parts.join("|"),
        "sensors": sensors
    }))
}

fn http_get_local(port: u16, path: &str) -> Option<String> {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let mut stream = TcpStream::connect_timeout(&addr, TIMEOUT).ok()?;
    stream.set_read_timeout(Some(TIMEOUT)).ok()?;
    stream.set_write_timeout(Some(TIMEOUT)).ok()?;
    let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    stream.write_all(req.as_bytes()).ok()?;
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    loop {
        match stream.read(&mut tmp) {
            Ok(0) => break,
            Ok(n) => {
                buf.extend_from_slice(&tmp[..n]);
                if buf.len() > MAX_BODY {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    let text = String::from_utf8_lossy(&buf);
    let idx = text.find("\r\n\r\n")?;
    let body = text[idx + 4..].to_string();
    if body.is_empty() {
        None
    } else {
        Some(body)
    }
}

fn walk(v: &Value, path: &mut Vec<String>, out: &mut Vec<Value>) {
    if out.len() >= MAX_SENSORS {
        return;
    }
    if let Some(obj) = v.as_object() {
        let text = obj
            .get("Text")
            .or_else(|| obj.get("text"))
            .and_then(|x| x.as_str())
            .unwrap_or("");
        let stype = obj
            .get("SensorType")
            .or_else(|| obj.get("Type"))
            .and_then(|x| x.as_str())
            .unwrap_or("");
        if let Some(val) = obj.get("Value").and_then(|x| x.as_f64()) {
            let kind = match stype {
                "Temperature" => Some(("temp", TEMP_C_STEP)),
                "Fan" => Some(("fan", FAN_RPM_STEP)),
                "Power" => Some(("power", WATT_STEP)),
                _ => None,
            };
            if let Some((t, step)) = kind {
                let q = quantize(val, step);
                out.push(json!({
                    "n": text,
                    "t": t,
                    "v": q as f64 * step,
                    "q": q
                }));
            }
        }
        if !text.is_empty() {
            path.push(text.to_string());
        }
        if let Some(children) = obj.get("Children").and_then(|c| c.as_array()) {
            for c in children {
                walk(c, path, out);
            }
        }
        if !text.is_empty() {
            path.pop();
        }
    }
}
