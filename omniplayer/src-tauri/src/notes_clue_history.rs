//! Durable per-board clue history (append-only JSONL) + restore-from-snapshot rollback.

use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::notes_ctl::{
    ClueBoard, ClueBoardEdge, ClueBoardNode, ClueBoardView, ClueBoardsFile,
};
use crate::notes_paths::{clue_history_dir, clue_history_path};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClueHistorySnapshot {
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub nodes: Vec<ClueBoardNode>,
    #[serde(default)]
    pub edges: Vec<ClueBoardEdge>,
    #[serde(default)]
    pub view: Option<ClueBoardView>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClueHistoryEntry {
    pub v: u32,
    pub seq: u64,
    pub ts: u64,
    /// `human` | `ai`
    pub actor: String,
    /// e.g. initial / add_node / edit_text / rollback / create_board
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rollback_to_seq: Option<u64>,
    pub snapshot: ClueHistorySnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClueHistoryList {
    pub board_id: String,
    pub path: String,
    pub entries: Vec<ClueHistoryEntry>,
    pub current_seq: Option<u64>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn file_mtime_ms_opt(path: &PathBuf) -> Option<u64> {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .filter(|t| *t > 0)
}

/// First/last history `ts` by seq. Missing or empty file → (None, None). Never invents now.
pub fn history_ts_range(board_id: &str) -> (Option<u64>, Option<u64>) {
    let mut entries = load_entries(board_id).unwrap_or_default();
    entries.retain(|e| e.ts > 0);
    if entries.is_empty() {
        return (None, None);
    }
    entries.sort_by_key(|e| e.seq);
    (
        entries.first().map(|e| e.ts),
        entries.last().map(|e| e.ts),
    )
}

/// Fill 0 timestamps from: history first/last seq ts → history file mtime → boards file mtime.
/// Does not use wall-clock now.
pub fn seed_board_timestamps(board: &mut ClueBoard, boards_mtime: Option<u64>) {
    if board.created_at > 0 && board.updated_at > 0 {
        return;
    }
    let (first, last) = history_ts_range(&board.id);
    let hist_mtime = file_mtime_ms_opt(&clue_history_path(&board.id));
    if board.created_at == 0 {
        board.created_at = first.or(hist_mtime).or(boards_mtime).unwrap_or(0);
    }
    if board.updated_at == 0 {
        board.updated_at = last.or(hist_mtime).or(boards_mtime).unwrap_or(board.created_at);
    }
}

fn ensure_history_dir() -> Result<(), String> {
    fs::create_dir_all(clue_history_dir()).map_err(|e| e.to_string())
}

pub fn snapshot_from_board(board: &ClueBoard) -> ClueHistorySnapshot {
    ClueHistorySnapshot {
        title: board.title.clone(),
        nodes: board.nodes.clone(),
        edges: board.edges.clone(),
        view: board.view.clone(),
    }
}

pub fn apply_snapshot_to_board(board: &mut ClueBoard, snap: &ClueHistorySnapshot) {
    board.title = snap.title.clone();
    board.nodes = snap.nodes.clone();
    board.edges = snap.edges.clone();
    board.view = snap.view.clone();
}

pub fn load_entries(board_id: &str) -> Result<Vec<ClueHistoryEntry>, String> {
    let path = clue_history_path(board_id);
    if !path.exists() {
        return Ok(vec![]);
    }
    let raw = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for line in raw.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        match serde_json::from_str::<ClueHistoryEntry>(line) {
            Ok(e) => out.push(e),
            Err(_) => continue,
        }
    }
    Ok(out)
}

fn next_seq(entries: &[ClueHistoryEntry]) -> u64 {
    entries.iter().map(|e| e.seq).max().unwrap_or(0).saturating_add(1)
}

fn append_line(path: &PathBuf, entry: &ClueHistoryEntry) -> Result<(), String> {
    ensure_history_dir()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    let line = serde_json::to_string(entry).map_err(|e| e.to_string())?;
    f.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
    f.write_all(b"\n").map_err(|e| e.to_string())?;
    f.flush().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn append_entry(
    board_id: &str,
    actor: &str,
    action: &str,
    tool: Option<&str>,
    label_key: Option<&str>,
    rollback_to_seq: Option<u64>,
    snapshot: ClueHistorySnapshot,
) -> Result<ClueHistoryEntry, String> {
    let bid = board_id.trim();
    if bid.is_empty() {
        return Err("缺少 board_id".into());
    }
    let actor = match actor.trim() {
        "ai" | "mcp" => "ai",
        _ => "human",
    };
    let action = action.trim();
    if action.is_empty() {
        return Err("缺少 action".into());
    }
    let entries = load_entries(bid)?;
    let entry = ClueHistoryEntry {
        v: 1,
        seq: next_seq(&entries),
        ts: now_ms(),
        actor: actor.to_string(),
        action: action.to_string(),
        tool: tool.map(|s| s.to_string()).filter(|s| !s.is_empty()),
        label_key: label_key.map(|s| s.to_string()).filter(|s| !s.is_empty()),
        rollback_to_seq,
        snapshot,
    };
    append_line(&clue_history_path(bid), &entry)?;
    Ok(entry)
}

pub fn append_from_board(
    board: &ClueBoard,
    actor: &str,
    action: &str,
    tool: Option<&str>,
    label_key: Option<&str>,
    rollback_to_seq: Option<u64>,
) -> Result<ClueHistoryEntry, String> {
    append_entry(
        &board.id,
        actor,
        action,
        tool,
        label_key,
        rollback_to_seq,
        snapshot_from_board(board),
    )
}

/// If the board has no history file yet, seed an `initial` snapshot (actor=human).
pub fn ensure_seeded(board: &ClueBoard) -> Result<Vec<ClueHistoryEntry>, String> {
    let mut entries = load_entries(&board.id)?;
    if entries.is_empty() {
        let e = append_from_board(
            board,
            "human",
            "initial",
            Some("ui"),
            Some("notes.clue.history.initial"),
            None,
        )?;
        entries.push(e);
    }
    Ok(entries)
}

pub fn delete_history(board_id: &str) -> Result<(), String> {
    let path = clue_history_path(board_id.trim());
    if path.exists() {
        fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn board_id_from_history_filename(name: &str) -> Option<String> {
    let name = name.trim();
    if !name.starts_with("board_") || !name.ends_with(".jsonl") {
        return None;
    }
    let id = name.trim_end_matches(".jsonl");
    if id.is_empty() || id.len() > 128 {
        return None;
    }
    Some(id.to_string())
}

/// Latest snapshot in that board's history file, or None if missing/empty.
pub fn board_from_latest_history(board_id: &str) -> Option<ClueBoard> {
    let entries = load_entries(board_id).ok()?;
    if entries.is_empty() {
        return None;
    }
    let first_ts = entries.iter().map(|e| e.ts).filter(|t| *t > 0).min().unwrap_or(0);
    let last = entries.last()?;
    Some(ClueBoard {
        id: board_id.trim().to_string(),
        title: last.snapshot.title.clone(),
        nodes: last.snapshot.nodes.clone(),
        edges: last.snapshot.edges.clone(),
        view: last.snapshot.view.clone(),
        created_at: first_ts,
        updated_at: last.ts,
    })
}

/// Boards that still have history files but are missing from the registry.
/// Used to recover after a stale full-file save collapsed `clue_boards.json`.
pub fn orphan_boards_from_history(present_ids: &BTreeSet<String>) -> Vec<ClueBoard> {
    let dir = clue_history_dir();
    let rd = match fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(_) => return vec![],
    };
    let mut out = Vec::new();
    for ent in rd.flatten() {
        let name = ent.file_name().to_string_lossy().to_string();
        let Some(id) = board_id_from_history_filename(&name) else {
            continue;
        };
        if present_ids.contains(&id) {
            continue;
        }
        if let Some(board) = board_from_latest_history(&id) {
            out.push(board);
        }
    }
    out
}

/// Insert history-only boards into `data`. Returns how many were added.
pub fn merge_history_orphans(data: &mut ClueBoardsFile) -> usize {
    let present: BTreeSet<String> = data.boards.iter().map(|b| b.id.clone()).collect();
    let orphans = orphan_boards_from_history(&present);
    let n = orphans.len();
    for b in orphans {
        data.boards.push(b);
    }
    n
}

pub fn list_history(board_id: &str) -> Result<ClueHistoryList, String> {
    let bid = board_id.trim().to_string();
    if bid.is_empty() {
        return Err("缺少 board_id".into());
    }
    let entries = load_entries(&bid)?;
    let current_seq = entries.last().map(|e| e.seq);
    Ok(ClueHistoryList {
        board_id: bid.clone(),
        path: clue_history_path(&bid).to_string_lossy().to_string(),
        entries,
        current_seq,
    })
}

/// Restore board content from a prior history seq (full snapshot), then append a
/// new `rollback` entry so the audit log stays chronological and restart-safe.
pub fn rollback_to_seq(
    board_id: &str,
    target_seq: u64,
    actor: &str,
    tool: Option<&str>,
) -> Result<(ClueBoardsFile, ClueHistoryEntry), String> {
    let bid = board_id.trim();
    if bid.is_empty() {
        return Err("缺少 board_id".into());
    }
    let entries = load_entries(bid)?;
    let target = entries
        .iter()
        .find(|e| e.seq == target_seq)
        .ok_or_else(|| format!("history seq not found: {target_seq}"))?;
    if let Some(last) = entries.last() {
        if last.seq == target_seq {
            // Already at this version — still return current boards without duplicating.
            let data = crate::notes_ctl::notes_clue_board_load_internal()?;
            return Ok((data, last.clone()));
        }
    }
    let snap = target.snapshot.clone();
    crate::notes_ctl::with_clue_boards(|data| {
        if let Some(board) = data.boards.iter_mut().find(|b| b.id == bid) {
            apply_snapshot_to_board(board, &snap);
        } else {
            data.boards.push(ClueBoard {
                id: bid.to_string(),
                title: snap.title.clone(),
                nodes: snap.nodes.clone(),
                edges: snap.edges.clone(),
                view: snap.view.clone(),
                created_at: target.ts,
                updated_at: now_ms(),
            });
        }
        Ok(())
    })?;
    let entry = append_entry(
        bid,
        actor,
        "rollback",
        tool.or(Some("clue_board_rollback")),
        Some("notes.clue.history.rollback"),
        Some(target_seq),
        snap,
    )?;
    let data = crate::notes_ctl::notes_clue_board_load_internal()?;
    Ok((data, entry))
}

#[derive(Debug, Deserialize)]
pub struct HistoryRecordArgs {
    pub board_id: String,
    pub actor: String,
    pub action: String,
    #[serde(default)]
    pub tool: Option<String>,
    #[serde(default)]
    pub label_key: Option<String>,
    pub snapshot: ClueHistorySnapshot,
}

#[tauri::command]
pub fn notes_clue_history_list(board_id: String) -> Result<ClueHistoryList, String> {
    list_history(&board_id)
}

#[tauri::command]
pub fn notes_clue_history_record(args: HistoryRecordArgs) -> Result<ClueHistoryEntry, String> {
    append_entry(
        &args.board_id,
        &args.actor,
        &args.action,
        args.tool.as_deref(),
        args.label_key.as_deref(),
        None,
        args.snapshot,
    )
}

#[tauri::command]
pub fn notes_clue_history_rollback(
    board_id: String,
    seq: u64,
    actor: Option<String>,
) -> Result<serde_json::Value, String> {
    let actor = actor.as_deref().unwrap_or("human");
    let (data, entry) = rollback_to_seq(&board_id, seq, actor, Some("ui"))?;
    Ok(json!({
        "boards": data,
        "entry": entry,
    }))
}

#[tauri::command]
pub fn notes_clue_history_ensure(board_id: String) -> Result<ClueHistoryList, String> {
    let data = crate::notes_ctl::notes_clue_board_load_internal()?;
    let board = data
        .boards
        .iter()
        .find(|b| b.id == board_id.trim())
        .ok_or_else(|| format!("board not found: {board_id}"))?;
    ensure_seeded(board)?;
    list_history(&board_id)
}

#[tauri::command]
pub fn notes_clue_history_delete(board_id: String) -> Result<(), String> {
    delete_history(&board_id)
}
