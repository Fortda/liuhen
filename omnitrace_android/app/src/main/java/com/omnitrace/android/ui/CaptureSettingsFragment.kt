package com.omnitrace.android.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.view.accessibility.AccessibilityManager
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.fragment.app.Fragment
import com.omnitrace.android.MainActivity
import com.omnitrace.android.R
import com.omnitrace.android.RecordService
import com.omnitrace.android.databinding.FragmentCaptureSettingsBinding
import com.omnitrace.android.host.CaptureCatalog
import com.omnitrace.android.host.CapturePermProbe
import com.omnitrace.android.host.HostBridge

class CaptureSettingsFragment : Fragment() {
    private var binding: FragmentCaptureSettingsBinding? = null
    private val handler = Handler(Looper.getMainLooper())

    private val permLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { refresh() }

    private val poll = object : Runnable {
        override fun run() {
            if (!isAdded || view == null) return
            refresh()
            handler.postDelayed(this, 1500)
        }
    }

    override fun onCreateView(inflater: LayoutInflater, container: ViewGroup?, savedInstanceState: Bundle?): View {
        val b = FragmentCaptureSettingsBinding.inflate(inflater, container, false)
        binding = b
        return b.root
    }

    override fun onViewCreated(view: View, savedInstanceState: Bundle?) {
        val b = binding ?: return
        (activity as? MainActivity)?.fitScroll(b.root)
        b.head.txtSubTitle.text = getString(R.string.set_page_capture)
        b.head.btnBack.setOnClickListener { parentFragmentManager.popBackStack() }
        val act = requireActivity()
        val prefs = act.getSharedPreferences(RecordService.PREFS, AppCompatActivity.MODE_PRIVATE)
        val profile = prefs.getString(RecordService.KEY_PROFILE, RecordService.PROFILE_OVERNIGHT)
        b.swMax.isChecked = profile == RecordService.PROFILE_MAX
        b.swMax.setOnCheckedChangeListener { _, on ->
            prefs.edit().putString(
                RecordService.KEY_PROFILE,
                if (on) RecordService.PROFILE_MAX else RecordService.PROFILE_OVERNIGHT,
            ).apply()
        }
        b.btnPerms.setOnClickListener { requestRuntimePerms() }
        b.btnA11y.setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        b.btnBattery.setOnClickListener { requestIgnoreBattery() }
        b.btnBgLoc.setOnClickListener { requestBackgroundLocation() }
        b.swBoot.isChecked = prefs.getBoolean(RecordService.KEY_BOOT, false)
        b.swBoot.setOnCheckedChangeListener { _, on ->
            prefs.edit().putBoolean(RecordService.KEY_BOOT, on).apply()
        }
        b.swKeepAlive.isChecked = prefs.getBoolean(RecordService.KEY_KEEP_ALIVE, false)
        b.swKeepAlive.setOnCheckedChangeListener { _, on ->
            prefs.edit().putBoolean(RecordService.KEY_KEEP_ALIVE, on).apply()
        }
        b.btnOemAutostart.setOnClickListener { openOemAutostart() }
        paintModules()
        refresh()
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

    override fun onDestroyView() {
        handler.removeCallbacks(poll)
        binding = null
        super.onDestroyView()
    }

    private fun paintModules() {
        val b = binding ?: return
        val ctx = context ?: return
        val box = b.listModules
        box.removeAllViews()
        for (m in CaptureCatalog.modules) {
            val on = CaptureCatalog.enabled(ctx, m.id)
            val (_, actions) = SettingsUi.row(box, m.label)
            val sw = SettingsUi.endSwitch(ctx)
            sw.isChecked = on
            sw.setOnCheckedChangeListener { _, next ->
                CaptureCatalog.setEnabled(ctx, m.id, next)
                if (RecordService.running.get()) {
                    Toast.makeText(ctx, R.string.set_mod_next, Toast.LENGTH_SHORT).show()
                }
            }
            actions.addView(sw)
        }
    }

    private fun refresh() {
        val b = binding ?: return
        b.txtChecklist.text = checklist()
    }

    private fun checklist(): String {
        if (context == null) return ""
        val lines = mutableListOf<String>()
        fun mark(ok: Boolean, name: String) {
            lines.add(if (ok) "✓ $name" else "✗ $name")
        }
        mark(CapturePermProbe.hasFineLocation(requireContext()), "精确位置")
        if (Build.VERSION.SDK_INT >= 29) {
            mark(CapturePermProbe.has(requireContext(), Manifest.permission.ACCESS_BACKGROUND_LOCATION), "后台位置（灭屏 GPS）")
        }
        if (Build.VERSION.SDK_INT >= 33) {
            mark(CapturePermProbe.has(requireContext(), Manifest.permission.POST_NOTIFICATIONS), "通知")
        }
        if (Build.VERSION.SDK_INT >= 29) {
            mark(CapturePermProbe.hasActivityRecognition(requireContext()), "计步")
        }
        mark(CapturePermProbe.a11yOn(requireContext()), "无障碍（焦点/点击/窗栈）")
        mark(CapturePermProbe.batteryUnrestricted(requireContext()), "忽略电池优化")
        mark(CapturePermProbe.a11yConnected(), "无障碍服务已连接")
        mark(RecordService.running.get(), "采集服务")
        return lines.joinToString("\n")
    }

    private fun has(p: String): Boolean = CapturePermProbe.has(requireContext(), p)

    private fun a11yOn(): Boolean = CapturePermProbe.a11yOn(requireContext())

    private fun batteryUnrestricted(): Boolean = CapturePermProbe.batteryUnrestricted(requireContext())

    private fun requestRuntimePerms() {
        val need = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION,
        )
        if (Build.VERSION.SDK_INT >= 33) need.add(Manifest.permission.POST_NOTIFICATIONS)
        if (Build.VERSION.SDK_INT >= 29) need.add(Manifest.permission.ACTIVITY_RECOGNITION)
        if (Build.VERSION.SDK_INT >= 31) {
            need.add(Manifest.permission.BLUETOOTH_CONNECT)
            need.add(Manifest.permission.BLUETOOTH_SCAN)
        }
        if (Build.VERSION.SDK_INT >= 33) need.add(Manifest.permission.NEARBY_WIFI_DEVICES)
        need.add(Manifest.permission.READ_PHONE_STATE)
        permLauncher.launch(need.toTypedArray())
    }

    private fun requestBackgroundLocation() {
        if (Build.VERSION.SDK_INT >= 29) {
            permLauncher.launch(arrayOf(Manifest.permission.ACCESS_BACKGROUND_LOCATION))
        }
    }

    private fun requestIgnoreBattery() {
        if (batteryUnrestricted()) return
        val ctx = context ?: return
        val i = Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
        i.data = Uri.parse("package:${ctx.packageName}")
        startActivity(i)
    }

    private fun openOemAutostart() {
        val ctx = context ?: return
        val tries = listOf(
            Intent().setClassName("com.miui.securitycenter", "com.miui.permcenter.autostart.AutoStartManagementActivity"),
            Intent("miui.intent.action.OP_AUTO_START").addCategory(Intent.CATEGORY_DEFAULT),
            Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS).setData(Uri.parse("package:${ctx.packageName}")),
        )
        for (i in tries) {
            try {
                startActivity(i)
                return
            } catch (_: Exception) {
            }
        }
    }
}
