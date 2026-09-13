package com.omnitrace.android.modules

import android.graphics.Rect
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import com.omnitrace.android.host.EventSink
import com.omnitrace.android.host.HostBridge
import com.omnitrace.android.host.ModuleContext
import com.omnitrace.android.host.ModuleStatus
import com.omnitrace.android.host.TraceModule
import com.omnitrace.android.host.kv
import org.json.JSONObject

/** 交互级触摸：点了哪个控件，不是全局原始轨迹。 */
class TouchModule : TraceModule {
    override val id = "touch"
    override val name = "Touch interactions"
    override val version = "0.1.0"

    private var st = ModuleStatus.Idle
    private var sink: EventSink? = null
    private var lastScrollAt = 0L
    private var lastTextAt = 0L
    private val listener: (AccessibilityEvent) -> Unit = { onEvent(it) }

    override fun status(): ModuleStatus = st

    override fun start(ctx: ModuleContext, sink: EventSink) {
        this.sink = sink
        sink.emit(id, "module_hello", JSONObject().kv("implemented", true).kv("raw_path", false))
        HostBridge.addListener(listener)
        st = if (HostBridge.service() != null) ModuleStatus.Running else ModuleStatus.Degraded
    }

    override fun stop() {
        HostBridge.removeListener(listener)
        st = ModuleStatus.Stopped
    }

    private fun onEvent(ev: AccessibilityEvent) {
        val kind = when (ev.eventType) {
            AccessibilityEvent.TYPE_VIEW_CLICKED -> "view_clicked"
            AccessibilityEvent.TYPE_VIEW_LONG_CLICKED -> "view_long_clicked"
            AccessibilityEvent.TYPE_VIEW_SCROLLED -> "view_scrolled"
            AccessibilityEvent.TYPE_VIEW_TEXT_CHANGED -> "view_text_changed"
            else -> return
        }
        if (kind == "view_scrolled") {
            val now = android.os.SystemClock.uptimeMillis()
            if (now - lastScrollAt < 220) return
            lastScrollAt = now
        }
        if (kind == "view_text_changed") {
            val now = android.os.SystemClock.uptimeMillis()
            if (now - lastTextAt < 280) return
            lastTextAt = now
        }
        val src = ev.source
        val bounds = Rect()
        src?.getBoundsInScreen(bounds)
        val payload = JSONObject()
            .kv("package", ev.packageName?.toString() ?: "")
            .kv("class", ev.className?.toString() ?: "")
            .kv("view_id", src?.viewIdResourceName ?: "")
            .kv("text", ev.text.joinToString(" ").take(200))
            .kv("content_desc", src?.contentDescription?.toString() ?: "")
            .kv("bounds", JSONObject().kv("l", bounds.left).kv("t", bounds.top).kv("r", bounds.right).kv("b", bounds.bottom))
        if (kind == "view_scrolled") {
            payload.kv("scroll_x", ev.scrollX).kv("scroll_y", ev.scrollY)
        }
        src?.recycle()
        sink?.emit(id, kind, payload)
        if (st == ModuleStatus.Degraded && HostBridge.service() != null) st = ModuleStatus.Running
    }
}
