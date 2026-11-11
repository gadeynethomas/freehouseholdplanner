package org.freehouseholdplanner.nearby

import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanResult
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import kotlin.concurrent.thread

/**
 * Woken by the system's background scan (see [Ble.setBackgroundScan]), also when the app is closed.
 * [goAsync] keeps the process alive while the session runs; a background broadcast may take up to
 * about a minute, so a session is cut off after 25 s. Whether that suffices is what the PoC measures.
 */
class ScanReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    Nearby.init(context)
    val error = intent.getIntExtra(BluetoothLeScanner.EXTRA_ERROR_CODE, 0)
    if (error != 0) {
      EventLog.log("scan-failed", "source" to "background", "code" to error)
      return
    }
    val results = intent.getParcelableArrayListExtra(
      BluetoothLeScanner.EXTRA_LIST_SCAN_RESULT,
      ScanResult::class.java,
    ) ?: return
    countWake(results.size)
    val pending = goAsync()
    thread(name = "scan-receiver") {
      try {
        val deadline = System.currentTimeMillis() + BUDGET_MS
        results.mapNotNull { Ble.handle(context.applicationContext, it, "background") }
          .forEach { it.join((deadline - System.currentTimeMillis()).coerceAtLeast(1)) }
      } finally {
        pending.finish()
      }
    }
  }

  private companion object {
    const val BUDGET_MS = 25_000L
    const val WAKE_LOG_INTERVAL_MS = 60_000L
    var wakes = 0
    var resultCount = 0
    var lastWakeLog = 0L

    /** How often the system wakes the app matters for battery; logged at most once a minute. */
    @Synchronized
    fun countWake(count: Int) {
      wakes++
      resultCount += count
      val now = System.currentTimeMillis()
      if (now - lastWakeLog < WAKE_LOG_INTERVAL_MS) return
      EventLog.log("wakes", "wakes" to wakes, "results" to resultCount)
      wakes = 0
      resultCount = 0
      lastWakeLog = now
    }
  }
}
