//! 模拟量量化：死区比较用整数格，避免 RSSI/CPU 抖动刷盘。

pub fn quantize(v: f64, step: f64) -> i64 {
    if !v.is_finite() || step <= 0.0 {
        return 0;
    }
    (v / step).round() as i64
}

pub fn dequantize(q: i64, step: f64) -> f64 {
    q as f64 * step
}

pub const CPU_PCT_STEP: f64 = 2.0;
pub const TEMP_C_STEP: f64 = 1.0;
pub const RSSI_DBM_STEP: f64 = 3.0;
pub const SIGNAL_Q_STEP: f64 = 3.0;
pub const FAN_RPM_STEP: f64 = 50.0;
pub const FAN_PCT_STEP: f64 = 5.0;
pub const WATT_STEP: f64 = 1.0;
pub const MEM_MB_STEP: f64 = 64.0;
pub const DISK_BUSY_STEP: f64 = 5.0;
pub const LINK_MBPS_STEP: f64 = 10.0;
/// 网卡吞吐死区（B/s）；约 8 KB/s，避免空闲抖动刷盘。
pub const NET_BPS_STEP: f64 = 8_192.0;
/// 磁盘读写吞吐死区（B/s）；与网卡同量级，避免空闲抖动刷盘。
pub const DISK_IO_BPS_STEP: f64 = 8_192.0;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cpu_deadband_swallows_one_percent() {
        assert_eq!(quantize(11.0, CPU_PCT_STEP), quantize(12.4, CPU_PCT_STEP));
        assert_ne!(quantize(11.0, CPU_PCT_STEP), quantize(14.0, CPU_PCT_STEP));
    }

    #[test]
    fn rssi_step_is_three() {
        assert_eq!(quantize(-51.0, RSSI_DBM_STEP), quantize(-52.0, RSSI_DBM_STEP));
        assert_ne!(quantize(-51.0, RSSI_DBM_STEP), quantize(-56.0, RSSI_DBM_STEP));
    }
}
