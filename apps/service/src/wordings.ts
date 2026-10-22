import type { ListProposal, Manifest, PageProposalInput, Proposal, Target, WordingRef } from '@socrate/contract';
import type { Env } from './env.ts';
import { HttpError } from './http.ts';

export type RevisionRef = { revisionId: string; manifest: Manifest };
export type ProposalRow = { thread_id: string; original: string; replacement: string; source_revision_id: string; wording_id: string | null; wording: string | null };

const REVISION_SQL = 'SELECT d.revision_id, r.manifest FROM deployments d JOIN revisions r ON r.project_id = d.project_id AND r.review_key = d.review_key AND r.revision_id = d.revision_id WHERE d.project_id = ? AND d.review_key = ?';

/** Révision du déploiement nommé, ou du dernier déploiement importé quand la lecture n'est liée à aucun (accès agent). */
export async function revisionOf(env: Env, projectId: string, reviewKey: string, deploymentId: string | null): Promise<RevisionRef | null> {
  const row = deploymentId
    ? await env.DB.prepare(`${REVISION_SQL} AND d.deployment_id = ?`).bind(projectId, reviewKey, deploymentId).first<{ revision_id: string; manifest: string }>()
    : await env.DB.prepare(`${REVISION_SQL} ORDER BY d.created_at DESC, d.deployment_id DESC LIMIT 1`).bind(projectId, reviewKey).first<{ revision_id: string; manifest: string }>();
  return row ? { revisionId: row.revision_id, manifest: JSON.parse(row.manifest) as Manifest } : null;
}

/** La proposition est jugée sur la révision que la relectrice voyait : une session passée à une autre révision est refusée, jamais réinterprétée. */
function observed(revision: RevisionRef, revisionId: string): void {
  if (revision.revisionId !== revisionId) {
    throw new HttpError(409, 'revision_changed', `proposition rédigée sur la révision ${revisionId.slice(0, 8)}, la session est maintenant sur la révision ${revision.revisionId.slice(0, 8)} : rien n’est publié, rechargez la page pour relire la révision actuelle`);
  }
}

/** L'original d'un texte préparé vient de la révision autorisée, jamais du navigateur. */
function prepared(revision: RevisionRef, wordingId: string, replacement: string): Proposal {
  const w = revision.manifest.wordings?.find((x) => x.id === wordingId);
  if (!w) throw new HttpError(422, 'invalid_request', `texte à relire absent de la sélection de cette révision : ${wordingId}`);
  const wording: WordingRef = { id: w.id, key: w.key ?? null, locale: w.locale, variant: w.variant ?? null };
  return { original: w.source, replacement, sourceRevisionId: revision.revisionId, wording, drift: { status: 'current', revisionId: revision.revisionId } };
}

export function resolveListProposal(revision: RevisionRef, input: ListProposal): Proposal {
  observed(revision, input.revisionId);
  return prepared(revision, input.wordingId, input.replacement);
}

/** Le rattachement déclaré sur la cible désigne le texte préparé ; sans rattachement, l'original est l'extrait ciblé, sans clé. */
export function resolvePageProposal(revision: RevisionRef, input: PageProposalInput, target: Target): Proposal {
  observed(revision, input.revisionId);
  if (target.wording) return prepared(revision, target.wording, input.replacement);
  if (!target.text.trim()) throw new HttpError(422, 'invalid_request', 'aucun texte ciblé à remplacer');
  return { original: target.text, replacement: input.replacement, sourceRevisionId: revision.revisionId, wording: null, drift: null };
}

export function proposalStatement(env: Env, projectId: string, reviewKey: string, threadId: string, p: Proposal): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO proposals (project_id, review_key, thread_id, original, replacement, source_revision_id, wording_id, wording)
     SELECT project_id, review_key, thread_id, ?, ?, ?, ?, ? FROM threads WHERE project_id = ? AND review_key = ? AND thread_id = ?`,
  ).bind(p.original, p.replacement, p.sourceRevisionId, p.wording?.id ?? null, p.wording ? JSON.stringify(p.wording) : null, projectId, reviewKey, threadId);
}

export function toProposal(row: ProposalRow, reference: RevisionRef | null): Proposal {
  const wording = row.wording ? (JSON.parse(row.wording) as WordingRef) : null;
  const base = { original: row.original, replacement: row.replacement, sourceRevisionId: row.source_revision_id, wording };
  if (!wording || !reference) return { ...base, drift: null };
  const now = reference.manifest.wordings?.find((w) => w.id === wording.id);
  if (!now) return { ...base, drift: { status: 'removed', revisionId: reference.revisionId } };
  if (now.source !== row.original) return { ...base, drift: { status: 'changed', revisionId: reference.revisionId, currentSource: now.source } };
  return { ...base, drift: { status: 'current', revisionId: reference.revisionId } };
}
