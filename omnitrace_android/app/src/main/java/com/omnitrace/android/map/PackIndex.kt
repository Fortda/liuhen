package com.omnitrace.android.map

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

data class CityPack(
    val id: String,
    val name: String,
    val south: Double,
    val west: Double,
    val north: Double,
    val east: Double,
    val zMin: Int,
    val zMax: Int,
    val source: String,
    var bytes: Long,
    var files: Int,
) {
    fun contains(lat: Double, lon: Double): Boolean =
        lat in south..north && lon in west..east

    fun containsTile(z: Int, x: Int, y: Int): Boolean {
        if (z < zMin || z > zMax) return false
        val (lat, lon) = Slippy.tileCenterLatLon(z, x, y)
        return contains(lat, lon)
    }
}

object PackIndex {
    private var file: File? = null
    private val packs = ArrayList<CityPack>()

    fun init(dir: File) {
        file = File(dir, "packs.json")
        load()
    }

    fun all(): List<CityPack> = synchronized(packs) { packs.toList() }

    fun forSource(src: MapSource): List<CityPack> =
        synchronized(packs) { packs.filter { it.source == src.id } }

    fun allows(src: MapSource, z: Int, x: Int, y: Int): Boolean {
        if (z < Slippy.CITY_Z) return true
        synchronized(packs) {
            return packs.any { it.source == src.id && it.containsTile(z, x, y) }
        }
    }

    fun coversPoint(src: MapSource, lat: Double, lon: Double): Boolean {
        synchronized(packs) {
            return packs.any { it.source == src.id && it.contains(lat, lon) }
        }
    }

    fun add(offer: PackOffer, src: MapSource, bytes: Long, files: Int) {
        synchronized(packs) {
            packs.removeAll { it.id == offer.id && it.source == src.id }
            packs.add(
                CityPack(
                    offer.id, offer.name, offer.south, offer.west, offer.north, offer.east,
                    offer.zMin, offer.zMax, src.id, bytes, files,
                ),
            )
        }
        save()
    }

    fun remove(id: String, source: String) {
        synchronized(packs) { packs.removeAll { it.id == id && it.source == source } }
        save()
    }

    fun clear() {
        synchronized(packs) { packs.clear() }
        save()
    }

    private fun load() {
        val f = file ?: return
        if (!f.isFile) return
        try {
            val arr = JSONObject(f.readText(Charsets.UTF_8)).optJSONArray("packs") ?: JSONArray()
            synchronized(packs) {
                packs.clear()
                for (i in 0 until arr.length()) {
                    val o = arr.optJSONObject(i) ?: continue
                    packs.add(
                        CityPack(
                            id = o.optString("id"),
                            name = o.optString("name"),
                            south = o.optDouble("south"),
                            west = o.optDouble("west"),
                            north = o.optDouble("north"),
                            east = o.optDouble("east"),
                            zMin = o.optInt("zMin", Slippy.CITY_Z),
                            zMax = o.optInt("zMax", 14),
                            source = o.optString("source", MapSource.CARTO.id),
                            bytes = o.optLong("bytes"),
                            files = o.optInt("files"),
                        ),
                    )
                }
            }
        } catch (_: Exception) {
        }
    }

    private fun save() {
        val f = file ?: return
        val arr = JSONArray()
        synchronized(packs) {
            for (p in packs) {
                arr.put(
                    JSONObject()
                        .put("id", p.id)
                        .put("name", p.name)
                        .put("south", p.south)
                        .put("west", p.west)
                        .put("north", p.north)
                        .put("east", p.east)
                        .put("zMin", p.zMin)
                        .put("zMax", p.zMax)
                        .put("source", p.source)
                        .put("bytes", p.bytes)
                        .put("files", p.files),
                )
            }
        }
        f.writeText(JSONObject().put("packs", arr).toString(), Charsets.UTF_8)
    }
}
