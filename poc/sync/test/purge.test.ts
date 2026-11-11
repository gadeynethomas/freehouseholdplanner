// K8: purging a removed device's late changes from a copy that already took them in.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import * as A from '@automerge/automerge';
import {
  actorFor,
  addTask,
  completeTask,
  createHousehold,
  isRemovedAuthorChange,
  registerDevice,
  removeDevice,
  renameTask,
  type DeviceRecord,
  type Household,
  type HouseholdDoc,
} from '../src/model.ts';
import { purgeChanges } from '../src/purge.ts';
import { syncInMemory } from './helpers.ts';

const founderId = randomUUID();
const laptopId = randomUUID();
const phoneId = randomUUID();

function record(name: string): DeviceRecord {
  return {
    name,
    signingKey: 'unused',
    boxKey: 'unused',
    addedBy: founderId,
    addedAt: 0,
    removedAt: null,
    acceptedUpTo: {},
  };
}

function copyFor(doc: Household, deviceId: string, generation = 0): Household {
  return A.load<HouseholdDoc>(A.save(doc), { actor: actorFor(deviceId, generation) });
}

/** Founder, laptop and phone share a household with one task; then the founder removes the laptop. */
function scenario(): { founder: Household; laptop: Household; phone: Household } {
  let founder = createHousehold(randomUUID(), founderId, record('gsm A'), actorFor(founderId, 0));
  founder = registerDevice(founder, laptopId, record('laptop'));
  founder = registerDevice(founder, phoneId, record('gsm B'));
  founder = addTask(founder, { id: 't0', title: 'Afwas', createdBy: 'lid-a' });
  let laptop = copyFor(founder, laptopId);
  laptop = addTask(laptop, { id: 'before', title: 'Voor ontkoppelen', createdBy: 'laptop' });
  [founder, laptop] = syncInMemory(founder, laptop);
  const phone = copyFor(founder, phoneId);
  founder = removeDevice(founder, laptopId, 1000, 1, {});
  return { founder, laptop, phone };
}

test('K8: removal records how many changes of the removed device are accepted', () => {
  const { founder } = scenario();
  const laptopActor = actorFor(laptopId, 0);
  assert.deepEqual(founder.devices[laptopId]?.acceptedUpTo, { [laptopActor]: 1 });
  assert.equal(isRemovedAuthorChange(founder, laptopActor, 1), false);
  assert.equal(isRemovedAuthorChange(founder, laptopActor, 2), true);
  assert.equal(isRemovedAuthorChange(founder, actorFor(laptopId, 1), 1), true);
  assert.equal(isRemovedAuthorChange(founder, actorFor(phoneId, 0), 99), false);
});

test("K8: a purge drops the removed device's late changes and keeps everyone else's work", () => {
  const { founder, ...devices } = scenario();
  let { laptop, phone } = devices;
  laptop = addTask(laptop, { id: 'late', title: 'Na ontkoppelen', createdBy: 'laptop' });
  phone = addTask(phone, { id: 'own', title: 'Offline gemaakt', createdBy: 'lid-b' });
  [phone, laptop] = syncInMemory(phone, laptop); // they meet before the phone hears of the removal
  phone = completeTask(phone, 't0', 'lid-b', 5);
  phone = renameTask(phone, 'late', 'Hernoemd');
  phone = A.merge(phone, founder); // the phone hears of the removal

  const result = purgeChanges(
    phone,
    (actor, seq) => isRemovedAuthorChange(phone, actor, seq),
    actorFor(phoneId, 1),
  );
  assert.ok(result);
  assert.equal(result.dropped, 1);
  assert.equal(result.replayed, 2);
  assert.equal(result.skipped, 1, 'the rename of a task only the removed device created');
  const clean = result.doc;
  assert.equal(clean.tasks['late'], undefined);
  assert.equal(clean.tasks['before']?.title, 'Voor ontkoppelen');
  assert.equal(clean.tasks['own']?.title, 'Offline gemaakt');
  assert.equal(clean.tasks['t0']?.done, true);
  assert.notEqual(clean.devices[laptopId]?.removedAt, null);
  assert.equal(A.getActorId(clean), actorFor(phoneId, 1));
});

test('K8: after a purge the copy syncs cleanly with a device that never saw the late changes', () => {
  let { founder, laptop, phone } = scenario();
  laptop = addTask(laptop, { id: 'late', title: 'Na ontkoppelen', createdBy: 'laptop' });
  [phone, laptop] = syncInMemory(phone, laptop);
  phone = completeTask(phone, 't0', 'lid-b', 5);
  phone = A.merge(phone, founder); // one way: the founder refuses the late change (Device does this)

  const result = purgeChanges(
    phone,
    (actor, seq) => isRemovedAuthorChange(phone, actor, seq),
    actorFor(phoneId, 1),
  );
  assert.ok(result);
  [phone, founder] = syncInMemory(result.doc, founder);
  assert.deepEqual(A.getHeads(phone).sort(), A.getHeads(founder).sort());
  assert.equal(founder.tasks['late'], undefined);
  assert.equal(founder.tasks['t0']?.done, true);
});

test('K8: nothing to purge returns null', () => {
  const { founder } = scenario();
  assert.equal(
    purgeChanges(founder, (actor, seq) => isRemovedAuthorChange(founder, actor, seq), 'aa'),
    null,
  );
});
