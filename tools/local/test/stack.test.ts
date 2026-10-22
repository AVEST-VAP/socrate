import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tokenHash } from '@socrate/contract';
import { LocalRefusal, REPO_ROOT, deadlineIn, portNumber, runtime, tcpProbe } from '../local-run.ts';

const rt = await runtime();
const tmp = (prefix: string) => mkdtemp(join(REPO_ROOT, '.tmp', prefix));
const claimOrThrow = (root: string) => {
  const c = rt.claimRoot(root);
  if (c === 'busy') throw new Error('racine occupée');
  return c;
};

test('provisionnement réconcilié sur hash, projet, libellé, capacités, validité et durée ; fichiers inversés et spécification changée réémis sans reset métier', { skip: 'retenu, fermeture à borner : ressource acquise avant une fermeture complète bornée sur chaque sortie ; ne vaut pas PASS' }, async () => {
  const root = await tmp('cred-');
  const claim = claimOrThrow(root);
  const service = await rt.startService({ root, projects: [{ projectId: 'demo', issuer: 'demo-host', publicJwk: (await rt.generateIssuerKeys()).publicJwk, attestableCapabilities: [] }] });
  const dir = join(root, 'credentials');
  const spec = () => ({ import: { projectId: 'demo', label: 'ci-demo', capabilities: ['deployment.import' as const] }, agent: { projectId: 'demo', label: 'agent-demo', capabilities: ['review.read' as const] } });
  await service.db.prepare("INSERT INTO reviews (project_id, review_key, state, created_at) VALUES ('demo', 'temoin', 'active', '2026-10-15T00:00:00Z')").run();
  const rows = async () => (await service.db.prepare('SELECT COUNT(*) AS n FROM technical_credentials').first<{ n: number }>())!.n;

  const first = await rt.reconcileCredentials(service.db, dir, spec());
  assert.ok(first.import!.renewed && first.agent!.renewed);
  assert.equal(await rows(), 2);
  const stable = await rt.reconcileCredentials(service.db, dir, spec());
  assert.ok(!stable.import!.renewed && !stable.agent!.renewed, 'des accès conformes ne sont pas réémis');
  const created = await service.db.prepare('SELECT created_at, expires_at FROM technical_credentials').all<{ created_at: string; expires_at: number }>();
  for (const r of created.results) assert.equal(r.expires_at - Math.floor(Date.parse(r.created_at) / 1000), 86_400, 'même instant pour created_at et expires_at');

  await rm(join(dir, 'agent.token'));
  const missing = await rt.reconcileCredentials(service.db, dir, spec());
  assert.ok(missing.agent!.renewed && !missing.import!.renewed, 'seul le fichier manquant est repris');
  assert.equal(await rows(), 3);

  await writeFile(join(dir, 'import.token'), 'contenu-partiel');
  const partial = await rt.reconcileCredentials(service.db, dir, spec());
  assert.ok(partial.import!.renewed && !partial.agent!.renewed, 'un fichier partiel est remplacé');

  const importToken = (await readFile(join(dir, 'import.token'), 'utf8')).trim();
  const agentToken = (await readFile(join(dir, 'agent.token'), 'utf8')).trim();
  await writeFile(join(dir, 'import.token'), agentToken);
  await writeFile(join(dir, 'agent.token'), importToken);
  const inverted = await rt.reconcileCredentials(service.db, dir, spec());
  assert.ok(inverted.import!.renewed && inverted.agent!.renewed, 'des fichiers inversés sont tous deux réémis');
  assert.match(inverted.import!.why!, /libellé|capacités/);

  const changed = spec();
  changed.agent.label = 'agent-demo-v2';
  const relabeled = await rt.reconcileCredentials(service.db, dir, changed);
  assert.ok(relabeled.agent!.renewed && !relabeled.import!.renewed, 'une spécification changée réémet seulement l’accès concerné');
  const ttl = await rt.reconcileCredentials(service.db, dir, { ...changed, import: { ...changed.import, ttlSeconds: 3_600 } });
  assert.ok(ttl.import!.renewed && !ttl.agent!.renewed, 'une durée attendue différente réémet l’accès');

  await service.db.prepare('UPDATE technical_credentials SET expires_at = 1 WHERE token_hash = ?').bind(await tokenHash(ttl.import!.token)).run();
  const expired = await rt.reconcileCredentials(service.db, dir, { ...changed, import: { ...changed.import, ttlSeconds: 3_600 } });
  assert.ok(expired.import!.renewed, 'un accès expiré en D1 est réémis');
  const stale = await fetch(`${service.url}/v1/projects/demo/reviews/temoin/threads`, { headers: { Authorization: `Bearer ${ttl.import!.token}` } });
  assert.equal(stale.status, 401, 'l’ancien accès expiré est refusé');
  const fresh = await fetch(`${service.url}/v1/projects/demo/reviews/temoin/threads`, { headers: { Authorization: `Bearer ${expired.agent!.token}` } });
  assert.equal(fresh.status, 200, 'le nouvel accès agent lit la revue');

  assert.deepEqual((await readdir(dir)).sort(), ['agent.token', 'import.token'], 'aucun fichier temporaire ne subsiste');
  const reviews = await service.db.prepare('SELECT COUNT(*) AS n FROM reviews').first<{ n: number }>();
  assert.equal(reviews!.n, 1, 'données métier intactes');
  await service.stop();
  claim.release();
});

test('un autre serveur sur le port de l’hôte ne donne jamais un faux prêt ; l’échec ferme chaque ressource créée et libère le verrou', { skip: 'retenu, fermeture à borner : ressource acquise avant une fermeture complète bornée sur chaque sortie ; ne vaut pas PASS' }, async () => {
  const foreign = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.url === '/api/preview-context' ? { instanceId: 'autre-instance' } : {}));
  });
  await new Promise<void>((r) => foreign.listen(0, '127.0.0.1', () => r()));
  const port = (foreign.address() as { port: number }).port;
  const root = await tmp('foreign-');
  const log: string[] = [];
  const started = Date.now();
  await assert.rejects(rt.launchInstance({ root, name: 'foreign', ports: { service: 0, demo: port }, reset: false, deadline: deadlineIn(30_000), log: (l) => log.push(l) }), (e: Error) => e instanceof LocalRefusal && /Vite s'est arrêté|n'a pas répondu avec l'instance/.test(e.message));
  assert.ok(Date.now() - started < 30_000, 'l’échec est détecté sans attendre l’échéance complète');
  const record = await rt.readRecord(root);
  assert.ok(record && record !== 'unreadable');
  assert.equal(record.state, 'closed', JSON.stringify(record));
  assert.ok(Object.values(record.resources).every((r) => r.phase === 'closed'), 'toutes les ressources créées sont closes');
  assert.equal(await tcpProbe(record.resources.service!.port), 'refused', 'le service créé pendant l’essai est arrêté');
  const claim = rt.claimRoot(root);
  assert.notEqual(claim, 'busy', 'le verrou est libéré après l’échec');
  (claim as Exclude<typeof claim, 'busy'>).release();
  assert.equal(await tcpProbe(port), 'listening', 'le serveur étranger n’a pas été arrêté');
  await new Promise<void>((r) => foreign.close(() => r()));
});

test('doctor : stockage absent ou remplacé rend un refus, l’instance lancée est saine, cleanup ordinaire supprime puis conserve le verrou', async () => {
  const name = `bench-doc-${crypto.randomUUID().slice(0, 8)}`;
  const root = rt.instanceRoot(name);
  const handle = await rt.launchInstance({ root, name, ports: { service: 0, demo: portNumber(process.env.SOCRATE_STORAGE_TEST_PORT ?? 5389, 'stockage') }, reset: true, deadline: deadlineIn(60_000) });
  try {
    const healthy = await rt.doctorInstance(name, deadlineIn(10_000));
    assert.equal(healthy.kind, 'healthy', JSON.stringify(healthy));
    const persist = handle.service.persistRoot;
    await rename(persist, `${persist}.deplace`);
    try {
      const absent = await rt.doctorInstance(name, deadlineIn(10_000));
      assert.equal(absent.kind, 'refused');
      assert.match((absent as { checks: Record<string, { ok: boolean; detail: string }> }).checks.persist!.detail, /ABSENT/);
      const { mkdir } = await import('node:fs/promises');
      await mkdir(persist);
      const replaced = await rt.doctorInstance(name, deadlineIn(10_000));
      assert.equal(replaced.kind, 'refused');
      assert.match((replaced as { checks: Record<string, { ok: boolean; detail: string }> }).checks.persist!.detail, /REMPLACÉ/);
      await rm(persist, { recursive: true });
    } finally {
      if (!existsSync(persist)) await rename(`${persist}.deplace`, persist);
    }
    assert.equal((await rt.doctorInstance(name, deadlineIn(10_000))).kind, 'healthy', 'stockage restauré');
  } finally {
    const stopped = await handle.stop('fin du test');
    assert.ok(stopped.confirmed, stopped.detail);
  }
  const cleaned = await rt.cleanupInstance(name, deadlineIn(10_000));
  assert.equal(cleaned.kind, 'cleaned', JSON.stringify(cleaned));
  assert.ok(!existsSync(root) && existsSync(rt.lockPathOf(root)));
});
