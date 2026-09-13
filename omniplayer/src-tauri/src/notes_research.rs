//! 研究资料库：`OmniDatabase/notes/research/` + `notes/config/research_index.jsonl`

use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::notes_paths::{
    calendar_segment, notes_config_dir, research_index_path, research_item_dir, research_root,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ResearchMeta {
    pub id: String,
    pub title: String,
    pub format: String,
    pub collected_at: u64,
    pub motive: String,
    pub orig_filename: String,
    pub rel_dir: String,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn new_research_id(ts_ms: u64) -> String {
    let n = (ts_ms ^ (ts_ms >> 12)) & 0xffff;
    format!("res_{ts_ms}_{n:04x}")
}

fn format_from_path(path: &Path) -> String {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| !e.is_empty())
        .unwrap_or_else(|| "unknown".into())
}

fn sanitize_filename(name: &str) -> String {
    let s: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let trimmed = s.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        "file".into()
    } else {
        trimmed.to_string()
    }
}

fn rel_dir_for(ts_ms: u64, id: &str) -> String {
    use chrono::{Datelike, TimeZone, Utc};
    let dt = Utc
        .timestamp_millis_opt(ts_ms as i64)
        .single()
        .unwrap_or_else(Utc::now);
    let seg = calendar_segment(dt.year(), dt.month(), dt.day());
    seg.join(id).to_string_lossy().replace('\\', "/")
}

fn meta_path(item_dir: &Path) -> PathBuf {
    item_dir.join("meta.json")
}

fn read_meta_file(path: &Path) -> Option<ResearchMeta> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_meta(item_dir: &Path, meta: &ResearchMeta) -> Result<(), String> {
    let path = meta_path(item_dir);
    let json = serde_json::to_string_pretty(meta).map_err(|e| e.to_string())?;
    fs::write(&path, json).map_err(|e| format!("写 meta.json 失败: {e}"))
}

fn append_index_line(meta: &ResearchMeta) -> Result<(), String> {
    fs::create_dir_all(notes_config_dir()).map_err(|e| e.to_string())?;
    let path = research_index_path();
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| format!("打开 research_index 失败: {e}"))?;
    let line = serde_json::to_string(meta).map_err(|e| e.to_string())?;
    writeln!(f, "{line}").map_err(|e| format!("追加 research_index 失败: {e}"))
}

fn rewrite_index(items: &[ResearchMeta]) -> Result<(), String> {
    fs::create_dir_all(notes_config_dir()).map_err(|e| e.to_string())?;
    let path = research_index_path();
    let tmp = path.with_extension("jsonl.tmp");
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        for m in items {
            let line = serde_json::to_string(m).map_err(|e| e.to_string())?;
            writeln!(f, "{line}").map_err(|e| e.to_string())?;
        }
    }
    fs::rename(&tmp, &path).map_err(|e| format!("写回 research_index 失败: {e}"))
}

fn read_index_lines() -> Result<Vec<ResearchMeta>, String> {
    let path = research_index_path();
    if !path.is_file() {
        return Err("missing".into());
    }
    let f = fs::File::open(&path).map_err(|e| e.to_string())?;
    let reader = BufReader::new(f);
    let mut out = Vec::new();
    for line in reader.lines() {
        let line = line.map_err(|e| e.to_string())?;
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        match serde_json::from_str::<ResearchMeta>(t) {
            Ok(m) => out.push(m),
            Err(_) => return Err("corrupt".into()),
        }
    }
    Ok(out)
}

fn scan_research_metas() -> Vec<ResearchMeta> {
    let root = research_root();
    if !root.is_dir() {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut stack = vec![root];
    while let Some(dir) = stack.pop() {
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for ent in entries.flatten() {
            let path = ent.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.file_name().and_then(|n| n.to_str()) == Some("meta.json") {
                if let Some(m) = read_meta_file(&path) {
                    out.push(m);
                }
            }
        }
    }
    out.sort_by_key(|m| m.collected_at);
    out
}

fn load_or_rebuild_index() -> Vec<ResearchMeta> {
    match read_index_lines() {
        Ok(items) => items,
        Err(_) => {
            let scanned = scan_research_metas();
            let _ = rewrite_index(&scanned);
            scanned
        }
    }
}

fn original_file_in_dir(item_dir: &Path, orig_filename: &str) -> Option<PathBuf> {
    let p = item_dir.join(orig_filename);
    if p.is_file() {
        return Some(p);
    }
    // fallback: first non-meta file
    let entries = fs::read_dir(item_dir).ok()?;
    for ent in entries.flatten() {
        let path = ent.path();
        if !path.is_file() {
            continue;
        }
        if path.file_name().and_then(|n| n.to_str()) == Some("meta.json") {
            continue;
        }
        return Some(path);
    }
    None
}

#[tauri::command]
pub fn notes_research_list() -> Result<Vec<ResearchMeta>, String> {
    Ok(load_or_rebuild_index())
}

#[tauri::command]
pub fn notes_research_get(id: String) -> Result<ResearchMeta, String> {
    let id = id.trim();
    if id.is_empty() {
        return Err("空 id".into());
    }
    let items = load_or_rebuild_index();
    items
        .into_iter()
        .find(|m| m.id == id)
        .ok_or_else(|| format!("未找到资料: {id}"))
}

#[tauri::command]
pub fn notes_research_open(id: String) -> Result<String, String> {
    let meta = notes_research_get(id)?;
    let item_dir = research_root().join(meta.rel_dir.replace('/', std::path::MAIN_SEPARATOR_STR));
    let path = original_file_in_dir(&item_dir, &meta.orig_filename)
        .or_else(|| {
            // rel_dir 损坏时按 collected_at 重算
            let dir = research_item_dir(meta.collected_at, &meta.id);
            original_file_in_dir(&dir, &meta.orig_filename)
        })
        .ok_or_else(|| format!("原文件不存在: {}", meta.orig_filename))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn notes_research_ingest(
    source_path: String,
    title: Option<String>,
    motive: String,
) -> Result<ResearchMeta, String> {
    let src = PathBuf::from(source_path.trim());
    if !src.is_file() {
        return Err(format!("文件不存在: {}", src.display()));
    }
    let collected_at = now_ms();
    let id = new_research_id(collected_at);
    let format = format_from_path(&src);
    let stem = src
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("untitled");
    let title = title
        .map(|t| t.trim().to_string())
        .filter(|t| !t.is_empty())
        .unwrap_or_else(|| stem.to_string());
    let raw_name = src
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let orig_filename = sanitize_filename(raw_name);
    let rel_dir = rel_dir_for(collected_at, &id);
    let item_dir = research_item_dir(collected_at, &id);
    fs::create_dir_all(&item_dir).map_err(|e| format!("创建资料目录失败: {e}"))?;
    let dest = item_dir.join(&orig_filename);
    fs::copy(&src, &dest).map_err(|e| format!("复制资料失败: {e}"))?;

    let meta = ResearchMeta {
        id,
        title,
        format,
        collected_at,
        motive: motive.trim().to_string(),
        orig_filename,
        rel_dir,
    };
    write_meta(&item_dir, &meta)?;
    append_index_line(&meta)?;
    Ok(meta)
}
