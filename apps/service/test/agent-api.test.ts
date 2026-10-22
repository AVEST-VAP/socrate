import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { startBench, importDemo, demoManifest, call, sessionClient, threadsPath, key, rt, PROJECT, REVIEW, ORIGIN, type Bench, type Client } from './helpers.ts';
import { REPO_ROOT } from '../../../tools/local/local-run.ts';

const run = promisify(execFile);
const base = `/v1/projects/${PROJECT}/reviews/${REVIEW}`;
/** Seconde revue du même projet : portée des marqueurs et revue existante sans fil. */
const REVIEW2 = 'seconde-revue';
const base2 = `/v1/projects/${PROJECT}/reviews/${REVIEW2}`;
const noMarker = `c2.${'0'.repeat(32)}.${'0'.repeat(32)}.0`;

let bench: Bench;
let agent: Client;
let tokenFile: string;
let otherTokenFile: string;
let claire: Client;
let karim: Client;
let claire2: Client;
let revisionId: string;
const ids: Record<string, string> = {};
let imageBytes: Uint8Array;
/** Faits du parcours agent, sans bearer : écrits sous `SOCRATE_AGENT_FACTS_OUT` quand la variable est fournie. */
const facts: Record<string, unknown> = {};

/** Exemples publiés dans le guide, extraits par leur marqueur et exécutés tels quels par `sh` après le préambule. */
const guide = await readFile(join(REPO_ROOT, 'docs/agent-api.md'), 'utf8');
const examples = new Map([...guide.matchAll(/<!-- example: ([a-z-]+) -->\n```sh\n([\s\S]*?)```/g)].map((m) => [m[1]!, m[2]!]));

async function example(name: string, vars: Record<string, string> = {}, file = tokenFile): Promise<string> {
  const script = `${examples.get('preambule')}\n${examples.get(name) ?? assert.fail(`exemple ${name} absent du guide`)}`;
  // Processus neuf sans HOME ni profil : seules les variables du guide, PATH et le temporaire local.
  const env = { PATH: process.env.PATH!, TMPDIR: process.env.TMPDIR!, TMP: process.env.TMP!, TEMP: process.env.TEMP!, SOCRATE_URL: bench.service.url, SOCRATE_PROJECT: PROJECT, SOCRATE_REVIEW: REVIEW, SOCRATE_TOKEN_FILE: file, ...vars };
  const { stdout } = await run('/bin/sh', ['-c', script], { env, cwd: bench.root });
  return stdout;
}
const exampleJson = async (name: string, vars?: Record<string, string>, file?: string) => JSON.parse(await example(name, vars, file));

function png(seed: string): Uint8Array {
  const body = new TextEncoder().encode(`image fictive ${seed} `.repeat(50));
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...body]);
}
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const count = async (sql: string, ...binds: unknown[]) => (await bench.service.db.prepare(sql).bind(...binds).first<{ n: number }>())!.n;

async function global(c: Client, body: string, proposal?: unknown) {
  const r = await call(c, 'POST', threadsPath, { kind: 'global', body, ...(proposal ? { proposal } : {}) }, { 'Idempotency-Key': key() });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.threadId as string;
}

async function targeted(c: Client, bytes: Uint8Array, proposal?: unknown) {
  const r = await call(c, 'POST', `${base}/targeted`, {
    kind: 'targeted', body: 'Le bouton Enregistrer de la modal est ambigu.',
    target: {
      url: `${ORIGIN}/reglages/rappels`, route: '/reglages/rappels', rect: { x: 412, y: 300, width: 120, height: 36 },
      viewport: { width: 1280, height: 800, devicePixelRatio: 1, scrollX: 0, scrollY: 0 },
      role: 'button', text: 'Enregistrer le rappel', selector: 'button[data-socrate-id="modal-enregistrer"]',
      html: '<button type="button" data-socrate-id="modal-enregistrer">Enregistrer le rappel</button>',
    },
    image: { contentType: 'image/png', size: bytes.byteLength, sha256: sha(bytes), width: 1280, height: 800 },
    ...(proposal ? { proposal } : {}),
  }, { 'Idempotency-Key': key() });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const put = await fetch(`${c.url}${base}/captures/${r.json.captureId}?attempt=${r.json.attempt}`, {
    method: 'PUT', headers: { Authorization: `Bearer ${c.token}`, Origin: c.origin!, 'Content-Type': 'image/png' }, body: bytes as BodyInit,
  });
  assert.equal(put.status, 200);
  const done = await call(c, 'POST', `${base}/captures/${r.json.captureId}/commit`, { attempt: r.json.attempt });
  assert.equal(done.status, 201, JSON.stringify(done.json));
  return done.json.threadId as string;
}

const setState = (c: Client, threadId: string, state: 'open' | 'resolved', expectedVersion: number, k = key()) =>
  call(c, 'PUT', `${threadsPath}/${threadId}/state`, { state, expectedVersion }, { 'Idempotency-Key': k });
const reply = (c: Client, threadId: string, body: string, k = key()) => call(c, 'POST', `${threadsPath}/${threadId}/messages`, { body }, { 'Idempotency-Key': k });

before(async () => {
  bench = await startBench();
  const imported = await importDemo(bench, 'local-1');
  assert.equal(imported.status, 201);
  revisionId = imported.json.revisionId;
  agent = { url: bench.service.url, token: bench.agentToken };
  tokenFile = join(bench.root, 'agent.token');
  otherTokenFile = join(bench.root, 'agent-autre.token');
  await writeFile(tokenFile, bench.agentToken, { mode: 0o600 });
  await writeFile(otherTokenFile, await rt.provisionCredential(bench.service.db, { projectId: 'autre', label: 'agent-autre', capabilities: ['review.read'] }), { mode: 0o600 });
  claire = await sessionClient(bench, { deploymentId: 'local-1' });
  karim = await sessionClient(bench, { deploymentId: 'local-1', sub: 'karim', name: 'Karim Benali', capabilities: ['thread.participate', 'thread.moderate'] });
  const second = await call({ url: bench.service.url, token: bench.importToken }, 'PUT', `${base2}/deployments/local-b`, { commit: 'b1b2c3d4e5f6', buildId: '0043', url: `${ORIGIN}/`, manifest: { ...(await demoManifest()), reviewKey: REVIEW2 } });
  assert.equal(second.status, 201, JSON.stringify(second.json));
  claire2 = await sessionClient(bench, { deploymentId: 'local-b', reviewKey: REVIEW2 });
  imageBytes = png('agent');
  ids.global = await global(claire, 'Le résumé hebdomadaire manque de contexte.');
  ids.cible = await targeted(claire, imageBytes);
  ids.wording = await global(claire, 'Plus court.', { wordingId: 'rappel-sms', replacement: 'SMS de rappel {delai} avant.', revisionId });
  ids.quatre = await global(karim, 'Quatrième retour.');
  ids.cinq = await global(karim, 'Cinquième retour.');
});

after(async () => {
  if (process.env.SOCRATE_AGENT_FACTS_OUT) await writeFile(process.env.SOCRATE_AGENT_FACTS_OUT, `${JSON.stringify({ examples: [...examples.keys()], ...facts }, null, 2)}\n`);
  await bench?.stop();
});

test('lecture agent : revues, parcours paginé avec mutations entre deux pages, sans perte ni doublon', async () => {
  const reviews = await exampleJson('revues');
  assert.deepEqual(reviews.items.map((r: any) => [r.reviewKey, r.latestDeployment.deploymentId]), [[REVIEW, 'local-1'], [REVIEW2, 'local-b']]);

  const p1 = await exampleJson('retours-ouverts');
  assert.equal(p1.total, 5);
  assert.deepEqual(p1.filter, { state: 'open' });
  assert.deepEqual(p1.items.map((t: any) => t.threadId), [ids.global, ids.cible]);
  assert.match(p1.nextCursor, /^l1\.[0-9a-f]{32}\.2$/);
  assert.match(p1.changesSince, /^c2\.[0-9a-f]{32}\.[0-9a-f]{32}\.\d+$/);

  // Entre deux pages : réponse sur un fil déjà lu, résolution d'un fil à venir, création d'un nouveau fil.
  assert.equal((await reply(karim, ids.global!, 'Réponse pendant le parcours.')).status, 201);
  assert.equal((await setState(karim, ids.quatre!, 'resolved', 0)).status, 200);
  ids.nouveau = await global(claire, 'Créé pendant le parcours.');

  const p2 = await exampleJson('page-suivante', { CURSOR: p1.nextCursor });
  const p3 = await exampleJson('page-suivante', { CURSOR: p2.nextCursor });
  assert.equal(p3.nextCursor, null);
  const all = [...p1.items, ...p2.items, ...p3.items].map((t: any) => t.threadId);
  assert.deepEqual(all, [ids.global, ids.cible, ids.wording, ids.quatre, ids.cinq], 'appartenance et ordre figés au premier appel');
  assert.equal(new Set(all).size, all.length);
  assert.equal(p2.items.find((t: any) => t.threadId === ids.quatre).state, 'resolved', 'valeur plus récente, membre conservé');
  assert.equal(p2.changesSince, p1.changesSince);
  facts.pagination = { total: p1.total, pages: [p1, p2, p3].map((p) => p.items.length), distinct: new Set(all).size, mutationsEntrePages: ['réponse', 'résolution', 'création'] };

  const changes = await exampleJson('changements', { MARKER: p1.changesSince });
  assert.deepEqual(changes.items.map((t: any) => t.threadId).sort(), [ids.global, ids.quatre, ids.nouveau].sort());
  assert.equal(changes.items.find((t: any) => t.threadId === ids.global).messages.at(-1).body, 'Réponse pendant le parcours.');
  assert.equal(changes.more, false);

  // Réouverture puis rejeux idempotents : le marqueur avance une fois, le rejeu n'écrit aucun changement.
  const reopenKey = key();
  const reopened = await setState(karim, ids.quatre!, 'open', 1, reopenKey);
  assert.equal(reopened.status, 200);
  const journal = await count('SELECT COUNT(*) AS n FROM changes');
  assert.equal((await setState(karim, ids.quatre!, 'open', 1, reopenKey)).status, 200);
  assert.equal((await setState(karim, ids.quatre!, 'open', 2)).status, 200, 'état déjà atteint');
  assert.equal(await count('SELECT COUNT(*) AS n FROM changes'), journal);
  const after = await exampleJson('changements', { MARKER: changes.next });
  assert.deepEqual(after.items.map((t: any) => [t.threadId, t.state]), [[ids.quatre, 'open']]);
  facts.incremental = { apresParcours: changes.items.length, apresReouverture: after.items.length, journalAvantRejeu: journal, journalApresRejeu: await count('SELECT COUNT(*) AS n FROM changes') };
  const quiet = await exampleJson('changements', { MARKER: after.next });
  assert.deepEqual(quiet, { items: [], next: after.next, more: false });
});

test('lecture agent : filtres exacts par état et date, bornes et égalités d’horodatage', async () => {
  const db = bench.service.db;
  const resolved = await call(agent, 'GET', `${threadsPath}?state=resolved`);
  const expected = (await db.prepare("SELECT thread_id FROM threads WHERE project_id = ? AND review_key = ? AND state = 'resolved' ORDER BY created_at, thread_id").bind(PROJECT, REVIEW).all<{ thread_id: string }>()).results.map((r) => r.thread_id);
  assert.deepEqual(resolved.json.items.map((t: any) => t.threadId), expected);
  assert.ok(resolved.json.items.every((t: any) => t.state === 'resolved'));

  // Fixture d'égalité : deux fils mis à jour et créés au même instant.
  const tie = '2026-10-18T12:00:00.000Z';
  await db.prepare('UPDATE threads SET updated_at = ?, created_at = ? WHERE thread_id IN (?, ?)').bind(tie, tie, ids.quatre, ids.cinq).run();
  await setState(karim, ids.cinq!, 'resolved', 0);
  const since = await exampleJson('resolus-depuis', { SINCE: '2026-10-18T12:00:00Z' });
  const rows = (await db.prepare("SELECT thread_id FROM threads WHERE project_id = ? AND review_key = ? AND state = 'resolved' AND updated_at >= ? ORDER BY created_at, thread_id").bind(PROJECT, REVIEW, tie).all<{ thread_id: string }>()).results;
  assert.deepEqual(since.items.map((t: any) => t.threadId), rows.map((r) => r.thread_id));
  const window = await call(agent, 'GET', `${threadsPath}?updatedSince=${tie}&updatedBefore=2026-10-18T12:00:00.001Z`);
  assert.deepEqual(window.json.items.map((t: any) => t.threadId), [ids.quatre], 'inclusif en bas, exclusif en haut');
  const tied = await call(agent, 'GET', `${threadsPath}?limit=100`);
  const order = tied.json.items.filter((t: any) => t.createdAt === tie).map((t: any) => t.threadId);
  assert.deepEqual(order, [ids.quatre, ids.cinq].sort(), 'égalité départagée par threadId');

  // Bornes plus précises que la milliseconde : deux fils au plus bas, quatre une milliseconde plus tard.
  const six = [ids.global, ids.cible, ids.wording, ids.quatre, ids.cinq, ids.nouveau] as string[];
  assert.equal(await count('SELECT COUNT(*) AS n FROM threads WHERE project_id = ? AND review_key = ?', PROJECT, REVIEW), 6);
  const counted: Record<string, unknown> = {};
  for (const [low, high, bounds] of [
    ['2026-10-18T10:00:00.000Z', '2026-10-18T10:00:00.001Z', [['2026-10-18T10:00:00.0001Z', 4, 2], ['2026-10-18T10:00:00.0000Z', 6, 0], ['2026-10-18T10:00:00Z', 6, 0]]],
    ['2026-10-18T23:59:59.999Z', '2026-10-19T00:00:00.000Z', [['2026-10-18T23:59:59.9999Z', 4, 2], ['2026-10-18T23:59:59.9990Z', 6, 0]]],
    // Fin de l'an 9999 contre six fils ordinaires de 2026 : la borne arrondie de .9999Z ne doit pas passer avant eux.
    ['2026-10-18T10:00:00.000Z', '2026-10-18T10:00:00.001Z', [['9999-12-31T23:59:59.999Z', 0, 6], ['9999-12-31T23:59:59.9990Z', 0, 6], ['9999-12-31T23:59:59.9999Z', 0, 6]]],
  ] as const) {
    await db.prepare('UPDATE threads SET updated_at = CASE WHEN thread_id IN (?, ?) THEN ? ELSE ? END WHERE thread_id IN (?, ?, ?, ?, ?, ?)').bind(six[0], six[1], low, high, ...six).run();
    for (const [value, nSince, nBefore] of bounds) {
      const s = await call(agent, 'GET', `${threadsPath}?updatedSince=${value}&limit=100`);
      const b = await call(agent, 'GET', `${threadsPath}?updatedBefore=${value}&limit=100`);
      assert.deepEqual([s.status, s.json.total, b.status, b.json.total], [200, nSince, 200, nBefore], value);
      assert.deepEqual([s.json.filter, b.json.filter], [{ updatedSince: value }, { updatedBefore: value }], 'filtre rendu tel qu’envoyé');
      counted[value] = { updatedSince: s.json.total, updatedBefore: b.json.total };
    }
  }
  facts.datesSousMilliseconde = counted;
});

test('lecture agent : JSON texte avec contexte, une capture téléchargée seule par identifiant', async () => {
  const page = await call(agent, 'GET', `${threadsPath}?limit=100`);
  const raw = JSON.stringify(page.json);
  assert.doesNotMatch(raw, /base64|data:image|PNG/);
  const byId = new Map(page.json.items.map((t: any) => [t.threadId, t]));
  const g: any = byId.get(ids.global);
  assert.deepEqual([g.kind, g.target, g.capture, g.proposal], ['global', null, null, null]);
  const c: any = byId.get(ids.cible);
  assert.equal(c.target.selector, 'button[data-socrate-id="modal-enregistrer"]');
  assert.deepEqual(Object.keys(c.capture).sort(), ['captureId', 'contentType', 'height', 'sha256', 'size', 'status', 'width']);
  assert.equal(c.capture.status, 'available');
  const w: any = byId.get(ids.wording);
  assert.equal(w.proposal.sourceRevisionId, revisionId);
  assert.equal(w.proposal.wording.id, 'rappel-sms');
  assert.equal(w.proposal.replacement, 'SMS de rappel {delai} avant.');
  assert.equal(w.proposal.drift.status, 'current');

  const file = join(bench.root, 'capture.png');
  const out = await example('capture', { CAPTURE_ID: c.capture.captureId, CAPTURE_FILE: file });
  assert.equal(out.split(/\s+/)[0], sha(imageBytes));
  assert.equal(c.capture.sha256, sha(imageBytes));
  facts.capture = { sha256Annonce: c.capture.sha256, sha256Telecharge: out.split(/\s+/)[0], octets: (await readFile(file)).byteLength, jsonOctets: raw.length, base64: /base64/.test(raw) };
  const res = await fetch(`${agent.url}${base}/captures/${c.capture.captureId}`, { headers: { Authorization: `Bearer ${agent.token}` } });
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('content-type'), 'image/png');
});

test('lecture agent : un autre projet ne lit ni la discussion ni l’image, l’accès est en lecture seule', async () => {
  const other = { url: bench.service.url, token: await readFile(otherTokenFile, 'utf8') };
  const captureId = (await call(agent, 'GET', `${threadsPath}/${ids.cible}`)).json.capture.captureId;
  for (const path of [`/v1/projects/${PROJECT}/reviews`, threadsPath, `${threadsPath}/${ids.cible}`, `${base}/changes?since=${noMarker}`, `${base}/captures/${captureId}`]) {
    const r = await call(other, 'GET', path);
    assert.equal(r.status, 403, path);
    assert.equal(r.json.code, 'forbidden');
  }
  assert.deepEqual((await exampleJson('revues', { SOCRATE_PROJECT: 'autre' }, otherTokenFile)).items, [], 'son propre projet est vide');

  const threads = await count('SELECT COUNT(*) AS n FROM threads');
  const messages = await count('SELECT COUNT(*) AS n FROM messages');
  const operations = await count('SELECT COUNT(*) AS n FROM operations');
  assert.equal((await example('ecriture-refusee')).trim(), '403');
  facts.refus = { autreProjet: 5, ecrituresLectureSeule: 7 };
  const writes: Array<[string, string, unknown?]> = [
    ['POST', `${threadsPath}/${ids.global}/messages`, { body: 'non' }],
    ['PUT', `${threadsPath}/${ids.global}/state`, { state: 'resolved', expectedVersion: 0 }],
    ['POST', `${base}/targeted`, {}],
    ['POST', `${base}/captures/${captureId}/commit`, { attempt: 'a'.repeat(16) }],
    ['PUT', `${base}/deployments/local-2`, {}],
  ];
  for (const [method, path, body] of writes) {
    const r = await call(agent, method, path, body, { 'Idempotency-Key': key() });
    assert.equal(r.status, 403, `${method} ${path}`);
  }
  const put = await fetch(`${agent.url}${base}/captures/${captureId}?attempt=${'a'.repeat(16)}`, { method: 'PUT', headers: { Authorization: `Bearer ${agent.token}`, 'Content-Type': 'image/png' }, body: png('x') as BodyInit });
  assert.equal(put.status, 403);
  assert.deepEqual([await count('SELECT COUNT(*) AS n FROM threads'), await count('SELECT COUNT(*) AS n FROM messages'), await count('SELECT COUNT(*) AS n FROM operations')], [threads, messages, operations]);
  assert.equal((await call(claire, 'GET', `${base}/changes?since=${noMarker}`)).status, 403, 'une session ne lit pas le journal');
});

test('revue inconnue : 404 sans liste technique ; revue existante sans fil : 200 vide', async () => {
  const listings = await count('SELECT COUNT(*) AS n FROM listings');
  const unknown = `/v1/projects/${PROJECT}/reviews/inexistante`;
  for (const path of [`${unknown}/threads`, `${unknown}/threads?state=open&limit=2`, `${unknown}/changes?since=${noMarker}`]) {
    const r = await call(agent, 'GET', path);
    assert.deepEqual([r.status, r.json.code], [404, 'not_found'], path);
  }
  assert.equal((await exampleJson('retours-ouverts', { SOCRATE_REVIEW: 'inexistante' })).code, 'not_found', 'exemple du guide sur une faute de nom');
  const afterUnknown = await count('SELECT COUNT(*) AS n FROM listings');
  assert.equal(afterUnknown, listings, 'aucune liste technique fantôme');
  const empty = await exampleJson('retours-ouverts', { SOCRATE_REVIEW: REVIEW2 });
  assert.deepEqual([empty.total, empty.items, empty.nextCursor], [0, [], null]);
  const quiet = await exampleJson('changements', { SOCRATE_REVIEW: REVIEW2, MARKER: empty.changesSince });
  assert.deepEqual(quiet, { items: [], next: empty.changesSince, more: false });
  facts.revueInconnue = { liste: 404, journal: 404, listesAvant: listings, listesApres: afterUnknown, revueVide: { statut: 200, total: empty.total, journal: quiet.items.length } };
});

test('marqueur lié à la revue : autre portée refusée, aucune perte dans la bonne malgré des événements intercalés', async () => {
  const db = bench.service.db;
  const post2 = async (body: string) => {
    const r = await call(claire2, 'POST', `${base2}/threads`, { kind: 'global', body }, { 'Idempotency-Key': key() });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    return r.json.threadId as string;
  };
  const a0 = (await call(agent, 'GET', `${threadsPath}?limit=1`)).json.changesSince;
  const b0 = (await call(agent, 'GET', `${base2}/threads?limit=1`)).json.changesSince;
  assert.notEqual(a0.split('.')[2], b0.split('.')[2], 'portées distinctes');
  // A, B, B, A, B : la séquence globale du journal entrelace les deux revues.
  const a1 = await global(claire, 'Revue A, avant B.');
  const b1 = await post2('Revue B, premier.');
  assert.equal((await call(claire2, 'POST', `${base2}/threads/${b1}/messages`, { body: 'Revue B, réponse.' }, { 'Idempotency-Key': key() })).status, 201);
  assert.equal((await reply(karim, a1, 'Revue A, entre deux événements de B.')).status, 201);
  const b3 = await post2('Revue B, dernier.');

  const a = await exampleJson('changements', { MARKER: a0 });
  assert.deepEqual(a.items.map((t: any) => t.threadId), [a1]);
  for (const marker of [a0, a.next]) {
    const wrong = await exampleJson('changements', { SOCRATE_REVIEW: REVIEW2, MARKER: marker });
    assert.deepEqual([wrong.code, wrong.message], ['invalid_request', 'marqueur émis pour une autre revue'], marker);
  }
  const epoch = b0.split('.')[1];
  const legacy = await call(agent, 'GET', `${base2}/changes?since=c1.${epoch}.0`);
  assert.deepEqual([legacy.status, legacy.json.code, legacy.json.retryable], [410, 'resync_required', false]);
  assert.match(legacy.json.message, /c1 sans portée/);

  const seen: string[] = [];
  let entries = 0;
  let pages = 0;
  for (let since = b0, more = true; more; pages++) {
    const page = await call(agent, 'GET', `${base2}/changes?since=${since}&limit=1`);
    assert.equal(page.status, 200);
    assert.equal(page.json.next.split('.')[2], b0.split('.')[2], 'next garde la portée de B');
    entries += Number(page.json.next.split('.')[3]) > Number(since.split('.')[3]) ? 1 : 0;
    seen.push(...page.json.items.map((t: any) => t.threadId));
    since = page.json.next;
    more = page.json.more;
  }
  const journal = (await db.prepare('SELECT seq, review_key FROM changes WHERE project_id = ? AND seq > ? ORDER BY seq').bind(PROJECT, Number(a0.split('.')[3])).all<{ seq: number; review_key: string }>()).results;
  const bSeqs = journal.filter((e) => e.review_key === REVIEW2).map((e) => e.seq);
  assert.equal(entries, bSeqs.length, 'chaque entrée de B lue une fois');
  assert.deepEqual([...new Set(seen)], [b1, b3]);
  const lastA = Number(a.next.split('.')[3]);
  assert.ok(bSeqs.some((q) => q < lastA), 'un marqueur de A réutilisé sur B aurait sauté des entrées de B');
  facts.porteeMarqueur = {
    ordreJournal: journal.map((e) => (e.review_key === REVIEW ? 'A' : 'B')).join(''),
    entreesB: bSeqs.length, entreesBAvantDernierA: bSeqs.filter((q) => q < lastA).length, pagesB: pages,
    refusAutrePortee: 2, marqueurC1: legacy.status,
  };
});

test('curseurs et marqueurs : bornes, filtres figés, expiration et epoch', async () => {
  const p1 = await call(agent, 'GET', `${threadsPath}?state=open&limit=1`);
  for (const q of ['limit=0', 'limit=101', 'state=ouvert', 'updatedSince=hier', 'updatedSince=2026-10-18T12:00:00%2B02:00', 'state=open&state=resolved', 'inconnu=1', `cursor=${p1.json.nextCursor}&state=resolved`, 'cursor=l1.zz.1']) {
    const r = await call(agent, 'GET', `${threadsPath}?${q}`);
    assert.equal(r.status, 422, q);
    assert.equal(r.json.code, 'invalid_request');
  }
  assert.equal((await call(agent, 'GET', `${threadsPath}?cursor=l1.${'0'.repeat(32)}.1`)).status, 410);
  assert.equal((await call(agent, 'GET', `${threadsPath}?cursor=${p1.json.nextCursor.replace(/\.\d+$/, '.999')}`)).status, 422);
  const [, listing] = p1.json.nextCursor.split('.');
  assert.equal((await call(agent, 'GET', `${base2}/threads?cursor=${p1.json.nextCursor}`)).status, 422, 'curseur d’une autre revue');
  await bench.service.db.prepare('UPDATE listings SET expires_at = 0 WHERE listing_id = ?').bind(listing).run();
  const expired = await call(agent, 'GET', `${threadsPath}?cursor=${p1.json.nextCursor}`);
  assert.deepEqual([expired.status, expired.json.code, expired.json.retryable], [410, 'resync_required', false]);

  const p2 = await call(agent, 'GET', `${threadsPath}?limit=1`);
  await bench.service.db.prepare("UPDATE sync_epoch SET epoch = lower(hex(randomblob(16))) WHERE singleton = 1").run();
  assert.equal((await call(agent, 'GET', `${threadsPath}?cursor=${p2.json.nextCursor}`)).json.code, 'resync_required');
  assert.equal((await call(agent, 'GET', `${base}/changes?since=${p2.json.changesSince}`)).status, 410);
  const fresh = await call(agent, 'GET', `${threadsPath}?limit=1`);
  assert.equal((await call(agent, 'GET', `${base}/changes?since=${fresh.json.changesSince}`)).status, 200, 'reprise depuis le premier appel');
  assert.equal((await call(agent, 'GET', `${base}/changes?since=c1.bad.1`)).status, 422);
  assert.equal(p1.headers.get('cache-control'), 'no-store');
});

test('mutations concurrentes du premier appel : membres égaux à la reconstruction du journal au plafond, incrémental exact après', async () => {
  const db = bench.service.db;
  const seqOf = async (threadId: string, kind: string) => (await db.prepare('SELECT MAX(seq) AS n FROM changes WHERE thread_id = ? AND kind = ?').bind(threadId, kind).first<{ n: number }>())!.n;
  const before = await call(agent, 'GET', `${threadsPath}?limit=100`);
  const open = before.json.items.filter((t: any) => t.state === 'open');
  assert.ok(open.length >= 5, `fils ouverts pour les écritures concurrentes : ${open.length}`);
  // Événements connus avant le premier appel : un fil créé reste ouvert, un autre est résolu.
  const keptOpen = await global(claire, 'Avant le plafond, ouvert.');
  const closedBefore = await global(claire, 'Avant le plafond, résolu.');
  assert.equal((await setState(karim, closedBefore, 'resolved', 0)).status, 200);
  const writes = [
    ...Array.from({ length: 6 }, (_, i) => global(claire, `Concurrent ${i}.`)),
    ...open.slice(0, 3).map((t: any) => setState(karim, t.threadId, 'resolved', t.version)),
    ...open.slice(3, 5).map((t: any) => reply(karim, t.threadId, 'Réponse concurrente.')),
  ];
  const [first] = await Promise.all([call(agent, 'GET', `${threadsPath}?state=open&limit=3`), ...writes]);
  assert.equal(first.status, 200);
  // Événements connus après le premier appel : réponse à un membre, création d'un fil.
  assert.equal((await reply(karim, keptOpen, 'Après le plafond.')).status, 201);
  const createdAfter = await global(claire, 'Après le plafond.');

  const listed: string[] = first.json.items.map((t: any) => t.threadId);
  for (let cursor = first.json.nextCursor; cursor; ) {
    const page = await call(agent, 'GET', `${threadsPath}?cursor=${cursor}&limit=3`);
    listed.push(...page.json.items.map((t: any) => t.threadId));
    cursor = page.json.nextCursor;
  }
  assert.equal(new Set(listed).size, listed.length);
  assert.equal(listed.length, first.json.total);
  const changed = new Set<string>();
  for (let since = first.json.changesSince, more = true; more; ) {
    const page = await call(agent, 'GET', `${base}/changes?since=${since}&limit=2`);
    for (const t of page.json.items) changed.add(t.threadId);
    since = page.json.next;
    more = page.json.more;
  }
  const ceiling = Number(first.json.changesSince.split('.').at(-1));

  // Reconstruction indépendante : membre si créé au plafond et ouvert selon sa dernière transition au plafond.
  const atCeiling = (await db.prepare('SELECT thread_id, kind FROM changes WHERE project_id = ? AND review_key = ? AND seq <= ? ORDER BY seq').bind(PROJECT, REVIEW, ceiling).all<{ thread_id: string; kind: string }>()).results;
  const stateAt = new Map<string, string>();
  for (const e of atCeiling) {
    if (e.kind === 'thread.created') stateAt.set(e.thread_id, 'open');
    if (e.kind === 'thread.open' || e.kind === 'thread.resolved') stateAt.set(e.thread_id, e.kind.slice('thread.'.length));
  }
  const members = [...stateAt].filter(([, state]) => state === 'open').map(([id]) => id);
  const expected = (await db.prepare('SELECT thread_id FROM threads WHERE project_id = ? AND review_key = ? AND thread_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, thread_id').bind(PROJECT, REVIEW, JSON.stringify(members)).all<{ thread_id: string }>()).results.map((r) => r.thread_id);
  assert.deepEqual(listed, expected, 'appartenance et ordre égaux à la reconstruction au plafond');

  const knownBefore = [await seqOf(keptOpen, 'thread.created'), await seqOf(closedBefore, 'thread.resolved')];
  const knownAfter = [await seqOf(keptOpen, 'message.created'), await seqOf(createdAfter, 'thread.created')];
  assert.ok(knownBefore.every((q) => q <= ceiling) && knownAfter.every((q) => q > ceiling), `connus ${knownBefore} ≤ ${ceiling} < ${knownAfter}`);
  assert.ok(listed.includes(keptOpen) && !listed.includes(closedBefore) && !listed.includes(createdAfter));
  assert.ok(changed.has(keptOpen) && changed.has(createdAfter) && !changed.has(closedBefore));

  const late = (await db.prepare('SELECT DISTINCT thread_id FROM changes WHERE project_id = ? AND review_key = ? AND seq > ?').bind(PROJECT, REVIEW, ceiling).all<{ thread_id: string }>()).results.map((r) => r.thread_id);
  assert.deepEqual([...changed].sort(), late.sort());
  const createdLate = (await db.prepare("SELECT thread_id FROM changes WHERE project_id = ? AND review_key = ? AND seq > ? AND kind = 'thread.created'").bind(PROJECT, REVIEW, ceiling).all<{ thread_id: string }>()).results.map((r) => r.thread_id);
  for (const id of createdLate) assert.ok(!listed.includes(id), `fil ${id} créé après le plafond mais membre`);
  const nowOpen = (await db.prepare("SELECT thread_id FROM threads WHERE project_id = ? AND review_key = ? AND state = 'open'").bind(PROJECT, REVIEW).all<{ thread_id: string }>()).results.map((r) => r.thread_id);
  for (const id of nowOpen) assert.ok(listed.includes(id) || changed.has(id), `fil ouvert ${id} perdu`);

  // Entrées des seules écritures concurrentes, entre le dernier événement connu avant et le premier connu après.
  const concurrent = (await db.prepare('SELECT seq FROM changes WHERE project_id = ? AND review_key = ? AND seq > ? AND seq < ?').bind(PROJECT, REVIEW, Math.max(...knownBefore), Math.min(...knownAfter)).all<{ seq: number }>()).results.map((r) => r.seq);
  assert.equal(concurrent.length, writes.length, 'une entrée par écriture concurrente');
  facts.concurrence = {
    plafond: ceiling, membres: listed.length, reconstruits: expected.length, incremental: changed.size,
    connusAvant: knownBefore.length, connusApres: knownAfter.length,
    concurrentesAvantPlafond: concurrent.filter((q) => q <= ceiling).length, concurrentesApresPlafond: concurrent.filter((q) => q > ceiling).length,
  };
});

test('critère 9 : après révocation réelle du déploiement d’origine, l’accès technique lit encore fils, journal et image', async () => {
  const listAll = async () => {
    const r = await call(agent, 'GET', `${threadsPath}?limit=100`);
    assert.equal(r.status, 200);
    return r.json;
  };
  const marker = (await listAll()).changesSince;
  const g = await global(claire, 'Proposition globale avant révocation.');
  const cBytes = png('critere-9');
  const c = await targeted(claire, cBytes, { replacement: 'Enregistrer ce rappel', revisionId });
  const w = await global(claire, 'Plus direct.', { wordingId: 'rappel-sms', replacement: 'Rappel SMS {delai} avant.', revisionId });
  assert.equal((await reply(karim, g, 'Réponse avant révocation.')).status, 201);
  const mine = (page: any) => page.items.filter((t: any) => [g, c, w].includes(t.threadId));
  const listBefore = await listAll();
  const journalBefore = await exampleJson('changements', { MARKER: marker });
  assert.deepEqual(journalBefore.items.map((t: any) => t.threadId).sort(), [g, c, w].sort());
  const wBefore = mine(listBefore).find((t: any) => t.threadId === w);
  assert.deepEqual(wBefore.proposal.drift, { status: 'current', revisionId });

  const deployments = await count('SELECT COUNT(*) AS n FROM deployments WHERE project_id = ? AND review_key = ?', PROJECT, REVIEW);
  assert.equal(deployments, 1, 'local-1 est à la fois le déploiement d’origine et le plus récent');
  const revoked = await call({ url: bench.service.url, token: bench.importToken }, 'POST', `${base}/deployments/local-1/revoke`);
  assert.equal(revoked.status, 200, JSON.stringify(revoked.json));
  assert.equal(revoked.json.deploymentId, 'local-1');
  assert.equal((await call(agent, 'POST', `${base}/deployments/local-1/revoke`)).status, 403, 'review.read ne révoque pas');
  const refused = await call(claire, 'GET', threadsPath);
  assert.deepEqual([refused.status, refused.json.code], [403, 'forbidden'], 'la session du déploiement révoqué est refusée');
  await assert.rejects(sessionClient(bench, { deploymentId: 'local-1' }), /session refusée: 403/, 'aucune nouvelle session sur l’origine révoquée');

  const listAfter = await listAll();
  assert.deepEqual(listAfter.items, listBefore.items, 'mêmes fils, messages, cibles, propositions et captures');
  assert.equal(listAfter.total, listBefore.total);
  const pages: string[] = [];
  for (let page = await exampleJson('retours-ouverts'); ; page = await exampleJson('page-suivante', { CURSOR: page.nextCursor })) {
    pages.push(...page.items.map((t: any) => t.threadId));
    if (!page.nextCursor) break;
  }
  assert.ok([g, c, w].every((id) => pages.includes(id)), 'les exemples du guide listent les trois fils');
  const journalAfter = await exampleJson('changements', { MARKER: marker });
  assert.deepEqual(journalAfter, journalBefore, 'journal relu depuis le même marqueur, identique');
  const after = mine(listAfter);
  const wAfter = after.find((t: any) => t.threadId === w);
  assert.deepEqual([wAfter.proposal.original, wAfter.proposal.sourceRevisionId, wAfter.proposal.drift], [wBefore.proposal.original, revisionId, { status: 'current', revisionId }], 'référence du décalage : révision du dernier déploiement importé, même révoqué');
  assert.ok(after.every((t: any) => t.deploymentId === 'local-1' && t.revisionId === revisionId), 'origine historique conservée');
  const cAfter = after.find((t: any) => t.threadId === c);
  assert.deepEqual([cAfter.proposal.original, cAfter.proposal.sourceRevisionId, cAfter.proposal.drift], ['Enregistrer le rappel', revisionId, null], 'original de page pris de la cible');
  const file = join(bench.root, 'capture-critere-9.png');
  const out = await example('capture', { CAPTURE_ID: cAfter.capture.captureId, CAPTURE_FILE: file });
  assert.equal(out.split(/\s+/)[0], sha(cBytes));
  assert.equal(cAfter.capture.sha256, sha(cBytes));
  facts.critere9 = {
    revoque: revoked.json.deploymentId, sessionApres: refused.status, nouvelleSession: 403, deploiementsRevue: deployments,
    fils: after.map((t: any) => ({ kind: t.kind, state: t.state, messages: t.messages.length, proposal: t.proposal ? { original: t.proposal.original, sourceRevisionId: t.proposal.sourceRevisionId, drift: t.proposal.drift } : null })),
    listeIdentique: true, journal: journalAfter.items.length, journalIdentique: true, sha256Annonce: cAfter.capture.sha256, sha256Telecharge: out.split(/\s+/)[0],
  };
});

test('aucun dépôt ne déclenche d’appel sortant', () => {
  assert.deepEqual(bench.service.egress, []);
  facts.sortiesWorker = bench.service.egress.length;
});
