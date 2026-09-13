//! ime：小狼毫侧路写入的组字/候选/上屏 JSONL；本模组负责开录时声明数据根并记账。
//! 候选窗内容由旁边 weasel-omni-probe 补丁写出，不把小狼毫链进本进程。

use crate::module::{
    ModuleCapability, ModuleContext, ModuleId, ModuleInfo, ModuleStatus, TraceModule,
};
use crate::sink::EventSink;
use serde_json::json;
use std::process::Command;

pub struct ImeModule {
    status: ModuleStatus,
}

impl ImeModule {
    pub fn new() -> Self {
        Self {
            status: ModuleStatus::Idle,
        }
    }
}

impl Default for ImeModule {
    fn default() -> Self {
        Self::new()
    }
}

fn weasel_running() -> bool {
    let out = Command::new("tasklist")
        .args(["/FI", "IMAGENAME eq WeaselServer.exe", "/NH"])
        .output()
        .ok();
    out.map(|o| {
        String::from_utf8_lossy(&o.stdout)
            .to_ascii_lowercase()
            .contains("weaselserver.exe")
    })
    .unwrap_or(false)
}

impl TraceModule for ImeModule {
    fn info(&self) -> ModuleInfo {
        ModuleInfo {
            id: ModuleId::Ime,
            name: "IME".into(),
            version: "0.1.0".into(),
            description: "小狼毫当时可见页 UI 架构（组字/候选/上屏）；需侧路补丁"
                .into(),
            capabilities: ModuleCapability::RECORD.union(ModuleCapability::PLAYBACK),
        }
    }

    fn start(&mut self, ctx: &ModuleContext, sink: EventSink) -> Result<(), String> {
        crate::paths::write_data_root_pointer();
        let probe = weasel_running();
        sink.emit_kind(
            now_ms(),
            "module_hello",
            json!({
                "implemented": true,
                "kinds": ["compose_update", "commit"],
                "writer": "weasel-omni-probe",
                "data_root": ctx.data_root.to_string_lossy(),
                "weasel_server": probe,
            }),
        )?;
        self.status = if probe {
            ModuleStatus::Running
        } else {
            ModuleStatus::Degraded
        };
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
