import { millisecondBound, sha256Hex, type ChangesPage, type ReviewState, type ReviewSummary, type ThreadFilter, type ThreadPage } from '@socrate/contract';
import type { Env } from './env.ts';
import { HttpError } from './http.ts';
import { listThreads } from './threads.ts';
import type { RevisionRef } from './wordings.ts';

/** Durée de vie d'une liste figée : au-delà, le parcours recommence au premier appel. */
export const LISTING_TTL_SECONDS = 15 * 60;

const resync = (why: string) => new HttpError(410, 'resync_required', `${why} : relancer la liste sans curseur puis reprendre l'incrémental depuis son changesSince`);
const nowSec = () => Math.floor(Date.now() / 1000);
const hex128 = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
const bound = (s: string | undefined) => (s === undefined ? null : millisecondBound(s));
/** Portée d'un marqueur : la séquence du journal est globale, un marqueur d'une autre revue y sauterait des entrées. */
const scopeOf = async (projectId: string, reviewKey: string) => (await sha256Hex(JSON.stringify([projectId, reviewKey]))).slice(0, 32);
const marker = (epoch: string, scope: string, seq: number) => `c2.${epoch}.${scope}.${seq}`;

/** Une revue inconnue rend 404 avant toute liste technique : une faute de nom ne passe pas pour une revue vide. */
async function requireReview(env: Env, projectId: string, reviewKey: string): Promise<void> {
  const row = await env.DB.prepare('SELECT state, purged_at FROM reviews WHERE project_id = ? AND review_key = ?').bind(projectId, reviewKey).first<{ state: ReviewState; purged_at: string | null }>();
  if (!row) throw new HttpError(404, 'not_found', 'revue inconnue');
  if (row.state === 'purging' || row.state === 'purged') throw new HttpError(404, 'not_found', row.purged_at ? `revue purgée le ${row.purged_at}` : 'revue en cours de purge');
}

async function currentEpoch(env: Env): Promise<string> {
  return (await env.DB.prepare('SELECT epoch FROM sync_epoch WHERE singleton = 1').first<{ epoch: string }>())!.epoch;
}

type ListingRow = { project_id: string; review_key: string; filter: string; epoch: string; ceiling: number; total: number; expires_at: number };

/**
 * Le premier appel fige en un seul batch l'appartenance et l'ordre (création, identifiant) des fils filtrés, avec le plafond du journal.
 * Les pages suivantes relisent ces identifiants : aucun fil perdu ni répété, valeurs lues au moment de la page.
 */
export async function listPage(env: Env, projectId: string, reviewKey: string, query: { cursor: string; limit: number } | (ThreadFilter & { limit: number }), reference: RevisionRef | null): Promise<ThreadPage> {
  await requireReview(env, projectId, reviewKey);
  const now = nowSec();
  let listingId: string;
  let offset: number;
  let listing: ListingRow;
  if ('cursor' in query) {
    const [, id, at] = query.cursor.split('.') as [string, string, string];
    listingId = id;
    offset = Number(at);
    const row = await env.DB.prepare('SELECT * FROM listings WHERE listing_id = ?').bind(listingId).first<ListingRow>();
    if (!row) throw resync('curseur inconnu ou expiré');
    if (row.project_id !== projectId || row.review_key !== reviewKey) throw new HttpError(422, 'invalid_request', 'curseur émis pour une autre revue');
    if (row.expires_at <= now) throw resync('curseur expiré');
    if (row.epoch !== (await currentEpoch(env))) throw resync('epoch du curseur périmée');
    if (offset > row.total) throw new HttpError(422, 'invalid_request', 'curseur hors de la liste');
    listing = row;
  } else {
    const { limit: _, ...filter } = query;
    listingId = hex128();
    offset = 0;
    const state = filter.state ?? null;
    const since = bound(filter.updatedSince);
    const before = bound(filter.updatedBefore);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM listing_items WHERE listing_id IN (SELECT listing_id FROM listings WHERE expires_at <= ?)').bind(now),
      env.DB.prepare('DELETE FROM listings WHERE expires_at <= ?').bind(now),
      env.DB.prepare(
        `INSERT INTO listings (listing_id, project_id, review_key, filter, epoch, ceiling, total, expires_at)
         SELECT ?, ?, ?, ?, epoch, (SELECT COALESCE(MAX(seq), 0) FROM changes WHERE project_id = ? AND review_key = ?), 0, ? FROM sync_epoch WHERE singleton = 1`,
      ).bind(listingId, projectId, reviewKey, JSON.stringify(filter), projectId, reviewKey, now + LISTING_TTL_SECONDS),
      env.DB.prepare(
        `INSERT INTO listing_items (listing_id, position, thread_id)
         SELECT ?, ROW_NUMBER() OVER (ORDER BY created_at, thread_id), thread_id FROM threads
         WHERE project_id = ? AND review_key = ? AND (? IS NULL OR state = ?) AND (? IS NULL OR updated_at >= ?) AND (? IS NULL OR updated_at < ?)`,
      ).bind(listingId, projectId, reviewKey, state, state, since, since, before, before),
      env.DB.prepare('UPDATE listings SET total = (SELECT COUNT(*) FROM listing_items WHERE listing_id = ?) WHERE listing_id = ?').bind(listingId, listingId),
    ]);
    listing = (await env.DB.prepare('SELECT * FROM listings WHERE listing_id = ?').bind(listingId).first<ListingRow>())!;
  }
  const ids = (await env.DB.prepare('SELECT thread_id FROM listing_items WHERE listing_id = ? AND position > ? ORDER BY position LIMIT ?').bind(listingId, offset, query.limit).all<{ thread_id: string }>()).results.map((r) => r.thread_id);
  const end = offset + ids.length;
  return {
    items: ids.length ? await listThreads(env, projectId, reviewKey, reference, ids) : [],
    nextCursor: end < listing.total ? `l1.${listingId}.${end}` : null,
    changesSince: marker(listing.epoch, await scopeOf(projectId, reviewKey), listing.ceiling),
    filter: JSON.parse(listing.filter) as ThreadFilter,
    total: listing.total,
    expiresAt: new Date(listing.expires_at * 1000).toISOString(),
  };
}

/** Fils touchés par le journal après `since`, tous états confondus, chacun une fois par page avec sa valeur actuelle. */
export async function changesPage(env: Env, projectId: string, reviewKey: string, since: string, limit: number, reference: RevisionRef | null): Promise<ChangesPage> {
  await requireReview(env, projectId, reviewKey);
  if (since.startsWith('c1.')) throw resync('marqueur c1 sans portée de revue');
  const [, epoch, scope, seqText] = since.split('.') as [string, string, string, string];
  const own = await scopeOf(projectId, reviewKey);
  if (scope !== own) throw new HttpError(422, 'invalid_request', 'marqueur émis pour une autre revue');
  if (epoch !== (await currentEpoch(env))) throw resync('epoch du marqueur périmée');
  const rows = (await env.DB.prepare('SELECT seq, thread_id FROM changes WHERE project_id = ? AND review_key = ? AND seq > ? ORDER BY seq LIMIT ?')
    .bind(projectId, reviewKey, Number(seqText), limit).all<{ seq: number; thread_id: string }>()).results;
  const ids = [...new Set(rows.map((r) => r.thread_id))];
  const last = rows.at(-1)?.seq ?? Number(seqText);
  return { items: ids.length ? await listThreads(env, projectId, reviewKey, reference, ids) : [], next: marker(epoch, own, last), more: rows.length === limit };
}

export async function listReviews(env: Env, projectId: string): Promise<ReviewSummary[]> {
  const rows = (await env.DB.prepare(
    `SELECT v.review_key, v.state, v.created_at, v.archived_at, v.purge_after, v.purged_at, d.deployment_id, d.revision_id, d.url, d.created_at AS deployed_at FROM reviews v
     LEFT JOIN deployments d ON d.project_id = v.project_id AND d.review_key = v.review_key AND d.deployment_id =
       (SELECT x.deployment_id FROM deployments x WHERE x.project_id = v.project_id AND x.review_key = v.review_key ORDER BY x.created_at DESC, x.deployment_id DESC LIMIT 1)
     WHERE v.project_id = ? ORDER BY v.review_key`,
  ).bind(projectId).all<{ review_key: string; state: ReviewState; created_at: string; archived_at: string | null; purge_after: string | null; purged_at: string | null; deployment_id: string | null; revision_id: string; url: string; deployed_at: string }>()).results;
  return rows.map((r) => ({
    projectId, reviewKey: r.review_key, state: r.state, createdAt: r.created_at, archivedAt: r.archived_at, purgeAfter: r.purge_after, purgedAt: r.purged_at,
    latestDeployment: r.deployment_id ? { deploymentId: r.deployment_id, revisionId: r.revision_id, url: r.url, createdAt: r.deployed_at } : null,
  }));
}
