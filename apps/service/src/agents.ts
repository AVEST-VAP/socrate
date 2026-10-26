import { USER_CODE_ALPHABET, USER_CODE_PATTERN, formatUserCode, normalizeUserCode, type AgentGrant, type AgentToken, type Capability, type DeviceDetails, type DeviceStart } from '@socrate/contract';
import type { Env } from './env.ts';
import { readConfig } from './env.ts';
import { HttpError, nowIso } from './http.ts';
import { delegatedCapabilities, randomToken, tokenHash, type Principal } from './auth.ts';
import { uncertain } from './d1.ts';

/** Durée d'un code affiché : dix minutes pour lancer la commande, ouvrir la preview et approuver. */
export const DEVICE_TTL_SECONDS = 600;
/** Intervalle de scrutation annoncé ; `slow_down` l'allonge de cinq secondes, comme RFC 8628. */
export const DEVICE_INTERVAL_SECONDS = 5;
/** Codes en attente par projet : au-delà, un démarrage est refusé sans rien écrire. */
export const MAX_PENDING_PER_PROJECT = 20;
/** Essais de code inconnus admis par acteur et par projet sur la fenêtre, contre la force brute. */
export const MAX_FAILED_LOOKUPS = 5;
export const FAILED_LOOKUP_WINDOW_MS = 10 * 60_000;
/** Validité fixe d'un jeton délégué, sans prolongation à l'usage. */
export const AGENT_TOKEN_TTL_SECONDS = 30 * 24 * 3600;

type DeviceRow = {
  device_hash: string; user_code: string; project_id: string; agent: string; machine: string; state: 'pending' | 'approved' | 'denied' | 'consumed';
  poll_interval: number; last_poll_ms: number | null; actor_key: string | null; actor_name: string | null; capabilities: string | null;
  token_id: string | null; decided_at: string | null; created_at: string; expires_at: number;
};
type TokenRow = { token_id: string; agent: string; machine: string; capabilities: string; created_at: string; expires_at: number; last_used_at: string | null };

const nowSec = () => Math.floor(Date.now() / 1000);
const isoOf = (sec: number) => new Date(sec * 1000).toISOString();

/** Huit caractères tirés uniformément de l'alphabet sans ambiguïté, par rejet des octets qui biaiseraient le modulo. */
function userCode(): string {
  const n = USER_CODE_ALPHABET.length;
  const limit = 256 - (256 % n);
  let out = '';
  while (out.length < 8) {
    for (const b of crypto.getRandomValues(new Uint8Array(16))) {
      if (b < limit && out.length < 8) out += USER_CODE_ALPHABET[b % n];
    }
  }
  return out;
}

/**
 * Démarrage sans authentification : le projet doit exister, les codes expirés sont effacés et le plafond des codes en attente
 * est vérifié dans l'instruction qui insère. Seule l'empreinte du `deviceCode` est stockée.
 */
export async function startDevice(env: Env, input: { projectId: string; agent: string; machine: string }): Promise<DeviceStart> {
  if (!readConfig(env).projects[input.projectId]) throw new HttpError(404, 'not_found', 'projet inconnu');
  const now = nowSec();
  for (let attempt = 0; attempt < 3; attempt++) {
    const deviceCode = randomToken();
    const code = userCode();
    let inserted: number;
    try {
      const [, , insert] = await env.DB.batch([
        env.DB.prepare('DELETE FROM device_authorizations WHERE expires_at < ?').bind(now),
        env.DB.prepare('DELETE FROM device_attempts WHERE at_ms < ?').bind(Date.now() - FAILED_LOOKUP_WINDOW_MS),
        env.DB.prepare(
          `INSERT INTO device_authorizations (device_hash, user_code, project_id, agent, machine, state, poll_interval, created_at, expires_at)
           SELECT ?, ?, ?, ?, ?, 'pending', ?, ?, ? WHERE (SELECT COUNT(*) FROM device_authorizations WHERE project_id = ? AND state = 'pending') < ?`,
        ).bind(await tokenHash(deviceCode), code, input.projectId, input.agent, input.machine, DEVICE_INTERVAL_SECONDS, nowIso(), now + DEVICE_TTL_SECONDS, input.projectId, MAX_PENDING_PER_PROJECT),
      ]);
      inserted = insert!.meta.changes ?? 0;
    } catch (e) {
      // Collision du code affiché avec un code encore vivant : un nouveau tirage suffit.
      if (/UNIQUE/i.test(String(e))) continue;
      throw uncertain('démarrage non confirmé, relancer la commande');
    }
    if (inserted === 0) throw new HttpError(429, 'rate_limited', `trop de codes en attente pour ce projet (${MAX_PENDING_PER_PROJECT}) : réessayer dans quelques minutes`, true);
    return { deviceCode, userCode: formatUserCode(code), expiresIn: DEVICE_TTL_SECONDS, interval: DEVICE_INTERVAL_SECONDS };
  }
  throw uncertain('code affiché non attribué, relancer la commande');
}

const deviceError = (code: 'authorization_pending' | 'slow_down' | 'access_denied' | 'expired_token' | 'invalid_grant', message: string) =>
  new HttpError(400, code, message, code === 'authorization_pending' || code === 'slow_down');

/**
 * Échange sans authentification par le `deviceCode` : réponses distinctes tant que la décision manque, puis remise unique du jeton.
 * Le passage `approved` → `consumed` et la création du jeton forment un seul batch : un second échange ne trouve plus de code approuvé.
 */
export async function exchangeDevice(env: Env, deviceCode: string): Promise<AgentGrant> {
  const hash = await tokenHash(deviceCode);
  const row = await env.DB.prepare('SELECT * FROM device_authorizations WHERE device_hash = ?').bind(hash).first<DeviceRow>();
  const now = nowSec();
  if (!row || row.expires_at < now) throw deviceError('expired_token', 'code expiré ou inconnu : relancer npx @meyer0x/socrate login');
  if (row.state === 'denied') throw deviceError('access_denied', 'autorisation refusée dans le panneau');
  if (row.state === 'consumed') throw deviceError('invalid_grant', 'code déjà échangé : relancer npx @meyer0x/socrate login');
  if (row.state === 'pending') {
    const ms = Date.now();
    const early = row.last_poll_ms !== null && ms - row.last_poll_ms < row.poll_interval * 1000;
    await env.DB.prepare('UPDATE device_authorizations SET last_poll_ms = ?, poll_interval = poll_interval + ? WHERE device_hash = ?').bind(ms, early ? 5 : 0, hash).run().catch(() => undefined);
    if (early) throw deviceError('slow_down', `scrutation trop rapide : attendre ${row.poll_interval + 5} secondes entre deux essais`);
    throw deviceError('authorization_pending', 'en attente de l’approbation dans le panneau');
  }
  const capabilities = delegatedCapabilities(readConfig(env), row.project_id, JSON.parse(row.capabilities!) as Capability[]);
  if (!capabilities.includes('thread.participate')) throw deviceError('access_denied', 'la politique du projet ne permet plus de déléguer');
  const token = randomToken();
  const tokenId = crypto.randomUUID();
  const expiresAt = now + AGENT_TOKEN_TTL_SECONDS;
  let consumed: number;
  try {
    const [update] = await env.DB.batch([
      env.DB.prepare("UPDATE device_authorizations SET state = 'consumed', token_id = ? WHERE device_hash = ? AND state = 'approved' AND expires_at >= ?").bind(tokenId, hash, now),
      env.DB.prepare(
        `INSERT INTO agent_tokens (token_id, token_hash, project_id, actor_key, actor_name, agent, machine, capabilities, created_at, expires_at)
         SELECT token_id, ?, project_id, actor_key, actor_name, agent, machine, ?, ?, ? FROM device_authorizations WHERE device_hash = ? AND token_id = ?`,
      ).bind(await tokenHash(token), JSON.stringify(capabilities), nowIso(), expiresAt, hash, tokenId),
    ]);
    consumed = update!.meta.changes ?? 0;
  } catch {
    throw uncertain('échange non confirmé : relancer npx @meyer0x/socrate login');
  }
  if (consumed === 0) throw deviceError('invalid_grant', 'code déjà échangé ou expiré : relancer npx @meyer0x/socrate login');
  return {
    accessToken: token, tokenType: 'Bearer', tokenId, projectId: row.project_id, agent: row.agent, machine: row.machine,
    actor: { key: row.actor_key!, displayName: row.actor_name! }, capabilities, expiresAt: isoOf(expiresAt),
  };
}

/** Panneau seulement : une session de relecteur, du projet demandé. */
function reviewer(p: Principal, projectId: string): Extract<Principal, { kind: 'session' }> {
  if (p.kind !== 'session') throw new HttpError(403, 'forbidden', 'cette opération exige une session de relecteur dans le panneau');
  if (p.projectId !== projectId) throw new HttpError(403, 'forbidden', 'accès limité à un autre projet');
  return p;
}

/**
 * Code saisi dans le panneau : chaque recherche réserve d'abord un essai, dans l'instruction même qui compte ceux de la fenêtre,
 * pour que des recherches parallèles ne dépassent pas le plafond. Au-delà, toute recherche est refusée avant lecture. Un code
 * trouvé rend sa réservation ; un code inconnu, mal formé ou d'un autre projet la garde comme échec de l'acteur.
 */
async function lookup(env: Env, p: Extract<Principal, { kind: 'session' }>, input: string): Promise<DeviceRow> {
  const now = Date.now();
  const reserved = await env.DB.prepare(
    `INSERT INTO device_attempts (project_id, actor_key, at_ms)
     SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM device_attempts WHERE project_id = ? AND actor_key = ? AND at_ms >= ?) < ?`,
  ).bind(p.projectId, p.actor.key, now, p.projectId, p.actor.key, now - FAILED_LOOKUP_WINDOW_MS, MAX_FAILED_LOOKUPS).run();
  if ((reserved.meta.changes ?? 0) === 0) throw new HttpError(429, 'rate_limited', 'trop de codes inconnus saisis : réessayer dans dix minutes', true);
  const code = normalizeUserCode(input);
  const row = USER_CODE_PATTERN.test(code)
    ? await env.DB.prepare('SELECT * FROM device_authorizations WHERE user_code = ? AND project_id = ?').bind(code, p.projectId).first<DeviceRow>()
    : null;
  if (!row) throw new HttpError(404, 'not_found', 'code inconnu pour ce projet : vérifier le code affiché par la commande');
  await env.DB.prepare('DELETE FROM device_attempts WHERE rowid = ?').bind(reserved.meta.last_row_id).run();
  return row;
}

function requireUndecided(row: DeviceRow): void {
  if (row.expires_at < nowSec()) throw new HttpError(410, 'expired_token', 'code expiré : relancer npx @meyer0x/socrate login');
  if (row.state !== 'pending') throw new HttpError(409, 'state_conflict', 'code déjà approuvé ou refusé');
}

export async function deviceDetails(env: Env, principal: Principal, projectId: string, input: string): Promise<DeviceDetails> {
  const row = await lookup(env, reviewer(principal, projectId), input);
  requireUndecided(row);
  return { userCode: formatUserCode(row.user_code), projectId: row.project_id, agent: row.agent, machine: row.machine, createdAt: row.created_at, expiresAt: isoOf(row.expires_at) };
}

/**
 * Approbation : l'acteur réel de la session, jamais un compte emprunté, et ses capacités de participation recoupées avec la politique.
 * L'instruction exige encore un code en attente et vivant : deux approbations concurrentes n'en valident qu'une.
 */
export async function decideDevice(env: Env, principal: Principal, projectId: string, input: string, approve: boolean): Promise<{ state: 'approved' | 'denied' }> {
  const p = reviewer(principal, projectId);
  if (approve && p.exploring) throw new HttpError(403, 'forbidden', 'approbation impossible en explorant un compte : un agent agit au nom de la personne réelle');
  if (approve && !p.capabilities.includes('thread.participate')) throw new HttpError(403, 'forbidden', 'capacité thread.participate absente : rien à déléguer');
  const row = await lookup(env, p, input);
  requireUndecided(row);
  const wanted: Capability[] = ['review.read', 'thread.participate', ...(p.capabilities.includes('thread.moderate') ? ['thread.moderate' as const] : [])];
  const capabilities = delegatedCapabilities(readConfig(env), projectId, wanted);
  const r = approve
    ? await env.DB.prepare("UPDATE device_authorizations SET state = 'approved', actor_key = ?, actor_name = ?, capabilities = ?, decided_at = ? WHERE device_hash = ? AND state = 'pending' AND expires_at >= ?")
      .bind(p.actor.key, p.actor.displayName, JSON.stringify(capabilities), nowIso(), row.device_hash, nowSec()).run()
    : await env.DB.prepare("UPDATE device_authorizations SET state = 'denied', decided_at = ? WHERE device_hash = ? AND state = 'pending' AND expires_at >= ?").bind(nowIso(), row.device_hash, nowSec()).run();
  if ((r.meta.changes ?? 0) === 0) throw new HttpError(409, 'state_conflict', 'code décidé ou expiré entre-temps');
  return { state: approve ? 'approved' : 'denied' };
}

/** Agents vivants de l'acteur courant sur le projet, du plus récent au plus ancien. */
export async function listAgents(env: Env, principal: Principal, projectId: string): Promise<AgentToken[]> {
  const p = reviewer(principal, projectId);
  const rows = (await env.DB.prepare('SELECT token_id, agent, machine, capabilities, created_at, expires_at, last_used_at FROM agent_tokens WHERE project_id = ? AND actor_key = ? AND revoked_at IS NULL AND expires_at >= ? ORDER BY created_at DESC, token_id')
    .bind(projectId, p.actor.key, nowSec()).all<TokenRow>()).results;
  return rows.map((r) => ({ tokenId: r.token_id, agent: r.agent, machine: r.machine, capabilities: JSON.parse(r.capabilities), createdAt: r.created_at, lastUsedAt: r.last_used_at, expiresAt: isoOf(r.expires_at) }));
}

/** Révocation par l'acteur dans le panneau : seulement ses propres jetons ; une seconde révocation rend le même résultat. */
export async function revokeAgent(env: Env, principal: Principal, projectId: string, tokenId: string): Promise<{ tokenId: string; revoked: true }> {
  const p = reviewer(principal, projectId);
  const r = await env.DB.prepare('UPDATE agent_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE token_id = ? AND project_id = ? AND actor_key = ?').bind(nowIso(), tokenId, projectId, p.actor.key).run();
  if ((r.meta.changes ?? 0) === 0) throw new HttpError(404, 'not_found', 'agent inconnu');
  return { tokenId, revoked: true };
}

/** `socrate logout` : le jeton délégué se révoque lui-même. */
export async function revokeSelf(env: Env, principal: Principal): Promise<{ tokenId: string; revoked: true }> {
  if (principal.kind !== 'agent') throw new HttpError(403, 'forbidden', 'seul un jeton délégué se révoque par cette route');
  await env.DB.prepare('UPDATE agent_tokens SET revoked_at = COALESCE(revoked_at, ?) WHERE token_id = ?').bind(nowIso(), principal.tokenId).run();
  return { tokenId: principal.tokenId, revoked: true };
}
