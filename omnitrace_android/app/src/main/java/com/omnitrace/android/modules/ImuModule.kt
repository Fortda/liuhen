package com.omnitrace.android.modules

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.PowerManager
import com.omnitrace.android.host.EventSink
import com.omnitrace.android.host.ImuBinWriter
import com.omnitrace.android.host.ModuleContext
import com.omnitrace.android.host.ModuleStatus
import com.omnitrace.android.host.Receivers
import com.omnitrace.android.host.TraceModule
import com.omnitrace.android.host.kv
import org.json.JSONObject

class ImuModule : TraceModule, SensorEventListener {
    override val id = "imu"
    override val name = "Inertial sensors"
    override val version = "0.1.0"

    private var st = ModuleStatus.Idle
    private var sm: SensorManager? = null
    private var ctx: ModuleContext? = null
    private var sink: EventSink? = null
    private var receiver: BroadcastReceiver? = null
    private var screenOn = true

    override fun status(): ModuleStatus = st

    override fun start(ctx: ModuleContext, sink: EventSink) {
        this.ctx = ctx
        this.sink = sink
        sm = ctx.app.getSystemService(Context.SENSOR_SERVICE) as SensorManager
        val pm = ctx.app.getSystemService(Context.POWER_SERVICE) as PowerManager
        screenOn = pm.isInteractive
        sink.emit(
            id,
            "module_hello",
            JSONObject().kv("implemented", true).kv("profile", ctx.profile).kv("file", "imu_DD.bin"),
        )
        registerSensors()
        receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, intent: Intent?) {
                when (intent?.action) {
                    Intent.ACTION_SCREEN_ON -> {
                        screenOn = true
                        reregister()
                    }
                    Intent.ACTION_SCREEN_OFF -> {
                        screenOn = false
                        reregister()
                    }
                }
            }
        }
        Receivers.register(
            ctx.app,
            receiver!!,
            IntentFilter().apply {
                addAction(Intent.ACTION_SCREEN_ON)
                addAction(Intent.ACTION_SCREEN_OFF)
            },
        )
        st = ModuleStatus.Running
    }

    override fun stop() {
        try {
            sm?.unregisterListener(this)
        } catch (_: Exception) {
        }
        try {
            receiver?.let { ctx?.app?.unregisterReceiver(it) }
        } catch (_: Exception) {
        }
        ctx?.imu?.flush()
        st = ModuleStatus.Stopped
    }

    private fun reregister() {
        sm?.unregisterListener(this)
        registerSensors()
        sink?.emit(id, "rate_change", JSONObject().kv("screen_on", screenOn).kv("profile", ctx?.profile))
    }

    private fun registerSensors() {
        val mgr = sm ?: return
        val max = ctx?.profile == "max"
        val accelUs = periodUs(max, screenOn, game = true)
        val magUs = if (max) 20_000 else if (screenOn) 40_000 else 200_000
        listen(mgr.getDefaultSensor(Sensor.TYPE_ACCELEROMETER), accelUs)
        listen(mgr.getDefaultSensor(Sensor.TYPE_GYROSCOPE), accelUs)
        listen(mgr.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD), magUs)
        if (max) {
            listen(mgr.getDefaultSensor(Sensor.TYPE_LINEAR_ACCELERATION), accelUs)
        }
    }

    private fun periodUs(max: Boolean, screenOn: Boolean, game: Boolean): Int {
        if (max) return SensorManager.SENSOR_DELAY_FASTEST
        if (!screenOn) return 100_000
        return if (game) SensorManager.SENSOR_DELAY_GAME else SensorManager.SENSOR_DELAY_UI
    }

    private fun listen(sensor: Sensor?, us: Int) {
        if (sensor == null) return
        sm?.registerListener(this, sensor, us)
    }

    override fun onSensorChanged(event: SensorEvent) {
        val ch = when (event.sensor.type) {
            Sensor.TYPE_ACCELEROMETER -> ImuBinWriter.CH_ACCEL
            Sensor.TYPE_LINEAR_ACCELERATION -> ImuBinWriter.CH_LINEAR
            Sensor.TYPE_GYROSCOPE -> ImuBinWriter.CH_GYRO
            Sensor.TYPE_MAGNETIC_FIELD -> ImuBinWriter.CH_MAG
            else -> return
        }
        val v = event.values
        if (v.size < 3) return
        val ts = System.currentTimeMillis()
        ctx?.imu?.write(ch, ts, v[0], v[1], v[2])
    }

    override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
}
