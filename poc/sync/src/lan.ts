// Finding the household's other devices on the home network (K3) with UDP multicast announcements.
// An announcement only carries the room id, a device id and a TCP port; the connection itself is encrypted.
import { createSocket, type Socket } from 'node:dgram';

export interface LanOptions {
  /** UDP port shared by all devices for announcements. */
  discoveryPort: number;
  group?: string;
  /** Interface address to send and receive multicast on (e.g. 127.0.0.1 in tests). */
  interfaceAddress?: string;
  intervalMs?: number;
  /** Address the device's TCP listener binds to. */
  listenHost?: string;
}

export interface LanPeer {
  deviceId: string;
  address: string;
  port: number;
}

const DEFAULT_GROUP = '239.255.42.99';
const DEVICE_ID = /^[0-9a-f-]{36}$/;

export class LanDiscovery {
  readonly #socket: Socket;
  readonly #announcement: Buffer;
  readonly #options: LanOptions;
  readonly #roomHex: string;
  readonly #deviceId: string;
  readonly #onPeer: (peer: LanPeer) => void;
  #timer: NodeJS.Timeout | null = null;

  constructor(
    roomHex: string,
    deviceId: string,
    tcpPort: number,
    options: LanOptions,
    onPeer: (peer: LanPeer) => void,
  ) {
    this.#roomHex = roomHex;
    this.#deviceId = deviceId;
    this.#options = options;
    this.#onPeer = onPeer;
    this.#announcement = Buffer.from(
      JSON.stringify({ v: 1, room: roomHex, device: deviceId, port: tcpPort }),
    );
    this.#socket = createSocket({ type: 'udp4', reuseAddr: true });
  }

  start(): Promise<void> {
    const group = this.#options.group ?? DEFAULT_GROUP;
    return new Promise((resolve, reject) => {
      this.#socket.once('error', reject);
      this.#socket.on('message', (message, remote) => {
        this.#receive(message, remote.address);
      });
      this.#socket.bind(this.#options.discoveryPort, () => {
        this.#socket.addMembership(group, this.#options.interfaceAddress);
        if (this.#options.interfaceAddress !== undefined) {
          this.#socket.setMulticastInterface(this.#options.interfaceAddress);
        }
        this.#socket.setMulticastLoopback(true);
        this.#announce(group);
        this.#timer = setInterval(() => {
          this.#announce(group);
        }, this.#options.intervalMs ?? 1000);
        resolve();
      });
    });
  }

  stop(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    this.#socket.close();
  }

  #announce(group: string): void {
    this.#socket.send(this.#announcement, this.#options.discoveryPort, group);
  }

  #receive(message: Buffer, address: string): void {
    const peer = parseAnnouncement(message, this.#roomHex);
    if (peer === null || peer.deviceId === this.#deviceId) return;
    this.#onPeer({ ...peer, address });
  }
}

function parseAnnouncement(message: Buffer, roomHex: string): Omit<LanPeer, 'address'> | null {
  let value: unknown;
  try {
    value = JSON.parse(message.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const { v, room, device, port } = value as Record<string, unknown>;
  if (v !== 1 || room !== roomHex) return null;
  if (typeof device !== 'string' || !DEVICE_ID.test(device)) return null;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { deviceId: device, port };
}
