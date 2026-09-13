package com.omnitrace.android.dash

import com.omnitrace.android.RecordService
import com.omnitrace.android.host.OmniPaths
import org.json.JSONObject
import java.io.File

object HealthSpans {
    fun recording(root: File, now: Long): List<Span> {
        val f = OmniPaths.healthLog(root)
        if (!f.isFile) return emptyList()
        val byMod = LinkedHashMap<String, ModBuf>()
        f.forEachLine(Charsets.UTF_8) { line ->
            val s = line.trim()
            if (s.isEmpty()) return@forEachLine
            val o = try {
                JSONObject(s)
            } catch (_: Exception) {
                return@forEachLine
            }
            val mod = o.optString("module")
            if (mod.isEmpty()) return@forEachLine
            val ts = o.optLong("ts", -1L)
            if (ts < 0) return@forEachLine
            val buf = byMod.getOrPut(mod) { ModBuf() }
            when (o.optString("kind")) {
                "start" -> buf.starts.add(ts)
                "tombstone" -> buf.ends.add(ts)
                "beat" -> buf.lastBeat = ts
            }
        }
        val prefer = byMod[DashCaliber.HEALTH_MODULE] ?: byMod["hw"] ?: byMod.values.firstOrNull()
            ?: return emptyList()
        return spansOf(prefer, now)
    }

    private class ModBuf {
        val starts = ArrayList<Long>()
        val ends = ArrayList<Long>()
        var lastBeat = -1L
    }

    private fun spansOf(buf: ModBuf, now: Long): List<Span> {
        val out = ArrayList<Span>()
        var ei = 0
        val starts = buf.starts
        val ends = buf.ends
        for (i in starts.indices) {
            val a = starts[i]
            val nextStart = starts.getOrNull(i + 1) ?: Long.MAX_VALUE
            var b = -1L
            while (ei < ends.size && ends[ei] < a) ei++
            if (ei < ends.size && ends[ei] < nextStart) {
                b = ends[ei]
                ei++
            }
            if (b < 0) {
                b = when {
                    i == starts.lastIndex && RecordService.running.get() -> now
                    buf.lastBeat > a -> buf.lastBeat
                    else -> a
                }
            }
            if (b > a) out.add(Span(a, b))
        }
        return SpanUtil.merge(out)
    }
}
