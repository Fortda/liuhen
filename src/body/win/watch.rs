//! 插拔通知：隐藏消息窗收 WM_DEVICECHANGE，回调里只投递，枚举交给采样线程。

use super::BodyShared;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use windows::core::{w, PCWSTR};
use windows::Win32::Foundation::{HANDLE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::GetCurrentThreadId;
use windows::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DispatchMessageW, GetMessageW, PostThreadMessageW,
    RegisterClassW, RegisterDeviceNotificationW, TranslateMessage, DBT_DEVICEARRIVAL,
    DBT_DEVICEREMOVECOMPLETE, DBT_DEVNODES_CHANGED, DBT_DEVTYP_DEVICEINTERFACE,
    DEVICE_NOTIFY_ALL_INTERFACE_CLASSES, DEVICE_NOTIFY_WINDOW_HANDLE, DEV_BROADCAST_DEVICEINTERFACE_W,
    DEV_BROADCAST_HDR, HWND_MESSAGE, MSG, WINDOW_EX_STYLE, WM_DEVICECHANGE, WM_DESTROY, WM_QUIT,
    WNDCLASSW, WS_POPUP,
};

const CLASS: PCWSTR = w!("OmniTraceBodyWatch");

pub fn spawn(shared: Arc<BodyShared>) -> Result<JoinHandle<()>, String> {
    thread::Builder::new()
        .name("omni-body-watch".into())
        .spawn(move || watch_loop(shared))
        .map_err(|e| format!("body watch: {e}"))
}

pub fn request_stop(shared: &BodyShared) {
    let tid = shared.watch_tid.load(Ordering::SeqCst);
    if tid != 0 {
        unsafe {
            let _ = PostThreadMessageW(tid, WM_QUIT, WPARAM(0), LPARAM(0));
        }
    }
}

fn watch_loop(shared: Arc<BodyShared>) {
    unsafe {
        let tid = GetCurrentThreadId();
        shared.watch_tid.store(tid, Ordering::SeqCst);

        let hinst = GetModuleHandleW(None)
            .ok()
            .map(|h| windows::Win32::Foundation::HINSTANCE(h.0))
            .unwrap_or_default();
        let wc = WNDCLASSW {
            lpfnWndProc: Some(wnd_proc),
            hInstance: hinst,
            lpszClassName: CLASS,
            ..Default::default()
        };
        let _ = RegisterClassW(&wc);
        let hwnd = CreateWindowExW(
            WINDOW_EX_STYLE(0),
            CLASS,
            w!(""),
            WS_POPUP,
            0,
            0,
            0,
            0,
            HWND_MESSAGE,
            None,
            hinst,
            None,
        );
        let Ok(hwnd) = hwnd else {
            return;
        };

        let filter = DEV_BROADCAST_DEVICEINTERFACE_W {
            dbcc_size: std::mem::size_of::<DEV_BROADCAST_DEVICEINTERFACE_W>() as u32,
            dbcc_devicetype: DBT_DEVTYP_DEVICEINTERFACE.0,
            dbcc_reserved: 0,
            dbcc_classguid: windows::core::GUID::zeroed(),
            dbcc_name: [0; 1],
        };
        let _ = RegisterDeviceNotificationW(
            HANDLE(hwnd.0),
            &filter as *const _ as *const std::ffi::c_void,
            DEVICE_NOTIFY_WINDOW_HANDLE | DEVICE_NOTIFY_ALL_INTERFACE_CLASSES,
        );

        WATCH_SLOT.with(|s| *s.borrow_mut() = Some(shared.clone()));

        let mut msg = MSG::default();
        while GetMessageW(&mut msg, HWND::default(), 0, 0).as_bool() {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
            if !shared.running.load(Ordering::SeqCst) {
                break;
            }
        }
        WATCH_SLOT.with(|s| *s.borrow_mut() = None);
        let _ = filter;
    }
}

thread_local! {
    static WATCH_SLOT: std::cell::RefCell<Option<Arc<BodyShared>>> = const { std::cell::RefCell::new(None) };
}

fn notify(kind: &str, extra: Option<String>) {
    WATCH_SLOT.with(|s| {
        if let Some(shared) = s.borrow().as_ref() {
            shared.inventory_dirty.store(true, Ordering::SeqCst);
            shared.link_dirty.store(true, Ordering::SeqCst);
            if kind != "nodes" {
                let ts = super::now_ms();
                let payload = match extra {
                    Some(name) => serde_json::json!({ "action": kind, "name": name }),
                    None => serde_json::json!({ "action": kind }),
                };
                shared.push(super::OutEvent {
                    ts,
                    kind: "device_change".into(),
                    payload,
                });
            }
            shared.wake_now();
        }
    });
}

unsafe extern "system" fn wnd_proc(hwnd: HWND, msg: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if msg == WM_DESTROY {
        return LRESULT(0);
    }
    if msg == WM_DEVICECHANGE {
        let ev = wparam.0 as u32;
        if ev == DBT_DEVNODES_CHANGED {
            notify("nodes", None);
        } else if ev == DBT_DEVICEARRIVAL || ev == DBT_DEVICEREMOVECOMPLETE {
            let action = if ev == DBT_DEVICEARRIVAL {
                "arrival"
            } else {
                "remove"
            };
            notify(action, device_name_from_lparam(lparam));
        }
        return LRESULT(1);
    }
    unsafe { DefWindowProcW(hwnd, msg, wparam, lparam) }
}

fn device_name_from_lparam(lparam: LPARAM) -> Option<String> {
    if lparam.0 == 0 {
        return None;
    }
    unsafe {
        let hdr = lparam.0 as *const DEV_BROADCAST_HDR;
        if (*hdr).dbch_devicetype != DBT_DEVTYP_DEVICEINTERFACE {
            return None;
        }
        let iface = lparam.0 as *const DEV_BROADCAST_DEVICEINTERFACE_W;
        let name = windows::core::PWSTR((*iface).dbcc_name.as_ptr() as *mut u16);
        name.to_string().ok()
    }
}
