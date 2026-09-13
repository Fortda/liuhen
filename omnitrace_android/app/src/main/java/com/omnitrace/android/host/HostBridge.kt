package com.omnitrace.android.host

import android.view.accessibility.AccessibilityEvent
import com.omnitrace.android.a11y.OmniAccessibilityService
import java.lang.ref.WeakReference
import java.util.concurrent.CopyOnWriteArrayList

/** 无障碍服务把事件交给 focus / touch / ui_map。 */
object HostBridge {
    @Volatile
    var running: Boolean = false

    var a11y: WeakReference<OmniAccessibilityService>? = null

    private val listeners = CopyOnWriteArrayList<(AccessibilityEvent) -> Unit>()

    fun addListener(l: (AccessibilityEvent) -> Unit) {
        listeners.add(l)
    }

    fun removeListener(l: (AccessibilityEvent) -> Unit) {
        listeners.remove(l)
    }

    fun dispatch(ev: AccessibilityEvent) {
        if (!running) return
        for (l in listeners) {
            try {
                l(ev)
            } catch (_: Exception) {
            }
        }
    }

    fun service(): OmniAccessibilityService? = a11y?.get()
}
