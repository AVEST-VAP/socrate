import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBench, importDemo, openSession, assertionFor, call, sessionClient, threadsPath, key, ORIGIN, PROJECT, REVIEW, type Bench } from './helpers.ts';

let bench: Bench;
before(async () => {
  bench = await startBench();
  const r = await importDemo(bench, 'local-1');
  assert.equal(r.status, 201, JSON.stringify(r.json));
});
after(async () => { await bench.stop(); });

test('une assertion valide ouvre une session sans compte Socrate', async () => {
  const r = await openSession(bench, { deploymentId: 'local-1' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.actor.displayName, 'Claire Morel');
  assert.deepEqual(r.json.capabilities, ['thread.participate']);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(r.headers.get('vary'), 'Origin');
});

test('assertion expirée, modifiée, autre clé, autre audience, autre projet refusées', async () => {
  const cases: Array<[string, () => string, string]> = [
    ['expirée', () => assertionFor(bench, { deploymentId: 'local-1', iat: Math.floor(Date.now() / 1000) - 200 }), 'expirée'],
    ['autre clé', () => assertionFor(bench, { deploymentId: 'local-1' }, bench.otherKeys.privateJwk), 'signature'],
    ['autre audience', () => assertionFor(bench, { deploymentId: 'local-1', audience: 'autre-service' }), 'audience'],
    ['autre projet', () => assertionFor(bench, { deploymentId: 'local-1', projectId: 'inconnu' }), 'projet'],
    ['validité trop longue', () => assertionFor(bench, { deploymentId: 'local-1', ttlSeconds: 3600 }), 'validité'],
  ];
  for (const [label, make, hint] of cases) {
    const r = await call({ url: bench.service.url, origin: ORIGIN }, 'POST', '/v1/auth/session', { assertion: make() });
    assert.equal(r.status, 401, `${label}: ${JSON.stringify(r.json)}`);
    assert.equal(r.json.code, 'assertion_invalid', label);
    assert.match(r.json.message, new RegExp(hint), label);
  }
  const good = assertionFor(bench, { deploymentId: 'local-1' });
  const [h, p, s] = good.split('.');
  const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
  payload.name = 'Quelqu’un d’autre';
  const tampered = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;
  const r = await call({ url: bench.service.url, origin: ORIGIN }, 'POST', '/v1/auth/session', { assertion: tampered });
  assert.equal(r.status, 401);
  assert.match(r.json.message, /signature/);
});

test('entrées JWT et chemins malformés : refus propre, jamais un 500 réessayable', async () => {
  const good = assertionFor(bench, { deploymentId: 'local-1' });
  const [h, p, s] = good.split('.');
  const nullHeader = Buffer.from('null').toString('base64url');
  const cases: Array<[string, string, RegExp]> = [
    ['signature hors base64url', `${h}.${p}.${s}*!`, /encodage/],
    ['signature de longueur impossible', `${h}.${p}.${s!.slice(0, s!.length - (s!.length % 4) + 1)}`, /encodage|signature/],
    ['en-tête null', `${nullHeader}.${p}.${s}`, /algorithme/],
    ['en-tête sans alg', `${Buffer.from('{"typ":"JWT"}').toString('base64url')}.${p}.${s}`, /algorithme/],
    ['alg none', `${Buffer.from('{"alg":"none"}').toString('base64url')}.${p}.${s}`, /algorithme/],
    ['charge non JSON', `${h}.${Buffer.from('pas du json').toString('base64url')}.${s}`, /encodage/],
    ['deux segments', `${h}.${p}`, /format/],
  ];
  for (const [label, token, hint] of cases) {
    const r = await call({ url: bench.service.url, origin: ORIGIN }, 'POST', '/v1/auth/session', { assertion: token });
    assert.equal(r.status, 401, `${label}: ${r.status} ${JSON.stringify(r.json)}`);
    assert.equal(r.json.code, 'assertion_invalid', label);
    assert.equal(r.json.retryable, false, label);
    assert.match(r.json.message, hint, label);
  }
  const c = await sessionClient(bench, { deploymentId: 'local-1' });
  for (const path of ['/v1/projects/%E0%A4%A/reviews/x/threads', '/v1/projects/demo/reviews/%zz/threads']) {
    const r = await call(c, 'GET', path);
    assert.equal(r.status, 404, path);
    assert.equal(r.json.code, 'not_found');
    assert.equal(r.json.retryable, false);
  }
});

test('une assertion rejouée est refusée après consommation', async () => {
  const assertion = assertionFor(bench, { deploymentId: 'local-1' });
  const first = await call({ url: bench.service.url, origin: ORIGIN }, 'POST', '/v1/auth/session', { assertion });
  assert.equal(first.status, 201);
  const second = await call({ url: bench.service.url, origin: ORIGIN }, 'POST', '/v1/auth/session', { assertion });
  assert.equal(second.status, 401);
  assert.equal(second.json.code, 'assertion_replayed');
});

test('origine non enregistrée refusée, y compris un domaine ressemblant', async () => {
  for (const origin of ['http://localhost:5173', 'http://127.0.0.1:5174', 'http://127.0.0.1.preview.test', 'https://127.0.0.1:5173']) {
    const r = await openSession(bench, { deploymentId: 'local-1', origin });
    assert.ok(r.status === 401 || r.status === 403, `${origin}: ${r.status}`);
    assert.equal(r.headers.get('access-control-allow-origin'), null, origin);
  }
  const claimsOk = assertionFor(bench, { deploymentId: 'local-1' });
  const mismatch = await call({ url: bench.service.url, origin: 'http://localhost:5173' }, 'POST', '/v1/auth/session', { assertion: claimsOk });
  assert.equal(mismatch.status, 401);
  assert.match(mismatch.json.message, /origine/);
  const noOrigin = await call({ url: bench.service.url }, 'POST', '/v1/auth/session', { assertion: assertionFor(bench, { deploymentId: 'local-1' }) });
  assert.equal(noOrigin.status, 403);
  assert.equal(noOrigin.json.code, 'origin_not_registered');
});

test('la session est liée à son origine exacte sur chaque requête', async () => {
  const c = await sessionClient(bench, { deploymentId: 'local-1' });
  const ok = await call(c, 'GET', threadsPath);
  assert.equal(ok.status, 200);
  const spoofed = await call({ ...c, origin: 'http://localhost:5173' }, 'GET', threadsPath);
  assert.equal(spoofed.status, 403);
  assert.equal(spoofed.json.code, 'origin_not_registered');
  const absent = await call({ url: c.url, token: c.token }, 'GET', threadsPath);
  assert.equal(absent.status, 403);
});

test('impersonation : acteur réel attribué, compte exploré enregistré à part', async () => {
  const c = await sessionClient(bench, { deploymentId: 'local-1', sub: 'karim', name: 'Karim Benali', exploring: { account: 'cabinet-dupont', organisation: 'Cabinet Dupont' } });
  assert.deepEqual(c.session.exploring, { account: 'cabinet-dupont', organisation: 'Cabinet Dupont' });
  const r = await call(c, 'POST', threadsPath, { kind: 'global', body: 'Vu depuis le compte du cabinet.' }, { 'Idempotency-Key': key() });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal(r.json.author.displayName, 'Karim Benali');
  assert.equal(r.json.author.key, 'demo-host:karim');
  assert.equal(r.json.messages[0].author.displayName, 'Karim Benali');
  assert.deepEqual(r.json.messages[0].exploring, { account: 'cabinet-dupont', organisation: 'Cabinet Dupont' });
});

test('auteur et date falsifiés dans la requête sont refusés', async () => {
  const c = await sessionClient(bench, { deploymentId: 'local-1' });
  const r = await call(c, 'POST', threadsPath, { kind: 'global', body: 'Bonjour', author: { displayName: 'Imposteur' }, createdAt: '2000-01-01T00:00:00Z' }, { 'Idempotency-Key': key() });
  assert.equal(r.status, 422);
  assert.equal(r.json.code, 'invalid_request');
  const ok = await call(c, 'POST', threadsPath, { kind: 'global', body: 'Bonjour' }, { 'Idempotency-Key': key() });
  assert.equal(ok.status, 201);
  assert.equal(ok.json.author.displayName, 'Claire Morel');
  assert.ok(Date.now() - Date.parse(ok.json.createdAt) < 10_000, 'date serveur récente');
});

test('les capacités attestées sont intersectées avec la politique du projet', async () => {
  const c = await sessionClient(bench, { deploymentId: 'local-1', capabilities: ['thread.participate', 'thread.moderate', 'deployment.import', 'review.read'] });
  assert.deepEqual(c.session.capabilities, ['thread.participate', 'thread.moderate']);
  const importAttempt = await call(c, 'PUT', `/v1/projects/${PROJECT}/reviews/${REVIEW}/deployments/local-99`, { commit: 'abcdef1', buildId: '1', url: `${ORIGIN}/`, manifest: {} });
  assert.equal(importAttempt.status, 403);
});

test('un accès d’import ne peut ni importer ailleurs ni écrire un message', async () => {
  const other = { url: bench.service.url, token: bench.otherProjectImportToken };
  const cross = await call(other, 'PUT', `/v1/projects/${PROJECT}/reviews/${REVIEW}/deployments/local-2`, { commit: 'abcdef1', buildId: '1', url: `${ORIGIN}/`, manifest: {} });
  assert.equal(cross.status, 403);
  const importer = { url: bench.service.url, token: bench.importToken };
  const write = await call(importer, 'POST', threadsPath, { kind: 'global', body: 'Pas autorisé' }, { 'Idempotency-Key': key() });
  assert.equal(write.status, 403);
  const read = await call(importer, 'GET', threadsPath);
  assert.equal(read.status, 403);
  const agent = { url: bench.service.url, token: bench.agentToken };
  const agentRead = await call(agent, 'GET', threadsPath);
  assert.equal(agentRead.status, 200);
  const agentWrite = await call(agent, 'POST', threadsPath, { kind: 'global', body: 'Pas autorisé' }, { 'Idempotency-Key': key() });
  assert.equal(agentWrite.status, 403);
});

test('la session expire et la session est opaque (hash stocké)', async () => {
  const c = await sessionClient(bench, { deploymentId: 'local-1' });
  const stored = await bench.service.db.prepare('SELECT token_hash FROM sessions').all<{ token_hash: string }>();
  assert.ok(stored.results.every((r) => r.token_hash !== c.token), 'aucun token en clair');
  await bench.service.db.prepare('UPDATE sessions SET expires_at = 1').run();
  const r = await call(c, 'GET', threadsPath);
  assert.equal(r.status, 401);
  assert.equal(r.json.code, 'session_expired');
});
