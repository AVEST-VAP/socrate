import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBench, importDemo, call, sessionClient, threadsPath, key, rt, ISSUER, PROJECT, REVIEW, ORIGIN, type Bench, type Client } from './helpers.ts';

const base = `/v1/projects/${PROJECT}/reviews/${REVIEW}`;
const devices = `/v1/projects/${PROJECT}/devices`;
const agents = `/v1/projects/${PROJECT}/agents`;

let bench: Bench;
let claire: Client;
let karim: Client;
let reader: Client;

before(async () => {
  bench = await startBench();
  assert.equal((await importDemo(bench, 'local-1')).status, 201);
  claire = await sessionClient(bench, { deploymentId: 'local-1' });
  karim = await sessionClient(bench, { deploymentId: 'local-1', sub: 'karim', name: 'Karim Benali', capabilities: ['thread.participate', 'thread.moderate'] });
  reader = { url: bench.service.url, token: bench.agentToken };
});
after(async () => { await bench.stop(); });

const tool = () => ({ url: bench.service.url });
const start = (agent = 'Claude', machine = 'poste-de-dev', projectId = PROJECT) => call(tool(), 'POST', '/v1/auth/device', { projectId, agent, machine });
const exchange = (deviceCode: string, origin?: string) => call({ url: bench.service.url, origin }, 'POST', '/v1/auth/device/token', { deviceCode });
const details = (c: Client, code: string) => call(c, 'GET', `${devices}/${encodeURIComponent(code)}`);
const decide = (c: Client, code: string, verdict: 'approve' | 'deny') => call(c, 'POST', `${devices}/${encodeURIComponent(code)}/${verdict}`);

/** Démarrage, approbation dans le panneau sous `who`, échange : le jeton délégué et sa réponse. */
async function login(who: Client, agent = 'Claude'): Promise<{ token: string; grant: any }> {
  const s = await start(agent);
  assert.equal(s.status, 201, JSON.stringify(s.json));
  assert.equal((await decide(who, s.json.userCode, 'approve')).status, 200);
  const g = await exchange(s.json.deviceCode);
  assert.equal(g.status, 200, JSON.stringify(g.json));
  return { token: g.json.accessToken, grant: g.json };
}
const agentClient = (token: string): Client => ({ url: bench.service.url, token });

async function thread(c: Client, body: string): Promise<string> {
  const r = await call(c, 'POST', threadsPath, { kind: 'global', body }, { 'Idempotency-Key': key() });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.threadId;
}
const resolve = (c: Client, threadId: string, body: unknown, k = key()) => call(c, 'POST', `${threadsPath}/${threadId}/resolve`, body, { 'Idempotency-Key': k });
const reopen = (c: Client, threadId: string, body: unknown, k = key()) => call(c, 'POST', `${threadsPath}/${threadId}/reopen`, body, { 'Idempotency-Key': k });
const reply = (c: Client, threadId: string, body: string, k = key()) => call(c, 'POST', `${threadsPath}/${threadId}/messages`, { body }, { 'Idempotency-Key': k });
const db = () => bench.service.db;

test('parcours complet : démarrage, détails, approbation, échange, puis lecture, réponse et résolution au nom de l’acteur réel', async () => {
  const s = await start('Claude', 'portable-de-karim');
  assert.equal(s.status, 201, JSON.stringify(s.json));
  assert.match(s.json.deviceCode, /^[A-Za-z0-9_-]{43}$/);
  assert.match(s.json.userCode, /^[BCDFGHJKMNPQRSTVWXZ2346789]{4}-[BCDFGHJKMNPQRSTVWXZ2346789]{4}$/);
  assert.deepEqual([s.json.expiresIn, s.json.interval], [600, 5]);
  const stored = await db().prepare('SELECT device_hash, user_code FROM device_authorizations WHERE user_code = ?').bind(s.json.userCode.replace('-', '')).first<{ device_hash: string }>();
  assert.ok(stored && stored.device_hash !== s.json.deviceCode && !JSON.stringify(stored).includes(s.json.deviceCode), 'seule l’empreinte du code est stockée');

  const pending = await exchange(s.json.deviceCode);
  assert.deepEqual([pending.status, pending.json.code, pending.json.retryable], [400, 'authorization_pending', true]);
  const fast = await exchange(s.json.deviceCode);
  assert.deepEqual([fast.status, fast.json.code, fast.json.retryable], [400, 'slow_down', true], 'scrutation avant l’intervalle');

  const d = await details(karim, s.json.userCode.toLowerCase().replace('-', ' '));
  assert.equal(d.status, 200, JSON.stringify(d.json));
  assert.deepEqual({ ...d.json, createdAt: undefined, expiresAt: undefined }, { userCode: s.json.userCode, projectId: PROJECT, agent: 'Claude', machine: 'portable-de-karim', createdAt: undefined, expiresAt: undefined });
  const approved = await decide(karim, s.json.userCode, 'approve');
  assert.deepEqual([approved.status, approved.json], [200, { state: 'approved' }]);

  const g = await exchange(s.json.deviceCode);
  assert.equal(g.status, 200, JSON.stringify(g.json));
  assert.equal(g.json.tokenType, 'Bearer');
  assert.match(g.json.accessToken, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(g.json.actor, { key: `${ISSUER}:karim`, displayName: 'Karim Benali' });
  assert.deepEqual(g.json.capabilities, ['review.read', 'thread.participate', 'thread.moderate']);
  const days = (Date.parse(g.json.expiresAt) - Date.now()) / 86_400_000;
  assert.ok(days > 29.9 && days <= 30, `expiration fixe à 30 jours (${days})`);
  const row = await db().prepare('SELECT token_hash FROM agent_tokens WHERE token_id = ?').bind(g.json.tokenId).first<{ token_hash: string }>();
  assert.ok(row && row.token_hash !== g.json.accessToken, 'jeton stocké haché');
  const again = await exchange(s.json.deviceCode);
  assert.deepEqual([again.status, again.json.code], [400, 'invalid_grant'], 'second échange refusé');

  const agent = agentClient(g.json.accessToken);
  const reviews = await call(agent, 'GET', `/v1/projects/${PROJECT}/reviews`);
  assert.equal(reviews.status, 200, 'lectures de l’API agent sur tout le projet');
  const threadId = await thread(claire, 'Le libellé du rappel est trop long.');
  const list = await call(agent, 'GET', `${threadsPath}?state=open`);
  assert.equal(list.status, 200);
  assert.ok(list.json.items.some((t: any) => t.threadId === threadId), 'liste paginée comme review.read');

  const k = key();
  const r = await reply(agent, threadId, 'Raccourci dans le commit suivant.', k);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual([r.json.author.displayName, r.json.via, r.json.transition, r.json.exploring], ['Karim Benali', 'Claude', null, null]);
  const replay = await reply(agent, threadId, 'Raccourci dans le commit suivant.', k);
  assert.deepEqual([replay.status, replay.json.messageId], [200, r.json.messageId], 'reprise idempotente');

  const res = await resolve(agent, threadId, { message: 'Corrigé.', commit: 'abc1234' });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  assert.deepEqual([res.json.body, res.json.via, res.json.transition], ['Corrigé.', 'Claude', { state: 'resolved', commit: 'abc1234', deploymentId: 'local-1' }]);
  const read = await call(agent, 'GET', `${threadsPath}/${threadId}`);
  assert.equal(read.json.state, 'resolved');
  assert.deepEqual(read.json.messages.map((m: any) => [m.via, m.transition?.state ?? null]), [[null, null], ['Claude', null], ['Claude', 'resolved']]);
  const seen = await call(claire, 'GET', threadsPath);
  const inPanel = seen.json.items.find((t: any) => t.threadId === threadId);
  assert.equal(inPanel.messages.at(-1).transition.commit, 'abc1234', 'la session lit les mêmes champs');
  assert.equal(await db().prepare("SELECT COUNT(*) AS n FROM changes WHERE thread_id = ? AND kind = 'thread.resolved'").bind(threadId).first('n'), 1, 'une entrée du journal dans le batch');

  const back = await reopen(agent, threadId, { message: 'Rouvert : régression vue en recette.' });
  assert.equal(back.status, 201, JSON.stringify(back.json));
  assert.deepEqual(back.json.transition, { state: 'open', commit: null, deploymentId: null });
});

test('la résolution enregistre le dernier déploiement non révoqué au moment de l’écriture', async () => {
  assert.equal((await importDemo(bench, 'local-2', { buildId: '0043' })).status, 201);
  assert.equal((await importDemo(bench, 'local-3', { buildId: '0044' })).status, 201);
  const revoked = await call({ url: bench.service.url, token: bench.importToken }, 'POST', `${base}/deployments/local-3/revoke`);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.json));
  const { token } = await login(karim);
  const threadId = await thread(karim, 'Contraste insuffisant.');
  const r = await resolve(agentClient(token), threadId, { message: 'Contraste relevé.' });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.deepEqual(r.json.transition, { state: 'resolved', commit: null, deploymentId: 'local-2' });
});

test('refus du panneau : exploration, code expiré, déjà décidé, autre projet, sans participation', async () => {
  const s = await start();
  const exploring = await sessionClient(bench, { deploymentId: 'local-1', exploring: { account: 'compte-client', organisation: null } });
  const e = await decide(exploring, s.json.userCode, 'approve');
  assert.deepEqual([e.status, e.json.code], [403, 'forbidden']);
  assert.match(e.json.message, /explorant un compte/);
  const guest = await sessionClient(bench, { deploymentId: 'local-1', sub: 'invite', name: 'Invité', capabilities: [] });
  assert.equal((await decide(guest, s.json.userCode, 'approve')).status, 403, 'rien à déléguer sans participation');

  assert.equal((await decide(claire, s.json.userCode, 'deny')).status, 200);
  const denied = await exchange(s.json.deviceCode);
  assert.deepEqual([denied.status, denied.json.code, denied.json.retryable], [400, 'access_denied', false]);
  const decided = await decide(karim, s.json.userCode, 'approve');
  assert.deepEqual([decided.status, decided.json.code], [409, 'state_conflict'], 'déjà décidé');
  assert.equal((await details(karim, s.json.userCode)).status, 409);

  const old = await start();
  await db().prepare('UPDATE device_authorizations SET expires_at = 1 WHERE user_code = ?').bind(old.json.userCode.replace('-', '')).run();
  assert.deepEqual([(await details(karim, old.json.userCode)).status, (await decide(karim, old.json.userCode, 'approve')).json.code], [410, 'expired_token']);
  assert.equal((await exchange(old.json.deviceCode)).json.code, 'expired_token');

  const elsewhere = await start('Codex', 'poste', 'autre');
  assert.equal(elsewhere.status, 201, JSON.stringify(elsewhere.json));
  const other = await decide(karim, elsewhere.json.userCode, 'approve');
  assert.deepEqual([other.status, other.json.code], [404, 'not_found'], 'code d’un autre projet introuvable depuis cette session');
  assert.equal((await start('Claude', 'poste', 'inconnu')).status, 404, 'projet inconnu au démarrage');
  for (const [agent, machine] of [['', 'poste'], ['x'.repeat(33), 'poste'], ['Claude', 'p'.repeat(65)], ['Cla\u0007ude', 'poste']]) {
    assert.equal((await start(agent, machine)).status, 422, `${JSON.stringify(agent)} / ${machine.length}`);
  }
});

test('force brute : cinq codes inconnus par acteur sur dix minutes, puis tout essai refusé', async () => {
  const temoin = await sessionClient(bench, { deploymentId: 'local-1', sub: 'temoin', name: 'Relectrice Témoin' });
  const s = await start();
  for (let i = 0; i < 5; i++) assert.equal((await details(temoin, `BBBB-BBB${'BCDFG'[i]}`)).status, 404);
  const blocked = await details(temoin, s.json.userCode);
  assert.deepEqual([blocked.status, blocked.json.code, blocked.json.retryable], [429, 'rate_limited', true], 'le bon code aussi, une fois le plafond atteint');
  assert.equal((await decide(temoin, s.json.userCode, 'approve')).status, 429);
  const renewed = await sessionClient(bench, { deploymentId: 'local-1', sub: 'temoin', name: 'Relectrice Témoin' });
  assert.equal((await details(renewed, s.json.userCode)).status, 429, 'une nouvelle session du même acteur ne remet pas le compteur à zéro');
  assert.equal((await details(karim, s.json.userCode)).status, 200, 'les autres acteurs ne sont pas bloqués');
});

test('force brute en parallèle : vingt codes inconnus simultanés, au plus cinq 404, les autres 429', async () => {
  const pressee = await sessionClient(bench, { deploymentId: 'local-1', sub: 'pressee', name: 'Relectrice Pressée' });
  const codes = Array.from({ length: 20 }, (_, i) => `CCCC-${'BCDFGHJKMN'[Math.floor(i / 10)]}${'BCDFGHJKMN'[i % 10]}CC`);
  const statuses = (await Promise.all(codes.map((code) => details(pressee, code)))).map((r) => r.status);
  assert.ok(statuses.every((s) => s === 404 || s === 429), statuses.join(','));
  assert.ok(statuses.filter((s) => s === 404).length <= 5, statuses.join(','));
  const attempts = (await db().prepare('SELECT COUNT(*) AS n FROM device_attempts WHERE actor_key = ?').bind(`${ISSUER}:pressee`).first<{ n: number }>())!.n;
  assert.equal(attempts, 5, 'un essai réservé par 404, aucun pour un 429');
});

test('plafond des codes en attente par projet', async () => {
  const pending = (await db().prepare("SELECT COUNT(*) AS n FROM device_authorizations WHERE project_id = 'autre' AND state = 'pending'").first<{ n: number }>())!.n;
  for (let i = pending; i < 20; i++) assert.equal((await start('Codex', `poste-${i}`, 'autre')).status, 201);
  const over = await start('Codex', 'poste-21', 'autre');
  assert.deepEqual([over.status, over.json.code], [429, 'rate_limited']);
  assert.equal((await start('Codex', 'poste', PROJECT)).status, 201, 'les autres projets restent ouverts');
});

test('refus du jeton délégué : Origin, création, pièces, état sans message, fil d’un autre sans modération', async () => {
  const { token, grant } = await login(claire);
  assert.deepEqual(grant.capabilities, ['review.read', 'thread.participate'], 'capacités de la session, sans modération');
  const agent = agentClient(token);
  const fromPage = await call({ ...agent, origin: ORIGIN }, 'GET', threadsPath);
  assert.deepEqual([fromPage.status, fromPage.json.code], [403, 'forbidden']);
  assert.match(fromPage.json.message, /page web/);
  assert.equal((await call({ url: bench.service.url, origin: ORIGIN }, 'POST', '/v1/auth/device', { projectId: PROJECT, agent: 'Claude', machine: 'x' })).status, 403);
  const s = await start();
  assert.equal((await exchange(s.json.deviceCode, ORIGIN)).status, 403, 'échange refusé depuis une page');

  const writes: Array<[string, string, string, unknown]> = [
    ['créer un fil', 'POST', threadsPath, { kind: 'global', body: 'Nouveau fil' }],
    ['proposer une formulation', 'POST', threadsPath, { kind: 'global', body: '', proposal: { wordingId: 'x', replacement: 'y', revisionId: '0'.repeat(64) } }],
    ['créer un fil ciblé', 'POST', `${base}/targeted`, {}],
    ['joindre une pièce', 'POST', `${base}/attachments`, { operation: 'message.create', attachments: [] }],
    ['archiver', 'POST', `${base}/archive`, {}],
    ['purger', 'POST', `/v1/projects/${PROJECT}/purge`, {}],
    ['importer', 'PUT', `${base}/deployments/agent-1`, {}],
  ];
  const threadsBefore = await db().prepare('SELECT COUNT(*) AS n FROM threads').first('n');
  for (const [what, method, path, body] of writes) {
    const r = await call(agent, method, path, body, { 'Idempotency-Key': key() });
    assert.deepEqual([r.status, r.json.code], [403, 'forbidden'], `${what} : ${JSON.stringify(r.json)}`);
  }
  assert.equal(await db().prepare('SELECT COUNT(*) AS n FROM threads').first('n'), threadsBefore, 'aucun fil créé');

  const mine = await thread(claire, 'Mon fil.');
  const withPiece = await call(agent, 'POST', `${threadsPath}/${mine}/messages`, { body: 'x', attachments: [{ name: 'a.png', contentType: 'image/png', size: 1, sha256: '0'.repeat(64) }] }, { 'Idempotency-Key': key() });
  assert.deepEqual([withPiece.status, withPiece.json.code], [403, 'forbidden'], 'réponse avec pièce');
  const state = await call(agent, 'PUT', `${threadsPath}/${mine}/state`, { state: 'resolved', expectedVersion: 0 }, { 'Idempotency-Key': key() });
  assert.equal(state.status, 403, 'changement d’état sans message');
  for (const body of [{}, { message: '' }, { message: '   ' }, { message: 'ok', commit: 'HEAD' }, { message: 'ok', commit: 'abc12' }, { message: 'ok', extra: 1 }]) {
    const r = await resolve(agent, mine, body);
    assert.deepEqual([r.status, r.json.code], [422, 'invalid_request'], JSON.stringify(body));
  }
  assert.equal((await call(agent, 'POST', `${threadsPath}/${mine}/resolve`, { message: 'ok' })).status, 422, 'clé d’idempotence requise');

  const hers = await resolve(agent, mine, { message: 'Fait.' });
  assert.equal(hers.status, 201, 'l’auteur résout le sien');
  assert.deepEqual([(await resolve(agent, mine, { message: 'Encore.' })).json.code], ['state_conflict'], 'déjà résolu');
  const others = await thread(karim, 'Fil de Karim.');
  const refused = await resolve(agent, others, { message: 'Fait.' });
  assert.deepEqual([refused.status, refused.json.code], [403, 'forbidden'], 'fil d’un autre sans thread.moderate');
  assert.equal((await db().prepare('SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?').bind(others).first('n')), 1, 'aucun message écrit');
});

test('révocation : panneau limité à l’acteur, logout par le jeton lui-même, effet à la requête suivante ; expiration', async () => {
  const a = await login(karim, 'Claude');
  const b = await login(karim, 'Codex');
  const c = await login(claire, 'Claude');
  const mine = await call(karim, 'GET', agents);
  assert.equal(mine.status, 200);
  assert.deepEqual(mine.json.items.slice(0, 2).map((x: any) => x.agent).sort(), ['Claude', 'Codex']);
  assert.ok(mine.json.items.every((x: any) => !('accessToken' in x) && !('token' in x)), 'aucun secret listé');
  assert.ok(!mine.json.items.some((x: any) => x.tokenId === c.grant.tokenId), 'seulement les agents de l’acteur courant');
  assert.ok(mine.json.items.find((x: any) => x.tokenId === a.grant.tokenId).lastUsedAt === null);
  await call(agentClient(a.token), 'GET', threadsPath);
  assert.ok((await call(karim, 'GET', agents)).json.items.find((x: any) => x.tokenId === a.grant.tokenId).lastUsedAt, 'dernière utilisation notée');

  assert.equal((await call(karim, 'POST', `${agents}/${c.grant.tokenId}/revoke`)).status, 404, 'le jeton d’un autre acteur');
  assert.equal((await call(agentClient(a.token), 'GET', agents)).status, 403, 'la liste exige une session');
  const revoked = await call(karim, 'POST', `${agents}/${a.grant.tokenId}/revoke`);
  assert.deepEqual([revoked.status, revoked.json.revoked], [200, true]);
  const after = await call(agentClient(a.token), 'GET', threadsPath);
  assert.deepEqual([after.status, after.json.code], [401, 'unauthenticated']);
  assert.ok(!(await call(karim, 'GET', agents)).json.items.some((x: any) => x.tokenId === a.grant.tokenId));

  const out = await call(agentClient(b.token), 'POST', '/v1/auth/agent/revoke');
  assert.deepEqual([out.status, out.json.tokenId], [200, b.grant.tokenId]);
  assert.equal((await call(agentClient(b.token), 'GET', threadsPath)).status, 401);
  assert.equal((await call(reader, 'POST', '/v1/auth/agent/revoke')).status, 403, 'un jeton technique ne passe pas par cette route');

  await db().prepare('UPDATE agent_tokens SET expires_at = 1 WHERE token_id = ?').bind(c.grant.tokenId).run();
  const expired = await call(agentClient(c.token), 'GET', threadsPath);
  assert.deepEqual([expired.status, expired.json.code], [401, 'unauthenticated']);
  assert.match(expired.json.message, /expiré/);
});

test('compatibilité : session navigateur, jeton review.read et formes existantes inchangés', async () => {
  const threadId = await thread(claire, 'Avis navigateur.');
  const r = await reply(claire, threadId, 'Réponse navigateur.');
  assert.equal(r.status, 201);
  assert.deepEqual([r.json.via, r.json.transition], [null, null]);
  const st = await call(claire, 'PUT', `${threadsPath}/${threadId}/state`, { state: 'resolved', expectedVersion: 0 }, { 'Idempotency-Key': key() });
  assert.deepEqual([st.status, st.json.state, st.json.version], [200, 'resolved', 1], 'changement d’état du client 0.1.0 sans message');
  const list = await call(reader, 'GET', `${threadsPath}?state=resolved`);
  assert.equal(list.status, 200);
  const t = list.json.items.find((x: any) => x.threadId === threadId);
  assert.deepEqual(Object.keys(t.messages[0]).sort(), ['attachments', 'author', 'body', 'createdAt', 'exploring', 'messageId', 'seq', 'threadId', 'transition', 'via'], 'deux champs ajoutés, aucun retiré');
  for (const [method, path, body] of [['POST', `${threadsPath}/${threadId}/messages`, { body: 'x' }], ['POST', `${threadsPath}/${threadId}/reopen`, { message: 'x' }]] as const) {
    assert.equal((await call(reader, method, path, body, { 'Idempotency-Key': key() })).status, 403, `${path} avec review.read`);
  }
  assert.equal((await call(reader, 'GET', agents)).status, 403);
});

test('politique recoupée à chaque usage : capacité retirée après l’approbation', async () => {
  const { token: moderator } = await login(karim);
  const { token: participant } = await login(claire);
  const victim = await thread(claire, 'Fil à modérer.');
  const projects = (attestable: string[]) => [
    { projectId: PROJECT, issuer: ISSUER, publicJwk: bench.keys.publicJwk, attestableCapabilities: attestable },
    { projectId: 'autre', issuer: 'autre-host', publicJwk: bench.otherKeys.publicJwk, attestableCapabilities: ['thread.participate'] },
  ] as Parameters<typeof rt.startService>[0]['projects'];
  await bench.stopService();
  let service = await rt.startService({ root: bench.root, projects: projects(['thread.participate']) });
  try {
    const m = await call({ url: service.url, token: moderator }, 'POST', `${threadsPath}/${victim}/resolve`, { message: 'Modération.' }, { 'Idempotency-Key': key() });
    assert.deepEqual([m.status, m.json.code], [403, 'forbidden'], 'thread.moderate retiré de la politique');
    assert.equal((await call({ url: service.url, token: moderator }, 'GET', threadsPath)).status, 200, 'lecture et participation conservées');
    await service.stop();
    service = await rt.startService({ root: bench.root, projects: projects([]) });
    const p = await call({ url: service.url, token: participant }, 'GET', threadsPath);
    assert.deepEqual([p.status, p.json.code], [403, 'forbidden'], 'sans participation attestable, plus rien, pas même la lecture');
  } finally {
    await service.stop();
    await bench.startService();
  }
});
