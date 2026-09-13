package com.omnitrace.android.map

import android.content.Context
import android.widget.Toast
import androidx.appcompat.app.AlertDialog

object MapDownloadUi {
    fun fmtBytes(n: Long): String {
        if (n < 1000) return "$n B"
        if (n < 1_000_000) return "${n / 1000} KB"
        return String.format("%.1f MB", n / 1_000_000.0)
    }

    fun confirm(ctx: Context, offer: PackOffer, onYes: () -> Unit, onDismiss: (() -> Unit)? = null) {
        val src = TileStore.source
        val msg = "${offer.name}\n约 ${fmtBytes(offer.bytesEst)}（${offer.tiles} 张，z${offer.zMin}–${offer.zMax}）\n来源 ${src.title} · ${src.datum}"
        AlertDialog.Builder(ctx)
            .setTitle("下载城区地图？")
            .setMessage(msg)
            .setPositiveButton("下载") { _, _ -> onYes() }
            .setNegativeButton("取消", null)
            .setOnDismissListener { onDismiss?.invoke() }
            .show()
    }

    fun toastProgress(ctx: Context, done: Int, total: Int) {
        if (done == total || done % 40 == 0) {
            Toast.makeText(ctx, "地图 $done / $total", Toast.LENGTH_SHORT).show()
        }
    }
}
