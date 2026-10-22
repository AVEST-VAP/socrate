import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { rt, startBench, importDemo, demoManifest, call, newRoot, PROJECT, REVIEW, ORIGIN, ISSUER, type Bench } from './helpers.ts';

let bench: Bench;
before(async () => { bench = await startBench(); });
after(async () => { await bench.stop(); });

const CLIENT_DIR = join(rt.REPO_ROOT, 'apps/service/dist/assets/client');

test('GET /v1/client donne l’entrée mount de ce build, nommée par empreinte, sans cache', async () => {
  const r = await call({ url: bench.service.url }, 'GET', '/v1/client');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const url = new URL(r.json.url);
  assert.equal(url.origin, bench.service.url);
  assert.match(url.pathname, /^\/client\/[A-Z0-9]{8}\.js$/);
  assert.ok((await readdir(CLIENT_DIR)).includes(url.pathname.slice('/client/'.length)), 'entrée présente dans les assets du build');
  const entry = await fetch(url);
  assert.equal(entry.status, 200);
  assert.match(entry.headers.get('content-type') ?? '', /javascript/);
  assert.match(await entry.text(), /createRoot|mount/);
});

test('fichiers client immuables, ouverts en CORS aux seules origines enregistrées', async () => {
  assert.equal((await importDemo(bench, 'local-1')).status < 300, true);
  const { json } = await call({ url: bench.service.url }, 'GET', '/v1/client');
  const files = (await readdir(CLIENT_DIR)).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 2, 'entrée et chunks à la demande');
  for (const path of [new URL(json.url).pathname, ...files.map((f) => `/client/${f}`)]) {
    const registered = await fetch(`${bench.service.url}${path}`, { headers: { Origin: ORIGIN } });
    await registered.arrayBuffer();
    assert.equal(registered.status, 200, path);
    assert.equal(registered.headers.get('access-control-allow-origin'), ORIGIN, path);
    assert.equal(registered.headers.get('cache-control'), 'public, max-age=31536000, immutable', path);
    assert.match(registered.headers.get('vary') ?? '', /Origin/, path);
    const foreign = await fetch(`${bench.service.url}${path}`, { headers: { Origin: 'http://localhost:5173' } });
    await foreign.arrayBuffer();
    assert.equal(foreign.status, 200, path);
    assert.equal(foreign.headers.get('access-control-allow-origin'), null, `${path} sans CORS pour une origine non enregistrée`);
  }
});

test('fichier client inconnu ou chemin hors de client/ : 404', async () => {
  for (const path of ['/client/inconnu.js', '/client/', '/client/a/b.js', '/worker.mjs', '/assets/client/x.js']) {
    const r = await call({ url: bench.service.url }, 'GET', path);
    assert.equal(r.status, 404, path);
  }
  const put = await call({ url: bench.service.url }, 'PUT', '/client/inconnu.js', {});
  assert.equal(put.status, 404);
});

test('origine : un accès d’import valide ne peut pas enregistrer une origine hors du motif du projet', async () => {
  const keys = await rt.generateIssuerKeys();
  const service = await rt.startService({ root: await newRoot('allowed-origin-'), projects: [{ projectId: PROJECT, issuer: ISSUER, publicJwk: keys.publicJwk, attestableCapabilities: ['thread.participate'], allowedOrigin: 'https://*.previews.test' }] });
  try {
    const token = await rt.provisionCredential(service.db, { projectId: PROJECT, label: 'ci-fuite', capabilities: ['deployment.import'] });
    const manifest = await demoManifest();
    const put = (id: string, url: string) => call({ url: service.url, token }, 'PUT', `/v1/projects/${PROJECT}/reviews/${REVIEW}/deployments/${id}`, { commit: 'a1b2c3d4e5f6', buildId: '1', url, manifest });
    assert.equal((await put('pr-1', 'https://pr-1.previews.test/')).status, 201);
    for (const [id, url] of [['pr-2', 'https://app.example.com/'], ['pr-3', 'https://pr-3.previews.test.evil.test/'], ['pr-4', 'https://a.b.previews.test/'], ['pr-5', 'http://pr-5.previews.test/']]) {
      const r = await put(id!, url!);
      assert.equal(r.status, 403, url);
      assert.equal(r.json.code, 'forbidden', url);
    }
    const origins = (await service.db.prepare('SELECT origin FROM deployments ORDER BY origin').all<{ origin: string }>()).results.map((r) => r.origin);
    assert.deepEqual(origins, ['https://pr-1.previews.test'], 'aucune origine refusée enregistrée, donc aucun CORS ni session possibles');
  } finally {
    await service.stop();
  }
});
