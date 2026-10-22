import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalRefusal, REPO_ROOT, deadlineIn, runtime, tcpProbe } from '../local-run.ts';

const rt = await runtime();
const tmp = (prefix: string) => mkdtemp(join(REPO_ROOT, '.tmp', prefix));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

function spawnFixture(name: string, args: string[]): { child: ChildProcess; line: Promise<string>; exited: Promise<number | null> } {
  const child = spawn(process.execPath, [fixture(name), ...args], { stdio: ['ignore', 'pipe', 'inherit'], env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } });
  const line = new Promise<string>((ok, ko) => {
    let buf = '';
    child.stdout!.on('data', (d) => {
      buf += String(d);
      if (buf.includes('\n')) ok(buf.split('\n')[0]!);
    });
    child.once('exit', (code) => ko(new Error(`fixture ${name} terminée (${code}) avant sa première ligne : ${buf}`)));
  });
  const exited = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
  return { child, line, exited };
}

test('exclusion entre deux processus : BUSY immédiat pour le second, reprise après la mort du détenteur, fichier de verrou jamais supprimé', { skip: 'retenu, fermeture à borner : ressource acquise avant une fermeture complète bornée sur chaque sortie ; ne vaut pas PASS' }, async () => {
  const root = await tmp('lock-');
  const holder = spawnFixture('holder.ts', [root]);
  assert.equal(await holder.line, 'held');
  assert.equal(rt.claimRoot(root), 'busy');
  assert.equal(rt.claimRoot(root), 'busy', 'le refus est répétable sans effet');
  holder.child.kill('SIGKILL');
  await holder.exited;
  const claim = rt.claimRoot(root);
  assert.notEqual(claim, 'busy', 'le verrou est libéré par le noyau à la mort du détenteur');
  const second = spawnFixture('holder.ts', [root]);
  await second.exited;
  assert.equal(await second.line, 'busy', 'un second processus reçoit BUSY pendant que ce processus détient le verrou');
  (claim as Exclude<typeof claim, 'busy'>).release();
  assert.ok(existsSync(rt.lockPathOf(root)), 'le fichier de verrou survit à la libération');
});

test('fichier de verrou corrompu : refus explicite, fichier intact, aucune reprise', async () => {
  const root = await tmp('corrupt-');
  const garbage = 'ceci n’est pas une base SQLite, juste des octets';
  await writeFile(rt.lockPathOf(root), garbage);
  assert.throws(() => rt.claimRoot(root), (e: Error) => e instanceof LocalRefusal && e.reason === 'lock_unreadable');
  assert.equal(await readFile(rt.lockPathOf(root), 'utf8'), garbage, 'octets conservés');
});

test('lancement contre une racine possédée : refusé avant tout effet, données du premier intactes', { skip: 'retenu, fermeture à borner : ressource acquise avant une fermeture complète bornée sur chaque sortie ; ne vaut pas PASS' }, async () => {
  const root = await tmp('occupied-');
  await writeFile(join(root, 'temoin.txt'), 'premier lancement');
  const holder = spawnFixture('holder.ts', [root]);
  assert.equal(await holder.line, 'held');
  await assert.rejects(rt.launchInstance({ root, name: 'occupied', ports: { service: 0, demo: 0 }, reset: true, deadline: deadlineIn(5_000) }), (e: Error) => e instanceof LocalRefusal && e.reason === 'occupied');
  assert.equal(await readFile(join(root, 'temoin.txt'), 'utf8'), 'premier lancement');
  assert.ok(!existsSync(join(root, 'worker.mjs')) && !existsSync(rt.recordPathOf(root)), 'aucun effet du lancement refusé');
  holder.child.kill('SIGTERM');
  await holder.exited;
});

test('cleanup demande l’arrêt par le contrôle privé, acquiert réellement l’exclusion puis supprime sous verrou', { skip: 'retenu, fermeture à borner : ressource acquise avant une fermeture complète bornée sur chaque sortie ; ne vaut pas PASS' }, async () => {
  const name = `bench-ctl-${crypto.randomUUID().slice(0, 8)}`;
  const root = rt.instanceRoot(name);
  const owner = spawnFixture('owner-witness.ts', [name, 'ready']);
  assert.match(await owner.line, /^ready \d+$/);
  const report = await rt.cleanupInstance(name, deadlineIn(10_000));
  assert.equal(report.kind, 'cleaned', JSON.stringify(report));
  assert.equal(await owner.exited, 0, 'le propriétaire s’est arrêté lui-même');
  assert.ok(!existsSync(root), 'racine supprimée');
  assert.ok(!existsSync(rt.recordPathOf(root)), 'enregistrement retiré après suppression');
  assert.ok(existsSync(rt.lockPathOf(root)), 'verrou conservé');
});

test('une nouvelle génération entre l’arrêt demandé et l’acquisition fait refuser la suppression', { skip: 'retenu, fermeture à borner : ressource acquise avant une fermeture complète bornée sur chaque sortie ; ne vaut pas PASS' }, async () => {
  const name = `bench-gen-${crypto.randomUUID().slice(0, 8)}`;
  const root = rt.instanceRoot(name);
  const owner = spawnFixture('owner-witness.ts', [name, 'swap-generation']);
  assert.match(await owner.line, /^ready \d+$/);
  const report = await rt.cleanupInstance(name, deadlineIn(10_000));
  assert.equal(report.kind, 'refused');
  assert.equal((report as { reason: string }).reason, 'generation_changed');
  assert.equal(await readFile(join(root, 'temoin.txt'), 'utf8'), 'données du propriétaire', 'rien n’est supprimé');
  await owner.exited;
  const again = await rt.cleanupInstance(name, deadlineIn(10_000));
  assert.equal(again.kind, 'cleaned', 'une fois l’enregistrement clos et le verrou libre, la suppression est possible');
});

async function bounded<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} : ${ms} ms dépassés`)), ms);
  });
  try {
    return await Promise.race([work, limit]);
  } finally {
    clearTimeout(timer);
  }
}

async function freePort(): Promise<number> {
  const probe = createTcpServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

test('SIGKILL du propriétaire avec une ressource consignée creating dont le témoin, créé et possédé par le banc, n’écoute qu’après la mort du propriétaire et après la sonde : refus conservateur, aucun signal du produit, racine conservée', { skip: 'retenu, fermeture à borner : ressource acquise avant une fermeture complète bornée sur chaque sortie ; ne vaut pas PASS' }, async () => {
  const name = `bench-kill-${crypto.randomUUID().slice(0, 8)}`;
  const root = rt.instanceRoot(name);
  const port = await freePort();
  const witness = spawn(process.execPath, [fixture('listener.ts'), String(port)], { stdio: ['pipe', 'pipe', 'inherit'], env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } });
  const witnessExited = new Promise<void>((r) => witness.once('exit', () => r()));
  let witnessOut = '';
  witness.stdout!.on('data', (d) => (witnessOut += String(d)));
  try {
    const owner = spawnFixture('owner-witness.ts', [name, 'late-child', String(port)]);
    assert.equal(await bounded(owner.line, 10_000, 'enregistrement du propriétaire témoin'), `creating ${port}`);
    owner.child.kill('SIGKILL');
    await bounded(owner.exited, 5_000, 'mort du propriétaire témoin');
    assert.equal(await tcpProbe(port), 'refused', 'le port de la ressource consignée est encore fermé à cet instant');
    const report = await rt.cleanupInstance(name, deadlineIn(5_000));
    assert.equal(report.kind, 'refused');
    assert.equal((report as { reason: string }).reason, 'uncertain_resources', JSON.stringify(report));
    assert.match((report as { detail: string }).detail, /aucun signal envoyé/);
    assert.ok(existsSync(join(root, 'temoin.txt')), 'racine conservée');
    await assert.rejects(rt.launchInstance({ root, name, ports: { service: 0, demo: 0 }, reset: true, deadline: deadlineIn(5_000) }), (e: Error) => e instanceof LocalRefusal && e.reason === 'uncertain_resources');
    assert.ok(existsSync(join(root, 'temoin.txt')), 'un lancement avec reset est lui aussi refusé sans toucher la racine');
    witness.stdin!.write('go\n');
    await bounded(new Promise<void>((r) => {
      const tick = () => (witnessOut.includes('listening') ? r() : setTimeout(tick, 20));
      tick();
    }), 5_000, 'écoute du témoin sur ordre du banc');
    assert.equal(await tcpProbe(port), 'listening', 'une ressource consignée creating peut encore se lier après la mort du propriétaire et après la sonde');
    const again = await rt.cleanupInstance(name, deadlineIn(5_000));
    assert.equal(again.kind, 'refused');
    assert.match((again as { detail: string }).detail, /listening/, 'le diagnostic montre le port désormais occupé');
    assert.ok(existsSync(join(root, 'temoin.txt')));
  } finally {
    witness.kill('SIGTERM');
    await bounded(witnessExited, 5_000, 'arrêt du témoin par son handle').catch(async () => {
      witness.kill('SIGKILL');
      await bounded(witnessExited, 5_000, 'arrêt forcé du témoin du banc');
    });
    assert.equal(await tcpProbe(port), 'refused', 'le témoin du banc est fermé par le banc');
    await rm(root, { recursive: true, force: true });
    await rm(rt.recordPathOf(root), { force: true });
  }
});

test('preuve de port : un témoin 503 ou muet occupe son port, seul ECONNREFUSED signifie libre', { skip: 'retenu, fermeture à borner : ressource acquise avant une fermeture complète bornée sur chaque sortie ; ne vaut pas PASS' }, async () => {
  const busy503 = createServer((_req, res) => res.writeHead(503).end());
  await new Promise<void>((r) => busy503.listen(0, '127.0.0.1', () => r()));
  const sockets = new Set<import('node:net').Socket>();
  const silent = createTcpServer((socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
  const p503 = (busy503.address() as { port: number }).port;
  const pSilent = (silent.address() as { port: number }).port;
  assert.equal(await tcpProbe(p503), 'listening');
  assert.equal(await tcpProbe(pSilent), 'listening');
  for (const s of sockets) s.destroy();
  await new Promise<void>((r) => silent.close(() => r()));
  busy503.closeAllConnections();
  await new Promise<void>((r) => busy503.close(() => r()));
  assert.equal(await tcpProbe(pSilent), 'refused');
});
