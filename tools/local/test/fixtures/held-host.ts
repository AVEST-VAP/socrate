import { createServer } from 'node:http';
import type { Socket } from 'node:net';

const mode = process.argv[2] === 'body' ? 'body' : 'headers';
const sockets = new Set<Socket>();
const server = createServer((req, res) => {
  console.log(`témoin retenu : ${req.method} ${req.url} (${mode})`);
  if (mode === 'body') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"instanceId":"');
  }
});
server.on('connection', (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});
server.listen(Number(process.env.SOCRATE_DEMO_PORT), '127.0.0.1', () => console.log(`témoin retenu : écoute (${mode})`));
process.on('SIGTERM', () => {
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
});
