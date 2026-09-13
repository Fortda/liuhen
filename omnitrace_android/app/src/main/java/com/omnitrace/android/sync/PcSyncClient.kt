package com.omnitrace.android.sync

import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.net.ConnectException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import java.util.concurrent.TimeUnit

data class SyncEndpoint(val host: String, val port: Int) {
    fun base(): String = "http://$host:$port"
}

object PcSyncClient {
    private const val DEFAULT_PORT = 3180
    private val http = OkHttpClient.Builder()
        .connectTimeout(8, TimeUnit.SECONDS)
        .readTimeout(120, TimeUnit.SECONDS)
        .build()

    /** 支持 `192.168.1.10` 或 `192.168.1.10:3181` */
    fun parseEndpoint(raw: String): SyncEndpoint? {
        val s = raw.trim()
        if (s.isEmpty()) return null
        val host: String
        val port: Int
        if (s.contains(":")) {
            val i = s.lastIndexOf(':')
            host = s.substring(0, i).trim()
            port = s.substring(i + 1).trim().toIntOrNull() ?: return null
        } else {
            host = s
            port = DEFAULT_PORT
        }
        if (host.isEmpty() || port !in 1..65535) return null
        return SyncEndpoint(host, port)
    }

    sealed class PingResult {
        data class Ok(val json: JSONObject, val endpoint: SyncEndpoint) : PingResult()
        data class Err(val code: String, val detail: String = "") : PingResult()
    }

    fun ping(rawHost: String): PingResult {
        val ep = parseEndpoint(rawHost) ?: return PingResult.Err("bad_host")
        val url = "${ep.base()}/api/omni/ping"
        return try {
            http.newCall(Request.Builder().url(url).get().build()).execute().use { resp ->
                if (!resp.isSuccessful) {
                    return PingResult.Err("http_${resp.code}", "ping")
                }
                val body = resp.body?.string() ?: return PingResult.Err("empty_body")
                val json = JSONObject(body)
                // 服务端可能协商了别的端口：若不同再试一次
                val reported = json.optInt("port", ep.port)
                if (reported != ep.port && reported in 1..65535) {
                    val ep2 = SyncEndpoint(ep.host, reported)
                    return pingEndpoint(ep2) ?: PingResult.Ok(json, ep)
                }
                PingResult.Ok(json, ep)
            }
        } catch (e: ConnectException) {
            PingResult.Err("connect_refused", e.message ?: "")
        } catch (e: SocketTimeoutException) {
            PingResult.Err("timeout", e.message ?: "")
        } catch (e: UnknownHostException) {
            PingResult.Err("unknown_host", e.message ?: "")
        } catch (e: IOException) {
            val msg = e.message ?: ""
            if (msg.contains("CLEARTEXT", ignoreCase = true)) {
                PingResult.Err("cleartext_blocked", msg)
            } else {
                PingResult.Err("io", msg)
            }
        } catch (e: Exception) {
            PingResult.Err("error", e.message ?: "")
        }
    }

    private fun pingEndpoint(ep: SyncEndpoint): PingResult.Ok? {
        val url = "${ep.base()}/api/omni/ping"
        return try {
            http.newCall(Request.Builder().url(url).get().build()).execute().use { resp ->
                if (!resp.isSuccessful) return null
                val body = resp.body?.string() ?: return null
                PingResult.Ok(JSONObject(body), ep)
            }
        } catch (_: Exception) {
            null
        }
    }

    sealed class FetchResult {
        object Ok : FetchResult()
        data class Err(val code: String) : FetchResult()
    }

    fun fetchInputHist(ep: SyncEndpoint, date: String, dest: File): FetchResult {
        val url = "${ep.base()}/api/omni/input_hist/$date"
        return try {
            http.newCall(Request.Builder().url(url).get().build()).execute().use { resp ->
                when {
                    resp.code == 404 -> FetchResult.Err("no_hist")
                    !resp.isSuccessful -> FetchResult.Err("http_${resp.code}")
                    else -> {
                        val body = resp.body?.bytes() ?: return FetchResult.Err("empty")
                        if (body.isEmpty()) return FetchResult.Err("empty")
                        dest.parentFile?.mkdirs()
                        dest.writeBytes(body)
                        FetchResult.Ok
                    }
                }
            }
        } catch (e: IOException) {
            FetchResult.Err(if (e.message?.contains("CLEARTEXT", true) == true) "cleartext_blocked" else "io")
        } catch (_: Exception) {
            FetchResult.Err("error")
        }
    }
}
