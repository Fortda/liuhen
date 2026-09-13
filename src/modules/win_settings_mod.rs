//! win_settings：Windows 设置启动全量快照 + 变更钩子。

use crate::module::{
    ModuleCapability, ModuleContext, ModuleId, ModuleInfo, ModuleStatus, TraceModule,
};
use crate::sink::EventSink;
use serde_json::json;
use std::collections::BTreeMap;

pub struct WinSettingsModule {
    status: ModuleStatus,
    last_sigs: BTreeMap<String, String>,
    tick_n: u64,
}

impl WinSettingsModule {
    pub fn new() -> Self {
        Self {
            status: ModuleStatus::Idle,
            last_sigs: BTreeMap::new(),
            tick_n: 0,
        }
    }
}

impl Default for WinSettingsModule {
    fn default() -> Self {
        Self::new()
    }
}

impl TraceModule for WinSettingsModule {
    fn info(&self) -> ModuleInfo {
        ModuleInfo {
            id: ModuleId::WinSettings,
            name: "Windows settings hooks".into(),
            version: "0.1.0".into(),
            description: "启动扫描 Win 设置；个性化/显示等变更时写日志（可扩展探针）"
                .into(),
            capabilities: ModuleCapability::RECORD,
        }
    }

    fn start(&mut self, _ctx: &ModuleContext, sink: EventSink) -> Result<(), String> {
        #[cfg(windows)]
        {
            let all = crate::win_settings::snapshot_all();
            let mut settings = json!({});
            let obj = settings.as_object_mut().unwrap();
            self.last_sigs.clear();
            for (id, (sig, payload)) in &all {
                self.last_sigs.insert(id.clone(), sig.clone());
                obj.insert(id.clone(), payload.clone());
            }
            sink.emit_kind(
                now_ms(),
                "settings_snapshot",
                json!({
                    "reason": "startup",
                    "probe_count": all.len(),
                    "settings": settings
                }),
            )?;
            self.status = ModuleStatus::Running;
            Ok(())
        }
        #[cfg(not(windows))]
        {
            let _ = sink;
            self.status = ModuleStatus::Unavailable;
            Err("win_settings 仅支持 Windows".into())
        }
    }

    fn tick_interval_ms(&self) -> Option<u64> {
        Some(2000)
    }

    fn tick(&mut self, _ctx: &ModuleContext, sink: &EventSink) -> Result<(), String> {
        #[cfg(windows)]
        {
            self.tick_n += 1;
            let all = crate::win_settings::snapshot_all();
            for (id, (sig, payload)) in all {
                let prev = self.last_sigs.get(&id).cloned();
                if prev.as_deref() != Some(sig.as_str()) {
                    self.last_sigs.insert(id.clone(), sig.clone());
                    sink.emit_kind(
                        now_ms(),
                        "settings_change",
                        json!({
                            "id": id,
                            "group": payload.get("group"),
                            "prev_sig": prev,
                            "sig": sig,
                            "data": payload.get("data"),
                            "reason": "changed"
                        }),
                    )?;
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
