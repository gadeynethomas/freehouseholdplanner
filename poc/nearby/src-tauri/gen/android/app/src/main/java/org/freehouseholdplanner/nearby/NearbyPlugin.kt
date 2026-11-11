package org.freehouseholdplanner.nearby

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@InvokeArg
class EditArgs {
  var size: Int = 1024
}

@InvokeArg
class ToggleArgs {
  var enabled: Boolean = false
}

/** The UI's view on the PoC: state, the log, and the switches (called through `nearby` in lib.rs). */
@TauriPlugin
class NearbyPlugin(private val activity: Activity) : Plugin(activity) {
  init {
    Nearby.init(activity)
  }

  @Command
  fun status(invoke: Invoke) {
    val adapter = Ble.adapter(activity)
    val permissions = JSObject()
    RUNTIME_PERMISSIONS.forEach { (name, permission) -> permissions.put(name, granted(permission)) }
    invoke.resolve(
      JSObject().apply {
        put("deviceId", EditStore.deviceId)
        put("edits", EditStore.count())
        put("digest", Household.hex(EditStore.digest()).take(8))
        put("bluetooth", adapter?.isEnabled == true)
        put("awareSupported", Aware.supported(activity))
        put("awareAvailable", Aware.available(activity))
        put("psm", Ble.psm)
        put("service", Nearby.prefs.getBoolean(NearbyService.PREF_SERVICE, false))
        put("backgroundScan", Nearby.prefs.getBoolean(NearbyService.PREF_BACKGROUND_SCAN, false))
        put("aware", Nearby.prefs.getBoolean(NearbyService.PREF_AWARE, false))
        put("permissions", permissions)
        put("events", EventLog.recent())
      },
    )
  }

  @Command
  fun edit(invoke: Invoke) {
    val size = invoke.parseArgs(EditArgs::class.java).size.coerceIn(0, SyncSession.MAX_EDIT_SIZE)
    val edit = EditStore.create(size, System.currentTimeMillis())
    EventLog.log("edit", "id" to edit.id, "size" to size)
    invoke.resolve()
  }

  @Command
  fun setService(invoke: Invoke) {
    val enabled = invoke.parseArgs(ToggleArgs::class.java).enabled
    val intent = Intent(activity, NearbyService::class.java)
    try {
      // Android refuses to start a foreground service while the app is not visible (locked phone).
      if (enabled) activity.startForegroundService(intent) else activity.stopService(intent)
    } catch (error: IllegalStateException) {
      invoke.reject(error.toString())
      return
    }
    Nearby.prefs.edit().putBoolean(NearbyService.PREF_SERVICE, enabled).apply()
    invoke.resolve()
  }

  @Command
  fun setBackgroundScan(invoke: Invoke) {
    val enabled = invoke.parseArgs(ToggleArgs::class.java).enabled
    Nearby.prefs.edit().putBoolean(NearbyService.PREF_BACKGROUND_SCAN, enabled).apply()
    try {
      Ble.setBackgroundScan(activity, enabled)
      invoke.resolve()
    } catch (error: SecurityException) {
      invoke.reject(error.toString())
    }
  }

  @Command
  fun setAware(invoke: Invoke) {
    val enabled = invoke.parseArgs(ToggleArgs::class.java).enabled
    Nearby.prefs.edit().putBoolean(NearbyService.PREF_AWARE, enabled).apply()
    // Takes effect at once when the service runs; otherwise the next time it starts.
    if (Nearby.prefs.getBoolean(NearbyService.PREF_SERVICE, false)) {
      if (enabled) Aware.start(activity) else Aware.stop()
    }
    invoke.resolve()
  }

  @Command
  fun clearLog(invoke: Invoke) {
    EventLog.clear()
    invoke.resolve()
  }

  @Command
  fun askPermissions(invoke: Invoke) {
    val missing = RUNTIME_PERMISSIONS.map { it.second }.filterNot(::granted)
    if (missing.isNotEmpty()) activity.requestPermissions(missing.toTypedArray(), PERMISSION_REQUEST)
    invoke.resolve()
  }

  private fun granted(permission: String): Boolean =
    activity.checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED

  private companion object {
    const val PERMISSION_REQUEST = 3
    val RUNTIME_PERMISSIONS = buildList {
      add("scan" to Manifest.permission.BLUETOOTH_SCAN)
      add("advertise" to Manifest.permission.BLUETOOTH_ADVERTISE)
      add("connect" to Manifest.permission.BLUETOOTH_CONNECT)
      add("nearbyWifi" to Manifest.permission.NEARBY_WIFI_DEVICES)
      add("notifications" to Manifest.permission.POST_NOTIFICATIONS)
      if (Build.VERSION.SDK_INT >= 37) add("localNetwork" to Manifest.permission.ACCESS_LOCAL_NETWORK)
    }
  }
}
