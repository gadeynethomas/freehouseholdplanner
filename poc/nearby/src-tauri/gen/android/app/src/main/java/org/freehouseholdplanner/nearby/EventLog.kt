package org.freehouseholdplanner.nearby

import android.content.Context
import android.os.BatteryManager
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * Everything the PoC measures, as JSON lines in the app's files (`adb shell run-as
 * org.freehouseholdplanner.nearby cat files/events.jsonl`) and the last events in memory for the UI.
 * Every event carries the battery level, so a run's cost can be read from the log alone.
 */
object EventLog {
  private const val KEEP = 300
  private lateinit var file: File
  private lateinit var battery: BatteryManager
  private val recent = ArrayDeque<JSONObject>()

  @Synchronized
  fun init(context: Context) {
    if (::file.isInitialized) return
    file = File(context.filesDir, "events.jsonl")
    battery = context.getSystemService(BatteryManager::class.java)
    if (file.exists()) file.readLines().takeLast(KEEP).forEach { recent.addLast(JSONObject(it)) }
  }

  @Synchronized
  fun log(kind: String, vararg fields: Pair<String, Any?>) {
    val event = JSONObject()
      .put("t", System.currentTimeMillis())
      .put("kind", kind)
      .put("battery", battery.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY))
    fields.forEach { (key, value) -> event.put(key, value) }
    file.appendText("$event\n")
    recent.addLast(event)
    while (recent.size > KEEP) recent.removeFirst()
  }

  @Synchronized
  fun recent(): JSONArray = JSONArray().apply { recent.forEach { put(it) } }

  @Synchronized
  fun clear() {
    recent.clear()
    file.writeText("")
  }
}
