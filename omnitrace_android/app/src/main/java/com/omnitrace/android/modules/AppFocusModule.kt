package com.omnitrace.android.modules

import android.view.accessibility.AccessibilityEvent
import com.omnitrace.android.host.EventSink
import com.omnitrace.android.host.HostBridge
import com.omnitrace.android.host.ModuleContext
import com.omnitrace.android.host.ModuleStatus
import com.omnitrace.android.host.TraceModule
import com.omnitrace.android.host.kv
import org.json.JSONObject

class AppFocusModule : TraceModule {
    override val id = "app_focus"
    override val name = "Foreground app"
    override val version = "0.1.0"

    private var st = ModuleStatus.Idle
    private var sink: EventSink? = null
    private var lastKey = ""
    private val listener: (AccessibilityEvent) -> Unit = { onEvent(it) }

    override fun status(): ModuleStatus = st

    override fun start(ctx: ModuleContext, sink: EventSink) {
        this.sink = sink
        val a11y = HostBridge.service()
        sink.emit(
            id,
            "module_hello",
            JSONObject().kv("implemented", true).kv("a11y", a11y != null),
        )
        HostBridge.addListener(listener)
        st = if (a11y != null) ModuleStatus.Running else ModuleStatus.Degraded
    }

    override fun stop() {
        HostBridge.removeListener(listener)
        st = ModuleStatus.Stopped
    }

    private fun onEvent(ev: AccessibilityEvent) {
        if (ev.eventType != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED &&
            ev.eventType != AccessibilityEvent.TYPE_WINDOWS_CHANGED
        ) {
            return
        }
        val pkg = ev.packageName?.toString() ?: ""
        val cls = ev.className?.toString() ?: ""
        val title = ev.text.joinToString(" ")
        val key = "$pkg|$cls|$title"
        if (key == lastKey) return
        lastKey = key
        sink?.emit(
            id,
            "focus_change",
            JSONObject()
                .kv("package", pkg)
                .kv("class", cls)
                .kv("title", title)
                .kv("event", ev.eventType),
        )
        if (st == ModuleStatus.Degraded && HostBridge.service() != null) {
            st = ModuleStatus.Running
        }
    }
}
