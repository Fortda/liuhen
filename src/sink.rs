//! 统一事件写出：每模组一天一个 JSONL。

use crate::module::{ModuleEvent, ModuleId};
use crate::paths::{ensure_dir, module_data_dir, module_events_path_today};
use std::fs::OpenOptions;
use std::io::Write;
use std::sync::{Arc, Mutex};

#[derive(Clone)]
pub struct EventSink {
    module: ModuleId,
    inner: Arc<Mutex<SinkInner>>,
}

struct SinkInner {
    day: u32,
    file: std::fs::File,
}

impl EventSink {
    pub fn open(module: ModuleId) -> Result<Self, String> {
        let path = module_events_path_today(module.as_str());
        ensure_dir(&module_data_dir(module.as_str()));
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| format!("打开事件文件失败 {}: {}", path.display(), e))?;
        Ok(Self {
            module,
            inner: Arc::new(Mutex::new(SinkInner {
                day: crate::paths::today_day(),
                file,
            })),
        })
    }

    pub fn emit(&self, event: ModuleEvent) -> Result<(), String> {
        if event.module != self.module {
            return Err(format!(
                "事件模组 {} 与 sink {} 不匹配",
                event.module, self.module
            ));
        }
        let line = serde_json::to_string(&event).map_err(|e| e.to_string())?;
        let mut guard = self.inner.lock().map_err(|_| "sink lock poisoned")?;

        let today = crate::paths::today_day();
        if today != guard.day {
            let path = module_events_path_today(self.module.as_str());
            ensure_dir(&module_data_dir(self.module.as_str()));
            guard.file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .map_err(|e| e.to_string())?;
            guard.day = today;
        }

        writeln!(guard.file, "{}", line).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn emit_kind(
        &self,
        ts: u64,
        kind: &str,
        payload: serde_json::Value,
    ) -> Result<(), String> {
        self.emit(ModuleEvent::new(self.module, ts, kind, payload))
    }
}
