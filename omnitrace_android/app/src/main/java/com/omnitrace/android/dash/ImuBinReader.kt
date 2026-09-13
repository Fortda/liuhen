package com.omnitrace.android.dash

import com.omnitrace.android.host.ImuBinWriter
import com.omnitrace.android.host.OmniPaths
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Calendar
import kotlin.math.sqrt

/** 读 `imu_DD.bin`，产出分钟级静止段（低陀螺运动）。 */
object ImuBinReader {
    fun stillSpans(root: File, dayStart: Long, dayEnd: Long): List<Span> {
        val cal = Calendar.getInstance()
        cal.timeInMillis = dayStart
        val bin = File(OmniPaths.eventDataDir(root, cal), String.format("imu_%02d.bin", OmniPaths.day(cal)))
        if (!bin.isFile) return emptyList()
        val bucketMs = DashCaliber.IMU_STILL_BUCKET_MS
        val buckets = HashMap<Long, Int>()
        parse(bin) { ts, ch, x, y, z ->
            if (ts < dayStart || ts >= dayEnd) return@parse
            if (ch != ImuBinWriter.CH_GYRO) return@parse
            val mag = sqrt((x * x + y * y + z * z).toDouble()).toInt()
            val b = (ts / bucketMs) * bucketMs
            val prev = buckets[b] ?: 0
            if (mag > prev) buckets[b] = mag
        }
        if (buckets.isEmpty()) return emptyList()
        val stillEdges = ArrayList<Pair<Long, Boolean>>()
        var t = dayStart
        while (t < dayEnd) {
            val mag = buckets[t] ?: 0
            stillEdges.add(t to (mag <= DashCaliber.IMU_STILL_GYRO_MAX))
            t += bucketMs
        }
        return SpanUtil.fromEdges(stillEdges, dayEnd)
    }

    private fun parse(file: File, onSample: (ts: Long, ch: Int, x: Int, y: Int, z: Int) -> Unit) {
        val data = file.readBytes()
        if (data.size < 16) return
        var i = 16
        var lastTs = -1L
        var lastX = IntArray(5)
        var lastY = IntArray(5)
        var lastZ = IntArray(5)
        while (i < data.size) {
            val b = data[i].toInt() and 0xFF
            if (b == 0xFF) {
                if (i + 16 > data.size) break
                val buf = ByteBuffer.wrap(data, i, 16).order(ByteOrder.BIG_ENDIAN)
                buf.get()
                val ts = buf.long
                val ch = buf.get().toInt() and 0xFF
                val x = buf.short.toInt()
                val y = buf.short.toInt()
                val z = buf.short.toInt()
                if (ch in 1..4) {
                    onSample(ts, ch, x, y, z)
                    lastTs = ts
                    lastX[ch] = x
                    lastY[ch] = y
                    lastZ[ch] = z
                }
                i += 16
            } else if (b in 1..250) {
                if (i + 5 > data.size) break
                val dt = b
                val ch = data[i + 1].toInt() and 0xFF
                val dx = data[i + 2].toByte().toInt()
                val dy = data[i + 3].toByte().toInt()
                val dz = data[i + 4].toByte().toInt()
                if (ch in 1..4 && lastTs >= 0) {
                    lastTs += dt
                    val x = lastX[ch] + dx
                    val y = lastY[ch] + dy
                    val z = lastZ[ch] + dz
                    onSample(lastTs, ch, x, y, z)
                    lastX[ch] = x
                    lastY[ch] = y
                    lastZ[ch] = z
                }
                i += 5
            } else {
                i++
            }
        }
    }
}
