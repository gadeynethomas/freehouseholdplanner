import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  DecryptError,
  exportPrivateKey,
  generateDeviceKeys,
  generateHouseholdKey,
  importDeviceKeys,
  open,
  openFrom,
  roomIdFor,
  seal,
  sealTo,
  signBytes,
  verifySignature,
} from '../src/crypto.ts';

const aad = new Uint8Array([1, 2, 3]);
const text = new TextEncoder().encode('ramen poetsen');

test('K4: sealed messages round-trip and hide the plaintext', () => {
  const key = generateHouseholdKey();
  const sealed = seal(key, text, aad);
  assert.equal(Buffer.from(sealed).includes(Buffer.from(text)), false);
  assert.deepEqual(open(key, sealed, aad), text);
});

test('K4: the same message encrypts differently each time', () => {
  const key = generateHouseholdKey();
  assert.notDeepEqual(seal(key, text, aad), seal(key, text, aad));
});

test('K4: a wrong key, changed bytes or other associated data are rejected', () => {
  const key = generateHouseholdKey();
  const sealed = seal(key, text, aad);
  assert.throws(() => open(generateHouseholdKey(), sealed, aad), DecryptError);
  const tampered = sealed.slice();
  tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 1;
  assert.throws(() => open(key, tampered, aad), DecryptError);
  assert.throws(() => open(key, sealed, new Uint8Array([9])), DecryptError);
  assert.throws(() => open(key, new Uint8Array(5), aad), DecryptError);
});

test('keys must be 32 bytes', () => {
  assert.throws(() => seal(new Uint8Array(16), text, aad), RangeError);
});

test('the relay room id is stable per household and reveals nothing about it', () => {
  const householdId = randomUUID();
  assert.deepEqual(roomIdFor(householdId), roomIdFor(householdId));
  assert.notDeepEqual(roomIdFor(householdId), roomIdFor(randomUUID()));
  assert.equal(Buffer.from(roomIdFor(householdId)).includes(Buffer.from(householdId)), false);
});

test('K4: a device signature verifies only for that device and that exact message', () => {
  const device = generateDeviceKeys();
  const other = generateDeviceKeys();
  const signature = signBytes(device.signingPrivate, text);
  assert.equal(verifySignature(device.signingPublic, text, signature), true);
  assert.equal(verifySignature(other.signingPublic, text, signature), false);
  assert.equal(verifySignature(device.signingPublic, aad, signature), false);
  assert.equal(verifySignature(device.signingPublic, text, signature.subarray(1)), false);
  assert.equal(verifySignature(new Uint8Array(32), text, signature), false);
});

test('K8: a key sealed to one device opens only for that device and that purpose', () => {
  const recipient = generateDeviceKeys();
  const sealed = sealTo(recipient.boxPublic, text, 'purpose-a');
  assert.deepEqual(openFrom(recipient, sealed, 'purpose-a'), text);
  assert.throws(() => openFrom(generateDeviceKeys(), sealed, 'purpose-a'), DecryptError);
  assert.throws(() => openFrom(recipient, sealed, 'purpose-b'), DecryptError);
  assert.throws(() => openFrom(recipient, sealed.subarray(0, 20), 'purpose-a'), DecryptError);
});

test('device keys survive export and import', () => {
  const keys = generateDeviceKeys();
  const restored = importDeviceKeys(
    exportPrivateKey(keys.signingPrivate),
    exportPrivateKey(keys.boxPrivate),
  );
  assert.deepEqual(restored.signingPublic, keys.signingPublic);
  assert.deepEqual(restored.boxPublic, keys.boxPublic);
  assert.throws(() =>
    importDeviceKeys(exportPrivateKey(keys.boxPrivate), exportPrivateKey(keys.boxPrivate)),
  );
});
