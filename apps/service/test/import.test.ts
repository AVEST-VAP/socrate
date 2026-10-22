import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rt, startBench, importDemo, demoManifest, call, sessionClient, PROJECT, REVIEW, ORIGIN, type Bench } from './helpers.ts';

let bench: Bench;
before(async () => { bench = await startBench(); });
after(async () => { await bench.stop(); });

test('import rejoué : ni seconde revue, ni seconde révision, ni second déploiement', async () => {
  const first = await importDemo(bench, 'local-1');
  assert.equal(first.status, 201, JSON.stringify(first.json));
  const again = await importDemo(bench, 'local-1');
  assert.equal(again.status, 200);
  assert.equal(again.json.revisionId, first.json.revisionId);
  const counts = await bench.service.db.prepare('SELECT (SELECT COUNT(*) FROM reviews) AS reviews, (SELECT COUNT(*) FROM revisions) AS revisions, (SELECT COUNT(*) FROM deployments) AS deployments').first<any>();
  assert.deepEqual(counts, { reviews: 1, revisions: 1, deployments: 1 });
});

test('deux déploiements du même commit partagent une révision identique', async () => {
  const a = await importDemo(bench, 'local-1');
  const b = await importDemo(bench, 'local-2', { buildId: '0043' });
  assert.equal(b.status, 201);
  assert.equal(b.json.revisionId, a.json.revisionId);
  const counts = await bench.service.db.prepare('SELECT (SELECT COUNT(*) FROM revisions) AS revisions, (SELECT COUNT(*) FROM deployments) AS deployments').first<any>();
  assert.deepEqual(counts, { revisions: 1, deployments: 2 });
});

test('même identifiant de déploiement avec une charge différente : 409 immutable_deployment', async () => {
  const r = await importDemo(bench, 'local-1', { buildId: '0099' });
  assert.equal(r.status, 409);
  assert.equal(r.json.code, 'immutable_deployment');
  const m = await demoManifest();
  const r2 = await importDemo(bench, 'local-1', {}, { ...m, title: 'Titre changé' });
  assert.equal(r2.status, 409);
});

test('un manifeste invalide est refusé avec des erreurs localisées', async () => {
  const m = await demoManifest();
  const bad = { ...m, title: '', zones: [{ ...m.zones[0], route: 'https://ailleurs.test/x' }, { ...m.zones[1], id: m.zones[0]!.id, extra: true }] };
  const r = await importDemo(bench, 'local-3', {}, bad);
  assert.equal(r.status, 422);
  assert.equal(r.json.code, 'invalid_manifest');
  const paths = r.json.issues.map((i: any) => i.path);
  assert.ok(paths.includes('manifest.title'), paths.join(','));
  assert.ok(paths.includes('manifest.zones.0.route'), paths.join(','));
  assert.ok(paths.includes('manifest.zones.1.extra'), paths.join(','));
  assert.equal(await bench.service.db.prepare("SELECT COUNT(*) AS n FROM deployments WHERE deployment_id = 'local-3'").first<any>().then((r) => r.n), 0);
});

test('le navigateur charge la révision précise de son déploiement', async () => {
  const m = await demoManifest();
  const r = await importDemo(bench, 'local-4', { commit: 'ffffff1' }, { ...m, now: 'Version suivante du maintenant.' });
  assert.equal(r.status, 201);
  const c1 = await sessionClient(bench, { deploymentId: 'local-1' });
  const d1 = await call(c1, 'GET', `/v1/projects/${PROJECT}/reviews/${REVIEW}/deployments/local-1`);
  assert.equal(d1.status, 200);
  assert.equal(d1.json.revision.manifest.now, m.now);
  const c4 = await sessionClient(bench, { deploymentId: 'local-4' });
  const d4 = await call(c4, 'GET', `/v1/projects/${PROJECT}/reviews/${REVIEW}/deployments/local-4`);
  assert.equal(d4.json.revision.manifest.now, 'Version suivante du maintenant.');
  assert.notEqual(d4.json.revision.revisionId, d1.json.revision.revisionId);
  const foreign = await call(c1, 'GET', `/v1/projects/${PROJECT}/reviews/autre-revue/deployments/local-1`);
  assert.equal(foreign.status, 403);
  assert.equal(ORIGIN, d1.json.deployment.origin);
});

test('la frontière outboundService refuse réellement une sortie émise par un Worker du banc, sans DNS ni réseau', async () => {
  const egress: { url: string; method: string }[] = [];
  const mf = rt.startMiniflare(rt.miniflareOptions({ scriptPath: fileURLToPath(new URL('../../../tools/local/test/fixtures/egress-worker.mjs', import.meta.url)), persistRoot: join(bench.root, 'egress-persist'), port: 0, bindings: {}, egress }));
  try {
    await mf.ready;
    const res = await mf.dispatchFetch('http://127.0.0.1/?to=http://example.invalid/sortie');
    assert.equal(await res.text(), '403', 'le Worker reçoit le refus de la frontière');
    const second = await mf.dispatchFetch('http://127.0.0.1/?to=http://192.0.2.1/test-net');
    assert.equal(await second.text(), '403');
    assert.deepEqual(egress.map((e) => e.url), ['http://example.invalid/sortie', 'http://192.0.2.1/test-net'], 'chaque tentative est interceptée par la frontière');
  } finally {
    await mf.dispose();
  }
  assert.equal(bench.service.egress.length, 0, 'le Worker du produit n’a émis aucune sortie pendant la suite');
});
