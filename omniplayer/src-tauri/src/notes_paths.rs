//! 笔记卡片 / 协议日志路径：OmniDatabase/notes/cards|logs/Century/Year/Month/Day/

use chrono::{Datelike, TimeZone, Utc};
use std::path::PathBuf;

use crate::resolve_data_root;

pub const NOTES_CONFIG_DIR: &str = "config";
pub const NOTES_CARDS_DIR: &str = "cards";
pub const NOTES_LOGS_DIR: &str = "logs";
pub const NOTES_ATTACHMENTS_DIR: &str = "attachments";
pub const NOTES_RESEARCH_DIR: &str = "research";

#[derive(Clone, Debug)]
pub struct NotesDayPaths {
    pub century: i32,
    pub year: i32,
    pub month: u32,
    pub day: u32,
    pub cards_dir: PathBuf,
    pub logs_dir: PathBuf,
}

pub fn notes_root() -> PathBuf {
    resolve_data_root().join("notes")
}

pub fn notes_config_dir() -> PathBuf {
    notes_root().join(NOTES_CONFIG_DIR)
}

pub fn providers_config_path() -> PathBuf {
    notes_config_dir().join("providers.json")
}

pub fn pricing_config_path() -> PathBuf {
    notes_config_dir().join("pricing.json")
}

pub fn litellm_config_path() -> PathBuf {
    notes_config_dir().join("litellm_config.yaml")
}

pub fn litellm_settings_path() -> PathBuf {
    notes_config_dir().join("litellm_settings.json")
}

/// LiteLLM sidecar 是否走本机 HTTP 代理（Clash mixed-port 等）。
pub fn sidecar_network_path() -> PathBuf {
    notes_config_dir().join("network.json")
}

fn century_for_year(year: i32) -> i32 {
    (year / 100) + 1
}

pub fn calendar_segment(year: i32, month: u32, day: u32) -> PathBuf {
    PathBuf::from(format!("Century_{:08}", century_for_year(year)))
        .join(format!("Year_{:04}", year))
        .join(format!("Month_{:02}", month))
        .join(format!("Day_{:02}", day))
}

pub fn research_root() -> PathBuf {
    notes_root().join(NOTES_RESEARCH_DIR)
}

pub fn research_index_path() -> PathBuf {
    notes_config_dir().join("research_index.jsonl")
}

/// `OmniDatabase/notes/research/Century_…/Day_DD/<id>/`
pub fn research_item_dir(ts_ms: u64, id: &str) -> PathBuf {
    let dt = Utc
        .timestamp_millis_opt(ts_ms as i64)
        .single()
        .unwrap_or_else(Utc::now);
    let seg = calendar_segment(dt.year(), dt.month(), dt.day());
    research_root().join(seg).join(id)
}

pub fn day_paths_for_ms(ts_ms: u64) -> NotesDayPaths {
    let dt = Utc
        .timestamp_millis_opt(ts_ms as i64)
        .single()
        .unwrap_or_else(Utc::now);
    let year = dt.year();
    let month = dt.month();
    let day = dt.day();
    let seg = calendar_segment(year, month, day);
    let root = notes_root();
    NotesDayPaths {
        century: century_for_year(year),
        year,
        month,
        day,
        cards_dir: root.join(NOTES_CARDS_DIR).join(&seg),
        logs_dir: root.join(NOTES_LOGS_DIR).join(&seg),
    }
}

pub fn card_file_path(ts_ms: u64, card_id: &str) -> PathBuf {
    day_paths_for_ms(ts_ms)
        .cards_dir
        .join(format!("{card_id}.json"))
}

pub fn card_attachments_dir(ts_ms: u64, card_id: &str) -> PathBuf {
    let dp = day_paths_for_ms(ts_ms);
    let seg = calendar_segment(dp.year, dp.month, dp.day);
    notes_root()
        .join(NOTES_ATTACHMENTS_DIR)
        .join(seg)
        .join(card_id)
}

pub fn context_graph_path() -> PathBuf {
    notes_config_dir().join("context_graph.json")
}

pub fn wire_presets_path() -> PathBuf {
    notes_config_dir().join("wire_presets.json")
}

pub fn clue_board_path() -> PathBuf {
    notes_config_dir().join("clue_board.json")
}

pub fn clue_boards_path() -> PathBuf {
    notes_config_dir().join("clue_boards.json")
}

/// Image bytes for clue-board nodes. JSON stores only `clue_images/<file>`.
pub fn clue_images_dir() -> PathBuf {
    notes_config_dir().join("clue_images")
}

/// Per-board append-only history: `notes/config/clue_history/<board_id>.jsonl`
pub fn clue_history_dir() -> PathBuf {
    notes_config_dir().join("clue_history")
}

pub fn clue_history_path(board_id: &str) -> PathBuf {
    let safe: String = board_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let safe = if safe.is_empty() {
        "board".to_string()
    } else if safe.len() > 128 {
        safe.chars().take(128).collect()
    } else {
        safe
    };
    clue_history_dir().join(format!("{safe}.jsonl"))
}

pub fn log_file_path(ts_ms: u64, card_id: &str) -> PathBuf {
    day_paths_for_ms(ts_ms)
        .logs_dir
        .join(format!("{card_id}.log.jsonl"))
}

pub fn new_card_id(ts_ms: u64) -> String {
    let n = (ts_ms ^ (ts_ms >> 12)) & 0xffff;
    format!("card_{ts_ms}_{n:04x}")
}

pub fn ensure_notes_dirs(ts_ms: u64) -> std::io::Result<NotesDayPaths> {
    let paths = day_paths_for_ms(ts_ms);
    std::fs::create_dir_all(&paths.cards_dir)?;
    std::fs::create_dir_all(&paths.logs_dir)?;
    std::fs::create_dir_all(notes_config_dir())?;
    Ok(paths)
}
