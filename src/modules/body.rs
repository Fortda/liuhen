//! body：机体遥测模组。宿主 tick 只 drain 采样线程队列。

use crate::module::{
    ModuleCapability, ModuleContext, ModuleId, ModuleInfo, ModuleStatus, TraceModule,
};
use crate::sink::EventSink;

pub struct BodyModule {
    status: ModuleStatus,
    #[cfg(windows)]
    runtime: Option<crate::body::BodyRuntime>,
}

impl BodyModule {
    pub fn new() -> Self {
        Self {
            status: ModuleStatus::Idle,
            #[cfg(windows)]
            runtime: None,
        }
    }
}

impl Default for BodyModule {
    fn default() -> Self {
        Self::new()
    }
}

impl TraceModule for BodyModule {
    fn info(&self) -> ModuleInfo {
        ModuleInfo {
            id: ModuleId::Body,
            name: "Body telemetry".into(),
            version: "0.1.0".into(),
            description: "巡视器机体遥测：网/电/热/计算舱/外设清单（JSONL，不渲染）".into(),
            capabilities: ModuleCapability::RECORD,
        }
    }

    fn start(&mut self, _ctx: &ModuleContext, sink: EventSink) -> Result<(), String> {
        #[cfg(windows)]
        {
            let rt = crate::body::BodyRuntime::start()?;
            self.runtime = Some(rt);
            let _ = sink;
            self.status = ModuleStatus::Running;
            Ok(())
        }
        #[cfg(not(windows))]
        {
            let _ = sink;
            self.status = ModuleStatus::Unavailable;
            Err("body 仅支持 Windows".into())
        }
    }

    fn tick_interval_ms(&self) -> Option<u64> {
        Some(500)
    }

    fn tick(&mut self, _ctx: &ModuleContext, sink: &EventSink) -> Result<(), String> {
        #[cfg(windows)]
        {
            if let Some(rt) = self.runtime.as_ref() {
                for ev in rt.drain() {
                    sink.emit_kind(ev.ts, &ev.kind, ev.payload)?;
                }
            }
            Ok(())
        }
        #[cfg(not(windows))]
        {
            let _ = sink;
            Ok(())
        }
    }

    fn stop(&mut self) -> Result<(), String> {
        #[cfg(windows)]
        {
            self.runtime = None;
        }
        self.status = ModuleStatus::Stopped;
        Ok(())
    }

    fn status(&self) -> ModuleStatus {
        self.status
    }
}
