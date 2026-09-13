//! Windows 设置快照钩子：启动全量检测，变更时打日志。
//! 个性化（多屏壁纸等）与其它 HKCU 设置都往这里挂 probe。

#![cfg(windows)]

use crate::shell;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use windows::core::PCWSTR;
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{
    RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY_CURRENT_USER, KEY_READ, REG_DWORD,
    REG_SZ, REG_VALUE_TYPE,
};

/// 单个设置探针：返回稳定指纹 + 可读快照。
pub trait SettingProbe: Send {
    fn id(&self) -> &'static str;
    fn group(&self) -> &'static str;
    fn snapshot(&self) -> (String, Value);
}

struct DisplayTopologyProbe;
struct WallpaperPersonalizeProbe;
struct ThemePersonalizeProbe;

impl SettingProbe for DisplayTopologyProbe {
    fn id(&self) -> &'static str {
        "display.topology"
    }
    fn group(&self) -> &'static str {
        "display"
    }
    fn snapshot(&self) -> (String, Value) {
        let desk = crate::win_enum::virtual_desktop();
        let monitors: Vec<Value> = desk
            .monitors
            .iter()
            .enumerate()
            .map(|(i, m)| {
                let w = (m.right - m.left).max(0);
                let h = (m.bottom - m.top).max(0);
                json!({
                    "index": i,
                    "primary": m.primary,
                    "bounds": [m.left, m.top, m.right, m.bottom],
                    "width": w,
                    "height": h,
                    "resolution": format!("{w}x{h}")
                })
            })
            .collect();
        let sig = format!(
            "{}|{}x{}@{},{}|{}",
            desk.monitors.len(),
            desk.w,
            desk.h,
            desk.x,
            desk.y,
            desk.monitors
                .iter()
                .map(|m| format!(
                    "{}:{}:{}:{}:{}",
                    m.left, m.top, m.right, m.bottom, m.primary as u8
                ))
                .collect::<Vec<_>>()
                .join(";")
        );
        (
            sig,
            json!({
                "monitor_count": desk.monitors.len(),
                "virtual": { "x": desk.x, "y": desk.y, "w": desk.w, "h": desk.h },
                "monitors": monitors
            }),
        )
    }
}

impl SettingProbe for WallpaperPersonalizeProbe {
    fn id(&self) -> &'static str {
        "personalize.wallpaper"
    }
    fn group(&self) -> &'static str {
        "personalize"
    }
    fn snapshot(&self) -> (String, Value) {
        let report = shell::desktop_wallpaper_report();
        let sig = report
            .get("sig")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        (sig, report)
    }
}

impl SettingProbe for ThemePersonalizeProbe {
    fn id(&self) -> &'static str {
        "personalize.theme"
    }
    fn group(&self) -> &'static str {
        "personalize"
    }
    fn snapshot(&self) -> (String, Value) {
        let apps_light = reg_dword(
            r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
            "AppsUseLightTheme",
        );
        let system_light = reg_dword(
            r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
            "SystemUsesLightTheme",
        );
        let transparency = reg_dword(
            r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
            "EnableTransparency",
        );
        let color_prevalence = reg_dword(
            r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize",
            "ColorPrevalence",
        );
        let accent = reg_dword(r"Software\Microsoft\Windows\DWM", "AccentColor");
        let payload = json!({
            "apps_use_light_theme": apps_light,
            "system_uses_light_theme": system_light,
            "enable_transparency": transparency,
            "color_prevalence": color_prevalence,
            "accent_color": accent
        });
        let sig = format!(
            "light={:?}/{:?};trans={:?};prev={:?};accent={:?}",
            apps_light, system_light, transparency, color_prevalence, accent
        );
        (sig, payload)
    }
}

fn reg_dword(subkey: &str, name: &str) -> Option<u32> {
    unsafe {
        let mut hkey = std::mem::zeroed();
        let sub = wide(subkey);
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
        let name_w = wide(name);
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

#[allow(dead_code)]
fn reg_sz(subkey: &str, name: &str) -> Option<String> {
    unsafe {
        let mut hkey = std::mem::zeroed();
        let sub = wide(subkey);
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
        let mut size = 0u32;
        let name_w = wide(name);
        let _ = RegQueryValueExW(
            hkey,
            PCWSTR(name_w.as_ptr()),
            None,
            Some(&mut kind as *mut REG_VALUE_TYPE),
            None,
            Some(&mut size),
        );
        if size == 0 || kind != REG_SZ {
            let _ = RegCloseKey(hkey);
            return None;
        }
        let mut buf = vec![0u16; (size as usize / 2).max(1)];
        let mut size2 = size;
        let ok = RegQueryValueExW(
            hkey,
            PCWSTR(name_w.as_ptr()),
            None,
            Some(&mut kind as *mut REG_VALUE_TYPE),
            Some(buf.as_mut_ptr().cast()),
            Some(&mut size2),
        );
        let _ = RegCloseKey(hkey);
        if ok != ERROR_SUCCESS {
            return None;
        }
        let nul = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
        Some(String::from_utf16_lossy(&buf[..nul]))
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

pub fn builtin_probes() -> Vec<Box<dyn SettingProbe>> {
    vec![
        Box::new(DisplayTopologyProbe),
        Box::new(WallpaperPersonalizeProbe),
        Box::new(ThemePersonalizeProbe),
    ]
}

/// 跑全部探针，返回 id → (sig, payload)
pub fn snapshot_all() -> BTreeMap<String, (String, Value)> {
    let mut out = BTreeMap::new();
    for p in builtin_probes() {
        let (sig, val) = p.snapshot();
        out.insert(
            p.id().to_string(),
            (
                sig,
                json!({
                    "group": p.group(),
                    "id": p.id(),
                    "data": val
                }),
            ),
        );
    }
    out
}
