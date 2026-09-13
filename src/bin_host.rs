//! 融合宿主逻辑（供 main / module_host 共用）。

use crate::module::{ModuleId, ModuleRegistry};
use crate::modules::register_builtin_modules;
use crate::paths::{self, ensure_dir};
use std::env;
use std::fs;
use std::process::Command;
use std::thread;
use std::time::Duration;

pub fn run_default() {
    let args: Vec<String> = env::args().skip(1).collect();
    run_with_args(&args);
}

pub fn run_with_args(args: &[String]) {
    if args.iter().any(|a| a == "--stop") {
        stop_running();
        return;
    }
    if args.iter().any(|a| a == "--status") {
        print_status();
        return;
    }

    let quiet = args.iter().any(|a| a == "--quiet" || a == "-q");

    // 若已有实例，直接提示（避免双开钩子）
    if let Some(pid) = read_live_pid() {
        if !quiet {
            println!("WinRecorder 已在运行 (pid={pid})。停止：加 --stop");
        }
        return;
    }

    // 尽早占坑：start_all 较慢时防止第二个实例挤进来
    write_pid();

    let mut reg = ModuleRegistry::new();
    register_builtin_modules(&mut reg);

    if args.iter().any(|a| a == "--list" || a == "-l") {
        println!("已注册插件（同进程融合，不是独立软件）：");
        for info in reg.list_info() {
            println!(
                "  - {}  {}  v{}  caps=0x{:x}\n      {}",
                info.id,
                info.name,
                info.version,
                info.capabilities.bits(),
                info.description
            );
        }
        return;
    }

    let enable =
        parse_enable(args).unwrap_or_else(|| {
            vec![
                ModuleId::Input,
                ModuleId::Focus,
                ModuleId::WinMap,
                ModuleId::WinSettings,
                ModuleId::Body,
                ModuleId::Network,
                ModuleId::Ime,
            ]
        });
    if !quiet {
        println!(
            "融合启动插件: {:?}",
            enable.iter().map(|i| i.as_str()).collect::<Vec<_>>()
        );
    }
    reg.enable(&enable);

    if let Err(e) = reg.start_all() {
        eprintln!("start_all: {}", e);
        clear_pid();
        return;
    }

    // 上一实例已不在：若雷霆关机没写成墓碑，按 tick vs 墙钟补写后再记本次 start。
    crate::health::maybe_infer_prior_shutdown();
    crate::health::mark_starts(&enable);
    write_pid(); // 刷新为最终 pid（与上面占坑一致）
    crate::paths::write_data_root_pointer();
    #[cfg(windows)]
    crate::lifecycle::install_exit_hooks();
    if !quiet {
        println!("WinRecorder / OmniTrace 宿主运行中（一进程多插件）。Ctrl+C、点叉、关机或 --stop 结束。");
        println!("键鼠 bin → OmniDatabase/EventData/...");
        println!("焦点/信封 → OmniDatabase/ModuleData/...");
        println!("清单 → OmniDatabase/manifest.json");
        println!("健康心跳 → OmniDatabase/control/module_health.jsonl");
    }

    let mut beat_n = 0u64;
    loop {
        #[cfg(windows)]
        if crate::lifecycle::stop_requested() {
            break;
        }
        reg.tick_all();
        beat_n += 1;
        // 约每 2s 打一次心跳（主循环 500ms）
        if beat_n % 4 == 0 {
            crate::health::mark_beats(&enable);
        }
        thread::sleep(Duration::from_millis(500));
    }

    // 钩子已写墓碑时不会重复；正常 break 再兜底一次
    #[cfg(windows)]
    crate::lifecycle::write_exit_tombstones("clean_stop");
    #[cfg(not(windows))]
    crate::health::mark_default_tombstones("clean_stop");
    let _ = reg.stop_all();
    clear_pid();
}

fn write_pid() {
    ensure_dir(&paths::control_dir());
    let _ = fs::write(paths::pid_path(), std::process::id().to_string());
}

fn clear_pid() {
    let _ = fs::remove_file(paths::pid_path());
}

fn read_pid_file() -> Option<u32> {
    let s = fs::read_to_string(paths::pid_path()).ok()?;
    s.trim().parse().ok()
}

fn pid_alive(pid: u32) -> bool {
    #[cfg(windows)]
    {
        let out = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {pid}"), "/NH"])
            .output()
            .ok();
        if let Some(o) = out {
            let text = String::from_utf8_lossy(&o.stdout);
            return text.contains(&pid.to_string());
        }
        false
    }
    #[cfg(not(windows))]
    {
        let _ = pid;
        false
    }
}

fn read_live_pid() -> Option<u32> {
    let pid = read_pid_file()?;
    if pid_alive(pid) {
        Some(pid)
    } else {
        clear_pid();
        None
    }
}

fn stop_running() {
    // 先写墓碑再杀进程，仪表盘时间轴可正常收尾
    crate::health::mark_default_tombstones("clean_stop");
    let self_pid = std::process::id();

    if let Some(pid) = read_live_pid() {
        if pid != self_pid {
            let _ = Command::new("taskkill")
                .args(["/PID", &pid.to_string(), "/F"])
                .status();
        }
        clear_pid();
        println!("已停止 WinRecorder (pid={pid})");
        return;
    }

    // 兜底：只杀「非本进程」的采集实例，避免 --stop 用 /IM 把自己卡死
    #[cfg(windows)]
    {
        if let Ok(out) = Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq omnitrace_input.exe", "/FO", "CSV", "/NH"])
            .output()
        {
            let text = String::from_utf8_lossy(&out.stdout);
            for line in text.lines() {
                // "omnitrace_input.exe","1234","Session Name","Session#","Mem Usage"
                let cols: Vec<&str> = line.split(',').collect();
                if cols.len() < 2 {
                    continue;
                }
                let pid_s = cols[1].trim().trim_matches('"');
                if let Ok(pid) = pid_s.parse::<u32>() {
                    if pid != self_pid {
                        let _ = Command::new("taskkill")
                            .args(["/PID", &pid.to_string(), "/F"])
                            .status();
                    }
                }
            }
        }
    }
    clear_pid();
    println!("已尝试停止 WinRecorder（按其它 PID，不杀 --stop 自身）");
}

fn print_status() {
    match read_live_pid() {
        Some(pid) => println!("running pid={pid}"),
        None => println!("stopped"),
    }
}

fn parse_enable(args: &[String]) -> Option<Vec<ModuleId>> {
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--enable" || args[i] == "-e" {
            if let Some(list) = args.get(i + 1) {
                let ids: Vec<ModuleId> = list
                    .split(',')
                    .filter_map(|s| ModuleId::parse(s.trim()))
                    .collect();
                return Some(ids);
            }
        }
        i += 1;
    }
    None
}
