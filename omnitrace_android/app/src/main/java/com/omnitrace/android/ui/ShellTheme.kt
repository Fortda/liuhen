package com.omnitrace.android.ui

import android.content.Context
import androidx.appcompat.app.AppCompatDelegate
import com.omnitrace.android.RecordService

object ShellTheme {
    const val SYSTEM = "system"
    const val LIGHT = "light"
    const val DARK = "dark"
    const val KEY = "shell_theme"

    fun choice(ctx: Context): String {
        val raw = ctx.getSharedPreferences(RecordService.PREFS, Context.MODE_PRIVATE)
            .getString(KEY, LIGHT) ?: LIGHT
        return if (raw == SYSTEM || raw == LIGHT || raw == DARK) raw else LIGHT
    }

    fun apply(ctx: Context) {
        AppCompatDelegate.setDefaultNightMode(mode(choice(ctx)))
    }

    fun set(ctx: Context, value: String) {
        val v = if (value == SYSTEM || value == LIGHT || value == DARK) value else LIGHT
        ctx.getSharedPreferences(RecordService.PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY, v)
            .apply()
        apply(ctx)
    }

    private fun mode(choice: String): Int = when (choice) {
        LIGHT -> AppCompatDelegate.MODE_NIGHT_NO
        DARK -> AppCompatDelegate.MODE_NIGHT_YES
        else -> AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
    }
}
