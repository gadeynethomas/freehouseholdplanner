package org.freehouseholdplanner.nearby

import android.content.Context
import java.io.File
import java.security.SecureRandom

/** The phone's edits, its own and those received, kept in a small text file (one edit per line). */
object EditStore : EditSource {
  private lateinit var file: File
  private val edits = LinkedHashMap<String, Edit>()
  private val listeners = mutableListOf<() -> Unit>()
  lateinit var deviceId: String
    private set

  @Synchronized
  fun init(context: Context) {
    if (::file.isInitialized) return
    val prefs = context.getSharedPreferences("nearby", Context.MODE_PRIVATE)
    deviceId = prefs.getString("deviceId", null) ?: Household.hex(ByteArray(4).also { SecureRandom().nextBytes(it) })
      .also { prefs.edit().putString("deviceId", it).apply() }
    file = File(context.filesDir, "edits.tsv")
    if (file.exists()) {
      file.forEachLine { line ->
        val parts = line.split('\t')
        if (parts.size == 3) edits[parts[0]] = Edit(parts[0], parts[1].toLong(), parts[2].toInt())
      }
    }
  }

  fun create(size: Int, now: Long): Edit {
    val edit = synchronized(this) {
      val seq = edits.keys.count { it.startsWith("$deviceId:") } + 1
      Edit("$deviceId:$seq", now, size).also(::store)
    }
    notifyListeners()
    return edit
  }

  @Synchronized
  override fun ids(): Set<String> = edits.keys.toSet()

  @Synchronized
  override fun missingFrom(peerIds: Set<String>): List<Edit> = edits.values.filter { it.id !in peerIds }

  override fun add(edit: Edit): Boolean {
    synchronized(this) {
      if (edit.id in edits) return false
      store(edit)
    }
    notifyListeners()
    return true
  }

  @Synchronized
  fun digest(): ByteArray = Household.digest(edits.keys)

  @Synchronized
  fun count(): Int = edits.size

  @Synchronized
  fun onChange(listener: () -> Unit) {
    listeners += listener
  }

  private fun store(edit: Edit) {
    edits[edit.id] = edit
    file.appendText("${edit.id}\t${edit.createdAt}\t${edit.size}\n")
  }

  /** Outside the lock: listeners take other locks (Ble, Aware) that may call back into this store. */
  private fun notifyListeners() {
    synchronized(this) { listeners.toList() }.forEach { it() }
  }
}
