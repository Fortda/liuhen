package com.omnitrace.android.ui

import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.fragment.app.Fragment
import com.omnitrace.android.MainActivity
import com.omnitrace.android.R
import com.omnitrace.android.databinding.FragmentDataSettingsBinding
import com.omnitrace.android.export.ExportHelper
import com.omnitrace.android.host.OmniPaths
import com.omnitrace.android.sync.PcLinkPrefs
import com.omnitrace.android.sync.PcSyncHelper
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

class DataSettingsFragment : Fragment() {
    private var binding: FragmentDataSettingsBinding? = null
    private val handler = Handler(Looper.getMainLooper())
    private val sizeIo = Executors.newSingleThreadExecutor()
    private val syncIo = Executors.newSingleThreadExecutor()
    private val dayFmt = SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.getDefault())
    private var sizeAt = 0L

    private val treeLauncher = registerForActivityResult(
        ActivityResultContracts.OpenDocumentTree(),
    ) { uri ->
        if (uri == null) return@registerForActivityResult
        val act = activity ?: return@registerForActivityResult
        try {
            act.contentResolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION,
            )
        } catch (_: Exception) {
        }
        val msg = try {
            ExportHelper.copyToTree(act, uri)
        } catch (e: Exception) {
            "export_failed: ${e.message}"
        }
        Toast.makeText(act, msg, Toast.LENGTH_LONG).show()
        sizeAt = 0L
        refreshSize(force = true)
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        val b = FragmentDataSettingsBinding.inflate(inflater, container, false)
        binding = b
        return b.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        val b = binding ?: return
        val ctx = requireContext()
        (activity as? MainActivity)?.fitScroll(b.root)
        b.head.txtSubTitle.text = getString(R.string.set_page_data)
        b.head.btnBack.setOnClickListener { parentFragmentManager.popBackStack() }
        b.btnExport.setOnClickListener { treeLauncher.launch(null) }
        PcLinkPrefs.host(ctx)?.let { b.edtPcIp.setText(it) }
        paintPcSync()
        b.btnPcSync.setOnClickListener {
            val host = b.edtPcIp.text?.toString()?.trim() ?: ""
            if (host.isEmpty()) {
                Toast.makeText(ctx, "no_host", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            PcLinkPrefs.setHost(ctx, host)
            syncIo.execute {
                val msg = PcSyncHelper.syncRecent(ctx.applicationContext)
                handler.post {
                    Toast.makeText(ctx, msg, Toast.LENGTH_LONG).show()
                    paintPcSync()
                }
            }
        }
        b.txtPath.text = OmniPaths.dataRoot(ctx).absolutePath
        b.txtAdb.text = ExportHelper.adbHint(ctx)
        ExportHelper.peekBreakdown(ctx)?.let { paintParts(it) }
        refreshSize(force = true)
    }

    override fun onResume() {
        super.onResume()
        if (!isHidden) refreshSize(force = false)
    }

    override fun onDestroyView() {
        binding = null
        super.onDestroyView()
    }

    private fun paintPcSync() {
        val b = binding ?: return
        val ctx = context ?: return
        val last = PcLinkPrefs.lastSync(ctx)
        b.txtPcLastSync.text = if (last > 0L) {
            getString(R.string.set_pc_last_sync, dayFmt.format(Date(last)))
        } else {
            getString(R.string.set_pc_never_sync)
        }
    }

    private fun refreshSize(force: Boolean = false) {
        val ctx = context?.applicationContext ?: return
        val now = SystemClock.uptimeMillis()
        if (!force && now - sizeAt < 12_000L && (binding?.listSizes?.childCount ?: 0) > 0) return
        sizeAt = now
        sizeIo.execute {
            val parts = try {
                ExportHelper.breakdown(ctx)
            } catch (_: Exception) {
                return@execute
            }
            handler.post { paintParts(parts) }
        }
    }

    private fun paintParts(parts: List<com.omnitrace.android.export.SizePart>) {
        val box = binding?.listSizes ?: return
        box.removeAllViews()
        for (p in parts) {
            if (p.id == "map_tiles" || p.id == "tiles") continue
            val (txt, actions) = SettingsUi.row(box, p.label)
            if (p.id == "total") txt.setTypeface(txt.typeface, android.graphics.Typeface.BOLD)
            actions.addView(SettingsUi.value(box.context, ExportHelper.fmtMb(p.bytes)))
        }
    }
}
