package com.omnitrace.android.host

import android.content.Context
import org.json.JSONObject

enum class ModuleStatus {
    Idle, Running, Degraded, Stopped, Unavailable
}

class ModuleContext(
    val app: Context,
    val dataRoot: java.io.File,
    val startedAtMs: Long,
    val profile: String,
    val deviceId: String,
    val imu: ImuBinWriter,
)

interface TraceModule {
    val id: String
    val name: String
    val version: String
    fun start(ctx: ModuleContext, sink: EventSink)
    fun tick(ctx: ModuleContext, sink: EventSink) {}
    fun tickIntervalMs(): Long? = null
    fun stop() {}
    fun status(): ModuleStatus = ModuleStatus.Idle
}

class ModuleRegistry {
    private val all = LinkedHashMap<String, TraceModule>()
    private val lastTick = HashMap<String, Long>()

    fun register(m: TraceModule) {
        all[m.id] = m
    }

    fun modules(): List<TraceModule> = all.values.toList()

    fun ids(): List<String> = all.keys.toList()

    fun startAll(ctx: ModuleContext, sink: EventSink) {
        for (m in all.values) {
            try {
                m.start(ctx, sink)
            } catch (e: Exception) {
                sink.emit(
                    m.id,
                    "module_error",
                    JSONObject().kv("where", "start").kv("err", e.message ?: e.javaClass.simpleName),
                )
            }
        }
    }

    fun tickAll(now: Long, ctx: ModuleContext, sink: EventSink) {
        for (m in all.values) {
            val iv = m.tickIntervalMs() ?: continue
            val prev = lastTick[m.id] ?: 0L
            if (now - prev >= iv) {
                lastTick[m.id] = now
                try {
                    m.tick(ctx, sink)
                } catch (e: Exception) {
                    sink.emit(
                        m.id,
                        "module_error",
                        JSONObject().kv("where", "tick").kv("err", e.message ?: e.javaClass.simpleName),
                    )
                }
            }
        }
    }

    fun stopAll() {
        all.values.forEach {
            try {
                it.stop()
            } catch (_: Exception) {
            }
        }
    }
}
