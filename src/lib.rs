//! OmniTrace 核心库：进程内插件（像游戏 mod），不是多开几个 exe。
//!
//! - 一个宿主进程里挂多个插件（input / focus / 以后 win_map…）
//! - 共享同一套 UTC 毫秒时钟
//! - 键鼠：零假设压缩 bin；窗口等：各自文件，但同进程同生命周期

pub mod bin_host;
pub mod body;
pub mod capture;
pub mod health;
pub mod module;
pub mod modules;
pub mod net_ports;
pub mod paths;
pub mod sink;

#[cfg(windows)]
pub mod lifecycle;

#[cfg(windows)]
pub mod win_enum;

#[cfg(windows)]
pub mod win_move_hook;

#[cfg(windows)]
pub mod win_state_hook;

#[cfg(windows)]
pub mod shell;

#[cfg(windows)]
pub mod win_settings;

pub use module::{
    ManifestModuleEntry, ModuleCapability, ModuleContext, ModuleEvent, ModuleId, ModuleInfo,
    ModuleRegistry, ModuleStatus, SessionManifest, TraceModule,
};
