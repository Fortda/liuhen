package com.omnitrace.android.map

/**
 * 底图来源与大地/测绘坐标。
 *
 * GPS 点按 WGS84 存。CGCS2000（中国 2000，常被说成「国标 2000/2020」）和 WGS84
 * 差几十厘米，城区图可当同一套。高德等国内互联网图是 GCJ-02（火星坐标），叠点要偏。
 */
enum class MapSource(
    val id: String,
    val title: String,
    val datum: String,
    val datumNote: String,
    val attribution: String,
    val bytesPerTile: Int,
    val gcj: Boolean,
) {
    CARTO(
        "carto",
        "CARTO Voyager",
        "WGS84",
        "GPS 同系。相对 CGCS2000（中国 2000 大地坐标系）差亚米级，城区可当一样。不是火星坐标。",
        "© OSM / CARTO",
        16_000,
        false,
    ),
    OSM(
        "osm",
        "OpenStreetMap",
        "WGS84",
        "标准 OSM 栅格，WGS84 / Web Mercator。美国国防部 WGS84，和手机 GPS 直接叠。",
        "© OpenStreetMap",
        18_000,
        false,
    ),
    AMAP(
        "amap",
        "高德（国内路网）",
        "GCJ-02",
        "国测局火星坐标，不是 CGCS2000，也不是 WGS84。叠 GPS 点会做偏移。无天地图 key，不能直接铺 CGCS2000 国标图。",
        "© 高德",
        12_000,
        true,
    );

    fun urls(z: Int, x: Int, y: Int): Array<String> {
        val letter = ('a'.code + ((x + y) % 3)).toChar()
        return when (this) {
            CARTO -> arrayOf(
                "https://$letter.basemaps.cartocdn.com/rastertiles/voyager/$z/$x/$y.png",
                "https://tile.openstreetmap.de/$z/$x/$y.png",
            )
            OSM -> arrayOf(
                "https://tile.openstreetmap.de/$z/$x/$y.png",
                "https://tile.openstreetmap.org/$z/$x/$y.png",
            )
            AMAP -> {
                val n = 1 + ((x + y) % 4)
                arrayOf("https://webrd0$n.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x=$x&y=$y&z=$z")
            }
        }
    }

    companion object {
        fun fromId(id: String?): MapSource =
            entries.firstOrNull { it.id == id } ?: AMAP
    }
}
