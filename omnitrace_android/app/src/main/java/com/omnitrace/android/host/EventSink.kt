package com.omnitrace.android.host

import org.json.JSONObject
import java.io.BufferedWriter
import java.io.File
import java.io.FileOutputStream
import java.io.OutputStreamWriter
import java.util.Calendar
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** ModuleEvent JSONL：`{ v:1, module, ts, kind, payload }`。写盘在后台线程，主线程只入队。 */
class EventSink(private val root: File) {
    private val writers = ConcurrentHashMap<String, DayWriter>()
    private val io = Executors.newSingleThreadExecutor { r ->
        Thread(r, "omni-jsonl").apply { isDaemon = true }
    }

    fun emit(module: String, kind: String, payload: JSONObject = JSONObject()) {
        val ev = JSONObject()
            .kv("v", 1)
            .kv("module", module)
            .kv("ts", JsonUtil.nowMs())
            .kv("kind", kind)
            .kv("payload", payload)
        val line = ev.toString()
        try {
            io.execute { writers.getOrPut(module) { DayWriter(module) }.write(line) }
        } catch (_: Exception) {
        }
    }

    fun close() {
        io.shutdown()
        try {
            io.awaitTermination(2, TimeUnit.SECONDS)
        } catch (_: Exception) {
        }
        writers.values.forEach { it.close() }
        writers.clear()
    }

    fun eventsPath(module: String): String {
        return OmniPaths.moduleEventsToday(root, module).absolutePath
    }

    private inner class DayWriter(private val module: String) {
        private var day = -1
        private var writer: BufferedWriter? = null
        private var dirty = 0
        private val lock = Any()

        fun write(line: String) {
            synchronized(lock) {
                val cal = Calendar.getInstance()
                val d = OmniPaths.day(cal)
                if (d != day || writer == null) {
                    writer?.flush()
                    writer?.close()
                    val f = OmniPaths.moduleEventsToday(root, module, cal)
                    writer = BufferedWriter(
                        OutputStreamWriter(FileOutputStream(f, true), Charsets.UTF_8),
                        16 * 1024,
                    )
                    day = d
                    dirty = 0
                }
                writer!!.append(line)
                writer!!.append('\n')
                dirty++
                if (dirty >= 16) {
                    writer!!.flush()
                    dirty = 0
                }
            }
        }

        fun close() {
            synchronized(lock) {
                try {
                    writer?.flush()
                    writer?.close()
                } catch (_: Exception) {
                }
                writer = null
            }
        }
    }
}
