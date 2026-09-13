package com.omnitrace.android.ui.graph

import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.util.AttributeSet
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.ScaleGestureDetector
import android.view.View
import android.view.ViewConfiguration
import android.widget.OverScroller
import androidx.core.content.ContextCompat
import androidx.core.graphics.drawable.DrawableCompat
import com.omnitrace.android.R
import com.omnitrace.android.graph.CaptureGraphCatalog
import com.omnitrace.android.graph.HwSpecResolver
import kotlin.math.abs
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.min

class BoundedGraphView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {
    var model: CaptureGraphCatalog.GraphModel? = null
        set(value) {
            field = value
            if (value != null && !fitted) fitToContent()
            invalidate()
        }

    var onNodeClick: ((CaptureGraphCatalog.GraphNode) -> Unit)? = null
    var onTitleClick: ((CaptureGraphCatalog.GraphNode) -> Unit)? = null

    private val titleHits = ArrayList<Pair<String, RectF>>()

    private val d = resources.displayMetrics.density
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val text = Paint(Paint.ANTI_ALIAS_FLAG)
    private val linePaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        strokeWidth = 1.2f * d
        style = Paint.Style.STROKE
    }
    private val divPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        strokeWidth = 1f * d
        style = Paint.Style.STROKE
    }
    private val tmp = RectF()
    private val edgePath = Path()

    private var panX = 0f
    private var panY = 0f
    private var scale = 1f
    private var fitted = false

    private val scroller = OverScroller(context)
    private val minFling = ViewConfiguration.get(context).scaledMinimumFlingVelocity
    private var flingLastX = 0
    private var flingLastY = 0
    private var flingNotifyAt = 0L
    private val flingTick = Runnable { stepFling() }
    private val zoomTick = Runnable { stepZoomFling() }
    private var scaleAt = 0L
    private var scaleVel = 0.0
    private var scaleFocusX = 0f
    private var scaleFocusY = 0f
    private var zoomFlingVel = 0.0
    private var zoomTickAt = 0L

    private val scaleDet = ScaleGestureDetector(
        context,
        object : ScaleGestureDetector.SimpleOnScaleGestureListener() {
            override fun onScaleBegin(detector: ScaleGestureDetector): Boolean {
                abortInertia()
                scaleAt = android.os.SystemClock.uptimeMillis()
                scaleVel = 0.0
                scaleFocusX = detector.focusX
                scaleFocusY = detector.focusY
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
                scaleFocusY = detector.focusY
                zoomAt(detector.focusX, detector.focusY, detector.scaleFactor)
                return true
            }

            override fun onScaleEnd(detector: ScaleGestureDetector) {
                val idle = (android.os.SystemClock.uptimeMillis() - scaleAt) / 1000.0
                if (idle > 0.0) scaleVel *= exp(-ZOOM_FRICTION * idle)
                if (abs(scaleVel) >= MIN_ZOOM_VEL) startZoomFling(scaleFocusX, scaleFocusY, scaleVel)
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

            override fun onScroll(
                e1: MotionEvent?,
                e2: MotionEvent,
                distanceX: Float,
                distanceY: Float,
            ): Boolean {
                pan(distanceX, distanceY)
                return true
            }

            override fun onFling(
                e1: MotionEvent?,
                e2: MotionEvent,
                velocityX: Float,
                velocityY: Float,
            ): Boolean {
                if (max(abs(velocityX), abs(velocityY)) < minFling) return false
                startFling(velocityX, velocityY)
                return true
            }

            override fun onSingleTapUp(e: MotionEvent): Boolean {
                val m = model ?: return false
                val wx = screenToWorldX(e.x)
                val wy = screenToWorldY(e.y)
                for ((nodeId, rect) in titleHits) {
                    if (rect.contains(e.x, e.y)) {
                        val node = m.nodes.find { it.id == nodeId }
                        if (node != null) {
                            onTitleClick?.invoke(node)
                            performClick()
                            return true
                        }
                    }
                }
                for (n in m.nodes) {
                    val cx = circleX(n)
                    val cy = n.worldY
                    val r = CaptureGraphCatalog.CIRCLE_R + 6f
                    val dx = wx - cx
                    val dy = wy - cy
                    if (dx * dx + dy * dy <= r * r) {
                        onNodeClick?.invoke(n)
                        performClick()
                        return true
                    }
                }
                return false
            }
        },
    )

    init {
        isClickable = true
    }

    override fun performClick(): Boolean {
        super.performClick()
        return true
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        scaleDet.onTouchEvent(event)
        gesture.onTouchEvent(event)
        return true
    }

    fun fitToContent() {
        val m = model ?: return
        if (width <= 0 || height <= 0) {
            fitted = false
            return
        }
        val contentW = (m.boundsRight - m.boundsLeft) * d
        val contentH = (m.boundsBottom - m.boundsTop) * d
        val margin = 24f * d
        val sx = (width - margin * 2) / contentW.coerceAtLeast(1f)
        val sy = (height - margin * 2) / contentH.coerceAtLeast(1f)
        scale = min(sx, sy).coerceIn(MIN_SCALE, MAX_SCALE)
        val cx = (m.boundsLeft + m.boundsRight) / 2f * d
        val cy = (m.boundsTop + m.boundsBottom) / 2f * d
        panX = width / 2f - cx * scale
        panY = height / 2f - cy * scale
        clamp()
        fitted = true
        invalidate()
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        if (model != null) fitToContent()
    }

    override fun onDraw(canvas: Canvas) {
        val m = model ?: return
        titleHits.clear()
        val accent = ContextCompat.getColor(context, R.color.accent)
        val fg = ContextCompat.getColor(context, R.color.fg)
        val muted = ContextCompat.getColor(context, R.color.muted)
        val line = ContextCompat.getColor(context, R.color.line)

        for (e in m.edges) {
            val a = m.nodes.find { it.id == e.fromId } ?: continue
            val b = m.nodes.find { it.id == e.toId } ?: continue
            val alpha = (min(a.alpha, b.alpha) * 255).toInt().coerceIn(0, 255)
            linePaint.color = accent
            linePaint.alpha = alpha
            val x0 = worldToScreenX(circleX(a))
            val y0 = worldToScreenY(a.worldY)
            val x1 = worldToScreenX(circleX(b))
            val y1 = worldToScreenY(b.worldY)
            val r0 = CaptureGraphCatalog.CIRCLE_R * d * scale
            val r1 = CaptureGraphCatalog.CIRCLE_R * d * scale
            drawElbow(canvas, x0, y0, r0, x1, y1, r1, alpha)
        }

        for (n in m.nodes) {
            drawNode(canvas, n, fg, muted, line, accent)
        }
    }

    private fun drawNode(
        canvas: Canvas,
        n: CaptureGraphCatalog.GraphNode,
        fg: Int,
        muted: Int,
        line: Int,
        accent: Int,
    ) {
        val cx = worldToScreenX(circleX(n))
        val cy = worldToScreenY(n.worldY)
        val r = CaptureGraphCatalog.CIRCLE_R * d * scale
        val a = (n.alpha * 255).toInt().coerceIn(0, 255)

        paint.color = accent
        paint.alpha = a
        paint.style = Paint.Style.STROKE
        paint.strokeWidth = 2f * d
        canvas.drawCircle(cx, cy, r, paint)
        paint.style = Paint.Style.FILL
        paint.alpha = (a * 0.12f).toInt().coerceIn(0, 255)
        canvas.drawCircle(cx, cy, r, paint)

        val icon = ContextCompat.getDrawable(context, n.iconRes)
        if (icon != null) {
            val isize = (r * 1.1f).toInt()
            val left = (cx - isize / 2f).toInt()
            val top = (cy - isize / 2f).toInt()
            DrawableCompat.setTint(icon, if (n.hwState == CaptureGraphCatalog.HwState.MISSING) muted else accent)
            icon.alpha = a
            icon.setBounds(left, top, left + isize, top + isize)
            icon.draw(canvas)
        }

        drawTextBlock(canvas, n.leftLines, cx - r - 8f * d * scale, cy, true, fg, muted, line, a, n.id)
        drawTextBlock(
            canvas,
            n.rightLines.map { HwSpecResolver.SpecLine(it, false) },
            cx + r + 8f * d * scale,
            cy,
            false,
            fg,
            muted,
            line,
            a,
            null,
        )
    }

    private fun drawElbow(
        canvas: Canvas,
        cx0: Float,
        cy0: Float,
        r0: Float,
        cx1: Float,
        cy1: Float,
        r1: Float,
        alpha: Int,
    ) {
        val edgeH = CaptureGraphCatalog.EDGE_H * d * scale
        val toRight = cx1 >= cx0
        val sx = if (toRight) cx0 + r0 else cx0 - r0
        val sy = cy0
        val midX = if (toRight) sx + edgeH else sx - edgeH
        val tx = if (toRight) cx1 - r1 else cx1 + r1
        val ty = cy1
        edgePath.reset()
        edgePath.moveTo(sx, sy)
        edgePath.lineTo(midX, sy)
        edgePath.lineTo(tx, ty)
        canvas.drawPath(edgePath, linePaint)
    }

    private fun drawTextBlock(
        canvas: Canvas,
        lines: List<HwSpecResolver.SpecLine>,
        anchorX: Float,
        centerY: Float,
        alignRight: Boolean,
        fg: Int,
        muted: Int,
        lineColor: Int,
        alpha: Int,
        titleHitNodeId: String?,
    ) {
        val titleSize = 13f * d * scale.coerceIn(0.6f, 1.2f)
        val bodySize = 10f * d * scale.coerceIn(0.55f, 1.1f)
        val lineH = CaptureGraphCatalog.LINE_H * d * scale
        val divH = CaptureGraphCatalog.DIV_H * d * scale
        val totalH = lines.fold(0f) { acc, _ -> acc + lineH + divH } - divH / 2f
        var y = centerY - totalH / 2f + bodySize

        for (line in lines) {
            text.textSize = if (line.title) titleSize else bodySize
            text.color = if (line.title) fg else muted
            text.alpha = alpha
            text.isFakeBoldText = line.title
            val tw = text.measureText(line.text)
            val x = if (alignRight) anchorX - tw else anchorX
            canvas.drawText(line.text, x, y, text)
            if (line.title && titleHitNodeId != null) {
                val pad = 4f * d
                titleHits.add(
                    titleHitNodeId to RectF(
                        x - pad,
                        y - titleSize,
                        x + tw + pad,
                        y + pad,
                    ),
                )
            }
            val divY = y + divH * 0.35f
            val divLen = min(tw, DIV_LINE_W * d * scale)
            divPaint.color = lineColor
            divPaint.alpha = (alpha * 0.7f).toInt().coerceIn(0, 255)
            canvas.drawLine(x, divY, x + divLen, divY, divPaint)
            y += lineH + divH
        }
    }

    private fun circleX(n: CaptureGraphCatalog.GraphNode): Float = when (n.kind) {
        CaptureGraphCatalog.Kind.SOURCE -> n.worldX + CaptureGraphCatalog.LEFT_W + CaptureGraphCatalog.CIRCLE_R
        CaptureGraphCatalog.Kind.CATEGORY,
        CaptureGraphCatalog.Kind.HUB,
        -> n.worldX
        CaptureGraphCatalog.Kind.SINK -> n.worldX + CaptureGraphCatalog.LEFT_W + CaptureGraphCatalog.CIRCLE_R
    }

    private fun worldToScreenX(wx: Float): Float = wx * d * scale + panX
    private fun worldToScreenY(wy: Float): Float = wy * d * scale + panY
    private fun screenToWorldX(sx: Float): Float = (sx - panX) / (d * scale)
    private fun screenToWorldY(sy: Float): Float = (sy - panY) / (d * scale)

    private fun pan(dx: Float, dy: Float) {
        panX -= dx
        panY -= dy
        clamp()
        invalidate()
    }

    private fun zoomAt(focusX: Float, focusY: Float, factor: Float) {
        val wx = (focusX - panX) / (d * scale)
        val wy = (focusY - panY) / (d * scale)
        scale = (scale * factor).coerceIn(MIN_SCALE, MAX_SCALE)
        panX = focusX - wx * d * scale
        panY = focusY - wy * d * scale
        clamp()
        invalidate()
    }

    private fun startFling(vx: Float, vy: Float) {
        abortInertia()
        flingLastX = 0
        flingLastY = 0
        scroller.fling(0, 0, (-vx).toInt(), (-vy).toInt(), -50_000_000, 50_000_000, -50_000_000, 50_000_000)
        postOnAnimation(flingTick)
    }

    private fun startZoomFling(fx: Float, fy: Float, vel: Double) {
        abortPanFling()
        zoomFlingVel = vel.coerceIn(-MAX_ZOOM_VEL, MAX_ZOOM_VEL)
        scaleFocusX = fx
        scaleFocusY = fy
        zoomTickAt = android.os.SystemClock.uptimeMillis()
        postOnAnimation(zoomTick)
    }

    private fun stepFling() {
        val more = scroller.computeScrollOffset()
        val x = scroller.currX
        val y = scroller.currY
        val dx = (x - flingLastX).toFloat()
        val dy = (y - flingLastY).toFloat()
        flingLastX = x
        flingLastY = y
        if (dx != 0f || dy != 0f) pan(dx, dy)
        if (more) postOnAnimation(flingTick)
    }

    private fun stepZoomFling() {
        val now = android.os.SystemClock.uptimeMillis()
        val dt = ((now - zoomTickAt).coerceIn(1L, 32L)) / 1000.0
        zoomTickAt = now
        val factor = exp(zoomFlingVel * dt).toFloat().coerceIn(0.82f, 1.22f)
        zoomAt(scaleFocusX, scaleFocusY, factor)
        zoomFlingVel *= exp(-ZOOM_FRICTION * dt)
        if (abs(zoomFlingVel) >= MIN_ZOOM_VEL * 0.2) postOnAnimation(zoomTick)
        else zoomFlingVel = 0.0
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

    private fun clamp() {
        val m = model ?: return
        if (width <= 0 || height <= 0) return
        val s = d * scale
        // 任意世界坐标点都能被平移到屏幕中心：pan = 屏心 − 世界坐标×缩放
        val panXMin = width / 2f - m.boundsRight * s
        val panXMax = width / 2f - m.boundsLeft * s
        val panYMin = height / 2f - m.boundsBottom * s
        val panYMax = height / 2f - m.boundsTop * s
        panX = panX.coerceIn(min(panXMin, panXMax), max(panXMin, panXMax))
        panY = panY.coerceIn(min(panYMin, panYMax), max(panYMin, panYMax))
    }

    companion object {
        private const val MIN_SCALE = 0.35f
        private const val MAX_SCALE = 2.5f
        private const val DIV_LINE_W = 118f
        private const val ZOOM_FRICTION = 5.2
        private const val MIN_ZOOM_VEL = 0.55
        private const val MAX_ZOOM_VEL = 3.8
    }
}
