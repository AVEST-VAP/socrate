import { attachmentReservationSchema, captureCommitSchema, changesQuerySchema, deviceStartSchema, deviceTokenRequestSchema, issuesOf, threadListQuerySchema, MAX_CAPTURE_BYTES, newMessageSchema, newTargetedThreadSchema, newThreadSchema, reopenSchema, resolveSchema, sessionRequestSchema, stateChangeSchema, type Session } from '@socrate/contract';
import type { z } from 'zod';
import { ensureSchema, expectedSchema, readConfig, readInstance, type Env } from './env.ts';
import { HttpError, errorResponse, json, readJson } from './http.ts';
import { actorKey, authenticate, grantedCapabilities, randomToken, requireCapability, requireProject, tokenHash, verifyAssertion, type Principal } from './auth.ts';
import { isConstraintViolation } from './d1.ts';
import { deploymentOriginMatches, importDeployment, isRegisteredOrigin, readDeployment, readRevision, revokeDeployment } from './reviews.ts';
import { getThread, listThreads, publish, reply, setState, transition, type ParticipantScope, type WriterScope } from './threads.ts';
import { decideDevice, deviceDetails, exchangeDevice, listAgents, revokeAgent, revokeSelf, startDevice } from './agents.ts';
import { commitTargeted, readCapture, reclaimExpired, recognize, reserve, upload } from './captures.ts';
import { revisionOf } from './wordings.ts';
import { changesPage, listPage, listReviews } from './sync.ts';
import { archiveReview, archiver, MANUAL_PURGE } from './purge.ts';
import { readAttachment, reclaimExpiredAttachments, reserveAttachments, uploadAttachment } from './attachments.ts';

/** Chemin de l'entrée `mount` de ce build, fixé par `build-worker.ts`. */
declare const __SOCRATE_CLIENT__: string;

const ALLOWED_METHODS = 'GET, POST, PUT, OPTIONS';
const ALLOWED_HEADERS = 'Authorization, Content-Type, Idempotency-Key';

async function corsHeaders(env: Env, request: Request): Promise<Record<string, string>> {
  const origin = request.headers.get('Origin');
  const headers: Record<string, string> = { Vary: 'Origin' };
  if (origin && (await isRegisteredOrigin(env, origin))) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = ALLOWED_METHODS;
    headers['Access-Control-Allow-Headers'] = ALLOWED_HEADERS;
    headers['Access-Control-Max-Age'] = '600';
  }
  return headers;
}

/** `refused` dit ce qu'un agent délégué ne fait jamais : il répond, résout et rouvre, sans rien créer. */
function participant(p: Principal, refused: string): ParticipantScope {
  if (p.kind === 'agent') throw new HttpError(403, 'forbidden', `un agent délégué ne peut pas ${refused}`);
  if (p.kind !== 'session') throw new HttpError(403, 'forbidden', 'cette opération exige une session de relecteur');
  requireCapability(p, 'thread.participate');
  return { projectId: p.projectId, reviewKey: p.reviewKey, deploymentId: p.deploymentId, actor: p.actor, exploring: p.exploring, capabilities: p.capabilities, via: null };
}

/** Réponse et changement d'état avec message : session de relecteur, ou agent délégué au nom de son acteur réel. */
function writer(p: Principal, reviewKey: string): WriterScope {
  if (p.kind !== 'agent') return participant(p, '');
  requireCapability(p, 'thread.participate');
  return { projectId: p.projectId, reviewKey, deploymentId: null, actor: p.actor, exploring: null, capabilities: p.capabilities, via: p.agent };
}

/** Démarrage et échange servent aux outils : une page n'obtient jamais de jeton délégué. */
function toolOnly(request: Request): void {
  if (request.headers.get('Origin') !== null) throw new HttpError(403, 'forbidden', 'connexion d’agent refusée depuis une page web');
}

function idempotencyKey(request: Request): string {
  const key = request.headers.get('Idempotency-Key')?.trim() ?? '';
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new HttpError(422, 'invalid_request', 'en-tête Idempotency-Key requis (8 à 128 caractères)');
  return key;
}

async function parsed<T>(schema: z.ZodType<T>, request: Request, message: string): Promise<T> {
  const r = schema.safeParse(await readJson(request));
  if (!r.success) throw new HttpError(422, 'invalid_request', message, false, issuesOf(r.error));
  return r.data;
}

function queryOf<T>(schema: z.ZodType<T>, url: URL, message: string): T {
  const params: Record<string, string> = {};
  for (const [k, v] of url.searchParams) {
    if (k in params) throw new HttpError(422, 'invalid_request', `${message} : paramètre ${k} répété`);
    params[k] = v;
  }
  const r = schema.safeParse(params);
  if (!r.success) throw new HttpError(422, 'invalid_request', message, false, issuesOf(r.error));
  return r.data;
}

async function createSession(env: Env, request: Request): Promise<Response> {
  const config = readConfig(env);
  const body = sessionRequestSchema.safeParse(await readJson(request));
  if (!body.success) throw new HttpError(422, 'invalid_request', 'assertion manquante');
  const origin = request.headers.get('Origin');
  if (!origin) throw new HttpError(403, 'origin_not_registered', 'en-tête Origin requis');
  const claims = await verifyAssertion(config, body.data.assertion, origin);
  if (!(await deploymentOriginMatches(env, claims.projectId, claims.reviewKey, claims.deploymentId, origin))) {
    throw new HttpError(403, 'origin_not_registered', 'origine absente des déploiements enregistrés pour cette revue');
  }
  const capabilities = grantedCapabilities(config, claims);
  const token = randomToken();
  const hash = await tokenHash(token);
  const nowSec = Math.floor(Date.now() / 1000);
  const expiresAt = nowSec + config.sessionTtlSeconds;
  const actor = { key: actorKey(claims.iss, claims.sub), displayName: claims.name };
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO consumed_assertions (issuer, jti, expires_at) VALUES (?, ?, ?)').bind(claims.iss, claims.jti, claims.exp + config.clockSkewSeconds),
      // Une purge entre la vérification d'origine et ce batch ne laisse aucune session orpheline : la ligne exige son déploiement et une revue non purgée.
      env.DB.prepare(
        `INSERT INTO sessions (session_id, token_hash, project_id, review_key, deployment_id, origin, actor_key, actor_name, exploring, capabilities, issued_at, expires_at)
         SELECT ?, ?, d.project_id, d.review_key, d.deployment_id, ?, ?, ?, ?, ?, ?, ? FROM deployments d JOIN reviews v ON v.project_id = d.project_id AND v.review_key = d.review_key
         WHERE d.project_id = ? AND d.review_key = ? AND d.deployment_id = ? AND d.origin = ? AND d.revoked_at IS NULL AND v.state IN ('active', 'archived')`,
      ).bind(crypto.randomUUID(), hash, origin, actor.key, actor.displayName, claims.exploring ? JSON.stringify(claims.exploring) : null, JSON.stringify(capabilities), nowSec, expiresAt,
        claims.projectId, claims.reviewKey, claims.deploymentId, origin),
    ]).then((r) => {
      if ((r[1]!.meta.changes ?? 0) === 0) throw new HttpError(403, 'origin_not_registered', 'déploiement révoqué ou revue purgée pendant l’ouverture de session');
    });
  } catch (e) {
    if (e instanceof HttpError) throw e;
    if (isConstraintViolation(e)) throw new HttpError(401, 'assertion_replayed', 'assertion déjà consommée, nouvelle assertion requise');
    throw new HttpError(503, 'persistence_uncertain', 'session non confirmée', true);
  }
  const session: Session = { sessionToken: token, expiresAt: new Date(expiresAt * 1000).toISOString(), actor, exploring: claims.exploring, capabilities };
  return json(session, 201);
}

function pathSegments(url: URL): string[] {
  try {
    return url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new HttpError(404, 'not_found', 'chemin mal encodé');
  }
}

/** Fichiers nommés par empreinte, donc immuables ; le CORS du Worker les ouvre aux seules origines enregistrées. */
async function clientFile(env: Env, request: Request): Promise<Response> {
  const asset = await env.ASSETS.fetch(request);
  if (!asset.ok) throw new HttpError(404, 'not_found', 'fichier client inconnu');
  const response = new Response(asset.body, asset);
  response.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
  response.headers.set('X-Content-Type-Options', 'nosniff');
  return response;
}

async function route(env: Env, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method;
  const seg = pathSegments(url);
  if (seg[0] === 'client' && seg.length === 2 && method === 'GET') return clientFile(env, request);
  if (seg[0] !== 'v1') throw new HttpError(404, 'not_found', 'route inconnue');
  if (seg[1] === 'client' && seg.length === 2 && method === 'GET') return json({ url: new URL(__SOCRATE_CLIENT__, url).href });
  if (seg[1] === 'health' && seg.length === 2 && method === 'GET') {
    const instance = readInstance(env);
    const restored = await env.DB.prepare('SELECT state, started_at, restored_at, backup_created_at, manifest_sha256, source_instance_id FROM restorations ORDER BY started_at DESC LIMIT 1')
      .first<{ state: 'in_progress' | 'complete'; started_at: string; restored_at: string | null; backup_created_at: string; manifest_sha256: string; source_instance_id: string }>();
    return json({
      ok: true, instanceId: instance.instanceId, build: instance.build, schema: expectedSchema(env).map((m) => m.id),
      restoredFrom: restored ? { state: restored.state, startedAt: restored.started_at, restoredAt: restored.restored_at, backupCreatedAt: restored.backup_created_at, manifestSha256: restored.manifest_sha256, sourceInstanceId: restored.source_instance_id } : null,
    });
  }
  if (seg[1] === 'auth' && seg[2] === 'session' && seg.length === 3 && method === 'POST') return createSession(env, request);
  if (seg[1] === 'auth' && seg[2] === 'device' && seg.length === 3 && method === 'POST') {
    toolOnly(request);
    return json(await startDevice(env, await parsed(deviceStartSchema, request, 'démarrage invalide')), 201);
  }
  if (seg[1] === 'auth' && seg[2] === 'device' && seg[3] === 'token' && seg.length === 4 && method === 'POST') {
    toolOnly(request);
    return json(await exchangeDevice(env, (await parsed(deviceTokenRequestSchema, request, 'échange invalide')).deviceCode));
  }
  if (seg[1] === 'auth' && seg[2] === 'agent' && seg[3] === 'revoke' && seg.length === 4 && method === 'POST') return json(await revokeSelf(env, await authenticate(env, request)));
  if (seg[1] === 'projects' && seg[2] && seg[3] === 'devices' && seg[4]) {
    const principal = await authenticate(env, request);
    if (seg.length === 5 && method === 'GET') return json(await deviceDetails(env, principal, seg[2], seg[4]));
    if (seg.length === 6 && (seg[5] === 'approve' || seg[5] === 'deny') && method === 'POST') return json(await decideDevice(env, principal, seg[2], seg[4], seg[5] === 'approve'));
  }
  if (seg[1] === 'projects' && seg[2] && seg[3] === 'agents') {
    const principal = await authenticate(env, request);
    if (seg.length === 4 && method === 'GET') return json({ items: await listAgents(env, principal, seg[2]) });
    if (seg.length === 6 && seg[4] && seg[5] === 'revoke' && method === 'POST') return json(await revokeAgent(env, principal, seg[2], seg[4]));
  }

  if (seg[1] === 'projects' && seg[3] === 'purge' && seg[2] && seg.length === 4 && method === 'POST') {
    const principal = await authenticate(env, request);
    requireProject(principal, seg[2]);
    archiver(principal);
    // L'instance interactive peut avoir des téléversements en vol : seule la phase de maintenance exclusive purge.
    throw new HttpError(409, 'maintenance', `purge refusée sur l’instance en service : ${MANUAL_PURGE}`);
  }
  if (seg[1] === 'projects' && seg[3] === 'reviews' && seg[2] && seg.length === 4 && method === 'GET') {
    const principal = await authenticate(env, request);
    requireProject(principal, seg[2]);
    requireCapability(principal, 'review.read');
    return json({ items: await listReviews(env, seg[2]) });
  }
  if (seg[1] === 'projects' && seg[3] === 'reviews' && seg[2] && seg[4]) {
    const projectId = seg[2];
    const reviewKey = seg[4];
    const principal = await authenticate(env, request);
    requireProject(principal, projectId, reviewKey);

    if (seg[5] === 'archive' && seg.length === 6 && method === 'POST') {
      archiver(principal);
      return json(await archiveReview(env, projectId, reviewKey, readConfig(env).archiveRetentionDays));
    }
    if (seg[5] === 'deployments' && seg[6] && seg.length === 7) {
      if (method === 'PUT') {
        requireCapability(principal, 'deployment.import');
        const r = await importDeployment(env, projectId, reviewKey, seg[6], await readJson(request));
        return json({ review: r.review, revisionId: r.revisionId, deploymentId: r.deploymentId }, r.created ? 201 : 200);
      }
      if (method === 'GET') {
        requireCapability(principal, principal.kind === 'session' ? 'thread.participate' : 'review.read');
        return json(await readDeployment(env, projectId, reviewKey, seg[6]));
      }
    }
    if (seg[5] === 'deployments' && seg[6] && seg[7] === 'revoke' && seg.length === 8 && method === 'POST') {
      if (principal.kind !== 'technical') throw new HttpError(403, 'forbidden', 'la révocation exige un accès technique');
      requireCapability(principal, 'deployment.import');
      return json(await revokeDeployment(env, projectId, reviewKey, seg[6]));
    }
    if (seg[5] === 'revisions' && seg[6] && seg.length === 7 && method === 'GET') {
      requireCapability(principal, principal.kind === 'session' ? 'thread.participate' : 'review.read');
      return json(await readRevision(env, projectId, reviewKey, seg[6]));
    }
    if (seg[5] === 'captures' && seg[6]) {
      const captureId = seg[6];
      if (seg.length === 7 && method === 'GET') {
        requireCapability(principal, principal.kind === 'session' ? 'thread.participate' : 'review.read');
        return readCapture(env, projectId, reviewKey, captureId);
      }
      if (seg.length === 7 && method === 'PUT') {
        const scope = participant(principal, 'téléverser une capture');
        const attempt = captureCommitSchema.safeParse({ attempt: url.searchParams.get('attempt') ?? '' });
        if (!attempt.success) throw new HttpError(422, 'invalid_request', 'paramètre attempt requis');
        if ((request.headers.get('Content-Type') ?? '') !== 'image/png') throw new HttpError(422, 'invalid_request', 'Content-Type image/png attendu');
        const declared = Number(request.headers.get('Content-Length') ?? '0');
        if (declared > MAX_CAPTURE_BYTES) throw new HttpError(422, 'invalid_request', 'image trop volumineuse');
        const bytes = new Uint8Array(await request.arrayBuffer().catch(() => { throw new HttpError(400, 'invalid_request', 'téléversement interrompu', true); }));
        if (bytes.byteLength > MAX_CAPTURE_BYTES) throw new HttpError(422, 'invalid_request', 'image trop volumineuse');
        await upload(env, { scope, captureId, attempt: attempt.data.attempt, bytes });
        return json({ uploaded: true }, 200);
      }
      if (seg[7] === 'commit' && seg.length === 8 && method === 'POST') {
        const scope = participant(principal, 'créer un fil');
        const body = await parsed(captureCommitSchema, request, 'validation invalide');
        const r = await commitTargeted(env, { scope, captureId, attempt: body.attempt });
        return json(r.thread, r.created ? 201 : 200);
      }
    }
    if (seg[5] === 'attachments' && seg.length === 6 && method === 'POST') {
      const scope = participant(principal, 'joindre une pièce');
      const key = idempotencyKey(request);
      const body = await parsed(attachmentReservationSchema, request, 'pièces jointes invalides');
      return json(await reserveAttachments(env, { scope, key, operation: body.operation, attachments: body.attachments }), 201);
    }
    if (seg[5] === 'attachments' && seg[6] && seg.length === 7) {
      if (method === 'GET') {
        requireCapability(principal, principal.kind === 'session' ? 'thread.participate' : 'review.read');
        return readAttachment(env, projectId, reviewKey, seg[6]);
      }
      if (method === 'PUT') {
        const scope = participant(principal, 'joindre une pièce');
        const length = request.headers.get('Content-Length');
        // Une pièce par requête, lue en flux : jamais plusieurs vidéos en mémoire dans le Worker.
        await uploadAttachment(env, { scope, attachmentId: seg[6], contentType: request.headers.get('Content-Type') ?? '', declaredLength: length === null ? null : Number(length), body: request.body });
        return json({ uploaded: true }, 200);
      }
    }
    if (seg[5] === 'targeted' && seg.length === 6 && method === 'GET') {
      const scope = participant(principal, 'créer un fil');
      return json(await recognize(env, { scope, key: idempotencyKey(request) }));
    }
    if (seg[5] === 'targeted' && seg.length === 6 && method === 'POST') {
      const scope = participant(principal, 'créer un fil');
      const key = idempotencyKey(request);
      const payload = await parsed(newTargetedThreadSchema, request, 'retour ciblé invalide');
      const r = await reserve(env, { scope, key, payload });
      return r.kind === 'committed' ? json(r.thread, 200) : json(r.reservation, 201);
    }
    if (seg[5] === 'changes' && seg.length === 6 && method === 'GET') {
      requireCapability(principal, 'review.read');
      const q = queryOf(changesQuerySchema, url, 'paramètres de lecture incrémentale invalides');
      return json(await changesPage(env, projectId, reviewKey, q.since, q.limit, await revisionOf(env, projectId, reviewKey, null)));
    }
    if (seg[5] === 'threads') {
      if (seg.length === 6 && method === 'GET') {
        requireCapability(principal, principal.kind === 'session' ? 'thread.participate' : 'review.read');
        const reference = await revisionOf(env, projectId, reviewKey, principal.kind === 'session' ? principal.deploymentId : null);
        // Le panneau lit la revue entière ; l'accès technique parcourt une liste figée page par page.
        if (principal.kind === 'session') return json({ items: await listThreads(env, projectId, reviewKey, reference) });
        return json(await listPage(env, projectId, reviewKey, queryOf(threadListQuerySchema, url, 'paramètres de liste invalides'), reference));
      }
      if (seg.length === 6 && method === 'POST') {
        const scope = participant(principal, 'créer un fil ni proposer une formulation');
        const key = idempotencyKey(request);
        const body = await parsed(newThreadSchema, request, 'retour invalide');
        const r = await publish(env, { scope, key, body: body.body, proposal: body.proposal, attachments: body.attachments });
        return json(r.thread, r.created ? 201 : 200);
      }
      const threadId = seg[6];
      if (threadId && seg.length === 7 && method === 'GET') {
        requireCapability(principal, principal.kind === 'session' ? 'thread.participate' : 'review.read');
        const reference = await revisionOf(env, projectId, reviewKey, principal.kind === 'session' ? principal.deploymentId : null);
        return json(await getThread(env, projectId, reviewKey, threadId, reference));
      }
      if (threadId && seg[7] === 'messages' && seg.length === 8 && method === 'POST') {
        const scope = writer(principal, reviewKey);
        const key = idempotencyKey(request);
        const body = await parsed(newMessageSchema, request, 'réponse invalide');
        if (scope.via !== null && body.attachments?.length) throw new HttpError(403, 'forbidden', 'un agent délégué ne peut pas joindre une pièce');
        const r = await reply(env, { scope, key, threadId, body: body.body, attachments: body.attachments });
        return json(r.message, r.created ? 201 : 200);
      }
      if (threadId && (seg[7] === 'resolve' || seg[7] === 'reopen') && seg.length === 8 && method === 'POST') {
        const scope = writer(principal, reviewKey);
        const key = idempotencyKey(request);
        const body = seg[7] === 'resolve'
          ? await parsed(resolveSchema, request, 'résolution invalide : message requis, commit facultatif')
          : { ...(await parsed(reopenSchema, request, 'réouverture invalide : message requis')), commit: undefined };
        const r = await transition(env, { scope, key, threadId, state: seg[7] === 'resolve' ? 'resolved' : 'open', body: body.message, commit: body.commit ?? null });
        return json(r.message, r.created ? 201 : 200);
      }
      if (threadId && seg[7] === 'state' && seg.length === 8 && method === 'PUT') {
        const scope = participant(principal, 'changer l’état sans message : utiliser …/resolve ou …/reopen');
        const key = idempotencyKey(request);
        const body = await parsed(stateChangeSchema, request, 'changement d’état invalide');
        const r = await setState(env, { scope, key, threadId, state: body.state, expectedVersion: body.expectedVersion });
        return json(r.thread, 200);
      }
    }
  }
  throw new HttpError(404, 'not_found', 'route inconnue');
}

/** Refus lisible des nouvelles requêtes pendant le gel D1 ; les déclencheurs de 0006 avortent aussi les écritures D1 en vol, jamais un PUT R2. */
async function refuseWhileFrozen(env: Env): Promise<void> {
  if (env.SOCRATE_MAINTENANCE === 'exclusive') throw new HttpError(503, 'maintenance', 'phase de maintenance exclusive : aucune requête ordinaire acceptée', true);
  const m = await env.DB.prepare('SELECT frozen, since FROM maintenance WHERE singleton = 1').first<{ frozen: number; since: string | null }>();
  if (m?.frozen === 1) throw new HttpError(503, 'maintenance', `instance gelée pour sauvegarde depuis ${m.since}, réessayer après la sauvegarde`, true);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    let cors: Record<string, string> = { Vary: 'Origin' };
    try {
      await ensureSchema(env);
      cors = await corsHeaders(env, request);
      if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
      if (new URL(request.url).pathname !== '/v1/health') await refuseWhileFrozen(env);
      const response = await route(env, request);
      for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
      response.headers.set('X-Request-Id', requestId);
      return response;
    } catch (e) {
      const err = e instanceof HttpError ? e : new HttpError(500, 'persistence_uncertain', 'erreur interne', true);
      if (!(e instanceof HttpError)) console.error(requestId, e);
      // Un corps JSON refusé avant lecture est lu avant la réponse : sinon la connexion réutilisée par le client peut être réinitialisée.
      if (!request.bodyUsed && (request.headers.get('Content-Type') ?? '').startsWith('application/json')) await request.text().catch(() => undefined);
      return errorResponse(err, requestId, { ...cors, 'X-Request-Id': requestId });
    }
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await ensureSchema(env);
    console.log(`nettoyage des captures : ${JSON.stringify(await reclaimExpired(env))}`);
    console.log(`nettoyage des pièces jointes : ${JSON.stringify(await reclaimExpiredAttachments(env))}`);
  },
} satisfies ExportedHandler<Env>;
