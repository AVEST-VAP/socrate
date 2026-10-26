import { digestOf, randomToken, sha256Hex, type Json, type NewTargetedThread, type Reservation, type ThreadWithMessages } from '@socrate/contract';
import type { Env } from './env.ts';
import { isConstraintViolation, uncertain } from './d1.ts';
import { HttpError, nowIso } from './http.ts';
import { asThread, changeStatement, commit, operationStatement, recordedResult, scopeOf, type Guard, type ParticipantScope } from './threads.ts';
import { planAttachments } from './attachments.ts';
import { proposalStatement, resolvePageProposal, revisionOf } from './wordings.ts';

export const RESERVATION_TTL_SECONDS = 600;
export const RECLAIM_LEASE_SECONDS = 120;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

type CaptureRow = {
  capture_id: string; actor_key: string; idempotency_key: string; payload_digest: string; payload: string; attempt: string;
  state: 'reserved' | 'committed' | 'reclaiming'; uploaded: number; object_key: string; size: number; sha256: string; thread_id: string | null; expires_at: number;
};

const nowSec = () => Math.floor(Date.now() / 1000);
const payloadOf = (input: NewTargetedThread): Json => ({ kind: 'targeted', body: input.body, target: input.target, image: input.image, ...(input.proposal && { proposal: input.proposal }), ...(input.attachments?.length && { attachments: input.attachments }) } as unknown as Json);

export type Reserved = { kind: 'reserved'; reservation: Reservation } | { kind: 'committed'; thread: ThreadWithMessages };

/** Réserve l'opération en D1 avant tout PUT R2. Chaque appel prend une nouvelle tentative : seule la dernière peut téléverser et valider. */
export async function reserve(env: Env, input: { scope: ParticipantScope; key: string; payload: NewTargetedThread }): Promise<Reserved> {
  const p = input.scope;
  const digest = await digestOf(payloadOf(input.payload));
  const scope = scopeOf(p, 'thread.targeted', input.key);
  const stored = await recordedResult(env, scope, digest);
  if (stored !== null) return { kind: 'committed', thread: asThread(stored) };
  if (input.payload.proposal) {
    // Refus avant toute réservation : aucun octet n'est téléversé pour une proposition invalide.
    const revision = await revisionOf(env, p.projectId, p.reviewKey, p.deploymentId);
    if (!revision) throw new HttpError(404, 'not_found', 'déploiement de la session inconnu');
    resolvePageProposal(revision, input.payload.proposal, input.payload.target);
  }
  const captureId = crypto.randomUUID();
  const attempt = randomToken();
  const expiresAt = nowSec() + RESERVATION_TTL_SECONDS;
  const img = input.payload.image;
  try {
    await env.DB.prepare(
      `INSERT INTO captures (project_id, review_key, capture_id, actor_key, idempotency_key, payload_digest, payload, attempt, state, uploaded, object_key, content_type, size, sha256, width, height, thread_id, expires_at, created_at)
       SELECT project_id, review_key, ?, ?, ?, ?, ?, ?, 'reserved', 0, ?, ?, ?, ?, ?, ?, NULL, ?, ? FROM reviews WHERE project_id = ? AND review_key = ? AND state = 'active'
       ON CONFLICT (project_id, review_key, actor_key, idempotency_key) DO UPDATE SET attempt = excluded.attempt, expires_at = excluded.expires_at
       WHERE captures.state = 'reserved' AND captures.payload_digest = excluded.payload_digest`,
    ).bind(captureId, p.actor.key, input.key, digest, JSON.stringify(payloadOf(input.payload)), attempt, `captures/${p.projectId}/${p.reviewKey}/${captureId}.png`,
      img.contentType, img.size, img.sha256, img.width, img.height, expiresAt, nowIso(), p.projectId, p.reviewKey).run();
  } catch (e) {
    if (!isConstraintViolation(e)) throw uncertain('réservation non confirmée, réessayer avec la même clé');
  }
  const row = await env.DB.prepare('SELECT * FROM captures WHERE project_id = ? AND review_key = ? AND actor_key = ? AND idempotency_key = ?')
    .bind(p.projectId, p.reviewKey, p.actor.key, input.key).first<CaptureRow>();
  if (!row) throw new HttpError(409, 'review_inactive', 'la revue n’accepte plus de retours');
  if (row.payload_digest !== digest) throw new HttpError(409, 'idempotency_conflict', 'même clé d’idempotence avec une charge différente');
  if (row.state === 'committed') {
    const raced = await recordedResult(env, scope, digest);
    if (raced !== null) return { kind: 'committed', thread: asThread(raced) };
    throw uncertain();
  }
  if (row.state === 'reclaiming' || row.attempt !== attempt) throw new HttpError(503, 'reservation_lost', 'réservation reprise par une autre tentative ou en cours de nettoyage, réessayer', true);
  return { kind: 'reserved', reservation: { status: 'reserved', captureId: row.capture_id, attempt, uploaded: row.uploaded === 1, expiresAt: new Date(row.expires_at * 1000).toISOString() } };
}

async function ownedRow(env: Env, p: ParticipantScope, captureId: string, attempt: string): Promise<CaptureRow> {
  const row = await env.DB.prepare('SELECT * FROM captures WHERE project_id = ? AND review_key = ? AND capture_id = ? AND actor_key = ?')
    .bind(p.projectId, p.reviewKey, captureId, p.actor.key).first<CaptureRow>();
  if (!row) throw new HttpError(404, 'not_found', 'capture inconnue');
  if (row.state === 'committed') return row;
  if (row.state !== 'reserved' || row.attempt !== attempt || row.expires_at <= nowSec()) throw new HttpError(409, 'reservation_lost', 'cette tentative ne possède plus la réservation, réserver à nouveau avec la même clé', true);
  return row;
}

/** Octets immuables : l'objet propre à l'opération n'est écrit que s'il est absent, et seulement avec l'empreinte réservée. */
export async function upload(env: Env, input: { scope: ParticipantScope; captureId: string; attempt: string; bytes: Uint8Array }): Promise<void> {
  const row = await ownedRow(env, input.scope, input.captureId, input.attempt);
  if (row.state === 'committed') return;
  const b = input.bytes;
  if (b.byteLength !== row.size || !PNG_SIGNATURE.every((v, i) => b[i] === v)) throw new HttpError(422, 'capture_mismatch', 'octets différents de l’image réservée (taille ou format PNG)');
  const sha = await sha256Hex(b);
  if (sha !== row.sha256) throw new HttpError(422, 'capture_mismatch', 'empreinte SHA-256 différente de l’image réservée');
  const existing = await env.CAPTURES.head(row.object_key);
  if (existing) {
    if (existing.customMetadata?.sha256 !== row.sha256) throw new HttpError(409, 'capture_mismatch', 'objet existant différent, aucune réécriture');
  } else {
    const put = await env.CAPTURES.put(row.object_key, b, { sha256: sha, httpMetadata: { contentType: 'image/png' }, customMetadata: { sha256: sha, captureId: row.capture_id }, onlyIf: { etagDoesNotMatch: '*' } });
    if (put === null) {
      const raced = await env.CAPTURES.head(row.object_key);
      if (raced?.customMetadata?.sha256 !== row.sha256) throw new HttpError(409, 'capture_mismatch', 'objet existant différent, aucune réécriture');
    }
  }
  const marked = await env.DB.prepare("UPDATE captures SET uploaded = 1 WHERE project_id = ? AND review_key = ? AND capture_id = ? AND state = 'reserved' AND attempt = ?")
    .bind(input.scope.projectId, input.scope.reviewKey, input.captureId, input.attempt).run().catch(() => { throw uncertain('téléversement non confirmé, réessayer'); });
  if ((marked.meta.changes ?? 0) === 0) throw new HttpError(409, 'reservation_lost', 'réservation perdue pendant le téléversement', true);
}

export type TargetedPublished = { created: boolean; thread: ThreadWithMessages };

/** Rend le retour visible dans un seul batch conditionné à la réservation, la charge, la revue active, l'upload et la possession de la tentative. */
export async function commitTargeted(env: Env, input: { scope: ParticipantScope; captureId: string; attempt: string }): Promise<TargetedPublished> {
  const p = input.scope;
  const row = await ownedRow(env, p, input.captureId, input.attempt);
  const scope = scopeOf(p, 'thread.targeted', row.idempotency_key);
  const replayOf = async () => {
    const stored = await recordedResult(env, scope, row.payload_digest);
    if (stored === null) throw uncertain();
    return { created: false, thread: asThread(stored) };
  };
  if (row.state === 'committed') return replayOf();
  if (row.uploaded !== 1) throw new HttpError(409, 'capture_missing', 'image non téléversée pour cette réservation', true);
  const object = await env.CAPTURES.head(row.object_key);
  if (!object || object.customMetadata?.sha256 !== row.sha256 || object.size !== row.size) throw new HttpError(409, 'capture_missing', 'image absente du stockage, téléverser à nouveau', true);

  const payload = JSON.parse(row.payload) as NewTargetedThread;
  const revision = await revisionOf(env, p.projectId, p.reviewKey, p.deploymentId);
  if (!revision) throw new HttpError(404, 'not_found', 'déploiement de la session inconnu');
  // La charge réservée fige la révision observée : une session renouvelée sur une autre révision est refusée ici aussi.
  const proposal = payload.proposal ? resolvePageProposal(revision, payload.proposal, payload.target) : null;
  const pieces = await planAttachments(env, { scope: p, operation: 'thread.targeted', key: row.idempotency_key, attachments: payload.attachments });
  const threadId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const at = nowIso();
  const snapshot: ThreadWithMessages = {
    threadId, kind: 'targeted', state: 'open', version: 0, revisionId: revision.revisionId, deploymentId: p.deploymentId, author: p.actor, createdAt: at, updatedAt: at,
    target: payload.target, capture: { captureId: row.capture_id, status: 'available', ...payload.image }, proposal,
    messages: [{ messageId, threadId, seq: 1, author: p.actor, exploring: p.exploring, body: payload.body, attachments: pieces?.attachments ?? [], via: null, transition: null, createdAt: at }],
  };
  const owned: Guard = {
    sql: "SELECT 1 FROM captures WHERE project_id = ? AND review_key = ? AND capture_id = ? AND actor_key = ? AND state = 'reserved' AND attempt = ? AND payload_digest = ? AND uploaded = 1 AND expires_at > ?",
    binds: [p.projectId, p.reviewKey, row.capture_id, p.actor.key, input.attempt, row.payload_digest, nowSec()],
  };
  const produced: Guard = { sql: "SELECT 1 FROM threads WHERE project_id = ? AND review_key = ? AND thread_id = ? AND kind = 'targeted'", binds: [p.projectId, p.reviewKey, threadId] };
  const outcome = await commit(env, scope, row.payload_digest, {
    before: [],
    mutation: env.DB.prepare(
      `INSERT INTO threads (project_id, review_key, thread_id, kind, state, version, revision_id, deployment_id, author_key, author_name, created_at, updated_at)
       SELECT project_id, review_key, ?, 'targeted', 'open', 0, ?, ?, ?, ?, ?, ? FROM reviews WHERE project_id = ? AND review_key = ? AND state = 'active' AND EXISTS (${owned.sql})${pieces ? ` AND EXISTS (${pieces.guard.sql})` : ''}`,
    ).bind(threadId, revision.revisionId, p.deploymentId, p.actor.key, p.actor.displayName, at, at, p.projectId, p.reviewKey, ...owned.binds, ...(pieces?.guard.binds ?? [])),
    after: [
      env.DB.prepare(`UPDATE captures SET state = 'committed', thread_id = ? WHERE project_id = ? AND review_key = ? AND capture_id = ? AND attempt = ? AND state = 'reserved' AND EXISTS (${produced.sql})`)
        .bind(threadId, p.projectId, p.reviewKey, row.capture_id, input.attempt, ...produced.binds),
      env.DB.prepare(`INSERT INTO targets (project_id, review_key, thread_id, capture_id, context) SELECT project_id, review_key, thread_id, ?, ? FROM threads WHERE project_id = ? AND review_key = ? AND thread_id = ? AND kind = 'targeted'`)
        .bind(row.capture_id, JSON.stringify(payload.target), p.projectId, p.reviewKey, threadId),
      env.DB.prepare(
        `INSERT INTO messages (project_id, review_key, thread_id, message_id, seq, author_key, author_name, exploring, body, created_at)
         SELECT project_id, review_key, thread_id, ?, 1, ?, ?, ?, ?, ? FROM threads WHERE project_id = ? AND review_key = ? AND thread_id = ?`,
      ).bind(messageId, p.actor.key, p.actor.displayName, p.exploring ? JSON.stringify(p.exploring) : null, payload.body, at, p.projectId, p.reviewKey, threadId),
      ...(pieces ? [pieces.attach(threadId, messageId, produced)] : []),
      ...(proposal ? [proposalStatement(env, p.projectId, p.reviewKey, threadId, proposal)] : []),
      changeStatement(env, scope, threadId, 'thread.created', at, produced),
      operationStatement(env, scope, row.payload_digest, snapshot as unknown as Json, at, produced),
    ],
  }, (stored) => Promise.resolve(asThread(stored)));
  if (outcome.kind === 'replayed') return { created: false, thread: outcome.result };
  if (outcome.kind === 'written') return { created: true, thread: snapshot };
  const review = await env.DB.prepare("SELECT 1 AS ok FROM reviews WHERE project_id = ? AND review_key = ? AND state = 'active'").bind(p.projectId, p.reviewKey).first();
  if (!review) throw new HttpError(409, 'review_inactive', 'la revue n’accepte plus de retours');
  if (pieces) throw new HttpError(409, 'attachment_missing', 'pièces ou réservation plus disponibles au moment de publier : reprendre avec la même clé', true);
  throw new HttpError(409, 'reservation_lost', 'cette tentative ne possède plus la réservation, réserver à nouveau avec la même clé', true);
}

/** Lecture sans mutation pour une reprise dont le partage est interrompu : la publication validée sous cette clé, ou 404 sans conclusion. */
export async function recognize(env: Env, input: { scope: ParticipantScope; key: string }): Promise<ThreadWithMessages> {
  const p = input.scope;
  const row = await env.DB.prepare("SELECT payload_digest FROM captures WHERE project_id = ? AND review_key = ? AND actor_key = ? AND idempotency_key = ? AND state = 'committed'")
    .bind(p.projectId, p.reviewKey, p.actor.key, input.key).first<{ payload_digest: string }>();
  if (!row) throw new HttpError(404, 'not_found', 'aucune publication validée sous cette clé à cette lecture');
  const stored = await recordedResult(env, scopeOf(p, 'thread.targeted', input.key), row.payload_digest);
  if (stored === null) throw uncertain();
  return asThread(stored);
}

export async function readCapture(env: Env, projectId: string, reviewKey: string, captureId: string): Promise<Response> {
  const row = await env.DB.prepare("SELECT object_key, sha256 FROM captures WHERE project_id = ? AND review_key = ? AND capture_id = ? AND state = 'committed'")
    .bind(projectId, reviewKey, captureId).first<{ object_key: string; sha256: string }>();
  if (!row) throw new HttpError(404, 'not_found', 'capture inconnue');
  const object = await env.CAPTURES.get(row.object_key);
  if (!object) throw new HttpError(503, 'persistence_uncertain', 'image validée introuvable dans le stockage', true);
  return new Response(object.body, {
    headers: { 'Content-Type': 'image/png', 'Content-Length': String(object.size), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Disposition': 'inline', ETag: `"${row.sha256}"` },
  });
}

export type Reclaimed = { reclaimed: string[]; deferred: string[]; strayObjects: string[]; scanned: number };

/**
 * Réclame atomiquement les réservations expirées, ou un nettoyage interrompu dont le bail a expiré, puis supprime objet et ligne.
 * Un échec laisse la ligne en `reclaiming` sous bail : l'invocation suivante la reprend. Une ligne validée n'est jamais candidate.
 * Les objets sans ligne sont cherchés sur toutes les pages du préfixe ; seuls ceux plus vieux qu'une réservation sont supprimés.
 */
export async function reclaimExpired(env: Env, opts: { limit?: number; pageSize?: number; now?: number } = {}): Promise<Reclaimed> {
  const at = opts.now ?? nowSec();
  const out: Reclaimed = { reclaimed: [], deferred: [], strayObjects: [], scanned: 0 };
  const candidates = await env.DB.prepare("SELECT project_id, review_key, capture_id FROM captures WHERE state IN ('reserved', 'reclaiming') AND expires_at <= ? LIMIT ?")
    .bind(at, opts.limit ?? 20).all<{ project_id: string; review_key: string; capture_id: string }>();
  for (const c of candidates.results) {
    const token = randomToken();
    const claimed = await env.DB.prepare("UPDATE captures SET state = 'reclaiming', attempt = ?, expires_at = ? WHERE project_id = ? AND review_key = ? AND capture_id = ? AND state IN ('reserved', 'reclaiming') AND expires_at <= ? RETURNING object_key")
      .bind(token, at + RECLAIM_LEASE_SECONDS, c.project_id, c.review_key, c.capture_id, at).first<{ object_key: string }>();
    if (!claimed) continue;
    try {
      await env.CAPTURES.delete(claimed.object_key);
      await env.DB.prepare("DELETE FROM captures WHERE project_id = ? AND review_key = ? AND capture_id = ? AND state = 'reclaiming' AND attempt = ?").bind(c.project_id, c.review_key, c.capture_id, token).run();
      out.reclaimed.push(c.capture_id);
    } catch {
      out.deferred.push(c.capture_id);
    }
  }
  let cursor: string | undefined;
  do {
    const page = await env.CAPTURES.list({ prefix: 'captures/', limit: opts.pageSize ?? 200, cursor });
    out.scanned += page.objects.length;
    const keys = JSON.stringify(page.objects.map((o) => o.key));
    const known = new Set((await env.DB.prepare('SELECT object_key FROM captures WHERE object_key IN (SELECT value FROM json_each(?))').bind(keys).all<{ object_key: string }>()).results.map((r) => r.object_key));
    for (const o of page.objects) {
      if (known.has(o.key) || at * 1000 - o.uploaded.getTime() < RESERVATION_TTL_SECONDS * 1000) continue;
      const still = await env.DB.prepare('SELECT 1 AS ok FROM captures WHERE object_key = ?').bind(o.key).first();
      if (still) continue;
      await env.CAPTURES.delete(o.key);
      out.strayObjects.push(o.key);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return out;
}
