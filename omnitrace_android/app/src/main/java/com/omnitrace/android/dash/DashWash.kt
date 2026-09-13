package com.omnitrace.android.dash

import android.content.Context
import android.content.pm.PackageManager
import android.location.Geocoder
import org.json.JSONObject
import java.io.File
import java.util.Locale
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

object DashWash {
    fun timeline(ctx: Context, root: File, t0: Long, t1: Long, now: Long, lodSpan: Long = t1 - t0): TimelineModel {
        val rec = SpanUtil.clip(HealthSpans.recording(root, now), t0, t1)
        val far = lodSpan > DashCaliber.NEAR_SPAN_MS
        if (far) {
            val days = DashIo.listDayFiles(root, "device", t0, t1)
            val mediaDays = DashIo.listDayFiles(root, "media", t0, t1).map { it.dayStart }.toHashSet()
            val screen = days.map { Span(maxOf(it.dayStart, t0), minOf(it.dayEnd, t1)) }
            val audio = days.filter { mediaDays.contains(it.dayStart) }
                .map { Span(maxOf(it.dayStart, t0), minOf(it.dayEnd, t1)) }
            val possible = SpanUtil.intersect(rec, screen)
            return TimelineModel(
                t0 = t0,
                t1 = t1,
                far = true,
                recording = rec,
                screenOn = possible,
                unlocked = emptyList(),
                audio = SpanUtil.intersect(rec, audio),
                lanes = emptyList(),
                noFocus = SpanUtil.subtract(listOf(Span(t0, t1)), possible),
                farNote = "跨度大于 7 天：叠色/音频按日粗占用；缩到 7 日内看开锁与程序分行。",
            )
        }
        val look0 = t0 - 36L * 60L * 60L * 1000L
        val device = DashIo.readEventsInRange(root, "device", look0, t1)
        val media = DashIo.readEventsInRange(root, "media", look0, t1)
        val focus = DashIo.readEventsInRange(root, "app_focus", look0, t1)
        val screenOn = SpanUtil.clip(screenSpans(device, t1.coerceAtMost(now)), t0, t1)
        val unlocked = SpanUtil.clip(unlockSpans(device, t1.coerceAtMost(now)), t0, t1)
        val audio = SpanUtil.clip(audioSpans(media, t1.coerceAtMost(now)), t0, t1)
        val active = SpanUtil.intersect(screenOn, unlocked)
        val lanes = appLanes(ctx, focus, active, t0, t1.coerceAtMost(now))
        val recScreen = SpanUtil.intersect(rec, screenOn)
        val recUnlock = SpanUtil.intersect(recScreen, unlocked)
        val a11yOn = a11yOnSpans(focus, t1.coerceAtMost(now))
        val possible = SpanUtil.intersect(recUnlock, a11yOn)
        return TimelineModel(
            t0 = t0,
            t1 = t1,
            far = false,
            recording = rec,
            screenOn = recScreen,
            unlocked = recUnlock,
            audio = SpanUtil.intersect(rec, audio),
            lanes = lanes,
            noFocus = SpanUtil.subtract(listOf(Span(t0, t1)), possible),
            farNote = null,
        )
    }

    fun screenTime(ctx: Context, root: File, t0: Long, t1: Long, now: Long): List<AppDur> {
        val look0 = t0 - 36L * 60L * 60L * 1000L
        val device = DashIo.readEventsInRange(root, "device", look0, t1)
        val focus = DashIo.readEventsInRange(root, "app_focus", look0, t1)
        val screenOn = SpanUtil.clip(screenSpans(device, t1.coerceAtMost(now)), t0, t1)
        val unlocked = SpanUtil.clip(unlockSpans(device, t1.coerceAtMost(now)), t0, t1)
        val active = SpanUtil.intersect(screenOn, unlocked)
        return appLanes(ctx, focus, active, t0, t1.coerceAtMost(now)).map {
            AppDur(it.pkg, it.label, it.durationMs)
        }
    }

    fun screenReport(ctx: Context, root: File, appFrom: Long, appTo: Long, now: Long): ScreenReport {
        val today0 = DashIo.startOfLocalDay(now)
        val tomorrow = DashIo.addLocalDays(today0, 1)
        val week0 = DashIo.addLocalDays(today0, -6)
        // 近三十天（含今日共 30 个本地日）；近十二月柱仍按日历月
        val recent30_0 = DashIo.addLocalDays(today0, -29)
        val month0 = DashIo.startOfLocalMonth(now)
        val months0 = DashIo.addLocalMonths(month0, -11)
        val scan0 = minOf(months0, recent30_0, appFrom)
        val scan1 = maxOf(tomorrow, appTo)
        val look0 = scan0 - 36L * 60L * 60L * 1000L
        val rec = HealthSpans.recording(root, now)
        val device = DashIo.readEventsInRange(root, "device", look0, scan1)
        val cap = scan1.coerceAtMost(now)
        val screenOn = screenSpans(device, cap)
        val unlocked = unlockSpans(device, cap)
        val usage = SpanUtil.intersect(rec, SpanUtil.intersect(screenOn, unlocked))
        fun sum(a: Long, b: Long) = SpanUtil.clip(usage, a, b).sumOf { it.duration }
        val days = ArrayList<DayUsage>()
        var d = months0
        while (d < tomorrow) {
            val n = DashIo.addLocalDays(d, 1)
            days.add(DayUsage(d, sum(d, n.coerceAtMost(tomorrow))))
            d = n
        }
        val week = (0 until 7).map { i ->
            val a = DashIo.addLocalDays(week0, i)
            days.find { it.dayStart == a } ?: DayUsage(a, 0L)
        }
        val monthDays = days.filter { it.dayStart >= recent30_0 }
        val months = ArrayList<MonthUsage>()
        var m0 = months0
        while (m0 <= month0) {
            val m1 = DashIo.addLocalMonths(m0, 1)
            val cal = java.util.Calendar.getInstance()
            cal.timeInMillis = m0
            months.add(
                MonthUsage(
                    cal.get(java.util.Calendar.YEAR),
                    cal.get(java.util.Calendar.MONTH) + 1,
                    days.filter { it.dayStart >= m0 && it.dayStart < m1 }.sumOf { it.durationMs },
                ),
            )
            m0 = m1
        }
        return ScreenReport(
            todayMs = sum(today0, tomorrow),
            week = week,
            monthDays = monthDays,
            monthTotalMs = monthDays.sumOf { it.durationMs },
            months = months,
            apps = screenTime(ctx, root, appFrom, appTo, now),
        )
    }

    /** 在录 ∩ 亮屏 ∩ 开锁，与统计图总时长同一口径。 */
    fun usageSpans(root: File, t0: Long, t1: Long, now: Long): List<Span> {
        if (t1 <= t0) return emptyList()
        val look0 = t0 - 36L * 60L * 60L * 1000L
        val rec = HealthSpans.recording(root, now)
        val device = DashIo.readEventsInRange(root, "device", look0, t1)
        val cap = t1.coerceAtMost(now)
        val screenOn = screenSpans(device, cap)
        val unlocked = unlockSpans(device, cap)
        return SpanUtil.clip(SpanUtil.intersect(rec, SpanUtil.intersect(screenOn, unlocked)), t0, cap)
    }

    fun usageSeries(root: File, t0: Long, t1: Long, now: Long, grain: UsageGrain): UsageSeries {
        var a = t0
        var b = t1.coerceAtMost(now)
        if (b <= a) {
            return UsageSeries(emptyList(), DashCaliber.HOUR_MS, grain, null)
        }
        var note: String? = null
        if (grain == UsageGrain.HOUR) {
            val capEnd = DashIo.addLocalDays(a, DashCaliber.USAGE_HOUR_MAX_DAYS)
            if (b > capEnd) {
                b = capEnd
                note = "小时刻度最多 ${DashCaliber.USAGE_HOUR_MAX_DAYS} 天，已截到起点起 ${DashCaliber.USAGE_HOUR_MAX_DAYS} 天。"
            }
        }
        val usage = usageSpans(root, a, b, now)
        fun sum(x: Long, y: Long) = SpanUtil.clip(usage, x, y).sumOf { it.duration }
        val bars = ArrayList<DayUsage>()
        var t = DashIo.alignGrain(a, grain)
        val maxN = when (grain) {
            UsageGrain.HOUR -> DashCaliber.USAGE_HOUR_MAX_DAYS * 24
            UsageGrain.DAY -> 400
            UsageGrain.WEEK -> 80
            UsageGrain.MONTH -> 36
        }
        var n = 0
        while (t < b && n < maxN) {
            val n1 = DashIo.addGrain(t, grain)
            bars.add(DayUsage(t, sum(maxOf(t, a), minOf(n1, b))))
            t = n1
            n++
        }
        val yMax = if (grain == UsageGrain.HOUR) {
            DashCaliber.HOUR_MS
        } else {
            DashCaliber.niceUsageY(bars.maxOfOrNull { it.durationMs } ?: 0L)
        }
        return UsageSeries(bars, yMax, grain, note)
    }

    fun places(ctx: Context, root: File, t0: Long, t1: Long): PlaceModel {
        val days = DashIo.listDayFiles(root, "gps", t0, t1)
        val dayCount = days.size
        val pts = ArrayList<GpsPt>()
        for (df in days) {
            for (ev in DashIo.readEvents(df.file)) {
                if (ev.optString("kind") != "fix") continue
                val ts = ev.optLong("ts", -1L)
                if (ts < t0 || ts >= t1) continue
                val p = ev.optJSONObject("payload") ?: continue
                pts.add(
                    GpsPt(
                        ts,
                        p.optDouble("lat", Double.NaN),
                        p.optDouble("lon", Double.NaN),
                    ),
                )
            }
        }
        val valid = pts.filter { it.lat.isFinite() && it.lon.isFinite() }.sortedBy { it.ts }
        if (valid.isEmpty()) {
            return PlaceModel(emptyList(), emptyList(), "这段没有 GPS 点（未授权或未采集）。")
        }
        val pathPts = if (dayCount > DashCaliber.GPS_SAMPLE_DAYS) {
            valid.groupBy { DashIo.startOfLocalDay(it.ts) }.values.map { g -> g.last() }
        } else {
            valid
        }
        val path = pathPts.map { it.lat to it.lon }
        val stays = clusterStays(valid)
        // 地址反查慢：先交折线/停留点，调用方再异步补 address
        val note = if (dayCount > DashCaliber.GPS_SAMPLE_DAYS) {
            "折线按日抽样；停留仍用全部点。"
        } else {
            null
        }
        return PlaceModel(stays, path, note)
    }

    fun labelStays(ctx: Context, stays: List<Stay>): List<Stay> {
        if (stays.isEmpty()) return stays
        val geo = try {
            if (Geocoder.isPresent()) Geocoder(ctx, Locale.getDefault()) else null
        } catch (_: Exception) {
            null
        }
        return stays.map { s ->
            if (!s.address.isNullOrBlank()) s
            else s.copy(address = reverse(geo, s.lat, s.lon))
        }
    }

    fun track(root: File, t0: Long, t1: Long): List<GpsPt> {
        val days = DashIo.listDayFiles(root, "gps", t0, t1)
        val pts = ArrayList<GpsPt>()
        for (df in days) {
            for (ev in DashIo.readEvents(df.file)) {
                if (ev.optString("kind") != "fix") continue
                val ts = ev.optLong("ts", -1L)
                if (ts < t0 || ts >= t1) continue
                val p = ev.optJSONObject("payload") ?: continue
                pts.add(GpsPt(ts, p.optDouble("lat", Double.NaN), p.optDouble("lon", Double.NaN)))
            }
        }
        return pts.filter { it.lat.isFinite() && it.lon.isFinite() }.sortedBy { it.ts }
    }

    fun mornings(ctx: Context, root: File, t0: Long, t1: Long, now: Long): List<MorningDay> {
        return sleepGuessDays(ctx, root, t0, t1, now).map {
            MorningDay(it.dayStart, it.wakeTs, it.apps)
        }
    }

    fun sleepGuessDays(ctx: Context, root: File, t0: Long, t1: Long, now: Long): List<SleepGuessDay> {
        val look0 = t0 - 36L * 60L * 60L * 1000L
        val deviceFiles = DashIo.listDayFiles(root, "device", t0, t1)
        if (deviceFiles.isEmpty()) return emptyList()
        val pcLinked = PcIdleSpans.hasLinkedData(root)
        val pcHost = PcIdleSpans.linkedHost(root)
        val device = DashIo.readEventsInRange(root, "device", look0, t1)
        val focus = DashIo.readEventsInRange(root, "app_focus", look0, t1)
        val hourMs = 60L * 60L * 1000L
        val out = ArrayList<SleepGuessDay>()
        for (df in deviceFiles) {
            val searchStart = df.dayStart + DashCaliber.WAKE_SEARCH_START_HOUR * hourMs
            val searchEnd = minOf(
                df.dayStart + DashCaliber.WAKE_SEARCH_END_HOUR * hourMs,
                df.dayEnd,
            )
            if (searchEnd <= searchStart) continue
            val rough = firstUnlock(device, searchStart, searchEnd)
                ?: firstScreenOn(device, searchStart, searchEnd)
                ?: continue
            val margin = DashCaliber.WAKE_MARGIN_MS
            val win0 = maxOf(rough - margin, df.dayStart)
            val win1 = minOf(rough + margin, df.dayEnd, t1, now)
            val screenOff = invertSpans(screenSpans(device, df.dayEnd), df.dayStart, df.dayEnd)
            var sleep = SpanUtil.intersect(screenOff, ImuBinReader.stillSpans(root, df.dayStart, df.dayEnd))
            if (pcLinked && pcHost != null) {
                sleep = SpanUtil.intersect(sleep, PcIdleSpans.idleSpans(root, df.dayStart, df.dayEnd, pcHost))
            }
            val sleepEnd = findLastSleepEnd(sleep, win0, win1, rough) ?: rough
            val wakeTs = sleepEnd
            val postEnd = minOf(wakeTs + DashCaliber.WAKE_POST_MS, df.dayEnd, t1, now)
            if (postEnd <= wakeTs) continue
            val screenOn = SpanUtil.clip(screenSpans(device, postEnd), wakeTs, postEnd)
            val unlocked = SpanUtil.clip(unlockSpans(device, postEnd), wakeTs, postEnd)
            val active = SpanUtil.intersect(screenOn, unlocked)
            val apps = appLanes(ctx, focus, active, wakeTs, postEnd)
            val mode = if (pcLinked) SleepGuessMode.PHONE_AND_PC else SleepGuessMode.PHONE_ONLY
            out.add(
                SleepGuessDay(
                    dayStart = df.dayStart,
                    wakeTs = wakeTs,
                    sleepEndTs = sleepEnd,
                    mode = mode,
                    apps = apps.map { AppDur(it.pkg, it.label, it.durationMs) },
                ),
            )
        }
        return out
    }

    fun sleepActivity(root: File, t0: Long, t1: Long, wakeMarks: LongArray): SleepActivityModel {
        val bin = DashCaliber.ACTIVE_BIN_MS
        val act0 = (t0 / bin) * bin
        val n = (((t1 - act0 + bin - 1) / bin).toInt()).coerceIn(0, 14 * 288)
        val phone = BooleanArray(n)
        val pc = BooleanArray(n)
        val pcHost = PcIdleSpans.linkedHost(root)
        var d = DashIo.startOfLocalDay(act0)
        val end = t1
        while (d < end) {
            val dayEnd = DashIo.addLocalDays(d, 1)
            // PC
            val pcDay = PcIdleSpans.active5MinBins(root, d, pcHost)
            for (i in pcDay.indices) {
                if (!pcDay[i]) continue
                val ts = d + i * bin
                if (ts < act0 || ts >= end) continue
                val idx = ((ts - act0) / bin).toInt()
                if (idx in pc.indices) pc[idx] = true
            }
            // GPS fix
            for (ev in DashIo.readEventsInRange(root, "gps", d, dayEnd)) {
                if (ev.optString("kind") != "fix") continue
                val ts = ev.optLong("ts", -1L)
                if (ts < act0 || ts >= end) continue
                val idx = ((ts - act0) / bin).toInt()
                if (idx in phone.indices) phone[idx] = true
            }
            // IMU 非静止桶 → 黄（无 IMU 文件则不画，避免整日全黄）
            val still = ImuBinReader.stillSpans(root, d, dayEnd)
            if (still.isNotEmpty()) {
                var t = d
                while (t < dayEnd && t < end) {
                    val inStill = still.any { t >= it.start && t < it.end }
                    if (!inStill) {
                        val ts = t.coerceAtLeast(act0)
                        if (ts >= act0 && ts < end) {
                            val idx = ((ts - act0) / bin).toInt()
                            if (idx in phone.indices) phone[idx] = true
                        }
                    }
                    t += DashCaliber.IMU_STILL_BUCKET_MS
                }
            }
            d = dayEnd
        }
        return SleepActivityModel(act0, act0 + n * bin, bin, phone, pc, wakeMarks)
    }

    private fun invertSpans(onSpans: List<Span>, dayStart: Long, dayEnd: Long): List<Span> {
        if (dayEnd <= dayStart) return emptyList()
        return SpanUtil.subtract(listOf(Span(dayStart, dayEnd)), onSpans)
    }

    private fun firstScreenOn(events: List<JSONObject>, from: Long, to: Long): Long? {
        var best: Long? = null
        for (ev in events) {
            if (ev.optString("kind") != "screen") continue
            val ts = ev.optLong("ts")
            if (ts < from || ts >= to) continue
            val on = ev.optJSONObject("payload")?.optBoolean("on", false) ?: false
            if (on && (best == null || ts < best)) best = ts
        }
        return best
    }

    private fun findLastSleepEnd(sleep: List<Span>, win0: Long, win1: Long, rough: Long): Long? {
        val clipped = SpanUtil.clip(sleep, win0, win1)
        if (clipped.isEmpty()) return null
        val before = clipped.filter { it.end <= rough }.maxByOrNull { it.end }
        if (before != null) return before.end
        return clipped.maxByOrNull { it.end }?.end
    }

    private fun screenSpans(events: List<JSONObject>, openEnd: Long): List<Span> {
        val edges = ArrayList<Pair<Long, Boolean>>()
        for (ev in events) {
            if (ev.optString("kind") != "screen") continue
            val on = ev.optJSONObject("payload")?.optBoolean("on", false) ?: false
            edges.add(ev.optLong("ts") to on)
        }
        return SpanUtil.fromEdges(edges, openEnd)
    }

    private fun unlockSpans(events: List<JSONObject>, openEnd: Long): List<Span> {
        val edges = ArrayList<Pair<Long, Boolean>>()
        for (ev in events) {
            val ts = ev.optLong("ts")
            when (ev.optString("kind")) {
                "user_present" -> edges.add(ts to true)
                "keyguard" -> {
                    val locked = ev.optJSONObject("payload")?.optBoolean("locked", true) ?: true
                    edges.add(ts to !locked)
                }
                "screen" -> {
                    val on = ev.optJSONObject("payload")?.optBoolean("on", false) ?: false
                    if (!on) edges.add(ts to false)
                }
            }
        }
        return SpanUtil.fromEdges(edges, openEnd)
    }

    private fun audioSpans(events: List<JSONObject>, openEnd: Long): List<Span> {
        val edges = ArrayList<Pair<Long, Boolean>>()
        for (ev in events) {
            if (ev.optString("kind") != "audio_playback") continue
            val p = ev.optJSONObject("payload") ?: continue
            val n = p.optInt("n", 0)
            val music = p.optBoolean("music_active", false)
            edges.add(ev.optLong("ts") to (n > 0 || music))
        }
        return SpanUtil.fromEdges(edges, openEnd)
    }

    private fun appLanes(
        ctx: Context,
        events: List<JSONObject>,
        active: List<Span>,
        t0: Long,
        t1: Long,
    ): List<AppLane> {
        val segs = ArrayList<Pair<String, Span>>()
        var lastPkg: String? = null
        var lastTs = -1L
        fun close(at: Long) {
            val pkg = lastPkg ?: return
            val a = lastTs
            if (a < 0 || at <= a) return
            val cap = minOf(at, a + DashCaliber.FOCUS_CAP_MS)
            segs.add(pkg to Span(a, cap))
        }
        for (ev in events) {
            if (ev.optString("kind") != "focus_change") continue
            val ts = ev.optLong("ts")
            if (ts < t0 - DashCaliber.FOCUS_CAP_MS) continue
            close(ts)
            val pkg = ev.optJSONObject("payload")?.optString("package").orEmpty()
            lastPkg = pkg
            lastTs = ts
        }
        close(t1)
        val byPkg = LinkedHashMap<String, ArrayList<Span>>()
        for ((pkg, sp) in segs) {
            if (pkg.isEmpty()) continue
            val clipped = SpanUtil.intersect(listOf(sp), active)
            if (clipped.isEmpty()) continue
            byPkg.getOrPut(pkg) { ArrayList() }.addAll(clipped)
        }
        return byPkg.map { (pkg, spans) ->
            val merged = SpanUtil.merge(SpanUtil.clip(spans, t0, t1))
            val dur = merged.sumOf { it.duration }
            AppLane(pkg, appLabel(ctx, pkg), merged, dur)
        }.filter { it.durationMs > 0 }.sortedByDescending { it.durationMs }
    }

    private fun a11yOnSpans(events: List<JSONObject>, openEnd: Long): List<Span> {
        val covered = ArrayList<Span>()
        var lastTs = -1L
        for (ev in events) {
            if (ev.optString("kind") != "focus_change") continue
            val ts = ev.optLong("ts")
            if (lastTs >= 0 && ts > lastTs) {
                covered.add(Span(lastTs, minOf(ts, lastTs + DashCaliber.FOCUS_CAP_MS)))
            }
            lastTs = ts
        }
        if (lastTs >= 0 && openEnd > lastTs) {
            covered.add(Span(lastTs, minOf(openEnd, lastTs + DashCaliber.FOCUS_CAP_MS)))
        }
        return SpanUtil.merge(covered)
    }

    private fun firstUnlock(events: List<JSONObject>, from: Long, to: Long): Long? {
        var best: Long? = null
        for (ev in events) {
            val ts = ev.optLong("ts")
            if (ts < from || ts >= to) continue
            val unlock = when (ev.optString("kind")) {
                "user_present" -> true
                "keyguard" -> ev.optJSONObject("payload")?.optBoolean("locked", true) == false
                else -> false
            }
            if (unlock && (best == null || ts < best)) best = ts
        }
        return best
    }

    private fun clusterStays(pts: List<GpsPt>): List<Stay> {
        if (pts.isEmpty()) return emptyList()
        val out = ArrayList<Stay>()
        var i = 0
        while (i < pts.size) {
            var j = i
            var slat = pts[i].lat
            var slon = pts[i].lon
            var n = 1
            while (j + 1 < pts.size) {
                val nxt = pts[j + 1]
                val gap = nxt.ts - pts[j].ts
                val dist = haversineM(pts[i].lat, pts[i].lon, nxt.lat, nxt.lon)
                if (gap > DashCaliber.STAY_GAP_MS || dist > DashCaliber.STAY_SPLIT_M) break
                j++
                slat += nxt.lat
                slon += nxt.lon
                n++
            }
            val dur = pts[j].ts - pts[i].ts
            if (dur >= DashCaliber.STAY_MIN_MS) {
                out.add(Stay(pts[i].ts, pts[j].ts, slat / n, slon / n, null))
            }
            i = maxOf(j + 1, i + 1)
        }
        return out
    }

    fun stageFrames(root: File, t0: Long, t1: Long): List<StageFrame> {
        val look0 = t0 - 36L * 60L * 60L * 1000L
        val events = DashIo.readEventsInRange(root, "ui_map", look0, t1)
        var dw = 1080
        var dh = 2400
        val out = ArrayList<StageFrame>()
        for (ev in events) {
            val kind = ev.optString("kind")
            val ts = ev.optLong("ts", -1L)
            val p = ev.optJSONObject("payload") ?: continue
            if (kind == "display_setup") {
                val arr = p.optJSONArray("displays") ?: continue
                if (arr.length() == 0) continue
                val d0 = arr.optJSONObject(0) ?: continue
                dw = d0.optInt("w", dw).coerceAtLeast(1)
                dh = d0.optInt("h", dh).coerceAtLeast(1)
                continue
            }
            if (kind != "win_snapshot") continue
            val arr = p.optJSONArray("windows") ?: continue
            val wins = ArrayList<StageWin>(arr.length())
            var maxR = dw
            var maxB = dh
            for (i in 0 until arr.length()) {
                val w = arr.optJSONObject(i) ?: continue
                val b = w.optJSONObject("bounds") ?: continue
                val l = b.optInt("l")
                val t = b.optInt("t")
                val r = b.optInt("r")
                val bb = b.optInt("b")
                maxR = maxOf(maxR, r)
                maxB = maxOf(maxB, bb)
                wins.add(
                    StageWin(
                        l, t, r, bb,
                        w.optString("title"),
                        w.optString("pkg"),
                        w.optBoolean("focused"),
                        w.optInt("type"),
                    ),
                )
            }
            if (maxR > dw) dw = maxR
            if (maxB > dh) dh = maxB
            if (ts >= 0) out.add(StageFrame(ts, dw, dh, wins))
        }
        return out
    }

    private fun haversineM(lat1: Double, lon1: Double, lat2: Double, lon2: Double): Double {
        val r = 6371000.0
        val p1 = Math.toRadians(lat1)
        val p2 = Math.toRadians(lat2)
        val dphi = Math.toRadians(lat2 - lat1)
        val dl = Math.toRadians(lon2 - lon1)
        val a = sin(dphi / 2) * sin(dphi / 2) + cos(p1) * cos(p2) * sin(dl / 2) * sin(dl / 2)
        return 2 * r * atan2(sqrt(a), sqrt(1 - a))
    }

    private fun reverse(geo: Geocoder?, lat: Double, lon: Double): String? {
        if (geo == null) return null
        return try {
            @Suppress("DEPRECATION")
            val list = geo.getFromLocation(lat, lon, 1)
            list?.firstOrNull()?.getAddressLine(0)
        } catch (_: Exception) {
            null
        }
    }

    private fun appLabel(ctx: Context, pkg: String): String {
        return try {
            val pm = ctx.packageManager
            val ai = pm.getApplicationInfo(pkg, 0)
            pm.getApplicationLabel(ai).toString()
        } catch (_: PackageManager.NameNotFoundException) {
            pkg.substringAfterLast('.')
        } catch (_: Exception) {
            pkg
        }
    }
}
