import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, deadlineIn, localFetch, tcpProbe } from '../local-run.ts';
import { CaseFailure, withOwnedCase, type CaseReport, type End, type OwnedCase, type Witness } from './bench.ts';

const witness = fileURLToPath(new URL('./fixtures/bench-witness.cjs', import.meta.url));
const absentBinary = fileURLToPath(new URL('./fixtures/bench-absent.bin', import.meta.url));
const cjs = createRequire(import.meta.url)('node:child_process') as { spawn: typeof spawn };
const rawOptions = { stdio: ['ignore', 'pipe', 'inherit'] as ['ignore', 'pipe', 'inherit'], env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' } };
const exited: End = { code: 0, signal: null, error: null };
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const resources = (): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const r of process.getActiveResourcesInfo()) counts[r] = (counts[r] ?? 0) + 1;
  return counts;
};
const nothingLeft = async (before: Record<string, number>, kinds = ['Timeout', 'ProcessWrap', 'TCPServerWrap']) => {
  let after = resources();
  for (let turns = 0; turns < 20 && kinds.some((k) => (after[k] ?? 0) > (before[k] ?? 0)); turns += 1) {
    await turn();
    after = resources();
  }
  for (const kind of kinds) assert.ok((after[kind] ?? 0) <= (before[kind] ?? 0), `ressource ${kind} laissée dans le processus de test par le cas : ${JSON.stringify(after)} après ${JSON.stringify(before)}`);
};
const failureOf = (work: Promise<unknown>): Promise<CaseFailure> => work.then(
  () => assert.fail('le cas aurait dû échouer'),
  (e: unknown) => {
    assert.ok(e instanceof CaseFailure, String(e));
    return e;
  },
);
const firstOutput = (child: ChildProcess) => new Promise<void>((resolve) => child.stdout!.once('data', () => resolve()));
const within = <T>(work: Promise<T>, ms: number, label: string): Promise<T> => new Promise<T>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`${label} : ${ms} ms dépassés`)), ms);
  work.then((value) => { clearTimeout(timer); resolve(value); }, (e: unknown) => { clearTimeout(timer); reject(e); });
});
type Owned = { readonly child: ChildProcess; readonly kill: ChildProcess['kill']; readonly close: Promise<void>; closed: boolean };
const own = (held: Owned[], child: ChildProcess): ChildProcess => {
  const owned: Owned = { child, kill: child.kill.bind(child), closed: false, close: new Promise<void>((resolve) => child.once('close', () => { owned.closed = true; resolve(); })) };
  held.push(owned);
  return child;
};
let unknownEnd: string | null = null;
const requireKnownEnds = () => assert.equal(unknownEnd, null, `cas dépendant refusé : ${unknownEnd}`);
const killHeld = async (held: Owned[]) => {
  for (const { child, kill } of held) if (child.exitCode === null && child.signalCode === null) kill('SIGKILL');
  const results = await Promise.allSettled(held.map(({ child, close }) => within(close, 5_000, `pid ${child.pid}`)));
  const unknown = held.filter((_, i) => results[i]!.status === 'rejected').map(({ child }) => `pid ${child.pid} (exitCode ${child.exitCode}, signalCode ${child.signalCode})`);
  if (unknown.length) {
    unknownEnd = `finally indépendant : close non observé 5 000 ms après SIGKILL pour ${unknown.join(', ')}`;
    throw new Error(unknownEnd);
  }
};

test('passage normal : témoin, serveurs HTTP et TCP détenus avant écoute, résultat rendu, fins confirmées, racine supprimée', async (t) => {
  const before = resources();
  const dir = await mkdtemp(join(REPO_ROOT, '.tmp', 'bench-p0-'));
  let report: CaseReport | undefined;
  let w!: Witness;
  let ports: number[] = [];
  let live: Record<string, number> = {};
  const value = await withOwnedCase({ name: 'normal', report: (r) => (report = r) }, async (b) => {
    b.root(dir);
    w = b.child({ name: 'witness', argv: [witness, 'ready'] });
    assert.equal(await w.line(), 'ready');
    const http = b.http({ name: 'http', handle: (_req, res) => res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}') });
    const tcp = b.tcp({ name: 'tcp', connection: (socket) => socket.end() });
    assert.equal(http.port, 0, 'aucun port avant écoute');
    ports = [await http.listen(), await tcp.listen()];
    live = resources();
    assert.deepEqual((await localFetch(`http://127.0.0.1:${ports[0]}/ok`, deadlineIn(2_000))).json, { ok: true });
    assert.equal(await tcpProbe(ports[1]!), 'listening');
    return 42;
  });
  assert.equal(value, 42);
  assert.ok((live.ProcessWrap ?? 0) > (before.ProcessWrap ?? 0), `le compteur voit le témoin vivant : ${JSON.stringify(live)}`);
  assert.ok((live.TCPServerWrap ?? 0) >= (before.TCPServerWrap ?? 0) + 2, `le compteur voit les deux serveurs en écoute : ${JSON.stringify(live)}`);
  assert.ok(report?.confirmed, JSON.stringify(report));
  assert.deepEqual(report.acquisitions.map((a) => [a.name, a.kind, a.state]), [['root', 'root', 'closed'], ['witness', 'child', 'closed'], ['http', 'http', 'closed'], ['tcp', 'tcp', 'closed']]);
  assert.deepEqual(w.ended, exited, 'témoin terminé par SIGTERM de son handle');
  assert.deepEqual(w.events, ['exit code 0', 'close']);
  assert.equal(await tcpProbe(ports[0]!), 'refused');
  assert.equal(await tcpProbe(ports[1]!), 'refused');
  assert.ok(!existsSync(dir), 'racine supprimée après toutes les fins confirmées');
  await nothingLeft(before);
  t.diagnostic(`fins observées : ${JSON.stringify({ witness: w.events, report })}`);
});

test('assertion après création : erreur initiale rendue avec le rapport de fermeture, témoin et serveur clos', async () => {
  const before = resources();
  let w!: Witness;
  let port = 0;
  const failure = await failureOf(withOwnedCase({ name: 'assertion' }, async (b) => {
    w = b.child({ name: 'witness', argv: [witness, 'ready'] });
    assert.equal(await w.line(), 'ready');
    port = await b.http({ name: 'http', handle: (_req, res) => res.end() }).listen();
    assert.equal(1, 2, 'assertion injectée');
  }));
  assert.equal(failure.errors.length, 1);
  assert.match((failure.errors[0] as Error).message, /assertion injectée/);
  assert.match(failure.message, /assertion injectée/);
  assert.ok(failure.report.confirmed, JSON.stringify(failure.report));
  assert.deepEqual(w.ended, exited, 'témoin arrêté par le banc après l’assertion');
  assert.equal(await tcpProbe(port), 'refused');
  await nothingLeft(before);
});

test('première ligne absente : le lecteur borné rejette, le témoin muet est terminé par son handle, aucun timer ne reste', async () => {
  const before = resources();
  let w!: Witness;
  const failure = await failureOf(withOwnedCase({ name: 'silent' }, async (b) => {
    w = b.child({ name: 'silent', argv: [witness, 'silent'] });
    await w.line({ ms: 300 });
  }));
  assert.match((failure.errors[0] as Error).message, /première ligne du témoin silent : 300 ms dépassés/);
  assert.ok(failure.report.confirmed, JSON.stringify(failure.report));
  assert.ok(w.ended && (w.ended.code === 0 || w.ended.signal === 'SIGTERM'), `fin provoquée par le SIGTERM du handle, gestionnaire installé ou non : ${JSON.stringify(w.ended)}`);
  await nothingLeft(before);
});

for (const [mode, expected] of [['exit-early', /terminé \(code 3\)|sortie fermée \(EOF\)/], ['eof', /sortie fermée \(EOF\)/]] as const) {
  test(`${mode === 'eof' ? 'EOF' : 'sortie'} avant la première ligne : rejet sans attendre la borne, handle terminé`, async () => {
    const before = resources();
    const started = performance.now();
    let w!: Witness;
    const failure = await failureOf(withOwnedCase({ name: mode }, async (b) => {
      w = b.child({ name: mode, argv: [witness, mode] });
      await w.line({ ms: 10_000 });
    }));
    assert.match((failure.errors[0] as Error).message, expected);
    assert.ok(performance.now() - started < 5_000, 'le lecteur n’a pas attendu sa borne');
    assert.ok(failure.report.confirmed, JSON.stringify(failure.report));
    assert.deepEqual(w.ended, mode === 'eof' ? exited : { ...exited, code: 3 }, mode === 'eof' ? 'témoin vivant après EOF, terminé par le banc' : 'fin observée avant la fermeture');
    await nothingLeft(before);
  });
}

test('erreur d’écoute : le second serveur sur un port pris échoue, les deux handles sont clos, aucune attente ne reste', async () => {
  const before = resources();
  let taken = 0;
  const failure = await failureOf(withOwnedCase({ name: 'listen' }, async (b) => {
    taken = await b.tcp({ name: 'premier' }).listen();
    await b.tcp({ name: 'second' }).listen(taken);
  }));
  assert.equal((failure.errors[0] as NodeJS.ErrnoException).code, 'EADDRINUSE');
  assert.ok(failure.report.confirmed, JSON.stringify(failure.report));
  assert.equal(await tcpProbe(taken), 'refused');
  await nothingLeft(before);
});

for (const kind of ['tcp', 'http'] as const) {
  test(`écoute ${kind} pending : la fermeture invalide la demande, règle sa promesse, et l’écoute ne devient jamais active après closed (Server.close original détenu avant listen)`, async (t) => {
    const before = resources();
    const dir = await mkdtemp(join(REPO_ROOT, '.tmp', `bench-p0-pending-${kind}-`));
    const primary = new Error(`erreur initiale juste après la demande d’écoute ${kind}`);
    const events: string[] = [];
    let server!: import('node:net').Server;
    let originalClose!: (cb: (e?: Error) => void) => unknown;
    let requested!: Promise<number>;
    let report: CaseReport | undefined;
    try {
      const failure = await failureOf(withOwnedCase({ name: `pending-${kind}`, report: (r) => (report = r) }, async (b) => {
        b.root(dir);
        const listener = kind === 'tcp' ? b.tcp({ name: 'pending' }) : b.http({ name: 'pending', handle: (_req, res) => res.end() });
        server = listener.server;
        originalClose = server.close.bind(server);
        server.on('listening', () => events.push('listening'));
        server.on('close', () => events.push('close'));
        requested = listener.listen();
        requested.catch(() => undefined);
        assert.equal(server.listening, false, 'la demande est encore pending');
        throw primary;
      }));
      assert.equal(failure.errors[0], primary);
      assert.ok(report?.confirmed, JSON.stringify(report));
      assert.deepEqual(report.acquisitions.map((a) => `${a.name}:${a.state}`), ['root:closed', 'pending:closed']);
      assert.match(report.acquisitions[1]!.detail, /demande d’écoute pending invalidée avant liaison/);
      await assert.rejects(requested, /écoute de pending invalidée par la fermeture du cas/);
      await pause(50);
      assert.equal(server.listening, false, 'aucune écoute après la déclaration closed');
      assert.deepEqual(events, ['close'], 'aucun événement listening, un seul close');
      assert.ok(!existsSync(dir));
      await nothingLeft(before);
    } finally {
      let rescue = 'inutile, serveur sans écoute';
      if (server?.listening) rescue = await within(new Promise<string>((resolve) => originalClose((e) => resolve(e ? `erreur ${e.message}` : 'fermé'))), 5_000, 'secours Server.close original').catch((e: Error) => (unknownEnd = e.message));
      t.diagnostic(`événements du serveur ${kind} : ${JSON.stringify(events)} ; secours : ${rescue}`);
    }
  });
}

test('écoute hors durée de vie : un port invalide rejette sans laisser d’écouteur, une seconde demande est refusée, listen après la fin du cas est refusé sans effet', async () => {
  const before = resources();
  let bad!: ReturnType<OwnedCase['tcp']>;
  let good!: ReturnType<OwnedCase['tcp']>;
  let port = 0;
  await withOwnedCase({ name: 'listen-lifetime' }, async (b) => {
    bad = b.tcp({ name: 'invalide' });
    await assert.rejects(bad.listen(70_000), { code: 'ERR_SOCKET_BAD_PORT' });
    assert.equal(bad.server.listenerCount('listening') + bad.server.listenerCount('error'), 0, 'les écouteurs d’un échec synchrone sont retirés');
    good = b.tcp({ name: 'valide' });
    const first = good.listen();
    await assert.rejects(good.listen(), /écoute de valide refusée : une demande a déjà eu lieu \(pending\)/);
    port = await first;
    await assert.rejects(good.listen(), /une demande a déjà eu lieu \(listening\)/);
  });
  await assert.rejects(good.listen(), /écoute de valide refusée : hors de la durée de vie du cas/);
  await assert.rejects(bad.listen(), /hors de la durée de vie du cas/);
  await pause(20);
  assert.equal(good.server.listening, false);
  assert.equal(await tcpProbe(port), 'refused');
  await nothingLeft(before);
});

test('lecteur annulé : rejet immédiat sans timer résiduel, un lecteur laissé en suspens est annulé à la fermeture du cas', async () => {
  const before = resources();
  let dangling!: Promise<unknown>;
  await withOwnedCase({ name: 'cancel' }, async (b) => {
    const w = b.child({ name: 'silent', argv: [witness, 'silent'] });
    const cancel = new AbortController();
    const reading = w.line({ ms: 60_000, cancel: cancel.signal });
    cancel.abort(new Error('annulation du test'));
    await assert.rejects(reading, /première ligne du témoin silent : annulé \(annulation du test\)/);
    assert.ok((resources().Timeout ?? 0) <= (before.Timeout ?? 0), 'le timer de borne est retiré à l’annulation');
    dangling = w.until(() => false, { ms: 60_000 }).then(() => 'résolu', (e: unknown) => e);
  });
  const outcome = await dangling;
  assert.ok(outcome instanceof Error && /annulé \(cas cancel : fermeture du banc/.test(outcome.message), String(outcome));
  await nothingLeft(before);
});

test('prédicat until levant (chemin événementiel contrôlé) : l’exception devient le rejet du lecteur, depuis une arrivée stdout comme depuis une fin, et le watcher est retiré', async () => {
  const before = resources();
  const onData = new Error('prédicat levé sur données');
  const onEnd = new Error('prédicat levé sur notification de fin');
  let dataCalls = 0;
  let endCalls = 0;
  let afterRejection = 0;
  let w1!: Witness;
  await withOwnedCase({ name: 'predicate' }, async (b) => {
    w1 = b.child({ name: 'ready', argv: [witness, 'ready'] });
    const w2 = b.child({ name: 'early', argv: [witness, 'exit-early'] });
    const reader1 = w1.until((o) => {
      dataCalls += 1;
      if (o.includes('ready')) throw onData;
      return false;
    });
    const reader2 = w2.until(() => {
      endCalls += 1;
      if (endCalls > 1) throw onEnd;
      return false;
    });
    const rejections = Promise.all([assert.rejects(reader1, (e: unknown) => e === onData), assert.rejects(reader2, (e: unknown) => e === onEnd)]);
    await rejections;
    afterRejection = dataCalls;
    assert.equal(await w1.until((o) => o.includes('ready')), undefined, 'un autre lecteur du même témoin fonctionne encore');
  });
  assert.deepEqual(w1.ended, exited);
  assert.equal(dataCalls, afterRejection, 'le prédicat rejeté n’est plus appelé par les notifications suivantes');
  await nothingLeft(before);
});

test('publication levante : l’exception du callback report rejoint l’échec final avec l’erreur initiale et les erreurs de fermeture', async () => {
  const before = resources();
  const primary = new Error('erreur initiale injectée');
  const published = new Error('publication injectée');
  let w!: Witness;
  const failure = await failureOf(withOwnedCase({ name: 'publish', report: () => { throw published; } }, async (b) => {
    b.closer('pur-en-erreur', async () => {
      throw new Error('closer injecté');
    });
    w = b.child({ name: 'witness', argv: [witness, 'ready'] });
    assert.equal(await w.line(), 'ready');
    throw primary;
  }));
  assert.equal(failure.errors[0], primary);
  assert.equal(failure.errors.at(-1), published);
  assert.deepEqual(failure.errors.map((e) => (e as Error).message), ['erreur initiale injectée', 'pur-en-erreur#1 (closer) : closer injecté', 'publication injectée']);
  assert.match(failure.message, /erreur initiale injectée.*closer injecté.*publication : publication injectée/);
  assert.equal(failure.report.publication, 'publication injectée');
  assert.deepEqual(w.ended, exited);
  const confirmedButUnpublished = await failureOf(withOwnedCase({ name: 'publish-only', report: () => { throw published; } }, async () => undefined));
  assert.deepEqual(confirmedButUnpublished.errors, [published]);
  assert.equal(confirmedButUnpublished.report.confirmed, true);
  await nothingLeft(before);
});

test('deux témoins de même nom : la seconde occurrence s’ajoute sans remplacer la première, les deux sont terminés', async () => {
  let report: CaseReport | undefined;
  const ws: Witness[] = [];
  await withOwnedCase({ name: 'twice', report: (r) => (report = r) }, async (b) => {
    for (let i = 0; i < 2; i += 1) {
      const w = b.child({ name: 'holder', argv: [witness, 'ready'] });
      ws.push(w);
      assert.equal(await w.line(), 'ready');
    }
  });
  assert.deepEqual(report?.acquisitions.map((a) => `${a.name}#${a.seq}:${a.state}`), ['holder#1:closed', 'holder#2:closed']);
  assert.deepEqual(ws.map((w) => w.ended), [exited, exited]);
});

test('agrégation : erreur initiale, closer en erreur et closer hors borne visibles ensemble, le témoin réel est clos, la racine est conservée avec le motif exact', async () => {
  const dir = await mkdtemp(join(REPO_ROOT, '.tmp', 'bench-p0-kept-'));
  let w!: Witness;
  try {
    const failure = await failureOf(withOwnedCase({ name: 'aggregate', closeMs: 300 }, async (b) => {
      b.root(dir);
      b.closer('pur-en-erreur', async () => {
        throw new Error('closer injecté');
      });
      w = b.child({ name: 'witness', argv: [witness, 'ready'] });
      assert.equal(await w.line(), 'ready');
      b.closer('pur-sans-fin', () => new Promise<void>(() => undefined));
      throw new Error('erreur initiale injectée');
    }));
    assert.deepEqual(failure.errors.map((e) => (e as Error).message), ['erreur initiale injectée', 'root#1 (root) : racine conservée : pur-en-erreur#2 unconfirmed, pur-sans-fin#4 unconfirmed', 'pur-en-erreur#2 (closer) : closer injecté', 'pur-sans-fin#4 (closer) : fermeture de pur-sans-fin#4 : 300 ms dépassés']);
    assert.match(failure.message, /erreur initiale injectée.*closer injecté.*300 ms dépassés/);
    assert.equal(failure.report.confirmed, false);
    assert.deepEqual(w.ended, exited, 'le témoin entre les deux closers défaillants est clos');
    assert.deepEqual(failure.report.acquisitions.map((a) => `${a.name}:${a.state}`), ['root:kept', 'pur-en-erreur:unconfirmed', 'witness:closed', 'pur-sans-fin:unconfirmed']);
    assert.ok(existsSync(dir), 'racine conservée tant qu’une fin n’est pas confirmée');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('borne courte : après la borne le banc ne signale plus, ne réarme aucun timer et rapporte la fin inconnue ; le test ferme le témoin par son propre handle', async (t) => {
  const before = resources();
  const dir = await mkdtemp(join(REPO_ROOT, '.tmp', 'bench-p0-bound-'));
  const held: Owned[] = [];
  let w!: Witness;
  try {
    const failure = await failureOf(withOwnedCase({ name: 'bound', closeMs: 300 }, async (b) => {
      b.root(dir);
      w = b.child({ name: 'stubborn', argv: [witness, 'stubborn'] });
      own(held, w.child);
      assert.equal(await w.line(), 'stubborn');
    }));
    const [root, child] = failure.report.acquisitions;
    assert.equal(child!.state, 'unconfirmed');
    assert.match(child!.detail, /SIGTERM envoyé\(s\) par le handle, fin non observée avant la borne \(fermeture de stubborn#2 : 300 ms dépassés\) ; aucun autre signal/);
    assert.ok(child!.ms < 1_000, `fermeture réglée près de sa borne : ${child!.ms} ms`);
    assert.equal(root!.state, 'kept');
    assert.equal(root!.detail, 'racine conservée : stubborn#2 unconfirmed');
    assert.ok(existsSync(dir));
    await pause(150);
    assert.equal(w.ended, null, 'aucun SIGKILL envoyé après le rapport : le témoin obstiné vit encore');
    assert.equal(w.child.exitCode, null);
    await nothingLeft(before, ['Timeout']);
    t.diagnostic(`événements du témoin avant le secours du test : ${JSON.stringify(w.events)}`);
  } finally {
    try {
      await killHeld(held);
    } catch (e) {
      t.diagnostic(`racine conservée après secours inconnu : ${dir}`);
      throw e;
    }
    await rm(dir, { recursive: true, force: true });
  }
  assert.deepEqual(w.ended, { code: null, signal: 'SIGKILL', error: null });
  await nothingLeft(before);
});

test('racine : un composant remplacé par un lien symbolique après l’inscription est refusé à la suppression, la cible du lien est intacte', async () => {
  const outer = await mkdtemp(join(REPO_ROOT, '.tmp', 'bench-p0-link-'));
  const target = await mkdtemp(join(REPO_ROOT, '.tmp', 'bench-p0-link-target-'));
  writeFileSync(join(target, 'temoin.txt'), 'intact');
  try {
    const inner = join(outer, 'racine');
    mkdirSync(inner);
    const failure = await failureOf(withOwnedCase({ name: 'link' }, async (b) => {
      b.root(inner);
      renameSync(inner, join(outer, 'deplacee'));
      symlinkSync(target, inner);
    }));
    assert.equal(failure.report.acquisitions[0]!.state, 'unconfirmed');
    assert.match(failure.report.acquisitions[0]!.detail, /lien symbolique refusé/);
    assert.ok(existsSync(join(target, 'temoin.txt')), 'la cible du lien n’a pas été supprimée');
  } finally {
    await rm(outer, { recursive: true, force: true });
    await rm(target, { recursive: true, force: true });
  }
});

test('préflight de capture : CJS default.spawn et ESM nommé après syncBuiltinESMExports, handles conservés par le test avant toute assertion, seconde portée refusée avant effet, témoin du banc hors capture, originaux restaurés', async (t) => {
  requireKnownEnds();
  const before = resources();
  const originalSpawn = cjs.spawn;
  assert.equal(spawn, originalSpawn, 'avant la capture, le nommé ESM est l’original');
  const held: Owned[] = [];
  const ends: End[] = [];
  let events: string[][] = [];
  let bench!: Witness;
  try {
    await withOwnedCase({ name: 'capture-preflight' }, async (b) => {
      const capture = b.captureSpawns();
      const viaCjs = own(held, cjs.spawn(process.execPath, [witness, 'ready'], rawOptions));
      const viaEsm = own(held, spawn(process.execPath, [witness, 'ready'], rawOptions));
      bench = b.child({ name: 'bench', argv: [witness, 'ready'] });
      assert.equal(capture.original, originalSpawn);
      assert.notEqual(cjs.spawn, originalSpawn, 'default.spawn est remplacé pendant la portée');
      assert.equal(spawn, cjs.spawn, 'le nommé ESM suit le même remplacement');
      assert.equal(capture.seen().length, 2, 'le témoin du banc n’est pas observé par la capture');
      assert.equal(capture.seen()[0]!.child, viaCjs, 'handle CJS vu avant son retour');
      assert.equal(capture.seen()[1]!.child, viaEsm, 'handle ESM vu avant son retour');
      assert.deepEqual(capture.seen().map((s) => [...s.argv]), [[process.execPath, witness, 'ready'], [process.execPath, witness, 'ready']]);
      const patched = cjs.spawn;
      assert.throws(() => b.captureSpawns(), /déjà détenue par le cas capture-preflight/);
      assert.equal(cjs.spawn, patched, 'la seconde portée est refusée sans toucher la première');
      assert.equal(await bench.line(), 'ready');
      await b.wait(Promise.all(held.map((h) => firstOutput(h.child))), { label: 'première sortie des témoins bruts' });
      for (const { kill } of held) kill('SIGTERM');
      ends.push(...(await Promise.all(capture.seen().map((s) => b.wait(s.end)))));
      events = capture.seen().map((s) => [...s.events]);
    });
    assert.deepEqual(ends, [exited, exited]);
    assert.ok(events.every((e) => e[0] === 'exit code 0'), JSON.stringify(events));
    assert.deepEqual(bench.ended, exited, 'le témoin du banc est fermé par son propre closer');
    assert.equal(cjs.spawn, originalSpawn, 'default.spawn restauré après la fin de chaque processus observé');
    assert.equal(spawn, originalSpawn, 'nommé ESM restauré');
  } finally {
    await killHeld(held);
  }
  await nothingLeft(before);
  t.diagnostic(`fins observées par la capture : ${JSON.stringify({ ends, events })}`);
});

test('fins natives distinctes sous capture : un refus de création (ENOENT) est une fin, une AbortError de spawn est une erreur non terminale suivie de la fin native', async (t) => {
  requireKnownEnds();
  const before = resources();
  const held: Owned[] = [];
  let report: CaseReport | undefined;
  let refused: End | undefined;
  let refusedEvents: string[] = [];
  let aborted: End | undefined;
  let abortedEvents: string[] = [];
  let endedAtAbort: End | null | undefined;
  try {
    await withOwnedCase({ name: 'native-ends', report: (r) => (report = r) }, async (b) => {
      const capture = b.captureSpawns();
      own(held, cjs.spawn(absentBinary, [], rawOptions));
      refused = await b.wait(capture.seen()[0]!.end, { label: 'refus de création' });
      refusedEvents = [...capture.seen()[0]!.events];
      const controller = new AbortController();
      const alive = own(held, cjs.spawn(process.execPath, [witness, 'ready'], { ...rawOptions, signal: controller.signal }));
      const record = capture.seen()[1]!;
      await b.wait(firstOutput(alive), { label: 'première sortie du témoin abortable' });
      controller.abort();
      endedAtAbort = record.ended;
      abortedEvents = [...record.events];
      aborted = await b.wait(record.end, { label: 'fin native après abort' });
    });
    assert.ok(report?.confirmed, JSON.stringify(report));
    assert.equal(report.acquisitions[0]!.state, 'closed', 'aucun secours : le refus est une fin, l’abort a été suivi de sa fin native');
    assert.deepEqual(refused, { code: -2, signal: null, error: `spawn ${absentBinary} ENOENT` });
    assert.match(refusedEvents[0]!, /^création refusée spawn .* ENOENT$/);
    assert.equal(endedAtAbort, null, 'l’AbortError émise pendant abort ne vaut pas fin');
    assert.match(abortedEvents[0]!, /^erreur non terminale The operation was aborted/);
    assert.deepEqual(aborted, exited, 'la fin native suit : le témoin sort avec le code 0 sur SIGTERM');
    assert.equal(cjs.spawn, spawn);
  } finally {
    await killHeld(held);
  }
  await nothingLeft(before);
  t.diagnostic(`événements : ${JSON.stringify({ refusedEvents, abortedEvents })}`);
});

test('error simulé sur un témoin vivant (simulation explicite, pas un EPERM natif) : aucune fin annoncée, la fermeture ordinaire attend la fin native avant de supprimer la racine', async () => {
  const before = resources();
  const dir = await mkdtemp(join(REPO_ROOT, '.tmp', 'bench-p0-error-'));
  let report: CaseReport | undefined;
  let w!: Witness;
  let endedAfterError: End | null | undefined;
  try {
    await withOwnedCase({ name: 'simulated-error', report: (r) => (report = r) }, async (b) => {
      b.root(dir);
      w = b.child({ name: 'witness', argv: [witness, 'ready'] });
      assert.equal(await w.line(), 'ready');
      w.child.emit('error', Object.assign(new Error('EPERM simulé par le test'), { code: 'EPERM', syscall: 'kill' }));
      await turn();
      endedAfterError = w.ended;
    });
    assert.equal(endedAfterError, null, 'un error non terminal ne prouve pas exit');
    assert.ok(report?.confirmed, JSON.stringify(report));
    assert.match(report.acquisitions[1]!.detail, /terminé par SIGTERM du handle \(code 0\), flux fermés/);
    assert.deepEqual(w.events, ['erreur non terminale EPERM simulé par le test', 'exit code 0', 'close']);
    assert.ok(!existsSync(dir), 'racine supprimée seulement après la fin native');
    await nothingLeft(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('secours de la capture : un témoin laissé vivant est terminé par le handle brut, une création pendant le secours est refusée, la restauration suit la fin, le cas reste un échec avec le motif secours', async () => {
  requireKnownEnds();
  const before = resources();
  const originalSpawn = cjs.spawn;
  const held: Owned[] = [];
  let attempt: unknown = 'non tenté';
  let ended: End | undefined;
  try {
    const failure = await failureOf(withOwnedCase({ name: 'capture-rescue' }, async (b) => {
      const capture = b.captureSpawns();
      const alive = own(held, cjs.spawn(process.execPath, [witness, 'ready'], rawOptions));
      alive.once('exit', () => {
        try {
          own(held, cjs.spawn(process.execPath, ['-e', '0'], rawOptions));
          attempt = 'acceptée';
        } catch (e) {
          attempt = e;
        }
      });
      void capture.seen()[0]!.end.then((e) => (ended = e));
      await b.wait(firstOutput(alive), { label: 'première sortie du témoin brut' });
    }));
    assert.equal(failure.errors.length, 1);
    assert.match((failure.errors[0] as Error).message, /capture#1 \(capture\) : originaux restaurés après secours : secours pid \d+ : terminé par SIGTERM du handle \(code 0\), flux fermés/);
    assert.equal(failure.report.acquisitions[0]!.state, 'rescued');
    assert.ok(attempt instanceof Error && /refusée pendant la fermeture de la capture/.test(attempt.message), String(attempt));
    assert.deepEqual(ended, exited);
    assert.equal(cjs.spawn, originalSpawn, 'restauré après la fin observée');
    await withOwnedCase({ name: 'capture-again' }, async (b) => {
      b.captureSpawns();
    });
    assert.equal(cjs.spawn, originalSpawn);
  } finally {
    await killHeld(held);
  }
  await nothingLeft(before);
});

test('secours de plusieurs enfants simples dans une borne courte : SIGTERM et SIGKILL en parallèle par les handles, racine conservée après secours', async (t) => {
  requireKnownEnds();
  const before = resources();
  const dir = await mkdtemp(join(REPO_ROOT, '.tmp', 'bench-p0-rescue-'));
  const held: Owned[] = [];
  let seen: End[] = [];
  try {
    const failure = await failureOf(withOwnedCase({ name: 'capture-many', graceMs: 300, closeMs: 1_500 }, async (b) => {
      b.root(dir);
      const capture = b.captureSpawns();
      for (const mode of ['ready', 'stubborn', 'ready']) own(held, cjs.spawn(process.execPath, [witness, mode], rawOptions));
      await b.wait(Promise.all(held.map((h) => firstOutput(h.child))), { label: 'première sortie des trois témoins' });
      void Promise.all(capture.seen().map((s) => s.end)).then((ends) => (seen = ends));
    }));
    const [root, capture] = failure.report.acquisitions;
    assert.equal(capture!.state, 'rescued');
    assert.ok(capture!.ms < 1_500, `secours parallèle réglé dans la borne : ${capture!.ms} ms`);
    assert.match(capture!.detail, /SIGTERM du handle \(code 0\).*SIGTERM puis SIGKILL du handle \(signal SIGKILL\).*SIGTERM du handle \(code 0\)/s);
    assert.equal(root!.state, 'kept');
    assert.equal(root!.detail, 'racine conservée après secours de capture#2');
    assert.ok(existsSync(dir));
    assert.deepEqual(seen, [exited, { code: null, signal: 'SIGKILL', error: null }, exited]);
    assert.equal(cjs.spawn, spawn);
    t.diagnostic(`secours : ${capture!.detail}`);
  } finally {
    await killHeld(held);
    await rm(dir, { recursive: true, force: true });
  }
  await nothingLeft(before);
});

test('paire sous capture (régression observée indépendamment) : deux témoins ready déjà sortis, sans racine ni closer ordinaire ; le rapport P0 et la restauration ne précèdent le close natif d’aucun enfant, observé par le test dès la création', async (t) => {
  requireKnownEnds();
  const before = resources();
  const originalSpawn = cjs.spawn;
  const held: Owned[] = [];
  let report: CaseReport | undefined;
  let closedAtReport: boolean[] = [];
  let closedAtReturn: boolean[] = [];
  let spawnAtReport: typeof spawn | undefined;
  try {
    await withOwnedCase({ name: 'pair', report: (r) => { report = r; closedAtReport = held.map((h) => h.closed); spawnAtReport = cjs.spawn; } }, async (b) => {
      const capture = b.captureSpawns();
      for (let i = 0; i < 2; i += 1) own(held, cjs.spawn(process.execPath, [witness, 'ready'], rawOptions));
      await b.wait(Promise.all(held.map((h) => firstOutput(h.child))), { label: 'première sortie de la paire' });
      for (const { kill } of held) kill('SIGTERM');
      await b.wait(Promise.all(capture.seen().map((s) => s.end)), { label: 'exit de la paire' });
      closedAtReturn = held.map((h) => h.closed);
    });
    assert.ok(report?.confirmed, JSON.stringify(report));
    assert.deepEqual(report.acquisitions.map((a) => `${a.name}:${a.state}`), ['capture:closed']);
    assert.deepEqual(closedAtReport, [true, true], 'le rapport P0 ne précède le close natif d’aucun des deux enfants');
    assert.equal(spawnAtReport, originalSpawn, 'spawn restauré au rapport, donc après les deux close observés');
    assert.equal(cjs.spawn, originalSpawn);
  } finally {
    await killHeld(held);
  }
  await nothingLeft(before);
  t.diagnostic(`close déjà observés au retour du callback, avant la fermeture du banc : ${JSON.stringify(closedAtReturn)}`);
});

test('producteur inscrit avant la capture : son arrêt ordinaire termine son enfant d’abord, la capture est closed sans secours', async () => {
  requireKnownEnds();
  const before = resources();
  const originalSpawn = cjs.spawn;
  const held: Owned[] = [];
  let report: CaseReport | undefined;
  try {
    await withOwnedCase({ name: 'producer-first', report: (r) => (report = r) }, async (b) => {
      b.closer('producteur', async () => {
        for (const { child, kill, close } of held) {
          if (child.exitCode === null && child.signalCode === null) kill('SIGTERM');
          await close;
        }
        return `${held.length} enfant(s) terminé(s) par le producteur`;
      });
      b.captureSpawns();
      own(held, cjs.spawn(process.execPath, [witness, 'ready'], rawOptions));
      await b.wait(firstOutput(held[0]!.child), { label: 'première sortie de l’enfant du producteur' });
    });
    assert.ok(report?.confirmed, JSON.stringify(report));
    assert.deepEqual(report.acquisitions.map((a) => [a.name, a.kind, a.state]), [['producteur', 'closer', 'closed'], ['capture', 'capture', 'closed']]);
    assert.equal(report.acquisitions[0]!.detail, '1 enfant(s) terminé(s) par le producteur');
    assert.equal(report.acquisitions[1]!.detail, '1 processus observé(s), fins et close observés, originaux restaurés');
    assert.equal(cjs.spawn, originalSpawn);
  } finally {
    await killHeld(held);
  }
  await nothingLeft(before);
});

test('racines et budget (instrumentation locale déclarée : rm de node:fs/promises retardé par une attente pure, puis restauré) : le rm commencé est attribué inconnu sans attendre son règlement, la racine suivante ne commence pas, le rm en vol s’achève ensuite sans être prétendu annulé', async (t) => {
  const before = resources();
  const fsp = createRequire(import.meta.url)('node:fs/promises') as { rm: typeof rm };
  const originalRm = fsp.rm;
  const first = await mkdtemp(join(REPO_ROOT, '.tmp', 'bench-p0-slow-rm-a-'));
  const second = await mkdtemp(join(REPO_ROOT, '.tmp', 'bench-p0-slow-rm-b-'));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const started: string[] = [];
  const inFlight: Promise<void>[] = [];
  fsp.rm = ((path: Parameters<typeof rm>[0], options?: Parameters<typeof rm>[1]) => {
    started.push(String(path));
    const work = gate.then(() => originalRm(path, options));
    inFlight.push(work);
    return work;
  }) as typeof rm;
  syncBuiltinESMExports();
  let existsAtReport: boolean[] = [];
  try {
    assert.notEqual(rm, originalRm, 'le binding ESM nommé suit l’instrumentation, comme celui de bench.ts');
    const failure = await failureOf(withOwnedCase({ name: 'slow-root', closeMs: 200, report: () => (existsAtReport = [existsSync(first), existsSync(second)]) }, async (b) => {
      b.root(first, second);
    }));
    const [root] = failure.report.acquisitions;
    assert.equal(root!.state, 'unconfirmed');
    assert.equal(root!.detail, `racine ${first} : rm commencé, issue inconnue (fermeture de root#1 : 200 ms dépassés) ; supprimée(s) : aucune ; non commencée(s) : ${second}`);
    assert.ok(root!.ms < 1_000, `rapport réglé près de sa borne sans attendre le rm en vol : ${root!.ms} ms`);
    assert.deepEqual(started, [first], 'un seul rm commencé avant le rapport');
    assert.deepEqual(existsAtReport, [true, true], 'au rapport, le rm en vol n’a pas encore agi et la racine suivante est intacte');
    release();
    await Promise.all(inFlight);
    assert.deepEqual(started, [first], 'aucun rm commencé après le rapport');
    assert.ok(!existsSync(first), 'le rm commencé n’était pas annulé : il s’achève après le rapport');
    assert.ok(existsSync(second), 'la racine suivante n’a pas été touchée');
    t.diagnostic(`rm instrumentés : ${JSON.stringify(started)} ; racine : ${root!.detail}`);
  } finally {
    fsp.rm = originalRm;
    syncBuiltinESMExports();
    release();
    await Promise.allSettled(inFlight);
    await originalRm(first, { recursive: true, force: true });
    await originalRm(second, { recursive: true, force: true });
  }
  assert.equal(rm, originalRm, 'instrumentation restaurée');
  await nothingLeft(before);
});

test('acquisition après la fin du cas : refusée avant tout effet', async () => {
  const before = resources();
  let late!: OwnedCase;
  await withOwnedCase({ name: 'late' }, async (b) => {
    late = b;
  });
  assert.throws(() => late.child({ name: 'tard', argv: [witness, 'ready'] }), /n’accepte plus d’acquisition \(done\)/);
  assert.throws(() => late.tcp({ name: 'tard' }), /n’accepte plus d’acquisition/);
  assert.throws(() => late.captureSpawns(), /n’accepte plus d’acquisition/);
  await nothingLeft(before);
});

test('capture retenue (dernier cas) : un producteur à fin inconnue interdit la restauration, la cause est nommée, les cas dépendants sont refusés, le témoin du banc reste indépendant', async () => {
  requireKnownEnds();
  const dir = await mkdtemp(join(REPO_ROOT, '.tmp', 'bench-p0-retained-'));
  const originalSpawn = cjs.spawn;
  try {
    const failure = await failureOf(withOwnedCase({ name: 'retained', closeMs: 200 }, async (b) => {
      b.root(dir);
      b.closer('pur-sans-fin', () => new Promise<void>(() => undefined));
      b.captureSpawns();
    }));
    const [root, closer, capture] = failure.report.acquisitions;
    assert.equal(closer!.state, 'unconfirmed');
    assert.equal(capture!.state, 'retained');
    assert.equal(capture!.detail, 'capture retenue, originaux non restaurés : producteur(s) à fin inconnue : pur-sans-fin#2');
    assert.equal(root!.state, 'kept');
    assert.equal(root!.detail, 'racine conservée : pur-sans-fin#2 unconfirmed, capture#3 retained');
    assert.notEqual(cjs.spawn, originalSpawn, 'les originaux ne sont pas restaurés');
    assert.throws(() => cjs.spawn(process.execPath, ['-e', '0'], rawOptions), /refusée : capture retenue \(cas retained : producteur\(s\) à fin inconnue : pur-sans-fin#2\)/);
    await assert.rejects(withOwnedCase({ name: 'dependent' }, async (b) => {
      b.captureSpawns();
    }), (e: unknown) => e instanceof CaseFailure && /capture retenue, campagne arrêtée \(cas retained : producteur\(s\) à fin inconnue : pur-sans-fin#2\)/.test((e.errors[0] as Error).message));
    let w!: Witness;
    await withOwnedCase({ name: 'independent-witness' }, async (b) => {
      w = b.child({ name: 'bench', argv: [witness, 'ready'] });
      assert.equal(await w.line(), 'ready');
    });
    assert.deepEqual(w.ended, exited, 'le témoin du banc ne dépend pas de la capture retenue');
    assert.notEqual(cjs.spawn, originalSpawn, 'aucune reprise automatique tardive');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
