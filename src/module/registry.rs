//! 模组注册表：装载、启停、写清单。

use super::types::{
    ManifestModuleEntry, ModuleContext, ModuleId, ModuleStatus, SessionManifest,
};
use super::TraceModule;
use crate::paths::{self, ensure_dir};
use crate::sink::EventSink;
use std::collections::HashMap;
use std::fs;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct ModuleRegistry {
    modules: HashMap<ModuleId, Box<dyn TraceModule>>,
    enabled: Vec<ModuleId>,
    ctx: Option<ModuleContext>,
}

impl ModuleRegistry {
    pub fn new() -> Self {
        Self {
            modules: HashMap::new(),
            enabled: Vec::new(),
            ctx: None,
        }
    }

    pub fn register(&mut self, module: Box<dyn TraceModule>) {
        let id = module.id();
        self.modules.insert(id, module);
    }

    /// 按顺序启用；未注册的 ID 会被跳过并打日志。
    pub fn enable(&mut self, ids: &[ModuleId]) {
        self.enabled.clear();
        for id in ids {
            if self.modules.contains_key(id) {
                self.enabled.push(*id);
            } else {
                eprintln!("[module_host] 跳过未注册模组: {}", id);
            }
        }
    }

    pub fn list_info(&self) -> Vec<crate::module::ModuleInfo> {
        self.modules.values().map(|m| m.info()).collect()
    }

    pub fn start_all(&mut self) -> Result<(), String> {
        let started_at_ms = now_ms();
        let data_root = paths::data_root();
        ensure_dir(&data_root);

        let ctx = ModuleContext {
            data_root: data_root.clone(),
            started_at_ms,
        };

        for id in self.enabled.clone() {
            let sink = EventSink::open(id)?;
            if let Some(m) = self.modules.get_mut(&id) {
                match m.start(&ctx, sink) {
                    Ok(()) => eprintln!("[module_host] 已启动: {} ({})", m.info().name, id),
                    Err(e) => {
                        eprintln!("[module_host] 启动失败 {}: {}", id, e);
                    }
                }
            }
        }

        self.ctx = Some(ctx);
        self.write_manifest()?;
        Ok(())
    }

    /// 对需要轮询的模组调用 tick（宿主主循环用）。
    pub fn tick_all(&mut self) {
        let Some(ctx) = self.ctx.clone() else {
            return;
        };
        for id in self.enabled.clone() {
            let Ok(sink) = EventSink::open(id) else {
                continue;
            };
            if let Some(m) = self.modules.get_mut(&id) {
                if m.tick_interval_ms().is_some() {
                    if let Err(e) = m.tick(&ctx, &sink) {
                        eprintln!("[module_host] tick 失败 {}: {}", id, e);
                    }
                }
            }
        }
    }

    pub fn stop_all(&mut self) {
        for id in self.enabled.clone() {
            if let Some(m) = self.modules.get_mut(&id) {
                let _ = m.stop();
                eprintln!("[module_host] 已停止: {}", id);
            }
        }
        let _ = self.write_manifest();
    }

    fn write_manifest(&self) -> Result<(), String> {
        let started = self
            .ctx
            .as_ref()
            .map(|c| c.started_at_ms)
            .unwrap_or_else(now_ms);

        let mut entries = Vec::new();
        for (id, m) in &self.modules {
            let info = m.info();
            let enabled = self.enabled.contains(id);
            let events_path = if enabled {
                Some(
                    paths::module_events_path_today(id.as_str())
                        .to_string_lossy()
                        .into_owned(),
                )
            } else {
                None
            };
            entries.push(ManifestModuleEntry {
                id: id.as_str().to_string(),
                name: info.name,
                version: info.version,
                enabled,
                status: if enabled {
                    m.status()
                } else {
                    ModuleStatus::Idle
                },
                capabilities: info.capabilities.bits(),
                events_path,
            });
        }

        let manifest = SessionManifest {
            v: SessionManifest::VERSION,
            session_started_ms: started,
            data_root: paths::data_root().to_string_lossy().into_owned(),
            modules: entries,
        };

        ensure_dir(&paths::data_root());
        let path = paths::manifest_path();
        let text = serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?;
        fs::write(&path, text).map_err(|e| format!("写 manifest 失败: {}", e))?;
        eprintln!("[module_host] manifest → {}", path.display());
        Ok(())
    }
}

impl Default for ModuleRegistry {
    fn default() -> Self {
        Self::new()
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
