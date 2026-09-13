//! browser：浏览器上下文（骨架）。

use crate::module::{
    ModuleCapability, ModuleContext, ModuleId, ModuleInfo, ModuleStatus, TraceModule,
};
use crate::sink::EventSink;
use serde_json::json;

pub struct BrowserModule {
    status: ModuleStatus,
}

impl BrowserModule {
    pub fn new() -> Self {
        Self {
            status: ModuleStatus::Idle,
        }
    }
}

impl Default for BrowserModule {
    fn default() -> Self {
        Self::new()
    }
}

impl TraceModule for BrowserModule {
    fn info(&self) -> ModuleInfo {
        ModuleInfo {
            id: ModuleId::Browser,
            name: "Browser".into(),
            version: "0.0.0".into(),
            description: "标题/URL/粗结构等；未实现".into(),
            capabilities: ModuleCapability::RECORD
                .union(ModuleCapability::PLAYBACK)
                .union(ModuleCapability::STUB),
        }
    }

    fn start(&mut self, _ctx: &ModuleContext, sink: EventSink) -> Result<(), String> {
        sink.emit_kind(
            now_ms(),
            "module_hello",
            json!({
                "implemented": false,
                "planned_kinds": ["nav", "title", "url"]
            }),
        )?;
        self.status = ModuleStatus::Unavailable;
        Ok(())
    }

    fn status(&self) -> ModuleStatus {
        self.status
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
