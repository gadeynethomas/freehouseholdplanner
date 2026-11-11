// A blind relay for sync over the internet (K3). It only sees a room id (a hash of the household key)
// and encrypted frames, and forwards every frame to the other devices in the same room.
import { createServer, type Server, type Socket } from 'node:net';
import { readFrames, writeFrame } from './framing.ts';
import type { RelayAddress } from './pairing.ts';

export const ROOM_ID_BYTES = 32;

export interface RelayOptions {
  host?: string;
  port?: number;
  /** Test hook: every forwarded frame, exactly as the relay sees it. */
  onForward?: (frame: Uint8Array) => void;
}

export class Relay {
  readonly #rooms = new Map<string, Set<Socket>>();
  readonly #server: Server;
  readonly #options: RelayOptions;

  constructor(options: RelayOptions = {}) {
    this.#options = options;
    this.#server = createServer((socket) => {
      this.#accept(socket);
    });
  }

  start(): Promise<RelayAddress> {
    const host = this.#options.host ?? '127.0.0.1';
    return new Promise((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen(this.#options.port ?? 0, host, () => {
        const address = this.#server.address();
        if (address === null || typeof address === 'string') {
          reject(new Error('no address'));
          return;
        }
        resolve({ host, port: address.port });
      });
    });
  }

  stop(): Promise<void> {
    for (const room of this.#rooms.values()) for (const socket of room) socket.destroy();
    this.#rooms.clear();
    return new Promise((resolve) =>
      this.#server.close(() => {
        resolve();
      }),
    );
  }

  #accept(socket: Socket): void {
    let room: Set<Socket> | null = null;
    socket.on('error', () => socket.destroy());
    socket.on('close', () => room?.delete(socket));
    readFrames(socket, (frame) => {
      if (room === null) {
        room = this.#join(socket, frame);
        return;
      }
      this.#forward(socket, room, frame);
    });
  }

  /** The first frame of a connection names the room. */
  #join(socket: Socket, frame: Uint8Array): Set<Socket> | null {
    if (frame.length !== ROOM_ID_BYTES) {
      socket.destroy();
      return null;
    }
    const roomKey = Buffer.from(frame).toString('hex');
    const room = this.#rooms.get(roomKey) ?? new Set<Socket>();
    this.#rooms.set(roomKey, room);
    room.add(socket);
    return room;
  }

  #forward(sender: Socket, room: Set<Socket>, frame: Uint8Array): void {
    this.#options.onForward?.(frame);
    for (const socket of room) if (socket !== sender) writeFrame(socket, frame);
  }
}
