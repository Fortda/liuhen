package com.omnitrace.android.host

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import android.view.accessibility.AccessibilityManager
import androidx.core.content.ContextCompat

object CapturePermProbe {
    fun has(ctx: Context, perm: String): Boolean =
        ContextCompat.checkSelfPermission(ctx, perm) == PackageManager.PERMISSION_GRANTED

    fun a11yOn(ctx: Context): Boolean {
        val am = ctx.getSystemService(Context.ACCESSIBILITY_SERVICE) as AccessibilityManager
        if (!am.isEnabled) return false
        val id = "${ctx.packageName}/com.omnitrace.android.a11y.OmniAccessibilityService"
        val enabled = Settings.Secure.getString(ctx.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: ""
        return enabled.split(':').any { it.equals(id, true) || it.endsWith("OmniAccessibilityService") }
    }

    fun a11yConnected(): Boolean = HostBridge.service() != null

    fun batteryUnrestricted(ctx: Context): Boolean {
        val pm = ctx.getSystemService(Context.POWER_SERVICE) as PowerManager
        return pm.isIgnoringBatteryOptimizations(ctx.packageName)
    }

    fun hasFineLocation(ctx: Context): Boolean = has(ctx, Manifest.permission.ACCESS_FINE_LOCATION)

    fun hasActivityRecognition(ctx: Context): Boolean {
        if (Build.VERSION.SDK_INT < 29) return true
        return has(ctx, Manifest.permission.ACTIVITY_RECOGNITION)
    }

    fun hasRadioPerms(ctx: Context): Boolean {
        if (!hasFineLocation(ctx)) return false
        if (Build.VERSION.SDK_INT >= 31) {
            if (!has(ctx, Manifest.permission.BLUETOOTH_CONNECT)) return false
            if (!has(ctx, Manifest.permission.BLUETOOTH_SCAN)) return false
        }
        if (Build.VERSION.SDK_INT >= 33 && !has(ctx, Manifest.permission.NEARBY_WIFI_DEVICES)) return false
        return has(ctx, Manifest.permission.READ_PHONE_STATE)
    }

    enum class Need {
        NONE,
        LOCATION,
        ACTIVITY,
        RADIO,
        A11Y,
    }

    fun needSatisfied(ctx: Context, need: Need): Boolean = when (need) {
        Need.NONE -> true
        Need.LOCATION -> hasFineLocation(ctx)
        Need.ACTIVITY -> hasActivityRecognition(ctx)
        Need.RADIO -> hasRadioPerms(ctx)
        Need.A11Y -> a11yOn(ctx) && a11yConnected()
    }
}
