package org.freehouseholdplanner.nearby

import android.content.Context
import android.content.SharedPreferences
import java.io.Closeable
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.util.Timer
import java.util.TimerTask

/** Shared state of the PoC: settings, and running one sync session with logging. */
object Nearby {
  private const val RETRY_AFTER_MS = 10_000L
  private val lastAttempt = HashMap<String, Long>()
  private var outgoing = 0
  lateinit var prefs: SharedPreferences
    private set

  @Synchronized
  fun init(context: Context) {
    if (::prefs.isInitialized) return
    val app = context.applicationContext
    EditStore.init(app)
    EventLog.init(app)
    prefs = app.getSharedPreferences("nearby", Context.MODE_PRIVATE)
    EditStore.onChange {
      Ble.refreshAdvertising(app)
      Aware.refresh()
    }
  }

  /**
   * Whether to start an outgoing session to [peer] now: at most one at a time, and not the same
   * peer again within 10 s (scan results arrive many times per second).
   */
  @Synchronized
  fun claim(peer: String, now: Long): Boolean {
    if (outgoing > 0) return false
    if (now - (lastAttempt[peer] ?: 0L) < RETRY_AFTER_MS) return false
    lastAttempt[peer] = now
    outgoing++
    return true
  }

  @Synchronized
  fun release() {
    outgoing--
  }

  /** Runs one exchange and logs what it moved. [startedAt] is when the peer was seen. */
  fun exchange(transport: String, role: String, startedAt: Long, input: InputStream, output: OutputStream) {
    val connectedAt = System.currentTimeMillis()
    val result = SyncSession(EditStore).run(input, output)
    val doneAt = System.currentTimeMillis()
    result.received.forEach { (edit, receivedAt) ->
      EventLog.log(
        "received",
        "transport" to transport,
        "id" to edit.id,
        "size" to edit.size,
        "latencyMs" to receivedAt - edit.createdAt,
      )
    }
    EventLog.log(
      "sync",
      "transport" to transport,
      "role" to role,
      "sent" to result.sent,
      "received" to result.received.size,
      "bytesOut" to result.bytesOut,
      "bytesIn" to result.bytesIn,
      "connectMs" to connectedAt - startedAt,
      "transferMs" to doneAt - connectedAt,
    )
  }

  /**
   * Runs [block] and closes [resource] if it takes longer than [ms]. Reads on an L2CAP channel have
   * no timeout of their own, so a peer that walks away would otherwise block the thread forever.
   */
  fun withDeadline(resource: Closeable, ms: Long, block: () -> Unit) {
    val timer = Timer("deadline", true)
    timer.schedule(object : TimerTask() {
      override fun run() {
        try {
          resource.close()
        } catch (_: IOException) {
          // Already closed.
        }
      }
    }, ms)
    try {
      block()
    } finally {
      timer.cancel()
    }
  }

  fun failed(transport: String, role: String, error: Throwable) {
    EventLog.log("sync-failed", "transport" to transport, "role" to role, "error" to error.toString())
  }
}
