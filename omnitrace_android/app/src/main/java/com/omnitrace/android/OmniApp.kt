package com.omnitrace.android

import android.app.Application
import com.omnitrace.android.host.OmniPaths
import com.omnitrace.android.map.TileStore
import com.omnitrace.android.ui.ShellTheme
import java.io.File

class OmniApp : Application() {
    override fun onCreate() {
        super.onCreate()
        instance = this
        ShellTheme.apply(this)
        TileStore.init(File(OmniPaths.dataRoot(this), "cache/map_tiles"))
        TileStore.setSource(com.omnitrace.android.map.MapPrefs.source(this))
    }

    companion object {
        lateinit var instance: OmniApp
            private set
    }
}
