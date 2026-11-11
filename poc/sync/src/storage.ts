// Local storage of one device: its identity and the household document as an append-only log.
// PoC only: private keys sit in a plain file. The real app keeps them in the OS keystore (K8).
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { KEY_BYTES, exportPrivateKey, importDeviceKeys, type DeviceKeys } from './crypto.ts';

export interface Identity {
  deviceId: string;
  householdId: string;
  name: string;
  keys: DeviceKeys;
  /** Generation of this device's Automerge actor id; raised after a purge (K8). */
  actorGeneration: number;
  /** Set when this device missed a key rotation; it then checks its copy for refused changes (K8). */
  purgeCheckPending: boolean;
  /** Household key per epoch; older ones answer devices that missed a rotation (K8). */
  householdKeys: Map<number, Uint8Array>;
}

const IDENTITY_FILE = 'device.json';
const DOC_FILE = 'household.automerge';
const ID = /^[0-9a-f-]{36}$/;

export class InvalidIdentityError extends Error {}

export function saveIdentity(dir: string, identity: Identity): void {
  mkdirSync(dir, { recursive: true });
  const body = {
    deviceId: identity.deviceId,
    householdId: identity.householdId,
    name: identity.name,
    actorGeneration: identity.actorGeneration,
    purgeCheckPending: identity.purgeCheckPending,
    signingPrivate: b64(exportPrivateKey(identity.keys.signingPrivate)),
    boxPrivate: b64(exportPrivateKey(identity.keys.boxPrivate)),
    householdKeys: Object.fromEntries(
      [...identity.householdKeys].map(([epoch, key]) => [String(epoch), b64(key)]),
    ),
  };
  const path = join(dir, IDENTITY_FILE);
  writeFileSync(`${path}.tmp`, JSON.stringify(body), { mode: 0o600 });
  renameSync(`${path}.tmp`, path);
}

export function loadIdentity(dir: string): Identity {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(dir, IDENTITY_FILE), 'utf8'));
  } catch {
    throw new InvalidIdentityError('unreadable identity');
  }
  if (typeof value !== 'object' || value === null) {
    throw new InvalidIdentityError('malformed identity');
  }
  const body = value as Record<string, unknown>;
  const { deviceId, householdId, name, actorGeneration, purgeCheckPending } = body;
  const { signingPrivate, boxPrivate } = body;
  if (typeof deviceId !== 'string' || !ID.test(deviceId)) {
    throw new InvalidIdentityError('invalid device id');
  }
  if (typeof householdId !== 'string' || !ID.test(householdId)) {
    throw new InvalidIdentityError('invalid household id');
  }
  if (typeof name !== 'string') throw new InvalidIdentityError('invalid name');
  if (
    typeof actorGeneration !== 'number' ||
    !Number.isInteger(actorGeneration) ||
    actorGeneration < 0 ||
    actorGeneration > 255
  ) {
    throw new InvalidIdentityError('invalid actor generation');
  }
  if (typeof purgeCheckPending !== 'boolean') {
    throw new InvalidIdentityError('invalid purge flag');
  }
  if (typeof signingPrivate !== 'string' || typeof boxPrivate !== 'string') {
    throw new InvalidIdentityError('missing device keys');
  }
  let keys: DeviceKeys;
  try {
    keys = importDeviceKeys(unb64(signingPrivate), unb64(boxPrivate));
  } catch {
    throw new InvalidIdentityError('invalid device keys');
  }
  return {
    deviceId,
    householdId,
    name,
    keys,
    actorGeneration,
    purgeCheckPending,
    householdKeys: parseHouseholdKeys(body['householdKeys']),
  };
}

function parseHouseholdKeys(value: unknown): Map<number, Uint8Array> {
  if (typeof value !== 'object' || value === null) {
    throw new InvalidIdentityError('missing household keys');
  }
  const keys = new Map<number, Uint8Array>();
  for (const [epochText, keyText] of Object.entries(value)) {
    const epoch = Number(epochText);
    const key = typeof keyText === 'string' ? unb64(keyText) : new Uint8Array();
    if (!Number.isSafeInteger(epoch) || epoch < 0 || key.length !== KEY_BYTES) {
      throw new InvalidIdentityError('invalid household key');
    }
    keys.set(epoch, key);
  }
  if (keys.size === 0) throw new InvalidIdentityError('missing household keys');
  return keys;
}

/** Automerge can load a concatenation of a full save and incremental chunks. */
export function appendDocChunk(dir: string, chunk: Uint8Array): void {
  if (chunk.length > 0) appendFileSync(join(dir, DOC_FILE), chunk);
}

/** Replaces the log by one compact save; write-then-rename so a crash never leaves half a file. */
export function writeCompactDoc(dir: string, bytes: Uint8Array): void {
  const path = join(dir, DOC_FILE);
  writeFileSync(`${path}.tmp`, bytes);
  renameSync(`${path}.tmp`, path);
}

/** An unpaired device forgets the household: its keys and its copy of the data (K8). */
export function wipeHousehold(dir: string): void {
  rmSync(join(dir, IDENTITY_FILE), { force: true });
  rmSync(join(dir, DOC_FILE), { force: true });
}

export function loadDocBytes(dir: string): Uint8Array | null {
  const path = join(dir, DOC_FILE);
  return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
}

export function b64(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}

export function unb64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, 'base64url'));
}
