import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import type { PurgeReport } from '@socrate/contract';
import { assembleManifest } from '@socrate/contract/assemble';
import { call, claimOrThrow, closeHeld, demoManifest, key, newRoot, rt, startHeld, workerBuilt, assertionFor, ORIGIN, PROJECT, REVIEW, ISSUER, type Bench, type Client } from './helpers.ts';
import { REPO_ROOT } from '../../../tools/local/local-run.ts';
import { exportBackup, freeze, restoreBackup, thaw, verifyBackup } from '../../../tools/local/backup.ts';
import { Maintenance, purgeProject } from '../../../tools/local/maintenance.ts';

const DAY = 86_400_000;
const SHARED = 'revue-partagee';
const RACE = 'revue-course';
const CONC = 'revue-concurrente';
const base = (r: string, p = PROJECT) => `/v1/projects/${p}/reviews/${r}`;
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const png = (seed: string) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode(`image fictive ${seed} `.repeat(40))]);
/** Faits sans secret, écrits sous `SOCRATE_OPERATIONS_FACTS_OUT` quand la variable est fournie. */
const facts: Record<string, unknown> = {};

type Svc = Awaited<ReturnType<typeof startHeld>>;
type Db = Svc['db'];
let svc: Svc;
let mainRoot: string;
let mainClaim: ReturnType<typeof claimOrThrow>;
let raceClient: Client;
const inflight: { captureId: string; attempt: string; bytes: Uint8Array }[] = [];
let keys: Awaited<ReturnType<typeof rt.generateIssuerKeys>>;
let projects: Parameters<typeof rt.startService>[0]['projects'];
const tok: Record<string, string> = {};
let claire: Client;
let karim: Client;
let j0: number;
const ids: Record<string, string> = {};
let imageBytes: Uint8Array;
let oldCursor: string;
let oldMarker: string;

const benchOf = (s: Svc) => ({ service: s, keys, importToken: tok.import }) as unknown as Bench;
const as = (token: string, s = svc): Client => ({ url: s.url, token });
async function session(reviewKey: string, deploymentId: string, over: Record<string, unknown> = {}): Promise<Client> {
  const assertion = assertionFor(benchOf(svc), { deploymentId, reviewKey, ...over } as never);
  const r = await call({ url: svc.url, origin: ORIGIN }, 'POST', '/v1/auth/session', { assertion });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return { url: svc.url, token: r.json.sessionToken, origin: ORIGIN };
}
async function importInto(reviewKey: string, deploymentId: string, projectId = PROJECT, token = tok.import!, manifest?: unknown) {
  return call(as(token), 'PUT', `${base(reviewKey, projectId)}/deployments/${deploymentId}`, { commit: 'a1b2c3d4e5f6', buildId: '0042', url: `${ORIGIN}/`, manifest: manifest ?? { ...(await demoManifest()), reviewKey } });
}
const publish = (c: Client, r: string, body: string, proposal?: unknown) => call(c, 'POST', `${base(r)}/threads`, { kind: 'global', body, ...(proposal ? { proposal } : {}) }, { 'Idempotency-Key': key() });
async function reserve(c: Client, r: string, bytes: Uint8Array, proposal?: unknown, upload = true) {
  const res = await call(c, 'POST', `${base(r)}/targeted`, {
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
  assert.equal(res.status, 201, JSON.stringify(res.json));
  if (!upload) return res.json as { captureId: string; attempt: string };
  const put = await fetch(`${c.url}${base(r)}/captures/${res.json.captureId}?attempt=${res.json.attempt}`, {
    method: 'PUT', headers: { Authorization: `Bearer ${c.token}`, Origin: c.origin!, 'Content-Type': 'image/png' }, body: bytes as BodyInit,
  });
  assert.equal(put.status, 200);
  return res.json as { captureId: string; attempt: string };
}
async function targeted(c: Client, r: string, bytes: Uint8Array, proposal?: unknown) {
  const res = await reserve(c, r, bytes, proposal);
  const done = await call(c, 'POST', `${base(r)}/captures/${res.captureId}/commit`, { attempt: res.attempt });
  assert.equal(done.status, 201, JSON.stringify(done.json));
  return done.json as { threadId: string; capture: { captureId: string } };
}
const countIn = async (db: Db, sql: string, ...b: unknown[]) => (await db.prepare(sql).bind(...b).first<{ n: number }>())!.n;
const count = (sql: string, ...b: unknown[]) => countIn(svc.db, sql, ...b);
const reviewRow = (r: string, db = svc.db) => db.prepare('SELECT state, archived_at, purge_after, purged_at FROM reviews WHERE project_id = ? AND review_key = ?').bind(PROJECT, r).first<Record<string, string | null>>();
const purgeAt = (m: Maintenance, now: number, token = tok.archive!) => purgeProject(m, { projectId: PROJECT, token, now });
const captureKey = (r: string, captureId: string) => `captures/${PROJECT}/${r}/${captureId}.png`;

async function interactive() {
  mainClaim = claimOrThrow(mainRoot);
  svc = await startHeld({ root: mainRoot, projects });
  for (const c of [claire, karim, raceClient]) if (c) c.url = svc.url;
}

/** Arrêt confirmé de l'instance interactive et libération de sa racine, phase de maintenance exclusive, puis reprise interactive. */
async function maintained<T>(work: (m: Maintenance) => Promise<T>): Promise<T> {
  await svc.stop();
  mainClaim.release();
  try {
    return await Maintenance.run(mainRoot, work);
  } finally {
    await interactive();
  }
}

/** PUT HTTP réel dont le corps reste à moitié envoyé tant que `finish` n'est pas appelé : un écrivain en vol possédé par le test. */
async function putInFlight(c: Client, r: string, res: { captureId: string; attempt: string; bytes: Uint8Array }) {
  const u = new URL(`${c.url}${base(r)}/captures/${res.captureId}?attempt=${res.attempt}`);
  const req = httpRequest({ host: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, method: 'PUT', headers: { Authorization: `Bearer ${c.token}`, Origin: c.origin!, 'Content-Type': 'image/png', 'Content-Length': res.bytes.byteLength } });
  const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
    req.on('response', (incoming) => {
      let body = '';
      incoming.setEncoding('utf8');
      incoming.on('data', (d: string) => { body += d; });
      incoming.on('end', () => resolve({ status: incoming.statusCode!, body }));
    });
    req.on('error', reject);
  });
  await new Promise<void>((resolve, reject) => req.write(res.bytes.subarray(0, 16), (e) => (e ? reject(e) : resolve())));
  return { finish: () => { req.end(res.bytes.subarray(16)); return response; } };
}

/** Maintenance tentée pendant que le PUT est en vol, puis fin du PUT : le refus et l'écriture effective sont tous deux observés. */
async function refusedWhileWriting(r: string, res: (typeof inflight)[number]) {
  const writer = await putInFlight(raceClient, r, res);
  let refusal: unknown;
  let put: { status: number; body: string };
  try {
    refusal = await Maintenance.run(mainRoot, async () => 'exécutée').then((v) => v, (e: Error) => e);
  } finally {
    put = await writer.finish();
  }
  assert.ok(refusal instanceof Error && /en service/.test(refusal.message), String(refusal));
  return { refusal: (refusal as Error).message, put };
}

before(async () => {
  await workerBuilt;
  mainRoot = await newRoot('ops-');
  mainClaim = claimOrThrow(mainRoot);
  keys = await rt.generateIssuerKeys();
  const other = await rt.generateIssuerKeys();
  projects = [
    { projectId: PROJECT, issuer: ISSUER, publicJwk: keys.publicJwk, attestableCapabilities: ['thread.participate', 'thread.moderate', 'review.archive'] },
    { projectId: 'autre', issuer: 'autre-host', publicJwk: other.publicJwk, attestableCapabilities: ['thread.participate'] },
  ];
  svc = await startHeld({ root: mainRoot, projects });
  tok.import = await rt.provisionCredential(svc.db, { projectId: PROJECT, label: 'ci-demo', capabilities: ['deployment.import'] });
  tok.agent = await rt.provisionCredential(svc.db, { projectId: PROJECT, label: 'agent-demo', capabilities: ['review.read'] });
  tok.archive = await rt.provisionCredential(svc.db, { projectId: PROJECT, label: 'archivage-demo', capabilities: ['review.archive'] });
  tok.archiveAutre = await rt.provisionCredential(svc.db, { projectId: 'autre', label: 'archivage-autre', capabilities: ['review.archive'] });
  tok.importAutre = await rt.provisionCredential(svc.db, { projectId: 'autre', label: 'ci-autre', capabilities: ['deployment.import'] });
  const imported = await importInto(REVIEW, 'local-1');
  assert.equal(imported.status, 201);
  const revisionId = imported.json.revisionId as string;
  ids.revision = revisionId;
  assert.equal((await importInto(SHARED, 'local-p')).status, 201);
  assert.equal((await importInto(RACE, 'local-c')).status, 201);
  assert.equal((await importInto(CONC, 'local-x')).status, 201);
  const autre = await importInto(REVIEW, 'autre-1', 'autre', tok.importAutre, await demoManifest());
  assert.equal(autre.status, 201);
  assert.equal(autre.json.revisionId, revisionId, 'même contenu, même révision dans un autre projet');
  claire = await session(REVIEW, 'local-1');
  karim = await session(REVIEW, 'local-1', { sub: 'karim', name: 'Karim Benali', capabilities: ['thread.participate', 'thread.moderate'] });
  const g = await publish(claire, REVIEW, 'Le résumé des rappels manque de contexte.');
  assert.equal(g.status, 201);
  ids.global = g.json.threadId;
  const rep = await call(karim, 'POST', `${base(REVIEW)}/threads/${ids.global}/messages`, { body: 'Ajouté en v2, merci.' }, { 'Idempotency-Key': key() });
  assert.equal(rep.status, 201);
  imageBytes = png('archive');
  const t = await targeted(claire, REVIEW, imageBytes, { replacement: 'Enregistrer ce rappel', revisionId });
  ids.targeted = t.threadId;
  ids.capture = t.capture.captureId;
  const w = await publish(claire, REVIEW, 'Plus court.', { wordingId: 'rappel-sms', replacement: 'SMS de rappel {delai} avant.', revisionId });
  assert.equal(w.status, 201, JSON.stringify(w.json));
  ids.wording = w.json.threadId;
  const shared = await targeted(await session(SHARED, 'local-p'), SHARED, imageBytes);
  ids.sharedCapture = shared.capture.captureId;
  await targeted(await session(CONC, 'local-x'), CONC, png('concurrente'));
  const page = await call(as(tok.agent!), 'GET', `${base(REVIEW)}/threads?limit=1`);
  assert.equal(page.status, 200);
  oldCursor = page.json.nextCursor;
  oldMarker = page.json.changesSince;
  assert.ok(oldCursor && oldMarker);
});

after(async () => {
  if (process.env.SOCRATE_OPERATIONS_FACTS_OUT) await writeFile(process.env.SOCRATE_OPERATIONS_FACTS_OUT, JSON.stringify(facts, null, 1));
  await closeHeld();
});

test('critères 3 et 7 : seule review.archive archive et purge ; révoquer ou fermer une preview n’archive rien', async () => {
  const path = `${base(RACE)}/archive`;
  const refusals = [
    await call(as(tok.import!), 'POST', path), await call(as(tok.agent!), 'POST', path), await call(claire, 'POST', `${base(REVIEW)}/archive`),
    await call(as(tok.archiveAutre!), 'POST', path), await call(as(tok.import!), 'POST', `/v1/projects/${PROJECT}/purge`), await call(as(tok.agent!), 'POST', `/v1/projects/${PROJECT}/purge`),
    await call(claire, 'POST', `/v1/projects/${PROJECT}/purge`),
  ].map((r) => r.status);
  assert.deepEqual(refusals, [403, 403, 403, 403, 403, 403, 403]);
  const revoke = await call(as(tok.import!), 'POST', `${base(SHARED)}/deployments/local-p/revoke`);
  assert.equal(revoke.status, 200);
  assert.equal((await reviewRow(SHARED))!.state, 'active', 'révocation de la preview : revue toujours active');
  assert.equal(await count('SELECT COUNT(*) AS n FROM captures WHERE review_key = ?', SHARED), 1);
  facts.capacites = { refus: refusals, revocationArchive: false };
});

test('critère 1 : archivée à J0, lisible et sans écriture avant expiration, sélectionnée à J30 par défaut', async () => {
  const a = await call(as(tok.archive!), 'POST', `${base(REVIEW)}/archive`);
  assert.equal(a.status, 200, JSON.stringify(a.json));
  j0 = Date.parse(a.json.archivedAt);
  assert.equal(a.json.state, 'archived');
  const days = (Date.parse(a.json.purgeAfter) - Date.parse(a.json.archivedAt)) / DAY;
  assert.equal(days, 30);
  assert.match(a.json.purge, /purge manuelle disponible.*aucune purge planifiée n’est déployée/);
  const again = await call(as(tok.archive!), 'POST', `${base(REVIEW)}/archive`);
  assert.deepEqual([again.json.archivedAt, again.json.purgeAfter], [a.json.archivedAt, a.json.purgeAfter], 'second archivage sans effet');
  const writes = [
    (await publish(claire, REVIEW, 'Trop tard ?')).status,
    (await call(karim, 'POST', `${base(REVIEW)}/threads/${ids.global}/messages`, { body: 'encore' }, { 'Idempotency-Key': key() })).status,
    (await call(karim, 'PUT', `${base(REVIEW)}/threads/${ids.global}/state`, { state: 'resolved', expectedVersion: 0 }, { 'Idempotency-Key': key() })).status,
    (await call(claire, 'PUT', `${base(REVIEW)}/threads/${ids.global}/state`, { state: 'open', expectedVersion: 0 }, { 'Idempotency-Key': key() })).status,
    (await importInto(REVIEW, 'local-2')).status,
    (await call(claire, 'POST', `${base(REVIEW)}/targeted`, { kind: 'targeted' }, { 'Idempotency-Key': key() })).status,
  ];
  assert.deepEqual(writes, [409, 409, 409, 409, 409, 422]);
  const replay = await importInto(REVIEW, 'local-1');
  assert.deepEqual([replay.status, replay.json.review.state], [200, 'archived'], 'rejeu identique : état persisté, sans réactivation');
  assert.deepEqual(Object.values((await reviewRow(REVIEW))!).slice(0, 3), ['archived', a.json.archivedAt, a.json.purgeAfter], 'rejeu sans prolongation de la conservation');
  assert.equal(await count('SELECT COUNT(*) AS n FROM deployments WHERE project_id = ? AND review_key = ?', PROJECT, REVIEW), 1);
  const http = await call(as(tok.archive!), 'POST', `/v1/projects/${PROJECT}/purge`);
  assert.deepEqual([http.status, http.json.code], [409, 'maintenance'], 'instance en service : purge refusée');
  assert.match(http.json.message, /npm run sauvegarde -- purger.*aucune purge planifiée n’est déployée/);
  const list = await call(as(tok.agent!), 'GET', `${base(REVIEW)}/threads?limit=10`);
  assert.equal(list.json.total, 3, 'lisible à J29');
  assert.equal((await fetch(`${svc.url}${base(REVIEW)}/captures/${ids.capture}`, { headers: { Authorization: `Bearer ${tok.agent}` } })).status, 200);
  const reviews = await call(as(tok.agent!), 'GET', `/v1/projects/${PROJECT}/reviews`);
  assert.equal(reviews.json.items.find((r: any) => r.reviewKey === REVIEW).purgeAfter, a.json.purgeAfter);
  facts.archivage = { archivedAt: a.json.archivedAt, purgeAfter: a.json.purgeAfter, joursParDefaut: days, ecrituresRefusees: writes, rejeuImport: { status: replay.status, state: replay.json.review.state }, purgeHttp: { status: http.status, code: http.json.code, message: http.json.message } };
});

test('critère 2 : une conservation configurée change la date de purge', async () => {
  const root = await newRoot('ops-retention-');
  const claim = claimOrThrow(root);
  const s = await startHeld({ root, projects, archiveRetentionDays: 10 });
  const t = await rt.provisionCredential(s.db, { projectId: PROJECT, label: 'ci', capabilities: ['deployment.import'] });
  const ar = await rt.provisionCredential(s.db, { projectId: PROJECT, label: 'archive', capabilities: ['review.archive'] });
  assert.equal((await call(as(t, s), 'PUT', `${base(REVIEW)}/deployments/local-1`, { commit: 'a1b2c3d4e5f6', buildId: '1', url: `${ORIGIN}/`, manifest: await demoManifest() })).status, 201);
  const a = await call(as(ar, s), 'POST', `${base(REVIEW)}/archive`);
  const days = (Date.parse(a.json.purgeAfter) - Date.parse(a.json.archivedAt)) / DAY;
  assert.equal(days, 10);
  const at = Date.parse(a.json.archivedAt);
  await s.stop();
  claim.release();
  const [kept, purged] = await Maintenance.run(root, async (m) => [
    await purgeProject(m, { projectId: PROJECT, token: ar, now: at + 9 * DAY }),
    await purgeProject(m, { projectId: PROJECT, token: ar, now: at + 10 * DAY }),
  ]);
  assert.equal(kept!.entries[0]!.action, 'kept');
  assert.ok(purged!.entries.some((e) => e.action === 'deleted' && e.resource === 'revisions' && e.detail === '1'));
  assert.equal(purged!.complete, true);
  facts.conservationConfiguree = { jours: days };
});

test('course avec publication : archivage concurrent de huit publications, réservation téléversée non validée', async () => {
  const c = await session(RACE, 'local-c');
  raceClient = c;
  const pending = await reserve(c, RACE, png('reservee'));
  for (const seed of ['en-vol-export', 'en-vol-purge']) {
    const bytes = png(seed);
    inflight.push({ ...(await reserve(c, RACE, bytes, undefined, false)), bytes });
  }
  const results = await Promise.all([
    ...Array.from({ length: 8 }, (_, i) => publish(c, RACE, `retour concurrent ${i}`)),
    call(as(tok.archive!), 'POST', `${base(RACE)}/archive`),
  ]);
  const statuses = results.slice(0, 8).map((r) => r.status);
  assert.ok(statuses.every((s) => s === 201 || s === 409), JSON.stringify(statuses));
  assert.equal(results[8]!.status, 200);
  assert.equal((await call(as(tok.archive!), 'POST', `${base(CONC)}/archive`)).status, 200);
  const created = statuses.filter((s) => s === 201).length;
  assert.equal(await count('SELECT COUNT(*) AS n FROM threads WHERE review_key = ?', RACE), created, 'chaque 201 est durable, chaque 409 n’a rien écrit');
  assert.equal(await count('SELECT COUNT(*) AS n FROM changes WHERE review_key = ?', RACE), created);
  const commit = await call(c, 'POST', `${base(RACE)}/captures/${pending.captureId}/commit`, { attempt: pending.attempt });
  assert.equal(commit.status, 409);
  assert.equal(commit.json.code, 'review_inactive');
  const bucket = await svc.mf.getR2Bucket('CAPTURES');
  ids.reservedKey = captureKey(RACE, pending.captureId);
  assert.ok(await bucket.head(ids.reservedKey), 'objet temporaire téléversé avant la purge');
  facts.course = { statuts: statuses, crees: created, commitApresArchivage: commit.status };
});

test('gel : refus 503 lisible, écriture en vol avortée par la base, lecture de santé conservée', async () => {
  const c = await session(SHARED, 'local-p').catch(() => null);
  assert.equal(c, null, 'déploiement révoqué : pas de session');
  const since = await freeze(svc.db, 'preuve');
  const refused = await call(as(tok.agent!), 'GET', `${base(REVIEW)}/threads?limit=1`);
  assert.deepEqual([refused.status, refused.json.code, refused.json.retryable], [503, 'maintenance', true]);
  assert.equal((await fetch(`${svc.url}/v1/health`)).status, 200);
  await assert.rejects(svc.db.prepare("UPDATE reviews SET state = 'active', archived_at = NULL WHERE review_key = ?").bind(RACE).run(), /socrate_frozen/);
  await assert.rejects(svc.db.prepare("INSERT INTO changes (project_id, review_key, thread_id, kind, created_at) VALUES ('demo', 'x', 'y', 'z', 'now')").run(), /socrate_frozen/);
  await assert.rejects(freeze(svc.db, 'double'), /déjà gelée/);
  await thaw(svc.db);
  assert.equal((await call(as(tok.agent!), 'GET', `${base(REVIEW)}/threads?limit=1`)).status, 200);
  facts.gel = { depuis: since, refus: refused.json.code };
});

let backup: Awaited<ReturnType<typeof exportBackup>>;
let backupDigests: Record<string, string>;

test('critère 9, sauvegarde : refusée pendant un PUT en vol, puis export exclusif à inventaire stable', async () => {
  const dir = join(svc.root, 'sauvegardes', 'avant-purge');
  await assert.rejects(exportBackup(svc as never, dir), /maintenance exclusive/, 'un service interactif n’est pas une phase exclusive');
  const uncertain = await newRoot('ops-incertaine-');
  await rt.publishRecord(uncertain, { generation: 'g', pid: 1, startedAt: new Date().toISOString(), state: 'ready', ports: { service: 0, demo: 0 }, resources: { service: { phase: 'running', port: 1 } } });
  await assert.rejects(Maintenance.run(uncertain, async () => 0), /sans preuve de fermeture/, 'propriétaire disparu sans fermeture prouvée : refus');
  const during = await refusedWhileWriting(RACE, inflight[0]!);
  assert.equal(during.put.status, 200, during.put.body);
  const lateKey = captureKey(RACE, inflight[0]!.captureId);
  backup = await maintained((m) => exportBackup(m, dir));
  const m = backup.manifest;
  const rows = Object.fromEntries(m.tables.map((t) => [t.name, t.rows]));
  assert.equal(rows.threads, await count('SELECT COUNT(*) AS n FROM threads'));
  assert.equal(rows.captures, await count("SELECT COUNT(*) AS n FROM captures WHERE state = 'committed'"));
  assert.equal(m.objects.length, rows.captures);
  assert.deepEqual(m.objectsNotExported, [ids.reservedKey, lateKey].sort(), 'objets temporaires inventoriés après la fin du PUT en vol, non exportés');
  assert.match(m.retention, /suppression manuelle explicite/);
  assert.equal((await svc.db.prepare('SELECT frozen FROM maintenance').first<{ frozen: number }>())!.frozen, 0, 'dégelée après export');
  backupDigests = Object.fromEntries(await Promise.all([...m.tables.map((t) => t.file), ...m.objects.map((o) => o.file), 'manifest.json'].map(async (f) => [f, sha(await readFile(join(dir, f)))] as const)));
  await assert.rejects(maintained((x) => exportBackup(x, dir)), /déjà présent/);
  facts.sauvegarde = { manifestSha256: backup.manifestSha256, lignes: rows, objets: m.objects.map((o) => ({ sha256: o.sha256, size: o.size })), nonExportes: Object.keys(m.notExported), objetsTemporaires: m.objectsNotExported, refusPendantEcriture: during.refusal, putEnVol: during.put.status };
});

test('admission à l’exécution : constructeur appelé en JavaScript, objet recopié et handle périmé refusés avant tout effet ; phase nominale utilisable', async () => {
  const states = () => svc.db.prepare('SELECT review_key, state, purge_after FROM reviews ORDER BY review_key').all();
  const before = (await states()).results;
  const journal = () => count('SELECT COUNT(*) AS n FROM purge_log');
  const entries = await journal();
  const bucket = await svc.mf.getR2Bucket('CAPTURES');
  assert.equal(rt.claimRoot(svc.root), 'busy', 'instance interactive vivante, racine verrouillée');
  const falseRoot = join(svc.root, 'racine-non-possedee');
  for (const key of [undefined, Symbol('admission'), falseRoot]) {
    assert.throws(() => Reflect.construct(Maintenance, [key, falseRoot, svc, bucket]), /maintenance exclusive/, 'constructeur JavaScript sans la clé du module');
  }
  assert.equal(Reflect.set(Maintenance, 'assert', () => undefined), false, 'contrôle d’admission non remplaçable');
  const copied = Object.assign(Object.create(Maintenance.prototype), { root: svc.root, url: svc.url, db: svc.db, bucket });
  const refusals: Record<string, string> = {};
  const refuse = async (label: string, m: unknown) => {
    const dir = join(svc.root, 'sauvegardes', `refus-${label}`);
    await assert.rejects(exportBackup(m as Maintenance, dir), /maintenance exclusive/, `${label} : export`);
    await assert.rejects(purgeProject(m as Maintenance, { projectId: PROJECT, token: tok.archive! }), /maintenance exclusive/, `${label} : purge`);
    await assert.rejects(restoreBackup(m as Maintenance, join(svc.root, 'sauvegardes', 'avant-purge'), backup.manifestSha256), /maintenance exclusive/, `${label} : restauration`);
    assert.equal(existsSync(dir), false, `${label} : aucun dossier de sauvegarde`);
    refusals[label] = 'not_exclusive';
  };
  await refuse('service', svc);
  await refuse('recopie', copied);
  await assert.rejects(Maintenance.prototype.scheduled.call(copied, 'nettoyage-manuel'), /maintenance exclusive/, 'nettoyage par objet recopié');

  const fresh = await newRoot('ops-admission-');
  let stale: Maintenance | undefined;
  const phase = await Maintenance.run(fresh, async (m) => {
    stale = m;
    const rebound = { db: Reflect.set(m, 'db', svc.db), bucket: Reflect.set(m, 'bucket', bucket), root: Reflect.set(m, 'root', svc.root) };
    await assert.rejects(exportBackup(Object.create(m), join(fresh, 'derivee')), /maintenance exclusive/, 'objet dérivé d’un handle vivant');
    const cleanup = await m.scheduled('nettoyage-manuel');
    const exported = await exportBackup(m, join(fresh, 'sauvegarde'));
    return { rebound, cleanup: cleanup.outcome, root: m.root === fresh && m.db !== svc.db, tables: exported.manifest.tables.length };
  });
  assert.deepEqual(phase.rebound, { db: false, bucket: false, root: false }, 'handle gelé sur la racine et les liaisons acquises');
  assert.equal(phase.root, true);
  assert.equal(phase.cleanup, 'ok', 'nettoyage manuel exécuté dans la phase');
  await refuse('perime', stale);
  await assert.rejects(stale!.scheduled('nettoyage-manuel'), /maintenance exclusive/, 'nettoyage par handle périmé');
  assert.deepEqual((await states()).results, before, 'aucune revue modifiée');
  assert.equal(await journal(), entries, 'aucune entrée de journal de purge');
  assert.equal((await call(as(tok.agent!), 'GET', `${base(REVIEW)}/threads?limit=1`)).status, 200, 'instance interactive intacte');
  facts.admission = { refus: refusals, phaseNominale: phase };
});

test('critères 4, 5 et 6 : purge refusée pendant un PUT en vol, puis exclusive, complète, sans objet fantôme ni faux succès concurrent', async () => {
  const at = Math.max(j0 + 30 * DAY, Date.parse((await reviewRow(RACE))!.purge_after!));
  const atConc = Date.parse((await reviewRow(CONC))!.purge_after!);
  assert.ok(atConc > at, 'revue concurrente encore conservée au premier passage');
  const during = await refusedWhileWriting(RACE, inflight[1]!);
  assert.equal(during.put.status, 200, during.put.body);
  const lateKey = captureKey(RACE, inflight[1]!.captureId);
  const orphanKey = captureKey(REVIEW, '00000000-0000-4000-8000-000000000000');
  const r = await maintained(async (m) => {
    const ordinary = await fetch(`${m.url}${base(REVIEW)}/threads?limit=1`, { headers: { Authorization: `Bearer ${tok.agent}` } });
    const wrong = await purgeAt(m, at, tok.agent).then(() => null, (e: { status?: number }) => e.status);
    const early = [await purgeAt(m, j0), await purgeAt(m, j0 + 29 * DAY)];
    const objectsBefore = (await m.bucket.list({ prefix: `captures/${PROJECT}/${RACE}/` })).objects.map((o) => o.key).sort();
    const run1 = await purgeAt(m, at);
    const states = [(await reviewRow(REVIEW, m.db))!.state, (await reviewRow(RACE, m.db))!.state];
    const prefixes = await Promise.all([REVIEW, RACE].map(async (k) => (await m.bucket.list({ prefix: `captures/${PROJECT}/${k}/` })).objects.length));
    // Reste d'un écrivain antérieur à ce correctif, posé sous la tombale purged.
    await m.bucket.put(orphanKey, png('reste'));
    const run2 = await purgeAt(m, at);
    const orphan = await m.bucket.head(orphanKey);
    const logBefore = await countIn(m.db, 'SELECT COUNT(*) AS n FROM purge_log');
    const run3 = await purgeAt(m, at);
    const logAfter = await countIn(m.db, 'SELECT COUNT(*) AS n FROM purge_log');
    const pair = await Promise.all([0, 1].map(() => purgeAt(m, atConc).then(async (p) => ({ p, state: (await reviewRow(CONC, m.db))!.state }))));
    const concCounts = await countIn(m.db, "SELECT COUNT(*) AS n FROM purge_log WHERE review_key = ? AND resource = 'threads'", CONC);
    return { ordinary: [ordinary.status, ((await ordinary.json()) as { code: string }).code], wrong, early, objectsBefore, run1, states, prefixes, run2, orphan, run3, logBefore, logAfter, pair, concCounts };
  });
  const mine = (p: PurgeReport, k = REVIEW) => p.entries.filter((e) => e.reviewKey === k);
  assert.deepEqual(r.ordinary, [503, 'maintenance'], 'Worker de maintenance fermé aux routes ordinaires');
  assert.equal(r.wrong, 403, 'purge sans review.archive refusée');
  for (const [i, e] of r.early.entries()) {
    assert.deepEqual(mine(e).map((x) => x.action), ['kept'], `J${i ? 29 : 0} : conservée`);
    assert.equal(e.complete, true);
  }
  assert.ok(r.objectsBefore.includes(lateKey), 'objet du PUT en vol présent avant la purge');
  assert.equal(r.run1.complete, true, 'aucun écrivain possible : un seul passage complet');
  assert.ok(mine(r.run1).some((e) => e.action === 'purged') && mine(r.run1, RACE).some((e) => e.action === 'purged'));
  assert.deepEqual(r.states, ['purged', 'purged']);
  assert.deepEqual(r.prefixes, [0, 0], 'préfixes R2 relus vides');
  const deleted = Object.fromEntries(mine(r.run1).filter((e) => e.action === 'deleted' && e.resource !== 'object').map((e) => [e.resource, Number(e.detail)]));
  assert.deepEqual([deleted.threads, deleted.messages, deleted.captures, deleted.targets, deleted.proposals, deleted.revisions, deleted.deployments], [3, 4, 1, 1, 2, 1, 1]);
  assert.ok(mine(r.run1).some((e) => e.action === 'kept' && e.resource === 'revision' && /un autre projet/.test(e.detail)), 'révision identique d’un autre projet conservée');
  assert.ok(mine(r.run1).some((e) => e.action === 'kept' && e.resource === 'capture' && e.detail.includes(SHARED)), 'image identique d’une autre revue conservée');
  assert.ok(mine(r.run1, SHARED).some((e) => e.action === 'kept' && e.detail === 'revue active'), 'revue active conservée');
  assert.ok(mine(r.run1, CONC).some((e) => e.action === 'kept' && e.resource === 'review'), 'revue non expirée conservée');
  for (const k of [ids.reservedKey!, lateKey]) assert.ok(mine(r.run1, RACE).some((e) => e.resource === 'object' && e.detail === k), `${k} supprimé`);
  assert.ok(mine(r.run2).some((e) => e.action === 'deleted' && e.detail.startsWith(orphanKey) && e.detail.includes('reste trouvé')), 'reste sous la tombale nettoyé et journalisé');
  assert.ok(!mine(r.run2).some((e) => e.action === 'purged' || e.action === 'waiting'), 'revue non rouverte');
  assert.deepEqual([r.run2.complete, r.orphan], [true, null]);
  assert.deepEqual(r.run3.entries.filter((e) => e.action !== 'kept'), [], 'second passage : rien de plus');
  assert.equal(r.logAfter, r.logBefore);
  for (const { p, state } of r.pair) if (p.complete) assert.equal(state, 'purged', 'un passage complet implique la revue purgée dans l’état durable');
  assert.equal(r.pair.filter(({ p }) => mine(p, CONC).some((e) => e.action === 'purged')).length, 1, `une seule clôture : ${JSON.stringify(r.pair)}`);
  assert.equal(r.concCounts, 1, 'comptes journalisés une fois');

  const img = await fetch(`${svc.url}${base(REVIEW)}/captures/${ids.capture}`, { headers: { Authorization: `Bearer ${tok.agent}` } });
  assert.equal(img.status, 404, 'capture purgée illisible par l’API');
  assert.equal((await call(claire, 'GET', `${base(REVIEW)}/threads`)).status, 401, 'session de la revue purgée refusée');
  assert.equal((await call(as(tok.agent!), 'GET', `${base(REVIEW)}/threads?limit=1`)).status, 404);
  assert.equal((await fetch(`${svc.url}${base(SHARED)}/captures/${ids.sharedCapture}`, { headers: { Authorization: `Bearer ${tok.agent}` } })).status, 200, 'image partagée lisible');
  assert.equal((await call(as(tok.importAutre!), 'GET', `${base(REVIEW, 'autre')}/revisions/${ids.revision}`)).status, 403);
  assert.equal(await count("SELECT COUNT(*) AS n FROM revisions WHERE project_id = 'autre' AND revision_id = ?", ids.revision), 1);
  assert.equal((await call(as(tok.agent!), 'GET', `${base(SHARED)}/changes?since=${oldMarker.replace(/\.[0-9a-f]{32}\.\d+$/, `.${'0'.repeat(32)}.0`)}`)).status, 422);
  const left = await svc.db.batch(['threads', 'messages', 'captures', 'targets', 'proposals', 'operations', 'changes', 'sessions', 'deployments', 'revisions', 'listings', 'purge_objects']
    .map((t) => svc.db.prepare(`SELECT '${t}' AS t, COUNT(*) AS n FROM ${t} WHERE project_id = ? AND review_key IN (?, ?, ?)`).bind(PROJECT, REVIEW, RACE, CONC)));
  assert.deepEqual(left.map((x) => (x.results[0] as { n: number }).n), Array(12).fill(0), 'aucune ligne des revues purgées');
  const bucket = await svc.mf.getR2Bucket('CAPTURES');
  for (const k of [REVIEW, RACE, CONC]) assert.equal((await bucket.list({ prefix: `captures/${PROJECT}/${k}/` })).objects.length, 0);
  const row = await reviewRow(REVIEW);
  assert.equal(row!.state, 'purged');
  facts.purge = {
    refusPendantEcriture: during.refusal, putEnVol: during.put.status, maintenanceHttp: r.ordinary, objetEnVol: lateKey, reste: orphanKey,
    passages: [r.run1, r.run2, r.run3].map((p) => ({ complete: p.complete, entries: p.entries.filter((e) => e.reviewKey !== SHARED).map((e) => `${e.reviewKey} ${e.action} ${e.resource} ${e.detail}`) })),
    concurrents: r.pair.map(({ p, state }) => ({ complete: p.complete, etatAuRetour: state, entries: mine(p, CONC).map((e) => `${e.action} ${e.resource} ${e.detail}`) })),
    purgedAt: row!.purged_at,
  };
});

test('epoch renouvelée par la purge : curseur et marqueur antérieurs en 410, nouveau parcours valide', async () => {
  const shared = base(SHARED);
  const cursor = await call(as(tok.agent!), 'GET', `${base(REVIEW)}/threads?cursor=${oldCursor}`);
  assert.equal(cursor.status, 404, 'revue purgée');
  const fresh = await call(as(tok.agent!), 'GET', `${shared}/threads?limit=1`);
  assert.equal(fresh.status, 200);
  const staleEpoch = fresh.json.changesSince.replace(/^c2\.[0-9a-f]{32}/, `c2.${oldMarker.split('.')[1]}`);
  const stale = await call(as(tok.agent!), 'GET', `${shared}/changes?since=${staleEpoch}`);
  assert.deepEqual([stale.status, stale.json.code], [410, 'resync_required']);
  assert.equal((await call(as(tok.agent!), 'GET', `${shared}/changes?since=${fresh.json.changesSince}`)).status, 200);
  facts.epoch = { ancienne: oldMarker.split('.')[1], nouvelle: fresh.json.changesSince.split('.')[1], ancienMarqueur: stale.status };
});

test('critère 10 : la purge n’a rien modifié dans la sauvegarde déjà faite', async () => {
  const dir = backup.dir;
  for (const [f, digest] of Object.entries(backupDigests)) assert.equal(sha(await readFile(join(dir, f))), digest, f);
  assert.equal((await verifyBackup(dir, backup.manifestSha256)).manifestSha256, backup.manifestSha256);
});

test('critère 9, restauration : entrées hostiles refusées avant effet, restauration partielle signalée et refusée au démarrage', async () => {
  const dir = backup.dir;
  await assert.rejects(restoreBackup(svc as never, dir, backup.manifestSha256), /maintenance exclusive/);
  await assert.rejects(maintained((m) => restoreBackup(m, dir, backup.manifestSha256)), /non vierge/, 'jamais substituée à l’instance active');
  const work = await newRoot('ops-hostile-');
  const forge = async (name: string, mutate: (manifest: any, tables: Record<string, any[]>) => void) => {
    const out = join(work, name);
    await cp(dir, out, { recursive: true });
    const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
    const tables: Record<string, any[]> = {};
    for (const t of manifest.tables) tables[t.name] = JSON.parse(await readFile(join(out, t.file), 'utf8'));
    mutate(manifest, tables);
    for (const t of manifest.tables) {
      const body = JSON.stringify(tables[t.name]);
      await writeFile(join(out, t.file), body);
      t.sha256 = sha(body);
    }
    const text = JSON.stringify(manifest, null, 1);
    await writeFile(join(out, 'manifest.json'), text);
    return { dir: out, sha: sha(text) };
  };
  const hostile = {
    injection: await forge('injection', (_, t) => { t.reviews![0]['state) VALUES (1); DROP TABLE threads; --'] = 'x'; }),
    colonne: await forge('colonne', (_, t) => { t.reviews![0].colonne_inconnue = 'x'; }),
    compteur: await forge('compteur', (m) => { m.tables[0].rows += 1; }),
    chemin: await forge('chemin', (m) => { m.objects[0].key = 'captures/../../hors.png'; }),
    taille: await forge('taille', (m) => { m.objects[0].size += 1; }),
    valeur: await forge('valeur', (_, t) => { t.messages![0].body = { objet: true }; }),
  };
  const root = await newRoot('ops-restore-');
  const outcome = await Maintenance.run(root, async (target) => {
    const empty = async () => countIn(target.db, 'SELECT (SELECT COUNT(*) FROM reviews) + (SELECT COUNT(*) FROM restorations) + (SELECT COUNT(*) FROM technical_credentials) AS n');
    const refusals: Record<string, string> = {};
    const attempt = async (label: string, d: string, expected: string, pattern: RegExp) => {
      const e = await restoreBackup(target, d, expected).then(() => null, (x: Error) => x);
      assert.ok(e && pattern.test(e.message), `${label} : ${e?.message}`);
      assert.equal(await empty(), 0, `${label} : aucun effet`);
      refusals[label] = e.message;
    };
    await attempt('sans empreinte', dir, undefined as never, /empreinte SHA-256 attendue/);
    await attempt('fausse empreinte', dir, '0'.repeat(64), /empreinte du manifeste/);
    const altered = join(work, 'alteree');
    await cp(dir, altered, { recursive: true });
    await writeFile(join(altered, 'tables/messages.json'), '[]');
    await attempt('fichier altéré', altered, backup.manifestSha256, /altéré/);
    await rm(altered, { recursive: true });
    await cp(dir, altered, { recursive: true });
    await writeFile(join(altered, 'objects/extra.png'), 'x');
    await attempt('fichier en trop', altered, backup.manifestSha256, /hors du format/);
    await rm(join(altered, 'objects/extra.png'));
    await rm(join(altered, backup.manifest.objects[0]!.file));
    await attempt('objet manquant', altered, backup.manifestSha256, /manquants/);
    await rm(altered, { recursive: true });
    await cp(dir, altered, { recursive: true });
    await symlink('/etc/hosts', join(altered, 'objects/lien.png'));
    await attempt('lien symbolique', altered, backup.manifestSha256, /lien symbolique/);
    await rm(altered, { recursive: true });
    await attempt('nom de colonne injecté', hostile.injection.dir, hostile.injection.sha, /hors forme/);
    await attempt('colonne inconnue', hostile.colonne.dir, hostile.colonne.sha, /colonnes inconnues de reviews : colonne_inconnue/);
    await attempt('compteur faux', hostile.compteur.dir, hostile.compteur.sha, /le manifeste en annonce/);
    await attempt('clé d’objet hors forme', hostile.chemin.dir, hostile.chemin.sha, /manifeste hors forme/);
    await attempt('taille fausse', hostile.taille.dir, hostile.taille.sha, /sans objet identique/);
    await attempt('valeur non scalaire', hostile.valeur.dir, hostile.valeur.sha, /hors forme/);
    return { refusals, restored: await restoreBackup(target, dir, backup.manifestSha256) };
  });
  const restored = outcome.restored;
  claimOrThrow(root);
  const target = await startHeld({ root, projects });
  assert.notEqual(restored.epoch, backup.manifest.epochAtBackup);
  const health = await (await fetch(`${target.url}/v1/health`)).json() as any;
  assert.deepEqual([health.restoredFrom.state, health.restoredFrom.backupCreatedAt, health.restoredFrom.manifestSha256], ['complete', backup.manifest.createdAt, backup.manifestSha256], 'restauration datée et signalée');
  const old = [await call(as(tok.agent!, target), 'GET', `${base(REVIEW)}/threads?limit=10`), await call({ ...claire, url: target.url }, 'GET', `${base(REVIEW)}/threads`)];
  assert.deepEqual(old.map((r) => r.status), [401, 401], 'accès et sessions antérieurs refusés');
  const agent = await rt.provisionCredential(target.db, { projectId: PROJECT, label: 'agent-restaure', capabilities: ['review.read'] });
  const list = await call(as(agent, target), 'GET', `${base(REVIEW)}/threads?limit=10`);
  assert.equal(list.status, 200);
  const byId = new Map(list.json.items.map((t: any) => [t.threadId, t]));
  const g: any = byId.get(ids.global);
  assert.deepEqual(g.messages.map((m: any) => [m.author.displayName, m.body]), [['Claire Morel', 'Le résumé des rappels manque de contexte.'], ['Karim Benali', 'Ajouté en v2, merci.']]);
  const t: any = byId.get(ids.targeted);
  assert.equal(t.proposal.original, 'Enregistrer le rappel');
  const w: any = byId.get(ids.wording);
  assert.equal(w.proposal.wording.id, 'rappel-sms');
  const img = await fetch(`${target.url}${base(REVIEW)}/captures/${ids.capture}`, { headers: { Authorization: `Bearer ${agent}` } });
  assert.equal(img.status, 200);
  const bytes = new Uint8Array(await img.arrayBuffer());
  assert.equal(sha(bytes), sha(imageBytes), 'image restaurée identique');
  const staleCursor = await call(as(agent, target), 'GET', `${base(REVIEW)}/threads?cursor=${oldCursor}`);
  const staleMarker = await call(as(agent, target), 'GET', `${base(REVIEW)}/changes?since=${oldMarker}`);
  assert.deepEqual([staleCursor.status, staleMarker.status, staleMarker.json.code], [410, 410, 'resync_required']);
  const changes = await call(as(agent, target), 'GET', `${base(REVIEW)}/changes?since=${list.json.changesSince}`);
  assert.deepEqual([changes.status, changes.json.items.length], [200, 0]);
  const reviews = await call(as(agent, target), 'GET', `/v1/projects/${PROJECT}/reviews`);
  assert.equal(reviews.json.items.find((r: any) => r.reviewKey === REVIEW).state, 'archived', 'revue restaurée avec sa date de purge d’origine');
  await target.stop();

  // Erreur applicative après la marque « en cours » : une ligne en double viole la clé primaire pendant l'insertion.
  const partial = await forge('partielle', (m, t) => { t.messages!.push({ ...t.messages![0] }); m.tables.find((x: any) => x.name === 'messages').rows += 1; });
  const partialRoot = await newRoot('ops-partielle-');
  const failed = await Maintenance.run(partialRoot, (m) => restoreBackup(m, partial.dir, partial.sha)).then(() => null, (e: Error) => e.message);
  assert.ok(failed, 'restauration partielle en échec');
  const partialClaim = claimOrThrow(partialRoot);
  const boot = await startHeld({ root: partialRoot, projects }).then(() => null, (e: Error) => e.message);
  partialClaim.release();
  assert.match(boot ?? '', /restauration incomplète commencée le .*aucun accès émis/, 'démarrage ordinaire refusé');
  const again = await Maintenance.run(partialRoot, async () => 'ouverte').then(() => null, (e: Error) => e.message);
  assert.match(again ?? '', /restauration incomplète/, 'aucune autre opération sur la cible partielle');
  facts.restaurationPartielle = { erreur: failed, demarrage: boot, maintenance: again };
  facts.entreesHostiles = outcome.refusals;
  facts.restauration = {
    epochSauvegarde: backup.manifest.epochAtBackup, epochRestauree: restored.epoch, lignes: restored.rows, objets: restored.objects,
    anciensAcces: old.map((r) => r.status), ancienCurseur: staleCursor.status, ancienMarqueur: staleMarker.status, image: sha(bytes), restoredFrom: health.restoredFrom,
  };
});

test('critère 11 : fin de travail, fichiers de préparation retirés, anciens retours expliqués par la révision conservée', async () => {
  const depot = join(svc.root, 'depot-integre');
  await cp(join(REPO_ROOT, 'apps/demo/.socrate'), join(depot, '.socrate'), { recursive: true });
  const assembled = await assembleManifest(join(depot, '.socrate'));
  assert.ok(assembled.ok);
  const review = 'fin-de-travail';
  const imported = await importInto(review, 'local-f', PROJECT, tok.import, { ...assembled.manifest, reviewKey: review });
  assert.equal(imported.status, 201);
  const c = await session(review, 'local-f');
  const w = await publish(c, review, 'Plus court.', { wordingId: 'rappel-sms', replacement: 'SMS de rappel {delai} avant.', revisionId: imported.json.revisionId });
  assert.equal(w.status, 201, JSON.stringify(w.json));
  await rm(join(depot, '.socrate'), { recursive: true });
  const thread = await call(as(tok.agent!), 'GET', `${base(review)}/threads/${w.json.threadId}`);
  const revision = await call(as(tok.agent!), 'GET', `${base(review)}/revisions/${thread.json.revisionId}`);
  assert.equal(revision.status, 200);
  const prepared = revision.json.manifest.wordings.find((x: any) => x.id === 'rappel-sms');
  assert.equal(prepared.source, thread.json.proposal.original, 'original expliqué par la révision conservée');
  facts.finDeTravail = { revisionId: thread.json.revisionId, original: thread.json.proposal.original };
});
