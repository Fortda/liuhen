//! Windows 退出生命周期：点叉 / 注销 / 关机时写终止墓碑，
//! 避免只靠心跳缺口被标成「采集中断」。
//!
//! 关机主路径是**顶层隐藏窗**收 `WM_QUERYENDSESSION`（parent NULL）。
//! 消息专用窗（HWND_MESSAGE）收不到会话结束广播。
//! 加载 user32 且以 CREATE_NO_WINDOW 启动时，控制台钩子也收不到
//! `CTRL_SHUTDOWN_EVENT` / `CTRL_LOGOFF_EVENT`；控制台钩子只保留给
//! Ctrl+C / 关控制台。雷霆关机仍可能赶不及墓碑，由下次启动推断补写。

#![cfg(windows)]

use crate::health;
use crate::paths;
use std::fs;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use windows::Win32::Foundation::{BOOL, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::Console::{
    SetConsoleCtrlHandler, CTRL_BREAK_EVENT, CTRL_CLOSE_EVENT, CTRL_C_EVENT, CTRL_LOGOFF_EVENT,
    CTRL_SHUTDOWN_EVENT,
};
use windows::Win32::System::Shutdown::{
    ShutdownBlockReasonCreate, ShutdownBlockReasonDestroy,
};
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, RegisterClassW,
    TranslateMessage, CS_HREDRAW, CS_VREDRAW, ENDSESSION_LOGOFF, MSG, WINDOW_EX_STYLE, WM_CLOSE,
    WM_DESTROY, WM_ENDSESSION, WM_QUERYENDSESSION, WNDCLASSW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    WS_POPUP,
};

static TOMBSTONE_DONE: AtomicBool = AtomicBool::new(false);
static STOP_REQUESTED: AtomicBool = AtomicBool::new(false);

pub fn stop_requested() -> bool {
    STOP_REQUESTED.load(Ordering::SeqCst)
}

fn clear_pid_file() {
    let _ = fs::remove_file(paths::pid_path());
}

/// 幂等写墓碑 + 清 pid；reason 会进 health jsonl。
pub fn write_exit_tombstones(reason: &str) {
    if TOMBSTONE_DONE.swap(true, Ordering::SeqCst) {
        return;
    }
    health::mark_default_tombstones(reason);
    health::sync_health_log();
    clear_pid_file();
    STOP_REQUESTED.store(true, Ordering::SeqCst);
}

unsafe extern "system" fn console_ctrl_handler(ctrl_type: u32) -> BOOL {
    // 有控制台时 Ctrl+C / 关控制台仍有效。加载 user32 后 Windows 不会把
    // CTRL_SHUTDOWN / CTRL_LOGOFF 交给这个钩子；关机主路径是窗口过程。
    let reason = match ctrl_type {
        x if x == CTRL_C_EVENT || x == CTRL_BREAK_EVENT => "ctrl_c",
        x if x == CTRL_CLOSE_EVENT => "user_close",
        x if x == CTRL_LOGOFF_EVENT => "logoff",
        x if x == CTRL_SHUTDOWN_EVENT => "shutdown",
        _ => "user_close",
    };
    write_exit_tombstones(reason);
    BOOL(1)
}

fn endsession_reason(lparam: LPARAM) -> &'static str {
    if (lparam.0 as u32) & ENDSESSION_LOGOFF != 0 {
        "logoff"
    } else {
        "shutdown"
    }
}

unsafe extern "system" fn lifecycle_wnd_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    match msg {
        WM_QUERYENDSESSION => {
            let reason = endsession_reason(lparam);
            // 只挡极短的 flush；产品行为仍是立刻同意关机。
            // 墓碑必须写在 QUERYENDSESSION：等 WM_ENDSESSION 时进程可能已被杀。
            unsafe {
                let _ = ShutdownBlockReasonCreate(
                    hwnd,
                    windows::core::w!("OmniTrace flushing health tombstone"),
                );
            }
            write_exit_tombstones(reason);
            unsafe {
                let _ = ShutdownBlockReasonDestroy(hwnd);
            }
            LRESULT(1)
        }
        WM_ENDSESSION => {
            if wparam.0 != 0 {
                write_exit_tombstones(endsession_reason(lparam));
            }
            LRESULT(1)
        }
        WM_CLOSE | WM_DESTROY => {
            write_exit_tombstones("user_close");
            LRESULT(0)
        }
        _ => unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) },
    }
}

/// 安装控制台 Ctrl 钩子 + 顶层隐藏窗（关机/注销）。主循环应轮询 `stop_requested()`。
pub fn install_exit_hooks() {
    unsafe {
        let _ = SetConsoleCtrlHandler(Some(console_ctrl_handler), true);
    }

    thread::Builder::new()
        .name("omni-lifecycle".into())
        .spawn(|| unsafe {
            let class_name = windows::core::w!("OmniTraceLifecycle");
            let wc = WNDCLASSW {
                style: CS_HREDRAW | CS_VREDRAW,
                lpfnWndProc: Some(lifecycle_wnd_proc),
                lpszClassName: class_name,
                ..Default::default()
            };
            let _ = RegisterClassW(&wc);
            // 顶层隐藏窗：parent NULL（不是 HWND_MESSAGE），才能进会话结束广播。
            let hwnd = match CreateWindowExW(
                WINDOW_EX_STYLE(WS_EX_TOOLWINDOW.0 | WS_EX_NOACTIVATE.0),
                class_name,
                windows::core::w!("OmniTrace-WinRecorder-Lifecycle"),
                WS_POPUP,
                -32000,
                -32000,
                1,
                1,
                HWND::default(),
                None,
                None,
                None,
            ) {
                Ok(h) => h,
                Err(_) => return,
            };
            if hwnd.0.is_null() {
                return;
            }
            let mut msg = MSG::default();
            while GetMessageW(&mut msg, None, 0, 0).into() {
                let _ = TranslateMessage(&msg);
                DispatchMessageW(&msg);
                if stop_requested() {
                    break;
                }
            }
        })
        .ok();
}
