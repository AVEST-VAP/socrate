import { createServer } from 'node:net';
import { createInterface } from 'node:readline';

const port = Number(process.argv[2]);
const server = createServer((socket) => socket.end());
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
const orders = createInterface({ input: process.stdin });
orders.on('close', stop);
orders.once('line', () => server.listen(port, '127.0.0.1', () => console.log('listening')));
