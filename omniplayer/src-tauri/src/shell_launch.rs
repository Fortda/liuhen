//! 启动参数与笔记可摘窗（主窗 XOR 笔记窗）。
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

static LAUNCH_PAGE: Mutex<Option<String>> = Mutex::new(None);

const NOTES_LABEL: &str = "notes";

pub fn parse_cli_args() {
    let mut page: Option<String> = None;
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        if let Some(rest) = a.strip_prefix("--page=") {
            page = Some(normalize_page(rest));
        } else if a == "--page" {
            if let Some(v) = args.next() {
                page = Some(normalize_page(&v));
            }
        }
    }
    if let Ok(mut g) = LAUNCH_PAGE.lock() {
        *g = page;
    }
}

fn normalize_page(raw: &str) -> String {
    match raw.trim().to_ascii_lowercase().as_str() {
        "notes" | "note" => "notes".into(),
        "player" | "play" => "player".into(),
        "dashboard" | "dash" => "dashboard".into(),
        "settings" | "setting" => "settings".into(),
        other => other.to_string(),
    }
}

pub fn take_launch_page() -> Option<String> {
    LAUNCH_PAGE.lock().ok().and_then(|mut g| g.take())
}

pub fn peek_launch_page() -> Option<String> {
    LAUNCH_PAGE.lock().ok().and_then(|g| g.clone())
}

pub fn set_pending_page(page: &str) {
    if let Ok(mut g) = LAUNCH_PAGE.lock() {
        *g = Some(normalize_page(page));
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchInfo {
    pub page: Option<String>,
    pub shell: String,
    pub notes_undocked: bool,
}

fn notes_window_open(app: &AppHandle) -> bool {
    app.get_webview_window(NOTES_LABEL).is_some()
}

#[tauri::command]
pub fn shell_get_launch_info(app: AppHandle, window: WebviewWindow) -> LaunchInfo {
    let label = window.label().to_string();
    let shell = if label == NOTES_LABEL {
        "notes".into()
    } else {
        "full".into()
    };
    LaunchInfo {
        page: peek_launch_page(),
        shell,
        notes_undocked: notes_window_open(&app),
    }
}

#[tauri::command]
pub fn shell_consume_launch_page() -> Option<String> {
    take_launch_page()
}

fn notes_url() -> WebviewUrl {
    // Prefer hash so Vite/dev and production both resolve to index.html.
    WebviewUrl::App("index.html?shell=notes".into())
}

pub fn open_or_focus_notes_window(app: &AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(NOTES_LABEL) {
        let _ = w.unminimize();
        let _ = w.set_focus();
        let _ = w.show();
        let _ = app.emit("notes-dock-changed", serde_json::json!({ "undocked": true }));
        return Ok(());
    }
    let win = WebviewWindowBuilder::new(app, NOTES_LABEL, notes_url())
        .title("留痕 · Notes")
        .inner_size(980.0, 720.0)
        .min_inner_size(640.0, 480.0)
        .resizable(true)
        .maximizable(true)
        .decorations(false)
        .shadow(true)
        .center()
        .additional_browser_args(crate::webview_loopback::WEBVIEW_ADDITIONAL_BROWSER_ARGS)
        .build()
        .map_err(|e| e.to_string())?;
    let _ = win.set_focus();
    let app2 = app.clone();
    win.on_window_event(move |ev| {
        if let tauri::WindowEvent::Destroyed = ev {
            let _ = app2.emit(
                "notes-dock-changed",
                serde_json::json!({ "undocked": false }),
            );
        }
    });
    let _ = app.emit("notes-dock-changed", serde_json::json!({ "undocked": true }));
    Ok(())
}

#[tauri::command]
pub fn shell_open_notes_window(app: AppHandle) -> Result<(), String> {
    open_or_focus_notes_window(&app)
}

#[tauri::command]
pub fn shell_close_notes_window(app: AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(NOTES_LABEL) {
        w.close().map_err(|e| e.to_string())?;
    }
    let _ = app.emit(
        "notes-dock-changed",
        serde_json::json!({ "undocked": false }),
    );
    Ok(())
}

#[tauri::command]
pub fn shell_focus_main_window(app: AppHandle) -> Result<(), String> {
    let w = app
        .get_webview_window("main")
        .ok_or_else(|| "main window missing".to_string())?;
    let _ = w.unminimize();
    w.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

/// 第二次启动：把 argv 里的 --page= 转成事件，并前置对应窗口。
pub fn handle_second_instance(app: &AppHandle, argv: Vec<String>) {
    let mut page: Option<String> = None;
    let mut i = 0;
    while i < argv.len() {
        let a = &argv[i];
        if let Some(rest) = a.strip_prefix("--page=") {
            page = Some(normalize_page(rest));
        } else if a == "--page" {
            if let Some(v) = argv.get(i + 1) {
                page = Some(normalize_page(v));
                i += 1;
            }
        }
        i += 1;
    }
    if let Some(ref p) = page {
        set_pending_page(p);
    }
    let page_s = page.clone().unwrap_or_default();
    if page_s == "notes" {
        let _ = open_or_focus_notes_window(app);
    } else if let Some(main) = app.get_webview_window("main") {
        let _ = main.unminimize();
        let _ = main.set_focus();
        let _ = main.show();
    }
    let _ = app.emit(
        "shell-second-instance",
        serde_json::json!({ "page": page }),
    );
}
