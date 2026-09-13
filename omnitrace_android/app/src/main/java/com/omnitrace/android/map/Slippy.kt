package com.omnitrace.android.map

import kotlin.math.PI
import kotlin.math.atan
import kotlin.math.ln
import kotlin.math.sinh
import kotlin.math.tan

object Slippy {
    const val TILE = 256
    const val MIN_Z = 0
    const val MAX_Z = 18
    /** 全球表层：这些 zoom 的瓦片覆盖大洲，张数少。 */
    const val SURFACE_Z = 4
    const val CITY_Z = 10

    fun n(z: Int): Int = 1 shl z.coerceIn(0, MAX_Z)

    fun worldPx(zoom: Double): Double = TILE * Math.pow(2.0, zoom)

    fun lonToWorldX(lon: Double, zoom: Double): Double =
        (lon.coerceIn(-180.0, 180.0) + 180.0) / 360.0 * worldPx(zoom)

    fun latToWorldY(lat: Double, zoom: Double): Double {
        val latC = lat.coerceIn(-85.05112878, 85.05112878)
        val r = Math.toRadians(latC)
        val s = ln(tan(PI / 4.0 + r / 2.0))
        return (1.0 - s / PI) / 2.0 * worldPx(zoom)
    }

    fun worldXToLon(x: Double, zoom: Double): Double =
        x / worldPx(zoom) * 360.0 - 180.0

    fun worldYToLat(y: Double, zoom: Double): Double {
        val n = PI - 2.0 * PI * y / worldPx(zoom)
        return Math.toDegrees(atan(sinh(n)))
    }

    fun lonToTileX(lon: Double, z: Int): Int {
        val n = n(z)
        val x = kotlin.math.floor((lon.coerceIn(-180.0, 179.999999) + 180.0) / 360.0 * n).toInt()
        return x.coerceIn(0, n - 1)
    }

    fun latToTileY(lat: Double, z: Int): Int {
        val n = n(z)
        val y = kotlin.math.floor(latToWorldY(lat, z.toDouble()) / TILE).toInt()
        return y.coerceIn(0, n - 1)
    }

    fun tileCenterLatLon(z: Int, x: Int, y: Int): Pair<Double, Double> {
        val lat = worldYToLat((y + 0.5) * TILE, z.toDouble())
        val lon = worldXToLon((x + 0.5) * TILE, z.toDouble())
        return lat to lon
    }

    /** WebMercator：当前纬度、缩放下每像素大约多少米。 */
    fun metersPerPixel(lat: Double, zoom: Double): Double {
        val c = kotlin.math.cos(Math.toRadians(lat.coerceIn(-85.0, 85.0)))
        return 156543.03392 * c / Math.pow(2.0, zoom)
    }
}
