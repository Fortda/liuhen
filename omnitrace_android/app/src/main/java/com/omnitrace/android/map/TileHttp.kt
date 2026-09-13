package com.omnitrace.android.map

import okhttp3.ConnectionPool
import okhttp3.Dispatcher
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/**
 * 成熟地图同一套：连接池复用 TLS、短超时、记住能通的 host，不再每张图重握手、不再串行等 4 秒。
 */
object TileHttp {
    const val UA = "OmniTrace/0.1 (personal sideload; local dashboard)"

    private val client: OkHttpClient = OkHttpClient.Builder()
        .connectTimeout(1200, TimeUnit.MILLISECONDS)
        .readTimeout(4000, TimeUnit.MILLISECONDS)
        .writeTimeout(2000, TimeUnit.MILLISECONDS)
        .callTimeout(5000, TimeUnit.MILLISECONDS)
        .retryOnConnectionFailure(true)
        .followRedirects(true)
        .connectionPool(ConnectionPool(12, 5, TimeUnit.MINUTES))
        .dispatcher(
            Dispatcher().apply {
                maxRequests = 24
                maxRequestsPerHost = 8
            },
        )
        .addInterceptor { chain ->
            chain.proceed(
                chain.request().newBuilder()
                    .header("User-Agent", UA)
                    .header("Accept", "image/png,image/jpeg,image/webp,*/*")
                    .header("Accept-Encoding", "identity")
                    .build(),
            )
        }
        .build()

    @Volatile
    private var pinnedHost: String? = null

    fun fetch(urls: Array<String>): ByteArray? {
        if (urls.isEmpty()) return null
        val pin = pinnedHost
        val ordered = if (pin == null) urls else {
            val hit = urls.filter { host(it) == pin }
            if (hit.isEmpty()) urls else (hit + urls.filter { host(it) != pin }).toTypedArray()
        }
        for (spec in ordered) {
            val bytes = pull(spec)
            if (bytes != null) {
                pinnedHost = host(spec)
                return bytes
            }
            if (pin != null && host(spec) == pin) pinnedHost = null
        }
        return null
    }

    fun resetPin() {
        pinnedHost = null
    }

    private fun pull(spec: String): ByteArray? {
        val req = Request.Builder().url(spec).get().build()
        return try {
            client.newCall(req).execute().use { resp ->
                if (!resp.isSuccessful) return null
                val bytes = resp.body?.bytes() ?: return null
                if (bytes.size < 32) null else bytes
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun host(spec: String): String {
        val i = spec.indexOf("://")
        val s = if (i >= 0) spec.substring(i + 3) else spec
        val slash = s.indexOf('/')
        return if (slash >= 0) s.substring(0, slash) else s
    }
}
