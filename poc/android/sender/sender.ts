// Laptop side of the Android probe: runs the relay from poc/sync on the home network and sends a
// numbered ping every few seconds into the probe's room. Usage: npm run sender [-- intervalSeconds]
import { connect } from 'node:net';
import { writeFrame } from '../../sync/src/framing.ts';
import { Relay } from '../../sync/src/relay.ts';

const PORT = 7400;
/** Shared with probe-core: 32 bytes, padded with zeros. */
const ROOM = Buffer.concat([Buffer.from('fhp-probe-room-v1'), Buffer.alloc(15)]);

const intervalSeconds = Number(process.argv[2] ?? '10');
if (!Number.isFinite(intervalSeconds) || intervalSeconds < 1) {
  throw new RangeError('interval must be at least 1 second');
}

const relay = new Relay({ host: '0.0.0.0', port: PORT });
const address = await relay.start();
console.log(`relay listening on ${address.host}:${address.port}`);

const socket = connect(PORT, '127.0.0.1');
await new Promise((resolve) => socket.once('connect', resolve));
writeFrame(socket, ROOM);

let seq = 0;
const timer = setInterval(() => {
  seq += 1;
  const sentAt = Date.now();
  writeFrame(socket, Buffer.from(JSON.stringify({ seq, sentAt })));
  console.log(`${new Date(sentAt).toLocaleTimeString('nl-BE')} ping ${seq}`);
}, intervalSeconds * 1000);

process.on('SIGINT', () => {
  clearInterval(timer);
  socket.destroy();
  void relay.stop().then(() => process.exit(0));
});
