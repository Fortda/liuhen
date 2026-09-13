//! 所有采集插件实现此 trait（游戏 mod 式：链进同一进程，共享时钟与生命周期）。
//!
//! 不是「再开一个软件」。`ModuleRegistry` 只是进程内的插件名册。

mod registry;
mod types;

pub use registry::ModuleRegistry;
pub use types::{
    ManifestModuleEntry, ModuleCapability, ModuleContext, ModuleEvent, ModuleId, ModuleInfo,
    ModuleStatus, SessionManifest,
};

use crate::sink::EventSink;

/// 采集插件合同。
pub trait TraceModule: Send {
    fn info(&self) -> ModuleInfo;

    fn id(&self) -> ModuleId {
        self.info().id
    }

    /// 在宿主进程内启动（可自己开钩子线程）。
    fn start(&mut self, ctx: &ModuleContext, sink: EventSink) -> Result<(), String>;

    /// 仅轮询型插件需要；钩子型返回 `tick_interval_ms = None`。
    fn tick(&mut self, _ctx: &ModuleContext, _sink: &EventSink) -> Result<(), String> {
        Ok(())
    }

    fn tick_interval_ms(&self) -> Option<u64> {
        None
    }

    fn stop(&mut self) -> Result<(), String> {
        Ok(())
    }

    fn status(&self) -> ModuleStatus {
        ModuleStatus::Idle
    }
}
