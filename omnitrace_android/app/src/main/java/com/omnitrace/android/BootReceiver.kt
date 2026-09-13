package com.omnitrace.android

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action ?: return
        if (action != Intent.ACTION_BOOT_COMPLETED && action != "android.intent.action.QUICKBOOT_POWERON") return
        val on = context.getSharedPreferences(RecordService.PREFS, Context.MODE_PRIVATE)
            .getBoolean(RecordService.KEY_BOOT, false)
        if (on) RecordService.start(context)
    }
}
