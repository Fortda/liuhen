//! 窗口在场 + 焦点：用 WinEvent 钩子演绎，不再周期 EnumWindows。
//!
//! - 启动时 EnumWindows 一次作种子（已有窗口不会“凭空出现”）
//! - 之后靠 CREATE/SHOW / HIDE/DESTROY / MINIMIZE* / FOREGROUND / NAMECHANGE 维护集合
//! - 故意不钩 LOCATIONCHANGE（全局控件位移噪音会拖垮 UI）
//! - `focus_change` → focus sink；`win_open/close/minimize/restore` + `win_snapshot` → win_map sink

#![cfg(windows)]

use crate::sink::EventSink;
use crate::win_enum::{describe_window, is_trackable_top_level, snapshot_windows, WinEntry};
use serde_json::json;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{SystemTime, UNIX_EPOCH};
use windows::Win32::Foundation::{HWND, LPARAM, WAIT_OBJECT_0, WPARAM};
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, GetAncestor, GetClassNameW, GetForegroundWindow, GetParent, IsIconic,
    IsWindow, IsWindowVisible, MsgWaitForMultipleObjects, PeekMessageW, PostThreadMessageW,
    TranslateMessage, EVENT_OBJECT_CREATE, EVENT_OBJECT_DESTROY, EVENT_OBJECT_HIDE,
    EVENT_OBJECT_NAMECHANGE, EVENT_OBJECT_SHOW, EVENT_SYSTEM_FOREGROUND,
    EVENT_SYSTEM_MINIMIZEEND, EVENT_SYSTEM_MINIMIZESTART, GA_ROOT, MSG, OBJID_WINDOW, PM_REMOVE,
    QS_ALLINPUT, WM_QUIT, WINEVENT_OUTOFCONTEXT,
};

struct HookShared {
    focus_sink: Mutex<Option<EventSink>>,
    win_map_sink: Mutex<Option<EventSink>>,
    running: Arc<AtomicBool>,
    /// front → back
    order: Mutex<Vec<u64>>,
    by_hwnd: Mutex<HashMap<u64, WinEntry>>,
    focus_hwnd: Mutex<Option<u64>>,
    last_focus_sig: Mutex<String>,
    last_snap_sig: Mutex<String>,
}

static SHARED: OnceLock<Mutex<Option<Arc<HookShared>>>> = OnceLock::new();
static HOOK_THREAD_ID: AtomicU32 = AtomicU32::new(0);
static CLIENTS: AtomicU32 = AtomicU32::new(0);
static JOIN: OnceLock<Mutex<Option<JoinHandle<()>>>> = OnceLock::new();

fn shared_slot() -> &'static Mutex<Option<Arc<HookShared>>> {
    SHARED.get_or_init(|| Mutex::new(None))
}

fn join_slot() -> &'static Mutex<Option<JoinHandle<()>>> {
    JOIN.get_or_init(|| Mutex::new(None))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn hwnd_u64(hwnd: HWND) -> u64 {
    hwnd.0 as usize as u64
}

fn hwnd_from_u64(id: u64) -> HWND {
    HWND(id as *mut core::ffi::c_void)
}

unsafe fn resolve_top_level(hwnd: HWND) -> Option<HWND> {
    unsafe {
        if hwnd.0.is_null() || !IsWindow(hwnd).as_bool() {
            return None;
        }
        let root = GetAncestor(hwnd, GA_ROOT);
        if !root.0.is_null() {
            return Some(root);
        }
        if GetParent(hwnd).map(|p| p.0.is_null()).unwrap_or(true) {
            Some(hwnd)
        } else {
            None
        }
    }
}

fn class_name(hwnd: HWND) -> String {
    unsafe {
        let mut buf = [0u16; 256];
        let n = GetClassNameW(hwnd, &mut buf);
        let len = (n as usize).min(buf.len());
        String::from_utf16_lossy(&buf[..len])
    }
}

fn is_desktop_shell(hwnd: HWND) -> bool {
    matches!(
        class_name(hwnd).as_str(),
        "Progman" | "WorkerW" | "Shell_TrayWnd" | "Shell_SecondaryTrayWnd"
    )
}

fn app_label(exe: &str) -> String {
    if exe.is_empty() {
        "System".into()
    } else {
        exe.trim_end_matches(".exe")
            .trim_end_matches(".EXE")
            .to_string()
    }
}

fn reindex(order: &[u64], by: &mut HashMap<u64, WinEntry>) {
    for (i, id) in order.iter().enumerate() {
        if let Some(e) = by.get_mut(id) {
            e.z = i as u32;
        }
    }
}

fn ordered_windows(shared: &HookShared) -> Vec<WinEntry> {
    let order = shared.order.lock().ok();
    let by = shared.by_hwnd.lock().ok();
    match (order, by) {
        (Some(order), Some(by)) => order
            .iter()
            .filter_map(|id| by.get(id).cloned())
            .collect(),
        _ => Vec::new(),
    }
}

fn emit_win_map(shared: &HookShared, kind: &str, payload: serde_json::Value) {
    if let Ok(g) = shared.win_map_sink.lock() {
        if let Some(sink) = g.as_ref() {
            let _ = sink.emit_kind(now_ms(), kind, payload);
        }
    }
}

fn emit_focus(shared: &HookShared, app: &str, title: &str, bounds: [i32; 4]) {
    let sig = format!(
        "{app}|{title}|{}:{}:{}:{}",
        bounds[0], bounds[1], bounds[2], bounds[3]
    );
    if let Ok(mut last) = shared.last_focus_sig.lock() {
        if *last == sig {
            return;
        }
        *last = sig;
    }
    if let Ok(g) = shared.focus_sink.lock() {
        if let Some(sink) = g.as_ref() {
            let _ = sink.emit_kind(
                now_ms(),
                "focus_change",
                json!({
                    "app": app,
                    "title": title,
                    "bounds": bounds
                }),
            );
        }
    }
}

fn emit_snapshot_if_changed(shared: &HookShared) {
    let wins = ordered_windows(shared);
    let sig = wins
        .iter()
        .map(|w| {
            format!(
                "{}:{}:{}x{}+{}+{}:{}:{}",
                w.hwnd,
                w.z,
                w.bounds[2],
                w.bounds[3],
                w.bounds[0],
                w.bounds[1],
                w.minimized as u8,
                w.title
            )
        })
        .collect::<Vec<_>>()
        .join("|");
    if let Ok(mut last) = shared.last_snap_sig.lock() {
        if *last == sig {
            return;
        }
        *last = sig;
    }
    emit_win_map(
        shared,
        "win_snapshot",
        json!({
            "windows": wins,
            "order": "front_to_back",
            "source": "hook_deduce"
        }),
    );
}

fn seed_from_enum(shared: &HookShared) {
    let wins = snapshot_windows();
    if let (Ok(mut order), Ok(mut by)) = (shared.order.lock(), shared.by_hwnd.lock()) {
        order.clear();
        by.clear();
        for w in wins {
            order.push(w.hwnd);
            by.insert(w.hwnd, w);
        }
    }
    emit_snapshot_if_changed(shared);

    unsafe {
        let fg = GetForegroundWindow();
        if !fg.0.is_null() {
            on_foreground(shared, fg);
        } else {
            emit_focus(shared, "System", "[桌面或失去焦点]", [0, 0, 0, 0]);
        }
    }
}

fn upsert_open(shared: &HookShared, hwnd: HWND) {
    let id = hwnd_u64(hwnd);
    let Some(entry) = describe_window(hwnd, 0) else {
        return;
    };
    let mut opened = false;
    if let (Ok(mut order), Ok(mut by)) = (shared.order.lock(), shared.by_hwnd.lock()) {
        if let Some(old) = by.get_mut(&id) {
            let z = old.z;
            *old = entry.clone();
            old.z = z;
        } else {
            order.insert(0, id);
            by.insert(id, entry.clone());
            reindex(&order, &mut by);
            opened = true;
        }
    }
    if opened {
        emit_win_map(
            shared,
            "win_open",
            json!({
                "hwnd": entry.hwnd,
                "title": entry.title,
                "class": entry.class,
                "bounds": entry.bounds,
                "minimized": entry.minimized,
                "pid": entry.pid,
                "exe": entry.exe
            }),
        );
    }
    emit_snapshot_if_changed(shared);
}

fn remove_window(shared: &HookShared, id: u64, reason: &str) {
    let removed = {
        if let (Ok(mut order), Ok(mut by)) = (shared.order.lock(), shared.by_hwnd.lock()) {
            let had = by.remove(&id);
            order.retain(|x| *x != id);
            reindex(&order, &mut by);
            had
        } else {
            None
        }
    };
    let Some(e) = removed else {
        return;
    };
    emit_win_map(
        shared,
        "win_close",
        json!({
            "hwnd": e.hwnd,
            "exe": e.exe,
            "title": e.title,
            "reason": reason
        }),
    );
    emit_snapshot_if_changed(shared);
    if let Ok(mut fg) = shared.focus_hwnd.lock() {
        if *fg == Some(id) {
            *fg = None;
        }
    }
}

fn set_minimized(shared: &HookShared, hwnd: HWND, minimized: bool) {
    let id = hwnd_u64(hwnd);
    let mut payload = None;
    if let Ok(mut by) = shared.by_hwnd.lock() {
        if let Some(e) = by.get_mut(&id) {
            if e.minimized != minimized {
                e.minimized = minimized;
                if !minimized {
                    if let Some(fresh) = describe_window(hwnd, e.z) {
                        *e = fresh;
                    }
                }
                payload = Some((
                    if minimized {
                        "win_minimize"
                    } else {
                        "win_restore"
                    },
                    json!({
                        "hwnd": e.hwnd,
                        "exe": e.exe,
                        "title": e.title,
                        "bounds": e.bounds,
                        "minimized": e.minimized
                    }),
                ));
            }
        }
    }
    if let Some((kind, p)) = payload {
        emit_win_map(shared, kind, p);
        emit_snapshot_if_changed(shared);
    } else if !minimized {
        upsert_open(shared, hwnd);
    }
}

fn on_foreground(shared: &HookShared, hwnd: HWND) {
    unsafe {
        let Some(top) = resolve_top_level(hwnd) else {
            emit_focus(shared, "System", "[桌面或失去焦点]", [0, 0, 0, 0]);
            if let Ok(mut fg) = shared.focus_hwnd.lock() {
                *fg = None;
            }
            return;
        };

        if is_desktop_shell(top) || !IsWindowVisible(top).as_bool() {
            emit_focus(shared, "System", "[桌面或失去焦点]", [0, 0, 0, 0]);
            if let Ok(mut fg) = shared.focus_hwnd.lock() {
                *fg = None;
            }
            return;
        }

        let id = hwnd_u64(top);
        if is_trackable_top_level(top) {
            if let (Ok(mut order), Ok(mut by)) = (shared.order.lock(), shared.by_hwnd.lock()) {
                if let Some(fresh) = describe_window(top, 0) {
                    let is_new = !by.contains_key(&id);
                    order.retain(|x| *x != id);
                    order.insert(0, id);
                    by.insert(id, fresh.clone());
                    reindex(&order, &mut by);
                    drop(order);
                    drop(by);
                    if is_new {
                        emit_win_map(
                            shared,
                            "win_open",
                            json!({
                                "hwnd": fresh.hwnd,
                                "title": fresh.title,
                                "class": fresh.class,
                                "bounds": fresh.bounds,
                                "minimized": fresh.minimized,
                                "pid": fresh.pid,
                                "exe": fresh.exe,
                                "reason": "foreground"
                            }),
                        );
                    }
                }
            }
            emit_snapshot_if_changed(shared);
        }

        if let Ok(mut fg) = shared.focus_hwnd.lock() {
            *fg = Some(id);
        }

        if let Some(e) = shared.by_hwnd.lock().ok().and_then(|g| g.get(&id).cloned()) {
            emit_focus(shared, &app_label(&e.exe), &e.title, e.bounds);
        } else if let Some(e) = describe_window(top, 0) {
            emit_focus(shared, &app_label(&e.exe), &e.title, e.bounds);
        } else {
            let title = crate::win_enum::window_title(top);
            emit_focus(shared, "System", &title, [0, 0, 0, 0]);
        }
    }
}

fn on_name_change(shared: &HookShared, hwnd: HWND) {
    let id = hwnd_u64(hwnd);
    let mut title = None;
    if let Ok(mut by) = shared.by_hwnd.lock() {
        if let Some(e) = by.get_mut(&id) {
            let t = crate::win_enum::window_title(hwnd);
            if e.title != t {
                e.title = t.clone();
                title = Some((e.exe.clone(), t, e.bounds));
            }
        }
    }
    if let Some((exe, t, bounds)) = title {
        emit_snapshot_if_changed(shared);
        if shared.focus_hwnd.lock().ok().and_then(|g| *g) == Some(id) {
            emit_focus(shared, &app_label(&exe), &t, bounds);
        }
    }
}

/// 去掉已销毁 hwnd（只扫演绎集合，不 EnumWindows）。
pub fn gc_dead() {
    let shared = {
        let g = match shared_slot().lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        match g.as_ref() {
            Some(s) => s.clone(),
            None => return,
        }
    };
    let ids: Vec<u64> = shared.order.lock().map(|o| o.clone()).unwrap_or_default();
    for id in ids {
        let hwnd = hwnd_from_u64(id);
        unsafe {
            if !IsWindow(hwnd).as_bool() {
                remove_window(&shared, id, "gc_dead");
            }
        }
    }
}

unsafe extern "system" fn win_event_proc(
    _hook: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    id_object: i32,
    id_child: i32,
    _id_event_thread: u32,
    _dwms_event_time: u32,
) {
    if id_object != OBJID_WINDOW.0 || id_child != 0 {
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
        match event {
            EVENT_SYSTEM_FOREGROUND => on_foreground(&shared, hwnd),
            EVENT_OBJECT_CREATE | EVENT_OBJECT_SHOW => {
                let Some(top) = resolve_top_level(hwnd) else {
                    return;
                };
                if is_trackable_top_level(top) {
                    upsert_open(&shared, top);
                }
            }
            EVENT_OBJECT_HIDE => {
                let Some(top) = resolve_top_level(hwnd) else {
                    return;
                };
                let id = hwnd_u64(top);
                if IsWindow(top).as_bool() && IsIconic(top).as_bool() {
                    set_minimized(&shared, top, true);
                } else if !IsWindow(top).as_bool() || !IsWindowVisible(top).as_bool() {
                    remove_window(&shared, id, "hide");
                }
            }
            EVENT_OBJECT_DESTROY => {
                let id = match resolve_top_level(hwnd) {
                    Some(t) => hwnd_u64(t),
                    None => hwnd_u64(hwnd),
                };
                remove_window(&shared, id, "destroy");
            }
            EVENT_SYSTEM_MINIMIZESTART => {
                let Some(top) = resolve_top_level(hwnd) else {
                    return;
                };
                set_minimized(&shared, top, true);
            }
            EVENT_SYSTEM_MINIMIZEEND => {
                let Some(top) = resolve_top_level(hwnd) else {
                    return;
                };
                set_minimized(&shared, top, false);
            }
            EVENT_OBJECT_NAMECHANGE => {
                let Some(top) = resolve_top_level(hwnd) else {
                    return;
                };
                on_name_change(&shared, top);
            }
            _ => {}
        }
    }
}

fn ensure_shared() -> Result<Arc<HookShared>, String> {
    let mut slot = shared_slot()
        .lock()
        .map_err(|_| "win_state_hook lock poisoned".to_string())?;
    if let Some(s) = slot.as_ref() {
        return Ok(s.clone());
    }
    let s = Arc::new(HookShared {
        focus_sink: Mutex::new(None),
        win_map_sink: Mutex::new(None),
        running: Arc::new(AtomicBool::new(true)),
        order: Mutex::new(Vec::new()),
        by_hwnd: Mutex::new(HashMap::new()),
        focus_hwnd: Mutex::new(None),
        last_focus_sig: Mutex::new(String::new()),
        last_snap_sig: Mutex::new(String::new()),
    });
    *slot = Some(s.clone());
    Ok(s)
}

fn spawn_thread(shared: Arc<HookShared>) -> Result<(), String> {
    let running = shared.running.clone();
    running.store(true, Ordering::SeqCst);

    let handle = thread::Builder::new()
        .name("win-state-hook".into())
        .spawn(move || {
            HOOK_THREAD_ID.store(
                unsafe { windows::Win32::System::Threading::GetCurrentThreadId() },
                Ordering::SeqCst,
            );

            seed_from_enum(&shared);

            // 分段挂钩，避开 LOCATIONCHANGE (0x800B)
            let hook_fg = unsafe {
                SetWinEventHook(
                    EVENT_SYSTEM_FOREGROUND,
                    EVENT_SYSTEM_FOREGROUND,
                    None,
                    Some(win_event_proc),
                    0,
                    0,
                    WINEVENT_OUTOFCONTEXT,
                )
            };
            let hook_min = unsafe {
                SetWinEventHook(
                    EVENT_SYSTEM_MINIMIZESTART,
                    EVENT_SYSTEM_MINIMIZEEND,
                    None,
                    Some(win_event_proc),
                    0,
                    0,
                    WINEVENT_OUTOFCONTEXT,
                )
            };
            // CREATE..HIDE = 0x8000..0x8003，不含后面的 LOCATIONCHANGE
            let hook_life = unsafe {
                SetWinEventHook(
                    EVENT_OBJECT_CREATE,
                    EVENT_OBJECT_HIDE,
                    None,
                    Some(win_event_proc),
                    0,
                    0,
                    WINEVENT_OUTOFCONTEXT,
                )
            };
            let hook_name = unsafe {
                SetWinEventHook(
                    EVENT_OBJECT_NAMECHANGE,
                    EVENT_OBJECT_NAMECHANGE,
                    None,
                    Some(win_event_proc),
                    0,
                    0,
                    WINEVENT_OUTOFCONTEXT,
                )
            };

            if hook_fg.is_invalid()
                && hook_min.is_invalid()
                && hook_life.is_invalid()
                && hook_name.is_invalid()
            {
                let _ = shared_slot().lock().map(|mut g| *g = None);
                HOOK_THREAD_ID.store(0, Ordering::SeqCst);
                return;
            }

            while running.load(Ordering::SeqCst) {
                let wait =
                    unsafe { MsgWaitForMultipleObjects(None, false, 250, QS_ALLINPUT) };
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
            }

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
                if !hook_fg.is_invalid() {
                    let _ = UnhookWinEvent(hook_fg);
                }
                if !hook_min.is_invalid() {
                    let _ = UnhookWinEvent(hook_min);
                }
                if !hook_life.is_invalid() {
                    let _ = UnhookWinEvent(hook_life);
                }
                if !hook_name.is_invalid() {
                    let _ = UnhookWinEvent(hook_name);
                }
            }
            let _ = shared_slot().lock().map(|mut g| *g = None);
            HOOK_THREAD_ID.store(0, Ordering::SeqCst);
        })
        .map_err(|e| format!("启动 win_state_hook 失败: {e}"))?;

    *join_slot()
        .lock()
        .map_err(|_| "join lock poisoned".to_string())? = Some(handle);
    Ok(())
}

fn flush_current(shared: &HookShared) {
    // 允许 sink 晚于种子挂上时补发当前演绎态
    if let Ok(mut last) = shared.last_snap_sig.lock() {
        last.clear();
    }
    if let Ok(mut last) = shared.last_focus_sig.lock() {
        last.clear();
    }
    emit_snapshot_if_changed(shared);
    let fg = shared.focus_hwnd.lock().ok().and_then(|g| *g);
    if let Some(id) = fg {
        if let Some(e) = shared.by_hwnd.lock().ok().and_then(|g| g.get(&id).cloned()) {
            emit_focus(shared, &app_label(&e.exe), &e.title, e.bounds);
            return;
        }
    }
    unsafe {
        let hwnd = GetForegroundWindow();
        if !hwnd.0.is_null() {
            on_foreground(shared, hwnd);
        }
    }
}

/// 挂上 sink 并保留一个客户端；首个客户端启动钩子线程。
pub fn retain(focus: Option<EventSink>, win_map: Option<EventSink>) -> Result<(), String> {
    let shared = ensure_shared()?;
    let mut attached_map = false;
    if let Some(s) = focus {
        *shared
            .focus_sink
            .lock()
            .map_err(|_| "focus_sink lock".to_string())? = Some(s);
    }
    if let Some(s) = win_map {
        *shared
            .win_map_sink
            .lock()
            .map_err(|_| "win_map_sink lock".to_string())? = Some(s);
        attached_map = true;
    }

    let prev = CLIENTS.fetch_add(1, Ordering::SeqCst);
    if prev == 0 {
        spawn_thread(shared.clone())?;
    } else if attached_map {
        // 钩子已在跑、win_map 后挂上：补发快照
        flush_current(&shared);
    }
    Ok(())
}

/// 释放一个客户端；最后一个退出时停钩子并 join。
pub fn release() {
    let prev = CLIENTS.fetch_sub(1, Ordering::SeqCst);
    if prev != 1 {
        return;
    }
    if let Ok(g) = shared_slot().lock() {
        if let Some(s) = g.as_ref() {
            s.running.store(false, Ordering::SeqCst);
        }
    }
    let tid = HOOK_THREAD_ID.load(Ordering::SeqCst);
    if tid != 0 {
        unsafe {
            let _ = PostThreadMessageW(tid, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }
    if let Ok(mut j) = join_slot().lock() {
        if let Some(h) = j.take() {
            let _ = h.join();
        }
    }
}
