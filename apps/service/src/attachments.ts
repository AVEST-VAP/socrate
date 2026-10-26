import { SIGNATURE_BYTES, digestOf, signatureMatches, type Attachment, type AttachmentMeta, type AttachmentOperation, type AttachmentReservation, type Json } from '@socrate/contract';
import type { Env } from './env.ts';
import { isConstraintViolation, uncertain } from './d1.ts';
import { HttpError, PRIVATE_HEADERS, nowIso } from './http.ts';
import { RESERVATION_TTL_SECONDS } from './captures.ts';
import { ACTIVE_REVIEW, requireActive, type Guard, type ParticipantScope, type WriterScope } from './threads.ts';

export const ATTACHMENT_PREFIX = 'attachments/';
export const attachmentPrefixOf = (projectId: string, reviewKey: string) => `${ATTACHMENT_PREFIX}${projectId}/${reviewKey}/`;

type Row = {
  attachment_id: string; actor_key: string; operation: AttachmentOperation; idempotency_key: string; position: number; payload_digest: string;
  name: string; content_type: AttachmentMeta['contentType']; size: number; sha256: string; object_key: string; state: 'reserved' | 'attached';
  uploaded: number; thread_id: string | null; message_id: string | null; expires_at: number;
};

const nowSec = () => Math.floor(Date.now() / 1000);
const metaOf = (r: Pick<Row, 'name' | 'content_type' | 'size' | 'sha256'>): AttachmentMeta => ({ name: r.name, contentType: r.content_type, size: r.size, sha256: r.sha256 });
const sameMeta = (a: AttachmentMeta, b: AttachmentMeta) => a.name === b.name && a.contentType === b.contentType && a.size === b.size && a.sha256 === b.sha256;
const OWNED = 'project_id = ? AND review_key = ? AND actor_key = ? AND operation = ? AND idempotency_key = ?';
const ownedBinds = (p: WriterScope, operation: AttachmentOperation, key: string) => [p.projectId, p.reviewKey, p.actor.key, operation, key];

/** Empreinte de la liste ordonnée des pièces : une même clé ne réserve jamais deux listes différentes. */
const listDigest = (list: AttachmentMeta[]) => digestOf(list as unknown as Json);

/**
 * Réserve les pièces d'une opération sous sa clé, avant tout octet. Un nouvel appel avec la même clé et la même liste rend les mêmes
 * identifiants et prolonge les réservations non rattachées ; une autre liste sous cette clé est un conflit. Aucune pièce d'une revue inactive.
 */
export async function reserveAttachments(env: Env, input: { scope: ParticipantScope; key: string; operation: AttachmentOperation; attachments: AttachmentMeta[] }): Promise<AttachmentReservation> {
  const p = input.scope;
  const digest = await listDigest(input.attachments);
  const owned = ownedBinds(p, input.operation, input.key);
  const expiresAt = nowSec() + RESERVATION_TTL_SECONDS;
  const createdAt = nowIso();
  try {
    await env.DB.batch([
      ...input.attachments.map((a, position) => {
        const id = crypto.randomUUID();
        return env.DB.prepare(
          `INSERT INTO attachments (project_id, review_key, attachment_id, actor_key, operation, idempotency_key, position, payload_digest, name, content_type, size, sha256, object_key, state, uploaded, thread_id, message_id, expires_at, created_at)
           SELECT project_id, review_key, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'reserved', 0, NULL, NULL, ?, ? FROM reviews WHERE project_id = ? AND review_key = ? AND state = 'active'
             AND NOT EXISTS (SELECT 1 FROM attachments WHERE ${OWNED} AND payload_digest <> ?)
           ON CONFLICT (project_id, review_key, actor_key, operation, idempotency_key, position) DO NOTHING`,
        ).bind(id, p.actor.key, input.operation, input.key, position, digest, a.name, a.contentType, a.size, a.sha256, `${attachmentPrefixOf(p.projectId, p.reviewKey)}${id}`,
          expiresAt, createdAt, p.projectId, p.reviewKey, ...owned, digest);
      }),
      env.DB.prepare(`UPDATE attachments SET expires_at = ? WHERE ${OWNED} AND payload_digest = ? AND state = 'reserved' AND ${ACTIVE_REVIEW}`).bind(expiresAt, ...owned, digest, p.projectId, p.reviewKey),
    ]);
  } catch (e) {
    if (!isConstraintViolation(e)) throw uncertain('réservation des pièces non confirmée, réessayer avec la même clé');
  }
  const rows = (await env.DB.prepare(`SELECT * FROM attachments WHERE ${OWNED} ORDER BY position`).bind(...owned).all<Row>()).results;
  if (rows.some((r) => r.payload_digest !== digest)) throw new HttpError(409, 'idempotency_conflict', 'même clé d’idempotence avec d’autres pièces');
  if (rows.length !== input.attachments.length) {
    await requireActive(env, p.projectId, p.reviewKey);
    throw new HttpError(503, 'reservation_lost', 'réservation des pièces incomplète, réessayer avec la même clé', true);
  }
  const live = rows.filter((r) => r.state === 'reserved');
  return {
    items: rows.map((r) => ({ attachmentId: r.attachment_id, uploaded: r.uploaded === 1 })),
    expiresAt: new Date((live.length ? Math.min(...live.map((r) => r.expires_at)) : expiresAt) * 1000).toISOString(),
  };
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');

/**
 * Octets d'une pièce réservée par son auteur, lus en flux sans jamais tenir la pièce entière en mémoire : taille bornée pendant la
 * lecture, signature des premiers octets cohérente avec le type réservé, SHA-256 calculé au passage et revérifié par R2. L'objet propre
 * à la pièce n'est écrit que s'il est absent ; un objet existant identique rend l'appel idempotent.
 */
export async function uploadAttachment(env: Env, input: { scope: ParticipantScope; attachmentId: string; contentType: string; declaredLength: number | null; body: ReadableStream<Uint8Array> | null }): Promise<void> {
  const p = input.scope;
  const row = await env.DB.prepare('SELECT * FROM attachments WHERE project_id = ? AND review_key = ? AND attachment_id = ? AND actor_key = ?')
    .bind(p.projectId, p.reviewKey, input.attachmentId, p.actor.key).first<Row>();
  if (!row) throw new HttpError(404, 'not_found', 'pièce inconnue');
  if (row.state === 'attached') return;
  if (row.expires_at <= nowSec()) throw new HttpError(409, 'attachment_missing', 'réservation de la pièce expirée : réserver à nouveau avec la même clé', true);
  await requireActive(env, p.projectId, p.reviewKey);
  const existing = await env.CAPTURES.head(row.object_key);
  // Un objet déjà présent a été vérifié à son écriture : même empreinte et même taille, imposées par R2 et la longueur fixe.
  if (!existing || existing.customMetadata?.sha256 !== row.sha256 || existing.size !== row.size) {
    if (input.contentType !== row.content_type) throw new HttpError(422, 'attachment_rejected', `Content-Type ${row.content_type} attendu pour cette pièce`);
    if (input.declaredLength !== null && input.declaredLength !== row.size) throw new HttpError(422, 'attachment_rejected', `taille annoncée ${input.declaredLength}, ${row.size} octets réservés`);
    if (!input.body) throw new HttpError(422, 'attachment_rejected', 'corps de la pièce absent');
    await streamInto(env, row, input.body);
  }
  const marked = await env.DB.prepare("UPDATE attachments SET uploaded = 1 WHERE project_id = ? AND review_key = ? AND attachment_id = ? AND state = 'reserved'")
    .bind(p.projectId, p.reviewKey, input.attachmentId).run().catch(() => { throw uncertain('téléversement non confirmé, réessayer'); });
  if ((marked.meta.changes ?? 0) === 0) throw new HttpError(409, 'attachment_missing', 'réservation de la pièce perdue pendant le téléversement', true);
}

async function streamInto(env: Env, row: Row, body: ReadableStream<Uint8Array>): Promise<void> {
  let failure: HttpError | null = null;
  const fail = (message: string) => (failure ??= new HttpError(422, 'attachment_rejected', message));
  const head = new Uint8Array(SIGNATURE_BYTES);
  const want = Math.min(SIGNATURE_BYTES, row.size);
  let seen = 0;
  let last: Uint8Array | null = null;
  const digest = new crypto.DigestStream('SHA-256');
  const digesting = digest.getWriter();
  const verify = new TransformStream<Uint8Array, Uint8Array>({
    async transform(chunk, controller) {
      if (seen + chunk.byteLength > row.size) throw fail(`pièce plus longue que les ${row.size} octets réservés`);
      if (seen < want) head.set(chunk.subarray(0, want - seen), seen);
      const before = seen;
      seen += chunk.byteLength;
      if (before < want && seen >= want && !signatureMatches(row.content_type, head.subarray(0, want))) throw fail(`octets qui ne sont pas un fichier ${row.content_type}`);
      await digesting.write(chunk);
      if (last) controller.enqueue(last);
      last = chunk;
    },
    async flush(controller) {
      if (seen !== row.size) throw fail(`pièce de ${seen} octets, ${row.size} réservés`);
      await digesting.close();
      if (hex(await digest.digest) !== row.sha256) throw fail('empreinte SHA-256 différente de la pièce réservée');
      // La longueur complète n'arrive chez R2 qu'après validation du flux entier.
      if (last) controller.enqueue(last);
    },
  });
  // R2 exige une longueur connue pour un flux ; elle refuse aussi tout octet de plus ou de moins.
  const fixed = new FixedLengthStream(row.size);
  const piped = body.pipeThrough(verify).pipeTo(fixed.writable).then(() => null, (e: unknown) => e);
  // Sans condition d'absence : toute écriture de cette clé porte les mêmes octets, empreinte vérifiée par R2 et longueur fixe.
  const put = await env.CAPTURES.put(row.object_key, fixed.readable, {
    sha256: row.sha256, httpMetadata: { contentType: row.content_type }, customMetadata: { sha256: row.sha256, attachmentId: row.attachment_id },
  }).then(() => true, () => false);
  const broken = await piped;
  if (!put || broken || failure) {
    // Une tentative concurrente peut avoir validé cet objet : l'échec ne le supprime jamais. Le nettoyage reprend les réservations expirées.
    throw failure ?? new HttpError(503, 'persistence_uncertain', 'téléversement interrompu, réessayer', true);
  }
}

export type AttachPlan = { guard: Guard; attach: (threadId: string, messageId: string, produced: Guard) => D1PreparedStatement; attachments: Attachment[] };

/**
 * Prépare le rattachement des pièces déclarées par le message : mêmes pièces, même ordre, toutes téléversées, objets présents et
 * réservations encore valides. `guard` conditionne la création du message dans le même batch ; `attach` les lie au message créé.
 * Une liste vide rend `null` : le message garde la forme d’avant les pièces jointes.
 */
export async function planAttachments(env: Env, input: { scope: WriterScope; operation: AttachmentOperation; key: string; attachments: AttachmentMeta[] | undefined }): Promise<AttachPlan | null> {
  const declared = input.attachments ?? [];
  if (!declared.length) return null;
  const p = input.scope;
  const owned = ownedBinds(p, input.operation, input.key);
  const digest = await listDigest(declared);
  const rows = (await env.DB.prepare(`SELECT * FROM attachments WHERE ${OWNED} ORDER BY position`).bind(...owned).all<Row>()).results;
  if (!rows.length) throw new HttpError(409, 'attachment_missing', 'pièces non réservées sous cette clé : réserver puis téléverser avant de publier', true);
  if (rows.some((r) => r.payload_digest !== digest) || rows.length !== declared.length || rows.some((r, i) => !sameMeta(metaOf(r), declared[i]!))) {
    throw new HttpError(409, 'idempotency_conflict', 'pièces différentes de celles réservées sous cette clé');
  }
  const now = nowSec();
  for (const r of rows) {
    if (r.state !== 'reserved' || r.uploaded !== 1 || r.expires_at <= now) throw new HttpError(409, 'attachment_missing', `pièce « ${r.name} » non téléversée ou réservation expirée : téléverser à nouveau avec la même clé`, true);
    const object = await env.CAPTURES.head(r.object_key);
    if (!object || object.customMetadata?.sha256 !== r.sha256 || object.size !== r.size) throw new HttpError(409, 'attachment_missing', `pièce « ${r.name} » absente du stockage : téléverser à nouveau`, true);
  }
  const ids = JSON.stringify(rows.map((r) => r.attachment_id));
  const ready = `${OWNED} AND attachment_id IN (SELECT value FROM json_each(?)) AND payload_digest = ? AND state = 'reserved' AND uploaded = 1`;
  return {
    guard: { sql: `SELECT 1 WHERE (SELECT COUNT(*) FROM attachments WHERE ${ready} AND expires_at > ?) = ?`, binds: [...owned, ids, digest, now, rows.length] },
    attach: (threadId, messageId, produced) => env.DB.prepare(`UPDATE attachments SET state = 'attached', thread_id = ?, message_id = ? WHERE ${ready} AND EXISTS (${produced.sql})`)
      .bind(threadId, messageId, ...owned, ids, digest, ...produced.binds),
    attachments: rows.map((r) => ({ attachmentId: r.attachment_id, ...metaOf(r) })),
  };
}

export type AttachmentRow = Pick<Row, 'attachment_id' | 'thread_id' | 'message_id' | 'name' | 'content_type' | 'size' | 'sha256'>;
export const ATTACHED_SQL = "SELECT attachment_id, thread_id, message_id, name, content_type, size, sha256 FROM attachments WHERE state = 'attached' AND project_id = ? AND review_key = ?";
export const toAttachment = (r: AttachmentRow): Attachment => ({ attachmentId: r.attachment_id, ...metaOf(r) });

/** Octets d'une pièce rattachée, servis avec leur type validé, jamais interprétés : ni reniflage, ni document actif, ni cache partagé. */
export async function readAttachment(env: Env, projectId: string, reviewKey: string, attachmentId: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT object_key, content_type, sha256 FROM attachments WHERE project_id = ? AND review_key = ? AND attachment_id = ? AND state = 'attached'")
    .bind(projectId, reviewKey, attachmentId).first<Pick<Row, 'object_key' | 'content_type' | 'sha256'>>();
  if (!row) throw new HttpError(404, 'not_found', 'pièce inconnue');
  const object = await env.CAPTURES.get(row.object_key);
  if (!object) throw new HttpError(503, 'persistence_uncertain', 'pièce validée introuvable dans le stockage', true);
  return new Response(object.body, {
    headers: {
      ...PRIVATE_HEADERS, 'Content-Type': row.content_type, 'Content-Length': String(object.size), 'Content-Disposition': 'inline',
      'Content-Security-Policy': "default-src 'none'; sandbox", ETag: `"${row.sha256}"`,
    },
  });
}

export type ReclaimedAttachments = { reclaimed: string[]; strayObjects: string[]; scanned: number };

/**
 * Supprime les pièces réservées et non rattachées dont la réservation a expiré, ligne puis objet, et les objets du préfixe sans
 * ligne plus vieux qu'une réservation. Une pièce rattachée n'est jamais candidate. Appelé seulement par le nettoyage manuel de la
 * phase de maintenance exclusive : un objet dont la suppression échoue reste un orphelin repris au passage suivant.
 */
export async function reclaimExpiredAttachments(env: Pick<Env, 'DB' | 'CAPTURES'>, opts: { limit?: number; pageSize?: number; now?: number } = {}): Promise<ReclaimedAttachments> {
  const at = opts.now ?? nowSec();
  const out: ReclaimedAttachments = { reclaimed: [], strayObjects: [], scanned: 0 };
  const expired = (await env.DB.prepare("DELETE FROM attachments WHERE rowid IN (SELECT rowid FROM attachments WHERE state = 'reserved' AND expires_at <= ? LIMIT ?) RETURNING attachment_id, object_key")
    .bind(at, opts.limit ?? 50).all<{ attachment_id: string; object_key: string }>()).results;
  for (const r of expired) {
    await env.CAPTURES.delete(r.object_key).catch(() => undefined);
    out.reclaimed.push(r.attachment_id);
  }
  let cursor: string | undefined;
  do {
    const page = await env.CAPTURES.list({ prefix: ATTACHMENT_PREFIX, limit: opts.pageSize ?? 200, cursor });
    out.scanned += page.objects.length;
    const keys = JSON.stringify(page.objects.map((o) => o.key));
    const known = new Set((await env.DB.prepare('SELECT object_key FROM attachments WHERE object_key IN (SELECT value FROM json_each(?))').bind(keys).all<{ object_key: string }>()).results.map((r) => r.object_key));
    for (const o of page.objects) {
      if (known.has(o.key) || at * 1000 - o.uploaded.getTime() < RESERVATION_TTL_SECONDS * 1000) continue;
      await env.CAPTURES.delete(o.key);
      out.strayObjects.push(o.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}
