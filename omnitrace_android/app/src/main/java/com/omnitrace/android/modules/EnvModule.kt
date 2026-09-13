package com.omnitrace.android.modules

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import com.omnitrace.android.host.EventSink
import com.omnitrace.android.host.ModuleContext
import com.omnitrace.android.host.ModuleStatus
import com.omnitrace.android.host.TraceModule
import com.omnitrace.android.host.kv
import org.json.JSONObject
import kotlin.math.abs

/** 光感 / 色温 / 接近 / 计步：变化才写。 */
class EnvModule : TraceModule, SensorEventListener {
    override val id = "env"
    override val name = "Environment sensors"
    override val version = "0.1.0"

    private var st = ModuleStatus.Idle
    private var sm: SensorManager? = null
    private var sink: EventSink? = null
    private var lastLight = Float.NaN
    private var lastProx = Float.NaN
    private var lastCct = Float.NaN
    private var lastSteps = -1f

    override fun status(): ModuleStatus = st

    override fun start(ctx: ModuleContext, sink: EventSink) {
        this.sink = sink
        sm = ctx.app.getSystemService(Context.SENSOR_SERVICE) as SensorManager
        val mgr = sm!!
        sink.emit(id, "module_hello", JSONObject().kv("implemented", true))
        listen(mgr, Sensor.TYPE_LIGHT)
        listen(mgr, Sensor.TYPE_PROXIMITY)
        listen(mgr, Sensor.TYPE_STEP_COUNTER)
        val cct = findCct(mgr)
        if (cct != null) {
            mgr.registerListener(this, cct, SensorManager.SENSOR_DELAY_NORMAL)
        }
        st = ModuleStatus.Running
    }

    override fun stop() {
        try {
            sm?.unregisterListener(this)
        } catch (_: Exception) {
        }
        st = ModuleStatus.Stopped
    }

    private fun listen(mgr: SensorManager, type: Int) {
        val s = mgr.getDefaultSensor(type) ?: return
        mgr.registerListener(this, s, SensorManager.SENSOR_DELAY_NORMAL)
    }

    private fun findCct(mgr: SensorManager): Sensor? {
        for (s in mgr.getSensorList(Sensor.TYPE_ALL)) {
            val n = (s.name + " " + s.stringType).lowercase()
            if (n.contains("color") || n.contains("cct") || n.contains("色温")) return s
        }
        return null
    }

    override fun onSensorChanged(event: SensorEvent) {
        val s = sink ?: return
        val v0 = event.values.firstOrNull() ?: return
        when (event.sensor.type) {
            Sensor.TYPE_LIGHT -> {
                if (changed(lastLight, v0, 2f)) {
                    lastLight = v0
                    s.emit(id, "light", JSONObject().kv("lux", v0.toDouble()))
                }
            }
            Sensor.TYPE_PROXIMITY -> {
                if (changed(lastProx, v0, 0.01f)) {
                    lastProx = v0
                    s.emit(
                        id,
                        "proximity",
                        JSONObject().kv("cm", v0.toDouble()).kv("max", event.sensor.maximumRange.toDouble()),
                    )
                }
            }
            Sensor.TYPE_STEP_COUNTER -> {
                if (v0 != lastSteps) {
                    lastSteps = v0
                    s.emit(id, "steps", JSONObject().kv("count", v0.toDouble()))
                }
            }
            else -> {
                if (changed(lastCct, v0, 10f)) {
                    lastCct = v0
                    s.emit(
                        id,
                        "color_temp",
                        JSONObject().kv("name", event.sensor.name).kv("v0", v0.toDouble()),
                    )
                }
            }
        }
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}

    private fun changed(prev: Float, next: Float, eps: Float): Boolean {
        if (prev.isNaN()) return true
        return abs(prev - next) >= eps
    }
}
