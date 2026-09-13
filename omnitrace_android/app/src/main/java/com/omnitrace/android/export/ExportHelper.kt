package com.omnitrace.android.export

import android.content.Context
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import com.omnitrace.android.RecordService
import com.omnitrace.android.host.CaptureCatalog
import com.omnitrace.android.host.OmniPaths
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

data class SizePart(val id: String, val label: String, val bytes: Long)

/** 把本机 OmniDatabase 拷到用户选的目录下 `sources/<device_id>/`。 */
object ExportHelper {
    fun copyToTree(ctx: Context, treeUri: Uri): String {
        val root = OmniPaths.dataRoot(ctx)
        if (!root.exists()) return "no_data"
        val deviceId = OmniPaths.sourceId(ctx)
        val tree = DocumentFile.fromTreeUri(ctx, treeUri) ?: return "bad_tree"
        val sources = tree.findFile("sources") ?: tree.createDirectory("sources")
            ?: return "mkdir_sources_failed"
        val dest = sources.findFile(deviceId) ?: sources.createDirectory(deviceId)
            ?: return "mkdir_device_failed"
        var files = 0
        var bytes = 0L
        copyDir(ctx, root, dest) { n, b ->
            files += n
            bytes += b
        }
        return "ok files=$files bytes=$bytes dest=sources/$deviceId"
    }

    fun dataSize(ctx: Context): Long = dirSize(OmniPaths.dataRoot(ctx))

    fun fmtMb(bytes: Long): String = String.format("%.1f MB", bytes / 1_000_000.0)

    @Volatile
    var lastBreakdown: List<SizePart>? = null
        private set

    fun peekBreakdown(ctx: Context): List<SizePart>? {
        lastBreakdown?.let { mem ->
            val cleaned = mem.filter { it.id != "map_tiles" && it.id != "tiles" }
            return cleaned.takeIf { it.isNotEmpty() }
        }
        val raw = ctx.getSharedPreferences(RecordService.PREFS, Context.MODE_PRIVATE)
            .getString(KEY_BREAKDOWN, null) ?: return null
        val parsed = parseBreakdown(raw)?.filter { it.id != "map_tiles" && it.id != "tiles" }
        if (parsed.isNullOrEmpty()) return null
        lastBreakdown = parsed
        return parsed
    }

    fun breakdown(ctx: Context): List<SizePart> {
        val root = OmniPaths.dataRoot(ctx)
        val tiles = File(root, "cache/map_tiles")
        val out = ArrayList<SizePart>()
        fun add(id: String, label: String, f: File) {
            out.add(SizePart(id, label, dirSize(f, tiles)))
        }
        add("imu", "IMU", File(root, "EventData"))
        for (m in CaptureCatalog.modules) {
            add(m.id, m.label, OmniPaths.moduleRoot(root, m.id))
        }
        val cacheOther = dirSize(File(root, "cache"), tiles)
        if (cacheOther > 0L) out.add(SizePart("cache_other", "其它缓存", cacheOther))
        add("control", "控制面", File(root, "control"))
        val accounted = out.sumOf { it.bytes }
        val total = dirSize(root, tiles)
        val rest = (total - accounted).coerceAtLeast(0L)
        if (rest > 1024L) out.add(SizePart("other", "其它", rest))
        val ranked = out.sortedByDescending { it.bytes }.toMutableList()
        ranked.add(0, SizePart("total", "合计", total))
        remember(ctx, ranked)
        return ranked
    }

    private fun remember(ctx: Context, parts: List<SizePart>) {
        lastBreakdown = parts
        val arr = JSONArray()
        for (p in parts) {
            arr.put(
                JSONObject()
                    .put("id", p.id)
                    .put("label", p.label)
                    .put("bytes", p.bytes),
            )
        }
        ctx.getSharedPreferences(RecordService.PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_BREAKDOWN, arr.toString())
            .apply()
    }

    private fun parseBreakdown(raw: String): List<SizePart>? {
        return try {
            val arr = JSONArray(raw)
            val out = ArrayList<SizePart>(arr.length())
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                out.add(SizePart(o.optString("id"), o.optString("label"), o.optLong("bytes")))
            }
            if (out.isEmpty()) null else out
        } catch (_: Exception) {
            null
        }
    }

    private const val KEY_BREAKDOWN = "size_breakdown_v3"

    fun adbHint(ctx: Context): String {
        val p = OmniPaths.dataRoot(ctx).absolutePath
        val id = OmniPaths.sourceId(ctx)
        return "adb pull \"$p\" \"./OmniDatabase/sources/$id\""
    }

    private fun dirSize(f: File, skip: File? = null): Long {
        if (!f.exists()) return 0
        if (skip != null && f.absolutePath == skip.absolutePath) return 0
        if (f.isFile) return f.length()
        return f.listFiles()?.sumOf { dirSize(it, skip) } ?: 0
    }

    private fun copyDir(ctx: Context, src: File, dest: DocumentFile, acc: (Int, Long) -> Unit) {
        val children = src.listFiles() ?: return
        for (c in children) {
            if (c.isDirectory) {
                val sub = dest.findFile(c.name) ?: dest.createDirectory(c.name) ?: continue
                copyDir(ctx, c, sub, acc)
            } else {
                val mime = if (c.name.endsWith(".json") || c.name.endsWith(".jsonl")) {
                    "application/json"
                } else {
                    "application/octet-stream"
                }
                dest.findFile(c.name)?.delete()
                val outFile = dest.createFile(mime, c.name) ?: continue
                ctx.contentResolver.openOutputStream(outFile.uri)?.use { out ->
                    c.inputStream().use { it.copyTo(out) }
                }
                acc(1, c.length())
            }
        }
    }
}
