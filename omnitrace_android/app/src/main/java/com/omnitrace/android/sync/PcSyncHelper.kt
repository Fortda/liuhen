package com.omnitrace.android.sync

import android.content.Context
import com.omnitrace.android.dash.DashCaliber
import com.omnitrace.android.dash.DashIo
import com.omnitrace.android.host.OmniPaths
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

object PcSyncHelper {
    fun syncRecent(ctx: Context, days: Int = DashCaliber.GPS_SAMPLE_DAYS): String {
        val raw = PcLinkPrefs.host(ctx) ?: return "未填写电脑 IP（可写 IP 或 IP:端口）"
        return when (val ping = PcSyncClient.ping(raw)) {
            is PcSyncClient.PingResult.Err -> when (ping.code) {
                "bad_host" -> "地址格式不对"
                "connect_refused" -> "连不上：检查 OmniPlayer 是否开着、防火墙是否放行端口、IP 是否正确"
                "timeout" -> "超时：同一局域网？端口是否被占？"
                "unknown_host" -> "主机名无法解析"
                "cleartext_blocked" -> "系统禁止明文 HTTP（需允许 cleartext）"
                else -> "ping 失败：${ping.code} ${ping.detail}".trim()
            }
            is PcSyncClient.PingResult.Ok -> {
                val ep = ping.endpoint
                PcLinkPrefs.setHost(ctx, "${ep.host}:${ep.port}")
                val hostname = ping.json.optString("hostname", ep.host)
                val root = OmniPaths.dataRoot(ctx)
                val hostDir = OmniPaths.linkedPcHostDir(root, hostname)
                val histDir = OmniPaths.linkedPcInputHistDir(root, hostname)
                val fmt = SimpleDateFormat("yyyy-MM-dd", Locale.US)
                val today0 = DashIo.startOfLocalDay(System.currentTimeMillis())
                var ok = 0
                var noHist = 0
                var fail = 0
                for (i in 0 until days) {
                    val dayStart = DashIo.addLocalDays(today0, -i)
                    val date = fmt.format(Date(dayStart))
                    val dest = File(histDir, "$date.otih")
                    when (val r = PcSyncClient.fetchInputHist(ep, date, dest)) {
                        PcSyncClient.FetchResult.Ok -> ok++
                        is PcSyncClient.FetchResult.Err -> when (r.code) {
                            "no_hist", "empty" -> noHist++
                            else -> fail++
                        }
                    }
                }
                PcLinkPrefs.setHostname(ctx, hostname)
                PcLinkPrefs.setLastSync(ctx, System.currentTimeMillis())
                "ok ${ep.host}:${ep.port} host=$hostname files=$ok no_data=$noHist fail=$fail dir=${hostDir.name}"
            }
        }
    }
}
