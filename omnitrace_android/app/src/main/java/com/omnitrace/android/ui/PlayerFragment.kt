package com.omnitrace.android.ui

import android.app.DatePickerDialog
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.Fragment
import com.omnitrace.android.R
import com.omnitrace.android.dash.DashIo
import com.omnitrace.android.dash.DashWash
import com.omnitrace.android.dash.StageFrame
import com.omnitrace.android.dash.TimelineModel
import com.omnitrace.android.databinding.FragmentPlayerBinding
import com.omnitrace.android.host.OmniPaths
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

class PlayerFragment : Fragment() {
    private var binding: FragmentPlayerBinding? = null
    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private var dayStart = 0L
    private var dayEnd = 0L
    private var playhead = 0L
    private var playing = false
    private var speed = 60
    private var model: TimelineModel? = null
    private var frames: List<StageFrame> = emptyList()
    private var lastTick = 0L
    private var gen = 0
    private val dayFmt = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault())
    private val clockFmt = SimpleDateFormat("HH:mm:ss", Locale.getDefault())

    private val tick = object : Runnable {
        override fun run() {
            if (!playing) return
            val now = SystemClock.uptimeMillis()
            val dt = if (lastTick == 0L) 50L else now - lastTick
            lastTick = now
            playhead = (playhead + dt * speed).coerceIn(dayStart, (dayEnd - 1).coerceAtLeast(dayStart))
            paintHead()
            if (playhead >= dayEnd - 1) {
                playing = false
                binding?.btnPlayerPlay?.text = getString(R.string.player_play)
                return
            }
            main.postDelayed(this, 50)
        }
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        val b = FragmentPlayerBinding.inflate(inflater, container, false)
        binding = b
        dayStart = DashIo.startOfLocalDay(System.currentTimeMillis())
        dayEnd = DashIo.addLocalDays(dayStart, 1)
        playhead = dayStart
        b.playerTimeline.setWindow(dayStart, dayEnd)
        b.playerTimeline.onSeek = {
            playhead = it.coerceIn(dayStart, dayEnd - 1)
            paintHead()
        }
        b.btnPlayerDay.setOnClickListener { pickDay() }
        b.btnPlayerPlay.setOnClickListener { togglePlay() }
        b.btnPlayerSpeed.setOnClickListener { cycleSpeed() }
        paintDayBtn()
        paintSpeed()
        (activity as? com.omnitrace.android.MainActivity)?.fitBottomChrome(b.playerChrome)
        loadDay()
        return b.root
    }

    override fun onHiddenChanged(hidden: Boolean) {
        super.onHiddenChanged(hidden)
        if (hidden) {
            playing = false
            main.removeCallbacks(tick)
            binding?.btnPlayerPlay?.text = getString(R.string.player_play)
        }
    }

    override fun onPause() {
        playing = false
        main.removeCallbacks(tick)
        binding?.btnPlayerPlay?.text = getString(R.string.player_play)
        super.onPause()
    }

    override fun onDestroyView() {
        playing = false
        main.removeCallbacks(tick)
        binding?.playerTimeline?.onSeek = null
        binding = null
        super.onDestroyView()
    }

    private fun pickDay() {
        val c = Calendar.getInstance()
        c.timeInMillis = dayStart
        DatePickerDialog(
            requireContext(),
            { _, y, m, d ->
                val x = Calendar.getInstance()
                x.set(y, m, d, 0, 0, 0)
                x.set(Calendar.MILLISECOND, 0)
                dayStart = x.timeInMillis
                dayEnd = DashIo.addLocalDays(dayStart, 1)
                playhead = dayStart
                playing = false
                binding?.btnPlayerPlay?.text = getString(R.string.player_play)
                paintDayBtn()
                loadDay()
            },
            c.get(Calendar.YEAR),
            c.get(Calendar.MONTH),
            c.get(Calendar.DAY_OF_MONTH),
        ).show()
    }

    private fun togglePlay() {
        playing = !playing
        binding?.btnPlayerPlay?.text = getString(if (playing) R.string.player_pause else R.string.player_play)
        if (playing) {
            lastTick = 0L
            main.post(tick)
        } else {
            main.removeCallbacks(tick)
        }
    }

    private fun cycleSpeed() {
        speed = when (speed) {
            1 -> 10
            10 -> 60
            60 -> 300
            else -> 1
        }
        paintSpeed()
    }

    private fun paintSpeed() {
        binding?.btnPlayerSpeed?.text = "${speed}×"
    }

    private fun paintDayBtn() {
        binding?.btnPlayerDay?.text = dayFmt.format(Date(dayStart))
    }

    private fun loadDay() {
        val b = binding ?: return
        b.playerTimeline.setWindow(dayStart, dayEnd)
        val g = ++gen
        val app = requireContext().applicationContext
        val a = dayStart
        val z = dayEnd
        io.execute {
            val root = OmniPaths.dataRoot(app)
            val tl = try {
                DashWash.timeline(app, root, a, z, System.currentTimeMillis())
            } catch (_: Exception) {
                null
            }
            val st = try {
                DashWash.stageFrames(root, a, z)
            } catch (_: Exception) {
                emptyList()
            }
            main.post {
                val bb = binding ?: return@post
                if (g != gen) return@post
                model = tl
                frames = st
                bb.playerTimeline.model = tl
                bb.playerStage.frames = st
                paintHead()
            }
        }
    }

    private fun paintHead() {
        val b = binding ?: return
        b.playerTimeline.playhead = playhead
        val screenOn = inSpans(model?.screenOn, playhead)
        val unlocked = inSpans(model?.unlocked, playhead)
        b.playerStage.playhead = playhead
        b.playerStage.screenOn = screenOn
        b.playerStage.unlocked = unlocked
        val app = appAt(playhead)
        val screen = when {
            unlocked -> "开锁"
            screenOn -> "亮屏"
            inSpans(model?.recording, playhead) -> "在录灭屏"
            else -> "没在录"
        }
        val line = "${clockFmt.format(Date(playhead))}  $screen" +
            (if (app.isEmpty()) "" else "  $app")
        b.txtPlayerHint.text = line
        b.playerStage.hint = line
    }

    private fun appAt(t: Long): String {
        val lanes = model?.lanes.orEmpty()
        for (lane in lanes) {
            if (inSpans(lane.spans, t)) return lane.label
        }
        return ""
    }

    private fun inSpans(spans: List<com.omnitrace.android.dash.Span>?, t: Long): Boolean {
        if (spans == null) return false
        return spans.any { t >= it.start && t < it.end }
    }
}
