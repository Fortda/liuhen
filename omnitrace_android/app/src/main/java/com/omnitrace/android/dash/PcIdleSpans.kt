package com.omnitrace.android.dash

import com.omnitrace.android.host.OmniPaths
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.Calendar
import java.util.Locale

/** 从联动缓存 linked_pc 下各主机的 cache/input_hist 里的 otih 文件读 PC 键鼠空闲段。 */
object PcIdleSpans {
    private const val VER = 1
    private const val FINE_MS = 1000L
    private const val SECS_PER_DAY = 86400

    fun hasLinkedData(root: File): Boolean {
        val base = OmniPaths.linkedPcRoot(root)
        return anyOtihUnder(base)
    }

    fun linkedHost(root: File): String? {
        val base = OmniPaths.linkedPcRoot(root)
        if (!base.isDirectory) return null
        for (hostDir in base.listFiles().orEmpty()) {
            if (!hostDir.isDirectory) continue
            if (anyOtihUnder(hostDir)) return hostDir.name
        }
        return null
    }

    fun idleSpans(root: File, dayStart: Long, dayEnd: Long, host: String?): List<Span> {
        val h = host ?: return emptyList()
        val file = File(OmniPaths.linkedPcInputHistDir(root, h), otihFileName(dayStart))
        val hist = load(file) ?: return emptyList()
        if (hist.dayStartMs != dayStart) return emptyList()
        val mouse = hist.mouse
        val key = hist.key
        val secs = minOf(SECS_PER_DAY, mouse.size, key.size)
        if (secs == 0) return emptyList()
        val active = BooleanArray(secs)
        for (sec in 0 until secs) {
            active[sec] = (mouse[sec] + key[sec]) > 0
        }
        val minIdleSec = (DashCaliber.PC_IDLE_MS / FINE_MS).toInt()
        val out = ArrayList<Span>()
        var i = 0
        while (i < secs) {
            if (active[i]) {
                i++
                continue
            }
            var j = i
            while (j < secs && !active[j]) j++
            if (j - i >= minIdleSec) {
                val a = dayStart + i * FINE_MS
                val b = dayStart + j * FINE_MS
                if (b > dayStart && a < dayEnd) {
                    out.add(Span(maxOf(a, dayStart), minOf(b, dayEnd)))
                }
            }
            i = j
        }
        return out
    }

    /** 当日 288 个 5 分钟格：格内任一秒 mouse+key >0。 */
    fun active5MinBins(root: File, dayStart: Long, host: String?): BooleanArray {
        val bins = BooleanArray(288)
        val h = host ?: return bins
        val file = File(OmniPaths.linkedPcInputHistDir(root, h), otihFileName(dayStart))
        val hist = load(file) ?: return bins
        if (hist.dayStartMs != dayStart) return bins
        val secs = minOf(SECS_PER_DAY, hist.mouse.size, hist.key.size)
        val binSecs = (DashCaliber.ACTIVE_BIN_MS / FINE_MS).toInt().coerceAtLeast(1)
        for (sec in 0 until secs) {
            if (hist.mouse[sec] + hist.key[sec] > 0) {
                val b = sec / binSecs
                if (b in bins.indices) bins[b] = true
            }
        }
        return bins
    }

    private fun anyOtihUnder(dir: File): Boolean {
        if (!dir.isDirectory) return false
        for (child in dir.listFiles().orEmpty()) {
            if (child.isFile && child.name.endsWith(".otih")) return true
            if (child.isDirectory && anyOtihUnder(child)) return true
        }
        return false
    }

    private fun otihFileName(dayStart: Long): String {
        val c = Calendar.getInstance()
        c.timeInMillis = dayStart
        return String.format(
            Locale.US,
            "%04d-%02d-%02d.otih",
            c.get(Calendar.YEAR),
            c.get(Calendar.MONTH) + 1,
            c.get(Calendar.DAY_OF_MONTH),
        )
    }

    private class Hist(
        val dayStartMs: Long,
        val mouse: IntArray,
        val key: IntArray,
    )

    private fun load(path: File): Hist? {
        if (!path.isFile) return null
        val data = path.readBytes()
        val hdr = 4 + 4 + 8 + 8 + 8 + 4 + 4
        if (data.size < hdr) return null
        if (!isOtihHeader(data)) return null
        val buf = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN)
        buf.position(4)
        val ver = buf.int
        if (ver != VER) return null
        val dayStart = buf.long
        buf.long // processed
        buf.long // last_ts
        val fine = buf.int
        val secs = buf.int
        if (fine != FINE_MS.toInt() || secs != SECS_PER_DAY) return null
        if (data.size < hdr + secs * 8) return null
        val mouse = IntArray(secs)
        val key = IntArray(secs)
        for (i in 0 until secs) mouse[i] = buf.int
        for (i in 0 until secs) key[i] = buf.int
        return Hist(dayStart, mouse, key)
    }

    private fun isOtihHeader(data: ByteArray): Boolean {
        return data[0] == 'O'.code.toByte() &&
            data[1] == 'T'.code.toByte() &&
            data[2] == 'I'.code.toByte() &&
            data[3] == 'H'.code.toByte()
    }
}
