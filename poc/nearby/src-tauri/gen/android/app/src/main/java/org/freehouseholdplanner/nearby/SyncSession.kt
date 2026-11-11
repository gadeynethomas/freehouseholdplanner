package org.freehouseholdplanner.nearby

import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import kotlin.concurrent.thread

/** A synthetic edit: the PoC measures how fast edits travel, not what they contain. */
data class Edit(val id: String, val createdAt: Long, val size: Int)

/** Where a session reads and stores edits. */
interface EditSource {
  fun ids(): Set<String>
  fun missingFrom(peerIds: Set<String>): List<Edit>
  /** Stores an edit from a peer; false when it was already known. */
  fun add(edit: Edit): Boolean
}

/**
 * One symmetric exchange over any byte stream (an L2CAP channel or a TCP socket): both sides send
 * the ids they hold, then the edits the other lacks, then DONE. A writer thread sends while the
 * caller reads, so two large transfers in opposite directions cannot block each other.
 *
 * Binary framing (DataOutputStream), every field bounded: whatever a peer sends is untrusted.
 * PoC only: the stream is not encrypted. The real app runs Noise KK on top (K4).
 */
class SyncSession(private val source: EditSource, private val now: () -> Long = System::currentTimeMillis) {
  data class Received(val edit: Edit, val receivedAt: Long)
  data class Result(val sent: Int, val received: List<Received>, val bytesOut: Long, val bytesIn: Long)

  fun run(input: InputStream, output: OutputStream): Result {
    val reader = CountingInput(input)
    val writer = CountingOutput(output)
    // Buffered, so a frame goes out in few writes: every write is a packet on an L2CAP channel.
    val data = DataOutputStream(BufferedOutputStream(writer, BUFFER_SIZE))
    val dataIn = DataInputStream(BufferedInputStream(reader, BUFFER_SIZE))

    writeHave(data, source.ids())
    val peerIds = readHave(dataIn)
    val toSend = source.missingFrom(peerIds)
    var writeError: Throwable? = null
    val sender = thread(name = "sync-writer") {
      try {
        toSend.forEach { writeEdit(data, it) }
        data.writeByte(DONE)
        data.flush()
      } catch (error: Throwable) {
        writeError = error
      }
    }

    val received = mutableListOf<Received>()
    while (true) {
      when (val type = dataIn.readUnsignedByte()) {
        EDIT -> {
          val edit = readEdit(dataIn)
          if (source.add(edit)) received += Received(edit, now())
        }
        DONE -> break
        else -> throw IOException("unexpected frame type $type")
      }
    }
    sender.join()
    writeError?.let { throw IOException("sending failed", it) }
    return Result(toSend.size, received, writer.count, reader.count)
  }

  companion object {
    const val HAVE = 1
    const val EDIT = 2
    const val DONE = 3
    const val MAX_IDS = 10_000
    const val MAX_ID_LENGTH = 64
    const val MAX_EDIT_SIZE = 256 * 1024
    private const val BUFFER_SIZE = 16 * 1024
    private val PADDING = ByteArray(8 * 1024) { 'x'.code.toByte() }

    fun writeHave(out: DataOutputStream, ids: Set<String>) {
      require(ids.size <= MAX_IDS)
      out.writeByte(HAVE)
      out.writeShort(ids.size)
      ids.forEach { out.writeUTF(it) }
      out.flush()
    }

    fun readHave(input: DataInputStream): Set<String> {
      val type = input.readUnsignedByte()
      if (type != HAVE) throw IOException("expected HAVE, got $type")
      val count = input.readUnsignedShort()
      if (count > MAX_IDS) throw IOException("too many ids: $count")
      return (0 until count).mapTo(HashSet()) { readId(input) }
    }

    fun writeEdit(out: DataOutputStream, edit: Edit) {
      out.writeByte(EDIT)
      out.writeUTF(edit.id)
      out.writeLong(edit.createdAt)
      out.writeInt(edit.size)
      var left = edit.size
      while (left > 0) {
        val chunk = minOf(left, PADDING.size)
        out.write(PADDING, 0, chunk)
        left -= chunk
      }
    }

    fun readEdit(input: DataInputStream): Edit {
      val id = readId(input)
      val createdAt = input.readLong()
      val size = input.readInt()
      if (size !in 0..MAX_EDIT_SIZE) throw IOException("edit size out of range: $size")
      input.skipNBytesCompat(size)
      return Edit(id, createdAt, size)
    }

    private fun readId(input: DataInputStream): String {
      val id = input.readUTF()
      if (id.isEmpty() || id.length > MAX_ID_LENGTH || !ID_PATTERN.matches(id)) {
        throw IOException("malformed edit id")
      }
      return id
    }

    private val ID_PATTERN = Regex("[0-9a-f]{8}:[0-9]{1,9}")

    private fun DataInputStream.skipNBytesCompat(count: Int) {
      val buffer = ByteArray(8 * 1024)
      var left = count
      while (left > 0) {
        val read = read(buffer, 0, minOf(left, buffer.size))
        if (read < 0) throw IOException("stream ended inside an edit")
        left -= read
      }
    }
  }

  private class CountingInput(private val inner: InputStream) : InputStream() {
    var count = 0L
    override fun read(): Int = inner.read().also { if (it >= 0) count++ }
    override fun read(b: ByteArray, off: Int, len: Int): Int =
      inner.read(b, off, len).also { if (it > 0) count += it }
  }

  private class CountingOutput(private val inner: OutputStream) : OutputStream() {
    @Volatile var count = 0L
    override fun write(b: Int) {
      inner.write(b)
      count++
    }
    override fun write(b: ByteArray, off: Int, len: Int) {
      inner.write(b, off, len)
      count += len
    }
    override fun flush() = inner.flush()
  }
}
