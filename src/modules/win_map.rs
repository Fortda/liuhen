//! win_map：窗口叠层（钩子演绎）+ 显示器/壁纸/任务栏 + 移动轨迹钩子。

use crate::module::{
    ModuleCapability, ModuleContext, ModuleId, ModuleInfo, ModuleStatus, TraceModule,
};
use crate::sink::EventSink;
use serde_json::json;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;

pub struct WinMapModule {
    status: ModuleStatus,
    last_wallpaper: String,
    last_taskbar_sig: String,
    last_ymd: i32,
    tick_n: u64,
    state_retained: bool,
    move_running: Arc<AtomicBool>,
    move_join: Option<JoinHandle<()>>,
}

impl WinMapModule {
    pub fn new() -> Self {
        Self {
            status: ModuleStatus::Idle,
            last_wallpaper: String::new(),
            last_taskbar_sig: String::new(),
            last_ymd: 0,
            tick_n: 0,
            state_retained: false,
            move_running: Arc::new(AtomicBool::new(false)),
            move_join: None,
        }
    }
}

impl Default for WinMapModule {
    fn default() -> Self {
        Self::new()
    }
}

impl TraceModule for WinMapModule {
    fn info(&self) -> ModuleInfo {
        ModuleInfo {
            id: ModuleId::WinMap,
            name: "Win window map".into(),
            version: "0.4.0".into(),
            description: "钩子演绎窗口开/关/最小化与焦点叠层；任务栏/壁纸；移动轨迹".into(),
            capabilities: ModuleCapability::RECORD.union(ModuleCapability::PLAYBACK),
        }
    }

    fn start(&mut self, ctx: &ModuleContext, sink: EventSink) -> Result<(), String> {
        #[cfg(windows)]
        {
            sink.emit_kind(
                now_ms(),
                "module_hello",
                json!({
                    "mode": "hook_deduce",
                    "poll_ms": 250,
                    "poll": ["wallpaper", "taskbar", "gc_dead"],
                    "move_hook": true,
                    "lifecycle_kinds": [
                        "win_open",
                        "win_close",
                        "win_minimize",
                        "win_restore",
                        "win_snapshot",
                        "win_bounds"
                    ]
                }),
            )?;
            let setup = crate::shell::display_shell_payload();
            sink.emit_kind(now_ms(), "display_setup", setup)?;
            let wp = crate::shell::check_and_backup_wallpaper("startup");
            self.last_wallpaper = crate::shell::wallpaper_content_sig();
            sink.emit_kind(now_ms(), "wallpaper", wp)?;
            self.last_ymd = crate::paths::today_ymd();
            self.emit_taskbar(&sink)?;

            crate::win_state_hook::retain(None, Some(sink.clone()))?;
            self.state_retained = true;

            if !self.move_running.load(Ordering::SeqCst) {
                self.move_running.store(true, Ordering::SeqCst);
                match crate::win_move_hook::spawn_win_move_hook(
                    sink.clone(),
                    self.move_running.clone(),
                ) {
                    Ok(jh) => self.move_join = Some(jh),
                    Err(e) => {
                        self.move_running.store(false, Ordering::SeqCst);
                        eprintln!("[win_map] move hook 启动失败: {e}");
                    }
                }
            }

            self.status = ModuleStatus::Running;
            self.tick(ctx, &sink)?;
            Ok(())
        }
        #[cfg(not(windows))]
        {
            let _ = (ctx, sink);
            self.status = ModuleStatus::Unavailable;
            Err("win_map 仅支持 Windows".into())
        }
    }

    fn tick_interval_ms(&self) -> Option<u64> {
        Some(250)
    }

    fn tick(&mut self, _ctx: &ModuleContext, sink: &EventSink) -> Result<(), String> {
        #[cfg(windows)]
        {
            self.tick_n += 1;
            let ymd = crate::paths::today_ymd();
            if self.last_ymd != 0 && ymd != self.last_ymd {
                self.last_ymd = ymd;
                sink.emit_kind(
                    now_ms(),
                    "display_setup",
                    crate::shell::display_shell_payload(),
                )?;
                let payload = crate::shell::check_and_backup_wallpaper("day_roll");
                self.last_wallpaper = crate::shell::wallpaper_content_sig();
                sink.emit_kind(now_ms(), "wallpaper", payload)?;
                self.last_taskbar_sig.clear();
                self.emit_taskbar(sink)?;
            } else {
                self.last_ymd = ymd;
            }
            let wp = crate::shell::wallpaper_content_sig();
            if wp != self.last_wallpaper {
                self.last_wallpaper = wp;
                let payload = crate::shell::check_and_backup_wallpaper("changed");
                sink.emit_kind(now_ms(), "wallpaper", payload)?;
                sink.emit_kind(now_ms(), "display_setup", crate::shell::display_shell_payload())?;
            }

            if self.tick_n % 4 == 0 {
                self.emit_taskbar(sink)?;
            }
            // 偶尔清理已销毁但漏 DESTROY 的 hwnd（扫演绎集，不 EnumWindows）
            if self.tick_n % 20 == 0 {
                crate::win_state_hook::gc_dead();
            }
            Ok(())
        }
        #[cfg(not(windows))]
        {
            let _ = (sink, _ctx);
            Ok(())
        }
    }

    fn stop(&mut self) -> Result<(), String> {
        #[cfg(windows)]
        {
            if self.state_retained {
                crate::win_state_hook::release();
                self.state_retained = false;
            }
            crate::win_move_hook::request_hook_stop(&self.move_running);
            if let Some(jh) = self.move_join.take() {
                let _ = jh.join();
            }
        }
        self.status = ModuleStatus::Stopped;
        Ok(())
    }

    fn status(&self) -> ModuleStatus {
        self.status
    }
}

impl WinMapModule {
    #[cfg(windows)]
    fn emit_taskbar(&mut self, sink: &EventSink) -> Result<(), String> {
        let hints = crate::shell::build_exe_hints();
        let bars = crate::shell::snapshot_taskbars(&hints);
        let sig = serde_json::to_string(&bars).unwrap_or_default();
        if sig == self.last_taskbar_sig {
            return Ok(());
        }
        self.last_taskbar_sig = sig;
        sink.emit_kind(
            now_ms(),
            "taskbar",
            json!({
                "taskbars": bars,
                "desktop_shown": true
            }),
        )?;
        Ok(())
    }
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
