package com.omnitrace.android.map

data class CityDef(
    val id: String,
    val name: String,
    val south: Double,
    val west: Double,
    val north: Double,
    val east: Double,
) {
    fun contains(lat: Double, lon: Double): Boolean =
        lat in south..north && lon in west..east

    fun offer(source: MapSource, zMin: Int = Slippy.CITY_Z, zMax: Int = 14): PackOffer {
        val tiles = TileMath.count(south, west, north, east, zMin, zMax)
        return PackOffer(
            id = id,
            name = name,
            south = south,
            west = west,
            north = north,
            east = east,
            zMin = zMin,
            zMax = zMax,
            tiles = tiles,
            bytesEst = tiles * source.bytesPerTile.toLong(),
        )
    }
}

data class PackOffer(
    val id: String,
    val name: String,
    val south: Double,
    val west: Double,
    val north: Double,
    val east: Double,
    val zMin: Int,
    val zMax: Int,
    val tiles: Int,
    val bytesEst: Long,
)

object TileMath {
    fun count(south: Double, west: Double, north: Double, east: Double, zMin: Int, zMax: Int): Int {
        var n = 0
        for (z in zMin..zMax) {
            val x0 = Slippy.lonToTileX(west, z)
            val x1 = Slippy.lonToTileX(east, z)
            val y0 = Slippy.latToTileY(north, z)
            val y1 = Slippy.latToTileY(south, z)
            n += (x1 - x0 + 1).coerceAtLeast(1) * (y1 - y0 + 1).coerceAtLeast(1)
        }
        return n
    }
}

object CityCatalog {
    val all: List<CityDef> = listOf(
        c("beijing", "北京", 39.45, 115.75, 40.25, 116.85),
        c("shanghai", "上海", 30.70, 120.85, 31.70, 122.20),
        c("guangzhou", "广州", 22.75, 113.05, 23.55, 113.75),
        c("shenzhen", "深圳", 22.40, 113.75, 22.85, 114.65),
        c("chengdu", "成都", 30.35, 103.80, 31.05, 104.40),
        c("hangzhou", "杭州", 30.05, 119.90, 30.55, 120.50),
        c("wuhan", "武汉", 30.30, 114.05, 30.85, 114.70),
        c("xian", "西安", 34.10, 108.70, 34.55, 109.20),
        c("nanjing", "南京", 31.85, 118.55, 32.25, 119.05),
        c("tianjin", "天津", 38.85, 116.90, 39.35, 117.85),
        c("chongqing", "重庆", 29.30, 106.20, 29.90, 106.90),
        c("suzhou", "苏州", 31.15, 120.35, 31.55, 121.00),
        c("zhengzhou", "郑州", 34.55, 113.40, 34.95, 113.90),
        c("changsha", "长沙", 28.05, 112.75, 28.40, 113.20),
        c("shenyang", "沈阳", 41.60, 123.20, 42.00, 123.70),
        c("qingdao", "青岛", 35.95, 120.15, 36.45, 120.70),
        c("dalian", "大连", 38.80, 121.35, 39.15, 121.85),
        c("xiamen", "厦门", 24.40, 117.95, 24.65, 118.25),
        c("fuzhou", "福州", 25.95, 119.15, 26.20, 119.50),
        c("hefei", "合肥", 31.70, 117.10, 32.00, 117.50),
        c("jinan", "济南", 36.50, 116.80, 36.85, 117.30),
        c("harbin", "哈尔滨", 45.55, 126.40, 45.95, 126.90),
        c("changchun", "长春", 43.70, 125.10, 44.10, 125.50),
        c("nanchang", "南昌", 28.55, 115.75, 28.85, 116.10),
        c("kunming", "昆明", 24.85, 102.55, 25.15, 102.90),
        c("nanning", "南宁", 22.70, 108.20, 23.00, 108.55),
        c("guiyang", "贵阳", 26.45, 106.55, 26.75, 106.90),
        c("taiyuan", "太原", 37.70, 112.40, 38.00, 112.75),
        c("shijiazhuang", "石家庄", 37.95, 114.30, 38.20, 114.70),
        c("lanzhou", "兰州", 35.95, 103.60, 36.20, 104.00),
        c("urumqi", "乌鲁木齐", 43.70, 87.40, 44.00, 87.80),
        c("hohhot", "呼和浩特", 40.70, 111.50, 40.95, 112.00),
        c("yinchuan", "银川", 38.35, 106.10, 38.60, 106.45),
        c("xining", "西宁", 36.55, 101.65, 36.75, 101.95),
        c("lhasa", "拉萨", 29.55, 90.95, 29.75, 91.25),
        c("haikou", "海口", 19.90, 110.20, 20.10, 110.50),
        c("sanya", "三亚", 18.15, 109.40, 18.35, 109.65),
        c("dongguan", "东莞", 22.85, 113.55, 23.15, 114.05),
        c("foshan", "佛山", 22.90, 112.90, 23.20, 113.30),
        c("wuxi", "无锡", 31.45, 120.15, 31.75, 120.50),
        c("ningbo", "宁波", 29.75, 121.40, 30.05, 121.80),
        c("hongkong", "香港", 22.15, 113.82, 22.58, 114.45),
        c("macau", "澳门", 22.10, 113.52, 22.22, 113.62),
        c("taipei", "台北", 24.95, 121.45, 25.20, 121.70),
    )

    fun at(lat: Double, lon: Double): CityDef? =
        all.firstOrNull { it.contains(lat, lon) }

    fun search(q: String): List<CityDef> {
        val s = q.trim()
        if (s.isEmpty()) return all
        return all.filter { it.name.contains(s, true) || it.id.contains(s, true) }
    }

    fun byId(id: String): CityDef? = all.firstOrNull { it.id == id }

    fun viewportOffer(
        south: Double,
        west: Double,
        north: Double,
        east: Double,
        z: Int,
        source: MapSource,
    ): PackOffer {
        val city = at((south + north) / 2.0, (west + east) / 2.0)
        if (city != null) return city.offer(source)
        val zMin = Slippy.CITY_Z
        val zMax = z.coerceIn(Slippy.CITY_Z, 14)
        val tiles = TileMath.count(south, west, north, east, zMin, zMax)
        return PackOffer(
            id = "view_${"%.3f".format(south)}_${"%.3f".format(west)}",
            name = "当前视野",
            south = south,
            west = west,
            north = north,
            east = east,
            zMin = zMin,
            zMax = zMax,
            tiles = tiles,
            bytesEst = tiles * source.bytesPerTile.toLong(),
        )
    }

    private fun c(id: String, name: String, s: Double, w: Double, n: Double, e: Double) =
        CityDef(id, name, s, w, n, e)
}
