//! Windows：枚举顶层窗 Z-order、虚拟桌面几何、系统壁纸。

#![cfg(windows)]

use serde::Serialize;
use serde_json::{json, Value};
use std::ffi::OsString;
use std::os::windows::ffi::OsStringExt;
use windows::core::PWSTR;
use windows::Win32::Foundation::{BOOL, CloseHandle, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::Graphics::Gdi::{
    EnumDisplayMonitors, GetMonitorInfoW, HDC, HMONITOR, MONITORINFO,
};
use windows::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetClassNameW, GetSystemMetrics, GetWindowLongW, GetWindowRect,
    GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible,
    SystemParametersInfoW, GWL_EXSTYLE, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN, SM_XVIRTUALSCREEN,
    SM_YVIRTUALSCREEN, SPI_GETDESKWALLPAPER, SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS, WS_EX_TOOLWINDOW,
};

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct WinEntry {
    pub hwnd: u64,
    pub z: u32,
    pub title: String,
    pub class: String,
    pub bounds: [i32; 4],
    pub minimized: bool,
    pub pid: u32,
    pub exe: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct MonitorInfo {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
    pub primary: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct VirtualDesktop {
    pub x: i32,
    pub y: i32,
    pub w: i32,
    pub h: i32,
    pub monitors: Vec<MonitorInfo>,
}

struct EnumState {
    list: Vec<(HWND, u32)>,
}

unsafe extern "system" fn enum_proc(hwnd: HWND, lparam: LPARAM) -> BOOL {
    unsafe {
        let state = &mut *(lparam.0 as *mut EnumState);
        if IsWindowVisible(hwnd).as_bool() {
            let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
            if ex & WS_EX_TOOLWINDOW.0 != 0 {
                return BOOL(1);
            }
            let mut cloaked: u32 = 0;
            let _ = DwmGetWindowAttribute(
                hwnd,
                DWMWA_CLOAKED,
                &mut cloaked as *mut u32 as *mut _,
                std::mem::size_of::<u32>() as u32,
            );
            if cloaked != 0 {
                return BOOL(1);
            }
            let z = state.list.len() as u32;
            state.list.push((hwnd, z));
        }
        BOOL(1)
    }
}

fn wide_to_string(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    OsString::from_wide(&buf[..len])
        .to_string_lossy()
        .into_owned()
}

/// 是否按顶层可见窗跟踪（与枚举过滤一致：可见、非 ToolWindow、非 Cloaked）。
pub fn is_trackable_top_level(hwnd: HWND) -> bool {
    unsafe {
        if hwnd.0.is_null() || !IsWindowVisible(hwnd).as_bool() {
            return false;
        }
        let ex = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
        if ex & WS_EX_TOOLWINDOW.0 != 0 {
            return false;
        }
        let mut cloaked: u32 = 0;
        let _ = DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            &mut cloaked as *mut u32 as *mut _,
            std::mem::size_of::<u32>() as u32,
        );
        cloaked == 0
    }
}

/// 读取单个顶层窗的当前描述；不满足跟踪条件时返回 None。
pub fn describe_window(hwnd: HWND, z: u32) -> Option<WinEntry> {
    if !is_trackable_top_level(hwnd) {
        return None;
    }
    unsafe {
        let mut rect = RECT::default();
        if GetWindowRect(hwnd, &mut rect).is_err() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        Some(WinEntry {
            hwnd: hwnd.0 as usize as u64,
            z,
            title: window_title(hwnd),
            class: window_class(hwnd),
            bounds: [
                rect.left,
                rect.top,
                rect.right - rect.left,
                rect.bottom - rect.top,
            ],
            minimized: IsIconic(hwnd).as_bool(),
            pid,
            exe: process_exe(pid),
        })
    }
}

pub fn window_title(hwnd: HWND) -> String {
    unsafe {
        let len = GetWindowTextLengthW(hwnd);
        if len <= 0 {
            return String::new();
        }
        let mut buf = vec![0u16; (len + 1) as usize];
        let n = GetWindowTextW(hwnd, &mut buf);
        wide_to_string(&buf[..n as usize])
    }
}

pub fn window_class(hwnd: HWND) -> String {
    unsafe {
        let mut buf = [0u16; 256];
        let n = GetClassNameW(hwnd, &mut buf);
        wide_to_string(&buf[..n as usize])
    }
}

fn path_file_name(path: &str) -> String {
    path.rsplit(['\\', '/'])
        .next()
        .unwrap_or(path)
        .to_string()
}

pub fn process_exe(pid: u32) -> String {
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return String::new();
        };
        let mut buf = [0u16; 512];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut size,
        );
        let _ = CloseHandle(handle);
        if ok.is_err() {
            return String::new();
        }
        path_file_name(&wide_to_string(&buf[..size as usize]))
    }
}

pub fn process_exe_full(pid: u32) -> String {
    unsafe {
        let Ok(handle) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return String::new();
        };
        let mut buf = [0u16; 512];
        let mut size = buf.len() as u32;
        let ok = QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut size,
        );
        let _ = CloseHandle(handle);
        if ok.is_err() {
            return String::new();
        }
        wide_to_string(&buf[..size as usize])
    }
}

/// EnumWindows 顺序：先枚举到的更靠前（顶层）。
/// 仅作启动种子 / 调试；运行时由 win_state_hook 事件演绎维护。
pub fn snapshot_windows() -> Vec<WinEntry> {
    let mut state = EnumState { list: Vec::new() };
    unsafe {
        let _ = EnumWindows(Some(enum_proc), LPARAM(&mut state as *mut _ as isize));
    }
    let mut out = Vec::with_capacity(state.list.len());
    for (hwnd, z) in state.list {
        if let Some(e) = describe_window(hwnd, z) {
            out.push(e);
        }
    }
    out
}

struct MonitorCollect {
    list: Vec<MonitorInfo>,
}

unsafe extern "system" fn monitor_enum(
    monitor: HMONITOR,
    _hdc: HDC,
    _rect: *mut RECT,
    lparam: LPARAM,
) -> BOOL {
    unsafe {
        let state = &mut *(lparam.0 as *mut MonitorCollect);
        let mut info = MONITORINFO {
            cbSize: std::mem::size_of::<MONITORINFO>() as u32,
            ..Default::default()
        };
        if GetMonitorInfoW(monitor, &mut info).as_bool() {
            let r = info.rcMonitor;
            state.list.push(MonitorInfo {
                left: r.left,
                top: r.top,
                right: r.right,
                bottom: r.bottom,
                primary: info.dwFlags & 1 != 0,
            });
        }
        BOOL(1)
    }
}

pub fn virtual_desktop() -> VirtualDesktop {
    unsafe {
        let x = GetSystemMetrics(SM_XVIRTUALSCREEN);
        let y = GetSystemMetrics(SM_YVIRTUALSCREEN);
        let w = GetSystemMetrics(SM_CXVIRTUALSCREEN);
        let h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
        let mut state = MonitorCollect { list: Vec::new() };
        let _ = EnumDisplayMonitors(
            None,
            None,
            Some(monitor_enum),
            LPARAM(&mut state as *mut _ as isize),
        );
        VirtualDesktop {
            x,
            y,
            w,
            h,
            monitors: state.list,
        }
    }
}

pub fn system_wallpaper_path() -> Option<String> {
    unsafe {
        let mut buf = [0u16; 260];
        let ok = SystemParametersInfoW(
            SPI_GETDESKWALLPAPER,
            buf.len() as u32,
            Some(buf.as_mut_ptr() as *mut _),
            SYSTEM_PARAMETERS_INFO_UPDATE_FLAGS(0),
        );
        if ok.is_err() {
            return None;
        }
        let s = wide_to_string(&buf);
        if s.is_empty() {
            None
        } else {
            Some(s)
        }
    }
}

fn running_process_names() -> Vec<String> {
    let mut names = Vec::new();
    unsafe {
        let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
            return names;
        };
        let mut entry = PROCESSENTRY32W {
            dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
            ..Default::default()
        };
        if Process32FirstW(snap, &mut entry).is_ok() {
            loop {
                names.push(wide_to_string(&entry.szExeFile));
                if Process32NextW(snap, &mut entry).is_err() {
                    break;
                }
            }
        }
        let _ = CloseHandle(snap);
    }
    names
}

/// 启发式：是否在跑常见第三方动态壁纸软件（它们没有统一「读壁纸」接口）。
pub fn detect_third_party_wallpaper() -> Vec<String> {
    const NAMES: &[&str] = &[
        "wallpaper32.exe",
        "wallpaper64.exe",
        "lively.exe",
        "wallpapengine.exe",
        "deskscapes.exe",
        "rainwallpaper.exe",
    ];
    let procs = running_process_names();
    NAMES
        .iter()
        .filter(|n| {
            procs
                .iter()
                .any(|p| p.eq_ignore_ascii_case(n))
        })
        .map(|s| (*s).to_string())
        .collect()
}

pub fn display_and_wallpaper_payload() -> Value {
    let desk = virtual_desktop();
    let wallpaper = system_wallpaper_path();
    let third = detect_third_party_wallpaper();
    json!({
        "virtual": desk,
        "wallpaper_path": wallpaper,
        "wallpaper_source": if third.is_empty() { "windows" } else { "third_party_detected" },
        "third_party_wallpaper_apps": third,
        "note": "第三方动态壁纸无统一读取接口；仅记录系统 SPI 壁纸路径并标注检测结果"
    })
}
