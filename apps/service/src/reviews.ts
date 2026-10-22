import { deploymentImportSchema, digestOf, issuesOf, originAllowed, type Deployment, type Revision, type Review, type ReviewState, type Json } from '@socrate/contract';
import { readConfig, type Env } from './env.ts';
import { HttpError, nowIso } from './http.ts';
import { isConstraintViolation } from './d1.ts';

export type ImportResult = { created: boolean; review: Review; revisionId: string; deploymentId: string };

type DeploymentRow = { revision_id: string; payload_digest: string; state: ReviewState; commit_sha: string; build_id: string; url: string; origin: string; created_at: string };

export async function importDeployment(env: Env, projectId: string, reviewKey: string, deploymentId: string, body: unknown): Promise<ImportResult> {
  const parsed = deploymentImportSchema.safeParse(body);
  if (!parsed.success) throw new HttpError(422, 'invalid_manifest', 'import refusé : manifeste ou métadonnées invalides', false, issuesOf(parsed.error));
  const input = parsed.data;
  if (input.manifest.reviewKey !== reviewKey) {
    throw new HttpError(422, 'invalid_manifest', 'import refusé', false, [{ path: 'reviewKey', message: `clé ${input.manifest.reviewKey} différente de la route ${reviewKey}` }]);
  }
  const revisionId = await digestOf(input.manifest as unknown as Json);
  const origin = new URL(input.url).origin;
  // Un accès d'import fuité ne peut pas ouvrir le service à une autre origine que celles du projet.
  const allowed = readConfig(env).projects[projectId]?.allowedOrigin;
  if (allowed !== undefined && !originAllowed(allowed, origin)) throw new HttpError(403, 'forbidden', `origine ${origin} hors du motif ${allowed} du projet ${projectId}`);
  const payloadDigest = await digestOf({ revisionId, commit: input.commit, buildId: input.buildId, url: input.url });
  // Un rejeu identique rend l'état persisté de la revue, archivée comprise, sans rien écrire.
  const replayed = 'SELECT d.revision_id, d.payload_digest, v.state FROM deployments d JOIN reviews v ON v.project_id = d.project_id AND v.review_key = d.review_key WHERE d.project_id = ? AND d.review_key = ? AND d.deployment_id = ?';
  const existing = await env.DB.prepare(replayed).bind(projectId, reviewKey, deploymentId).first<Pick<DeploymentRow, 'revision_id' | 'payload_digest' | 'state'>>();
  if (existing) {
    if (existing.payload_digest !== payloadDigest) throw new HttpError(409, 'immutable_deployment', `déploiement ${deploymentId} déjà enregistré avec un autre contenu`);
    return { created: false, review: { projectId, reviewKey, state: existing.state }, revisionId, deploymentId };
  }
  const at = nowIso();
  const manifestJson = JSON.stringify(input.manifest);
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO reviews (project_id, review_key, state, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING').bind(projectId, reviewKey, 'active', at),
      // Un nouveau déploiement n'entre que dans une revue active : l'archivage ou une purge en cours ne reçoit plus de révision.
      env.DB.prepare("INSERT INTO revisions (project_id, review_key, revision_id, manifest, created_at) SELECT project_id, review_key, ?, ?, ? FROM reviews WHERE project_id = ? AND review_key = ? AND state = 'active' ON CONFLICT DO NOTHING")
        .bind(revisionId, manifestJson, at, projectId, reviewKey),
      env.DB.prepare("INSERT INTO deployments (project_id, review_key, deployment_id, revision_id, commit_sha, build_id, url, origin, payload_digest, created_at) SELECT project_id, review_key, ?, ?, ?, ?, ?, ?, ?, ? FROM reviews WHERE project_id = ? AND review_key = ? AND state = 'active'")
        .bind(deploymentId, revisionId, input.commit, input.buildId, input.url, origin, payloadDigest, at, projectId, reviewKey),
    ]).then((r) => {
      if ((r[2]!.meta.changes ?? 0) === 0) throw new HttpError(409, 'review_inactive', 'revue archivée ou purgée : nouveau déploiement refusé');
    });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (isConstraintViolation(e)) {
      const raced = await env.DB.prepare(replayed).bind(projectId, reviewKey, deploymentId).first<Pick<DeploymentRow, 'revision_id' | 'payload_digest' | 'state'>>();
      if (raced && raced.payload_digest === payloadDigest) return { created: false, review: { projectId, reviewKey, state: raced.state }, revisionId, deploymentId };
      throw new HttpError(409, 'immutable_deployment', `déploiement ${deploymentId} déjà enregistré avec un autre contenu`);
    }
    throw e;
  }
  return { created: true, review: { projectId, reviewKey, state: 'active' }, revisionId, deploymentId };
}

export async function readDeployment(env: Env, projectId: string, reviewKey: string, deploymentId: string): Promise<{ review: Review; revision: Revision; deployment: Deployment }> {
  const row = await env.DB.prepare(
    `SELECT d.deployment_id, d.revision_id, d.commit_sha, d.build_id, d.url, d.origin, d.created_at, r.manifest, r.created_at AS revision_created_at, v.state
     FROM deployments d JOIN revisions r ON r.project_id = d.project_id AND r.review_key = d.review_key AND r.revision_id = d.revision_id
     JOIN reviews v ON v.project_id = d.project_id AND v.review_key = d.review_key
     WHERE d.project_id = ? AND d.review_key = ? AND d.deployment_id = ?`,
  ).bind(projectId, reviewKey, deploymentId).first<DeploymentRow & { deployment_id: string; manifest: string; revision_created_at: string; state: ReviewState }>();
  if (!row) throw new HttpError(404, 'not_found', 'déploiement inconnu');
  return {
    review: { projectId, reviewKey, state: row.state },
    revision: { revisionId: row.revision_id, manifest: JSON.parse(row.manifest), createdAt: row.revision_created_at },
    deployment: { deploymentId: row.deployment_id, revisionId: row.revision_id, commit: row.commit_sha, buildId: row.build_id, url: row.url, origin: row.origin, createdAt: row.created_at },
  };
}

export async function readRevision(env: Env, projectId: string, reviewKey: string, revisionId: string): Promise<Revision> {
  const row = await env.DB.prepare('SELECT manifest, created_at FROM revisions WHERE project_id = ? AND review_key = ? AND revision_id = ?')
    .bind(projectId, reviewKey, revisionId).first<{ manifest: string; created_at: string }>();
  if (!row) throw new HttpError(404, 'not_found', 'révision inconnue');
  return { revisionId, manifest: JSON.parse(row.manifest), createdAt: row.created_at };
}

/** Ferme l'origine et les sessions du déploiement ; sa révision, ses fils et leurs captures restent lisibles depuis les autres déploiements. */
export async function revokeDeployment(env: Env, projectId: string, reviewKey: string, deploymentId: string): Promise<{ deploymentId: string; revokedAt: string }> {
  const row = await env.DB.prepare('UPDATE deployments SET revoked_at = COALESCE(revoked_at, ?) WHERE project_id = ? AND review_key = ? AND deployment_id = ? RETURNING revoked_at')
    .bind(nowIso(), projectId, reviewKey, deploymentId).first<{ revoked_at: string }>();
  if (!row) throw new HttpError(404, 'not_found', 'déploiement inconnu');
  return { deploymentId, revokedAt: row.revoked_at };
}

export async function isRegisteredOrigin(env: Env, origin: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT 1 AS one FROM deployments WHERE origin = ? AND revoked_at IS NULL LIMIT 1').bind(origin).first<{ one: number }>();
  return row !== null;
}

export async function deploymentOriginMatches(env: Env, projectId: string, reviewKey: string, deploymentId: string, origin: string): Promise<boolean> {
  const row = await env.DB.prepare('SELECT 1 AS one FROM deployments WHERE project_id = ? AND review_key = ? AND deployment_id = ? AND origin = ? AND revoked_at IS NULL')
    .bind(projectId, reviewKey, deploymentId, origin).first<{ one: number }>();
  return row !== null;
}
