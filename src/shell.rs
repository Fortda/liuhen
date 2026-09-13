//! 任务栏 / 壁纸 / 光标度量（Windows shell 外观相关）。

#![cfg(windows)]

use crate::paths::{data_root, ensure_dir};
use crate::win_enum::{
    detect_third_party_wallpaper, process_exe_full, snapshot_windows, system_wallpaper_path,
    virtual_desktop,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use windows::core::{w, PCWSTR, PWSTR};
use windows::Win32::Foundation::{BOOL, HINSTANCE, HWND, LPARAM, RECT};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
};
use windows::Win32::UI::Shell::{DesktopWallpaper, IDesktopWallpaper};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
};
use windows::Win32::UI::Shell::{
    SHAppBarMessage, ABE_BOTTOM, ABE_LEFT, ABE_RIGHT, ABE_TOP, ABM_GETTASKBARPOS, APPBARDATA,
};
use windows::Win32::UI::WindowsAndMessaging::{
    DestroyIcon, DrawIconEx, EnumChildWindows, FindWindowExW, FindWindowW, GetSystemMetrics,
    GetWindowRect, GetWindowTextW, IsWindowVisible, DI_NORMAL, HICON, SM_CXCURSOR, SM_CYCURSOR,
    SM_CXICON, SM_CYICON,
};

#[link(name = "shell32")]
unsafe extern "system" {
    fn ExtractIconW(h_inst: HINSTANCE, lpsz_exe: PCWSTR, n_icon_index: u32) -> isize;
}

#[derive(Debug, Clone, Serialize)]
pub struct TaskbarButton {
    pub title: String,
    pub bounds: [i32; 4],
    pub icon_rel: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TaskbarInfo {
    pub bounds: [i32; 4],
    pub edge: String,
    pub hwnd: u64,
    pub secondary: bool,
    pub buttons: Vec<TaskbarButton>,
}

fn null_hwnd() -> HWND {
    HWND(std::ptr::null_mut())
}

fn wide_to_string(buf: &[u16]) -> String {
    let len = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

fn window_text(hwnd: HWND) -> String {
    unsafe {
        let mut buf = [0u16; 512];
        let n = GetWindowTextW(hwnd, &mut buf);
        wide_to_string(&buf[..n as usize])
    }
}

fn edge_name(u: u32) -> &'static str {
    match u {
        x if x == ABE_LEFT as u32 => "left",
        x if x == ABE_TOP as u32 => "top",
        x if x == ABE_RIGHT as u32 => "right",
        x if x == ABE_BOTTOM as u32 => "bottom",
        _ => "bottom",
    }
}

fn rect_arr(r: RECT) -> [i32; 4] {
    [r.left, r.top, r.right - r.left, r.bottom - r.top]
}

fn find_task_list(tray: HWND) -> Option<HWND> {
    unsafe {
        let mut cur = tray;
        for class in [w!("ReBarWindow32"), w!("MSTaskSwWClass"), w!("MSTaskListWClass")] {
            cur = FindWindowExW(cur, null_hwnd(), class, PCWSTR::null()).ok()?;
        }
        Some(cur)
    }
}

struct ChildCollect {
    list: Vec<HWND>,
}

unsafe extern "system" fn enum_children(hwnd: HWND, lparam: LPARAM) -> BOOL {
    unsafe {
        let st = &mut *(lparam.0 as *mut ChildCollect);
        if IsWindowVisible(hwnd).as_bool() {
            st.list.push(hwnd);
        }
        BOOL(1)
    }
}

fn hash_str(s: &str) -> u64 {
    let mut h = DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

fn hicon_to_png_file(icon: HICON, path: &PathBuf) -> Result<(), String> {
    unsafe {
        let cx = GetSystemMetrics(SM_CXICON);
        let cy = GetSystemMetrics(SM_CYICON);
        let hdc = GetDC(null_hwnd());
        let mem = CreateCompatibleDC(hdc);
        let bmp = CreateCompatibleBitmap(hdc, cx, cy);
        let old = SelectObject(mem, HGDIOBJ(bmp.0));
        let _ = DrawIconEx(mem, 0, 0, icon, cx, cy, 0, None, DI_NORMAL);
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: cx,
                biHeight: -cy,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0 as u32,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels = vec![0u8; (cx * cy * 4) as usize];
        let got = GetDIBits(
            mem,
            bmp,
            0,
            cy as u32,
            Some(pixels.as_mut_ptr() as *mut _),
            &mut info,
            DIB_RGB_COLORS,
        );
        SelectObject(mem, old);
        let _ = DeleteObject(HGDIOBJ(bmp.0));
        let _ = DeleteDC(mem);
        ReleaseDC(null_hwnd(), hdc);
        if got == 0 {
            return Err("GetDIBits failed".into());
        }
        for chunk in pixels.chunks_exact_mut(4) {
            chunk.swap(0, 2);
        }
        let img = image::RgbaImage::from_raw(cx as u32, cy as u32, pixels)
            .ok_or_else(|| "bad rgba".to_string())?;
        img.save(path).map_err(|e| e.to_string())?;
        Ok(())
    }
}

fn extract_icon_from_exe(exe_path: &str, icon_dir: &PathBuf) -> Option<String> {
    if exe_path.is_empty() || !std::path::Path::new(exe_path).is_file() {
        return None;
    }
    ensure_dir(icon_dir);
    let name = format!("icon_{:x}.png", hash_str(exe_path));
    let dest = icon_dir.join(&name);
    if dest.is_file() {
        return Some(format!("icons/{}", name));
    }
    unsafe {
        let wide: Vec<u16> = exe_path.encode_utf16().chain(std::iter::once(0)).collect();
        let icon_raw = ExtractIconW(
            HINSTANCE(std::ptr::null_mut()),
            PCWSTR(wide.as_ptr()),
            0,
        );
        if icon_raw <= 1 {
            return None;
        }
        let icon = HICON(icon_raw as *mut _);
        let res = hicon_to_png_file(icon, &dest);
        let _ = DestroyIcon(icon);
        res.ok()?;
        Some(format!("icons/{}", name))
    }
}

fn collect_buttons(
    task_list: HWND,
    icon_dir: &PathBuf,
    exe_hints: &[(String, String)],
) -> Vec<TaskbarButton> {
    let mut st = ChildCollect { list: Vec::new() };
    unsafe {
        let _ = EnumChildWindows(task_list, Some(enum_children), LPARAM(&mut st as *mut _ as isize));
    }
    let mut buttons = Vec::new();
    for hwnd in st.list {
        let title = window_text(hwnd);
        if title.is_empty() {
            continue;
        }
        let mut rect = RECT::default();
        unsafe {
            if GetWindowRect(hwnd, &mut rect).is_err() {
                continue;
            }
        }
        let exe = exe_hints
            .iter()
            .find(|(t, _)| t == &title || title.contains(t) || t.contains(&title))
            .map(|(_, e)| e.clone())
            .unwrap_or_default();
        let icon_rel = extract_icon_from_exe(&exe, icon_dir);
        buttons.push(TaskbarButton {
            title,
            bounds: rect_arr(rect),
            icon_rel,
        });
    }
    buttons
}

fn snapshot_one_tray(
    tray: HWND,
    secondary: bool,
    icon_dir: &PathBuf,
    exe_hints: &[(String, String)],
) -> Option<TaskbarInfo> {
    unsafe {
        let mut rect = RECT::default();
        GetWindowRect(tray, &mut rect).ok()?;
        let mut abd = APPBARDATA {
            cbSize: std::mem::size_of::<APPBARDATA>() as u32,
            hWnd: tray,
            ..Default::default()
        };
        let _ = SHAppBarMessage(ABM_GETTASKBARPOS, &mut abd);
        let edge = edge_name(abd.uEdge);
        let buttons = find_task_list(tray)
            .map(|tl| collect_buttons(tl, icon_dir, exe_hints))
            .unwrap_or_default();
        Some(TaskbarInfo {
            bounds: rect_arr(rect),
            edge: edge.to_string(),
            hwnd: tray.0 as usize as u64,
            secondary,
            buttons,
        })
    }
}

pub fn snapshot_taskbars(exe_hints: &[(String, String)]) -> Vec<TaskbarInfo> {
    let icon_dir = data_root().join("ModuleData").join("win_map").join("icons");
    ensure_dir(&icon_dir);
    let mut out = Vec::new();
    unsafe {
        if let Ok(h) = FindWindowW(w!("Shell_TrayWnd"), PCWSTR::null()) {
            if let Some(info) = snapshot_one_tray(h, false, &icon_dir, exe_hints) {
                out.push(info);
            }
        }
        let mut sec = FindWindowExW(null_hwnd(), null_hwnd(), w!("Shell_SecondaryTrayWnd"), PCWSTR::null()).ok();
        while let Some(h) = sec {
            if let Some(info) = snapshot_one_tray(h, true, &icon_dir, exe_hints) {
                out.push(info);
            }
            sec = FindWindowExW(null_hwnd(), h, w!("Shell_SecondaryTrayWnd"), PCWSTR::null()).ok();
        }
    }
    out
}

pub fn build_exe_hints() -> Vec<(String, String)> {
    snapshot_windows()
        .into_iter()
        .filter_map(|w| {
            let full = process_exe_full(w.pid);
            if full.is_empty() {
                None
            } else {
                Some((w.title, full))
            }
        })
        .collect()
}

/// 系统指针在桌面像素里的目标尺寸。
/// 优先读「鼠标指针大小」相关注册表，否则回退 SM_CX/CYCURSOR。
pub fn cursor_metrics() -> (i32, i32) {
    let sm = unsafe { (GetSystemMetrics(SM_CXCURSOR), GetSystemMetrics(SM_CYCURSOR)) };
    // Win10/11：设置 → 蓝牙和设备 → 鼠标 → 其他鼠标选项 / 辅助功能指针大小
    // CursorBaseSize 单位近似屏幕像素
    let base = reg_cursor_base_size();
    let access = reg_accessibility_cursor_size(); // 1..=15
    let px = if let Some(b) = base {
        b.clamp(16, 256) as i32
    } else if let Some(level) = access {
        // 经验映射：1→16 … 默认约 4→32 … 15→128
        let t = (level.clamp(1, 15) as f32 - 1.0) / 14.0;
        (16.0 + t * (128.0 - 16.0)).round() as i32
    } else {
        sm.0.max(sm.1).clamp(16, 256)
    };
    (px, px)
}

fn reg_cursor_base_size() -> Option<u32> {
    reg_hkcu_dword(r"Control Panel\Cursors", "CursorBaseSize")
}

fn reg_accessibility_cursor_size() -> Option<u32> {
    reg_hkcu_dword(r"Software\Microsoft\Accessibility", "CursorSize")
}

fn reg_hkcu_dword(subkey: &str, name: &str) -> Option<u32> {
    use windows::Win32::Foundation::ERROR_SUCCESS;
    use windows::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY_CURRENT_USER, KEY_READ, REG_DWORD,
        REG_VALUE_TYPE,
    };
    unsafe {
        let mut hkey = std::mem::zeroed();
        let sub: Vec<u16> = subkey.encode_utf16().chain(std::iter::once(0)).collect();
        if RegOpenKeyExW(
            HKEY_CURRENT_USER,
            PCWSTR(sub.as_ptr()),
            0,
            KEY_READ,
            &mut hkey,
        ) != ERROR_SUCCESS
        {
            return None;
        }
        let mut kind = REG_VALUE_TYPE(0);
        let mut data = 0u32;
        let mut size = std::mem::size_of::<u32>() as u32;
        let name_w: Vec<u16> = name.encode_utf16().chain(std::iter::once(0)).collect();
        let ok = RegQueryValueExW(
            hkey,
            PCWSTR(name_w.as_ptr()),
            None,
            Some(&mut kind as *mut REG_VALUE_TYPE),
            Some((&mut data as *mut u32).cast()),
            Some(&mut size),
        );
        let _ = RegCloseKey(hkey);
        if ok == ERROR_SUCCESS && kind == REG_DWORD {
            Some(data)
        } else {
            None
        }
    }
}

pub fn display_shell_payload() -> Value {
    let report = desktop_wallpaper_report();
    let desk = virtual_desktop();
    let third = detect_third_party_wallpaper();
    let (cx, cy) = cursor_metrics();
    let sm = unsafe { (GetSystemMetrics(SM_CXCURSOR), GetSystemMetrics(SM_CYCURSOR)) };
    let monitors = report
        .get("monitors")
        .cloned()
        .unwrap_or_else(|| json!([]));
    json!({
        "virtual": desk,
        "monitor_count": desk.monitors.len(),
        "monitors": monitors,
        "wallpaper_path": report.get("primary_path").cloned().unwrap_or(Value::Null),
        "wallpaper_mode": report.get("wallpaper_mode").cloned().unwrap_or(json!("unknown")),
        "different_wallpapers": report.get("different_wallpapers").cloned().unwrap_or(json!(false)),
        "wallpaper_source": if third.is_empty() { "windows" } else { "third_party_detected" },
        "third_party_wallpaper_apps": third,
        "cursor_size": [cx, cy],
        "cursor_size_sm": [sm.0, sm.1],
        "cursor_base_size": reg_cursor_base_size(),
        "cursor_accessibility_size": reg_accessibility_cursor_size(),
        "note": "多屏分辨率 + 每屏壁纸；光标尺寸对齐系统指针设置（桌面像素）"
    })
}

/// 旧接口：仅路径。壁纸变更检测请用 [`wallpaper_content_sig`]。
pub fn wallpaper_sig() -> String {
    wallpaper_content_sig()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MonitorWallpaperState {
    key: String,
    sig: String,
    source_path: String,
    backup_rel: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct WallpaperStateFile {
    version: u32,
    same_all: bool,
    monitors: Vec<MonitorWallpaperState>,
}

#[derive(Debug, Clone)]
struct MonitorWallpaperLive {
    key: String,
    index: usize,
    primary: bool,
    left: i32,
    top: i32,
    right: i32,
    bottom: i32,
    width: i32,
    height: i32,
    device_path: String,
    path: String,
}

fn win_map_root() -> PathBuf {
    data_root().join("ModuleData").join("win_map")
}

fn wallpaper_state_path() -> PathBuf {
    win_map_root().join("wallpaper_state.json")
}

fn path_content_sig(path: &str) -> String {
    if path.is_empty() {
        return String::new();
    }
    match fs::metadata(path) {
        Ok(m) => {
            let modified = m
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
                .unwrap_or(0);
            format!("{}|{}|{}", path, m.len(), modified)
        }
        Err(_) => path.to_string(),
    }
}

/// 全桌面壁纸指纹（多屏拼接）。
pub fn wallpaper_content_sig() -> String {
    desktop_wallpaper_report()
        .get("sig")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn ensure_com() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
    }
}

unsafe fn pwstr_to_string(p: PWSTR) -> String {
    unsafe {
        if p.is_null() {
            return String::new();
        }
        let s = p.to_string().unwrap_or_default();
        CoTaskMemFree(Some(p.0 as *const _ as *const _));
        s
    }
}

fn collect_monitor_wallpapers() -> (Vec<MonitorWallpaperLive>, bool, String) {
    ensure_com();
    let desk = virtual_desktop();
    let mut lives: Vec<MonitorWallpaperLive> = Vec::new();
    let mut different = false;
    let mut mode = "spi_fallback".to_string();

    let com_ok = (|| -> windows::core::Result<()> {
        unsafe {
            let dw: IDesktopWallpaper =
                CoCreateInstance(&DesktopWallpaper, None, CLSCTX_ALL)?;
            // nullptr → 同壁纸 S_OK；每屏不同 S_FALSE（仍当成功）
            let common = dw.GetWallpaper(PCWSTR::null());
            match &common {
                Ok(p) => {
                    let s = pwstr_to_string(*p);
                    if s.is_empty() {
                        different = true;
                        mode = "per_monitor".into();
                    } else {
                        different = false;
                        mode = "same_all".into();
                    }
                }
                Err(_) => {
                    different = true;
                    mode = "per_monitor".into();
                }
            }

            let count = dw.GetMonitorDevicePathCount().unwrap_or(0);
            for i in 0..count {
                let id_pw = match dw.GetMonitorDevicePathAt(i) {
                    Ok(p) => p,
                    Err(_) => continue,
                };
                let device_path = pwstr_to_string(id_pw);
                if device_path.is_empty() {
                    continue;
                }
                let id_wide: Vec<u16> = device_path
                    .encode_utf16()
                    .chain(std::iter::once(0))
                    .collect();
                let rect = dw
                    .GetMonitorRECT(PCWSTR(id_wide.as_ptr()))
                    .unwrap_or(RECT::default());
                let wp_pw = dw
                    .GetWallpaper(PCWSTR(id_wide.as_ptr()))
                    .ok();
                let path = wp_pw
                    .map(|p| pwstr_to_string(p))
                    .unwrap_or_default();
                let w = (rect.right - rect.left).max(0);
                let h = (rect.bottom - rect.top).max(0);
                let primary = desk.monitors.iter().any(|m| {
                    m.primary
                        && m.left == rect.left
                        && m.top == rect.top
                        && m.right == rect.right
                        && m.bottom == rect.bottom
                });
                lives.push(MonitorWallpaperLive {
                    key: device_path.clone(),
                    index: i as usize,
                    primary,
                    left: rect.left,
                    top: rect.top,
                    right: rect.right,
                    bottom: rect.bottom,
                    width: w,
                    height: h,
                    device_path,
                    path,
                });
            }
        }
        Ok(())
    })();

    if com_ok.is_err() || lives.is_empty() {
        mode = "spi_fallback".into();
        different = false;
        lives.clear();
        for (i, m) in desk.monitors.iter().enumerate() {
            let path = system_wallpaper_path().unwrap_or_default();
            lives.push(MonitorWallpaperLive {
                key: format!("bounds:{}:{}:{}:{}", m.left, m.top, m.right, m.bottom),
                index: i,
                primary: m.primary,
                left: m.left,
                top: m.top,
                right: m.right,
                bottom: m.bottom,
                width: (m.right - m.left).max(0),
                height: (m.bottom - m.top).max(0),
                device_path: String::new(),
                path,
            });
        }
    } else {
        // 用路径集合再核验是否不同壁纸
        let paths: Vec<&str> = lives
            .iter()
            .map(|m| m.path.as_str())
            .filter(|p| !p.is_empty())
            .collect();
        if paths.len() >= 2 {
            let first = paths[0];
            if paths.iter().any(|p| *p != first) {
                different = true;
                mode = "per_monitor".into();
            }
        }
    }

    (lives, different, mode)
}

/// 个性化：多屏壁纸报告（供 display_setup / win_settings 共用）。
pub fn desktop_wallpaper_report() -> Value {
    let (lives, different, mode) = collect_monitor_wallpapers();
    let primary_path = lives
        .iter()
        .find(|m| m.primary)
        .map(|m| m.path.clone())
        .or_else(|| lives.first().map(|m| m.path.clone()))
        .filter(|s| !s.is_empty())
        .or_else(system_wallpaper_path);

    let monitors: Vec<Value> = lives
        .iter()
        .map(|m| {
            json!({
                "index": m.index,
                "primary": m.primary,
                "bounds": [m.left, m.top, m.right, m.bottom],
                "width": m.width,
                "height": m.height,
                "resolution": format!("{}x{}", m.width, m.height),
                "device_path": m.device_path,
                "wallpaper_path": if m.path.is_empty() { Value::Null } else { json!(m.path) },
                "sig": path_content_sig(&m.path)
            })
        })
        .collect();

    let sig = lives
        .iter()
        .map(|m| format!("{}@{}", m.key, path_content_sig(&m.path)))
        .collect::<Vec<_>>()
        .join("||");

    json!({
        "monitor_count": lives.len(),
        "different_wallpapers": different,
        "wallpaper_mode": mode,
        "primary_path": primary_path,
        "monitors": monitors,
        "sig": sig,
        "windows_supports_per_monitor_wallpaper": true
    })
}

fn load_wallpaper_state() -> Option<WallpaperStateFile> {
    let bytes = fs::read(wallpaper_state_path()).ok()?;
    // 兼容旧单文件 state
    if let Ok(v2) = serde_json::from_slice::<WallpaperStateFile>(&bytes) {
        return Some(v2);
    }
    #[derive(Deserialize)]
    struct Legacy {
        sig: String,
        source_path: String,
        backup_rel: String,
    }
    let leg: Legacy = serde_json::from_slice(&bytes).ok()?;
    Some(WallpaperStateFile {
        version: 1,
        same_all: true,
        monitors: vec![MonitorWallpaperState {
            key: "legacy".into(),
            sig: leg.sig,
            source_path: leg.source_path,
            backup_rel: leg.backup_rel,
        }],
    })
}

fn save_wallpaper_state(st: &WallpaperStateFile) {
    let root = win_map_root();
    ensure_dir(&root);
    if let Ok(bytes) = serde_json::to_vec_pretty(st) {
        let _ = fs::write(wallpaper_state_path(), bytes);
    }
}

fn backup_one_file(src: &str) -> Result<String, String> {
    let wall_dir = win_map_root().join("wallpapers");
    ensure_dir(&wall_dir);
    let ext = Path::new(src)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("img");
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let mut h: u64 = 2166136261;
    for b in src.as_bytes() {
        h = h.wrapping_mul(16777619) ^ (*b as u64);
    }
    let name = format!("wp_{ts}_{:x}.{ext}", h & 0xffff);
    let rel = format!("wallpapers/{name}");
    let dest = wall_dir.join(&name);
    fs::copy(src, &dest).map_err(|e| e.to_string())?;
    Ok(rel)
}

/// 多屏：变了才备份对应原图；没变只记 unchanged。
pub fn check_and_backup_wallpaper(change_reason: &str) -> Value {
    let (lives, different, mode) = collect_monitor_wallpapers();
    if lives.is_empty() {
        return json!({
            "changed": false,
            "reason": "no_wallpaper",
            "path": null,
            "different_wallpapers": false
        });
    }

    let prev = load_wallpaper_state();
    let mut any_changed = false;
    let mut out_monitors = Vec::new();
    let mut new_states = Vec::new();
    let mut path_backup_cache: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();

    for m in &lives {
        let sig = path_content_sig(&m.path);
        let prev_m = prev.as_ref().and_then(|st| {
            st.monitors
                .iter()
                .find(|x| x.key == m.key || (st.same_all && x.source_path == m.path))
        });

        let (changed, backup_rel, err) = if m.path.is_empty() {
            (false, None, None)
        } else if let Some(pm) = prev_m {
            let abs = win_map_root().join(&pm.backup_rel);
            if pm.sig == sig && abs.is_file() {
                path_backup_cache.insert(m.path.clone(), pm.backup_rel.clone());
                (false, Some(pm.backup_rel.clone()), None)
            } else if let Some(rel) = path_backup_cache.get(&m.path) {
                any_changed = true;
                (true, Some(rel.clone()), None)
            } else {
                match backup_one_file(&m.path) {
                    Ok(rel) => {
                        any_changed = true;
                        path_backup_cache.insert(m.path.clone(), rel.clone());
                        (true, Some(rel), None)
                    }
                    Err(e) => {
                        any_changed = true;
                        (true, None, Some(e))
                    }
                }
            }
        } else if let Some(rel) = path_backup_cache.get(&m.path) {
            any_changed = true;
            (true, Some(rel.clone()), None)
        } else {
            match backup_one_file(&m.path) {
                Ok(rel) => {
                    any_changed = true;
                    path_backup_cache.insert(m.path.clone(), rel.clone());
                    (true, Some(rel), None)
                }
                Err(e) => {
                    any_changed = true;
                    (true, None, Some(e))
                }
            }
        };

        if let Some(rel) = backup_rel.clone() {
            new_states.push(MonitorWallpaperState {
                key: m.key.clone(),
                sig: sig.clone(),
                source_path: m.path.clone(),
                backup_rel: rel.clone(),
            });
        }

        out_monitors.push(json!({
            "index": m.index,
            "primary": m.primary,
            "bounds": [m.left, m.top, m.right, m.bottom],
            "width": m.width,
            "height": m.height,
            "resolution": format!("{}x{}", m.width, m.height),
            "device_path": m.device_path,
            "path": if m.path.is_empty() { Value::Null } else { json!(m.path) },
            "backup_rel": backup_rel,
            "changed": changed,
            "backup_error": err
        }));
    }

    if any_changed || prev.is_none() {
        save_wallpaper_state(&WallpaperStateFile {
            version: 2,
            same_all: !different,
            monitors: new_states,
        });
    } else if let Some(st) = prev {
        // 未变更也刷新 state keys（避免仅 device path 变化丢备份引用）
        let _ = st;
    }

    let primary = out_monitors
        .iter()
        .find(|m| m.get("primary").and_then(|v| v.as_bool()) == Some(true))
        .cloned()
        .or_else(|| out_monitors.first().cloned());

    let sig = wallpaper_content_sig();
    json!({
        "changed": any_changed,
        "reason": if any_changed { change_reason } else { "unchanged" },
        "different_wallpapers": different,
        "wallpaper_mode": mode,
        "monitor_count": lives.len(),
        "path": primary.as_ref().and_then(|m| m.get("path").cloned()).unwrap_or(Value::Null),
        "backup_rel": primary.as_ref().and_then(|m| m.get("backup_rel").cloned()).unwrap_or(Value::Null),
        "monitors": out_monitors,
        "sig": sig,
        "windows_supports_per_monitor_wallpaper": true
    })
}
