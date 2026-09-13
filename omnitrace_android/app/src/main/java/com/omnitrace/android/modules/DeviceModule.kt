package com.omnitrace.android.modules

import android.app.KeyguardManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.ConsumerIrManager
import android.nfc.NfcAdapter
import android.os.BatteryManager
import android.os.Build
import android.os.PowerManager
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import com.omnitrace.android.host.EventSink
import com.omnitrace.android.host.ModuleContext
import com.omnitrace.android.host.ModuleStatus
import com.omnitrace.android.host.Receivers
import com.omnitrace.android.host.TraceModule
import com.omnitrace.android.host.json
import org.json.JSONObject
import java.io.File

/**
 * 亮灭屏 / 锁 / 电量 / 亮度 + 振动/NFC/红外忙闲钩子。
 * 不归因到 App，不采集内容。
 */
class DeviceModule : TraceModule {
    override val id = "device"
    override val name = "Device live state"
    override val version = "0.1.0"

    private var st = ModuleStatus.Idle
    private var app: Context? = null
    private var sink: EventSink? = null
    private var receiver: BroadcastReceiver? = null
    private var brightnessObserver: android.database.ContentObserver? = null
    private var vibratorListener: Any? = null
    private var lastBright = -1
    private var lastPct = -1
    private var lastLocked: Boolean? = null

    override fun status(): ModuleStatus = st

    override fun start(ctx: ModuleContext, sink: EventSink) {
        app = ctx.app
        this.sink = sink
        sink.emit(id, "module_hello", json("implemented" to true))

        val filter = IntentFilter().apply {
            addAction(Intent.ACTION_SCREEN_ON)
            addAction(Intent.ACTION_SCREEN_OFF)
            addAction(Intent.ACTION_USER_PRESENT)
            addAction(Intent.ACTION_BATTERY_CHANGED)
            addAction(Intent.ACTION_POWER_CONNECTED)
            addAction(Intent.ACTION_POWER_DISCONNECTED)
            addAction(NfcAdapter.ACTION_ADAPTER_STATE_CHANGED)
        }
        receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, intent: Intent?) {
                handle(intent ?: return)
            }
        }
        Receivers.register(ctx.app, receiver!!, filter)

        val sticky = Receivers.sticky(ctx.app, Intent.ACTION_BATTERY_CHANGED)
        if (sticky != null) handle(sticky)

        val cr = ctx.app.contentResolver
        brightnessObserver = object : android.database.ContentObserver(android.os.Handler(android.os.Looper.getMainLooper())) {
            override fun onChange(selfChange: Boolean) {
                emitBrightness(ctx.app)
            }
        }
        cr.registerContentObserver(
            Settings.System.getUriFor(Settings.System.SCREEN_BRIGHTNESS),
            false,
            brightnessObserver!!,
        )
        emitBrightness(ctx.app)
        emitInitialScreen(ctx.app)
        emitKeyguard(ctx.app, "start")

        hookVibrator(ctx.app, sink)
        hookNfc(ctx.app, sink)
        hookIr(ctx.app, sink)

        st = ModuleStatus.Running
    }

    override fun tickIntervalMs(): Long = 15_000

    override fun tick(ctx: ModuleContext, sink: EventSink) {
        emitKeyguard(ctx.app, "tick")
        val sticky = Receivers.sticky(ctx.app, Intent.ACTION_BATTERY_CHANGED) ?: return
        val pct = batteryPct(sticky)
        if (pct != lastPct) {
            lastPct = pct
            emitBattery(sticky, "tick")
        }
    }

    override fun stop() {
        val c = app
        try {
            receiver?.let { c?.unregisterReceiver(it) }
        } catch (_: Exception) {
        }
        try {
            brightnessObserver?.let { c?.contentResolver?.unregisterContentObserver(it) }
        } catch (_: Exception) {
        }
        unhookVibrator(c)
        receiver = null
        brightnessObserver = null
        vibratorListener = null
        st = ModuleStatus.Stopped
    }

    private fun handle(intent: Intent) {
        val s = sink ?: return
        when (intent.action) {
            Intent.ACTION_SCREEN_ON -> {
                s.emit(id, "screen", json("on" to true))
                app?.let { emitKeyguard(it, "screen_on") }
            }
            Intent.ACTION_SCREEN_OFF -> {
                s.emit(id, "screen", json("on" to false))
                emitKeyguardLocked(true, "screen_off")
            }
            Intent.ACTION_USER_PRESENT -> {
                s.emit(id, "user_present", JSONObject())
                emitKeyguardLocked(false, "user_present")
            }
            Intent.ACTION_BATTERY_CHANGED,
            Intent.ACTION_POWER_CONNECTED,
            Intent.ACTION_POWER_DISCONNECTED,
            -> emitBattery(intent, intent.action ?: "battery")
            NfcAdapter.ACTION_ADAPTER_STATE_CHANGED -> {
                val stNfc = intent.getIntExtra(NfcAdapter.EXTRA_ADAPTER_STATE, NfcAdapter.STATE_OFF)
                val enabled = stNfc == NfcAdapter.STATE_ON || stNfc == NfcAdapter.STATE_TURNING_ON
                s.emit(id, "nfc_adapter", json("enabled" to enabled, "state" to stNfc))
            }
        }
    }

    private fun emitBattery(intent: Intent, reason: String) {
        val s = sink ?: return
        val pct = batteryPct(intent)
        lastPct = pct
        val plugged = intent.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0)
        val temp = intent.getIntExtra(BatteryManager.EXTRA_TEMPERATURE, -1)
        val status = intent.getIntExtra(BatteryManager.EXTRA_STATUS, -1)
        s.emit(
            id,
            "battery",
            json(
                "reason" to reason,
                "pct" to pct,
                "plugged" to plugged,
                "temp_tenths_c" to temp,
                "status" to status,
            ),
        )
    }

    private fun batteryPct(intent: Intent): Int {
        val level = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
        val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, 100).coerceAtLeast(1)
        return (level * 100) / scale
    }

    private fun emitInitialScreen(app: Context) {
        val s = sink ?: return
        val pm = app.getSystemService(Context.POWER_SERVICE) as PowerManager
        s.emit(id, "screen", json("on" to pm.isInteractive, "reason" to "start"))
    }

    private fun emitKeyguard(app: Context, reason: String) {
        val km = app.getSystemService(Context.KEYGUARD_SERVICE) as KeyguardManager
        emitKeyguardLocked(km.isKeyguardLocked, reason)
    }

    private fun emitKeyguardLocked(locked: Boolean, reason: String) {
        if (lastLocked == locked && reason != "start") return
        lastLocked = locked
        sink?.emit(id, "keyguard", json("locked" to locked, "reason" to reason))
    }

    private fun emitBrightness(app: Context) {
        val s = sink ?: return
        val b = Settings.System.getInt(app.contentResolver, Settings.System.SCREEN_BRIGHTNESS, -1)
        if (b == lastBright) return
        lastBright = b
        s.emit(id, "brightness", json("value" to b))
    }

    private fun hookVibrator(app: Context, sink: EventSink) {
        if (Build.VERSION.SDK_INT < 31) {
            sink.emit(
                id,
                "vibrator_run",
                json("running" to "unsupported", "api" to Build.VERSION.SDK_INT),
            )
            return
        }
        val v = vibrator(app)
        if (!v.hasVibrator()) {
            sink.emit(id, "vibrator_run", json("running" to "unreadable", "has" to false))
            return
        }
        // API 31 监听器在部分 SDK stub 里编不过，用反射挂钩。
        try {
            val listenerClz = Class.forName("android.os.Vibrator\$OnVibratorStateChangedListener")
            val proxy = java.lang.reflect.Proxy.newProxyInstance(
                listenerClz.classLoader,
                arrayOf(listenerClz),
            ) { _, method, args ->
                if (method.name == "onVibratorStateChanged" && !args.isNullOrEmpty()) {
                    val running = args[0] as Boolean
                    sink.emit(id, "vibrator_run", json("running" to running))
                }
                null
            }
            val add = Vibrator::class.java.getMethod(
                "addVibratorStateListener",
                java.util.concurrent.Executor::class.java,
                listenerClz,
            )
            add.invoke(v, androidx.core.content.ContextCompat.getMainExecutor(app), proxy)
            vibratorListener = proxy
            val vibrating = Vibrator::class.java.getMethod("isVibrating").invoke(v) as Boolean
            sink.emit(id, "vibrator_run", json("running" to vibrating))
        } catch (e: Exception) {
            sink.emit(
                id,
                "vibrator_run",
                json("running" to "unreadable", "err" to e.javaClass.simpleName),
            )
        }
    }

    private fun unhookVibrator(app: Context?) {
        val l = vibratorListener ?: return
        val c = app ?: return
        try {
            val v = vibrator(c)
            val listenerClz = Class.forName("android.os.Vibrator\$OnVibratorStateChangedListener")
            Vibrator::class.java.getMethod("removeVibratorStateListener", listenerClz).invoke(v, l)
        } catch (_: Exception) {
        }
    }

    private fun hookNfc(app: Context, sink: EventSink) {
        val nfc = NfcAdapter.getDefaultAdapter(app)
        if (nfc == null) {
            sink.emit(id, "nfc_adapter", json("enabled" to "unreadable", "present" to false))
            return
        }
        sink.emit(id, "nfc_adapter", json("enabled" to nfc.isEnabled, "present" to true))
    }

    private fun hookIr(app: Context, sink: EventSink) {
        val ir = app.getSystemService(Context.CONSUMER_IR_SERVICE) as? ConsumerIrManager
        val has = ir?.hasIrEmitter() ?: false
        val sysfs = File("/sys/class/rc").exists() || File("/sys/class/ir").exists()
        if (!has && !sysfs) {
            sink.emit(id, "ir_run", json("running" to "unsupported", "has_emitter" to false))
            return
        }
        sink.emit(
            id,
            "ir_run",
            json(
                "running" to "unreadable",
                "has_emitter" to has,
                "note" to "no_public_busy_listener",
            ),
        )
    }

    private fun vibrator(app: Context): Vibrator {
        return if (Build.VERSION.SDK_INT >= 31) {
            val vm = app.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager
            vm.defaultVibrator
        } else {
            @Suppress("DEPRECATION")
            app.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
        }
    }
}
