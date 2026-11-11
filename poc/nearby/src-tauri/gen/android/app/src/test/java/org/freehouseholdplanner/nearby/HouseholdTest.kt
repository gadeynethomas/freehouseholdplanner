package org.freehouseholdplanner.nearby

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** K12: what a phone advertises, and how a household phone recognises it. */
class HouseholdTest {
  private val windowMs = Household.WINDOW_SECONDS * 1000
  private val now = 1_800_000_000_000L
  private val digest = Household.digest(listOf("0a0b0c0d:1"))

  @Test
  fun payloadFitsTheLegacyAdvertisement() {
    // 31 bytes: flags (3) + service data header (2) + 128-bit UUID (16) + payload.
    assertTrue(3 + 2 + 16 + Household.PAYLOAD_SIZE <= 31)
  }

  @Test
  fun parsesOwnPayloadWithChannel() {
    val advert = Household.parse(Household.payload(Household.window(now), digest, 0x0081), now)
    assertNotNull(advert)
    assertEquals(0x0081, advert!!.psm)
    assertFalse(Household.differs(advert, digest))
  }

  @Test
  fun channelAboveSignedShortRange() {
    val advert = Household.parse(Household.payload(Household.window(now), digest, 0xFFFF), now)
    assertEquals(0xFFFF, advert!!.psm)
  }

  @Test
  fun acceptsNeighbouringWindowsOnly() {
    val window = Household.window(now)
    assertNotNull(Household.parse(Household.payload(window - 1, digest, 1), now))
    assertNotNull(Household.parse(Household.payload(window + 1, digest, 1), now))
    assertNull(Household.parse(Household.payload(window - 2, digest, 1), now))
    assertNull(Household.parse(Household.payload(window + 2, digest, 1), now))
  }

  @Test
  fun tokenChangesEveryWindow() {
    val window = Household.window(now)
    assertNotEquals(Household.hex(Household.token(window)), Household.hex(Household.token(window + 1)))
    assertEquals(window + 1, Household.window(now + windowMs))
  }

  @Test
  fun sameEditsGiveDifferentTagsInDifferentWindows() {
    val window = Household.window(now)
    assertNotEquals(
      Household.hex(Household.stateTag(window, digest)),
      Household.hex(Household.stateTag(window + 1, digest)),
    )
  }

  @Test
  fun detectsOtherEdits() {
    val advert = Household.parse(Household.payload(Household.window(now), digest, 1), now)!!
    assertTrue(Household.differs(advert, Household.digest(listOf("0a0b0c0d:1", "0a0b0c0d:2"))))
    assertTrue(Household.differs(advert, Household.digest(emptyList())))
  }

  @Test
  fun digestIgnoresOrder() {
    assertEquals(
      Household.hex(Household.digest(listOf("a", "b"))),
      Household.hex(Household.digest(listOf("b", "a"))),
    )
  }

  @Test
  fun rejectsForeignOrMalformedBytes() {
    assertNull(Household.parse(null, now))
    assertNull(Household.parse(ByteArray(0), now))
    assertNull(Household.parse(ByteArray(Household.PAYLOAD_SIZE), now))
    assertNull(Household.parse(ByteArray(Household.PAYLOAD_SIZE + 1), now))
  }

  @Test
  fun awarePassphraseHasValidLength() {
    assertTrue(Household.awarePassphrase.length in 8..63)
  }
}
