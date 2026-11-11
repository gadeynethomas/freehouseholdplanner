# Nearby sync PoC (K12)

Answers one question before K12 goes into a delivery step: **can two phones near each other, with
no shared network, exchange edits within a minute without anyone switching anything on, and what
does that cost in battery?** Example from the PRD (N9): one person edits in the car, the other
gets out with all edits.

Two transports, both plain Android APIs (no Google Play services, N8):

| Transport | Discovery | Data | While the app is closed |
| --- | --- | --- | --- |
| Bluetooth LE | Advertisement with a rotating household token and a state tag | L2CAP channel (`createInsecureL2capChannel`) | Yes: a system scan with a `PendingIntent` wakes [`ScanReceiver`](src-tauri/gen/android/app/src/main/java/org/freehouseholdplanner/nearby/ScanReceiver.kt) |
| Wi-Fi Aware | Publish and subscribe with the same token and tag | TCP over an Aware data path (IPv6 link-local, WPA passphrase) | No: only while the service runs |

## How it works

| Part | Where (`src-tauri/gen/android/app/src/main/java/org/freehouseholdplanner/nearby/`) | Role |
| --- | --- | --- |
| Household | `Household.kt` | Token = HMAC(key, window)[6 bytes], changes every 15 minutes; state tag = HMAC(key, window ‖ digest of edit ids)[2 bytes]. A stranger sees random bytes that change every window; a household phone recomputes them. The scan filter matches only the app-wide service UUID |
| Sync session | `SyncSession.kt` | Symmetric over any stream: both send the ids they hold, then the edits the other lacks, then DONE. Bounded binary frames; a writer thread so large transfers in both directions cannot block |
| Bluetooth | `Ble.kt`, `ScanReceiver.kt` | Advertises token, tag and L2CAP channel (10 bytes, fits a legacy advertisement). A phone that sees a household phone with a different tag connects, syncs, and both re-advertise. Sessions are cut off after 60 s |
| Wi-Fi Aware | `Aware.kt` | Same token and tag in the service-specific info, plus a random number per start: the phone with the lower number starts the data path, so both do not |
| Service | `NearbyService.kt` | Foreground service (`connectedDevice`): advertising, L2CAP server, foreground scan and Aware. Logs a tick every 10 minutes |
| Store and log | `EditStore.kt`, `EventLog.kt` | Synthetic edits (`device:seq`, creation time, padding size). Every event is logged with the battery level in `files/events.jsonl` |
| UI | `ui/`, `NearbyPlugin.kt`, `src/lib.rs` | Buttons for a 1 KB or 200 KB edit, three switches, summary and log |

PoC shortcuts, not for the real app:

- Both phones share a key compiled into the build; the real app derives it at pairing (K2).
- The L2CAP channel and the TCP socket are not encrypted and not authenticated. The real app runs
  Noise KK on top (K4, `docs/TECHNICAL.md` section 6). The edits here are synthetic padding.
- Edits carry no content and do not merge; this measures transport, not Automerge.

## Setup

Same toolchains as `poc/android` (`source ../android/env.sh`). minSdk 33.

```sh
source ../android/env.sh
npm ci
npx tauri android build --debug --apk --target aarch64
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk
(cd src-tauri/gen/android && ./gradlew :app:testUniversalDebugUnitTest)
```

Install the same build on both phones, open it, tap "Toestemmingen vragen" and allow everything
("Apparaten in de buurt", notifications). Bluetooth must be on; Wi-Fi Aware also needs Wi-Fi on
(not connected to a network).

Read a phone's log: `adb shell run-as org.freehouseholdplanner.nearby cat files/events.jsonl`.
Clocks: both phones on automatic time, so latencies across phones are meaningful (± a second).

## Test protocol

Phone A is the one that edits ("sender"), phone B the one that should receive. Wi-Fi off on both,
or at least not on the same network, so nothing else can carry the data.

| # | Setup | What to do | What to note |
| --- | --- | --- | --- |
| 1 | A: service on. B: service on | A: small edit | Latency (`received` on B), connect and transfer time |
| 2 | Same | A: big edit (200 KB) | Throughput over Bluetooth |
| 3 | A: service on. B: service off, background scan on, app swiped away, screen off | A: small edit | Does B wake and receive it? Latency. `wakes` on B |
| 4 | Same as 3, B in forced deep Doze (`adb shell dumpsys deviceidle force-idle`) | A: small edit | Same |
| 5 | Same as 3, both in a pocket, 1–2 m apart, 30 min, A edits every 5 min | — | All edits on B? Battery on both (start and end of the log) |
| 6 | A and B: service on, Wi-Fi Aware on, Wi-Fi on but not connected | A: big edit | Throughput over Aware; does Aware win over Bluetooth? |
| 7 | Same as 3, A walks away and back | — | Range; does a session that breaks off recover? |
| 8 | B: background scan on for 1 hour, A off | — | Battery cost of the background scan alone; `wakes` should be 0 |

Done means K12 is achievable when test 3 or 4 delivers a small edit within a minute, test 5 loses
nothing and costs no more than a few percent of battery per hour, and test 8 costs close to nothing.

## Results

### One phone (2026-11-11)

Pixel 7a, Android 17, debug APK. Checks that need no second phone:

| Check | Result |
| --- | --- |
| Unit tests (token, windows, state tag, session, malformed input) | 18 of 18 pass |
| Advertisement fits a legacy advertisement | Yes: advertising starts, no `ADVERTISE_FAILED_DATA_TOO_LARGE` |
| Seen from a laptop (`bluetoothctl`) | Service data `31d81d732d7b b07e 008b`: token, tag, PSM 139. Random device address, no device name |
| L2CAP server | Listens on PSM 139 |
| Foreground service | Runs as `connectedDevice` (`types=0x10`) with the notification |
| Starting the service while the phone is locked | Refused by Android (`startForegroundService() not allowed`): it can only start while the app is visible |
| Background scan (`PendingIntent`) | Registered (code 0) without the service, listed by the Bluetooth stack |
| Wi-Fi Aware | Supported (`android.hardware.wifi.aware`), but not available while Wi-Fi is switched off: Aware needs the Wi-Fi radio on, even without a network |

So the sync itself, the background wake-up and Aware's data path still need the second phone.

### Two phones

Not run yet. Phones: Pixel 7a (Android 17) and OnePlus Nord 3 (OxygenOS, MediaTek). Run every
test in both directions: OxygenOS is known to stop background apps more aggressively than a
Pixel, so the background scan (tests 3–5, 8) may behave differently there. Run them first with the
app's battery setting at the default ("Geoptimaliseerd"), then with "Onbeperkt", and note which
setting is needed. The app's status line shows whether the Nord 3 supports Wi-Fi Aware.

Open questions the tests answer:

- Does the system scan (`PendingIntent`, `CALLBACK_TYPE_ALL_MATCHES`) wake a closed app, and how
  often, while a household phone stays near with the same edits? The receiver ignores those, but
  every wake costs battery.
- Is 25 s inside `goAsync()` enough to connect and sync, or does the receiver need a short
  foreground service or job?
- Does `neverForLocation` on `BLUETOOTH_SCAN` filter our advertisements out? (Android strips some
  beacon formats from results with that flag.)
- Does Android re-deliver a Wi-Fi Aware discovery when the publisher's info changes?
- Does `ACCESS_LOCAL_NETWORK` (Android 17) apply to sockets over a Wi-Fi Aware data path?
- How does the sender's advertising time limit look in practice: in the real app the sender stops
  advertising some time after its last edit when everyone has it (K11). The PoC advertises as long
  as the service runs.
