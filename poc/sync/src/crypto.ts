// Cryptographic building blocks, all from node:crypto (OpenSSL); no custom primitives.
// - Household key: AES-256-GCM over all sync traffic (K4); replaced on unpairing (K8).
// - Device keys: Ed25519 to sign every message, X25519 to receive a key sealed to one device (K2, K8).
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from 'node:crypto';

export const KEY_BYTES = 32;
export const PUBLIC_KEY_BYTES = 32;
export const SIGNATURE_BYTES = 64;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class DecryptError extends Error {}

export function generateHouseholdKey(): Uint8Array {
  return new Uint8Array(randomBytes(KEY_BYTES));
}

export function assertKey(key: Uint8Array): void {
  if (key.length !== KEY_BYTES) throw new RangeError(`household key must be ${KEY_BYTES} bytes`);
}

/** Relay routing id: derived from the household id, so it survives key rotation and reveals nothing. */
export function roomIdFor(householdId: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update('fhp-room-v2').update(householdId).digest());
}

/** Returns nonce | tag | ciphertext. `aad` is authenticated but not encrypted. */
export function seal(key: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Uint8Array {
  assertKey(key);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return new Uint8Array(Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]));
}

export function open(key: Uint8Array, sealed: Uint8Array, aad: Uint8Array): Uint8Array {
  assertKey(key);
  if (sealed.length < NONCE_BYTES + TAG_BYTES) throw new DecryptError('sealed message too short');
  const nonce = sealed.subarray(0, NONCE_BYTES);
  const tag = sealed.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
  const ciphertext = sealed.subarray(NONCE_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  try {
    return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
  } catch {
    throw new DecryptError('message could not be authenticated');
  }
}

export interface DeviceKeys {
  signingPrivate: KeyObject;
  signingPublic: Uint8Array;
  boxPrivate: KeyObject;
  boxPublic: Uint8Array;
}

export function generateDeviceKeys(): DeviceKeys {
  const signing = generateKeyPairSync('ed25519');
  const box = generateKeyPairSync('x25519');
  return {
    signingPrivate: signing.privateKey,
    signingPublic: rawPublicKey(signing.publicKey),
    boxPrivate: box.privateKey,
    boxPublic: rawPublicKey(box.publicKey),
  };
}

export function exportPrivateKey(key: KeyObject): Uint8Array {
  return new Uint8Array(key.export({ format: 'der', type: 'pkcs8' }));
}

/** Restores device keys from their stored private halves; throws on anything malformed. */
export function importDeviceKeys(signingPrivate: Uint8Array, boxPrivate: Uint8Array): DeviceKeys {
  const signing = createPrivateKey({
    key: Buffer.from(signingPrivate),
    format: 'der',
    type: 'pkcs8',
  });
  const box = createPrivateKey({ key: Buffer.from(boxPrivate), format: 'der', type: 'pkcs8' });
  if (signing.asymmetricKeyType !== 'ed25519' || box.asymmetricKeyType !== 'x25519') {
    throw new TypeError('unexpected device key type');
  }
  return {
    signingPrivate: signing,
    signingPublic: rawPublicKey(createPublicKey(signing)),
    boxPrivate: box,
    boxPublic: rawPublicKey(createPublicKey(box)),
  };
}

export function signBytes(signingPrivate: KeyObject, data: Uint8Array): Uint8Array {
  return new Uint8Array(sign(null, data, signingPrivate));
}

export function verifySignature(
  signingPublic: Uint8Array,
  data: Uint8Array,
  signature: Uint8Array,
): boolean {
  if (signingPublic.length !== PUBLIC_KEY_BYTES || signature.length !== SIGNATURE_BYTES)
    return false;
  try {
    return verify(null, data, publicKeyObject('Ed25519', signingPublic), signature);
  } catch {
    return false;
  }
}

/**
 * Seals a message so only the holder of `recipientBoxPublic`'s private key can read it:
 * an ephemeral X25519 key agreement, HKDF-SHA256 bound to `purpose` and both public keys,
 * then AES-256-GCM. Layout: ephemeral public key | sealed.
 */
export function sealTo(
  recipientBoxPublic: Uint8Array,
  plaintext: Uint8Array,
  purpose: string,
): Uint8Array {
  const ephemeral = generateKeyPairSync('x25519');
  const ephemeralPublic = rawPublicKey(ephemeral.publicKey);
  const key = boxKey(
    ephemeral.privateKey,
    recipientBoxPublic,
    ephemeralPublic,
    recipientBoxPublic,
    purpose,
  );
  const context = Buffer.concat([ephemeralPublic, recipientBoxPublic]);
  return new Uint8Array(Buffer.concat([ephemeralPublic, seal(key, plaintext, context)]));
}

export function openFrom(keys: DeviceKeys, sealed: Uint8Array, purpose: string): Uint8Array {
  if (sealed.length <= PUBLIC_KEY_BYTES) throw new DecryptError('sealed box too short');
  const ephemeralPublic = sealed.subarray(0, PUBLIC_KEY_BYTES);
  let key: Uint8Array;
  try {
    key = boxKey(keys.boxPrivate, ephemeralPublic, ephemeralPublic, keys.boxPublic, purpose);
  } catch {
    throw new DecryptError('invalid ephemeral key');
  }
  const context = Buffer.concat([ephemeralPublic, keys.boxPublic]);
  return open(key, sealed.subarray(PUBLIC_KEY_BYTES), context);
}

function boxKey(
  privateKey: KeyObject,
  otherPublic: Uint8Array,
  ephemeralPublic: Uint8Array,
  recipientPublic: Uint8Array,
  purpose: string,
): Uint8Array {
  const shared = diffieHellman({ privateKey, publicKey: publicKeyObject('X25519', otherPublic) });
  const salt = Buffer.concat([ephemeralPublic, recipientPublic]);
  return new Uint8Array(hkdfSync('sha256', shared, salt, purpose, KEY_BYTES));
}

function rawPublicKey(key: KeyObject): Uint8Array {
  const { x } = key.export({ format: 'jwk' });
  if (x === undefined) throw new TypeError('not an OKP key');
  return new Uint8Array(Buffer.from(x, 'base64url'));
}

function publicKeyObject(curve: 'Ed25519' | 'X25519', raw: Uint8Array): KeyObject {
  if (raw.length !== PUBLIC_KEY_BYTES) throw new DecryptError('invalid public key length');
  return createPublicKey({
    key: { kty: 'OKP', crv: curve, x: Buffer.from(raw).toString('base64url') },
    format: 'jwk',
  });
}
