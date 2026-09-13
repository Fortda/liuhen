package com.omnitrace.android.graph

import android.content.Context
import android.hardware.Sensor
import org.json.JSONObject

/** 采集图节点名称点击后的科普说明（静态 + 本机 inventory 动态字段）。 */
object CaptureEduCatalog {
    data class EduDetail(
        val title: String,
        val sections: List<Pair<String, String>>,
    )

    fun detail(ctx: Context, nodeId: String, inv: JSONObject?): EduDetail {
        val base = static[nodeId] ?: static["default"]!!
        val sections = base.sections.map { it }.toMutableList()
        appendLive(ctx, nodeId, inv, sections)
        return EduDetail(base.title, sections)
    }

    fun formatMessage(d: EduDetail): String =
        d.sections.joinToString("\n\n") { (k, v) -> "$k\n$v" }

    private fun appendLive(ctx: Context, nodeId: String, inv: JSONObject?, sections: MutableList<Pair<String, String>>) {
        when (nodeId) {
            "accel" -> appendSensor(sections, inv, ctx, Sensor.TYPE_ACCELEROMETER)
            "gyro" -> appendSensor(sections, inv, ctx, Sensor.TYPE_GYROSCOPE)
            "mag" -> appendSensor(sections, inv, ctx, Sensor.TYPE_MAGNETIC_FIELD)
            "light" -> appendSensor(sections, inv, ctx, Sensor.TYPE_LIGHT)
            "prox" -> appendSensor(sections, inv, ctx, Sensor.TYPE_PROXIMITY)
            "steps" -> appendSensor(sections, inv, ctx, Sensor.TYPE_STEP_COUNTER)
            "gps" -> {
                val g = inv?.optJSONObject("build")
                if (g != null) {
                    sections.add("本机" to "${g.optString("manufacturer")} ${g.optString("model")}")
                }
            }
            "display" -> {
                val o = inv?.optJSONObject("display")?.optJSONArray("displays")?.optJSONObject(0)
                if (o != null) {
                    sections.add(
                        "本机屏参" to "${o.optString("name")} · ${o.optInt("w")}×${o.optInt("h")} · " +
                            "${o.optDouble("refresh_hz", 0.0).let { if (it > 0) "${it.toInt()}Hz" else "—" }}",
                    )
                }
            }
            "battery" -> {
                val b = inv?.optJSONObject("battery")
                if (b != null) {
                    val tech = b.optString("technology", "")
                    if (tech.isNotBlank() && tech != "unreadable") {
                        sections.add("本机电芯" to tech)
                    }
                }
            }
            "camera" -> {
                val arr = inv?.optJSONArray("cameras")
                if (arr != null && arr.length() > 0) {
                    val c = arr.optJSONObject(0)
                    sections.add(
                        "本机相机" to "id ${c?.optString("id")} · " +
                            "${c?.optInt("pixel_w")}×${c?.optInt("pixel_h")}",
                    )
                }
            }
            "perf" -> {
                val cpu = inv?.optJSONObject("cpu")
                val mem = inv?.optJSONObject("memory")
                if (cpu != null) sections.add("CPU" to "${cpu.optInt("cores")} 核")
                if (mem != null) {
                    val gb = mem.optLong("total_bytes", 0L) / (1024L * 1024L * 1024L)
                    if (gb > 0) sections.add("RAM" to "${gb} GB")
                }
            }
        }
    }

    private fun appendSensor(
        sections: MutableList<Pair<String, String>>,
        inv: JSONObject?,
        ctx: Context,
        type: Int,
    ) {
        val s = HwSpecResolver.sensorByType(inv, ctx, type)
        if (s == null) return
        val name = s.optString("name", "")
        val vendor = s.optString("vendor", "")
        if (name.isNotBlank()) sections.add("本机型号" to name)
        if (vendor.isNotBlank()) sections.add("厂商" to vendor)
        val range = s.optDouble("max_range", 0.0)
        val res = s.optDouble("resolution", 0.0)
        if (range > 0 || res > 0) {
            sections.add("量程/分辨率" to "±${HwSpecResolver.truncate(range.toString())} / ${HwSpecResolver.truncate(res.toString())}")
        }
    }

    private data class StaticEdu(val title: String, val sections: List<Pair<String, String>>)

    private val static: Map<String, StaticEdu> = mapOf(
        "accel" to edu(
            "加速度计",
            "俗称" to "加速度计、G-sensor",
            "学名" to "三轴加速度计（Accelerometer）",
            "物理元件" to "MEMS 微机电加速度传感器芯片，测量手机在 X/Y/Z 三个方向的线性加速度。",
            "典型参数" to "量程（如 ±8g）、分辨率（m/s² 或 g）、采样率（本 App 高频写入 IMU 流）。",
            "存储形式" to "imu 模组 → EventData/…/imu_DD.bin（量化二进制流，与陀螺/磁力共用）。",
            "采集口径" to "亮屏时高频采样；灭屏可降频或停采（省电）。",
        ),
        "gyro" to edu(
            "陀螺仪",
            "俗称" to "陀螺仪、角速度计",
            "学名" to "三轴陀螺仪（Gyroscope）",
            "物理元件" to "MEMS 陀螺仪，测量绕三个轴的角速度（转动快慢）。",
            "典型参数" to "量程（rad/s）、分辨率、零偏稳定性。",
            "存储形式" to "同上 imu_DD.bin。",
            "采集口径" to "与加速度计同流，用于判断手机是否静止/晃动。",
        ),
        "mag" to edu(
            "磁力计",
            "俗称" to "磁力计、电子罗盘",
            "学名" to "三轴磁力计（Magnetometer）",
            "物理元件" to "测量周围磁场强度，用于方向与部分姿态估计。",
            "典型参数" to "量程（µT）、软/硬铁校准。",
            "存储形式" to "同上 imu_DD.bin。",
            "采集口径" to "高频写入 IMU 流。",
        ),
        "light" to edu(
            "光线（环境光）",
            "俗称" to "光线、亮度、环境光",
            "学名" to "环境光传感器（ALS, Ambient Light Sensor）",
            "物理元件" to "通常是一颗独立的光电传感器（或屏下感光区），测周围照度，不是屏幕像素本身。",
            "典型参数" to "照度 lux、变化阈值触发记录。",
            "存储形式" to "env 模组 → ModuleData/env/…/events_DD.jsonl（变化时记）。",
            "采集口径" to "照度变化超过阈值才写一条，避免刷屏。",
        ),
        "prox" to edu(
            "接近传感器",
            "俗称" to "接近、距离、贴脸传感器",
            "学名" to "接近传感器（Proximity Sensor）",
            "物理元件" to "多为红外发射+接收对管，测前方物体远近（如通话贴脸、口袋接近）。",
            "典型参数" to "近/远两态或厘米级距离（厂商差异大）。",
            "存储形式" to "env 模组 jsonl，变化时记。",
            "采集口径" to "距离状态变化时记录。",
        ),
        "color" to edu(
            "色温估计",
            "俗称" to "色温",
            "学名" to "相关色温估计（CCT，常由光线传感器推算）",
            "物理元件" to "多数机型无独立「色温芯片」；本 App 在支持时用光线/色温类传感器，否则为启发式估计。",
            "典型参数" to "色温 K 值（暖光/冷光）。",
            "存储形式" to "env 模组 jsonl。",
            "采集口径" to "变化时记；与光线传感器同源或伴生。",
        ),
        "steps" to edu(
            "计步器",
            "俗称" to "步数、计步",
            "学名" to "步数计数器（Step Counter）",
            "物理元件" to "低功耗计步算法，多基于加速度计融合，系统维护累计步数。",
            "典型参数" to "累计步数（重启后可能重置，取决于系统）。",
            "存储形式" to "env 模组 jsonl，步数变化时记。",
            "采集口径" to "累计值变化才写。",
        ),
        "gps" to edu(
            "GPS / 定位",
            "俗称" to "GPS、定位",
            "学名" to "全球导航卫星系统定位（GNSS，含 GPS/北斗等）",
            "物理元件" to "GNSS 射频芯片 + 天线，接收卫星信号解算经纬度。",
            "典型参数" to "纬度、经度、精度、时间戳；需定位权限。",
            "存储形式" to "gps 模组 → ModuleData/gps/…/events_DD.jsonl（fix 事件）。",
            "采集口径" to "按模组策略采样定位点。",
        ),
        "display" to edu(
            "屏幕状态",
            "俗称" to "亮灭屏、屏幕",
            "学名" to "显示子系统状态（非独立传感器）",
            "物理元件" to "由系统 PowerManager / 显示策略上报亮灭、锁屏等逻辑状态。",
            "典型参数" to "亮/灭、锁屏/开锁、时间戳。",
            "存储形式" to "device 模组 jsonl。",
            "采集口径" to "状态变化即记。",
        ),
        "battery" to edu(
            "电池",
            "俗称" to "电量、电池",
            "学名" to "电池管理系统（BMS）状态",
            "物理元件" to "锂电芯 + 电量计 IC；上报百分比、充电状态等。",
            "典型参数" to "电量%、充电/放电、技术类型（Li-ion 等）。",
            "存储形式" to "device 模组 jsonl。",
            "采集口径" to "变化或周期快照。",
        ),
        "vibrate" to edu(
            "振动马达",
            "俗称" to "振动、震动",
            "学名" to "振动器（Vibrator / Haptic）",
            "物理元件" to "转子马达或线性谐振马达（LRA），用于触觉反馈。",
            "典型参数" to "忙/闲、开关状态（非采集振动波形）。",
            "存储形式" to "device 模组 jsonl。",
            "采集口径" to "占用状态变化时记。",
        ),
        "nfc" to edu(
            "NFC",
            "俗称" to "NFC、近场",
            "学名" to "近场通信（Near Field Communication）",
            "物理元件" to "NFC 控制器芯片 + 天线线圈。",
            "典型参数" to "适配器是否可用、开/关。",
            "存储形式" to "radio 模组 jsonl。",
            "采集口径" to "状态变化时记。",
        ),
        "ir" to edu(
            "红外发射",
            "俗称" to "红外、IR",
            "学名" to "红外发射器（Consumer IR）",
            "物理元件" to "红外 LED，可用于遥控等（非测温红外相机）。",
            "典型参数" to "是否具备发射器、开/关。",
            "存储形式" to "radio 模组 jsonl。",
            "采集口径" to "状态变化时记。",
        ),
        "camera" to edu(
            "相机占用",
            "俗称" to "相机、摄像头",
            "学名" to "相机子系统占用状态",
            "物理元件" to "前后置 CMOS 传感器模组；本 App 只记是否被占用，不录画面。",
            "典型参数" to "镜头 ID、分辨率、焦距（来自 inventory）。",
            "存储形式" to "media 模组 jsonl。",
            "采集口径" to "相机被应用占用/释放时记。",
        ),
        "audio" to edu(
            "音频占用",
            "俗称" to "音频、播放录音",
            "学名" to "音频子系统占用",
            "物理元件" to "扬声器、麦克风、蓝牙音频通路；不采集 PCM 波形。",
            "典型参数" to "播放/录音是否活跃、music_active 等。",
            "存储形式" to "media 模组 jsonl。",
            "采集口径" to "占用状态变化时记。",
        ),
        "wifi" to edu(
            "WiFi",
            "俗称" to "WiFi、无线局域网",
            "学名" to "IEEE 802.11 无线局域网",
            "物理元件" to "WiFi 射频芯片与天线。",
            "典型参数" to "连接/扫描状态、SSID 等（按模组策略）。",
            "存储形式" to "radio 模组 jsonl。",
            "采集口径" to "状态变化时记。",
        ),
        "bt" to edu(
            "蓝牙",
            "俗称" to "蓝牙、BT",
            "学名" to "Bluetooth 无线个人局域网",
            "物理元件" to "蓝牙 SoC / 组合芯片中的 BT 射频。",
            "典型参数" to "开关、配对/连接状态。",
            "存储形式" to "radio 模组 jsonl。",
            "采集口径" to "状态变化时记。",
        ),
        "cell" to edu(
            "蜂窝网络",
            "俗称" to "蜂窝、移动网络、基带",
            "学名" to "蜂窝移动通信（LTE/5G 等）",
            "物理元件" to "基带处理器 + 蜂窝射频前端。",
            "典型参数" to "信号、数据连接状态等。",
            "存储形式" to "radio 模组 jsonl。",
            "采集口径" to "状态变化时记。",
        ),
        "perf" to edu(
            "系统性能",
            "俗称" to "CPU、内存、温度",
            "学名" to "操作系统性能与热状态",
            "物理元件" to "SoC、RAM、温度传感器（板载/PMIC）。",
            "典型参数" to "CPU 负载、内存、温度阈值事件。",
            "存储形式" to "perf 模组 jsonl，约 5s 粒度。",
            "采集口径" to "超阈或签名变化时写。",
        ),
        "app_focus" to edu(
            "前台应用",
            "俗称" to "前台 App、焦点应用",
            "学名" to "前台窗口 / 焦点应用（Accessibility）",
            "物理元件" to "无独立传感器；通过无障碍服务读系统窗管焦点。",
            "典型参数" to "包名、切换时间戳。",
            "存储形式" to "app_focus 模组 jsonl；需无障碍权限。",
            "采集口径" to "焦点变化时记。",
        ),
        "touch" to edu(
            "点击交互",
            "俗称" to "点击、触摸目标",
            "学名" to "语义化触摸事件（Accessibility）",
            "物理元件" to "触摸屏控制器；本 App 记「点了哪个控件」而非原始坐标轨迹。",
            "典型参数" to "控件类名/文本摘要、时间戳。",
            "存储形式" to "touch 模组 jsonl；需无障碍。",
            "采集口径" to "交互级点击事件。",
        ),
        "ui_map" to edu(
            "窗栈 / 界面结构",
            "俗称" to "窗栈、窗口、界面树",
            "学名" to "窗口层级与浅层控件树（Accessibility + 显示几何）",
            "物理元件" to "软件抽象：显示器布局 + 无障碍节点树。",
            "典型参数" to "窗标题、包名、显示器 ID、浅树快照。",
            "存储形式" to "ui_map 模组 jsonl；需无障碍。",
            "采集口径" to "焦点切换或结构变化时记。",
        ),
        "hw" to edu(
            "硬件清单",
            "俗称" to "硬件扫描、inventory",
            "学名" to "启动期硬件清单（Hardware Inventory）",
            "物理元件" to "汇总本机传感器、相机、SoC 等静态能力快照。",
            "典型参数" to "传感器列表、相机表、build 字段。",
            "存储形式" to "control/hw_inventory.json + hw 模组 jsonl 事件。",
            "采集口径" to "启动扫描；签名不变可只记「无变化」。",
        ),
        "cat_imu" to edu(
            "三轴空间类",
            "分类说明" to "高频三轴惯性数据，共用一条 IMU 二进制流。",
            "存储形式" to "imu_DD.bin（OTIM 量化流，非 jsonl）。",
            "包含" to "加速度计、陀螺仪、磁力计。",
        ),
        "cat_env" to edu(
            "环境传感类",
            "分类说明" to "环境量与低功耗计步，变化触发写入。",
            "存储形式" to "ModuleData/env/…/events_DD.jsonl。",
            "包含" to "光线、接近、色温估计、计步。",
        ),
        "cat_gps" to edu(
            "定位类",
            "分类说明" to "室外卫星定位点列。",
            "存储形式" to "ModuleData/gps/…/events_DD.jsonl。",
            "包含" to "GPS/GNSS 经纬度 fix。",
        ),
        "cat_device" to edu(
            "设备状态类",
            "分类说明" to "手机本体状态，无高频波形。",
            "存储形式" to "ModuleData/device/…/events_DD.jsonl。",
            "包含" to "屏幕、电池、振动占用。",
        ),
        "cat_radio" to edu(
            "无线连通类",
            "分类说明" to "射频与近场连接状态。",
            "存储形式" to "ModuleData/radio/…/events_DD.jsonl。",
            "包含" to "WiFi、蓝牙、蜂窝、NFC、红外。",
        ),
        "cat_media" to edu(
            "媒体占用类",
            "分类说明" to "多媒体子系统是否被占用（不采内容）。",
            "存储形式" to "ModuleData/media/…/events_DD.jsonl。",
            "包含" to "相机、音频播放/录音占用。",
        ),
        "cat_perf" to edu(
            "系统性能类",
            "分类说明" to "SoC 负载与热状态。",
            "存储形式" to "ModuleData/perf/…/events_DD.jsonl。",
            "包含" to "CPU/内存/温度等。",
        ),
        "cat_a11y" to edu(
            "无障碍交互类",
            "分类说明" to "依赖无障碍服务的界面语义数据。",
            "存储形式" to "各模组独立 jsonl（app_focus / touch / ui_map）。",
            "包含" to "前台应用、点击、窗栈。",
        ),
        "cat_hw" to edu(
            "硬件快照类",
            "分类说明" to "启动期硬件能力扫描。",
            "存储形式" to "control/hw_inventory.json + hw jsonl。",
            "包含" to "硬件清单模组。",
        ),
        "default" to edu(
            "采集项",
            "说明" to "暂无详细科普条目。",
        ),
    )

    private fun edu(title: String, vararg pairs: Pair<String, String>): StaticEdu =
        StaticEdu(title, pairs.toList())
}
