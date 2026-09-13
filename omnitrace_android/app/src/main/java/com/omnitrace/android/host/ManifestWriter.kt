package com.omnitrace.android.host

import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

object ManifestWriter {
    fun write(
        root: File,
        deviceId: String,
        profile: String,
        startedAtMs: Long,
        modules: List<TraceModule>,
        sink: EventSink,
    ) {
        val arr = JSONArray()
        for (m in modules) {
            val st = m.status().name.lowercase()
            arr.put(
                JSONObject()
                    .kv("id", m.id)
                    .kv("name", m.name)
                    .kv("version", m.version)
                    .kv("enabled", true)
                    .kv("status", st)
                    .kv("capabilities", 1)
                    .kv("events_path", sink.eventsPath(m.id)),
            )
        }
        val obj = JSONObject()
            .kv("v", 1)
            .kv("session_started_ms", startedAtMs)
            .kv("data_root", root.absolutePath)
            .kv("source", "android")
            .kv("os", "android")
            .kv("device_id", deviceId)
            .kv("profile", profile)
            .kv("uptime_ms", SystemClock.elapsedRealtime())
            .kv("modules", arr)
        FileOutputStream(OmniPaths.manifest(root)).use {
            it.write((obj.toString() + "\n").toByteArray(Charsets.UTF_8))
        }
    }
}
