//! 键鼠物理流：全局钩子 + 有损相对压缩二进制（零假设：记真实坐标/时间，不臆造语义）。
//!
//! 文件：`OmniDatabase/EventData/.../trace_DD.bin`
//! 这是「插件」在进程内开的后台线程，不是第二个 exe。

use chrono::{Datelike, Local};
use rdev::{listen, Button, Event, EventType, Key};
use std::fs::{create_dir_all, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread::{self, JoinHandle};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::paths::{data_root, ensure_dir};

struct EventData {
    timestamp: u64,
    event_type: u8,
    val1: i16,
    val2: i16,
}

fn button_to_u8(btn: Button) -> u8 {
    match btn {
        Button::Left => 1,
        Button::Right => 2,
        Button::Middle => 3,
        Button::Unknown(x) => x,
    }
}

/// rdev `Unknown` 内若已是 Windows VK（1..=255），透传；否则落 999。
fn unknown_key_to_vk(v: u32) -> u16 {
    if (1..=0xFF).contains(&v) {
        v as u16
    } else {
        999
    }
}

/// 写入 bin 的键码：字母/数字用 ASCII，其它尽量对齐 Windows VK。`Function` 与无效 `Unknown` 为 999。
fn key_to_u16(key: Key) -> u16 {
    match key {
        Key::Backspace => 8,
        Key::Tab => 9,
        Key::Return => 13,
        Key::ShiftLeft => 160,
        Key::ShiftRight => 161,
        Key::ControlLeft => 162,
        Key::ControlRight => 163,
        Key::Alt => 164,
        Key::AltGr => 165,
        Key::Pause => 19,
        Key::CapsLock => 20,
        Key::Escape => 27,
        Key::Space => 32,
        Key::PageUp => 33,
        Key::PageDown => 34,
        Key::End => 35,
        Key::Home => 36,
        Key::LeftArrow => 37,
        Key::UpArrow => 38,
        Key::RightArrow => 39,
        Key::DownArrow => 40,
        Key::Insert => 45,
        Key::Delete => 46,
        Key::Num0 => 48,
        Key::Num1 => 49,
        Key::Num2 => 50,
        Key::Num3 => 51,
        Key::Num4 => 52,
        Key::Num5 => 53,
        Key::Num6 => 54,
        Key::Num7 => 55,
        Key::Num8 => 56,
        Key::Num9 => 57,
        Key::KeyA => 65,
        Key::KeyB => 66,
        Key::KeyC => 67,
        Key::KeyD => 68,
        Key::KeyE => 69,
        Key::KeyF => 70,
        Key::KeyG => 71,
        Key::KeyH => 72,
        Key::KeyI => 73,
        Key::KeyJ => 74,
        Key::KeyK => 75,
        Key::KeyL => 76,
        Key::KeyM => 77,
        Key::KeyN => 78,
        Key::KeyO => 79,
        Key::KeyP => 80,
        Key::KeyQ => 81,
        Key::KeyR => 82,
        Key::KeyS => 83,
        Key::KeyT => 84,
        Key::KeyU => 85,
        Key::KeyV => 86,
        Key::KeyW => 87,
        Key::KeyX => 88,
        Key::KeyY => 89,
        Key::KeyZ => 90,
        Key::MetaLeft => 91,
        Key::MetaRight => 92,
        Key::Kp0 => 96,
        Key::Kp1 => 97,
        Key::Kp2 => 98,
        Key::Kp3 => 99,
        Key::Kp4 => 100,
        Key::Kp5 => 101,
        Key::Kp6 => 102,
        Key::Kp7 => 103,
        Key::Kp8 => 104,
        Key::Kp9 => 105,
        Key::KpMultiply => 106,
        Key::KpPlus => 107,
        Key::KpMinus => 109,
        Key::KpDelete => 110,
        Key::KpDivide => 111,
        Key::F1 => 112,
        Key::F2 => 113,
        Key::F3 => 114,
        Key::F4 => 115,
        Key::F5 => 116,
        Key::F6 => 117,
        Key::F7 => 118,
        Key::F8 => 119,
        Key::F9 => 120,
        Key::F10 => 121,
        Key::F11 => 122,
        Key::F12 => 123,
        Key::NumLock => 144,
        Key::ScrollLock => 145,
        Key::SemiColon => 186,
        Key::Equal => 187,
        Key::Comma => 188,
        Key::Minus => 189,
        Key::Dot => 190,
        Key::Slash => 191,
        Key::Quote => 222,
        Key::BackQuote => 192,
        Key::LeftBracket => 219,
        Key::BackSlash => 220,
        Key::IntlBackslash => 226,
        Key::RightBracket => 221,
        Key::PrintScreen => 44,
        Key::KpReturn => 13,
        Key::Function => 999,
        Key::Unknown(v) => unknown_key_to_vk(v),
    }
}

fn event_dir_for(now: chrono::DateTime<Local>) -> PathBuf {
    let century = (now.year() / 100) + 1;
    data_root()
        .join("EventData")
        .join(format!("Century_{:08}", century))
        .join(format!("Year_{:04}", now.year()))
        .join(format!("Month_{:02}", now.month()))
}

/// 在进程内启动：写盘线程 + 钩子线程。`running` 置 false 后钩子仍可能阻塞到下一次事件。
pub fn spawn_input_capture(running: Arc<AtomicBool>) -> Result<JoinHandle<()>, String> {
    let (tx, rx) = mpsc::channel::<EventData>();
    let running_writer = running.clone();

    thread::spawn(move || {
        let mut current_day = 0u32;
        let mut writer: Option<BufWriter<File>> = None;
        let mut last_ts: u64 = 0;
        let mut last_x: i16 = 0;
        let mut last_y: i16 = 0;

        while running_writer.load(Ordering::SeqCst) {
            let data = match rx.recv_timeout(std::time::Duration::from_millis(200)) {
                Ok(d) => d,
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            };

            let now_local = Local::now();
            let today = now_local.day();
            if today != current_day {
                if let Some(mut w) = writer.take() {
                    let _ = w.flush();
                }
                let dir = event_dir_for(now_local);
                ensure_dir(&dir);
                create_dir_all(&dir).ok();
                let filename = dir.join(format!("trace_{:02}.bin", today));
                let file = OpenOptions::new()
                    .create(true)
                    .append(true)
                    .open(&filename)
                    .expect("打开 trace bin 失败");
                writer = Some(BufWriter::with_capacity(64 * 1024, file));
                current_day = today;
                last_ts = 0;
            }

            let Some(ref mut w) = writer else { continue };
            let dt = if last_ts == 0 {
                0
            } else {
                data.timestamp.saturating_sub(last_ts)
            };

            if data.event_type == 0 {
                let dx = data.val1 as i32 - last_x as i32;
                let dy = data.val2 as i32 - last_y as i32;
                if last_ts == 0 || dt > 1000 || dt > 250 || dx < -128 || dx > 127 || dy < -128 || dy > 127
                {
                    let _ = w.write_all(&[0xFF]);
                    let _ = w.write_all(&data.timestamp.to_be_bytes());
                    let _ = w.write_all(&data.val1.to_be_bytes());
                    let _ = w.write_all(&data.val2.to_be_bytes());
                } else {
                    let _ = w.write_all(&[dt as u8, dx as i8 as u8, dy as i8 as u8]);
                }
                last_x = data.val1;
                last_y = data.val2;
            } else if data.event_type == 1 || data.event_type == 2 {
                let dt_safe = if dt > 250 { 250 } else { dt as u8 };
                let _ = w.write_all(&[0xFE, dt_safe, data.val1 as u8, data.event_type]);
            } else if data.event_type == 3 {
                let dt_safe = if dt > 250 { 250 } else { dt as u8 };
                let _ = w.write_all(&[
                    0xFD,
                    dt_safe,
                    data.val1 as i8 as u8,
                    data.val2 as i8 as u8,
                ]);
            } else if data.event_type == 4 || data.event_type == 5 {
                let dt_safe = if dt > 250 { 250 } else { dt as u8 };
                let marker = if data.event_type == 4 { 0xFC } else { 0xFB };
                let _ = w.write_all(&[marker, dt_safe]);
                let _ = w.write_all(&data.val1.to_be_bytes());
            }
            last_ts = data.timestamp;
            let _ = w.flush();
        }
    });

    let handle = thread::Builder::new()
        .name("input-hook".into())
        .spawn(move || {
            let running_hook = running.clone();
            let callback = move |event: Event| {
                if !running_hook.load(Ordering::SeqCst) {
                    return;
                }
                let ts = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                match event.event_type {
                    EventType::MouseMove { x, y } => {
                        let _ = tx.send(EventData {
                            timestamp: ts,
                            event_type: 0,
                            val1: x as i16,
                            val2: y as i16,
                        });
                    }
                    EventType::ButtonPress(btn) => {
                        let _ = tx.send(EventData {
                            timestamp: ts,
                            event_type: 1,
                            val1: button_to_u8(btn) as i16,
                            val2: 0,
                        });
                    }
                    EventType::ButtonRelease(btn) => {
                        let _ = tx.send(EventData {
                            timestamp: ts,
                            event_type: 2,
                            val1: button_to_u8(btn) as i16,
                            val2: 0,
                        });
                    }
                    EventType::Wheel { delta_x, delta_y } => {
                        let _ = tx.send(EventData {
                            timestamp: ts,
                            event_type: 3,
                            val1: delta_x as i16,
                            val2: delta_y as i16,
                        });
                    }
                    EventType::KeyPress(key) => {
                        let _ = tx.send(EventData {
                            timestamp: ts,
                            event_type: 4,
                            val1: key_to_u16(key) as i16,
                            val2: 0,
                        });
                    }
                    EventType::KeyRelease(key) => {
                        let _ = tx.send(EventData {
                            timestamp: ts,
                            event_type: 5,
                            val1: key_to_u16(key) as i16,
                            val2: 0,
                        });
                    }
                }
            };
            if let Err(e) = listen(callback) {
                eprintln!("[input] 钩子结束/错误: {:?}", e);
            }
        })
        .map_err(|e| e.to_string())?;

    Ok(handle)
}
