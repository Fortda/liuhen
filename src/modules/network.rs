//! network：轻量 TCP/UDP 连接快照（变化时写 delta，非抓包）。

use crate::module::{
    ModuleCapability, ModuleContext, ModuleId, ModuleInfo, ModuleStatus, TraceModule,
};
use crate::net_ports::ConnEntry;
use crate::sink::EventSink;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};

/// 宿主主循环 500ms；每 30 tick ≈ 15s 采一次。
const POLL_EVERY_TICKS: u64 = 30;

pub struct NetworkModule {
    status: ModuleStatus,
    tick_n: u64,
    last_keys: BTreeSet<String>,
    proc_cache: HashMap<u32, String>,
}

impl NetworkModule {
    pub fn new() -> Self {
        Self {
            status: ModuleStatus::Idle,
            tick_n: 0,
            last_keys: BTreeSet::new(),
            proc_cache: HashMap::new(),
        }
    }

    fn emit_snapshot(&mut self, sink: &EventSink, reason: &str, rows: &[ConnEntry]) -> Result<(), String> {
        let conns = rows
            .iter()
            .map(|c| conn_json(c, &mut self.proc_cache))
            .collect::<Vec<_>>();
        self.last_keys = rows.iter().map(|c| c.key()).collect();
        sink.emit_kind(
            now_ms(),
            "conn_snapshot",
            json!({
                "reason": reason,
                "count": rows.len(),
                "conns": conns,
            }),
        )
    }

    fn emit_delta(
        &mut self,
        sink: &EventSink,
        added: &[ConnEntry],
        removed_keys: &[String],
        total: usize,
    ) -> Result<(), String> {
        let added_json = added
            .iter()
            .map(|c| conn_json(c, &mut self.proc_cache))
            .collect::<Vec<_>>();
        sink.emit_kind(
            now_ms(),
            "conn_delta",
            json!({
                "added": added_json,
                "removed": removed_keys,
                "total": total,
            }),
        )
    }
}

impl Default for NetworkModule {
    fn default() -> Self {
        Self::new()
    }
}

impl TraceModule for NetworkModule {
    fn info(&self) -> ModuleInfo {
        ModuleInfo {
            id: ModuleId::Network,
            name: "Network connections".into(),
            version: "0.1.0".into(),
            description: "轻量 TCP/UDP 连接快照（~15s 或变化时写 delta，非抓包）".into(),
            capabilities: ModuleCapability::RECORD,
        }
    }

    fn start(&mut self, _ctx: &ModuleContext, sink: EventSink) -> Result<(), String> {
        #[cfg(windows)]
        {
            sink.emit_kind(
                now_ms(),
                "module_hello",
                json!({
                    "mode": "iphelper_snapshot",
                    "poll_s": POLL_EVERY_TICKS / 2,
                    "events": ["conn_snapshot", "conn_delta"]
                }),
            )?;
            let rows = crate::net_ports::snapshot()?;
            self.emit_snapshot(&sink, "startup", &rows)?;
            self.status = ModuleStatus::Running;
            Ok(())
        }
        #[cfg(not(windows))]
        {
            let _ = sink;
            self.status = ModuleStatus::Unavailable;
            Err("network 仅支持 Windows".into())
        }
    }

    fn tick_interval_ms(&self) -> Option<u64> {
        Some(500)
    }

    fn tick(&mut self, _ctx: &ModuleContext, sink: &EventSink) -> Result<(), String> {
        #[cfg(windows)]
        {
            self.tick_n += 1;
            if self.tick_n % POLL_EVERY_TICKS != 0 {
                return Ok(());
            }
            let rows = crate::net_ports::snapshot()?;
            let new_keys: BTreeSet<String> = rows.iter().map(|c| c.key()).collect();
            if new_keys == self.last_keys {
                return Ok(());
            }
            let mut removed: Vec<String> = self
                .last_keys
                .difference(&new_keys)
                .cloned()
                .collect();
            let added: Vec<ConnEntry> = rows
                .iter()
                .filter(|c| !self.last_keys.contains(&c.key()))
                .cloned()
                .collect();
            removed.sort();
            self.emit_delta(sink, &added, &removed, rows.len())?;
            self.last_keys = new_keys;
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
        self.last_keys.clear();
        self.proc_cache.clear();
        Ok(())
    }

    fn status(&self) -> ModuleStatus {
        self.status
    }
}

fn conn_json(c: &ConnEntry, proc_cache: &mut HashMap<u32, String>) -> Value {
    let mut obj = serde_json::Map::new();
    obj.insert("p".into(), json!(c.proto));
    obj.insert("l".into(), json!(c.local));
    if !c.remote.is_empty() {
        obj.insert("r".into(), json!(c.remote));
    }
    if !c.state.is_empty() {
        obj.insert("s".into(), json!(c.state));
    }
    if c.pid != 0 {
        obj.insert("pid".into(), json!(c.pid));
        let name = proc_cache
            .entry(c.pid)
            .or_insert_with(|| crate::win_enum::process_exe(c.pid))
            .clone();
        if !name.is_empty() {
            obj.insert("pn".into(), json!(name));
        }
    }
    Value::Object(obj)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
