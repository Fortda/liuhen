package com.omnitrace.android

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Process
import androidx.core.app.NotificationCompat
import com.omnitrace.android.host.CaptureCatalog
import com.omnitrace.android.host.EventSink
import com.omnitrace.android.host.HealthLog
import com.omnitrace.android.host.HostBridge
import com.omnitrace.android.host.ImuBinWriter
import com.omnitrace.android.host.ManifestWriter
import com.omnitrace.android.host.ModuleContext
import com.omnitrace.android.host.ModuleRegistry
import com.omnitrace.android.host.OmniPaths
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

class RecordService : Service() {
    private var thread: HandlerThread? = null
    private var handler: Handler? = null
    private var registry: ModuleRegistry? = null
    private var sink: EventSink? = null
    private var imu: ImuBinWriter? = null
    private var root: java.io.File? = null
    private var lastBeat = 0L
    private var lastManifest = 0L
    private var startedAt = 0L
    private var deviceId = ""
    private var profile = PROFILE_OVERNIGHT
    private var ctxMod: com.omnitrace.android.host.ModuleContext? = null
    private var tombstoned = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
        startFg()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopRecording("clean_stop")
                stopSelf()
                return START_NOT_STICKY
            }
            else -> startRecording()
        }
        return START_STICKY
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        val keep = getSharedPreferences(PREFS, MODE_PRIVATE).getBoolean(KEY_KEEP_ALIVE, false)
        if (!keep) stopRecording("user_close")
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        stopRecording("service_destroy")
        super.onDestroy()
    }

    private fun startRecording() {
        if (running.get()) return
        profile = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_PROFILE, PROFILE_OVERNIGHT)
            ?: PROFILE_OVERNIGHT
        val dataRoot = OmniPaths.dataRoot(this)
        root = dataRoot
        deviceId = OmniPaths.sourceId(this)
        startedAt = System.currentTimeMillis()
        sink = EventSink(dataRoot)
        imu = ImuBinWriter(dataRoot)
        val registry = ModuleRegistry().also { reg ->
            CaptureCatalog.createEnabled(this).forEach { reg.register(it) }
        }
        this.registry = registry
        val mctx = ModuleContext(
            app = applicationContext,
            dataRoot = dataRoot,
            startedAtMs = startedAt,
            profile = profile,
            deviceId = deviceId,
            imu = imu!!,
        )
        ctxMod = mctx
        HostBridge.running = true
        running.set(true)
        tombstoned = false
        dataRoot.resolve("control").mkdirs()
        OmniPaths.pidPath(dataRoot).writeText(Process.myPid().toString())
        File(OmniPaths.controlDir(dataRoot), "source_id.txt").writeText(deviceId)
        HealthLog.markStarts(dataRoot, registry.ids())
        registry.startAll(mctx, sink!!)
        ManifestWriter.write(dataRoot, deviceId, profile, startedAt, registry.modules(), sink!!)
        val th = HandlerThread("omni-host")
        th.start()
        thread = th
        handler = Handler(th.looper)
        lastBeat = 0L
        handler?.post(tickRunnable)
    }

    private val tickRunnable = object : Runnable {
        override fun run() {
            val r = registry ?: return
            val s = sink ?: return
            val c = ctxMod ?: return
            val now = System.currentTimeMillis()
            r.tickAll(now, c, s)
            if (now - lastBeat >= 2000) {
                lastBeat = now
                root?.let { HealthLog.markBeats(it, r.ids()) }
            }
            if (now - lastManifest >= 12_000) {
                lastManifest = now
                root?.let { ManifestWriter.write(it, deviceId, profile, startedAt, r.modules(), s) }
            }
            handler?.postDelayed(this, 500)
        }
    }

    private fun stopRecording(reason: String) {
        if (!running.get() && tombstoned) return
        HostBridge.running = false
        running.set(false)
        handler?.removeCallbacksAndMessages(null)
        thread?.quitSafely()
        thread = null
        handler = null
        registry?.stopAll()
        val ids = registry?.ids().orEmpty()
        root?.let {
            if (!tombstoned && ids.isNotEmpty()) {
                HealthLog.markTombstones(it, ids, reason)
                tombstoned = true
            }
            OmniPaths.pidPath(it).delete()
        }
        imu?.close()
        sink?.close()
        imu = null
        sink = null
        registry = null
        ctxMod = null
    }

    private fun startFg() {
        val pi = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val n: Notification = NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.notify_title))
            .setContentText(getString(R.string.notify_text))
            .setContentIntent(pi)
            .setOngoing(true)
            .build()
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(
                    NOTIF_ID,
                    n,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION or ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE,
                )
            } else if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
            } else {
                startForeground(NOTIF_ID, n)
            }
        } catch (_: Exception) {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
            } else {
                startForeground(NOTIF_ID, n)
            }
        }
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL, getString(R.string.notify_channel), NotificationManager.IMPORTANCE_LOW),
        )
    }

    companion object {
        const val ACTION_STOP = "com.omnitrace.android.STOP"
        const val CHANNEL = "omnitrace_record"
        const val NOTIF_ID = 21
        const val PREFS = "omnitrace"
        const val KEY_PROFILE = "profile"
        const val KEY_BOOT = "boot_start"
        const val KEY_KEEP_ALIVE = "keep_alive"
        const val PROFILE_OVERNIGHT = "overnight"
        const val PROFILE_MAX = "max"
        val running = AtomicBoolean(false)

        fun start(ctx: Context) {
            val i = Intent(ctx, RecordService::class.java)
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
        }

        fun stop(ctx: Context) {
            if (!running.get()) return
            val i = Intent(ctx, RecordService::class.java).setAction(ACTION_STOP)
            ctx.startService(i)
        }
    }
}
