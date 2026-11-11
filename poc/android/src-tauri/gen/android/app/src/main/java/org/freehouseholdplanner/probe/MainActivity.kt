package org.freehouseholdplanner.probe

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.enableEdgeToEdge

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    requestLocalNetworkPermission()
  }

  /** Probe: how Android 17 asks for local network access, and what the connection does without it. */
  private fun requestLocalNetworkPermission() {
    if (Build.VERSION.SDK_INT >= 37 &&
      checkSelfPermission(Manifest.permission.ACCESS_LOCAL_NETWORK) != PackageManager.PERMISSION_GRANTED
    ) {
      requestPermissions(arrayOf(Manifest.permission.ACCESS_LOCAL_NETWORK), LOCAL_NETWORK_REQUEST)
    }
  }

  private companion object {
    const val LOCAL_NETWORK_REQUEST = 2
  }
}
