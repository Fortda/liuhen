//! 笔记 MCP 偏好、搜索配置、工具注册与原生执行（与 mcp/* stdio 包工具名对齐）。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::notes_paths::{notes_config_dir, notes_root};
use crate::resolve_data_root;

pub const MCP_PREFS_FILE: &str = "mcp_prefs.json";
pub const SEARCH_CONFIG_FILE: &str = "search_config.json";

pub const SERVER_CLUE_BOARD: &str = "clue_board";
pub const SERVER_OMNI_DATA: &str = "omni_data";
pub const SERVER_OMNI_ARCH: &str = "omni_arch";
pub const SERVER_OMNI_DASH_UI: &str = "omni_dash_ui";
pub const SERVER_OMNI_SEARCH: &str = "omni_search";
pub const SERVER_OMNI_ARTIFACT: &str = "omni_artifact";

const MAX_TOOL_ROUNDS: usize = 8;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerToggle {
    pub id: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpPrefs {
    pub v: u32,
    /// 是否注入「与本软件有关」的短架构摘要
    #[serde(default = "default_true")]
    pub inject_product_context: bool,
    #[serde(default = "default_servers")]
    pub servers: Vec<McpServerToggle>,
}

fn default_servers() -> Vec<McpServerToggle> {
    vec![
        McpServerToggle {
            id: SERVER_CLUE_BOARD.into(),
            enabled: false,
        },
        McpServerToggle {
            id: SERVER_OMNI_DATA.into(),
            enabled: false,
        },
        McpServerToggle {
            id: SERVER_OMNI_ARCH.into(),
            enabled: false,
        },
        McpServerToggle {
            id: SERVER_OMNI_DASH_UI.into(),
            enabled: false,
        },
        McpServerToggle {
            id: SERVER_OMNI_SEARCH.into(),
            enabled: false,
        },
        McpServerToggle {
            id: SERVER_OMNI_ARTIFACT.into(),
            enabled: false,
        },
    ]
}

impl Default for McpPrefs {
    fn default() -> Self {
        Self {
            v: 1,
            inject_product_context: true,
            servers: default_servers(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchConfig {
    pub v: u32,
    /// duckduckgo | searx | brave | custom
    #[serde(default = "default_engine")]
    pub engine: String,
    #[serde(default)]
    pub searx_url: String,
    #[serde(default)]
    pub custom_url: String,
    #[serde(default)]
    pub api_key: String,
}

fn default_engine() -> String {
    "duckduckgo".into()
}

impl Default for SearchConfig {
    fn default() -> Self {
        Self {
            v: 1,
            engine: default_engine(),
            searx_url: String::new(),
            custom_url: String::new(),
            api_key: String::new(),
        }
    }
}

fn mcp_prefs_path() -> PathBuf {
    notes_config_dir().join(MCP_PREFS_FILE)
}

fn search_config_path() -> PathBuf {
    notes_config_dir().join(SEARCH_CONFIG_FILE)
}

pub fn load_mcp_prefs() -> McpPrefs {
    let path = mcp_prefs_path();
    let Ok(raw) = fs::read_to_string(&path) else {
        return McpPrefs::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

pub fn save_mcp_prefs(prefs: &McpPrefs) -> Result<(), String> {
    fs::create_dir_all(notes_config_dir()).map_err(|e| e.to_string())?;
    let mut p = prefs.clone();
    p.v = 1;
    let raw = serde_json::to_string_pretty(&p).map_err(|e| e.to_string())?;
    fs::write(mcp_prefs_path(), raw).map_err(|e| e.to_string())
}

pub fn load_search_config() -> SearchConfig {
    let path = search_config_path();
    let Ok(raw) = fs::read_to_string(&path) else {
        return SearchConfig::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

pub fn save_search_config(cfg: &SearchConfig) -> Result<(), String> {
    fs::create_dir_all(notes_config_dir()).map_err(|e| e.to_string())?;
    let mut c = cfg.clone();
    c.v = 1;
    let raw = serde_json::to_string_pretty(&c).map_err(|e| e.to_string())?;
    fs::write(search_config_path(), raw).map_err(|e| e.to_string())
}

pub fn enabled_server_ids(prefs: &McpPrefs) -> HashSet<String> {
    prefs
        .servers
        .iter()
        .filter(|s| s.enabled)
        .map(|s| s.id.clone())
        .collect()
}

pub fn any_mcp_enabled(prefs: &McpPrefs) -> bool {
    prefs.servers.iter().any(|s| s.enabled)
}

pub fn product_context_system_message() -> String {
    let root = resolve_data_root();
    format!(
        "You are assisting inside 留痕 / Liuhen (OmniPlayer shell). Data root: {}. \
You may use tools only within their documented scope. \
Do NOT edit .cursor/ARCHITECTURE_BLUEPRINT.md directly — use write_adr_draft or write_arch_suggestion instead. \
Dashboard UI edits are limited to stats/live/sleep front-end files. \
Clue board tools exist but must NOT be used to mint a new empty board at the start of a chat. \
Only call clue_board_create_board when the user explicitly asks for a new board. \
Prefer clue_board_list / clue_board_get on an existing board. \
Version history is durable: clue_board_list_history shows chronological steps (human vs AI); \
clue_board_rollback restores a prior seq via full snapshot (safe undo / version restore).",
        root.display()
    )
}

pub fn clue_board_usage_system_message(viewing: bool, board_id: Option<&str>) -> String {
    let bid = board_id.map(|s| s.trim()).filter(|s| !s.is_empty());
    if viewing {
        if let Some(id) = bid {
            return format!(
                "The user is currently viewing clue board `{id}`. Use that board_id for get / create_note / add_edge / update. \
Do NOT call clue_board_create_board unless they explicitly ask for a new board."
            );
        }
    }
    "The user is not on a clue board. Do NOT call clue_board_create_board or create empty boards unless they explicitly ask to make a board. Answer in chat instead."
        .into()
}

/// Map OpenAI tool name → MCP server id (stable; unknown → None).
pub fn server_id_for_tool(name: &str) -> Option<&'static str> {
    match name {
        "read_data_root" | "list_recent_cards" | "tail_module_health" => Some(SERVER_OMNI_DATA),
        "read_blueprint" | "write_adr_draft" | "write_arch_suggestion" => Some(SERVER_OMNI_ARCH),
        "read_dash_ui_file" | "apply_dash_ui_patch" => Some(SERVER_OMNI_DASH_UI),
        "web_search" => Some(SERVER_OMNI_SEARCH),
        "write_artifact" => Some(SERVER_OMNI_ARTIFACT),
        "clue_board_list"
        | "clue_board_get"
        | "clue_board_create_board"
        | "clue_board_create_note"
        | "clue_board_update_note"
        | "clue_board_delete_note"
        | "clue_board_add_edge"
        | "clue_board_delete_edge"
        | "clue_board_set_active"
        | "clue_board_list_history"
        | "clue_board_rollback" => Some(SERVER_CLUE_BOARD),
        _ => None,
    }
}

/// Dedup tools in first-seen order; servers in first-seen order of those tools.
pub fn collect_mcp_usage(tool_names: &[String]) -> (Vec<String>, Vec<String>) {
    let mut tools = Vec::new();
    let mut servers = Vec::new();
    let mut seen_t = HashSet::new();
    let mut seen_s = HashSet::new();
    for name in tool_names {
        if name.is_empty() {
            continue;
        }
        if seen_t.insert(name.clone()) {
            tools.push(name.clone());
        }
        if let Some(sid) = server_id_for_tool(name) {
            if seen_s.insert(sid.to_string()) {
                servers.push(sid.to_string());
            }
        }
    }
    (servers, tools)
}

pub fn openai_tools_for_prefs(prefs: &McpPrefs) -> Vec<Value> {
    let enabled = enabled_server_ids(prefs);
    let mut tools = Vec::new();
    if enabled.contains(SERVER_OMNI_DATA) {
        tools.push(tool_def(
            "read_data_root",
            "Return OmniDatabase root path.",
            json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        ));
        tools.push(tool_def(
            "list_recent_cards",
            "List recent note card summaries (read-only), chronological ascending by created_at.",
            json!({
                "type": "object",
                "properties": { "limit": { "type": "integer", "description": "Max cards, default 20" } },
                "additionalProperties": false
            }),
        ));
        tools.push(tool_def(
            "tail_module_health",
            "Tail module_health.jsonl lines (read-only).",
            json!({
                "type": "object",
                "properties": { "max_lines": { "type": "integer" } },
                "additionalProperties": false
            }),
        ));
    }
    if enabled.contains(SERVER_OMNI_ARCH) {
        tools.push(tool_def(
            "read_blueprint",
            "Read ARCHITECTURE_BLUEPRINT.md (read-only).",
            json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        ));
        tools.push(tool_def(
            "write_adr_draft",
            "Write ADR draft markdown under OmniDatabase/notes/adr_drafts/ (does not edit live blueprint).",
            json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "body_markdown": { "type": "string" }
                },
                "required": ["title", "body_markdown"],
                "additionalProperties": false
            }),
        ));
        tools.push(tool_def(
            "write_arch_suggestion",
            "Write architecture suggestion markdown under OmniDatabase/notes/adr_drafts/suggestions/.",
            json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "body_markdown": { "type": "string" }
                },
                "required": ["title", "body_markdown"],
                "additionalProperties": false
            }),
        ));
    }
    if enabled.contains(SERVER_OMNI_DASH_UI) {
        tools.push(tool_def(
            "read_dash_ui_file",
            "Read whitelisted dashboard UI source file.",
            json!({
                "type": "object",
                "properties": {
                    "file_id": {
                        "type": "string",
                        "enum": ["dashboard_ts", "dashboard_status_ts", "index_html", "shell_i18n", "shell_i18n_about"]
                    }
                },
                "required": ["file_id"],
                "additionalProperties": false
            }),
        ));
        tools.push(tool_def(
            "apply_dash_ui_patch",
            "Replace old_string with new_string in whitelisted dashboard UI file.",
            json!({
                "type": "object",
                "properties": {
                    "file_id": { "type": "string" },
                    "old_string": { "type": "string" },
                    "new_string": { "type": "string" }
                },
                "required": ["file_id", "old_string", "new_string"],
                "additionalProperties": false
            }),
        ));
    }
    if enabled.contains(SERVER_OMNI_SEARCH) {
        tools.push(tool_def(
            "web_search",
            "Search the web using user-configured engine in notes settings.",
            json!({
                "type": "object",
                "properties": { "query": { "type": "string" } },
                "required": ["query"],
                "additionalProperties": false
            }),
        ));
    }
    if enabled.contains(SERVER_OMNI_ARTIFACT) {
        tools.push(tool_def(
            "write_artifact",
            "Write HTML or Markdown to AI canvas files under OmniDatabase/notes/artifacts/ (no live canvas).",
            json!({
                "type": "object",
                "properties": {
                    "filename": { "type": "string" },
                    "format": { "type": "string", "enum": ["html", "markdown"] },
                    "content": { "type": "string" }
                },
                "required": ["filename", "format", "content"],
                "additionalProperties": false
            }),
        ));
    }
    if enabled.contains(SERVER_CLUE_BOARD) {
        tools.push(tool_def(
            "clue_board_list",
            "List clue boards (id, title, node/edge counts).",
            json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        ));
        tools.push(tool_def(
            "clue_board_get",
            "Get active or specified clue board (nodes, edges, view).",
            json!({
                "type": "object",
                "properties": { "board_id": { "type": "string" } },
                "additionalProperties": false
            }),
        ));
        tools.push(tool_def(
            "clue_board_create_board",
            "Create a new clue board ONLY when the user explicitly asks for a new board. Never call this at the start of a chat or as a default. Returns board_id — do not invent ids.",
            json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string", "description": "Board title" },
                    "set_active": { "type": "boolean", "description": "If true (default), switch UI active board to the new one" }
                },
                "additionalProperties": false
            }),
        ));
        tools.push(tool_def(
            "clue_board_create_note",
            "Add a sticky note to an existing clue board. Prefer the active board or clue_board_list first. Do NOT call clue_board_create_board first unless the user asked for a new board.",
            json!({
                "type": "object",
                "properties": {
                    "text": { "type": "string" },
                    "x": { "type": "number" },
                    "y": { "type": "number" },
                    "board_id": { "type": "string" },
                    "w": { "type": "number" },
                    "h": { "type": "number" },
                    "color": { "type": "string" }
                },
                "required": ["text"],
                "additionalProperties": false
            }),
        ));
        tools.push(tool_def(
            "clue_board_update_note",
            "Update a note's text, position, or size.",
            json!({
                "type": "object",
                "properties": {
                    "board_id": { "type": "string" },
                    "node_id": { "type": "string" },
                    "text": { "type": "string" },
                    "x": { "type": "number" },
                    "y": { "type": "number" },
                    "w": { "type": "number" },
                    "h": { "type": "number" },
                    "color": { "type": "string" }
                },
                "required": ["node_id"],
                "additionalProperties": false
            }),
        ));
        tools.push(tool_def(
            "clue_board_delete_note",
            "Delete a note and its connected edges.",
            json!({
                "type": "object",
                "properties": {
                    "board_id": { "type": "string" },
                    "node_id": { "type": "string" }
                },
                "required": ["node_id"],
                "additionalProperties": false
            }),
        ));
        tools.push(tool_def(
            "clue_board_add_edge",
            "Add a directed edge (arrow) between two notes.",
            json!({
                "type": "object",
                "properties": {
                    "board_id": { "type": "string" },
                    "from": { "type": "string" },
                    "to": { "type": "string" },
                    "edge_id": { "type": "string" }
                },
                "required": ["from", "to"],
                "additionalProperties": false
            }),
        ));
        tools.push(tool_def(
            "clue_board_delete_edge",
            "Delete an edge by edge_id, or by from/to pair.",
            json!({
                "type": "object",
                "properties": {
                    "board_id": { "type": "string" },
                    "edge_id": { "type": "string" },
                    "from": { "type": "string" },
                    "to": { "type": "string" }
                },
                "additionalProperties": false
            }),
        ));
        tools.push(tool_def(
            "clue_board_set_active",
            "Set the active clue board (UI selection).",
            json!({
                "type": "object",
                "properties": { "board_id": { "type": "string" } },
                "required": ["board_id"],
                "additionalProperties": false
            }),
        ));
        tools.push(tool_def(
            "clue_board_list_history",
            "List durable chronological version history for a clue board (survives app restart). Each step has seq, ts, actor (human|ai), action, and optional rollback_to_seq. Use before clue_board_rollback to pick a seq.",
            json!({
                "type": "object",
                "properties": {
                    "board_id": { "type": "string", "description": "Board id; omit for active board" }
                },
                "additionalProperties": false
            }),
        ));
        tools.push(tool_def(
            "clue_board_rollback",
            "Restore a clue board to a prior history seq (full snapshot restore). Appends a new rollback audit entry; does not delete older steps. Prefer this for undo / version restore. Actor is recorded as AI.",
            json!({
                "type": "object",
                "properties": {
                    "board_id": { "type": "string" },
                    "seq": { "type": "integer", "description": "Target history seq from clue_board_list_history" }
                },
                "required": ["seq"],
                "additionalProperties": false
            }),
        ));
    }
    tools
}

fn tool_def(name: &str, description: &str, parameters: Value) -> Value {
    json!({
        "type": "function",
        "function": {
            "name": name,
            "description": description,
            "parameters": parameters
        }
    })
}

fn repo_root() -> Option<PathBuf> {
    let mut dir = std::env::current_dir().ok()?;
    for _ in 0..8 {
        if dir.join("Cargo.toml").exists() && dir.join("omniplayer").exists() {
            return Some(dir);
        }
        if !dir.pop() {
            break;
        }
    }
    None
}

fn dash_ui_path(file_id: &str) -> Result<PathBuf, String> {
    let root = repo_root().ok_or("找不到仓库根目录")?;
    match file_id {
        "dashboard_ts" => Ok(root.join("omniplayer/src/dashboard.ts")),
        "dashboard_status_ts" => Ok(root.join("omniplayer/src/dashboard_status.ts")),
        "index_html" => Ok(root.join("omniplayer/index.html")),
        "shell_i18n" => Ok(root.join("omniplayer/src/shell_i18n.ts")),
        "shell_i18n_about" => Ok(root.join("omniplayer/src/shell_i18n_about.ts")),
        other => Err(format!("不允许的文件: {other}")),
    }
}

fn slug_filename(title: &str) -> String {
    let mut s: String = title
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    if s.len() > 64 {
        s.truncate(64);
    }
    if s.is_empty() {
        s = "draft".into();
    }
    s
}

pub async fn execute_tool(name: &str, args: &Value, prefs: &McpPrefs) -> Result<Value, String> {
    let enabled = enabled_server_ids(prefs);
    match name {
        "read_data_root" if enabled.contains(SERVER_OMNI_DATA) => {
            Ok(json!({ "data_root": resolve_data_root().to_string_lossy() }))
        }
        "list_recent_cards" if enabled.contains(SERVER_OMNI_DATA) => {
            let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(20) as usize;
            let mut cards = crate::notes_ctl::list_cards_internal(limit)?;
            // Chronological (oldest → newest); UI list stays newest-first separately.
            cards.sort_by(|a, b| {
                a.created_at
                    .cmp(&b.created_at)
                    .then_with(|| a.id.cmp(&b.id))
            });
            Ok(json!({
                "order": "ascending_created_at",
                "cards": cards
            }))
        }
        "tail_module_health" if enabled.contains(SERVER_OMNI_DATA) => {
            let max = args.get("max_lines").and_then(|v| v.as_u64()).unwrap_or(40) as usize;
            Ok(json!({ "lines": tail_jsonl(&resolve_data_root().join("control/module_health.jsonl"), max)? }))
        }
        "read_blueprint" if enabled.contains(SERVER_OMNI_ARCH) => {
            let root = repo_root().ok_or("找不到仓库根")?;
            let path = root.join(".cursor/ARCHITECTURE_BLUEPRINT.md");
            let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
            Ok(json!({ "path": path.to_string_lossy(), "text": text }))
        }
        "write_adr_draft" if enabled.contains(SERVER_OMNI_ARCH) => {
            let title = args.get("title").and_then(|v| v.as_str()).unwrap_or("adr");
            let body = args
                .get("body_markdown")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let dir = notes_root().join("adr_drafts");
            fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let ts = chrono::Utc::now().format("%Y%m%d_%H%M%S");
            let file = dir.join(format!("{}_{}.md", ts, slug_filename(title)));
            let content = format!("# {title}\n\n{body}\n");
            fs::write(&file, content).map_err(|e| e.to_string())?;
            Ok(json!({ "written": file.to_string_lossy() }))
        }
        "write_arch_suggestion" if enabled.contains(SERVER_OMNI_ARCH) => {
            let title = args.get("title").and_then(|v| v.as_str()).unwrap_or("suggestion");
            let body = args
                .get("body_markdown")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            let dir = notes_root().join("adr_drafts/suggestions");
            fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let ts = chrono::Utc::now().format("%Y%m%d_%H%M%S");
            let file = dir.join(format!("{}_{}.md", ts, slug_filename(title)));
            let content = format!("# {title}\n\n{body}\n");
            fs::write(&file, content).map_err(|e| e.to_string())?;
            Ok(json!({ "written": file.to_string_lossy() }))
        }
        "read_dash_ui_file" if enabled.contains(SERVER_OMNI_DASH_UI) => {
            let fid = args
                .get("file_id")
                .and_then(|v| v.as_str())
                .ok_or("缺少 file_id")?;
            let path = dash_ui_path(fid)?;
            let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
            Ok(json!({ "file_id": fid, "path": path.to_string_lossy(), "text": text }))
        }
        "apply_dash_ui_patch" if enabled.contains(SERVER_OMNI_DASH_UI) => {
            let fid = args
                .get("file_id")
                .and_then(|v| v.as_str())
                .ok_or("缺少 file_id")?;
            let old_s = args
                .get("old_string")
                .and_then(|v| v.as_str())
                .ok_or("缺少 old_string")?;
            let new_s = args
                .get("new_string")
                .and_then(|v| v.as_str())
                .ok_or("缺少 new_string")?;
            let path = dash_ui_path(fid)?;
            let mut text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
            if !text.contains(old_s) {
                return Err("old_string 未在文件中找到".into());
            }
            text = text.replacen(old_s, new_s, 1);
            fs::write(&path, text).map_err(|e| e.to_string())?;
            Ok(json!({ "patched": path.to_string_lossy() }))
        }
        "web_search" if enabled.contains(SERVER_OMNI_SEARCH) => web_search(args).await,
        "write_artifact" if enabled.contains(SERVER_OMNI_ARTIFACT) => {
            let filename = args
                .get("filename")
                .and_then(|v| v.as_str())
                .ok_or("缺少 filename")?;
            let format = args
                .get("format")
                .and_then(|v| v.as_str())
                .unwrap_or("markdown");
            let content = args
                .get("content")
                .and_then(|v| v.as_str())
                .ok_or("缺少 content")?;
            let ext = if format == "html" { "html" } else { "md" };
            let safe: String = filename
                .chars()
                .map(|c| {
                    if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                        c
                    } else {
                        '_'
                    }
                })
                .collect();
            let dir = notes_root().join("artifacts");
            fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let path = dir.join(if safe.ends_with(ext) { safe } else { format!("{safe}.{ext}") });
            fs::write(&path, content).map_err(|e| e.to_string())?;
            Ok(json!({ "written": path.to_string_lossy() }))
        }
        "clue_board_list" if enabled.contains(SERVER_CLUE_BOARD) => {
            let data = crate::notes_ctl::notes_clue_board_load_internal()?;
            Ok(json!({
                "active_id": data.active_id,
                "boards": data.boards.iter().map(|b| json!({
                    "id": b.id,
                    "title": b.title,
                    "node_count": b.nodes.len(),
                    "edge_count": b.edges.len(),
                })).collect::<Vec<_>>()
            }))
        }
        "clue_board_get" if enabled.contains(SERVER_CLUE_BOARD) => {
            let data = crate::notes_ctl::notes_clue_board_load_internal()?;
            let bid = args.get("board_id").and_then(|v| v.as_str());
            let board = if let Some(id) = bid {
                data.boards.iter().find(|b| b.id == id).cloned()
            } else {
                data.boards.iter().find(|b| b.id == data.active_id).cloned()
            };
            board
                .map(|b| json!({ "board": b }))
                .ok_or_else(|| "board not found".into())
        }
        "clue_board_create_board" if enabled.contains(SERVER_CLUE_BOARD) => {
            let title = args
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let set_active = args
                .get("set_active")
                .and_then(|v| v.as_bool())
                .unwrap_or(true);
            let id = crate::notes_ctl::new_board_id();
            let id_for_hist = id.clone();
            let board = crate::notes_ctl::with_clue_boards(|data| {
                data.boards.push(crate::notes_ctl::ClueBoard {
                    id: id.clone(),
                    title: title.clone(),
                    nodes: vec![],
                    edges: vec![],
                    view: Some(crate::notes_ctl::ClueBoardView {
                        x: 0.0,
                        y: 0.0,
                        zoom: Some(1.0),
                    }),
                    created_at: 0,
                    updated_at: 0,
                });
                if set_active {
                    data.active_id = id.clone();
                }
                data.boards
                    .iter()
                    .find(|b| b.id == id)
                    .cloned()
                    .ok_or_else(|| "failed to create board".to_string())
            })?;
            let _ = crate::notes_clue_history::append_from_board(
                &board,
                "ai",
                "create_board",
                Some("clue_board_create_board"),
                Some("notes.clue.history.newBoard"),
                None,
            );
            Ok(json!({ "board_id": id_for_hist, "active": set_active }))
        }
        "clue_board_create_note" if enabled.contains(SERVER_CLUE_BOARD) => {
            let board_id_arg = args
                .get("board_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let text = args
                .get("text")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string();
            let x = args.get("x").and_then(|v| v.as_f64()).unwrap_or(120.0);
            let y = args.get("y").and_then(|v| v.as_f64()).unwrap_or(120.0);
            let w = args.get("w").and_then(|v| v.as_f64()).or(Some(200.0));
            let h = args.get("h").and_then(|v| v.as_f64()).or(Some(120.0));
            let color = args
                .get("color")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let node_id = format!("node_{}", chrono::Utc::now().timestamp_millis());
            let (board_id, hist) = crate::notes_ctl::with_clue_boards(|data| {
                let active_id = data.active_id.clone();
                let bid = board_id_arg
                    .as_deref()
                    .unwrap_or(active_id.as_str())
                    .to_string();
                let board = data.boards.iter_mut().find(|b| b.id == bid).ok_or_else(|| {
                    format!(
                        "board not found: {bid}. Call clue_board_list and use an existing board_id; only call clue_board_create_board if the user asked for a new board."
                    )
                })?;
                board.nodes.push(crate::notes_ctl::ClueBoardNode {
                    id: node_id.clone(),
                    text: text.clone(),
                    x,
                    y,
                    w,
                    h,
                    color: color.clone(),
                    rotation: None,
                });
                Ok((bid, board.clone()))
            })?;
            let _ = crate::notes_clue_history::append_from_board(
                &hist,
                "ai",
                "add_node",
                Some("clue_board_create_note"),
                Some("notes.clue.history.addNode"),
                None,
            );
            Ok(json!({ "node_id": node_id, "board_id": board_id }))
        }
        "clue_board_update_note" if enabled.contains(SERVER_CLUE_BOARD) => {
            let board_id_arg = args
                .get("board_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let node_id = args
                .get("node_id")
                .and_then(|v| v.as_str())
                .ok_or("缺少 node_id")?
                .to_string();
            let (bid, updated, hist) = crate::notes_ctl::with_clue_boards(|data| {
                let active_id = data.active_id.clone();
                let bid = board_id_arg
                    .as_deref()
                    .unwrap_or(active_id.as_str())
                    .to_string();
                let board = data
                    .boards
                    .iter_mut()
                    .find(|b| b.id == bid)
                    .ok_or("board not found")?;
                let node = board
                    .nodes
                    .iter_mut()
                    .find(|n| n.id == node_id)
                    .ok_or_else(|| format!("node not found: {node_id}"))?;
                if let Some(t) = args.get("text").and_then(|v| v.as_str()) {
                    node.text = t.to_string();
                }
                if let Some(x) = args.get("x").and_then(|v| v.as_f64()) {
                    node.x = x;
                }
                if let Some(y) = args.get("y").and_then(|v| v.as_f64()) {
                    node.y = y;
                }
                if let Some(w) = args.get("w").and_then(|v| v.as_f64()) {
                    node.w = Some(w);
                }
                if let Some(h) = args.get("h").and_then(|v| v.as_f64()) {
                    node.h = Some(h);
                }
                if let Some(c) = args.get("color").and_then(|v| v.as_str()) {
                    node.color = Some(c.to_string());
                }
                let updated = node.clone();
                Ok((bid, updated, board.clone()))
            })?;
            let _ = crate::notes_clue_history::append_from_board(
                &hist,
                "ai",
                "update_note",
                Some("clue_board_update_note"),
                Some("notes.clue.history.editText"),
                None,
            );
            Ok(json!({ "node": updated, "board_id": bid }))
        }
        "clue_board_delete_note" if enabled.contains(SERVER_CLUE_BOARD) => {
            let board_id_arg = args
                .get("board_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let node_id = args
                .get("node_id")
                .and_then(|v| v.as_str())
                .ok_or("缺少 node_id")?
                .to_string();
            let (bid, removed_edges, hist) = crate::notes_ctl::with_clue_boards(|data| {
                let active_id = data.active_id.clone();
                let bid = board_id_arg
                    .as_deref()
                    .unwrap_or(active_id.as_str())
                    .to_string();
                let board = data
                    .boards
                    .iter_mut()
                    .find(|b| b.id == bid)
                    .ok_or("board not found")?;
                let before_n = board.nodes.len();
                let before_e = board.edges.len();
                board.nodes.retain(|n| n.id != node_id);
                if board.nodes.len() == before_n {
                    return Err(format!("node not found: {node_id}"));
                }
                board.edges.retain(|e| e.from != node_id && e.to != node_id);
                let removed_edges = before_e - board.edges.len();
                Ok((bid, removed_edges, board.clone()))
            })?;
            let _ = crate::notes_clue_history::append_from_board(
                &hist,
                "ai",
                "delete_node",
                Some("clue_board_delete_note"),
                Some("notes.clue.history.deleteNode"),
                None,
            );
            Ok(json!({
                "deleted_node_id": node_id,
                "board_id": bid,
                "removed_edges": removed_edges
            }))
        }
        "clue_board_add_edge" if enabled.contains(SERVER_CLUE_BOARD) => {
            let board_id_arg = args
                .get("board_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let from = args
                .get("from")
                .and_then(|v| v.as_str())
                .ok_or("缺少 from")?
                .to_string();
            let to = args
                .get("to")
                .and_then(|v| v.as_str())
                .ok_or("缺少 to")?
                .to_string();
            if from == to {
                return Err("from and to must differ".into());
            }
            let edge_id = args
                .get("edge_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(crate::notes_ctl::new_edge_id);
            let (bid, hist) = crate::notes_ctl::with_clue_boards(|data| {
                let active_id = data.active_id.clone();
                let bid = board_id_arg
                    .as_deref()
                    .unwrap_or(active_id.as_str())
                    .to_string();
                let board = data
                    .boards
                    .iter_mut()
                    .find(|b| b.id == bid)
                    .ok_or("board not found")?;
                if !board.nodes.iter().any(|n| n.id == from) {
                    return Err(format!("from node not found: {from}"));
                }
                if !board.nodes.iter().any(|n| n.id == to) {
                    return Err(format!("to node not found: {to}"));
                }
                if board.edges.iter().any(|e| e.from == from && e.to == to) {
                    return Err(format!("edge already exists: {from} -> {to}"));
                }
                board.edges.push(crate::notes_ctl::ClueBoardEdge {
                    id: edge_id.clone(),
                    from: from.clone(),
                    to: to.clone(),
                });
                Ok((bid, board.clone()))
            })?;
            let _ = crate::notes_clue_history::append_from_board(
                &hist,
                "ai",
                "add_edge",
                Some("clue_board_add_edge"),
                Some("notes.clue.history.addEdge"),
                None,
            );
            Ok(json!({ "edge_id": edge_id, "board_id": bid, "from": from, "to": to }))
        }
        "clue_board_delete_edge" if enabled.contains(SERVER_CLUE_BOARD) => {
            let board_id_arg = args
                .get("board_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
            let edge_id = args.get("edge_id").and_then(|v| v.as_str()).map(|s| s.to_string());
            let from = args.get("from").and_then(|v| v.as_str()).map(|s| s.to_string());
            let to = args.get("to").and_then(|v| v.as_str()).map(|s| s.to_string());
            let (bid, hist) = crate::notes_ctl::with_clue_boards(|data| {
                let active_id = data.active_id.clone();
                let bid = board_id_arg
                    .as_deref()
                    .unwrap_or(active_id.as_str())
                    .to_string();
                let board = data
                    .boards
                    .iter_mut()
                    .find(|b| b.id == bid)
                    .ok_or("board not found")?;
                let before = board.edges.len();
                if let Some(eid) = edge_id.as_deref() {
                    board.edges.retain(|e| e.id != eid);
                } else if let (Some(f), Some(t)) = (from.as_deref(), to.as_deref()) {
                    board.edges.retain(|e| !(e.from == f && e.to == t));
                } else {
                    return Err("provide edge_id or both from and to".into());
                }
                if board.edges.len() == before {
                    return Err("edge not found".into());
                }
                Ok((bid, board.clone()))
            })?;
            let _ = crate::notes_clue_history::append_from_board(
                &hist,
                "ai",
                "delete_edge",
                Some("clue_board_delete_edge"),
                Some("notes.clue.history.deleteEdge"),
                None,
            );
            Ok(json!({ "deleted": true, "board_id": bid, "edge_id": edge_id, "from": from, "to": to }))
        }
        "clue_board_set_active" if enabled.contains(SERVER_CLUE_BOARD) => {
            let board_id = args
                .get("board_id")
                .and_then(|v| v.as_str())
                .ok_or("缺少 board_id")?
                .trim()
                .to_string();
            crate::notes_ctl::with_clue_boards(|data| {
                if !data.boards.iter().any(|b| b.id == board_id) {
                    return Err(format!("board not found: {board_id}"));
                }
                data.active_id = board_id.clone();
                Ok(())
            })?;
            Ok(json!({ "active_id": board_id }))
        }
        "clue_board_list_history" if enabled.contains(SERVER_CLUE_BOARD) => {
            let data = crate::notes_ctl::notes_clue_board_load_internal()?;
            let bid = args
                .get("board_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| data.active_id.clone());
            if let Some(board) = data.boards.iter().find(|b| b.id == bid) {
                let _ = crate::notes_clue_history::ensure_seeded(board);
            }
            let list = crate::notes_clue_history::list_history(&bid)?;
            Ok(json!({
                "board_id": list.board_id,
                "path": list.path,
                "current_seq": list.current_seq,
                "entries": list.entries.iter().map(|e| json!({
                    "seq": e.seq,
                    "ts": e.ts,
                    "actor": e.actor,
                    "action": e.action,
                    "tool": e.tool,
                    "label_key": e.label_key,
                    "rollback_to_seq": e.rollback_to_seq,
                    "node_count": e.snapshot.nodes.len(),
                    "edge_count": e.snapshot.edges.len(),
                    "title": e.snapshot.title,
                })).collect::<Vec<_>>(),
                "hint": "Use clue_board_rollback with seq to restore a prior version (full snapshot)."
            }))
        }
        "clue_board_rollback" if enabled.contains(SERVER_CLUE_BOARD) => {
            let data = crate::notes_ctl::notes_clue_board_load_internal()?;
            let bid = args
                .get("board_id")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| data.active_id.clone());
            let seq = args
                .get("seq")
                .and_then(|v| v.as_u64())
                .ok_or("缺少 seq")?;
            let (boards, entry) =
                crate::notes_clue_history::rollback_to_seq(&bid, seq, "ai", Some("clue_board_rollback"))?;
            Ok(json!({
                "board_id": bid,
                "restored_seq": seq,
                "new_seq": entry.seq,
                "active_id": boards.active_id,
                "entry": {
                    "seq": entry.seq,
                    "actor": entry.actor,
                    "action": entry.action,
                    "rollback_to_seq": entry.rollback_to_seq,
                }
            }))
        }
        _ => Err(format!("未知或未启用的工具: {name}")),
    }
}

fn tail_jsonl(path: &Path, max_lines: usize) -> Result<Vec<String>, String> {
    if !path.exists() {
        return Ok(vec![]);
    }
    let raw = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let lines: Vec<String> = raw.lines().map(String::from).collect();
    let start = lines.len().saturating_sub(max_lines);
    Ok(lines[start..].to_vec())
}

async fn web_search(args: &Value) -> Result<Value, String> {
    let query = args
        .get("query")
        .and_then(|v| v.as_str())
        .ok_or("缺少 query")?;
    let cfg = load_search_config();
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| e.to_string())?;
    match cfg.engine.as_str() {
        "duckduckgo" => {
            let url = format!(
                "https://api.duckduckgo.com/?q={}&format=json&no_html=1",
                urlencoding(query)
            );
            let text = client.get(&url).send().await.map_err(|e| e.to_string())?.text().await.map_err(|e| e.to_string())?;
            Ok(json!({ "engine": "duckduckgo", "query": query, "raw": text }))
        }
        "searx" => {
            if cfg.searx_url.is_empty() {
                return Err("请在笔记设置中配置 SearX 实例 URL".into());
            }
            let base = cfg.searx_url.trim_end_matches('/');
            let url = format!("{base}/search?q={}&format=json", urlencoding(query));
            let text = client.get(&url).send().await.map_err(|e| e.to_string())?.text().await.map_err(|e| e.to_string())?;
            Ok(json!({ "engine": "searx", "query": query, "raw": text }))
        }
        "brave" => {
            if cfg.api_key.is_empty() {
                return Err("Brave 搜索需要在笔记设置中填写 API Key".into());
            }
            let url = format!(
                "https://api.search.brave.com/res/v1/web/search?q={}",
                urlencoding(query)
            );
            let text = client
                .get(&url)
                .header("X-Subscription-Token", &cfg.api_key)
                .send()
                .await
                .map_err(|e| e.to_string())?
                .text()
                .await
                .map_err(|e| e.to_string())?;
            Ok(json!({ "engine": "brave", "query": query, "raw": text }))
        }
        "custom" => {
            if cfg.custom_url.is_empty() {
                return Err("请在笔记设置中配置自定义搜索 URL（含 {{q}} 占位）".into());
            }
            let url = cfg.custom_url.replace("{q}", &urlencoding(query)).replace("{{q}}", &urlencoding(query));
            let text = client.get(&url).send().await.map_err(|e| e.to_string())?.text().await.map_err(|e| e.to_string())?;
            Ok(json!({ "engine": "custom", "query": query, "raw": text }))
        }
        other => Err(format!("未知搜索引擎: {other}")),
    }
}

fn urlencoding(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char);
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub fn max_tool_rounds() -> usize {
    MAX_TOOL_ROUNDS
}

#[tauri::command]
pub fn notes_mcp_prefs_get() -> Result<McpPrefs, String> {
    Ok(load_mcp_prefs())
}

#[tauri::command]
pub fn notes_mcp_prefs_save(prefs: McpPrefs) -> Result<McpPrefs, String> {
    save_mcp_prefs(&prefs)?;
    Ok(load_mcp_prefs())
}

#[tauri::command]
pub fn notes_search_config_get() -> Result<SearchConfig, String> {
    Ok(load_search_config())
}

#[tauri::command]
pub fn notes_search_config_save(config: SearchConfig) -> Result<SearchConfig, String> {
    save_search_config(&config)?;
    Ok(load_search_config())
}
