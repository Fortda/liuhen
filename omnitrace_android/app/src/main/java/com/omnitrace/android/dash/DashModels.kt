package com.omnitrace.android.dash

data class AppLane(
    val pkg: String,
    val label: String,
    val spans: List<Span>,
    val durationMs: Long,
)

data class TimelineModel(
    val t0: Long,
    val t1: Long,
    val far: Boolean,
    val recording: List<Span>,
    val screenOn: List<Span>,
    val unlocked: List<Span>,
    val audio: List<Span>,
    val lanes: List<AppLane>,
    val noFocus: List<Span> = emptyList(),
    val farNote: String?,
)

data class AppDur(
    val pkg: String,
    val label: String,
    val durationMs: Long,
)

enum class UsageGrain {
    HOUR,
    DAY,
    WEEK,
    MONTH,
}

data class DayUsage(
    val dayStart: Long,
    val durationMs: Long,
)

data class UsageSeries(
    val bars: List<DayUsage>,
    val yMaxMs: Long,
    val grain: UsageGrain,
    val note: String?,
)

data class MonthUsage(
    val year: Int,
    val month: Int, // 1-12
    val durationMs: Long,
)

data class ScreenReport(
    val todayMs: Long,
    val week: List<DayUsage>,
    val monthDays: List<DayUsage>,
    val monthTotalMs: Long,
    val months: List<MonthUsage>,
    val apps: List<AppDur>,
)

data class GpsPt(
    val ts: Long,
    val lat: Double,
    val lon: Double,
)

data class Stay(
    val start: Long,
    val end: Long,
    val lat: Double,
    val lon: Double,
    val address: String?,
)

data class PlaceModel(
    val stays: List<Stay>,
    val path: List<Pair<Double, Double>>,
    val note: String?,
)

data class MorningDay(
    val dayStart: Long,
    val unlockTs: Long,
    val apps: List<AppDur>,
)

enum class SleepGuessMode {
    PHONE_ONLY,
    PHONE_AND_PC,
}

data class SleepGuessDay(
    val dayStart: Long,
    val wakeTs: Long,
    val sleepEndTs: Long,
    val mode: SleepGuessMode,
    val apps: List<AppDur>,
)

/** 睡眠页活跃条：5 分钟格双色 */
data class SleepActivityModel(
    val t0: Long,
    val t1: Long,
    val binMs: Long,
    val phoneActive: BooleanArray,
    val pcActive: BooleanArray,
    val wakeMarks: LongArray,
)

data class StageWin(
    val l: Int,
    val t: Int,
    val r: Int,
    val b: Int,
    val title: String,
    val pkg: String,
    val focused: Boolean,
    val type: Int,
)

data class StageFrame(
    val ts: Long,
    val dw: Int,
    val dh: Int,
    val wins: List<StageWin>,
)
