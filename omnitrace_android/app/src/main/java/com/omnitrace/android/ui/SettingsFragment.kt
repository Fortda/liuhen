package com.omnitrace.android.ui

import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import androidx.fragment.app.Fragment
import com.omnitrace.android.MainActivity
import com.omnitrace.android.R
import com.omnitrace.android.RecordService
import com.omnitrace.android.databinding.FragmentSettingsBinding

class SettingsFragment : Fragment() {
    private var binding: FragmentSettingsBinding? = null
    private val handler = Handler(Looper.getMainLooper())
    private var applyingRecord = false

    private val poll = object : Runnable {
        override fun run() {
            if (!isAdded || view == null) return
            refreshRecord()
            handler.postDelayed(this, 1500)
        }
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        val b = FragmentSettingsBinding.inflate(inflater, container, false)
        binding = b
        return b.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        val b = binding ?: return
        (activity as? MainActivity)?.fitScroll(b.root)
        val act = activity as? MainActivity ?: return
        b.rowCapture.setOnClickListener { act.openCaptureSettings() }
        b.rowData.setOnClickListener { act.openDataSettings() }
        b.rowMap.setOnClickListener { act.openMapSettings() }
        b.rowGraph.setOnClickListener { act.openCaptureGraph() }
        b.rowAbout.setOnClickListener { act.openAbout() }

        b.swRecord.setOnCheckedChangeListener { _, on ->
            if (applyingRecord) return@setOnCheckedChangeListener
            if (on) RecordService.start(act) else RecordService.stop(act)
            handler.postDelayed({ refreshRecord() }, 400)
        }
        refreshRecord()

        val tabs = listOf(b.tabThemeSystem, b.tabThemeLight, b.tabThemeDark)
        val cur = when (ShellTheme.choice(act)) {
            ShellTheme.SYSTEM -> 0
            ShellTheme.DARK -> 2
            else -> 1
        }
        SettingsUi.bindExclusive(tabs, cur) { i ->
            val next = when (i) {
                0 -> ShellTheme.SYSTEM
                2 -> ShellTheme.DARK
                else -> ShellTheme.LIGHT
            }
            if (next != ShellTheme.choice(act)) ShellTheme.set(act, next)
        }
    }

    override fun onResume() {
        super.onResume()
        if (!isHidden) handler.post(poll)
    }

    override fun onHiddenChanged(hidden: Boolean) {
        super.onHiddenChanged(hidden)
        if (hidden) handler.removeCallbacks(poll)
        else if (isResumed) handler.post(poll)
    }

    override fun onPause() {
        handler.removeCallbacks(poll)
        super.onPause()
    }

    private fun refreshRecord() {
        val b = binding ?: return
        val running = RecordService.running.get()
        b.txtRecordStatus.text = if (running) getString(R.string.status_on) else getString(R.string.status_off)
        if (b.swRecord.isChecked != running) {
            applyingRecord = true
            b.swRecord.isChecked = running
            applyingRecord = false
        }
    }

    override fun onDestroyView() {
        handler.removeCallbacks(poll)
        binding = null
        super.onDestroyView()
    }
}
