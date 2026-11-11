package org.freehouseholdplanner.probe

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

/** Lets the Rust side start and stop the foreground service (`service` module in lib.rs). */
@TauriPlugin
class ServicePlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun start(invoke: Invoke) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
      activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
    ) {
      // Without this permission the service still runs; its notification is only less visible.
      activity.requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
    }
    activity.startForegroundService(Intent(activity, ProbeService::class.java))
    invoke.resolve()
  }

  @Command
  fun stop(invoke: Invoke) {
    activity.stopService(Intent(activity, ProbeService::class.java))
    invoke.resolve()
  }
}
