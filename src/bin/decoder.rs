use chrono::{Datelike, Local};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, ErrorKind};
use std::thread::sleep;
use std::time::Duration;

fn main() {
    let now = Local::now();
    // 💡 自动寻找今天的日志文件！
    let filename = format!("mousedata/{:04}/{:02}/trace_{:02}.bin", now.year(), now.month(), now.day());
    let mut file = File::open(&filename).expect("找不到今天的数据文件！");
    
    let mut buffer = [0u8; 1];
    println!("📡 OmniTrace V2 解码器监听中 (按 Ctrl+C 停止)...\n");
    
    loop {
        match file.read_exact(&mut buffer) {
            Ok(_) => {
                let marker = buffer[0];
                
                if marker == 0xFF { // 【绝对锚点】
                    let mut payload = [0u8; 12];
                    if let Err(e) = file.read_exact(&mut payload) {
                        if e.kind() == ErrorKind::UnexpectedEof {
                            file.seek(SeekFrom::Current(-1)).unwrap();
                            sleep(Duration::from_millis(100));
                            continue;
                        }
                    }
                    let mut ts_buf = [0u8; 8]; let mut x_buf = [0u8; 2]; let mut y_buf = [0u8; 2];
                    ts_buf.copy_from_slice(&payload[0..8]); x_buf.copy_from_slice(&payload[8..10]); y_buf.copy_from_slice(&payload[10..12]);
                    let ts = u64::from_be_bytes(ts_buf);
                    let x = i16::from_be_bytes(x_buf);
                    let y = i16::from_be_bytes(y_buf);
                    println!("\n[⭐ 绝对锚点] 时间戳: {}, 初始坐标: (X: {}, Y: {})", ts, x, y);
                } 
                else if marker == 0xFE { // 【点击事件】
                    let mut payload = [0u8; 3];
                    if let Err(e) = file.read_exact(&mut payload) {
                        if e.kind() == ErrorKind::UnexpectedEof {
                            file.seek(SeekFrom::Current(-1)).unwrap();
                            sleep(Duration::from_millis(100));
                            continue;
                        }
                    }
                    let dt = payload[0];
                    let btn = payload[1];
                    let action = if payload[2] == 1 { "按下🔻" } else { "松开🔺" };
                    let btn_name = match btn { 1=>"左键", 2=>"右键", 3=>"中键", _=>"侧键/其他" };
                    println!("  🔴 [鼠标点击] +{:02}ms, {} {}", dt, btn_name, action);
                }
                else if marker == 0xFD { // 【滚轮事件】
                    let mut payload = [0u8; 3];
                    if let Err(e) = file.read_exact(&mut payload) {
                        if e.kind() == ErrorKind::UnexpectedEof {
                            file.seek(SeekFrom::Current(-1)).unwrap();
                            sleep(Duration::from_millis(100));
                            continue;
                        }
                    }
                    let dt = payload[0];
                    let scroll_x = payload[1] as i8;
                    let scroll_y = payload[2] as i8;
                    println!("  ⚙️ [滚轮滚动] +{:02}ms, 位移: (dx: {}, dy: {})", dt, scroll_x, scroll_y);
                }
                else { // 【轨迹微调】
                    let dt = marker; 
                    let mut payload = [0u8; 2];
                    if let Err(e) = file.read_exact(&mut payload) {
                        if e.kind() == ErrorKind::UnexpectedEof {
                            file.seek(SeekFrom::Current(-1)).unwrap();
                            sleep(Duration::from_millis(100));
                            continue;
                        }
                    }
                    let dx = payload[0] as i8;
                    let dy = payload[1] as i8;
                    println!("  ├── [轨迹微调] +{:02}ms, 位移: (dx: {:>3}, dy: {:>3})", dt, dx, dy);
                }

            }
            Err(e) if e.kind() == ErrorKind::UnexpectedEof => { sleep(Duration::from_millis(100)); }
            Err(e) => panic!("读取严重错误: {}", e),
        }
    }
}