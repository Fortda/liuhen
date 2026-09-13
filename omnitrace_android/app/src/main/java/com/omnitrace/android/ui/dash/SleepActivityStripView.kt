package com.omnitrace.android.ui.dash

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.util.AttributeSet
import android.view.View
import androidx.core.content.ContextCompat
import com.omnitrace.android.R
import com.omnitrace.android.dash.SleepActivityModel

/** 睡眠猜测页：上轨手机浅金黄、下轨电脑浅天青（5 分钟格）。 */
class SleepActivityStripView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {
    var model: SleepActivityModel? = null
        set(value) {
            field = value
            invalidate()
        }

    private val d = resources.displayMetrics.density
    private val phonePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0x6BC9B07A
        style = Paint.Style.FILL
    }
    private val pcPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0x6B8AAFBD
        style = Paint.Style.FILL
    }
    private val trackPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
    }
    private val wakePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        color = 0xD9C62828.toInt()
        strokeWidth = 1.5f * d
        style = Paint.Style.STROKE
    }
    private val textPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        textSize = 10f * d
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        val h = (56 * d).toInt()
        setMeasuredDimension(MeasureSpec.getSize(widthMeasureSpec), h)
    }

    override fun onDraw(canvas: Canvas) {
        val m = model ?: return
        val muted = ContextCompat.getColor(context, R.color.muted)
        val line = ContextCompat.getColor(context, R.color.line)
        trackPaint.color = line
        trackPaint.alpha = 90
        textPaint.color = muted
        val padL = 28f * d
        val padR = 8f * d
        val trackW = (width - padL - padR).coerceAtLeast(1f)
        val phoneY = 10f * d
        val pcY = 30f * d
        val h = 12f * d
        canvas.drawRect(padL, phoneY, padL + trackW, phoneY + h, trackPaint)
        canvas.drawRect(padL, pcY, padL + trackW, pcY + h, trackPaint)
        canvas.drawText("手机", 2f * d, phoneY + h * 0.85f, textPaint)
        canvas.drawText("电脑", 2f * d, pcY + h * 0.85f, textPaint)
        val span = (m.t1 - m.t0).coerceAtLeast(1L)
        val n = maxOf(m.phoneActive.size, m.pcActive.size)
        for (i in 0 until n) {
            val a = m.t0 + i * m.binMs
            val b = minOf(m.t1, a + m.binMs)
            val x0 = padL + ((a - m.t0).toFloat() / span) * trackW
            val x1 = padL + ((b - m.t0).toFloat() / span) * trackW
            val w = (x1 - x0).coerceAtLeast(1f)
            if (i < m.phoneActive.size && m.phoneActive[i]) {
                canvas.drawRect(x0, phoneY, x0 + w, phoneY + h, phonePaint)
            }
            if (i < m.pcActive.size && m.pcActive[i]) {
                canvas.drawRect(x0, pcY, x0 + w, pcY + h, pcPaint)
            }
        }
        for (wake in m.wakeMarks) {
            if (wake < m.t0 || wake > m.t1) continue
            val x = padL + ((wake - m.t0).toFloat() / span) * trackW
            canvas.drawLine(x, 6f * d, x, height - 6f * d, wakePaint)
        }
    }
}
