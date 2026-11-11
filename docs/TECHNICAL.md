# Technical design

Status: **proposal**, 2026-11-11. How freehouseholdplanner is built. What it does and why is in the
[PRD](PRD.md) (in Dutch); requirement codes such as K3 or B5 refer to it. Section 13 lists the
decisions that are still open.

## 1. Constraints that shape the design

| Constraint | Source | Consequence |
| --- | --- | --- |
| No central server; every device holds all data | N4, K1 | Each device runs the full app: storage, sync, business rules |
| A household with only phones must work completely | N6, K1 | No feature may depend on a PC, an always-on device or a relay |
| Sync only on the same network by default | N7, K3 | LAN discovery and direct connections; no NAT traversal in the first version |
| Android freezes a background app within 5 s; only a foreground service keeps it alive | K11, `poc/android` | Sync must run in native code. JavaScript in the web view does not run in the background |
| Android 17 asks for local network access at runtime | `poc/android` | Without it, connections only time out. The app checks and shows the permission state itself |
| Merge without loss; last writer wins per field | K5 | A CRDT: Automerge, validated in `poc/sync` |
| Old and new app versions sync together | K9 | Additive schema changes, version fields, unknown fields kept |
| Distribution via GitHub Releases, Obtainium and later F-Droid | N8 | No non-free libraries (Google Play services, ML Kit), fixed app id |

## 2. Architecture

```
┌──────────────────────────── one device ────────────────────────────┐
│  UI (TypeScript, web view)                                          │
│    screens, forms, i18n, accessibility; no business rules           │
│        │  Tauri commands (typed requests)    ▲ events (doc changed) │
│        ▼                                     │                      │
│  App shell (Rust, Tauri 2)                                          │
│    commands, permissions, Android plugins (service, keystore,       │
│    local network, camera)                                           │
│        │                                                            │
│        ▼                                                            │
│  Core (Rust library, no Tauri)                                      │
│    domain model + rules · document (Automerge) · storage (SQLite)   │
│    sync sessions · pairing · crypto · LAN discovery + transport     │
└─────────────────────────────────────────────────────────────────────┘
          ▲  Noise-encrypted TCP on the home network  ▲
          ▼                                           ▼
     other devices of the household (same core, same protocol)
```

- **Core** owns all data and all rules. It runs in-process in the app and, later, in a headless
  binary for the always-on device (K6). It has no dependency on Tauri, so it is built and tested
  with plain `cargo test`.
- **App shell** is thin: it maps Tauri commands onto core calls and adds what only the platform can
  do (the Android foreground service, the keystore, the local network permission, the camera).
- **UI** renders views that the core computes ("today", "project budget") and sends user intents
  ("complete task 42"). It never edits the document directly and holds no business rules, so the
  app, the headless device and later the web view (K10) all behave the same.

### Repository layout

```
crates/core/         Rust library: model, rules, storage, sync, pairing, crypto, network
crates/headless/     always-on device binary (step 2, K6)
app/src-tauri/       Tauri 2 shell, Android project under gen/android
app/ui/              TypeScript UI
docs/                PRD, this document
poc/                 proofs of concept (kept for reference; not built into the app)
```

One Cargo workspace at the root, one npm package in `app/`. Lockfiles committed (CLAUDE.md).

## 3. Data model

**One Automerge document per household** (A4). The top level holds maps keyed by id:

| Map | PRD | Notes |
| --- | --- | --- |
| `household` | A1–A4 | id, name, timezone, `schemaVersion`, `minAppVersion` |
| `members`, `devices` | A1–A3, K2, K8 | device records hold public keys, `addedBy`, `removedAt`, author cut-off |
| `rooms` | R1 | |
| `chores`, `choreCompletions` | H1–H8 | completions are separate records, so history (H6) is plain data |
| `projects`, `phases`, `projectTasks`, `dependencies`, `decisions`, `materials` | P1–P9, PL1–PL10 | |
| `budgets`, `expenses`, `quotes`, `contacts`, `grants` | B1–B10, O1–O6, E1–E2 | |
| `ideas`, `appliances`, `templates` | I1–I5, R2–R4, S1–S3 | |
| `attachments` | G2 | metadata only: hash, size, type, name; the bytes live outside the document |

Rules:

- **Ids** are random UUIDs (v4) created on the device. Never derive ids from content: two devices
  creating "the same" item must give two items, not a merge accident.
- **Money** is an integer number of cents, incl. VAT (B7). **Instants** are UTC milliseconds;
  **calendar dates** (due dates, phase periods) are `YYYY-MM-DD` strings in the household timezone,
  so a due date does not shift with DST or travel.
- **Fields are scalars** (last writer wins, K5). Concurrent values stay readable through Automerge's
  conflict API for the history view. Long free text (descriptions, notes) can later become Automerge
  text if concurrent editing matters; not in step 1.
- **Deleting** removes the record from its map. Records that others refer to (a contact with quotes)
  are archived instead (`archivedAt`), so references never dangle.
- **Status** values are strings from a closed set per entity. Unknown values from a newer version
  are kept and shown as "unknown" (K9).
- **Size.** `poc/sync` measured 3,000 tasks and 33,000 changes: 370 KiB compacted, about 300 ms to
  load. One document per household is enough for the expected scale. If it ever is not, finished
  projects can move to their own document per project; the design does not block that.

### Versions and migrations (K9)

- `schemaVersion`: the highest data format any device has written. `minAppVersion`: the oldest app
  that may still edit. An older app that sees a higher `minAppVersion` turns read-only and asks to
  update.
- Changes are **additive**: new fields and new maps. Old apps keep fields they do not know, because
  Automerge keeps everything.
- A migration that must rewrite data runs as a deterministic function of the document, so two devices
  that run it concurrently produce the same result (no random ids, no timestamps). Each migration has
  a test that runs it on two devices at once and merges.

## 4. Storage

SQLite (one database file per household per device), accessed only from the core, with parameterized
statements.

| Table | Content |
| --- | --- |
| `doc_chunks` | Compacted document snapshot plus incremental changes since (append-only); compaction on start-up and in charge mode (`poc/sync` lesson 3) |
| `peers` | Per paired device: last address, last sync time and path (K7), saved Automerge sync state |
| `blobs` | Attachment bytes by content hash, with a reference count and a "fetch on open" flag (G2) |
| `local_settings` | Settings that are not shared: charge mode on/off, fetch-on-open, UI preferences |

**Encryption at rest (K8).** Every document chunk and blob is encrypted by the core with a random
256-bit storage key (XChaCha20-Poly1305) before it reaches SQLite. The storage key is wrapped by the
platform:

- Android: an AES key in the Android Keystore (hardware-backed where available), via a small Kotlin
  plugin.
- Linux: Secret Service (GNOME Keyring, KWallet). Windows: Credential Manager (DPAPI).
- Headless or no keyring available: a passphrase entered at start.

The device's own private keys are stored the same way. The PIN or fingerprint lock (K8) gates the UI;
with biometrics the keystore key can also require user authentication. Whether to require that is
an open decision (section 13).

**Attachments (G2)** are stored outside the document, addressed by SHA-256 of the plaintext, encrypted
with the storage key. Photos are resized on the device before they are stored. Type is checked by
content, size limits are enforced at import and on receipt.

## 5. Sync

Within one connection, devices run the **Automerge sync protocol**: each side keeps a sync state per
peer, and only missing changes travel (K3). On top of what `poc/sync` proved:

- **Session rules** from `poc/sync`: a new device does not write before its first sync; a reconnect
  starts a fresh session on both sides; a corrupt message is dropped and counted, never fatal; after an
  unusable message the session with that peer restarts.
- **Authors.** Each device writes under a fixed Automerge actor id derived from its device id. Changes
  by a removed device after its cut-off are refused, and a device that took them in purges its copy
  before it replies (K8; port of `src/purge.ts`).
- **Trust.** A paired device is trusted as a household member: the threat model is a lost or sold
  phone, not a hostile member (as accepted in `poc/sync`). Individual changes are therefore not
  signed; the channel is authenticated per device.
- **Attachments** travel in a separate blob exchange after the document sync: "I have these hashes,
  which do you need?" Large blobs only on Wi-Fi by default (G2).
- **Bounds.** Every incoming message has a maximum size; per peer there is a limit on pending work, so
  a misbehaving device cannot exhaust memory (K9).

## 6. Security

### Channel (K4)

Every connection between two devices is a **Noise protocol** session (an established, reviewed
framework; `poc/sync` combined primitives by hand and recommended this). Each device has a static
X25519 key; its public half is in the household document.

| Situation | Noise pattern | Why |
| --- | --- | --- |
| Two paired devices | `KK` | Both already know each other's static key from the document; an unknown or removed key fails the handshake |
| Pairing with a QR code | `XK` | The new device knows the inviter's key from the QR code; it sends its own key inside the handshake |
| Pairing with a typed code (PC without camera, K2) | PAKE (CPace or SPAKE2), then `KK` | A short code cannot carry a key; a PAKE turns it into a shared secret without letting an eavesdropper guess offline |

The household key and key epochs from `poc/sync` are no longer needed for the channel: removing a
device removes its key from the document, and `KK` refuses it from then on. A **household key** stays
for data that leaves the devices: backups (G3) and, if ever built, a relay. It is rotated on unpairing
as in `poc/sync`, sealed to each remaining device.

### Pairing (K2)

1. A paired device shows a QR code with: protocol version, household id, its static public key, a
   random one-time token (valid 10 minutes) and its LAN addresses and port.
2. The new device connects and runs the `XK` handshake, sending the token, its name and its public keys.
3. The inviting device checks the token and asks its user to confirm, showing the new device's name.
4. On confirmation it adds the device record to the document and starts a normal sync. The new device
   writes nothing until that first sync completes.

Because the transport is the home network only, both devices must be on it at pairing time; that
matches how pairing happens (on the couch, next to each other).

### Unpairing (K8)

As proven in `poc/sync`: mark removed, set the author cut-off, rotate the household key, send the
removed device a signed "you were unpaired" notice when it next appears; it deletes its keys and data.
Concurrent unpairings on two devices need a deterministic winner (open in `poc/sync`, to be solved
here: the rotation with the lowest hash wins, the other device re-rotates).

### Before the first release

- An external review of the protocol (handshakes, pairing, rotation, purge). Budgeted as a task for
  step 1, before any release.
- Fuzz tests for every decoder of data from another device (cargo-fuzz).

## 7. Network

- **Discovery.** Each device announces itself with **mDNS/DNS-SD** (`_fhp._tcp`) with an opaque
  household tag in the TXT record (a keyed hash, so a network does not learn which household it is).
  On Android this goes through `NsdManager` in a Kotlin plugin; on desktop through a Rust mDNS crate.
  As a fallback, each device remembers the last address of every peer and tries it directly. Some
  routers block multicast; the remembered address covers that case once two devices have met.
- **Transport.** TCP, a dynamic port (announced via mDNS), Noise on top, length-prefixed frames.
- **Android local network permission** (Android 17, targetSdk 37). Asked at pairing time with an
  explanation first, re-checked when the app returns to the foreground. When denied, the sync status
  (K7) says so and links to the app settings. Measured behaviour is in `poc/android/README.md`.

## 8. Android

| Concern | Approach |
| --- | --- |
| Sync while the app is open or just closed | Core runs in-process; sync on open and on leaving (K11) |
| Charge mode (K11) | Foreground service of type `connectedDevice` while on the charger and on Wi-Fi, with a notification. Started on `ACTION_POWER_CONNECTED`, stopped on unplug. Tested in `poc/android` |
| Short background runs | A periodic job (WorkManager, at most every 15 minutes, as Android allows) that syncs with whoever is reachable and stops |
| Always reachable (opt-in per device, K11) | The same foreground service without the charger condition |
| QR scanning | CameraX with ZXing (Apache 2.0). Not Google ML Kit: it is non-free and blocks F-Droid. The Tauri barcode-scanner plugin must be checked for this before use |
| Permissions | `ACCESS_LOCAL_NETWORK`, `CAMERA` (only when scanning), `POST_NOTIFICATIONS`, `FOREGROUND_SERVICE_CONNECTED_DEVICE`, `CHANGE_NETWORK_STATE` |
| App id and versions | `org.freehouseholdplanner.app`; `versionCode` = major × 10,000 + minor × 100 + patch, so it only goes up (N8) |

The other vendors' battery savers (Samsung, Xiaomi) are not tested yet; the sync status shows when a
device was last seen, so a problem is visible to the user.

## 9. UI

- **TypeScript**, `strict`, built with a bundler into static files shipped inside the app; no runtime
  network access, no CDN, no external fonts.
- **Framework**: open decision (section 13).
- **Views from the core.** Commands return ready-to-render view models ("today": tasks, overdue,
  planned minutes). The UI subscribes to a "household changed" event and asks again. A few thousand
  tasks need paginated lists and indexed queries; the core keeps in-memory indexes rebuilt from the
  document on load and updated on change.
- **Types** for commands and view models are generated from the Rust definitions, so the two sides
  cannot drift.
- **i18n.** All strings in message catalogs (Dutch first), formatted with the built-in `Intl` APIs
  (dates, numbers, euro amounts). No string concatenation for sentences.
- **Accessibility** (WCAG 2.2 AA): semantic HTML, labels on every field, full keyboard use, visible
  focus, contrast checked in CI where possible.

## 10. Business rules

All rules live in the core, as pure Rust functions over plain data, each with unit tests including the
edge cases from CLAUDE.md:

- recurrence schedules (H2, H4), in the household timezone, DST-safe;
- today / this week and planned time (H5, H7);
- budget overview and forecast (B4–B8);
- quick entry parsing (H8), with fixed Dutch phrase patterns;
- schedule shifting with dependencies (PL7).

Keeping them in Rust means the app, the headless device (calendar feed PL11, links E3) and the web view
(K10) use one implementation.

## 11. Testing and CI

| Level | What | Where |
| --- | --- | --- |
| Unit | Business rules, decoders, migrations | `cargo test` in `crates/core` |
| Sync | Several in-process devices: concurrent offline edits, any merge order, conflicts (K5), unpairing and rotation (K8), old and new versions (K9), household isolation (A4). Ported from `poc/sync` | `cargo test` |
| Storage | Real SQLite in a temp dir, crash during write, compaction | `cargo test` |
| Fuzz | Every decoder of data from another device | `cargo fuzz`, run locally and before releases |
| UI | Component logic, i18n completeness | npm test in `app/` |
| Smoke | App starts, household created, second device pairs and syncs, main screens load | Desktop build with WebDriver (`tauri-driver`), on Linux in CI |
| Android | Background and permission behaviour | Manual protocol on a real phone (as in `poc/android`), before each release |

CI keeps one workflow (CLAUDE.md): on push to `dev` and PRs to `main`, `cargo fmt --check`, `clippy`,
`cargo test`, UI type check, lint and tests, and the Linux smoke test. Android and Windows packages
are built only for releases (N8) to save Actions minutes.

## 12. Build and release (N8)

- A version tag triggers the release workflow: Linux AppImage and `.deb`, Windows installer, Android
  APK; all signed; published on GitHub Releases with the Tauri updater manifest.
- Keys: the Android signing key and the Tauri updater key, each stored in two places (N8), and as
  GitHub Actions secrets for the release job only.
- `fastlane/metadata/android/` holds the description and screenshots for a later F-Droid repository.
- No non-free dependencies anywhere in the Android build; checked before each release.

## 13. Open decisions

| # | Decision | Proposal |
| --- | --- | --- |
| T1 | UI framework | Svelte 5: small runtime, no virtual DOM, good accessibility warnings at compile time. Alternatives: SolidJS (similar), React (bigger, most familiar), no framework (more code to maintain) |
| T2 | Rust dependencies for step 1 (each needs approval, CLAUDE.md) | `automerge`, `rusqlite` (bundled SQLite), `snow` (Noise), `chacha20poly1305`, `ed25519-dalek`, `x25519-dalek`, `sha2`, `rand`, `serde`, `uuid`, an mDNS crate, `keyring` (desktop key storage), a PAKE crate (step 1 only if the typed code is in step 1). Each to be checked for size and maintenance when it is added |
| T3 | Generated TypeScript types from Rust | `specta` with `tauri-specta`, or `ts-rs`; or hand-written types with a test that compares them |
| T4 | App lock with biometrics also protecting the storage key | Yes on Android (keystore key requires user authentication, with a grace period); desktop relies on the OS login |
| T5 | Typed pairing code (PC without camera) in step 1 or later | Later: in step 1 a PC can pair by showing the QR code and letting the phone scan it, which needs no camera on the PC |
| T6 | Port the sync PoC to Rust first, before any UI | Yes: the core with sync tests passing is the base of step 1; the UI follows |

## 14. Step 1 (Fundament) as work packages

1. Workspace, CI, empty Tauri app on Linux and Android with the fixed app id and versioning.
2. Core: model (household, members, devices, rooms), storage with encryption at rest, compaction.
3. Core: sync sessions and author rules, ported from `poc/sync` with its tests, over an in-memory
   transport.
4. Core: Noise channel, LAN discovery and transport; two desktop instances sync on the home network.
5. Pairing with a QR code (desktop shows, phone scans; phone shows, phone scans).
6. Android: keystore plugin, local network permission flow, charge mode service, periodic job.
7. UI: create household, pair, members, rooms, sync status (K7), empty home screen; Dutch catalog.
8. Unpairing with rotation and purge; protocol review; smoke tests.
