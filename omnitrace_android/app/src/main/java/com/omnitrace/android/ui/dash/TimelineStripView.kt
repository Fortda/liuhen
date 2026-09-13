package com.omnitrace.android.ui.dash

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.util.AttributeSet
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.ViewConfiguration
import android.widget.OverScroller
import androidx.core.content.ContextCompat
import com.omnitrace.android.R
import com.omnitrace.android.dash.DashCaliber
import com.omnitrace.android.dash.Span
import com.omnitrace.android.dash.TimelineModel
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.max

class TimelineStripView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {
    var viewStart: Long = System.currentTimeMillis() - DashCaliber.INITIAL_PAST_MS
        private set
    var viewEnd: Long = System.currentTimeMillis() + DashCaliber.INITIAL_PAST_MS / 6
        private set

    var model: TimelineModel? = null
        set(value) {
            field = value
            requestLayout()
            invalidate()
        }

    var onViewSettled: (() -> Unit)? = null
    var onViewChanged: (() -> Unit)? = null
    var onTap: (() -> Unit)? = null
    var onSeek: ((Long) -> Unit)? = null
    var playhead: Long? = null
        set(value) {
            field = value
            invalidate()
        }

    fun setWindow(start: Long, end: Long) {
        abortInertia()
        viewStart = start
        viewEnd = end
        clamp()
        invalidate()
        scheduleSettle()
    }

    var gutterTop: Int = 0
        private set
    var gutterBottom: Int = 0
        private set

    fun setGutters(top: Int, bottom: Int) {
        val t = top.coerceAtLeast(0)
        val btm = bottom.coerceAtLeast(0)
        if (t == gutterTop && btm == gutterBottom) return
        gutterTop = t
        gutterBottom = btm
        invalidate()
    }

    private val d = resources.displayMetrics.density
    private val nameW = 88f * d
    private val pad = 8f * d
    private val tickH = 16f * d
    private val layerH = 18f * d
    private val laneH = 18f * d
    private val gap = 6f * d

    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textSize = 11f * d
    }
    private val tmp = RectF()
    private val settle = Runnable { onViewSettled?.invoke() }
    private val scroller = OverScroller(context)
    private val minFling = ViewConfiguration.get(context).scaledMinimumFlingVelocity
    private var flingLastX = 0
    private var flingNotifyAt = 0L
    private val flingTick = Runnable { stepFling() }
    private val zoomTick = Runnable { stepZoomFling() }
    private val slop = ViewConfiguration.get(context).scaledTouchSlop
    private var downX = 0f
    private var downY = 0f
    private var lockH = false
    private var scaleAt = 0L
    private var scaleVel = 0.0
    private var scaleFocusX = 0f
    private var zoomFlingVel = 0.0
    private var zoomFlingFocus = 0f
    private var zoomTickAt = 0L

    private val scale = ScaleGestureDetector(
        context,
        object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScaleBegin(detector: ScaleGestureDetector): Boolean {
                abortInertia()
                scaleAt = android.os.SystemClock.uptimeMillis()
                scaleVel = 0.0
                scaleFocusX = detector.focusX
                return true
            }
            override fun onScale(detector: ScaleGestureDetector): Boolean {
                val now = android.os.SystemClock.uptimeMillis()
                val rawDt = now - scaleAt
                if (rawDt >= 8L) {
                    val dt = rawDt.coerceAtMost(80L) / 1000.0
                    val lnS = ln(detector.scaleFactor.toDouble().coerceIn(0.25, 4.0))
                    val inst = lnS / dt
                    scaleVel = if (scaleVel == 0.0) inst else scaleVel * 0.45 + inst * 0.55
                    scaleAt = now
                }
                scaleFocusX = detector.focusX
                zoom(detector.focusX, detector.scaleFactor, notify = false)
                maybeNotify()
                return true
            }
            override fun onScaleEnd(detector: ScaleGestureDetector) {
                val idle = (android.os.SystemClock.uptimeMillis() - scaleAt) / 1000.0
                if (idle > 0.0) scaleVel *= exp(-ZOOM_FRICTION * idle)
                if (abs(scaleVel) >= MIN_ZOOM_VEL) startZoomFling(scaleFocusX, scaleVel)
                else {
                    onViewChanged?.invoke()
                    scheduleSettle()
                }
            }
        },
    )
    private val gesture = GestureDetector(
        context,
        object : GestureDetector.SimpleOnGestureListener() {
            override fun onDown(e: MotionEvent): Boolean {
                abortInertia()
                return true
            }
            override fun onScroll(e1: MotionEvent?, e2: MotionEvent, distanceX: Float, distanceY: Float): Boolean {
                if (abs(distanceX) < abs(distanceY) && !scale.isInProgress) return false
                pan(distanceX)
                return true
            }
            override fun onFling(e1: MotionEvent?, e2: MotionEvent, velocityX: Float, velocityY: Float): Boolean {
                if (abs(velocityX) < abs(velocityY)) return false
                if (abs(velocityX) < minFling) return false
                startFling(velocityX)
                return true
            }
            override fun onSingleTapUp(e: MotionEvent): Boolean {
                val seek = onSeek
                if (seek != null) {
                    seek(xToTs(e.x))
                    return true
                }
                onTap?.invoke()
                return true
            }
        },
    )

    fun resetToNow() {
        abortInertia()
        val n = System.currentTimeMillis()
        viewStart = n - DashCaliber.INITIAL_PAST_MS
        viewEnd = n + DashCaliber.INITIAL_PAST_MS / 6
        clamp()
        invalidate()
        scheduleSettle()
    }

    override fun onDetachedFromWindow() {
        abortInertia()
        removeCallbacks(settle)
        super.onDetachedFromWindow()
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val lanes = model?.lanes?.size ?: 0
        val want = (pad * 2 + tickH + layerH + gap + laneH + gap + lanes * (laneH + 4f * d) + pad).toInt()
            .coerceAtLeast((120 * d).toInt())
        val w = MeasureSpec.getSize(widthMeasureSpec).coerceAtLeast((200 * d).toInt())
        val h = when (MeasureSpec.getMode(heightMeasureSpec)) {
            MeasureSpec.EXACTLY -> MeasureSpec.getSize(heightMeasureSpec)
            MeasureSpec.AT_MOST -> want.coerceAtMost(MeasureSpec.getSize(heightMeasureSpec)).coerceAtLeast((120 * d).toInt())
            else -> want
        }
        setMeasuredDimension(w, h)
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                abortInertia()
                downX = event.x
                downY = event.y
                lockH = false
            }
            MotionEvent.ACTION_POINTER_DOWN -> {
                lockH = true
                parent?.requestDisallowInterceptTouchEvent(true)
            }
            MotionEvent.ACTION_MOVE -> {
                if (!lockH) {
                    val dx = abs(event.x - downX)
                    val dy = abs(event.y - downY)
                    if (dx > slop || dy > slop) {
                        if (dx >= dy) {
                            lockH = true
                            parent?.requestDisallowInterceptTouchEvent(true)
                        } else {
                            parent?.requestDisallowInterceptTouchEvent(false)
                            return false
                        }
                    }
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                parent?.requestDisallowInterceptTouchEvent(false)
                lockH = false
            }
        }
        scale.onTouchEvent(event)
        gesture.onTouchEvent(event)
        return true
    }

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat()
        val plotTop = gutterTop.toFloat()
        val plotBot = (height - gutterBottom).toFloat().coerceAtLeast(plotTop + 1f)
        canvas.save()
        canvas.clipRect(0f, plotTop, w, plotBot)
        val plotL = pad
        val plotR = w - nameW
        val plotW = (plotR - plotL).coerceAtLeast(1f)
        val t0 = viewStart
        val t1 = viewEnd
        val span = (t1 - t0).coerceAtLeast(1L)
        fun x(t: Long): Float {
            val f = (t - t0).toDouble() / span.toDouble()
            return (plotL + f * plotW).toFloat()
        }

        val top = gutterTop + pad
        var y = top + tickH
        drawTicks(canvas, plotL, plotR, y)
        y += 4f * d
        val rec = model?.recording.orEmpty()
        val screen = model?.screenOn.orEmpty()
        val unlock = model?.unlocked.orEmpty()
        drawSpans(canvas, rec, plotL, plotW, t0, span, y, layerH, c(R.color.timeline_standby))
        drawSpans(canvas, screen, plotL, plotW, t0, span, y, layerH, c(R.color.timeline_screen))
        drawSpans(canvas, unlock, plotL, plotW, t0, span, y, layerH, c(R.color.accent))
        text.color = c(R.color.fg)
        canvas.drawText("电源/屏/锁", plotR + 6f * d, y + layerH - 4f * d, text)
        y += layerH + gap

        drawSpans(canvas, model?.audio.orEmpty(), plotL, plotW, t0, span, y, laneH, c(R.color.timeline_audio))
        canvas.drawText("音频", plotR + 6f * d, y + laneH - 4f * d, text)
        y += laneH + gap

        val palette = intArrayOf(
            0xFF26A69A.toInt(), 0xFF8D6E63.toInt(), 0xFF7E57C2.toInt(), 0xFFEC407A.toInt(),
            0xFF29B6F6.toInt(), 0xFFFFA726.toInt(), 0xFF66BB6A.toInt(), 0xFF78909C.toInt(),
            0xFFBDBDBD.toInt(),
        )
        val lanes = model?.lanes.orEmpty()
        val bandTop = y
        if (lanes.isEmpty() && model?.far == true) {
            text.color = c(R.color.muted)
            canvas.drawText("程序轴：缩到 7 日内", plotL, y + 12f * d, text)
            y += laneH
        } else if (lanes.isEmpty()) {
            text.color = c(R.color.fg)
            canvas.drawText("窗口", plotR + 6f * d, y + laneH - 4f * d, text)
            y += laneH + 4f * d
        } else {
            lanes.forEachIndexed { i, lane ->
                drawSpans(canvas, lane.spans, plotL, plotW, t0, span, y, laneH, palette[i % palette.size])
                val label = fit(lane.label, nameW - 10f * d)
                text.color = c(R.color.fg)
                canvas.drawText(label, plotR + 6f * d, y + laneH - 4f * d, text)
                y += laneH + 4f * d
            }
        }
        val bandBot = y.coerceAtLeast(bandTop + laneH)
        drawSpans(canvas, model?.noFocus.orEmpty(), plotL, plotW, t0, span, bandTop, bandBot - bandTop, c(R.color.timeline_nofocus))

        val nowMark = playhead ?: System.currentTimeMillis()
        if (nowMark >= t0 && nowMark <= t1) {
            val nx = x(nowMark)
            paint.color = c(R.color.now_line)
            paint.strokeWidth = 1.5f * d
            canvas.drawLine(nx, top, nx, height.toFloat() - gutterBottom - pad, paint)
        }
        canvas.restore()
    }

    private fun xToTs(x: Float): Long {
        val plotL = pad
        val plotW = plotWidth()
        val span = (viewEnd - viewStart).coerceAtLeast(1L)
        val f = ((x - plotL) / plotW).toDouble().coerceIn(0.0, 1.0)
        return viewStart + (span * f).toLong()
    }

    private fun drawSpans(
        canvas: Canvas,
        spans: List<Span>,
        plotL: Float,
        plotW: Float,
        t0: Long,
        span: Long,
        y: Float,
        h: Float,
        color: Int,
    ) {
        paint.color = color
        val t1 = t0 + span
        for (s in spans) {
            val a = maxOf(s.start, t0)
            val b = minOf(s.end, t1)
            if (b <= a) continue
            val x0 = plotL + ((a - t0).toDouble() / span * plotW).toFloat()
            val x1 = plotL + ((b - t0).toDouble() / span * plotW).toFloat()
            tmp.set(x0, y, max(x0 + 1f, x1), y + h)
            canvas.drawRoundRect(tmp, 2f * d, 2f * d, paint)
        }
    }

    private fun drawTicks(canvas: Canvas, plotL: Float, plotR: Float, baseline: Float) {
        val span = (viewEnd - viewStart).coerceAtLeast(1L)
        val step = tickStep(span)
        val fmt = tickFmt(span)
        fmt.timeZone = TimeZone.getDefault()
        text.color = c(R.color.muted)
        val plotW = plotR - plotL
        var t = (viewStart / step) * step
        if (t < viewStart) t += step
        var lastX = -1e9f
        var n = 0
        while (t <= viewEnd && n < 48) {
            val x = plotL + ((t - viewStart).toDouble() / span * plotW).toFloat()
            paint.color = c(R.color.tick)
            paint.strokeWidth = 1f
            canvas.drawLine(x, baseline - 10f * d, x, baseline, paint)
            val label = fmt.format(Date(t))
            val tw = text.measureText(label)
            if (x - tw / 2 > lastX + 8f * d && x + tw / 2 < plotR) {
                canvas.drawText(label, x - tw / 2, baseline - 12f * d, text)
                lastX = x + tw / 2
            }
            t += step
            n++
        }
    }

    private fun tickStep(span: Long): Long {
        val min = 60_000L
        val hour = 60 * min
        val day = 24 * hour
        return when {
            span <= 2 * min -> 10_000L
            span <= 2 * hour -> 5 * min
            span <= 12 * hour -> 30 * min
            span <= 3 * day -> hour
            span <= 21 * day -> day
            span <= 180 * day -> 7 * day
            span <= 3 * 365 * day -> 30 * day
            span <= 30 * 365 * day -> 365 * day
            else -> 3650 * day
        }
    }

    private fun tickFmt(span: Long): SimpleDateFormat {
        val day = 24L * 60L * 60L * 1000L
        val pat = when {
            span <= 3 * 60_000L -> "HH:mm:ss"
            span <= 2 * day -> "HH:mm"
            span <= 60 * day -> "M/d"
            span <= 3 * 365 * day -> "yyyy-M"
            else -> "yyyy"
        }
        return SimpleDateFormat(pat, Locale.getDefault())
    }

    private fun zoom(focusX: Float, scaleFactor: Float, notify: Boolean = true) {
        val plotL = pad
        val plotW = plotWidth()
        val span = (viewEnd - viewStart).coerceAtLeast(1L)
        val frac = ((focusX - plotL) / plotW).toDouble().coerceIn(0.0, 1.0)
        val anchor = viewStart + (span * frac).toLong()
        var newSpan = (span / scaleFactor.toDouble()).toLong()
        if (newSpan < DashCaliber.MIN_VIEW_SPAN_MS) newSpan = DashCaliber.MIN_VIEW_SPAN_MS
        if (newSpan > DashCaliber.TS_ABS_MAX) newSpan = DashCaliber.TS_ABS_MAX
        viewStart = anchor - (newSpan * frac).toLong()
        viewEnd = viewStart + newSpan
        clamp()
        invalidate()
        if (notify) {
            onViewChanged?.invoke()
            scheduleSettle()
        }
    }

    private fun pan(distanceX: Float, notify: Boolean = true) {
        if (notify) abortZoomFling()
        val plotW = plotWidth()
        val span = (viewEnd - viewStart).coerceAtLeast(1L)
        val dt = (distanceX / plotW * span).toLong()
        viewStart += dt
        viewEnd += dt
        clamp()
        invalidate()
        if (notify) {
            onViewChanged?.invoke()
            scheduleSettle()
        }
    }

    private fun startFling(velocityX: Float) {
        abortInertia()
        removeCallbacks(settle)
        flingLastX = 0
        flingNotifyAt = 0L
        scroller.fling(0, 0, (-velocityX).toInt(), 0, -50_000_000, 50_000_000, 0, 0)
        postOnAnimation(flingTick)
    }

    private fun startZoomFling(focusX: Float, vel: Double) {
        abortPanFling()
        removeCallbacks(zoomTick)
        removeCallbacks(settle)
        zoomFlingFocus = focusX
        zoomFlingVel = vel.coerceIn(-MAX_ZOOM_VEL, MAX_ZOOM_VEL)
        zoomTickAt = android.os.SystemClock.uptimeMillis()
        flingNotifyAt = 0L
        postOnAnimation(zoomTick)
    }

    private fun stepZoomFling() {
        val now = android.os.SystemClock.uptimeMillis()
        val dt = ((now - zoomTickAt).coerceIn(1L, 32L)) / 1000.0
        zoomTickAt = now
        val factor = exp(zoomFlingVel * dt).toFloat().coerceIn(0.82f, 1.22f)
        zoom(zoomFlingFocus, factor, notify = false)
        zoomFlingVel *= exp(-ZOOM_FRICTION * dt)
        maybeNotify()
        if (abs(zoomFlingVel) >= MIN_ZOOM_VEL * 0.2) {
            postOnAnimation(zoomTick)
        } else {
            zoomFlingVel = 0.0
            onViewChanged?.invoke()
            onViewSettled?.invoke()
        }
    }

    private fun stepFling() {
        val more = scroller.computeScrollOffset()
        val x = scroller.currX
        val dx = (x - flingLastX).toFloat()
        flingLastX = x
        if (dx != 0f) pan(dx, notify = false)
        val now = android.os.SystemClock.uptimeMillis()
        if (now - flingNotifyAt > 48) {
            flingNotifyAt = now
            onViewChanged?.invoke()
        }
        if (more) {
            postOnAnimation(flingTick)
        } else {
            onViewChanged?.invoke()
            onViewSettled?.invoke()
        }
    }

    private fun maybeNotify() {
        val now = android.os.SystemClock.uptimeMillis()
        if (now - flingNotifyAt > 48) {
            flingNotifyAt = now
            onViewChanged?.invoke()
        }
    }

    private fun abortPanFling() {
        removeCallbacks(flingTick)
        if (!scroller.isFinished) scroller.abortAnimation()
    }

    private fun abortZoomFling() {
        removeCallbacks(zoomTick)
        zoomFlingVel = 0.0
    }

    private fun abortInertia() {
        abortPanFling()
        abortZoomFling()
    }

    private fun plotWidth(): Float = (width - nameW - pad).coerceAtLeast(1f)

    private fun clamp() {
        var span = viewEnd - viewStart
        if (span < DashCaliber.MIN_VIEW_SPAN_MS) span = DashCaliber.MIN_VIEW_SPAN_MS
        if (span <= 0 || span > DashCaliber.TS_ABS_MAX) span = DashCaliber.INITIAL_PAST_MS
        var start = viewStart
        if (start < -DashCaliber.TS_ABS_MAX) start = -DashCaliber.TS_ABS_MAX
        if (start > DashCaliber.TS_ABS_MAX - span) start = DashCaliber.TS_ABS_MAX - span
        viewStart = start
        viewEnd = start + span
    }

    private fun scheduleSettle() {
        removeCallbacks(settle)
        postDelayed(settle, 180)
    }

    private fun c(id: Int): Int = ContextCompat.getColor(context, id)

    private fun fit(s: String, maxW: Float): String {
        if (text.measureText(s) <= maxW) return s
        var x = s
        while (x.length > 1 && text.measureText("$x…") > maxW) x = x.dropLast(1)
        return "$x…"
    }

    companion object {
        private const val ZOOM_FRICTION = 5.2
        private const val MIN_ZOOM_VEL = 0.55
        private const val MAX_ZOOM_VEL = 3.8
    }
}
