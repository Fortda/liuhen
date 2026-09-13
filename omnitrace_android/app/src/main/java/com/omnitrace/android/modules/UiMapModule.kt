package com.omnitrace.android.modules

import android.content.Context
import android.graphics.Rect
import android.hardware.display.DisplayManager
import android.os.Build
import android.util.DisplayMetrics
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import android.view.accessibility.AccessibilityWindowInfo
import com.omnitrace.android.host.EventSink
import com.omnitrace.android.host.HostBridge
import com.omnitrace.android.host.ModuleContext
import com.omnitrace.android.host.ModuleStatus
import com.omnitrace.android.host.TraceModule
import com.omnitrace.android.host.kv
import org.json.JSONArray
import org.json.JSONObject

/** 显示器几何 + 无障碍窗栈 + 焦点切换时浅控件树。 */
class UiMapModule : TraceModule {
    override val id = "ui_map"
    override val name = "Semantic window map"
    override val version = "0.1.0"

    private var st = ModuleStatus.Idle
    private var sink: EventSink? = null
    private var lastFocusKey = ""
    private val listener: (AccessibilityEvent) -> Unit = { onEvent(it) }
    private val main = android.os.Handler(android.os.Looper.getMainLooper())
    private var pendingReason = "windows_changed"
    private val dumpSoon = Runnable { dumpWindows(pendingReason) }

    override fun status(): ModuleStatus = st

    override fun start(ctx: ModuleContext, sink: EventSink) {
        this.sink = sink
        sink.emit(id, "module_hello", JSONObject().kv("implemented", true).kv("pixels", false))
        emitDisplaySetup(ctx.app)
        HostBridge.addListener(listener)
        dumpWindows("start")
        st = if (HostBridge.service() != null) ModuleStatus.Running else ModuleStatus.Degraded
    }

    override fun stop() {
        main.removeCallbacks(dumpSoon)
        HostBridge.removeListener(listener)
        st = ModuleStatus.Stopped
    }

    private fun onEvent(ev: AccessibilityEvent) {
        when (ev.eventType) {
            AccessibilityEvent.TYPE_WINDOWS_CHANGED -> scheduleDump("windows_changed")
            AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED -> {
                scheduleDump("window_state")
                maybeShallowTree(ev)
            }
        }
    }

    private fun scheduleDump(reason: String) {
        pendingReason = reason
        main.removeCallbacks(dumpSoon)
        main.postDelayed(dumpSoon, 220)
    }

    private fun emitDisplaySetup(app: Context) {
        val dm = app.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
        val arr = JSONArray()
        for (d in dm.displays) {
            val m = DisplayMetrics()
            d.getRealMetrics(m)
            arr.put(
                JSONObject()
                    .kv("id", d.displayId)
                    .kv("name", d.name)
                    .kv("w", m.widthPixels)
                    .kv("h", m.heightPixels)
                    .kv("dpi", m.densityDpi)
                    .kv("refresh_hz", d.refreshRate.toDouble()),
            )
        }
        sink?.emit(id, "display_setup", JSONObject().kv("displays", arr))
    }

    private fun dumpWindows(reason: String) {
        val svc = HostBridge.service() ?: return
        val wins = svc.windows ?: emptyList()
        val arr = JSONArray()
        for (w in wins) {
            val b = Rect()
            w.getBoundsInScreen(b)
            arr.put(
                JSONObject()
                    .kv("id", w.id)
                    .kv("type", w.type)
                    .kv("title", w.title?.toString() ?: "")
                    .kv("pkg", windowPkg(w))
                    .kv("focused", w.isFocused)
                    .kv("active", w.isActive)
                    .kv("layer", if (Build.VERSION.SDK_INT >= 21) w.layer else JSONObject.NULL)
                    .kv("bounds", JSONObject().kv("l", b.left).kv("t", b.top).kv("r", b.right).kv("b", b.bottom)),
            )
        }
        sink?.emit(id, "win_snapshot", JSONObject().kv("reason", reason).kv("n", wins.size).kv("windows", arr))
        if (st == ModuleStatus.Degraded) st = ModuleStatus.Running
    }

    private fun windowPkg(w: AccessibilityWindowInfo): String {
        val root = w.root ?: return ""
        val pkg = root.packageName?.toString() ?: ""
        root.recycle()
        return pkg
    }

    private fun maybeShallowTree(ev: AccessibilityEvent) {
        val key = "${ev.packageName}|${ev.className}"
        if (key == lastFocusKey) return
        lastFocusKey = key
        val src = ev.source
        if (src == null) {
            sink?.emit(id, "ui_tree", JSONObject().kv("readable", false).kv("package", ev.packageName?.toString() ?: ""))
            return
        }
        val nodes = JSONArray()
        val budget = intArrayOf(80)
        dumpNode(src, 0, 3, nodes, budget)
        src.recycle()
        sink?.emit(
            id,
            "ui_tree",
            JSONObject()
                .kv("readable", nodes.length() > 0)
                .kv("package", ev.packageName?.toString() ?: "")
                .kv("nodes", nodes),
        )
    }

    private fun dumpNode(
        node: AccessibilityNodeInfo,
        depth: Int,
        maxDepth: Int,
        out: JSONArray,
        budget: IntArray,
    ) {
        if (budget[0] <= 0 || depth > maxDepth) return
        budget[0]--
        val b = Rect()
        node.getBoundsInScreen(b)
        out.put(
            JSONObject()
                .kv("d", depth)
                .kv("class", node.className?.toString() ?: "")
                .kv("id", node.viewIdResourceName ?: "")
                .kv("text", node.text?.toString()?.take(80) ?: "")
                .kv("desc", node.contentDescription?.toString()?.take(80) ?: "")
                .kv("click", node.isClickable)
                .kv("scroll", node.isScrollable)
                .kv("bounds", JSONObject().kv("l", b.left).kv("t", b.top).kv("r", b.right).kv("b", b.bottom)),
        )
        val n = node.childCount
        for (i in 0 until n) {
            val child = node.getChild(i) ?: continue
            dumpNode(child, depth + 1, maxDepth, out, budget)
            child.recycle()
        }
    }
}
