package com.omnitrace.android.ui

import android.Manifest
import android.app.DatePickerDialog
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.fragment.app.Fragment
import com.omnitrace.android.MainActivity
import com.omnitrace.android.R
import com.omnitrace.android.dash.AppDur
import com.omnitrace.android.dash.DashCaliber
import com.omnitrace.android.dash.DashIo
import com.omnitrace.android.dash.DashWash
import androidx.appcompat.app.AlertDialog
import android.widget.EditText
import com.omnitrace.android.dash.PcIdleSpans
import com.omnitrace.android.dash.SleepGuessDay
import com.omnitrace.android.dash.SleepGuessMode
import com.omnitrace.android.sync.PcLinkPrefs
import com.omnitrace.android.sync.PcSyncHelper
import com.omnitrace.android.dash.PlaceModel
import com.omnitrace.android.dash.ScreenReport
import com.omnitrace.android.databinding.FragmentDashboardBinding
import com.omnitrace.android.host.OmniPaths
import com.omnitrace.android.map.MapDownloadUi
import com.omnitrace.android.map.PackOffer
import com.omnitrace.android.map.TileStore
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

class DashboardFragment : Fragment() {
    companion object {
        private const val STATE_TAB = "dashTab"
    }

    private var binding: FragmentDashboardBinding? = null
    private val io = Executors.newSingleThreadExecutor()
    private val main = Handler(Looper.getMainLooper())
    private var gen1 = 0
    private var gen2 = 0
    private var gen3 = 0
    private var gen4 = 0
    private var cacheStart = 0L
    private var cacheEnd = 0L
    private var cacheLodFar = false
    private var cacheOk = false
    private var tlBusy = false
    private var tlAgain = false
    private var chromeOn = true
    private var immersive = false
    private var packSnooze = HashMap<String, Long>()
    private var packAsking = false

    private var screenFrom = 0L
    private var screenTo = 0L
    private var placeFrom = 0L
    private var placeTo = 0L
    private var morningFrom = 0L
    private var morningTo = 0L

    private val dayFmt = SimpleDateFormat("yyyy-MM-dd", Locale.getDefault())
    private val timeFmt = SimpleDateFormat("M/d HH:mm", Locale.getDefault())

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        val b = FragmentDashboardBinding.inflate(inflater, container, false)
        binding = b
        val (a, z) = DashIo.defaultRange()
        screenFrom = a
        screenTo = z
        placeFrom = a
        placeTo = z
        morningFrom = a
        morningTo = z
        b.timeline.resetToNow()
        b.btnTimeNow.setOnClickListener {
            b.timeline.resetToNow()
            requestTimeline(prefetch = true, force = true)
        }
        b.timeline.onTap = { toggleChrome() }
        b.placePath.onTap = { toggleChrome() }
        b.placePath.onNeedPack = { offer -> askPack(offer) }
        b.btnLocate.setOnClickListener { goHere() }
        b.timeline.onViewChanged = {
            paintTimeHint()
            requestTimeline(prefetch = false)
        }
        b.timeline.onViewSettled = {
            paintTimeHint()
            requestTimeline(prefetch = true)
        }
        bindRange(b.btnScreenFrom, b.btnScreenTo, { screenFrom }, { screenTo }, { v -> screenFrom = v }, { v -> screenTo = v }, ::washScreen)
        bindRange(b.btnPlaceFrom, b.btnPlaceTo, { placeFrom }, { placeTo }, { v -> placeFrom = v }, { v -> placeTo = v }, ::washPlace)
        bindRange(b.btnMorningFrom, b.btnMorningTo, { morningFrom }, { morningTo }, { v -> morningFrom = v }, { v -> morningTo = v }, ::washSleepGuess)
        b.btnPcSync.setOnClickListener { showPcSyncDialog() }
        b.btnUsageDetail.setOnClickListener {
            (activity as? MainActivity)?.openUsageDetail()
        }
        b.dashTabs.addOnButtonCheckedListener { _, id, checked ->
            if (checked) showCard(id)
        }
        val initial = savedInstanceState?.getInt(STATE_TAB) ?: R.id.tabTimeline
        if (initial != View.NO_ID && b.dashTabs.checkedButtonId != initial) b.dashTabs.check(initial)
        showCard(b.dashTabs.checkedButtonId)
        androidx.core.view.ViewCompat.setOnApplyWindowInsetsListener(b.root) { _, insets ->
            relayoutGutters()
            insets
        }
        b.dashChrome.addOnLayoutChangeListener { _, _, _, _, _, _, _, _, _ -> relayoutGutters() }
        androidx.core.view.ViewCompat.requestApplyInsets(b.root)
        return b.root
    }

    override fun onResume() {
        super.onResume()
        if (!isHidden) onPageOn()
    }

    override fun onHiddenChanged(hidden: Boolean) {
        super.onHiddenChanged(hidden)
        if (!hidden && isResumed) onPageOn()
    }

    private fun onPageOn() {
        requestTimeline(prefetch = true, force = true)
        // 时间轴优先；行踪 / 睡眠 / 统计错开，避免挤同一 IO 线程
        main.postDelayed({ if (!isHidden && isResumed) washScreen() }, 80)
        main.postDelayed({ if (!isHidden && isResumed) washPlace() }, 180)
        main.postDelayed({ if (!isHidden && isResumed) washSleepGuess() }, 320)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        binding?.dashTabs?.checkedButtonId?.let { outState.putInt(STATE_TAB, it) }
    }

    override fun onPause() {
        (activity as? MainActivity)?.setNavVisible(true)
        super.onPause()
    }

    override fun onDestroyView() {
        binding?.timeline?.onViewSettled = null
        binding?.timeline?.onViewChanged = null
        binding?.timeline?.onTap = null
        binding?.placePath?.onTap = null
        binding?.placePath?.onNeedPack = null
        binding = null
        super.onDestroyView()
    }

    private fun showCard(tabId: Int) {
        val b = binding ?: return
        val id = if (tabId == View.NO_ID) R.id.tabTimeline else tabId
        immersive = id == R.id.tabTimeline || id == R.id.tabPlace
        b.timeline.visibility = vis(id == R.id.tabTimeline)
        b.placePath.visibility = vis(id == R.id.tabPlace)
        b.cardScreen.visibility = vis(id == R.id.tabScreen)
        b.cardMorning.visibility = vis(id == R.id.tabMorning)
        b.timeChrome.visibility = vis(id == R.id.tabTimeline)
        b.placeChrome.visibility = vis(id == R.id.tabPlace)
        b.btnLocate.visibility = vis(id == R.id.tabPlace)
        if (!immersive) setChrome(true, animate = false)
        else if (!chromeOn) setChrome(true, animate = false)
    }

    private fun toggleChrome() {
        if (!immersive) return
        setChrome(!chromeOn, animate = true)
    }

    private fun setChrome(on: Boolean, animate: Boolean) {
        val b = binding ?: return
        chromeOn = on
        val a = if (on) 1f else 0f
        val locM = (if (on) 72 else 16) * resources.displayMetrics.density
        if (!animate) {
            b.dashChrome.alpha = a
            b.dashChrome.visibility = if (on) View.VISIBLE else View.INVISIBLE
            (b.btnLocate.layoutParams as? android.widget.FrameLayout.LayoutParams)?.bottomMargin = locM.toInt()
            b.btnLocate.requestLayout()
            (activity as? MainActivity)?.setNavVisible(on)
            relayoutGutters()
            return
        }
        b.dashChrome.visibility = View.VISIBLE
        b.dashChrome.animate().alpha(a).setDuration(220).withEndAction {
            if (!on) b.dashChrome.visibility = View.INVISIBLE
        }.start()
        (b.btnLocate.layoutParams as? android.widget.FrameLayout.LayoutParams)?.let { lp ->
            val start = lp.bottomMargin
            val end = locM.toInt()
            android.animation.ValueAnimator.ofInt(start, end).apply {
                duration = 220
                addUpdateListener {
                    lp.bottomMargin = it.animatedValue as Int
                    b.btnLocate.requestLayout()
                }
                start()
            }
        }
        (activity as? MainActivity)?.setNavVisible(on)
        relayoutGutters()
    }

    private fun relayoutGutters() {
        val b = binding ?: return
        val act = activity as? MainActivity ?: return
        val d = resources.displayMetrics.density
        val gap = (8 * d).toInt()
        val bars = ViewCompat.getRootWindowInsets(b.root)
            ?.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
        val status = bars?.top ?: act.systemTop
        val wantPad = status + gap
        if (b.dashChrome.paddingTop != wantPad) {
            b.dashChrome.updatePadding(top = wantPad)
            return
        }
        val reservedTop = if (b.dashChrome.height > 0) {
            b.dashChrome.bottom
        } else {
            status + (120 * d).toInt()
        } + gap
        val bottom = act.navOverlay()
        b.timeline.setGutters(reservedTop, bottom)
        b.cardScreen.setPadding(b.cardScreen.paddingLeft, reservedTop, b.cardScreen.paddingRight, bottom + gap)
        b.cardMorning.setPadding(b.cardMorning.paddingLeft, reservedTop, b.cardMorning.paddingRight, bottom + gap)
    }

    private fun goHere() {
        val b = binding ?: return
        val ctx = requireContext()
        val fine = ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
        val coarse = ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_COARSE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
        var lat: Double? = null
        var lon: Double? = null
        if (fine || coarse) {
            try {
                val lm = ctx.getSystemService(Context.LOCATION_SERVICE) as LocationManager
                val last = lm.getLastKnownLocation(LocationManager.GPS_PROVIDER)
                    ?: lm.getLastKnownLocation(LocationManager.NETWORK_PROVIDER)
                    ?: lm.getLastKnownLocation(LocationManager.PASSIVE_PROVIDER)
                if (last != null) {
                    lat = last.latitude
                    lon = last.longitude
                }
            } catch (_: SecurityException) {
            }
        }
        if (lat == null || lon == null) {
            val s = b.placePath.stays.lastOrNull()
            if (s != null) {
                lat = s.lat
                lon = s.lon
            }
        }
        if (lat == null || lon == null) {
            Toast.makeText(ctx, R.string.map_no_fix, Toast.LENGTH_SHORT).show()
            return
        }
        b.placePath.goTo(lat, lon, 15.0)
    }

    private fun askPack(offer: PackOffer) {
        if (packAsking) return
        val until = packSnooze[offer.id] ?: 0L
        if (System.currentTimeMillis() < until) return
        val ctx = context ?: return
        packAsking = true
        MapDownloadUi.confirm(
            ctx,
            offer,
            onYes = { TileStore.downloadOfferMeasured(offer, { _, _ -> }, { _, _, _ -> }) },
            onDismiss = {
                packAsking = false
                packSnooze[offer.id] = System.currentTimeMillis() + 120_000L
            },
        )
    }

    private fun vis(on: Boolean) = if (on) View.VISIBLE else View.GONE

    private fun bindRange(
        fromBtn: Button,
        toBtn: Button,
        getFrom: () -> Long,
        getTo: () -> Long,
        setFrom: (Long) -> Unit,
        setTo: (Long) -> Unit,
        reload: () -> Unit,
    ) {
        fun paint() {
            fromBtn.text = getString(R.string.dash_range_from) + " " + dayFmt.format(Date(getFrom()))
            toBtn.text = getString(R.string.dash_range_to) + " " + dayFmt.format(Date(getTo() - 1))
        }
        paint()
        fromBtn.setOnClickListener {
            pickDay(getFrom()) { v ->
                setFrom(v)
                if (getFrom() >= getTo()) setTo(DashIo.addLocalDays(getFrom(), 1))
                paint()
                reload()
            }
        }
        toBtn.setOnClickListener {
            pickDay(getTo() - 1) { v ->
                setTo(DashIo.addLocalDays(v, 1))
                if (getTo() <= getFrom()) setFrom(DashIo.startOfLocalDay(getTo() - 1))
                paint()
                reload()
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

    private fun requestTimeline(prefetch: Boolean, force: Boolean = false) {
        val b = binding ?: return
        if (isHidden) return
        val v0 = b.timeline.viewStart
        val v1 = b.timeline.viewEnd
        val far = DashCaliber.lodFar(v0, v1)
        if (!force && cacheOk && far == cacheLodFar && v0 >= cacheStart && v1 <= cacheEnd) {
            if (!prefetch) return
            val margin = (v1 - v0).coerceAtLeast(1L) / 4
            if (v0 >= cacheStart + margin && v1 <= cacheEnd - margin) return
        }
        if (tlBusy) {
            tlAgain = true
            return
        }
        washTimeline()
    }

    private fun paintTimeHint() {
        val b = binding ?: return
        val t0 = b.timeline.viewStart
        val t1 = b.timeline.viewEnd
        val far = if (DashCaliber.lodFar(t0, t1)) {
            b.timeline.model?.farNote
                ?: "跨度大于 7 天：叠色/音频按日粗占用；缩到 7 日内看开锁与程序分行。"
        } else {
            ""
        }
        b.txtTimeHint.text = fmtWindow(t0, t1) + if (far.isEmpty()) "" else " · $far"
    }

    private fun washTimeline() {
        val b = binding ?: return
        val view0 = b.timeline.viewStart
        val view1 = b.timeline.viewEnd
        val (t0, t1) = DashCaliber.paddedLoadRange(view0, view1)
        val lod = view1 - view0
        val g = ++gen1
        tlBusy = true
        val app = requireContext().applicationContext
        io.execute {
            val model = try {
                DashWash.timeline(app, OmniPaths.dataRoot(app), t0, t1, System.currentTimeMillis(), lod)
            } catch (_: Exception) {
                null
            }
            main.post {
                val bb = binding ?: return@post
                if (g != gen1) return@post
                tlBusy = false
                if (model != null) {
                    bb.timeline.model = model
                    cacheStart = t0
                    cacheEnd = t1
                    cacheLodFar = model.far
                    cacheOk = true
                    paintTimeHint()
                }
                if (tlAgain) {
                    tlAgain = false
                    requestTimeline(prefetch = true, force = true)
                }
            }
        }
    }

    private fun washScreen() {
        val g = ++gen2
        val app = requireContext().applicationContext
        val a = screenFrom
        val z = screenTo
        io.execute {
            val report = try {
                DashWash.screenReport(app, OmniPaths.dataRoot(app), a, z, System.currentTimeMillis())
            } catch (_: Exception) {
                null
            }
            main.post {
                val b = binding ?: return@post
                if (g != gen2) return@post
                if (report != null) paintScreen(report) else fillDurations(b.listScreen, emptyList())
            }
        }
    }

    private fun paintScreen(report: ScreenReport) {
        val b = binding ?: return
        val weekFmt = SimpleDateFormat("M/d", Locale.getDefault())
        val dayFmt = SimpleDateFormat("M/d", Locale.getDefault())
        b.txtTodayUsage.text = fmtDur(report.todayMs)
        b.txtMonthHead.text = getString(
            R.string.dash_usage_month,
            dayFmt.format(Date(report.monthDays.firstOrNull()?.dayStart
                ?: DashIo.addLocalDays(DashIo.startOfLocalDay(System.currentTimeMillis()), -29))),
            fmtDur(report.monthTotalMs),
        )
        b.chartWeek.bars = report.week.map {
            com.omnitrace.android.ui.dash.UsageBarsView.Bar(weekFmt.format(Date(it.dayStart)), it.durationMs)
        }
        b.chartMonth.bars = report.monthDays.map {
            com.omnitrace.android.ui.dash.UsageBarsView.Bar(dayFmt.format(Date(it.dayStart)), it.durationMs)
        }
        b.chartYear.bars = report.months.map {
            com.omnitrace.android.ui.dash.UsageBarsView.Bar("${it.month}月", it.durationMs)
        }
        fillDurations(b.listScreen, report.apps)
    }

    private fun washPlace() {
        val g = ++gen3
        val app = requireContext().applicationContext
        val a = placeFrom
        val z = placeTo
        io.execute {
            val model = try {
                DashWash.places(app, OmniPaths.dataRoot(app), a, z)
            } catch (_: Exception) {
                PlaceModel(emptyList(), emptyList(), "这段没有数据。")
            }
            main.post {
                val b = binding ?: return@post
                if (g != gen3) return@post
                b.placePath.path = model.path
                b.placePath.stays = model.stays
            }
            if (model.stays.isEmpty()) return@execute
            val labeled = try {
                DashWash.labelStays(app, model.stays)
            } catch (_: Exception) {
                return@execute
            }
            main.post {
                val b = binding ?: return@post
                if (g != gen3) return@post
                b.placePath.stays = labeled
            }
        }
    }

    private fun washSleepGuess() {
        val g = ++gen4
        val app = requireContext().applicationContext
        val root = OmniPaths.dataRoot(app)
        val a = morningFrom
        val z = morningTo
        val showPcBanner = !PcIdleSpans.hasLinkedData(root)
        main.post {
            val b = binding ?: return@post
            b.boxSleepPcMissing.visibility = if (showPcBanner) View.VISIBLE else View.GONE
        }
        io.execute {
            val rows = try {
                DashWash.sleepGuessDays(app, root, a, z, System.currentTimeMillis())
            } catch (_: Exception) {
                emptyList()
            }
            val wakes = rows.map { it.wakeTs }.toLongArray()
            val strip = try {
                DashWash.sleepActivity(root, a, z, wakes)
            } catch (_: Exception) {
                null
            }
            main.post {
                val b = binding ?: return@post
                if (g != gen4) return@post
                if (strip != null) b.sleepActivityStrip.model = strip
                fillSleepGuess(b.listMorning, rows)
            }
        }
    }

    private fun showPcSyncDialog() {
        val ctx = requireContext()
        val input = EditText(ctx)
        input.hint = getString(R.string.set_pc_ip_hint)
        PcLinkPrefs.host(ctx)?.let { input.setText(it) }
        AlertDialog.Builder(ctx)
            .setTitle(getString(R.string.set_pc_link))
            .setMessage(getString(R.string.set_pc_link_hint))
            .setView(input)
            .setPositiveButton(getString(R.string.set_pc_sync)) { _, _ ->
                val host = input.text?.toString()?.trim() ?: return@setPositiveButton
                if (host.isEmpty()) return@setPositiveButton
                PcLinkPrefs.setHost(ctx, host)
                io.execute {
                    val msg = PcSyncHelper.syncRecent(ctx.applicationContext)
                    main.post {
                        Toast.makeText(ctx, msg, Toast.LENGTH_LONG).show()
                        washSleepGuess()
                    }
                }
            }
            .setNegativeButton(android.R.string.cancel, null)
            .show()
    }

    private fun fillSleepGuess(box: LinearLayout, rows: List<SleepGuessDay>) {
        box.removeAllViews()
        if (rows.isEmpty()) {
            box.addView(muted(getString(R.string.dash_empty)))
            return
        }
        for (d in rows) {
            val mode = when (d.mode) {
                SleepGuessMode.PHONE_ONLY -> getString(R.string.dash_sleep_guess_mode_phone)
                SleepGuessMode.PHONE_AND_PC -> getString(R.string.dash_sleep_guess_mode_both)
            }
            val head = TextView(requireContext())
            head.setTextColor(col(R.color.accent))
            head.textSize = 13f
            head.text = dayFmt.format(Date(d.dayStart)) + " · " + mode + " · " +
                getString(R.string.dash_sleep_guess_wake, timeFmt.format(Date(d.wakeTs)))
            box.addView(head)
            if (d.apps.isEmpty()) {
                box.addView(muted(getString(R.string.dash_sleep_guess_no_apps)))
            } else {
                val body = TextView(requireContext())
                body.setTextColor(col(R.color.fg))
                body.textSize = 13f
                body.text = d.apps.joinToString(" → ") { "${it.label} ${fmtDur(it.durationMs)}" }
                val lp = LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
                lp.bottomMargin = 12
                body.layoutParams = lp
                box.addView(body)
            }
        }
    }

    private fun fillDurations(box: LinearLayout, rows: List<AppDur>) {
        box.removeAllViews()
        if (rows.isEmpty()) {
            box.addView(muted(getString(R.string.dash_empty)))
            return
        }
        val max = rows.maxOf { it.durationMs }.coerceAtLeast(1L)
        for (r in rows) {
            val line = TextView(requireContext())
            line.setTextColor(col(R.color.fg))
            line.textSize = 13f
            line.text = "${r.label}  ${fmtDur(r.durationMs)}"
            box.addView(line)
            val bar = View(requireContext())
            val lp = LinearLayout.LayoutParams(
                (box.resources.displayMetrics.widthPixels * 0.6f * r.durationMs / max).toInt().coerceAtLeast(8),
                (8 * resources.displayMetrics.density).toInt(),
            )
            lp.topMargin = 4
            lp.bottomMargin = 10
            bar.layoutParams = lp
            bar.setBackgroundColor(col(R.color.accent))
            box.addView(bar)
        }
    }

    private fun muted(s: String): TextView {
        val t = TextView(requireContext())
        t.setTextColor(col(R.color.muted))
        t.textSize = 13f
        t.text = s
        return t
    }

    private fun col(id: Int): Int = ContextCompat.getColor(requireContext(), id)

    private fun fmtWindow(t0: Long, t1: Long): String {
        val span = t1 - t0
        val day = 24L * 3600_000L
        return when {
            span < day -> timeFmt.format(Date(t0)) + " → " + timeFmt.format(Date(t1))
            span < 400 * day -> dayFmt.format(Date(t0)) + " → " + dayFmt.format(Date(t1))
            else -> SimpleDateFormat("yyyy", Locale.getDefault()).format(Date(t0)) +
                " → " + SimpleDateFormat("yyyy", Locale.getDefault()).format(Date(t1))
        }
    }

    private fun fmtDur(ms: Long): String {
        val s = (ms / 1000).coerceAtLeast(0)
        val h = s / 3600
        val m = (s % 3600) / 60
        return when {
            h > 0 -> "${h}h ${m}m"
            m > 0 -> "${m}m"
            else -> "${s}s"
        }
    }
}
