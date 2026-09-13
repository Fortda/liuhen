package com.omnitrace.android.sync

import android.content.Context

object PcLinkPrefs {
    private const val NAME = "pc_link_v1"
    private const val KEY_HOST = "host"
    private const val KEY_HOSTNAME = "hostname"
    private const val KEY_LAST_SYNC = "last_sync"

    private fun sp(ctx: Context) = ctx.getSharedPreferences(NAME, Context.MODE_PRIVATE)

    fun host(ctx: Context): String? = sp(ctx).getString(KEY_HOST, null)?.takeIf { it.isNotBlank() }

    fun setHost(ctx: Context, host: String) {
        sp(ctx).edit().putString(KEY_HOST, host.trim()).apply()
    }

    fun hostname(ctx: Context): String? = sp(ctx).getString(KEY_HOSTNAME, null)

    fun setHostname(ctx: Context, name: String?) {
        sp(ctx).edit().putString(KEY_HOSTNAME, name).apply()
    }

    fun lastSync(ctx: Context): Long = sp(ctx).getLong(KEY_LAST_SYNC, 0L)

    fun setLastSync(ctx: Context, ts: Long) {
        sp(ctx).edit().putLong(KEY_LAST_SYNC, ts).apply()
    }
}
