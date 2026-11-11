// A minimal slice of the household data model: enough household tasks (H1, H3) to exercise sync.
// One Automerge document per household (A4).
import * as A from '@automerge/automerge';

/** Bumped when a release writes data that older releases must not edit blindly (K9). */
export const APP_VERSION = 1;

export type Task = {
  id: string;
  title: string;
  done: boolean;
  doneBy: string | null;
  doneAt: number | null;
  createdBy: string;
};

/** A paired device (K2). Public keys as base64url; a removed device keeps its record (K8). */
export type DeviceRecord = {
  name: string;
  signingKey: string;
  boxKey: string;
  addedBy: string;
  addedAt: number;
  removedAt: number | null;
  /**
   * Set on removal: per Automerge actor of this device, the last change accepted from it.
   * Later changes by those actors are refused everywhere (K8).
   */
  acceptedUpTo: Record<string, number>;
};

export type HouseholdDoc = {
  householdId: string;
  minAppVersion: number;
  tasks: Record<string, Task>;
  devices: Record<string, DeviceRecord>;
  /** Per key epoch: the household key sealed to each device that may read it (K8). */
  keyring: Record<string, Record<string, string>>;
};

export type Household = A.Doc<HouseholdDoc>;

/** Only the first device of a household calls this; joining devices start empty and sync (K1, K2). */
export function createHousehold(
  householdId: string,
  founderId: string,
  founder: DeviceRecord,
  actor: string = actorFor(founderId, 0),
): Household {
  return A.from<HouseholdDoc>(
    {
      householdId,
      minAppVersion: APP_VERSION,
      tasks: {},
      devices: { [founderId]: founder },
      keyring: {},
    },
    { actor },
  );
}

/**
 * Every device writes under its own Automerge actor id: its device id plus a generation, which
 * goes up when the device rebuilds its document after a removed device's changes were purged.
 */
export function actorFor(deviceId: string, generation: number): string {
  return deviceId.replaceAll('-', '') + generation.toString(16).padStart(2, '0');
}

function deviceIdOfActor(actor: string): string | null {
  const hex = actor.slice(0, 32);
  if (!/^[0-9a-f]{32}$/.test(hex)) return null;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** True when this change was written by a removed device after its removal took effect (K8). */
export function isRemovedAuthorChange(doc: Household, actor: string, seq: number): boolean {
  const deviceId = deviceIdOfActor(actor);
  const record = deviceId === null ? undefined : doc.devices[deviceId];
  if (record === undefined || record.removedAt === null) return false;
  return seq > (record.acceptedUpTo[actor] ?? 0);
}

/** Per actor of this device, the highest change number present in the document. */
export function acceptedChangesOf(doc: Household, deviceId: string): Record<string, number> {
  const accepted: Record<string, number> = {};
  for (const change of A.getAllChanges(doc).map(A.decodeChange)) {
    if (deviceIdOfActor(change.actor) !== deviceId) continue;
    accepted[change.actor] = Math.max(accepted[change.actor] ?? 0, change.seq);
  }
  return accepted;
}

export function registerDevice(doc: Household, deviceId: string, record: DeviceRecord): Household {
  return A.change(doc, (d) => {
    d.devices[deviceId] = record;
  });
}

/** Marks a device removed and stores the next epoch's key, sealed to every remaining device. */
export function removeDevice(
  doc: Household,
  deviceId: string,
  at: number,
  epoch: number,
  sealedKeys: Record<string, string>,
): Household {
  const acceptedUpTo = acceptedChangesOf(doc, deviceId);
  return A.change(doc, (d) => {
    const record = d.devices[deviceId];
    if (record !== undefined) {
      record.removedAt = at;
      record.acceptedUpTo = acceptedUpTo;
    }
    d.keyring[String(epoch)] = sealedKeys;
  });
}

export function activeDevice(doc: Household, deviceId: string): DeviceRecord | undefined {
  const record = doc.devices[deviceId];
  return record?.removedAt === null ? record : undefined;
}

export function activeDeviceIds(doc: Household): string[] {
  return Object.keys(doc.devices).filter((id) => activeDevice(doc, id) !== undefined);
}

export function latestKeyEpoch(doc: Household): number {
  return Math.max(0, ...Object.keys(doc.keyring).map(Number));
}

export function sealedKeyFor(doc: Household, epoch: number, deviceId: string): string | undefined {
  return doc.keyring[String(epoch)]?.[deviceId];
}

/** Changes when a device is added or removed; used to restart sessions with newly known devices. */
export function registryFingerprint(doc: Household): string {
  return Object.entries(doc.devices)
    .map(([id, record]) => `${id}:${String(record.removedAt)}`)
    .sort()
    .join(',');
}

export function addTask(doc: Household, task: Pick<Task, 'id' | 'title' | 'createdBy'>): Household {
  return A.change(doc, (d) => {
    d.tasks[task.id] = { ...task, done: false, doneBy: null, doneAt: null };
  });
}

export function renameTask(doc: Household, taskId: string, title: string): Household {
  return A.change(doc, (d) => {
    const task = d.tasks[taskId];
    if (task !== undefined) task.title = title;
  });
}

export function completeTask(doc: Household, taskId: string, by: string, at: number): Household {
  return A.change(doc, (d) => {
    const task = d.tasks[taskId];
    if (task === undefined) return;
    task.done = true;
    task.doneBy = by;
    task.doneAt = at;
  });
}

/** Concurrent values that lost the merge, so the UI can show them in the history (K5). */
export function titleConflicts(doc: Household, taskId: string): string[] {
  const task = doc.tasks[taskId];
  if (task === undefined) return [];
  const conflicts = A.getConflicts(task, 'title') ?? {};
  return Object.values(conflicts).filter(
    (value): value is string => typeof value === 'string' && value !== task.title,
  );
}

export function needsAppUpdate(doc: Household, appVersion: number): boolean {
  return doc.minAppVersion > appVersion;
}
