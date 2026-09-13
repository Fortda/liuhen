package com.omnitrace.android.modules

import android.content.Context
import android.hardware.camera2.CameraManager
import android.media.AudioManager
import android.media.AudioPlaybackConfiguration
import android.media.AudioRecordingConfiguration
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import com.omnitrace.android.host.EventSink
import com.omnitrace.android.host.ModuleContext
import com.omnitrace.android.host.ModuleStatus
import com.omnitrace.android.host.TraceModule
import com.omnitrace.android.host.json
import com.omnitrace.android.host.kv
import org.json.JSONArray
import org.json.JSONObject

/** 谁在播/录、哪颗镜头被占用。不要 PCM，不要预览帧。 */
class MediaModule : TraceModule {
    override val id = "media"
    override val name = "Media occupancy"
    override val version = "0.1.0"

    private var st = ModuleStatus.Idle
    private var am: AudioManager? = null
    private var cm: CameraManager? = null
    private var sink: EventSink? = null
    private var playCb: AudioManager.AudioPlaybackCallback? = null
    private var recCb: AudioManager.AudioRecordingCallback? = null
    private var camCb: CameraManager.AvailabilityCallback? = null
    private var volObserver: android.database.ContentObserver? = null
    private var app: Context? = null

    override fun status(): ModuleStatus = st

    override fun start(ctx: ModuleContext, sink: EventSink) {
        this.sink = sink
        this.app = ctx.app
        am = ctx.app.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        cm = ctx.app.getSystemService(Context.CAMERA_SERVICE) as CameraManager
        sink.emit(id, "module_hello", json("implemented" to true, "pcm" to false, "preview" to false))

        val h = Handler(Looper.getMainLooper())
        playCb = object : AudioManager.AudioPlaybackCallback() {
            override fun onPlaybackConfigChanged(configs: MutableList<AudioPlaybackConfiguration>) {
                emitPlayback(configs)
            }
        }
        recCb = object : AudioManager.AudioRecordingCallback() {
            override fun onRecordingConfigChanged(configs: MutableList<AudioRecordingConfiguration>) {
                emitRecording(configs)
            }
        }
        val play = playCb!!
        val rec = recCb!!
        am?.registerAudioPlaybackCallback(play, h)
        am?.registerAudioRecordingCallback(rec, h)
        emitPlayback(am?.activePlaybackConfigurations ?: emptyList())
        emitRecording(am?.activeRecordingConfigurations ?: emptyList())

        camCb = object : CameraManager.AvailabilityCallback() {
            override fun onCameraAvailable(cameraId: String) {
                sink.emit(
                    id,
                    "camera_availability",
                    json("id" to cameraId, "available" to true),
                )
            }

            override fun onCameraUnavailable(cameraId: String) {
                sink.emit(
                    id,
                    "camera_availability",
                    json("id" to cameraId, "available" to false),
                )
            }
        }
        cm?.registerAvailabilityCallback(camCb!!, h)

        volObserver = object : android.database.ContentObserver(h) {
            override fun onChange(selfChange: Boolean) {
                emitVolume()
            }
        }
        ctx.app.contentResolver.registerContentObserver(
            Settings.System.CONTENT_URI,
            true,
            volObserver!!,
        )
        emitVolume()
        st = ModuleStatus.Running
    }

    override fun stop() {
        try {
            playCb?.let { am?.unregisterAudioPlaybackCallback(it) }
            recCb?.let { am?.unregisterAudioRecordingCallback(it) }
            camCb?.let { cm?.unregisterAvailabilityCallback(it) }
            volObserver?.let { app?.contentResolver?.unregisterContentObserver(it) }
        } catch (_: Exception) {
        }
        st = ModuleStatus.Stopped
    }

    private fun emitPlayback(configs: List<AudioPlaybackConfiguration>) {
        val arr = JSONArray()
        for (c in configs) {
            val o = json()
            try {
                val attrs = c.javaClass.methods.firstOrNull { it.name == "getAudioAttributes" }?.invoke(c)
                    ?: continue
                val usage = attrs.javaClass.methods.firstOrNull { it.name == "getUsage" }?.invoke(attrs)
                val content = attrs.javaClass.methods.firstOrNull { it.name == "getContentType" }?.invoke(attrs)
                if (usage != null) o.kv("usage", usage)
                if (content != null) o.kv("content", content)
            } catch (_: Exception) {
            }
            arr.put(o)
        }
        sink?.emit(
            id,
            "audio_playback",
            json(
                "n" to configs.size,
                "configs" to arr,
                "mode" to (am?.mode ?: JSONObject.NULL),
                "speaker" to (am?.isSpeakerphoneOn ?: false),
                "music_active" to (am?.isMusicActive ?: false),
            ),
        )
    }

    private fun emitRecording(configs: List<AudioRecordingConfiguration>) {
        val arr = JSONArray()
        for (c in configs) {
            val o = json()
            try {
                val uid = c.javaClass.methods.firstOrNull { it.name == "getClientUid" }?.invoke(c)
                if (uid != null) o.kv("client_uid", uid)
            } catch (_: Exception) {
            }
            try {
                val pkg = c.javaClass.methods.firstOrNull { it.name == "getClientPackageName" }
                    ?.invoke(c) as? String
                if (pkg != null) o.kv("client_pkg", pkg)
            } catch (_: Exception) {
            }
            arr.put(o)
        }
        sink?.emit(id, "audio_recording", json("n" to configs.size, "configs" to arr))
    }

    private fun emitVolume() {
        val a = am ?: return
        sink?.emit(
            id,
            "volume",
            json(
                "music" to a.getStreamVolume(AudioManager.STREAM_MUSIC),
                "ring" to a.getStreamVolume(AudioManager.STREAM_RING),
                "alarm" to a.getStreamVolume(AudioManager.STREAM_ALARM),
                "voice" to a.getStreamVolume(AudioManager.STREAM_VOICE_CALL),
            ),
        )
    }
}
