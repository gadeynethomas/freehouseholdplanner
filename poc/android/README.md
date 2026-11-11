# Android background probe

Answers one question before we build the real app: **how timely does a Tauri app on Android receive
messages when it is in the background or the screen is off?** Android freezes background apps, and
JavaScript in the Tauri web view does not run then at all. So the probe keeps its connection in Rust.

| Part | Where | Role |
| --- | --- | --- |
| Relay client and log | `probe-core/` | Tauri-free Rust crate: TCP connection to the relay, reconnects, logs every ping |
| App | `src-tauri/` | Tauri 2 app: commands for the UI, starts the probe at launch |
| Foreground service | `src-tauri/gen/android/app/src/main/java/.../ProbeService.kt` | Optional notification "Synchroniseert…" that keeps the process alive |
| UI | `ui/` | Plain HTML and JavaScript, no bundler; shows pings, delays and a summary |
| Sender | `sender/sender.ts` | Runs the relay from `poc/sync` on the laptop and sends a numbered ping every 10 s |

## Setup (once)

Toolchains are installed per user, without sudo: Rust (`~/.cargo`), Temurin JDK 17 (`~/.jdks`),
Android SDK with platform 37, build-tools 37 and NDK (`~/Android/Sdk`). `env.sh` puts them on the path.

```sh
source env.sh
npm ci
npx tauri android build --debug --apk --target aarch64
cd probe-core && cargo test && cargo clippy --all-targets -- -D warnings
```

The firewall (ufw) must let the phone reach the relay on TCP port 7400 from the home network.

## Test protocol

Run `npm run sender` on the laptop. Then on the phone, with the app open:

| Step | Duration | What to do |
| --- | --- | --- |
| 1. Foreground | 2 min | App open, screen on |
| 2. Background | 5 min | Home button, screen on |
| 3. Screen off | 30 min | Lock the phone, leave it still (Doze starts after a while) |
| 4–6. Repeat | same | Steps 1–3 with "Voorgronddienst" on |

Doze can be forced instead of waiting: `adb shell dumpsys deviceidle force-idle` (and
`adb shell dumpsys deviceidle unforce` afterwards). The app marks every switch to and from the
background in its log. Each ping records when it was sent and when it arrived.

## Results (2026-11-11)

Google Pixel 7a, Android 17, debug APK, home Wi-Fi, laptop relay. Ping every 10 s; delay is
arrival minus send time (laptop and phone clocks, both NTP-synced).

| Step | Pings received | Delay | Notes |
| --- | --- | --- | --- |
| 1. Foreground | all | 0.5–0.7 s | |
| 2. Background | none after 5 s | – | Connection aborted 5 s after the home button, one failed reconnect, then the process was frozen (`isFrozen=true`, cached) |
| 3. Screen off | skipped | – | A frozen process runs no code at all, so step 2 already answers it |
| 4. Foreground + service | 14 of 14 | 0.5–0.7 s | Service accepted as type `dataSync` |
| 5. Background + service | 32 of 32 | 0.5–1.1 s | Process not frozen |
| 6. Screen off + service | 181 of 181 (30 min) | median 0.66 s, p95 1.11 s, max 2.5 s | Unplugged, locked, still; deep Doze (`mState=IDLE`) for most of the run. Battery 37 % → 36 % |

Conclusions:

- Without a foreground service, Android freezes the app within seconds of leaving the foreground.
  Background sync on Android needs the foreground service with its ongoing notification.
- With the service, the Rust connection keeps receiving within about a second, even in deep Doze,
  at low battery cost over 30 minutes.
- After a long run of failed attempts, the probe waited 19 s to reconnect when the app came back
  to the foreground. The real app should reconnect immediately on return to the foreground and
  when the network comes back.
- Only a Pixel was tested; other vendors (Samsung, Xiaomi) kill background apps more aggressively.
- Cosmetic: the title runs under the status bar (edge-to-edge insets not handled).

### Foreground service type

The first runs used type `dataSync`. Android 15+ limits `dataSync` to 6 hours per 24 hours (the
timer resets when the user opens the app) and forbids starting it from `BOOT_COMPLETED`. That does
not fit continuous sync. The probe now uses `connectedDevice`: "interactions with external devices
that require a Bluetooth, NFC, IR, USB, or network connection", which is what syncing with the
household's other devices is. It has no time limit and may start after boot. Its runtime
prerequisite is met by declaring `CHANGE_NETWORK_STATE` (a normal permission, granted at install).

Re-run with `connectedDevice` (same phone, unplugged, locked, deep Doze): 62 of 62 pings in
10 minutes, median 0.66 s, max 3.9 s. Service reported as `types=0x10`.

### Local network permission (Android 17)

Apps that target API 37 need the runtime permission `ACCESS_LOCAL_NETWORK` for any TCP or UDP
traffic on the local network. The probe now targets API 37, declares the permission and asks for it
at launch (`MainActivity.kt`). Tested on 2026-11-11, same Pixel 7a, Android 17:

| Situation | Result |
| --- | --- |
| Dialog shown, not answered yet | Connections time out |
| Granted in the dialog | Connected within 1 s, pings arrive as before |
| Revoked in Settings | Android kills the process at once ("permissions revoked") |
| Denied | Connections time out after 5 s. No distinct error (no `EPERM`): from the socket, a missing permission looks the same as a peer that is offline |
| Denied twice | Flag `USER_FIXED`: Android no longer shows the dialog; only Settings can grant it |
| Foreground service started while denied | Starts without error (`connectedDevice` does not require it) |
| Granted later in Settings | No restart needed; the next reconnect attempt succeeds |
| Granted, service on, screen off, forced deep Doze, 10 min | 61 of 61 pings, median 0.74 s, max 1.6 s, no disconnects |

The dialog belongs to the permission group "Apparaten in de buurt" (nearby devices).

What this means for the real app:

- Check the permission state yourself and show it ("Synchroniseren thuis staat uit: geef toegang tot
  apparaten in de buurt"). A failing connection cannot tell you why.
- Ask at pairing time, with a short explanation first, not at launch. After two refusals, link to the
  app's settings page instead of asking again.
- Re-check the permission when the app returns to the foreground, and reconnect at once when it is
  granted.

### Direct sync over IPv6 (N7)

Can a phone on mobile data reach a device at home over IPv6, without a relay? Tested on 2026-11-11:
the Pixel on mobile data (Wi-Fi off, adb over USB), the laptop wired at home, both with a public
IPv6 address. Both sides sent a UDP datagram every second to each other's address and port for
a minute, so that each firewall would see outgoing traffic first (hole punching).

| Check | Result |
| --- | --- |
| Public IPv6 address | Both sides |
| Mobile IPv4 | `100.64.0.0/10` address: carrier-grade NAT |
| UDP reply from a public server (DNS), same ports | Works on both sides |
| Phone pings the laptop | No reply |
| Simultaneous UDP in both directions, two runs | 0 datagrams arrived, either way |
| Phone's datagrams in the laptop's firewall log | None: dropped before they reach the laptop |

So the home router, the mobile carrier's firewall or both drop this traffic. Which one could not be
determined without a third public host. The provider's modem has no IPv6 firewall settings, so a
household cannot change it. Direct sync over IPv6 does not work on this network; it stays a possible
later extension that may work elsewhere, never a requirement.

Not tested yet, needed for the real app:

- Discovering peers with mDNS (`NsdManager`) under this permission.
- Starting the service from `BOOT_COMPLETED`.
- Other vendors' battery savers.
