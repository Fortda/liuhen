package com.omnitrace.android.ui

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import com.omnitrace.android.R
import com.omnitrace.android.databinding.FragmentMapSettingsBinding
import com.omnitrace.android.host.OmniPaths
import com.omnitrace.android.map.CityCatalog
import com.omnitrace.android.map.CityDef
import com.omnitrace.android.map.MapDownloadUi
import com.omnitrace.android.map.MapPrefs
import com.omnitrace.android.map.MapSource
import com.omnitrace.android.map.PackIndex
import com.omnitrace.android.map.PackOffer
import com.omnitrace.android.map.TileStore
import org.json.JSONArray
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.util.concurrent.Executors

class MapSettingsFragment : Fragment() {
    private var binding: FragmentMapSettingsBinding? = null
    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private var busy = false

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        val b = FragmentMapSettingsBinding.inflate(inflater, container, false)
        binding = b
        TileStore.init(File(OmniPaths.dataRoot(requireContext()), "cache/map_tiles"))
        b.head.txtSubTitle.text = getString(R.string.set_page_map)
        b.head.btnBack.setOnClickListener { parentFragmentManager.popBackStack() }
        val srcIdx = when (TileStore.source) {
            MapSource.AMAP -> 0
            MapSource.OSM -> 1
            else -> 2
        }
        SettingsUi.bindExclusive(listOf(b.rbAmap, b.rbOsm, b.rbCarto), srcIdx) { i ->
            val src = when (i) {
                1 -> MapSource.OSM
                2 -> MapSource.CARTO
                else -> MapSource.AMAP
            }
            MapPrefs.setSource(requireContext(), src)
            paintDatum()
            paintPacks()
        }
        paintDatum()
        b.btnMapSurface.setOnClickListener { downloadSurface() }
        b.btnMapClearCity.setOnClickListener {
            TileStore.clearCity()
            refreshCache()
            paintPacks()
        }
        b.btnMapClearAll.setOnClickListener {
            TileStore.clearAll()
            refreshCache()
            paintPacks()
        }
        b.btnMapSearch.setOnClickListener { runSearch() }
        (activity as? com.omnitrace.android.MainActivity)?.fitScroll(b.root)
        b.txtMapCache.text = getString(R.string.map_cache_loading)
        b.root.post { loadLists() }
        return b.root
    }

    private fun loadLists() {
        paintCities(CityCatalog.all)
        paintPacks()
        io.execute {
            val s = try {
                TileStore.stats()
            } catch (_: Exception) {
                return@execute
            }
            main.post {
                val b = binding ?: return@post
                b.txtMapCache.text = getString(
                    R.string.map_cache_fmt,
                    s.surfaceBytes / 1_000_000.0,
                    s.cityBytes / 1_000_000.0,
                    s.files,
                )
            }
        }
    }

    override fun onDestroyView() {
        binding = null
        super.onDestroyView()
    }

    private fun paintDatum() {
        val b = binding ?: return
        val s = TileStore.source
        b.txtMapDatum.text = "${s.datum} · ${s.datumNote}"
    }

    private fun refreshCache() {
        io.execute {
            val s = try {
                TileStore.stats()
            } catch (_: Exception) {
                return@execute
            }
            main.post {
                val b = binding ?: return@post
                b.txtMapCache.text = getString(
                    R.string.map_cache_fmt,
                    s.surfaceBytes / 1_000_000.0,
                    s.cityBytes / 1_000_000.0,
                    s.files,
                )
            }
        }
    }

    private fun paintPacks() {
        val b = binding ?: return
        val ctx = context ?: return
        val box = b.listPacks
        box.removeAllViews()
        val packs = PackIndex.forSource(TileStore.source)
        if (packs.isEmpty()) {
            box.addView(muted(getString(R.string.map_packs_empty)))
            return
        }
        for (p in packs) {
            val (_, actions) = SettingsUi.row(
                box,
                "${p.name}  ${MapDownloadUi.fmtBytes(p.bytes)}  ${p.files} 张",
            )
            actions.addView(
                SettingsUi.action(ctx, getString(R.string.map_pack_delete)) {
                    TileStore.deletePack(p)
                    refreshCache()
                    paintPacks()
                },
            )
        }
    }

    private fun paintCities(rows: List<CityDef>) {
        val b = binding ?: return
        val ctx = context ?: return
        val box = b.listCities
        box.removeAllViews()
        if (rows.isEmpty()) {
            box.addView(muted(getString(R.string.map_search_empty)))
            return
        }
        for (c in rows.take(24)) {
            val offer = c.offer(TileStore.source)
            val (_, actions) = SettingsUi.row(
                box,
                "${c.name}  约 ${MapDownloadUi.fmtBytes(offer.bytesEst)}",
            )
            actions.addView(
                SettingsUi.action(ctx, getString(R.string.set_download)) { askDownload(offer) },
            )
        }
    }

    private fun runSearch() {
        val q = binding?.edtMapSearch?.text?.toString().orEmpty()
        val local = CityCatalog.search(q)
        if (q.trim().length < 2) {
            paintCities(if (q.isBlank()) CityCatalog.all else local)
            return
        }
        paintCities(local)
        io.execute {
            val extra = nominatim(q)
            main.post {
                if (!isAdded) return@post
                paintCities(local + extra.filter { e -> local.none { it.id == e.id } })
            }
        }
    }

    private fun nominatim(q: String): List<CityDef> {
        return try {
            val spec = "https://nominatim.openstreetmap.org/search?format=json&limit=6&q=" +
                URLEncoder.encode(q, "UTF-8")
            val conn = URL(spec).openConnection() as HttpURLConnection
            conn.connectTimeout = 5000
            conn.readTimeout = 7000
            conn.setRequestProperty("User-Agent", "OmniTrace/0.1 (personal sideload)")
            val body = conn.inputStream.bufferedReader().readText()
            conn.disconnect()
            val arr = JSONArray(body)
            val out = ArrayList<CityDef>()
            for (i in 0 until arr.length()) {
                val o = arr.optJSONObject(i) ?: continue
                val bb = o.optJSONArray("boundingbox") ?: continue
                if (bb.length() < 4) continue
                out.add(
                    CityDef(
                        id = "nom_${o.optString("place_id")}",
                        name = o.optString("display_name").substringBefore(',').ifBlank { q },
                        south = bb.optString(0).toDoubleOrNull() ?: continue,
                        north = bb.optString(1).toDoubleOrNull() ?: continue,
                        west = bb.optString(2).toDoubleOrNull() ?: continue,
                        east = bb.optString(3).toDoubleOrNull() ?: continue,
                    ),
                )
            }
            out
        } catch (_: Exception) {
            emptyList()
        }
    }

    private fun askDownload(offer: PackOffer) {
        val ctx = context ?: return
        MapDownloadUi.confirm(ctx, offer, onYes = { startOffer(offer) })
    }

    private fun startOffer(offer: PackOffer) {
        if (busy) return
        busy = true
        binding?.txtMapProgress?.text = getString(R.string.map_progress_fmt, 0, offer.tiles)
        TileStore.downloadOfferMeasured(offer, { d, t ->
            main.post { binding?.txtMapProgress?.text = getString(R.string.map_progress_fmt, d, t) }
        }, { ok, total, _ ->
            main.post {
                busy = false
                binding?.txtMapProgress?.text = getString(R.string.map_progress_fmt, ok, total)
                refreshCache()
                paintPacks()
                Toast.makeText(context, "${offer.name} 已下载 $ok / $total", Toast.LENGTH_SHORT).show()
            }
        })
    }

    private fun downloadSurface() {
        if (busy) return
        busy = true
        TileStore.downloadSurface({ d, t ->
            main.post { binding?.txtMapProgress?.text = getString(R.string.map_progress_fmt, d, t) }
        }, { ok, total ->
            main.post {
                busy = false
                binding?.txtMapProgress?.text = getString(R.string.map_progress_fmt, ok, total)
                refreshCache()
            }
        })
    }

    private fun muted(s: String): TextView {
        val t = TextView(requireContext())
        t.setTextColor(ContextCompat.getColor(requireContext(), R.color.muted))
        t.textSize = 13f
        t.text = s
        val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
        lp.bottomMargin = 8
        t.layoutParams = lp
        return t
    }
}
