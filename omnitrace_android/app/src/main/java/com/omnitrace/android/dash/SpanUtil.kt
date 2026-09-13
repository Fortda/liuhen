package com.omnitrace.android.dash

data class Span(val start: Long, val end: Long) {
    val duration: Long get() = (end - start).coerceAtLeast(0L)
}

object SpanUtil {
    fun clip(spans: List<Span>, t0: Long, t1: Long): List<Span> {
        if (t1 <= t0) return emptyList()
        val out = ArrayList<Span>()
        for (s in spans) {
            val a = maxOf(s.start, t0)
            val b = minOf(s.end, t1)
            if (b > a) out.add(Span(a, b))
        }
        return out
    }

    fun merge(spans: List<Span>): List<Span> {
        if (spans.isEmpty()) return emptyList()
        val sorted = spans.sortedBy { it.start }
        val out = ArrayList<Span>()
        var cur = sorted[0]
        for (i in 1 until sorted.size) {
            val s = sorted[i]
            if (s.start <= cur.end) {
                cur = Span(cur.start, maxOf(cur.end, s.end))
            } else {
                out.add(cur)
                cur = s
            }
        }
        out.add(cur)
        return out
    }

    fun subtract(base: List<Span>, cut: List<Span>): List<Span> {
        if (base.isEmpty()) return emptyList()
        if (cut.isEmpty()) return merge(base)
        val aa = merge(base)
        val bb = merge(cut)
        val out = ArrayList<Span>()
        for (x in aa) {
            var t = x.start
            for (y in bb) {
                if (y.end <= t) continue
                if (y.start >= x.end) break
                if (y.start > t) out.add(Span(t, minOf(y.start, x.end)))
                t = maxOf(t, y.end)
                if (t >= x.end) break
            }
            if (t < x.end) out.add(Span(t, x.end))
        }
        return out.filter { it.end > it.start }
    }

    fun intersect(a: List<Span>, b: List<Span>): List<Span> {
        if (a.isEmpty() || b.isEmpty()) return emptyList()
        val aa = merge(a)
        val bb = merge(b)
        val out = ArrayList<Span>()
        var i = 0
        var j = 0
        while (i < aa.size && j < bb.size) {
            val x = aa[i]
            val y = bb[j]
            val lo = maxOf(x.start, y.start)
            val hi = minOf(x.end, y.end)
            if (hi > lo) out.add(Span(lo, hi))
            if (x.end < y.end) i++ else j++
        }
        return out
    }

    fun fromEdges(times: List<Pair<Long, Boolean>>, t1: Long): List<Span> {
        if (times.isEmpty()) return emptyList()
        val sorted = times.sortedBy { it.first }
        val out = ArrayList<Span>()
        var on = false
        var start = 0L
        for ((ts, flag) in sorted) {
            if (flag && !on) {
                on = true
                start = ts
            } else if (!flag && on) {
                on = false
                if (ts > start) out.add(Span(start, ts))
            }
        }
        if (on && t1 > start) out.add(Span(start, t1))
        return out
    }
}
