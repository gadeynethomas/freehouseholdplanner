// One device of the household (a phone, a laptop, or the always-on device, K6).
// It holds a full copy of the household document, works offline, and syncs changes with every
// other paired device it can reach: directly on the home network, or through the blind relay (K3).
import { randomUUID } from 'node:crypto';
import { connect, createServer, type Server, type Socket } from 'node:net';
import * as A from '@automerge/automerge';
import {
  DecryptError,
  generateDeviceKeys,
  generateHouseholdKey,
  openFrom,
  roomIdFor,
  sealTo,
  verifySignature,
  type DeviceKeys,
} from './crypto.ts';
import {
  InvalidEnvelopeError,
  decodeFrame,
  encodeFrame,
  openEnvelope,
  sealEnvelope,
  type Envelope,
  type Frame,
} from './envelope.ts';
import { readFrames, writeFrame } from './framing.ts';
import { LanDiscovery, type LanOptions, type LanPeer } from './lan.ts';
import {
  APP_VERSION,
  actorFor,
  activeDevice,
  activeDeviceIds,
  createHousehold,
  isRemovedAuthorChange,
  latestKeyEpoch,
  needsAppUpdate,
  registerDevice,
  registryFingerprint,
  removeDevice,
  sealedKeyFor,
  type DeviceRecord,
  type Household,
  type HouseholdDoc,
} from './model.ts';
import {
  InvalidPairingMessageError,
  createInvite,
  decodeInvite,
  encodeInvite,
  openPairAccept,
  openPairRequest,
  sealPairAccept,
  sealPairRequest,
  type PairAccept,
  type PairRequest,
  type PairingInvite,
  type RelayAddress,
} from './pairing.ts';
import {
  appendDocChunk,
  b64,
  loadDocBytes,
  loadIdentity,
  saveIdentity,
  unb64,
  wipeHousehold,
  writeCompactDoc,
} from './storage.ts';
import { purgeChanges, type PurgeResult } from './purge.ts';

const COMPACT_WHEN_LOG_EXCEEDS = 2;
const REKEY_PURPOSE = 'fhp-rekey-v1';
const PAIR_RETRY_MS = 500;
const RETRY_INTERVAL_MS = 1000;

type LinkKind = 'relay' | 'lan';

interface Link {
  kind: LinkKind;
  socket: Socket;
}

interface Peer {
  deviceId: string;
  link: Link;
  state: A.SyncState;
  lastSyncAt: number | null;
}

export interface PairRequestInfo {
  deviceId: string;
  name: string;
}

export interface DeviceOptions {
  name: string;
  dataDir: string;
  appVersion?: number;
  now?: () => number;
  /** K2: the inviter's user confirms "<name> wants to join". Defaults to yes in this PoC. */
  confirmPairing?: (request: PairRequestInfo) => boolean;
}

export interface PeerStatus {
  deviceId: string;
  via: LinkKind;
  lastSyncAt: number | null;
}

/** A joined device must not write before it holds the household's history, or its writes fork the root. */
export class NotYetSyncedError extends Error {}

export class Device {
  readonly name: string;
  readonly deviceId: string;
  readonly householdId: string;
  readonly appVersion: number;
  /** Frames that failed decryption, signature or validation: a foreign, removed or broken device. */
  rejectedFrames = 0;
  /** Sync messages refused because they carry changes by a removed device (K8). */
  refusedSyncMessages = 0;
  /** The last purge of a removed device's changes from this device's own copy (K8). */
  lastPurge: PurgeResult | null = null;

  readonly #keys: DeviceKeys;
  readonly #householdKeys: Map<number, Uint8Array>;
  readonly #roomId: Uint8Array;
  readonly #dataDir: string;
  readonly #now: () => number;
  readonly #confirmPairing: (request: PairRequestInfo) => boolean;
  readonly #peers = new Map<string, Peer>();
  readonly #links = new Set<Link>();
  readonly #lanConnecting = new Set<string>();
  readonly #pendingInvites = new Map<string, number>();
  #epoch: number;
  #actorGeneration: number;
  #purgeCheckPending: boolean;
  #removed = false;
  #doc: Household;
  #joining: PairingInvite | null = null;
  #pairRequestFrame: Uint8Array | null = null;
  #pairTimer: NodeJS.Timeout | null = null;
  #lastNewerEpochHello = 0;
  #relayAddress: RelayAddress | null = null;
  #lanOptions: LanOptions | null = null;
  #lanServer: Server | null = null;
  #discovery: LanDiscovery | null = null;
  #changeListeners: Array<() => void> = [];

  private constructor(
    options: DeviceOptions,
    identity: {
      deviceId: string;
      householdId: string;
      keys: DeviceKeys;
      actorGeneration: number;
      purgeCheckPending: boolean;
      householdKeys: Map<number, Uint8Array>;
    },
    doc: Household,
  ) {
    this.name = options.name;
    this.deviceId = identity.deviceId;
    this.householdId = identity.householdId;
    this.appVersion = options.appVersion ?? APP_VERSION;
    this.#keys = identity.keys;
    this.#householdKeys = identity.householdKeys;
    this.#actorGeneration = identity.actorGeneration;
    this.#purgeCheckPending = identity.purgeCheckPending;
    this.#epoch = Math.max(-1, ...identity.householdKeys.keys());
    this.#roomId = roomIdFor(identity.householdId);
    this.#dataDir = options.dataDir;
    this.#now = options.now ?? Date.now;
    this.#confirmPairing = options.confirmPairing ?? (() => true);
    this.#doc = doc;
  }

  /** K1: the first device creates the household. */
  static createHousehold(options: DeviceOptions): Device {
    const deviceId = randomUUID();
    const householdId = randomUUID();
    const keys = generateDeviceKeys();
    const householdKeys = new Map([[0, generateHouseholdKey()]]);
    const now = (options.now ?? Date.now)();
    const founder = deviceRecord(options.name, keys.signingPublic, keys.boxPublic, deviceId, now);
    const doc = createHousehold(householdId, deviceId, founder, actorFor(deviceId, 0));
    const identity = {
      deviceId,
      householdId,
      name: options.name,
      keys,
      actorGeneration: 0,
      purgeCheckPending: false,
      householdKeys,
    };
    saveIdentity(options.dataDir, identity);
    appendDocChunk(options.dataDir, A.save(doc));
    return new Device(options, identity, doc);
  }

  /** K2: a new device scans the invite, asks to join, and waits for the inviter's answer. */
  static join(options: DeviceOptions, inviteText: string): Device {
    const invite = decodeInvite(inviteText, (options.now ?? Date.now)());
    const identity = {
      deviceId: randomUUID(),
      householdId: invite.householdId,
      keys: generateDeviceKeys(),
      actorGeneration: 0,
      purgeCheckPending: false,
      householdKeys: new Map<number, Uint8Array>(),
    };
    const actor = actorFor(identity.deviceId, 0);
    const device = new Device(options, identity, A.init<HouseholdDoc>({ actor }));
    device.#joining = invite;
    device.#relayAddress = invite.relay;
    device.#pairRequestFrame = encodeFrame({
      type: 'pair-request',
      sealed: sealPairRequest(invite, {
        token: invite.token,
        deviceId: identity.deviceId,
        name: options.name,
        signingKey: identity.keys.signingPublic,
        boxKey: identity.keys.boxPublic,
      }),
    });
    device.#pairTimer = setInterval(() => {
      device.#sendPairRequest();
    }, PAIR_RETRY_MS);
    return device;
  }

  /** Restart from local storage, compacting the change log when it has grown well past a full save. */
  static load(options: DeviceOptions): Device {
    const identity = loadIdentity(options.dataDir);
    const bytes = loadDocBytes(options.dataDir);
    const actor = actorFor(identity.deviceId, identity.actorGeneration);
    const doc =
      bytes === null ? A.init<HouseholdDoc>({ actor }) : A.load<HouseholdDoc>(bytes, { actor });
    if (bytes !== null) {
      const compact = A.save(doc);
      if (bytes.length > COMPACT_WHEN_LOG_EXCEEDS * compact.length) {
        writeCompactDoc(options.dataDir, compact);
      }
    }
    return new Device(options, identity, doc);
  }

  get doc(): Household {
    return this.#doc;
  }

  get relayAddress(): RelayAddress | null {
    return this.#relayAddress;
  }

  get epoch(): number {
    return this.#epoch;
  }

  get isPaired(): boolean {
    return this.#householdKeys.size > 0;
  }

  /** True once this device learned it was unpaired; it then forgot the household (K8). */
  get isRemoved(): boolean {
    return this.#removed;
  }

  get hasHousehold(): boolean {
    return this.#doc.householdId === this.householdId;
  }

  get needsAppUpdate(): boolean {
    return this.hasHousehold && needsAppUpdate(this.#doc, this.appVersion);
  }

  /** K2: a one-time invite for the QR code, valid for 10 minutes while this device runs. */
  invite(): string {
    if (!this.hasHousehold) throw new NotYetSyncedError('wait for the first sync before inviting');
    const invite = createInvite(
      this.householdId,
      this.deviceId,
      this.#keys,
      this.#relayAddress,
      this.#now(),
    );
    this.#pendingInvites.set(b64(invite.token), invite.expiresAt);
    return encodeInvite(invite);
  }

  /** Apply a local change (any model function) and share it with every reachable device. */
  change(update: (doc: Household) => Household): void {
    if (!this.hasHousehold) {
      throw new NotYetSyncedError('wait for the first sync before changing data');
    }
    const fingerprint = registryFingerprint(this.#doc);
    this.#doc = update(this.#doc);
    this.#persist();
    this.#syncAll();
    this.#afterRegistryChange(fingerprint);
  }

  /**
   * K8: removes a device and moves the household to a new key, sealed to each remaining device.
   * The removed device keeps what it already had, but cannot read anything written from now on.
   */
  unpair(targetId: string): void {
    if (!this.hasHousehold) throw new NotYetSyncedError('wait for the first sync');
    if (targetId === this.deviceId) throw new Error('a device cannot unpair itself here');
    if (activeDevice(this.#doc, targetId) === undefined) throw new Error('unknown device');

    const oldEpoch = this.#epoch;
    const newEpoch = Math.max(oldEpoch, latestKeyEpoch(this.#doc)) + 1;
    const newKey = generateHouseholdKey();
    const sealedKeys: Record<string, string> = {};
    for (const id of activeDeviceIds(this.#doc)) {
      const record = activeDevice(this.#doc, id);
      if (id === targetId || record === undefined) continue;
      sealedKeys[id] = b64(sealTo(unb64(record.boxKey), newKey, REKEY_PURPOSE));
    }
    // Not synced in the old epoch: the removed device still holds that key.
    this.#doc = removeDevice(this.#doc, targetId, this.#now(), newEpoch, sealedKeys);
    this.#persist();
    const target = this.#peers.get(targetId);
    if (target !== undefined) this.#sendRemoved(target.link, targetId, oldEpoch);
    this.#peers.delete(targetId);
    this.#switchEpoch(newEpoch, newKey);
    // Peers still on the old epoch get the new key now, each sealed to that peer alone.
    for (const peer of this.#peers.values()) this.#sendRekey(peer.link, peer.deviceId, oldEpoch);
  }

  onChange(listener: () => void): void {
    this.#changeListeners.push(listener);
  }

  /** K7: who this device last synced with, and how. */
  status(): PeerStatus[] {
    return [...this.#peers.values()].map((peer) => ({
      deviceId: peer.deviceId,
      via: peer.link.kind,
      lastSyncAt: peer.lastSyncAt,
    }));
  }

  connectRelay(address: RelayAddress | null = this.#relayAddress): Promise<void> {
    if (address === null) return Promise.reject(new Error('no relay address'));
    this.#relayAddress = address;
    return new Promise((resolve, reject) => {
      const socket = connect(address.port, address.host);
      socket.once('error', reject);
      socket.once('connect', () => {
        socket.off('error', reject);
        writeFrame(socket, this.#roomId);
        this.#attach({ kind: 'relay', socket });
        resolve();
      });
    });
  }

  async startLan(options: LanOptions | null = this.#lanOptions): Promise<void> {
    if (options === null) throw new Error('no LAN options');
    this.#lanOptions = options;
    const server = createServer((socket) => {
      this.#attach({ kind: 'lan', socket });
    });
    const port = await listen(server, options.listenHost ?? '0.0.0.0');
    this.#lanServer = server;
    const roomHex = Buffer.from(this.#roomId).toString('hex');
    this.#discovery = new LanDiscovery(roomHex, this.deviceId, port, options, (peer) => {
      this.#onLanPeer(peer);
    });
    await this.#discovery.start();
  }

  /** Simulates losing the connection (airplane mode, no wifi). Data stays local and editable. */
  goOffline(): void {
    this.#discovery?.stop();
    this.#discovery = null;
    this.#lanServer?.close();
    this.#lanServer = null;
    for (const link of this.#links) link.socket.destroy();
    this.#links.clear();
    this.#peers.clear();
    this.#lanConnecting.clear();
  }

  async goOnline(): Promise<void> {
    if (this.#relayAddress !== null) await this.connectRelay();
    if (this.#lanOptions !== null) await this.startLan();
  }

  close(): void {
    if (this.#pairTimer !== null) clearInterval(this.#pairTimer);
    this.#pairTimer = null;
    this.goOffline();
  }

  // --- links -------------------------------------------------------------------------------

  #onLanPeer(peer: LanPeer): void {
    // The device with the smaller id dials, so two devices open one connection between them.
    if (this.deviceId > peer.deviceId) return;
    if (
      this.#peers.get(peer.deviceId)?.link.kind === 'lan' ||
      this.#lanConnecting.has(peer.deviceId)
    ) {
      return;
    }
    this.#lanConnecting.add(peer.deviceId);
    const socket = connect(peer.port, peer.address);
    socket.once('error', () => this.#lanConnecting.delete(peer.deviceId));
    socket.once('connect', () => {
      this.#attach({ kind: 'lan', socket });
    });
  }

  #attach(link: Link): void {
    this.#links.add(link);
    link.socket.on('error', () => link.socket.destroy());
    link.socket.on('close', () => {
      this.#detach(link);
    });
    readFrames(link.socket, (frame) => {
      this.#receive(link, frame);
    });
    if (this.isPaired) this.#hello(link);
    else this.#sendPairRequest();
  }

  #detach(link: Link): void {
    this.#links.delete(link);
    for (const peer of [...this.#peers.values()]) {
      if (peer.link !== link) continue;
      this.#peers.delete(peer.deviceId);
      this.#lanConnecting.delete(peer.deviceId);
      // A peer reached over LAN may still be reachable via the relay: say hello there again.
      for (const other of this.#links) if (other.kind === 'relay') this.#hello(other);
    }
  }

  #hello(link: Link): void {
    this.#send(link, { kind: 'hello', from: this.deviceId, to: null });
  }

  /** Starts fresh sessions with everyone, e.g. after a key change or when new devices are known. */
  #restartSessions(): void {
    for (const peer of this.#peers.values()) peer.state = A.initSyncState();
    for (const link of this.#links) this.#hello(link);
  }

  // --- receiving ---------------------------------------------------------------------------

  #receive(link: Link, bytes: Uint8Array): void {
    let frame: Frame;
    try {
      frame = decodeFrame(bytes);
    } catch {
      this.rejectedFrames += 1;
      return;
    }
    if (frame.type === 'pair-request') this.#onPairRequest(link, frame.sealed);
    else if (frame.type === 'pair-accept') this.#onPairAccept(frame.sealed);
    else this.#onHouseholdFrame(link, frame.epoch, frame.sealed);
  }

  #onHouseholdFrame(link: Link, epoch: number, sealed: Uint8Array): void {
    if (!this.isPaired) return;
    if (epoch > this.#epoch) {
      this.#helloForNewerEpoch(link);
      return;
    }
    const key = this.#householdKeys.get(epoch);
    if (key === undefined) return;

    let envelope: Envelope;
    try {
      const opened = openEnvelope(key, epoch, this.#roomId, sealed);
      const signer = this.#signerOf(opened.envelope.from);
      if (signer === null || !verifySignature(signer.key, opened.signed, opened.signature)) {
        this.rejectedFrames += 1;
        return;
      }
      if (signer.removed) {
        // A removed device that does not know it yet: tell it, so it switches itself off.
        this.rejectedFrames += 1;
        this.#sendRemoved(link, opened.envelope.from, epoch);
        return;
      }
      envelope = opened.envelope;
    } catch (error) {
      if (!(error instanceof DecryptError || error instanceof InvalidEnvelopeError)) throw error;
      this.rejectedFrames += 1;
      return;
    }
    if (envelope.from === this.deviceId) return;
    if (envelope.to !== null && envelope.to !== this.deviceId) return;

    if (epoch < this.#epoch) {
      // The sender missed a key rotation. It says hello on every (re)connect; answer each hello
      // with only the new key, sealed to it alone. Nothing else is sent in an old epoch.
      if (envelope.kind === 'hello') this.#sendRekey(link, envelope.from, epoch);
      return;
    }
    this.#handle(link, envelope);
  }

  #handle(link: Link, envelope: Envelope): void {
    const peer = this.#peerFor(envelope.from, link);
    if (envelope.kind === 'hello') {
      if (envelope.to === null) {
        // A broadcast hello means the peer (re)connected with a fresh session. Our state for it is
        // stale: it may claim the peer already has changes it never received, which stalls sync.
        peer.state = A.initSyncState();
        this.#send(link, { kind: 'hello', from: this.deviceId, to: peer.deviceId });
      }
      this.#syncPeer(peer);
    } else if (envelope.kind === 'sync') {
      this.#receiveSync(peer, envelope.data);
    } else if (envelope.kind === 'rekey') {
      this.#receiveRekey(envelope.epoch, envelope.data);
    } else {
      this.#switchOff();
    }
  }

  /** The signing key of a known device, and whether it was removed; null when unknown. */
  #signerOf(deviceId: string): { key: Uint8Array; removed: boolean } | null {
    if (this.hasHousehold) {
      const record = this.#doc.devices[deviceId];
      if (record === undefined) return null;
      return { key: unb64(record.signingKey), removed: record.removedAt !== null };
    }
    // Before the first sync, only the inviter (known from the QR code) is trusted.
    const invite = this.#joining;
    return invite?.inviterId === deviceId
      ? { key: invite.inviterSigningKey, removed: false }
      : null;
  }

  /** Prefers a direct LAN link over the relay; a new link starts a fresh sync session. */
  #peerFor(deviceId: string, link: Link): Peer {
    const existing = this.#peers.get(deviceId);
    if (existing !== undefined && !(link.kind === 'lan' && existing.link.kind === 'relay')) {
      return existing;
    }
    const peer: Peer = {
      deviceId,
      link,
      state: A.initSyncState(),
      lastSyncAt: existing?.lastSyncAt ?? null,
    };
    this.#peers.set(deviceId, peer);
    this.#lanConnecting.delete(deviceId);
    return peer;
  }

  #receiveSync(peer: Peer, message: Uint8Array): void {
    const headsBefore = A.getHeads(this.#doc);
    const fingerprint = this.hasHousehold ? registryFingerprint(this.#doc) : '';
    let doc: Household;
    let state: A.SyncState;
    try {
      [doc, state] = A.receiveSyncMessage(this.#doc, peer.state, this.#withoutRefused(message));
    } catch {
      // Authenticated but unusable (a buggy or newer peer, or changes whose history we refused):
      // drop it, keep the connection, and start a fresh session with that peer.
      this.rejectedFrames += 1;
      peer.state = A.initSyncState();
      this.#send(peer.link, { kind: 'hello', from: this.deviceId, to: null });
      return;
    }
    this.#doc = doc;
    peer.state = state;
    peer.lastSyncAt = this.#now();
    const changed = !sameHeads(headsBefore, A.getHeads(doc));
    if (changed) {
      this.#persist();
      // Purge first (K8), so no reply is ever built from a copy that holds refused changes.
      if (this.#afterRegistryChange(fingerprint)) return;
    }
    this.#syncPeer(peer);
    if (!changed) return;
    this.#syncAll();
    for (const listener of this.#changeListeners) listener();
  }

  /** Returns true when the device list changed; sessions then restart (after a purge if needed). */
  #afterRegistryChange(before: string): boolean {
    if (!this.hasHousehold || registryFingerprint(this.#doc) === before) return false;
    this.#purgeRemovedAuthors();
    this.#restartSessions();
    for (const listener of this.#changeListeners) listener();
    return true;
  }

  /**
   * K8: drops the changes of a sync message when any of them was written by a removed device after
   * its removal. The rest of the message (what the peer has and needs) is kept, so the peer still
   * receives the removal from us and can purge its own copy.
   */
  #withoutRefused(message: Uint8Array): Uint8Array {
    if (!this.#anyDeviceRemoved()) return message;
    const decoded = A.decodeSyncMessage(message);
    if (decoded.changes.length === 0) return message;
    // Chunks may be single changes or partial documents: apply them to a cheap fork and look at
    // which changes they add.
    let candidate = A.clone(this.#doc);
    for (const chunk of decoded.changes) candidate = A.loadIncremental(candidate, chunk);
    const refused = A.getChanges(this.#doc, candidate)
      .map(A.decodeChange)
      .some((change) => isRemovedAuthorChange(this.#doc, change.actor, change.seq));
    if (!refused) return message;
    this.refusedSyncMessages += 1;
    return A.encodeSyncMessage({ ...decoded, changes: [] });
  }

  #anyDeviceRemoved(): boolean {
    return (
      this.hasHousehold && activeDeviceIds(this.#doc).length < Object.keys(this.#doc.devices).length
    );
  }

  /** K8: a lagging device took in a removed device's late changes before it heard of the removal. */
  #purgeRemovedAuthors(): void {
    // Only a device that missed a rotation can hold refused changes: current devices filter them.
    if (!this.#purgeCheckPending || !this.#anyDeviceRemoved()) return;
    if (latestKeyEpoch(this.#doc) >= this.#epoch) this.#purgeCheckPending = false;
    const doc = this.#doc;
    const nextActor = actorFor(this.deviceId, this.#actorGeneration + 1);
    const result = purgeChanges(
      doc,
      (actor, seq) => isRemovedAuthorChange(doc, actor, seq),
      nextActor,
    );
    if (result === null) {
      this.#saveIdentity();
      return;
    }
    this.lastPurge = result;
    this.#actorGeneration += 1;
    this.#doc = result.doc;
    writeCompactDoc(this.#dataDir, A.save(this.#doc));
    this.#saveIdentity();
  }

  // --- pairing (K2) ------------------------------------------------------------------------

  #sendPairRequest(): void {
    const frame = this.#pairRequestFrame;
    if (frame === null) return;
    for (const link of this.#links) writeFrame(link.socket, frame);
  }

  #onPairRequest(link: Link, sealed: Uint8Array): void {
    if (!this.hasHousehold || this.#pendingInvites.size === 0) return;
    let request: PairRequest;
    try {
      request = openPairRequest(this.#keys, sealed);
    } catch (error) {
      // Sealed to another device, or malformed: not ours to answer.
      if (error instanceof DecryptError || error instanceof InvalidPairingMessageError) return;
      throw error;
    }
    const token = b64(request.token);
    const expiresAt = this.#pendingInvites.get(token);
    if (expiresAt === undefined || expiresAt <= this.#now()) return;
    this.#pendingInvites.delete(token);
    if (this.#doc.devices[request.deviceId] !== undefined) return;
    if (!this.#confirmPairing({ deviceId: request.deviceId, name: request.name })) return;

    const record = deviceRecord(
      request.name,
      request.signingKey,
      request.boxKey,
      this.deviceId,
      this.#now(),
    );
    this.change((d) => registerDevice(d, request.deviceId, record));
    const key = this.#householdKeys.get(this.#epoch);
    if (key === undefined) return;
    const accept = sealPairAccept(this.#keys, request, { householdKey: key, epoch: this.#epoch });
    writeFrame(link.socket, encodeFrame({ type: 'pair-accept', sealed: accept }));
  }

  #onPairAccept(sealed: Uint8Array): void {
    const invite = this.#joining;
    if (invite === null || this.isPaired) return;
    let accept: PairAccept;
    try {
      accept = openPairAccept(this.#keys, invite, sealed);
    } catch (error) {
      if (error instanceof DecryptError || error instanceof InvalidPairingMessageError) return;
      throw error;
    }
    if (this.#pairTimer !== null) clearInterval(this.#pairTimer);
    this.#pairTimer = null;
    this.#pairRequestFrame = null;
    this.#householdKeys.set(accept.epoch, accept.householdKey);
    this.#epoch = accept.epoch;
    this.#saveIdentity();
    for (const link of this.#links) this.#hello(link);
  }

  // --- key rotation (K8) -------------------------------------------------------------------

  #sendRekey(link: Link, targetId: string, oldEpoch: number): void {
    const sealedKey = sealedKeyFor(this.#doc, this.#epoch, targetId);
    if (sealedKey === undefined) return;
    const envelope: Envelope = {
      kind: 'rekey',
      from: this.deviceId,
      to: targetId,
      epoch: this.#epoch,
      data: unb64(sealedKey),
    };
    this.#send(link, envelope, oldEpoch);
  }

  #sendRemoved(link: Link, targetId: string, epoch: number): void {
    this.#send(link, { kind: 'removed', from: this.deviceId, to: targetId }, epoch);
  }

  /**
   * K8: a current device told us we were unpaired. Forget the household: keys, data and links.
   * Only a device the household still lists as active can send this, signed.
   */
  #switchOff(): void {
    this.#removed = true;
    this.close();
    this.#householdKeys.clear();
    this.#doc = A.init<HouseholdDoc>();
    wipeHousehold(this.#dataDir);
    for (const listener of this.#changeListeners) listener();
  }

  #receiveRekey(epoch: number, sealedKey: Uint8Array): void {
    if (epoch <= this.#epoch) return;
    let key: Uint8Array;
    try {
      key = openFrom(this.#keys, sealedKey, REKEY_PURPOSE);
    } catch {
      this.rejectedFrames += 1;
      return;
    }
    this.#purgeCheckPending = true;
    this.#switchEpoch(epoch, key);
  }

  #switchEpoch(epoch: number, key: Uint8Array): void {
    this.#householdKeys.set(epoch, key);
    this.#epoch = epoch;
    this.#saveIdentity();
    this.#restartSessions();
  }

  /** We cannot read a newer epoch: say hello in ours, so a current device sends us the new key. */
  #helloForNewerEpoch(link: Link): void {
    if (this.#now() - this.#lastNewerEpochHello < RETRY_INTERVAL_MS) return;
    this.#lastNewerEpochHello = this.#now();
    this.#hello(link);
  }

  // --- sending and storage -----------------------------------------------------------------

  #syncAll(): void {
    for (const peer of this.#peers.values()) this.#syncPeer(peer);
  }

  #syncPeer(peer: Peer): void {
    const [state, message] = A.generateSyncMessage(this.#doc, peer.state);
    peer.state = state;
    if (message === null) return;
    this.#send(peer.link, { kind: 'sync', from: this.deviceId, to: peer.deviceId, data: message });
  }

  #send(link: Link, envelope: Envelope, epoch: number = this.#epoch): void {
    const key = this.#householdKeys.get(epoch);
    if (link.socket.destroyed || key === undefined) return;
    writeFrame(link.socket, sealEnvelope(key, epoch, this.#roomId, this.#keys, envelope));
  }

  #persist(): void {
    appendDocChunk(this.#dataDir, A.saveIncremental(this.#doc));
  }

  #saveIdentity(): void {
    saveIdentity(this.#dataDir, {
      deviceId: this.deviceId,
      householdId: this.householdId,
      name: this.name,
      keys: this.#keys,
      actorGeneration: this.#actorGeneration,
      purgeCheckPending: this.#purgeCheckPending,
      householdKeys: this.#householdKeys,
    });
  }
}

function deviceRecord(
  name: string,
  signingKey: Uint8Array,
  boxKey: Uint8Array,
  addedBy: string,
  addedAt: number,
): DeviceRecord {
  return {
    name,
    signingKey: b64(signingKey),
    boxKey: b64(boxKey),
    addedBy,
    addedAt,
    removedAt: null,
    acceptedUpTo: {},
  };
}

function sameHeads(a: A.Heads, b: A.Heads): boolean {
  return a.length === b.length && a.every((head) => b.includes(head));
}

function listen(server: Server, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no address'));
        return;
      }
      resolve(address.port);
    });
  });
}
