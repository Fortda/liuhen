//! NVIDIA NVML：本机有 nvml.dll 才加载，读利用率/温度/功率/风扇。

use windows::core::{s, w};
use windows::Win32::Foundation::{FreeLibrary, HMODULE};
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

const NVML_SUCCESS: i32 = 0;
const NVML_TEMPERATURE_GPU: i32 = 0;

type NvmlInit = unsafe extern "C" fn() -> i32;
type NvmlShutdown = unsafe extern "C" fn() -> i32;
type NvmlCount = unsafe extern "C" fn(*mut u32) -> i32;
type NvmlHandle = unsafe extern "C" fn(u32, *mut *mut std::ffi::c_void) -> i32;
type NvmlName = unsafe extern "C" fn(*mut std::ffi::c_void, *mut i8, u32) -> i32;
type NvmlTemp = unsafe extern "C" fn(*mut std::ffi::c_void, i32, *mut u32) -> i32;
type NvmlUtil = unsafe extern "C" fn(*mut std::ffi::c_void, *mut NvmlUtilization) -> i32;
type NvmlPower = unsafe extern "C" fn(*mut std::ffi::c_void, *mut u32) -> i32;
type NvmlFan = unsafe extern "C" fn(*mut std::ffi::c_void, *mut u32) -> i32;
type NvmlMem = unsafe extern "C" fn(*mut std::ffi::c_void, *mut NvmlMemory) -> i32;

#[repr(C)]
struct NvmlUtilization {
    gpu: u32,
    memory: u32,
}

#[repr(C)]
struct NvmlMemory {
    total: u64,
    free: u64,
    used: u64,
}

pub struct GpuSample {
    pub index: u32,
    pub name: String,
    pub util: u32,
    pub temp: u32,
    pub power_w: u32,
    pub fan_pct: u32,
    pub vram_used_mb: u64,
    pub vram_total_mb: u64,
}

pub struct Nvml {
    module: HMODULE,
    shutdown: NvmlShutdown,
    count: NvmlCount,
    handle: NvmlHandle,
    name: NvmlName,
    temp: NvmlTemp,
    util: NvmlUtil,
    power: NvmlPower,
    fan: NvmlFan,
    mem: NvmlMem,
}

impl Nvml {
    pub fn load() -> Option<Self> {
        unsafe {
            let module = LoadLibraryW(w!("nvml.dll")).ok()?;
            let g = |n: windows::core::PCSTR| GetProcAddress(module, n);
            let init: NvmlInit = std::mem::transmute(g(s!("nvmlInit_v2")).or_else(|| g(s!("nvmlInit")))?);
            if init() != NVML_SUCCESS {
                let _ = FreeLibrary(module);
                return None;
            }
            let shutdown: NvmlShutdown =
                std::mem::transmute(g(s!("nvmlShutdown"))?);
            let count: NvmlCount =
                std::mem::transmute(g(s!("nvmlDeviceGetCount_v2")).or_else(|| g(s!("nvmlDeviceGetCount")))?);
            let handle: NvmlHandle = std::mem::transmute(
                g(s!("nvmlDeviceGetHandleByIndex_v2")).or_else(|| g(s!("nvmlDeviceGetHandleByIndex")))?,
            );
            let name: NvmlName = std::mem::transmute(g(s!("nvmlDeviceGetName"))?);
            let temp: NvmlTemp = std::mem::transmute(g(s!("nvmlDeviceGetTemperature"))?);
            let util: NvmlUtil = std::mem::transmute(g(s!("nvmlDeviceGetUtilizationRates"))?);
            let power: NvmlPower = std::mem::transmute(g(s!("nvmlDeviceGetPowerUsage"))?);
            let fan: NvmlFan = std::mem::transmute(g(s!("nvmlDeviceGetFanSpeed"))?);
            let mem: NvmlMem = std::mem::transmute(g(s!("nvmlDeviceGetMemoryInfo"))?);
            Some(Self {
                module,
                shutdown,
                count,
                handle,
                name,
                temp,
                util,
                power,
                fan,
                mem,
            })
        }
    }

    pub fn sample(&mut self) -> Vec<GpuSample> {
        let mut n = 0u32;
        unsafe {
            if (self.count)(&mut n) != NVML_SUCCESS {
                return Vec::new();
            }
        }
        n = n.min(4);
        let mut out = Vec::new();
        for i in 0..n {
            unsafe {
                let mut h = std::ptr::null_mut();
                if (self.handle)(i, &mut h) != NVML_SUCCESS || h.is_null() {
                    continue;
                }
                let mut name_buf = [0i8; 96];
                let _ = (self.name)(h, name_buf.as_mut_ptr(), name_buf.len() as u32);
                let name = std::ffi::CStr::from_ptr(name_buf.as_ptr())
                    .to_string_lossy()
                    .into_owned();
                let mut temp = 0u32;
                let _ = (self.temp)(h, NVML_TEMPERATURE_GPU, &mut temp);
                let mut util = NvmlUtilization { gpu: 0, memory: 0 };
                let _ = (self.util)(h, &mut util);
                let mut mw = 0u32;
                let _ = (self.power)(h, &mut mw);
                let mut fan = 0u32;
                let _ = (self.fan)(h, &mut fan);
                let mut mem = NvmlMemory {
                    total: 0,
                    free: 0,
                    used: 0,
                };
                let _ = (self.mem)(h, &mut mem);
                out.push(GpuSample {
                    index: i,
                    name,
                    util: util.gpu,
                    temp,
                    power_w: mw / 1000,
                    fan_pct: fan,
                    vram_used_mb: mem.used / (1024 * 1024),
                    vram_total_mb: mem.total / (1024 * 1024),
                });
            }
        }
        out
    }
}

pub fn adl_dll_present() -> bool {
    unsafe {
        match LoadLibraryW(w!("atiadlxx.dll")) {
            Ok(h) => {
                let _ = FreeLibrary(h);
                true
            }
            Err(_) => false,
        }
    }
}

impl Drop for Nvml {
    fn drop(&mut self) {
        unsafe {
            let _ = (self.shutdown)();
            let _ = FreeLibrary(self.module);
        }
    }
}
