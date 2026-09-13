package com.omnitrace.android.dash

object DashCaliber {
    const val MIN_VIEW_SPAN_MS = 80L
    const val INITIAL_PAST_MS = 2L * 60L * 60L * 1000L
    const val NEAR_SPAN_MS = 7L * 24L * 60L * 60L * 1000L
    const val FOCUS_CAP_MS = 2L * 60L * 60L * 1000L
    const val STAY_SPLIT_M = 150.0
    const val STAY_GAP_MS = 5L * 60L * 1000L
    const val STAY_MIN_MS = 5L * 60L * 1000L
  /** 睡眠猜测：清晨粗起床搜索起点（本地时 03:00）。 */
    const val WAKE_SEARCH_START_HOUR = 3
    /** 睡眠猜测：清晨粗起床搜索终点（本地时 12:00）。 */
    const val WAKE_SEARCH_END_HOUR = 12
    const val WAKE_MARGIN_MS = 30L * 60L * 1000L
    const val WAKE_POST_MS = 30L * 60L * 1000L
    /** PC 键鼠连续空闲 ≥ 此值 ≈ 电脑闲着/可能熄屏（代理口径）。 */
    const val PC_IDLE_MS = 10L * 60L * 1000L
    /** 睡眠活跃条 / AFK 同宽：5 分钟格 */
    const val ACTIVE_BIN_MS = 5L * 60L * 1000L
    const val IMU_STILL_BUCKET_MS = 60_000L
    /** 陀螺量化值（rad/s×1000）低于此视为静止桶。 */
    const val IMU_STILL_GYRO_MAX = 900
    const val GPS_SAMPLE_DAYS = 14
    const val APP_LANE_MAX = 8
    const val HEALTH_MODULE = "device"
    const val HOUR_MS = 3_600_000L
    /** 小时刻度柱太多会拖垮横滑，自选跨度截到这么多本地日。 */
    const val USAGE_HOUR_MAX_DAYS = 21

    fun niceUsageY(ms: Long): Long {
        if (ms <= 0L) return HOUR_MS
        val need = (ms + HOUR_MS - 1) / HOUR_MS
        val steps = longArrayOf(1, 2, 3, 4, 6, 8, 10, 12, 16, 18, 24, 30, 36, 48, 60, 72, 96, 120, 168, 240, 336, 480, 720)
        for (s in steps) {
            if (s >= need) return s * HOUR_MS
        }
        return ((need + 23) / 24) * 24 * HOUR_MS
    }

    /** 平移/缩放只挡溢出，不挡数据或现在。 */
    const val TS_ABS_MAX = Long.MAX_VALUE / 8

    /**
     * 视窗外左右各垫一段，滑过去时条已经在模型里。
     * 近景 JSONL 总窗不超过 [NEAR_SPAN_MS]；远景只列日文件，可垫满一个视窗宽。
     * 远近判定用视窗跨度，不用这段垫后的跨度。
     */
    fun paddedLoadRange(view0: Long, view1: Long): Pair<Long, Long> {
        val span = (view1 - view0).coerceAtLeast(1L)
        val far = span > NEAR_SPAN_MS
        val pad = if (far) {
            span
        } else {
            val budget = (NEAR_SPAN_MS - span).coerceAtLeast(0L)
            minOf(span, budget / 2)
        }
        val a = if (pad > 0 && view0 < -TS_ABS_MAX + pad) -TS_ABS_MAX else view0 - pad
        val b = if (pad > 0 && view1 > TS_ABS_MAX - pad) TS_ABS_MAX else view1 + pad
        return a to b
    }

    fun lodFar(view0: Long, view1: Long): Boolean = (view1 - view0) > NEAR_SPAN_MS
}
