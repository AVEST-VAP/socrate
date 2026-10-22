import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startBench, importDemo, call, sessionClient, threadsPath, key, type Bench } from './helpers.ts';

let bench: Bench;
before(async () => {
  bench = await startBench();
  assert.equal((await importDemo(bench, 'local-1')).status, 201);
});
after(async () => { await bench.stop(); });

const claire = () => sessionClient(bench, { deploymentId: 'local-1' });
const karim = () => sessionClient(bench, { deploymentId: 'local-1', sub: 'karim', name: 'Karim Benali', capabilities: ['thread.participate', 'thread.moderate'] });
const invite = () => sessionClient(bench, { deploymentId: 'local-1', sub: 'invite', name: 'Invité Sans Droit', capabilities: [] });

test('publier, répondre, résoudre, rouvrir ; une réponse appartient au retour', async () => {
  const c = await claire();
  const created = await call(c, 'POST', threadsPath, { kind: 'global', body: 'Le délai de 24 h me paraît court.' }, { 'Idempotency-Key': key() });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const threadId = created.json.threadId;
  assert.equal(created.json.state, 'open');
  assert.equal(created.json.messages.length, 1);

  const reply = await call(c, 'POST', `${threadsPath}/${threadId}/messages`, { body: 'Je précise : 48 h serait mieux.' }, { 'Idempotency-Key': key() });
  assert.equal(reply.status, 201, JSON.stringify(reply.json));
  assert.equal(reply.json.seq, 2);
  const list = await call(c, 'GET', threadsPath);
  assert.equal(list.json.items.length, 1, 'une réponse ne crée pas de nouveau retour');
  assert.equal(list.json.items[0].messages.length, 2);

  const resolved = await call(c, 'PUT', `${threadsPath}/${threadId}/state`, { state: 'resolved', expectedVersion: 0 }, { 'Idempotency-Key': key() });
  assert.equal(resolved.status, 200, JSON.stringify(resolved.json));
  assert.equal(resolved.json.state, 'resolved');
  assert.equal(resolved.json.version, 1);
  const reopened = await call(c, 'PUT', `${threadsPath}/${threadId}/state`, { state: 'open', expectedVersion: 1 }, { 'Idempotency-Key': key() });
  assert.equal(reopened.json.state, 'open');
  assert.equal(reopened.json.version, 2);

  const k = await karim();
  const devResolved = await call(k, 'PUT', `${threadsPath}/${threadId}/state`, { state: 'resolved', expectedVersion: 2 }, { 'Idempotency-Key': key() });
  assert.equal(devResolved.status, 200, 'le développeur résout');
  const devReopened = await call(k, 'PUT', `${threadsPath}/${threadId}/state`, { state: 'open', expectedVersion: 3 }, { 'Idempotency-Key': key() });
  assert.equal(devReopened.status, 200, 'le développeur rouvre');

  const other = await sessionClient(bench, { deploymentId: 'local-1', sub: 'lea', name: 'Léa Petit' });
  const denied = await call(other, 'PUT', `${threadsPath}/${threadId}/state`, { state: 'resolved', expectedVersion: 4 }, { 'Idempotency-Key': key() });
  assert.equal(denied.status, 403);
  const i = await invite();
  const noCap = await call(i, 'POST', threadsPath, { kind: 'global', body: 'Je n’ai pas la capacité.' }, { 'Idempotency-Key': key() });
  assert.equal(noCap.status, 403);

  const stale = await call(c, 'PUT', `${threadsPath}/${threadId}/state`, { state: 'resolved', expectedVersion: 1 }, { 'Idempotency-Key': key() });
  assert.equal(stale.status, 412);
  assert.equal(stale.json.code, 'state_conflict');
  const satisfiedKey = key();
  const already = await call(c, 'PUT', `${threadsPath}/${threadId}/state`, { state: 'open', expectedVersion: 4 }, { 'Idempotency-Key': satisfiedKey });
  assert.equal(already.status, 200, 'intention déjà réalisée');
  const changes = await bench.service.db.prepare('SELECT COUNT(*) AS n FROM changes WHERE thread_id = ?').bind(threadId).first<any>();
  assert.equal(changes.n, 6, 'création, réponse, quatre changements d’état, aucun événement pour l’intention déjà réalisée');
  const satisfiedOp = await bench.service.db.prepare("SELECT result FROM operations WHERE idempotency_key = ? AND kind = 'thread.state'").bind(satisfiedKey).first<any>();
  assert.ok(satisfiedOp, 'l’intention déjà réalisée enregistre sa clé');
  const replayed = await call(c, 'PUT', `${threadsPath}/${threadId}/state`, { state: 'open', expectedVersion: 4 }, { 'Idempotency-Key': satisfiedKey });
  assert.deepEqual(replayed.json, already.json, 'le rejeu renvoie le résultat enregistré');
  const conflict = await call(c, 'PUT', `${threadsPath}/${threadId}/state`, { state: 'resolved', expectedVersion: 4 }, { 'Idempotency-Key': satisfiedKey });
  assert.equal(conflict.status, 409, 'même clé, autre charge');
});

test('le rejeu d’un changement d’état renvoie le résultat enregistré, pas l’état courant', async () => {
  const c = await claire();
  const created = await call(c, 'POST', threadsPath, { kind: 'global', body: 'Rejeu d’état.' }, { 'Idempotency-Key': key() });
  const threadId = created.json.threadId;
  const k = key();
  const resolved = await call(c, 'PUT', `${threadsPath}/${threadId}/state`, { state: 'resolved', expectedVersion: 0 }, { 'Idempotency-Key': k });
  assert.equal(resolved.json.version, 1);
  const reopened = await call(c, 'PUT', `${threadsPath}/${threadId}/state`, { state: 'open', expectedVersion: 1 }, { 'Idempotency-Key': key() });
  assert.equal(reopened.json.version, 2);
  const replay = await call(c, 'PUT', `${threadsPath}/${threadId}/state`, { state: 'resolved', expectedVersion: 0 }, { 'Idempotency-Key': k });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.json, resolved.json, 'résultat enregistré (résolu, version 1) alors que le fil est rouvert en version 2');
  const createReplay = await call(c, 'POST', threadsPath, { kind: 'global', body: 'Rejeu d’état.' }, { 'Idempotency-Key': key() });
  assert.equal(createReplay.status, 201, 'une autre clé crée un autre retour');
});

test('même clé sur deux fils en concurrence : une opération enregistrée, l’autre en conflit, le second fil intact', async () => {
  const c = await claire();
  const [t1, t2] = await Promise.all([
    call(c, 'POST', threadsPath, { kind: 'global', body: 'Fil un.' }, { 'Idempotency-Key': key() }),
    call(c, 'POST', threadsPath, { kind: 'global', body: 'Fil deux.' }, { 'Idempotency-Key': key() }),
  ]);
  const k = key();
  const [r1, r2] = await Promise.all([
    call(c, 'PUT', `${threadsPath}/${t1.json.threadId}/state`, { state: 'resolved', expectedVersion: 0 }, { 'Idempotency-Key': k }),
    call(c, 'PUT', `${threadsPath}/${t2.json.threadId}/state`, { state: 'resolved', expectedVersion: 0 }, { 'Idempotency-Key': k }),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409], JSON.stringify([r1.json, r2.json]));
  const winner = r1.status === 200 ? t1 : t2;
  const loser = r1.status === 200 ? t2 : t1;
  const w = await call(c, 'GET', `${threadsPath}/${winner.json.threadId}`);
  const l = await call(c, 'GET', `${threadsPath}/${loser.json.threadId}`);
  assert.equal(w.json.state, 'resolved');
  assert.equal(l.json.state, 'open', 'le fil perdant n’a pas été modifié');
  assert.equal(l.json.version, 0);
  const ops = await bench.service.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE idempotency_key = ?").bind(k).first<any>();
  assert.equal(ops.n, 1);
  const events = await bench.service.db.prepare("SELECT COUNT(*) AS n FROM changes WHERE thread_id = ?").bind(loser.json.threadId).first<any>();
  assert.equal(events.n, 1, 'seul l’événement de création du fil perdant');
  const sequential = await call(c, 'PUT', `${threadsPath}/${loser.json.threadId}/state`, { state: 'resolved', expectedVersion: 0 }, { 'Idempotency-Key': k });
  assert.equal(sequential.status, 409);
  const replyKey = key();
  const [m1, m2] = await Promise.all([
    call(c, 'POST', `${threadsPath}/${t1.json.threadId}/messages`, { body: 'Même clé, fil un.' }, { 'Idempotency-Key': replyKey }),
    call(c, 'POST', `${threadsPath}/${t2.json.threadId}/messages`, { body: 'Même clé, fil deux.' }, { 'Idempotency-Key': replyKey }),
  ]);
  assert.deepEqual([m1.status, m2.status].sort(), [201, 409], JSON.stringify([m1.json, m2.json]));
  const n = await bench.service.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE body LIKE 'Même clé, fil %'").first<any>();
  assert.equal(n.n, 1);
});

test('double clic et rejeu avec la même clé produisent un seul retour', async () => {
  const c = await claire();
  const k = key();
  const body = { kind: 'global', body: 'Double clic.' };
  const [a, b] = await Promise.all([
    call(c, 'POST', threadsPath, body, { 'Idempotency-Key': k }),
    call(c, 'POST', threadsPath, body, { 'Idempotency-Key': k }),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 201], JSON.stringify([a.json, b.json]));
  assert.equal(a.json.threadId, b.json.threadId);
  const replay = await call(c, 'POST', threadsPath, body, { 'Idempotency-Key': k });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.threadId, a.json.threadId);
  const conflict = await call(c, 'POST', threadsPath, { kind: 'global', body: 'Autre charge.' }, { 'Idempotency-Key': k });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.code, 'idempotency_conflict');
  const n = await bench.service.db.prepare("SELECT COUNT(*) AS n FROM threads t JOIN messages m USING (project_id, review_key, thread_id) WHERE m.body = 'Double clic.'").first<any>();
  assert.equal(n.n, 1);
  const missing = await call(c, 'POST', threadsPath, body);
  assert.equal(missing.status, 422, 'clé requise');
  const replyKey = key();
  const [r1, r2] = await Promise.all([
    call(c, 'POST', `${threadsPath}/${a.json.threadId}/messages`, { body: 'Réponse en double.' }, { 'Idempotency-Key': replyKey }),
    call(c, 'POST', `${threadsPath}/${a.json.threadId}/messages`, { body: 'Réponse en double.' }, { 'Idempotency-Key': replyKey }),
  ]);
  assert.equal(r1.json.messageId, r2.json.messageId);
  const replies = await bench.service.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE body = 'Réponse en double.'").first<any>();
  assert.equal(replies.n, 1);
});

test('deux relectrices publient en même temps : deux retours distincts et intacts', async () => {
  const [c1, c2] = await Promise.all([claire(), sessionClient(bench, { deploymentId: 'local-1', sub: 'lea', name: 'Léa Petit' })]);
  const bodies = Array.from({ length: 6 }, (_, i) => `Publication concurrente ${i}`);
  const results = await Promise.all(bodies.map((b, i) => call(i % 2 ? c1 : c2, 'POST', threadsPath, { kind: 'global', body: b }, { 'Idempotency-Key': key() })));
  assert.ok(results.every((r) => r.status === 201), JSON.stringify(results.map((r) => r.status)));
  const ids = new Set(results.map((r) => r.json.threadId));
  assert.equal(ids.size, 6);
  const list = await call(c1, 'GET', threadsPath);
  const got = list.json.items.filter((t: any) => t.messages[0].body.startsWith('Publication concurrente')).map((t: any) => t.messages[0].body).sort();
  assert.deepEqual(got, bodies.sort());
  const threadId = results[0]!.json.threadId;
  const author = results[0]!.json.author.key === c1.session.actor.key ? c1 : c2;
  const [s1, s2] = await Promise.all([
    call(author, 'PUT', `${threadsPath}/${threadId}/state`, { state: 'resolved', expectedVersion: 0 }, { 'Idempotency-Key': key() }),
    call(author, 'PUT', `${threadsPath}/${threadId}/state`, { state: 'resolved', expectedVersion: 0 }, { 'Idempotency-Key': key() }),
  ]);
  assert.deepEqual([s1.status, s2.status].sort(), [200, 200]);
  const t = await call(author, 'GET', `${threadsPath}/${threadId}`);
  assert.equal(t.json.version, 1, 'une seule transition malgré deux demandes concurrentes');
  const events = await bench.service.db.prepare("SELECT COUNT(*) AS n FROM changes WHERE thread_id = ? AND kind = 'thread.resolved'").bind(threadId).first<any>();
  assert.equal(events.n, 1);
});

test('redémarrage pendant une publication : ni succès mensonger ni doublon après reprise', async () => {
  const c = await claire();
  const k = key();
  const body = { kind: 'global', body: 'Publié juste avant la coupure.' };
  const committed = await call(c, 'POST', threadsPath, body, { 'Idempotency-Key': k });
  assert.equal(committed.status, 201);
  await bench.restart();
  const retry = await call(c, 'POST', threadsPath, body, { 'Idempotency-Key': k });
  assert.equal(retry.status, 200, 'la session et l’opération survivent au redémarrage');
  assert.equal(retry.json.threadId, committed.json.threadId);
  const n = await bench.service.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE body = 'Publié juste avant la coupure.'").first<any>();
  assert.equal(n.n, 1);

  const url = bench.service.url;
  await bench.stopService();
  const k2 = key();
  await assert.rejects(fetch(`${url}${threadsPath}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${c.token}`, Origin: c.origin!, 'Idempotency-Key': k2 }, body: JSON.stringify({ kind: 'global', body: 'Pendant la coupure.' }) }), 'aucune réponse pendant la coupure');
  await bench.startService();
  const after1 = await call(c, 'POST', threadsPath, { kind: 'global', body: 'Pendant la coupure.' }, { 'Idempotency-Key': k2 });
  assert.equal(after1.status, 201);
  const after2 = await call(c, 'POST', threadsPath, { kind: 'global', body: 'Pendant la coupure.' }, { 'Idempotency-Key': k2 });
  assert.equal(after2.status, 200);
  assert.equal(after2.json.threadId, after1.json.threadId);
  const list = await call(c, 'GET', threadsPath);
  assert.equal(list.json.items.filter((t: any) => t.messages[0].body === 'Pendant la coupure.').length, 1);
});

test('refus certains avant écriture : 422 sur 16 001 caractères et 404 sur un fil inconnu ne laissent aucune opération ; aucun 4xx n’est rendu après un batch validé', async () => {
  const c = await claire();
  const noOperation = async (k: string) => (await bench.service.db.prepare('SELECT COUNT(*) AS n FROM operations WHERE idempotency_key = ?').bind(k).first<any>()).n;
  const tooLong = 'x'.repeat(16_001);
  const k1 = key();
  const r1 = await call(c, 'POST', threadsPath, { kind: 'global', body: tooLong }, { 'Idempotency-Key': k1 });
  assert.equal(r1.status, 422);
  assert.equal(r1.json.code, 'invalid_request');
  assert.equal(r1.json.retryable, false);
  assert.equal(await noOperation(k1), 0);
  const ok = await call(c, 'POST', threadsPath, { kind: 'global', body: 'Texte raccourci.' }, { 'Idempotency-Key': key() });
  assert.equal(ok.status, 201);
  const k2 = key();
  const r2 = await call(c, 'POST', `${threadsPath}/${ok.json.threadId}/messages`, { body: tooLong }, { 'Idempotency-Key': k2 });
  assert.equal(r2.status, 422);
  assert.equal(await noOperation(k2), 0);
  const k3 = key();
  const r3 = await call(c, 'POST', `${threadsPath}/inconnu/messages`, { body: 'Fil inconnu.' }, { 'Idempotency-Key': k3 });
  assert.equal(r3.status, 404);
  assert.equal(await noOperation(k3), 0);
  const i = await invite();
  const k4 = key();
  const r4 = await call(i, 'POST', threadsPath, { kind: 'global', body: 'Sans capacité.' }, { 'Idempotency-Key': k4 });
  assert.equal(r4.status, 403);
  assert.equal(await noOperation(k4), 0);
  const k5 = key();
  const committed = await call(c, 'POST', `${threadsPath}/${ok.json.threadId}/messages`, { body: 'Réponse validée.' }, { 'Idempotency-Key': k5 });
  assert.equal(committed.status, 201);
  assert.equal(await noOperation(k5), 1);
  const replay = await call(c, 'POST', `${threadsPath}/${ok.json.threadId}/messages`, { body: 'Réponse validée.' }, { 'Idempotency-Key': k5 });
  assert.equal(replay.status, 200, 'après un batch validé, la même intention est rejouée, jamais refusée');
  assert.equal(replay.json.messageId, committed.json.messageId);
});
