//! L0 探针：CPU/内存/盘/电/网/设备清单。贵操作不在宿主 tick 里跑。

use super::nvml::Nvml;
use crate::body::quantize::{
    dequantize, quantize, CPU_PCT_STEP, DISK_BUSY_STEP, DISK_IO_BPS_STEP, FAN_PCT_STEP,
    LINK_MBPS_STEP, MEM_MB_STEP, NET_BPS_STEP, SIGNAL_Q_STEP, TEMP_C_STEP, WATT_STEP,
};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::mem::{size_of, zeroed};
use windows::core::{GUID, PCWSTR, PWSTR};
use windows::Win32::Devices::Bluetooth::{
    BluetoothFindDeviceClose, BluetoothFindFirstDevice, BluetoothFindFirstRadio,
    BluetoothFindNextDevice, BluetoothFindNextRadio, BluetoothFindRadioClose,
    BLUETOOTH_DEVICE_INFO, BLUETOOTH_DEVICE_SEARCH_PARAMS, BLUETOOTH_FIND_RADIO_PARAMS,
};
use windows::Win32::Devices::DeviceAndDriverInstallation::{
    SetupDiDestroyDeviceInfoList, SetupDiEnumDeviceInfo, SetupDiGetClassDevsW,
    SetupDiGetDeviceInstanceIdW, SetupDiGetDeviceRegistryPropertyW, DIGCF_PRESENT, HDEVINFO,
    SETUP_DI_REGISTRY_PROPERTY, SP_DEVINFO_DATA, SPDRP_DEVICEDESC, SPDRP_FRIENDLYNAME,
};
use windows::Win32::Devices::Display::{
    DisplayConfigGetDeviceInfo, GetDisplayConfigBufferSizes, QueryDisplayConfig,
    DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME, DISPLAYCONFIG_MODE_INFO, DISPLAYCONFIG_PATH_INFO,
    DISPLAYCONFIG_TARGET_DEVICE_NAME, QDC_ONLY_ACTIVE_PATHS,
};
use windows::Win32::Foundation::{
    BOOL, CloseHandle, ERROR_BUFFER_OVERFLOW, ERROR_SUCCESS, FILETIME, HANDLE,
};
use windows::Win32::Graphics::Dxgi::{CreateDXGIFactory1, IDXGIFactory1};
use windows::Win32::Media::Audio::{
    eConsole, eRender, IMMDevice, IMMDeviceEnumerator, MMDeviceEnumerator, DEVICE_STATE_ACTIVE,
};
use windows::Win32::NetworkManagement::IpHelper::{
    GetAdaptersAddresses, GetIfEntry2, GAA_FLAG_SKIP_ANYCAST, GAA_FLAG_SKIP_DNS_SERVER,
    GAA_FLAG_SKIP_MULTICAST, IF_TYPE_IEEE80211, IF_TYPE_SOFTWARE_LOOPBACK, IP_ADAPTER_ADDRESSES_LH,
    MIB_IF_ROW2,
};
use windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;
use windows::Win32::NetworkManagement::WiFi::{
    wlan_intf_opcode_current_connection, WlanCloseHandle, WlanEnumInterfaces, WlanFreeMemory,
    WlanOpenHandle, WlanQueryInterface, WLAN_CONNECTION_ATTRIBUTES, WLAN_INTERFACE_INFO_LIST,
};
use windows::Win32::Networking::WinSock::AF_UNSPEC;
use windows::Win32::Storage::FileSystem::{
    GetDiskFreeSpaceExW, GetDriveTypeW, GetLogicalDrives,
};
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_MULTITHREADED, STGM_READ,
};
use windows::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterValue,
    PdhOpenQueryW, PDH_FMT_COUNTERVALUE, PDH_FMT_DOUBLE,
};
use windows::Win32::System::Power::{
    CallNtPowerInformation, GetSystemPowerStatus, SystemBatteryState, SYSTEM_BATTERY_STATE,
    SYSTEM_POWER_STATUS,
};
use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
use windows::Win32::System::Threading::GetSystemTimes;
use windows::Win32::UI::Shell::PropertiesSystem::{IPropertyStore, PROPERTYKEY};

const CLASS_NET: GUID = GUID::from_u128(0x4d36e972_e325_11ce_bfc1_08002be10318);
const CLASS_MOUSE: GUID = GUID::from_u128(0x4d36e96f_e325_11ce_bfc1_08002be10318);
const CLASS_KEYBOARD: GUID = GUID::from_u128(0x4d36e96b_e325_11ce_bfc1_08002be10318);
const CLASS_HID: GUID = GUID::from_u128(0x745a17a0_74d3_11d0_b6fe_00a0c90f57da);
const CLASS_MONITOR: GUID = GUID::from_u128(0x4d36e96e_e325_11ce_bfc1_08002be10318);
const CLASS_MEDIA: GUID = GUID::from_u128(0x4d36e96c_e325_11ce_bfc1_08002be10318);
const CLASS_DISK: GUID = GUID::from_u128(0x4d36e967_e325_11ce_bfc1_08002be10318);
const CLASS_DISPLAY: GUID = GUID::from_u128(0x4d36e968_e325_11ce_bfc1_08002be10318);
const CLASS_BATTERY: GUID = GUID::from_u128(0x72631e54_78a4_11d0_bcf7_00aa00b7b32a);
const CLASS_BT: GUID = GUID::from_u128(0xe0cbf06c_cd8b_4647_bb8a_263b43f0f974);

pub fn com_init() {
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

pub fn com_uninit() {
    unsafe {
        CoUninitialize();
    }
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

unsafe fn pwstr_lossy(p: PWSTR) -> String {
    if p.is_null() {
        return String::new();
    }
    unsafe { p.to_string().unwrap_or_default() }
}

fn utf16z_to_string(buf: &[u16]) -> String {
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..end])
}

fn mac_str(bytes: &[u8]) -> String {
    bytes
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(":")
}

#[derive(Clone, Copy)]
pub struct CpuTimes {
    idle: u64,
    kernel: u64,
    user: u64,
}

impl CpuTimes {
    pub fn read() -> Option<Self> {
        unsafe {
            let mut idle = FILETIME::default();
            let mut kernel = FILETIME::default();
            let mut user = FILETIME::default();
            GetSystemTimes(
                Some(&mut idle as *mut FILETIME),
                Some(&mut kernel as *mut FILETIME),
                Some(&mut user as *mut FILETIME),
            ).ok()?;
            Some(Self {
                idle: ft_u64(idle),
                kernel: ft_u64(kernel),
                user: ft_u64(user),
            })
        }
    }

    pub fn percent_since(&self, prev: &Self) -> Option<f64> {
        let idle = self.idle.saturating_sub(prev.idle);
        let kernel = self.kernel.saturating_sub(prev.kernel);
        let user = self.user.saturating_sub(prev.user);
        let total = kernel.saturating_add(user);
        if total == 0 {
            return None;
        }
        let busy = total.saturating_sub(idle);
        Some((busy as f64) * 100.0 / (total as f64))
    }
}

fn ft_u64(ft: FILETIME) -> u64 {
    ((ft.dwHighDateTime as u64) << 32) | (ft.dwLowDateTime as u64)
}

pub struct PdhDisk {
    query: isize,
    disk: Option<isize>,
    disk_read: Option<isize>,
    disk_write: Option<isize>,
    meter: Option<isize>,
    primed: bool,
}

pub struct PdhSample {
    pub disk_busy: Option<f64>,
    /// PhysicalDisk(_Total) Disk Read Bytes/sec
    pub disk_read_bps: Option<f64>,
    /// PhysicalDisk(_Total) Disk Write Bytes/sec
    pub disk_write_bps: Option<f64>,
    pub meter_w: Option<f64>,
}

impl PdhDisk {
    pub fn open() -> Option<Self> {
        unsafe {
            let mut query: isize = 0;
            if PdhOpenQueryW(PCWSTR::null(), 0, &mut query) != 0 {
                return None;
            }
            let disk = add_counter(query, r"\PhysicalDisk(_Total)\% Disk Time");
            let disk_read = add_counter(query, r"\PhysicalDisk(_Total)\Disk Read Bytes/sec");
            let disk_write = add_counter(query, r"\PhysicalDisk(_Total)\Disk Write Bytes/sec");
            let meter = add_counter(query, r"\Power Meter(_Total)\Power")
                .or_else(|| add_counter(query, r"\Power Meter(*)\Power"));
            if disk.is_none()
                && disk_read.is_none()
                && disk_write.is_none()
                && meter.is_none()
            {
                let _ = PdhCloseQuery(query);
                return None;
            }
            let _ = PdhCollectQueryData(query);
            Some(Self {
                query,
                disk,
                disk_read,
                disk_write,
                meter,
                primed: false,
            })
        }
    }

    pub fn collect(&mut self) -> PdhSample {
        unsafe {
            if PdhCollectQueryData(self.query) != 0 {
                return PdhSample {
                    disk_busy: None,
                    disk_read_bps: None,
                    disk_write_bps: None,
                    meter_w: None,
                };
            }
            if !self.primed {
                self.primed = true;
                return PdhSample {
                    disk_busy: None,
                    disk_read_bps: None,
                    disk_write_bps: None,
                    meter_w: None,
                };
            }
            PdhSample {
                disk_busy: self.disk.and_then(read_pdh_f64),
                disk_read_bps: self.disk_read.and_then(read_pdh_f64),
                disk_write_bps: self.disk_write.and_then(read_pdh_f64),
                meter_w: self.meter.and_then(read_pdh_f64),
            }
        }
    }
}

fn add_counter(query: isize, path: &str) -> Option<isize> {
    unsafe {
        let mut counter: isize = 0;
        let w = wide(path);
        if PdhAddEnglishCounterW(query, PCWSTR(w.as_ptr()), 0, &mut counter) != 0 {
            None
        } else {
            Some(counter)
        }
    }
}

fn read_pdh_f64(counter: isize) -> Option<f64> {
    unsafe {
        let mut val = PDH_FMT_COUNTERVALUE::default();
        if PdhGetFormattedCounterValue(counter, PDH_FMT_DOUBLE, None, &mut val) != 0 {
            return None;
        }
        let v = val.Anonymous.doubleValue;
        if v.is_finite() {
            Some(v)
        } else {
            None
        }
    }
}

impl Drop for PdhDisk {
    fn drop(&mut self) {
        unsafe {
            let _ = PdhCloseQuery(self.query);
        }
    }
}

fn mem_status() -> Option<(u64, u64)> {
    unsafe {
        let mut s = MEMORYSTATUSEX {
            dwLength: size_of::<MEMORYSTATUSEX>() as u32,
            ..zeroed()
        };
        GlobalMemoryStatusEx(&mut s).ok()?;
        let total = s.ullTotalPhys / (1024 * 1024);
        let avail = s.ullAvailPhys / (1024 * 1024);
        Some((total, total.saturating_sub(avail)))
    }
}

fn disks() -> Vec<Value> {
    let mask = unsafe { GetLogicalDrives() };
    let mut out = Vec::new();
    for i in 0..26u32 {
        if mask & (1 << i) == 0 {
            continue;
        }
        let letter = (b'A' + i as u8) as char;
        let root = format!("{letter}:\\");
        let w = wide(&root);
        let dtype = unsafe { GetDriveTypeW(PCWSTR(w.as_ptr())) };
        if dtype != 3 {
            continue;
        }
        let mut free = 0u64;
        let mut total = 0u64;
        let ok = unsafe {
            GetDiskFreeSpaceExW(
                PCWSTR(w.as_ptr()),
                None,
                Some(&mut total),
                Some(&mut free),
            )
            .is_ok()
        };
        if !ok {
            continue;
        }
        out.push(json!({
            "id": format!("{letter}:"),
            "free_gb": (free / (1024 * 1024 * 1024)) as i64,
            "total_gb": (total / (1024 * 1024 * 1024)) as i64
        }));
    }
    out
}

fn power() -> Value {
    unsafe {
        let mut s = SYSTEM_POWER_STATUS::default();
        let gps_ok = GetSystemPowerStatus(&mut s).is_ok();
        let ac = if gps_ok {
            match s.ACLineStatus {
                0 => json!(false),
                1 => json!(true),
                _ => json!(null),
            }
        } else {
            json!(null)
        };
        let bat = if gps_ok && s.BatteryLifePercent <= 100 {
            json!(s.BatteryLifePercent)
        } else {
            json!(null)
        };

        let mut st = SYSTEM_BATTERY_STATE::default();
        let nt = CallNtPowerInformation(
            SystemBatteryState,
            None,
            0,
            Some((&mut st as *mut SYSTEM_BATTERY_STATE).cast()),
            size_of::<SYSTEM_BATTERY_STATE>() as u32,
        );
        let bat_ok = nt.is_ok();
        let present = bat_ok && st.BatteryPresent.0 != 0;
        let charging = bat_ok && st.Charging.0 != 0;
        let discharging = bat_ok && st.Discharging.0 != 0;
        let rate_mw = if present { st.Rate as i32 } else { 0 };
        json!({
            "ac": ac,
            "battery_pct": bat,
            "battery_present": present,
            "charging": charging,
            "discharging": discharging,
            "rate_mw": if present { json!(rate_mw) } else { json!(null) },
            "remain_mwh": if present { json!(st.RemainingCapacity) } else { json!(null) },
            "max_mwh": if present { json!(st.MaxCapacity) } else { json!(null) }
        })
    }
}

fn lhm_power_split(lhm: Option<&Value>) -> (Option<f64>, Option<f64>, Option<f64>) {
    let Some(arr) = lhm.and_then(|v| v.get("sensors")).and_then(|s| s.as_array()) else {
        return (None, None, None);
    };
    let mut sys = None;
    let mut cpu = None;
    let mut gpu = None;
    for s in arr {
        if s.get("t").and_then(|x| x.as_str()) != Some("power") {
            continue;
        }
        let n = s
            .get("n")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let Some(v) = s.get("v").and_then(|x| x.as_f64()) else {
            continue;
        };
        if !v.is_finite() || v <= 0.0 {
            continue;
        }
        if n.contains("psu")
            || n.contains("power supply")
            || n.contains("system")
            || n.contains("主板")
        {
            sys = Some(sys.map_or(v, |old: f64| old.max(v)));
        } else if n.contains("gpu") || n.contains("graphics") || n.contains("nvidia") {
            gpu = Some(gpu.unwrap_or(0.0) + v);
        } else if n.contains("package") || n.contains("cpu") {
            cpu = Some(cpu.map_or(v, |old: f64| old.max(v)));
        }
    }
    (sys, cpu, gpu)
}

fn dxgi_gpus() -> Vec<Value> {
    let mut out = Vec::new();
    unsafe {
        let factory: IDXGIFactory1 = match CreateDXGIFactory1() {
            Ok(f) => f,
            Err(_) => return out,
        };
        for i in 0..8u32 {
            let adapter = match factory.EnumAdapters1(i) {
                Ok(a) => a,
                Err(_) => break,
            };
            let desc = match adapter.GetDesc1() {
                Ok(d) => d,
                Err(_) => continue,
            };
            let name = utf16z_to_string(&desc.Description);
            if name.contains("Microsoft Basic") || name.contains("Remote") {
                continue;
            }
            out.push(json!({
                "name": name,
                "vendor": desc.VendorId,
                "device": desc.DeviceId,
                "vram_mb": (desc.DedicatedVideoMemory as u64) / (1024 * 1024)
            }));
        }
    }
    out
}

/// 单块网卡吞吐采样（已过滤隧道/环回）。
#[derive(Clone)]
pub struct TelecomAdapterSample {
    pub guid: String,
    pub name: String,
    pub media: String,
    pub up: bool,
    pub link_mbps: f64,
    pub signal_q: Option<f64>,
    /// 量化后的入站 B/s（死区 NET_BPS_STEP）。
    pub in_bps_q: i64,
    /// 量化后的出站 B/s。
    pub out_bps_q: i64,
}

/// 跨拍差分 In/OutOctets → B/s。
pub struct NicRateTracker {
    prev: HashMap<String, (u64, u64, u64)>,
}

impl NicRateTracker {
    pub fn new() -> Self {
        Self {
            prev: HashMap::new(),
        }
    }

    pub fn sample(&mut self, now_ms: u64) -> Vec<TelecomAdapterSample> {
        let mut out = Vec::new();
        let mut seen = HashMap::new();
        for a in iter_adapters() {
            if a.tunnel || a.if_type == IF_TYPE_SOFTWARE_LOOPBACK {
                continue;
            }
            let media = if a.if_type == IF_TYPE_IEEE80211 {
                "wifi"
            } else {
                "ethernet"
            };
            let (in_bps, out_bps) = if let Some((pin, pout, pts)) = self.prev.get(&a.guid) {
                let dt_ms = now_ms.saturating_sub(*pts).max(1);
                let dt = dt_ms as f64 / 1000.0;
                let din = a.in_octets.wrapping_sub(*pin) as f64 / dt;
                let dout = a.out_octets.wrapping_sub(*pout) as f64 / dt;
                (din, dout)
            } else {
                (0.0, 0.0)
            };
            seen.insert(a.guid.clone(), (a.in_octets, a.out_octets, now_ms));
            out.push(TelecomAdapterSample {
                guid: a.guid,
                name: a.name,
                media: media.into(),
                up: a.up,
                link_mbps: a.mbps,
                signal_q: a.signal_q,
                in_bps_q: quantize(in_bps, NET_BPS_STEP),
                out_bps_q: quantize(out_bps, NET_BPS_STEP),
            });
        }
        self.prev = seen;
        out
    }
}

pub struct HkFrame {
    cpu_q: Option<i64>,
    mem_used_q: Option<i64>,
    mem_total_q: Option<i64>,
    disk_busy_q: Option<i64>,
    disk_read_q: Option<i64>,
    disk_write_q: Option<i64>,
    disks: Vec<Value>,
    eps: Value,
    gpus: Vec<Value>,
    nvml_q: Vec<(i64, i64, i64, i64)>,
    telecom: Vec<TelecomAdapterSample>,
    pub tcs_lhm: Option<Value>,
    meter_w: Option<f64>,
    watts_q: Option<i64>,
}

impl HkFrame {
    pub fn sample(
        cpu_pct: Option<f64>,
        pdh: Option<&mut PdhDisk>,
        nic: &mut NicRateTracker,
        now_ms: u64,
    ) -> Self {
        let (mem_total, mem_used) = mem_status().unwrap_or((0, 0));
        let pdh_s = pdh.map(|p| p.collect());
        let disk_busy = pdh_s.as_ref().and_then(|s| s.disk_busy);
        let disk_read = pdh_s.as_ref().and_then(|s| s.disk_read_bps);
        let disk_write = pdh_s.as_ref().and_then(|s| s.disk_write_bps);
        let meter_w = pdh_s.and_then(|s| s.meter_w);
        let telecom = nic.sample(now_ms);
        Self {
            cpu_q: cpu_pct.map(|v| quantize(v, CPU_PCT_STEP)),
            mem_used_q: Some(quantize(mem_used as f64, MEM_MB_STEP)),
            mem_total_q: Some(quantize(mem_total as f64, MEM_MB_STEP)),
            disk_busy_q: disk_busy.map(|v| quantize(v, DISK_BUSY_STEP)),
            disk_read_q: disk_read.map(|v| quantize(v.max(0.0), DISK_IO_BPS_STEP)),
            disk_write_q: disk_write.map(|v| quantize(v.max(0.0), DISK_IO_BPS_STEP)),
            disks: disks(),
            eps: power(),
            gpus: dxgi_gpus(),
            nvml_q: Vec::new(),
            telecom,
            tcs_lhm: None,
            meter_w,
            watts_q: None,
        }
    }

    pub fn apply_nvml(&mut self, nvml: &mut Nvml) {
        self.nvml_q.clear();
        for g in nvml.sample() {
            self.nvml_q.push((
                quantize(g.util as f64, CPU_PCT_STEP),
                quantize(g.temp as f64, TEMP_C_STEP),
                quantize(g.power_w as f64, WATT_STEP),
                quantize(g.fan_pct as f64, FAN_PCT_STEP),
            ));
            if let Some(slot) = self.gpus.get_mut(g.index as usize) {
                if let Some(obj) = slot.as_object_mut() {
                    obj.insert("util_pct".into(), json!(dequantize(self.nvml_q.last().unwrap().0, CPU_PCT_STEP)));
                    obj.insert("temp_c".into(), json!(dequantize(self.nvml_q.last().unwrap().1, TEMP_C_STEP)));
                    obj.insert("power_w".into(), json!(dequantize(self.nvml_q.last().unwrap().2, WATT_STEP)));
                    obj.insert("fan_pct".into(), json!(dequantize(self.nvml_q.last().unwrap().3, FAN_PCT_STEP)));
                    obj.insert("vram_used_mb".into(), json!(g.vram_used_mb));
                }
            } else {
                self.gpus.push(json!({
                    "name": g.name,
                    "util_pct": dequantize(quantize(g.util as f64, CPU_PCT_STEP), CPU_PCT_STEP),
                    "temp_c": g.temp,
                    "power_w": g.power_w,
                    "fan_pct": g.fan_pct,
                    "vram_used_mb": g.vram_used_mb,
                    "vram_total_mb": g.vram_total_mb
                }));
            }
        }
    }

    pub fn finalize_eps(&mut self) {
        let gpu_w: f64 = self
            .gpus
            .iter()
            .filter_map(|g| g.get("power_w").and_then(|v| v.as_f64()))
            .sum();
        let (lhm_sys, lhm_cpu, lhm_gpu) = lhm_power_split(self.tcs_lhm.as_ref());
        let rate_mw = self
            .eps
            .get("rate_mw")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        let discharging = self
            .eps
            .get("discharging")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);
        let meter = self.meter_w.filter(|v| *v > 0.0 && v.is_finite());
        let (watts, src) = if let Some(m) = meter {
            (Some(m), "power_meter")
        } else if discharging && rate_mw < 0 {
            (Some((-rate_mw as f64) / 1000.0), "battery_discharge")
        } else if let Some(s) = lhm_sys.filter(|v| *v > 0.0) {
            (Some(s), "lhm")
        } else {
            (None, "unavailable")
        };
        self.watts_q = watts.map(|w| quantize(w, WATT_STEP));
        if let Some(obj) = self.eps.as_object_mut() {
            obj.insert(
                "meter_w".into(),
                meter.map(|v| json!(dequantize(quantize(v, WATT_STEP), WATT_STEP))).unwrap_or(Value::Null),
            );
            obj.insert(
                "gpu_w".into(),
                if gpu_w > 0.0 {
                    json!(dequantize(quantize(gpu_w, WATT_STEP), WATT_STEP))
                } else {
                    Value::Null
                },
            );
            obj.insert(
                "lhm_cpu_w".into(),
                lhm_cpu.map(|v| json!(dequantize(quantize(v, WATT_STEP), WATT_STEP))).unwrap_or(Value::Null),
            );
            obj.insert(
                "lhm_gpu_w".into(),
                lhm_gpu.map(|v| json!(dequantize(quantize(v, WATT_STEP), WATT_STEP))).unwrap_or(Value::Null),
            );
            obj.insert(
                "watts".into(),
                self.watts_q
                    .map(|q| json!(dequantize(q, WATT_STEP)))
                    .unwrap_or(Value::Null),
            );
            obj.insert("watts_src".into(), json!(src));
        }
    }

    pub fn sig(&self) -> String {
        let tel: Vec<String> = self
            .telecom
            .iter()
            .map(|a| {
                format!(
                    "{}:{}:{}:{}",
                    a.guid, a.up as u8, a.in_bps_q, a.out_bps_q
                )
            })
            .collect();
        format!(
            "c{:?}m{:?}d{:?}r{:?}w{:?}t{:?}n{:?}l{:?}p{:?}",
            self.cpu_q,
            self.mem_used_q,
            self.disk_busy_q,
            self.disk_read_q,
            self.disk_write_q,
            tel,
            self.nvml_q,
            self.tcs_lhm
                .as_ref()
                .and_then(|v| v.get("sig"))
                .cloned()
                .unwrap_or(Value::Null),
            self.watts_q
        )
    }

    pub fn to_payload(&self, sample_ms: u64, throttled: bool, lite: bool) -> Value {
        let adapters: Vec<Value> = self
            .telecom
            .iter()
            .map(|a| {
                json!({
                    "guid": a.guid,
                    "name": a.name,
                    "media": a.media,
                    "up": a.up,
                    "link_mbps": dequantize(quantize(a.link_mbps, LINK_MBPS_STEP), LINK_MBPS_STEP) as i64,
                    "signal_q": a.signal_q.map(|q| dequantize(quantize(q, SIGNAL_Q_STEP), SIGNAL_Q_STEP)),
                    "in_Bps": dequantize(a.in_bps_q, NET_BPS_STEP),
                    "out_Bps": dequantize(a.out_bps_q, NET_BPS_STEP),
                })
            })
            .collect();
        // 兼容旧图：仍附带无名数组（仪表盘新路径读 adapters）
        let wifi_q: Vec<f64> = self
            .telecom
            .iter()
            .filter(|a| a.media == "wifi")
            .filter_map(|a| a.signal_q)
            .map(|q| dequantize(quantize(q, SIGNAL_Q_STEP), SIGNAL_Q_STEP))
            .collect();
        let eth_up: Vec<bool> = self
            .telecom
            .iter()
            .filter(|a| a.media == "ethernet")
            .map(|a| a.up)
            .collect();
        let eth_mbps: Vec<i64> = self
            .telecom
            .iter()
            .filter(|a| a.media == "ethernet")
            .map(|a| dequantize(quantize(a.link_mbps, LINK_MBPS_STEP), LINK_MBPS_STEP) as i64)
            .collect();
        json!({
            "volume_mode": if throttled { "throttled" } else { "normal" },
            "compute_mode": if lite { "lite" } else { "full" },
            "ms": sample_ms,
            "cdh": {
                "cpu_pct": self.cpu_q.map(|q| dequantize(q, CPU_PCT_STEP)),
                "mem_used_mb": self.mem_used_q.map(|q| dequantize(q, MEM_MB_STEP) as i64),
                "mem_total_mb": self.mem_total_q.map(|q| dequantize(q, MEM_MB_STEP) as i64),
                "disk_busy_pct": self.disk_busy_q.map(|q| dequantize(q, DISK_BUSY_STEP)),
                "disk_read_Bps": self.disk_read_q.map(|q| dequantize(q, DISK_IO_BPS_STEP)),
                "disk_write_Bps": self.disk_write_q.map(|q| dequantize(q, DISK_IO_BPS_STEP)),
                "disks": self.disks,
                "gpu": self.gpus
            },
            "eps": self.eps,
            "tcs": { "lhm": self.tcs_lhm.as_ref().and_then(|v| v.get("sensors")).cloned() },
            "telecom": {
                "adapters": adapters,
                "wifi_q": wifi_q,
                "eth_up": eth_up,
                "eth_mbps": eth_mbps
            }
        })
    }
}

struct AdapterRow {
    name: String,
    guid: String,
    net_guid: GUID,
    if_type: u32,
    up: bool,
    mbps: f64,
    mac: String,
    signal_q: Option<f64>,
    ssid: Option<String>,
    bssid: Option<String>,
    tunnel: bool,
    in_octets: u64,
    out_octets: u64,
}

fn iter_adapters() -> Vec<AdapterRow> {
    let mut size = 0u32;
    let flags = GAA_FLAG_SKIP_ANYCAST | GAA_FLAG_SKIP_MULTICAST | GAA_FLAG_SKIP_DNS_SERVER;
    unsafe {
        GetAdaptersAddresses(AF_UNSPEC.0 as u32, flags, None, None, &mut size);
    }
    if size == 0 {
        return Vec::new();
    }
    let mut buf = vec![0u8; size as usize];
    let head = buf.as_mut_ptr() as *mut IP_ADAPTER_ADDRESSES_LH;
    let err = unsafe { GetAdaptersAddresses(AF_UNSPEC.0 as u32, flags, None, Some(head), &mut size) };
    if err != ERROR_SUCCESS.0 && err != ERROR_BUFFER_OVERFLOW.0 {
        if err != 0 {
            return Vec::new();
        }
    }
    if err == ERROR_BUFFER_OVERFLOW.0 {
        return Vec::new();
    }
    let mut out = Vec::new();
    let mut p = head;
    while !p.is_null() {
        unsafe {
            let a = &*p;
            let if_type = a.IfType;
            let name = pwstr_lossy(a.FriendlyName);
            let guid = a.AdapterName.to_string().unwrap_or_default();
            let mac_len = a.PhysicalAddressLength.min(8) as usize;
            let mac = mac_str(&a.PhysicalAddress[..mac_len]);
            let mut row = MIB_IF_ROW2 {
                InterfaceLuid: a.Luid,
                ..zeroed()
            };
            let (up, mbps, in_octets, out_octets) = if GetIfEntry2(&mut row) == ERROR_SUCCESS {
                let up = row.OperStatus == IfOperStatusUp;
                let mbps = (row.TransmitLinkSpeed as f64) / 1_000_000.0;
                (up, mbps, row.InOctets, row.OutOctets)
            } else {
                (a.OperStatus == IfOperStatusUp, 0.0, 0u64, 0u64)
            };
            let tunnel = if_type == 131 || name.to_lowercase().contains("tunnel");
            if if_type != IF_TYPE_SOFTWARE_LOOPBACK && !guid.is_empty() {
                out.push(AdapterRow {
                    name,
                    guid,
                    net_guid: a.NetworkGuid,
                    if_type,
                    up,
                    mbps,
                    mac,
                    signal_q: None,
                    ssid: None,
                    bssid: None,
                    tunnel,
                    in_octets,
                    out_octets,
                });
            }
            p = a.Next;
        }
    }
    fill_wlan(&mut out);
    out
}

fn fill_wlan(rows: &mut [AdapterRow]) {
    unsafe {
        let mut ver = 0u32;
        let mut handle = HANDLE::default();
        if WlanOpenHandle(2, None, &mut ver, &mut handle) != 0 {
            return;
        }
        let mut list: *mut WLAN_INTERFACE_INFO_LIST = std::ptr::null_mut();
        if WlanEnumInterfaces(handle, None, &mut list) != 0 || list.is_null() {
            let _ = WlanCloseHandle(handle, None);
            return;
        }
        let n = (*list).dwNumberOfItems;
        for i in 0..n {
            let info = (*list).InterfaceInfo.as_ptr().add(i as usize);
            let guid = (*info).InterfaceGuid;
            let mut data_size = 0u32;
            let mut ptr: *mut std::ffi::c_void = std::ptr::null_mut();
            if WlanQueryInterface(
                handle,
                &guid,
                wlan_intf_opcode_current_connection,
                None,
                &mut data_size,
                &mut ptr,
                None,
            ) != 0
                || ptr.is_null()
            {
                continue;
            }
            let conn = &*(ptr as *const WLAN_CONNECTION_ATTRIBUTES);
            let ssid_len = conn.wlanAssociationAttributes.dot11Ssid.uSSIDLength.min(32) as usize;
            let ssid = String::from_utf8_lossy(
                &conn.wlanAssociationAttributes.dot11Ssid.ucSSID[..ssid_len],
            )
            .to_string();
            let bssid = mac_str(&conn.wlanAssociationAttributes.dot11Bssid);
            let q = conn.wlanAssociationAttributes.wlanSignalQuality as f64;
            for r in rows.iter_mut() {
                if r.if_type == IF_TYPE_IEEE80211 && r.net_guid == guid {
                    r.ssid = Some(ssid.clone());
                    r.bssid = Some(bssid.clone());
                    r.signal_q = Some(q);
                }
            }
            WlanFreeMemory(ptr);
        }
        WlanFreeMemory(list as *mut _);
        let _ = WlanCloseHandle(handle, None);
    }
}

pub struct LinkSnap {
    pub sig: String,
    pub changes: Vec<Value>,
}

pub fn link_snapshot() -> LinkSnap {
    let mut parts = Vec::new();
    let mut changes = Vec::new();
    for a in iter_adapters() {
        if a.tunnel {
            continue;
        }
        if a.if_type == IF_TYPE_IEEE80211 {
            let ssid = a.ssid.clone().unwrap_or_default();
            parts.push(format!("w:{}:{}:{}", a.guid, ssid, a.up as u8));
            changes.push(json!({
                "media": "wifi",
                "adapter": a.name,
                "guid": a.guid,
                "mac": a.mac,
                "ssid": ssid,
                "bssid": a.bssid,
                "up": a.up,
                "quality": a.signal_q
            }));
        } else if a.if_type != IF_TYPE_SOFTWARE_LOOPBACK {
            parts.push(format!("e:{}:{}:{}", a.guid, a.up as u8, a.mbps.round() as i64));
            changes.push(json!({
                "media": "ethernet",
                "adapter": a.name,
                "guid": a.guid,
                "mac": a.mac,
                "up": a.up,
                "mbps": a.mbps.round() as i64
            }));
        }
    }
    for b in bluetooth_devices() {
        parts.push(format!("b:{}:{}", b["addr"], b["connected"]));
        let mut ch = b.clone();
        if let Some(obj) = ch.as_object_mut() {
            obj.insert("media".into(), json!("bluetooth"));
        }
        changes.push(ch);
    }
    parts.sort();
    LinkSnap {
        sig: parts.join("|"),
        changes,
    }
}

pub struct Inventory {
    pub sig: String,
    devices: Vec<Value>,
    displays: Vec<Value>,
    audio: Vec<Value>,
    adapters: Vec<Value>,
    gpus: Vec<Value>,
    bluetooth: Vec<Value>,
}

impl Inventory {
    pub fn collect() -> Result<Self, String> {
        let mut devices = Vec::new();
        for (guid, class) in [
            (CLASS_NET, "net"),
            (CLASS_MOUSE, "mouse"),
            (CLASS_KEYBOARD, "keyboard"),
            (CLASS_HID, "hid"),
            (CLASS_MONITOR, "monitor"),
            (CLASS_MEDIA, "audio"),
            (CLASS_DISK, "disk"),
            (CLASS_DISPLAY, "gpu"),
            (CLASS_BATTERY, "battery"),
            (CLASS_BT, "bluetooth"),
        ] {
            devices.extend(enum_class(&guid, class));
        }
        let displays = displays_identity();
        let audio = audio_endpoints();
        let adapters = iter_adapters()
            .into_iter()
            .filter(|a| !a.tunnel && a.if_type != IF_TYPE_SOFTWARE_LOOPBACK)
            .map(|a| {
                json!({
                    "name": a.name,
                    "guid": a.guid,
                    "type": if a.if_type == IF_TYPE_IEEE80211 { "wifi" } else { "ethernet" },
                    "mac": a.mac,
                    "up": a.up,
                    "mbps": a.mbps.round() as i64,
                    "ssid": a.ssid,
                    "bssid": a.bssid
                })
            })
            .collect::<Vec<_>>();
        let gpus = dxgi_gpus();
        let bluetooth = bluetooth_devices();
        let mut sig_parts: Vec<String> = devices
            .iter()
            .filter_map(|d| d.get("id").and_then(|v| v.as_str()).map(|s| s.to_string()))
            .collect();
        sig_parts.sort();
        Ok(Self {
            sig: sig_parts.join("|"),
            devices,
            displays,
            audio,
            adapters,
            gpus,
            bluetooth,
        })
    }

    pub fn to_payload(&self, reason: &str) -> Value {
        json!({
            "reason": reason,
            "devices": self.devices,
            "displays": self.displays,
            "audio": self.audio,
            "adapters": self.adapters,
            "gpus": self.gpus,
            "bluetooth": self.bluetooth
        })
    }
}

fn enum_class(guid: &GUID, class: &str) -> Vec<Value> {
    let mut out = Vec::new();
    unsafe {
        let set = match SetupDiGetClassDevsW(Some(guid), None, None, DIGCF_PRESENT) {
            Ok(h) => h,
            Err(_) => return out,
        };
        let mut info = SP_DEVINFO_DATA {
            cbSize: size_of::<SP_DEVINFO_DATA>() as u32,
            ..zeroed()
        };
        let mut i = 0u32;
        while SetupDiEnumDeviceInfo(set, i, &mut info).is_ok() {
            i += 1;
            let mut id_buf = [0u16; 512];
            let mut needed = 0u32;
            let id = if SetupDiGetDeviceInstanceIdW(
                set,
                &info,
                Some(&mut id_buf),
                Some(&mut needed as *mut u32),
            )
            .is_ok()
            {
                utf16z_to_string(&id_buf)
            } else {
                continue;
            };
            let name = device_prop(set, &info, SPDRP_FRIENDLYNAME)
                .or_else(|| device_prop(set, &info, SPDRP_DEVICEDESC))
                .unwrap_or_default();
            out.push(json!({ "class": class, "id": id, "name": name }));
            if out.len() >= 80 {
                break;
            }
        }
        let _ = SetupDiDestroyDeviceInfoList(set);
    }
    out
}

unsafe fn device_prop(set: HDEVINFO, info: &SP_DEVINFO_DATA, prop: SETUP_DI_REGISTRY_PROPERTY) -> Option<String> {
    let mut buf = [0u8; 1024];
    let mut needed = 0u32;
    let mut dtype = 0u32;
    unsafe {
        SetupDiGetDeviceRegistryPropertyW(
            set,
            info,
            prop,
            Some(&mut dtype as *mut u32),
            Some(&mut buf),
            Some(&mut needed as *mut u32),
        )
        .ok()?;
    }
    let u16s: Vec<u16> = buf
        .chunks_exact(2)
        .map(|c| u16::from_le_bytes([c[0], c[1]]))
        .collect();
    let s = utf16z_to_string(&u16s);
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn displays_identity() -> Vec<Value> {
    unsafe {
        let mut n_path = 0u32;
        let mut n_mode = 0u32;
        if GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &mut n_path, &mut n_mode).is_err() {
            return Vec::new();
        }
        let mut paths = vec![DISPLAYCONFIG_PATH_INFO::default(); n_path as usize];
        let mut modes = vec![DISPLAYCONFIG_MODE_INFO::default(); n_mode as usize];
        if QueryDisplayConfig(
            QDC_ONLY_ACTIVE_PATHS,
            &mut n_path,
            paths.as_mut_ptr(),
            &mut n_mode,
            modes.as_mut_ptr(),
            None,
        )
        .is_err()
        {
            return Vec::new();
        }
        paths.truncate(n_path as usize);
        let mut out = Vec::new();
        for p in &paths {
            let mut name: DISPLAYCONFIG_TARGET_DEVICE_NAME = zeroed();
            name.header.size = size_of::<DISPLAYCONFIG_TARGET_DEVICE_NAME>() as u32;
            name.header.r#type = DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME;
            name.header.adapterId = p.targetInfo.adapterId;
            name.header.id = p.targetInfo.id;
            if DisplayConfigGetDeviceInfo(&mut name.header) != 0 {
                continue;
            }
            let refresh = if p.targetInfo.refreshRate.Denominator > 0 {
                (p.targetInfo.refreshRate.Numerator as f64)
                    / (p.targetInfo.refreshRate.Denominator as f64)
            } else {
                0.0
            };
            out.push(json!({
                "name": utf16z_to_string(&name.monitorFriendlyDeviceName),
                "path": utf16z_to_string(&name.monitorDevicePath),
                "edid_mfr": name.edidManufactureId,
                "edid_product": name.edidProductCodeId,
                "output": output_tech(p.targetInfo.outputTechnology.0),
                "refresh_hz": (refresh.round() as i64)
            }));
        }
        out
    }
}

fn output_tech(v: i32) -> &'static str {
    match v {
        0 => "vga",
        4 => "dvi",
        5 => "hdmi",
        10 => "dp",
        11 => "dp_embedded",
        -2147483648 => "internal",
        _ => "other",
    }
}

fn audio_endpoints() -> Vec<Value> {
    let mut out = Vec::new();
    unsafe {
        let enumr: IMMDeviceEnumerator =
            match CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL) {
                Ok(e) => e,
                Err(_) => return out,
            };
        let col = match enumr.EnumAudioEndpoints(eRender, DEVICE_STATE_ACTIVE) {
            Ok(c) => c,
            Err(_) => return out,
        };
        let n = col.GetCount().unwrap_or(0);
        for i in 0..n {
            let dev: IMMDevice = match col.Item(i) {
                Ok(d) => d,
                Err(_) => continue,
            };
            let id = dev
                .GetId()
                .ok()
                .map(|p| pwstr_lossy(p))
                .unwrap_or_default();
            let name = audio_name(&dev).unwrap_or_default();
            out.push(json!({ "id": id, "name": name, "role": "render" }));
        }
        if let Ok(def) = enumr.GetDefaultAudioEndpoint(eRender, eConsole) {
            if let Ok(id) = def.GetId() {
                let sid = pwstr_lossy(id);
                out.push(json!({ "default_render": sid }));
            }
        }
    }
    out
}

unsafe fn audio_name(dev: &IMMDevice) -> Option<String> {
    let store: IPropertyStore = unsafe { dev.OpenPropertyStore(STGM_READ).ok()? };
    let key = PROPERTYKEY {
        fmtid: GUID::from_u128(0xa45c254e_df1c_4efd_8020_67d146a850e0),
        pid: 14,
    };
    let pv = unsafe { store.GetValue(&key).ok()? };
    let s = pv.to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn bluetooth_devices() -> Vec<Value> {
    let mut out = Vec::new();
    unsafe {
        let params = BLUETOOTH_FIND_RADIO_PARAMS {
            dwSize: size_of::<BLUETOOTH_FIND_RADIO_PARAMS>() as u32,
        };
        let mut radio = HANDLE::default();
        let find = match BluetoothFindFirstRadio(&params, &mut radio) {
            Ok(h) => h,
            Err(_) => return out,
        };
        loop {
            let mut search = BLUETOOTH_DEVICE_SEARCH_PARAMS {
                dwSize: size_of::<BLUETOOTH_DEVICE_SEARCH_PARAMS>() as u32,
                fReturnAuthenticated: BOOL(1),
                fReturnRemembered: BOOL(1),
                fReturnUnknown: BOOL(0),
                fReturnConnected: BOOL(1),
                fIssueInquiry: BOOL(0),
                cTimeoutMultiplier: 0,
                hRadio: radio,
            };
            let mut info = BLUETOOTH_DEVICE_INFO {
                dwSize: size_of::<BLUETOOTH_DEVICE_INFO>() as u32,
                ..zeroed()
            };
            if let Ok(dfind) = BluetoothFindFirstDevice(&mut search, &mut info) {
                loop {
                    let name = utf16z_to_string(&info.szName);
                    let addr = format!("{:012x}", u64_be_bt(&info.Address.Anonymous.rgBytes));
                    out.push(json!({
                        "name": name,
                        "addr": addr,
                        "connected": info.fConnected.as_bool(),
                        "remembered": info.fRemembered.as_bool()
                    }));
                    if BluetoothFindNextDevice(dfind, &mut info).is_err() {
                        break;
                    }
                    if out.len() >= 40 {
                        break;
                    }
                }
                let _ = BluetoothFindDeviceClose(dfind);
            }
            let _ = CloseHandle(radio);
            if BluetoothFindNextRadio(find, &mut radio).is_err() {
                break;
            }
        }
        let _ = BluetoothFindRadioClose(find);
    }
    out
}

fn u64_be_bt(bytes: &[u8; 6]) -> u64 {
    let mut v = 0u64;
    for b in bytes {
        v = (v << 8) | (*b as u64);
    }
    v
}
