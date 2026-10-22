import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, unlink, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { startBench, call, claimOrThrow, closeHeld, demoManifest, assertionFor, key, newRoot, rt, ORIGIN, PROJECT, REVIEW, type Bench, type Client } from './helpers.ts';
import { REPO_ROOT } from '../../../tools/local/local-run.ts';
import { exportBackup, restoreBackup, verifyBackup } from '../../../tools/local/backup.ts';
import { Maintenance, purgeProject } from '../../../tools/local/maintenance.ts';
const workerModule = new URL('../src/attachments.ts', import.meta.url).href;
const { reclaimExpiredAttachments } = await import(workerModule);

const KEPT = 'revue-gardee';
const DAY = 86_400_000;
/** Archive produite par le code de 87954e3 (`fixtures/generer-sauvegarde-v1.ts`), format socrate-sauvegarde/1. */
const V1_DIR = join(REPO_ROOT, 'apps/service/test/fixtures/sauvegarde-v1');
const V1_SHA = '4ed25d83acec21b986d7650fa7b51892c00b0707f6b14a9ffbcdb704688decca';
const facts: Record<string, unknown> = {};
const base = (r: string) => `/v1/projects/${PROJECT}/reviews/${r}`;
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
const png = (seed: string) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode(`pièce fictive ${seed} `.repeat(60))]);
const webm = (seed: string) => new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d, ...new TextEncoder().encode(`vidéo fictive ${seed} `.repeat(200))]);
const meta = (name: string, contentType: string, bytes: Uint8Array) => ({ name, contentType, size: bytes.byteLength, sha256: sha(bytes) });

let bench: Bench;
let archiveToken: string;
const tok = { agent: '' };
before(async () => {
  bench = await startBench();
  archiveToken = await rt.provisionCredential(bench.service.db, { projectId: PROJECT, label: 'archivage', capabilities: ['review.archive'] });
  tok.agent = bench.agentToken;
  for (const r of [REVIEW, KEPT]) {
    const res = await call({ url: bench.service.url, token: bench.importToken }, 'PUT', `${base(r)}/deployments/local-1`, { commit: 'a1b2c3d4e5f6', buildId: '0042', url: `${ORIGIN}/`, manifest: { ...(await demoManifest()), reviewKey: r } });
    assert.equal(res.status, 201, JSON.stringify(res.json));
  }
});
after(async () => {
  if (process.env.SOCRATE_B_OPS_OUT) await writeFile(process.env.SOCRATE_B_OPS_OUT, JSON.stringify(facts, null, 1));
  await bench.stop();
  await closeHeld();
});

async function session(reviewKey: string): Promise<Client> {
  const r = await call({ url: bench.service.url, origin: ORIGIN }, 'POST', '/v1/auth/session', { assertion: assertionFor(bench, { deploymentId: 'local-1', reviewKey }) });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return { url: bench.service.url, token: r.json.sessionToken, origin: ORIGIN };
}
async function upload(c: Client, r: string, k: string, files: Array<{ name: string; type: string; bytes: Uint8Array }>, operation = 'thread.create') {
  const list = files.map((f) => meta(f.name, f.type, f.bytes));
  const res = await call(c, 'POST', `${base(r)}/attachments`, { operation, attachments: list }, { 'Idempotency-Key': k });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  for (const [i, item] of res.json.items.entries()) {
    const put = await fetch(`${c.url}${base(r)}/attachments/${item.attachmentId}`, { method: 'PUT', headers: { Authorization: `Bearer ${c.token}`, Origin: ORIGIN, 'Content-Type': files[i]!.type }, body: files[i]!.bytes as BodyInit });
    assert.equal(put.status, 200);
  }
  return { list, ids: res.json.items.map((i: { attachmentId: string }) => i.attachmentId) as string[] };
}
const objectKeys = async (prefix = 'attachments/') => (await (await bench.service.mf.getR2Bucket('CAPTURES')).list({ prefix })).objects.map((o) => o.key).sort();

/** Arrêt confirmé de l'instance interactive, phase de maintenance exclusive de la même racine, puis reprise interactive. */
let claim: { release(): void } | null = null;
async function maintained<T>(work: (m: Maintenance) => Promise<T>): Promise<T> {
  await bench.stopService();
  (claim ?? bench.claim).release();
  try {
    return await Maintenance.run(bench.root, work);
  } finally {
    claim = claimOrThrow(bench.root);
    await bench.startService();
  }
}
/** Instance restaurée lancée sous sa racine possédée, puis arrêtée. */
async function served<T>(root: string, work: (svc: Awaited<ReturnType<typeof rt.startService>>) => Promise<T>): Promise<T> {
  const owned = claimOrThrow(root);
  const svc = await rt.startService({ root, projects: [] });
  try {
    return await work(svc);
  } finally {
    await svc.stop();
    owned.release();
  }
}

const state: { purgedIds: string[]; keptIds: string[]; keptThread: string; pendingId: string; files: Record<string, Uint8Array> } = { purgedIds: [], keptIds: [], keptThread: '', pendingId: '', files: {} };

test('données : pièces rattachées dans deux revues, une réservation jamais rattachée', async () => {
  const purged = await session(REVIEW);
  const kept = await session(KEPT);
  const k1 = key();
  const a = await upload(purged, REVIEW, k1, [{ name: 'a-purger.png', type: 'image/png', bytes: png('purge') }, { name: 'a-purger.webm', type: 'video/webm', bytes: webm('purge') }]);
  assert.equal((await call(purged, 'POST', `${base(REVIEW)}/threads`, { kind: 'global', body: 'Revue à purger', attachments: a.list }, { 'Idempotency-Key': k1 })).status, 201);
  state.purgedIds = a.ids;
  const k2 = key();
  state.files = { 'garde.png': png('garde'), 'garde.webm': webm('garde') };
  const b = await upload(kept, KEPT, k2, [{ name: 'garde.png', type: 'image/png', bytes: state.files['garde.png']! }, { name: 'garde.webm', type: 'video/webm', bytes: state.files['garde.webm']! }]);
  const t = await call(kept, 'POST', `${base(KEPT)}/threads`, { kind: 'global', body: 'Revue gardée', attachments: b.list }, { 'Idempotency-Key': k2 });
  assert.equal(t.status, 201);
  state.keptIds = b.ids;
  state.keptThread = t.json.threadId;
  const pending = await upload(kept, KEPT, key(), [{ name: 'abandon.png', type: 'image/png', bytes: png('abandon') }]);
  state.pendingId = pending.ids[0]!;
  assert.equal((await objectKeys()).length, 5);
});

test('revue archivée : aucune réservation ni octet, lecture des pièces conservée', async () => {
  const c = await session(REVIEW);
  const archived = await call({ url: bench.service.url, token: archiveToken }, 'POST', `${base(REVIEW)}/archive`);
  assert.equal(archived.status, 200, JSON.stringify(archived.json));
  const bytes = png('apres-archivage');
  const refused = await call(c, 'POST', `${base(REVIEW)}/attachments`, { operation: 'thread.create', attachments: [meta('x.png', 'image/png', bytes)] }, { 'Idempotency-Key': key() });
  assert.equal(refused.status, 409);
  assert.equal(refused.json.code, 'review_inactive');
  const read = await fetch(`${bench.service.url}${base(REVIEW)}/attachments/${state.purgedIds[0]}`, { headers: { Authorization: `Bearer ${tok.agent}` } });
  assert.equal(read.status, 200, 'une revue archivée reste lisible jusqu’à sa purge');
  facts.archivee = { reservation: refused.status, lecture: read.status };
});

test('nettoyage manuel sous maintenance exclusive : réservation expirée retirée, pièces rattachées intactes', async () => {
  // Préparation du temps écoulé : la réservation de 600 s est datée du passé, aucune autre ligne n'est touchée.
  await bench.service.db.prepare('UPDATE attachments SET expires_at = 1 WHERE attachment_id = ?').bind(state.pendingId).run();
  const before = await objectKeys();
  const r = await maintained(async (m) => {
    const { outcome } = await m.scheduled('nettoyage-manuel');
    await m.bucket.put(`attachments/${PROJECT}/${KEPT}/00000000-0000-4000-8000-000000000000`, png('orpheline'));
    const stray = await reclaimExpiredAttachments({ DB: m.db as never, CAPTURES: m.bucket as never }, { now: Math.floor(Date.now() / 1000) + 3600 });
    return { outcome, stray };
  });
  assert.equal(r.outcome, 'ok');
  const after = await objectKeys();
  assert.deepEqual(before.filter((k) => !after.includes(k)), [`attachments/${PROJECT}/${KEPT}/${state.pendingId}`]);
  assert.deepEqual(r.stray.strayObjects, [`attachments/${PROJECT}/${KEPT}/00000000-0000-4000-8000-000000000000`]);
  for (const id of [...state.keptIds, ...state.purgedIds]) assert.ok(after.some((k) => k.endsWith(id)), `pièce rattachée ${id} conservée`);
  assert.equal((await bench.service.db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE attachment_id = ?').bind(state.pendingId).first<{ n: number }>())!.n, 0);
  facts.nettoyage = { retirees: 1, orphelines: r.stray.strayObjects.length, conservees: after.length };
});

let backupDir = '';
let backupSha = '';
test('sauvegarde format 2 puis restauration vers une instance vierge : pièces, tailles et empreintes identiques', async () => {
  backupDir = join(await newRoot('sauvegarde-b-'), 'archive');
  const r = await maintained((m) => exportBackup(m, backupDir));
  backupSha = r.manifestSha256;
  assert.equal(r.manifest.format, 'socrate-sauvegarde/2');
  const pieces = r.manifest.objects.filter((o) => 'attachmentId' in o);
  assert.equal(pieces.length, 4, 'quatre pièces rattachées, la réservation retirée n’est pas exportée');
  assert.equal(r.manifest.tables.find((t) => t.name === 'attachments')!.rows, 4);
  const target = await newRoot('restaure-b-');
  const restored = await Maintenance.run(target, (m) => restoreBackup(m, backupDir, backupSha));
  assert.equal(restored.rows.attachments, 4);
  await served(target, async (svc) => {
    const agent = await rt.provisionCredential(svc.db, { projectId: PROJECT, label: 'agent', capabilities: ['review.read'] });
    const page = await call({ url: svc.url, token: agent }, 'GET', `${base(KEPT)}/threads`);
    assert.equal(page.status, 200);
    const m = page.json.items.find((t: { threadId: string }) => t.threadId === state.keptThread).messages[0];
    assert.deepEqual(m.attachments.map((a: { name: string }) => a.name), ['garde.png', 'garde.webm']);
    for (const a of m.attachments as Array<{ attachmentId: string; name: string; contentType: string }>) {
      const res = await fetch(`${svc.url}${base(KEPT)}/attachments/${a.attachmentId}`, { headers: { Authorization: `Bearer ${agent}` } });
      assert.equal(res.headers.get('content-type'), a.contentType);
      assert.equal(sha(new Uint8Array(await res.arrayBuffer())), sha(state.files[a.name]!));
    }
  });
  facts.sauvegarde = { format: r.manifest.format, pieces: pieces.map((p) => ({ size: p.size, sha256: p.sha256 })), restaurees: restored.rows.attachments };
});

test('archives refusées avant tout effet : objet altéré, pièce sans message, format inconnu', async () => {
  const copy = async (name: string) => {
    const dir = join(await newRoot(`${name}-`), 'archive');
    await cp(backupDir, dir, { recursive: true });
    return dir;
  };
  const altered = await copy('alteree');
  const manifest = JSON.parse(await readFile(join(altered, 'manifest.json'), 'utf8'));
  const video = manifest.objects.find((o: { contentType?: string }) => o.contentType === 'video/webm');
  const bytes = await readFile(join(altered, video.file));
  bytes[40] ^= 1;
  await writeFile(join(altered, video.file), bytes);
  await assert.rejects(verifyBackup(altered, backupSha), /altéré/);

  const orphan = await copy('orpheline');
  const m2 = JSON.parse(await readFile(join(orphan, 'manifest.json'), 'utf8'));
  const rows = JSON.parse(await readFile(join(orphan, 'tables/attachments.json'), 'utf8'));
  rows[0].message_id = '00000000-0000-4000-8000-000000000000';
  const body = JSON.stringify(rows);
  await writeFile(join(orphan, 'tables/attachments.json'), body);
  m2.tables.find((t: { name: string }) => t.name === 'attachments').sha256 = sha(body);
  const text = JSON.stringify(m2, null, 1);
  await writeFile(join(orphan, 'manifest.json'), text);
  await assert.rejects(verifyBackup(orphan, sha(text)), /message absent/);

  for (const [field, value] of [['name', 'nom\u202einverse.png'], ['position', 4], ['actor_key', 'autre-auteur']] as const) {
    const dir = await copy(`incoherente-${field.replaceAll('_', '-')}`);
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    const rows = JSON.parse(await readFile(join(dir, 'tables/attachments.json'), 'utf8'));
    rows[0][field] = value;
    const body = JSON.stringify(rows);
    await writeFile(join(dir, 'tables/attachments.json'), body);
    manifest.tables.find((t: { name: string }) => t.name === 'attachments').sha256 = sha(body);
    const text = JSON.stringify(manifest);
    await writeFile(join(dir, 'manifest.json'), text);
    await assert.rejects(verifyBackup(dir, sha(text)), /métadonnées|position|auteur/, `${field} invalide refusé avant restauration`);
  }

  const avifDir = await copy('avif-mp4');
  const avif = await readFile(new URL('../../../tools/local/fixtures/media/non-mp4.avif', import.meta.url));
  const avifManifest = JSON.parse(await readFile(join(avifDir, 'manifest.json'), 'utf8'));
  const avifRows = JSON.parse(await readFile(join(avifDir, 'tables/attachments.json'), 'utf8'));
  const avifObject = avifManifest.objects.find((o: { contentType?: string }) => o.contentType === 'video/webm');
  const previousFile = avifObject.file;
  Object.assign(avifObject, { contentType: 'video/mp4', size: avif.length, sha256: sha(avif), file: `objects/${sha(avif)}.mp4` });
  Object.assign(avifRows.find((a: { attachment_id: string }) => a.attachment_id === avifObject.attachmentId), { content_type: 'video/mp4', name: 'image.mp4', size: avif.length, sha256: sha(avif) });
  await writeFile(join(avifDir, avifObject.file), avif);
  await unlink(join(avifDir, previousFile));
  const avifTable = JSON.stringify(avifRows);
  await writeFile(join(avifDir, 'tables/attachments.json'), avifTable);
  avifManifest.tables.find((t: { name: string }) => t.name === 'attachments').sha256 = sha(avifTable);
  const avifText = JSON.stringify(avifManifest);
  await writeFile(join(avifDir, 'manifest.json'), avifText);
  await assert.rejects(verifyBackup(avifDir, sha(avifText)), /signature invalides/, 'tailles et empreintes cohérentes, refus du format');
  const avifTarget = await newRoot('cible-avif-');
  await assert.rejects(Maintenance.run(avifTarget, (m) => restoreBackup(m, avifDir, sha(avifText))), /signature invalides/);
  await served(avifTarget, async (svc) => {
    assert.equal((await svc.db.prepare('SELECT COUNT(*) AS n FROM restorations').first<{ n: number }>())!.n, 0);
    assert.equal((await svc.db.prepare('SELECT COUNT(*) AS n FROM messages').first<{ n: number }>())!.n, 0);
    assert.equal((await (await svc.mf.getR2Bucket('CAPTURES')).list()).objects.length, 0);
  });
  facts.avifArchive = { size: avif.length, sha256: sha(avif), manifestSha256: sha(avifText), refused: 'signature invalides', restorations: 0, messages: 0, objects: 0 };

  const unknown = await copy('inconnue');
  const m3 = JSON.parse(await readFile(join(unknown, 'manifest.json'), 'utf8'));
  m3.format = 'socrate-sauvegarde/3';
  const t3 = JSON.stringify(m3, null, 1);
  await writeFile(join(unknown, 'manifest.json'), t3);
  await assert.rejects(verifyBackup(unknown, sha(t3)), /manifeste hors forme/);
  const target = await newRoot('cible-refus-');
  await assert.rejects(Maintenance.run(target, (m) => restoreBackup(m, orphan, sha(text))), /message absent/);
  await served(target, async (svc) => {
    assert.equal((await svc.db.prepare('SELECT COUNT(*) AS n FROM restorations').first<{ n: number }>())!.n, 0, 'aucune restauration commencée');
  });
});

test('archive au format 1 produite par 87954e3 : restaurée sur le schéma 0007, messages sans pièces lisibles', async () => {
  const verified = await verifyBackup(V1_DIR, V1_SHA);
  assert.equal(verified.manifest.format, 'socrate-sauvegarde/1');
  const target = await newRoot('restaure-v1-');
  const restored = await Maintenance.run(target, (m) => restoreBackup(m, V1_DIR, V1_SHA));
  await served(target, async (svc) => {
    const agent = await rt.provisionCredential(svc.db, { projectId: PROJECT, label: 'agent', capabilities: ['review.read'] });
    const page = await call({ url: svc.url, token: agent }, 'GET', `${base(REVIEW)}/threads`);
    assert.equal(page.status, 200);
    assert.equal(page.json.items.length, 2);
    const messages = page.json.items.flatMap((t: { messages: Array<{ attachments: unknown[] }> }) => t.messages);
    assert.equal(messages.length, 3);
    assert.ok(messages.every((m: { attachments: unknown[] }) => Array.isArray(m.attachments) && m.attachments.length === 0));
    const targeted = page.json.items.find((t: { kind: string }) => t.kind === 'targeted');
    const image = await fetch(`${svc.url}${base(REVIEW)}/captures/${targeted.capture.captureId}`, { headers: { Authorization: `Bearer ${agent}` } });
    assert.equal(sha(new Uint8Array(await image.arrayBuffer())), targeted.capture.sha256, 'capture technique du format 1 restaurée');
    assert.equal((await svc.db.prepare("SELECT state FROM restorations").first<{ state: string }>())!.state, 'complete');
    assert.equal((await svc.db.prepare('SELECT COUNT(*) AS n FROM attachments').first<{ n: number }>())!.n, 0);
    facts.formatV1 = { empreinte: V1_SHA, lignes: restored.rows, fils: page.json.items.length, messages: messages.length };
  });
  const tampered = join(await newRoot('v1-schema-'), 'archive');
  await cp(V1_DIR, tampered, { recursive: true });
  const m = JSON.parse(await readFile(join(tampered, 'manifest.json'), 'utf8'));
  m.schema = m.schema.slice(0, 5);
  const text = JSON.stringify(m, null, 1);
  await writeFile(join(tampered, 'manifest.json'), text);
  await assert.rejects(verifyBackup(tampered, sha(text)), /schéma/, 'format 1 sans 0006 : refus');
});

test('purge de la revue expirée : lignes et objets de ses pièces supprimés, pièces de la revue active intactes', async () => {
  const report = await maintained((m) => purgeProject(m, { projectId: PROJECT, token: archiveToken, now: Date.now() + 31 * DAY }));
  assert.equal(report.complete, true, JSON.stringify(report.entries));
  const deleted = report.entries.filter((e) => e.reviewKey === REVIEW && e.action === 'deleted');
  assert.ok(deleted.some((e) => e.resource === 'attachments' && e.detail === '2'), JSON.stringify(deleted));
  assert.equal(deleted.filter((e) => e.resource === 'object' && e.detail.startsWith('attachments/')).length, 2);
  const left = await objectKeys();
  assert.deepEqual(left.filter((k) => k.includes(`/${REVIEW}/`)), []);
  assert.deepEqual(left.filter((k) => k.includes(`/${KEPT}/`)).length, 2);
  const kept = await call({ url: bench.service.url, token: tok.agent }, 'GET', `${base(KEPT)}/threads/${state.keptThread}`);
  assert.equal(kept.json.messages[0].attachments.length, 2);
  facts.purge = { complete: report.complete, objetsPieces: 2, conservees: left.length };
});
