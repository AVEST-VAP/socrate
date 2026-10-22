import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { startBench, importDemo, demoManifest, call, sessionClient, threadsPath, key, PROJECT, REVIEW, type Bench, type Client } from './helpers.ts';

let bench: Bench;
let revisionW1: string;
before(async () => {
  bench = await startBench();
  const imported = await importDemo(bench, 'w-1');
  assert.equal(imported.status, 201);
  revisionW1 = imported.json.revisionId;
});
after(async () => { await bench.stop(); });

const base = `/v1/projects/${PROJECT}/reviews/${REVIEW}`;
const claire = () => sessionClient(bench, { deploymentId: 'w-1' });
const agent = (): Client => ({ url: bench.service.url, token: bench.agentToken });
const count = async (sql: string, ...binds: unknown[]) => (await bench.service.db.prepare(sql).bind(...binds).first<{ n: number }>())!.n;
const SMS_SOURCE = 'Un rappel vous sera envoyé par SMS {delai} avant le rendez-vous.';

function png(seed: string): Uint8Array {
  const body = new TextEncoder().encode(`image fictive ${seed} `.repeat(50));
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...body]);
}

function targeted(bytes: Uint8Array, text: string, over: Record<string, unknown> = {}, targetOver: Record<string, unknown> = {}) {
  return {
    kind: 'targeted', body: 'Proposition depuis la page.',
    target: {
      url: 'http://127.0.0.1:5173/rendez-vous/rdv-1042', route: '/rendez-vous/rdv-1042', frame: [],
      rect: { x: 40, y: 200, width: 500, height: 20 },
      viewport: { width: 1280, height: 800, devicePixelRatio: 1, scrollX: 0, scrollY: 0 },
      role: 'paragraph', text, selector: 'p', html: `<p>${text}</p>`, ...targetOver,
    },
    image: { contentType: 'image/png', size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), width: 1280, height: 800 },
    ...over,
  };
}

async function publishTargeted(c: Client, k: string, body: ReturnType<typeof targeted>, bytes: Uint8Array) {
  const r = await call(c, 'POST', `${base}/targeted`, body, { 'Idempotency-Key': k });
  if (r.status !== 201) return r;
  const up = await fetch(`${c.url}${base}/captures/${r.json.captureId}?attempt=${r.json.attempt}`, {
    method: 'PUT', headers: { Authorization: `Bearer ${c.token}`, Origin: c.origin!, 'Content-Type': 'image/png' }, body: bytes as BodyInit,
  });
  assert.equal(up.status, 200);
  return call(c, 'POST', `${base}/captures/${r.json.captureId}/commit`, { attempt: r.json.attempt });
}

test('la revue regroupée propose sans capture ; l’original vient de la révision, pas du navigateur', async () => {
  const c = await claire();
  const k = key();
  const body = { kind: 'global', body: 'Plus direct.', proposal: { wordingId: 'rappel-sms', replacement: 'Rappel par SMS {delai} avant votre rendez-vous.', revisionId: revisionW1 } };
  const created = await call(c, 'POST', threadsPath, body, { 'Idempotency-Key': k });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.capture, null, 'aucune capture depuis la liste');
  assert.equal(created.json.target, null);
  assert.deepEqual(created.json.proposal.wording, { id: 'rappel-sms', key: 'rdv.rappel.sms', locale: 'fr', variant: 'Canal SMS' });
  assert.equal(created.json.proposal.original, SMS_SOURCE, 'template source, distinct de l’exemple rendu');
  assert.equal(created.json.proposal.sourceRevisionId, created.json.revisionId);
  assert.equal(await count('SELECT COUNT(*) AS n FROM captures WHERE thread_id = ?', created.json.threadId), 0);

  const replay = await call(c, 'POST', threadsPath, body, { 'Idempotency-Key': k });
  assert.equal(replay.status, 200, 'rejeu idempotent');
  assert.equal(replay.json.threadId, created.json.threadId);
  const changed = await call(c, 'POST', threadsPath, { ...body, proposal: { ...body.proposal, replacement: 'Autre.' } }, { 'Idempotency-Key': k });
  assert.equal(changed.status, 409, 'même clé, proposition différente');

  const unknown = await call(c, 'POST', threadsPath, { kind: 'global', body: 'x', proposal: { wordingId: 'inexistant', replacement: 'y', revisionId: revisionW1 } }, { 'Idempotency-Key': key() });
  assert.equal(unknown.status, 422);
  const both = await call(c, 'POST', threadsPath, { kind: 'global', body: 'x', proposal: { wordingId: 'rappel-sms', original: 'forgé', replacement: 'y', revisionId: revisionW1 } }, { 'Idempotency-Key': key() });
  assert.equal(both.status, 422, 'un original fourni par le navigateur n’accompagne jamais un texte préparé');
  const unversioned = await call(c, 'POST', threadsPath, { kind: 'global', body: 'x', proposal: { wordingId: 'rappel-sms', replacement: 'y' } }, { 'Idempotency-Key': key() });
  assert.equal(unversioned.status, 422, 'la révision observée est obligatoire');
});

test('la revue regroupée refuse une proposition de texte libre : sans cible ni capture, elle n’a pas de contexte', async () => {
  const c = await claire();
  const threadsBefore = await count('SELECT COUNT(*) AS n FROM threads');
  const free = await call(c, 'POST', threadsPath, { kind: 'global', body: 'Proposition libre sans capture', proposal: { original: 'Texte libre vu dans la page', replacement: 'Autre texte', revisionId: revisionW1 } }, { 'Idempotency-Key': key() });
  assert.equal(free.status, 422, JSON.stringify(free.json));
  assert.equal(await count('SELECT COUNT(*) AS n FROM threads'), threadsBefore, 'aucun fil créé');
  const plain = await call(c, 'POST', threadsPath, { kind: 'global', body: 'Commentaire global ordinaire' }, { 'Idempotency-Key': key() });
  assert.equal(plain.status, 201, 'le commentaire global sans proposition reste disponible');
  assert.equal(plain.json.proposal, null);
});

test('depuis la page : élément rattaché retrouvé dans la liste, doublons libres séparés, refus sans image', async () => {
  const c = await claire();
  const attachedBytes = png('sms');
  const page = await publishTargeted(c, key(), targeted(attachedBytes, 'Un rappel vous sera envoyé par SMS 24 heures avant le rendez-vous.',
    { proposal: { replacement: 'SMS de rappel {delai} avant.', revisionId: revisionW1 } }, { wording: 'rappel-sms' }), attachedBytes);
  assert.equal(page.status, 201, JSON.stringify(page.json));
  assert.ok(page.json.capture, 'capture au ciblage');
  assert.equal(page.json.proposal.original, SMS_SOURCE);
  assert.equal(page.json.target.text, 'Un rappel vous sera envoyé par SMS 24 heures avant le rendez-vous.', 'rendu conservé comme contexte');

  const before = await count('SELECT COUNT(*) AS n FROM captures');
  const refused = [
    ['identifiant en double de la cible', { proposal: { wordingId: 'rappel-sms', replacement: 'z', revisionId: revisionW1 } }, { wording: 'rappel-sms' }],
    ['original contradictoire avec l’extrait ciblé', { proposal: { original: 'autre chose', replacement: 'z', revisionId: revisionW1 } }, {}],
    ['rattachement absent de la sélection, jamais dégradé en texte libre', { proposal: { replacement: 'z', revisionId: revisionW1 } }, { wording: 'inexistant' }],
    ['extrait vide', { proposal: { replacement: 'z', revisionId: revisionW1 } }, { text: '' }],
  ] as const;
  for (const [why, over, targetOver] of refused) {
    const r = await call(c, 'POST', `${base}/targeted`, targeted(png(why), 'Un rappel vous sera envoyé par SMS 24 heures avant le rendez-vous.', over, targetOver), { 'Idempotency-Key': key() });
    assert.equal(r.status, 422, `${why} : ${JSON.stringify(r.json)}`);
  }
  assert.equal(await count('SELECT COUNT(*) AS n FROM captures'), before, 'refus avant réservation, aucune image');

  const free: string[] = [];
  for (const seed of ['occ-1', 'occ-2']) {
    const bytes = png(seed);
    const r = await publishTargeted(c, key(), targeted(bytes, 'Rappel recalculé', { proposal: { replacement: `Rappel mis à jour (${seed})`, revisionId: revisionW1 } }), bytes);
    assert.equal(r.status, 201, JSON.stringify(r.json));
    assert.equal(r.json.proposal.original, 'Rappel recalculé', 'original libre pris dans l’extrait ciblé');
    assert.equal(r.json.proposal.wording, null, 'aucune clé inventée');
    assert.equal(r.json.proposal.drift, null);
    free.push(r.json.threadId);
  }
  assert.notEqual(free[0], free[1]);

  const list = await call(c, 'GET', threadsPath);
  const sms = list.json.items.filter((t: any) => t.proposal?.wording?.id === 'rappel-sms');
  assert.deepEqual(sms.map((t: any) => t.kind).sort(), ['global', 'targeted'], 'la liste et la page lisent les mêmes propositions');
  const recalc = list.json.items.filter((t: any) => t.proposal?.original === 'Rappel recalculé');
  assert.equal(recalc.length, 2, 'deux occurrences, deux propositions distinctes');
  assert.ok(recalc.every((t: any) => t.proposal.wording === null));
});

test('révision suivante : original intact et décalage signalé à l’API agent et à la relectrice', async () => {
  const m = structuredClone(await demoManifest()) as any;
  m.wordings.find((w: any) => w.id === 'rappel-sms').source = 'Vous recevrez un SMS de rappel {delai} avant le rendez-vous.';
  m.wordings = m.wordings.filter((w: any) => w.id !== 'rappel-email');
  assert.equal((await importDemo(bench, 'w-2', { commit: 'b2c3d4e5f6a7', buildId: '0043' }, m)).status, 201);
  const c = await claire();
  const email = await call(c, 'POST', threadsPath, { kind: 'global', body: 'e', proposal: { wordingId: 'rappel-email', replacement: 'Rappel par e-mail.', revisionId: revisionW1 } }, { 'Idempotency-Key': key() });
  assert.equal(email.status, 201);

  const read = await call(agent(), 'GET', threadsPath);
  assert.equal(read.status, 200);
  const sms = read.json.items.filter((t: any) => t.proposal?.wording?.id === 'rappel-sms');
  assert.ok(sms.length >= 2);
  for (const t of sms) {
    assert.equal(t.proposal.original, SMS_SOURCE, 'original figé');
    assert.equal(t.proposal.drift.status, 'changed');
    assert.equal(t.proposal.drift.currentSource, 'Vous recevrez un SMS de rappel {delai} avant le rendez-vous.');
    assert.notEqual(t.proposal.drift.revisionId, t.proposal.sourceRevisionId);
  }
  const removed = read.json.items.find((t: any) => t.threadId === email.json.threadId);
  assert.equal(removed.proposal.drift.status, 'removed');
  const raw = JSON.stringify(read.json);
  assert.ok(!/iVBORw0KGgo|data:image/.test(raw), 'aucune image embarquée dans la liste JSON');
  const one = await call(agent(), 'GET', `${threadsPath}/${sms[0].threadId}`);
  assert.equal(one.json.proposal.drift.status, 'changed');

  const onW1 = await call(c, 'GET', threadsPath);
  assert.ok(onW1.json.items.filter((t: any) => t.proposal?.wording?.id === 'rappel-sms').every((t: any) => t.proposal.drift.status === 'current'), 'la session de la révision d’origine ne voit pas de décalage');
  const reviewerW2 = await sessionClient(bench, { deploymentId: 'w-2' });
  const onW2 = await call(reviewerW2, 'GET', threadsPath);
  assert.ok(onW2.json.items.filter((t: any) => t.proposal?.wording?.id === 'rappel-sms').every((t: any) => t.proposal.drift.status === 'changed'), 'la relectrice de la révision suivante voit le décalage');
});

test('changement de révision : jamais d’original réinterprété, refus explicite, succès déjà écrit reconnu', async () => {
  const m = structuredClone(await demoManifest()) as any;
  m.wordings.find((w: any) => w.id === 'rappel-sms').source = 'Source B entièrement différente {delai}.';
  const imported = await importDemo(bench, 'w-b', { commit: 'c3d4e5f6a7b8', buildId: '0044' }, m);
  assert.equal(imported.status, 201);
  const revisionB = imported.json.revisionId;
  assert.notEqual(revisionB, revisionW1);
  const onA = await claire();
  const onB = await sessionClient(bench, { deploymentId: 'w-b' });
  assert.equal(onB.session.actor.key, onA.session.actor.key, 'même relectrice, session renouvelée sur B');

  const listOnB = await call(onB, 'POST', threadsPath, { kind: 'global', body: 'x', proposal: { wordingId: 'rappel-sms', replacement: 'y', revisionId: revisionW1 } }, { 'Idempotency-Key': key() });
  assert.equal(listOnB.status, 409, JSON.stringify(listOnB.json));
  assert.equal(listOnB.json.code, 'revision_changed');
  assert.equal(listOnB.json.retryable, false);

  const captures = await count('SELECT COUNT(*) AS n FROM captures');
  const firstOnB = await call(onB, 'POST', `${base}/targeted`, targeted(png('first-b'), 'Un rappel', { proposal: { replacement: 'Rédigé sur A', revisionId: revisionW1 } }, { wording: 'rappel-sms' }), { 'Idempotency-Key': key() });
  assert.equal(firstOnB.status, 409, 'première émission après renouvellement refusée avant réservation');
  assert.equal(firstOnB.json.code, 'revision_changed');
  assert.equal(await count('SELECT COUNT(*) AS n FROM captures'), captures, 'aucune image réservée');

  const bytes = png('reserve-a');
  const k = key();
  const body = targeted(bytes, 'Un rappel', { proposal: { replacement: 'Rédigé sur A', revisionId: revisionW1 } }, { wording: 'rappel-sms' });
  const reserved = await call(onA, 'POST', `${base}/targeted`, body, { 'Idempotency-Key': k });
  assert.equal(reserved.status, 201);
  const up = await fetch(`${onA.url}${base}/captures/${reserved.json.captureId}?attempt=${reserved.json.attempt}`, {
    method: 'PUT', headers: { Authorization: `Bearer ${onA.token}`, Origin: onA.origin!, 'Content-Type': 'image/png' }, body: bytes as BodyInit,
  });
  assert.equal(up.status, 200);
  const threads = await count('SELECT COUNT(*) AS n FROM threads');
  const commitOnB = await call(onB, 'POST', `${base}/captures/${reserved.json.captureId}/commit`, { attempt: reserved.json.attempt });
  assert.equal(commitOnB.status, 409, `réservation A validée sous B refusée : ${JSON.stringify(commitOnB.json)}`);
  assert.equal(commitOnB.json.code, 'revision_changed');
  assert.equal(await count('SELECT COUNT(*) AS n FROM threads'), threads, 'aucun fil écrit');
  const reserveOnB = await call(onB, 'POST', `${base}/targeted`, body, { 'Idempotency-Key': k });
  assert.equal(reserveOnB.status, 409, 'reprise de la même intention sous B refusée');

  const commitOnA = await call(onA, 'POST', `${base}/captures/${reserved.json.captureId}/commit`, { attempt: reserved.json.attempt });
  assert.equal(commitOnA.status, 201, JSON.stringify(commitOnA.json));
  assert.equal(commitOnA.json.proposal.original, SMS_SOURCE, 'original de la révision observée');
  assert.equal(commitOnA.json.proposal.sourceRevisionId, revisionW1);
  const recognizedByCommit = await call(onB, 'POST', `${base}/captures/${reserved.json.captureId}/commit`, { attempt: reserved.json.attempt });
  assert.equal(recognizedByCommit.status, 200, 'succès déjà écrit reconnu sous B');
  assert.equal(recognizedByCommit.json.threadId, commitOnA.json.threadId);
  assert.equal(recognizedByCommit.json.proposal.original, SMS_SOURCE);
  const recognizedByReserve = await call(onB, 'POST', `${base}/targeted`, body, { 'Idempotency-Key': k });
  assert.equal(recognizedByReserve.status, 200);
  assert.equal(recognizedByReserve.json.threadId, commitOnA.json.threadId);
  const stored = await bench.service.db.prepare('SELECT original, source_revision_id FROM proposals WHERE thread_id = ?').bind(commitOnA.json.threadId).first<{ original: string; source_revision_id: string }>();
  assert.deepEqual(stored, { original: SMS_SOURCE, source_revision_id: revisionW1 }, 'original durable de A');
});
