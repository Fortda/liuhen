//! Windows 机体遥测：清单 / 链路事件 / 管家采样。
//! 非 Windows 编译为空实现（模组 start 会标 Unavailable）。

pub mod quantize;

#[cfg(windows)]
mod win;

#[cfg(windows)]
pub use win::{BodyRuntime, OutEvent};

#[cfg(not(windows))]
pub struct BodyRuntime;

#[cfg(not(windows))]
impl BodyRuntime {
    pub fn start() -> Result<Self, String> {
        Err("body 仅支持 Windows".into())
    }
}

#[cfg(not(windows))]
pub struct OutEvent {
    pub ts: u64,
    pub kind: String,
    pub payload: serde_json::Value,
}
