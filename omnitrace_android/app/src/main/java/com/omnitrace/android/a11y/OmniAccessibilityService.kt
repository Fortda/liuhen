package com.omnitrace.android.a11y

import android.accessibilityservice.AccessibilityService
import android.view.accessibility.AccessibilityEvent
import com.omnitrace.android.host.HostBridge
import java.lang.ref.WeakReference

class OmniAccessibilityService : AccessibilityService() {
    override fun onServiceConnected() {
        HostBridge.a11y = WeakReference(this)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        if (event != null) HostBridge.dispatch(event)
    }

    override fun onInterrupt() {}

    override fun onDestroy() {
        if (HostBridge.a11y?.get() === this) HostBridge.a11y = null
        super.onDestroy()
    }
}
