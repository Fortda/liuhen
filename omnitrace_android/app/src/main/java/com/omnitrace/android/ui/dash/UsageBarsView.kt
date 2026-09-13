package com.omnitrace.android.ui.dash

import android.content.Context
import android.graphics.Canvas
import android.graphics.DashPathEffect
import android.graphics.Paint
import android.graphics.RectF
import android.util.AttributeSet
import android.view.MotionEvent
import android.view.View
import androidx.core.content.ContextCompat
import com.omnitrace.android.R
import com.omnitrace.android.dash.DashCaliber
import java.util.Locale
import kotlin.math.roundToInt

class UsageBarsView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {
    data class Bar(
        val label: String,
        val ms: Long,
        val major: Boolean = false,
    )

    var bars: List<Bar> = emptyList()
        set(value) {
            field = value
            selectedIndex = -1
            requestLayout()
            invalidate()
        }

    /** 0 = 按最高柱取整；小时刻度应设成 [DashCaliber.HOUR_MS]。 */
    var yCeilingMs: Long = 0L
        set(value) {
            field = value
            invalidate()
        }

    var selectedIndex: Int = -1
        set(value) {
            field = value
            invalidate()
        }

    var onBarClick: ((Int, Bar) -> Unit)? = null

    private val d = resources.displayMetrics.density
    private val yAxisW = 36f * d
    private val minSlot = 14f * d
    private val valueMinSlot = 32f * d
    private val padR = 8f * d
    private val topPad = 16f * d
    private val labelH = 16f * d

    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val grid = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 1f * d
        pathEffect = DashPathEffect(floatArrayOf(5f * d, 5f * d), 0f)
    }
    private val guide = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 1.2f * d
        pathEffect = DashPathEffect(floatArrayOf(7f * d, 5f * d), 0f)
    }
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textSize = 10f * d
    }
    private val tmp = RectF()

    init {
        isClickable = true
    }

    override fun performClick(): Boolean {
        super.performClick()
        return true
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        if (event.actionMasked == MotionEvent.ACTION_UP) {
            val i = indexAt(event.x)
            if (i >= 0) {
                selectedIndex = i
                onBarClick?.invoke(i, bars[i])
            }
        }
        return super.onTouchEvent(event)
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val h = when (MeasureSpec.getMode(heightMeasureSpec)) {
            MeasureSpec.EXACTLY -> MeasureSpec.getSize(heightMeasureSpec)
            MeasureSpec.AT_MOST -> MeasureSpec.getSize(heightMeasureSpec).coerceAtMost((180 * d).toInt())
            else -> (160 * d).toInt()
        }
        val n = bars.size.coerceAtLeast(1)
        val want = (yAxisW + padR + n * minSlot).roundToInt().coerceAtLeast((160 * d).toInt())
        val screen = (resources.displayMetrics.widthPixels - 24f * d).roundToInt()
        val w = when (MeasureSpec.getMode(widthMeasureSpec)) {
            MeasureSpec.EXACTLY -> MeasureSpec.getSize(widthMeasureSpec)
            else -> maxOf(want, screen)
        }
        setMeasuredDimension(w, h)
    }

    override fun onDraw(canvas: Canvas) {
        if (width <= 0 || height <= 0) return
        val accent = ContextCompat.getColor(context, R.color.accent)
        val muted = ContextCompat.getColor(context, R.color.muted)
        val fg = ContextCompat.getColor(context, R.color.fg)
        val plotL = yAxisW
        val plotR = width - padR
        val plotT = topPad
        val plotB = height - labelH
        val plotW = (plotR - plotL).coerceAtLeast(8f * d)
        val plotH = (plotB - plotT).coerceAtLeast(8f * d)
        val ceiling = ceilingMs()
        grid.color = muted
        grid.alpha = 90
        text.color = muted
        text.textAlign = Paint.Align.RIGHT
        text.textSize = 9f * d
        for (i in 0..4) {
            val frac = i / 4f
            val y = plotB - plotH * frac
            canvas.drawLine(plotL, y, plotR, y, grid)
            val tickMs = (ceiling * frac).toLong()
            canvas.drawText(fmtTick(tickMs), plotL - 4f * d, y + 3f * d, text)
        }
        if (bars.isEmpty()) return
        val n = bars.size
        val slot = plotW / n
        val barW = (slot * 0.62f).coerceAtLeast(2f * d).coerceAtMost(slot - 1f * d)
        val dense = n > 14 && slot < 22f * d
        val wide = slot >= valueMinSlot
        val sel = selectedIndex
        bars.forEachIndexed { i, b ->
            val x = plotL + slot * i + (slot - barW) / 2f
            val h = plotH * (b.ms.toFloat() / ceiling.toFloat())
            if (h >= 0.5f * d) {
                tmp.set(x, plotB - h, x + barW, plotB)
                fill.color = accent
                fill.alpha = if (sel >= 0 && i != sel) 110 else 255
                canvas.drawRoundRect(tmp, 2f * d, 2f * d, fill)
            }
            if (wide && b.ms > 0L) {
                text.color = fg
                text.textAlign = Paint.Align.CENTER
                text.textSize = 9f * d
                val s = fmtShort(b.ms)
                val ty = (plotB - h - 3f * d).coerceAtLeast(plotT + 2f * d)
                canvas.drawText(s, x + barW / 2f, ty, text)
            }
            val showX = b.label.isNotEmpty() && (b.major || !dense || i == 0 || i == n - 1 || i % 6 == 0)
            if (showX) {
                text.color = muted
                text.textAlign = Paint.Align.CENTER
                text.textSize = 10f * d
                val tw = text.measureText(b.label)
                val lx = (x + barW / 2f).coerceIn(plotL + tw / 2f, plotR - tw / 2f)
                canvas.drawText(b.label, lx, height - 3f * d, text)
            }
        }
        if (sel in bars.indices) {
            val b = bars[sel]
            val h = plotH * (b.ms.toFloat() / ceiling.toFloat())
            val y = plotB - h
            guide.color = accent
            canvas.drawLine(plotL, y, plotR, y, guide)
            if (!wide) {
                text.color = accent
                text.textAlign = Paint.Align.LEFT
                text.textSize = 10f * d
                val s = fmtShort(b.ms)
                val ty = (y - 3f * d).coerceAtLeast(text.textSize + 2f * d)
                canvas.drawText(s, plotL + 4f * d, ty, text)
            }
        }
    }

    private fun indexAt(x: Float): Int {
        if (bars.isEmpty()) return -1
        val plotL = yAxisW
        val plotR = width - padR
        if (x < plotL || x > plotR) return -1
        val slot = (plotR - plotL) / bars.size
        if (slot <= 0f) return -1
        return ((x - plotL) / slot).toInt().coerceIn(0, bars.lastIndex)
    }

    private fun ceilingMs(): Long {
        if (yCeilingMs > 0L) return yCeilingMs
        val maxBar = bars.maxOfOrNull { it.ms } ?: 0L
        return DashCaliber.niceUsageY(maxBar)
    }

    companion object {
        fun fmtTick(ms: Long): String {
            if (ms <= 0L) return "0"
            val hour = DashCaliber.HOUR_MS
            if (ms % hour == 0L) return "${ms / hour}h"
            val min = 60_000L
            if (ms % min == 0L) {
                val m = ms / min
                return if (m >= 60L) {
                    val h = m / 60L
                    val r = m % 60L
                    if (r == 0L) "${h}h" else "${h}h${r}m"
                } else {
                    "${m}m"
                }
            }
            return String.format(Locale.US, "%.1fh", ms / hour.toFloat())
        }

        fun fmtShort(ms: Long): String {
            if (ms <= 0L) return "0"
            val hour = DashCaliber.HOUR_MS
            if (ms >= hour) {
                val h = ms / hour.toFloat()
                return if (ms % hour == 0L) "${ms / hour}h" else String.format(Locale.US, "%.1fh", h)
            }
            val m = ms / 60_000L
            return if (m > 0L) "${m}m" else "${ms / 1000L}s"
        }
    }
}
