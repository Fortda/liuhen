package com.omnitrace.android.modules

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.os.Build
import android.telephony.TelephonyManager
import androidx.core.content.ContextCompat
import com.omnitrace.android.host.EventSink
import com.omnitrace.android.host.JsonUtil
import com.omnitrace.android.host.ModuleContext
import com.omnitrace.android.host.ModuleStatus
import com.omnitrace.android.host.Receivers
import com.omnitrace.android.host.TraceModule
import com.omnitrace.android.host.kv
import org.json.JSONArray
import org.json.JSONObject

/** WiFi / 蓝牙 / 基带：记状态变化，默认不持续扫描。 */
class RadioModule : TraceModule {
    override val id = "radio"
    override val name = "Radio occupancy"
    override val version = "0.1.0"

    private var st = ModuleStatus.Idle
    private var app: Context? = null
    private var sink: EventSink? = null
    private var profile = "overnight"
    private var receiver: BroadcastReceiver? = null
    private var netCb: ConnectivityManager.NetworkCallback? = null
    private var lastWifiSig = ""
    private var lastScanMs = 0L
    private var lastCellMs = 0L

    override fun status(): ModuleStatus = st

    override fun start(ctx: ModuleContext, sink: EventSink) {
        app = ctx.app
        this.sink = sink
        profile = ctx.profile
        sink.emit(id, "module_hello", JSONObject().kv("implemented", true).kv("scan_default", false))
        val filter = IntentFilter().apply {
            addAction(WifiManager.NETWORK_STATE_CHANGED_ACTION)
            addAction(WifiManager.RSSI_CHANGED_ACTION)
            addAction(WifiManager.SCAN_RESULTS_AVAILABLE_ACTION)
            addAction(BluetoothAdapter.ACTION_STATE_CHANGED)
            addAction(BluetoothDevice.ACTION_ACL_CONNECTED)
            addAction(BluetoothDevice.ACTION_ACL_DISCONNECTED)
        }
        receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, intent: Intent?) {
                handle(intent ?: return)
            }
        }
        Receivers.registerExported(ctx.app, receiver!!, filter)
        emitWifi(ctx.app, "start")
        emitBt(ctx.app, "start")
        emitCell(ctx.app, "start")
        listenNetwork(ctx.app)
        st = ModuleStatus.Running
    }

    override fun tickIntervalMs(): Long = 30_000

    override fun tick(ctx: ModuleContext, sink: EventSink) {
        emitWifi(ctx.app, "tick")
        emitCell(ctx.app, "tick")
        val now = JsonUtil.nowMs()
        val interval = if (profile == "max") 60_000L else 10 * 60_000L
        val pm = ctx.app.getSystemService(Context.POWER_SERVICE) as android.os.PowerManager
        if (pm.isInteractive && now - lastScanMs >= interval && profile == "max") {
            maybeScanWifi(ctx.app)
        }
    }

    override fun stop() {
        try {
            receiver?.let { app?.unregisterReceiver(it) }
        } catch (_: Exception) {
        }
        try {
            netCb?.let {
                val cm = app?.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
                cm?.unregisterNetworkCallback(it)
            }
        } catch (_: Exception) {
        }
        st = ModuleStatus.Stopped
    }

    private fun handle(intent: Intent) {
        val c = app ?: return
        when (intent.action) {
            WifiManager.NETWORK_STATE_CHANGED_ACTION, WifiManager.RSSI_CHANGED_ACTION -> emitWifi(c, intent.action ?: "wifi")
            WifiManager.SCAN_RESULTS_AVAILABLE_ACTION -> emitScan(c)
            BluetoothAdapter.ACTION_STATE_CHANGED,
            BluetoothDevice.ACTION_ACL_CONNECTED,
            BluetoothDevice.ACTION_ACL_DISCONNECTED,
            -> emitBt(c, intent.action ?: "bt")
        }
    }

    private fun listenNetwork(app: Context) {
        val cm = app.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                emitTransport(app, "available")
            }

            override fun onLost(network: Network) {
                emitTransport(app, "lost")
            }

            override fun onCapabilitiesChanged(network: Network, caps: NetworkCapabilities) {
                emitTransport(app, "caps")
            }
        }
        netCb = cb
        try {
            cm.registerDefaultNetworkCallback(cb)
        } catch (_: Exception) {
        }
    }

    private fun emitTransport(app: Context, reason: String) {
        val cm = app.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        val n = cm.activeNetwork
        val caps = n?.let { cm.getNetworkCapabilities(it) }
        val type = when {
            caps == null -> "none"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
            caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "ethernet"
            else -> "other"
        }
        sink?.emit(id, "transport", JSONObject().kv("reason", reason).kv("type", type))
    }

    private fun emitWifi(app: Context, reason: String) {
        val wm = app.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        @Suppress("DEPRECATION")
        val info = wm.connectionInfo
        val ssid = info?.ssid?.trim('"') ?: ""
        val payload = JSONObject()
            .kv("reason", reason)
            .kv("enabled", wm.isWifiEnabled)
            .kv("ssid", if (ssid == "<unknown ssid>") "unreadable" else ssid)
            .kv("bssid", info?.bssid ?: JSONObject.NULL)
            .kv("rssi", info?.rssi ?: JSONObject.NULL)
            .kv("freq", info?.frequency ?: JSONObject.NULL)
        val sig = JsonUtil.sha256Hex(payload.toString())
        if (sig == lastWifiSig && reason == "tick") return
        lastWifiSig = sig
        sink?.emit(id, "wifi", payload)
    }

    private fun maybeScanWifi(app: Context) {
        val loc = ContextCompat.checkSelfPermission(app, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
        if (!loc) return
        val wm = app.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        lastScanMs = JsonUtil.nowMs()
        @Suppress("DEPRECATION")
        try {
            wm.startScan()
        } catch (_: Exception) {
        }
    }

    private fun emitScan(app: Context) {
        if (profile != "max") return
        val wm = app.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
        val arr = JSONArray()
        @Suppress("DEPRECATION")
        val results = try {
            wm.scanResults
        } catch (_: Exception) {
            emptyList()
        }
        for (r in results.take(30)) {
            arr.put(JSONObject().kv("ssid", r.SSID).kv("bssid", r.BSSID).kv("rssi", r.level))
        }
        sink?.emit(id, "wifi_scan", JSONObject().kv("n", results.size).kv("top", arr))
    }

    private fun emitBt(app: Context, reason: String) {
        val bm = app.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
        val ad = bm.adapter
        if (ad == null) {
            sink?.emit(id, "bluetooth", JSONObject().kv("present", false).kv("reason", reason))
            return
        }
        val state = ad.state
        val connected = JSONArray()
        if (Build.VERSION.SDK_INT < 31 ||
            ContextCompat.checkSelfPermission(app, Manifest.permission.BLUETOOTH_CONNECT) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            try {
                ad.bondedDevices?.forEach { d ->
                    connected.put(JSONObject().kv("name", d.name ?: "").kv("addr", d.address).kv("bond", d.bondState))
                }
            } catch (_: SecurityException) {
            }
        }
        sink?.emit(
            id,
            "bluetooth",
            JSONObject()
                .kv("reason", reason)
                .kv("state", state)
                .kv("enabled", state == BluetoothAdapter.STATE_ON)
                .kv("bonded", connected),
        )
    }

    private fun emitCell(app: Context, reason: String) {
        val now = JsonUtil.nowMs()
        if (reason == "tick" && now - lastCellMs < 25_000) return
        lastCellMs = now
        val tm = app.getSystemService(Context.TELEPHONY_SERVICE) as TelephonyManager
        val net = try {
            if (Build.VERSION.SDK_INT >= 24) tm.dataNetworkType else {
                @Suppress("DEPRECATION")
                tm.networkType
            }
        } catch (_: SecurityException) {
            -1
        }
        val op = try {
            tm.networkOperatorName ?: "unreadable"
        } catch (_: Exception) {
            "unreadable"
        }
        val payload = JSONObject()
            .kv("reason", reason)
            .kv("data_network_type", net)
            .kv("operator", op)
        if (ContextCompat.checkSelfPermission(app, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
        ) {
            try {
                val cells = tm.allCellInfo
                payload.kv("cell_count", cells?.size ?: 0)
            } catch (_: Exception) {
                payload.kv("cell_count", "unreadable")
            }
        } else {
            payload.kv("cell_count", "no_permission")
        }
        sink?.emit(id, "cell", payload)
    }
}
