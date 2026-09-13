//! 轻量网络连接/端口快照（GetExtendedTcpTable / GetExtendedUdpTable）。

#[cfg(windows)]
mod win;

#[derive(Debug, Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ConnEntry {
    pub proto: &'static str,
    pub local: String,
    pub remote: String,
    pub state: &'static str,
    pub pid: u32,
}

impl ConnEntry {
    pub fn key(&self) -> String {
        format!(
            "{}|{}|{}|{}|{}",
            self.proto, self.local, self.remote, self.state, self.pid
        )
    }
}

/// 采集当前 TCP/UDP 连接表（IPv4 + IPv6）。
pub fn snapshot() -> Result<Vec<ConnEntry>, String> {
    #[cfg(windows)]
    {
        win::snapshot_all()
    }
    #[cfg(not(windows))]
    {
        Err("network 端口采集仅支持 Windows".into())
    }
}
