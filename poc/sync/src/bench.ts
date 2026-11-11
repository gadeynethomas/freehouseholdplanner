// Scale check (non-functional requirement "Snelheid"): a household with a few thousand tasks and
// years of history. Measures storage size, load time, first sync of a new device, and one change.
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as A from '@automerge/automerge';
import { Device } from './device.ts';
import { addTask, completeTask, type HouseholdDoc } from './model.ts';
import { Relay } from './relay.ts';

const ONE_OFF_TASKS = 2700;
const RECURRING_TASKS = 300;
const COMPLETIONS_PER_RECURRING_TASK = 100;

function time<T>(run: () => T): [T, number] {
  const start = performance.now();
  const result = run();
  return [result, performance.now() - start];
}

async function timeAsync(run: () => Promise<void>): Promise<number> {
  const start = performance.now();
  await run();
  return performance.now() - start;
}

function waitFor(condition: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (condition()) resolve();
      else setTimeout(check, 5);
    };
    check();
  });
}

function kib(bytes: number): string {
  return `${(bytes / 1024).toFixed(0)} KiB`;
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'fhp-bench-'));
  const relay = new Relay();
  const relayAddress = await relay.start();
  try {
    const phone1 = Device.createHousehold({ name: 'gsm A', dataDir: join(root, 'phone1') });
    const [, buildMs] = time(() => {
      for (let i = 0; i < ONE_OFF_TASKS + RECURRING_TASKS; i += 1) {
        phone1.change((d) =>
          addTask(d, { id: `t${i}`, title: `Taak nummer ${i}`, createdBy: 'lid-a' }),
        );
      }
      for (let round = 0; round < COMPLETIONS_PER_RECURRING_TASK; round += 1) {
        for (let i = 0; i < RECURRING_TASKS; i += 1) {
          phone1.change((d) => completeTask(d, `t${i}`, 'lid-b', round * 86_400_000 + i));
        }
      }
    });
    const changes = ONE_OFF_TASKS + RECURRING_TASKS * (1 + COMPLETIONS_PER_RECURRING_TASK);

    const logBytes = statSync(join(root, 'phone1', 'household.automerge')).size;
    const [compact, saveMs] = time(() => A.save(phone1.doc));
    const [, loadMs] = time(() => A.load<HouseholdDoc>(compact));

    await phone1.connectRelay(relayAddress);
    const phone2 = Device.join({ name: 'gsm B', dataDir: join(root, 'phone2') }, phone1.invite());
    const firstSyncMs = await timeAsync(async () => {
      await phone2.connectRelay();
      await waitFor(
        () =>
          phone2.hasHousehold &&
          Object.keys(phone2.doc.tasks).length === ONE_OFF_TASKS + RECURRING_TASKS,
      );
    });

    let relayed = 0;
    const counting = new Relay({ onForward: (frame) => (relayed += frame.length) });
    const countingAddress = await counting.start();
    phone1.close();
    phone2.close();
    await phone1.connectRelay(countingAddress);
    await phone2.connectRelay(countingAddress);
    await waitFor(() => phone1.status().length === 1 && phone2.status().length === 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    relayed = 0;
    const oneChangeMs = await timeAsync(async () => {
      phone1.change((d) => completeTask(d, 't0', 'lid-a', Date.now()));
      await waitFor(() => phone2.doc.tasks['t0']?.doneBy === 'lid-a');
    });
    const oneChangeBytes = relayed;

    // After an unpairing, every incoming change is checked for its author (K8).
    const laptop = Device.join({ name: 'laptop', dataDir: join(root, 'laptop') }, phone1.invite());
    await laptop.connectRelay(countingAddress);
    await waitFor(() => laptop.hasHousehold && phone1.status().length === 2);
    const [, unpairMs] = time(() => {
      phone1.unpair(laptop.deviceId);
    });
    await waitFor(() => laptop.isRemoved && phone2.epoch === 1);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const oneChangeAfterUnpairMs = await timeAsync(async () => {
      phone2.change((d) => completeTask(d, 't1', 'lid-b', Date.now()));
      await waitFor(() => phone1.doc.tasks['t1']?.doneBy === 'lid-b');
    });
    const phone3 = Device.join({ name: 'tablet', dataDir: join(root, 'phone3') }, phone1.invite());
    const firstSyncAfterUnpairMs = await timeAsync(async () => {
      await phone3.connectRelay(countingAddress);
      await waitFor(
        () =>
          phone3.hasHousehold &&
          Object.keys(phone3.doc.tasks).length === ONE_OFF_TASKS + RECURRING_TASKS,
      );
    });
    for (const device of [phone1, phone2, laptop, phone3]) device.close();
    await counting.stop();

    console.table({
      tasks: ONE_OFF_TASKS + RECURRING_TASKS,
      'changes in history': changes,
      'building history (ms)': Math.round(buildMs),
      'append-only log on disk': kib(logBytes),
      'compacted save': kib(compact.length),
      'compact save (ms)': Math.round(saveMs),
      'load from disk (ms)': Math.round(loadMs),
      'first sync of a new device via relay (ms)': Math.round(firstSyncMs),
      'one change, end to end via relay (ms)': Math.round(oneChangeMs),
      'one change, bytes through relay': oneChangeBytes,
      'unpair a device (ms)': Math.round(unpairMs),
      'one change after an unpairing (ms)': Math.round(oneChangeAfterUnpairMs),
      'first sync of a new device after an unpairing (ms)': Math.round(firstSyncAfterUnpairMs),
    });
  } finally {
    await relay.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

await main();
