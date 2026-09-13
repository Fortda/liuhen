package com.omnitrace.android.host

import android.content.BroadcastReceiver
import android.content.Context
import android.content.IntentFilter
import androidx.core.content.ContextCompat

object Receivers {
    fun register(ctx: Context, receiver: BroadcastReceiver, filter: IntentFilter) {
        ContextCompat.registerReceiver(ctx, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
    }

    fun registerExported(ctx: Context, receiver: BroadcastReceiver, filter: IntentFilter) {
        ContextCompat.registerReceiver(ctx, receiver, filter, ContextCompat.RECEIVER_EXPORTED)
    }

    fun sticky(ctx: Context, action: String): android.content.Intent? {
        return ContextCompat.registerReceiver(
            ctx,
            null,
            IntentFilter(action),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
    }
}
