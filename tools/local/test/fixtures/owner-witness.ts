import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import { instanceName, runtime } from '../../local-run.ts';

const rt = await runtime();
const name = instanceName(process.argv[2]);
const mode = process.argv[3] ?? 'ready';
const root = rt.instanceRoot(name);
const claim = rt.claimRoot(root);
if (claim === 'busy') {
  console.log('busy');
  process.exit(3);
}
const { mkdir } = await import('node:fs/promises');
await mkdir(root, { recursive: true });
await writeFile(`${root}/temoin.txt`, 'données du propriétaire');
const record: import('../../runtime.ts').OwnerRecord = {
  generation: crypto.randomUUID(), pid: process.pid, startedAt: new Date().toISOString(), state: 'starting', ports: { service: 0, demo: 0 }, instanceId: `witness-${name}`, resources: {},
};
const publish = () => writeFile(`${root}.owner.json`, JSON.stringify(record));

if (mode === 'late-child') {
  const port = Number(process.argv[4]);
  record.resources.host = { phase: 'creating', port };
  await publish();
  console.log(`creating ${port}`);
  setInterval(() => undefined, 1_000);
} else {
  const nonce = 'nonce-' + crypto.randomUUID();
  const control = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const parsed = JSON.parse(body || '{}');
      if (req.url !== '/stop' || parsed.nonce !== nonce || parsed.instanceId !== record.instanceId) {
        res.writeHead(403).end('{}');
        return;
      }
      res.writeHead(202).end('{"accepted":true}');
      setImmediate(async () => {
        await new Promise<void>((r) => control.close(() => r()));
        record.resources.control = { phase: 'closed', port: record.resources.control!.port };
        record.state = 'closed';
        if (mode === 'swap-generation') record.generation = crypto.randomUUID();
        await publish();
        claim.release();
        process.exit(0);
      });
    });
  });
  await new Promise<void>((r) => control.listen(0, '127.0.0.1', () => r()));
  const port = (control.address() as { port: number }).port;
  record.resources.control = { phase: 'running', port };
  record.control = { port, nonce };
  record.state = 'ready';
  await publish();
  console.log(`ready ${port}`);
}
