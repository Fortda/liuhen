package com.omnitrace.android.dash

import com.omnitrace.android.host.OmniPaths
import org.json.JSONObject
import java.io.File
import java.util.Calendar
import java.util.regex.Pattern

object DashIo {
    private val dayFile = Pattern.compile("events_(\\d{2})\\.jsonl")
    private val monthDir = Pattern.compile("Month_(\\d{2})")
    private val yearDir = Pattern.compile("Year_(\\d{4})")

    fun startOfLocalDay(ts: Long): Long {
        val c = Calendar.getInstance()
        c.timeInMillis = ts
        c.set(Calendar.HOUR_OF_DAY, 0)
        c.set(Calendar.MINUTE, 0)
        c.set(Calendar.SECOND, 0)
        c.set(Calendar.MILLISECOND, 0)
        return c.timeInMillis
    }

    fun addLocalDays(startOfDay: Long, days: Int): Long {
        val c = Calendar.getInstance()
        c.timeInMillis = startOfDay
        c.add(Calendar.DAY_OF_MONTH, days)
        return c.timeInMillis
    }

    fun startOfLocalMonth(ts: Long): Long {
        val c = Calendar.getInstance()
        c.timeInMillis = ts
        c.set(Calendar.DAY_OF_MONTH, 1)
        c.set(Calendar.HOUR_OF_DAY, 0)
        c.set(Calendar.MINUTE, 0)
        c.set(Calendar.SECOND, 0)
        c.set(Calendar.MILLISECOND, 0)
        return c.timeInMillis
    }

    fun addLocalMonths(startOfMonth: Long, months: Int): Long {
        val c = Calendar.getInstance()
        c.timeInMillis = startOfMonth
        c.add(Calendar.MONTH, months)
        return c.timeInMillis
    }

    fun startOfLocalHour(ts: Long): Long {
        val c = Calendar.getInstance()
        c.timeInMillis = ts
        c.set(Calendar.MINUTE, 0)
        c.set(Calendar.SECOND, 0)
        c.set(Calendar.MILLISECOND, 0)
        return c.timeInMillis
    }

    fun addLocalHours(startOfHour: Long, hours: Int): Long {
        val c = Calendar.getInstance()
        c.timeInMillis = startOfHour
        c.add(Calendar.HOUR_OF_DAY, hours)
        return c.timeInMillis
    }

    fun startOfLocalWeek(ts: Long): Long {
        val c = Calendar.getInstance()
        c.timeInMillis = ts
        c.set(Calendar.HOUR_OF_DAY, 0)
        c.set(Calendar.MINUTE, 0)
        c.set(Calendar.SECOND, 0)
        c.set(Calendar.MILLISECOND, 0)
        val dow = c.get(Calendar.DAY_OF_WEEK)
        val fromMon = (dow + 5) % 7
        c.add(Calendar.DAY_OF_MONTH, -fromMon)
        return c.timeInMillis
    }

    fun alignGrain(ts: Long, grain: UsageGrain): Long = when (grain) {
        UsageGrain.HOUR -> startOfLocalHour(ts)
        UsageGrain.DAY -> startOfLocalDay(ts)
        UsageGrain.WEEK -> startOfLocalWeek(ts)
        UsageGrain.MONTH -> startOfLocalMonth(ts)
    }

    fun addGrain(start: Long, grain: UsageGrain, n: Int = 1): Long = when (grain) {
        UsageGrain.HOUR -> addLocalHours(start, n)
        UsageGrain.DAY -> addLocalDays(start, n)
        UsageGrain.WEEK -> addLocalDays(start, 7 * n)
        UsageGrain.MONTH -> addLocalMonths(start, n)
    }

    fun defaultRange(): Pair<Long, Long> {
        val today0 = startOfLocalDay(System.currentTimeMillis())
        val from = addLocalDays(today0, -6)
        val to = addLocalDays(today0, 1)
        return from to to
    }

    data class DayFile(val file: File, val dayStart: Long, val dayEnd: Long)

    fun listDayFiles(root: File, module: String, t0: Long, t1: Long): List<DayFile> {
        val base = OmniPaths.moduleRoot(root, module)
        if (!base.isDirectory) return emptyList()
        val out = ArrayList<DayFile>()
        val centuries = base.listFiles() ?: return emptyList()
        for (cent in centuries) {
            if (!cent.isDirectory || !cent.name.startsWith("Century_")) continue
            val years = cent.listFiles() ?: continue
            for (year in years) {
                val ym = yearDir.matcher(year.name)
                if (!year.isDirectory || !ym.matches()) continue
                val y = ym.group(1)!!.toInt()
                val months = year.listFiles() ?: continue
                for (month in months) {
                    val mm = monthDir.matcher(month.name)
                    if (!month.isDirectory || !mm.matches()) continue
                    val mo = mm.group(1)!!.toInt()
                    val files = month.listFiles() ?: continue
                    for (f in files) {
                        val dm = dayFile.matcher(f.name)
                        if (!f.isFile || !dm.matches()) continue
                        val d = dm.group(1)!!.toInt()
                        val cal = Calendar.getInstance()
                        try {
                            cal.set(y, mo - 1, d, 0, 0, 0)
                            cal.set(Calendar.MILLISECOND, 0)
                        } catch (_: Exception) {
                            continue
                        }
                        val a = cal.timeInMillis
                        val b = addLocalDays(a, 1)
                        if (b > t0 && a < t1) out.add(DayFile(f, a, b))
                    }
                }
            }
        }
        return out.sortedBy { it.dayStart }
    }

    fun readEvents(file: File): List<JSONObject> {
        if (!file.isFile) return emptyList()
        val out = ArrayList<JSONObject>()
        file.forEachLine(Charsets.UTF_8) { line ->
            val s = line.trim()
            if (s.isEmpty()) return@forEachLine
            try {
                out.add(JSONObject(s))
            } catch (_: Exception) {
            }
        }
        return out
    }

    fun readEventsInRange(root: File, module: String, t0: Long, t1: Long): List<JSONObject> {
        val all = ArrayList<JSONObject>()
        for (df in listDayFiles(root, module, t0, t1)) {
            for (ev in readEvents(df.file)) {
                val ts = ev.optLong("ts", -1L)
                if (ts in t0 until t1) all.add(ev)
            }
        }
        all.sortBy { it.optLong("ts", 0L) }
        return all
    }
}
