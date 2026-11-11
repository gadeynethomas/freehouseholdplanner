package org.freehouseholdplanner.nearby

import java.nio.ByteBuffer
import java.security.MessageDigest
import java.util.UUID
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * What a phone puts in the air, and how another phone of the same household recognises it (K12).
 *
 * The advertisement carries no fixed identifier: a token derived from the household key and the
 * current 15-minute window, and a state tag derived from the window and the phone's set of edits.
 * A stranger sees random bytes that change every window; a household phone recomputes both and
 * compares. PoC only: both phones run the same build and share [SECRET]. The real app derives the
 * key at pairing (K2).
 */
object Household {
  private val SECRET = "fhp-nearby-poc-household-key-v1".toByteArray()

  /** App-wide service UUID for the scan filter; reveals the app, not the household. */
  val SERVICE_UUID: UUID = UUID.fromString("6f1d0b6e-2a4c-4f0e-9a51-6b0c1f6c2e10")
  const val WINDOW_SECONDS = 900L
  const val TOKEN_SIZE = 6
  const val TAG_SIZE = 2
  const val PAYLOAD_SIZE = TOKEN_SIZE + TAG_SIZE + 2

  /** Passphrase for the Wi-Fi Aware data path (8–63 characters). */
  val awarePassphrase: String = hex(hmac("aware".toByteArray())).take(32)

  fun window(nowMs: Long): Long = nowMs / 1000 / WINDOW_SECONDS

  fun token(window: Long): ByteArray = hmac(label("token", window)).copyOf(TOKEN_SIZE)

  fun stateTag(window: Long, digest: ByteArray): ByteArray =
    hmac(label("state", window) + digest).copyOf(TAG_SIZE)

  /** Advertised bytes: token, state tag, and the L2CAP channel (PSM) to connect to. */
  fun payload(window: Long, digest: ByteArray, psm: Int): ByteArray =
    ByteBuffer.allocate(PAYLOAD_SIZE)
      .put(token(window))
      .put(stateTag(window, digest))
      .putShort(psm.toShort())
      .array()

  data class Advert(val window: Long, val tag: ByteArray, val psm: Int)

  /**
   * Reads a household advertisement, or null when it is not ours. Accepts the neighbouring windows
   * too, so clocks a few minutes apart still match.
   */
  fun parse(bytes: ByteArray?, nowMs: Long): Advert? {
    if (bytes == null || bytes.size != PAYLOAD_SIZE) return null
    val token = bytes.copyOfRange(0, TOKEN_SIZE)
    val now = window(nowMs)
    val window = listOf(now, now - 1, now + 1).firstOrNull {
      MessageDigest.isEqual(token(it), token)
    } ?: return null
    val tag = bytes.copyOfRange(TOKEN_SIZE, TOKEN_SIZE + TAG_SIZE)
    val psm = ByteBuffer.wrap(bytes, TOKEN_SIZE + TAG_SIZE, 2).short.toInt() and 0xFFFF
    return Advert(window, tag, psm)
  }

  /** True when the peer's edits differ from ours, judged in the peer's window. */
  fun differs(advert: Advert, ownDigest: ByteArray): Boolean =
    !MessageDigest.isEqual(stateTag(advert.window, ownDigest), advert.tag)

  fun digest(ids: Collection<String>): ByteArray =
    MessageDigest.getInstance("SHA-256").digest(ids.sorted().joinToString("\n").toByteArray())

  fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

  private fun label(name: String, window: Long): ByteArray =
    name.toByteArray() + ByteBuffer.allocate(8).putLong(window).array()

  private fun hmac(data: ByteArray): ByteArray =
    Mac.getInstance("HmacSHA256").run {
      init(SecretKeySpec(SECRET, "HmacSHA256"))
      doFinal(data)
    }
}
