import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startBench, importDemo, call, sessionClient, threadsPath, key, PROJECT, REVIEW, type Bench, type Client } from './helpers.ts';

let bench: Bench;
before(async () => {
  bench = await startBench();
  assert.equal((await importDemo(bench, 'local-1')).status, 201);
});
after(async () => { await bench.stop(); });

const base = `/v1/projects/${PROJECT}/reviews/${REVIEW}`;
const claire = () => sessionClient(bench, { deploymentId: 'local-1' });

function png(seed: string): Uint8Array {
  const body = new TextEncoder().encode(`image fictive ${seed} `.repeat(50));
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...body]);
}
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

function payload(bytes: Uint8Array, over: Record<string, unknown> = {}) {
  return {
    kind: 'targeted', body: 'Le bouton Enregistrer de la modal est ambigu.',
    target: {
      url: 'http://127.0.0.1:5173/reglages/rappels', route: '/reglages/rappels',
      rect: { x: 412, y: 300, width: 120, height: 36 },
      viewport: { width: 1280, height: 800, devicePixelRatio: 1, scrollX: 0, scrollY: 0 },
      role: 'button', text: 'Enregistrer le rappel', selector: 'button[data-socrate-id="modal-enregistrer"]',
      html: '<button type="button" data-socrate-id="modal-enregistrer">Enregistrer le rappel</button>',
    },
    image: { contentType: 'image/png', size: bytes.byteLength, sha256: sha(bytes), width: 1280, height: 800 },
    ...over,
  };
}

async function putBytes(c: Client, captureId: string, attempt: string, bytes: Uint8Array) {
  const res = await fetch(`${c.url}${base}/captures/${captureId}?attempt=${attempt}`, {
    method: 'PUT', headers: { Authorization: `Bearer ${c.token}`, Origin: c.origin!, 'Content-Type': 'image/png' }, body: bytes as BodyInit,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

async function publishTargeted(c: Client, k: string, bytes: Uint8Array) {
  const r = await call(c, 'POST', `${base}/targeted`, payload(bytes), { 'Idempotency-Key': k });
  if (r.status === 200) return r;
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal((await putBytes(c, r.json.captureId, r.json.attempt, bytes)).status, 200);
  return call(c, 'POST', `${base}/captures/${r.json.captureId}/commit`, { attempt: r.json.attempt });
}

const count = async (sql: string, ...binds: unknown[]) => (await bench.service.db.prepare(sql).bind(...binds).first<{ n: number }>())!.n;

test('publication ciblée durable : métadonnées dans la liste, octets sur une route protégée, rejeu idempotent', async () => {
  const c = await claire();
  const bytes = png('modal-a');
  const k = key();
  const created = await publishTargeted(c, k, bytes);
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.kind, 'targeted');
  assert.equal(created.json.capture.sha256, sha(bytes));
  assert.equal(created.json.target.route, '/reglages/rappels');

  const list = await call(c, 'GET', threadsPath);
  const item = list.json.items.find((t: any) => t.threadId === created.json.threadId);
  assert.deepEqual(item.capture, created.json.capture, 'métadonnées de capture dans la liste');
  assert.ok(!JSON.stringify(list.json).includes('base64') && JSON.stringify(list.json).length < 5_000, 'aucune image encodée dans la liste JSON');

  const res = await fetch(`${c.url}${base}/captures/${created.json.capture.captureId}`, { headers: { Authorization: `Bearer ${c.token}`, Origin: c.origin! } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/png');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(sha(new Uint8Array(await res.arrayBuffer())), sha(bytes), 'octets identiques');
  const anonymous = await fetch(`${c.url}${base}/captures/${created.json.capture.captureId}`);
  assert.equal(anonymous.status, 401);
  const otherReview = await call(c, 'GET', `/v1/projects/${PROJECT}/reviews/autre-revue/captures/${created.json.capture.captureId}`);
  assert.equal(otherReview.status, 403, 'contrôle de revue identique à la discussion');
  const agent = await fetch(`${c.url}${base}/captures/${created.json.capture.captureId}`, { headers: { Authorization: `Bearer ${bench.agentToken}` } });
  assert.equal(agent.status, 200, 'un accès technique review.read lit les octets séparément');

  const replay = await call(c, 'POST', `${base}/targeted`, payload(bytes), { 'Idempotency-Key': k });
  assert.equal(replay.status, 200, 'même clé et même charge convergent');
  assert.equal(replay.json.threadId, created.json.threadId);
  const conflict = await call(c, 'POST', `${base}/targeted`, payload(bytes, { body: 'Texte modifié après coup.' }), { 'Idempotency-Key': k });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.code, 'idempotency_conflict');
  const otherImage = await call(c, 'POST', `${base}/targeted`, payload(png('autre')), { 'Idempotency-Key': k });
  assert.equal(otherImage.json.code, 'idempotency_conflict', 'une autre image sous la même clé est un conflit explicite');
});

test('contexte de cible facultatif : conservé tel quel à la publication, dans la liste et le fil ; refusé non assaini', async () => {
  const c = await claire();
  const bytes = png('contexte');
  const p = payload(bytes);
  const context = { html: '<div class="ligne"><span>Mme Fictive Petit</span><button type="button">Modifier</button></div>', path: [1] };
  const r = await call(c, 'POST', `${base}/targeted`, { ...p, target: { ...p.target, context } }, { 'Idempotency-Key': key() });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.equal((await putBytes(c, r.json.captureId, r.json.attempt, bytes)).status, 200);
  const created = await call(c, 'POST', `${base}/captures/${r.json.captureId}/commit`, { attempt: r.json.attempt });
  assert.deepEqual(created.json.target.context, context);
  const item = (await call(c, 'GET', threadsPath)).json.items.find((t: any) => t.threadId === created.json.threadId);
  assert.deepEqual(item.target.context, context, 'liste');
  assert.deepEqual((await call(c, 'GET', `${threadsPath}/${created.json.threadId}`)).json.target.context, context, 'fil');
  const refused = await call(c, 'POST', `${base}/targeted`, { ...p, target: { ...p.target, context: { ...context, html: '<div onclick="x()">x</div>' } } }, { 'Idempotency-Key': key() });
  assert.equal(refused.status, 422);
});

test('réponse et changement d’état sur un retour ciblé ne prennent aucune capture', async () => {
  const c = await claire();
  const created = await publishTargeted(c, key(), png('reponse'));
  const before = await count('SELECT COUNT(*) AS n FROM captures');
  const objects = (await (await bench.service.mf.getR2Bucket('CAPTURES')).list()).objects.length;
  assert.equal((await call(c, 'POST', `${threadsPath}/${created.json.threadId}/messages`, { body: 'Précision.' }, { 'Idempotency-Key': key() })).status, 201);
  assert.equal((await call(c, 'PUT', `${threadsPath}/${created.json.threadId}/state`, { state: 'resolved', expectedVersion: 0 }, { 'Idempotency-Key': key() })).status, 200);
  assert.equal(await count('SELECT COUNT(*) AS n FROM captures'), before);
  assert.equal((await (await bench.service.mf.getR2Bucket('CAPTURES')).list()).objects.length, objects);
  const thread = await call(c, 'GET', `${threadsPath}/${created.json.threadId}`);
  assert.equal(thread.json.state, 'resolved');
  assert.equal(thread.json.capture.captureId, created.json.capture.captureId, 'capture initiale inchangée');
});

test('contexte refusé s’il contient script, gestionnaire inline ou attribut sensible', async () => {
  const c = await claire();
  for (const html of ['<script>alert(1)</script>', '<button onclick="x()">x</button>', '<input type="text" value="secret">', '<a href="javascript:x">x</a>']) {
    const bytes = png(html);
    const p = payload(bytes);
    const r = await call(c, 'POST', `${base}/targeted`, { ...p, target: { ...p.target, html } }, { 'Idempotency-Key': key() });
    assert.equal(r.status, 422, html);
  }
});

test('upload interrompu ou octets différents : aucun retour visible, reprise avec la même clé sans doublon', async () => {
  const c = await claire();
  const bytes = png('interrompu');
  const k = key();
  const r = await call(c, 'POST', `${base}/targeted`, payload(bytes), { 'Idempotency-Key': k });
  assert.equal(r.status, 201);
  const abort = new AbortController();
  const stream = new ReadableStream<Uint8Array>({
    start(ctl) { ctl.enqueue(bytes.slice(0, 64)); setTimeout(() => abort.abort(), 50); },
  });
  await fetch(`${c.url}${base}/captures/${r.json.captureId}?attempt=${r.json.attempt}`, {
    method: 'PUT', headers: { Authorization: `Bearer ${c.token}`, Origin: c.origin!, 'Content-Type': 'image/png', 'Content-Length': String(bytes.byteLength) },
    body: stream, signal: abort.signal, duplex: 'half',
  } as RequestInit).then(() => assert.fail('le téléversement devait être interrompu'), (e) => assert.equal((e as Error).name, 'AbortError'));
  const early = await call(c, 'POST', `${base}/captures/${r.json.captureId}/commit`, { attempt: r.json.attempt });
  assert.equal(early.status, 409);
  assert.equal(early.json.code, 'capture_missing', 'aucun succès sans image durable');
  assert.equal((await putBytes(c, r.json.captureId, r.json.attempt, png('tronqué'))).json.code, 'capture_mismatch');
  assert.equal(await count("SELECT COUNT(*) AS n FROM captures WHERE capture_id = ? AND uploaded = 0", r.json.captureId), 1);

  const resumed = await publishTargeted(c, k, bytes);
  assert.equal(resumed.status, 201, JSON.stringify(resumed.json));
  assert.equal(await count("SELECT COUNT(*) AS n FROM captures WHERE idempotency_key = ?", k), 1, 'une seule opération réservée');
  assert.equal(await count("SELECT COUNT(*) AS n FROM threads WHERE thread_id = ?", resumed.json.threadId), 1);
});

test('redémarrage pendant la publication : l’ancienne tentative perd la possession, la reprise publie une seule fois', async () => {
  let c = await claire();
  const bytes = png('redemarrage');
  const k = key();
  const first = await call(c, 'POST', `${base}/targeted`, payload(bytes), { 'Idempotency-Key': k });
  assert.equal((await putBytes(c, first.json.captureId, first.json.attempt, bytes)).status, 200);
  await bench.restart();
  c = await claire();
  const second = await call(c, 'POST', `${base}/targeted`, payload(bytes), { 'Idempotency-Key': k });
  assert.equal(second.status, 201);
  assert.equal(second.json.captureId, first.json.captureId, 'même opération réservée');
  assert.equal(second.json.uploaded, true, 'octets déjà durables avant le redémarrage');
  assert.notEqual(second.json.attempt, first.json.attempt);
  const stale = await call(c, 'POST', `${base}/captures/${first.json.captureId}/commit`, { attempt: first.json.attempt });
  assert.equal(stale.status, 409);
  assert.equal(stale.json.code, 'reservation_lost', 'l’ancienne tentative ne rend rien visible');
  const done = await call(c, 'POST', `${base}/captures/${second.json.captureId}/commit`, { attempt: second.json.attempt });
  assert.equal(done.status, 201, JSON.stringify(done.json));
  const again = await call(c, 'POST', `${base}/captures/${second.json.captureId}/commit`, { attempt: second.json.attempt });
  assert.equal(again.status, 200);
  assert.equal(again.json.threadId, done.json.threadId);
  assert.equal(await count("SELECT COUNT(*) AS n FROM threads t JOIN captures c ON c.thread_id = t.thread_id WHERE c.idempotency_key = ?", k), 1, 'aucun doublon');
});

test('orphelins : une réservation expirée est réclamée atomiquement, un objet validé n’est jamais supprimé', async () => {
  const c = await claire();
  const committed = await publishTargeted(c, key(), png('valide'));
  const bytes = png('orphelin');
  const r = await call(c, 'POST', `${base}/targeted`, payload(bytes), { 'Idempotency-Key': key() });
  assert.equal((await putBytes(c, r.json.captureId, r.json.attempt, bytes)).status, 200);
  const bucket = await bench.service.mf.getR2Bucket('CAPTURES');
  const orphanKey = `captures/${PROJECT}/${REVIEW}/${r.json.captureId}.png`;
  assert.ok(await bucket.head(orphanKey), 'objet temporaire présent');
  await bench.service.db.prepare('UPDATE captures SET expires_at = 0 WHERE capture_id = ?').bind(r.json.captureId).run();
  await bench.service.db.prepare('UPDATE captures SET expires_at = 0 WHERE capture_id = ?').bind(committed.json.capture.captureId).run();
  const worker = await bench.service.mf.getWorker();
  const outcome = await worker.scheduled({ cron: '*/10 * * * *' });
  assert.equal(outcome.outcome, 'ok');
  assert.equal(await bucket.head(orphanKey), null, 'objet orphelin supprimé');
  assert.equal(await count('SELECT COUNT(*) AS n FROM captures WHERE capture_id = ?', r.json.captureId), 0);
  const late = await call(c, 'POST', `${base}/captures/${r.json.captureId}/commit`, { attempt: r.json.attempt });
  assert.equal(late.status, 404, 'une tentative réclamée ne peut plus valider');
  assert.ok(await bucket.head(`captures/${PROJECT}/${REVIEW}/${committed.json.capture.captureId}.png`), 'objet validé conservé même expiré');
});

test('contexte : attributs interdits refusés malgré un > cité, valeurs citées légitimes acceptées', async () => {
  const c = await claire();
  for (const html of ['<div class="x>" onclick="y()">x</div>', '<input aria-label=">" value="fictif" onfocus="x()">', '<!--> <div onclick="x()"> -->', '<div class=x onclick=y>x</div>', '<div class="a"onclick="x()">x</div>']) {
    const bytes = png(html);
    const p = payload(bytes);
    const r = await call(c, 'POST', `${base}/targeted`, { ...p, target: { ...p.target, html } }, { 'Idempotency-Key': key() });
    assert.equal(r.status, 422, html);
  }
  for (const html of ['<button aria-label="Total = 5" type="button">Total</button>', '<div class="carte" role="dialog" aria-modal="true"><p>Rappel J-1 &gt; e-mail</p><br></div>']) {
    const bytes = png(html);
    const p = payload(bytes);
    const r = await call(c, 'POST', `${base}/targeted`, { ...p, target: { ...p.target, html } }, { 'Idempotency-Key': key() });
    assert.equal(r.status, 201, `${html} ${JSON.stringify(r.json)}`);
  }
});

test('reconnaissance sans mutation : 404 avant validation, le retour validé ensuite, rien pour une autre identité', async () => {
  const c = await claire();
  const bytes = png('reconnaissance');
  const k = key();
  const r = await call(c, 'POST', `${base}/targeted`, payload(bytes), { 'Idempotency-Key': k });
  assert.equal(r.status, 201);
  const rows = () => bench.service.db.prepare('SELECT attempt, expires_at, uploaded FROM captures WHERE capture_id = ?').bind(r.json.captureId).first();
  const before = await rows();
  const early = await call(c, 'GET', `${base}/targeted`, undefined, { 'Idempotency-Key': k });
  assert.equal(early.status, 404, 'aucune publication validée constatée');
  assert.deepEqual(await rows(), before, 'la lecture ne touche pas la réservation');
  assert.equal((await putBytes(c, r.json.captureId, r.json.attempt, bytes)).status, 200);
  const done = await call(c, 'POST', `${base}/captures/${r.json.captureId}/commit`, { attempt: r.json.attempt });
  assert.equal(done.status, 201);
  const seen = await call(c, 'GET', `${base}/targeted`, undefined, { 'Idempotency-Key': k });
  assert.equal(seen.status, 200);
  assert.equal(seen.json.threadId, done.json.threadId);
  const other = await sessionClient(bench, { deploymentId: 'local-1', sub: 'karim', name: 'Karim Benali', capabilities: ['thread.participate'] });
  assert.equal((await call(other, 'GET', `${base}/targeted`, undefined, { 'Idempotency-Key': k })).status, 404, 'la clé d’une autre identité ne révèle rien');
});

test('nettoyage : panne R2 contrôlée sous bail, reprise ordinaire, PUT tardif refusé, objets sans ligne après la première page', async () => {
  const workerModule = '../src/captures.ts';
  const { reclaimExpired, RECLAIM_LEASE_SECONDS, RESERVATION_TTL_SECONDS } = await import(workerModule);
  const c = await claire();
  const bucket = await bench.service.mf.getR2Bucket('CAPTURES');
  const db = bench.service.db;
  const bytes = png('nettoyage-interrompu');
  const k = key();
  const r = await call(c, 'POST', `${base}/targeted`, payload(bytes), { 'Idempotency-Key': k });
  assert.equal((await putBytes(c, r.json.captureId, r.json.attempt, bytes)).status, 200);
  const objectKey = `captures/${PROJECT}/${REVIEW}/${r.json.captureId}.png`;
  await db.prepare('UPDATE captures SET expires_at = 0 WHERE capture_id = ?').bind(r.json.captureId).run();
  const failing = { list: (o: object) => bucket.list(o), delete: async () => { throw new Error('panne R2 contrôlée'); } };
  const now = Math.floor(Date.now() / 1000);
  const broken = await reclaimExpired({ DB: db, CAPTURES: failing } as never, { now });
  assert.deepEqual(broken.deferred, [r.json.captureId], 'suppression échouée, réclamation conservée');
  assert.ok(await bucket.head(objectKey), 'objet encore présent');
  const leased = await db.prepare('SELECT state, expires_at FROM captures WHERE capture_id = ?').bind(r.json.captureId).first<{ state: string; expires_at: number }>();
  assert.equal(leased?.state, 'reclaiming');
  assert.equal(leased?.expires_at, now + RECLAIM_LEASE_SECONDS, 'bail borné');
  assert.equal((await putBytes(c, r.json.captureId, r.json.attempt, bytes)).json.code, 'reservation_lost', 'PUT tardif refusé pendant le nettoyage');
  assert.equal((await call(c, 'POST', `${base}/captures/${r.json.captureId}/commit`, { attempt: r.json.attempt })).json.code, 'reservation_lost', 'validation tardive refusée');
  const within = await reclaimExpired({ DB: db, CAPTURES: bucket } as never, { now: now + 1 });
  assert.ok(!within.reclaimed.includes(r.json.captureId), 'bail en cours respecté');
  const resumed = await reclaimExpired({ DB: db, CAPTURES: bucket } as never, { now: now + RECLAIM_LEASE_SECONDS });
  assert.ok(resumed.reclaimed.includes(r.json.captureId), 'nettoyage repris après le bail');
  assert.equal(await bucket.head(objectKey), null);
  assert.equal(await count('SELECT COUNT(*) AS n FROM captures WHERE capture_id = ?', r.json.captureId), 0);
  const again = await call(c, 'POST', `${base}/targeted`, payload(bytes), { 'Idempotency-Key': k });
  assert.equal(again.status, 201, 'la même clé peut de nouveau réserver, sans boucle reservation_lost');

  const committed = await publishTargeted(c, key(), png('valide-page'));
  const committedKey = `captures/${PROJECT}/${REVIEW}/${committed.json.capture.captureId}.png`;
  await bucket.put(`captures/zz-sans-ligne-${key()}.png`, png('sans-ligne'));
  const lastKey = (await bucket.list({ prefix: 'captures/zz-' })).objects[0]!.key;
  const total = (await bucket.list({ prefix: 'captures/' })).objects.length;
  assert.ok(total >= 3, `plusieurs pages à parcourir (${total} objets)`);
  const young = await reclaimExpired({ DB: db, CAPTURES: bucket } as never, { pageSize: 1 });
  assert.ok(!young.strayObjects.includes(lastKey), 'un objet récent peut être un PUT encore en vol');
  const swept = await reclaimExpired({ DB: db, CAPTURES: bucket } as never, { pageSize: 1, now: Math.floor(Date.now() / 1000) + RESERVATION_TTL_SECONDS + 1 });
  assert.ok(swept.scanned >= total, `toutes les pages examinées (${swept.scanned}/${total})`);
  assert.ok(swept.strayObjects.includes(lastKey), 'objet sans ligne au-delà de la première page supprimé');
  assert.ok(await bucket.head(committedKey), 'objet validé conservé');
});
