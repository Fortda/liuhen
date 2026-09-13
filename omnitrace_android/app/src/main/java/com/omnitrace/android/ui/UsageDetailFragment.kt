package com.omnitrace.android.ui

import android.app.DatePickerDialog
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import androidx.fragment.app.Fragment
import com.omnitrace.android.MainActivity
import com.omnitrace.android.R
import com.omnitrace.android.dash.DashIo
import com.omnitrace.android.dash.DashWash
import com.omnitrace.android.dash.DayUsage
import com.omnitrace.android.dash.UsageGrain
import com.omnitrace.android.dash.UsageSeries
import com.omnitrace.android.databinding.FragmentUsageDetailBinding
import com.omnitrace.android.host.OmniPaths
import com.omnitrace.android.ui.dash.UsageBarsView
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

class UsageDetailFragment : Fragment() {
    private var binding: FragmentUsageDetailBinding? = null
    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private var genYear = 0
    private var genCustom = 0
    private var fromTs = 0L
    private var toTs = 0L
    private var grain = UsageGrain.HOUR
    private var customBars: List<DayUsage> = emptyList()

    private val dayFmt = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault())
    private val monthFmt = SimpleDateFormat("M月", Locale.getDefault())
    private val mdFmt = SimpleDateFormat("M/d", Locale.getDefault())
    private val mdhFmt = SimpleDateFormat("M/d H:mm", Locale.getDefault())

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        val b = FragmentUsageDetailBinding.inflate(inflater, container, false)
        binding = b
        val (a, z) = DashIo.defaultRange()
        fromTs = savedInstanceState?.getLong(STATE_FROM, a) ?: a
        toTs = savedInstanceState?.getLong(STATE_TO, z) ?: z
        grain = grainAt(savedInstanceState?.getInt(STATE_GRAIN, 0) ?: 0)
        b.head.txtSubTitle.text = getString(R.string.dash_usage_page)
        b.head.btnBack.setOnClickListener { parentFragmentManager.popBackStack() }
        bindRange(b.btnFrom, b.btnTo)
        val grainIdx = grain.ordinal
        SettingsUi.bindExclusive(listOf(b.tabHour, b.tabDay, b.tabWeek, b.tabMonth), grainIdx) { i ->
            grain = grainAt(i)
            washCustom()
        }
        b.chartYear.onBarClick = { _, bar ->
            b.txtPick.text = bar.label + "  " + UsageBarsView.fmtShort(bar.ms)
        }
        b.chartCustom.onBarClick = { i, bar ->
            val row = customBars.getOrNull(i)
            b.txtPick.text = if (row != null) {
                pickLabel(row) + "  " + UsageBarsView.fmtShort(row.durationMs)
            } else {
                bar.label + "  " + UsageBarsView.fmtShort(bar.ms)
            }
        }
        (activity as? MainActivity)?.fitScroll(b.root)
        return b.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        washYear()
        washCustom()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putLong(STATE_FROM, fromTs)
        outState.putLong(STATE_TO, toTs)
        outState.putInt(STATE_GRAIN, grain.ordinal)
    }

    override fun onDestroyView() {
        binding = null
        super.onDestroyView()
    }

    private fun bindRange(fromBtn: Button, toBtn: Button) {
        fun paint() {
            fromBtn.text = getString(R.string.dash_range_from) + " " + dayFmt.format(Date(fromTs))
            toBtn.text = getString(R.string.dash_range_to) + " " + dayFmt.format(Date(toTs - 1))
        }
        paint()
        fromBtn.setOnClickListener {
            pickDay(fromTs) { v ->
                fromTs = v
                if (fromTs >= toTs) toTs = DashIo.addLocalDays(fromTs, 1)
                paint()
                washCustom()
            }
        }
        toBtn.setOnClickListener {
            pickDay(toTs - 1) { v ->
                toTs = DashIo.addLocalDays(v, 1)
                if (toTs <= fromTs) fromTs = DashIo.startOfLocalDay(toTs - 1)
                paint()
                washCustom()
            }
        }
    }

    private fun pickDay(currentTs: Long, onPicked: (Long) -> Unit) {
        val c = Calendar.getInstance()
        c.timeInMillis = currentTs
        DatePickerDialog(
            requireContext(),
            { _, y, m, d ->
                val x = Calendar.getInstance()
                x.set(y, m, d, 0, 0, 0)
                x.set(Calendar.MILLISECOND, 0)
                onPicked(x.timeInMillis)
            },
            c.get(Calendar.YEAR),
            c.get(Calendar.MONTH),
            c.get(Calendar.DAY_OF_MONTH),
        ).show()
    }

    private fun washYear() {
        val g = ++genYear
        val app = requireContext().applicationContext
        io.execute {
            val now = System.currentTimeMillis()
            val month0 = DashIo.startOfLocalMonth(now)
            val a = DashIo.addLocalMonths(month0, -11)
            val z = DashIo.addLocalDays(DashIo.startOfLocalDay(now), 1)
            val series = try {
                DashWash.usageSeries(OmniPaths.dataRoot(app), a, z, now, UsageGrain.MONTH)
            } catch (_: Exception) {
                UsageSeries(emptyList(), 0L, UsageGrain.MONTH, null)
            }
            main.post {
                val b = binding ?: return@post
                if (g != genYear) return@post
                b.chartYear.yCeilingMs = series.yMaxMs
                b.chartYear.bars = series.bars.map {
                    UsageBarsView.Bar(monthFmt.format(Date(it.dayStart)), it.durationMs, major = true)
                }
            }
        }
    }

    private fun washCustom() {
        val g = ++genCustom
        val app = requireContext().applicationContext
        val a = fromTs
        val z = toTs
        val gr = grain
        io.execute {
            val now = System.currentTimeMillis()
            val series = try {
                DashWash.usageSeries(OmniPaths.dataRoot(app), a, z, now, gr)
            } catch (_: Exception) {
                UsageSeries(emptyList(), 0L, gr, null)
            }
            main.post {
                val b = binding ?: return@post
                if (g != genCustom) return@post
                customBars = series.bars
                b.chartCustom.yCeilingMs = series.yMaxMs
                b.chartCustom.bars = series.bars.map { toBar(it, gr) }
                val hint = series.note ?: getString(R.string.dash_usage_pick)
                b.txtHint.text = hint
                b.txtPick.text = ""
            }
        }
    }

    private fun toBar(row: DayUsage, gr: UsageGrain): UsageBarsView.Bar {
        val cal = Calendar.getInstance()
        cal.timeInMillis = row.dayStart
        return when (gr) {
            UsageGrain.HOUR -> {
                val h = cal.get(Calendar.HOUR_OF_DAY)
                val label = if (h == 0) mdFmt.format(Date(row.dayStart)) else h.toString()
                UsageBarsView.Bar(label, row.durationMs, major = h == 0 || h % 6 == 0)
            }
            UsageGrain.DAY -> UsageBarsView.Bar(mdFmt.format(Date(row.dayStart)), row.durationMs)
            UsageGrain.WEEK -> UsageBarsView.Bar(mdFmt.format(Date(row.dayStart)), row.durationMs, major = true)
            UsageGrain.MONTH -> UsageBarsView.Bar(monthFmt.format(Date(row.dayStart)), row.durationMs, major = true)
        }
    }

    private fun pickLabel(row: DayUsage): String {
        val end = DashIo.addGrain(row.dayStart, grain)
        return when (grain) {
            UsageGrain.HOUR -> mdhFmt.format(Date(row.dayStart)) + "–" + SimpleDateFormat("H:mm", Locale.getDefault()).format(Date(end))
            UsageGrain.DAY -> dayFmt.format(Date(row.dayStart))
            UsageGrain.WEEK -> mdFmt.format(Date(row.dayStart)) + " 起一周"
            UsageGrain.MONTH -> monthFmt.format(Date(row.dayStart))
        }
    }

    companion object {
        private const val STATE_FROM = "from"
        private const val STATE_TO = "to"
        private const val STATE_GRAIN = "grain"

        private fun grainAt(i: Int): UsageGrain {
            val all = UsageGrain.values()
            return all[i.coerceIn(0, all.lastIndex)]
        }
    }
}
