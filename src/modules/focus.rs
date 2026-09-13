//! focus：焦点窗变化（SetWinEventHook / EVENT_SYSTEM_FOREGROUND，与 win_state 共用演绎线程）。

use crate::module::{
    ModuleCapability, ModuleContext, ModuleId, ModuleInfo, ModuleStatus, TraceModule,
};
use crate::sink::EventSink;
use serde_json::json;

pub struct FocusModule {
    status: ModuleStatus,
    retained: bool,
}

impl FocusModule {
    pub fn new() -> Self {
        Self {
            status: ModuleStatus::Idle,
            retained: false,
        }
    }
}

impl Default for FocusModule {
    fn default() -> Self {
        Self::new()
    }
}

impl TraceModule for FocusModule {
    fn info(&self) -> ModuleInfo {
        ModuleInfo {
            id: ModuleId::Focus,
            name: "Focus window".into(),
            version: "0.3.0".into(),
            description: "钩子演绎焦点窗 app/title/bounds（非轮询）".into(),
            capabilities: ModuleCapability::RECORD.union(ModuleCapability::PLAYBACK),
        }
    }

    fn start(&mut self, _ctx: &ModuleContext, sink: EventSink) -> Result<(), String> {
        sink.emit_kind(
            now_ms(),
            "module_hello",
            json!({
                "mode": "winevent_hook",
                "events": ["EVENT_SYSTEM_FOREGROUND"]
            }),
        )?;
        #[cfg(windows)]
        {
            crate::win_state_hook::retain(Some(sink), None)?;
            self.retained = true;
        }
        #[cfg(not(windows))]
        {
            let _ = sink;
            self.status = ModuleStatus::Unavailable;
            return Err("focus 钩子仅支持 Windows".into());
        }
        self.status = ModuleStatus::Running;
        Ok(())
    }

    fn tick_interval_ms(&self) -> Option<u64> {
        None
    }

    fn stop(&mut self) -> Result<(), String> {
        #[cfg(windows)]
        if self.retained {
            crate::win_state_hook::release();
            self.retained = false;
        }
        self.status = ModuleStatus::Stopped;
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
