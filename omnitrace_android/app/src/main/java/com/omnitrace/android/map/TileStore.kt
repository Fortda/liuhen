package com.omnitrace.android.map

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import android.util.LruCache
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * 栅格瓦片：内存 + 磁盘。可见瓦片当场拉（像看图）；整城包仍走确认。
 */
object TileStore {
    private const val CITY_BUDGET = 80L * 1000L * 1000L
    private val io = Executors.newFixedThreadPool(8)
    private val pending = ConcurrentHashMap.newKeySet<String>()
    private val listeners = CopyOnWriteArrayList<() -> Unit>()
    private var root: File? = null
    private var sinceEvict = 0
    @Volatile var source: MapSource = MapSource.AMAP
        private set
    private val pingOnce = java.util.concurrent.atomic.AtomicBoolean(false)
    private val main = Handler(Looper.getMainLooper())
    private val mem = object : LruCache<String, Bitmap>(32 * 1024 * 1024) {
        override fun sizeOf(key: String, value: Bitmap): Int = value.byteCount
    }
    private val surface = ConcurrentHashMap<String, Bitmap>()
    private val wanted = AtomicInteger(0)
    data class Cover(val bmp: Bitmap, val srcZ: Int, val srcX: Int, val srcY: Int, val exact: Boolean)
    data class Stats(val files: Int, val bytes: Long, val surfaceBytes: Long, val cityBytes: Long)

    fun init(dir: File) {
        if (root != null) return
        dir.mkdirs()
        root = dir
        PackIndex.init(dir)
    }

    fun addWanted() {
        if (wanted.getAndIncrement() == 0) warmLow()
    }

    fun removeWanted() {
        wanted.updateAndGet { n -> (n - 1).coerceAtLeast(0) }
    }

    fun setSource(src: MapSource) {
        if (source == src) return
        source = src
        TileHttp.resetPin()
        mem.evictAll()
        surface.clear()
        ping()
        if (wanted.get() > 0) warmLow()
    }

    fun addListener(fn: () -> Unit) {
        listeners.add(fn)
    }

    fun removeListener(fn: () -> Unit) {
        listeners.remove(fn)
    }

    fun peek(z: Int, x: Int, y: Int): Bitmap? {
        val k = key(z, x, y)
        return mem.get(k) ?: surface[k]
    }

    fun cover(z: Int, x: Int, y: Int): Cover? {
        val n = Slippy.n(z)
        val xx = ((x % n) + n) % n
        val yy = y
        if (yy < 0 || yy >= n) return null
        peek(z, xx, yy)?.let { return Cover(it, z, xx, yy, true) }
        var pz = z
        var px = xx
        var py = yy
        while (pz > 0) {
            pz--
            px /= 2
            py /= 2
            peek(pz, px, py)?.let { return Cover(it, pz, px, py, false) }
        }
        return null
    }

    fun request(z: Int, x: Int, y: Int) {
        val zz = z.coerceIn(0, Slippy.MAX_Z)
        val n = Slippy.n(zz)
        val xx = ((x % n) + n) % n
        val yy = y
        if (yy < 0 || yy >= n) return
        val k = key(zz, xx, yy)
        if (peek(zz, xx, yy) != null) return
        if (wanted.get() <= 0) return
        val dir = root ?: return
        if (!pending.add(k)) return
        io.execute {
            try {
                val f = file(dir, zz, xx, yy)
                var bmp: Bitmap? = null
                if (f.isFile && f.length() > 32) {
                    bmp = BitmapFactory.decodeFile(f.absolutePath, opts())
                }
                if (bmp == null) {
                    val bytes = TileHttp.fetch(source.urls(zz, xx, yy))
                    if (bytes != null) {
                        bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts())
                        if (bmp != null) {
                            remember(zz, k, bmp)
                            ping()
                            writeQuiet(f, bytes)
                            if (zz > Slippy.SURFACE_Z && ++sinceEvict >= 24) {
                                sinceEvict = 0
                                evictCity(dir)
                            }
                            return@execute
                        }
                    }
                }
                if (bmp != null) remember(zz, k, bmp)
            } catch (_: Exception) {
            } finally {
                pending.remove(k)
                ping()
            }
        }
    }

    fun downloadSurface(onProgress: (done: Int, total: Int) -> Unit, onDone: (ok: Int, total: Int) -> Unit) {
        val jobs = ArrayList<IntArray>()
        for (z in 0..Slippy.SURFACE_Z) {
            val n = Slippy.n(z)
            for (y in 0 until n) for (x in 0 until n) jobs.add(intArrayOf(z, x, y))
        }
        runJobs(jobs, onProgress, onDone)
    }

    fun downloadOfferMeasured(
        offer: PackOffer,
        onProgress: (done: Int, total: Int) -> Unit,
        onDone: (ok: Int, total: Int, bytes: Long) -> Unit,
    ) {
        val dir = root ?: return
        val jobs = ArrayList<IntArray>()
        for (z in offer.zMin..offer.zMax) {
            val x0 = Slippy.lonToTileX(offer.west, z)
            val x1 = Slippy.lonToTileX(offer.east, z)
            val y0 = Slippy.latToTileY(offer.north, z)
            val y1 = Slippy.latToTileY(offer.south, z)
            for (y in y0..y1) for (x in x0..x1) jobs.add(intArrayOf(z, x, y))
        }
        if (jobs.isEmpty()) {
            onDone(0, 0, 0)
            return
        }
        val total = jobs.size
        val done = AtomicInteger(0)
        val ok = AtomicInteger(0)
        val bytes = AtomicLong(0)
        jobs.forEach { t ->
            io.execute {
                val z = t[0]
                val x = t[1]
                val y = t[2]
                val f = file(dir, z, x, y)
                var good = f.isFile && f.length() > 32
                if (!good) {
                    val raw = TileHttp.fetch(source.urls(z, x, y))
                    if (raw != null) {
                        writeQuiet(f, raw)
                        good = f.isFile && f.length() > 32
                    }
                }
                if (good) {
                    bytes.addAndGet(f.length())
                    BitmapFactory.decodeFile(f.absolutePath, opts())?.let { remember(z, key(z, x, y), it) }
                    ok.incrementAndGet()
                }
                val d = done.incrementAndGet()
                onProgress(d, total)
                if (d >= total) {
                    PackIndex.add(offer, source, bytes.get(), ok.get())
                    ping()
                    onDone(ok.get(), total, bytes.get())
                }
            }
        }
    }

    private fun runJobs(
        jobs: List<IntArray>,
        onProgress: (done: Int, total: Int) -> Unit,
        onDone: (ok: Int, total: Int) -> Unit,
    ) {
        val dir = root ?: return
        val total = jobs.size.coerceAtLeast(1)
        val done = AtomicInteger(0)
        val ok = AtomicInteger(0)
        jobs.forEach { t ->
            io.execute {
                val z = t[0]
                val x = t[1]
                val y = t[2]
                val f = file(dir, z, x, y)
                var good = f.isFile && f.length() > 32
                if (!good) {
                    val raw = TileHttp.fetch(source.urls(z, x, y))
                    if (raw != null) {
                        writeQuiet(f, raw)
                        good = f.isFile && f.length() > 32
                    }
                }
                if (good) {
                    BitmapFactory.decodeFile(f.absolutePath, opts())?.let { remember(z, key(z, x, y), it) }
                    ok.incrementAndGet()
                }
                val d = done.incrementAndGet()
                onProgress(d, total)
                if (d >= total) onDone(ok.get(), total)
            }
        }
    }

    fun deletePack(pack: CityPack) {
        val dir = root ?: return
        for (z in pack.zMin..pack.zMax) {
            val x0 = Slippy.lonToTileX(pack.west, z)
            val x1 = Slippy.lonToTileX(pack.east, z)
            val y0 = Slippy.latToTileY(pack.north, z)
            val y1 = Slippy.latToTileY(pack.south, z)
            for (y in y0..y1) for (x in x0..x1) {
                file(dir, z, x, y).delete()
                mem.remove(key(z, x, y))
            }
        }
        PackIndex.remove(pack.id, pack.source)
        ping()
    }

    fun clearCity() {
        val dir = root ?: return
        dir.walkTopDown().forEach { f ->
            if (!f.isFile || !f.name.endsWith(".png")) return@forEach
            val z = zOf(f) ?: return@forEach
            if (z > Slippy.SURFACE_Z) f.delete()
        }
        PackIndex.clear()
        mem.evictAll()
        ping()
    }

    fun clearAll() {
        val dir = root ?: return
        dir.deleteRecursively()
        dir.mkdirs()
        PackIndex.clear()
        mem.evictAll()
        surface.clear()
        ping()
        if (wanted.get() > 0) warmLow()
    }

    fun stats(): Stats {
        val dir = root ?: return Stats(0, 0, 0, 0)
        var files = 0
        var bytes = 0L
        var surface = 0L
        var city = 0L
        dir.walkTopDown().forEach { f ->
            if (!f.isFile || !f.name.endsWith(".png")) return@forEach
            files++
            bytes += f.length()
            val z = zOf(f) ?: return@forEach
            if (z <= Slippy.SURFACE_Z) surface += f.length() else city += f.length()
        }
        return Stats(files, bytes, surface, city)
    }

    private fun zOf(f: File): Int? {
        val parent = f.parentFile?.parentFile?.name?.toIntOrNull()
        if (parent != null) return parent
        return f.parentFile?.parentFile?.parentFile?.name?.toIntOrNull()
    }

    private fun warmLow() {
        for (z in 0..2) {
            val n = Slippy.n(z)
            for (y in 0 until n) for (x in 0 until n) request(z, x, y)
        }
    }

    private fun remember(z: Int, k: String, bmp: Bitmap) {
        mem.put(k, bmp)
        if (z <= 2) surface[k] = bmp
    }

    private fun opts() = BitmapFactory.Options().apply {
        inPreferredConfig = Bitmap.Config.RGB_565
    }

    private fun writeQuiet(dest: File, bytes: ByteArray) {
        try {
            dest.parentFile?.mkdirs()
            val tmp = File(dest.absolutePath + ".part")
            tmp.writeBytes(bytes)
            dest.delete()
            tmp.renameTo(dest)
        } catch (_: Exception) {
        }
    }

    private fun evictCity(dir: File) {
        val city = ArrayList<File>()
        var cityBytes = 0L
        dir.walkTopDown().forEach { f ->
            if (!f.isFile || !f.name.endsWith(".png")) return@forEach
            val z = zOf(f) ?: return@forEach
            if (z <= Slippy.SURFACE_Z) return@forEach
            val x = f.parentFile?.name?.toIntOrNull() ?: return@forEach
            val y = f.name.removeSuffix(".png").toIntOrNull() ?: return@forEach
            if (PackIndex.forSource(source).any { it.containsTile(z, x, y) }) return@forEach
            city.add(f)
            cityBytes += f.length()
        }
        if (cityBytes <= CITY_BUDGET) return
        city.sortBy { it.lastModified() }
        var extra = cityBytes - CITY_BUDGET
        for (f in city) {
            if (extra <= 0) break
            val n = f.length()
            if (f.delete()) extra -= n
        }
    }

    private fun ping() {
        if (!pingOnce.compareAndSet(false, true)) return
        main.post {
            pingOnce.set(false)
            listeners.forEach {
                try {
                    it()
                } catch (_: Exception) {
                }
            }
        }
    }

    private fun file(dir: File, z: Int, x: Int, y: Int): File {
        val nested = File(dir, "${source.id}/$z/$x/$y.png")
        if (nested.isFile) return nested
        if (source == MapSource.CARTO) {
            val old = File(dir, "$z/$x/$y.png")
            if (old.isFile) return old
        }
        return nested
    }

    private fun key(z: Int, x: Int, y: Int) = "${source.id}/$z/$x/$y"
}
