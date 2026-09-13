//! input 插件：进程内启动键鼠钩子，写压缩 .bin（与旧协议兼容）。

use crate::capture::input_bin;
use crate::module::{
    ModuleCapability, ModuleContext, ModuleId, ModuleInfo, ModuleStatus, TraceModule,
};
use crate::sink::EventSink;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct InputModule {
    status: ModuleStatus,
    running: Arc<AtomicBool>,
}

impl InputModule {
    pub fn new() -> Self {
        Self {
            status: ModuleStatus::Idle,
            running: Arc::new(AtomicBool::new(false)),
        }
    }
}

impl Default for InputModule {
    fn default() -> Self {
        Self::new()
    }
}

impl TraceModule for InputModule {
    fn info(&self) -> ModuleInfo {
        ModuleInfo {
            id: ModuleId::Input,
            name: "Input (mouse/keyboard)".into(),
            version: "0.3.0".into(),
            description: "全局钩子 + 相对压缩 bin；与 focus 同进程融合运行".into(),
            capabilities: ModuleCapability::RECORD.union(ModuleCapability::PLAYBACK),
        }
    }

    fn start(&mut self, _ctx: &ModuleContext, sink: EventSink) -> Result<(), String> {
        if self.running.load(Ordering::SeqCst) {
            return Ok(());
        }
        self.running.store(true, Ordering::SeqCst);
        input_bin::spawn_input_capture(self.running.clone())?;
        sink.emit_kind(
            now_ms(),
            "module_hello",
            json!({
                "stream": "OmniDatabase/EventData/.../trace_DD.bin",
                "format": "compressed_bin_v3",
                "fused": true
            }),
        )?;
        self.status = ModuleStatus::Running;
        Ok(())
    }

    fn tick_interval_ms(&self) -> Option<u64> {
        None
    }

    fn stop(&mut self) -> Result<(), String> {
        self.running.store(false, Ordering::SeqCst);
        self.status = ModuleStatus::Stopped;
        Ok(())
    }

    fn status(&self) -> ModuleStatus {
        self.status
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
