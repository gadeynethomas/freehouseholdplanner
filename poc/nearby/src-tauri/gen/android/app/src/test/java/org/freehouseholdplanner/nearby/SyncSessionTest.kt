package org.freehouseholdplanner.nearby

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.io.IOException
import java.io.PipedInputStream
import java.io.PipedOutputStream
import java.util.concurrent.Callable
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** K12: two phones exchange exactly the edits the other lacks, in both directions at once. */
class SyncSessionTest {
  private class MemorySource(vararg edits: Edit) : EditSource {
    val edits = edits.associateBy { it.id }.toMutableMap()
    @Synchronized override fun ids(): Set<String> = edits.keys.toSet()
    @Synchronized override fun missingFrom(peerIds: Set<String>): List<Edit> = edits.values.filter { it.id !in peerIds }
    @Synchronized override fun add(edit: Edit): Boolean = edits.putIfAbsent(edit.id, edit) == null
  }

  private fun edit(device: String, seq: Int, size: Int = 10) = Edit("$device:$seq", 1_000L + seq, size)

  private fun exchange(a: MemorySource, b: MemorySource): Pair<SyncSession.Result, SyncSession.Result> {
    val aToB = PipedOutputStream()
    val bIn = PipedInputStream(aToB, 64 * 1024)
    val bToA = PipedOutputStream()
    val aIn = PipedInputStream(bToA, 64 * 1024)
    val pool = Executors.newFixedThreadPool(2)
    try {
      val first = pool.submit(Callable { SyncSession(a).run(aIn, aToB).also { aToB.close() } })
      val second = pool.submit(Callable { SyncSession(b).run(bIn, bToA).also { bToA.close() } })
      return first.get(10, TimeUnit.SECONDS) to second.get(10, TimeUnit.SECONDS)
    } finally {
      pool.shutdownNow()
    }
  }

  @Test
  fun bothSidesEndWithAllEdits() {
    val a = MemorySource(edit("aaaaaaaa", 1), edit("aaaaaaaa", 2), edit("cccccccc", 1))
    val b = MemorySource(edit("bbbbbbbb", 1), edit("cccccccc", 1))
    val (fromA, fromB) = exchange(a, b)
    assertEquals(a.ids(), b.ids())
    assertEquals(4, a.ids().size)
    assertEquals(2, fromA.sent)
    assertEquals(1, fromB.sent)
    assertEquals(listOf("bbbbbbbb:1"), fromA.received.map { it.edit.id })
  }

  @Test
  fun emptyPhonesExchangeNothing() {
    val (fromA, fromB) = exchange(MemorySource(), MemorySource())
    assertEquals(0, fromA.sent + fromB.sent)
    assertTrue(fromA.received.isEmpty() && fromB.received.isEmpty())
  }

  @Test
  fun largeEditsInBothDirectionsDoNotBlock() {
    // Each side sends more than the pipe holds before it reads: needs the writer thread.
    val big = SyncSession.MAX_EDIT_SIZE
    val a = MemorySource(edit("aaaaaaaa", 1, big), edit("aaaaaaaa", 2, big))
    val b = MemorySource(edit("bbbbbbbb", 1, big), edit("bbbbbbbb", 2, big))
    val (fromA, _) = exchange(a, b)
    assertEquals(4, a.ids().size)
    assertEquals(4, b.ids().size)
    assertTrue(fromA.bytesOut > 2L * big)
  }

  private fun runAgainst(bytes: ByteArray): Result<SyncSession.Result> =
    runCatching { SyncSession(MemorySource()).run(ByteArrayInputStream(bytes), ByteArrayOutputStream()) }

  private fun frames(write: DataOutputStream.() -> Unit): ByteArray =
    ByteArrayOutputStream().also { DataOutputStream(it).write() }.toByteArray()

  @Test
  fun rejectsOversizedEdit() {
    val bytes = frames {
      SyncSession.writeHave(this, emptySet())
      writeByte(SyncSession.EDIT)
      writeUTF("aaaaaaaa:1")
      writeLong(1)
      writeInt(SyncSession.MAX_EDIT_SIZE + 1)
    }
    assertTrue(runAgainst(bytes).exceptionOrNull() is IOException)
  }

  @Test
  fun rejectsNegativeEditSize() {
    val bytes = frames {
      SyncSession.writeHave(this, emptySet())
      writeByte(SyncSession.EDIT)
      writeUTF("aaaaaaaa:1")
      writeLong(1)
      writeInt(-1)
    }
    assertTrue(runAgainst(bytes).exceptionOrNull() is IOException)
  }

  @Test
  fun rejectsMalformedId() {
    val bytes = frames {
      writeByte(SyncSession.HAVE)
      writeShort(1)
      writeUTF("../../etc")
    }
    assertTrue(runAgainst(bytes).exceptionOrNull() is IOException)
  }

  @Test
  fun rejectsTooManyIds() {
    val bytes = frames {
      writeByte(SyncSession.HAVE)
      writeShort(SyncSession.MAX_IDS + 1)
    }
    assertTrue(runAgainst(bytes).exceptionOrNull() is IOException)
  }

  @Test
  fun rejectsUnknownFrameAndTruncatedStream() {
    assertTrue(runAgainst(frames { SyncSession.writeHave(this, emptySet()); writeByte(9) }).isFailure)
    assertTrue(runAgainst(frames { SyncSession.writeHave(this, emptySet()) }).isFailure)
    assertTrue(runAgainst(ByteArray(0)).isFailure)
  }
}
