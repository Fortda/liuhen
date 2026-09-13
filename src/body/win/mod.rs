//! 机体遥测 Windows 运行时：采样线程 + 插拔窗口。宿主 tick 只 drain 队列。

mod lhm;
mod nvml;
mod probes;
mod watch;

use crate::paths;
use probes::{HkFrame, Inventory, NicRateTracker};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU8, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const SAMPLE_MS: u64 = 10_000;
pub const FORCE_MS: u64 = 60_000;
pub const VOLUME_CAP: u64 = 8 * 1024 * 1024;
pub const SAMPLE_BUDGET: Duration = Duration::from_millis(50);
pub const PENDING_CAP: usize = 256;

const COMPUTE_FULL: u8 = 0;
const COMPUTE_LITE: u8 = 1;

#[derive(Clone)]
pub struct OutEvent {
    pub ts: u64,
    pub kind: String,
    pub payload: Value,
}

pub struct BodyShared {
    pub running: AtomicBool,
    pub inventory_dirty: AtomicBool,
    pub link_dirty: AtomicBool,
    pub volume_throttled: AtomicBool,
    pub compute_mode: AtomicU8,
    pub watch_tid: AtomicU32,
    pub pending: Mutex<Vec<OutEvent>>,
    pub wait: Mutex<()>,
    pub wake: Condvar,
}

impl BodyShared {
    fn new() -> Self {
        Self {
            running: AtomicBool::new(true),
            inventory_dirty: AtomicBool::new(true),
            link_dirty: AtomicBool::new(true),
            volume_throttled: AtomicBool::new(false),
            compute_mode: AtomicU8::new(COMPUTE_FULL),
            watch_tid: AtomicU32::new(0),
            pending: Mutex::new(Vec::new()),
            wait: Mutex::new(()),
            wake: Condvar::new(),
        }
    }

    pub fn push(&self, ev: OutEvent) {
        if let Ok(mut g) = self.pending.lock() {
            if g.len() < PENDING_CAP {
                g.push(ev);
            }
        }
    }

    pub fn wake_now(&self) {
        self.wake.notify_one();
    }
}

pub struct BodyRuntime {
    shared: Arc<BodyShared>,
    sampler: Option<JoinHandle<()>>,
    watch: Option<JoinHandle<()>>,
}

impl BodyRuntime {
    pub fn start() -> Result<Self, String> {
        let shared = Arc::new(BodyShared::new());
        let watch = watch::spawn(shared.clone())?;
        let sampler = {
            let s = shared.clone();
            thread::Builder::new()
                .name("omni-body-sample".into())
                .spawn(move || sampler_loop(s))
                .map_err(|e| format!("body sampler: {e}"))?
        };
        Ok(Self {
            shared,
            sampler: Some(sampler),
            watch: Some(watch),
        })
    }

    pub fn drain(&self) -> Vec<OutEvent> {
        self.shared
            .pending
            .lock()
            .map(|mut g| std::mem::take(&mut *g))
            .unwrap_or_default()
    }
}

impl Drop for BodyRuntime {
    fn drop(&mut self) {
        self.shared.running.store(false, Ordering::SeqCst);
        self.shared.wake_now();
        watch::request_stop(&self.shared);
        if let Some(h) = self.sampler.take() {
            let _ = h.join();
        }
        if let Some(h) = self.watch.take() {
            let _ = h.join();
        }
    }
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn body_file_len() -> u64 {
    std::fs::metadata(paths::module_events_path_today("body"))
        .map(|m| m.len())
        .unwrap_or(0)
}

fn sampler_loop(shared: Arc<BodyShared>) {
    probes::com_init();
    let mut nvml = nvml::Nvml::load();
    let mut pdh = probes::PdhDisk::open();
    let mut nic_rates = NicRateTracker::new();
    let mut prev_cpu = probes::CpuTimes::read();
    let mut last_inv_sig = String::new();
    let mut last_link_sig = String::new();
    let mut last_hk_sig = String::new();
    let mut last_hk_ms = 0u64;
    let mut hello_sent = false;
    let mut slow_streak = 0u32;
    let mut unavailable: HashSet<String> = HashSet::new();
    let mut last_day = crate::paths::today_day();
    let mut lhm_tried = false;
    let mut lhm_ok = false;

    while shared.running.load(Ordering::SeqCst) {
        let ts = now_ms();
        let today = crate::paths::today_day();
        if today != last_day {
            last_day = today;
            shared.inventory_dirty.store(true, Ordering::SeqCst);
            shared.volume_throttled.store(false, Ordering::SeqCst);
        }

        if body_file_len() >= VOLUME_CAP {
            shared.volume_throttled.store(true, Ordering::SeqCst);
        }

        let lite = shared.compute_mode.load(Ordering::SeqCst) == COMPUTE_LITE;
        let throttled = shared.volume_throttled.load(Ordering::SeqCst);

        if !hello_sent {
            lhm_ok = !lite && lhm::probe_present();
            lhm_tried = true;
            shared.push(OutEvent {
                ts,
                kind: "module_hello".into(),
                payload: json!({
                    "buses": ["telecom", "eps", "tcs", "cdh", "payload"],
                    "sample_ms": SAMPLE_MS,
                    "force_ms": FORCE_MS,
                    "volume_cap_bytes": VOLUME_CAP,
                    "lhm": if lhm_ok { "attached" } else { "absent" },
                    "nvml": nvml.is_some(),
                    "adl": nvml::adl_dll_present(),
                    "volume_mode": if throttled { "throttled" } else { "normal" },
                    "compute_mode": if lite { "lite" } else { "full" },
                    "kinds": [
                        "module_hello",
                        "inventory_snapshot",
                        "device_change",
                        "link_change",
                        "hk_sample",
                        "sensor_unavailable"
                    ]
                }),
            });
            hello_sent = true;
            if !nvml.is_some() {
                emit_unavailable(&shared, ts, &mut unavailable, "gpu.nvml", "nvml.dll 未加载");
            }
            if !lhm_ok {
                emit_unavailable(&shared, ts, &mut unavailable, "tcs.lhm", "LibreHardwareMonitor 未挂上");
            }
        }

        let inv_dirty = shared
            .inventory_dirty
            .swap(false, Ordering::SeqCst);
        let link_dirty = shared.link_dirty.swap(false, Ordering::SeqCst);
        if inv_dirty {
            let reason = if last_inv_sig.is_empty() {
                "startup"
            } else if today != last_day {
                "day"
            } else {
                "changed"
            };
            match Inventory::collect() {
                Ok(inv) => {
                    if inv.sig != last_inv_sig {
                        last_inv_sig = inv.sig.clone();
                        shared.push(OutEvent {
                            ts,
                            kind: "inventory_snapshot".into(),
                            payload: inv.to_payload(reason),
                        });
                    }
                }
                Err(e) => emit_unavailable(&shared, ts, &mut unavailable, "payload.inventory", &e),
            }
        }

        if inv_dirty || link_dirty || last_link_sig.is_empty() {
            let links = probes::link_snapshot();
            if links.sig != last_link_sig {
                let prev = last_link_sig.clone();
                last_link_sig = links.sig.clone();
                if !prev.is_empty() {
                    for ch in links.changes {
                        shared.push(OutEvent {
                            ts,
                            kind: "link_change".into(),
                            payload: ch,
                        });
                    }
                }
            }
        }

        let want_hk = !throttled || ts.saturating_sub(last_hk_ms) >= FORCE_MS;
        if want_hk {
            let t0 = Instant::now();
            let cpu = probes::CpuTimes::read();
            let cpu_pct = match (prev_cpu, cpu) {
                (Some(a), Some(b)) => b.percent_since(&a),
                _ => None,
            };
            prev_cpu = cpu;

            let mut frame = HkFrame::sample(cpu_pct, pdh.as_mut(), &mut nic_rates, ts);
            if let Some(ref mut n) = nvml {
                frame.apply_nvml(n);
            }
            if !lite && lhm_ok && t0.elapsed() < SAMPLE_BUDGET {
                match lhm::sample_compact() {
                    Some(v) => frame.tcs_lhm = Some(v),
                    None => {
                        if lhm_tried {
                            emit_unavailable(
                                &shared,
                                ts,
                                &mut unavailable,
                                "tcs.lhm",
                                "LHM HTTP 超时或失败",
                            );
                        }
                    }
                }
            }
            let sample_ms = t0.elapsed().as_millis() as u64;
            if t0.elapsed() > SAMPLE_BUDGET {
                slow_streak = slow_streak.saturating_add(1);
            } else {
                slow_streak = 0;
            }
            if slow_streak >= 3 && !lite {
                shared.compute_mode.store(COMPUTE_LITE, Ordering::SeqCst);
                lhm_ok = false;
                emit_unavailable(
                    &shared,
                    ts,
                    &mut unavailable,
                    "compute.lite",
                    "连续 3 拍超过 50ms，丢掉 L2/L3",
                );
            }

            frame.finalize_eps();
            let payload = frame.to_payload(
                sample_ms,
                throttled,
                shared.compute_mode.load(Ordering::SeqCst) == COMPUTE_LITE,
            );
            if payload
                .get("eps")
                .and_then(|e| e.get("watts"))
                .map(|v| v.is_null())
                .unwrap_or(true)
            {
                emit_unavailable(
                    &shared,
                    ts,
                    &mut unavailable,
                    "eps.watts",
                    "无整机功率源（无放电电池、无 ACPI Power Meter、无 LHM PSU）",
                );
            }
            let sig = frame.sig();
            let force = ts.saturating_sub(last_hk_ms) >= FORCE_MS;
            if force || sig != last_hk_sig {
                last_hk_sig = sig;
                last_hk_ms = ts;
                shared.push(OutEvent {
                    ts,
                    kind: "hk_sample".into(),
                    payload,
                });
            }
        }

        let wait_ms = if shared.volume_throttled.load(Ordering::SeqCst) {
            FORCE_MS
        } else {
            SAMPLE_MS
        };
        let guard = match shared.wait.lock() {
            Ok(g) => g,
            Err(_) => break,
        };
        if !shared.running.load(Ordering::SeqCst) {
            break;
        }
        let _ = shared
            .wake
            .wait_timeout(guard, Duration::from_millis(wait_ms));
    }

    probes::com_uninit();
}

fn emit_unavailable(
    shared: &BodyShared,
    ts: u64,
    seen: &mut HashSet<String>,
    channel: &str,
    reason: &str,
) {
    if !seen.insert(channel.to_string()) {
        return;
    }
    shared.push(OutEvent {
        ts,
        kind: "sensor_unavailable".into(),
        payload: json!({ "channel": channel, "reason": reason }),
    });
}
