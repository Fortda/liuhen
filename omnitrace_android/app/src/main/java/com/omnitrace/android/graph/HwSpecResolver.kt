package com.omnitrace.android.graph

import android.content.Context
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.os.Build
import com.omnitrace.android.host.OmniPaths
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.Locale
import kotlin.math.roundToInt

object HwSpecResolver {
    private const val MAX_LINE = 22

    fun loadInventory(ctx: Context): JSONObject? {
        val f = OmniPaths.hwInventory(OmniPaths.dataRoot(ctx))
        if (!f.exists()) return null
        return try {
            JSONObject(f.readText()).optJSONObject("inventory")
        } catch (_: Exception) {
            null
        }
    }

    fun truncate(s: String, max: Int = MAX_LINE): String {
        if (s.length <= max) return s
        return s.take(max - 1) + "…"
    }

    fun sensorByType(inv: JSONObject?, live: Context, type: Int): JSONObject? {
        inv?.optJSONArray("sensors")?.let { arr ->
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i)
                if (o?.optInt("type") == type) return o
            }
        }
        val sm = live.getSystemService(Context.SENSOR_SERVICE) as SensorManager
        val s = sm.getSensorList(type).firstOrNull()
        if (s == null) return null
        return JSONObject()
            .put("name", s.name)
            .put("vendor", s.vendor)
            .put("max_range", s.maximumRange.toDouble())
            .put("resolution", s.resolution.toDouble())
    }

    fun sensorLines(title: String, inv: JSONObject?, live: Context, type: Int, missing: String): List<SpecLine> {
        val s = sensorByType(inv, live, type)
        if (s == null) {
            return listOf(SpecLine(title, true), SpecLine(missing, false))
        }
        val model = truncate(s.optString("name", "未知"))
        val vendor = truncate(s.optString("vendor", ""))
        val range = s.optDouble("max_range", 0.0)
        val res = s.optDouble("resolution", 0.0)
        val param = when {
            range > 0 && res > 0 -> "$vendor · ±${fmtNum(range)} · ${fmtNum(res)}"
            vendor.isNotBlank() -> vendor
            else -> "已探测"
        }
        return listOf(
            SpecLine(title, true),
            SpecLine(model, false),
            SpecLine(truncate(param), false),
        )
    }

    fun displayLines(inv: JSONObject?, live: Context): List<SpecLine> {
        val arr = inv?.optJSONObject("display")?.optJSONArray("displays")
        val o = if (arr != null && arr.length() > 0) arr.optJSONObject(0) else null
        if (o != null) {
            val name = truncate(o.optString("name", "主屏"))
            val w = o.optInt("w", 0)
            val h = o.optInt("h", 0)
            val hz = o.optDouble("refresh_hz", 0.0)
            val res = if (w > 0 && h > 0) "${w}×${h}" else ""
            val hzS = if (hz > 0) "${hz.roundToInt()}Hz" else ""
            val p = listOf(res, hzS).filter { it.isNotEmpty() }.joinToString(" · ")
            return listOf(
                SpecLine("显示屏", true),
                SpecLine(name, false),
                SpecLine(truncate(p.ifBlank { "内置" }), false),
            )
        }
        return listOf(SpecLine("显示屏", true), SpecLine("主屏", false))
    }

    fun cameraLines(inv: JSONObject?, live: Context, facing: Int, title: String): List<SpecLine> {
        val arr = inv?.optJSONArray("cameras")
        var pick: JSONObject? = null
        if (arr != null) {
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i)
                if (o?.optInt("facing") == facing) {
                    pick = o
                    break
                }
            }
            if (pick == null && arr.length() > 0) pick = arr.optJSONObject(0)
        }
        if (pick == null) {
            try {
                val cm = live.getSystemService(Context.CAMERA_SERVICE) as CameraManager
                for (id in cm.cameraIdList) {
                    val ch = cm.getCameraCharacteristics(id)
                    if (ch.get(CameraCharacteristics.LENS_FACING) == facing) {
                        val size = ch.get(CameraCharacteristics.SENSOR_INFO_PIXEL_ARRAY_SIZE)
                        val focals = ch.get(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS)
                        pick = JSONObject()
                            .put("id", id)
                            .put("pixel_w", size?.width ?: 0)
                            .put("pixel_h", size?.height ?: 0)
                            .put("focals_mm", focals?.firstOrNull()?.toDouble() ?: 0.0)
                        break
                    }
                }
            } catch (_: Exception) {
            }
        }
        if (pick == null) return listOf(SpecLine(title, true), SpecLine("本机无", false))
        val w = pick.optInt("pixel_w", 0)
        val h = pick.optInt("pixel_h", 0)
        val mp = if (w > 0 && h > 0) "${(w * h / 1_000_000.0).roundToInt()}MP" else ""
        val focal = pick.optDouble("focals_mm", 0.0)
        val focalS = if (focal > 0) "焦距 ${fmtNum(focal)}mm" else ""
        val p = listOf(mp, focalS).filter { it.isNotEmpty() }.joinToString(" · ")
        return listOf(
            SpecLine(title, true),
            SpecLine("id ${pick.optString("id", "0")}", false),
            SpecLine(truncate(p.ifBlank { "已探测" }), false),
        )
    }

    fun cpuLines(inv: JSONObject?): List<SpecLine> {
        val build = inv?.optJSONObject("build")
        val cpu = inv?.optJSONObject("cpu")
        val soc = build?.optString("soc_model", "").orEmpty()
        val model = when {
            soc.isNotBlank() -> truncate(soc)
            build != null -> truncate("${build.optString("manufacturer")} ${build.optString("model")}")
            else -> "处理器"
        }
        val cores = cpu?.optInt("cores", 0) ?: 0
        val coreS = if (cores > 0) "$cores 核" else ""
        return listOf(
            SpecLine("处理器", true),
            SpecLine(model, false),
            SpecLine(truncate(coreS.ifBlank { Build.HARDWARE }), false),
        )
    }

    fun memoryLines(inv: JSONObject?): List<SpecLine> {
        val mem = inv?.optJSONObject("memory")
        val total = mem?.optLong("total_bytes", 0L) ?: 0L
        val gb = if (total > 0) "${(total / (1024.0 * 1024.0 * 1024.0)).roundToInt()} GB" else "RAM"
        return listOf(SpecLine("内存", true), SpecLine(gb, false))
    }

    fun featureLines(title: String, present: Boolean, detail: String): List<SpecLine> {
        if (!present) return listOf(SpecLine(title, true), SpecLine("本机无", false))
        return listOf(SpecLine(title, true), SpecLine(truncate(detail), false))
    }

    fun gpsLines(inv: JSONObject?, live: Context): List<SpecLine> {
        val pm = live.packageManager
        val has = pm.hasSystemFeature(PackageManager.FEATURE_LOCATION_GPS)
        if (!has) return listOf(SpecLine("GPS", true), SpecLine("本机无", false))
        return listOf(
            SpecLine("GPS", true),
            SpecLine("系统定位", false),
            SpecLine("FEATURE_GPS", false),
        )
    }

    fun simpleLines(title: String, line2: String, line3: String = ""): List<SpecLine> {
        val out = mutableListOf(SpecLine(title, true), SpecLine(truncate(line2), false))
        if (line3.isNotBlank()) out.add(SpecLine(truncate(line3), false))
        return out
    }

    private fun fmtNum(v: Double): String {
        if (v >= 100) return v.roundToInt().toString()
        if (v >= 10) return String.format(Locale.US, "%.1f", v)
        return String.format(Locale.US, "%.2f", v)
    }

    data class SpecLine(val text: String, val title: Boolean)
}
