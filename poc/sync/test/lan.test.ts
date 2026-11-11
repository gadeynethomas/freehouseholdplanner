// Devices on the same home network find each other and sync directly, without any relay (K3).
import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Device } from '../src/device.ts';
import type { LanOptions } from '../src/lan.ts';
import { addTask } from '../src/model.ts';
import { Relay } from '../src/relay.ts';
import { converged, tempDirs, waitFor } from './helpers.ts';

const lan: LanOptions = {
  discoveryPort: 41_999,
  interfaceAddress: '127.0.0.1',
  listenHost: '127.0.0.1',
  intervalMs: 100,
};

let dirs: ReturnType<typeof tempDirs>;
let devices: Device[];

beforeEach(() => {
  dirs = tempDirs();
  devices = [];
});

afterEach(() => {
  for (const device of devices) device.close();
  dirs.cleanup();
});

function track(device: Device): Device {
  devices.push(device);
  return device;
}

test('K3: two devices on the home network sync without a relay', async () => {
  const phone1 = track(Device.createHousehold({ name: 'gsm A', dataDir: dirs.make('phone1') }));
  phone1.change((d) => addTask(d, { id: 't1', title: 'Afwas', createdBy: 'lid-a' }));
  const phone2 = track(
    Device.join({ name: 'gsm B', dataDir: dirs.make('phone2') }, phone1.invite()),
  );
  assert.equal(phone2.relayAddress, null);

  await phone1.startLan(lan);
  await phone2.startLan(lan);
  await waitFor(() => phone2.hasHousehold && phone2.doc.tasks['t1'] !== undefined);

  phone2.change((d) => addTask(d, { id: 't2', title: 'Strijk', createdBy: 'lid-b' }));
  await waitFor(() => converged([phone1, phone2]) && phone1.doc.tasks['t2'] !== undefined);
  assert.deepEqual(
    phone1.status().map((peer) => peer.via),
    ['lan'],
  );
});

test('K3: with both available, devices switch from the relay to the direct home connection', async () => {
  const relay = new Relay();
  const relayAddress = await relay.start();
  try {
    const phone1 = track(Device.createHousehold({ name: 'gsm A', dataDir: dirs.make('phone1') }));
    await phone1.connectRelay(relayAddress);
    const phone2 = track(
      Device.join({ name: 'gsm B', dataDir: dirs.make('phone2') }, phone1.invite()),
    );
    await phone2.connectRelay();
    await waitFor(() => phone2.hasHousehold);
    assert.deepEqual(
      phone1.status().map((peer) => peer.via),
      ['relay'],
    );

    await phone1.startLan(lan);
    await phone2.startLan(lan);
    await waitFor(() => phone1.status()[0]?.via === 'lan' && phone2.status()[0]?.via === 'lan');

    phone1.change((d) => addTask(d, { id: 't1', title: 'Afwas', createdBy: 'lid-a' }));
    await waitFor(() => converged([phone1, phone2]) && phone2.doc.tasks['t1'] !== undefined);
  } finally {
    for (const device of devices) device.close();
    await relay.stop();
  }
});
