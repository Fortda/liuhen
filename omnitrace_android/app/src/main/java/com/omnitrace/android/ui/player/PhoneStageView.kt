package com.omnitrace.android.ui.player

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.RectF
import android.util.AttributeSet
import android.view.View
import androidx.core.content.ContextCompat
import com.omnitrace.android.R
import com.omnitrace.android.dash.StageFrame
import com.omnitrace.android.dash.StageWin
import kotlin.math.min

/** 按 ui_map 窗栈重建当时屏幕，不是像素录屏，也不是 GPS 地图。 */
class PhoneStageView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {
    var frames: List<StageFrame> = emptyList()
        set(value) {
            field = value
            invalidate()
        }
    var playhead: Long = 0L
        set(value) {
            if (field == value) return
            field = value
            invalidate()
        }
    var screenOn: Boolean = true
        set(value) {
            field = value
            invalidate()
        }
    var unlocked: Boolean = true
        set(value) {
            field = value
            invalidate()
        }
    var hint: String = ""
        set(value) {
            field = value
            invalidate()
        }

    private val d = resources.displayMetrics.density
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val text = Paint(Paint.ANTI_ALIAS_FLAG)
    private val tmp = RectF()

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat().coerceAtLeast(1f)
        val h = height.toFloat().coerceAtLeast(1f)
        canvas.drawColor(ContextCompat.getColor(context, R.color.player_bg))
        val frame = frameAt(playhead)
        val dw = (frame?.dw ?: 1080).coerceAtLeast(1)
        val dh = (frame?.dh ?: 2400).coerceAtLeast(1)
        val scale = min(w / dw, h / dh) * 0.92f
        val pw = dw * scale
        val ph = dh * scale
        val ox = (w - pw) / 2f
        val oy = (h - ph) / 2f
        tmp.set(ox, oy, ox + pw, oy + ph)
        fill.color = 0xFF1A1A1A.toInt()
        canvas.drawRoundRect(tmp, 18f * d, 18f * d, fill)

        if (!screenOn) {
            text.color = 0xFF888888.toInt()
            text.textSize = 16f * d
            val s = "灭屏"
            canvas.drawText(s, ox + (pw - text.measureText(s)) / 2f, oy + ph / 2f, text)
            drawHint(canvas, w, h)
            return
        }

        val wins = frame?.wins.orEmpty()
        if (wins.isEmpty()) {
            text.color = 0xFFAAAAAA.toInt()
            text.textSize = 14f * d
            val s = if (frames.isEmpty()) "当天没有窗栈（需要无障碍并采集）" else "这一刻还没有窗口快照"
            canvas.drawText(s, ox + 16f * d, oy + ph / 2f, text)
        } else {
            for (win in wins) drawWin(canvas, win, ox, oy, scale)
        }
        if (!unlocked) {
            fill.color = 0x99000000.toInt()
            canvas.drawRoundRect(tmp, 18f * d, 18f * d, fill)
            text.color = 0xFFFFFFFF.toInt()
            text.textSize = 16f * d
            val s = "锁屏"
            canvas.drawText(s, ox + (pw - text.measureText(s)) / 2f, oy + ph / 2f, text)
        }
        stroke.color = 0xFF444444.toInt()
        stroke.strokeWidth = 2f * d
        canvas.drawRoundRect(tmp, 18f * d, 18f * d, stroke)
        drawHint(canvas, w, h)
    }

    private fun drawHint(canvas: Canvas, w: Float, h: Float) {
        if (hint.isEmpty()) return
        text.color = 0xFFCCCCCC.toInt()
        text.textSize = 12f * d
        val x = 12f * d
        canvas.drawText(hint, x.coerceAtMost(w - 12f * d), h - 10f * d, text)
    }

    private fun drawWin(canvas: Canvas, win: StageWin, ox: Float, oy: Float, scale: Float) {
        val l = ox + win.l * scale
        val t = oy + win.t * scale
        val r = ox + win.r * scale
        val b = oy + win.b * scale
        if (r - l < 2 || b - t < 2) return
        tmp.set(l, t, r, b)
        fill.color = colorOf(win.pkg, win.focused)
        canvas.drawRoundRect(tmp, 6f * d, 6f * d, fill)
        stroke.color = if (win.focused) ContextCompat.getColor(context, R.color.accent) else 0x44FFFFFF
        stroke.strokeWidth = if (win.focused) 2.4f * d else 1f * d
        canvas.drawRoundRect(tmp, 6f * d, 6f * d, stroke)
        val label = win.title.ifBlank { win.pkg.substringAfterLast('.') }.ifBlank { "窗口" }
        text.color = 0xFFFFFFFF.toInt()
        text.textSize = (11f * d).coerceAtMost((b - t) * 0.35f).coerceAtLeast(8f * d)
        val maxW = (r - l - 10f * d).coerceAtLeast(8f)
        canvas.drawText(fit(label, maxW), l + 6f * d, t + text.textSize + 4f * d, text)
    }

    private fun colorOf(pkg: String, focused: Boolean): Int {
        var h = pkg.hashCode()
        if (h == 0) h = 0x445566
        val r = 40 + (h ushr 16 and 0x7F)
        val g = 40 + (h ushr 8 and 0x7F)
        val b = 40 + (h and 0x7F)
        val a = if (focused) 0xE6 else 0xB3
        return (a shl 24) or (r shl 16) or (g shl 8) or b
    }

    private fun fit(s: String, maxW: Float): String {
        if (text.measureText(s) <= maxW) return s
        var x = s
        while (x.length > 1 && text.measureText("$x…") > maxW) x = x.dropLast(1)
        return "$x…"
    }

    private fun frameAt(t: Long): StageFrame? {
        val f = frames
        if (f.isEmpty()) return null
        var lo = 0
        var hi = f.lastIndex
        while (lo < hi) {
            val mid = (lo + hi + 1) ushr 1
            if (f[mid].ts <= t) lo = mid else hi = mid - 1
        }
        return if (f[lo].ts <= t) f[lo] else null
    }
}
