import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { startBench, importDemo, call, sessionClient, key, rt, PROJECT, REVIEW, type Bench, type Client } from './helpers.ts';

let bench: Bench;
before(async () => {
  bench = await startBench();
  assert.equal((await importDemo(bench, 'local-1')).status, 201);
});
after(async () => {
  if (process.env.SOCRATE_B_OUT) await writeFile(process.env.SOCRATE_B_OUT, JSON.stringify(facts, null, 1));
  await bench.stop();
});

/** Faits sans secret, écrits sous `SOCRATE_B_OUT` quand la variable est fournie. */
const facts: Record<string, unknown> = {};
const MIB = 1024 * 1024;
const base = `/v1/projects/${PROJECT}/reviews/${REVIEW}`;
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const claire = () => sessionClient(bench, { deploymentId: 'local-1' });
const karim = () => sessionClient(bench, { deploymentId: 'local-1', sub: 'karim', name: 'Karim Benali' });
const count = async (sql: string, ...binds: unknown[]) => (await bench.service.db.prepare(sql).bind(...binds).first<{ n: number }>())!.n;
const objects = async (prefix = 'attachments/') => (await (await bench.service.mf.getR2Bucket('CAPTURES')).list({ prefix })).objects.map((o) => o.key);

const SIGNATURES: Record<string, number[]> = {
  'image/png': [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  'image/jpeg': [0xff, 0xd8, 0xff, 0xe0],
  'image/webp': [...'RIFF'].map((c) => c.charCodeAt(0)).concat([0, 0, 0, 0], [...'WEBPVP8 '].map((c) => c.charCodeAt(0))),
  'video/mp4': [0, 0, 0, 0x18, ...[...'ftypisom'].map((c) => c.charCodeAt(0)), 0, 0, 0, 0, ...[...'isommp41'].map((c) => c.charCodeAt(0))],
  'video/webm': [0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84, ...[...'webm'].map((c) => c.charCodeAt(0))],
};
/** Pièce synthétique : signature du type puis octets fictifs, jamais un fichier personnel. */
function piece(type: keyof typeof SIGNATURES, size: number, seed = 'a'): Uint8Array {
  const b = new Uint8Array(size);
  b.set(SIGNATURES[type]!);
  const filler = new TextEncoder().encode(`piece fictive ${seed} `);
  for (let i = SIGNATURES[type]!.length; i < size; i++) b[i] = filler[i % filler.length]!;
  return b;
}
const meta = (name: string, contentType: string, bytes: Uint8Array) => ({ name, contentType, size: bytes.byteLength, sha256: sha(bytes) });

async function reserve(c: Client, k: string, operation: string, attachments: unknown[]) {
  return call(c, 'POST', `${base}/attachments`, { operation, attachments }, { 'Idempotency-Key': k });
}
async function put(c: Client, attachmentId: string, bytes: Uint8Array, contentType: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${c.url}${base}/attachments/${attachmentId}`, {
    method: 'PUT', headers: { Authorization: `Bearer ${c.token}`, Origin: c.origin!, 'Content-Type': contentType, ...headers }, body: bytes as BodyInit,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
/** Réserve, téléverse les pièces manquantes puis rend la liste déclarée, comme le client. */
async function upload(c: Client, k: string, operation: string, files: Array<{ name: string; type: string; bytes: Uint8Array }>) {
  const list = files.map((f) => meta(f.name, f.type, f.bytes));
  const r = await reserve(c, k, operation, list);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  for (const [i, item] of (r.json.items as Array<{ attachmentId: string; uploaded: boolean }>).entries()) {
    if (item.uploaded) continue;
    const up = await put(c, item.attachmentId, files[i]!.bytes, files[i]!.type);
    assert.equal(up.status, 200, JSON.stringify(up.json));
  }
  return { list, ids: (r.json.items as Array<{ attachmentId: string }>).map((i) => i.attachmentId) };
}

/** Mémoire résidente du workerd lancé par ce banc, lue par `ps` sans aucun signal. */
function workerdRss(): number {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,comm='], { encoding: 'utf8' }).trim().split('\n').map((l) => l.trim().split(/\s+/, 4));
  const children = new Map<string, string[]>();
  for (const [pid, ppid] of rows) children.set(ppid!, [...(children.get(ppid!) ?? []), pid!]);
  const mine = new Set<string>();
  const walk = (pid: string) => { for (const c of children.get(pid) ?? []) { mine.add(c); walk(c); } };
  walk(String(process.pid));
  return rows.filter(([pid, , , comm]) => mine.has(pid!) && /workerd/.test(comm!)).reduce((n, [, , rss]) => n + Number(rss) * 1024, 0);
}

test('commentaire général avec trois pièces : réservation, octets, rattachement atomique et relecture protégée', async () => {
  const c = await claire();
  const files = [
    { name: 'écran rappel.png', type: 'image/png', bytes: piece('image/png', 4000, 'png') },
    { name: 'photo.jpg', type: 'image/jpeg', bytes: piece('image/jpeg', 3000, 'jpeg') },
    { name: 'parcours.webm', type: 'video/webm', bytes: piece('video/webm', 9000, 'webm') },
  ];
  const k = key();
  const { list, ids } = await upload(c, k, 'thread.create', files);
  assert.equal(await count("SELECT COUNT(*) AS n FROM attachments WHERE state = 'reserved' AND uploaded = 1 AND idempotency_key = ?", k), 3);
  assert.equal(await count('SELECT COUNT(*) AS n FROM messages'), 0, 'aucun message avant la publication');
  const created = await call(c, 'POST', `${base}/threads`, { kind: 'global', body: 'Trois pièces jointes.', attachments: list }, { 'Idempotency-Key': k });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.deepEqual(created.json.messages[0].attachments.map((a: { attachmentId: string }) => a.attachmentId), ids);
  const listed = await call(c, 'GET', `${base}/threads`);
  const m = listed.json.items.find((t: { threadId: string }) => t.threadId === created.json.threadId).messages[0];
  assert.deepEqual(m.attachments, ids.map((attachmentId, i) => ({ attachmentId, ...list[i] })));
  for (const [i, f] of files.entries()) {
    const res = await fetch(`${c.url}${base}/attachments/${ids[i]}`, { headers: { Authorization: `Bearer ${c.token}`, Origin: c.origin! } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), f.type);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.match(res.headers.get('content-security-policy') ?? '', /sandbox/);
    assert.equal(sha(new Uint8Array(await res.arrayBuffer())), f.bytes.length ? sha(f.bytes) : '');
  }
  const agent = await fetch(`${c.url}${base}/attachments/${ids[0]}`, { headers: { Authorization: `Bearer ${bench.agentToken}` } });
  assert.equal(agent.status, 200, 'API agent : lecture technique review.read');
  const anonymous = await fetch(`${c.url}${base}/attachments/${ids[0]}`);
  assert.equal(anonymous.status, 401, 'aucun lien public');
  facts.general = { threadId: created.json.threadId, pieces: list.map((l) => ({ type: l.contentType, size: l.size })) };
});

test('quatre vidéos de 50 Mio dans un message, une par requête en flux ; 50 Mio + 1 refusée ; mémoire du Worker relevée', async () => {
  const c = await claire();
  const source = await readFile(new URL('../../../tools/local/fixtures/media/parcours.mp4', import.meta.url));
  const video = Buffer.alloc(50 * MIB);
  source.copy(video);
  video.writeUInt32BE(video.length - source.length, source.length);
  video.write('free', source.length + 4, 'ascii');
  const videos = Array.from({ length: 4 }, () => video);
  const list = videos.map((b, i) => meta(`borne-${i}.mp4`, 'video/mp4', b));
  const k = key();
  const r = await reserve(c, k, 'thread.create', list);
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const rss: Array<{ avant: number; pic: number; ms: number }> = [];
  for (const [i, bytes] of videos.entries()) {
    const avant = workerdRss();
    let pic = avant;
    const sampler = setInterval(() => { pic = Math.max(pic, workerdRss()); }, 25);
    const started = performance.now();
    const up = await put(c, r.json.items[i].attachmentId, bytes, 'video/mp4');
    const ms = Math.round(performance.now() - started);
    clearInterval(sampler);
    assert.equal(up.status, 200, JSON.stringify(up.json));
    rss.push({ avant, pic: Math.max(pic, workerdRss()), ms });
  }
  const created = await call(c, 'POST', `${base}/threads`, { kind: 'global', body: '', attachments: list }, { 'Idempotency-Key': k });
  assert.equal(created.status, 201, 'message fait seulement de pièces');
  const read = await fetch(`${c.url}${base}/attachments/${r.json.items[3].attachmentId}`, { headers: { Authorization: `Bearer ${c.token}`, Origin: c.origin! } });
  const back = new Uint8Array(await read.arrayBuffer());
  assert.equal(back.byteLength, 50 * MIB);
  assert.equal(sha(back), sha(videos[3]!));
  const over = await reserve(c, key(), 'thread.create', [{ name: 'trop.mp4', contentType: 'video/mp4', size: 50 * MIB + 1, sha256: sha(videos[0]!) }]);
  assert.equal(over.status, 422, 'au-delà de 50 Mio : refus avant tout octet');
  const image = await reserve(c, key(), 'thread.create', [{ name: 'trop.png', contentType: 'image/png', size: 10 * MIB + 1, sha256: sha(videos[0]!) }]);
  assert.equal(image.status, 422, 'au-delà de 10 Mio pour une image');
  const small = piece('video/mp4', 4000, 'court');
  const id = (await reserve(c, key(), 'thread.create', [meta('court.mp4', 'video/mp4', small)])).json.items[0].attachmentId;
  const declared = await put(c, id, piece('video/mp4', 5000, 'court'), 'video/mp4');
  assert.equal(declared.status, 422, 'taille annoncée différente : refus avant lecture');
  const chunked = async (bytes: Uint8Array) => {
    const body = new ReadableStream<Uint8Array>({ start(ctl) { for (let i = 0; i < bytes.length; i += 1000) ctl.enqueue(bytes.slice(i, i + 1000)); ctl.close(); } });
    const res = await fetch(`${c.url}${base}/attachments/${id}`, { method: 'PUT', headers: { Authorization: `Bearer ${c.token}`, Origin: c.origin!, 'Content-Type': 'video/mp4' }, body, duplex: 'half' } as RequestInit);
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  const longer = await chunked(new Uint8Array([...small, ...piece('video/mp4', 1000, 'surplus')]));
  assert.equal(longer.status, 422, 'flux sans longueur annoncée borné pendant la lecture');
  const shorter = await chunked(small.subarray(0, 3000));
  assert.equal(shorter.status, 422, 'flux plus court que la réservation');
  assert.deepEqual((await objects()).filter((o) => o.endsWith(id)), [], 'aucun objet pour un flux refusé');
  assert.equal((await chunked(small)).status, 200, 'le flux exact passe ensuite');
  facts.borne = { octetsParVideo: 50 * MIB, videos: 4, source: 'parcours.mp4 + boîte ISO BMFF free', workerdRss: rss, workerdRssApres: workerdRss(), refus50Mio1: over.status, refusImage10Mio1: image.status, longueurAnnonceeFausse: declared.status, fluxTropLong: longer.status, fluxTropCourt: shorter.status };
});

test('refus aux frontières : format, signature, taille réelle, empreinte, quota, nom, message vide', async () => {
  const c = await claire();
  const png = piece('image/png', 2000, 'refus');
  const gif = await reserve(c, key(), 'thread.create', [{ name: 'a.gif', contentType: 'image/gif', size: 10, sha256: sha(png) }]);
  assert.equal(gif.status, 422);
  const five = await reserve(c, key(), 'thread.create', Array.from({ length: 5 }, (_, i) => meta(`p${i}.png`, 'image/png', png)));
  assert.equal(five.status, 422, 'cinq pièces refusées');
  const named = await reserve(c, key(), 'thread.create', [meta('a‮bad.png', 'image/png', png)]);
  assert.equal(named.status, 422, 'nom avec caractère de direction refusé');
  const empty = await call(c, 'POST', `${base}/threads`, { kind: 'global', body: '  ', attachments: [] }, { 'Idempotency-Key': key() });
  assert.equal(empty.status, 422, 'ni texte ni pièce');

  const jpeg = piece('image/jpeg', 2000, 'masque');
  const disguised = await reserve(c, key(), 'thread.create', [meta('faux.png', 'image/png', jpeg)]);
  const wrongSignature = await put(c, disguised.json.items[0].attachmentId, jpeg, 'image/png');
  assert.equal(wrongSignature.status, 422);
  assert.equal(wrongSignature.json.code, 'attachment_rejected');
  const r = await reserve(c, key(), 'thread.create', [meta('vrai.png', 'image/png', png)]);
  const id = r.json.items[0].attachmentId;
  assert.equal((await put(c, id, png, 'image/jpeg')).status, 422, 'Content-Type différent de la réservation');
  const longer = new Uint8Array([...png, 1]);
  assert.equal((await put(c, id, longer, 'image/png')).status, 422, 'un octet de plus');
  const altered = png.slice();
  altered[1500] ^= 1;
  const digest = await put(c, id, altered, 'image/png');
  assert.equal(digest.status, 422, 'empreinte différente');
  assert.equal(await count('SELECT COUNT(*) AS n FROM attachments WHERE attachment_id IN (?, ?) AND uploaded = 1', id, disguised.json.items[0].attachmentId), 0);
  assert.deepEqual((await objects()).filter((o) => o.endsWith(id) || o.endsWith(disguised.json.items[0].attachmentId)), [], 'aucun objet écrit pour un refus');
  assert.equal((await put(c, id, png, 'image/png')).status, 200, 'les bons octets passent ensuite');
  facts.refus = { gif: gif.status, cinq: five.status, nom: named.status, vide: empty.status, signature: wrongSignature.status, digest: digest.status };
});

test('rejeu même clé : ni message ni objet dupliqué ; conflit pour une autre charge ; pièces non téléversées refusées', async () => {
  const c = await claire();
  const files = [{ name: 'a.webp', type: 'image/webp', bytes: piece('image/webp', 2500, 'rejeu') }];
  const k = key();
  const { list, ids } = await upload(c, k, 'thread.create', files);
  const body = { kind: 'global', body: 'Rejeu', attachments: list };
  const first = await call(c, 'POST', `${base}/threads`, body, { 'Idempotency-Key': k });
  assert.equal(first.status, 201);
  const again = await reserve(c, k, 'thread.create', list);
  assert.deepEqual(again.json.items, [{ attachmentId: ids[0], uploaded: true }], 'même pièce, déjà rattachée');
  const replay = await call(c, 'POST', `${base}/threads`, body, { 'Idempotency-Key': k });
  assert.equal(replay.status, 200);
  assert.equal(replay.json.threadId, first.json.threadId);
  assert.equal(await count('SELECT COUNT(*) AS n FROM messages WHERE thread_id = ?', first.json.threadId), 1);
  assert.equal((await objects()).filter((o) => o.endsWith(ids[0]!)).length, 1);
  assert.equal((await reserve(c, k, 'thread.create', [meta('b.webp', 'image/webp', piece('image/webp', 2500, 'autre'))])).status, 409, 'autres pièces sous la même clé');
  assert.equal((await call(c, 'POST', `${base}/threads`, { ...body, body: 'Autre texte' }, { 'Idempotency-Key': k })).status, 409, 'autre texte sous la même clé');

  const k2 = key();
  const png = piece('image/png', 1200, 'manquante');
  await reserve(c, k2, 'thread.create', [meta('m.png', 'image/png', png)]);
  const missing = await call(c, 'POST', `${base}/threads`, { kind: 'global', body: 'Sans octets', attachments: [meta('m.png', 'image/png', png)] }, { 'Idempotency-Key': k2 });
  assert.equal(missing.status, 409);
  assert.equal(missing.json.code, 'attachment_missing');
  assert.equal(await count('SELECT COUNT(*) AS n FROM operations WHERE idempotency_key = ?', k2), 0, 'aucun faux succès');
  const unreserved = await call(c, 'POST', `${base}/threads`, { kind: 'global', body: 'Jamais réservée', attachments: [meta('n.png', 'image/png', png)] }, { 'Idempotency-Key': key() });
  assert.equal(unreserved.json.code, 'attachment_missing');
});

test('réponse faite d’une pièce et retour ciblé avec pièces, relus dans le fil', async () => {
  const c = await claire();
  const g = await call(c, 'POST', `${base}/threads`, { kind: 'global', body: 'Fil pour répondre' }, { 'Idempotency-Key': key() });
  const k = key();
  const { list } = await upload(c, k, 'message.create', [{ name: 'réponse.png', type: 'image/png', bytes: piece('image/png', 1500, 'reponse') }]);
  const replied = await call(c, 'POST', `${base}/threads/${g.json.threadId}/messages`, { body: '', attachments: list }, { 'Idempotency-Key': k });
  assert.equal(replied.status, 201, JSON.stringify(replied.json));
  assert.equal(replied.json.body, '');
  assert.equal(replied.json.attachments.length, 1);
  const again = await call(c, 'POST', `${base}/threads/${g.json.threadId}/messages`, { body: '', attachments: list }, { 'Idempotency-Key': k });
  assert.equal(again.status, 200);
  assert.deepEqual(again.json.attachments, replied.json.attachments);

  const capture = piece('image/png', 3000, 'capture');
  const kt = key();
  const files = [{ name: 'détail.jpg', type: 'image/jpeg', bytes: piece('image/jpeg', 1800, 'cible') }];
  const listT = files.map((f) => meta(f.name, f.type, f.bytes));
  const res = await call(c, 'POST', `${base}/targeted`, {
    kind: 'targeted', body: 'Avec une photo',
    target: {
      url: 'http://127.0.0.1:5173/reglages/rappels', route: '/reglages/rappels', rect: { x: 1, y: 2, width: 3, height: 4 },
      viewport: { width: 1280, height: 800, devicePixelRatio: 1, scrollX: 0, scrollY: 0 }, role: 'button', text: 'Enregistrer', selector: 'button', html: '<button type="button">Enregistrer</button>',
    },
    image: { contentType: 'image/png', size: capture.byteLength, sha256: sha(capture), width: 1280, height: 800 },
    attachments: listT,
  }, { 'Idempotency-Key': kt });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  const cap = await fetch(`${c.url}${base}/captures/${res.json.captureId}?attempt=${res.json.attempt}`, { method: 'PUT', headers: { Authorization: `Bearer ${c.token}`, Origin: c.origin!, 'Content-Type': 'image/png' }, body: capture as BodyInit });
  assert.equal(cap.status, 200);
  const early = await call(c, 'POST', `${base}/captures/${res.json.captureId}/commit`, { attempt: res.json.attempt });
  assert.equal(early.json.code, 'attachment_missing', 'capture seule : pas de retour sans ses pièces');
  await upload(c, kt, 'thread.targeted', files);
  const done = await call(c, 'POST', `${base}/captures/${res.json.captureId}/commit`, { attempt: res.json.attempt });
  assert.equal(done.status, 201, JSON.stringify(done.json));
  assert.equal(done.json.messages[0].attachments[0].name, 'détail.jpg');
  assert.equal(done.json.capture.contentType, 'image/png', 'capture technique distincte de la pièce');
  const read = await call(c, 'GET', `${base}/threads/${done.json.threadId}`);
  assert.equal(read.json.messages[0].attachments.length, 1);
});

test('AVIF renommé MP4 refusé avant objet complet et message', async () => {
  const c = await claire();
  const bytes = await readFile(new URL('../../../tools/local/fixtures/media/non-mp4.avif', import.meta.url));
  const k = key();
  const list = [meta('image.mp4', 'video/mp4', bytes)];
  const r = await reserve(c, k, 'thread.create', list);
  assert.equal(r.status, 201);
  const id = r.json.items[0].attachmentId;
  const up = await put(c, id, bytes, 'video/mp4');
  assert.equal(up.status, 422, JSON.stringify(up.json));
  assert.equal(up.json.code, 'attachment_rejected');
  const published = await call(c, 'POST', `${base}/threads`, { kind: 'global', body: 'AVIF refusé', attachments: list }, { 'Idempotency-Key': k });
  assert.equal(published.status, 409);
  assert.equal(await count('SELECT COUNT(*) AS n FROM messages WHERE body = ?', 'AVIF refusé'), 0);
  assert.equal(await count('SELECT COUNT(*) AS n FROM attachments WHERE attachment_id = ? AND uploaded = 1', id), 0);
  assert.deepEqual((await objects()).filter((o) => o.endsWith(id)), []);
  facts.avifRefuse = { size: bytes.length, sha256: sha(bytes), reservation: r.status, upload: up.status, publication: published.status, messages: 0, objets: 0 };
});

test('droits : autre auteur, autre projet, autre opération, aucun double rattachement', async () => {
  const c = await claire();
  const k = await karim();
  const png = piece('image/png', 1400, 'droits');
  const kc = key();
  const r = await reserve(c, kc, 'thread.create', [meta('c.png', 'image/png', png)]);
  const id = r.json.items[0].attachmentId;
  assert.equal((await put(k, id, png, 'image/png')).status, 404, 'Karim ne téléverse pas la pièce de Claire');
  assert.equal((await put(c, id, png, 'image/png')).status, 200);
  const stolen = await call(k, 'POST', `${base}/threads`, { kind: 'global', body: 'Vol', attachments: [meta('c.png', 'image/png', png)] }, { 'Idempotency-Key': kc });
  assert.equal(stolen.json.code, 'attachment_missing', 'la clé de Claire ne désigne rien pour Karim');
  const own = await call(c, 'POST', `${base}/threads`, { kind: 'global', body: 'Mienne', attachments: [meta('c.png', 'image/png', png)] }, { 'Idempotency-Key': kc });
  assert.equal(own.status, 201);
  const twice = await call(c, 'POST', `${base}/threads/${own.json.threadId}/messages`, { body: 'Encore', attachments: [meta('c.png', 'image/png', png)] }, { 'Idempotency-Key': kc });
  assert.equal(twice.json.code, 'attachment_missing', 'une pièce rattachée ne l’est jamais une seconde fois');
  assert.equal(await count("SELECT COUNT(*) AS n FROM attachments WHERE attachment_id = ? AND state = 'attached'", id), 1);
  const otherProject = await rt.provisionCredential(bench.service.db, { projectId: 'autre', label: 'agent-autre', capabilities: ['review.read'] });
  const foreign = await fetch(`${c.url}${base}/attachments/${id}`, { headers: { Authorization: `Bearer ${otherProject}` } });
  assert.equal(foreign.status, 403, 'autre projet');
  const readByKarim = await fetch(`${c.url}${base}/attachments/${id}`, { headers: { Authorization: `Bearer ${k.token}`, Origin: k.origin! } });
  assert.equal(readByKarim.status, 200, 'un autre lecteur autorisé lit la pièce');
  await readByKarim.arrayBuffer();
  const wrongReview = await call(c, 'GET', `/v1/projects/${PROJECT}/reviews/autre-revue/attachments/${id}`);
  assert.equal(wrongReview.status, 403);
  const agent = { url: c.url, token: bench.agentToken };
  assert.equal((await reserve(agent, key(), 'thread.create', [meta('non.png', 'image/png', png)])).status, 403, 'un accès technique ne réserve pas');
  const guest = await sessionClient(bench, { deploymentId: 'local-1', sub: 'invite', capabilities: [] });
  assert.equal((await call(guest, 'GET', `${base}/attachments/${id}`)).status, 403, 'capacité de lecture requise');
  assert.equal((await put(guest, id, png, 'image/png')).status, 403);
  await bench.service.db.prepare("UPDATE sessions SET expires_at = 1 WHERE actor_key = ?").bind(c.session.actor.key).run();
  assert.equal((await call(c, 'GET', `${base}/attachments/${id}`)).status, 401, 'session expirée');
  assert.equal((await put(c, id, png, 'image/png')).status, 401);
  const fresh = await claire();
  assert.equal((await call({ url: c.url, token: bench.importToken }, 'POST', `${base}/deployments/local-1/revoke`)).status, 200);
  assert.equal((await call(fresh, 'GET', `${base}/attachments/${id}`)).status, 403, 'déploiement révoqué');
  assert.equal((await put(fresh, id, png, 'image/png')).status, 403);
  assert.equal((await reserve(fresh, key(), 'thread.create', [meta('non.png', 'image/png', png)])).status, 403);
  const technicalRead = await fetch(`${c.url}${base}/attachments/${id}`, { headers: { Authorization: `Bearer ${bench.agentToken}` } });
  assert.equal(technicalRead.status, 200, 'lecture agent conservée après révocation de la preview');
  await technicalRead.arrayBuffer();
  facts.droits = { autreAuteur: 404, autreProjet: foreign.status, autreRevue: wrongReview.status, lecteurAutorise: readByKarim.status, sessionExpiree: 401, deploiementRevoque: 403, agentLecture: technicalRead.status };
});
