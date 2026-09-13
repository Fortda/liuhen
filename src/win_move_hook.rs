//! 窗口移动/缩放轨迹：只钩 MOVESIZE 起止；拖动期间对目标 hwnd 轻量轮询 → `win_bounds`。
//!
//! 故意不用全局 `EVENT_OBJECT_LOCATIONCHANGE`：该事件对每个控件位移都会回调，
//! OUTOFCONTEXT 下会把整机 UI 噪音灌进本进程，体感延迟会暴涨。

#![cfg(windows)]

use crate::sink::EventSink;
use serde_json::json;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{SystemTime, UNIX_EPOCH};
use windows::Win32::Foundation::{HWND, LPARAM, WAIT_OBJECT_0, WPARAM};
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, GetAncestor, GetParent, GetWindowLongW, GetWindowRect, IsIconic, IsWindow,
    IsWindowVisible, MsgWaitForMultipleObjects, PeekMessageW, PostThreadMessageW, TranslateMessage,
    EVENT_SYSTEM_MOVESIZEEND, EVENT_SYSTEM_MOVESIZESTART, GA_ROOT, GWL_EXSTYLE, MSG, OBJID_WINDOW,
    PM_REMOVE, QS_ALLINPUT, WM_QUIT, WINEVENT_OUTOFCONTEXT, WS_EX_TOOLWINDOW,
};

/// 拖动中采样间隔（约 60fps，只读正在拖的那几个顶层窗）
const SAMPLE_MS: u64 = 16;

struct HookShared {
    sink: EventSink,
    running: Arc<AtomicBool>,
    /// hwnd → last_bounds（正在拖动/缩放）
    moving: Mutex<HashMap<u64, [i32; 4]>>,
}

static SHARED: OnceLock<Mutex<Option<Arc<HookShared>>>> = OnceLock::new();
static HOOK_THREAD_ID: AtomicU32 = AtomicU32::new(0);

fn shared_slot() -> &'static Mutex<Option<Arc<HookShared>>> {
    SHARED.get_or_init(|| Mutex::new(None))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn hwnd_u64(hwnd: HWND) -> u64 {
    hwnd.0 as u64
}

fn hwnd_from_u64(id: u64) -> HWND {
    HWND(id as *mut core::ffi::c_void)
}

unsafe fn is_top_level(hwnd: HWND) -> bool {
    unsafe {
        if hwnd.0.is_null() || !IsWindow(hwnd).as_bool() {
            return false;
        }
        let root = GetAncestor(hwnd, GA_ROOT);
        if root == hwnd {
            return true;
        }
        GetParent(hwnd).map(|p| p.0.is_null()).unwrap_or(true)
    }
}

unsafe fn read_bounds(hwnd: HWND) -> Option<[i32; 4]> {
    unsafe {
        let mut r = windows::Win32::Foundation::RECT::default();
        if GetWindowRect(hwnd, &mut r).is_err() {
            return None;
        }
        Some([r.left, r.top, r.right - r.left, r.bottom - r.top])
    }
}

unsafe fn should_track(hwnd: HWND) -> bool {
    unsafe {
        if !is_top_level(hwnd) {
            return false;
        }
        if !IsWindowVisible(hwnd).as_bool() {
            return false;
        }
        let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        if ex & WS_EX_TOOLWINDOW.0 != 0 {
            return false;
        }
        true
    }
}

fn emit(shared: &HookShared, hwnd: u64, bounds: [i32; 4], phase: &str, minimized: bool) {
    let _ = shared.sink.emit_kind(
        now_ms(),
        "win_bounds",
        json!({
            "hwnd": hwnd,
            "bounds": bounds,
            "phase": phase,
            "minimized": minimized
        }),
    );
}

/// 仅对 moving 集合里的窗采样；无拖动时几乎零成本。
fn sample_moving(shared: &HookShared) {
    let ids: Vec<(u64, [i32; 4])> = match shared.moving.lock() {
        Ok(g) => g.iter().map(|(k, v)| (*k, *v)).collect(),
        Err(_) => return,
    };
    if ids.is_empty() {
        return;
    }
    for (id, prev) in ids {
        let hwnd = hwnd_from_u64(id);
        unsafe {
            if !IsWindow(hwnd).as_bool() {
                if let Ok(mut m) = shared.moving.lock() {
                    m.remove(&id);
                }
                continue;
            }
            if IsIconic(hwnd).as_bool() {
                continue;
            }
            let Some(bounds) = read_bounds(hwnd) else { continue };
            if bounds[2] <= 0 || bounds[3] <= 0 || bounds == prev {
                continue;
            }
            if let Ok(mut m) = shared.moving.lock() {
                if let Some(slot) = m.get_mut(&id) {
                    *slot = bounds;
                } else {
                    continue;
                }
            }
            emit(shared, id, bounds, "move", false);
        }
    }
}

unsafe extern "system" fn win_event_proc(
    _hook: windows::Win32::UI::Accessibility::HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    id_object: i32,
    id_child: i32,
    _id_event_thread: u32,
    _dwms_event_time: u32,
) {
    if id_object != OBJID_WINDOW.0 || id_child != 0 || hwnd.0.is_null() {
        return;
    }

    let shared = {
        let guard = match shared_slot().lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        match guard.as_ref() {
            Some(s) => s.clone(),
            None => return,
        }
    };
    if !shared.running.load(Ordering::SeqCst) {
        return;
    }

    unsafe {
        if !should_track(hwnd) {
            return;
        }
        let id = hwnd_u64(hwnd);
        let minimized = IsIconic(hwnd).as_bool();
        let bounds = match read_bounds(hwnd) {
            Some(b) => b,
            None => return,
        };

        match event {
            EVENT_SYSTEM_MOVESIZESTART => {
                if let Ok(mut m) = shared.moving.lock() {
                    m.insert(id, bounds);
                }
                emit(&shared, id, bounds, "start", minimized);
            }
            EVENT_SYSTEM_MOVESIZEEND => {
                if let Ok(mut m) = shared.moving.lock() {
                    m.remove(&id);
                }
                emit(&shared, id, bounds, "end", minimized);
            }
            _ => {}
        }
    }
}

/// 启动钩子线程；`running` 置 false 后会 `PostThreadMessage(WM_QUIT)` 退出。
pub fn spawn_win_move_hook(
    sink: EventSink,
    running: Arc<AtomicBool>,
) -> Result<JoinHandle<()>, String> {
    {
        let mut slot = shared_slot()
            .lock()
            .map_err(|_| "win_move_hook lock poisoned".to_string())?;
        if slot.is_some() {
            return Err("win_move_hook 已在运行".into());
        }
        *slot = Some(Arc::new(HookShared {
            sink,
            running: running.clone(),
            moving: Mutex::new(HashMap::new()),
        }));
    }

    let handle = thread::Builder::new()
        .name("win-move-hook".into())
        .spawn(move || {
            HOOK_THREAD_ID.store(
                unsafe { windows::Win32::System::Threading::GetCurrentThreadId() },
                Ordering::SeqCst,
            );

            // 只钩拖动/缩放起止（低频）；轨迹靠下面的短轮询
            let hook_move = unsafe {
                SetWinEventHook(
                    EVENT_SYSTEM_MOVESIZESTART,
                    EVENT_SYSTEM_MOVESIZEEND,
                    None,
                    Some(win_event_proc),
                    0,
                    0,
                    WINEVENT_OUTOFCONTEXT,
                )
            };
            if hook_move.is_invalid() {
                let _ = shared_slot().lock().map(|mut g| *g = None);
                HOOK_THREAD_ID.store(0, Ordering::SeqCst);
                return;
            }

            let shared = shared_slot()
                .lock()
                .ok()
                .and_then(|g| g.clone())
                .expect("hook shared");

            while running.load(Ordering::SeqCst) {
                // 有消息立刻处理；否则最多等 SAMPLE_MS 再采一次样
                let wait = unsafe {
                    MsgWaitForMultipleObjects(None, false, SAMPLE_MS as u32, QS_ALLINPUT)
                };
                if wait.0 == WAIT_OBJECT_0.0 {
                    let mut msg = MSG::default();
                    while unsafe { PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE) }.as_bool() {
                        if msg.message == WM_QUIT {
                            running.store(false, Ordering::SeqCst);
                            break;
                        }
                        unsafe {
                            let _ = TranslateMessage(&msg);
                            DispatchMessageW(&msg);
                        }
                    }
                }
                if !running.load(Ordering::SeqCst) {
                    break;
                }
                sample_moving(&shared);
            }

            // 收尾：再泵干消息
            let mut msg = MSG::default();
            while unsafe { PeekMessageW(&mut msg, None, 0, 0, PM_REMOVE) }.as_bool() {
                if msg.message == WM_QUIT {
                    break;
                }
                unsafe {
                    let _ = TranslateMessage(&msg);
                    DispatchMessageW(&msg);
                }
            }

            unsafe {
                let _ = UnhookWinEvent(hook_move);
            }
            let _ = shared_slot().lock().map(|mut g| *g = None);
            HOOK_THREAD_ID.store(0, Ordering::SeqCst);
        })
        .map_err(|e| format!("启动 win_move_hook 线程失败: {e}"))?;

    Ok(handle)
}

pub fn request_hook_stop(running: &AtomicBool) {
    running.store(false, Ordering::SeqCst);
    let tid = HOOK_THREAD_ID.load(Ordering::SeqCst);
    if tid != 0 {
        unsafe {
            let _ = PostThreadMessageW(tid, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }
}
