package com.omnitrace.android.ui.dash

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RadialGradient
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Shader
import android.util.AttributeSet
import android.view.GestureDetector
import android.view.MotionEvent
import android.view.View
import android.widget.OverScroller
import androidx.core.content.ContextCompat
import com.omnitrace.android.R
import com.omnitrace.android.dash.Stay
import com.omnitrace.android.host.OmniPaths
import com.omnitrace.android.map.ChinaOffset
import com.omnitrace.android.map.CityCatalog
import com.omnitrace.android.map.Globe
import com.omnitrace.android.map.PackIndex
import com.omnitrace.android.map.PackOffer
import com.omnitrace.android.map.Slippy
import com.omnitrace.android.map.TileStore
import kotlin.math.abs
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.ln
import kotlin.math.max
import kotlin.math.pow

class PlacePathView @JvmOverloads constructor(
    context: Context,
    attrs: AttributeSet? = null,
) : View(context, attrs) {
    var stays: List<Stay> = emptyList()
        set(value) {
            field = value
            if (!userMoved) fit()
            invalidate()
        }
    var path: List<Pair<Double, Double>> = emptyList()
        set(value) {
            field = value
            invalidate()
        }
    var onTap: (() -> Unit)? = null
    var onNeedPack: ((PackOffer) -> Unit)? = null
    var cursor: Pair<Double, Double>? = null
        set(value) {
            field = value
            invalidate()
        }

    private var zoom = 3.0
    private var cx = 105.0
    private var cy = 35.0
    private var userMoved = false
    private val d = resources.displayMetrics.density
    private val slop = android.view.ViewConfiguration.get(context).scaledTouchSlop
    private var downX = 0f
    private var downY = 0f
    private var lockH = false
    private var interacting = false
    private var pinch = false
    private var pinchSpan0 = 0f
    private var pinchZ0 = 0.0
    private var pinchLat = 0.0
    private var pinchLon = 0.0
    private var ignoreGesture = false
    private var fingerPan = false
    private var lastFx = 0f
    private var lastFy = 0f
    private var suppressTap = false
    private val globeVerts = FloatArray(Globe.vertCount())
    private val globeClip = Path()
    private val globeShade = Paint(Paint.ANTI_ALIAS_FLAG)
    private var worldTex: Bitmap? = null
    private var worldTexKey = ""
    private var worldOwned = false
    private val endInteract = Runnable {
        interacting = false
        invalidate()
    }
    private val tileDst = Rect()
    private val tileSrc = Rect()
    private val tilePaint = Paint(Paint.FILTER_BITMAP_FLAG)
    private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        strokeWidth = 2.2f * d
        style = Paint.Style.STROKE
        strokeJoin = Paint.Join.ROUND
        strokeCap = Paint.Cap.ROUND
    }
    private val fill = Paint(Paint.ANTI_ALIAS_FLAG)
    private val stroke = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeWidth = 1.2f * d
    }
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply { textSize = 11f * d }
    private val scroller = OverScroller(context)
    private var lastSx = 0
    private var lastSy = 0
    private val onTile: () -> Unit = { post { invalidate() } }
    private val checkPack = Runnable { offerPack() }

    private val gesture = GestureDetector(
        context,
        object : GestureDetector.SimpleOnGestureListener() {
            override fun onDown(e: MotionEvent): Boolean {
                scroller.abortAnimation()
                return true
            }
            override fun onScroll(e1: MotionEvent?, e2: MotionEvent, distanceX: Float, distanceY: Float): Boolean {
                if (ignoreGesture || pinch) return true
                pan(distanceX, distanceY)
                return true
            }
            override fun onFling(e1: MotionEvent?, e2: MotionEvent, velocityX: Float, velocityY: Float): Boolean {
                if (ignoreGesture || pinch) return true
                lastSx = 0
                lastSy = 0
                scroller.fling(0, 0, velocityX.toInt(), velocityY.toInt(), -100000, 100000, -100000, 100000)
                postInvalidateOnAnimation()
                return true
            }
            override fun onSingleTapUp(e: MotionEvent): Boolean {
                if (suppressTap) return true
                onTap?.invoke()
                return true
            }
        },
    )

    init {
        TileStore.init(java.io.File(OmniPaths.dataRoot(context), "cache/map_tiles"))
    }

    fun follow(lat: Double, lon: Double) {
        val p = ChinaOffset.toMap(lat, lon, TileStore.source)
        cy = p.first
        cx = p.second
        invalidate()
    }

    fun goTo(lat: Double, lon: Double, z: Double = 15.0) {
        userMoved = true
        val p = ChinaOffset.toMap(lat, lon, TileStore.source)
        cy = p.first
        cx = p.second
        zoom = z.coerceIn(Slippy.MIN_Z.toDouble(), Slippy.MAX_Z.toDouble())
        scroller.abortAnimation()
        invalidate()
        schedulePack()
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                downX = event.x
                downY = event.y
                lastFx = event.x
                lastFy = event.y
                lockH = false
                pinch = false
                fingerPan = false
                ignoreGesture = false
                suppressTap = false
                interacting = true
                scroller.abortAnimation()
                removeCallbacks(endInteract)
            }
            MotionEvent.ACTION_POINTER_DOWN -> {
                lockH = true
                suppressTap = true
                ignoreGesture = true
                fingerPan = false
                parent?.requestDisallowInterceptTouchEvent(true)
                scroller.abortAnimation()
                if (event.pointerCount >= 2) beginPinch(event)
            }
            MotionEvent.ACTION_MOVE -> {
                if (pinch && event.pointerCount >= 2) {
                    parent?.requestDisallowInterceptTouchEvent(true)
                    applyPinch(event)
                    return true
                }
                if (fingerPan || ignoreGesture) {
                    if (event.pointerCount == 1) {
                        pan(lastFx - event.x, lastFy - event.y)
                        lastFx = event.x
                        lastFy = event.y
                    }
                    return true
                }
                if (!lockH && (abs(event.x - downX) > slop || abs(event.y - downY) > slop)) {
                    lockH = true
                    parent?.requestDisallowInterceptTouchEvent(true)
                }
            }
            MotionEvent.ACTION_POINTER_UP -> {
                if (event.pointerCount <= 2) {
                    pinch = false
                    val keep = if (event.actionIndex == 0) 1 else 0
                    if (keep < event.pointerCount) {
                        lastFx = event.getX(keep)
                        lastFy = event.getY(keep)
                        fingerPan = true
                        ignoreGesture = true
                    }
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                parent?.requestDisallowInterceptTouchEvent(false)
                lockH = false
                pinch = false
                fingerPan = false
                schedulePack()
                removeCallbacks(endInteract)
                postDelayed(endInteract, 32)
            }
        }
        if (event.pointerCount >= 2 || pinch || ignoreGesture) return true
        gesture.onTouchEvent(event)
        return true
    }

    private fun beginPinch(e: MotionEvent) {
        val s = spanOf(e)
        if (s < 8f) return
        pinch = true
        pinchSpan0 = s
        pinchZ0 = zoom
        val mid = screenToLatLon(midX(e), midY(e), zoom)
        pinchLat = mid.first
        pinchLon = mid.second
    }

    private fun applyPinch(e: MotionEvent) {
        val s = spanOf(e)
        if (pinchSpan0 < 8f || s < 8f) return
        val z1 = (pinchZ0 + ln(s / pinchSpan0) / ln(2.0))
            .coerceIn(Slippy.MIN_Z.toDouble(), Slippy.MAX_Z.toDouble())
        keepLatLonAt(pinchLat, pinchLon, midX(e), midY(e), z1)
        invalidate()
    }

    private fun screenToLatLon(sx: Float, sy: Float, z: Double): Pair<Double, Double> {
        val w = width.toFloat().coerceAtLeast(1f)
        val h = height.toFloat().coerceAtLeast(1f)
        if (Globe.active(z, w, h)) {
            val r = Globe.radius(z, w, h)
            val deg = Globe.dLonPerPx(r)
            return (cy - (sy - h / 2f) * deg).coerceIn(-80.0, 80.0) to
                Globe.wrapLon(cx + (sx - w / 2f) * deg)
        }
        val lon = Slippy.worldXToLon(Slippy.lonToWorldX(cx, z) - w / 2.0 + sx, z)
        val lat = Slippy.worldYToLat(Slippy.latToWorldY(cy, z) - h / 2.0 + sy, z)
        return lat to lon
    }

    private fun keepLatLonAt(lat: Double, lon: Double, sx: Float, sy: Float, z: Double) {
        userMoved = true
        zoom = z.coerceIn(Slippy.MIN_Z.toDouble(), Slippy.MAX_Z.toDouble())
        val w = width.toFloat().coerceAtLeast(1f)
        val h = height.toFloat().coerceAtLeast(1f)
        if (Globe.active(zoom, w, h)) {
            val r = Globe.radius(zoom, w, h)
            val deg = Globe.dLonPerPx(r)
            cx = Globe.wrapLon(lon - (sx - w / 2f) * deg)
            cy = (lat + (sy - h / 2f) * deg).coerceIn(-80.0, 80.0)
        } else {
            cx = Slippy.worldXToLon(Slippy.lonToWorldX(lon, zoom) - sx + w / 2.0, zoom)
            cy = Slippy.worldYToLat(Slippy.latToWorldY(lat, zoom) - sy + h / 2.0, zoom)
        }
    }

    private fun spanOf(e: MotionEvent): Float {
        if (e.pointerCount < 2) return 0f
        return hypot(e.getX(0) - e.getX(1), e.getY(0) - e.getY(1))
    }

    private fun midX(e: MotionEvent): Float = (e.getX(0) + e.getX(1)) / 2f

    private fun midY(e: MotionEvent): Float = (e.getY(0) + e.getY(1)) / 2f

    override fun computeScroll() {
        if (!scroller.computeScrollOffset()) return
        val x = scroller.currX
        val y = scroller.currY
        pan(-(x - lastSx).toFloat(), -(y - lastSy).toFloat())
        lastSx = x
        lastSy = y
        postInvalidateOnAnimation()
    }

    override fun onDraw(canvas: Canvas) {
        val w = width.toFloat().coerceAtLeast(1f)
        val h = height.toFloat().coerceAtLeast(1f)
        val accent = ContextCompat.getColor(context, R.color.accent)
        val fg = ContextCompat.getColor(context, R.color.fg)
        val muted = ContextCompat.getColor(context, R.color.muted)
        line.color = accent
        fill.color = accent
        stroke.color = fg
        text.color = fg
        val z = zoom.coerceIn(Slippy.MIN_Z.toDouble(), Slippy.MAX_Z.toDouble())
        val globe = Globe.active(z, w, h)
        if (globe) {
            drawGlobe(canvas, w, h, z)
        } else {
            drawTiles(canvas, w, h, z)
        }
        fun xy(lat: Double, lon: Double): Pair<Float, Float> {
            val p = ChinaOffset.toMap(lat, lon, TileStore.source)
            if (globe) {
                val r = Globe.radius(z, w, h)
                return Globe.project(p.first, p.second, cy, cx, r, w / 2f, h / 2f, frontOnly = true)
            }
            val x = (Slippy.lonToWorldX(p.second, z) - (Slippy.lonToWorldX(cx, z) - w / 2.0)).toFloat()
            val y = (Slippy.latToWorldY(p.first, z) - (Slippy.latToWorldY(cy, z) - h / 2.0)).toFloat()
            return x to y
        }
        if (path.size >= 2 && z >= 8 && !globe) {
            var prev: Pair<Float, Float>? = null
            for (p in path) {
                val cur = xy(p.first, p.second)
                if (prev != null) canvas.drawLine(prev.first, prev.second, cur.first, cur.second, line)
                prev = cur
            }
        }
        for (s in stays) {
            val p = xy(s.lat, s.lon)
            if (p.first.isNaN()) continue
            val rr = 4f * d + (ln((s.end - s.start).coerceAtLeast(1L).toDouble() / 300_000.0 + 1.0) * d).toFloat()
            canvas.drawCircle(p.first, p.second, rr, fill)
            canvas.drawCircle(p.first, p.second, rr, stroke)
        }
        cursor?.let { c ->
            val p = xy(c.first, c.second)
            if (p.first.isNaN()) return@let
            fill.color = 0xE6B33B3B.toInt()
            canvas.drawCircle(p.first, p.second, 8f * d, fill)
            canvas.drawCircle(p.first, p.second, 8f * d, stroke)
        }
        drawScale(canvas, w, h, z, fg)
        text.textSize = 10f * d
        text.color = muted
        val attr = TileStore.source.attribution
        canvas.drawText(attr, w - text.measureText(attr) - 10f * d, h - 10f * d, text)
    }

    private fun drawGlobe(canvas: Canvas, w: Float, h: Float, z: Double) {
        if (!interacting) {
            for (zz in 0..2) {
                val n = Slippy.n(zz)
                for (y in 0 until n) for (x in 0 until n) TileStore.request(zz, x, y)
            }
        }
        val cx0 = w / 2f
        val cy0 = h / 2f
        val r = Globe.radius(z, w, h)
        fill.color = 0xFF8EBBD4.toInt()
        canvas.drawCircle(cx0, cy0, r, fill)
        val tex = worldTexture()
        if (tex != null) {
            Globe.fillMesh(globeVerts, cy, cx, cx0, cy0, r)
            globeClip.reset()
            globeClip.addCircle(cx0, cy0, r, Path.Direction.CW)
            canvas.save()
            canvas.clipPath(globeClip)
            tilePaint.alpha = 255
            canvas.drawBitmapMesh(tex, Globe.COLS, Globe.ROWS, globeVerts, 0, null, 0, tilePaint)
            canvas.restore()
        }
        globeShade.shader = RadialGradient(
            cx0, cy0, r,
            intArrayOf(0x00000000, 0x24000000, 0x66000000),
            floatArrayOf(0.42f, 0.82f, 1f),
            Shader.TileMode.CLAMP,
        )
        canvas.drawCircle(cx0, cy0, r, globeShade)
    }

    private fun worldTexture(): Bitmap? {
        val id = TileStore.source.id
        val t00 = TileStore.peek(1, 0, 0)
        val t10 = TileStore.peek(1, 1, 0)
        val t01 = TileStore.peek(1, 0, 1)
        val t11 = TileStore.peek(1, 1, 1)
        val key = if (t00 != null && t10 != null && t01 != null && t11 != null) "$id/1" else "$id/0"
        if (worldTex != null && worldTexKey == key) return worldTex
        if (worldOwned) {
            worldTex?.recycle()
            worldTex = null
            worldOwned = false
        }
        if (t00 != null && t10 != null && t01 != null && t11 != null) {
            val b = Bitmap.createBitmap(512, 512, Bitmap.Config.RGB_565)
            val c = Canvas(b)
            val p = Paint(Paint.FILTER_BITMAP_FLAG)
            c.drawBitmap(t00, 0f, 0f, p)
            c.drawBitmap(t10, 256f, 0f, p)
            c.drawBitmap(t01, 0f, 256f, p)
            c.drawBitmap(t11, 256f, 256f, p)
            worldTex = b
            worldTexKey = key
            worldOwned = true
            return b
        }
        val z0 = TileStore.peek(0, 0, 0)
        worldTex = z0
        worldTexKey = key
        worldOwned = false
        return z0
    }

    private fun drawTiles(canvas: Canvas, w: Float, h: Float, z: Double) {
        val zInt = floor(z).toInt().coerceIn(0, Slippy.MAX_Z)
        val originX = Slippy.lonToWorldX(cx, z) - w / 2.0
        val originY = Slippy.latToWorldY(cy, z) - h / 2.0
        val tileWorld = Slippy.TILE * 2.0.pow(z - zInt)
        val x0 = floor(originX / tileWorld).toInt()
        val y0 = floor(originY / tileWorld).toInt()
        val x1 = ceil((originX + w) / tileWorld).toInt()
        val y1 = ceil((originY + h) / tileWorld).toInt()
        val n = Slippy.n(zInt)
        tilePaint.alpha = 255
        for (ty in y0 until y1) {
            if (ty < 0 || ty >= n) continue
            for (tx in x0 until x1) {
                val wrapped = ((tx % n) + n) % n
                val cover = TileStore.cover(zInt, wrapped, ty)
                if (cover == null || !cover.exact) TileStore.request(zInt, wrapped, ty)
                if (cover == null && zInt > 0) TileStore.request(zInt - 1, wrapped / 2, ty / 2)
                if (cover == null) continue
                val l = (tx * tileWorld - originX).toInt()
                val t = (ty * tileWorld - originY).toInt()
                val size = ceil(tileWorld).toInt() + 1
                tileDst.set(l, t, l + size, t + size)
                srcOf(cover, zInt, wrapped, ty)
                canvas.drawBitmap(cover.bmp, tileSrc, tileDst, tilePaint)
            }
        }
        if (!interacting) {
            val px0 = (x0 - 1).coerceAtLeast(0)
            val px1 = x1 + 1
            val py0 = (y0 - 1).coerceAtLeast(0)
            val py1 = (y1 + 1).coerceAtMost(n)
            for (ty in py0 until py1) {
                for (tx in px0 until px1) {
                    if (ty in y0 until y1 && tx in x0 until x1) continue
                    val wrapped = ((tx % n) + n) % n
                    TileStore.request(zInt, wrapped, ty)
                }
            }
        }
    }

    private fun srcOf(cover: TileStore.Cover, z: Int, x: Int, y: Int) {
        val tw = cover.bmp.width
        val th = cover.bmp.height
        if (cover.exact || cover.srcZ == z) {
            tileSrc.set(0, 0, tw, th)
            return
        }
        val dz = z - cover.srcZ
        val n = 1 shl dz
        val localX = x - (cover.srcX shl dz)
        val localY = y - (cover.srcY shl dz)
        val sw = tw / n
        val sh = th / n
        tileSrc.set(localX * sw, localY * sh, (localX + 1) * sw, (localY + 1) * sh)
    }

    private fun drawScale(canvas: Canvas, w: Float, h: Float, z: Double, fg: Int) {
        val mpp = Slippy.metersPerPixel(cy, z)
        val target = 72f * d
        val steps = doubleArrayOf(
            5.0, 10.0, 20.0, 50.0, 100.0, 200.0, 500.0,
            1_000.0, 2_000.0, 5_000.0, 10_000.0, 20_000.0, 50_000.0,
            100_000.0, 200_000.0, 500_000.0, 1_000_000.0, 2_000_000.0, 5_000_000.0,
        )
        var nice = steps.last()
        for (s in steps) {
            if (s / mpp >= target * 0.55f) {
                nice = s
                break
            }
        }
        val bar = (nice / mpp).toFloat().coerceIn(28f * d, w * 0.45f)
        val label = if (nice >= 1000) "${(nice / 1000).toInt()} km" else "${nice.toInt()} m"
        val left = 12f * d
        val bottom = h - 28f * d
        fill.color = 0x99FFFFFF.toInt()
        val box = RectF(left - 6f * d, bottom - 18f * d, left + bar + 8f * d, bottom + 8f * d)
        canvas.drawRoundRect(box, 4f * d, 4f * d, fill)
        stroke.color = fg
        stroke.strokeWidth = 2.2f * d
        canvas.drawLine(left, bottom, left + bar, bottom, stroke)
        canvas.drawLine(left, bottom - 5f * d, left, bottom + 2f * d, stroke)
        canvas.drawLine(left + bar, bottom - 5f * d, left + bar, bottom + 2f * d, stroke)
        text.color = fg
        text.textSize = 11f * d
        canvas.drawText(label, left + 4f * d, bottom - 6f * d, text)
    }

    private fun pan(dx: Float, dy: Float) {
        userMoved = true
        val z = zoom
        val w = width.toFloat().coerceAtLeast(1f)
        val h = height.toFloat().coerceAtLeast(1f)
        if (Globe.active(z, w, h)) {
            val r = Globe.radius(z, w, h)
            val d = Globe.dLonPerPx(r)
            cx = Globe.wrapLon(cx + dx * d)
            cy = (cy - dy * d).coerceIn(-80.0, 80.0)
        } else {
            cx = Slippy.worldXToLon(Slippy.lonToWorldX(cx, z) + dx, z)
            cy = Slippy.worldYToLat(Slippy.latToWorldY(cy, z) + dy, z)
        }
        invalidate()
    }

    private fun zoomAt(focusX: Float, focusY: Float, factor: Double) {
        val z0 = zoom
        val z1 = (z0 + ln(factor) / ln(2.0)).coerceIn(Slippy.MIN_Z.toDouble(), Slippy.MAX_Z.toDouble())
        if (z1 == z0) return
        val p = screenToLatLon(focusX, focusY, z0)
        keepLatLonAt(p.first, p.second, focusX, focusY, z1)
        invalidate()
    }

    private fun schedulePack() {
        removeCallbacks(checkPack)
        postDelayed(checkPack, 420)
    }

    private fun offerPack() {
        if (zoom < Slippy.CITY_Z) return
        if (PackIndex.coversPoint(TileStore.source, cy, cx)) return
        val w = width.toFloat().coerceAtLeast(1f)
        val h = height.toFloat().coerceAtLeast(1f)
        val z = zoom
        val originX = Slippy.lonToWorldX(cx, z) - w / 2.0
        val originY = Slippy.latToWorldY(cy, z) - h / 2.0
        val corners = arrayOf(
            Slippy.worldYToLat(originY, z) to Slippy.worldXToLon(originX, z),
            Slippy.worldYToLat(originY, z) to Slippy.worldXToLon(originX + w, z),
            Slippy.worldYToLat(originY + h, z) to Slippy.worldXToLon(originX, z),
            Slippy.worldYToLat(originY + h, z) to Slippy.worldXToLon(originX + w, z),
        )
        val south = corners.minOf { it.first }
        val north = corners.maxOf { it.first }
        val west = corners.minOf { it.second }
        val east = corners.maxOf { it.second }
        val offer = CityCatalog.viewportOffer(south, west, north, east, floor(z).toInt(), TileStore.source)
        onNeedPack?.invoke(offer)
    }

    private fun fit() {
        val src = TileStore.source
        val pts = (stays.map { it.lat to it.lon } + path).map { ChinaOffset.toMap(it.first, it.second, src) }
        if (pts.isEmpty() || width <= 0 || height <= 0) return
        val minLat = pts.minOf { it.first }
        val maxLat = pts.maxOf { it.first }
        val minLon = pts.minOf { it.second }
        val maxLon = pts.maxOf { it.second }
        cy = (minLat + maxLat) / 2.0
        cx = (minLon + maxLon) / 2.0
        val dLon = max(maxLon - minLon, 0.02)
        var z = Slippy.MAX_Z.toDouble()
        while (z > Slippy.MIN_Z + 1) {
            val wLon = dLon / 360.0 * Slippy.worldPx(z)
            val wLat = abs(Slippy.latToWorldY(minLat, z) - Slippy.latToWorldY(maxLat, z))
            if (wLon < width * 0.7 && wLat < height * 0.7) break
            z -= 0.25
        }
        zoom = z
    }

    private var wanting = false

    private fun wantTiles(on: Boolean) {
        if (wanting == on) return
        wanting = on
        if (on) TileStore.addWanted() else TileStore.removeWanted()
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        if (!userMoved) fit()
    }

    override fun onVisibilityAggregated(isVisible: Boolean) {
        super.onVisibilityAggregated(isVisible)
        wantTiles(isVisible)
    }

    override fun onDetachedFromWindow() {
        wantTiles(false)
        removeCallbacks(checkPack)
        removeCallbacks(endInteract)
        TileStore.removeListener(onTile)
        if (worldOwned) {
            worldTex?.recycle()
            worldTex = null
            worldOwned = false
        }
        super.onDetachedFromWindow()
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        TileStore.addListener(onTile)
        wantTiles(isShown)
    }
}
