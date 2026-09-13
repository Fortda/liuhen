//! 按 API Key 从各厂商拉取可用模型列表（异步，可上报进度）。

use reqwest::Client;
use serde_json::Value;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

use crate::llm_sidecar_ctl::LLM_SIDECAR_URL;
use crate::notes_ctl::{NotesProvider, NotesProviderModel};
use crate::notes_paths::notes_config_dir;
use crate::notes_vendor::{litellm_prefix, normalize_vendor, vendor_preset};

const DISCOVER_PORT: u16 = 4001;
const DISCOVER_URL: &str = "http://127.0.0.1:4001";
const CONNECT_TIMEOUT: Duration = Duration::from_secs(12);
const REQUEST_TIMEOUT: Duration = Duration::from_secs(25);

const ANTHROPIC_CURATED: &[&str] = &[
    "claude-sonnet-4-20250514",
    "claude-3-7-sonnet-latest",
    "claude-3-5-sonnet-latest",
    "claude-3-5-haiku-latest",
    "claude-3-opus-latest",
    "claude-3-haiku-20240307",
];

#[derive(Clone)]
pub struct ProgressSink {
    app: AppHandle,
    op: String,
}

impl ProgressSink {
    pub fn new(app: AppHandle, op: impl Into<String>) -> Self {
        Self {
            app,
            op: op.into(),
        }
    }

    pub fn emit(&self, step: &str, message: &str, progress: u32) {
        let _ = self.app.emit(
            "notes-progress",
            serde_json::json!({
                "op": self.op,
                "step": step,
                "message": message,
                "progress": progress.min(100),
                "done": false,
                "error": null,
            }),
        );
    }

    pub fn done_ok(&self, message: &str) {
        let _ = self.app.emit(
            "notes-progress",
            serde_json::json!({
                "op": self.op,
                "step": "done",
                "message": message,
                "progress": 100,
                "done": true,
                "error": null,
            }),
        );
    }

    pub fn done_err(&self, message: &str) {
        let _ = self.app.emit(
            "notes-progress",
            serde_json::json!({
                "op": self.op,
                "step": "error",
                "message": message,
                "progress": 100,
                "done": true,
                "error": message,
            }),
        );
    }
}

fn http_client(use_proxy: bool) -> Result<Client, String> {
    crate::local_http_proxy::configure_upstream_reqwest_enabled(
        Client::builder()
            .connect_timeout(CONNECT_TIMEOUT)
            .timeout(REQUEST_TIMEOUT),
        use_proxy,
    )
    .build()
    .map_err(|e| e.to_string())
}

pub async fn discover_models_for_provider(
    prov: &NotesProvider,
    sink: Option<&ProgressSink>,
) -> Result<Vec<NotesProviderModel>, String> {
    if prov.api_key.trim().is_empty() {
        return Err("请先填写 API Key".into());
    }
    validate_provider_api_key(&prov.vendor, &prov.api_key)?;
    let vendor = normalize_vendor(&prov.vendor);
    let label = if prov.label.trim().is_empty() {
        vendor.clone()
    } else {
        prov.label.clone()
    };
    if let Some(s) = sink {
        s.emit(
            "discover_start",
            &format!("开始发现 {label}（{vendor}）可用模型…"),
            5,
        );
    }
    let result = match vendor.as_str() {
        "openai" | "deepseek" | "relay" => {
            discover_openai_compatible(prov, &vendor, sink).await
        }
        "google" => discover_google(prov, sink).await,
        "anthropic" => discover_anthropic(prov, sink).await,
        other => Err(format!("不支持的服务商: {other}")),
    };
    match &result {
        Ok(models) => {
            if let Some(s) = sink {
                s.emit(
                    "discover_ok",
                    &format!("{label}：发现 {} 个模型", models.len()),
                    90,
                );
            }
        }
        Err(e) => {
            if let Some(s) = sink {
                s.emit("discover_err", &format!("{label}：{e}"), 90);
            }
        }
    }
    result
}

fn make_model(id: &str, litellm_model: &str) -> NotesProviderModel {
    NotesProviderModel {
        id: id.to_string(),
        label: id.to_string(),
        litellm_model: litellm_model.to_string(),
    }
}

/// reqwest 错误常把完整 URL（含 key）打进字符串；脱敏后再给 UI。
fn sanitize_reqwest_err(e: &reqwest::Error) -> String {
    let mut s = e.to_string();
    if let Some(url) = e.url() {
        let raw = url.as_str();
        let safe = if let Some((base, _)) = raw.split_once('?') {
            format!("{base}?[redacted]")
        } else {
            raw.to_string()
        };
        s = s.replace(raw, &safe);
    }
    truncate_chars(&s, 280)
}

fn truncate_chars(s: &str, max: usize) -> String {
    let count = s.chars().count();
    if count <= max {
        return s.to_string();
    }
    format!("{}…(已截断)", s.chars().take(max).collect::<String>())
}

fn redact_secrets(s: &str, secrets: &[&str]) -> String {
    let mut out = s.to_string();
    for secret in secrets {
        let secret = secret.trim();
        if secret.len() >= 8 {
            out = out.replace(secret, "[redacted]");
        }
    }
    out
}

fn strip_utf8_bom(raw: &[u8]) -> &[u8] {
    if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        &raw[3..]
    } else {
        raw
    }
}

fn preview_http_body(raw: &[u8], secrets: &[&str]) -> String {
    let text = String::from_utf8_lossy(strip_utf8_bom(raw));
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    truncate_chars(&redact_secrets(&collapsed, secrets), 240)
}

fn body_kind_label(raw: &[u8], content_type: &str) -> &'static str {
    let ct = content_type.to_ascii_lowercase();
    let head = String::from_utf8_lossy(strip_utf8_bom(raw))
        .trim_start()
        .chars()
        .take(32)
        .collect::<String>()
        .to_ascii_lowercase();
    if ct.contains("text/html") || head.starts_with("<!doctype") || head.starts_with("<html") {
        "HTML"
    } else if ct.contains("text/event-stream") || head.starts_with("data:") {
        "SSE"
    } else if ct.contains("json") || head.starts_with('{') || head.starts_with('[') {
        "JSON"
    } else {
        "非 JSON"
    }
}

fn format_http_payload(
    method: &str,
    url: &str,
    status: u16,
    content_type: &str,
    raw: &[u8],
    secrets: &[&str],
) -> String {
    let ct = if content_type.trim().is_empty() {
        "unknown"
    } else {
        content_type
    };
    let kind = body_kind_label(raw, content_type);
    format!(
        "{method} {url} · HTTP {status} · Content-Type {ct} · {kind}：{}",
        preview_http_body(raw, secrets)
    )
}

async fn response_meta_bytes(
    resp: reqwest::Response,
) -> Result<(u16, String, Vec<u8>), String> {
    let status = resp.status().as_u16();
    let ct = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let raw = resp
        .bytes()
        .await
        .map_err(|e| sanitize_reqwest_err(&e))?
        .to_vec();
    Ok((status, ct, raw))
}

fn json_from_bytes(
    raw: &[u8],
    method: &str,
    url: &str,
    status: u16,
    content_type: &str,
    secrets: &[&str],
) -> Result<Value, String> {
    match serde_json::from_slice::<Value>(strip_utf8_bom(raw)) {
        Ok(v) => Ok(v),
        Err(e) => Err(format!(
            "{}（serde: {e}）",
            format_http_payload(method, url, status, content_type, raw, secrets)
        )),
    }
}

fn openai_error_message(body: &Value) -> Option<String> {
    let err = body.get("error")?;
    if let Some(s) = err.as_str() {
        let t = s.trim();
        if t.is_empty() {
            return None;
        }
        return Some(t.to_string());
    }
    if let Some(msg) = err.get("message").and_then(|v| v.as_str()) {
        let t = msg.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    Some(err.to_string())
}

fn looks_like_shell_paste(key: &str) -> bool {
    let k = key.trim();
    k.len() > 200
        || k.contains("npm run")
        || k.contains("cargo ")
        || k.contains("PS E:")
        || k.contains("BeforeDevCommand")
        || k.contains("Port 1420")
}

pub fn validate_provider_api_key(vendor: &str, api_key: &str) -> Result<(), String> {
    let key = api_key.trim();
    if key.is_empty() {
        return Ok(());
    }
    if looks_like_shell_paste(key) {
        return Err(
            "API Key 看起来像终端日志粘贴（过长或含 npm/cargo 输出）。请只粘贴服务商控制台里的密钥。".into(),
        );
    }
    if key.len() > 256 {
        return Err("API Key 过长（>256）。请检查是否误粘贴了其它内容。".into());
    }
    let v = normalize_vendor(vendor);
    if v == "google" && !(key.starts_with("AIza") || key.starts_with("ya29.")) {
        // 软提示：不硬拦，但常见 Google AI Studio key 以 AIza 开头
        // 仍允许其它格式（代理/企业）
    }
    let _ = v;
    Ok(())
}

fn is_non_chat_model(id: &str) -> bool {
    let id = id.to_lowercase();
    id.contains("embedding")
        || id.contains("whisper")
        || id.contains("tts")
        || id.contains("dall-e")
        || id.contains("dalle")
        || id.contains("davinci")
        || id.contains("babbage")
        || id.contains("moderation")
        || id.contains("transcribe")
        || id.contains("realtime")
        || id.contains("imagen")
        || id.contains("image-generation")
        || id.contains("veo")
        || id.contains("aqa")
        || id.starts_with("ft:")
        || id.starts_with("text-embedding")
}

/// Google ListModels 已按 API Key 作用域返回；再剔除非对话 / 非 generateContent。
fn is_google_chat_model(id: &str) -> bool {
    let id = id.to_lowercase();
    if id.is_empty() || is_non_chat_model(&id) {
        return false;
    }
    // 纯「audio」子串曾误杀；Gemini 原生多模态对话仍保留。非对话专用名再剔。
    if id.contains("embed") || id.contains("robotics") {
        return false;
    }
    true
}

fn is_chat_openai_model(id: &str) -> bool {
    if is_non_chat_model(id) {
        return false;
    }
    let id = id.to_lowercase();
    id.contains("gpt")
        || id.contains("o1")
        || id.contains("o3")
        || id.contains("o4")
        || id.contains("chatgpt")
        || id.contains("deepseek")
}

/// 中转站模型名五花八门（claude / gemini / grok / qwen…），只剔除明显非对话。
fn is_chat_relay_model(id: &str) -> bool {
    !is_non_chat_model(id) && !id.trim().is_empty()
}

/// 自定义 api_base 的 OpenAI/DeepSeek 卡按中转目录解析（官方域名仍用严过滤）。
fn catalog_vendor(vendor: &str, api_base: &str) -> String {
    let v = normalize_vendor(vendor);
    if v == "relay" {
        return v;
    }
    let official = vendor_preset(&v)
        .map(|p| p.api_base.trim().trim_end_matches('/').to_string())
        .unwrap_or_default();
    let base = api_base.trim().trim_end_matches('/');
    if matches!(v.as_str(), "openai" | "deepseek")
        && !official.is_empty()
        && !base.is_empty()
        && official != base
        && !base.starts_with(&official)
        && !official.starts_with(base)
    {
        return "relay".into();
    }
    v
}

fn openai_models_urls(base: &str) -> Vec<String> {
    let b = base.trim().trim_end_matches('/');
    if b.is_empty() {
        return vec![];
    }
    if b.ends_with("/models") {
        return vec![b.to_string()];
    }
    // 优先 /v1/models：New API 等中转的裸 /models 常是 200 HTML 站点页。
    if b.ends_with("/v1") {
        vec![format!("{b}/models")]
    } else {
        vec![format!("{b}/v1/models"), format!("{b}/models")]
    }
}

fn openai_model_items(body: &Value) -> Vec<Value> {
    if let Some(arr) = body.get("data").and_then(|d| d.as_array()) {
        return arr.clone();
    }
    if let Some(arr) = body
        .get("data")
        .and_then(|d| d.get("data"))
        .and_then(|d| d.as_array())
    {
        return arr.clone();
    }
    if let Some(arr) = body.get("models").and_then(|m| m.as_array()) {
        return arr.clone();
    }
    if let Some(arr) = body.as_array() {
        return arr.clone();
    }
    vec![]
}

fn parse_openai_models_body(body: &Value, vendor: &str) -> Vec<NotesProviderModel> {
    let prefix = litellm_prefix(vendor);
    let relay = vendor == "relay";
    let mut out = vec![];
    let data = openai_model_items(body);
    for item in data {
        let Some(id) = item.get("id").and_then(|v| v.as_str()) else {
            continue;
        };
        let keep = if relay {
            is_chat_relay_model(id)
        } else {
            is_chat_openai_model(id)
        };
        if !keep {
            continue;
        }
        // 中转一律走 OpenAI 协议；id 里就算带 anthropic/ 也仍当前缀 openai/…
        let litellm = if relay {
            format!("openai/{id}")
        } else if id.contains('/') {
            id.to_string()
        } else {
            format!("{prefix}/{id}")
        };
        out.push(make_model(id, &litellm));
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

async fn discover_openai_compatible(
    prov: &NotesProvider,
    vendor: &str,
    sink: Option<&ProgressSink>,
) -> Result<Vec<NotesProviderModel>, String> {
    let base = prov.api_base.trim().trim_end_matches('/');
    let urls = if base.is_empty() {
        let preset_base = vendor_preset(vendor)
            .map(|p| p.api_base.trim().trim_end_matches('/').to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                if vendor == "relay" {
                    "请先填写中转的 API Base（例如 https://xxx.com/v1）".to_string()
                } else {
                    "未知服务商".to_string()
                }
            })?;
        openai_models_urls(&preset_base)
    } else {
        openai_models_urls(base)
    };
    if urls.is_empty() {
        return Err("请先填写 API Base".into());
    }
    let catalog = catalog_vendor(vendor, base);
    let secrets = [prov.api_key.trim()];
    let client = http_client(crate::notes_ctl::provider_uses_http_proxy(prov))?;
    let mut last_err = String::new();
    let push_err = |last: &mut String, msg: String| {
        if last.is_empty() {
            *last = msg;
        } else {
            *last = format!("{last} → {msg}");
        }
    };
    for (i, url) in urls.iter().enumerate() {
        if let Some(s) = sink {
            s.emit(
                "http_get",
                &format!("GET {url}（超时 {}s）…", REQUEST_TIMEOUT.as_secs()),
                20 + (i as u32 * 10),
            );
        }
        let resp = match client
            .get(url)
            .header("Authorization", format!("Bearer {}", prov.api_key.trim()))
            .header("Accept", "application/json")
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                push_err(
                    &mut last_err,
                    format!("请求 {url} 失败: {}", sanitize_reqwest_err(&e)),
                );
                continue;
            }
        };
        let (status, ct, raw) = match response_meta_bytes(resp).await {
            Ok(v) => v,
            Err(e) => {
                push_err(&mut last_err, format!("读取 {url} 响应失败: {e}"));
                continue;
            }
        };
        if let Some(s) = sink {
            s.emit(
                "http_status",
                &format!("响应 HTTP {status} · {}", body_kind_label(&raw, &ct)),
                50,
            );
        }
        if !(200..300).contains(&status) {
            push_err(
                &mut last_err,
                format_http_payload("GET", url, status, &ct, &raw, &secrets),
            );
            continue;
        }
        if let Some(s) = sink {
            s.emit("parse", "解析模型列表…", 70);
        }
        let body = match json_from_bytes(&raw, "GET", url, status, &ct, &secrets) {
            Ok(v) => v,
            Err(e) => {
                push_err(&mut last_err, e);
                continue;
            }
        };
        if let Some(api_err) = openai_error_message(&body) {
            push_err(
                &mut last_err,
                redact_secrets(&format!("GET {url} · HTTP {status} · {api_err}"), &secrets),
            );
            continue;
        }
        let out = parse_openai_models_body(&body, &catalog);
        if out.is_empty() {
            push_err(
                &mut last_err,
                format!(
                    "GET {url} · HTTP {status} · 未解析到对话模型（已尝试 OpenAI data[] / models[]）"
                ),
            );
            continue;
        }
        return Ok(out);
    }
    Err(if last_err.is_empty() {
        "未发现可用对话模型".into()
    } else {
        last_err
    })
}

async fn discover_google(
    prov: &NotesProvider,
    sink: Option<&ProgressSink>,
) -> Result<Vec<NotesProviderModel>, String> {
    let use_proxy = crate::notes_ctl::provider_uses_http_proxy(prov);
    let det = crate::local_http_proxy::detect_local_http_proxy();
    let client = http_client(use_proxy)?;
    let mut out = vec![];
    let mut page_token: Option<String> = None;
    let mut page = 0u32;
    loop {
        page += 1;
        // 不把 api key 打进进度日志
        let mut url =
            "https://generativelanguage.googleapis.com/v1beta/models?pageSize=100".to_string();
        if let Some(t) = &page_token {
            url.push_str(&format!("&pageToken={t}"));
        }
        if let Some(s) = sink {
            s.emit(
                "http_get",
                &format!(
                    "GET Google models 第 {page} 页（超时 {}s；若长时间无响应请检查代理/TUN）…",
                    REQUEST_TIMEOUT.as_secs()
                ),
                15 + page.saturating_mul(10).min(50),
            );
        }
        let key = prov.api_key.trim();
        let resp = client
            .get(&url)
            .query(&[("key", key)])
            .send()
            .await
            .map_err(|e| {
                let base = sanitize_reqwest_err(&e);
                let hint = if use_proxy {
                    if let Some(u) = det.url.as_deref() {
                        format!(
                            "已开「代理」，经 {}（{}）仍失败：请确认 Clash 规则放行 Google / 或试 TUN",
                            u,
                            if det.source.is_empty() {
                                "detected"
                            } else {
                                &det.source
                            }
                        )
                    } else {
                        "已开「代理」，但未探测到本机 HTTP 代理口（Clash mixed 7890/7897 等）。请先打开 Clash，或关掉该卡「代理」改直连（若网络可直连 Google）".into()
                    }
                } else {
                    "当前卡片「代理」为关。国内访问 Google 通常需要打开右侧「代理」".into()
                };
                format!(
                    "请求 Google 模型列表失败: {}（{}；请确认 Key 来自 Google AI Studio，勿粘贴终端日志）",
                    base, hint
                )
            })?;
        if let Some(s) = sink {
            s.emit(
                "http_status",
                &format!("Google 第 {page} 页 · HTTP {}", resp.status().as_u16()),
                40 + page.saturating_mul(10).min(30),
            );
        }
        if !resp.status().is_success() {
            return Err(format!(
                "HTTP {} · {}",
                resp.status(),
                resp.text().await.unwrap_or_default()
            ));
        }
        let body: Value = resp.json().await.map_err(|e| e.to_string())?;
        if let Some(models) = body.get("models").and_then(|m| m.as_array()) {
            for item in models {
                let methods = item
                    .get("supportedGenerationMethods")
                    .and_then(|m| m.as_array());
                let chat_ok = methods
                    .map(|arr| arr.iter().any(|v| v.as_str() == Some("generateContent")))
                    .unwrap_or(false);
                if !chat_ok {
                    continue;
                }
                // 优先 name（models/xxx），避免 baseModelId 把版本别名糊成同一粗名却仍堆重复变体时难过滤。
                let id = item
                    .get("name")
                    .and_then(|v| v.as_str())
                    .map(|n| n.trim_start_matches("models/").to_string())
                    .or_else(|| {
                        item.get("baseModelId")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                    });
                let Some(id) = id else { continue };
                if !is_google_chat_model(&id) {
                    continue;
                }
                out.push(make_model(&id, &format!("gemini/{id}")));
            }
        }
        page_token = body
            .get("nextPageToken")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        if page_token.is_none() {
            break;
        }
    }
    if let Some(s) = sink {
        s.emit("parse", "过滤本 Key 可用的 generateContent 对话模型…", 75);
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out.dedup_by(|a, b| a.id == b.id);
    if out.is_empty() {
        return Err("未发现可用 Gemini 对话模型".into());
    }
    Ok(out)
}

async fn discover_anthropic(
    prov: &NotesProvider,
    sink: Option<&ProgressSink>,
) -> Result<Vec<NotesProviderModel>, String> {
    if let Some(s) = sink {
        s.emit("anthropic_wildcard", "Anthropic：尝试 LiteLLM wildcard 发现…", 15);
    }
    match discover_anthropic_via_litellm(prov, sink).await {
        Ok(models) if !models.is_empty() => return Ok(models),
        Ok(_) => {
            if let Some(s) = sink {
                s.emit("anthropic_fallback", "wildcard 为空，改用探测清单…", 40);
            }
        }
        Err(e) => {
            if let Some(s) = sink {
                s.emit(
                    "anthropic_fallback",
                    &format!("wildcard 失败（{e}），改用探测清单…"),
                    40,
                );
            }
        }
    }
    discover_anthropic_via_ping(prov, sink).await
}

async fn discover_anthropic_via_litellm(
    prov: &NotesProvider,
    sink: Option<&ProgressSink>,
) -> Result<Vec<NotesProviderModel>, String> {
    let config_path = notes_config_dir().join("litellm_discover.yaml");
    let yaml = format!(
        r#"# temporary discover config
model_list:
  - model_name: anthropic/*
    litellm_params:
      model: anthropic/*
      api_key: {key}
litellm_settings:
  check_provider_endpoint: true
"#,
        key = prov.api_key.trim()
    );
    std::fs::create_dir_all(notes_config_dir()).map_err(|e| e.to_string())?;
    std::fs::write(&config_path, yaml).map_err(|e| e.to_string())?;

    if let Some(s) = sink {
        s.emit(
            "sidecar_spawn",
            &format!("启动临时 LiteLLM 发现进程（端口 {DISCOVER_PORT}）…"),
            25,
        );
    }
    let mut child = spawn_discover_litellm(&config_path)?;
    let result = async {
        if let Some(s) = sink {
            s.emit("sidecar_wait", "等待发现端口就绪…", 35);
        }
        wait_port(DISCOVER_PORT, Duration::from_secs(25)).await?;
        if let Some(s) = sink {
            s.emit("http_get", "GET /v1/models …", 50);
        }
        let client = http_client(false)?;
        let resp = client
            .get(format!("{DISCOVER_URL}/v1/models"))
            .send()
            .await
            .map_err(|e| format!("LiteLLM 模型发现失败: {e}"))?;
        if !resp.status().is_success() {
            return Err(format!(
                "LiteLLM HTTP {} · {}",
                resp.status(),
                resp.text().await.unwrap_or_default()
            ));
        }
        let body: Value = resp.json().await.map_err(|e| e.to_string())?;
        let mut out = vec![];
        if let Some(data) = body.get("data").and_then(|d| d.as_array()) {
            for item in data {
                let Some(id) = item.get("id").and_then(|v| v.as_str()) else {
                    continue;
                };
                let model_id = id.strip_prefix("anthropic/").unwrap_or(id).to_string();
                if model_id.is_empty() {
                    continue;
                }
                out.push(make_model(&model_id, &format!("anthropic/{model_id}")));
            }
        }
        out.sort_by(|a, b| a.id.cmp(&b.id));
        Ok(out)
    }
    .await;
    let _ = child.kill();
    let _ = child.wait();
    result
}

async fn discover_anthropic_via_ping(
    prov: &NotesProvider,
    sink: Option<&ProgressSink>,
) -> Result<Vec<NotesProviderModel>, String> {
    let client = http_client(crate::notes_ctl::provider_uses_http_proxy(prov))?;
    let base = prov.api_base.trim().trim_end_matches('/').to_string();
    let url = if base.is_empty() {
        "https://api.anthropic.com/v1/messages".to_string()
    } else if base.ends_with("/v1/messages") {
        base
    } else if base.ends_with("/v1") {
        format!("{base}/messages")
    } else {
        format!("{base}/v1/messages")
    };
    let mut out = vec![];
    let total = ANTHROPIC_CURATED.len();
    for (i, model_id) in ANTHROPIC_CURATED.iter().enumerate() {
        if let Some(s) = sink {
            let pct = 45 + ((i as u32 * 40) / total as u32);
            s.emit(
                "ping",
                &format!("探测 {} ({}/{})…", model_id, i + 1, total),
                pct,
            );
        }
        let body = serde_json::json!({
            "model": model_id,
            "max_tokens": 1,
            "messages": [{ "role": "user", "content": "hi" }],
        });
        let resp = client
            .post(&url)
            .header("x-api-key", prov.api_key.trim())
            .header("anthropic-version", "2023-06-01")
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await;
        let Ok(resp) = resp else { continue };
        if resp.status().is_success() {
            out.push(make_model(model_id, &format!("anthropic/{model_id}")));
        }
    }
    if out.is_empty() {
        return Err("Anthropic 模型发现失败：wildcard 与探测均未找到可用模型".into());
    }
    Ok(out)
}

fn find_python() -> Option<PathBuf> {
    for cmd in ["python", "python3", "py"] {
        if Command::new(cmd)
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
        {
            return Some(PathBuf::from(cmd));
        }
    }
    None
}

fn spawn_discover_litellm(config: &PathBuf) -> Result<Child, String> {
    // 与主 sidecar 同一入口：litellm.exe 或 litellm.proxy.proxy_cli（勿用 -m litellm）
    let py = crate::llm_sidecar_ctl::resolve_python_with_litellm().or_else(|_| {
        find_python().ok_or_else(|| "找不到 Python（需 pip install litellm[proxy]）".to_string())
    })?;
    let config_s = config.to_string_lossy().into_owned();
    let port_s = DISCOVER_PORT.to_string();
    let mut cmd = if let Some(parent) = py.parent() {
        let cli = parent.join("Scripts").join("litellm.exe");
        if cli.is_file() {
            let mut c = Command::new(cli);
            c.args([
                "--config",
                &config_s,
                "--port",
                &port_s,
                "--host",
                "127.0.0.1",
            ]);
            c
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
            c
        }
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
        c
    };
    cmd.current_dir(notes_config_dir());
    cmd.env("PYTHONUTF8", "1");
    cmd.env("PYTHONIOENCODING", "utf-8");
    crate::llm_sidecar_ctl::apply_sidecar_network_env(&mut cmd);
    cmd.stdout(Stdio::null());
    cmd.stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
        .map_err(|e| format!("启动 LiteLLM 发现进程失败: {e}"))
}

async fn wait_port(port: u16, timeout: Duration) -> Result<(), String> {
    let deadline = std::time::Instant::now() + timeout;
    while std::time::Instant::now() < deadline {
        if std::net::TcpStream::connect_timeout(
            &format!("127.0.0.1:{port}")
                .parse()
                .map_err(|e: std::net::AddrParseError| e.to_string())?,
            Duration::from_millis(500),
        )
        .is_ok()
        {
            return Ok(());
        }
        tokio::time::sleep(Duration::from_millis(400)).await;
    }
    Err(format!("等待端口 {port} 超时"))
}

pub async fn ping_provider_model(prov: &NotesProvider, model_id: &str) -> Result<(), String> {
    let use_proxy = crate::notes_ctl::provider_uses_http_proxy(prov);
    let vendor = normalize_vendor(&prov.vendor);
    match vendor.as_str() {
        "google" => ping_google(prov, model_id, use_proxy).await,
        "anthropic" => ping_anthropic_model(prov, model_id, use_proxy).await,
        _ => ping_openai_compat(prov, model_id, use_proxy).await,
    }
}

async fn ping_google(prov: &NotesProvider, model_id: &str, use_proxy: bool) -> Result<(), String> {
    let client = http_client(use_proxy)?;
    let base = prov.api_base.trim().trim_end_matches('/');
    let url = format!("{base}/models/{model_id}:generateContent");
    let body = serde_json::json!({
        "contents": [{ "parts": [{ "text": "ping" }] }],
        "generationConfig": { "maxOutputTokens": 8 }
    });
    let secrets = [prov.api_key.trim()];
    let resp = client
        .post(&url)
        .query(&[("key", prov.api_key.trim())])
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", sanitize_reqwest_err(&e)))?;
    let (status, ct, raw) = response_meta_bytes(resp).await?;
    if (200..300).contains(&status) {
        Ok(())
    } else {
        Err(format_http_payload(
            "POST", &url, status, &ct, &raw, &secrets,
        ))
    }
}

async fn ping_openai_compat(
    prov: &NotesProvider,
    model_id: &str,
    use_proxy: bool,
) -> Result<(), String> {
    let client = http_client(use_proxy)?;
    let base = prov.api_base.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("请先填写 API Base".into());
    }
    let url = if base.ends_with("/v1") {
        format!("{base}/chat/completions")
    } else {
        format!("{base}/v1/chat/completions")
    };
    let secrets = [prov.api_key.trim()];
    let body = serde_json::json!({
        "model": model_id,
        "max_tokens": 8,
        "messages": [{ "role": "user", "content": "ping" }],
    });
    let resp = client
        .post(&url)
        .header("Authorization", format!("Bearer {}", prov.api_key.trim()))
        .header("Accept", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", sanitize_reqwest_err(&e)))?;
    let (status, ct, raw) = response_meta_bytes(resp).await?;
    if (200..300).contains(&status) {
        Ok(())
    } else {
        Err(format_http_payload(
            "POST", &url, status, &ct, &raw, &secrets,
        ))
    }
}

async fn ping_anthropic_model(
    prov: &NotesProvider,
    model_id: &str,
    use_proxy: bool,
) -> Result<(), String> {
    let client = http_client(use_proxy)?;
    let base = prov.api_base.trim().trim_end_matches('/');
    let url = if base.is_empty() {
        "https://api.anthropic.com/v1/messages".to_string()
    } else if base.ends_with("/v1/messages") {
        base.to_string()
    } else if base.ends_with("/v1") {
        format!("{base}/messages")
    } else {
        format!("{base}/v1/messages")
    };
    let secrets = [prov.api_key.trim()];
    let body = serde_json::json!({
        "model": model_id,
        "max_tokens": 8,
        "messages": [{ "role": "user", "content": "ping" }],
    });
    let resp = client
        .post(&url)
        .header("x-api-key", prov.api_key.trim())
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求失败: {}", sanitize_reqwest_err(&e)))?;
    let (status, ct, raw) = response_meta_bytes(resp).await?;
    if (200..300).contains(&status) {
        Ok(())
    } else {
        Err(format_http_payload(
            "POST", &url, status, &ct, &raw, &secrets,
        ))
    }
}

#[allow(dead_code)]
pub fn sidecar_models_url() -> &'static str {
    LLM_SIDECAR_URL
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn models_urls_prefer_v1_on_bare_host() {
        assert_eq!(
            openai_models_urls("https://bytecat.lamclod.cn"),
            vec![
                "https://bytecat.lamclod.cn/v1/models".to_string(),
                "https://bytecat.lamclod.cn/models".to_string(),
            ]
        );
        assert_eq!(
            openai_models_urls("https://api.openai.com/v1"),
            vec!["https://api.openai.com/v1/models".to_string()]
        );
        assert_eq!(
            openai_models_urls("https://ai-gateway.vercel.sh/v1/"),
            vec!["https://ai-gateway.vercel.sh/v1/models".to_string()]
        );
    }

    #[test]
    fn parse_newapi_openai_list() {
        let body = json!({
            "data": [
                {
                    "id": "claude-haiku-4-5-20251001",
                    "object": "model",
                    "owned_by": "claude"
                }
            ]
        });
        let models = parse_openai_models_body(&body, "relay");
        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "claude-haiku-4-5-20251001");
        assert_eq!(
            models[0].litellm_model,
            "openai/claude-haiku-4-5-20251001"
        );
    }

    #[test]
    fn json_error_includes_html_preview() {
        let html = b"<!doctype html><html><title>New API</title></html>";
        let err = json_from_bytes(
            html,
            "GET",
            "https://example.com/models",
            200,
            "text/html",
            &[],
        )
        .unwrap_err();
        assert!(err.contains("HTTP 200"), "{err}");
        assert!(err.contains("HTML"), "{err}");
        assert!(err.contains("New API"), "{err}");
        assert!(!err.eq_ignore_ascii_case("error decoding response body"));
    }

    #[test]
    fn redact_api_key_from_preview() {
        let key = "sk-SUPERSECRETKEYVALUE";
        let raw = format!(r#"{{"error":"{key}"}}"#);
        let preview = preview_http_body(raw.as_bytes(), &[key]);
        assert!(!preview.contains(key), "{preview}");
        assert!(preview.contains("[redacted]"), "{preview}");
    }

    #[test]
    fn custom_openai_base_uses_relay_catalog() {
        assert_eq!(
            catalog_vendor("openai", "https://bytecat.lamclod.cn"),
            "relay"
        );
        assert_eq!(
            catalog_vendor("openai", "https://api.openai.com/v1"),
            "openai"
        );
    }
}
