package com.omnitrace.android.modules

import android.app.ActivityManager
import android.content.Context
import android.os.BatteryManager
import android.os.Build
import android.os.Environment
import android.os.PowerManager
import android.os.StatFs
import com.omnitrace.android.host.EventSink
import com.omnitrace.android.host.JsonUtil
import com.omnitrace.android.host.ModuleContext
import com.omnitrace.android.host.ModuleStatus
import com.omnitrace.android.host.Receivers
import com.omnitrace.android.host.TraceModule
import com.omnitrace.android.host.kv
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/** CPU / 内存 / 温度 / 存储：过阈或签名变了才写。 */
class PerfModule : TraceModule {
    override val id = "perf"
    override val name = "Perf telemetry"
    override val version = "0.1.0"

    private var st = ModuleStatus.Idle
    private var lastSig = ""
    private var lastCpu: List<Long>? = null

    override fun status(): ModuleStatus = st

    override fun start(ctx: ModuleContext, sink: EventSink) {
        sink.emit(id, "module_hello", JSONObject().kv("implemented", true))
        lastCpu = readProcStat()
        st = ModuleStatus.Running
    }

    override fun tickIntervalMs(): Long = 5_000

    override fun tick(ctx: ModuleContext, sink: EventSink) {
        val payload = sample(ctx.app)
        val sig = JsonUtil.sha256Hex(JsonUtil.canonical(payload))
        if (sig == lastSig) return
        lastSig = sig
        sink.emit(id, "perf_sample", payload)
    }

    override fun stop() {
        st = ModuleStatus.Stopped
    }

    private fun sample(app: Context): JSONObject {
        val am = app.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        val mi = ActivityManager.MemoryInfo()
        am.getMemoryInfo(mi)
        val storage = try {
            val stFs = StatFs(Environment.getDataDirectory().path)
            JSONObject()
                .kv("avail_mb", stFs.availableBytes / 1_000_000)
                .kv("total_mb", stFs.totalBytes / 1_000_000)
        } catch (_: Exception) {
            JSONObject().kv("error", "unreadable")
        }
        val bm = app.getSystemService(Context.BATTERY_SERVICE) as BatteryManager
        val thermal = if (Build.VERSION.SDK_INT >= 29) {
            val pm = app.getSystemService(Context.POWER_SERVICE) as PowerManager
            pm.currentThermalStatus
        } else {
            -1
        }
        return JSONObject()
            .kv("cpu_pct", cpuPct())
            .kv("cpu_freq_khz", cpuFreq())
            .kv("mem_avail_mb", mi.availMem / 1_000_000)
            .kv("mem_total_mb", mi.totalMem / 1_000_000)
            .kv("low_memory", mi.lowMemory)
            .kv("storage", storage)
            .kv("thermal_status", thermal)
            .kv("battery_temp_tenths", batteryTemp(app))
    }

    private fun batteryTemp(app: Context): Int {
        val sticky = Receivers.sticky(app, android.content.Intent.ACTION_BATTERY_CHANGED)
        return sticky?.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, -1) ?: -1
    }

    private fun cpuFreq(): JSONArray {
        val arr = JSONArray()
        val dir = File("/sys/devices/system/cpu")
        val cpus = dir.listFiles { f -> f.name.matches(Regex("cpu[0-9]+")) } ?: return arr
        for (c in cpus.sortedBy { it.name }) {
            val f = File(c, "cpufreq/scaling_cur_freq")
            val khz = if (f.canRead()) f.readText().trim().toLongOrNull()?.div(10_000)?.times(10_000) else null
            arr.put(JSONObject().kv("cpu", c.name).kv("khz_rounded", khz ?: JSONObject.NULL))
        }
        return arr
    }

    private fun cpuPct(): Int {
        val now = readProcStat() ?: return -1
        val prev = lastCpu
        lastCpu = now
        if (prev == null || prev.size < 5 || now.size < 5) return -1
        val idle = now[3] - prev[3]
        val total = now.sum() - prev.sum()
        if (total <= 0) return 0
        return ((100L * (total - idle)) / total).toInt().coerceIn(0, 100)
    }

    private fun readProcStat(): List<Long>? {
        return try {
            val line = File("/proc/stat").useLines { it.firstOrNull() } ?: return null
            val parts = line.trim().split(Regex("\\s+"))
            if (parts.size < 5 || parts[0] != "cpu") return null
            parts.drop(1).mapNotNull { it.toLongOrNull() }
        } catch (_: Exception) {
            null
        }
    }
}
