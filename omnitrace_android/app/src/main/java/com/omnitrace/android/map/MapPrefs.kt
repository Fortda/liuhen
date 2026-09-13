package com.omnitrace.android.map

import android.content.Context
import com.omnitrace.android.RecordService

object MapPrefs {
    const val KEY_SOURCE = "map_source"

    fun source(ctx: Context): MapSource {
        val id = ctx.getSharedPreferences(RecordService.PREFS, Context.MODE_PRIVATE)
            .getString(KEY_SOURCE, MapSource.AMAP.id)
        return MapSource.fromId(id)
    }

    fun setSource(ctx: Context, src: MapSource) {
        ctx.getSharedPreferences(RecordService.PREFS, Context.MODE_PRIVATE)
            .edit()
            .putString(KEY_SOURCE, src.id)
            .apply()
        TileStore.setSource(src)
    }
}
