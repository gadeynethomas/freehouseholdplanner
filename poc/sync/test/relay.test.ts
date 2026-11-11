// Real devices over TCP through the blind relay: pairing, offline edits, reconnect, restart (K2–K8).
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Device, NotYetSyncedError } from '../src/device.ts';
import { addTask, completeTask, renameTask } from '../src/model.ts';
import type { RelayAddress } from '../src/pairing.ts';
import { Relay } from '../src/relay.ts';
import { converged, rawDevice, tempDirs, waitFor } from './helpers.ts';

let dirs: ReturnType<typeof tempDirs>;
let relay: Relay;
let relayAddress: RelayAddress;
let forwarded: Uint8Array[];
let devices: Device[];

beforeEach(async () => {
  dirs = tempDirs();
  forwarded = [];
  devices = [];
  relay = new Relay({ onForward: (frame) => forwarded.push(frame) });
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

/** Phone A creates the household; phone B and the laptop scan its QR code. */
async function household(): Promise<[Device, Device, Device]> {
  const phone1 = track(Device.createHousehold({ name: 'gsm A', dataDir: dirs.make('phone1') }));
  await phone1.connectRelay(relayAddress);
  const phone2 = track(
    Device.join({ name: 'gsm B', dataDir: dirs.make('phone2') }, phone1.invite()),
  );
  const laptop = track(
    Device.join({ name: 'laptop', dataDir: dirs.make('laptop') }, phone1.invite()),
  );
  await phone2.connectRelay();
  await laptop.connectRelay();
  await waitFor(() => phone2.hasHousehold && laptop.hasHousehold);
  return [phone1, phone2, laptop];
}

test('K2: joined devices receive the full household through the relay', async () => {
  const phone1 = track(Device.createHousehold({ name: 'gsm A', dataDir: dirs.make('phone1') }));
  phone1.change((d) => addTask(d, { id: 't1', title: 'Afwas', createdBy: 'lid-a' }));
  await phone1.connectRelay(relayAddress);

  const phone2 = track(
    Device.join({ name: 'gsm B', dataDir: dirs.make('phone2') }, phone1.invite()),
  );
  assert.throws(() => {
    phone2.change((d) => d);
  }, NotYetSyncedError);
  await phone2.connectRelay();

  await waitFor(() => phone2.hasHousehold && phone2.doc.tasks['t1'] !== undefined);
  assert.equal(phone2.householdId, phone1.householdId);
  assert.equal(phone2.doc.tasks['t1']?.title, 'Afwas');
});

test('K3: a change on one device reaches the others within a second', async () => {
  const [phone1, phone2, laptop] = await household();
  const start = Date.now();
  phone2.change((d) => addTask(d, { id: 't1', title: 'Planten water geven', createdBy: 'lid-b' }));
  await waitFor(
    () => converged([phone1, phone2, laptop]) && phone1.doc.tasks['t1'] !== undefined,
    1000,
  );
  assert.ok(Date.now() - start < 1000);
});

test('K5: all devices edit while offline and converge after reconnecting', async () => {
  const [phone1, phone2, laptop] = await household();
  phone1.change((d) => addTask(d, { id: 't1', title: 'Was', createdBy: 'lid-a' }));
  await waitFor(() => converged([phone1, phone2, laptop]));

  for (const device of [phone1, phone2, laptop]) device.goOffline();
  phone1.change((d) => completeTask(d, 't1', 'lid-a', 1000));
  phone2.change((d) => renameTask(d, 't1', 'Was ophangen'));
  laptop.change((d) => addTask(d, { id: 't2', title: 'Ketel onderhoud', createdBy: 'lid-a' }));
  assert.equal(converged([phone1, phone2, laptop]), false);

  for (const device of [phone1, phone2, laptop]) await device.goOnline();
  await waitFor(() => converged([phone1, phone2, laptop]));

  for (const device of [phone1, phone2, laptop]) {
    const task = device.doc.tasks['t1'];
    assert.ok(task);
    assert.equal(task.title, 'Was ophangen');
    assert.equal(task.done, true);
    assert.equal(device.doc.tasks['t2']?.title, 'Ketel onderhoud');
  }
});

test('K3: devices that are never online at the same time sync through an always-on device (K6)', async () => {
  const [phone1, phone2, alwaysOn] = await household();
  phone2.goOffline();
  phone1.change((d) => addTask(d, { id: 't1', title: 'Vuilbak buiten', createdBy: 'lid-a' }));
  await waitFor(() => alwaysOn.doc.tasks['t1'] !== undefined);
  phone1.goOffline();

  await phone2.goOnline();
  await waitFor(() => phone2.doc.tasks['t1'] !== undefined);
  assert.equal(phone2.doc.tasks['t1']?.title, 'Vuilbak buiten');
});

test('K4: the relay never sees task contents, names or the household id', async () => {
  const [phone1, phone2, laptop] = await household();
  phone1.change((d) => addTask(d, { id: 't1', title: 'Geheime verrassing', createdBy: 'lid-a' }));
  await waitFor(() => converged([phone1, phone2, laptop]));

  assert.ok(forwarded.length > 0);
  const seen = Buffer.concat(forwarded);
  for (const secret of ['Geheime verrassing', 'lid-a', phone1.householdId, phone1.deviceId]) {
    assert.equal(seen.includes(Buffer.from(secret)), false, `relay saw ${secret}`);
  }
});

test("K4: a device with another household's key gets nothing and changes nothing", async () => {
  const [phone1, phone2] = await household();
  const stranger = track(Device.createHousehold({ name: 'buur', dataDir: dirs.make('stranger') }));
  stranger.change((d) => addTask(d, { id: 'x', title: 'Inbraak', createdBy: 'buur' }));
  await stranger.connectRelay(relayAddress);

  phone1.change((d) => addTask(d, { id: 't1', title: 'Afwas', createdBy: 'lid-a' }));
  await waitFor(() => phone2.doc.tasks['t1'] !== undefined);

  assert.equal(stranger.doc.tasks['t1'], undefined);
  assert.equal(phone1.doc.tasks['x'], undefined);
  assert.deepEqual(stranger.status(), []);
});

test('K7: each device knows when it last synced with which device', async () => {
  const [phone1, phone2, laptop] = await household();
  phone1.change((d) => addTask(d, { id: 't1', title: 'Afwas', createdBy: 'lid-a' }));
  await waitFor(() => converged([phone1, phone2, laptop]));

  const status = phone1.status();
  assert.deepEqual(
    status.map((peer) => peer.deviceId).sort(),
    [phone2.deviceId, laptop.deviceId].sort(),
  );
  for (const peer of status) {
    assert.equal(peer.via, 'relay');
    assert.notEqual(peer.lastSyncAt, null);
  }
});

test('a device restarts from local storage and catches up on what it missed', async () => {
  const [phone1, phone2] = await household();
  phone2.change((d) => addTask(d, { id: 't1', title: 'Afwas', createdBy: 'lid-b' }));
  await waitFor(() => phone1.doc.tasks['t1'] !== undefined);
  phone2.close();

  phone1.change((d) => addTask(d, { id: 't2', title: 'Strijk', createdBy: 'lid-a' }));
  const restarted = track(Device.load({ name: 'gsm B', dataDir: dirs.make('phone2') }));
  assert.equal(restarted.deviceId, phone2.deviceId);
  assert.equal(restarted.doc.tasks['t1']?.title, 'Afwas');
  assert.equal(restarted.doc.tasks['t2'], undefined);

  await restarted.connectRelay(relayAddress);
  await waitFor(() => restarted.doc.tasks['t2'] !== undefined);
});

test('K4: a corrupt sync message from a paired device is rejected without crashing', async () => {
  const [phone1, phone2] = await household();
  const forger = await rawDevice(relayAddress, dirs.make('phone2'));
  forger.send(0, {
    kind: 'sync',
    from: phone2.deviceId,
    to: phone1.deviceId,
    data: new Uint8Array([0x42, 0xff, 0x00, 0x13]),
  });
  await waitFor(() => phone1.rejectedFrames > 0);
  forger.close();

  phone2.change((d) => addTask(d, { id: 't1', title: 'Afwas', createdBy: 'lid-b' }));
  await waitFor(() => phone1.doc.tasks['t1'] !== undefined);
});
