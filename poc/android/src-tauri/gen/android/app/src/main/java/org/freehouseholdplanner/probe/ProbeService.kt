package org.freehouseholdplanner.probe

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder

/**
 * A foreground service with a visible notification. It does no work itself: the sync thread runs
 * in Rust in the same process. The service only tells Android to keep that process running.
 */
class ProbeService : Service() {
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, "Synchroniseren", NotificationManager.IMPORTANCE_LOW)
    )
    val notification = Notification.Builder(this, CHANNEL_ID)
      .setContentTitle("FHP Probe")
      .setContentText("Synchroniseert met de andere apparaten…")
      .setSmallIcon(android.R.drawable.stat_notify_sync)
      .setOngoing(true)
      .build()
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
    } else {
      startForeground(NOTIFICATION_ID, notification)
    }
    return START_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private companion object {
    const val CHANNEL_ID = "probe-sync"
    const val NOTIFICATION_ID = 1
  }
}
