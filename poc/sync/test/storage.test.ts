import assert from 'node:assert/strict';
import { statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { Device } from '../src/device.ts';
import { addTask, completeTask } from '../src/model.ts';
import { InvalidIdentityError } from '../src/storage.ts';
import { tempDirs } from './helpers.ts';

let dirs: ReturnType<typeof tempDirs>;

beforeEach(() => {
  dirs = tempDirs();
});

afterEach(() => {
  dirs.cleanup();
});

test('restarting compacts a grown change log without losing data, and later changes still persist', () => {
  const dataDir = dirs.make('phone1');
  const logFile = join(dataDir, 'household.automerge');
  const phone = Device.createHousehold({ name: 'gsm', dataDir });
  phone.change((d) => addTask(d, { id: 't1', title: 'Afwas', createdBy: 'lid-a' }));
  for (let day = 0; day < 200; day += 1) phone.change((d) => completeTask(d, 't1', 'lid-a', day));
  phone.close();
  const before = statSync(logFile).size;

  const restarted = Device.load({ name: 'gsm', dataDir });
  assert.ok(statSync(logFile).size < before / 2);
  assert.equal(restarted.doc.tasks['t1']?.doneAt, 199);

  restarted.change((d) => addTask(d, { id: 't2', title: 'Strijk', createdBy: 'lid-a' }));
  restarted.close();
  const again = Device.load({ name: 'gsm', dataDir });
  assert.equal(again.doc.tasks['t2']?.title, 'Strijk');
  assert.equal(again.doc.tasks['t1']?.doneAt, 199);
});

test('a corrupt identity file is rejected', () => {
  const dataDir = dirs.make('phone1');
  Device.createHousehold({ name: 'gsm', dataDir }).close();
  writeFileSync(
    join(dataDir, 'device.json'),
    JSON.stringify({ deviceId: 'x', householdId: 'y', key: '' }),
  );
  assert.throws(() => Device.load({ name: 'gsm', dataDir }), InvalidIdentityError);
});
