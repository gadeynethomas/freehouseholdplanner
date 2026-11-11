package org.freehouseholdplanner.nearby

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.wifi.aware.AttachCallback
import android.net.wifi.aware.DiscoverySessionCallback
import android.net.wifi.aware.PeerHandle
import android.net.wifi.aware.PublishConfig
import android.net.wifi.aware.PublishDiscoverySession
import android.net.wifi.aware.SubscribeConfig
import android.net.wifi.aware.SubscribeDiscoverySession
import android.net.wifi.aware.WifiAwareManager
import android.net.wifi.aware.WifiAwareNetworkInfo
import android.net.wifi.aware.WifiAwareNetworkSpecifier
import android.net.wifi.aware.WifiAwareSession
import android.os.Handler
import android.os.HandlerThread
import java.io.IOException
import java.net.ServerSocket
import java.net.SocketTimeoutException
import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread

/**
 * Wi-Fi Aware part of K12: faster than Bluetooth, but only on phones that support it and only while
 * the app runs (there is no system scan that wakes the app). Every phone publishes and subscribes.
 * The service-specific info has the same layout as the Bluetooth advertisement, with a random
 * per-start number instead of the L2CAP channel: when two phones' edits differ, the one with the
 * lower number asks for a data path, so they do not both start one.
 */
@SuppressLint("MissingPermission")
object Aware {
  private const val SERVICE_NAME = "fhp-nearby"
  private const val SYNC_MESSAGE = "sync"
  private const val NETWORK_TIMEOUT_MS = 20_000
  private const val SOCKET_TIMEOUT_MS = 30_000
  private val nonce = SecureRandom().nextInt(0x10000)
  private val handler by lazy { Handler(HandlerThread("aware").apply { start() }.looper) }
  private var session: WifiAwareSession? = null
  private var publish: PublishDiscoverySession? = null
  private var subscribe: SubscribeDiscoverySession? = null
  private var messageId = 0

  fun supported(context: Context): Boolean =
    context.packageManager.hasSystemFeature(PackageManager.FEATURE_WIFI_AWARE)

  fun available(context: Context): Boolean =
    supported(context) && context.getSystemService(WifiAwareManager::class.java)?.isAvailable == true

  @Synchronized
  fun start(context: Context) {
    if (session != null) return
    val manager = context.getSystemService(WifiAwareManager::class.java)
    if (manager == null || !manager.isAvailable) {
      EventLog.log("aware-unavailable", "supported" to supported(context))
      return
    }
    manager.attach(object : AttachCallback() {
      override fun onAttached(attached: WifiAwareSession) {
        synchronized(this@Aware) { session = attached }
        EventLog.log("aware-attached")
        attached.publish(publishConfig(), publishCallback(context), handler)
        attached.subscribe(
          SubscribeConfig.Builder().setServiceName(SERVICE_NAME).build(),
          subscribeCallback(context),
          handler,
        )
      }

      override fun onAttachFailed() {
        EventLog.log("aware-unavailable", "error" to "attach failed")
      }
    }, handler)
  }

  @Synchronized
  fun stop() {
    publish?.close()
    subscribe?.close()
    session?.close()
    publish = null
    subscribe = null
    session = null
  }

  /** Publishes the current state; call after edits change and when the window rolls over. */
  @Synchronized
  fun refresh() {
    publish?.updatePublish(publishConfig())
  }

  private fun publishConfig(): PublishConfig {
    val info = Household.payload(Household.window(System.currentTimeMillis()), EditStore.digest(), nonce)
    return PublishConfig.Builder().setServiceName(SERVICE_NAME).setServiceSpecificInfo(info).build()
  }

  private fun publishCallback(context: Context) = object : DiscoverySessionCallback() {
    override fun onPublishStarted(started: PublishDiscoverySession) {
      synchronized(this@Aware) { publish = started }
    }

    override fun onMessageReceived(peer: PeerHandle, message: ByteArray) {
      val session = synchronized(this@Aware) { publish } ?: return
      if (String(message) == SYNC_MESSAGE) respond(context, session, peer)
    }
  }

  private fun subscribeCallback(context: Context) = object : DiscoverySessionCallback() {
    override fun onSubscribeStarted(started: SubscribeDiscoverySession) {
      synchronized(this@Aware) { subscribe = started }
    }

    override fun onServiceDiscovered(peer: PeerHandle, info: ByteArray?, filter: List<ByteArray>?) {
      val now = System.currentTimeMillis()
      val advert = Household.parse(info, now) ?: return
      if (!Household.differs(advert, EditStore.digest())) return
      if (advert.psm <= nonce) return // The peer starts the data path.
      val session = synchronized(this@Aware) { subscribe } ?: return
      if (!Nearby.claim("aware:$peer", now)) return
      EventLog.log("seen", "transport" to "aware")
      session.sendMessage(peer, messageId++, SYNC_MESSAGE.toByteArray())
      initiate(context, session, peer, now)
    }
  }

  /** Publisher side: open a port, ask for a data path to [peer], and serve one session on it. */
  private fun respond(context: Context, session: PublishDiscoverySession, peer: PeerHandle) {
    val startedAt = System.currentTimeMillis()
    val server = ServerSocket(0).apply { soTimeout = SOCKET_TIMEOUT_MS }
    val specifier = WifiAwareNetworkSpecifier.Builder(session, peer)
      .setPskPassphrase(Household.awarePassphrase)
      .setPort(server.localPort)
      .build()
    val callback = object : ConnectivityManager.NetworkCallback() {}
    val connectivity = context.getSystemService(ConnectivityManager::class.java)
    connectivity.requestNetwork(request(specifier), callback, NETWORK_TIMEOUT_MS)
    thread(name = "aware-server") {
      try {
        server.accept().use { socket ->
          socket.soTimeout = SOCKET_TIMEOUT_MS
          Nearby.exchange("aware", "server", startedAt, socket.getInputStream(), socket.getOutputStream())
        }
      } catch (error: IOException) {
        Nearby.failed("aware", "server", error)
      } finally {
        server.close()
        connectivity.unregisterNetworkCallback(callback)
        refresh()
        Ble.refreshAdvertising(context)
      }
    }
  }

  /** Subscriber side: ask for a data path to [peer] and connect once the peer's address is known. */
  private fun initiate(context: Context, session: SubscribeDiscoverySession, peer: PeerHandle, seenAt: Long) {
    val specifier = WifiAwareNetworkSpecifier.Builder(session, peer)
      .setPskPassphrase(Household.awarePassphrase)
      .build()
    val connectivity = context.getSystemService(ConnectivityManager::class.java)
    val connected = AtomicBoolean(false)
    val callback = object : ConnectivityManager.NetworkCallback() {
      override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
        val info = capabilities.transportInfo as? WifiAwareNetworkInfo ?: return
        val address = info.peerIpv6Addr ?: return
        if (info.port == 0 || !connected.compareAndSet(false, true)) return
        val callback = this
        thread(name = "aware-client") {
          try {
            network.socketFactory.createSocket(address, info.port).use { socket ->
              socket.soTimeout = SOCKET_TIMEOUT_MS
              Nearby.exchange("aware", "client", seenAt, socket.getInputStream(), socket.getOutputStream())
            }
          } catch (error: IOException) {
            Nearby.failed("aware", "client", error)
          } finally {
            finish(context, connectivity, callback)
          }
        }
      }

      override fun onUnavailable() {
        Nearby.failed("aware", "client", SocketTimeoutException("no data path within $NETWORK_TIMEOUT_MS ms"))
        finish(context, connectivity, this)
      }
    }
    connectivity.requestNetwork(request(specifier), callback, NETWORK_TIMEOUT_MS)
  }

  private fun finish(context: Context, connectivity: ConnectivityManager, callback: ConnectivityManager.NetworkCallback) {
    try {
      connectivity.unregisterNetworkCallback(callback)
    } catch (_: IllegalArgumentException) {
      // Already unregistered by the system after onUnavailable.
    }
    Nearby.release()
    refresh()
    Ble.refreshAdvertising(context)
  }

  private fun request(specifier: WifiAwareNetworkSpecifier): NetworkRequest =
    NetworkRequest.Builder()
      .addTransportType(NetworkCapabilities.TRANSPORT_WIFI_AWARE)
      .setNetworkSpecifier(specifier)
      .build()
}
