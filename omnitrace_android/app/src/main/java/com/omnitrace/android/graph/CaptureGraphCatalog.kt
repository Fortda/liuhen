package com.omnitrace.android.graph

import android.content.Context
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorManager
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
import android.nfc.NfcAdapter
import android.os.Build
import com.omnitrace.android.R
import com.omnitrace.android.host.CapturePermProbe
import org.json.JSONObject

object CaptureGraphCatalog {
    enum class Kind { SOURCE, CATEGORY, HUB, SINK }

    data class CategoryDef(
        val id: String,
        val title: String,
        val iconRes: Int,
        val memberIds: List<String>,
        val storageLines: List<String>,
    )

    enum class HwState { MISSING, NEED_PERM, OK }

    data class NodeDef(
        val id: String,
        val kind: Kind,
        val iconRes: Int,
        val rightLines: List<String>,
        val sensorType: Int? = null,
        val feature: Feature? = null,
        val perm: CapturePermProbe.Need = CapturePermProbe.Need.NONE,
        val leftBuilder: (Context, JSONObject?) -> List<HwSpecResolver.SpecLine>,
    )

    enum class Feature {
        GPS,
        STEP,
        VIBRATOR,
        NFC,
        IR,
        WIFI,
        BLUETOOTH,
        TELEPHONY,
        CAMERA_BACK,
        CAMERA_ANY,
    }

    data class GraphNode(
        val id: String,
        val kind: Kind,
        val iconRes: Int,
        val leftLines: List<HwSpecResolver.SpecLine>,
        val rightLines: List<String>,
        val worldX: Float,
        val worldY: Float,
        val rowH: Float,
        val hwState: HwState,
        val alpha: Float,
    )

    data class GraphEdge(val fromId: String, val toId: String)

    data class GraphModel(
        val nodes: List<GraphNode>,
        val edges: List<GraphEdge>,
        val boundsLeft: Float,
        val boundsTop: Float,
        val boundsRight: Float,
        val boundsBottom: Float,
    )

    private val sourceDefs: List<NodeDef> = listOf(
        node(
            "accel", R.drawable.ic_graph_accel, listOf("三轴数值·高频采样"),
            Sensor.TYPE_ACCELEROMETER, null, CapturePermProbe.Need.NONE,
            { ctx, inv -> HwSpecResolver.sensorLines("加速度计", inv, ctx, Sensor.TYPE_ACCELEROMETER, "本机无") },
        ),
        node(
            "gyro", R.drawable.ic_graph_gyro, listOf("三轴角速度·高频采样"),
            Sensor.TYPE_GYROSCOPE, null, CapturePermProbe.Need.NONE,
            { ctx, inv -> HwSpecResolver.sensorLines("陀螺仪", inv, ctx, Sensor.TYPE_GYROSCOPE, "本机无") },
        ),
        node(
            "mag", R.drawable.ic_graph_mag, listOf("三轴磁场·高频采样"),
            Sensor.TYPE_MAGNETIC_FIELD, null, CapturePermProbe.Need.NONE,
            { ctx, inv -> HwSpecResolver.sensorLines("磁力计", inv, ctx, Sensor.TYPE_MAGNETIC_FIELD, "本机无") },
        ),
        node(
            "light", R.drawable.ic_graph_light, listOf("亮度·变化时记"),
            Sensor.TYPE_LIGHT, null, CapturePermProbe.Need.NONE,
            { ctx, inv -> HwSpecResolver.sensorLines("光线", inv, ctx, Sensor.TYPE_LIGHT, "本机无") },
        ),
        node(
            "prox", R.drawable.ic_graph_proximity, listOf("距离·变化时记"),
            Sensor.TYPE_PROXIMITY, null, CapturePermProbe.Need.NONE,
            { ctx, inv -> HwSpecResolver.sensorLines("接近", inv, ctx, Sensor.TYPE_PROXIMITY, "本机无") },
        ),
        node(
            "color", R.drawable.ic_graph_light, listOf("色温估计·变化时记"),
            Sensor.TYPE_LIGHT, null, CapturePermProbe.Need.NONE,
            { ctx, inv -> HwSpecResolver.simpleLines("色温", "启发式", "同光线传感器") },
        ),
        node(
            "steps", R.drawable.ic_graph_steps, listOf("累计步数·变化时记"),
            null, Feature.STEP, CapturePermProbe.Need.ACTIVITY,
            { ctx, inv -> HwSpecResolver.sensorLines("计步器", inv, ctx, Sensor.TYPE_STEP_COUNTER, "本机无") },
        ),
        node(
            "gps", R.drawable.ic_graph_gps, listOf("经纬度·时间戳"),
            null, Feature.GPS, CapturePermProbe.Need.LOCATION,
            { ctx, inv -> HwSpecResolver.gpsLines(inv, ctx) },
        ),
        node(
            "display", R.drawable.ic_graph_display, listOf("亮灭·锁屏·时间戳"),
            null, null, CapturePermProbe.Need.NONE,
            { ctx, inv -> HwSpecResolver.displayLines(inv, ctx) },
        ),
        node(
            "battery", R.drawable.ic_graph_battery, listOf("电量·亮度·时间戳"),
            null, null, CapturePermProbe.Need.NONE,
            { _, inv ->
                val tech = inv?.optJSONObject("battery")?.optString("technology", "").orEmpty()
                HwSpecResolver.simpleLines("电池", truncateTech(tech), "电量百分比")
            },
        ),
        node(
            "vibrate", R.drawable.ic_graph_vibrate, listOf("忙闲·开/关·时间戳"),
            null, Feature.VIBRATOR, CapturePermProbe.Need.NONE,
            { ctx, inv ->
                val f = inv?.optJSONObject("features")
                val on = f?.optBoolean("vibrator", hasVibrator(ctx)) ?: hasVibrator(ctx)
                HwSpecResolver.featureLines("振动", on, "马达")
            },
        ),
        node(
            "nfc", R.drawable.ic_graph_nfc, listOf("适配器·开/关·时间戳"),
            null, Feature.NFC, CapturePermProbe.Need.NONE,
            { ctx, inv ->
                val f = inv?.optJSONObject("features")
                val on = f?.optBoolean("nfc", NfcAdapter.getDefaultAdapter(ctx) != null)
                    ?: (NfcAdapter.getDefaultAdapter(ctx) != null)
                HwSpecResolver.featureLines("NFC", on, "近场")
            },
        ),
        node(
            "ir", R.drawable.ic_graph_ir, listOf("发射·开/关·时间戳"),
            null, Feature.IR, CapturePermProbe.Need.NONE,
            { ctx, inv ->
                val f = inv?.optJSONObject("features")
                val on = f?.optBoolean("ir_emitter", hasIr(ctx)) ?: hasIr(ctx)
                HwSpecResolver.featureLines("红外", on, "发射器")
            },
        ),
        node(
            "camera", R.drawable.ic_graph_camera, listOf("占用开/关·时间戳"),
            null, Feature.CAMERA_BACK, CapturePermProbe.Need.NONE,
            { ctx, inv ->
                HwSpecResolver.cameraLines(inv, ctx, CameraCharacteristics.LENS_FACING_BACK, "相机")
            },
        ),
        node(
            "audio", R.drawable.ic_graph_audio, listOf("播放/录音占用·时间戳"),
            null, null, CapturePermProbe.Need.NONE,
            { _, _ -> HwSpecResolver.simpleLines("音频", "播放/录音占用", "无 PCM") },
        ),
        node(
            "wifi", R.drawable.ic_graph_wifi, listOf("连接/扫描·时间戳"),
            null, Feature.WIFI, CapturePermProbe.Need.RADIO,
            { ctx, inv ->
                val f = inv?.optJSONObject("features")
                val on = f?.optBoolean("wifi", ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI))
                    ?: ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI)
                HwSpecResolver.featureLines("WiFi", on, "无线局域网")
            },
        ),
        node(
            "bt", R.drawable.ic_graph_bluetooth, listOf("状态/配对·时间戳"),
            null, Feature.BLUETOOTH, CapturePermProbe.Need.RADIO,
            { ctx, inv ->
                val f = inv?.optJSONObject("features")
                val on = f?.optBoolean("bluetooth", ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH))
                    ?: ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH)
                HwSpecResolver.featureLines("蓝牙", on, "BT")
            },
        ),
        node(
            "cell", R.drawable.ic_graph_cell, listOf("蜂窝/传输·时间戳"),
            null, Feature.TELEPHONY, CapturePermProbe.Need.RADIO,
            { ctx, inv ->
                val f = inv?.optJSONObject("features")
                val on = f?.optBoolean("telephony", ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY))
                    ?: ctx.packageManager.hasSystemFeature(PackageManager.FEATURE_TELEPHONY)
                HwSpecResolver.featureLines("蜂窝", on, "基带")
            },
        ),
        node(
            "perf", R.drawable.ic_graph_cpu, listOf("CPU/内存/温感·5s"),
            null, null, CapturePermProbe.Need.NONE,
            { _, inv -> HwSpecResolver.cpuLines(inv) + HwSpecResolver.memoryLines(inv).drop(1) },
        ),
        node(
            "app_focus", R.drawable.ic_graph_app, listOf("包名·时间戳"),
            null, null, CapturePermProbe.Need.A11Y,
            { _, _ -> HwSpecResolver.simpleLines("前台应用", "无障碍", "焦点变化") },
        ),
        node(
            "touch", R.drawable.ic_graph_touch, listOf("控件目标·时间戳"),
            null, null, CapturePermProbe.Need.A11Y,
            { _, _ -> HwSpecResolver.simpleLines("点击", "无障碍", "语义交互") },
        ),
        node(
            "ui_map", R.drawable.ic_graph_window, listOf("窗栈/浅树·时间戳"),
            null, null, CapturePermProbe.Need.A11Y,
            { _, _ -> HwSpecResolver.simpleLines("窗栈", "无障碍", "显示器几何") },
        ),
        node(
            "hw", R.drawable.ic_graph_hw, listOf("启动快照·变更时记"),
            null, null, CapturePermProbe.Need.NONE,
            { _, inv ->
                val sig = inv?.let { "inventory" } ?: "待首次采集"
                HwSpecResolver.simpleLines("硬件清单", "启动扫描", sig)
            },
        ),
    )

    private val sinkDefs: List<NodeDef> = listOf(
        sink(
            "sink_player", R.drawable.ic_graph_player, listOf("窗栈", "前台应用", "屏幕几何"),
            { _, _ -> HwSpecResolver.simpleLines("播放器", "屏幕采集", "当日回放") },
        ),
        sink(
            "sink_timeline", R.drawable.ic_graph_timeline, listOf("亮灭屏", "开锁", "音频占用", "焦点"),
            { _, _ -> HwSpecResolver.simpleLines("时间轴", "开关时间戳", "多轨叠色") },
        ),
        sink(
            "sink_map", R.drawable.ic_graph_map, listOf("GPS 轨迹", "停留点"),
            { _, _ -> HwSpecResolver.simpleLines("地图", "GPS", "行踪折线") },
        ),
        sink(
            "sink_stats", R.drawable.ic_graph_stats, listOf("屏时", "步数", "惯性", "分应用"),
            { _, _ -> HwSpecResolver.simpleLines("统计图表", "多源汇总", "柱图/明细") },
        ),
        sink(
            "sink_idea", R.drawable.ic_graph_idea, listOf("…"),
            { _, _ -> HwSpecResolver.simpleLines("想想这些数据", "还能用来", "干什么") },
        ),
    )

    private val hubId = "hub_db"

    private val categories: List<CategoryDef> = listOf(
        CategoryDef(
            "cat_imu",
            "三轴空间类",
            R.drawable.ic_graph_gyro,
            listOf("accel", "gyro", "mag"),
            listOf("imu_DD.bin", "高频量化·非 jsonl"),
        ),
        CategoryDef(
            "cat_env",
            "环境传感类",
            R.drawable.ic_graph_light,
            listOf("light", "prox", "color", "steps"),
            listOf("env/events jsonl", "变化时记"),
        ),
        CategoryDef(
            "cat_gps",
            "定位类",
            R.drawable.ic_graph_gps,
            listOf("gps"),
            listOf("gps/events jsonl", "fix 点列"),
        ),
        CategoryDef(
            "cat_device",
            "设备状态类",
            R.drawable.ic_graph_display,
            listOf("display", "battery", "vibrate"),
            listOf("device/events jsonl", "状态戳"),
        ),
        CategoryDef(
            "cat_radio",
            "无线连通类",
            R.drawable.ic_graph_wifi,
            listOf("wifi", "bt", "cell", "nfc", "ir"),
            listOf("radio/events jsonl", "连通状态"),
        ),
        CategoryDef(
            "cat_media",
            "媒体占用类",
            R.drawable.ic_graph_camera,
            listOf("camera", "audio"),
            listOf("media/events jsonl", "占用非内容"),
        ),
        CategoryDef(
            "cat_perf",
            "系统性能类",
            R.drawable.ic_graph_cpu,
            listOf("perf"),
            listOf("perf/events jsonl", "约 5s 粒度"),
        ),
        CategoryDef(
            "cat_a11y",
            "无障碍交互类",
            R.drawable.ic_graph_window,
            listOf("app_focus", "touch", "ui_map"),
            listOf("多模组 jsonl", "需无障碍"),
        ),
        CategoryDef(
            "cat_hw",
            "硬件快照类",
            R.drawable.ic_graph_hw,
            listOf("hw"),
            listOf("hw_inventory.json", "启动扫描"),
        ),
    )

    fun build(ctx: Context): GraphModel {
        val inv = HwSpecResolver.loadInventory(ctx)
        val defById = sourceDefs.associateBy { it.id }
        val sourceNodes = ArrayList<GraphNode>()
        val categoryNodes = ArrayList<GraphNode>()
        val edges = ArrayList<GraphEdge>()
        var y0 = 0f
        var groupCount = 0

        for (cat in categories) {
            val pending = cat.memberIds.mapNotNull { id ->
                val def = defById[id] ?: return@mapNotNull null
                val hw = hwState(ctx, def)
                val alpha = when (hw) {
                    HwState.MISSING -> 0.15f
                    HwState.NEED_PERM -> 0.45f
                    HwState.OK -> 1f
                }
                val left = def.leftBuilder(ctx, inv).take(3)
                PendingNode(def, left, hw, alpha)
            }
            if (pending.isEmpty()) continue
            val rowHs = pending.map { rowHeight(it.left.size) }
            val groupH = rowHs.sum() + (pending.size - 1) * ROW_GAP
            val catY = y0 + groupH / 2f
            var sy = y0
            pending.forEachIndexed { i, p ->
                val h = rowHs[i]
                sourceNodes.add(
                    GraphNode(
                        id = p.def.id,
                        kind = Kind.SOURCE,
                        iconRes = p.def.iconRes,
                        leftLines = p.left,
                        rightLines = p.def.rightLines,
                        worldX = COL_SOURCE,
                        worldY = sy + h / 2f,
                        rowH = h,
                        hwState = p.hw,
                        alpha = p.alpha,
                    ),
                )
                edges.add(GraphEdge(p.def.id, cat.id))
                sy += h + ROW_GAP
            }
            categoryNodes.add(
                GraphNode(
                    id = cat.id,
                    kind = Kind.CATEGORY,
                    iconRes = cat.iconRes,
                    leftLines = listOf(HwSpecResolver.SpecLine(cat.title, true)),
                    rightLines = cat.storageLines,
                    worldX = COL_CAT,
                    worldY = catY,
                    rowH = rowHeight(2),
                    hwState = HwState.OK,
                    alpha = 1f,
                ),
            )
            edges.add(GraphEdge(cat.id, hubId))
            y0 += groupH + CAT_GAP
            groupCount++
        }
        val totalH = if (groupCount > 0) y0 - CAT_GAP else 120f
        val hubY = totalH / 2f
        val hub = GraphNode(
            id = hubId,
            kind = Kind.HUB,
            iconRes = R.drawable.ic_graph_db,
            leftLines = listOf(HwSpecResolver.SpecLine("手机数据库", true)),
            rightLines = listOf("OmniDatabase"),
            worldX = COL_HUB,
            worldY = hubY,
            rowH = 72f,
            hwState = HwState.OK,
            alpha = 1f,
        )
        val sinkPending = sinkDefs.map { def ->
            val left = def.leftBuilder(ctx, inv).take(3)
            PendingNode(def, left, HwState.OK, 1f)
        }
        val sinkRowHs = sinkPending.map { rowHeight(it.left.size) }
        val sinkTotal = sinkRowHs.sum() + (sinkPending.size - 1) * ROW_GAP
        var sy = (totalH - sinkTotal) / 2f
        val sinkNodes = sinkPending.mapIndexed { i, p ->
            val h = sinkRowHs[i]
            val n = GraphNode(
                id = p.def.id,
                kind = Kind.SINK,
                iconRes = p.def.iconRes,
                leftLines = p.left,
                rightLines = p.def.rightLines,
                worldX = COL_SINK,
                worldY = sy + h / 2f,
                rowH = h,
                hwState = HwState.OK,
                alpha = 1f,
            )
            sy += h + ROW_GAP
            n
        }
        sinkNodes.forEach { edges.add(GraphEdge(hubId, it.id)) }
        val all = sourceNodes + categoryNodes + hub + sinkNodes
        val left = COL_SOURCE - LEFT_W - 8f
        val right = COL_SINK + RIGHT_W + CIRCLE_R + 8f
        val top = -8f
        val bottom = totalH + 8f
        return GraphModel(all, edges, left, top, right, bottom)
    }

    private data class PendingNode(
        val def: NodeDef,
        val left: List<HwSpecResolver.SpecLine>,
        val hw: HwState,
        val alpha: Float,
    )

    private fun node(
        id: String,
        icon: Int,
        right: List<String>,
        sensorType: Int?,
        feature: Feature?,
        perm: CapturePermProbe.Need,
        leftBuilder: (Context, JSONObject?) -> List<HwSpecResolver.SpecLine>,
    ): NodeDef = NodeDef(id, Kind.SOURCE, icon, right, sensorType, feature, perm, leftBuilder)

    private fun sink(
        id: String,
        icon: Int,
        right: List<String>,
        leftBuilder: (Context, JSONObject?) -> List<HwSpecResolver.SpecLine>,
    ): NodeDef = NodeDef(id, Kind.SINK, icon, right, null, null, CapturePermProbe.Need.NONE, leftBuilder)

    private fun hwState(ctx: Context, def: NodeDef): HwState {
        val present = when {
            def.sensorType != null -> {
                val sm = ctx.getSystemService(Context.SENSOR_SERVICE) as SensorManager
                sm.getSensorList(def.sensorType).isNotEmpty()
            }
            def.feature != null -> featurePresent(ctx, def.feature)
            def.id == "display" || def.id == "battery" || def.id == "audio" || def.id == "perf" || def.id == "hw" -> true
            def.id == "app_focus" || def.id == "touch" || def.id == "ui_map" -> true
            else -> true
        }
        if (!present) return HwState.MISSING
        if (!CapturePermProbe.needSatisfied(ctx, def.perm)) return HwState.NEED_PERM
        return HwState.OK
    }

    private fun featurePresent(ctx: Context, f: Feature): Boolean {
        val pm = ctx.packageManager
        return when (f) {
            Feature.GPS -> pm.hasSystemFeature(PackageManager.FEATURE_LOCATION_GPS)
            Feature.STEP -> pm.hasSystemFeature(PackageManager.FEATURE_SENSOR_STEP_COUNTER)
            Feature.VIBRATOR -> hasVibrator(ctx)
            Feature.NFC -> NfcAdapter.getDefaultAdapter(ctx) != null
            Feature.IR -> hasIr(ctx)
            Feature.WIFI -> pm.hasSystemFeature(PackageManager.FEATURE_WIFI)
            Feature.BLUETOOTH -> pm.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH)
            Feature.TELEPHONY -> pm.hasSystemFeature(PackageManager.FEATURE_TELEPHONY)
            Feature.CAMERA_BACK, Feature.CAMERA_ANY -> hasCamera(ctx)
        }
    }

    private fun hasVibrator(ctx: Context): Boolean {
        return if (Build.VERSION.SDK_INT >= 31) {
            val vm = ctx.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as android.os.VibratorManager
            vm.defaultVibrator.hasVibrator()
        } else {
            @Suppress("DEPRECATION")
            (ctx.getSystemService(Context.VIBRATOR_SERVICE) as android.os.Vibrator).hasVibrator()
        }
    }

    private fun hasIr(ctx: Context): Boolean {
        val ir = ctx.getSystemService(Context.CONSUMER_IR_SERVICE) as? android.hardware.ConsumerIrManager
        return ir?.hasIrEmitter() == true
    }

    private fun hasCamera(ctx: Context): Boolean {
        return try {
            val cm = ctx.getSystemService(Context.CAMERA_SERVICE) as CameraManager
            cm.cameraIdList.isNotEmpty()
        } catch (_: Exception) {
            false
        }
    }

    private fun truncateTech(s: String): String {
        if (s.isBlank() || s == "unreadable") return "电量"
        return s
    }

    private fun rowHeight(lineCount: Int): Float {
        val lines = lineCount.coerceAtLeast(2)
        return TITLE_H + (lines - 1) * LINE_H + DIV_H * lines + 8f
    }

    const val COL_SOURCE = 0f
    const val COL_CAT = 210f
    const val COL_HUB = 390f
    const val COL_SINK = 580f
    const val LEFT_W = 118f
    const val RIGHT_W = 108f
    const val CIRCLE_R = 22f
    /** 连线折线水平段长度（世界坐标），略长于文字下灰色分隔线。 */
    const val EDGE_H = 34f
    const val ROW_GAP = 10f
    const val CAT_GAP = 14f
    const val TITLE_H = 18f
    const val LINE_H = 14f
    const val DIV_H = 6f
}
