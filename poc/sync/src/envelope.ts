// Wire format.
//
// Frame (what the relay sees): u8 type | payload
//   household:    u32 epoch | AES-GCM(household key of that epoch, signed envelope, aad = room | epoch)
//   pair-request: sealed box to the inviter (see pairing.ts)
//   pair-accept:  sealed box to the new device
//
// Signed envelope (inside the encryption): Ed25519 signature (64) | envelope.
// The signature covers room | epoch | envelope, so a message cannot be replayed into another
// household or key epoch, and one paired device cannot pose as another (K4).
//
// Envelope: u32 header length | header JSON | body bytes.
import { SIGNATURE_BYTES, open, seal, signBytes, type DeviceKeys } from './crypto.ts';

export type Envelope =
  | { kind: 'hello'; from: string; to: string | null }
  | { kind: 'sync'; from: string; to: string; data: Uint8Array }
  | { kind: 'rekey'; from: string; to: string; epoch: number; data: Uint8Array }
  | { kind: 'removed'; from: string; to: string };

export type Frame =
  | { type: 'household'; epoch: number; sealed: Uint8Array }
  | { type: 'pair-request'; sealed: Uint8Array }
  | { type: 'pair-accept'; sealed: Uint8Array };

export interface OpenedEnvelope {
  envelope: Envelope;
  signature: Uint8Array;
  signed: Uint8Array;
}

export class InvalidEnvelopeError extends Error {}

const FRAME_TYPES = { household: 1, 'pair-request': 2, 'pair-accept': 3 } as const;
const DEVICE_ID = /^[0-9a-f-]{36}$/;

export function encodeFrame(frame: Frame): Uint8Array {
  const type = Buffer.of(FRAME_TYPES[frame.type]);
  if (frame.type !== 'household') return new Uint8Array(Buffer.concat([type, frame.sealed]));
  return new Uint8Array(Buffer.concat([type, u32(frame.epoch), frame.sealed]));
}

export function decodeFrame(bytes: Uint8Array): Frame {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = buffer[0];
  if (type === FRAME_TYPES['pair-request'])
    return { type: 'pair-request', sealed: bytes.subarray(1) };
  if (type === FRAME_TYPES['pair-accept'])
    return { type: 'pair-accept', sealed: bytes.subarray(1) };
  if (type !== FRAME_TYPES.household || buffer.length < 5) {
    throw new InvalidEnvelopeError('unknown frame');
  }
  return { type: 'household', epoch: buffer.readUInt32BE(1), sealed: bytes.subarray(5) };
}

export function sealEnvelope(
  householdKey: Uint8Array,
  epoch: number,
  roomId: Uint8Array,
  keys: DeviceKeys,
  envelope: Envelope,
): Uint8Array {
  const aad = householdAad(roomId, epoch);
  const body = encodeEnvelope(envelope);
  const signature = signBytes(keys.signingPrivate, Buffer.concat([aad, body]));
  const sealed = seal(householdKey, Buffer.concat([signature, body]), aad);
  return encodeFrame({ type: 'household', epoch, sealed });
}

/** Decrypts and parses; the caller verifies `signature` over `signed` with the sender's key. */
export function openEnvelope(
  householdKey: Uint8Array,
  epoch: number,
  roomId: Uint8Array,
  sealed: Uint8Array,
): OpenedEnvelope {
  const aad = householdAad(roomId, epoch);
  const plain = open(householdKey, sealed, aad);
  if (plain.length < SIGNATURE_BYTES) throw new InvalidEnvelopeError('missing signature');
  const body = plain.subarray(SIGNATURE_BYTES);
  return {
    envelope: decodeEnvelope(body),
    signature: plain.subarray(0, SIGNATURE_BYTES),
    signed: new Uint8Array(Buffer.concat([aad, body])),
  };
}

export function encodeEnvelope(envelope: Envelope): Uint8Array {
  const epoch = envelope.kind === 'rekey' ? envelope.epoch : null;
  const header = Buffer.from(
    JSON.stringify({ k: envelope.kind, f: envelope.from, t: envelope.to, e: epoch }),
  );
  const body =
    envelope.kind === 'sync' || envelope.kind === 'rekey' ? envelope.data : new Uint8Array();
  return new Uint8Array(Buffer.concat([u32(header.length), header, body]));
}

export function decodeEnvelope(bytes: Uint8Array): Envelope {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buffer.length < 4) throw new InvalidEnvelopeError('too short');
  const headerLength = buffer.readUInt32BE(0);
  if (buffer.length < 4 + headerLength) throw new InvalidEnvelopeError('truncated header');
  const header = parseHeader(buffer.subarray(4, 4 + headerLength).toString('utf8'));
  const data = new Uint8Array(buffer.subarray(4 + headerLength));

  if (header.kind === 'hello') return { kind: 'hello', from: header.from, to: header.to };
  if (header.to === null) throw new InvalidEnvelopeError('message without recipient');
  if (header.kind === 'sync') return { kind: 'sync', from: header.from, to: header.to, data };
  if (header.kind === 'removed') return { kind: 'removed', from: header.from, to: header.to };
  if (header.epoch === null) throw new InvalidEnvelopeError('rekey without epoch');
  return { kind: 'rekey', from: header.from, to: header.to, epoch: header.epoch, data };
}

function householdAad(roomId: Uint8Array, epoch: number): Uint8Array {
  return new Uint8Array(Buffer.concat([roomId, u32(epoch)]));
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

interface Header {
  kind: Envelope['kind'];
  from: string;
  to: string | null;
  epoch: number | null;
}

function parseHeader(text: string): Header {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new InvalidEnvelopeError('malformed header');
  }
  if (typeof value !== 'object' || value === null) {
    throw new InvalidEnvelopeError('malformed header');
  }
  const { k, f, t, e } = value as Record<string, unknown>;
  if (k !== 'hello' && k !== 'sync' && k !== 'rekey' && k !== 'removed') {
    throw new InvalidEnvelopeError('unknown kind');
  }
  if (typeof f !== 'string' || !DEVICE_ID.test(f)) throw new InvalidEnvelopeError('invalid sender');
  if (t !== null && (typeof t !== 'string' || !DEVICE_ID.test(t))) {
    throw new InvalidEnvelopeError('invalid recipient');
  }
  if (e !== null && (typeof e !== 'number' || !Number.isSafeInteger(e) || e < 0)) {
    throw new InvalidEnvelopeError('invalid epoch');
  }
  return { kind: k, from: f, to: t, epoch: e };
}
