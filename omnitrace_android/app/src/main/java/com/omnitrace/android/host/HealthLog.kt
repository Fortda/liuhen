package com.omnitrace.android.host

import org.json.JSONObject
import java.io.File
import java.io.FileOutputStream

/** 对齐桌面 `health.rs`：`{ ts, kind, module, ... }` */
object HealthLog {
    fun append(root: File, kind: String, module: String, extra: JSONObject = JSONObject()) {
        val obj = JSONObject()
            .kv("ts", JsonUtil.nowMs())
            .kv("kind", kind)
            .kv("module", module)
        extra.keys().forEach { k -> obj.put(k, extra.get(k)) }
        val f = OmniPaths.healthLog(root)
        FileOutputStream(f, true).use { out ->
            out.write((obj.toString() + "\n").toByteArray(Charsets.UTF_8))
        }
    }

    fun markStarts(root: File, modules: List<String>) {
        modules.forEach { append(root, "start", it) }
    }

    fun markBeats(root: File, modules: List<String>) {
        modules.forEach { append(root, "beat", it) }
    }

    fun markTombstones(root: File, modules: List<String>, reason: String) {
        val extra = JSONObject().kv("reason", reason)
        modules.forEach { append(root, "tombstone", it, extra) }
    }
}
