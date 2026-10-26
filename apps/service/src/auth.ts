import { z } from 'zod';
import { capabilitySchema, tokenHash, type Capability, type Exploring, type Actor } from '@socrate/contract';
import { readConfig, type Env, type ServiceConfig } from './env.ts';
import { HttpError } from './http.ts';

export { randomToken, tokenHash } from '@socrate/contract';

const claimsSchema = z.object({
  iss: z.string().min(1),
  aud: z.string().min(1),
  sub: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  iat: z.number().int(),
  exp: z.number().int(),
  jti: z.string().min(8).max(128),
  projectId: z.string().min(1),
  reviewKey: z.string().min(1),
  deploymentId: z.string().min(1),
  origin: z.string().url(),
  capabilities: z.array(capabilitySchema),
  exploring: z.object({ account: z.string().min(1), organisation: z.string().nullable().default(null) }).nullable().default(null),
});
export type AssertionClaims = z.infer<typeof claimsSchema>;

const headerSchema = z.looseObject({ alg: z.literal('ES256') });

export type Principal =
  | { kind: 'session'; projectId: string; reviewKey: string; deploymentId: string; origin: string; actor: Actor; exploring: Exploring; capabilities: Capability[] }
  | { kind: 'technical'; projectId: string; capabilities: Capability[]; label: string }
  | { kind: 'agent'; projectId: string; capabilities: Capability[]; actor: Actor; agent: string; tokenId: string };

const B64URL = /^[A-Za-z0-9_-]*$/;

function b64urlDecode(s: string): Uint8Array {
  if (!B64URL.test(s) || s.length % 4 === 1) throw new Error('base64url invalide');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

const keyCache = new Map<string, Promise<CryptoKey>>();
function importKey(issuer: string, jwk: ServiceConfig['projects'][string]['publicJwk']): Promise<CryptoKey> {
  const id = `${issuer}:${JSON.stringify(jwk)}`;
  let p = keyCache.get(id);
  if (!p) {
    p = crypto.subtle.importKey('jwk', jwk as JsonWebKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    keyCache.set(id, p);
  }
  return p;
}

const invalid = (why: string) => new HttpError(401, 'assertion_invalid', `assertion refusée : ${why}`);

export async function verifyAssertion(config: ServiceConfig, token: string, requestOrigin: string | null, now = Date.now()): Promise<AssertionClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw invalid('format');
  let headerRaw: unknown;
  let payload: unknown;
  let signature: Uint8Array;
  try {
    headerRaw = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[0]!)));
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(parts[1]!)));
    signature = b64urlDecode(parts[2]!);
  } catch {
    throw invalid('encodage');
  }
  if (!headerSchema.safeParse(headerRaw).success) throw invalid('algorithme');
  const parsed = claimsSchema.safeParse(payload);
  if (!parsed.success) throw invalid(`claims (${parsed.error.issues.map((i) => i.path.join('.')).join(', ')})`);
  const claims = parsed.data;
  if (claims.aud !== config.audience) throw invalid('audience');
  const project = config.projects[claims.projectId];
  if (!project) throw invalid('projet inconnu');
  if (claims.iss !== project.issuer) throw invalid('émetteur');
  const key = await importKey(project.issuer, project.publicJwk);
  const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  let ok = false;
  try {
    ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature as BufferSource, data);
  } catch {
    ok = false;
  }
  if (!ok) throw invalid('signature');
  const nowSec = Math.floor(now / 1000);
  const skew = config.clockSkewSeconds;
  if (claims.exp <= claims.iat) throw invalid('validité vide');
  if (claims.exp - claims.iat > config.assertionMaxAgeSeconds) throw invalid('validité trop longue');
  if (claims.iat > nowSec + skew) throw invalid('émise dans le futur');
  if (claims.exp + skew < nowSec) throw invalid('expirée');
  if (requestOrigin !== null && claims.origin !== requestOrigin) throw invalid('origine');
  return claims;
}

export function grantedCapabilities(config: ServiceConfig, claims: AssertionClaims): Capability[] {
  const attestable = new Set(config.projects[claims.projectId]!.attestableCapabilities);
  return claims.capabilities.filter((c) => attestable.has(c));
}

export function actorKey(issuer: string, sub: string): string {
  return `${issuer}:${sub}`;
}

type SessionRow = {
  project_id: string; review_key: string; deployment_id: string; origin: string; actor_key: string; actor_name: string;
  exploring: string | null; capabilities: string; expires_at: number; revoked_at: string | null;
};
type CredentialRow = { project_id: string; label: string; capabilities: string; expires_at: number };
type AgentRow = { token_id: string; project_id: string; actor_key: string; actor_name: string; agent: string; capabilities: string; expires_at: number; last_used_at: string | null; revoked_at: string | null };

/**
 * Capacités déléguées encore admises par la politique du projet : recoupées à chaque usage. Sans `thread.participate` attestable,
 * le jeton ne donne plus rien, pas même la lecture qu'il tient de la participation.
 */
export function delegatedCapabilities(config: ServiceConfig, projectId: string, stored: Capability[]): Capability[] {
  const policy = config.projects[projectId];
  if (!policy?.attestableCapabilities.includes('thread.participate')) return [];
  const attestable = new Set<Capability>([...policy.attestableCapabilities, 'review.read']);
  return stored.filter((c) => attestable.has(c));
}

/** Dernière utilisation notée à la minute près : une lecture n'écrit pas à chaque requête. */
const LAST_USED_GRAIN_MS = 60_000;

export async function authenticate(env: Env, request: Request): Promise<Principal> {
  const header = request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) throw new HttpError(401, 'unauthenticated', 'session ou accès technique requis');
  const hash = await tokenHash(token);
  const nowSec = Math.floor(Date.now() / 1000);
  const session = await env.DB.prepare(
    `SELECT s.project_id, s.review_key, s.deployment_id, s.origin, s.actor_key, s.actor_name, s.exploring, s.capabilities, s.expires_at, d.revoked_at
     FROM sessions s LEFT JOIN deployments d ON d.project_id = s.project_id AND d.review_key = s.review_key AND d.deployment_id = s.deployment_id
     WHERE s.token_hash = ?`,
  ).bind(hash).first<SessionRow>();
  if (session) {
    if (session.expires_at < nowSec) throw new HttpError(401, 'session_expired', 'session Socrate expirée, nouvelle assertion requise');
    if (session.revoked_at !== null) throw new HttpError(403, 'forbidden', 'accès au déploiement révoqué');
    const origin = request.headers.get('Origin');
    if (origin !== session.origin) throw new HttpError(403, 'origin_not_registered', 'origine différente de celle de la session');
    return {
      kind: 'session', projectId: session.project_id, reviewKey: session.review_key, deploymentId: session.deployment_id, origin: session.origin,
      actor: { key: session.actor_key, displayName: session.actor_name },
      exploring: session.exploring ? (JSON.parse(session.exploring) as Exploring) : null,
      capabilities: JSON.parse(session.capabilities) as Capability[],
    };
  }
  const cred = await env.DB.prepare('SELECT project_id, label, capabilities, expires_at FROM technical_credentials WHERE token_hash = ?').bind(hash).first<CredentialRow>();
  if (cred) {
    if (cred.expires_at < nowSec) throw new HttpError(401, 'unauthenticated', 'accès technique expiré');
    return { kind: 'technical', projectId: cred.project_id, label: cred.label, capabilities: JSON.parse(cred.capabilities) as Capability[] };
  }
  const agent = await env.DB.prepare('SELECT token_id, project_id, actor_key, actor_name, agent, capabilities, expires_at, last_used_at, revoked_at FROM agent_tokens WHERE token_hash = ?').bind(hash).first<AgentRow>();
  if (!agent) throw new HttpError(401, 'unauthenticated', 'accès inconnu');
  // Le jeton délégué sert aux outils : une page qui le porterait l'exposerait à tout script de son origine.
  if (request.headers.get('Origin') !== null) throw new HttpError(403, 'forbidden', 'jeton délégué refusé depuis une page web');
  if (agent.revoked_at !== null) throw new HttpError(401, 'unauthenticated', 'jeton délégué révoqué');
  if (agent.expires_at < nowSec) throw new HttpError(401, 'unauthenticated', 'jeton délégué expiré, relancer npx @meyer0x/socrate login');
  const now = Date.now();
  if (agent.last_used_at === null || Date.parse(agent.last_used_at) < now - LAST_USED_GRAIN_MS) {
    await env.DB.prepare('UPDATE agent_tokens SET last_used_at = ? WHERE token_id = ? AND revoked_at IS NULL').bind(new Date(now).toISOString(), agent.token_id).run().catch(() => undefined);
  }
  return {
    kind: 'agent', projectId: agent.project_id, tokenId: agent.token_id, agent: agent.agent, actor: { key: agent.actor_key, displayName: agent.actor_name },
    capabilities: delegatedCapabilities(readConfig(env), agent.project_id, JSON.parse(agent.capabilities) as Capability[]),
  };
}

export function requireCapability(p: Principal, cap: Capability): void {
  if (!p.capabilities.includes(cap)) throw new HttpError(403, 'forbidden', `capacité ${cap} absente`);
}

export function requireProject(p: Principal, projectId: string, reviewKey?: string): void {
  if (p.projectId !== projectId) throw new HttpError(403, 'forbidden', 'accès limité à un autre projet');
  if (reviewKey !== undefined && p.kind === 'session' && p.reviewKey !== reviewKey) throw new HttpError(403, 'forbidden', 'session limitée à une autre revue');
}
