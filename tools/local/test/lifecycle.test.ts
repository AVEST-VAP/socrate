import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createTcpServer } from 'node:net';
import { mkdir, mkdtemp, readFile, rename, rm, symlink } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalRefusal, REPO_ROOT, deadlineIn, runtime, tcpProbe } from '../local-run.ts';

const rt = await runtime();
const tmp = (prefix: string) => mkdtemp(join(REPO_ROOT, '.tmp', prefix));
const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
type Closer = () => Promise<void>;

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

async function closeHeld(held: Map<string, Closer>, note: (line: string) => void): Promise<void> {
  for (const [name, close] of [...held].reverse()) {
    await bounded(close(), 20_000, `fermeture indépendante de ${name}`).then(() => note(`banc : ${name} fermé ou déjà fermé`), (e: Error) => note(`banc : ${name} ${e.message}`));
  }
}

async function freePort(): Promise<number> {
  const probe = createTcpServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  return port;
}

async function cancelledAt(marker: string, root: string, name: string, ports: { service: number; demo: number }) {
  const cancel = new AbortController();
  const lines: string[] = [];
  const held = new Map<string, Closer>();
  try {
    const outcome = await bounded(rt.launchInstance({
      root, name, ports, reset: false, deadline: deadlineIn(60_000), cancel: cancel.signal,
      own: (resource, close) => held.set(resource, close),
      log: (line) => {
        lines.push(line);
        if (line === marker) cancel.abort();
      },
    }).then(() => 'ready' as const, (e: unknown) => e), 60_000, 'lancement annulé');
    return { outcome, lines };
  } finally {
    await closeHeld(held, (l) => lines.push(l));
  }
}

async function expectClosed(root: string, lines: string[]) {
  const record = await rt.readRecord(root);
  assert.ok(record && record !== 'unreadable');
  assert.equal(record.state, 'closed', JSON.stringify(record));
  assert.ok(Object.values(record.resources).every((r) => r.phase === 'closed'), `ressources closes : ${JSON.stringify(record.resources)}`);
  assert.ok(lines.includes('arrêt confirmé (annulation demandée)'), lines.join('\n'));
  const claim = rt.claimRoot(root);
  assert.notEqual(claim, 'busy', 'verrou libéré après la fermeture confirmée');
  (claim as Exclude<typeof claim, 'busy'>).release();
  return record;
}

test('annulation demandée à l’annonce « service : creating », avant la construction de Miniflare : le handle créé ensuite est possédé, disposé, consigné closed ; aucun hôte créé', async () => {
  const root = await tmp('cancel-service-');
  const service = await freePort();
  const { outcome, lines } = await cancelledAt('ressource service : creating', root, 'cancel-service', { service, demo: await freePort() });
  assert.ok(outcome instanceof LocalRefusal && outcome.reason === 'launch_cancelled', String(outcome));
  const record = await expectClosed(root, lines);
  assert.equal(record.resources.service?.phase, 'closed');
  assert.equal(record.resources.host, undefined, 'Vite n’est jamais créé après une annulation passée');
  assert.equal(await tcpProbe(service), 'refused', 'workerd disposé par le handle possédé');
  assert.ok(lines.indexOf('ressource service : creating') < lines.indexOf('ressource service : closed'));
});

test('annulation demandée à l’annonce « service : running », avant la transition vers l’hôte : aucun Vite créé, service disposé et consigné closed', async () => {
  const root = await tmp('cancel-transition-');
  const service = await freePort();
  const { outcome, lines } = await cancelledAt('ressource service : running', root, 'cancel-transition', { service, demo: await freePort() });
  assert.ok(outcome instanceof LocalRefusal && outcome.reason === 'launch_cancelled', String(outcome));
  const record = await expectClosed(root, lines);
  assert.equal(record.resources.host, undefined);
  assert.equal(await tcpProbe(service), 'refused');
  assert.ok(!lines.some((l) => /VITE|Local:/.test(l)), 'aucune sortie Vite');
});

test('annulation demandée à l’annonce « host : creating », avant le spawn de l’hôte : le processus Vite créé ensuite est possédé et arrêté, chaque ressource est close avant la libération', async () => {
  const root = await tmp('cancel-host-');
  const service = await freePort();
  const demo = await freePort();
  const { outcome, lines } = await cancelledAt('ressource host : creating', root, 'cancel-host', { service, demo });
  assert.ok(outcome instanceof LocalRefusal && outcome.reason === 'launch_cancelled', String(outcome));
  const record = await expectClosed(root, lines);
  assert.equal(record.resources.host?.phase, 'closed');
  assert.equal(record.resources.service?.phase, 'closed');
  assert.equal(record.resources.control, undefined);
  await bounded(new Promise<void>((r) => setTimeout(r, 300)), 1_000, 'pause');
  assert.equal(await tcpProbe(demo), 'refused', 'l’hôte ne se lie plus après son arrêt');
  assert.equal(await tcpProbe(service), 'refused');
});

for (const mode of ['headers', 'body'] as const) {
  const held = mode === 'headers' ? 'en-têtes jamais envoyés' : 'corps JSON jamais terminé';

  test(`annulation pendant une vraie attente HTTP retenue par l’hôte (${held}) : la demande atteint l’attente, l’hôte possédé est arrêté, chaque ressource est close, le banc détient chaque fermeture avant la panne`, async () => {
    const root = await tmp(`held-${mode}-cancel-`);
    const service = await freePort();
    const demo = await freePort();
    const cancel = new AbortController();
    const lines: string[] = [];
    const heldClosers = new Map<string, Closer>();
    let cancelledAt = 0;
    let finishedAt = 0;
    try {
      const outcome = await bounded(rt.launchInstance({
        root, name: `held-${mode}-cancel`, ports: { service, demo }, reset: false, deadline: deadlineIn(60_000), cancel: cancel.signal,
        hostCommand: [fixture('held-host.ts'), mode],
        own: (resource, close) => heldClosers.set(resource, close),
        log: (line) => {
          lines.push(line);
          if (line.includes(`GET /api/preview-context (${mode})`) && cancelledAt === 0) {
            assert.deepEqual([...heldClosers.keys()], ['service', 'host'], 'le banc détient les fermetures du service et de l’hôte avant la panne');
            cancelledAt = performance.now();
            cancel.abort();
          }
        },
      }).then(() => 'ready' as const, (e: unknown) => e), 60_000, 'lancement retenu');
      finishedAt = performance.now();
      assert.ok(outcome instanceof LocalRefusal && outcome.reason === 'launch_cancelled', String(outcome));
      assert.ok(cancelledAt > 0, 'la requête retenue a bien atteint le témoin');
      assert.ok(finishedAt - cancelledAt < 5_000, `l’annulation a interrompu l’attente retenue en ${Math.round(finishedAt - cancelledAt)} ms, sans attendre l’échéance de 60 s`);
      const record = await expectClosed(root, lines);
      assert.equal(record.resources.host?.phase, 'closed');
      assert.equal(record.resources.service?.phase, 'closed');
      assert.equal(record.resources.control, undefined, 'aucun contrôle créé après l’annulation');
      assert.equal(await tcpProbe(service), 'refused', 'workerd disposé');
      assert.equal(await tcpProbe(demo), 'refused', 'témoin hôte arrêté par le handle possédé');
    } finally {
      await closeHeld(heldClosers, (l) => lines.push(l));
    }
  });

  test(`échéance pendant une vraie attente HTTP retenue par l’hôte (${held}) : refus dans le délai, hôte et service clos, verrou libéré`, async () => {
    const root = await tmp(`held-${mode}-deadline-`);
    const service = await freePort();
    const demo = await freePort();
    const lines: string[] = [];
    const heldClosers = new Map<string, Closer>();
    const started = performance.now();
    try {
      const outcome = await bounded(rt.launchInstance({
        root, name: `held-${mode}-deadline`, ports: { service, demo }, reset: false, deadline: deadlineIn(6_000),
        hostCommand: [fixture('held-host.ts'), mode],
        own: (resource, close) => heldClosers.set(resource, close),
        log: (line) => lines.push(line),
      }).then(() => 'ready' as const, (e: unknown) => e), 60_000, 'lancement retenu');
      const elapsed = performance.now() - started;
      assert.ok(outcome instanceof LocalRefusal && outcome.reason === 'launch_failed', String(outcome));
      assert.match((outcome as Error).message, /n'a pas répondu avec l'instance|délai écoulé/);
      assert.ok(lines.some((l) => l.includes(`GET /api/preview-context (${mode})`)), `la requête retenue a atteint le témoin : ${lines.join('\n')}`);
      assert.ok(elapsed < 25_000, `échec en ${Math.round(elapsed)} ms`);
      const record = await rt.readRecord(root);
      assert.ok(record && record !== 'unreadable');
      assert.equal(record.state, 'closed', JSON.stringify(record));
      assert.ok(Object.values(record.resources).every((r) => r.phase === 'closed'));
      assert.equal(await tcpProbe(service), 'refused');
      assert.equal(await tcpProbe(demo), 'refused');
      const claim = rt.claimRoot(root);
      assert.notEqual(claim, 'busy');
      (claim as Exclude<typeof claim, 'busy'>).release();
    } finally {
      await closeHeld(heldClosers, (l) => lines.push(l));
    }
  });
}

test('fermeture du service en échec : arrêt non confirmé, phase running conservée, racine et refus de launch/cleanup, aucune clôture fictive', { skip: 'retenu, fermeture à borner : remplace mf.dispose par un rejet injecté sans fermeture indépendante du vrai service ; scénario technique supplémentaire, non exécuté par la commande standard ; ne vaut pas PASS' }, async () => {
  const name = `bench-dispose-${crypto.randomUUID().slice(0, 8)}`;
  const root = rt.instanceRoot(name);
  const lines: string[] = [];
  const heldClosers = new Map<string, Closer>();
  const handle = await rt.launchInstance({ root, name, ports: { service: await freePort(), demo: await freePort() }, reset: true, deadline: deadlineIn(60_000), log: (l) => lines.push(l), own: (r, c) => heldClosers.set(r, c) });
  const mf = handle.service.mf as { dispose(): Promise<void> };
  const realDispose = mf.dispose;
  mf.dispose = async () => { throw new Error('dispose injecté par le banc'); };
  try {
    const report = await bounded(handle.stop('fermeture en échec injectée'), 40_000, 'arrêt');
    assert.equal(report.confirmed, false);
    assert.match(report.detail, /arrêt non confirmé/);
    assert.match(report.detail, /service en phase running .* sans preuve de fermeture/);
    assert.match(report.detail, /dispose injecté par le banc/);
    const record = await rt.readRecord(root);
    assert.ok(record && record !== 'unreadable');
    assert.equal(record.state, 'failed');
    assert.equal(record.resources.service?.phase, 'running', 'la phase prudente est conservée');
    assert.equal(record.resources.host?.phase, 'closed');
    assert.equal(record.resources.control?.phase, 'closed');
    const cleanup = await rt.cleanupInstance(name, deadlineIn(5_000));
    assert.equal(cleanup.kind, 'refused');
    assert.equal((cleanup as { reason: string }).reason, 'uncertain_resources', JSON.stringify(cleanup));
    assert.ok(existsSync(join(root, 'worker.mjs')), 'racine conservée');
    await assert.rejects(rt.launchInstance({ root, name, ports: { service: 0, demo: 0 }, reset: true, deadline: deadlineIn(5_000) }), (e: Error) => e instanceof LocalRefusal && e.reason === 'uncertain_resources');
    assert.ok(existsSync(join(root, 'worker.mjs')), 'un lancement avec reset ne touche pas la racine');
  } finally {
    mf.dispose = realDispose;
    await bounded(mf.dispose(), 20_000, 'dispose réel du banc');
    await closeHeld(heldClosers, (l) => lines.push(l));
    await rm(root, { recursive: true, force: true });
    await rm(rt.recordPathOf(root), { force: true });
  }
});

test('erreur d’écriture de l’enregistrement pendant l’arrêt : les fermetures restantes continuent, le verrou est libéré, le résultat reste non confirmé et l’enregistrement prudent est conservé', async () => {
  const name = `bench-eio-${crypto.randomUUID().slice(0, 8)}`;
  const root = rt.instanceRoot(name);
  const recordPath = rt.recordPathOf(root);
  const lines: string[] = [];
  const heldClosers = new Map<string, Closer>();
  const demo = await freePort();
  const handle = await rt.launchInstance({ root, name, ports: { service: await freePort(), demo }, reset: true, deadline: deadlineIn(60_000), log: (l) => lines.push(l), own: (r, c) => heldClosers.set(r, c) });
  const prudent = await readFile(recordPath, 'utf8');
  const controlPort = handle.record.control!.port;
  let blocked = false;
  try {
    await rename(recordPath, `${recordPath}.banc`);
    await mkdir(recordPath);
    blocked = true;
    const report = await bounded(handle.stop('publication en échec injectée'), 40_000, 'arrêt');
    assert.equal(report.confirmed, false, report.detail);
    assert.match(report.detail, /arrêt non confirmé/);
    assert.match(report.detail, /fermeture de control non écrite/);
    assert.match(report.detail, /fermeture de host non écrite/);
    assert.match(report.detail, /fermeture de service non écrite/);
    assert.match(report.detail, /enregistrement final non publié/);
    assert.ok(!/non arrêté/.test(report.detail), `chaque fermeture a été menée : ${report.detail}`);
    assert.ok(lines.includes('ressource control : closed, confirmation non écrite (EISDIR: illegal operation on a directory, rename') || lines.some((l) => l.startsWith('ressource control : closed, confirmation non écrite')), lines.join('\n'));
    assert.equal(await tcpProbe(controlPort), 'refused', 'contrôle fermé malgré l’erreur de publication');
    assert.equal(await tcpProbe(demo), 'refused', 'hôte arrêté malgré l’erreur de publication');
    assert.equal(await tcpProbe(handle.service.port), 'refused', 'workerd disposé malgré l’erreur de publication');
    const claim = rt.claimRoot(root);
    assert.notEqual(claim, 'busy', 'le verrou est libéré à la fin de la durée de vie');
    (claim as Exclude<typeof claim, 'busy'>).release();
    assert.deepEqual(readdirSync(join(root, '..')).filter((f) => f.startsWith(`${name}.owner.json.`) && f.endsWith('.tmp')), [], 'aucun fichier temporaire d’écriture laissé');
    await rm(recordPath, { recursive: true });
    await rename(`${recordPath}.banc`, recordPath);
    blocked = false;
    assert.equal(await readFile(recordPath, 'utf8'), prudent, 'l’enregistrement sur disque est resté celui d’avant l’arrêt');
    const cleanup = await rt.cleanupInstance(name, deadlineIn(5_000));
    assert.equal(cleanup.kind, 'refused');
    assert.equal((cleanup as { reason: string }).reason, 'uncertain_resources', `l’enregistrement prudent fait refuser la suppression : ${JSON.stringify(cleanup)}`);
    assert.ok(existsSync(join(root, 'worker.mjs')), 'racine conservée');
  } finally {
    await closeHeld(heldClosers, (l) => lines.push(l));
    if (blocked) {
      await rm(recordPath, { recursive: true, force: true });
      await rename(`${recordPath}.banc`, recordPath).catch(() => undefined);
    }
    await rm(root, { recursive: true, force: true });
    await rm(recordPath, { force: true });
  }
});

test('refus après acquisition de l’exclusion : un enregistrement de possession en lien symbolique est refusé avant tout effet et l’exclusion est libérée pendant que l’appelant vit', { skip: 'retenu, fermeture à borner : ressource acquise avant une fermeture complète bornée sur chaque sortie ; ne vaut pas PASS' }, async () => {
  const bench = await tmp('claim-scope-');
  const elsewhere = join(bench, 'ailleurs');
  await mkdir(elsewhere);
  const root = join(bench, 'instance');
  await mkdir(root);
  await symlink(join(elsewhere, 'owner.json'), rt.recordPathOf(root));
  await assert.rejects(rt.launchInstance({ root, name: 'claim-scope', ports: { service: 0, demo: 0 }, reset: false, deadline: deadlineIn(5_000) }), (e: Error) => e instanceof LocalRefusal && e.reason === 'symlink' && /owner\.json/.test(e.message));
  assert.deepEqual(readdirSync(elsewhere), [], 'rien n’est lu ni écrit derrière le lien');
  assert.ok(!existsSync(join(root, 'worker.mjs')), 'aucune ressource créée');
  const probe = spawn(process.execPath, [fixture('holder.ts'), root], { stdio: ['ignore', 'pipe', 'inherit'], env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } });
  const exited = new Promise<number | null>((r) => probe.once('exit', (code) => r(code)));
  let out = '';
  probe.stdout!.on('data', (d) => (out += String(d)));
  try {
    await bounded(new Promise<void>((r) => {
      const tick = () => (out.includes('\n') ? r() : setTimeout(tick, 20));
      tick();
    }), 10_000, 'acquisition indépendante');
    assert.equal(out.trim(), 'held', 'un autre processus acquiert l’exclusion pendant que l’appelant refusé est encore vivant');
  } finally {
    probe.kill('SIGTERM');
    await bounded(exited, 5_000, 'fin du processus témoin').catch(() => probe.kill('SIGKILL'));
  }
});
