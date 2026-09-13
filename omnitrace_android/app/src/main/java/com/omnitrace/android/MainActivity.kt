package com.omnitrace.android

import android.os.Bundle
import android.view.View
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.fragment.app.Fragment
import com.omnitrace.android.databinding.ActivityMainBinding
import com.omnitrace.android.ui.DashboardFragment
import com.omnitrace.android.ui.PlayerFragment
import com.omnitrace.android.ui.SettingsFragment

class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    var systemTop: Int = 0
        private set
    var systemBottom: Int = 0
        private set

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)
        ViewCompat.setOnApplyWindowInsetsListener(binding.bottomNav) { v, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            systemTop = bars.top
            systemBottom = bars.bottom
            v.updatePadding(bottom = bars.bottom)
            insets
        }

        binding.bottomNav.setOnItemSelectedListener { item ->
            showPage(tagFor(item.itemId))
            true
        }
        binding.bottomNav.setOnItemReselectedListener { }

        if (savedInstanceState == null) {
            showPage(TAG_SETTINGS)
        } else {
            val id = savedInstanceState.getInt(KEY_NAV, R.id.nav_settings)
            binding.bottomNav.selectedItemId = id
            showPage(tagFor(id))
        }
    }

    fun navOverlay(): Int {
        val h = binding.bottomNav.height
        if (h > 0) return h
        return (96 * resources.displayMetrics.density).toInt() + systemBottom
    }

    fun fitScroll(view: View, extraTopDp: Int = 12, extraBottomDp: Int = 24) {
        val d = resources.displayMetrics.density
        val left = view.paddingLeft
        val right = view.paddingRight
        ViewCompat.setOnApplyWindowInsetsListener(view) { v, insets ->
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            v.updatePadding(
                left = left,
                top = bars.top + (extraTopDp * d).toInt(),
                right = right,
                bottom = navOverlay() + (extraBottomDp * d).toInt(),
            )
            insets
        }
        ViewCompat.requestApplyInsets(view)
    }

    fun fitBottomChrome(view: View, extraDp: Int = 16) {
        val d = resources.displayMetrics.density
        val left = view.paddingLeft
        val top = view.paddingTop
        val right = view.paddingRight
        ViewCompat.setOnApplyWindowInsetsListener(view) { v, insets ->
            v.updatePadding(
                left = left,
                top = top,
                right = right,
                bottom = navOverlay() + (extraDp * d).toInt(),
            )
            insets
        }
        ViewCompat.requestApplyInsets(view)
    }

    fun setNavVisible(on: Boolean) {
        val nav = binding.bottomNav
        nav.animate().cancel()
        if (on) {
            nav.visibility = android.view.View.VISIBLE
            nav.animate().alpha(1f).translationY(0f).setDuration(220).start()
        } else {
            nav.animate().alpha(0f).translationY(nav.height.toFloat().coerceAtLeast(1f)).setDuration(220)
                .withEndAction {
                    if (nav.alpha < 0.05f) nav.visibility = android.view.View.INVISIBLE
                }.start()
        }
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        outState.putInt(KEY_NAV, binding.bottomNav.selectedItemId)
    }

    fun openCaptureSettings() = openSettingsChild(TAG_CAPTURE) { com.omnitrace.android.ui.CaptureSettingsFragment() }

    fun openDataSettings() = openSettingsChild(TAG_DATA) { com.omnitrace.android.ui.DataSettingsFragment() }

    fun openMapSettings() = openSettingsChild(TAG_MAPSET) { com.omnitrace.android.ui.MapSettingsFragment() }

    fun openAbout() = openSettingsChild(TAG_ABOUT) { com.omnitrace.android.ui.AboutSettingsFragment() }

    fun openCaptureGraph() = openSettingsChild(TAG_GRAPH) { com.omnitrace.android.ui.CaptureGraphFragment() }

    fun openUsageDetail() = openOverlay(TAG_USAGE, TAG_DASH) { com.omnitrace.android.ui.UsageDetailFragment() }

    private fun openSettingsChild(tag: String, make: () -> Fragment) =
        openOverlay(tag, TAG_SETTINGS, make)

    private fun openOverlay(tag: String, hideTag: String, make: () -> Fragment) {
        val fm = supportFragmentManager
        if (fm.findFragmentByTag(tag) != null) return
        val tx = fm.beginTransaction()
            .setReorderingAllowed(true)
            .setCustomAnimations(
                R.anim.page_enter,
                R.anim.page_exit,
                R.anim.page_pop_enter,
                R.anim.page_pop_exit,
            )
        fm.findFragmentByTag(hideTag)?.let { tx.hide(it) }
        tx.add(R.id.page_host, make(), tag)
            .addToBackStack(tag)
            .commit()
    }

    private fun showPage(tag: String) {
        val fm = supportFragmentManager
        if (fm.backStackEntryCount > 0) fm.popBackStack(null, androidx.fragment.app.FragmentManager.POP_BACK_STACK_INCLUSIVE)
        val tx = fm.beginTransaction()
        for (t in PAGES) {
            fm.findFragmentByTag(t)?.let { tx.hide(it) }
        }
        val existing = fm.findFragmentByTag(tag)
        if (existing == null) {
            tx.add(R.id.page_host, newPage(tag), tag)
        } else {
            tx.show(existing)
        }
        tx.commitNow()
    }

    private fun tagFor(itemId: Int): String = when (itemId) {
        R.id.nav_player -> TAG_PLAYER
        R.id.nav_dashboard -> TAG_DASH
        else -> TAG_SETTINGS
    }

    private fun newPage(tag: String): Fragment = when (tag) {
        TAG_PLAYER -> PlayerFragment()
        TAG_DASH -> DashboardFragment()
        else -> SettingsFragment()
    }

    companion object {
        private const val KEY_NAV = "nav"
        private const val TAG_SETTINGS = "settings"
        private const val TAG_PLAYER = "player"
        private const val TAG_DASH = "dash"
        private val PAGES = arrayOf(TAG_SETTINGS, TAG_PLAYER, TAG_DASH)
        private const val TAG_MAPSET = "mapset"
        private const val TAG_CAPTURE = "capture"
        private const val TAG_DATA = "data"
        private const val TAG_ABOUT = "about"
        private const val TAG_GRAPH = "graph"
        private const val TAG_USAGE = "usage"
    }
}
