import { randomToken, type PurgeEntry, type PurgeReport, type ReviewState } from '@socrate/contract';
import type { Env } from './env.ts';
import { HttpError } from './http.ts';
import { authenticate, requireCapability, requireProject, type Principal } from './auth.ts';
import { attachmentPrefixOf } from './attachments.ts';

const DAY_MS = 86_400_000;

export type Archived = { projectId: string; reviewKey: string; state: ReviewState; archivedAt: string; purgeAfter: string; purge: string };

export const PURGE_COMMAND = 'npm run sauvegarde -- purger --instance <nom>';
export const MANUAL_PURGE = `purge manuelle disponible, instance arrêtée (${PURGE_COMMAND}) ; aucune purge planifiée n’est déployée`;

/** Archivage et purge : un accès technique portant explicitement `review.archive`, jamais l'import, la lecture ou une session. */
export function archiver(p: Principal): void {
  if (p.kind !== 'technical') throw new HttpError(403, 'forbidden', 'l’archivage et la purge exigent un accès technique');
  requireCapability(p, 'review.archive');
}

/** Archive une revue active ; un second appel rend la date déjà fixée. Fermer ou révoquer une preview n'appelle jamais ceci. */
export async function archiveReview(env: Env, projectId: string, reviewKey: string, retentionDays: number, now = Date.now()): Promise<Archived> {
  const at = new Date(now).toISOString();
  const after = new Date(now + retentionDays * DAY_MS).toISOString();
  await env.DB.prepare("UPDATE reviews SET state = 'archived', archived_at = ?, purge_after = ? WHERE project_id = ? AND review_key = ? AND state = 'active'")
    .bind(at, after, projectId, reviewKey).run();
  const row = await env.DB.prepare('SELECT state, archived_at, purge_after FROM reviews WHERE project_id = ? AND review_key = ?')
    .bind(projectId, reviewKey).first<{ state: ReviewState; archived_at: string | null; purge_after: string | null }>();
  if (!row) throw new HttpError(404, 'not_found', 'revue inconnue');
  if (row.state !== 'archived') throw new HttpError(409, 'review_inactive', `revue ${row.state === 'purged' ? 'purgée' : 'en cours de purge'} : plus d’archivage possible`);
  return { projectId, reviewKey, state: row.state, archivedAt: row.archived_at!, purgeAfter: row.purge_after!, purge: MANUAL_PURGE };
}

type PurgeEnv = Pick<Env, 'DB' | 'CAPTURES'>;

type Candidate = { review_key: string; state: ReviewState; purge_after: string | null; purge_run: string | null };

/** Tables de la revue effacées dans le batch de clôture, enfants avant parents. */
const OWNED_TABLES = ['attachments', 'targets', 'proposals', 'messages', 'threads', 'captures', 'operations', 'changes', 'sessions', 'deployments', 'revisions'] as const;

/** Même contrôle d'accès que l'API : l'accès technique du projet portant `review.archive`, lu sans jamais être journalisé. */
export async function authorizePurge(env: PurgeEnv, token: string, projectId: string): Promise<void> {
  const principal = await authenticate(env as Env, new Request('http://maintenance.invalid/', { headers: { Authorization: `Bearer ${token}` } }));
  requireProject(principal, projectId);
  archiver(principal);
}

/**
 * Purge les revues archivées dont la date est passée à `now`. Appelée seulement dans la phase de maintenance exclusive de
 * `tools/local/maintenance.ts` : l'instance interactive est arrêtée et ses ressources prouvées fermées, aucun téléversement ne peut
 * donc être en vol. Une transaction D1 clôt la revue (`purging`), consigne ses comptes, garde ses clés d'objets, efface ses lignes et
 * renouvelle l'epoch ; les objets R2 sont ensuite supprimés, puis le préfixe relu vide avant `purged`. Une revue `purged` dont le
 * préfixe contient encore un objet est nettoyée et journalisée sans être rouverte. `complete` se lit dans l'état durable final.
 */
export async function purgeExpired(env: PurgeEnv, projectId: string, now = Date.now()): Promise<PurgeReport> {
  const frozen = await env.DB.prepare('SELECT frozen FROM maintenance WHERE singleton = 1').first<{ frozen: number }>();
  if (frozen?.frozen === 1) throw new HttpError(503, 'maintenance', 'instance gelée par une sauvegarde interrompue : purge refusée (npm run sauvegarde -- degeler après vérification)', true);
  const runId = randomToken();
  const at = new Date(now).toISOString();
  const entries: PurgeEntry[] = [];
  const log = async (reviewKey: string, action: PurgeEntry['action'], resource: string, detail: string) => {
    entries.push({ reviewKey, action, resource, detail });
    if (action === 'kept') return;
    await env.DB.prepare('INSERT INTO purge_log (run_id, at, project_id, review_key, action, resource, detail) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(runId, at, projectId, reviewKey, action, resource, detail).run();
  };
  const select = (where: string) => env.DB.prepare(`SELECT review_key, state, purge_after, purge_run FROM reviews WHERE project_id = ? ${where} ORDER BY review_key`).bind(projectId, ...(where ? [at] : [])).all<Candidate>();
  const due = "AND (state = 'purging' OR (state = 'archived' AND purge_after <= ?))";
  const reviews = (await select('')).results;
  for (const r of reviews) {
    if (r.state === 'active') entries.push({ reviewKey: r.review_key, action: 'kept', resource: 'review', detail: 'revue active' });
    else if (r.state === 'archived' && r.purge_after! > at) entries.push({ reviewKey: r.review_key, action: 'kept', resource: 'review', detail: `archivée, purge possible à partir du ${r.purge_after}` });
  }
  for (const r of reviews.filter((x) => x.state === 'purging' || (x.state === 'archived' && x.purge_after! <= at))) {
    const key = r.review_key;
    if (r.state === 'archived') {
      const kept = await shared(env, projectId, key);
      // Prise perdue : un autre passage détient la clôture, l'état durable final dit s'il a terminé.
      if (!(await close(env, projectId, key, runId, at))) continue;
      for (const s of kept) entries.push({ reviewKey: key, action: 'kept', resource: s.resource, detail: s.detail });
      const counted = (await env.DB.prepare('SELECT resource, detail FROM purge_log WHERE run_id = ? AND project_id = ? AND review_key = ? ORDER BY seq').bind(runId, projectId, key).all<{ resource: string; detail: string }>()).results;
      for (const c of counted) entries.push({ reviewKey: key, action: 'deleted', resource: c.resource, detail: c.detail });
    }
    await deleteObjects(env, projectId, key, log, 'objet sans ligne');
    const last = (await Promise.all(prefixesOf(projectId, key).map((prefix) => env.CAPTURES.list({ prefix, limit: 1 })))).flatMap((l) => l.objects);
    if (last.length) {
      await log(key, 'waiting', 'review', `objet apparu pendant ce passage (${last[0]!.key}) : exclusivité de maintenance non respectée, relancer la purge`);
      continue;
    }
    const done = await env.DB.prepare("UPDATE reviews SET state = 'purged', purged_at = ? WHERE project_id = ? AND review_key = ? AND state = 'purging' RETURNING review_key")
      .bind(at, projectId, key).first();
    if (done) await log(key, 'purged', 'review', 'lignes et objets supprimés, préfixe R2 relu vide sous maintenance exclusive');
  }
  for (const r of reviews.filter((x) => x.state === 'purged')) await deleteObjects(env, projectId, r.review_key, log, 'reste trouvé après la purge, revue maintenue purgée');
  const open = (await select(due)).results;
  for (const r of open) {
    if (entries.some((e) => e.reviewKey === r.review_key && e.action === 'waiting')) continue;
    await log(r.review_key, 'waiting', 'review', r.state === 'purging' ? `purge détenue par le passage ${r.purge_run} encore en cours : relancer après sa fin` : 'revue expirée non clôturée par ce passage : relancer la purge');
  }
  return { runId, at, mode: 'manuelle', planification: 'non déployée', complete: open.length === 0 && !entries.some((e) => e.action === 'waiting'), entries };
}

/** Captures techniques des fils et pièces jointes des messages : deux préfixes propres à la revue. */
const prefixesOf = (projectId: string, reviewKey: string) => [`captures/${projectId}/${reviewKey}/`, attachmentPrefixOf(projectId, reviewKey)];

/** Clôt la revue et efface ses lignes dans une seule transaction, conditionnée à la prise de cette clôture par ce passage. */
async function close(env: PurgeEnv, projectId: string, reviewKey: string, runId: string, at: string): Promise<boolean> {
  const owned = 'project_id = ? AND review_key = ?';
  const claimed = "EXISTS (SELECT 1 FROM reviews WHERE project_id = ? AND review_key = ? AND state = 'purging' AND purge_run = ?)";
  const k = [projectId, reviewKey];
  const c = [projectId, reviewKey, runId];
  const results = await env.DB.batch([
    env.DB.prepare("UPDATE reviews SET state = 'purging', purge_run = ? WHERE project_id = ? AND review_key = ? AND state = 'archived' AND purge_after <= ?")
      .bind(runId, projectId, reviewKey, at),
    ...OWNED_TABLES.map((t) => env.DB.prepare(`INSERT INTO purge_log (run_id, at, project_id, review_key, action, resource, detail) SELECT ?, ?, ?, ?, 'deleted', ?, (SELECT COUNT(*) FROM ${t} WHERE ${owned}) WHERE ${claimed}`)
      .bind(runId, at, projectId, reviewKey, t, ...k, ...c)),
    env.DB.prepare(`INSERT OR IGNORE INTO purge_objects (project_id, review_key, object_key) SELECT project_id, review_key, object_key FROM captures WHERE ${owned} AND ${claimed}`).bind(...k, ...c),
    env.DB.prepare(`INSERT OR IGNORE INTO purge_objects (project_id, review_key, object_key) SELECT project_id, review_key, object_key FROM attachments WHERE ${owned} AND ${claimed}`).bind(...k, ...c),
    ...OWNED_TABLES.map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE ${owned} AND ${claimed}`).bind(...k, ...c)),
    env.DB.prepare(`DELETE FROM listing_items WHERE listing_id IN (SELECT listing_id FROM listings WHERE ${owned}) AND ${claimed}`).bind(...k, ...c),
    env.DB.prepare(`DELETE FROM listings WHERE ${owned} AND ${claimed}`).bind(...k, ...c),
    // Les curseurs et marqueurs émis avant la purge rendent 410 resync_required plutôt qu'une page incomplète d'apparence valide.
    env.DB.prepare(`UPDATE sync_epoch SET epoch = lower(hex(randomblob(16))) WHERE singleton = 1 AND ${claimed}`).bind(...c),
  ]);
  return (results[0]!.meta.changes ?? 0) > 0;
}

/** Contenus identiques portés par une autre revue : leurs lignes et objets propres restent, la purge ne touche que ceux de la revue. */
async function shared(env: PurgeEnv, projectId: string, reviewKey: string): Promise<{ resource: string; detail: string }[]> {
  const rows = (await env.DB.batch([
    env.DB.prepare(`SELECT 'revision' AS resource, r.revision_id AS id, CASE WHEN o.project_id = r.project_id THEN o.review_key END AS other FROM revisions r
      JOIN revisions o ON o.revision_id = r.revision_id AND NOT (o.project_id = r.project_id AND o.review_key = r.review_key) WHERE r.project_id = ? AND r.review_key = ?`).bind(projectId, reviewKey),
    env.DB.prepare(`SELECT 'capture' AS resource, c.sha256 AS id, CASE WHEN o.project_id = c.project_id THEN o.review_key END AS other FROM captures c
      JOIN captures o ON o.sha256 = c.sha256 AND o.state = 'committed' AND NOT (o.project_id = c.project_id AND o.review_key = c.review_key) WHERE c.project_id = ? AND c.review_key = ?`).bind(projectId, reviewKey),
  ])).flatMap((r) => r.results as { resource: string; id: string; other: string | null }[]);
  // Un autre projet n'est jamais nommé dans le journal d'un projet.
  return rows.map((r) => ({ resource: r.resource, detail: `${r.id.slice(0, 12)} identique conservé dans ${r.other ? `la revue ${r.other}` : 'un autre projet'}` }));
}

async function deleteObjects(env: PurgeEnv, projectId: string, reviewKey: string, log: (k: string, a: PurgeEntry['action'], r: string, d: string) => Promise<void>, unlisted: string): Promise<void> {
  const recorded = (await env.DB.prepare('SELECT object_key FROM purge_objects WHERE project_id = ? AND review_key = ?').bind(projectId, reviewKey).all<{ object_key: string }>()).results;
  for (const { object_key } of recorded) {
    await env.CAPTURES.delete(object_key);
    await env.DB.prepare('DELETE FROM purge_objects WHERE project_id = ? AND review_key = ? AND object_key = ?').bind(projectId, reviewKey, object_key).run();
    await log(reviewKey, 'deleted', 'object', object_key);
  }
  for (const prefix of prefixesOf(projectId, reviewKey)) {
    let cursor: string | undefined;
    do {
      const page = await env.CAPTURES.list({ prefix, cursor });
      for (const o of page.objects) {
        await env.CAPTURES.delete(o.key);
        await log(reviewKey, 'deleted', 'object', `${o.key} (${unlisted})`);
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
}

/** Journal durable d'une revue, pour expliquer après coup ce qu'une purge a supprimé ou attendu. */
export async function purgeJournal(env: PurgeEnv, projectId: string, reviewKey: string) {
  return (await env.DB.prepare('SELECT run_id, at, action, resource, detail FROM purge_log WHERE project_id = ? AND review_key = ? ORDER BY seq').bind(projectId, reviewKey)
    .all<{ run_id: string; at: string; action: string; resource: string; detail: string }>()).results;
}
