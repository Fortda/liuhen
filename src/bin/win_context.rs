use active_win_pos_rs::get_active_window;
use chrono::{Datelike, Local};
use std::fs::OpenOptions;
use std::io::Write;
use std::thread::sleep;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn main() {
    println!("🪟 OmniTrace [OS窗口雷达 V3 - 焦点防丢版] 已启动！(按 Ctrl+C 停止)");

    let mut last_window_title = String::new();
    let mut last_bounds = (0, 0, 0, 0); 

    loop {
        // 💡 架构升级：统一萃取数据！把 Ok 和 Err 两种情况，都变成统一的格式
        let (app_name, current_title, x, y, w, h) = match get_active_window() {
            Ok(win) => (
                win.app_name,
                win.title,
                win.position.x as i32,
                win.position.y as i32,
                win.position.width as i32,
                win.position.height as i32,
            ),
            Err(()) => (
                // 当窗口关闭、焦点掉入虚空时，我们不跳过，而是给它一个占位符！
                String::from("System"),
                String::from("[桌面或失去焦点]"), 
                0, 0, 0, 0,
            ),
        };

        let current_bounds = (x, y, w, h);

        // 判定核心逻辑依然不变：名字变了，或者位置变了，就记录！
        if current_title != last_window_title || current_bounds != last_bounds {
            let ts = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;

            let log_entry = format!(
                "{{\"ts\": {}, \"app\": \"{}\", \"title\": \"{}\", \"bounds\": [{}, {}, {}, {}]}}\n",
                ts, app_name, current_title, x, y, w, h
            );

            let now = Local::now();
            let year = now.year();
            let month = now.month();
            let century = (year / 100) + 1; 
            
            let dir_path = format!("OmniDatabase/ContextData/Century_{:08}/Year_{:04}/Month_{:02}", century, year, month);
            std::fs::create_dir_all(&dir_path).expect("创建 ContextData 世纪文件夹失败");
            
            let filename = format!("{}/win_context_{:02}.jsonl", dir_path, now.day());
            let mut file = OpenOptions::new().create(true).append(true).open(filename).unwrap();
            
            file.write_all(log_entry.as_bytes()).unwrap();
            
            println!("🎯 [状态更新] {} -> [{}] (位置: {},{} 尺寸: {}x{})", ts, current_title, x, y, w, h);

            last_window_title = current_title;
            last_bounds = current_bounds;
        }
        
        sleep(Duration::from_millis(500));
    }
}