// Length-prefixed frames over a TCP stream: u32 big-endian length, then the bytes.
import type { Socket } from 'node:net';

export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

export class FrameTooLargeError extends Error {}

export function writeFrame(socket: Socket, frame: Uint8Array): void {
  if (frame.length > MAX_FRAME_BYTES)
    throw new FrameTooLargeError(`frame of ${frame.length} bytes`);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(frame.length);
  socket.write(Buffer.concat([header, frame]));
}

/** Feeds raw stream chunks in, calls `onFrame` per complete frame. Throws on an oversized frame. */
export class FrameReader {
  #buffer: Buffer = Buffer.alloc(0);
  readonly #onFrame: (frame: Uint8Array) => void;

  constructor(onFrame: (frame: Uint8Array) => void) {
    this.#onFrame = onFrame;
  }

  push(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (this.#buffer.length >= 4) {
      const length = this.#buffer.readUInt32BE(0);
      if (length > MAX_FRAME_BYTES) throw new FrameTooLargeError(`frame of ${length} bytes`);
      if (this.#buffer.length < 4 + length) return;
      const frame = new Uint8Array(this.#buffer.subarray(4, 4 + length));
      this.#buffer = this.#buffer.subarray(4 + length);
      this.#onFrame(frame);
    }
  }
}

/** Wires a socket to a frame handler; destroys the socket on a protocol violation. */
export function readFrames(socket: Socket, onFrame: (frame: Uint8Array) => void): void {
  const reader = new FrameReader(onFrame);
  socket.on('data', (chunk: Buffer) => {
    try {
      reader.push(chunk);
    } catch {
      socket.destroy();
    }
  });
}
