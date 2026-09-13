package com.omnitrace.android.modules

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Bundle
import android.os.Looper
import androidx.core.content.ContextCompat
import com.omnitrace.android.host.EventSink
import com.omnitrace.android.host.ModuleContext
import com.omnitrace.android.host.ModuleStatus
import com.omnitrace.android.host.TraceModule
import com.omnitrace.android.host.kv
import org.json.JSONObject

class GpsModule : TraceModule, LocationListener {
    override val id = "gps"
    override val name = "Locator"
    override val version = "0.1.0"

    private var st = ModuleStatus.Idle
    private var lm: LocationManager? = null
    private var sink: EventSink? = null
    private var app: Context? = null

    override fun status(): ModuleStatus = st

    override fun start(ctx: ModuleContext, sink: EventSink) {
        this.sink = sink
        this.app = ctx.app
        lm = ctx.app.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        val fine = ContextCompat.checkSelfPermission(ctx.app, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
        sink.emit(id, "module_hello", JSONObject().kv("implemented", true).kv("fine", fine))
        if (!fine) {
            sink.emit(id, "self_check", JSONObject().kv("ok", false).kv("reason", "no_location_permission"))
            st = ModuleStatus.Degraded
            return
        }
        val max = ctx.profile == "max"
        val minTime = if (max) 5_000L else 30_000L
        val minDist = if (max) 2f else 10f
        try {
            val gpsOn = lm?.isProviderEnabled(LocationManager.GPS_PROVIDER) == true
            val netOn = lm?.isProviderEnabled(LocationManager.NETWORK_PROVIDER) == true
            sink.emit(id, "provider", JSONObject().kv("gps", gpsOn).kv("network", netOn))
            if (gpsOn) {
                lm?.requestLocationUpdates(LocationManager.GPS_PROVIDER, minTime, minDist, this, Looper.getMainLooper())
            }
            if (netOn) {
                lm?.requestLocationUpdates(LocationManager.NETWORK_PROVIDER, minTime, minDist, this, Looper.getMainLooper())
            }
            val last = lm?.getLastKnownLocation(LocationManager.GPS_PROVIDER)
                ?: lm?.getLastKnownLocation(LocationManager.NETWORK_PROVIDER)
            if (last != null) emitLoc(last, "last_known")
            st = ModuleStatus.Running
        } catch (e: SecurityException) {
            sink.emit(id, "self_check", JSONObject().kv("ok", false).kv("err", e.message))
            st = ModuleStatus.Degraded
        }
    }

    override fun stop() {
        try {
            lm?.removeUpdates(this)
        } catch (_: Exception) {
        }
        st = ModuleStatus.Stopped
    }

    override fun onLocationChanged(location: Location) {
        emitLoc(location, "update")
    }

    @Deprecated("Deprecated in Java")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}

    override fun onProviderEnabled(provider: String) {
        sink?.emit(id, "provider_enabled", JSONObject().kv("provider", provider))
    }

    override fun onProviderDisabled(provider: String) {
        sink?.emit(id, "provider_disabled", JSONObject().kv("provider", provider))
    }

    private fun emitLoc(loc: Location, reason: String) {
        sink?.emit(
            id,
            "fix",
            JSONObject()
                .kv("reason", reason)
                .kv("provider", loc.provider)
                .kv("lat", loc.latitude)
                .kv("lon", loc.longitude)
                .kv("acc_m", loc.accuracy.toDouble())
                .kv("alt", if (loc.hasAltitude()) loc.altitude else JSONObject.NULL)
                .kv("speed", if (loc.hasSpeed()) loc.speed.toDouble() else JSONObject.NULL)
                .kv("bearing", if (loc.hasBearing()) loc.bearing.toDouble() else JSONObject.NULL)
                .kv("loc_ts", loc.time),
        )
    }
}
