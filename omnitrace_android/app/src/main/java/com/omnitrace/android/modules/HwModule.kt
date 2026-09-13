package com.omnitrace.android.modules

import android.app.ActivityManager
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.hardware.display.DisplayManager
import android.nfc.NfcAdapter
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.StatFs
import android.os.Vibrator
import android.os.VibratorManager
import android.util.DisplayMetrics
import android.view.WindowManager
import com.omnitrace.android.host.EventSink
import com.omnitrace.android.host.JsonUtil
import com.omnitrace.android.host.ModuleContext
import com.omnitrace.android.host.ModuleStatus
import com.omnitrace.android.host.OmniPaths
import com.omnitrace.android.host.Receivers
import com.omnitrace.android.host.TraceModule
import com.omnitrace.android.host.kv
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

/** 启动扫硬件身份；签名不变只写一行「组件信息无变化」。 */
class HwModule : TraceModule {
    override val id = "hw"
    override val name = "Hardware inventory"
    override val version = "0.1.0"
    private var st = ModuleStatus.Idle

    override fun status(): ModuleStatus = st

    override fun start(ctx: ModuleContext, sink: EventSink) {
        val inv = collect(ctx.app)
        val canon = JsonUtil.canonical(inv)
        val sig = JsonUtil.sha256Hex(canon)
        val store = OmniPaths.hwInventory(ctx.dataRoot)
        val prev = readPrev(store)
        val prevSig = prev?.optString("sig").orEmpty()
        sink.emit(
            id,
            "module_hello",
            JSONObject().kv("implemented", true).kv("device_id", ctx.deviceId),
        )
        if (prevSig == sig && prevSig.isNotEmpty()) {
            sink.emit(
                id,
                "hw_unchanged",
                JSONObject()
                    .kv("sig", sig)
                    .kv("message", "组件信息无变化"),
            )
        } else {
            val prevInv = prev?.optJSONObject("inventory")
            sink.emit(
                id,
                "hw_snapshot",
                JSONObject()
                    .kv("reason", "startup")
                    .kv("sig", sig)
                    .kv("inventory", inv),
            )
            val diff = JsonUtil.topLevelDiff(prevInv, inv)
            if (diff.length() > 0 && prevInv != null) {
                sink.emit(
                    id,
                    "hw_change",
                    JSONObject().kv("sig", sig).kv("prev_sig", prevSig).kv("diff", diff),
                )
            }
            val saved = JSONObject()
                .kv("sig", sig)
                .kv("ts", JsonUtil.nowMs())
                .kv("inventory", inv)
            FileOutputStream(store).use {
                it.write((saved.toString() + "\n").toByteArray(Charsets.UTF_8))
            }
        }
        st = ModuleStatus.Running
    }

    override fun stop() {
        st = ModuleStatus.Stopped
    }

    private fun readPrev(f: File): JSONObject? {
        if (!f.exists()) return null
        return try {
            JSONObject(f.readText())
        } catch (_: Exception) {
            null
        }
    }

    private fun collect(app: Context): JSONObject {
        val o = JSONObject()
        o.put(
            "build",
            JSONObject()
                .kv("manufacturer", Build.MANUFACTURER)
                .kv("brand", Build.BRAND)
                .kv("model", Build.MODEL)
                .kv("device", Build.DEVICE)
                .kv("board", Build.BOARD)
                .kv("hardware", Build.HARDWARE)
                .kv("product", Build.PRODUCT)
                .kv("fingerprint", Build.FINGERPRINT)
                .kv("release", Build.VERSION.RELEASE)
                .kv("sdk", Build.VERSION.SDK_INT)
                .kv("security_patch", Build.VERSION.SECURITY_PATCH)
                .kv("supported_abis", JSONArray(Build.SUPPORTED_ABIS.toList())),
        )
        if (Build.VERSION.SDK_INT >= 31) {
            o.optJSONObject("build")
                ?.kv("soc_model", Build.SOC_MODEL)
                ?.kv("soc_manufacturer", Build.SOC_MANUFACTURER)
        }
        o.kv("cpu", cpuInfo(app))
        o.kv("gpu", gpuInfo(app))
        o.kv("memory", memInfo(app))
        o.kv("storage", storageInfo())
        o.kv("battery", batteryInfo(app))
        o.kv("display", displayInfo(app))
        o.kv("sensors", sensorList(app))
        o.kv("cameras", cameraList(app))
        o.kv("features", features(app))
        return o
    }

    private fun cpuInfo(app: Context): JSONObject {
        val cores = Runtime.getRuntime().availableProcessors()
        val cpuinfo = readFirst("/proc/cpuinfo", 32)
        val freq = readableCpuFreq()
        val am = app.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        return JSONObject()
            .kv("cores", cores)
            .kv("cpuinfo_head", cpuinfo)
            .kv("cur_freq_khz", freq)
            .kv("low_ram", am.isLowRamDevice)
    }

    private fun gpuInfo(app: Context): JSONObject {
        val am = app.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val gles = am.deviceConfigurationInfo.glEsVersion
        return JSONObject()
            .kv("gles_version", gles)
            .kv("renderer", "see_gles")
            .kv("realtime_freq", "unreadable")
    }

    private fun memInfo(app: Context): JSONObject {
        val am = app.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val mi = ActivityManager.MemoryInfo()
        am.getMemoryInfo(mi)
        return JSONObject()
            .kv("total_bytes", mi.totalMem)
            .kv("threshold_bytes", mi.threshold)
    }

    private fun storageInfo(): JSONObject {
        return try {
            val path = Environment.getDataDirectory()
            val st = StatFs(path.path)
            JSONObject()
                .kv("data_total_bytes", st.totalBytes)
                .kv("data_avail_bytes", st.availableBytes)
        } catch (e: Exception) {
            JSONObject().kv("error", e.message ?: "unreadable")
        }
    }

    private fun batteryInfo(app: Context): JSONObject {
        val bm = app.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val cap = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        val chargeCounter = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CHARGE_COUNTER)
        val energy = bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_ENERGY_COUNTER)
        val tech = unreadableIfBlank(
            android.os.Build.VERSION.SDK_INT.let {
                try {
                    Receivers.sticky(app, android.content.Intent.ACTION_BATTERY_CHANGED)
                        ?.getStringExtra(BatteryManager.EXTRA_TECHNOLOGY)
                } catch (_: Exception) {
                    null
                }
            },
        )
        return JSONObject()
            .kv("capacity_pct", cap)
            .kv("charge_counter_uah", chargeCounter)
            .kv("energy_counter", energy)
            .kv("technology", tech)
            .kv("cycle_count", "unreadable")
    }

    private fun displayInfo(app: Context): JSONObject {
        val arr = JSONArray()
        val dm = app.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
        for (d in dm.displays) {
            val m = DisplayMetrics()
            d.getRealMetrics(m)
            val o = JSONObject()
                .kv("id", d.displayId)
                .kv("name", d.name)
                .kv("w", m.widthPixels)
                .kv("h", m.heightPixels)
                .kv("dpi", m.densityDpi)
                .kv("refresh_hz", d.refreshRate.toDouble())
            if (Build.VERSION.SDK_INT >= 23) {
                o.kv("hdr", d.hdrCapabilities != null)
            }
            if (Build.VERSION.SDK_INT >= 29) {
                try {
                    o.kv("cutout", d.cutout != null)
                } catch (_: Exception) {
                }
            }
            arr.put(o)
        }
        val wm = app.getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        wm.defaultDisplay.getRealMetrics(metrics)
        return JSONObject().kv("displays", arr).kv("default_dpi", metrics.densityDpi)
    }

    private fun sensorList(app: Context): JSONArray {
        val sm = app.getSystemService(Context.SENSOR_SERVICE) as SensorManager
        val arr = JSONArray()
        for (s in sm.getSensorList(Sensor.TYPE_ALL)) {
            arr.put(
                JSONObject()
                    .kv("name", s.name)
                    .kv("vendor", s.vendor)
                    .kv("type", s.type)
                    .kv("string_type", s.stringType)
                    .kv("max_range", s.maximumRange.toDouble())
                    .kv("resolution", s.resolution.toDouble())
                    .kv("power_ma", s.power.toDouble())
                    .kv("min_delay_us", s.minDelay)
                    .kv("wakeup", s.isWakeUpSensor),
            )
        }
        return arr
    }

    private fun cameraList(app: Context): JSONArray {
        val arr = JSONArray()
        return try {
            val cm = app.getSystemService(Context.CAMERA_SERVICE) as CameraManager
            for (id in cm.cameraIdList) {
                val ch = cm.getCameraCharacteristics(id)
                val facing = ch.get(CameraCharacteristics.LENS_FACING)
                val size = ch.get(CameraCharacteristics.SENSOR_INFO_PIXEL_ARRAY_SIZE)
                val focals = ch.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)
                arr.put(
                    JSONObject()
                        .kv("id", id)
                        .kv("facing", facing ?: JSONObject.NULL)
                        .kv("pixel_w", size?.width ?: JSONObject.NULL)
                        .kv("pixel_h", size?.height ?: JSONObject.NULL)
                        .put(
                            "focals_mm",
                            JSONArray().also { a -> focals?.forEach { a.put(it.toDouble()) } },
                        ),
                )
            }
            arr
        } catch (e: Exception) {
            arr.put(JSONObject().kv("error", e.message ?: "unreadable"))
            arr
        }
    }

    private fun features(app: Context): JSONObject {
        val pm = app.packageManager
        val vibe = if (Build.VERSION.SDK_INT >= 31) {
            val vm = app.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
            vm.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            app.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }
        val ir = app.getSystemService(Context.CONSUMER_IR_SERVICE) as? android.hardware.ConsumerIrManager
        val nfc = NfcAdapter.getDefaultAdapter(app)
        return JSONObject()
            .kv("gps", pm.hasSystemFeature(PackageManager.FEATURE_LOCATION_GPS))
            .kv("bluetooth", pm.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH))
            .kv("nfc", nfc != null)
            .kv("nfc_enabled", nfc?.isEnabled ?: false)
            .kv("ir_emitter", ir?.hasIrEmitter() ?: false)
            .kv("vibrator", vibe.hasVibrator())
            .kv("vibrator_amplitude", Build.VERSION.SDK_INT >= 26 && vibe.hasAmplitudeControl())
            .kv("wifi", pm.hasSystemFeature(PackageManager.FEATURE_WIFI))
            .kv("telephony", pm.hasSystemFeature(PackageManager.FEATURE_TELEPHONY))
            .kv("step_counter", pm.hasSystemFeature(PackageManager.FEATURE_SENSOR_STEP_COUNTER))
    }

    private fun readableCpuFreq(): JSONArray {
        val arr = JSONArray()
        val cpus = File("/sys/devices/system/cpu").listFiles { f -> f.name.matches(Regex("cpu[0-9]+")) } ?: return arr
        for (c in cpus.sortedBy { it.name }) {
            val f = File(c, "cpufreq/scaling_cur_freq")
            arr.put(
                JSONObject()
                    .kv("cpu", c.name)
                    .kv("khz", if (f.canRead()) f.readText().trim() else "unreadable"),
            )
        }
        return arr
    }

    private fun readFirst(path: String, lines: Int): String {
        return try {
            File(path).useLines { it.take(lines).joinToString("\n") }
        } catch (_: Exception) {
            "unreadable"
        }
    }

    private fun unreadableIfBlank(s: String?): String = if (s.isNullOrBlank()) "unreadable" else s
}
