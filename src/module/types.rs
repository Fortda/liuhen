//! 统一事件信封与模组元数据。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

/// 稳定模组 ID（文件名、清单、播放器注册表共用）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModuleId {
    /// 鼠标/键盘物理流（现有 .bin）
    Input,
    /// 焦点窗口（现有 win_context jsonl）
    Focus,
    /// 全量窗口地图 / Z-order（规划中）
    WinMap,
    /// 输入法当时可见页 UI 架构（小狼毫侧路）
    Ime,
    /// 浏览器上下文（规划中）
    Browser,
    /// Windows 设置快照 / 变更钩子
    WinSettings,
    /// 机体遥测（网/电/热/计算舱/外设清单）
    Body,
    /// 轻量 TCP/UDP 连接/端口快照（非抓包）
    Network,
}

impl ModuleId {
    pub fn as_str(self) -> &'static str {
        match self {
            ModuleId::Input => "input",
            ModuleId::Focus => "focus",
            ModuleId::WinMap => "win_map",
            ModuleId::Ime => "ime",
            ModuleId::Browser => "browser",
            ModuleId::WinSettings => "win_settings",
            ModuleId::Body => "body",
            ModuleId::Network => "network",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "input" => Some(ModuleId::Input),
            "focus" => Some(ModuleId::Focus),
            "win_map" => Some(ModuleId::WinMap),
            "ime" => Some(ModuleId::Ime),
            "browser" => Some(ModuleId::Browser),
            "win_settings" => Some(ModuleId::WinSettings),
            "body" => Some(ModuleId::Body),
            "network" => Some(ModuleId::Network),
            _ => None,
        }
    }
}

impl std::fmt::Display for ModuleId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// 模组能力位。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ModuleCapability(pub u32);

impl ModuleCapability {
    pub const RECORD: Self = Self(1 << 0);
    pub const PLAYBACK: Self = Self(1 << 1);
    pub const NEEDS_A11Y: Self = Self(1 << 2);
    pub const STUB: Self = Self(1 << 3);

    pub const fn empty() -> Self {
        Self(0)
    }

    pub const fn bits(self) -> u32 {
        self.0
    }

    pub const fn contains(self, other: Self) -> bool {
        self.0 & other.0 == other.0
    }

    pub const fn union(self, other: Self) -> Self {
        Self(self.0 | other.0)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModuleInfo {
    pub id: ModuleId,
    pub name: String,
    pub version: String,
    pub description: String,
    pub capabilities: ModuleCapability,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ModuleStatus {
    Idle,
    Running,
    Degraded,
    Stopped,
    Unavailable,
}

/// 宿主传给模组的只读上下文。
#[derive(Debug, Clone)]
pub struct ModuleContext {
    pub data_root: PathBuf,
    pub started_at_ms: u64,
}

/// 所有模组事件的统一信封（JSONL 一行一个）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModuleEvent {
    pub v: u32,
    pub module: ModuleId,
    pub ts: u64,
    pub kind: String,
    pub payload: serde_json::Value,
}

impl ModuleEvent {
    pub const VERSION: u32 = 1;

    pub fn new(
        module: ModuleId,
        ts: u64,
        kind: impl Into<String>,
        payload: serde_json::Value,
    ) -> Self {
        Self {
            v: Self::VERSION,
            module,
            ts,
            kind: kind.into(),
            payload,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionManifest {
    pub v: u32,
    pub session_started_ms: u64,
    pub data_root: String,
    pub modules: Vec<ManifestModuleEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManifestModuleEntry {
    pub id: String,
    pub name: String,
    pub version: String,
    pub enabled: bool,
    pub status: ModuleStatus,
    pub capabilities: u32,
    pub events_path: Option<String>,
}

impl SessionManifest {
    pub const VERSION: u32 = 1;
}
