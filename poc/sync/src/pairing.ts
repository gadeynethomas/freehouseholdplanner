// Pairing a new device (K2).
//
// The QR code carries no secret that grants access by itself: a one-time token and the inviting
// device's public keys. The new device seals a request with its own public keys to the inviter.
// The inviter checks the token (one-time, 10 minutes), asks its user to confirm, and replies with
// the household key, sealed to the new device and signed. Because the QR code is read from the
// inviter's screen, the new device knows it talks to the real inviter and not to the relay.
import { randomBytes } from 'node:crypto';
import {
  KEY_BYTES,
  PUBLIC_KEY_BYTES,
  SIGNATURE_BYTES,
  openFrom,
  sealTo,
  signBytes,
  verifySignature,
  type DeviceKeys,
} from './crypto.ts';

export const INVITE_PREFIX = 'fhp2:';
export const INVITE_LIFETIME_MS = 10 * 60 * 1000;
export const TOKEN_BYTES = 16;
const REQUEST_PURPOSE = 'fhp-pair-request-v1';
const ACCEPT_PURPOSE = 'fhp-pair-accept-v1';
const ID = /^[0-9a-f-]{36}$/;
const MAX_NAME_LENGTH = 60;

export interface RelayAddress {
  host: string;
  port: number;
}

/** What the QR code shows. */
export interface PairingInvite {
  householdId: string;
  inviterId: string;
  inviterSigningKey: Uint8Array;
  inviterBoxKey: Uint8Array;
  token: Uint8Array;
  relay: RelayAddress | null;
  expiresAt: number;
}

/** What the new device sends, sealed to the inviter. */
export interface PairRequest {
  token: Uint8Array;
  deviceId: string;
  name: string;
  signingKey: Uint8Array;
  boxKey: Uint8Array;
}

/** What the inviter answers, signed by the inviter and sealed to the new device. */
export interface PairAccept {
  householdKey: Uint8Array;
  epoch: number;
}

export class InvalidInviteError extends Error {}
export class InvalidPairingMessageError extends Error {}

export function createInvite(
  householdId: string,
  inviterId: string,
  inviterKeys: DeviceKeys,
  relay: RelayAddress | null,
  now: number,
): PairingInvite {
  return {
    householdId,
    inviterId,
    inviterSigningKey: inviterKeys.signingPublic,
    inviterBoxKey: inviterKeys.boxPublic,
    token: new Uint8Array(randomBytes(TOKEN_BYTES)),
    relay,
    expiresAt: now + INVITE_LIFETIME_MS,
  };
}

export function encodeInvite(invite: PairingInvite): string {
  const body = {
    h: invite.householdId,
    i: invite.inviterId,
    s: b64(invite.inviterSigningKey),
    b: b64(invite.inviterBoxKey),
    t: b64(invite.token),
    r: invite.relay === null ? null : `${invite.relay.host}:${invite.relay.port}`,
    e: invite.expiresAt,
  };
  return INVITE_PREFIX + Buffer.from(JSON.stringify(body)).toString('base64url');
}

export function decodeInvite(text: string, now: number): PairingInvite {
  if (!text.startsWith(INVITE_PREFIX)) throw new InvalidInviteError('not a household invite');
  const body = parseRecord(
    Buffer.from(text.slice(INVITE_PREFIX.length), 'base64url').toString('utf8'),
    InvalidInviteError,
  );
  const expiresAt = body['e'];
  if (typeof expiresAt !== 'number' || !Number.isSafeInteger(expiresAt)) {
    throw new InvalidInviteError('invalid expiry');
  }
  if (expiresAt <= now) throw new InvalidInviteError('invite expired');
  return {
    householdId: id(body['h'], InvalidInviteError),
    inviterId: id(body['i'], InvalidInviteError),
    inviterSigningKey: bytes(body['s'], PUBLIC_KEY_BYTES, InvalidInviteError),
    inviterBoxKey: bytes(body['b'], PUBLIC_KEY_BYTES, InvalidInviteError),
    token: bytes(body['t'], TOKEN_BYTES, InvalidInviteError),
    relay: parseRelay(body['r']),
    expiresAt,
  };
}

export function sealPairRequest(invite: PairingInvite, request: PairRequest): Uint8Array {
  const body = {
    t: b64(request.token),
    d: request.deviceId,
    n: request.name,
    s: b64(request.signingKey),
    b: b64(request.boxKey),
  };
  return sealTo(invite.inviterBoxKey, Buffer.from(JSON.stringify(body)), REQUEST_PURPOSE);
}

/** Throws DecryptError when the request is not meant for this device. */
export function openPairRequest(inviterKeys: DeviceKeys, sealed: Uint8Array): PairRequest {
  const plain = openFrom(inviterKeys, sealed, REQUEST_PURPOSE);
  const body = parseRecord(Buffer.from(plain).toString('utf8'), InvalidPairingMessageError);
  const name = body['n'];
  if (typeof name !== 'string' || name.length === 0 || name.length > MAX_NAME_LENGTH) {
    throw new InvalidPairingMessageError('invalid device name');
  }
  return {
    token: bytes(body['t'], TOKEN_BYTES, InvalidPairingMessageError),
    deviceId: id(body['d'], InvalidPairingMessageError),
    name,
    signingKey: bytes(body['s'], PUBLIC_KEY_BYTES, InvalidPairingMessageError),
    boxKey: bytes(body['b'], PUBLIC_KEY_BYTES, InvalidPairingMessageError),
  };
}

export function sealPairAccept(
  inviterKeys: DeviceKeys,
  request: PairRequest,
  accept: PairAccept,
): Uint8Array {
  const body = Buffer.from(JSON.stringify({ k: b64(accept.householdKey), e: accept.epoch }));
  const signature = signBytes(inviterKeys.signingPrivate, Buffer.concat([request.boxKey, body]));
  return sealTo(request.boxKey, Buffer.concat([signature, body]), ACCEPT_PURPOSE);
}

/** Throws DecryptError when not meant for this device, or when not signed by the inviter. */
export function openPairAccept(
  joinerKeys: DeviceKeys,
  invite: PairingInvite,
  sealed: Uint8Array,
): PairAccept {
  const plain = openFrom(joinerKeys, sealed, ACCEPT_PURPOSE);
  const signature = plain.subarray(0, SIGNATURE_BYTES);
  const body = plain.subarray(SIGNATURE_BYTES);
  const signed = Buffer.concat([joinerKeys.boxPublic, body]);
  if (!verifySignature(invite.inviterSigningKey, signed, signature)) {
    throw new InvalidPairingMessageError('accept not signed by the inviter');
  }
  const record = parseRecord(Buffer.from(body).toString('utf8'), InvalidPairingMessageError);
  const epoch = record['e'];
  if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 0) {
    throw new InvalidPairingMessageError('invalid epoch');
  }
  return { householdKey: bytes(record['k'], KEY_BYTES, InvalidPairingMessageError), epoch };
}

function parseRelay(value: unknown): RelayAddress | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new InvalidInviteError('invalid relay');
  const match = /^([a-zA-Z0-9.-]{1,253}):(\d{1,5})$/.exec(value);
  const port = Number(match?.[2]);
  if (match?.[1] === undefined || port < 1 || port > 65535) {
    throw new InvalidInviteError('invalid relay');
  }
  return { host: match[1], port };
}

type ErrorClass = new (message: string) => Error;

function parseRecord(text: string, error: ErrorClass): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new error('malformed message');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new error('malformed message');
  }
  return value as Record<string, unknown>;
}

function id(value: unknown, error: ErrorClass): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new error('invalid id');
  return value;
}

function bytes(value: unknown, length: number, error: ErrorClass): Uint8Array {
  if (typeof value !== 'string') throw new error('missing bytes');
  const decoded = new Uint8Array(Buffer.from(value, 'base64url'));
  if (decoded.length !== length) throw new error('invalid length');
  return decoded;
}

function b64(value: Uint8Array): string {
  return Buffer.from(value).toString('base64url');
}
