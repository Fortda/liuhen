package com.omnitrace.android.map

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.ln
import kotlin.math.min
import kotlin.math.sin

/**
 * 远距正射球体：把 z0/z1 世界图贴在半球 mesh 上。不是 OpenGL 地球仪，一张位图 + 几百顶点。
 */
object Globe {
    const val COLS = 28
    const val ROWS = 14

    fun vertCount(): Int = (COLS + 1) * (ROWS + 1) * 2

    fun fillZoom(viewW: Float, viewH: Float): Double {
        val m = min(viewW, viewH).coerceAtLeast(1f)
        return ln(m / Slippy.TILE.toDouble()) / ln(2.0)
    }

    fun active(zoom: Double, viewW: Float, viewH: Float): Boolean =
        zoom < fillZoom(viewW, viewH) - 0.04

    fun radius(zoom: Double, viewW: Float, viewH: Float): Float {
        val m = min(viewW, viewH)
        val zf = fillZoom(viewW, viewH).coerceAtLeast(0.35)
        val t = (zoom / zf).coerceIn(0.0, 1.0)
        return (m * (0.34 + 0.14 * t)).toFloat()
    }

    fun fillMesh(out: FloatArray, camLat: Double, camLon: Double, cx: Float, cy: Float, r: Float) {
        var k = 0
        for (j in 0..ROWS) {
            val lat = Slippy.worldYToLat(j.toDouble() / ROWS * Slippy.TILE, 0.0)
            for (i in 0..COLS) {
                val lon = -180.0 + 360.0 * i / COLS
                val p = project(lat, lon, camLat, camLon, r, cx, cy, frontOnly = false)
                out[k++] = p.first
                out[k++] = p.second
            }
        }
    }

    fun project(
        lat: Double,
        lon: Double,
        camLat: Double,
        camLon: Double,
        r: Float,
        cx: Float,
        cy: Float,
        frontOnly: Boolean,
    ): Pair<Float, Float> {
        val latR = Math.toRadians(lat)
        val lonR = Math.toRadians(lon)
        val cLat = Math.toRadians(camLat)
        val dLon = lonR - Math.toRadians(camLon)
        val x = cos(latR) * sin(dLon)
        val y = cos(cLat) * sin(latR) - sin(cLat) * cos(latR) * cos(dLon)
        val z = sin(cLat) * sin(latR) + cos(cLat) * cos(latR) * cos(dLon)
        if (z < 0) {
            if (frontOnly) return Float.NaN to Float.NaN
            val h = hypot(x, y).coerceAtLeast(1e-6)
            return (cx + r * (x / h).toFloat()) to (cy - r * (y / h).toFloat())
        }
        return (cx + r * x.toFloat()) to (cy - r * y.toFloat())
    }

    fun wrapLon(lon: Double): Double {
        var x = lon % 360.0
        if (x < -180.0) x += 360.0
        if (x > 180.0) x -= 360.0
        return x
    }

    fun dLonPerPx(r: Float): Double = if (r < 1f) 0.0 else (180.0 / PI) / r
}
