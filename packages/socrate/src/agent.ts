// Commandes des agents de code : connexion déléguée par code affiché (device flow), puis lecture, réponse, résolution et réouverture des retours.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { ATTACHMENT_TYPES, MAX_ATTACHMENTS, SIGNATURE_BYTES, commitShaSchema, deviceStartSchema, handoffOf, safeName, signatureMatches, stableId, type AttachmentMeta, type AttachmentReservation, type AgentGrant, type ApiError, type DeviceStart, type Message, type ThreadPage, type ThreadWithMessages } from '@socrate/contract';
import { loadConfig, renderReviewKey, type LoadedConfig } from './config.ts';
import { credentialsPath, readTokens, sameSlot, writeTokens, type StoredToken } from './credentials.ts';
import { CliError, secrets, type Io } from './io.ts';

const run = promisify(execFile);

export const AGENT_COMMANDS = new Set(['login', 'logout', 'threads', 'thread', 'reply', 'resolve', 'reopen']);
export const AGENT_USAGE = `  socrate login [--agent <name>] [--config socrate.yml] [--json]
  socrate logout [--agent <name>] [--config socrate.yml] [--json]
  socrate threads [--pr <n> | --review <key>] [--state open|resolved|all | --for-agent] [--agent <name>] [--json]
  socrate thread <id> [--pr <n> | --review <key>] [--captures <dir>] [--agent <name>] [--json]
  socrate reply <id> <message | -> [--attach <image>]... [--after <seq>] [--key <key>] [--pr <n> | --review <key>] [--agent <name>] [--json]
  socrate resolve <id> --message <text | -> [--commit <sha> | --no-commit] [--after <seq>] [--key <key>] [--pr <n> | --review <key>] [--agent <name>] [--json]
  socrate reopen <id> --message <text | -> [--after <seq>] [--key <key>] [--pr <n> | --review <key>] [--agent <name>] [--json]`;

const OPTIONS = {
  config: { type: 'string' }, agent: { type: 'string' }, json: { type: 'boolean' }, pr: { type: 'string' }, review: { type: 'string' },
  state: { type: 'string' }, captures: { type: 'string' }, message: { type: 'string' }, commit: { type: 'string' }, 'no-commit': { type: 'boolean' },
  key: { type: 'string' }, 'for-agent': { type: 'boolean' }, after: { type: 'string' }, attach: { type: 'string', multiple: true },
} as const;
type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>['values'];

const usage = (message: string) => new CliError(`${message}\nusage:\n${AGENT_USAGE}`, 2);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const LOGIN = 'npx @meyer0x/socrate login';

/** Sortie lisible : un caractère de contrôle venu du service (corps, nom, cible, HTML) ne pilote jamais le terminal. */
export const printable = (t: string) => t.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '\ufffd');

/** Agent qui lance la commande, d'après les variables posées par Claude Code (`CLAUDECODE`) et par Codex dans ses commandes. */
export function detectAgent(env: Io['env']): string | null {
  if (env.CLAUDECODE) return 'Claude';
  if (env.CODEX_THREAD_ID || env.CODEX_SANDBOX || env.CODEX_SANDBOX_NETWORK_DISABLED) return 'Codex';
  return null;
}

type Ctx = { io: Io; config: LoadedConfig; values: Values; out: (human: string, json: unknown) => void };
type Reply = { status: number; body: unknown; bytes: Uint8Array };

/** Une requête au service, sans en-tête Origin, sans redirection ; le jeton ne passe que dans `Authorization`. */
async function request(ctx: Ctx, method: string, path: string, init: { token?: string; body?: unknown; key?: string; bytes?: { data: Uint8Array; type: string } } = {}): Promise<Reply> {
  const headers: Record<string, string> = { 'User-Agent': 'socrate-cli' };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.bytes) headers['Content-Type'] = init.bytes.type;
  if (init.key) headers['Idempotency-Key'] = init.key;
  const url = `${ctx.config.service}${path}`;
  const res = await fetch(url, { method, headers, body: init.bytes ? new Blob([init.bytes.data as Uint8Array<ArrayBuffer>]) : (init.body === undefined ? undefined : JSON.stringify(init.body)), redirect: 'error', signal: AbortSignal.timeout(init.bytes ? 120_000 : 30_000) })
    .catch((e: Error) => { throw new CliError(`Socrate service unreachable (${method} ${url}): ${e.cause instanceof Error ? e.cause.message : e.message}`); });
  if (res.status === 401 && init.token) forget(ctx, init.token);
  const bytes = new Uint8Array(await res.arrayBuffer());
  let body: unknown = null;
  if ((res.headers.get('Content-Type') ?? '').startsWith('application/json')) {
    try { body = JSON.parse(new TextDecoder().decode(bytes)); } catch { body = null; }
  }
  return { status: res.status, body, bytes };
}

/** Un jeton refusé (révoqué, expiré) quitte le fichier d'identifiants, toujours réécrit en 0600 par renommage. */
function forget(ctx: Ctx, token: string): void {
  const all = readTokens(ctx.io.env);
  const kept = all.filter((t) => t.token !== token);
  if (kept.length < all.length) writeTokens(ctx.io.env, kept);
}

function refused(r: Reply, what: string): CliError {
  const e = r.body as Partial<ApiError> | null;
  const hint = r.status === 401 ? `; the token was removed from the credentials file: run ${LOGIN} again` : '';
  return new CliError(printable(`the Socrate service refused ${what}: ${r.status} ${e?.code ?? ''}${e?.message ? `: ${e.message}` : ''}${hint}`));
}

async function expect<T>(ctx: Ctx, what: string, method: string, path: string, init: { token?: string; body?: unknown } = {}): Promise<T> {
  const r = await request(ctx, method, path, init);
  if (r.status < 200 || r.status >= 300) throw refused(r, what);
  return r.body as T;
}

const KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * Une écriture : une seule clé d'idempotence pour toutes les tentatives, tirée au hasard ou passée par `--key`. Une réponse
 * perdue ou un refus réessayable relance la même requête, que le service reconnaît au lieu d'écrire deux fois. Si l'issue
 * reste inconnue (réseau, 5xx), la clé est rendue : relancer avec `--key` ne duplique pas une écriture peut-être faite.
 */
async function write<T>(ctx: Ctx, what: string, path: string, token: string, body: unknown, key = ctx.values.key ?? `socrate-cli-${randomUUID()}`): Promise<T> {
  let last: CliError | null = null;
  let unknown = false;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(1000 * attempt);
    let r: Reply;
    try {
      r = await request(ctx, 'POST', path, { token, body, key });
    } catch (e) {
      last = e as CliError;
      unknown = true;
      continue;
    }
    if (r.status >= 200 && r.status < 300) return r.body as T;
    last = refused(r, what);
    unknown = r.status >= 500;
    if (!(r.body as Partial<ApiError> | null)?.retryable) break;
  }
  if (!unknown) throw last!;
  const message = `${last!.message}\nThe ${what.replace(/^the /, '')} may have been recorded. Run the command again with --key ${key} so as not to duplicate it.`;
  if (ctx.values.json) ctx.io.log(JSON.stringify({ outcome: 'uncertain', idempotencyKey: key, message: last!.message }, null, 2));
  throw new CliError(message);
}

function agentName(values: Values, env: Io['env']): string | null {
  const name = values.agent ?? detectAgent(env);
  if (name !== null && !deviceStartSchema.shape.agent.safeParse(name).success) throw usage(`--agent ${JSON.stringify(name)}: 1 to 32 printable characters, e.g. Claude or Codex`);
  return name?.trim() ?? null;
}

/** Agent à l'usage : `--agent`, sinon l'environnement, sinon l'unique jeton rangé pour ce service et ce projet. */
function pickToken(ctx: Ctx): StoredToken {
  const slot = { service: ctx.config.service, projectId: ctx.config.project };
  const mine = readTokens(ctx.io.env).filter((t) => t.service === slot.service && t.projectId === slot.projectId);
  const name = agentName(ctx.values, ctx.io.env);
  if (name) {
    const t = mine.find((x) => sameSlot(x, { ...slot, agent: name }));
    if (!t) throw usage(`no ${name} login for project ${slot.projectId} on ${slot.service}: run ${LOGIN} --agent ${name}`);
    return t;
  }
  if (mine.length === 1) return mine[0]!;
  if (!mine.length) throw usage(`not logged in for project ${slot.projectId} on ${slot.service}: run ${LOGIN} --agent <name>`);
  throw usage(`several agents are logged in for project ${slot.projectId} (${mine.map((t) => t.agent).join(', ')}): pass --agent`);
}

/** Clé de revue : `--review`, `--pr` rendu par le gabarit `review` du yaml, sinon la pull request de la branche courante lue par `gh`. */
async function reviewKey(ctx: Ctx): Promise<string> {
  const { pr, review } = ctx.values;
  if (pr !== undefined && review !== undefined) throw usage('pass --pr or --review, not both');
  if (review !== undefined) {
    if (!stableId.safeParse(review).success) throw usage(`--review ${JSON.stringify(review)}: lowercase letters, digits and dashes`);
    return review;
  }
  let n = pr === undefined ? NaN : Number(pr);
  if (pr !== undefined && !(Number.isInteger(n) && n > 0)) throw usage(`--pr ${JSON.stringify(pr)}: a pull request number`);
  if (pr === undefined) {
    try {
      const { stdout } = await run('gh', ['pr', 'view', '--json', 'number', '--jq', '.number'], { cwd: ctx.io.cwd, env: ctx.io.env as NodeJS.ProcessEnv, timeout: 20_000 });
      n = Number(stdout.trim());
    } catch (e) {
      const why = (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'gh is not installed' : ((e as { stderr?: string }).stderr?.trim() || (e as Error).message);
      throw usage(`no --pr nor --review, and the pull request of the current branch could not be read with gh (${why}): pass --pr <number> or --review <key>`);
    }
    if (!(Number.isInteger(n) && n > 0)) throw usage('gh returned no pull request number for the current branch: pass --pr <number> or --review <key>');
  }
  return renderReviewKey(ctx.config.review, n);
}

async function text(ctx: Ctx, value: string | undefined, what: string): Promise<string> {
  if (value === undefined) throw usage(`${what} is required`);
  const body = value === '-' ? await (ctx.io.stdin ?? (async () => ''))() : value;
  if (!body.trim()) throw usage(`${what} is empty`);
  return body.trim();
}

/** `--commit` explicite (abrégé, complet ou référence Git), sinon HEAD dans un dépôt Git, rien avec `--no-commit` ou hors dépôt. */
async function commitOf(ctx: Ctx): Promise<string | null> {
  const { commit, 'no-commit': none } = ctx.values;
  if (none && commit !== undefined) throw usage('pass --commit or --no-commit, not both');
  if (none) return null;
  const wanted = commit?.toLowerCase();
  if (wanted !== undefined && commitShaSchema.safeParse(wanted).success) return wanted;
  try {
    const { stdout } = await run('git', ['rev-parse', '--verify', '--quiet', `${commit ?? 'HEAD'}^{commit}`], { cwd: ctx.io.cwd, timeout: 10_000 });
    return stdout.trim();
  } catch {
    if (commit !== undefined) throw usage(`--commit ${JSON.stringify(commit)}: neither a hexadecimal sha (7 to 40 characters) nor a commit of this repository`);
    return null;
  }
}

const base = (ctx: Ctx, review: string) => `/v1/projects/${encodeURIComponent(ctx.config.project)}/reviews/${encodeURIComponent(review)}`;
const short = (iso: string) => `${iso.slice(0, 16).replace('T', ' ')} UTC`;
const line = (t: string) => t.replace(/\s+/g, ' ').trim();
const cut = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/** Live state of a fix, as in the panel: "live since …" once a deployment carries the commit, "waiting" only while no deployment followed the resolution. */
function liveNote(t: NonNullable<Message['transition']>): string {
  return t.liveSince ? ` · live since ${short(t.liveSince)}` : t.liveState === 'pending' ? ' · waiting for the next preview' : '';
}

/** Same wording as the panel, without deployment id: "fixed in abc1234 · live since …" when an agent gave a commit, otherwise "resolved" or "reopened"; the author and agent are already on the line. */
function describeTransition(m: Message): string {
  const t = m.transition!;
  if (t.state === 'open') return 'reopened';
  return m.via && t.commit ? `fixed in ${t.commit.slice(0, 7)}${liveNote(t)}` : 'resolved';
}

function describeMessage(m: Message): string {
  const who = m.via ? `${m.via} via ${m.author.displayName}` : m.author.displayName;
  return `${who}${m.transition ? ` · ${describeTransition(m)}` : ''} · ${short(m.createdAt)}`;
}

async function login(ctx: Ctx): Promise<void> {
  const agent = agentName(ctx.values, ctx.io.env);
  if (!agent) throw usage('which agent? pass --agent <name> (e.g. Claude or Codex); it is detected inside Claude Code and Codex');
  const machine = cut(line(hostname()).replace(/\p{C}/gu, ''), 64) || 'unknown';
  const started = await expect<DeviceStart>(ctx, 'the login', 'POST', '/v1/auth/device', { body: { projectId: ctx.config.project, agent, machine } });
  secrets.add(started.deviceCode);
  const sink = ctx.values.json ? (ctx.io.warn ?? (() => {})) : ctx.io.log;
  const say = (t: string) => sink(printable(t));
  say(`To let ${agent} read, reply and resolve on your behalf on project ${ctx.config.project} (${ctx.config.service}):`);
  say('  1. open a Socrate preview of this project where you are signed in;');
  say('  2. in the Socrate toolbar, choose "Plus d’options", then "Connecter un agent";');
  say(`  3. enter the code ${started.userCode} and approve.`);
  say(`Only approve if you just ran this command. The code expires in ${Math.round(started.expiresIn / 60)} minutes.`);
  let interval = started.interval;
  const deadline = Date.now() + started.expiresIn * 1000;
  let grant: AgentGrant | null = null;
  while (!grant) {
    if (Date.now() > deadline) throw new CliError(`the code expired before approval: run ${LOGIN} again`);
    await sleep(interval * 1000);
    let r: Reply;
    try {
      r = await request(ctx, 'POST', '/v1/auth/device/token', { body: { deviceCode: started.deviceCode } });
    } catch {
      continue;
    }
    const code = (r.body as Partial<ApiError> | null)?.code;
    if (r.status === 200) grant = r.body as AgentGrant;
    else if (code === 'slow_down') interval += 5;
    else if (code !== 'authorization_pending') throw refused(r, 'the login');
  }
  secrets.add(grant.accessToken);
  const entry: StoredToken = {
    service: ctx.config.service, projectId: grant.projectId, agent: grant.agent, tokenId: grant.tokenId, token: grant.accessToken, machine: grant.machine,
    actor: grant.actor, capabilities: grant.capabilities, expiresAt: grant.expiresAt,
  };
  const all = readTokens(ctx.io.env);
  const previous = all.find((t) => sameSlot(t, entry));
  const file = writeTokens(ctx.io.env, [...all.filter((t) => !sameSlot(t, entry)), entry]);
  // L'ancien jeton du même agent ne sert plus : révoqué au mieux, sans bloquer la connexion.
  if (previous) await request(ctx, 'POST', '/v1/auth/agent/revoke', { token: previous.token }).catch(() => undefined);
  const { token: _, ...shown } = entry;
  ctx.out(`logged in: ${agent} acts as ${grant.actor.displayName} on project ${grant.projectId} until ${grant.expiresAt.slice(0, 10)} (${grant.capabilities.join(', ')}); token stored in ${file}`, { ...shown, credentials: file });
}

async function logout(ctx: Ctx): Promise<void> {
  const t = pickToken(ctx);
  const r = await request(ctx, 'POST', '/v1/auth/agent/revoke', { token: t.token });
  if (r.status !== 200 && r.status !== 401) throw refused(r, 'the logout');
  writeTokens(ctx.io.env, readTokens(ctx.io.env).filter((x) => !sameSlot(x, t)));
  ctx.out(`logged out: ${t.agent} token for project ${t.projectId} ${r.status === 200 ? 'revoked' : 'was already revoked or expired'} and removed from ${credentialsPath(ctx.io.env)}`, { agent: t.agent, projectId: t.projectId, tokenId: t.tokenId, revoked: true });
}

async function threads(ctx: Ctx): Promise<void> {
  const t = pickToken(ctx);
  const review = await reviewKey(ctx);
  const forAgent = ctx.values['for-agent'] ?? false;
  if (forAgent && ctx.values.state !== undefined) throw usage('pass --for-agent or --state, not both');
  const state = ctx.values.state ?? 'open';
  if (!['open', 'resolved', 'all'].includes(state)) throw usage(`--state ${JSON.stringify(state)}: open, resolved or all`);
  const read: ThreadWithMessages[] = [];
  let query = `?limit=100${state === 'all' ? '' : `&state=${state}`}`;
  for (;;) {
    const page = await expect<ThreadPage>(ctx, 'the thread list', 'GET', `${base(ctx, review)}/threads${query}`, { token: t.token });
    read.push(...page.items);
    if (!page.nextCursor) break;
    query = `?limit=100&cursor=${encodeURIComponent(page.nextCursor)}`;
  }
  // Seules les consignes de la personne connectée : le texte d'un relecteur n'est jamais une demande adressée à son agent.
  const handoffs = new Map(read.map((th) => [th.threadId, handoffOf(th.messages, t.actor.key)]));
  const items = forAgent ? read.filter((th) => handoffs.get(th.threadId)?.state === 'pending') : read;
  const human = [`review ${review}: ${items.length} ${forAgent ? 'thread' : state === 'all' ? 'thread' : `${state} thread`}${items.length === 1 ? '' : 's'}${forAgent ? ' for this agent' : ''}`];
  for (const th of items) {
    const first = th.messages[0];
    const where = th.target ? th.target.route : 'general';
    const replies = th.messages.length - 1;
    const pieces = th.messages.reduce((n, m) => n + m.attachments.length, 0);
    human.push(`${th.threadId}  ${th.state}  ${th.author.displayName} · ${short(th.createdAt)} · ${where}${replies ? ` · ${replies} repl${replies > 1 ? 'ies' : 'y'}` : ''}${pieces ? ` · ${pieces} attachment${pieces > 1 ? 's' : ''}` : ''}`);
    human.push(`  ${cut(line(th.proposal ? `proposal: « ${th.proposal.original} » → « ${th.proposal.replacement} »` : first?.body || '(attachments only)'), 160)}`);
    const handoff = handoffs.get(th.threadId);
    if (forAgent && handoff) human.push(`  to do (message ${handoff.seq}): ${cut(line(handoff.body), 160)}`);
  }
  ctx.out(human.join('\n'), { projectId: ctx.config.project, reviewKey: review, state: forAgent ? 'for-agent' : state, threads: items.map((th) => ({ ...th, handoff: handoffs.get(th.threadId) ?? null })) });
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function thread(ctx: Ctx, id: string | undefined): Promise<void> {
  if (!id) throw usage('socrate thread <id>');
  const t = pickToken(ctx);
  const review = await reviewKey(ctx);
  const path = `${base(ctx, review)}`;
  const th = await expect<ThreadWithMessages>(ctx, 'the thread', 'GET', `${path}/threads/${encodeURIComponent(id)}`, { token: t.token });
  const files: { capture?: string; attachments: Record<string, string> } = { attachments: {} };
  if (ctx.values.captures !== undefined) {
    const dir = resolve(ctx.io.cwd, ctx.values.captures);
    mkdirSync(dir, { recursive: true });
    const save = async (url: string, expected: string, name: string) => {
      const r = await request(ctx, 'GET', url, { token: t.token });
      if (r.status !== 200) throw refused(r, `the download of ${name}`);
      if (sha256(r.bytes) !== expected) throw new CliError(`${name}: downloaded bytes do not match the announced sha256`);
      const file = join(dir, name);
      writeFileSync(file, r.bytes);
      return file;
    };
    if (th.capture) files.capture = await save(`${path}/captures/${encodeURIComponent(th.capture.captureId)}`, th.capture.sha256, `${th.threadId}-capture.png`);
    for (const m of th.messages) {
      for (const a of m.attachments) {
        files.attachments[a.attachmentId] = await save(`${path}/attachments/${encodeURIComponent(a.attachmentId)}`, a.sha256, `${th.threadId}-${a.attachmentId}-${basename(a.name).replace(/^\.+/, '_')}`);
      }
    }
  }
  const human = [`thread ${th.threadId} · ${th.state} · ${th.kind} · version ${th.version} · by ${th.author.displayName} · ${short(th.createdAt)}`];
  if (th.target) {
    human.push(`route: ${th.target.route}${th.target.hostRoute ? ` (host route ${th.target.hostRoute})` : ''}`);
    human.push(`target: ${th.target.role || 'element'} « ${cut(line(th.target.text), 200)} » · selector ${th.target.selector}`);
    human.push(`html: ${th.target.html}`);
  }
  if (th.capture) human.push(`capture: ${th.capture.width}×${th.capture.height}${files.capture ? ` → ${files.capture}` : ' (--captures <dir> to download)'}`);
  if (th.proposal) human.push(`proposal: « ${th.proposal.original} » → « ${th.proposal.replacement} »${th.proposal.drift ? ` (wording ${th.proposal.drift.status})` : ''}`);
  for (const m of th.messages) {
    human.push(`[${m.seq}] ${describeMessage(m)}`);
    if (m.body) human.push(...m.body.split('\n').map((l) => `    ${l}`));
    for (const a of m.attachments) human.push(`    attachment ${a.name} (${a.contentType}, ${a.size} bytes)${files.attachments[a.attachmentId] ? ` → ${files.attachments[a.attachmentId]}` : ''}`);
  }
  ctx.out(human.join('\n'), ctx.values.captures !== undefined ? { ...th, files } : th);
}

/** `--after <seq>` : une personne a écrit après la consigne lue, le travail repart de la conversation au lieu d'y répondre à côté. */
async function checkAfter(ctx: Ctx, token: string, review: string, id: string): Promise<void> {
  if (ctx.values.after === undefined) return;
  const after = Number(ctx.values.after);
  if (!Number.isInteger(after) || after < 0) throw usage(`--after ${JSON.stringify(ctx.values.after)}: a message number`);
  const th = await expect<ThreadWithMessages>(ctx, 'the thread', 'GET', `${base(ctx, review)}/threads/${encodeURIComponent(id)}`, { token });
  const newer = th.messages.find((m) => m.seq > after && !m.via);
  if (newer) throw new CliError(printable(`${newer.author.displayName} wrote message ${newer.seq} after message ${after}: read the thread again, nothing was written`));
}

type Piece = AttachmentMeta & { data: Uint8Array };

/** Images locales à joindre, reconnues à leurs octets et non à leur extension : une consigne lue dans un fil ne fait jamais sortir un fichier quelconque. */
function readPieces(ctx: Ctx): Piece[] {
  const files = ctx.values.attach ?? [];
  if (files.length > MAX_ATTACHMENTS) throw usage(`--attach: ${MAX_ATTACHMENTS} images at most`);
  return files.map((file) => {
    let data: Uint8Array;
    try {
      data = readFileSync(resolve(ctx.io.cwd, file));
    } catch (e) {
      throw new CliError(`--attach ${file}: ${(e as Error).message}`);
    }
    const contentType = (['image/png', 'image/jpeg', 'image/webp'] as const).find((t) => signatureMatches(t, data.subarray(0, SIGNATURE_BYTES)));
    if (!contentType) throw new CliError(`--attach ${file}: not a PNG, JPEG or WebP image`);
    if (data.length > ATTACHMENT_TYPES[contentType].maxBytes) throw new CliError(`--attach ${file}: larger than the ${ATTACHMENT_TYPES[contentType].maxBytes} bytes allowed`);
    return { name: safeName(basename(file)) || 'capture', contentType, size: data.length, sha256: sha256(data), data };
  });
}

/** Réservation et téléversement sous la clé de la réponse : relancer avec `--key` reprend les pièces déjà reçues sans doublon. */
async function upload(ctx: Ctx, token: string, review: string, key: string, pieces: Piece[]): Promise<AttachmentMeta[]> {
  const metas = pieces.map(({ data: _, ...meta }) => meta);
  const reserved = await request(ctx, 'POST', `${base(ctx, review)}/attachments`, { token, key, body: { operation: 'message.create', attachments: metas } });
  if (reserved.status !== 201) throw refused(reserved, 'the attachments');
  const { items } = reserved.body as AttachmentReservation;
  for (const [i, item] of items.entries()) {
    if (item.uploaded) continue;
    const put = await request(ctx, 'PUT', `${base(ctx, review)}/attachments/${encodeURIComponent(item.attachmentId)}`, { token, bytes: { data: pieces[i]!.data, type: pieces[i]!.contentType } });
    if (put.status !== 200) throw refused(put, `the upload of ${pieces[i]!.name}`);
  }
  return metas;
}

async function reply(ctx: Ctx, id: string | undefined, value: string | undefined): Promise<void> {
  if (!id) throw usage('socrate reply <id> <message | ->');
  const t = pickToken(ctx);
  const pieces = readPieces(ctx);
  const body = await text(ctx, value, 'the message');
  const review = await reviewKey(ctx);
  await checkAfter(ctx, t.token, review, id);
  const key = ctx.values.key ?? `socrate-cli-${randomUUID()}`;
  const send = async () => {
    const attachments = pieces.length ? await upload(ctx, t.token, review, key, pieces) : undefined;
    return write<Message>(ctx, 'the reply', `${base(ctx, review)}/threads/${encodeURIComponent(id)}/messages`, t.token, { body, ...(attachments && { attachments }) }, key);
  };
  // Une réservation expirée entre l'envoi et la publication reprend toute la séquence, une fois, sous la même clé.
  const m = await send().catch((e: Error) => { if (pieces.length && e.message.includes('attachment_missing')) return send(); throw e; });
  ctx.out(`replied to ${id} as ${m.author.displayName} via ${m.via}`, m);
}

async function transition(ctx: Ctx, id: string | undefined, state: 'resolve' | 'reopen'): Promise<void> {
  if (!id) throw usage(`socrate ${state} <id> --message <text | ->`);
  const t = pickToken(ctx);
  const message = await text(ctx, ctx.values.message, '--message');
  if (state === 'reopen' && (ctx.values.commit !== undefined || ctx.values['no-commit'])) throw usage('reopen takes no commit');
  const commit = state === 'resolve' ? await commitOf(ctx) : null;
  const review = await reviewKey(ctx);
  await checkAfter(ctx, t.token, review, id);
  const m = await write<Message>(ctx, `the ${state === 'resolve' ? 'resolution' : 'reopening'}`, `${base(ctx, review)}/threads/${encodeURIComponent(id)}/${state}`, t.token, { message, ...(commit && { commit }) }).catch((e: Error) => {
    // Un refus de droits sur le fil d'une autre personne dit quoi faire, sans relancer de connexion à l'aveugle.
    if (!/ 403 /.test(e.message) || t.capabilities.includes('thread.moderate')) throw e;
    throw new CliError(printable(`${e.message}\n${t.agent} can only ${state} threads of ${t.actor.displayName}. If you may moderate this project, open Socrate in a preview, choose "Plus d’options", "Connecter un agent", then "Mettre à jour" next to ${t.agent}, and run the command again.`));
  });
  ctx.out(`${state === 'resolve' ? 'resolved' : 'reopened'} ${id} as ${m.author.displayName} via ${m.via}${m.transition?.commit ? ` in ${m.transition.commit.slice(0, 7)}${liveNote(m.transition)}` : ''}`, m);
}

export async function runAgent(command: string, argv: string[], io: Io): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, strict: true, options: OPTIONS });
  const config = loadConfig(io.cwd, values.config);
  const out = (human: string, json: unknown) => io.log(values.json ? JSON.stringify(json, null, 2) : printable(human));
  const ctx: Ctx = { io, config, values, out };
  const [id, extra, ...rest] = positionals;
  const max = command === 'reply' ? 2 : ['thread', 'resolve', 'reopen'].includes(command) ? 1 : 0;
  if (positionals.length > max || rest.length) throw usage(`unexpected argument ${JSON.stringify(positionals[max])}`);
  if (values.key !== undefined && !['reply', 'resolve', 'reopen'].includes(command)) throw usage(`${command} takes no --key`);
  if (values['for-agent'] && command !== 'threads') throw usage(`${command} takes no --for-agent`);
  if (values.attach !== undefined && command !== 'reply') throw usage(`${command} takes no --attach`);
  if (values.after !== undefined && !['reply', 'resolve', 'reopen'].includes(command)) throw usage(`${command} takes no --after`);
  if (values.key !== undefined && !KEY_PATTERN.test(values.key)) throw usage(`--key ${JSON.stringify(values.key)}: 8 to 128 letters, digits, dashes or underscores`);
  if (command === 'login') return login(ctx);
  if (command === 'logout') return logout(ctx);
  if (command === 'threads') return threads(ctx);
  if (command === 'thread') return thread(ctx, id);
  if (command === 'reply') return reply(ctx, id, extra);
  return transition(ctx, id, command === 'resolve' ? 'resolve' : 'reopen');
}
