import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import * as A from '@automerge/automerge';
import { roomIdFor } from '../src/crypto.ts';
import type { Device } from '../src/device.ts';
import { sealEnvelope, type Envelope } from '../src/envelope.ts';
import { writeFrame } from '../src/framing.ts';
import type { RelayAddress } from '../src/pairing.ts';
import { loadIdentity } from '../src/storage.ts';

export function tempDirs(): { make: (name: string) => string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'fhp-sync-poc-'));
  return {
    make: (name) => join(root, name),
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

export async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export function converged(devices: Device[]): boolean {
  const [first, ...rest] = devices.map((device) => [...A.getHeads(device.doc)].sort().join());
  return first !== undefined && first !== '' && rest.every((heads) => heads === first);
}

/** Runs the Automerge sync protocol between two in-memory docs until neither has anything to send. */
export function syncInMemory<T>(left: A.Doc<T>, right: A.Doc<T>): [A.Doc<T>, A.Doc<T>] {
  let leftState = A.initSyncState();
  let rightState = A.initSyncState();
  for (let round = 0; round < 50; round += 1) {
    const [nextLeftState, toRight] = A.generateSyncMessage(left, leftState);
    leftState = nextLeftState;
    if (toRight !== null) [right, rightState] = A.receiveSyncMessage(right, rightState, toRight);
    const [nextRightState, toLeft] = A.generateSyncMessage(right, rightState);
    rightState = nextRightState;
    if (toLeft !== null) [left, leftState] = A.receiveSyncMessage(left, leftState, toLeft);
    if (toRight === null && toLeft === null) return [left, right];
  }
  throw new Error('sync did not settle');
}

/**
 * A raw connection to the relay with the identity (keys) of a device stored in `dataDir`:
 * lets a test send hand-made, correctly encrypted and signed messages.
 */
export async function rawDevice(
  relay: RelayAddress,
  dataDir: string,
): Promise<{ send: (epoch: number, envelope: Envelope) => void; close: () => void }> {
  const identity = loadIdentity(dataDir);
  const room = roomIdFor(identity.householdId);
  const socket = connect(relay.port, relay.host);
  await new Promise((resolve) => socket.once('connect', resolve));
  writeFrame(socket, room);
  return {
    send: (epoch, envelope) => {
      const key = identity.householdKeys.get(epoch);
      if (key === undefined) throw new Error(`no key for epoch ${epoch}`);
      writeFrame(socket, sealEnvelope(key, epoch, room, identity.keys, envelope));
    },
    close: () => socket.destroy(),
  };
}
