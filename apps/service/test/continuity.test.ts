import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { manifestSchema, digestOf, type Json } from '@socrate/contract';
import { startBench, importDemo, demoManifest, call, openSession, sessionClient, key, PROJECT, REVIEW, ORIGIN, type Bench, type Client } from './helpers.ts';

const ORIGIN_B = 'http://127.0.0.1:8275';
const BEFORE_WORDINGS_DIGEST = '8874c089b204cef4a9b67d14c9f14ebe1b79f22cec6fe373a8aa3694546ea85f';
const base = `/v1/projects/${PROJECT}/reviews/${REVIEW}`;

let bench: Bench;
before(async () => { bench = await startBench(); });
after(async () => { await bench.stop(); });

const beforeWordings = async () => JSON.parse(await readFile(new URL('./fixtures/manifest-before-wordings.json', import.meta.url), 'utf8'));
const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode('image fictive A '.repeat(50))]);
const sha = createHash('sha256').update(bytes).digest('hex');

async function publishTargeted(c: Client) {
  const r = await call(c, 'POST', `${base}/targeted`, {
    kind: 'targeted', body: 'Le libellé du délai est ambigu sur A.',
    target: {
      url: `${ORIGIN}/reglages/rappels`, route: '/reglages/rappels', frame: [],
      rect: { x: 40, y: 120, width: 300, height: 24 },
      viewport: { width: 1280, height: 800, devicePixelRatio: 1, scrollX: 0, scrollY: 0 },
      role: 'label', text: 'Délai de rappel', selector: '[data-socrate-id="rappel-delai-a"]', html: '<label data-socrate-id="rappel-delai-a">Délai de rappel</label>',
    },
    image: { contentType: 'image/png', size: bytes.byteLength, sha256: sha, width: 1280, height: 800 },
  }, { 'Idempotency-Key': key() });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const put = await fetch(`${c.url}${base}/captures/${r.json.captureId}?attempt=${r.json.attempt}`, { method: 'PUT', headers: { Authorization: `Bearer ${c.token}`, Origin: c.origin!, 'Content-Type': 'image/png' }, body: bytes as BodyInit });
  assert.equal(put.status, 200);
  const done = await call(c, 'POST', `${base}/captures/${r.json.captureId}/commit`, { attempt: r.json.attempt });
  assert.equal(done.status, 201, JSON.stringify(done.json));
  return done.json;
}

test('un manifeste importé avant les repères garde sa forme canonique et son digest au rejeu', async () => {
  const old = await beforeWordings();
  const reparsed = manifestSchema.parse(old);
  assert.deepEqual(reparsed, old, 'aucun défaut injecté par les champs éditoriaux');
  assert.equal(await digestOf(reparsed as unknown as Json), BEFORE_WORDINGS_DIGEST);
  const first = await importDemo(bench, 'deploiement-a', {}, old);
  assert.equal(first.status, 201, JSON.stringify(first.json));
  assert.equal(first.json.revisionId, BEFORE_WORDINGS_DIGEST);
  const again = await importDemo(bench, 'deploiement-a', {}, old);
  assert.equal(again.status, 200);
  assert.equal(again.json.revisionId, BEFORE_WORDINGS_DIGEST);
});

test('A puis B : B rejoué converge, A révoqué est refusé, le fil de A reste lisible depuis B avec capture et révision d’origine', async () => {
  const claireA = await sessionClient(bench, { deploymentId: 'deploiement-a' });
  const targeted = await publishTargeted(claireA);
  const global = await call(claireA, 'POST', `${base}/threads`, { kind: 'global', body: 'Avis d’ensemble sur A.' }, { 'Idempotency-Key': key() });
  assert.equal(global.status, 201);

  const manifestB = await demoManifest();
  assert.ok(manifestB.zones.some((z) => z.markers?.length), 'B porte les nouveaux repères');
  const b = await importDemo(bench, 'deploiement-b', { commit: 'b2c3d4e5f6a7', buildId: '0043', url: `${ORIGIN_B}/` }, manifestB);
  assert.equal(b.status, 201, JSON.stringify(b.json));
  assert.notEqual(b.json.revisionId, BEFORE_WORDINGS_DIGEST);
  const replayB = await importDemo(bench, 'deploiement-b', { commit: 'b2c3d4e5f6a7', buildId: '0043', url: `${ORIGIN_B}/` }, manifestB);
  assert.equal(replayB.status, 200);
  const counts = await bench.service.db.prepare('SELECT (SELECT COUNT(*) FROM reviews) AS reviews, (SELECT COUNT(*) FROM deployments) AS deployments').first<any>();
  assert.deepEqual(counts, { reviews: 1, deployments: 2 }, 'aucune seconde revue');

  const ci: Client = { url: bench.service.url, token: bench.importToken };
  const bySession = await call(claireA, 'POST', `${base}/deployments/deploiement-a/revoke`);
  assert.equal(bySession.status, 403, 'une session de relecture ne révoque pas');
  const revoked = await call(ci, 'POST', `${base}/deployments/deploiement-a/revoke`);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.json));
  const revokedAgain = await call(ci, 'POST', `${base}/deployments/deploiement-a/revoke`);
  assert.equal(revokedAgain.json.revokedAt, revoked.json.revokedAt, 'révocation idempotente');

  const oldSession = await call(claireA, 'GET', `${base}/threads`);
  assert.equal(oldSession.status, 403, 'la session déjà ouverte sur A est refusée');
  assert.equal(oldSession.headers.get('Access-Control-Allow-Origin'), null, 'origine A retirée du CORS');
  const newA = await openSession(bench, { deploymentId: 'deploiement-a' });
  assert.equal(newA.status, 403);
  assert.equal(newA.json.code, 'origin_not_registered', 'nouvel accès à A refusé');
  const preflight = await fetch(`${bench.service.url}${base}/threads`, { method: 'OPTIONS', headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'GET' } });
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), null);

  const claireB = await sessionClient(bench, { deploymentId: 'deploiement-b', origin: ORIGIN_B });
  const list = await call(claireB, 'GET', `${base}/threads`);
  assert.equal(list.status, 200);
  assert.equal(list.headers.get('Access-Control-Allow-Origin'), ORIGIN_B);
  const fromA = list.json.items.filter((t: any) => t.deploymentId === 'deploiement-a');
  assert.equal(fromA.length, 2);
  for (const t of fromA) {
    assert.equal(t.state, 'open', 'aucun retour résolu par le redéploiement');
    assert.equal(t.revisionId, BEFORE_WORDINGS_DIGEST, 'révision d’origine conservée');
  }
  const t = fromA.find((x: any) => x.threadId === targeted.threadId);
  assert.equal(t.target.selector, '[data-socrate-id="rappel-delai-a"]');
  const image = await fetch(`${claireB.url}${base}/captures/${t.capture.captureId}`, { headers: { Authorization: `Bearer ${claireB.token}`, Origin: ORIGIN_B } });
  assert.equal(image.status, 200);
  assert.equal(createHash('sha256').update(new Uint8Array(await image.arrayBuffer())).digest('hex'), sha, 'capture de A lisible depuis B');
  const origin = await call(claireB, 'GET', `${base}/revisions/${BEFORE_WORDINGS_DIGEST}`);
  assert.equal(origin.status, 200);
  assert.deepEqual(origin.json.manifest, await beforeWordings(), 'explications de la révision d’origine');
  const current = await call(claireB, 'GET', `${base}/deployments/deploiement-b`);
  assert.equal(current.json.revision.revisionId, b.json.revisionId);
  const kept = await bench.service.db.prepare("SELECT (SELECT COUNT(*) FROM deployments WHERE deployment_id = 'deploiement-a') AS a, (SELECT COUNT(*) FROM revisions) AS revisions, (SELECT COUNT(*) FROM captures) AS captures").first<any>();
  assert.deepEqual(kept, { a: 1, revisions: 2, captures: 1 }, 'A, sa révision et sa capture ne sont pas supprimés');
});
