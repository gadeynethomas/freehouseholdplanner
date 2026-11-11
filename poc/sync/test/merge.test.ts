// Merge behaviour without any network: what happens when devices edit offline and meet again (K5, K9).
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import * as A from '@automerge/automerge';
import {
  actorFor,
  addTask,
  completeTask,
  createHousehold,
  needsAppUpdate,
  renameTask,
  titleConflicts,
  type DeviceRecord,
  type Household,
  type HouseholdDoc,
} from '../src/model.ts';
import { syncInMemory } from './helpers.ts';

const memberA = 'lid-a';
const memberB = 'lid-b';

const founderId = randomUUID();
const founder: DeviceRecord = {
  name: 'gsm A',
  signingKey: 'unused',
  boxKey: 'unused',
  addedBy: founderId,
  addedAt: 0,
  removedAt: null,
  acceptedUpTo: {},
};

function newHousehold(householdId: string = randomUUID()): Household {
  return createHousehold(householdId, founderId, founder);
}

/** A second device that joined the household: a clone of its full history. */
function joined(doc: Household): Household {
  return A.load<HouseholdDoc>(A.save(doc));
}

test('K5: offline edits on three devices all survive and converge', () => {
  let phone1 = newHousehold();
  let phone2 = joined(phone1);
  let laptop = joined(phone1);

  phone1 = addTask(phone1, { id: 't1', title: 'Ramen poetsen', createdBy: memberA });
  phone2 = addTask(phone2, { id: 't2', title: 'Planten water geven', createdBy: memberB });
  laptop = addTask(laptop, { id: 't3', title: 'Ketel onderhoud', createdBy: memberA });

  [phone1, phone2] = syncInMemory(phone1, phone2);
  [phone2, laptop] = syncInMemory(phone2, laptop);
  [phone1, laptop] = syncInMemory(phone1, laptop);

  for (const doc of [phone1, phone2, laptop]) {
    assert.deepEqual(Object.keys(doc.tasks).sort(), ['t1', 't2', 't3']);
  }
  assert.deepEqual(A.getHeads(phone1), A.getHeads(laptop));
});

test('K5: two renames of the same task: one wins everywhere, the other stays visible', () => {
  let phone1 = addTask(newHousehold(), {
    id: 't1',
    title: 'Ramen',
    createdBy: memberA,
  });
  let phone2 = joined(phone1);

  phone1 = renameTask(phone1, 't1', 'Ramen poetsen binnen');
  phone2 = renameTask(phone2, 't1', 'Ramen poetsen buiten');
  [phone1, phone2] = syncInMemory(phone1, phone2);

  const winner = phone1.tasks['t1']?.title;
  assert.equal(phone2.tasks['t1']?.title, winner);
  assert.ok(winner === 'Ramen poetsen binnen' || winner === 'Ramen poetsen buiten');
  assert.deepEqual(titleConflicts(phone1, 't1').length, 1);
});

test('K5: completing and renaming the same task at the same time keeps both', () => {
  let phone1 = addTask(newHousehold(), {
    id: 't1',
    title: 'Was',
    createdBy: memberA,
  });
  let phone2 = joined(phone1);

  phone1 = completeTask(phone1, 't1', memberA, 1000);
  phone2 = renameTask(phone2, 't1', 'Was ophangen');
  [phone1, phone2] = syncInMemory(phone1, phone2);

  assert.deepEqual(phone1.tasks['t1'], {
    id: 't1',
    title: 'Was ophangen',
    done: true,
    doneBy: memberA,
    doneAt: 1000,
    createdBy: memberA,
  });
});

test('K2: why a new device must not start its own document before the first sync', () => {
  const householdId = randomUUID();
  let first = addTask(newHousehold(householdId), {
    id: 't1',
    title: 'Afwas',
    createdBy: memberA,
  });
  // Wrong: the second device creates the same empty structure on its own and adds a task.
  const secondId = randomUUID();
  let independent = addTask(
    createHousehold(householdId, secondId, founder, actorFor(secondId, 0)),
    {
      id: 't2',
      title: 'Strijk',
      createdBy: memberB,
    },
  );
  [first, independent] = syncInMemory(first, independent);

  // Both created `tasks` concurrently; Automerge keeps one, so one device's task disappears.
  assert.equal(Object.keys(first.tasks).length, 1);
});

test('K9: an older app version edits a task without losing fields it does not know', () => {
  let newer = addTask(newHousehold(), {
    id: 't1',
    title: 'Gras maaien',
    createdBy: memberA,
  });
  newer = A.change(newer, (d) => {
    const task = d.tasks['t1'] as Record<string, unknown> | undefined;
    if (task !== undefined) task['estimateMinutes'] = 45;
  });
  let older = joined(newer);

  older = renameTask(older, 't1', 'Gras maaien voortuin');
  [newer, older] = syncInMemory(newer, older);

  const task = newer.tasks['t1'] as Record<string, unknown> | undefined;
  assert.ok(task);
  assert.equal(task['title'], 'Gras maaien voortuin');
  assert.equal(task['estimateMinutes'], 45);
});

test('K9: a device notices when the household needs a newer app version', () => {
  let doc = newHousehold();
  assert.equal(needsAppUpdate(doc, 1), false);
  doc = A.change(doc, (d) => {
    d.minAppVersion = 2;
  });
  assert.equal(needsAppUpdate(doc, 1), true);
  assert.equal(needsAppUpdate(doc, 2), false);
});
