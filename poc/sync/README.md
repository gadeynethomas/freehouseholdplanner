# Sync proof of concept

Proves that household devices can each keep a full local copy of the data and sync changes with each
other, without a central server (PRD decision N4, requirements K1–K9). Devices are simulated as
Node.js objects talking over real TCP and UDP sockets. Android and Tauri come in a later step.

```sh
npm ci
npm run check   # typecheck, lint, format check, 42 tests
npm run bench   # scale check: 3,000 tasks, 33,000 changes of history
```

## How it works

| Part         | File              | Role                                                                        |
| ------------ | ----------------- | --------------------------------------------------------------------------- |
| Data model   | `src/model.ts`    | One Automerge document per household: tasks, paired devices, key ring       |
| Device       | `src/device.ts`   | Holds the document, stores it locally, syncs with every reachable device    |
| Pairing      | `src/pairing.ts`  | QR code content, pairing request and answer                                 |
| Wire format  | `src/envelope.ts` | Frames, signed envelopes, key epochs                                        |
| Cryptography | `src/crypto.ts`   | AES-256-GCM, Ed25519, X25519 + HKDF, all from `node:crypto` (OpenSSL)       |
| Relay        | `src/relay.ts`    | Forwards encrypted frames between devices of one household; sees no content |
| Home network | `src/lan.ts`      | UDP multicast announcements; devices then connect directly over TCP         |
| Storage      | `src/storage.ts`  | Identity file and an append-only change log, compacted on restart           |

Every device runs the Automerge sync protocol with every other device it can reach. It prefers a
direct connection on the home network and falls back to the relay. Changes travel onward, so an
always-on device (K6) passes changes between phones that are never online at the same time.

## Security design

**Keys.** Each device creates its own Ed25519 key (to sign) and X25519 key (to receive sealed
keys). Their public halves are listed in the household document. All household traffic is encrypted
with a shared household key, which belongs to a numbered key epoch.

**Pairing (K2).** The QR code holds the household id, the inviting device's public keys, a random
one-time token and the relay address. It holds no household key.

1. The new device seals a request to the inviter's X25519 key: the token, its name and its public keys.
2. The inviter checks the token (unused, at most 10 minutes old) and asks its user to confirm.
3. The inviter adds the device to the household and answers with the household key, signed with its
   Ed25519 key and sealed to the new device.

The new device read the inviter's keys from the inviter's screen, so a relay in between cannot
read the request or forge the answer.

**Every message is signed (K4).** Inside the encryption, each message carries the sender's signature
over the room, the key epoch and the content. A device accepts it only from a device listed as active
in the household. A paired device therefore cannot pose as another device, and messages cannot be
replayed into another household or epoch.

**Unpairing (K8).**

1. The device that unpairs marks the device as removed.
2. It creates a key for the next epoch and seals that key separately to each remaining device. These
   sealed keys are stored in the household document.
3. It switches to the new epoch.

A device that missed the rotation says hello in its old epoch and gets only its own sealed new key
back. The removed device cannot read anything newer, and its messages are refused.

**The removed device switches itself off.** When the removed device contacts a current device, the
current device sends it a signed notice: "you were unpaired". This happens straight away if the
removed device is online during the unpairing, or else when it next comes online. On that notice the
removed device deletes its keys and its copy of the household, and stops syncing. This relies on the
app behaving as built: a modified app could ignore the notice. It still cannot read anything new.

**Late changes of the removed device are refused everywhere.**

- **Who wrote what:** every device writes under a fixed Automerge actor id, made from its device id.
- **The cut-off:** on removal, the household records the last change of the removed device that it
  accepts.
- **The filter:** current devices check every incoming sync message. A message with a later change by
  the removed device is not applied, but its metadata is, so the sender still learns of the removal.

A device that missed the rotation may meet the removed device first, with no current device around.
It then takes in the removed device's late changes, because it cannot know yet. As soon as it hears of
the removal, it purges its copy (`src/purge.ts`):

1. It rebuilds the document without the refused changes and without anything that depends on them.
2. It replays its own later edits field by field on the clean copy, under a new actor id. Edits to
   items that only the removed device created are lost, for example renaming a task the removed
   device added.

Only devices that missed a rotation run this check, so it costs current devices nothing.

**What remains (accepted).** In that same situation, changes the lagging device made offline reach
the removed device before it is switched off. The household accepts this risk: the threat is a lost
or sold phone, not a hostile household member. The removed device deletes that data once it is
switched off.

## What the tests prove

| Requirement         | Proven by                                                                                                                                                                                                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| K2 Pairing          | The QR code has no household key; an invite works once and expires; declining shares nothing; forged answers fail                                                                                                                                                                    |
| K3 Sync             | A change arrives within a second; home network works without a relay; switching relay → direct                                                                                                                                                                                       |
| K4 Security         | The relay never sees titles, names or ids; another household gets nothing; a paired device cannot pose as another; corrupt messages are dropped                                                                                                                                      |
| K5 Merge            | Offline edits on three devices converge; same-field edits pick one winner everywhere and keep the other visible                                                                                                                                                                      |
| K6 Always-on device | Two phones that are never online together still sync through it                                                                                                                                                                                                                      |
| K7 Sync status      | Each device knows when it last synced with which device, and how                                                                                                                                                                                                                     |
| K8 Unpairing        | The removed device switches itself off and deletes its data, online or later; its late changes never reach the household, even via a lagging device that took them in; an offline device gets the new key later; the rotation survives a restart; a purge keeps everyone else's work |
| K9 Versions         | An older app version edits without losing fields it does not know; a device notices it needs an update                                                                                                                                                                               |

## Scale (`npm run bench`, this laptop)

| Measure                                           | Result                                                                |
| ------------------------------------------------- | --------------------------------------------------------------------- |
| Household                                         | 3,000 tasks, 33,000 changes (300 recurring tasks done 100 times each) |
| Compacted size on disk                            | 370 KiB (the uncompacted change log: 6.1 MB)                          |
| Load from disk                                    | about 300 ms                                                          |
| First sync of a newly paired device via the relay | about 0.8 s                                                           |
| One change, end to end via the relay              | about 25–40 ms, under 1.1 KB through the relay (signatures included)  |
| Unpairing a device                                | about 1.3 s (it counts the removed device's accepted changes)         |
| One change once a device has been unpaired        | about 11 ms (the author check forks the document in about 1 ms)       |
| First sync of a new device after an unpairing     | about 0.9 s                                                           |

## Lessons for the real app

1. **A new device must not write before its first sync.** If it creates its own empty structure,
   that collides with the household's and one device's tasks disappear (test in `merge.test.ts`).
   The app shows "fetching your household" until the first sync completes (`NotYetSyncedError`).
2. **A reconnecting device starts a fresh sync session, and the others must reset theirs too.**
   Without that, the always-on device thought a phone already had changes it never received, and
   sync stalled. Found by the K6 test.
3. **The change log needs compaction.** It grows about 16 times larger than a compact save.
4. **A corrupt message must never close the connection.** One bad message cut a device off silently;
   now it is counted and dropped.
5. **Last writer wins per field.** Renaming and completing the same task at once keeps both. Two
   renames keep one, and the other stays available for the history (H6).
6. **An invite must be one-time, so each new device needs its own QR code.**
7. **Answer every old-epoch hello with the new key, without rate limiting.** A key sent while the
   device was offline is lost. A rate limit then blocked the retry, and the device stayed stuck in
   the old epoch. Found by the K8 offline test.
8. **Sync messages can carry partial documents, not only single changes.** To check authors, apply
   the message to a cheap fork and look at the changes it adds. Decoding the chunks directly fails.
9. **Purge before replying.** A device that learns of a removal must clean its copy before it builds
   any reply. Otherwise it sends changes whose history the others refused, and sync stalls.
10. **After an unusable message, restart the session with that peer** instead of waiting.

## Not covered yet

- **Android, Tauri and background sync.** Android stops apps in the background; this decides how
  timely sync is on phones. It needs a test on a real phone.
- **Direct connections over the internet (NAT traversal).** Only the relay and the home network are
  covered here. Libraries such as Iroh do this in Rust, which fits Tauri.
- **Roles (A2).** Any active device can invite and unpair. Enforcing roles needs a rule that every
  device checks, such as "only changes signed by an admin may change the device list".
- **A device that unpairs itself** (leaving the household) is not built.
- **Two unpairings at the same time** on different devices both create the same next epoch with
  different keys. The real app needs a deterministic winner and a re-rotation.
- **Protocol review.** The pairing and rekey messages combine standard primitives by hand. For the
  real app, use an established protocol for the channel (for example the Noise framework) and have
  the design reviewed.
- **Private keys are stored in a plain file.** The real app uses the Android Keystore or the OS
  keyring.
- **Relay hardening.** No limits on connections or traffic. Anyone who learns a room id can see
  traffic volume, but not content.
- **Attachments (G2)** are not synced.
- **Home network discovery** uses multicast, which some routers block. Android needs a multicast lock.
