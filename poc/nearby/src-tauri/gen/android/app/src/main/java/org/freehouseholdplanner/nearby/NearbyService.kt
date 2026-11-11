package org.freehouseholdplanner.nearby

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Handler
import android.os.IBinder
import android.os.Looper

/**
 * Keeps the phone findable while it has edits to share (K12): advertises over Bluetooth, accepts
 * L2CAP channels, scans in the foreground and, when switched on, runs Wi-Fi Aware. Type
 * `connectedDevice`, as tested in poc/android. Every 10 minutes it logs a tick, so the battery
 * curve of a run can be read from the log.
 */
class NearbyService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private var minutes = 0
  private val tick = object : Runnable {
    override fun run() {
      Ble.refreshAdvertising(this@NearbyService)
      Aware.refresh()
      if (++minutes % 10 == 0) EventLog.log("tick")
      handler.postDelayed(this, 60_000)
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    Nearby.init(this)
    startForeground(NOTIFICATION_ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
    try {
      Ble.startServer(this)
      Ble.refreshAdvertising(this)
      Ble.startForegroundScan(this)
    } catch (error: SecurityException) {
      EventLog.log("service-error", "error" to error.toString())
    }
    if (Nearby.prefs.getBoolean(PREF_AWARE, false)) Aware.start(this)
    handler.removeCallbacks(tick)
    handler.postDelayed(tick, 60_000)
    EventLog.log("service", "on" to true)
    return START_STICKY
  }

  override fun onDestroy() {
    handler.removeCallbacks(tick)
    Ble.stopForegroundScan(this)
    Ble.stopAdvertising(this)
    Ble.stopServer()
    Aware.stop()
    EventLog.log("service", "on" to false)
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun notification(): Notification {
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "Synchroniseren in de buurt", NotificationManager.IMPORTANCE_LOW)
    )
    return Notification.Builder(this, CHANNEL_ID)
      .setContentTitle("FHP Nearby")
      .setContentText("Deelt wijzigingen met gsm's in de buurt…")
      .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
      .setOngoing(true)
      .build()
  }

  companion object {
    const val PREF_AWARE = "aware"
    const val PREF_SERVICE = "service"
    const val PREF_BACKGROUND_SCAN = "backgroundScan"
    private const val CHANNEL_ID = "nearby-sync"
    private const val NOTIFICATION_ID = 1
  }
}
