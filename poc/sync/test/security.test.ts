// Pairing (K2), device identity (K4) and unpairing with key rotation (K8), over a real relay.
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Device, NotYetSyncedError } from '../src/device.ts';
import { addTask, completeTask, renameTask } from '../src/model.ts';
import { INVITE_LIFETIME_MS, type RelayAddress } from '../src/pairing.ts';
import { Relay } from '../src/relay.ts';
import { b64, loadIdentity } from '../src/storage.ts';
import { rawDevice, tempDirs, waitFor } from './helpers.ts';

let dirs: ReturnType<typeof tempDirs>;
let relay: Relay;
let relayAddress: RelayAddress;
let devices: Device[];

beforeEach(async () => {
  dirs = tempDirs();
  devices = [];
  relay = new Relay();
  relayAddress = await relay.start();
});

afterEach(async () => {
  for (const device of devices) device.close();
  await relay.stop();
  dirs.cleanup();
});

function track(device: Device): Device {
  devices.push(device);
  return device;
}

async function founder(options: Partial<Parameters<typeof Device.createHousehold>[0]> = {}) {
  const device = track(
    Device.createHousehold({ name: 'gsm A', dataDir: dirs.make('phone1'), ...options }),
  );
  await device.connectRelay(relayAddress);
  return device;
}

async function joinWith(invite: string, name: string): Promise<Device> {
  const device = track(Device.join({ name, dataDir: dirs.make(name) }, invite));
  await device.connectRelay();
  return device;
}

/** Waits long enough for a pairing that would succeed (it takes well under 100 ms here). */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 700));
}

test('K2: the QR code does not contain the household key', async () => {
  const phone1 = await founder();
  const invite = phone1.invite();
  const householdKey = loadIdentity(dirs.make('phone1')).householdKeys.get(0);
  assert.ok(householdKey);
  const decoded = Buffer.from(invite.slice(5), 'base64url').toString();
  assert.equal(decoded.includes(b64(householdKey)), false);
  assert.equal(Buffer.from(decoded).includes(Buffer.from(householdKey)), false);
});

test('K2: an invite works once; a second device with the same QR code is not paired', async () => {
  const phone1 = await founder();
  const invite = phone1.invite();
  const phone2 = await joinWith(invite, 'gsm-B');
  await waitFor(() => phone2.hasHousehold);

  const copy = await joinWith(invite, 'gsm-copy');
  await settle();
  assert.equal(copy.isPaired, false);
  assert.equal(Object.keys(phone1.doc.devices).length, 2);
});

test('K2: an invite used after 10 minutes is refused by the inviter', async () => {
  let clock = 1_800_000_000_000;
  const phone1 = await founder({ now: () => clock });
  const invite = phone1.invite();
  clock += INVITE_LIFETIME_MS + 1;

  const late = track(
    Device.join({ name: 'gsm-late', dataDir: dirs.make('late'), now: () => clock - 2 }, invite),
  );
  await late.connectRelay();
  await settle();
  assert.equal(late.isPaired, false);
});

test('K2: nothing is shared when the inviter declines', async () => {
  const asked: string[] = [];
  const phone1 = await founder({
    confirmPairing: (request) => {
      asked.push(request.name);
      return false;
    },
  });
  const stranger = await joinWith(phone1.invite(), 'onbekende-gsm');
  await waitFor(() => asked.length > 0);
  await settle();

  assert.deepEqual(asked, ['onbekende-gsm']);
  assert.equal(stranger.isPaired, false);
  assert.equal(stranger.hasHousehold, false);
  assert.equal(Object.keys(phone1.doc.devices).length, 1);
});

test('K4: a paired device cannot pose as another device', async () => {
  const phone1 = await founder();
  const phone2 = await joinWith(phone1.invite(), 'gsm-B');
  const laptop = await joinWith(phone1.invite(), 'laptop');
  await waitFor(() => phone2.hasHousehold && laptop.hasHousehold);

  // The laptop has the household key, but signs with its own device key.
  const laptopRaw = await rawDevice(relayAddress, dirs.make('laptop'));
  const before = phone1.rejectedFrames;
  laptopRaw.send(0, { kind: 'hello', from: phone2.deviceId, to: phone1.deviceId });
  await waitFor(() => phone1.rejectedFrames > before);
  laptopRaw.close();
});

test('K8: an online device that is unpaired switches itself off and forgets the household', async () => {
  const phone1 = await founder();
  const phone2 = await joinWith(phone1.invite(), 'gsm-B');
  const laptop = await joinWith(phone1.invite(), 'laptop');
  await waitFor(() => phone2.hasHousehold && laptop.hasHousehold);
  phone1.change((d) => addTask(d, { id: 't1', title: 'Voor ontkoppelen', createdBy: 'lid-a' }));
  await waitFor(() => laptop.doc.tasks['t1'] !== undefined);

  phone1.unpair(laptop.deviceId);
  await waitFor(() => laptop.isRemoved && phone2.epoch === 1);

  assert.equal(laptop.isPaired, false);
  assert.equal(laptop.hasHousehold, false);
  assert.equal(existsSync(join(dirs.make('laptop'), 'device.json')), false);
  assert.equal(existsSync(join(dirs.make('laptop'), 'household.automerge')), false);
  assert.throws(() => {
    laptop.change((d) => d);
  }, NotYetSyncedError);

  phone1.change((d) => addTask(d, { id: 't2', title: 'Na ontkoppelen', createdBy: 'lid-a' }));
  await waitFor(() => phone2.doc.tasks['t2'] !== undefined);
  assert.notEqual(phone2.doc.devices[laptop.deviceId]?.removedAt, null);
});

test('K8: an unpaired device that was offline switches itself off when it comes online', async () => {
  const phone1 = await founder();
  const laptop = await joinWith(phone1.invite(), 'laptop');
  await waitFor(() => laptop.hasHousehold);
  laptop.goOffline();
  phone1.unpair(laptop.deviceId);

  await laptop.goOnline();
  await waitFor(() => laptop.isRemoved);
  assert.equal(laptop.hasHousehold, false);
});

test('K8: late changes of an unpaired device never reach the household, even via a lagging device', async () => {
  const phone1 = await founder();
  const phone2 = await joinWith(phone1.invite(), 'gsm-B');
  const laptop = await joinWith(phone1.invite(), 'laptop');
  await waitFor(() => phone2.hasHousehold && laptop.hasHousehold);
  phone1.change((d) => addTask(d, { id: 't0', title: 'Afwas', createdBy: 'lid-a' }));
  await waitFor(() => phone2.doc.tasks['t0'] !== undefined && laptop.doc.tasks['t0'] !== undefined);

  // Phone 2 and the laptop are offline while phone 1 unpairs the laptop, then phone 1 goes away.
  laptop.goOffline();
  phone2.goOffline();
  phone1.unpair(laptop.deviceId);
  phone1.goOffline();
  phone2.change((d) => addTask(d, { id: 'own', title: 'Offline gemaakt', createdBy: 'lid-b' }));

  // The laptop and phone 2 meet with no current device around: phone 2 cannot know.
  await laptop.goOnline();
  await phone2.goOnline();
  laptop.change((d) => addTask(d, { id: 'late', title: 'Na ontkoppelen', createdBy: 'laptop' }));
  await waitFor(() => phone2.doc.tasks['late'] !== undefined);
  phone2.change((d) => completeTask(d, 't0', 'lid-b', 5));
  phone2.change((d) => renameTask(d, 'late', 'Hernoemd'));

  // Phone 1 returns: phone 2 gets the new key, hears of the removal and purges its copy.
  await phone1.goOnline();
  await waitFor(() => phone2.lastPurge !== null && laptop.isRemoved);
  await waitFor(
    () => phone1.doc.tasks['own'] !== undefined && phone1.doc.tasks['t0']?.done === true,
  );
  await settle();

  for (const device of [phone1, phone2]) {
    assert.equal(device.doc.tasks['late'], undefined);
    assert.equal(device.doc.tasks['own']?.title, 'Offline gemaakt');
    assert.equal(device.doc.tasks['t0']?.done, true);
  }
  const purge = phone2.lastPurge;
  assert.ok(purge);
  assert.equal(purge.dropped, 1);
  assert.equal(purge.skipped, 1, 'the rename of the late task is lost');
  assert.equal(phone2.epoch, 1);
});

test('K8: a device that was offline during the rotation gets the new key later', async () => {
  const phone1 = await founder();
  const phone2 = await joinWith(phone1.invite(), 'gsm-B');
  const laptop = await joinWith(phone1.invite(), 'laptop');
  await waitFor(() => phone2.hasHousehold && laptop.hasHousehold);

  phone2.goOffline();
  phone1.unpair(laptop.deviceId);
  phone1.change((d) => addTask(d, { id: 't1', title: 'Terwijl je weg was', createdBy: 'lid-a' }));
  phone2.change((d) => addTask(d, { id: 't2', title: 'Offline gemaakt', createdBy: 'lid-b' }));

  await phone2.goOnline();
  await waitFor(() => phone2.epoch === 1 && phone2.doc.tasks['t1'] !== undefined);
  await waitFor(() => phone1.doc.tasks['t2'] !== undefined);
  await settle();
  assert.equal(laptop.isRemoved, true);
});

test('K8: the new key and the rotation survive a restart', async () => {
  const phone1 = await founder();
  const phone2 = await joinWith(phone1.invite(), 'gsm-B');
  const laptop = await joinWith(phone1.invite(), 'laptop');
  await waitFor(() => phone2.hasHousehold && laptop.hasHousehold);
  phone1.unpair(laptop.deviceId);
  await waitFor(() => phone2.epoch === 1);
  phone2.close();

  const restarted = track(Device.load({ name: 'gsm-B', dataDir: dirs.make('gsm-B') }));
  assert.equal(restarted.epoch, 1);
  await restarted.connectRelay(relayAddress);
  phone1.change((d) => addTask(d, { id: 't1', title: 'Na herstart', createdBy: 'lid-a' }));
  await waitFor(() => restarted.doc.tasks['t1'] !== undefined);
});
