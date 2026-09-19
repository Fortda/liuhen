//! 笔记 LLM：卡片、providers、流式 send_turn；绿线连通块可拼历史。

use chrono::{SecondsFormat, Utc};
use futures_util::StreamExt;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};

use crate::llm_sidecar_ctl::{
    llm_sidecar_ensure_running, llm_sidecar_status, reload_sidecar_after_config_change,
    write_litellm_config_from_providers, LlmSidecarStatus, LLM_SIDECAR_URL,
};
use crate::notes_paths::{
    card_attachments_dir, card_file_path, clue_board_path, clue_boards_path, context_graph_path,
    ensure_notes_dirs, log_file_path, new_card_id, notes_config_dir, providers_config_path,
    wire_presets_path,
};
use crate::notes_model_discovery::{
    discover_models_for_provider, ping_provider_model, validate_provider_api_key, ProgressSink,
};
use crate::notes_pricing::{
    compute_cost, load_pricing, pricing_is_stale, refresh_pricing_if_stale, save_pricing,
    usage_from_openai_json, CostBreakdown, PricingFile, TokenUsage, PRICING_STALE_MS,
};
use crate::notes_mcp::{self, McpPrefs};
use crate::notes_vendor::{default_api_base, default_label, new_provider_id, normalize_vendor};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotesModelRef {
    pub provider_id: String,
    pub provider_label: String,
    pub model_id: String,
    pub label: String,
    pub litellm_model: String,
    pub proxy_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotesProviderModel {
    pub id: String,
    pub label: String,
    pub litellm_model: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotesProvider {
    pub id: String,
    pub label: String,
    #[serde(alias = "kind")]
    pub vendor: String,
    pub api_base: String,
    pub api_key: String,
    #[serde(default)]
    pub models: Vec<NotesProviderModel>,
    #[serde(default)]
    pub models_synced_at: Option<u64>,
    #[serde(default)]
    pub models_sync_error: Option<String>,
    /// 该服务商保存/拉模型/测试是否走本机 HTTP 代理。None：Google 默认开，其它默认关。
    #[serde(default)]
    pub use_local_http_proxy: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProvidersFile {
    pub v: u32,
    pub providers: Vec<NotesProvider>,
    #[serde(default)]
    pub default_model_key: Option<String>,
    #[serde(default)]
    pub recent_model_keys: Vec<String>,
    /// 置顶模型（provider_id/model_id）；同一服务商组内排到最前
    #[serde(default)]
    pub pinned_model_keys: Vec<String>,
    /// 从 Composer 列表隐藏的模型（缺省空=全开；新发现默认开）
    #[serde(default)]
    pub disabled_model_keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TimingsMs {
    pub request_sent: Option<u64>,
    pub first_byte: Option<u64>,
    pub first_token: Option<u64>,
    pub completed: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TimingsDeltaS {
    pub to_first_byte: Option<f64>,
    pub to_first_token: Option<f64>,
    pub to_completed: Option<f64>,
    pub total: Option<f64>,
}

/// 流式笔记色温：一字一间隔（快暖红 / 慢冷蓝）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserGlyph {
    pub ch: String,
    #[serde(default, alias = "dtMs")]
    pub dt_ms: u64,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub ts: Option<u64>,
}

fn sanitize_user_glyphs(raw: Vec<UserGlyph>) -> Vec<UserGlyph> {
    const MAX: usize = 8000;
    let mut out = Vec::new();
    for g in raw {
        let ch: String = g.ch.chars().take(2).collect();
        if ch.is_empty() {
            continue;
        }
        out.push(UserGlyph {
            ch,
            dt_ms: g.dt_ms.min(300_000),
            deleted: g.deleted,
            ts: g.ts,
        });
        if out.len() >= MAX {
            break;
        }
    }
    out
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotesCard {
    pub v: u32,
    pub id: String,
    pub created_at: u64,
    pub status: String,
    pub model: NotesModelRef,
    pub user_text: String,
    /// 用户打字色温字形（击键间隔）。旧卡缺省空。
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub user_glyphs: Vec<UserGlyph>,
    #[serde(default)]
    pub assistant_text: String,
    #[serde(default)]
    pub thinking_text: Option<String>,
    pub timings_ms: TimingsMs,
    pub timings_delta_s: TimingsDeltaS,
    pub usage: TokenUsage,
    pub cost: CostBreakdown,
    pub log_path: String,
    #[serde(default)]
    pub error: Option<String>,
    /// 发送时是否处于绿线连通上下文（composer 连通或带上历史）。
    #[serde(default)]
    pub from_wire_context: bool,
    /// 发送时选中的连线存档 id（快照；存档删除后仍可追溯）。
    #[serde(default)]
    pub wire_preset_id: Option<String>,
    #[serde(default)]
    pub wire_preset_name: Option<String>,
    #[serde(default)]
    pub wire_preset_note: Option<String>,
    #[serde(default)]
    pub wire_preset_created_at: Option<u64>,
    /// 用户附带的图片（落盘绝对路径）。
    #[serde(default)]
    pub user_images: Vec<String>,
    /// 本轮实际调用过的 MCP server id（首次出现顺序 = 工具调用时序）。
    #[serde(default)]
    pub mcp_servers: Vec<String>,
    /// 本轮实际调用过的工具名（首次出现顺序 = 调用时序）。
    #[serde(default)]
    pub mcp_tools: Vec<String>,
    /// 导入来源（如 `aistudio`）；本机新建卡为 None。
    #[serde(default)]
    pub import_source: Option<String>,
    /// MCP/思考活动快照（回合结束后保留，供卡片重开展示）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mcp_activity: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
pub struct NotesCardSummary {
    pub id: String,
    pub created_at: u64,
    pub status: String,
    pub model_label: String,
    pub user_text: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub user_glyphs: Vec<UserGlyph>,
    pub assistant_text: String,
    pub timings_delta_s: TimingsDeltaS,
    pub usage: TokenUsage,
    pub cost: CostBreakdown,
    pub from_wire_context: bool,
    pub wire_preset_id: Option<String>,
    pub wire_preset_name: Option<String>,
    pub wire_preset_note: Option<String>,
    pub wire_preset_created_at: Option<u64>,
    #[serde(default)]
    pub user_images: Vec<String>,
    #[serde(default)]
    pub error: Option<String>,
    /// 流式等待阶段文案（仅 UI；失败时用 error）
    #[serde(default)]
    pub stream_status: Option<String>,
    #[serde(default)]
    pub mcp_servers: Vec<String>,
    #[serde(default)]
    pub mcp_tools: Vec<String>,
    #[serde(default)]
    pub import_source: Option<String>,
    /// 结构化活动面板（思考/工具）；落盘自 `mcp_activity`，非流式时仍返回。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stream_activity: Option<Value>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn file_mtime_ms_opt(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .filter(|t| *t > 0)
}

fn default_providers_file() -> ProvidersFile {
    ProvidersFile {
        v: 2,
        providers: vec![],
        default_model_key: None,
        recent_model_keys: vec![],
        pinned_model_keys: vec![],
        disabled_model_keys: vec![],
    }
}

fn normalize_provider(mut p: NotesProvider) -> NotesProvider {
    p.vendor = normalize_vendor(&p.vendor);
    if p.label.trim().is_empty() {
        p.label = default_label(&p.vendor);
    }
    if p.api_base.trim().is_empty() {
        p.api_base = default_api_base(&p.vendor);
    }
    if p.id.trim().is_empty() {
        p.id = new_provider_id(&p.vendor);
    }
    // 清掉误粘贴的终端日志
    if validate_provider_api_key(&p.vendor, &p.api_key).is_err() {
        p.api_key.clear();
        p.models_sync_error = Some(
            "已清空异常 API Key（疑似粘贴了终端输出）。请重新填写服务商密钥。".into(),
        );
        p.models.clear();
    }
    p
}

pub fn provider_uses_http_proxy(p: &NotesProvider) -> bool {
    match p.use_local_http_proxy {
        Some(v) => v,
        None => normalize_vendor(&p.vendor) == "google",
    }
}

fn providers_want_local_http_proxy(pf: &ProvidersFile) -> bool {
    pf.providers
        .iter()
        .any(|p| !p.api_key.trim().is_empty() && provider_uses_http_proxy(p))
}

fn normalize_providers_file(mut pf: ProvidersFile) -> ProvidersFile {
    pf.providers = pf.providers.into_iter().map(normalize_provider).collect();
    if pf.v < 2 {
        pf.v = 2;
    }
    pf
}

async fn sync_provider_models(
    prov: &mut NotesProvider,
    now: u64,
    sink: Option<&ProgressSink>,
) {
    if prov.api_key.trim().is_empty() {
        prov.models_sync_error = Some("未填写 API Key".into());
        return;
    }
    match discover_models_for_provider(prov, sink).await {
        Ok(models) => {
            prov.models = models;
            prov.models_synced_at = Some(now);
            prov.models_sync_error = None;
        }
        Err(e) => {
            prov.models.clear();
            prov.models_synced_at = Some(now);
            prov.models_sync_error = Some(e);
        }
    }
}

async fn discover_all_providers(pf: &mut ProvidersFile, sink: Option<&ProgressSink>) {
    let now = now_ms();
    let total = pf.providers.len().max(1);
    for (i, prov) in pf.providers.iter_mut().enumerate() {
        if let Some(s) = sink {
            let base = ((i as u32) * 80) / (total as u32);
            s.emit(
                "provider",
                &format!(
                    "[{}/{}] 发现服务商「{}」的模型…",
                    i + 1,
                    total,
                    prov.label
                ),
                base.saturating_add(5),
            );
        }
        sync_provider_models(prov, now, sink).await;
    }
    prune_stale_model_keys(pf);
}

fn prune_stale_model_keys(pf: &mut ProvidersFile) {
    let valid: std::collections::HashSet<String> = pf
        .providers
        .iter()
        .flat_map(|p| {
            p.models
                .iter()
                .map(|m| model_key(&p.id, &m.id))
                .collect::<Vec<_>>()
        })
        .collect();
    pf.recent_model_keys.retain(|k| valid.contains(k));
    pf.pinned_model_keys.retain(|k| valid.contains(k));
    pf.disabled_model_keys.retain(|k| valid.contains(k));
    if let Some(ref dk) = pf.default_model_key {
        if !valid.contains(dk) {
            pf.default_model_key = pf.providers.iter().find_map(|p| {
                p.models
                    .first()
                    .map(|m| model_key(&p.id, &m.id))
            });
        }
    }
}

pub fn load_providers() -> ProvidersFile {
    let path = providers_config_path();
    if path.is_file() {
        if let Ok(raw) = fs::read_to_string(&path) {
            if let Ok(p) = serde_json::from_str::<ProvidersFile>(&raw) {
                return normalize_providers_file(p);
            }
        }
    }
    let def = default_providers_file();
    let _ = save_providers_file_only(&def);
    def
}

fn save_providers_file_only(p: &ProvidersFile) -> Result<(), String> {
    let path = providers_config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(p).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

pub fn save_providers(p: &ProvidersFile) -> Result<(), String> {
    save_providers_file_only(p)?;
    let raw = fs::read_to_string(providers_config_path()).map_err(|e| e.to_string())?;
    if let Err(e) = write_litellm_config_from_providers(&raw) {
        if !p.providers.iter().any(|pr| !pr.models.is_empty()) {
            return Ok(());
        }
        return Err(e);
    }
    let _ = crate::local_http_proxy::save_network_settings(&crate::local_http_proxy::SidecarNetworkSettings {
        v: 1,
        use_local_http_proxy: providers_want_local_http_proxy(p),
    });
    let _ = reload_sidecar_after_config_change();
    Ok(())
}

fn model_key(provider_id: &str, model_id: &str) -> String {
    format!("{provider_id}/{model_id}")
}

fn parse_model_key(key: &str) -> Option<(String, String)> {
    let (a, b) = key.split_once('/')?;
    if a.is_empty() || b.is_empty() {
        return None;
    }
    Some((a.to_string(), b.to_string()))
}

pub fn resolve_model(key: &str) -> Result<NotesModelRef, String> {
    let (pid, mid) = parse_model_key(key).ok_or("模型 key 格式应为 provider_id/model_id")?;
    let pf = load_providers();
    let prov = pf
        .providers
        .iter()
        .find(|p| p.id == pid)
        .ok_or(format!("找不到 provider: {pid}"))?;
    let m = prov
        .models
        .iter()
        .find(|m| m.id == mid)
        .ok_or(format!("找不到 model: {mid}"))?;
    Ok(NotesModelRef {
        provider_id: pid.clone(),
        provider_label: prov.label.clone(),
        model_id: mid.clone(),
        label: format!("{} · {}", prov.label, m.id),
        litellm_model: m.litellm_model.clone(),
        proxy_name: format!("{pid}__{mid}"),
    })
}

pub fn list_model_options() -> Vec<NotesModelRef> {
    let pf = load_providers();
    let mut out = vec![];
    for p in &pf.providers {
        for m in &p.models {
            out.push(NotesModelRef {
                provider_id: p.id.clone(),
                provider_label: p.label.clone(),
                model_id: m.id.clone(),
                label: format!("{} · {}", p.label, m.id),
                litellm_model: m.litellm_model.clone(),
                proxy_name: format!("{}__{}", p.id, m.id),
            });
        }
    }
    out
}

fn compute_deltas(t: &TimingsMs) -> TimingsDeltaS {
    let ms = |a: Option<u64>, b: Option<u64>| -> Option<f64> {
        match (a, b) {
            (Some(x), Some(y)) if y >= x => Some((y - x) as f64 / 1000.0),
            _ => None,
        }
    };
    TimingsDeltaS {
        to_first_byte: ms(t.request_sent, t.first_byte),
        to_first_token: ms(t.request_sent, t.first_token),
        to_completed: ms(t.request_sent, t.completed),
        total: ms(t.request_sent, t.completed),
    }
}

fn card_to_summary(c: &NotesCard) -> NotesCardSummary {
    let stream_status = if c.status == "streaming" && c.assistant_text.is_empty() {
        Some("等待服务器响应…".into())
    } else {
        None
    };
    NotesCardSummary {
        id: c.id.clone(),
        created_at: c.created_at,
        status: c.status.clone(),
        model_label: c.model.label.clone(),
        user_text: c.user_text.clone(),
        user_glyphs: c.user_glyphs.clone(),
        assistant_text: c.assistant_text.clone(),
        timings_delta_s: c.timings_delta_s.clone(),
        usage: c.usage.clone(),
        cost: c.cost.clone(),
        from_wire_context: c.from_wire_context,
        wire_preset_id: c.wire_preset_id.clone(),
        wire_preset_name: c.wire_preset_name.clone(),
        wire_preset_note: c.wire_preset_note.clone(),
        wire_preset_created_at: c.wire_preset_created_at,
        user_images: c.user_images.clone(),
        error: c.error.clone(),
        stream_status,
        mcp_servers: c.mcp_servers.clone(),
        mcp_tools: c.mcp_tools.clone(),
        import_source: c.import_source.clone(),
        stream_activity: c.mcp_activity.clone(),
    }
}

pub(crate) fn write_card(c: &NotesCard) -> Result<(), String> {
    let path = card_file_path(c.created_at, &c.id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(c).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

fn append_log(ts_ms: u64, card_id: &str, event: Value) -> Result<(), String> {
    let path = log_file_path(ts_ms, card_id);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let line = json!({
        "ts": ts_ms,
        "utc": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        "card_id": card_id,
        "event": event,
    });
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    writeln!(f, "{}", line).map_err(|e| e.to_string())?;
    Ok(())
}

fn collect_card_paths(limit: usize) -> Result<Vec<PathBuf>, String> {
    let root = notes_config_dir()
        .parent()
        .ok_or("notes root")?
        .join("cards");
    if !root.is_dir() {
        return Ok(vec![]);
    }
    let mut files: Vec<(u64, PathBuf)> = vec![];
    walk_cards(&root, &mut files)?;
    files.sort_by(|a, b| b.0.cmp(&a.0));
    Ok(files.into_iter().take(limit).map(|(_, p)| p).collect())
}

fn walk_cards(dir: &PathBuf, out: &mut Vec<(u64, PathBuf)>) -> Result<(), String> {
    for ent in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let ent = ent.map_err(|e| e.to_string())?;
        let path = ent.path();
        if path.is_dir() {
            walk_cards(&path, out)?;
        } else if path.extension().and_then(|s| s.to_str()) == Some("json") {
            let ts = ent
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            out.push((ts, path));
        }
    }
    Ok(())
}

#[tauri::command]
pub fn llm_sidecar_status_cmd() -> LlmSidecarStatus {
    llm_sidecar_status()
}

async fn llm_sidecar_ensure_running_async() -> Result<LlmSidecarStatus, String> {
    tauri::async_runtime::spawn_blocking(llm_sidecar_ensure_running)
        .await
        .map_err(|e| format!("sidecar worker panicked: {e}"))?
}

#[tauri::command]
pub async fn llm_sidecar_ensure_running_cmd() -> Result<LlmSidecarStatus, String> {
    llm_sidecar_ensure_running_async().await
}

#[tauri::command]
pub fn notes_providers_get() -> Result<ProvidersFile, String> {
    Ok(load_providers())
}

/// 只写置顶列表，不触发重新拉模型（模型列表里点星用）。
#[tauri::command]
pub fn notes_providers_set_pinned(pinned_model_keys: Vec<String>) -> Result<ProvidersFile, String> {
    let mut pf = load_providers();
    pf.pinned_model_keys = pinned_model_keys;
    prune_stale_model_keys(&mut pf);
    save_providers_file_only(&pf)?;
    Ok(pf)
}

/// 只写 Composer / 设置页的模型可见开关，不重新拉目录。
#[tauri::command]
pub fn notes_providers_set_disabled(
    disabled_model_keys: Vec<String>,
) -> Result<ProvidersFile, String> {
    let mut pf = load_providers();
    pf.disabled_model_keys = disabled_model_keys;
    prune_stale_model_keys(&mut pf);
    save_providers_file_only(&pf)?;
    Ok(pf)
}

#[tauri::command]
pub async fn notes_providers_save(
    app: AppHandle,
    mut providers: ProvidersFile,
    discover_provider_id: Option<String>,
) -> Result<ProvidersFile, String> {
    let sink = ProgressSink::new(app, "save_providers");
    sink.emit("save", "写入 providers.json…", 5);
    providers = normalize_providers_file(providers);
    save_providers_file_only(&providers)?;
    let only = discover_provider_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    if let Some(id) = only.as_deref() {
        sink.emit(
            "discover",
            &format!("发现「{}」的模型…", {
                providers
                    .providers
                    .iter()
                    .find(|p| p.id == id)
                    .map(|p| p.label.as_str())
                    .unwrap_or(id)
            }),
            10,
        );
        let now = now_ms();
        if let Some(prov) = providers.providers.iter_mut().find(|p| p.id == id) {
            sync_provider_models(prov, now, Some(&sink)).await;
        }
        prune_stale_model_keys(&mut providers);
    } else {
        sink.emit(
            "discover",
            "开始按密钥发现模型（可能较慢，界面不会卡住）…",
            10,
        );
        discover_all_providers(&mut providers, Some(&sink)).await;
    }
    if providers.default_model_key.is_none() {
        providers.default_model_key = providers.providers.iter().find_map(|p| {
            p.models
                .first()
                .map(|m| model_key(&p.id, &m.id))
        });
    }
    providers.v = 2;
    sink.emit("yaml", "生成 litellm_config.yaml…", 92);
    save_providers(&providers)?;
    let summary = providers
        .providers
        .iter()
        .filter(|p| {
            if let Some(id) = only.as_deref() {
                p.id == id
            } else {
                !p.api_key.trim().is_empty()
            }
        })
        .map(|p| {
            if let Some(err) = &p.models_sync_error {
                if !err.is_empty() && err != "未填写 API Key" {
                    format!("{}：{}", p.label, err)
                } else {
                    format!("{}：{} 个模型", p.label, p.models.len())
                }
            } else {
                format!("{}：{} 个模型", p.label, p.models.len())
            }
        })
        .collect::<Vec<_>>()
        .join("；");
    let any_err = providers.providers.iter().any(|p| {
        if let Some(id) = only.as_deref() {
            if p.id != id {
                return false;
            }
        } else if p.api_key.trim().is_empty() {
            return false;
        }
        p.models_sync_error
            .as_ref()
            .is_some_and(|e| !e.is_empty() && e != "未填写 API Key")
    });
    if any_err {
        sink.done_err(&format!("保存了密钥，但拉模型失败。{summary}"));
    } else {
        sink.done_ok(&format!("已保存。{summary}"));
    }
    Ok(providers)
}

#[tauri::command]
pub async fn notes_discover_provider_models(
    app: AppHandle,
    provider_id: String,
) -> Result<ProvidersFile, String> {
    let sink = ProgressSink::new(app, "discover_one");
    let mut pf = load_providers();
    let now = now_ms();
    let idx = pf
        .providers
        .iter()
        .position(|p| p.id == provider_id)
        .ok_or(format!("找不到 provider: {provider_id}"))?;
    let label = pf.providers[idx].label.clone();
    sink.emit("start", &format!("重新获取「{label}」模型…"), 5);
    let prov = &mut pf.providers[idx];
    match discover_models_for_provider(prov, Some(&sink)).await {
        Ok(models) => {
            let n = models.len();
            prov.models = models;
            prov.models_synced_at = Some(now);
            prov.models_sync_error = None;
            prune_stale_model_keys(&mut pf);
            save_providers(&pf)?;
            sink.done_ok(&format!("{label}：已发现 {n} 个模型"));
        }
        Err(e) => {
            prov.models.clear();
            prov.models_synced_at = Some(now);
            prov.models_sync_error = Some(e.clone());
            prune_stale_model_keys(&mut pf);
            let _ = save_providers(&pf);
            sink.done_err(&format!("{label}：{e}"));
            return Ok(pf);
        }
    }
    Ok(pf)
}

#[tauri::command]
pub async fn notes_refresh_models_if_stale(
    app: AppHandle,
    max_age_ms: Option<u64>,
) -> Result<ProvidersFile, String> {
    let max_age = max_age_ms.unwrap_or(24 * 60 * 60 * 1000);
    let mut pf = load_providers();
    let now = now_ms();
    let stale_ids: Vec<usize> = pf
        .providers
        .iter()
        .enumerate()
        .filter(|(_, prov)| {
            if prov.api_key.trim().is_empty() {
                return false;
            }
            prov.models_synced_at
                .map(|t| now.saturating_sub(t) >= max_age)
                .unwrap_or(true)
        })
        .map(|(i, _)| i)
        .collect();
    if stale_ids.is_empty() {
        return Ok(pf);
    }
    let sink = ProgressSink::new(app, "refresh_stale");
    sink.emit(
        "start",
        &format!("刷新 {} 个过期服务商的模型列表…", stale_ids.len()),
        5,
    );
    for (n, idx) in stale_ids.iter().enumerate() {
        let prov = &mut pf.providers[*idx];
        let label = prov.label.clone();
        sink.emit(
            "provider",
            &format!("刷新「{label}」({}/{})…", n + 1, stale_ids.len()),
            ((n as u32) * 80) / (stale_ids.len() as u32).max(1) + 10,
        );
        match discover_models_for_provider(prov, Some(&sink)).await {
            Ok(models) => {
                prov.models = models;
                prov.models_synced_at = Some(now);
                prov.models_sync_error = None;
            }
            Err(e) => {
                prov.models.clear();
                prov.models_synced_at = Some(now);
                prov.models_sync_error = Some(e);
            }
        }
    }
    prune_stale_model_keys(&mut pf);
    save_providers(&pf)?;
    sink.done_ok("模型列表已刷新");
    Ok(pf)
}

#[tauri::command]
pub fn notes_pricing_get() -> Result<PricingFile, String> {
    Ok(load_pricing())
}

#[tauri::command]
pub async fn notes_pricing_refresh_if_stale(
    max_age_ms: Option<u64>,
) -> Result<PricingFile, String> {
    refresh_pricing_if_stale(max_age_ms.unwrap_or(
        crate::notes_pricing::PRICING_STALE_MS,
    ))
    .await
}

#[tauri::command]
pub fn notes_pricing_save(pricing: PricingFile) -> Result<PricingFile, String> {
    save_pricing(&pricing)?;
    Ok(load_pricing())
}

#[tauri::command]
pub fn notes_list_models() -> Result<Vec<NotesModelRef>, String> {
    Ok(list_model_options())
}

#[tauri::command]
pub fn notes_list_cards(limit: Option<usize>) -> Result<Vec<NotesCardSummary>, String> {
    let lim = limit.unwrap_or(80).min(500);
    let paths = collect_card_paths(lim)?;
    let mut out = vec![];
    for p in paths {
        if let Ok(raw) = fs::read_to_string(&p) {
            if let Ok(c) = serde_json::from_str::<NotesCard>(&raw) {
                out.push(card_to_summary(&c));
            }
        }
    }
    out.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(out)
}

pub fn list_cards_internal(limit: usize) -> Result<Vec<NotesCardSummary>, String> {
    notes_list_cards(Some(limit))
}

#[tauri::command]
pub fn notes_read_card(card_id: String, created_at: u64) -> Result<NotesCard, String> {
    let path = card_file_path(created_at, &card_id);
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn notes_read_protocol_log(card_id: String, created_at: u64) -> Result<String, String> {
    let path = log_file_path(created_at, &card_id);
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize)]
pub struct SendTurnStart {
    pub card_id: String,
    pub created_at: u64,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct WireContextInput {
    #[serde(default)]
    pub from_wire_context: bool,
    #[serde(default)]
    pub wire_preset_id: Option<String>,
    #[serde(default)]
    pub wire_preset_name: Option<String>,
    #[serde(default)]
    pub wire_preset_note: Option<String>,
    #[serde(default)]
    pub wire_preset_created_at: Option<u64>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct McpTurnOpts {
    #[serde(default)]
    pub inject_product_context: bool,
    #[serde(default)]
    pub enabled_server_ids: Vec<String>,
    #[serde(default)]
    pub viewing_clue_board: bool,
    #[serde(default)]
    pub active_board_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct NotesTurnOpts {
    #[serde(default)]
    pub thinking: bool,
    /// 当前模型支持 thinking 开关时：false 则显式 disabled
    #[serde(default)]
    pub thinking_toggle: bool,
    #[serde(default)]
    pub effort: String,
    #[serde(default)]
    pub thinking_budget: Option<u32>,
    #[serde(default)]
    pub temperature: Option<f64>,
    #[serde(default)]
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub top_p: Option<f64>,
    /// Gemini：在 tools 中加入 googleSearch grounding
    #[serde(default)]
    pub google_search: bool,
    #[serde(default)]
    pub wire_context: Option<WireContextInput>,
    #[serde(default)]
    pub mcp: Option<McpTurnOpts>,
    /// 发送前用户选的本地图片路径（会复制到 notes/attachments/）。
    #[serde(default)]
    pub image_paths: Vec<String>,
    /// 用户打字色温字形（可选）。
    #[serde(default)]
    pub user_glyphs: Vec<UserGlyph>,
}

fn wire_context_from_opts(opts: &NotesTurnOpts) -> (bool, Option<String>, Option<String>, Option<String>, Option<u64>) {
    let wc = opts.wire_context.as_ref();
    if wc.map(|w| w.from_wire_context).unwrap_or(false) {
        (
            true,
            wc.and_then(|w| w.wire_preset_id.clone()),
            wc.and_then(|w| w.wire_preset_name.clone()),
            wc.and_then(|w| w.wire_preset_note.clone()),
            wc.and_then(|w| w.wire_preset_created_at),
        )
    } else {
        (false, None, None, None, None)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChatTurnMessage {
    pub role: String,
    pub content: String,
    /// 来源卡片创建时间（ms）；有则用于时序排序与时间戳注入。
    #[serde(default)]
    pub created_at: Option<u64>,
    #[serde(default)]
    pub card_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotesContextGraph {
    pub v: u32,
    #[serde(default)]
    pub edges: Vec<Vec<String>>,
}

fn default_context_graph() -> NotesContextGraph {
    NotesContextGraph {
        v: 1,
        edges: vec![],
    }
}

fn normalize_context_graph(mut g: NotesContextGraph) -> NotesContextGraph {
    g.v = 1;
    let mut seen = std::collections::BTreeSet::<(String, String)>::new();
    let mut out = Vec::new();
    for pair in g.edges {
        if pair.len() < 2 {
            continue;
        }
        let a = pair[0].trim().to_string();
        let b = pair[1].trim().to_string();
        if a.is_empty() || b.is_empty() || a == b {
            continue;
        }
        if a.len() > 128 || b.len() > 128 {
            continue;
        }
        let key = if a < b {
            (a.clone(), b.clone())
        } else {
            (b.clone(), a.clone())
        };
        if seen.insert(key.clone()) {
            out.push(vec![key.0, key.1]);
        }
        if out.len() >= 4000 {
            break;
        }
    }
    g.edges = out;
    g
}

fn load_context_graph() -> NotesContextGraph {
    let path = context_graph_path();
    let Ok(raw) = fs::read_to_string(&path) else {
        return default_context_graph();
    };
    serde_json::from_str::<NotesContextGraph>(&raw)
        .map(normalize_context_graph)
        .unwrap_or_else(|_| default_context_graph())
}

fn save_context_graph(graph: &NotesContextGraph) -> Result<(), String> {
    fs::create_dir_all(notes_config_dir()).map_err(|e| e.to_string())?;
    let path = context_graph_path();
    let raw = serde_json::to_string_pretty(graph).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn notes_context_graph_get() -> Result<NotesContextGraph, String> {
    Ok(load_context_graph())
}

#[tauri::command]
pub fn notes_context_graph_save(graph: NotesContextGraph) -> Result<NotesContextGraph, String> {
    let g = normalize_context_graph(graph);
    save_context_graph(&g)?;
    Ok(g)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WirePreset {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub note: String,
    pub edges: Vec<Vec<String>>,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WirePresetsFile {
    pub v: u32,
    #[serde(default)]
    pub presets: Vec<WirePreset>,
}

fn default_wire_presets_file() -> WirePresetsFile {
    WirePresetsFile {
        v: 1,
        presets: vec![],
    }
}

fn normalize_wire_preset_edges(edges: Vec<Vec<String>>) -> Vec<Vec<String>> {
    normalize_context_graph(NotesContextGraph { v: 1, edges }).edges
}

fn seed_missing_wire_preset_times(file: &mut WirePresetsFile) {
    let mtime = file_mtime_ms_opt(&wire_presets_path());
    for p in &mut file.presets {
        if p.created_at == 0 {
            p.created_at = mtime.unwrap_or(0);
        }
        if p.updated_at == 0 {
            p.updated_at = mtime.unwrap_or(p.created_at);
        }
    }
}

fn load_wire_presets() -> WirePresetsFile {
    let path = wire_presets_path();
    let Ok(raw) = fs::read_to_string(&path) else {
        return default_wire_presets_file();
    };
    let mut file = serde_json::from_str::<WirePresetsFile>(&raw)
        .map(|mut f| {
            f.v = 1;
            f.presets = f
                .presets
                .into_iter()
                .map(|mut p| {
                    p.edges = normalize_wire_preset_edges(p.edges);
                    p
                })
                .collect();
            f
        })
        .unwrap_or_else(|_| default_wire_presets_file());
    seed_missing_wire_preset_times(&mut file);
    file
}

fn save_wire_presets(file: &WirePresetsFile) -> Result<(), String> {
    fs::create_dir_all(notes_config_dir()).map_err(|e| e.to_string())?;
    let path = wire_presets_path();
    let raw = serde_json::to_string_pretty(file).map_err(|e| e.to_string())?;
    fs::write(&path, raw).map_err(|e| e.to_string())
}

fn new_preset_id(ts_ms: u64) -> String {
    let n = (ts_ms ^ (ts_ms >> 9)) & 0xffff;
    format!("preset_{ts_ms}_{n:04x}")
}

#[tauri::command]
pub fn notes_wire_presets_get() -> Result<WirePresetsFile, String> {
    Ok(load_wire_presets())
}

#[tauri::command]
pub fn notes_wire_presets_save(file: WirePresetsFile) -> Result<WirePresetsFile, String> {
    let now = now_ms();
    let existing = load_wire_presets();
    let existing_map: std::collections::BTreeMap<String, WirePreset> = existing
        .presets
        .into_iter()
        .map(|p| (p.id.clone(), p))
        .collect();
    let mut out = WirePresetsFile {
        v: 1,
        presets: vec![],
    };
    for mut p in file.presets {
        if p.id.trim().is_empty() {
            p.id = new_preset_id(now);
            p.created_at = now;
            p.updated_at = now;
        }
        p.name = p.name.trim().to_string();
        if p.name.is_empty() {
            return Err("存档名称不能为空".into());
        }
        if p.name.len() > 120 {
            p.name.truncate(120);
        }
        if p.note.len() > 500 {
            p.note.truncate(500);
        }
        p.edges = normalize_wire_preset_edges(p.edges);
        match existing_map.get(&p.id) {
            Some(old) => {
                if p.created_at == 0 {
                    p.created_at = old.created_at;
                }
                let changed = p.name != old.name || p.note != old.note || p.edges != old.edges;
                if changed {
                    p.updated_at = now;
                } else if p.updated_at == 0 {
                    p.updated_at = old.updated_at;
                }
            }
            None => {
                if p.created_at == 0 {
                    p.created_at = now;
                }
                if p.updated_at == 0 {
                    p.updated_at = now;
                }
            }
        }
        out.presets.push(p);
    }
    out.presets.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    save_wire_presets(&out)?;
    Ok(out)
}

#[tauri::command]
pub fn notes_wire_presets_delete(preset_id: String) -> Result<WirePresetsFile, String> {
    let mut file = load_wire_presets();
    let id = preset_id.trim();
    if id.is_empty() {
        return Err("缺少 preset_id".into());
    }
    file.presets.retain(|p| p.id != id);
    save_wire_presets(&file)?;
    Ok(file)
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClueBoardNode {
    pub id: String,
    #[serde(default)]
    pub text: String,
    pub x: f64,
    pub y: f64,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub rotation: Option<f64>,
    #[serde(default)]
    pub w: Option<f64>,
    #[serde(default)]
    pub h: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClueBoardEdge {
    pub id: String,
    pub from: String,
    pub to: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub struct ClueBoardView {
    pub x: f64,
    pub y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zoom: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClueBoard {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub nodes: Vec<ClueBoardNode>,
    #[serde(default)]
    pub edges: Vec<ClueBoardEdge>,
    #[serde(default)]
    pub view: Option<ClueBoardView>,
    /// Unix ms. 0 = unknown; seeded on load/save from history or file mtime.
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClueBoardsFile {
    pub v: u32,
    #[serde(default)]
    pub active_id: String,
    #[serde(default)]
    pub boards: Vec<ClueBoard>,
}

static CLUE_BOARDS_LOCK: Mutex<()> = Mutex::new(());

fn clue_boards_lock() -> std::sync::MutexGuard<'static, ()> {
    CLUE_BOARDS_LOCK
        .lock()
        .unwrap_or_else(|e| e.into_inner())
}

/// Legacy single-board file (`clue_board.json` v1).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClueBoardFile {
    pub v: u32,
    #[serde(default)]
    pub nodes: Vec<ClueBoardNode>,
    #[serde(default)]
    pub edges: Vec<ClueBoardEdge>,
    #[serde(default)]
    pub view: Option<ClueBoardView>,
}

pub(crate) fn new_board_id() -> String {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let n = (ts ^ (ts >> 11)) & 0xffff;
    format!("board_{ts}_{n:04x}")
}

pub(crate) fn new_edge_id() -> String {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let n = (ts ^ (ts >> 7)) & 0xffff;
    format!("edge_{ts}_{n:04x}")
}

fn default_clue_boards() -> ClueBoardsFile {
    let id = new_board_id();
    let now = now_ms();
    ClueBoardsFile {
        v: 2,
        active_id: id.clone(),
        boards: vec![ClueBoard {
            id,
            title: String::new(),
            nodes: vec![],
            edges: vec![],
            view: None,
            created_at: now,
            updated_at: now,
        }],
    }
}

fn normalize_clue_view(view: &mut Option<ClueBoardView>) {
    if let Some(ref mut v) = view {
        if !v.x.is_finite() {
            v.x = 0.0;
        }
        if !v.y.is_finite() {
            v.y = 0.0;
        }
        v.x = v.x.clamp(-50000.0, 50000.0);
        v.y = v.y.clamp(-50000.0, 50000.0);
        if let Some(z) = v.zoom {
            v.zoom = Some(if z.is_finite() { z.clamp(0.25, 2.0) } else { 1.0 });
        }
    }
}

fn normalize_clue_nodes_edges(
    nodes: Vec<ClueBoardNode>,
    edges: Vec<ClueBoardEdge>,
) -> (Vec<ClueBoardNode>, Vec<ClueBoardEdge>) {
    let mut out_nodes = Vec::new();
    let mut seen_ids = std::collections::BTreeSet::<String>::new();
    for mut n in nodes {
        n.id = n.id.trim().to_string();
        if n.id.is_empty() || n.id.len() > 128 || !seen_ids.insert(n.id.clone()) {
            continue;
        }
        if !n.x.is_finite() {
            n.x = 0.0;
        }
        if !n.y.is_finite() {
            n.y = 0.0;
        }
        if n.text.len() > 4000 {
            n.text.truncate(4000);
        }
        if let Some(ref c) = n.color {
            if c.len() > 32 {
                n.color = Some(c.chars().take(32).collect());
            }
        }
        n.rotation = None;
        // Match UI clampSize (CLUE_MIN/MAX_W/H): clamp finite sizes; never drop on reload.
        n.w = n.w.and_then(|w| {
            if w.is_finite() {
                Some(w.clamp(120.0, 1600.0))
            } else {
                None
            }
        });
        n.h = n.h.and_then(|h| {
            if h.is_finite() {
                Some(h.clamp(72.0, 1200.0))
            } else {
                None
            }
        });
        out_nodes.push(n);
    }
    if out_nodes.len() > 500 {
        out_nodes.truncate(500);
    }
    let node_ids: std::collections::BTreeSet<String> =
        out_nodes.iter().map(|n| n.id.clone()).collect();

    let mut out_edges = Vec::new();
    let mut seen_edges = std::collections::BTreeSet::<(String, String)>::new();
    for mut e in edges {
        e.id = e.id.trim().to_string();
        e.from = e.from.trim().to_string();
        e.to = e.to.trim().to_string();
        if e.id.is_empty() || e.from.is_empty() || e.to.is_empty() || e.from == e.to {
            continue;
        }
        if !node_ids.contains(&e.from) || !node_ids.contains(&e.to) {
            continue;
        }
        if e.id.len() > 128 {
            e.id.truncate(128);
        }
        let key = (e.from.clone(), e.to.clone());
        if !seen_edges.insert(key) {
            continue;
        }
        out_edges.push(e);
        if out_edges.len() >= 2000 {
            break;
        }
    }
    (out_nodes, out_edges)
}

fn normalize_clue_board(mut board: ClueBoardFile) -> ClueBoardFile {
    board.v = 1;
    let (nodes, edges) = normalize_clue_nodes_edges(board.nodes, board.edges);
    board.nodes = nodes;
    board.edges = edges;
    normalize_clue_view(&mut board.view);
    board
}

fn normalize_clue_board_entry(mut board: ClueBoard) -> Option<ClueBoard> {
    board.id = board.id.trim().to_string();
    if board.id.is_empty() || board.id.len() > 128 {
        return None;
    }
    board.title = board.title.trim().to_string();
    if board.title.len() > 120 {
        board.title.truncate(120);
    }
    let (nodes, edges) = normalize_clue_nodes_edges(board.nodes, board.edges);
    board.nodes = nodes;
    board.edges = edges;
    normalize_clue_view(&mut board.view);
    Some(board)
}

fn normalize_clue_boards(mut data: ClueBoardsFile) -> ClueBoardsFile {
    data.v = 2;
    let mut boards = Vec::new();
    let mut seen_ids = std::collections::BTreeSet::<String>::new();
    for b in data.boards {
        if let Some(nb) = normalize_clue_board_entry(b) {
            if seen_ids.insert(nb.id.clone()) {
                boards.push(nb);
            }
        }
    }
    if boards.len() > 100 {
        boards.truncate(100);
    }
    if boards.is_empty() {
        return default_clue_boards();
    }
    data.active_id = data.active_id.trim().to_string();
    if !boards.iter().any(|b| b.id == data.active_id) {
        data.active_id = boards[0].id.clone();
    }
    data.boards = boards;
    data
}

fn legacy_board_to_boards(legacy: ClueBoardFile) -> ClueBoardsFile {
    let b = normalize_clue_board(legacy);
    let id = new_board_id();
    let mut data = ClueBoardsFile {
        v: 2,
        active_id: id.clone(),
        boards: vec![ClueBoard {
            id,
            title: String::new(),
            nodes: b.nodes,
            edges: b.edges,
            view: b.view,
            created_at: 0,
            updated_at: 0,
        }],
    };
    seed_missing_clue_board_times(&mut data);
    data
}

fn clue_board_content_eq(a: &ClueBoard, b: &ClueBoard) -> bool {
    a.title == b.title && a.nodes == b.nodes && a.edges == b.edges && a.view == b.view
}

fn seed_missing_clue_board_times(data: &mut ClueBoardsFile) {
    let mtime = file_mtime_ms_opt(&clue_boards_path())
        .or_else(|| file_mtime_ms_opt(&clue_board_path()));
    for b in &mut data.boards {
        crate::notes_clue_history::seed_board_timestamps(b, mtime);
    }
}

/// On save: keep/seed existing times; bump `updated_at` only when that board's content changes.
/// New ids with no seedable history/mtime get now (genuine create). Never invent now for old ids.
fn stamp_clue_board_times(data: &mut ClueBoardsFile, existing: Option<&ClueBoardsFile>) {
    let now = now_ms();
    let mtime = file_mtime_ms_opt(&clue_boards_path())
        .or_else(|| file_mtime_ms_opt(&clue_board_path()));
    let existing_map: std::collections::BTreeMap<String, ClueBoard> = existing
        .map(|e| {
            e.boards
                .iter()
                .cloned()
                .map(|b| (b.id.clone(), b))
                .collect()
        })
        .unwrap_or_default();
    for b in &mut data.boards {
        match existing_map.get(&b.id) {
            Some(old) => {
                if b.created_at == 0 {
                    b.created_at = old.created_at;
                }
                crate::notes_clue_history::seed_board_timestamps(b, mtime);
                if !clue_board_content_eq(b, old) {
                    b.updated_at = now;
                } else if b.updated_at == 0 {
                    b.updated_at = old.updated_at;
                    crate::notes_clue_history::seed_board_timestamps(b, mtime);
                }
            }
            None => {
                if b.created_at == 0 {
                    b.created_at = now;
                }
                if b.updated_at == 0 {
                    b.updated_at = now;
                }
            }
        }
    }
}

fn parse_clue_boards_raw(raw: &str) -> Option<ClueBoardsFile> {
    if let Ok(data) = serde_json::from_str::<ClueBoardsFile>(raw) {
        if !data.boards.is_empty() {
            return Some(normalize_clue_boards(data));
        }
    }
    if let Ok(legacy) = serde_json::from_str::<ClueBoardFile>(raw) {
        return Some(legacy_board_to_boards(legacy));
    }
    None
}

/// Count nodes that still carry user text (used to detect empty shadow files).
fn clue_boards_text_score(data: &ClueBoardsFile) -> usize {
    data.boards
        .iter()
        .flat_map(|b| b.nodes.iter())
        .filter(|n| !n.text.trim().is_empty())
        .count()
}

fn merge_legacy_when_primary_empty(
    primary: ClueBoardsFile,
    legacy: ClueBoardsFile,
) -> ClueBoardsFile {
    if clue_boards_text_score(&primary) > 0 || clue_boards_text_score(&legacy) == 0 {
        return primary;
    }
    // Primary multi-board file can shadow a rich legacy single-board file.
    // Prefer legacy content as active, keep primary boards after it.
    let mut out = legacy;
    let mut seen: std::collections::BTreeSet<String> =
        out.boards.iter().map(|b| b.id.clone()).collect();
    for b in primary.boards {
        if seen.insert(b.id.clone()) {
            out.boards.push(b);
        }
    }
    normalize_clue_boards(out)
}

fn read_clue_boards_file(path: &Path) -> Option<ClueBoardsFile> {
    fs::read_to_string(path)
        .ok()
        .and_then(|raw| parse_clue_boards_raw(&raw))
}

fn backup_clue_boards_before_restore(path: &Path) {
    if !path.is_file() {
        return;
    }
    let stamp = chrono::Local::now().format("%Y%m%d_%H%M%S");
    let bak = notes_config_dir().join(format!("clue_boards.json.bak_before_restore_{stamp}"));
    let _ = fs::copy(path, bak);
}

fn load_clue_boards_unlocked() -> ClueBoardsFile {
    let path = clue_boards_path();
    let primary = read_clue_boards_file(&path);
    // If primary is missing (Windows replace used to unlink first), prefer bak/tmp
    // over inventing a new id from legacy `clue_board.json`.
    let mut data = if let Some(p) = primary {
        let legacy = read_clue_boards_file(&clue_board_path());
        if let Some(l) = legacy {
            merge_legacy_when_primary_empty(p, l)
        } else {
            p
        }
    } else if let Some(bak) = read_clue_boards_file(&path.with_extension("json.bak")) {
        bak
    } else if let Some(tmp) = read_clue_boards_file(&path.with_extension("json.tmp")) {
        tmp
    } else if let Some(legacy) = read_clue_boards_file(&clue_board_path()) {
        legacy
    } else {
        ClueBoardsFile {
            v: 2,
            active_id: String::new(),
            boards: vec![],
        }
    };

    let restored = crate::notes_clue_history::merge_history_orphans(&mut data);
    if data.boards.is_empty() {
        data = default_clue_boards();
    } else {
        data = normalize_clue_boards(data);
    }
    seed_missing_clue_board_times(&mut data);
    if restored > 0 {
        backup_clue_boards_before_restore(&path);
        let _ = write_clue_boards_file(&data);
    }
    data
}

fn load_clue_boards() -> ClueBoardsFile {
    let _g = clue_boards_lock();
    load_clue_boards_unlocked()
}

/// Write dest by copying a complete tmp over it. Never unlink dest first
/// (that gap made load fall back to legacy `clue_board.json` and mint a new id).
fn write_clue_boards_file(data: &ClueBoardsFile) -> Result<(), String> {
    fs::create_dir_all(notes_config_dir()).map_err(|e| e.to_string())?;
    let path = clue_boards_path();
    let raw = serde_json::to_string_pretty(data).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, &raw).map_err(|e| format!("写线索板临时文件失败: {e}"))?;
    if path.is_file() {
        let bak = path.with_extension("json.bak");
        let _ = fs::copy(&path, &bak);
        let day = chrono::Local::now().format("%Y%m%d").to_string();
        let bak_dir = notes_config_dir().join("clue_boards_bak");
        let _ = fs::create_dir_all(&bak_dir);
        let day_bak = bak_dir.join(format!("clue_boards_{day}.json"));
        if !day_bak.is_file() {
            let _ = fs::copy(&path, &day_bak);
        }
    }
    fs::copy(&tmp, &path).map_err(|e| format!("替换线索板文件失败: {e}"))?;
    let _ = fs::remove_file(&tmp);
    Ok(())
}

/// Same-id merge: UI payload wins overlapping nodes; keep disk-only ids when disk is newer
/// (MCP create_note racing a stale persistNow).
fn merge_matching_board(mut incoming: ClueBoard, disk: &ClueBoard) -> ClueBoard {
    if clue_board_content_eq(&incoming, disk) {
        return disk.clone();
    }
    if disk.updated_at > incoming.updated_at {
        let mut seen_n: std::collections::BTreeSet<String> =
            incoming.nodes.iter().map(|n| n.id.clone()).collect();
        for n in &disk.nodes {
            if seen_n.insert(n.id.clone()) {
                incoming.nodes.push(n.clone());
            }
        }
        let mut seen_e: std::collections::BTreeSet<String> =
            incoming.edges.iter().map(|e| e.id.clone()).collect();
        for e in &disk.edges {
            if seen_e.insert(e.id.clone()) {
                incoming.edges.push(e.clone());
            }
        }
        if incoming.title.is_empty() && !disk.title.is_empty() {
            incoming.title = disk.title.clone();
        }
    }
    if incoming.created_at == 0 {
        incoming.created_at = disk.created_at;
    }
    incoming
}

fn existing_boards_for_upsert() -> Option<ClueBoardsFile> {
    let mut existing = read_clue_boards_file(&clue_boards_path());
    match existing.as_mut() {
        Some(ex) => {
            let _ = crate::notes_clue_history::merge_history_orphans(ex);
        }
        None => {
            let mut empty = ClueBoardsFile {
                v: 2,
                active_id: String::new(),
                boards: vec![],
            };
            if crate::notes_clue_history::merge_history_orphans(&mut empty) > 0 {
                existing = Some(empty);
            }
        }
    }
    existing
}

fn merge_upsert_boards(
    existing: Option<&ClueBoardsFile>,
    incoming: ClueBoardsFile,
) -> Result<ClueBoardsFile, String> {
    let incoming_active = incoming.active_id.clone();
    let mut merged = incoming;
    if let Some(ex) = existing {
        let ex_map: std::collections::BTreeMap<String, ClueBoard> = ex
            .boards
            .iter()
            .cloned()
            .map(|b| (b.id.clone(), b))
            .collect();
        merged.boards = merged
            .boards
            .into_iter()
            .map(|b| {
                if let Some(old) = ex_map.get(&b.id) {
                    merge_matching_board(b, old)
                } else {
                    b
                }
            })
            .collect();
        let incoming_ids: std::collections::BTreeSet<String> =
            merged.boards.iter().map(|b| b.id.clone()).collect();
        for b in &ex.boards {
            if !incoming_ids.contains(&b.id) {
                merged.boards.push(b.clone());
            }
        }
        let existing_score = clue_boards_text_score(ex);
        let merged_score = clue_boards_text_score(&merged);
        if existing_score > 0 && merged_score == 0 {
            return Err(format!(
                "refusing to overwrite clue_boards.json ({existing_score} text nodes) with empty content"
            ));
        }
        if incoming_active.is_empty()
            || !merged.boards.iter().any(|b| b.id == incoming_active)
        {
            if ex.boards.iter().any(|b| b.id == ex.active_id) {
                merged.active_id = ex.active_id.clone();
            }
        }
    }
    Ok(normalize_clue_boards(merged))
}

fn save_clue_boards_upsert_unlocked(data: &ClueBoardsFile) -> Result<ClueBoardsFile, String> {
    let existing = existing_boards_for_upsert();
    let mut merged = merge_upsert_boards(existing.as_ref(), data.clone())?;
    stamp_clue_board_times(&mut merged, existing.as_ref());
    write_clue_boards_file(&merged)?;
    Ok(merged)
}

fn save_clue_boards_replace_unlocked(data: &ClueBoardsFile) -> Result<ClueBoardsFile, String> {
    let path = clue_boards_path();
    let existing = read_clue_boards_file(&path);
    if let Some(ref existing) = existing {
        let existing_score = clue_boards_text_score(existing);
        let incoming_score = clue_boards_text_score(data);
        if existing_score > 0 && incoming_score == 0 {
            return Err(format!(
                "refusing to overwrite clue_boards.json ({existing_score} text nodes) with empty content"
            ));
        }
    }
    let mut merged = normalize_clue_boards(data.clone());
    stamp_clue_board_times(&mut merged, existing.as_ref());
    write_clue_boards_file(&merged)?;
    Ok(merged)
}

/// Load → mutate → replace, one lock (MCP / rollback).
pub fn with_clue_boards<T, F>(f: F) -> Result<T, String>
where
    F: FnOnce(&mut ClueBoardsFile) -> Result<T, String>,
{
    let _g = clue_boards_lock();
    let mut data = load_clue_boards_unlocked();
    let out = f(&mut data)?;
    save_clue_boards_replace_unlocked(&data)?;
    Ok(out)
}

#[tauri::command]
pub fn notes_clue_board_load() -> Result<ClueBoardsFile, String> {
    Ok(load_clue_boards())
}

#[tauri::command]
pub fn notes_clue_board_save(data: ClueBoardsFile) -> Result<ClueBoardsFile, String> {
    let _g = clue_boards_lock();
    let b = normalize_clue_boards(data);
    save_clue_boards_upsert_unlocked(&b)
}

#[tauri::command]
pub fn notes_clue_board_delete(board_id: String) -> Result<ClueBoardsFile, String> {
    let bid = board_id.trim().to_string();
    if bid.is_empty() {
        return Err("缺少 board_id".into());
    }
    let _g = clue_boards_lock();
    let mut data = load_clue_boards_unlocked();
    if data.boards.len() <= 1 {
        return Err("至少保留一块线索板".into());
    }
    if !data.boards.iter().any(|b| b.id == bid) {
        return Ok(data);
    }
    data.boards.retain(|b| b.id != bid);
    if data.active_id == bid {
        data.active_id = data.boards.first().map(|b| b.id.clone()).unwrap_or_default();
    }
    save_clue_boards_replace_unlocked(&data)
}

pub fn notes_clue_board_load_internal() -> Result<ClueBoardsFile, String> {
    Ok(load_clue_boards())
}

pub fn notes_clue_board_save_internal(data: ClueBoardsFile) -> Result<(), String> {
    let _g = clue_boards_lock();
    let b = normalize_clue_boards(data);
    save_clue_boards_upsert_unlocked(&b)?;
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
pub struct PresetCardSnippet {
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SuggestPresetNoteReq {
    pub edges: Vec<Vec<String>>,
    #[serde(default)]
    pub cards: Vec<PresetCardSnippet>,
    #[serde(default)]
    pub model_key: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SuggestPresetMeta {
    pub name: String,
    pub note: String,
}

#[tauri::command]
pub async fn notes_wire_preset_suggest_note(
    req: SuggestPresetNoteReq,
) -> Result<SuggestPresetMeta, String> {
    llm_sidecar_ensure_running_async().await?;
    let pf = load_providers();
    let model_key = req
        .model_key
        .filter(|k| !k.trim().is_empty())
        .or_else(|| pf.default_model_key.clone())
        .ok_or("请先在笔记设置中配置模型")?;
    let model = resolve_model(&model_key)?;
    let mut lines = vec!["连线组合（节点 id）：".to_string()];
    for pair in &req.edges {
        if pair.len() >= 2 {
            lines.push(format!("- {} ↔ {}", pair[0], pair[1]));
        }
    }
    if !req.cards.is_empty() {
        lines.push(String::new());
        lines.push("相关卡片摘要：".to_string());
        for c in &req.cards {
            let t = c.text.trim();
            if t.is_empty() {
                continue;
            }
            let preview: String = t.chars().take(160).collect();
            lines.push(format!("- {}: {}", c.id, preview));
        }
    }
    lines.push(String::new());
    lines.push(
        "请用一句 JSON 概括这个对话存档：{\"name\":\"不超过12字的标题\",\"note\":\"不超过40字的备注\"}。只输出 JSON，不要Markdown。"
            .to_string(),
    );
    let prompt = lines.join("\n");
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(45))
        .build()
        .map_err(|e| e.to_string())?;
    let body = json!({
        "model": model.proxy_name,
        "max_tokens": 120,
        "temperature": 0.3,
        "messages": [{ "role": "user", "content": prompt }],
    });
    let resp = client
        .post(format!("{LLM_SIDECAR_URL}/v1/chat/completions"))
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("请求 sidecar 失败: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let err_body = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {}: {}", status.as_u16(), err_body));
    }
    let v: Value = resp.json().await.map_err(|e| e.to_string())?;
    let text = v
        .pointer("/choices/0/message/content")
        .and_then(|x| x.as_str())
        .unwrap_or("")
        .trim()
        .trim_matches(['"', '\'', '「', '」', '“', '”'])
        .to_string();
    if text.is_empty() {
        return Err("模型未返回名称".into());
    }
    if let Ok(obj) = serde_json::from_str::<Value>(&text) {
        let name: String = obj
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .chars()
            .take(24)
            .collect();
        let note: String = obj
            .get("note")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .chars()
            .take(80)
            .collect();
        if !name.trim().is_empty() || !note.trim().is_empty() {
            return Ok(SuggestPresetMeta {
                name: name.trim().to_string(),
                note: note.trim().to_string(),
            });
        }
    }
    let stripped = text
        .trim()
        .trim_start_matches("```json")
        .trim_start_matches("```")
        .trim_end_matches("```")
        .trim();
    if let Ok(obj) = serde_json::from_str::<Value>(stripped) {
        let name: String = obj
            .get("name")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .chars()
            .take(24)
            .collect();
        let note: String = obj
            .get("note")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .chars()
            .take(80)
            .collect();
        if !name.trim().is_empty() || !note.trim().is_empty() {
            return Ok(SuggestPresetMeta {
                name: name.trim().to_string(),
                note: note.trim().to_string(),
            });
        }
    }
    let note: String = text.chars().take(80).collect();
    Ok(SuggestPresetMeta {
        name: String::new(),
        note,
    })
}

fn image_path_to_data_url(path: &str) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("读图片失败 {path}: {e}"))?;
    let lower = path.to_lowercase();
    let mime = if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".bmp") {
        "image/bmp"
    } else if lower.ends_with(".webp") {
        "image/webp"
    } else if lower.ends_with(".gif") {
        "image/gif"
    } else {
        "application/octet-stream"
    };
    use base64::Engine;
    let b64 = base64::engine::general_purpose::STANDARD.encode(bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

fn persist_user_images(
    created_at: u64,
    card_id: &str,
    source_paths: &[String],
) -> Result<Vec<String>, String> {
    if source_paths.is_empty() {
        return Ok(vec![]);
    }
    let dest_dir = card_attachments_dir(created_at, card_id);
    fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let mut saved = Vec::new();
    for (i, src) in source_paths.iter().enumerate() {
        let src = src.trim();
        if src.is_empty() {
            continue;
        }
        if !PathBuf::from(src).is_file() {
            return Err(format!("图片不存在: {src}"));
        }
        let ext = std::path::Path::new(src)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("png");
        let dest = dest_dir.join(format!("{i}.{ext}"));
        fs::copy(src, &dest).map_err(|e| format!("复制图片失败: {e}"))?;
        saved.push(dest.to_string_lossy().into_owned());
    }
    Ok(saved)
}

fn build_user_message_content(text: &str, images: &[String]) -> Value {
    if images.is_empty() {
        return json!(text);
    }
    let mut parts: Vec<Value> = Vec::new();
    if !text.is_empty() {
        parts.push(json!({ "type": "text", "text": text }));
    }
    for path in images {
        if let Ok(url) = image_path_to_data_url(path) {
            parts.push(json!({
                "type": "image_url",
                "image_url": { "url": url }
            }));
        }
    }
    if parts.is_empty() {
        json!(text)
    } else if parts.len() == 1 {
        parts.into_iter().next().unwrap_or(json!(text))
    } else {
        json!(parts)
    }
}

fn build_chat_messages(
    user_text: &str,
    history: Option<Vec<ChatTurnMessage>>,
    system: Option<&str>,
    user_images: Option<&[String]>,
) -> Vec<Value> {
    let mut out = Vec::new();
    if let Some(s) = system {
        if !s.is_empty() {
            out.push(json!({ "role": "system", "content": s }));
        }
    }
    if let Some(h) = history {
        let mut indexed: Vec<(usize, ChatTurnMessage)> =
            h.into_iter().enumerate().collect();
        // Stable chronological order: created_at asc, then original index.
        indexed.sort_by(|a, b| {
            let ta = a.1.created_at.unwrap_or(0);
            let tb = b.1.created_at.unwrap_or(0);
            ta.cmp(&tb).then_with(|| a.0.cmp(&b.0))
        });
        if let Some(ts_note) = history_timestamps_system_message(
            &indexed.iter().map(|(_, m)| m).collect::<Vec<_>>(),
        ) {
            out.push(json!({ "role": "system", "content": ts_note }));
        }
        for (_, m) in indexed {
            let role = m.role.trim();
            if role != "user" && role != "assistant" {
                continue;
            }
            if m.content.is_empty() {
                continue;
            }
            out.push(json!({ "role": role, "content": m.content }));
        }
    }
    out.push(json!({
        "role": "user",
        "content": build_user_message_content(user_text, user_images.unwrap_or(&[]))
    }));
    out
}

/// Machine-readable prior-turn timestamps for the model (ascending).
fn history_timestamps_system_message(history: &[&ChatTurnMessage]) -> Option<String> {
    let mut lines = Vec::new();
    let mut seen = std::collections::BTreeSet::<String>::new();
    let mut n = 0u32;
    for m in history {
        let Some(ts) = m.created_at.filter(|t| *t > 0) else {
            continue;
        };
        let cid = m
            .card_id
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or("-");
        let key = format!("{ts}|{cid}");
        if !seen.insert(key) {
            continue;
        }
        n += 1;
        let utc = chrono::DateTime::<Utc>::from_timestamp_millis(ts as i64)
            .map(|d| d.to_rfc3339_opts(SecondsFormat::Millis, true))
            .unwrap_or_else(|| ts.to_string());
        lines.push(format!(
            "{n}. created_at_ms={ts} utc={utc} card_id={cid}"
        ));
    }
    if lines.is_empty() {
        return None;
    }
    Some(format!(
        "[prior_turn_timestamps order=ascending_created_at]\n\
Prior conversation cards (oldest first). Use these timestamps to know when earlier turns happened.\n\
{}\n\
[/prior_turn_timestamps]",
        lines.join("\n")
    ))
}

fn mcp_prefs_from_turn(opts: &NotesTurnOpts) -> McpPrefs {
    let mut prefs = notes_mcp::load_mcp_prefs();
    if let Some(m) = opts.mcp.as_ref() {
        prefs.inject_product_context = m.inject_product_context;
        let enabled: std::collections::HashSet<_> =
            m.enabled_server_ids.iter().cloned().collect();
        for s in &mut prefs.servers {
            s.enabled = enabled.contains(&s.id);
        }
    }
    prefs
}

fn apply_turn_body_opts(body: &mut Value, opts: &NotesTurnOpts) {
    if let Some(t) = opts.temperature {
        body["temperature"] = json!(t);
    }
    if let Some(m) = opts.max_tokens {
        body["max_tokens"] = json!(m);
    }
    if let Some(p) = opts.top_p {
        body["top_p"] = json!(p);
    }
    if opts.thinking_toggle {
        if opts.thinking {
            let mut thinking = json!({ "type": "enabled" });
            if let Some(b) = opts.thinking_budget {
                thinking["budget_tokens"] = json!(b);
            }
            body["thinking"] = thinking;
        } else {
            body["thinking"] = json!({ "type": "disabled" });
        }
    } else if opts.thinking {
        // 无开关但仍要开思考（少见）：只发 enabled
        let mut thinking = json!({ "type": "enabled" });
        if let Some(b) = opts.thinking_budget {
            thinking["budget_tokens"] = json!(b);
        }
        body["thinking"] = thinking;
    }
    let effort = opts.effort.trim();
    if !effort.is_empty() {
        // 原样下发；由前端按模型白名单裁剪（DeepSeek / OpenAI / Gemini3→thinking_level）
        body["reasoning_effort"] = json!(effort);
    }
    if opts.google_search {
        let gtool = json!({ "googleSearch": {} });
        match body.get_mut("tools") {
            Some(Value::Array(arr)) => {
                let already = arr.iter().any(|t| t.get("googleSearch").is_some());
                if !already {
                    arr.push(gtool);
                }
            }
            _ => {
                body["tools"] = json!([gtool]);
            }
        }
    }
}

#[tauri::command]
pub fn notes_save_user_only_card(
    user_text: String,
    image_paths: Option<Vec<String>>,
    user_glyphs: Option<Vec<UserGlyph>>,
) -> Result<SendTurnStart, String> {
    let text = user_text.trim().to_string();
    let imgs = image_paths.unwrap_or_default();
    if text.is_empty() && imgs.is_empty() {
        return Err("请输入内容或添加图片".into());
    }
    let created_at = now_ms();
    let card_id = new_card_id(created_at);
    ensure_notes_dirs(created_at).map_err(|e| e.to_string())?;
    let user_images = persist_user_images(created_at, &card_id, &imgs)?;
    let log_path = log_file_path(created_at, &card_id)
        .to_string_lossy()
        .into_owned();
    let card = NotesCard {
        v: 1,
        id: card_id.clone(),
        created_at,
        status: "done".into(),
        model: NotesModelRef {
            provider_id: "none".into(),
            provider_label: "NONE".into(),
            model_id: "none".into(),
            label: "NONE".into(),
            litellm_model: String::new(),
            proxy_name: String::new(),
        },
        user_text: text,
        user_glyphs: sanitize_user_glyphs(user_glyphs.unwrap_or_default()),
        assistant_text: String::new(),
        thinking_text: None,
        timings_ms: TimingsMs::default(),
        timings_delta_s: TimingsDeltaS::default(),
        usage: TokenUsage::default(),
        cost: CostBreakdown {
            currency: "USD".into(),
            priced: false,
            ..Default::default()
        },
        log_path,
        error: None,
        from_wire_context: false,
        wire_preset_id: None,
        wire_preset_name: None,
        wire_preset_note: None,
        wire_preset_created_at: None,
        user_images,
        mcp_servers: vec![],
        mcp_tools: vec![],
        import_source: None,
        mcp_activity: None,
    };
    write_card(&card)?;
    Ok(SendTurnStart {
        card_id,
        created_at,
    })
}

#[tauri::command]
pub async fn notes_send_turn(
    app: AppHandle,
    user_text: String,
    model_key: String,
    opts: Option<NotesTurnOpts>,
    history: Option<Vec<ChatTurnMessage>>,
) -> Result<SendTurnStart, String> {
    let text = user_text.trim().to_string();
    let opts = opts.unwrap_or_default();
    if text.is_empty() && opts.image_paths.is_empty() {
        return Err("请输入内容或添加图片".into());
    }
    let sink = ProgressSink::new(app.clone(), "send_turn");
    sink.emit("sidecar", "检查 / 拉起 LiteLLM sidecar…", 8);
    llm_sidecar_ensure_running_async()
        .await
        .map_err(|e| {
            sink.done_err(&e);
            e
        })?;
    sink.emit("resolve", &format!("解析模型 {model_key}…"), 20);
    let model = resolve_model(&model_key).map_err(|e| {
        sink.done_err(&e);
        e
    })?;
    sink.emit("card", "写入卡片占位并开始流式请求…", 35);
    let created_at = now_ms();
    let card_id = new_card_id(created_at);
    ensure_notes_dirs(created_at).map_err(|e| e.to_string())?;
    let log_path = log_file_path(created_at, &card_id)
        .to_string_lossy()
        .into_owned();
    let user_images = persist_user_images(created_at, &card_id, &opts.image_paths)?;
    let (from_wire_context, wire_preset_id, wire_preset_name, wire_preset_note, wire_preset_created_at) =
        wire_context_from_opts(&opts);
    let card = NotesCard {
        v: 1,
        id: card_id.clone(),
        created_at,
        status: "streaming".into(),
        model: model.clone(),
        user_text: text.clone(),
        user_glyphs: sanitize_user_glyphs(opts.user_glyphs.clone()),
        assistant_text: String::new(),
        thinking_text: None,
        timings_ms: TimingsMs::default(),
        timings_delta_s: TimingsDeltaS::default(),
        usage: TokenUsage::default(),
        cost: CostBreakdown {
            currency: "USD".into(),
            priced: false,
            ..Default::default()
        },
        log_path: log_path.clone(),
        error: None,
        from_wire_context,
        wire_preset_id,
        wire_preset_name,
        wire_preset_note,
        wire_preset_created_at,
        user_images: user_images.clone(),
        mcp_servers: vec![],
        mcp_tools: vec![],
        import_source: None,
        mcp_activity: None,
    };
    write_card(&card)?;
    let start = SendTurnStart {
        card_id: card_id.clone(),
        created_at,
    };
    sink.emit(
        "stream",
        &format!("流式请求已启动 · {}", model.label),
        50,
    );
    // 流式过程用卡片打字机；进度面板可先收尾
    sink.done_ok("已进入流式输出（进度见卡片）");
    let app2 = app.clone();
    let err_id = card_id.clone();
    let mcp_prefs = mcp_prefs_from_turn(&opts);
    let mut system_parts: Vec<String> = Vec::new();
    if notes_mcp::any_mcp_enabled(&mcp_prefs) && mcp_prefs.inject_product_context {
        system_parts.push(notes_mcp::product_context_system_message());
    }
    let enabled = notes_mcp::enabled_server_ids(&mcp_prefs);
    if enabled.contains(notes_mcp::SERVER_CLUE_BOARD) {
        let viewing = opts
            .mcp
            .as_ref()
            .map(|m| m.viewing_clue_board)
            .unwrap_or(false);
        let bid = opts
            .mcp
            .as_ref()
            .and_then(|m| m.active_board_id.as_deref());
        system_parts.push(notes_mcp::clue_board_usage_system_message(viewing, bid));
    }
    let system = if system_parts.is_empty() {
        None
    } else {
        Some(system_parts.join("\n"))
    };
    let messages = build_chat_messages(
        &text,
        history,
        system.as_deref(),
        Some(&user_images),
    );
    tauri::async_runtime::spawn(async move {
        if let Err(e) = run_turn_stream(app2.clone(), card, messages, model, opts, mcp_prefs).await {
            let _ = app2.emit(
                "notes-stream-error",
                json!({ "card_id": err_id, "error": e }),
            );
        }
    });
    Ok(start)
}

async fn turn_stream_http_error(
    app: &AppHandle,
    card: &mut NotesCard,
    card_id: String,
    created_at: u64,
    status: u16,
    err_body: String,
    t: u64,
) -> Result<(), String> {
    let _ = append_log(
        t,
        &card_id,
        json!({ "kind": "http_error", "status": status, "body": err_body }),
    );
    card.status = "error".into();
    card.error = Some(humanize_llm_error(&format!("HTTP {status}: {err_body}")));
    card.timings_ms.completed = Some(t);
    card.timings_delta_s = compute_deltas(&card.timings_ms);
    write_card(card)?;
    let _ = app.emit(
        "notes-stream-done",
        json!({
            "card_id": card_id,
            "created_at": created_at,
            "status": "error",
            "card": card_to_summary(card),
        }),
    );
    Err(card.error.clone().unwrap_or_default())
}

/// OpenAI/LiteLLM SSE 错误帧：`{"error":{"message":"...","code":"404"}}` 等。
fn extract_sse_error(v: &Value) -> Option<String> {
    let err = v.get("error")?;
    if let Some(s) = err.as_str().filter(|s| !s.is_empty()) {
        return Some(s.to_string());
    }
    if let Some(m) = err
        .get("message")
        .and_then(|x| x.as_str())
        .filter(|s| !s.is_empty())
    {
        let code = err
            .get("code")
            .and_then(|c| {
                c.as_str()
                    .map(|s| s.to_string())
                    .or_else(|| c.as_i64().map(|n| n.to_string()))
            })
            .unwrap_or_default();
        if code.is_empty() {
            return Some(m.to_string());
        }
        return Some(format!("{m} (code {code})"));
    }
    Some(err.to_string())
}

/// 卡片主文短中文；完整原文写入协议日志（fail_stream_card）。
fn humanize_llm_error(raw: &str) -> String {
    let s = raw.trim();
    if s.is_empty() {
        return s.to_string();
    }
    let cut = s.split("\n\n原始：").next().unwrap_or(s).trim();
    let lower = cut.to_lowercase();
    let looks_vertex_name = lower.contains("vertexaiexception");
    let quota = lower.contains("resource_exhausted")
        || lower.contains("exceeded your current quota")
        || lower.contains("配额/额度")
        || lower.contains("额度用尽")
        || (lower.contains("ratelimit") && (lower.contains("429") || looks_vertex_name))
        || (lower.contains("429") && (looks_vertex_name || lower.contains("quota")));
    if quota {
        return "额度用尽或触发限速（HTTP 429）。请到 AI Studio 查看额度，或换较低档模型 / 关闭 Google Search 后再试。VertexAIException 仅为 LiteLLM 类名，不等于走了 Vertex。"
            .into();
    }
    if looks_vertex_name && (lower.contains("404") || lower.contains("notfound")) {
        return "Gemini 返回 404（模型名或路径问题）。VertexAIException 是 LiteLLM 类名误导，不等于 Vertex。详情见 data。"
            .into();
    }
    if looks_vertex_name {
        let head: String = cut.chars().take(200).collect();
        return format!(
            "{head}{}（VertexAIException=LiteLLM 类名）",
            if cut.chars().count() > 200 { "…" } else { "" }
        );
    }
    if cut.chars().count() > 240 {
        format!("{}…", cut.chars().take(240).collect::<String>())
    } else {
        cut.to_string()
    }
}

async fn fail_stream_card(
    app: &AppHandle,
    card: &mut NotesCard,
    card_id: &str,
    created_at: u64,
    err: String,
) -> Result<(), String> {
    let t_done = now_ms();
    let raw = err.trim().to_string();
    let short = humanize_llm_error(&raw);
    card.timings_ms.completed = Some(t_done);
    card.timings_delta_s = compute_deltas(&card.timings_ms);
    card.status = "error".into();
    card.error = Some(short.clone());
    write_card(card)?;
    let _ = append_log(
        t_done,
        card_id,
        json!({ "kind": "stream_error", "message": short, "raw": raw }),
    );
    let err = short;
    emit_stream_status(
        app,
        card_id,
        created_at,
        &format!("失败：{}", err.chars().take(120).collect::<String>()),
    );
    let _ = app.emit(
        "notes-stream-done",
        json!({
            "card_id": card_id,
            "created_at": created_at,
            "status": "error",
            "error": err,
            "card": card_to_summary(card),
        }),
    );
    Err(err)
}

fn emit_stream_status(app: &AppHandle, card_id: &str, created_at: u64, status_text: &str) {
    emit_stream_status_ex(app, card_id, created_at, status_text, None);
}

fn emit_stream_status_ex(
    app: &AppHandle,
    card_id: &str,
    created_at: u64,
    status_text: &str,
    activity: Option<&Value>,
) {
    let mut payload = json!({
        "card_id": card_id,
        "created_at": created_at,
        "status_text": status_text,
    });
    if let Some(a) = activity {
        payload["activity"] = a.clone();
    }
    let _ = app.emit("notes-stream-status", payload);
}

fn truncate_ui_chars(s: &str, max: usize) -> String {
    let mut out = String::new();
    for (i, ch) in s.chars().enumerate() {
        if i >= max {
            out.push('…');
            break;
        }
        out.push(ch);
    }
    out
}

/// 从工具参数里抽短目标：board / note / path / title 等，供卡片活动面板展示。
fn tool_target_summary(name: &str, args: &Value) -> String {
    let _ = name;
    let prefer = [
        "path",
        "file_path",
        "file",
        "board_id",
        "note_id",
        "node_id",
        "card_id",
        "title",
        "query",
        "id",
        "seq",
        "from",
        "to",
        "text",
    ];
    let mut parts: Vec<String> = Vec::new();
    for k in prefer {
        let Some(v) = args.get(k) else { continue };
        let s = match v {
            Value::String(s) => s.clone(),
            Value::Number(n) => n.to_string(),
            Value::Bool(b) => b.to_string(),
            _ => continue,
        };
        let s = s.trim();
        if s.is_empty() {
            continue;
        }
        let short = truncate_ui_chars(s, 56);
        let bit = match k {
            "path" | "file_path" | "file" | "title" | "query" => short,
            "text" => format!("text={short}"),
            _ => format!("{k}={short}"),
        };
        parts.push(bit);
        if parts.len() >= 2 {
            break;
        }
    }
    if !parts.is_empty() {
        return parts.join(" · ");
    }
    if let Some(obj) = args.as_object() {
        for (k, v) in obj {
            if let Some(s) = v.as_str() {
                let s = s.trim();
                if !s.is_empty() {
                    return format!("{k}={}", truncate_ui_chars(s, 40));
                }
            }
        }
    }
    String::new()
}

fn extract_message_thinking(msg: &Value) -> Option<String> {
    msg.get("reasoning_content")
        .and_then(|x| x.as_str())
        .or_else(|| msg.get("reasoning").and_then(|x| x.as_str()))
        .filter(|s| !s.trim().is_empty())
        .map(|s| s.to_string())
}

fn is_dsml_pipe(c: char) -> bool {
    c == '|' || c == '\u{ff5c}'
}

/// True when assistant `content` looks like tool markup dumped as text
/// (DeepSeek DSML with 1–N pipes, or common XML tool_call / invoke forms).
fn content_looks_like_embedded_tools(content: &str) -> bool {
    if content.contains("DSML") && content.contains("invoke") {
        return true;
    }
    let lower = content.to_ascii_lowercase();
    lower.contains("<tool_call>")
        || lower.contains("<function_call>")
        || lower.contains("<invoke ")
        || (lower.contains("clue_board_")
            && (content.contains("<|") || content.contains('\u{ff5c}')))
}

fn parse_invoke_parameter_body(body: &str) -> serde_json::Map<String, Value> {
    let trimmed = body.trim();
    if trimmed.starts_with('{') {
        if let Ok(Value::Object(m)) = serde_json::from_str(trimmed) {
            return m;
        }
    }
    let mut map = serde_json::Map::new();
    let mut search = 0usize;
    while let Some(rel) = body[search..].find("parameter name=\"") {
        let at = search + rel;
        let name_start = at + "parameter name=\"".len();
        let Some(name_rel) = body[name_start..].find('"') else {
            break;
        };
        let name_end = name_start + name_rel;
        let pname = body[name_start..name_end].to_string();
        let after_name = &body[name_end + 1..];
        let mut is_string = true;
        if let Some(gt_rel) = after_name.find('>') {
            let attrs = &after_name[..gt_rel];
            if let Some(srel) = attrs.find("string=\"") {
                let sv = &attrs[srel + "string=\"".len()..];
                if sv.starts_with("false") {
                    is_string = false;
                }
            }
            let val_start = name_end + 1 + gt_rel + 1;
            let mut close: Option<usize> = None;
            let mut csearch = 0usize;
            let slice = &body[val_start..];
            while let Some(r) = slice[csearch..].find("</") {
                let cs = val_start + csearch + r;
                if let Some(cgt) = body[cs..].find('>') {
                    if body[cs..cs + cgt].contains("parameter") {
                        close = Some(cs);
                        break;
                    }
                    csearch = csearch + r + 2;
                } else {
                    break;
                }
            }
            let Some(close) = close else {
                break;
            };
            let raw_val = body[val_start..close].trim();
            let val = if is_string {
                Value::String(raw_val.to_string())
            } else {
                serde_json::from_str::<Value>(raw_val)
                    .unwrap_or_else(|_| Value::String(raw_val.to_string()))
            };
            map.insert(pname, val);
            search = close + 2;
            continue;
        }
        break;
    }
    map
}

fn strip_index_ranges(content: &str, ranges: &[(usize, usize)]) -> String {
    if ranges.is_empty() {
        return content.to_string();
    }
    let mut ordered = ranges.to_vec();
    ordered.sort_by_key(|r| r.0);
    let mut out = String::with_capacity(content.len());
    let mut cursor = 0usize;
    for (a, b) in ordered {
        if a < cursor || b > content.len() || a >= b {
            continue;
        }
        out.push_str(&content[cursor..a]);
        cursor = b;
    }
    out.push_str(&content[cursor..]);
    out
}

fn strip_orphan_dsml_wrappers(content: &str) -> String {
    // Remove leftover outer `<…DSML…calls|tool_calls|function_calls>` open/close tags.
    let mut cleaned = String::with_capacity(content.len());
    let mut i = 0usize;
    while i < content.len() {
        if content[i..].starts_with('<') {
            if let Some(gt) = content[i..].find('>') {
                let tag = &content[i..i + gt + 1];
                let tag_l = tag.to_ascii_lowercase();
                let pipes_dsml = tag.contains("DSML")
                    && tag.chars().any(is_dsml_pipe)
                    && (tag_l.contains("calls")
                        || tag_l.contains("tool_calls")
                        || tag_l.contains("function_calls"));
                if pipes_dsml {
                    i += gt + 1;
                    continue;
                }
            }
        }
        let ch = content[i..].chars().next().unwrap();
        cleaned.push(ch);
        i += ch.len_utf8();
    }
    cleaned
}

/// Parse tool markup embedded in assistant content into OpenAI-style `tool_calls`.
/// Returns `(cleaned_content, tool_calls)` when at least one invoke is recovered.
fn parse_content_embedded_tool_calls(content: &str) -> Option<(String, Vec<Value>)> {
    if !content_looks_like_embedded_tools(content) {
        return None;
    }
    let mut invokes: Vec<(String, serde_json::Map<String, Value>)> = Vec::new();
    let mut strip_ranges: Vec<(usize, usize)> = Vec::new();

    // DeepSeek DSML / XML-ish: …invoke name="tool"… …</…invoke>
    let mut search_from = 0usize;
    while let Some(rel) = content[search_from..].find("invoke name=\"") {
        let name_key_at = search_from + rel;
        let Some(open_start) = content[..name_key_at].rfind('<') else {
            search_from = name_key_at + 12;
            continue;
        };
        let open_head = &content[open_start..name_key_at];
        let dsml_ish = open_head.contains("DSML")
            || open_head.to_ascii_lowercase().contains("invoke");
        if !dsml_ish {
            search_from = name_key_at + 12;
            continue;
        }
        let name_start = name_key_at + "invoke name=\"".len();
        let Some(name_rel) = content[name_start..].find('"') else {
            break;
        };
        let name_end = name_start + name_rel;
        let name = content[name_start..name_end].trim().to_string();
        let Some(gt_rel) = content[name_end..].find('>') else {
            break;
        };
        let body_start = name_end + gt_rel + 1;
        let mut close_start: Option<usize> = None;
        let mut close_end: Option<usize> = None;
        let mut csearch = 0usize;
        let slice = &content[body_start..];
        while let Some(r) = slice[csearch..].find("</") {
            let cs = body_start + csearch + r;
            if let Some(cgt) = content[cs..].find('>') {
                if content[cs..cs + cgt].contains("invoke") {
                    close_start = Some(cs);
                    close_end = Some(cs + cgt + 1);
                    break;
                }
                csearch = csearch + r + 2;
            } else {
                break;
            }
        }
        let (Some(cs), Some(ce)) = (close_start, close_end) else {
            search_from = body_start;
            continue;
        };
        if name.is_empty() {
            search_from = ce;
            continue;
        }
        let args = parse_invoke_parameter_body(&content[body_start..cs]);
        invokes.push((name, args));
        strip_ranges.push((open_start, ce));
        search_from = ce;
    }

    // Hermes-style: <tool_call>{"name":"...","arguments":{...}}</tool_call>
    let mut search_from = 0usize;
    let lower = content.to_ascii_lowercase();
    while let Some(rel) = lower[search_from..].find("<tool_call>") {
        let open = search_from + rel;
        let body_start = open + "<tool_call>".len();
        let Some(close_rel) = lower[body_start..].find("</tool_call>") else {
            break;
        };
        let body_end = body_start + close_rel;
        let close_end = body_end + "</tool_call>".len();
        let body = content[body_start..body_end].trim();
        if let Ok(v) = serde_json::from_str::<Value>(body) {
            let name = v
                .get("name")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_string();
            let args = match v.get("arguments") {
                Some(Value::Object(m)) => m.clone(),
                Some(Value::String(s)) => serde_json::from_str::<Value>(s)
                    .ok()
                    .and_then(|x| x.as_object().cloned())
                    .unwrap_or_default(),
                _ => serde_json::Map::new(),
            };
            if !name.is_empty() {
                invokes.push((name, args));
                strip_ranges.push((open, close_end));
            }
        }
        search_from = close_end;
    }

    if invokes.is_empty() {
        return None;
    }

    let mut cleaned = strip_index_ranges(content, &strip_ranges);
    cleaned = strip_orphan_dsml_wrappers(&cleaned);
    let cleaned = cleaned.trim().to_string();

    let tool_calls: Vec<Value> = invokes
        .into_iter()
        .enumerate()
        .map(|(i, (name, args))| {
            json!({
                "id": format!("content_call_{}", i + 1),
                "type": "function",
                "function": {
                    "name": name,
                    "arguments": serde_json::to_string(&Value::Object(args))
                        .unwrap_or_else(|_| "{}".into()),
                }
            })
        })
        .collect();
    Some((cleaned, tool_calls))
}

/// If the model put tools in `content` instead of `tool_calls`, promote them.
fn promote_embedded_tools_in_message(msg: &mut Value) -> Vec<Value> {
    let existing = msg
        .get("tool_calls")
        .and_then(|x| x.as_array())
        .cloned()
        .unwrap_or_default();
    if !existing.is_empty() {
        return existing;
    }
    let Some(content) = msg.get("content").and_then(|c| c.as_str()) else {
        return vec![];
    };
    let Some((cleaned, synthetic)) = parse_content_embedded_tool_calls(content) else {
        return vec![];
    };
    if synthetic.is_empty() {
        return vec![];
    }
    msg["tool_calls"] = Value::Array(synthetic.clone());
    if cleaned.is_empty() {
        msg["content"] = Value::Null;
    } else {
        msg["content"] = json!(cleaned);
    }
    synthetic
}

#[cfg(test)]
mod embedded_tool_parse_tests {
    use super::*;

    #[test]
    fn parses_double_fullwidth_pipe_dsml_calls() {
        // LiteLLM / DeepSeek often emit `<｜｜DSML｜｜…>` (double U+FF5C), block name `calls`.
        let p = '\u{ff5c}';
        let content = format!(
            "先加节点：\n\n<{p}{p}DSML{p}{p}calls>\n\
<{p}{p}DSML{p}{p}invoke name=\"clue_board_create_note\">\n\
<{p}{p}DSML{p}{p}parameter name=\"board_id\" string=\"true\">board_x</{p}{p}DSML{p}{p}parameter>\n\
<{p}{p}DSML{p}{p}parameter name=\"text\" string=\"true\">乡镇党委</{p}{p}DSML{p}{p}parameter>\n\
<{p}{p}DSML{p}{p}parameter name=\"x\" string=\"false\">-620</{p}{p}DSML{p}{p}parameter>\n\
<{p}{p}DSML{p}{p}parameter name=\"y\" string=\"false\">1430</{p}{p}DSML{p}{p}parameter>\n\
</{p}{p}DSML{p}{p}invoke>\n\
</{p}{p}DSML{p}{p}calls>"
        );
        let (cleaned, calls) = parse_content_embedded_tool_calls(&content).expect("parse");
        assert_eq!(calls.len(), 1);
        assert_eq!(
            calls[0].pointer("/function/name").and_then(|x| x.as_str()),
            Some("clue_board_create_note")
        );
        let args: Value = serde_json::from_str(
            calls[0]
                .pointer("/function/arguments")
                .and_then(|x| x.as_str())
                .unwrap(),
        )
        .unwrap();
        assert_eq!(args["board_id"], "board_x");
        assert_eq!(args["text"], "乡镇党委");
        assert_eq!(args["x"], -620);
        assert_eq!(args["y"], 1430);
        assert!(!cleaned.contains("DSML"));
        assert!(cleaned.contains("先加节点"));
    }

    #[test]
    fn parses_dsml_tool_calls_wrapper() {
        let p = '\u{ff5c}';
        let content = format!(
            "<{p}{p}DSML{p}{p}tool_calls>\n\
<{p}{p}DSML{p}{p}invoke name=\"clue_board_create_note\">\n\
<{p}{p}DSML{p}{p}parameter name=\"board_id\" string=\"true\">board_y</{p}{p}DSML{p}{p}parameter>\n\
<{p}{p}DSML{p}{p}parameter name=\"text\" string=\"true\">hello</{p}{p}DSML{p}{p}parameter>\n\
</{p}{p}DSML{p}{p}invoke>\n\
</{p}{p}DSML{p}{p}tool_calls>"
        );
        let (cleaned, calls) = parse_content_embedded_tool_calls(&content).expect("parse");
        assert_eq!(calls.len(), 1);
        assert!(cleaned.is_empty() || !cleaned.contains("invoke"));
    }
}

#[cfg(test)]
mod clue_boards_merge_tests {
    use super::*;

    fn board(id: &str, text: &str) -> ClueBoard {
        ClueBoard {
            id: id.into(),
            title: id.into(),
            nodes: vec![ClueBoardNode {
                id: format!("n_{id}"),
                text: text.into(),
                x: 0.0,
                y: 0.0,
                color: None,
                rotation: None,
                w: None,
                h: None,
            }],
            edges: vec![],
            view: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn upsert_keeps_disk_only_boards() {
        let existing = ClueBoardsFile {
            v: 2,
            active_id: "a".into(),
            boards: vec![board("a", "hello"), board("b", "world")],
        };
        let incoming = ClueBoardsFile {
            v: 2,
            active_id: "a".into(),
            boards: vec![board("a", "hello")],
        };
        let merged = merge_upsert_boards(Some(&existing), incoming).unwrap();
        assert_eq!(merged.boards.len(), 2);
        assert!(merged.boards.iter().any(|b| b.id == "b"));
    }

    #[test]
    fn upsert_keeps_newer_disk_nodes_on_same_board() {
        let mut disk_a = board("a", "hello");
        disk_a.updated_at = 10;
        disk_a.nodes.push(ClueBoardNode {
            id: "n_mcp".into(),
            text: "from mcp".into(),
            x: 1.0,
            y: 2.0,
            color: None,
            rotation: None,
            w: None,
            h: None,
        });
        let existing = ClueBoardsFile {
            v: 2,
            active_id: "a".into(),
            boards: vec![disk_a, board("b", "world")],
        };
        let incoming = ClueBoardsFile {
            v: 2,
            active_id: "a".into(),
            boards: vec![board("a", "hello")],
        };
        let merged = merge_upsert_boards(Some(&existing), incoming).unwrap();
        let a = merged.boards.iter().find(|b| b.id == "a").unwrap();
        assert!(
            a.nodes.iter().any(|n| n.id == "n_mcp"),
            "stale UI snapshot must not drop MCP-added nodes"
        );
        assert!(merged.boards.iter().any(|b| b.id == "b"));
    }
}

#[derive(Clone, Default)]
struct McpActivityState {
    phase: String,
    round: Option<usize>,
    max_rounds: Option<usize>,
    waited_secs: Option<u64>,
    thinking_text: String,
    tools: Vec<Value>,
}

impl McpActivityState {
    fn to_json(&self) -> Value {
        json!({
            "phase": self.phase,
            "round": self.round,
            "max_rounds": self.max_rounds,
            "waited_secs": self.waited_secs,
            "thinking": if self.thinking_text.trim().is_empty() {
                Value::Null
            } else {
                json!({ "text": truncate_ui_chars(&self.thinking_text, 6000) })
            },
            "tools": self.tools,
        })
    }

    fn has_ui_content(&self) -> bool {
        !self.tools.is_empty()
            || !self.thinking_text.trim().is_empty()
            || self.round.is_some()
            || !self.phase.trim().is_empty()
    }
}

/// 回合结束时把活动快照写进卡片，供重开后仍能展开思考/工具轨迹。
fn snapshot_mcp_activity_to_card(
    card: &mut NotesCard,
    activity: &std::sync::Arc<std::sync::Mutex<McpActivityState>>,
) {
    let Ok(mut g) = activity.lock() else {
        return;
    };
    if !g.has_ui_content() {
        return;
    }
    g.phase = "done".into();
    g.waited_secs = None;
    for t in g.tools.iter_mut() {
        if t.get("status").and_then(|s| s.as_str()) == Some("running") {
            t["status"] = json!("done");
        }
    }
    card.mcp_activity = Some(g.to_json());
}

/// 协议日志不落完整 messages（MCP 多轮会膨胀到数 MB）；只记摘要。
fn request_log_summary(url: &str, body: &Value, mcp_round: Option<usize>) -> Value {
    let msg_count = body
        .get("messages")
        .and_then(|m| m.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    let tool_count = body
        .get("tools")
        .and_then(|t| t.as_array())
        .map(|a| a.len())
        .unwrap_or(0);
    let mut ev = json!({
        "kind": "request",
        "url": url,
        "model": body.get("model").cloned().unwrap_or(Value::Null),
        "stream": body.get("stream").cloned().unwrap_or(Value::Null),
        "message_count": msg_count,
        "tool_count": tool_count,
    });
    if let Some(r) = mcp_round {
        ev["mcp_round"] = json!(r);
    }
    if body.get("thinking").is_some() {
        ev["thinking"] = body.get("thinking").cloned().unwrap_or(Value::Null);
    }
    if let Some(effort) = body.get("reasoning_effort") {
        ev["reasoning_effort"] = effort.clone();
    }
    ev
}

fn clue_board_mutator(name: &str) -> bool {
    matches!(
        name,
        "clue_board_create_board"
            | "clue_board_create_note"
            | "clue_board_update_note"
            | "clue_board_delete_note"
            | "clue_board_add_edge"
            | "clue_board_delete_edge"
            | "clue_board_set_active"
            | "clue_board_rollback"
    )
}

/// 长请求期间每 5s 刷新状态，避免 UI 一直停在「等待服务器响应…」。
async fn await_with_wait_heartbeat<T, E, Fut>(
    app: &AppHandle,
    card_id: &str,
    created_at: u64,
    base_status: String,
    activity: Option<std::sync::Arc<std::sync::Mutex<McpActivityState>>>,
    fut: Fut,
) -> Result<T, E>
where
    Fut: std::future::Future<Output = Result<T, E>>,
{
    let app2 = app.clone();
    let cid = card_id.to_string();
    let started = std::time::Instant::now();
    let heartbeat = async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            let secs = started.elapsed().as_secs();
            let status = format!("{base_status}（已等待 {secs}s）");
            let act_json = activity.as_ref().and_then(|a| {
                a.lock().ok().map(|mut g| {
                    g.waited_secs = Some(secs);
                    g.to_json()
                })
            });
            emit_stream_status_ex(&app2, &cid, created_at, &status, act_json.as_ref());
        }
    };
    tokio::select! {
        res = fut => res,
        _ = heartbeat => unreachable!("heartbeat loop is infinite"),
    }
}

async fn finish_turn_with_text(
    app: &AppHandle,
    mut card: NotesCard,
    assistant: String,
    model: NotesModelRef,
    t_done: u64,
    usage_raw: Option<Value>,
) -> Result<(), String> {
    let card_id = card.id.clone();
    let created_at = card.created_at;
    card.timings_ms.completed = Some(t_done);
    if card.timings_ms.first_token.is_none() {
        card.timings_ms.first_token = Some(t_done);
    }
    if card.timings_ms.first_byte.is_none() {
        card.timings_ms.first_byte = card.timings_ms.first_token.or(Some(t_done));
    }
    if card.timings_ms.request_sent.is_none() {
        card.timings_ms.request_sent = card.timings_ms.first_byte;
    }
    card.timings_delta_s = compute_deltas(&card.timings_ms);
    card.assistant_text = assistant.clone();
    if let Some(u) = &usage_raw {
        card.usage = usage_from_openai_json(u);
    }
    let mk = model_key(&model.provider_id, &model.model_id);
    card.cost = compute_cost(&mk, &model.litellm_model, &card.usage);
    card.status = "done".into();
    write_card(&card)?;
    touch_recent_model(&mk);
    let _ = app.emit(
        "notes-stream-chunk",
        json!({
            "card_id": card_id,
            "created_at": created_at,
            "delta": assistant,
            "assistant_text": assistant,
        }),
    );
    let _ = app.emit(
        "notes-stream-done",
        json!({
            "card_id": card_id,
            "created_at": created_at,
            "status": "done",
            "card": card_to_summary(&card),
        }),
    );
    Ok(())
}

async fn execute_mcp_tool_calls(
    app: &AppHandle,
    card_id: &str,
    created_at: u64,
    round: usize,
    tool_calls: Vec<Value>,
    messages: &mut Vec<Value>,
    mcp_tool_names: &mut Vec<String>,
    mcp_prefs: &McpPrefs,
    activity: &std::sync::Arc<std::sync::Mutex<McpActivityState>>,
) -> Result<(), String> {
    let emit_act = |status_text: &str| {
        let act_json = activity.lock().ok().map(|g| g.to_json());
        emit_stream_status_ex(app, card_id, created_at, status_text, act_json.as_ref());
    };
    for tc in tool_calls {
        let tc_id = tc.get("id").and_then(|x| x.as_str()).unwrap_or("call");
        let name = tc
            .pointer("/function/name")
            .and_then(|x| x.as_str())
            .unwrap_or("");
        let args_str = tc
            .pointer("/function/arguments")
            .and_then(|x| x.as_str())
            .unwrap_or("{}");
        let args: Value = serde_json::from_str(args_str).unwrap_or(json!({}));
        if !name.is_empty() {
            mcp_tool_names.push(name.to_string());
        }
        let target = tool_target_summary(name, &args);
        let tool_row_id = if tc_id.is_empty() {
            format!("call-{}-{}", round + 1, mcp_tool_names.len())
        } else {
            tc_id.to_string()
        };
        {
            let mut g = activity.lock().map_err(|e| e.to_string())?;
            g.phase = "tool".into();
            g.waited_secs = None;
            g.tools.push(json!({
                "id": tool_row_id,
                "name": name,
                "target": if target.is_empty() { Value::Null } else { json!(target) },
                "status": "running",
                "detail": Value::Null,
            }));
        }
        emit_act(&format!(
            "调用工具 {}{}…",
            name,
            if target.is_empty() {
                String::new()
            } else {
                format!("（{target}）")
            }
        ));
        let _ = append_log(
            now_ms(),
            card_id,
            json!({
                "kind": "tool_call",
                "name": name,
                "server": notes_mcp::server_id_for_tool(name),
                "arguments": args,
                "target": if target.is_empty() { Value::Null } else { json!(target) },
            }),
        );
        let result = notes_mcp::execute_tool(name, &args, mcp_prefs).await;
        let content = match &result {
            Ok(val) => serde_json::to_string(val).unwrap_or_else(|_| "{}".into()),
            Err(e) => json!({ "error": e }).to_string(),
        };
        let detail = match &result {
            Ok(_) => truncate_ui_chars(&content, 160),
            Err(e) => truncate_ui_chars(e, 160),
        };
        {
            let mut g = activity.lock().map_err(|e| e.to_string())?;
            if let Some(last) = g.tools.last_mut() {
                last["status"] = json!(if result.is_ok() { "done" } else { "error" });
                last["detail"] = json!(detail);
            }
        }
        let _ = append_log(
            now_ms(),
            card_id,
            json!({
                "kind": "tool_result",
                "name": name,
                "ok": result.is_ok(),
                "content": content,
                "target": if target.is_empty() { Value::Null } else { json!(target) },
            }),
        );
        if result.is_err() {
            emit_act(&format!(
                "工具 {name} 失败：{}",
                result.as_ref().err().map(|s| s.as_str()).unwrap_or("error")
            ));
        } else {
            emit_act(&format!(
                "工具 {} 完成{}",
                name,
                if target.is_empty() {
                    String::new()
                } else {
                    format!(" · {target}")
                }
            ));
            if clue_board_mutator(name) {
                let _ = app.emit(
                    "notes-clue-boards-changed",
                    json!({ "source": "mcp", "tool": name }),
                );
            }
        }
        messages.push(json!({
            "role": "tool",
            "tool_call_id": tc_id,
            "content": content
        }));
    }
    Ok(())
}

async fn run_turn_stream(
    app: AppHandle,
    mut card: NotesCard,
    mut messages: Vec<Value>,
    model: NotesModelRef,
    opts: NotesTurnOpts,
    mcp_prefs: McpPrefs,
) -> Result<(), String> {
    let card_id = card.id.clone();
    let created_at = card.created_at;
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;

    let tools = notes_mcp::openai_tools_for_prefs(&mcp_prefs);
    let mut mcp_tool_names: Vec<String> = Vec::new();
    let activity = std::sync::Arc::new(std::sync::Mutex::new(McpActivityState::default()));
    let emit_act = |app: &AppHandle,
                    card_id: &str,
                    created_at: u64,
                    status_text: &str,
                    activity: &std::sync::Arc<std::sync::Mutex<McpActivityState>>| {
        let act_json = activity.lock().ok().map(|g| g.to_json());
        emit_stream_status_ex(app, card_id, created_at, status_text, act_json.as_ref());
    };
    if !tools.is_empty() {
        {
            let mut g = activity.lock().map_err(|e| e.to_string())?;
            g.phase = "waiting_model".into();
            g.max_rounds = Some(notes_mcp::max_tool_rounds());
            g.round = Some(1);
            g.waited_secs = None;
        }
        emit_act(
            &app,
            &card_id,
            created_at,
            "MCP 工具模式：等待模型（此阶段非流式，长文/思考会较久）…",
            &activity,
        );
        for round in 0..notes_mcp::max_tool_rounds() {
            let mut body = json!({
                "model": model.proxy_name,
                "stream": false,
                "messages": messages,
                "tools": tools,
                "tool_choice": "auto",
            });
            apply_turn_body_opts(&mut body, &opts);
            let t_req = now_ms();
            if card.timings_ms.request_sent.is_none() {
                card.timings_ms.request_sent = Some(t_req);
                let _ = write_card(&card);
            }
            let round_status = format!(
                "MCP 回合 {}/{}：等待模型…",
                round + 1,
                notes_mcp::max_tool_rounds()
            );
            {
                let mut g = activity.lock().map_err(|e| e.to_string())?;
                g.phase = "waiting_model".into();
                g.round = Some(round + 1);
                g.max_rounds = Some(notes_mcp::max_tool_rounds());
                g.waited_secs = None;
            }
            emit_act(&app, &card_id, created_at, &round_status, &activity);
            let _ = append_log(
                t_req,
                &card_id,
                request_log_summary(
                    &format!("{LLM_SIDECAR_URL}/v1/chat/completions"),
                    &body,
                    Some(round),
                ),
            );
            let resp = await_with_wait_heartbeat(
                &app,
                &card_id,
                created_at,
                round_status,
                Some(activity.clone()),
                client
                    .post(format!("{LLM_SIDECAR_URL}/v1/chat/completions"))
                    .header("Content-Type", "application/json")
                    .json(&body)
                    .send(),
            )
            .await
            .map_err(|e| format!("请求 sidecar 失败: {e}"))?;
            let t_byte = now_ms();
            if card.timings_ms.first_byte.is_none() {
                card.timings_ms.first_byte = Some(t_byte);
            }
            if !resp.status().is_success() {
                let status = resp.status().as_u16();
                let err_body = resp.text().await.unwrap_or_default();
                snapshot_mcp_activity_to_card(&mut card, &activity);
                return turn_stream_http_error(
                    &app,
                    &mut card,
                    card_id.clone(),
                    created_at,
                    status,
                    err_body,
                    t_byte,
                )
                .await;
            }
            {
                let mut g = activity.lock().map_err(|e| e.to_string())?;
                g.phase = "reading".into();
                g.waited_secs = None;
            }
            emit_act(
                &app,
                &card_id,
                created_at,
                &format!("MCP 回合 {}：已收到响应头，读取正文…", round + 1),
                &activity,
            );
            let v: Value = await_with_wait_heartbeat(
                &app,
                &card_id,
                created_at,
                format!("MCP 回合 {}：读取完整响应…", round + 1),
                Some(activity.clone()),
                resp.json(),
            )
            .await
            .map_err(|e| e.to_string())?;
            let t_body = now_ms();
            let mut msg = v
                .pointer("/choices/0/message")
                .cloned()
                .unwrap_or(json!({}));
            if let Some(think) = extract_message_thinking(&msg) {
                let mut g = activity.lock().map_err(|e| e.to_string())?;
                if g.thinking_text.is_empty() {
                    g.thinking_text = think;
                } else {
                    g.thinking_text.push_str("\n---\n");
                    g.thinking_text.push_str(&think);
                }
                g.phase = "thinking".into();
            }
            // Structured OpenAI tool_calls preferred; if empty, recover DeepSeek DSML /
            // XML tool markup dumped into `content` (otherwise shown as raw text).
            let had_structured = msg
                .get("tool_calls")
                .and_then(|x| x.as_array())
                .map(|a| !a.is_empty())
                .unwrap_or(false);
            let tool_calls = promote_embedded_tools_in_message(&mut msg);
            if !had_structured && !tool_calls.is_empty() {
                let _ = append_log(
                    now_ms(),
                    &card_id,
                    json!({
                        "kind": "embedded_tool_parse",
                        "count": tool_calls.len(),
                        "names": tool_calls.iter().filter_map(|tc| {
                            tc.pointer("/function/name").and_then(|x| x.as_str()).map(|s| s.to_string())
                        }).collect::<Vec<_>>(),
                    }),
                );
                emit_act(
                    &app,
                    &card_id,
                    created_at,
                    &format!(
                        "MCP 回合 {}：从正文解析出 {} 个工具调用…",
                        round + 1,
                        tool_calls.len()
                    ),
                    &activity,
                );
            }
            if !tool_calls.is_empty() {
                if activity
                    .lock()
                    .ok()
                    .map(|g| !g.thinking_text.trim().is_empty())
                    .unwrap_or(false)
                {
                    emit_act(
                        &app,
                        &card_id,
                        created_at,
                        &format!("MCP 回合 {}：模型已思考，准备调用工具…", round + 1),
                        &activity,
                    );
                }
            }
            if tool_calls.is_empty() {
                if let Some(content) = msg.get("content").and_then(|c| c.as_str()) {
                    if !content.is_empty() {
                        // MCP on + content still looks like tool markup → don't dump as final answer.
                        if content_looks_like_embedded_tools(content) {
                            let _ = append_log(
                                now_ms(),
                                &card_id,
                                json!({
                                    "kind": "embedded_tool_parse_failed",
                                    "preview": truncate_ui_chars(content, 240),
                                }),
                            );
                            emit_act(
                                &app,
                                &card_id,
                                created_at,
                                &format!(
                                    "MCP 回合 {}：正文像工具调用但未能解析，继续…",
                                    round + 1
                                ),
                                &activity,
                            );
                            messages.push(msg);
                            messages.push(json!({
                                "role": "user",
                                "content": "Your previous reply embedded tool-call markup in plain text and it could not be executed. Call tools via the API tool_calls mechanism (or valid DSML invoke blocks), do not dump raw markup as the final answer."
                            }));
                            continue;
                        }
                        let (servers, tools_used) =
                            notes_mcp::collect_mcp_usage(&mcp_tool_names);
                        card.mcp_servers = servers;
                        card.mcp_tools = tools_used;
                        if let Some(t) = extract_message_thinking(&msg) {
                            let prev = card.thinking_text.clone().unwrap_or_default();
                            card.thinking_text = Some(if prev.is_empty() {
                                t
                            } else {
                                format!("{prev}\n---\n{t}")
                            });
                        }
                        if card.timings_ms.first_token.is_none() {
                            card.timings_ms.first_token = Some(t_body);
                        }
                        return finish_turn_with_text(
                            &app,
                            card,
                            content.to_string(),
                            model,
                            t_body,
                            v.get("usage").cloned(),
                        )
                        .await;
                    }
                }
                break;
            }
            messages.push(msg);
            execute_mcp_tool_calls(
                &app,
                &card_id,
                created_at,
                round,
                tool_calls,
                &mut messages,
                &mut mcp_tool_names,
                &mcp_prefs,
                &activity,
            )
            .await?;
            let (servers, tools_used) = notes_mcp::collect_mcp_usage(&mcp_tool_names);
            card.mcp_servers = servers;
            card.mcp_tools = tools_used;
            let _ = write_card(&card);
        }
    }

    let mut body = json!({
        "model": model.proxy_name,
        "stream": true,
        "stream_options": { "include_usage": true },
        "messages": messages,
    });
    apply_turn_body_opts(&mut body, &opts);
    let t_sent = now_ms();
    if card.timings_ms.request_sent.is_none() {
        card.timings_ms.request_sent = Some(t_sent);
    }
    let (servers, tools_used) = notes_mcp::collect_mcp_usage(&mcp_tool_names);
    card.mcp_servers = servers;
    card.mcp_tools = tools_used;
    let _ = append_log(
        t_sent,
        &card_id,
        request_log_summary(
            &format!("{LLM_SIDECAR_URL}/v1/chat/completions"),
            &body,
            None,
        ),
    );
    write_card(&card)?;
    {
        let mut g = activity.lock().map_err(|e| e.to_string())?;
        g.phase = "streaming".into();
        g.waited_secs = None;
    }
    emit_act(&app, &card_id, created_at, "等待服务器响应…", &activity);
    let resp = await_with_wait_heartbeat(
        &app,
        &card_id,
        created_at,
        "等待服务器响应…".into(),
        Some(activity.clone()),
        client
            .post(format!("{LLM_SIDECAR_URL}/v1/chat/completions"))
            .header("Content-Type", "application/json")
            .json(&body)
            .send(),
    )
    .await
    .map_err(|e| format!("请求 sidecar 失败: {e}"))?;
    let t_first_byte = now_ms();
    if card.timings_ms.first_byte.is_none() {
        card.timings_ms.first_byte = Some(t_first_byte);
    }
    let status = resp.status();
    if !status.is_success() {
        let err_body = resp.text().await.unwrap_or_default();
        let _ = append_log(
            t_first_byte,
            &card_id,
            json!({ "kind": "http_error", "status": status.as_u16(), "body": err_body }),
        );
        card.status = "error".into();
        card.error = Some(humanize_llm_error(&format!(
            "HTTP {}: {}",
            status.as_u16(),
            err_body
        )));
        card.timings_ms.completed = Some(t_first_byte);
        card.timings_delta_s = compute_deltas(&card.timings_ms);
        snapshot_mcp_activity_to_card(&mut card, &activity);
        write_card(&card)?;
        let _ = app.emit(
            "notes-stream-done",
            json!({
                "card_id": card_id,
                "created_at": created_at,
                "status": "error",
                "card": card_to_summary(&card),
            }),
        );
        return Err(card.error.clone().unwrap_or_default());
    }
    emit_act(
        &app,
        &card_id,
        created_at,
        "服务器已响应，等待输出…",
        &activity,
    );
    let mut stream = resp.bytes_stream();
    let mut assistant = String::new();
    let mut first_token: Option<u64> = None;
    let mut usage_raw: Option<Value> = None;
    let mut buf = String::new();
    let mut sse_error: Option<String> = None;
    let mut last_think_emit = std::time::Instant::now()
        .checked_sub(std::time::Duration::from_secs(1))
        .unwrap_or_else(std::time::Instant::now);
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        let s = String::from_utf8_lossy(&chunk);
        buf.push_str(&s);
        while let Some(pos) = buf.find("\n\n") {
            let block = buf[..pos].to_string();
            buf = buf[pos + 2..].to_string();
            for line in block.lines() {
                let line = line.trim();
                if !line.starts_with("data:") {
                    continue;
                }
                let data = line.trim_start_matches("data:").trim();
                if data == "[DONE]" {
                    continue;
                }
                let _ = append_log(
                    now_ms(),
                    &card_id,
                    json!({ "kind": "sse_line", "data": data }),
                );
                let Ok(v) = serde_json::from_str::<Value>(data) else {
                    continue;
                };
                if let Some(err_msg) = extract_sse_error(&v) {
                    sse_error = Some(err_msg);
                    break;
                }
                if let Some(u) = v.get("usage") {
                    usage_raw = Some(u.clone());
                }
                if let Some(delta) = v
                    .pointer("/choices/0/delta/content")
                    .and_then(|x| x.as_str())
                {
                    if !delta.is_empty() {
                        if first_token.is_none() {
                            first_token = Some(now_ms());
                            card.timings_ms.first_token = first_token;
                        }
                        assistant.push_str(delta);
                        let _ = app.emit(
                            "notes-stream-chunk",
                            json!({
                                "card_id": card_id,
                                "created_at": created_at,
                                "delta": delta,
                                "assistant_text": assistant,
                            }),
                        );
                    }
                }
                // reasoning / thinking deltas (OpenAI-style or DeepSeek)
                let thinking_delta = v
                    .pointer("/choices/0/delta/reasoning_content")
                    .and_then(|x| x.as_str())
                    .or_else(|| {
                        v.pointer("/choices/0/delta/reasoning")
                            .and_then(|x| x.as_str())
                    });
                if let Some(td) = thinking_delta {
                    if !td.is_empty() {
                        let prev = card.thinking_text.clone().unwrap_or_default();
                        card.thinking_text = Some(format!("{prev}{td}"));
                        if let Ok(mut g) = activity.lock() {
                            g.phase = "thinking".into();
                            g.thinking_text.push_str(td);
                        }
                        if last_think_emit.elapsed() >= std::time::Duration::from_millis(350) {
                            emit_act(&app, &card_id, created_at, "思考中…", &activity);
                            last_think_emit = std::time::Instant::now();
                        }
                    }
                }
            }
            if sse_error.is_some() {
                break;
            }
        }
        if sse_error.is_some() {
            break;
        }
    }
    if let Some(err_msg) = sse_error {
        snapshot_mcp_activity_to_card(&mut card, &activity);
        return fail_stream_card(&app, &mut card, &card_id, created_at, err_msg).await;
    }
    let t_done = now_ms();
    card.timings_ms.completed = Some(t_done);
    if first_token.is_none() {
        card.timings_ms.first_token = card.timings_ms.first_byte.or(Some(t_first_byte));
    }
    card.timings_delta_s = compute_deltas(&card.timings_ms);
    card.assistant_text = assistant.clone();
    if let Some(u) = &usage_raw {
        card.usage = usage_from_openai_json(u);
        let _ = append_log(
            t_done,
            &card_id,
            json!({ "kind": "usage", "raw": u }),
        );
    }
    // Tool-round cap → final stream often dumps DSML into content instead of tool_calls.
    if !tools.is_empty() {
        let mut msg = json!({ "role": "assistant", "content": assistant });
        let recovered = promote_embedded_tools_in_message(&mut msg);
        if !recovered.is_empty() {
            let _ = append_log(
                now_ms(),
                &card_id,
                json!({
                    "kind": "embedded_tool_parse",
                    "source": "stream_final",
                    "count": recovered.len(),
                    "names": recovered.iter().filter_map(|tc| {
                        tc.pointer("/function/name").and_then(|x| x.as_str()).map(|s| s.to_string())
                    }).collect::<Vec<_>>(),
                }),
            );
            emit_act(
                &app,
                &card_id,
                created_at,
                &format!("从流式正文解析出 {} 个工具调用，继续执行…", recovered.len()),
                &activity,
            );
            messages.push(msg.clone());
            execute_mcp_tool_calls(
                &app,
                &card_id,
                created_at,
                notes_mcp::max_tool_rounds(),
                recovered,
                &mut messages,
                &mut mcp_tool_names,
                &mcp_prefs,
                &activity,
            )
            .await?;
            let (servers, tools_used) = notes_mcp::collect_mcp_usage(&mcp_tool_names);
            card.mcp_servers = servers;
            card.mcp_tools = tools_used;
            assistant = msg
                .get("content")
                .and_then(|c| c.as_str())
                .unwrap_or("")
                .trim()
                .to_string();
            if assistant.is_empty() {
                assistant = "已执行流式正文中的工具调用。".into();
            }
            card.assistant_text = assistant.clone();
            let _ = app.emit(
                "notes-stream-chunk",
                json!({
                    "card_id": card_id,
                    "created_at": created_at,
                    "delta": "",
                    "assistant_text": assistant,
                }),
            );
        } else if content_looks_like_embedded_tools(&assistant) {
            let _ = append_log(
                now_ms(),
                &card_id,
                json!({
                    "kind": "embedded_tool_parse_failed",
                    "source": "stream_final",
                    "preview": truncate_ui_chars(&assistant, 240),
                }),
            );
            assistant =
                "正文像工具调用但未能解析执行。请再发一次，改用 API tool_calls（不要把 DSML 当终答）。"
                    .into();
            card.assistant_text = assistant.clone();
        }
    }
    let mk = model_key(&model.provider_id, &model.model_id);
    card.cost = compute_cost(&mk, &model.litellm_model, &card.usage);
    if !card.cost.priced && pricing_is_stale(&load_pricing(), PRICING_STALE_MS) {
        let _ = refresh_pricing_if_stale(PRICING_STALE_MS).await;
        card.cost = compute_cost(&mk, &model.litellm_model, &card.usage);
    }
    if assistant.trim().is_empty() {
        snapshot_mcp_activity_to_card(&mut card, &activity);
        return fail_stream_card(
            &app,
            &mut card,
            &card_id,
            created_at,
            "上游无文本输出（流结束且正文为空；若协议日志含 SSE error 请对照）".into(),
        )
        .await;
    }
    card.status = "done".into();
    snapshot_mcp_activity_to_card(&mut card, &activity);
    write_card(&card)?;
    touch_recent_model(&mk);
    let _ = app.emit(
        "notes-stream-done",
        json!({
            "card_id": card_id,
            "created_at": created_at,
            "status": "done",
            "card": card_to_summary(&card),
        }),
    );
    Ok(())
}

fn touch_recent_model(key: &str) {
    let mut pf = load_providers();
    pf.recent_model_keys.retain(|k| k != key);
    pf.recent_model_keys.insert(0, key.to_string());
    pf.recent_model_keys.truncate(12);
    if pf.default_model_key.is_none() {
        pf.default_model_key = Some(key.to_string());
    }
    let _ = save_providers(&pf);
}

#[tauri::command]
pub async fn notes_test_connection(
    app: AppHandle,
    model_key: String,
) -> Result<String, String> {
    let sink = ProgressSink::new(app, "test_connection");
    sink.emit("resolve", &format!("解析模型 {model_key}…"), 10);
    let model = match resolve_model(&model_key) {
        Ok(m) => m,
        Err(e) => {
            sink.done_err(&e);
            return Err(e);
        }
    };
    let pf = load_providers();
    let prov = match pf
        .providers
        .iter()
        .find(|p| p.id == model.provider_id)
        .cloned()
    {
        Some(p) => p,
        None => {
            let e = format!("找不到 provider: {}", model.provider_id);
            sink.done_err(&e);
            return Err(e);
        }
    };
    let via_proxy = provider_uses_http_proxy(&prov);
    sink.emit(
        "http_post",
        &format!(
            "上游 ping · {}（本卡代理 {}）…",
            model.label,
            if via_proxy { "开" } else { "关" }
        ),
        55,
    );
    match ping_provider_model(&prov, &model.model_id).await {
        Ok(()) => {
            let msg = format!("连接成功 · {}", model.label);
            sink.done_ok(&msg);
            Ok(msg)
        }
        Err(e) => {
            sink.done_err(&e);
            Err(e)
        }
    }
}
