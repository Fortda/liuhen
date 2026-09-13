//! Import Google AI Studio / Gemini Takeout-style JSON exports into notes cards.

use chrono::{DateTime, SecondsFormat, Utc};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::notes_ctl::{
    write_card, NotesCard, NotesModelRef, TimingsDeltaS, TimingsMs,
};
use crate::notes_paths::{ensure_notes_dirs, log_file_path, new_card_id, notes_config_dir};
use crate::notes_pricing::{CostBreakdown, TokenUsage};

#[derive(Debug, Clone, Serialize)]
pub struct ImportResult {
    pub imported: u32,
    pub skipped: u32,
    pub report_path: String,
    pub errors: Vec<String>,
}

#[derive(Debug, Clone, Default)]
struct KeyHistEntry {
    string: u32,
    number: u32,
    object: u32,
    array: u32,
    bool: u32,
    null: u32,
}

impl KeyHistEntry {
    fn bump(&mut self, v: &Value) {
        match v {
            Value::String(_) => self.string += 1,
            Value::Number(_) => self.number += 1,
            Value::Object(_) => self.object += 1,
            Value::Array(_) => self.array += 1,
            Value::Bool(_) => self.bool += 1,
            Value::Null => self.null += 1,
        }
    }

    fn to_json(&self) -> Value {
        json!({
            "string": self.string,
            "number": self.number,
            "object": self.object,
            "array": self.array,
            "bool": self.bool,
            "null": self.null,
        })
    }
}

#[derive(Debug, Clone)]
struct ExtractedTurn {
    user_text: String,
    assistant_text: String,
    created_at: Option<u64>,
    model_label: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn file_mtime_ms(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or_else(now_ms)
}

fn walk_histogram(v: &Value, path: &str, hist: &mut BTreeMap<String, KeyHistEntry>, depth: u32) {
    if depth > 24 {
        return;
    }
    match v {
        Value::Object(map) => {
            for (k, child) in map {
                let p = if path.is_empty() {
                    k.clone()
                } else {
                    format!("{path}.{k}")
                };
                hist.entry(p.clone()).or_default().bump(child);
                walk_histogram(child, &p, hist, depth + 1);
            }
        }
        Value::Array(arr) => {
            for (i, child) in arr.iter().enumerate().take(64) {
                let p = format!("{path}[{i}]");
                // Cap path explosion: histogram by parent array + first-item keys only for deep arrays
                if i == 0 || arr.len() <= 8 {
                    walk_histogram(child, &p, hist, depth + 1);
                } else if i < 3 {
                    walk_histogram(child, &format!("{path}[*]"), hist, depth + 1);
                }
            }
            if !arr.is_empty() {
                hist.entry(format!("{path}[]")).or_default().bump(v);
            }
        }
        _ => {}
    }
}

fn role_of(obj: &Map<String, Value>) -> Option<String> {
    for key in ["role", "author", "user", "sender", "from"] {
        if let Some(v) = obj.get(key) {
            if let Some(s) = v.as_str() {
                let t = s.trim().to_lowercase();
                if !t.is_empty() {
                    return Some(t);
                }
            }
            if let Some(o) = v.as_object() {
                if let Some(s) = o
                    .get("role")
                    .or_else(|| o.get("name"))
                    .and_then(|x| x.as_str())
                {
                    let t = s.trim().to_lowercase();
                    if !t.is_empty() {
                        return Some(t);
                    }
                }
            }
            if key == "user" && v.as_bool() == Some(true) {
                return Some("user".into());
            }
        }
    }
    None
}

fn classify_role(role: &str) -> Option<&'static str> {
    let r = role.trim().to_lowercase();
    if matches!(
        r.as_str(),
        "user" | "human" | "prompt" | "question" | "me" | "client"
    ) {
        return Some("user");
    }
    if matches!(
        r.as_str(),
        "model"
            | "assistant"
            | "bot"
            | "ai"
            | "gemini"
            | "response"
            | "answer"
            | "bard"
    ) {
        return Some("model");
    }
    None
}

fn text_from_parts(parts: &Value) -> String {
    match parts {
        Value::String(s) => s.clone(),
        Value::Array(arr) => {
            let mut out = String::new();
            for p in arr {
                if let Some(s) = p.as_str() {
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    out.push_str(s);
                    continue;
                }
                if let Some(o) = p.as_object() {
                    for key in ["text", "content", "inlineData", "thought"] {
                        if key == "inlineData" {
                            continue;
                        }
                        if let Some(s) = o.get(key).and_then(|x| x.as_str()) {
                            if !s.is_empty() {
                                if !out.is_empty() {
                                    out.push('\n');
                                }
                                out.push_str(s);
                            }
                        }
                    }
                }
            }
            out
        }
        Value::Object(o) => o
            .get("text")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
        _ => String::new(),
    }
}

fn message_text(obj: &Map<String, Value>) -> String {
    for key in [
        "text",
        "content",
        "parts",
        "message",
        "prompt",
        "response",
        "body",
        "markdown",
    ] {
        if let Some(v) = obj.get(key) {
            match v {
                Value::String(s) if !s.trim().is_empty() => return s.clone(),
                Value::Array(_) => {
                    let t = text_from_parts(v);
                    if !t.trim().is_empty() {
                        return t;
                    }
                }
                Value::Object(inner) => {
                    if let Some(parts) = inner.get("parts") {
                        let t = text_from_parts(parts);
                        if !t.trim().is_empty() {
                            return t;
                        }
                    }
                    for k2 in ["text", "content", "message"] {
                        if let Some(s) = inner.get(k2).and_then(|x| x.as_str()) {
                            if !s.trim().is_empty() {
                                return s.to_string();
                            }
                        }
                    }
                }
                _ => {}
            }
        }
    }
    String::new()
}

fn parse_ts_value(v: &Value) -> Option<u64> {
    match v {
        Value::Number(n) => {
            let f = n.as_f64()?;
            if f > 1e12 {
                Some(f as u64)
            } else if f > 1e9 {
                Some((f * 1000.0) as u64)
            } else {
                None
            }
        }
        Value::String(s) => parse_ts_str(s),
        _ => None,
    }
}

fn parse_ts_str(s: &str) -> Option<u64> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    if let Ok(n) = t.parse::<f64>() {
        if n > 1e12 {
            return Some(n as u64);
        }
        if n > 1e9 {
            return Some((n * 1000.0) as u64);
        }
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(t) {
        return Some(dt.timestamp_millis() as u64);
    }
    // Truncate fractional / Z variants chrono might miss
    if let Ok(dt) = DateTime::parse_from_str(t, "%Y-%m-%dT%H:%M:%S%.f%z") {
        return Some(dt.timestamp_millis() as u64);
    }
    if let Ok(dt) = DateTime::parse_from_str(t, "%Y-%m-%dT%H:%M:%SZ") {
        return Some(dt.timestamp_millis() as u64);
    }
    None
}

fn message_ts(obj: &Map<String, Value>) -> Option<u64> {
    for key in [
        "createTime",
        "create_time",
        "created_at",
        "createdAt",
        "timestamp",
        "time",
        "ts",
        "updateTime",
        "updated_at",
    ] {
        if let Some(v) = obj.get(key) {
            if let Some(ms) = parse_ts_value(v) {
                return Some(ms);
            }
        }
    }
    None
}

fn looks_like_message(obj: &Map<String, Value>) -> bool {
    let has_role = role_of(obj).is_some();
    let has_text = !message_text(obj).trim().is_empty()
        || obj.contains_key("parts")
        || obj.contains_key("content")
        || obj.contains_key("text");
    has_role && has_text
}

fn collect_message_arrays<'a>(v: &'a Value, out: &mut Vec<&'a Vec<Value>>, depth: u32) {
    if depth > 20 {
        return;
    }
    match v {
        Value::Array(arr) => {
            let msg_like = arr
                .iter()
                .filter(|x| x.as_object().map(looks_like_message).unwrap_or(false))
                .count();
            if msg_like >= 1 && msg_like * 2 >= arr.len().max(1) {
                out.push(arr);
            }
            for child in arr.iter().take(200) {
                collect_message_arrays(child, out, depth + 1);
            }
        }
        Value::Object(map) => {
            for child in map.values() {
                collect_message_arrays(child, out, depth + 1);
            }
        }
        _ => {}
    }
}

fn sample_message_keys(arrs: &[&Vec<Value>]) -> Vec<String> {
    let mut keys = BTreeMap::new();
    for arr in arrs {
        for item in arr.iter().take(40) {
            if let Some(o) = item.as_object() {
                if looks_like_message(o) {
                    for k in o.keys() {
                        *keys.entry(k.clone()).or_insert(0u32) += 1;
                    }
                }
            }
        }
    }
    let mut list: Vec<(String, u32)> = keys.into_iter().collect();
    list.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    list.into_iter().take(24).map(|(k, _)| k).collect()
}

fn extract_model_label(root: &Value, obj: &Map<String, Value>) -> Option<String> {
    for key in ["model", "modelName", "model_name", "modelId", "model_id"] {
        if let Some(s) = obj.get(key).and_then(|x| x.as_str()) {
            let t = s.trim();
            if !t.is_empty() {
                return Some(format!("Google · {t}"));
            }
        }
    }
    if let Some(o) = root.as_object() {
        for key in ["model", "modelName", "runSettings", "metadata"] {
            if let Some(v) = o.get(key) {
                if let Some(s) = v.as_str() {
                    let t = s.trim();
                    if !t.is_empty() {
                        return Some(format!("Google · {t}"));
                    }
                }
                if let Some(inner) = v.as_object() {
                    for k2 in ["model", "modelName", "name"] {
                        if let Some(s) = inner.get(k2).and_then(|x| x.as_str()) {
                            let t = s.trim();
                            if !t.is_empty() {
                                return Some(format!("Google · {t}"));
                            }
                        }
                    }
                }
            }
        }
    }
    None
}

fn pair_turns(
    arr: &[Value],
    root: &Value,
    fallback_base: u64,
) -> Vec<ExtractedTurn> {
    let mut msgs: Vec<(String, String, Option<u64>, Option<String>)> = vec![];
    for item in arr {
        let Some(obj) = item.as_object() else {
            continue;
        };
        let Some(role_raw) = role_of(obj) else {
            continue;
        };
        let Some(side) = classify_role(&role_raw) else {
            continue;
        };
        let text = message_text(obj);
        if text.trim().is_empty() && side == "model" {
            continue;
        }
        msgs.push((
            side.to_string(),
            text,
            message_ts(obj),
            extract_model_label(root, obj),
        ));
    }

    let mut turns = vec![];
    let mut i = 0usize;
    let mut idx = 0u64;
    while i < msgs.len() {
        let (side, text, ts, model) = &msgs[i];
        if side == "user" {
            let user_text = text.clone();
            let created = *ts;
            let mut model_label = model.clone();
            let mut assistant_text = String::new();
            let mut used_pair = false;
            if let Some(next) = msgs.get(i + 1) {
                if next.0 == "model" {
                    assistant_text = next.1.clone();
                    if model_label.is_none() {
                        model_label = next.3.clone();
                    }
                    used_pair = true;
                }
            }
            turns.push(ExtractedTurn {
                user_text,
                assistant_text,
                created_at: created.or_else(|| Some(fallback_base.saturating_add(idx * 1000))),
                model_label,
            });
            idx += 1;
            i += if used_pair { 2 } else { 1 };
            continue;
        }
        // orphan model → skip (no user prompt)
        i += 1;
    }
    turns
}

fn unwrap_takeout(v: Value) -> Value {
    // Common Takeout wrappers: { conversations: [...] }, { chunk: [...] }, nested data
    if let Value::Object(map) = &v {
        for key in [
            "conversations",
            "chats",
            "chat",
            "history",
            "messages",
            "chunk",
            "data",
            "items",
            "contents",
        ] {
            if let Some(inner) = map.get(key) {
                if inner.is_array() || inner.is_object() {
                    return inner.clone();
                }
            }
        }
    }
    v
}

fn extract_turns_from_value(root: &Value, fallback_base: u64) -> Vec<ExtractedTurn> {
    let mut arrays = vec![];
    collect_message_arrays(root, &mut arrays, 0);
    // Prefer longest message-like array
    arrays.sort_by_key(|a| std::cmp::Reverse(a.len()));
    let mut all = vec![];
    let mut seen_sig = std::collections::HashSet::new();
    for arr in arrays {
        let turns = pair_turns(arr, root, fallback_base);
        if turns.is_empty() {
            continue;
        }
        // Dedup by first user text + len
        let sig = format!(
            "{}:{}:{}",
            turns.len(),
            turns.first().map(|t| t.user_text.len()).unwrap_or(0),
            turns
                .first()
                .map(|t| t.user_text.chars().take(40).collect::<String>())
                .unwrap_or_default()
        );
        if seen_sig.insert(sig) {
            all.extend(turns);
        }
    }
    all
}

fn imported_model(label: Option<String>) -> NotesModelRef {
    let label = label
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "Google · imported".into());
    NotesModelRef {
        provider_id: "google".into(),
        provider_label: "Google".into(),
        model_id: "imported".into(),
        label,
        litellm_model: String::new(),
        proxy_name: String::new(),
    }
}

fn write_imported_card(turn: &ExtractedTurn, created_at: u64) -> Result<(), String> {
    let card_id = new_card_id(created_at);
    ensure_notes_dirs(created_at).map_err(|e| e.to_string())?;
    let log_path = log_file_path(created_at, &card_id)
        .to_string_lossy()
        .into_owned();
    let card = NotesCard {
        v: 1,
        id: card_id,
        created_at,
        status: "done".into(),
        model: imported_model(turn.model_label.clone()),
        user_text: turn.user_text.clone(),
        assistant_text: turn.assistant_text.clone(),
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
        user_images: vec![],
        mcp_servers: vec![],
        mcp_tools: vec![],
        import_source: Some("aistudio".into()),
        mcp_activity: None,
    };
    write_card(&card)
}

fn read_json_file(path: &Path) -> Result<Value, String> {
    let raw = fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(format!("{}: empty file", path.display()));
    }
    serde_json::from_str(trimmed).map_err(|e| format!("{}: JSON parse error: {e}", path.display()))
}

fn import_one_file(
    path: &Path,
    hist: &mut BTreeMap<String, KeyHistEntry>,
    sample_keys: &mut Vec<String>,
) -> Result<(u32, u32), String> {
    let value = read_json_file(path)?;
    walk_histogram(&value, "", hist, 0);
    let unwrapped = unwrap_takeout(value.clone());
    if unwrapped != value {
        walk_histogram(&unwrapped, "unwrapped", hist, 0);
    }

    let mut arrays = vec![];
    collect_message_arrays(&unwrapped, &mut arrays, 0);
    let keys = sample_message_keys(&arrays);
    for k in keys {
        if !sample_keys.contains(&k) {
            sample_keys.push(k);
        }
    }

    let base = file_mtime_ms(path);
    let mut turns = extract_turns_from_value(&unwrapped, base);
    if turns.is_empty() {
        // Also try original root if unwrap changed structure poorly
        if unwrapped != value {
            turns = extract_turns_from_value(&value, base);
        }
    }
    if turns.is_empty() {
        return Ok((0, 1));
    }

    let mut imported = 0u32;
    for (i, turn) in turns.iter().enumerate() {
        if turn.user_text.trim().is_empty() && turn.assistant_text.trim().is_empty() {
            continue;
        }
        let created = turn
            .created_at
            .unwrap_or_else(|| base.saturating_add(i as u64 * 1000));
        // Slight offset so same-ms cards don't collide on id entropy alone
        let created = created.saturating_add(i as u64);
        write_imported_card(turn, created)?;
        imported += 1;
    }
    Ok((imported, if imported == 0 { 1 } else { 0 }))
}

#[tauri::command]
pub fn notes_import_aistudio_export(paths: Vec<String>) -> Result<ImportResult, String> {
    if paths.is_empty() {
        return Err("未选择文件".into());
    }
    fs::create_dir_all(notes_config_dir()).map_err(|e| e.to_string())?;

    let mut hist: BTreeMap<String, KeyHistEntry> = BTreeMap::new();
    let mut sample_keys: Vec<String> = vec![];
    let mut imported = 0u32;
    let mut skipped = 0u32;
    let mut errors: Vec<String> = vec![];
    let mut source_paths: Vec<String> = vec![];

    for p in &paths {
        let path = PathBuf::from(p);
        source_paths.push(path.display().to_string());
        match import_one_file(&path, &mut hist, &mut sample_keys) {
            Ok((imp, skip)) => {
                imported += imp;
                skipped += skip;
            }
            Err(e) => {
                skipped += 1;
                errors.push(e);
            }
        }
    }

    let ts = now_ms();
    let report_name = format!("aistudio_import_report_{ts}.json");
    let report_path = notes_config_dir().join(&report_name);
    let hist_json: Map<String, Value> = hist
        .iter()
        .map(|(k, v)| (k.clone(), v.to_json()))
        .collect();
    let report = json!({
        "v": 1,
        "utc": Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
        "source_paths": source_paths,
        "imported": imported,
        "skipped": skipped,
        "errors": errors,
        "sample_message_keys": sample_keys,
        "key_histogram": hist_json,
    });
    fs::write(
        &report_path,
        serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;

    Ok(ImportResult {
        imported,
        skipped,
        report_path: report_path.to_string_lossy().into_owned(),
        errors,
    })
}
