package org.freehouseholdplanner.nearby

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothServerSocket
import android.bluetooth.BluetoothSocket
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.Intent
import android.os.ParcelUuid
import java.io.IOException
import kotlin.concurrent.thread

/**
 * Bluetooth LE part of K12. A phone with the service on advertises its household token and state
 * tag, and accepts L2CAP channels. A phone that sees an advertisement whose state differs from its
 * own connects and runs one [SyncSession]. Scanning runs either inside the service (foreground) or
 * as a system scan that wakes the app through [ScanReceiver] (background, no service needed).
 *
 * Permissions (BLUETOOTH_SCAN/ADVERTISE/CONNECT) are checked by Android; a missing one surfaces as
 * a SecurityException, which the callers log.
 */
@SuppressLint("MissingPermission")
object Ble {
  private const val SESSION_DEADLINE_MS = 60_000L
  private val serviceUuid = ParcelUuid(Household.SERVICE_UUID)
  private var server: BluetoothServerSocket? = null
  private var advertising: AdvertiseCallback? = null
  private var advertisedKey: String? = null
  private var foregroundScan: ScanCallback? = null

  val psm: Int? get() = server?.psm

  fun adapter(context: Context): BluetoothAdapter? =
    context.getSystemService(BluetoothManager::class.java)?.adapter

  @Synchronized
  fun startServer(context: Context) {
    if (server != null) return
    val socket = adapter(context)?.listenUsingInsecureL2capChannel() ?: return
    server = socket
    EventLog.log("ble-server", "psm" to socket.psm)
    thread(name = "l2cap-accept") {
      while (true) {
        val client = try {
          socket.accept()
        } catch (_: IOException) {
          break
        }
        thread(name = "l2cap-server") { serve(client) }
      }
    }
  }

  @Synchronized
  fun stopServer() {
    server?.close()
    server = null
  }

  private fun serve(client: BluetoothSocket) {
    val acceptedAt = System.currentTimeMillis()
    client.use {
      try {
        Nearby.withDeadline(it, SESSION_DEADLINE_MS) {
          Nearby.exchange("ble", "server", acceptedAt, it.inputStream, it.outputStream)
        }
      } catch (error: IOException) {
        Nearby.failed("ble", "server", error)
      }
    }
  }

  /** (Re)starts advertising when the window, the edits or the channel changed. */
  @Synchronized
  fun refreshAdvertising(context: Context) {
    val psm = server?.psm ?: return
    val window = Household.window(System.currentTimeMillis())
    val digest = EditStore.digest()
    val key = "$window:${Household.hex(digest)}:$psm"
    if (key == advertisedKey) return
    stopAdvertising(context)
    val advertiser = adapter(context)?.bluetoothLeAdvertiser
    if (advertiser == null) {
      EventLog.log("advertise-failed", "error" to "Bluetooth is off")
      return
    }
    val data = AdvertiseData.Builder()
      .setIncludeDeviceName(false)
      .setIncludeTxPowerLevel(false)
      .addServiceData(serviceUuid, Household.payload(window, digest, psm))
      .build()
    val settings = AdvertiseSettings.Builder()
      .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_BALANCED)
      .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_MEDIUM)
      .setConnectable(true)
      .setTimeout(0)
      .build()
    val callback = object : AdvertiseCallback() {
      override fun onStartSuccess(settingsInEffect: AdvertiseSettings) {
        EventLog.log("advertising", "window" to window, "edits" to EditStore.count())
      }

      override fun onStartFailure(errorCode: Int) {
        EventLog.log("advertise-failed", "code" to errorCode)
        synchronized(this@Ble) { advertisedKey = null }
      }
    }
    advertiser.startAdvertising(settings, data, callback)
    advertising = callback
    advertisedKey = key
  }

  @Synchronized
  fun stopAdvertising(context: Context) {
    advertising?.let { adapter(context)?.bluetoothLeAdvertiser?.stopAdvertising(it) }
    advertising = null
    advertisedKey = null
  }

  /** Matches any advertisement with our service UUID; the token is checked in software. */
  private fun filters(): List<ScanFilter> =
    listOf(ScanFilter.Builder().setServiceData(serviceUuid, ByteArray(0), ByteArray(0)).build())

  @Synchronized
  fun startForegroundScan(context: Context) {
    if (foregroundScan != null) return
    val scanner = adapter(context)?.bluetoothLeScanner ?: return
    val callback = object : ScanCallback() {
      override fun onScanResult(callbackType: Int, result: ScanResult) {
        handle(context, result, "foreground")
      }

      override fun onScanFailed(errorCode: Int) {
        EventLog.log("scan-failed", "source" to "foreground", "code" to errorCode)
      }
    }
    val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_BALANCED).build()
    scanner.startScan(filters(), settings, callback)
    foregroundScan = callback
    EventLog.log("scan-started", "source" to "foreground")
  }

  @Synchronized
  fun stopForegroundScan(context: Context) {
    foregroundScan?.let { adapter(context)?.bluetoothLeScanner?.stopScan(it) }
    foregroundScan = null
  }

  /**
   * A scan the system runs for us, also while the app is closed or frozen: matches are delivered
   * to [ScanReceiver]. This is the K11-friendly mode: the phone only wakes when a household phone
   * is near.
   */
  fun setBackgroundScan(context: Context, enabled: Boolean) {
    val scanner = adapter(context)?.bluetoothLeScanner
    if (scanner == null) {
      EventLog.log("scan-failed", "source" to "background", "error" to "Bluetooth is off")
      return
    }
    val intent = PendingIntent.getBroadcast(
      context,
      0,
      Intent(context, ScanReceiver::class.java),
      PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE,
    )
    if (enabled) {
      val settings = ScanSettings.Builder()
        .setScanMode(ScanSettings.SCAN_MODE_LOW_POWER)
        .setCallbackType(ScanSettings.CALLBACK_TYPE_ALL_MATCHES)
        .build()
      val code = scanner.startScan(filters(), settings, intent)
      EventLog.log("scan-started", "source" to "background", "code" to code)
    } else {
      scanner.stopScan(intent)
      EventLog.log("scan-stopped", "source" to "background")
    }
  }

  /** Starts a session when [result] is a household phone with other edits; returns its thread. */
  fun handle(context: Context, result: ScanResult, source: String): Thread? {
    val now = System.currentTimeMillis()
    val bytes = result.scanRecord?.getServiceData(serviceUuid)
    val advert = Household.parse(bytes, now) ?: return null
    if (!Household.differs(advert, EditStore.digest())) return null
    if (!Nearby.claim(result.device.address, now)) return null
    EventLog.log("seen", "transport" to "ble", "source" to source, "rssi" to result.rssi)
    return thread(name = "l2cap-client") {
      try {
        connect(result.device, advert.psm, now)
      } finally {
        Nearby.release()
        refreshAdvertising(context)
      }
    }
  }

  private fun connect(device: BluetoothDevice, psm: Int, seenAt: Long) {
    try {
      device.createInsecureL2capChannel(psm).use { socket ->
        Nearby.withDeadline(socket, SESSION_DEADLINE_MS) {
          socket.connect()
          Nearby.exchange("ble", "client", seenAt, socket.inputStream, socket.outputStream)
        }
      }
    } catch (error: IOException) {
      Nearby.failed("ble", "client", error)
    } catch (error: SecurityException) {
      Nearby.failed("ble", "client", error)
    }
  }
}
