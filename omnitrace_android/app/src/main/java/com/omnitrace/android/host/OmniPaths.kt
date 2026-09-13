package com.omnitrace.android.host

import android.content.Context
import android.provider.Settings
import java.io.File
import java.util.Calendar

/**
 * 与桌面 `src/paths.rs` 对齐的日历路径。
 * 禁止写入 Windows 键鼠 `trace_DD.bin`。
 */
object OmniPaths {
    const val DB_DIR = "OmniDatabase"

    fun dataRoot(ctx: Context): File {
        val ext = ctx.getExternalFilesDir(null) ?: ctx.filesDir
        val root = File(ext, DB_DIR)
        if (!root.exists()) root.mkdirs()
        return root
    }

    fun centurySegments(cal: Calendar = Calendar.getInstance()): String {
        val year = cal.get(Calendar.YEAR)
        val century = year / 100 + 1
        val month = cal.get(Calendar.MONTH) + 1
        return String.format("Century_%08d/Year_%04d/Month_%02d", century, year, month)
    }

    fun day(cal: Calendar = Calendar.getInstance()): Int = cal.get(Calendar.DAY_OF_MONTH)

    fun eventDataDir(root: File, cal: Calendar = Calendar.getInstance()): File {
        val d = File(root, "EventData/${centurySegments(cal)}")
        d.mkdirs()
        return d
    }

    /** IMU 物理流；不是桌面键鼠 bin。 */
    fun imuBinToday(root: File, cal: Calendar = Calendar.getInstance()): File {
        return File(eventDataDir(root, cal), String.format("imu_%02d.bin", day(cal)))
    }

    fun moduleDataDir(root: File, moduleId: String, cal: Calendar = Calendar.getInstance()): File {
        val d = File(root, "ModuleData/$moduleId/${centurySegments(cal)}")
        d.mkdirs()
        return d
    }

    fun moduleEventsToday(root: File, moduleId: String, cal: Calendar = Calendar.getInstance()): File {
        return File(moduleDataDir(root, moduleId, cal), String.format("events_%02d.jsonl", day(cal)))
    }

    /** 只拼路径，不建目录（仪表盘读盘用）。 */
    fun moduleEventsFile(root: File, moduleId: String, cal: Calendar): File {
        val day = String.format("events_%02d.jsonl", day(cal))
        return File(root, "ModuleData/$moduleId/${centurySegments(cal)}/$day")
    }

    fun moduleRoot(root: File, moduleId: String): File = File(root, "ModuleData/$moduleId")

    fun controlDir(root: File): File {
        val d = File(root, "control")
        d.mkdirs()
        return d
    }

    fun healthLog(root: File): File = File(controlDir(root), "module_health.jsonl")

    fun pidPath(root: File): File = File(controlDir(root), "omnitrace_android.pid")

    fun hwInventory(root: File): File = File(controlDir(root), "hw_inventory.json")

    fun manifest(root: File): File = File(root, "manifest.json")

    fun linkedPcRoot(root: File): File = File(root, "linked_pc")

    fun linkedPcHostDir(root: File, host: String): File {
        val safe = host.replace(Regex("[^A-Za-z0-9._-]"), "_")
        return File(linkedPcRoot(root), safe)
    }

    fun linkedPcInputHistDir(root: File, host: String): File {
        val d = File(linkedPcHostDir(root, host), "cache/input_hist")
        d.mkdirs()
        return d
    }

    fun sourceId(ctx: Context): String {
        val androidId = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ANDROID_ID)
            ?: "unknown"
        val model = android.os.Build.MODEL.replace(Regex("[^A-Za-z0-9._-]"), "_")
        return "android_${model}_$androidId"
    }
}
