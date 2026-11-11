import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  DecryptError,
  generateDeviceKeys,
  generateHouseholdKey,
  roomIdFor,
} from '../src/crypto.ts';
import {
  InvalidEnvelopeError,
  decodeEnvelope,
  decodeFrame,
  encodeEnvelope,
  openEnvelope,
  sealEnvelope,
} from '../src/envelope.ts';
import {
  INVITE_LIFETIME_MS,
  INVITE_PREFIX,
  InvalidInviteError,
  InvalidPairingMessageError,
  createInvite,
  decodeInvite,
  encodeInvite,
  openPairAccept,
  openPairRequest,
  sealPairAccept,
  sealPairRequest,
  type PairRequest,
} from '../src/pairing.ts';

const now = 1_800_000_000_000;
const inviter = generateDeviceKeys();
const joiner = generateDeviceKeys();

function invite(): ReturnType<typeof createInvite> {
  return createInvite(
    randomUUID(),
    randomUUID(),
    inviter,
    { host: 'relay.local', port: 7400 },
    now,
  );
}

function request(token: Uint8Array): PairRequest {
  return {
    token,
    deviceId: randomUUID(),
    name: 'gsm B',
    signingKey: joiner.signingPublic,
    boxKey: joiner.boxPublic,
  };
}

test('K2: an invite round-trips through its QR text and carries only public data', () => {
  const original = invite();
  const text = encodeInvite(original);
  assert.deepEqual(decodeInvite(text, now), original);
  assert.equal(text.length < 400, true, 'fits a small QR code');
});

test('K2: an invite expires after 10 minutes', () => {
  const text = encodeInvite(invite());
  assert.doesNotThrow(() => decodeInvite(text, now + INVITE_LIFETIME_MS - 1));
  assert.throws(() => decodeInvite(text, now + INVITE_LIFETIME_MS), /expired/);
});

test('K2: malformed invites are rejected', () => {
  const encode = (body: unknown): string =>
    INVITE_PREFIX + Buffer.from(JSON.stringify(body)).toString('base64url');
  const valid = JSON.parse(
    Buffer.from(encodeInvite(invite()).slice(INVITE_PREFIX.length), 'base64url').toString(),
  ) as Record<string, unknown>;

  for (const text of [
    'https://example.com',
    'fhp1:' + Buffer.from('{}').toString('base64url'),
    INVITE_PREFIX + 'not-json',
    encode([]),
    encode({ ...valid, h: '../etc' }),
    encode({ ...valid, s: Buffer.alloc(16).toString('base64url') }),
    encode({ ...valid, t: undefined }),
    encode({ ...valid, r: 'host:0' }),
    encode({ ...valid, r: 42 }),
    encode({ ...valid, e: 'soon' }),
  ]) {
    assert.throws(() => decodeInvite(text, now), InvalidInviteError, text);
  }
});

test('K2: only the inviter can open a pairing request', () => {
  const qr = invite();
  const sealed = sealPairRequest(qr, request(qr.token));
  assert.deepEqual(openPairRequest(inviter, sealed).token, qr.token);
  assert.throws(() => openPairRequest(joiner, sealed), DecryptError);
});

test('K2: the household key reaches only the new device, and only signed by the inviter', () => {
  const qr = invite();
  const req = request(qr.token);
  const householdKey = generateHouseholdKey();
  const sealed = sealPairAccept(inviter, req, { householdKey, epoch: 0 });

  assert.deepEqual(openPairAccept(joiner, qr, sealed), { householdKey, epoch: 0 });
  assert.throws(() => openPairAccept(inviter, qr, sealed), DecryptError);

  // Someone who knows the new device's public key, e.g. the relay, cannot forge an answer.
  const forged = sealPairAccept(generateDeviceKeys(), req, { householdKey, epoch: 0 });
  assert.throws(() => openPairAccept(joiner, qr, forged), InvalidPairingMessageError);
});

test('envelopes round-trip and reject malformed headers', () => {
  const from = randomUUID();
  const to = randomUUID();
  const sync = { kind: 'sync', from, to, data: new Uint8Array([1, 2, 3]) } as const;
  assert.deepEqual(decodeEnvelope(encodeEnvelope(sync)), sync);
  const hello = { kind: 'hello', from, to: null } as const;
  assert.deepEqual(decodeEnvelope(encodeEnvelope(hello)), hello);
  const rekey = { kind: 'rekey', from, to, epoch: 3, data: new Uint8Array([4]) } as const;
  assert.deepEqual(decodeEnvelope(encodeEnvelope(rekey)), rekey);

  assert.throws(() => decodeEnvelope(new Uint8Array([0, 0])), InvalidEnvelopeError);
  assert.throws(
    () => decodeEnvelope(encodeEnvelope({ ...hello, from: 'x' })),
    InvalidEnvelopeError,
  );
  assert.throws(() => decodeFrame(new Uint8Array([9])), InvalidEnvelopeError);
});

test('K4: a signed envelope is bound to its household and key epoch', () => {
  const key = generateHouseholdKey();
  const room = roomIdFor(randomUUID());
  const hello = { kind: 'hello', from: randomUUID(), to: null } as const;
  const frame = decodeFrame(sealEnvelope(key, 2, room, joiner, hello));
  assert.equal(frame.type, 'household');

  assert.deepEqual(openEnvelope(key, 2, room, frame.sealed).envelope, hello);
  assert.throws(() => openEnvelope(key, 1, room, frame.sealed), DecryptError);
  assert.throws(() => openEnvelope(key, 2, roomIdFor(randomUUID()), frame.sealed), DecryptError);
});
