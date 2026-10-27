import { digestOf, type Actor, type Attachment, type AttachmentMeta, type Capability, type Exploring, type Json, type ListProposal, type Message, type Thread, type ThreadWithMessages, type Transition } from '@socrate/contract';
import type { Env } from './env.ts';
import { isConstraintViolation, uncertain } from './d1.ts';
import { HttpError, nowIso } from './http.ts';
import { proposalStatement, resolveListProposal, revisionOf, toProposal, type ProposalRow, type RevisionRef } from './wordings.ts';
import { ATTACHED_SQL, planAttachments, toAttachment, type AttachmentRow } from './attachments.ts';

/** Condition d'écriture : liée par projet puis revue, elle refuse toute écriture après archivage ou pendant une purge. */
export const ACTIVE_REVIEW = "EXISTS (SELECT 1 FROM reviews v WHERE v.project_id = ? AND v.review_key = ? AND v.state = 'active')";

export async function requireActive(env: Env, projectId: string, reviewKey: string): Promise<void> {
  if (!(await env.DB.prepare("SELECT 1 FROM reviews WHERE project_id = ? AND review_key = ? AND state = 'active'").bind(projectId, reviewKey).first())) {
    throw new HttpError(409, 'review_inactive', 'la revue est archivée ou purgée : aucune écriture');
  }
}

/** Auteur d'une écriture : session de relecteur sur un déploiement, ou agent délégué (`via`), sans déploiement. */
export type WriterScope = { projectId: string; reviewKey: string; deploymentId: string | null; actor: Actor; exploring: Exploring; capabilities: Capability[]; via: string | null };
export type ParticipantScope = WriterScope & { deploymentId: string };
export type ThreadState = Thread['state'];

type ThreadRow = { thread_id: string; kind: Thread['kind']; state: ThreadState; version: number; revision_id: string; deployment_id: string; author_key: string; author_name: string; created_at: string; updated_at: string };
type MessageRow = {
  message_id: string; thread_id: string; seq: number; author_key: string; author_name: string; exploring: string | null; body: string; created_at: string;
  via: string | null; transition: Transition['state'] | null; commit_sha: string | null; deployment_id: string | null;
};
type OperationRow = { payload_digest: string; result: string };

type TargetRow = { thread_id: string; capture_id: string; context: string; content_type: 'image/png'; size: number; sha256: string; width: number; height: number };
const TARGET_SQL = 'SELECT t.thread_id, t.capture_id, t.context, c.content_type, c.size, c.sha256, c.width, c.height FROM targets t JOIN captures c ON c.project_id = t.project_id AND c.review_key = t.review_key AND c.capture_id = t.capture_id';

const toThread = (r: ThreadRow, target: TargetRow | undefined, proposal: ProposalRow | undefined, reference: RevisionRef | null): Thread => ({
  threadId: r.thread_id, kind: r.kind, state: r.state, version: r.version, revisionId: r.revision_id, deploymentId: r.deployment_id,
  author: { key: r.author_key, displayName: r.author_name }, createdAt: r.created_at, updatedAt: r.updated_at,
  target: target ? JSON.parse(target.context) : null,
  capture: target ? { captureId: target.capture_id, status: 'available', contentType: target.content_type, size: target.size, sha256: target.sha256, width: target.width, height: target.height } : null,
  proposal: proposal ? toProposal(proposal, reference) : null,
});
/** Déploiements non révoqués de la revue, du plus ancien au plus récent : ce qu'il faut pour dire si un commit de résolution est en ligne. */
type LiveRow = { deployment_id: string; commit_sha: string; created_at: string };
const LIVE_SQL = 'SELECT deployment_id, commit_sha, created_at FROM deployments WHERE project_id = ? AND review_key = ? AND revoked_at IS NULL ORDER BY created_at, deployment_id';
const liveDeployments = async (env: Env, projectId: string, reviewKey: string) => (await env.DB.prepare(LIVE_SQL).bind(projectId, reviewKey).all<LiveRow>()).results;
/**
 * Mise en ligne d'une résolution avec commit. `liveSince` : premier déploiement qui porte le commit, abrégé ou complet de part et d'autre, comparé par préfixe dans les deux sens.
 * Sinon `pending` tant qu'aucun déploiement n'a été créé depuis la résolution (celui relevé à l'écriture exclu), `unknown` ensuite : un build postérieur peut contenir
 * le correctif sous un autre commit, et le service ne connaît aucune ascendance Git. Rien sans commit.
 */
function liveOf(live: LiveRow[], r: MessageRow): Pick<Transition, 'liveSince' | 'liveState'> {
  const commit = r.commit_sha;
  if (!commit) return { liveSince: null, liveState: null };
  const since = live.find((d) => d.commit_sha.startsWith(commit) || commit.startsWith(d.commit_sha))?.created_at ?? null;
  if (since) return { liveSince: since, liveState: 'live' };
  return { liveSince: null, liveState: live.some((d) => d.deployment_id !== r.deployment_id && d.created_at >= r.created_at) ? 'unknown' : 'pending' };
}

const toMessage = (r: MessageRow, attachments: Attachment[] = [], live: LiveRow[] = []): Message => ({
  messageId: r.message_id, threadId: r.thread_id, seq: r.seq, author: { key: r.author_key, displayName: r.author_name },
  exploring: r.exploring ? JSON.parse(r.exploring) : null, body: r.body, attachments, via: r.via,
  transition: r.transition ? { state: r.transition, commit: r.commit_sha, deploymentId: r.deployment_id, ...liveOf(live, r) } : null, createdAt: r.created_at,
});
const byMessage = (rows: AttachmentRow[]) => {
  const m = new Map<string, Attachment[]>();
  for (const r of rows) m.set(r.message_id!, [...(m.get(r.message_id!) ?? []), toAttachment(r)]);
  return m;
};

/** Résultat enregistré d'une opération de fil : un instantané d’avant les pièces jointes ou les agents est rendu avec une liste vide et sans agent. */
export const asThread = (stored: Json): ThreadWithMessages => {
  const t = stored as unknown as ThreadWithMessages;
  return { ...t, messages: t.messages.map((m) => ({ ...m, attachments: m.attachments ?? [], via: m.via ?? null, transition: m.transition ?? null })) };
};

/** `reference` est la révision contre laquelle le décalage des textes préparés est signalé. `ids` restreint la lecture et fixe l'ordre rendu. */
export async function listThreads(env: Env, projectId: string, reviewKey: string, reference: RevisionRef | null, ids?: string[]): Promise<ThreadWithMessages[]> {
  const only = (column: string) => (ids ? ` AND ${column} IN (SELECT value FROM json_each(?))` : '');
  const binds = ids ? [projectId, reviewKey, JSON.stringify(ids)] : [projectId, reviewKey];
  const [threads, messages, targets, proposals, attachments, live] = await env.DB.batch([
    env.DB.prepare(`SELECT * FROM threads WHERE project_id = ? AND review_key = ?${only('thread_id')} ORDER BY created_at, thread_id`).bind(...binds),
    env.DB.prepare(`SELECT * FROM messages WHERE project_id = ? AND review_key = ?${only('thread_id')} ORDER BY thread_id, seq`).bind(...binds),
    env.DB.prepare(`${TARGET_SQL} WHERE t.project_id = ? AND t.review_key = ?${only('t.thread_id')}`).bind(...binds),
    env.DB.prepare(`SELECT * FROM proposals WHERE project_id = ? AND review_key = ?${only('thread_id')}`).bind(...binds),
    env.DB.prepare(`${ATTACHED_SQL}${only('thread_id')} ORDER BY message_id, position`).bind(...binds),
    env.DB.prepare(LIVE_SQL).bind(projectId, reviewKey),
  ]);
  const deployments = live!.results as LiveRow[];
  const piecesOf = byMessage(attachments!.results as AttachmentRow[]);
  const targetOf = new Map((targets!.results as TargetRow[]).map((t) => [t.thread_id, t]));
  const proposalOf = new Map((proposals!.results as ProposalRow[]).map((p) => [p.thread_id, p]));
  const byThread = new Map<string, Message[]>();
  for (const m of (messages!.results as MessageRow[])) {
    const list = byThread.get(m.thread_id) ?? [];
    list.push(toMessage(m, piecesOf.get(m.message_id), deployments));
    byThread.set(m.thread_id, list);
  }
  const rows = threads!.results as ThreadRow[];
  if (ids) {
    const at = new Map(ids.map((id, i) => [id, i]));
    rows.sort((a, b) => at.get(a.thread_id)! - at.get(b.thread_id)!);
  }
  return rows.map((t) => ({ ...toThread(t, targetOf.get(t.thread_id), proposalOf.get(t.thread_id), reference), messages: byThread.get(t.thread_id) ?? [] }));
}

export async function getThread(env: Env, projectId: string, reviewKey: string, threadId: string, reference: RevisionRef | null): Promise<ThreadWithMessages> {
  const t = await env.DB.prepare('SELECT * FROM threads WHERE project_id = ? AND review_key = ? AND thread_id = ?').bind(projectId, reviewKey, threadId).first<ThreadRow>();
  if (!t) throw new HttpError(404, 'not_found', 'retour inconnu');
  const m = await env.DB.prepare('SELECT * FROM messages WHERE project_id = ? AND review_key = ? AND thread_id = ? ORDER BY seq').bind(projectId, reviewKey, threadId).all<MessageRow>();
  const target = await env.DB.prepare(`${TARGET_SQL} WHERE t.project_id = ? AND t.review_key = ? AND t.thread_id = ?`).bind(projectId, reviewKey, threadId).first<TargetRow>();
  const proposal = await env.DB.prepare('SELECT * FROM proposals WHERE project_id = ? AND review_key = ? AND thread_id = ?').bind(projectId, reviewKey, threadId).first<ProposalRow>();
  const pieces = byMessage((await env.DB.prepare(`${ATTACHED_SQL} AND thread_id = ? ORDER BY message_id, position`).bind(projectId, reviewKey, threadId).all<AttachmentRow>()).results);
  const live = await liveDeployments(env, projectId, reviewKey);
  return { ...toThread(t, target ?? undefined, proposal ?? undefined, reference), messages: m.results.map((r) => toMessage(r, pieces.get(r.message_id), live)) };
}

type OperationKind = 'thread.create' | 'thread.targeted' | 'message.create' | 'thread.state' | 'thread.transition';
export type Scope = { projectId: string; reviewKey: string; actorKey: string; kind: OperationKind; key: string };
export type Guard = { sql: string; binds: unknown[] };

export const scopeOf = (p: WriterScope, kind: OperationKind, key: string): Scope => ({ projectId: p.projectId, reviewKey: p.reviewKey, actorKey: p.actor.key, kind, key });

export async function recordedResult(env: Env, scope: Scope, digest: string): Promise<Json | null> {
  const op = await env.DB.prepare('SELECT payload_digest, result FROM operations WHERE project_id = ? AND review_key = ? AND actor_key = ? AND kind = ? AND idempotency_key = ?')
    .bind(scope.projectId, scope.reviewKey, scope.actorKey, scope.kind, scope.key).first<OperationRow>();
  if (!op) return null;
  if (op.payload_digest !== digest) throw new HttpError(409, 'idempotency_conflict', 'même clé d’idempotence avec une charge différente');
  return JSON.parse(op.result) as Json;
}

export function operationStatement(env: Env, scope: Scope, digest: string, result: Json, at: string, guard: Guard): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO operations (project_id, review_key, actor_key, kind, idempotency_key, payload_digest, result, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (${guard.sql})`,
  ).bind(scope.projectId, scope.reviewKey, scope.actorKey, scope.kind, scope.key, digest, JSON.stringify(result), at, ...guard.binds);
}

export function changeStatement(env: Env, scope: Scope, threadId: string, kind: string, at: string, guard: Guard): D1PreparedStatement {
  return env.DB.prepare(`INSERT INTO changes (project_id, review_key, thread_id, kind, created_at) SELECT ?, ?, ?, ?, ? WHERE EXISTS (${guard.sql})`)
    .bind(scope.projectId, scope.reviewKey, threadId, kind, at, ...guard.binds);
}

type Plan = { before: D1PreparedStatement[]; mutation: D1PreparedStatement; after: D1PreparedStatement[] };
type Commit<T> = { kind: 'replayed'; result: T } | { kind: 'written' } | { kind: 'not-written' };

export async function commit<T>(env: Env, scope: Scope, digest: string, plan: Plan, replay: (stored: Json) => Promise<T>): Promise<Commit<T>> {
  const stored = await recordedResult(env, scope, digest);
  if (stored !== null) return { kind: 'replayed', result: await replay(stored) };
  let rows: D1Result[];
  try {
    rows = await env.DB.batch([...plan.before, plan.mutation, ...plan.after]);
  } catch (e) {
    if (!isConstraintViolation(e)) throw uncertain();
    const raced = await recordedResult(env, scope, digest);
    if (raced !== null) return { kind: 'replayed', result: await replay(raced) };
    throw uncertain();
  }
  return (rows[plan.before.length]?.meta.changes ?? 0) > 0 ? { kind: 'written' } : { kind: 'not-written' };
}

export type Published = { created: boolean; thread: ThreadWithMessages };

export async function publish(env: Env, input: { scope: ParticipantScope; key: string; body: string; proposal?: ListProposal; attachments?: AttachmentMeta[] }): Promise<Published> {
  const p = input.scope;
  // Une charge sans proposition ni pièce garde la forme d’avant les propositions et les pièces jointes : une reprise d'un envoi antérieur reconnaît son opération.
  const digest = await digestOf({ kind: 'global', body: input.body, ...(input.proposal && { proposal: input.proposal }), ...(input.attachments?.length && { attachments: input.attachments }) } as Json);
  const scope = scopeOf(p, 'thread.create', input.key);
  const revision = await revisionOf(env, p.projectId, p.reviewKey, p.deploymentId);
  if (!revision) throw new HttpError(404, 'not_found', 'déploiement de la session inconnu');
  const stored = await recordedResult(env, scope, digest);
  if (stored !== null) return { created: false, thread: asThread(stored) };
  const proposal = input.proposal ? resolveListProposal(revision, input.proposal) : null;
  const pieces = await planAttachments(env, { scope: p, operation: 'thread.create', key: input.key, attachments: input.attachments });
  const threadId = crypto.randomUUID();
  const messageId = crypto.randomUUID();
  const at = nowIso();
  const snapshot: ThreadWithMessages = {
    threadId, kind: 'global', state: 'open', version: 0, revisionId: revision.revisionId, deploymentId: p.deploymentId, author: p.actor, createdAt: at, updatedAt: at,
    target: null, capture: null, proposal,
    messages: [{ messageId, threadId, seq: 1, author: p.actor, exploring: p.exploring, body: input.body, attachments: pieces?.attachments ?? [], via: null, transition: null, createdAt: at }],
  };
  const produced: Guard = { sql: 'SELECT 1 FROM threads WHERE project_id = ? AND review_key = ? AND thread_id = ?', binds: [p.projectId, p.reviewKey, threadId] };
  const outcome = await commit(env, scope, digest, {
    before: [],
    mutation: env.DB.prepare(
      `INSERT INTO threads (project_id, review_key, thread_id, kind, state, version, revision_id, deployment_id, author_key, author_name, created_at, updated_at)
       SELECT project_id, review_key, ?, 'global', 'open', 0, ?, ?, ?, ?, ?, ? FROM reviews WHERE project_id = ? AND review_key = ? AND state = 'active'${pieces ? ` AND EXISTS (${pieces.guard.sql})` : ''}`,
    ).bind(threadId, revision.revisionId, p.deploymentId, p.actor.key, p.actor.displayName, at, at, p.projectId, p.reviewKey, ...(pieces?.guard.binds ?? [])),
    after: [
      env.DB.prepare(
        `INSERT INTO messages (project_id, review_key, thread_id, message_id, seq, author_key, author_name, exploring, body, created_at)
         SELECT project_id, review_key, thread_id, ?, 1, ?, ?, ?, ?, ? FROM threads WHERE project_id = ? AND review_key = ? AND thread_id = ?`,
      ).bind(messageId, p.actor.key, p.actor.displayName, p.exploring ? JSON.stringify(p.exploring) : null, input.body, at, p.projectId, p.reviewKey, threadId),
      ...(pieces ? [pieces.attach(threadId, messageId, produced)] : []),
      ...(proposal ? [proposalStatement(env, p.projectId, p.reviewKey, threadId, proposal)] : []),
      changeStatement(env, scope, threadId, 'thread.created', at, produced),
      operationStatement(env, scope, digest, snapshot as unknown as Json, at, produced),
    ],
  }, (stored) => Promise.resolve(asThread(stored)));
  if (outcome.kind === 'replayed') return { created: false, thread: outcome.result };
  if (outcome.kind === 'not-written') {
    if (!pieces) throw new HttpError(409, 'review_inactive', 'la revue n’accepte plus de retours');
    await requireActive(env, p.projectId, p.reviewKey);
    throw new HttpError(409, 'attachment_missing', 'pièces plus disponibles au moment de publier : téléverser à nouveau avec la même clé', true);
  }
  return { created: true, thread: snapshot };
}

export type Replied = { created: boolean; message: Message };

export async function reply(env: Env, input: { scope: WriterScope; key: string; threadId: string; body: string; attachments?: AttachmentMeta[] }): Promise<Replied> {
  const p = input.scope;
  const threadId = input.threadId;
  const digest = await digestOf({ threadId, body: input.body, ...(input.attachments?.length && { attachments: input.attachments }) } as Json);
  const scope = scopeOf(p, 'message.create', input.key);
  const thread = await env.DB.prepare('SELECT thread_id FROM threads WHERE project_id = ? AND review_key = ? AND thread_id = ?').bind(p.projectId, p.reviewKey, threadId).first<{ thread_id: string }>();
  if (!thread) throw new HttpError(404, 'not_found', 'retour inconnu');
  const findMessage = async (messageId: string) => {
    const row = await env.DB.prepare('SELECT * FROM messages WHERE project_id = ? AND review_key = ? AND thread_id = ? AND message_id = ?').bind(p.projectId, p.reviewKey, threadId, messageId).first<MessageRow>();
    if (!row) throw uncertain('résultat introuvable');
    const pieces = byMessage((await env.DB.prepare(`${ATTACHED_SQL} AND message_id = ? ORDER BY position`).bind(p.projectId, p.reviewKey, messageId).all<AttachmentRow>()).results);
    return toMessage(row, pieces.get(messageId));
  };
  const stored = await recordedResult(env, scope, digest);
  if (stored !== null) return { created: false, message: await findMessage((stored as { messageId: string }).messageId) };
  const pieces = await planAttachments(env, { scope: p, operation: 'message.create', key: input.key, attachments: input.attachments });
  const messageId = crypto.randomUUID();
  const at = nowIso();
  const produced: Guard = { sql: 'SELECT 1 FROM messages WHERE project_id = ? AND review_key = ? AND thread_id = ? AND message_id = ?', binds: [p.projectId, p.reviewKey, threadId, messageId] };
  const outcome = await commit(env, scope, digest, {
    before: [],
    mutation: env.DB.prepare(
      `INSERT INTO messages (project_id, review_key, thread_id, message_id, seq, author_key, author_name, exploring, body, created_at, via)
       SELECT t.project_id, t.review_key, t.thread_id, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages m WHERE m.project_id = t.project_id AND m.review_key = t.review_key AND m.thread_id = t.thread_id), ?, ?, ?, ?, ?, ?
       FROM threads t JOIN reviews v ON v.project_id = t.project_id AND v.review_key = t.review_key
       WHERE t.project_id = ? AND t.review_key = ? AND t.thread_id = ? AND v.state = 'active'${pieces ? ` AND EXISTS (${pieces.guard.sql})` : ''}`,
    ).bind(messageId, p.actor.key, p.actor.displayName, p.exploring ? JSON.stringify(p.exploring) : null, input.body, at, p.via, p.projectId, p.reviewKey, threadId, ...(pieces?.guard.binds ?? [])),
    after: [
      ...(pieces ? [pieces.attach(threadId, messageId, produced)] : []),
      env.DB.prepare(`UPDATE threads SET updated_at = ? WHERE project_id = ? AND review_key = ? AND thread_id = ? AND EXISTS (${produced.sql})`).bind(at, p.projectId, p.reviewKey, threadId, ...produced.binds),
      changeStatement(env, scope, threadId, 'message.created', at, produced),
      operationStatement(env, scope, digest, { messageId }, at, produced),
    ],
  }, (stored) => findMessage((stored as { messageId: string }).messageId));
  if (outcome.kind === 'replayed') return { created: false, message: outcome.result };
  if (outcome.kind === 'not-written') {
    if (!pieces) throw new HttpError(409, 'review_inactive', 'la revue n’accepte plus de réponses');
    await requireActive(env, p.projectId, p.reviewKey);
    throw new HttpError(409, 'attachment_missing', 'pièces plus disponibles au moment de répondre : téléverser à nouveau avec la même clé', true);
  }
  return { created: true, message: await findMessage(messageId) };
}

export type StateChanged = { created: boolean; thread: Thread };

export async function setState(env: Env, input: { scope: ParticipantScope; key: string; threadId: string; state: ThreadState; expectedVersion: number }): Promise<StateChanged> {
  const p = input.scope;
  const { threadId, state, expectedVersion } = input;
  const digest = await digestOf({ threadId, state, expectedVersion });
  const scope = scopeOf(p, 'thread.state', input.key);
  const reference = await revisionOf(env, p.projectId, p.reviewKey, p.deploymentId);
  const current = async () => {
    const { messages: _, ...thread } = await getThread(env, p.projectId, p.reviewKey, threadId, reference);
    return thread as Thread;
  };
  const stored = await recordedResult(env, scope, digest);
  if (stored !== null) return { created: false, thread: stored as unknown as Thread };
  const before = await current();
  if (before.author.key !== p.actor.key && !p.capabilities.includes('thread.moderate')) throw new HttpError(403, 'forbidden', 'seul l’auteur ou un développeur change l’état');
  if (before.state === state) return recordSatisfied(env, scope, digest, before);
  if (before.version !== expectedVersion) throw new HttpError(412, 'state_conflict', `état modifié entre-temps (version ${before.version})`);

  const at = nowIso();
  const after: Thread = { ...before, state, version: expectedVersion + 1, updatedAt: at };
  const transition: Guard = {
    sql: `SELECT 1 FROM threads WHERE project_id = ? AND review_key = ? AND thread_id = ? AND version = ? AND state <> ? AND ${ACTIVE_REVIEW}`,
    binds: [p.projectId, p.reviewKey, threadId, expectedVersion, state, p.projectId, p.reviewKey],
  };
  const outcome = await commit(env, scope, digest, {
    before: [changeStatement(env, scope, threadId, `thread.${state}`, at, transition), operationStatement(env, scope, digest, after as unknown as Json, at, transition)],
    mutation: env.DB.prepare(`UPDATE threads SET state = ?, version = version + 1, updated_at = ? WHERE project_id = ? AND review_key = ? AND thread_id = ? AND version = ? AND state <> ? AND ${ACTIVE_REVIEW}`)
      .bind(state, at, p.projectId, p.reviewKey, threadId, expectedVersion, state, p.projectId, p.reviewKey),
    after: [],
  }, (replayed) => Promise.resolve(replayed as unknown as Thread));
  if (outcome.kind === 'replayed') return { created: false, thread: outcome.result };
  if (outcome.kind === 'written') return { created: true, thread: after };
  await requireActive(env, p.projectId, p.reviewKey);
  const now = await current();
  if (now.state === state) return recordSatisfied(env, scope, digest, now);
  throw new HttpError(412, 'state_conflict', `état modifié entre-temps (version ${now.version})`);
}

async function recordSatisfied(env: Env, scope: Scope, digest: string, thread: Thread): Promise<StateChanged> {
  try {
    const r = await env.DB.prepare(`INSERT INTO operations (project_id, review_key, actor_key, kind, idempotency_key, payload_digest, result, created_at) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${ACTIVE_REVIEW}`)
      .bind(scope.projectId, scope.reviewKey, scope.actorKey, scope.kind, scope.key, digest, JSON.stringify(thread), nowIso(), scope.projectId, scope.reviewKey).run();
    if ((r.meta.changes ?? 0) === 0) throw new HttpError(409, 'review_inactive', 'revue archivée : état inchangé');
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (!isConstraintViolation(e)) throw uncertain();
    const raced = await recordedResult(env, scope, digest);
    if (raced !== null) return { created: false, thread: raced as unknown as Thread };
    throw uncertain();
  }
  return { created: false, thread };
}

/** Dernier déploiement non révoqué de la revue, lu dans l'instruction même qui écrit la résolution. */
const LATEST_LIVE_DEPLOYMENT = `(SELECT d.deployment_id FROM deployments d WHERE d.project_id = ? AND d.review_key = ? AND d.revoked_at IS NULL ORDER BY d.created_at DESC, d.deployment_id DESC LIMIT 1)`;

/**
 * Résolution ou réouverture accompagnée de son message, en un seul batch : le message porte la transition, l'agent éventuel,
 * le commit et, pour une résolution, le dernier déploiement non révoqué. Un fil déjà dans l'état demandé est refusé, sauf reprise de la même clé.
 */
export async function transition(env: Env, input: { scope: WriterScope; key: string; threadId: string; state: ThreadState; body: string; commit: string | null }): Promise<Replied> {
  const p = input.scope;
  const { threadId, state, body } = input;
  const commitSha = state === 'resolved' ? input.commit : null;
  const digest = await digestOf({ threadId, state, body, commit: commitSha });
  const scope = scopeOf(p, 'thread.transition', input.key);
  const findMessage = async (messageId: string) => {
    const row = await env.DB.prepare('SELECT * FROM messages WHERE project_id = ? AND review_key = ? AND thread_id = ? AND message_id = ?').bind(p.projectId, p.reviewKey, threadId, messageId).first<MessageRow>();
    if (!row) throw uncertain('résultat introuvable');
    return toMessage(row, [], await liveDeployments(env, p.projectId, p.reviewKey));
  };
  const stored = await recordedResult(env, scope, digest);
  if (stored !== null) return { created: false, message: await findMessage((stored as { messageId: string }).messageId) };
  const before = await env.DB.prepare('SELECT * FROM threads WHERE project_id = ? AND review_key = ? AND thread_id = ?').bind(p.projectId, p.reviewKey, threadId).first<ThreadRow>();
  if (!before) throw new HttpError(404, 'not_found', 'retour inconnu');
  if (before.author_key !== p.actor.key && !p.capabilities.includes('thread.moderate')) throw new HttpError(403, 'forbidden', 'seul l’auteur ou un développeur change l’état');
  await requireActive(env, p.projectId, p.reviewKey);
  if (before.state === state) throw new HttpError(409, 'state_conflict', state === 'resolved' ? 'retour déjà résolu : répondre sans changer l’état' : 'retour déjà ouvert : répondre sans changer l’état');
  const messageId = crypto.randomUUID();
  const at = nowIso();
  const guard: Guard = {
    sql: `SELECT 1 FROM threads WHERE project_id = ? AND review_key = ? AND thread_id = ? AND version = ? AND state <> ? AND ${ACTIVE_REVIEW}`,
    binds: [p.projectId, p.reviewKey, threadId, before.version, state, p.projectId, p.reviewKey],
  };
  const outcome = await commit(env, scope, digest, {
    before: [
      env.DB.prepare(
        `INSERT INTO messages (project_id, review_key, thread_id, message_id, seq, author_key, author_name, exploring, body, created_at, via, transition, commit_sha, deployment_id)
         SELECT ?, ?, ?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM messages m WHERE m.project_id = ? AND m.review_key = ? AND m.thread_id = ?), ?, ?, ?, ?, ?, ?, ?, ?, ${state === 'resolved' ? LATEST_LIVE_DEPLOYMENT : 'NULL'}
         WHERE EXISTS (${guard.sql})`,
      ).bind(p.projectId, p.reviewKey, threadId, messageId, p.projectId, p.reviewKey, threadId, p.actor.key, p.actor.displayName, p.exploring ? JSON.stringify(p.exploring) : null, body, at, p.via, state, commitSha,
        ...(state === 'resolved' ? [p.projectId, p.reviewKey] : []), ...guard.binds),
      changeStatement(env, scope, threadId, `thread.${state}`, at, guard),
      operationStatement(env, scope, digest, { messageId }, at, guard),
    ],
    mutation: env.DB.prepare(`UPDATE threads SET state = ?, version = version + 1, updated_at = ? WHERE project_id = ? AND review_key = ? AND thread_id = ? AND version = ? AND state <> ? AND ${ACTIVE_REVIEW}`)
      .bind(state, at, p.projectId, p.reviewKey, threadId, before.version, state, p.projectId, p.reviewKey),
    after: [],
  }, (replayed) => findMessage((replayed as { messageId: string }).messageId));
  if (outcome.kind === 'replayed') return { created: false, message: outcome.result };
  if (outcome.kind === 'not-written') {
    await requireActive(env, p.projectId, p.reviewKey);
    throw new HttpError(412, 'state_conflict', 'état modifié entre-temps : relire le fil puis réessayer');
  }
  return { created: true, message: await findMessage(messageId) };
}
