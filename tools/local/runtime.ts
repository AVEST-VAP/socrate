import { Miniflare, type MiniflareOptions } from 'miniflare';
type D1Database = Awaited<ReturnType<Miniflare['getD1Database']>>;
import { DatabaseSync } from 'node:sqlite';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, lstatSync, mkdirSync, openSync, readFileSync, type Stats } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { assembleManifest } from '@socrate/contract/assemble';
import { issuesOf, randomToken, serviceConfigSchema, tokenHash, type Capability, type MigrationRef } from '@socrate/contract';
import { assetsDirOf, buildWorker, WORKER_BUNDLE } from './build-worker.ts';
export { buildWorker, WORKER_BUNDLE };
import {
  allowPort, deadlineIn, guardedPath, guardedTree, localFetch, localPath, remaining, sleep, tcpProbe, LocalRefusal, REPO_ROOT,
  type Check, type Deadline, type InstanceView, type LocalReport, type Ports, type StopReport,
} from './local-run.ts';

export { REPO_ROOT };
export const MIGRATIONS_DIR = localPath('apps/service/migrations');
export const SERVICE_AUDIENCE = 'socrate';
export const PROJECT = 'demo';
export const ISSUER = 'demo-host';

export type ProjectSetup = { projectId: string; issuer: string; publicJwk: JsonWebKey; attestableCapabilities: Capability[]; allowedOrigin?: string };
export type Migration = MigrationRef & { sql: string };
export type MigrationReport = { applied: string[]; skipped: string[] };

export class SchemaIncompatible extends Error {}

function splitStatements(sql: string): string[] {
  return sql.split(/;\s*\n/).map((s) => s.trim()).filter((s) => s.length > 0);
}

export async function listMigrations(dir = MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const out: Migration[] = [];
  for (const id of files) {
    const sql = await readFile(join(dir, id), 'utf8');
    out.push({ id, checksum: createHash('sha256').update(sql).digest('hex'), sql });
  }
  return out;
}

export const SCHEMA_MIGRATIONS_TABLE = 'CREATE TABLE IF NOT EXISTS schema_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)';

/** Migrations restant à appliquer après le préfixe déjà enregistré, refusé s'il diverge du build. */
export function pendingMigrations(applied: MigrationRef[], expected: Migration[]): Migration[] {
  applied.forEach((row, i) => {
    const m = expected[i];
    if (!m) throw new SchemaIncompatible(`base plus récente que le build : migration ${row.id} inconnue du build, aucune réinitialisation automatique`);
    if (row.id !== m.id) throw new SchemaIncompatible(`liste des migrations incompatible : ${row.id} appliquée là où le build attend ${m.id}, aucune réinitialisation automatique`);
    if (row.checksum !== m.checksum) throw new SchemaIncompatible(`migration ${m.id} modifiée après application (checksum ${row.checksum.slice(0, 12)} ≠ ${m.checksum.slice(0, 12)}), aucune réinitialisation automatique`);
  });
  return expected.slice(applied.length);
}

export async function applyMigrations(db: D1Database, dir = MIGRATIONS_DIR): Promise<MigrationReport> {
  await db.exec(SCHEMA_MIGRATIONS_TABLE);
  const expected = await listMigrations(dir);
  const applied = (await db.prepare('SELECT id, checksum FROM schema_migrations ORDER BY id').all<{ id: string; checksum: string }>()).results;
  const pending = pendingMigrations(applied, expected);
  const report: MigrationReport = { applied: [], skipped: applied.map((r) => r.id) };
  for (const m of pending) {
    const statements = splitStatements(m.sql).map((s) => db.prepare(s));
    statements.push(db.prepare('INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)').bind(m.id, m.checksum, new Date().toISOString()));
    await db.batch(statements);
    report.applied.push(m.id);
  }
  return report;
}

export type RootClaim = { root: string; lockPath: string; release(): void };
export const lockPathOf = (root: string) => `${root}.lock.db`;
export const recordPathOf = (root: string) => `${root}.owner.json`;

export function claimRoot(root: string): RootClaim | 'busy' {
  const lockPath = guardedPath(lockPathOf(guardedPath(root)));
  mkdirSync(dirname(lockPath), { recursive: true });
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(lockPath, { timeout: 0 });
    db.exec('PRAGMA journal_mode = DELETE');
    db.exec('BEGIN EXCLUSIVE');
  } catch (e) {
    db?.close();
    const err = e as Error & { errcode?: number };
    if (err.errcode === 5 || /database is locked/.test(err.message)) return 'busy';
    throw new LocalRefusal('lock_unreadable', `verrou ${lockPath} inutilisable (${err.message}) : fichier conservé tel quel, aucune reprise automatique`);
  }
  const handle = db;
  return {
    root,
    lockPath,
    release() {
      try {
        handle.exec('ROLLBACK');
      } catch {}
      handle.close();
    },
  };
}

export type ResourcePhase = 'creating' | 'running' | 'closed';
export type OwnerRecord = {
  generation: string;
  pid: number;
  startedAt: string;
  state: 'claimed' | 'starting' | 'ready' | 'stopping' | 'closed' | 'failed';
  ports: Ports;
  instanceId?: string;
  build?: string;
  persist?: { path: string; dev: number; ino: number };
  control?: { port: number; nonce: string };
  resources: Partial<Record<'service' | 'host' | 'host-b' | 'control', { phase: ResourcePhase; port: number }>>;
};

export async function readRecord(root: string): Promise<OwnerRecord | null | 'unreadable'> {
  const path = guardedPath(recordPathOf(root));
  if (!existsSync(path)) return null;
  try {
    const rec = JSON.parse(await readFile(path, 'utf8')) as OwnerRecord;
    if (typeof rec.generation !== 'string' || typeof rec.resources !== 'object' || rec.resources === null) return 'unreadable';
    return rec;
  } catch {
    return 'unreadable';
  }
}

export async function writePrivateFile(path: string, content: string): Promise<void> {
  const target = guardedPath(path);
  await mkdir(dirname(target), { recursive: true });
  const tmp = `${target}.${process.pid}.${crypto.randomUUID().slice(0, 8)}.tmp`;
  await writeFile(tmp, content, { mode: 0o600 });
  try {
    await rename(tmp, target);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

export const publishRecord = (root: string, rec: OwnerRecord) => writePrivateFile(recordPathOf(root), JSON.stringify(rec, null, 1));

export function openResources(rec: OwnerRecord | null | 'unreadable'): string[] {
  if (rec === null) return [];
  if (rec === 'unreadable') return ['enregistrement de possession illisible'];
  return Object.entries(rec.resources).filter(([, r]) => r.phase !== 'closed').map(([name, r]) => `${name} en phase ${r.phase} sur le port ${r.port}`);
}

export function bundleDigest(path = WORKER_BUNDLE): string {
  return createHash('sha256').update(readFileSync(guardedPath(path))).digest('hex');
}

export function serviceConfig(projects: ProjectSetup[], archiveRetentionDays?: number) {
  const config = serviceConfigSchema.safeParse({
    archiveRetentionDays,
    audience: SERVICE_AUDIENCE,
    assertionMaxAgeSeconds: 60,
    clockSkewSeconds: 30,
    sessionTtlSeconds: 300,
    projects: Object.fromEntries(projects.map((p) => [p.projectId, { issuer: p.issuer, publicJwk: p.publicJwk, attestableCapabilities: p.attestableCapabilities, allowedOrigin: p.allowedOrigin }])),
  });
  if (!config.success) throw new Error(`configuration du service refusée : ${issuesOf(config.error).map((i) => `${i.path} ${i.message}`).join(' ; ')}`);
  return config.data;
}

export type EgressAttempt = { url: string; method: string };

export function miniflareOptions(input: { scriptPath: string; persistRoot: string; port: number; bindings: Record<string, string>; egress: EgressAttempt[]; assets?: string }): MiniflareOptions {
  return {
    // Équivalent local de `assets.run_worker_first` : le Worker sert chaque fichier client avec ses en-têtes.
    ...(input.assets ? { assets: { directory: input.assets, binding: 'ASSETS', routerConfig: { invoke_user_worker_ahead_of_assets: true, has_user_worker: true } } } : {}),
    name: 'socrate-service',
    scriptPath: input.scriptPath,
    modules: true,
    compatibilityDate: '2026-07-01',
    host: '127.0.0.1',
    port: input.port,
    cf: false,
    liveReload: false,
    d1Databases: { DB: 'socrate' },
    r2Buckets: { CAPTURES: 'socrate-captures' },
    defaultPersistRoot: input.persistRoot,
    bindings: input.bindings,
    outboundService: (req: Request) => {
      input.egress.push({ url: req.url, method: req.method });
      return new Response('sortie réseau refusée par le banc local Socrate', { status: 403 });
    },
  };
}

export function startMiniflare(options: MiniflareOptions): Miniflare {
  const before = { int: process.listeners('SIGINT'), term: process.listeners('SIGTERM') };
  const mf = new Miniflare(options);
  for (const l of process.listeners('SIGINT')) if (!before.int.includes(l)) process.removeListener('SIGINT', l);
  for (const l of process.listeners('SIGTERM')) if (!before.term.includes(l)) process.removeListener('SIGTERM', l);
  return mf;
}

export type ServiceInstance = {
  url: string;
  port: number;
  root: string;
  instanceId: string;
  build: string;
  persistRoot: string;
  db: D1Database;
  mf: Miniflare;
  egress: EgressAttempt[];
  stop(): Promise<void>;
};

export type StartServiceOptions = {
  root: string;
  port?: number;
  projects: ProjectSetup[];
  bundlePath?: string;
  rebuild?: boolean;
  migrationsDir?: string;
  migrate?: boolean;
  instanceId?: string;
  creating?: () => Promise<void>;
  own?: (close: () => Promise<void>) => void;
  cancel?: AbortSignal;
  archiveRetentionDays?: number;
  /** Réservé à `maintenance.ts` : le Worker refuse toute route hors santé, seules les liaisons D1 et R2 du processus servent. */
  maintenance?: true;
};

/** Une restauration commencée mais non terminée ne démarre jamais comme instance ordinaire ni comme source d'une autre opération. */
async function refuseIncompleteRestore(db: D1Database): Promise<void> {
  // Une base arrêtée avant 0006 (preuves de migration) n'a pas de table de restauration.
  if (!(await db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'restorations'").first())) return;
  const r = await db.prepare("SELECT started_at, backup_created_at, manifest_sha256 FROM restorations WHERE state = 'in_progress' LIMIT 1")
    .first<{ started_at: string; backup_created_at: string; manifest_sha256: string }>();
  if (r) throw new LocalRefusal('restore_incomplete', `restauration incomplète commencée le ${r.started_at} (sauvegarde du ${r.backup_created_at}, manifeste ${r.manifest_sha256}) : instance non démarrée, aucun accès émis ; conserver cette racine pour examen et restaurer vers une nouvelle instance vierge`);
}

export async function startService(opts: StartServiceOptions): Promise<ServiceInstance> {
  const bundlePath = guardedPath(opts.bundlePath ?? WORKER_BUNDLE);
  const assetsDir = guardedPath(assetsDirOf(bundlePath));
  if (opts.rebuild || !existsSync(bundlePath) || !existsSync(assetsDir)) await buildWorker(bundlePath);
  const assets = guardedTree(assetsDir).path;
  const config = serviceConfig(opts.projects, opts.archiveRetentionDays);
  const migrationsDir = opts.migrationsDir ?? MIGRATIONS_DIR;
  const schema: MigrationRef[] = (await listMigrations(migrationsDir)).map(({ id, checksum }) => ({ id, checksum }));
  const instanceId = opts.instanceId ?? crypto.randomUUID();
  const build = bundleDigest(bundlePath);
  const persistRoot = guardedTree(join(opts.root, 'persist')).path;
  const egress: EgressAttempt[] = [];
  opts.cancel?.throwIfAborted();
  await opts.creating?.();
  const mf = startMiniflare(miniflareOptions({
    scriptPath: bundlePath, persistRoot, port: opts.port ?? 0, egress, assets,
    bindings: { SOCRATE_CONFIG: JSON.stringify(config), SOCRATE_SCHEMA: JSON.stringify(schema), SOCRATE_INSTANCE: JSON.stringify({ instanceId, build }), ...(opts.maintenance ? { SOCRATE_MAINTENANCE: 'exclusive' } : {}) },
  }));
  let revoke: (() => void) | undefined;
  const close = async () => {
    try {
      await mf.dispose();
    } finally {
      revoke?.();
    }
  };
  opts.own?.(close);
  let url: URL;
  let db: D1Database;
  try {
    url = await mf.ready;
    revoke = allowPort(Number(url.port));
    opts.cancel?.throwIfAborted();
    db = await mf.getD1Database('DB');
    opts.cancel?.throwIfAborted();
    if (opts.migrate !== false) {
      await applyMigrations(db, migrationsDir);
      await refuseIncompleteRestore(db);
    }
  } catch (e) {
    if (!opts.own) {
      const disposal = await close().then(() => null, (d: Error) => d);
      if (disposal) throw new Error(`${(e as Error).message} ; fermeture Miniflare échouée : ${disposal.message}`, { cause: e });
    }
    throw e;
  }
  return { url: url.origin, port: Number(url.port), root: opts.root, instanceId, build, persistRoot, db, mf, egress, stop: close };
}

export async function generateIssuerKeys(): Promise<{ privateJwk: JsonWebKey; publicJwk: JsonWebKey }> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return { privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey), publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey) };
}

export type CredentialSpec = { projectId: string; label: string; capabilities: Capability[]; ttlSeconds?: number };
const DEFAULT_CREDENTIAL_TTL = 86_400;
const CREDENTIAL_MARGIN_SECONDS = 600;

export async function provisionCredential(db: D1Database, input: CredentialSpec): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = Math.floor(now / 1000) + (input.ttlSeconds ?? DEFAULT_CREDENTIAL_TTL);
  await db.prepare('INSERT INTO technical_credentials (credential_id, token_hash, project_id, label, capabilities, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(crypto.randomUUID(), await tokenHash(token), input.projectId, input.label, JSON.stringify([...input.capabilities].sort()), expiresAt, createdAt)
    .run();
  return token;
}

type CredentialRow = { project_id: string; label: string; capabilities: string; expires_at: number; created_at: string };

async function credentialMatches(db: D1Database, token: string, spec: CredentialSpec): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return 'fichier partiel ou illisible';
  const row = await db.prepare('SELECT project_id, label, capabilities, expires_at, created_at FROM technical_credentials WHERE token_hash = ?').bind(await tokenHash(token)).first<CredentialRow>();
  if (!row) return 'accès inconnu de la base';
  if (row.project_id !== spec.projectId) return `projet ${row.project_id} au lieu de ${spec.projectId}`;
  if (row.label !== spec.label) return `libellé ${row.label} au lieu de ${spec.label}`;
  const stored = JSON.stringify(JSON.parse(row.capabilities).sort());
  const wanted = JSON.stringify([...spec.capabilities].sort());
  if (stored !== wanted) return `capacités ${stored} au lieu de ${wanted}`;
  const ttl = spec.ttlSeconds ?? DEFAULT_CREDENTIAL_TTL;
  if (row.expires_at - Math.floor(Date.parse(row.created_at) / 1000) !== ttl) return `durée ${row.expires_at - Math.floor(Date.parse(row.created_at) / 1000)} s au lieu de ${ttl} s`;
  if (row.expires_at <= Math.floor(Date.now() / 1000) + CREDENTIAL_MARGIN_SECONDS) return 'accès expiré ou expirant';
  return null;
}

export async function reconcileCredentials(db: D1Database, dir: string, specs: Record<string, CredentialSpec>): Promise<Record<string, { token: string; renewed: boolean; why?: string }>> {
  const out: Record<string, { token: string; renewed: boolean; why?: string }> = {};
  for (const [name, spec] of Object.entries(specs)) {
    const path = guardedPath(join(dir, `${name}.token`));
    const existing = existsSync(path) ? (await readFile(path, 'utf8')).trim() : '';
    const why = existing ? await credentialMatches(db, existing, spec) : 'fichier absent';
    if (why === null) {
      out[name] = { token: existing, renewed: false };
      continue;
    }
    const token = await provisionCredential(db, spec);
    await writePrivateFile(path, token);
    out[name] = { token, renewed: true, why };
  }
  return out;
}

export const instanceRoot = (name: string) => localPath('.local/runtime', name);

const physicalIdentity = (path: string) => {
  const st = lstatSync(path);
  return { path, dev: st.dev, ino: st.ino };
};

export type InstanceHandle = {
  view: InstanceView;
  service: ServiceInstance;
  record: OwnerRecord;
  credentials: { import: string; agent: string };
  stopService(): Promise<void>;
  startService(): Promise<void>;
  stop(reason?: string): Promise<StopReport>;
  /** Import CI d'un déploiement de la même revue, rejouable. */
  importDeployment(deploymentId: string, url: string, manifest: unknown): Promise<{ status: number; json: unknown }>;
  /** Second hôte possédé (déploiement B de la continuité) : fermé par `stop` avec les autres ressources. */
  addHost(input: { deploymentId: string; port: number; scene: 'b'; manifest: unknown; deadline: Deadline }): Promise<{ origin: string; revisionId: string }>;
};

type Resource = 'service' | 'host' | 'host-b' | 'control';
type Closer = () => Promise<void>;

export type LaunchInput = {
  root: string; name: string; ports: Ports; reset: boolean; deadline: Deadline; deploymentId?: string; log?: (line: string) => void; cancel?: AbortSignal;
  hostCommand?: string[];
  own?: (name: Resource, close: Closer) => void;
};

const VITE_COMMAND = () => [localPath('node_modules/vite/bin/vite.js'), '--clearScreen', 'false'];

async function stopChild(child: ChildProcess, deadline: Deadline): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-child.pid!, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {}
    }
  };
  signal('SIGTERM');
  const grace = Math.min(10_000, Math.max(remaining(deadline), 1_000));
  const timeout = (ms: number) => new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), ms));
  if ((await Promise.race([exited, timeout(grace)])) !== 'timeout') return true;
  signal('SIGKILL');
  return (await Promise.race([exited, timeout(5_000)])) !== 'timeout';
}

export async function launchInstance(input: LaunchInput): Promise<InstanceHandle> {
  const log = input.log ?? (() => undefined);
  const root = guardedPath(input.root);
  const hostCommand = input.hostCommand ?? VITE_COMMAND();
  guardedPath(hostCommand[0]!);
  const claim = claimRoot(root);
  if (claim === 'busy') throw new LocalRefusal('occupied', `racine ${root} déjà possédée par une autre instance (verrou ${lockPathOf(root)} tenu)`);
  try {
    const open = openResources(await readRecord(root));
    if (open.length) throw new LocalRefusal('uncertain_resources', `racine ${root} laissée par un propriétaire disparu sans preuve de fermeture (${open.join(' ; ')}) : racine conservée, aucune reprise automatique`);
  } catch (e) {
    claim.release();
    throw e;
  }
  const record: OwnerRecord = { generation: crypto.randomUUID(), pid: process.pid, startedAt: new Date().toISOString(), state: 'claimed', ports: input.ports, resources: {} };
  const owned: Array<{ name: Resource; close: Closer }> = [];
  const own = (name: Resource, close: Closer) => {
    let done: Promise<void> | undefined;
    const once: Closer = () => (done ??= close());
    const i = owned.findIndex((o) => o.name === name);
    if (i >= 0) owned.splice(i, 1);
    owned.push({ name, close: once });
    input.own?.(name, once);
  };
  const disown = (name: Resource) => {
    const i = owned.findIndex((o) => o.name === name);
    if (i >= 0) owned.splice(i, 1);
  };
  const publish = () => publishRecord(root, record);
  const announce = async (name: Resource, phase: ResourcePhase, port: number) => {
    record.resources[name] = { phase, port };
    await publish();
    log(`ressource ${name} : ${phase}`);
  };
  const cancel = new AbortController();
  const checkpoint = () => cancel.signal.throwIfAborted();
  let inFlight: Promise<void> = Promise.resolve();
  const guarded = <T>(work: () => Promise<T>): Promise<T> => {
    const p = work();
    inFlight = p.then(() => undefined, () => undefined);
    return p;
  };
  let stopping: Promise<StopReport> | null = null;
  const undo = async (reason: string): Promise<StopReport> => {
    cancel.abort(new LocalRefusal('launch_cancelled', `lancement interrompu (${reason})`));
    await inFlight;
    const problems: string[] = [];
    const unwritten: string[] = [];
    let published = false;
    try {
      record.state = 'stopping';
      await publish().catch((e) => unwritten.push(`état stopping non écrit (${(e as Error).message})`));
      for (const { name, close } of [...owned].reverse()) {
        try {
          await close();
        } catch (e) {
          problems.push(`${name} non arrêté : ${(e as Error).message}`);
          continue;
        }
        record.resources[name] = { phase: 'closed', port: record.resources[name]?.port ?? 0 };
        await publish().then(
          () => log(`ressource ${name} : closed`),
          (e) => {
            unwritten.push(`fermeture de ${name} non écrite (${(e as Error).message})`);
            log(`ressource ${name} : closed, confirmation non écrite (${(e as Error).message})`);
          },
        );
      }
      const unclosed = openResources(record);
      record.state = unclosed.length ? 'failed' : 'closed';
      await publish().then(() => { published = true; }, (e) => problems.push(`enregistrement final non publié : ${(e as Error).message}`));
      const confirmed = unclosed.length === 0 && problems.length === 0;
      const notes = [...unclosed.map((u) => `${u} sans preuve de fermeture`), ...problems, ...unwritten];
      if (published && unwritten.length) notes.push('enregistrement final écrit avec chaque fermeture observée');
      const detail = confirmed ? `arrêt confirmé (${reason})${notes.length ? ` ; ${notes.join(' ; ')}` : ''}` : `arrêt non confirmé (${reason}) : ${notes.join(' ; ')}`;
      log(detail);
      return { confirmed, detail };
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      claim.release();
    }
  };
  const stop = (reason = 'arrêt demandé'): Promise<StopReport> => (stopping ??= undo(reason));
  const onSignal = () => {
    void stop('signal reçu').then((r) => process.exit(r.confirmed ? 130 : 1));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  input.cancel?.addEventListener('abort', () => void stop('annulation demandée'), { once: true });
  let service!: ServiceInstance;
  const projects: ProjectSetup[] = [];
  const bundlePath = join(root, 'worker.mjs');
  const ownService = (close: Closer) => own('service', close);
  try {
    return await guarded(async () => {
      await publish();
      if (input.reset) await rm(root, { recursive: true, force: true });
      await mkdir(root, { recursive: true });
      record.state = 'starting';
      await publish();
      const keyPath = guardedPath(join(root, 'keys/issuer-private.jwk.json'));
      const pubPath = guardedPath(join(root, 'keys/issuer-public.jwk.json'));
      if (!existsSync(keyPath) || !existsSync(pubPath)) {
        const keys = await generateIssuerKeys();
        await writePrivateFile(keyPath, JSON.stringify(keys.privateJwk));
        await writePrivateFile(pubPath, JSON.stringify(keys.publicJwk));
      }
      const publicJwk = JSON.parse(await readFile(pubPath, 'utf8'));
      projects.push({ projectId: PROJECT, issuer: ISSUER, publicJwk, attestableCapabilities: ['thread.participate', 'thread.moderate'] });
      checkpoint();
      await buildWorker(bundlePath);
      guardedPath(join(root, 'persist'));
      checkpoint();
      service = await startService({ root, port: input.ports.service, projects, bundlePath, creating: () => announce('service', 'creating', input.ports.service), own: ownService, cancel: cancel.signal });
      record.instanceId = service.instanceId;
      record.build = service.build;
      record.persist = physicalIdentity(service.persistRoot);
      await announce('service', 'running', service.port);
      log(`service Socrate : ${service.url} (instance ${service.instanceId}, D1 persisté sous ${service.persistRoot})`);

      checkpoint();
      const credentials = await reconcileCredentials(service.db, join(root, 'credentials'), {
        import: { projectId: PROJECT, label: 'ci-demo', capabilities: ['deployment.import'] },
        agent: { projectId: PROJECT, label: 'agent-demo', capabilities: ['review.read'] },
        archive: { projectId: PROJECT, label: 'archivage-demo', capabilities: ['review.archive'] },
      });
      for (const [name, c] of Object.entries(credentials)) if (c.renewed) log(`accès technique ${name} émis (${c.why})`);

      const assembled = await assembleManifest(localPath('apps/demo/.socrate'));
      if (!assembled.ok) throw new Error(`manifeste de démonstration invalide :\n${assembled.issues.map((i) => `  ${i.file ?? ''} ${i.path} : ${i.message}`).join('\n')}`);
      const demoOrigin = `http://127.0.0.1:${input.ports.demo}`;
      const deploymentId = input.deploymentId ?? 'local-1';
      const importDeployment = (id: string, url: string, manifest: unknown, deadline = input.deadline) => localFetch(`${service.url}/v1/projects/${PROJECT}/reviews/${assembled.manifest.reviewKey}/deployments/${id}`, deadline, {
        method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credentials.import!.token}` },
        body: JSON.stringify({ commit: 'a1b2c3d4e5f6', buildId: id.replace(/\D/g, '') || '1', url, manifest }),
      }, cancel.signal);
      checkpoint();
      const imported = await importDeployment(deploymentId, `${demoOrigin}/`, assembled.manifest);
      const importBody = imported.json as { revisionId?: string; code?: string; message?: string } | null;
      if (imported.status !== 200 && imported.status !== 201) throw new Error(`import refusé : ${imported.status} ${importBody?.code} ${importBody?.message}`);
      log(`import ${imported.status === 201 ? 'créé' : 'rejoué sans effet'} : déploiement ${deploymentId}, révision ${importBody?.revisionId}`);
      await writePrivateFile(join(root, 'preview-context.json'), JSON.stringify({
        serviceUrl: service.url, projectId: PROJECT, reviewKey: assembled.manifest.reviewKey, deploymentId, origin: demoOrigin, issuer: ISSUER, audience: SERVICE_AUDIENCE, instanceId: service.instanceId,
      }));

      const startHost = async (name: Resource, port: number, deadline: Deadline, extraEnv: Record<string, string> = {}) => {
        const origin = `http://127.0.0.1:${port}`;
        checkpoint();
        await announce(name, 'creating', port);
        const revokeDemo = allowPort(port);
        const vite: ChildProcess = spawn(process.execPath, hostCommand, {
          cwd: localPath('apps/demo'), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
          env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TMPDIR: process.env.TMPDIR!, SOCRATE_RUNTIME_DIR: root, SOCRATE_DEMO_PORT: String(port), SOCRATE_PREVIEW_BUILD: 'true', BROWSER: 'none', VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true', ...extraEnv },
        });
        own(name, async () => {
          try {
            if (!(await stopChild(vite, deadlineIn(15_000)))) throw new Error(`hôte (pid ${vite.pid}) non arrêté dans le délai`);
          } finally {
            revokeDemo();
          }
        });
        await announce(name, 'running', port);
        vite.stdout?.on('data', (d) => log(String(d).trimEnd()));
        vite.stderr?.on('data', (d) => log(String(d).trimEnd()));
        let ready = false;
        while (!ready) {
          checkpoint();
          if (vite.exitCode !== null) throw new Error(`l'hôte Vite s'est arrêté (code ${vite.exitCode}) avant d'être prêt sur ${origin}, port occupé ou configuration invalide`);
          if (remaining(deadline) <= 0) throw new Error(`l'hôte ${origin} n'a pas répondu avec l'instance ${service.instanceId} dans le délai`);
          try {
            const r = await localFetch(`${origin}/api/preview-context`, deadline, {}, cancel.signal);
            ready = r.status === 200 && (r.json as { instanceId?: string } | null)?.instanceId === service.instanceId;
          } catch (e) {
            if (e instanceof LocalRefusal && e.reason === 'deadline') throw e;
          }
          if (!ready) await sleep(Math.min(200, Math.max(remaining(deadline), 0)), cancel.signal);
        }
      };
      await startHost('host', input.ports.demo, input.deadline);

      checkpoint();
      await announce('control', 'creating', 0);
      const nonce = randomToken();
      const control = createServer((req, res) => {
        if (req.method !== 'POST' || req.url !== '/stop') {
          res.writeHead(404).end();
          return;
        }
        let body = '';
        req.setEncoding('utf8');
        req.on('data', (c: string) => {
          body += c;
          if (body.length > 4096) req.destroy();
        });
        req.on('end', () => {
          let parsed: { nonce?: string; instanceId?: string } = {};
          try {
            parsed = JSON.parse(body || '{}');
          } catch {}
          if (parsed.nonce !== nonce || parsed.instanceId !== service.instanceId) {
            res.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ accepted: false }));
            return;
          }
          res.writeHead(202, { 'Content-Type': 'application/json' }).end(JSON.stringify({ accepted: true, generation: record.generation }));
          setImmediate(() => void stop('arrêt demandé par le contrôle privé').then((r) => process.exit(r.confirmed ? 0 : 1)));
        });
      });
      let revokeControl = () => undefined as void;
      own('control', async () => {
        control.closeAllConnections();
        await new Promise<void>((r) => control.close(() => r()));
        revokeControl();
      });
      await new Promise<void>((r) => control.listen(0, '127.0.0.1', () => r()));
      const controlPort = (control.address() as { port: number }).port;
      revokeControl = allowPort(controlPort);
      record.control = { port: controlPort, nonce };
      record.state = 'ready';
      await announce('control', 'running', controlPort);
      const schema = (await listMigrations()).map((m) => m.id);
      const view: InstanceView = { name: input.name, instanceId: service.instanceId, build: service.build, schema, serviceUrl: service.url, demoOrigin, root };
      const handle: InstanceHandle = {
        view,
        get service() { return service; },
        record,
        credentials: { import: credentials.import!.token, agent: credentials.agent!.token },
        stopService: () => guarded(async () => {
          await service.stop();
          disown('service');
          await announce('service', 'closed', service.port);
        }),
        startService: () => guarded(async () => {
          const port = service.port;
          service = await startService({ root, port, projects, instanceId: service.instanceId, bundlePath, creating: () => announce('service', 'creating', port), own: ownService, cancel: cancel.signal });
          await announce('service', 'running', service.port);
        }),
        stop,
        importDeployment: (id, url, manifest) => guarded(() => importDeployment(id, url, manifest, deadlineIn(10_000))),
        addHost: (h) => guarded(async () => {
          const origin = `http://127.0.0.1:${h.port}`;
          const r = await importDeployment(h.deploymentId, `${origin}/`, h.manifest, h.deadline);
          const body = r.json as { revisionId?: string; code?: string } | null;
          if (r.status !== 200 && r.status !== 201) throw new Error(`import de ${h.deploymentId} refusé : ${r.status} ${body?.code}`);
          const file = `preview-context-${h.deploymentId}.json`;
          await writePrivateFile(guardedPath(join(root, file)), JSON.stringify({
            serviceUrl: service.url, projectId: PROJECT, reviewKey: assembled.manifest.reviewKey, deploymentId: h.deploymentId, origin, issuer: ISSUER, audience: SERVICE_AUDIENCE, instanceId: service.instanceId,
          }));
          await startHost('host-b', h.port, h.deadline, { SOCRATE_PREVIEW_CONTEXT: file, SOCRATE_DEMO_SCENE: h.scene });
          return { origin, revisionId: body!.revisionId! };
        }),
      };
      return handle;
    });
  } catch (e) {
    const report = await stop(`échec du lancement : ${(e as Error).message}`);
    if (e instanceof LocalRefusal) throw e;
    throw new LocalRefusal('launch_failed', `${(e as Error).message} ; ${report.detail}`);
  }
}

const DETACHED_STOP_GRACE_MS = 30_000;

export async function launchDetached(input: { name: string; ports: Ports; reset: boolean; deadline: Deadline; log?: (line: string) => void; own?: (child: ChildProcess) => void }): Promise<LocalReport> {
  const root = instanceRoot(input.name);
  guardedPath(recordPathOf(root));
  const logPath = localPath('.local/artifacts/launch.log');
  await mkdir(dirname(logPath), { recursive: true });
  const out = openSync(logPath, 'a');
  const child = spawn(process.execPath, [localPath('tools/local/demo.ts'), ...(input.reset ? ['--reset'] : [])], {
    cwd: REPO_ROOT, detached: true, stdio: ['ignore', out, out],
    env: {
      PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', SOCRATE_INSTANCE: input.name, SOCRATE_SERVICE_PORT: String(input.ports.service), SOCRATE_DEMO_PORT: String(input.ports.demo),
      SOCRATE_LAUNCH_DEADLINE_MS: String(Math.max(1, Math.ceil(remaining(input.deadline)))),
    },
  });
  input.own?.(child);
  const exited = new Promise<void>((r) => child.once('exit', () => r()));
  while (remaining(input.deadline) > 0) {
    if (child.exitCode !== null) {
      const rec = await readRecord(root);
      const detail = rec && rec !== 'unreadable' && rec.state === 'failed' ? 'lanceur terminé en échec, voir launch.log' : `lanceur terminé prématurément (code ${child.exitCode}), voir launch.log`;
      return { kind: 'refused', reason: 'launch_failed', detail };
    }
    const rec = await readRecord(root);
    if (rec && rec !== 'unreadable' && rec.pid === child.pid && rec.state === 'ready') {
      const report = await doctorInstance(input.name, input.deadline);
      if (report.kind === 'healthy') {
        child.unref();
        const schema = (await listMigrations()).map((m) => m.id);
        return { kind: 'ready', instance: { name: input.name, instanceId: rec.instanceId!, build: rec.build!, schema, serviceUrl: `http://127.0.0.1:${rec.resources.service!.port}`, demoOrigin: `http://127.0.0.1:${rec.ports.demo}`, root } };
      }
    }
    await sleep(300);
  }
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  const stopped = await Promise.race([exited.then(() => true), sleep(DETACHED_STOP_GRACE_MS).then(() => false)]);
  const rec = await readRecord(root).catch(() => 'unreadable' as const);
  const open = openResources(rec);
  if (stopped && open.length === 0) {
    return { kind: 'refused', reason: 'launch_timeout', detail: `démonstration non prête dans le délai ; arrêt ordinaire du lanceur enfant terminé, ${rec === null ? 'aucun enregistrement de possession' : 'chaque ressource consignée est close'}` };
  }
  const why = stopped ? 'lanceur enfant terminé' : `lanceur enfant encore vivant après ${DETACHED_STOP_GRACE_MS} ms de grâce, aucun autre signal envoyé`;
  return { kind: 'refused', reason: 'launch_unconfirmed', detail: `démonstration non prête dans le délai ; ${why} ; ${open.length ? `${open.join(' ; ')} sans preuve de fermeture` : 'enregistrement de possession non concluant'} ; racine conservée` };
}

async function instanceHealth(rec: OwnerRecord, deadline: Deadline): Promise<{ ok: boolean; instanceId: string; build: string; schema: string[]; status: number; code?: string }> {
  const port = rec.resources.service?.port ?? rec.ports.service;
  const revoke = allowPort(port);
  try {
    const r = await localFetch(`http://127.0.0.1:${port}/v1/health`, deadline);
    const body = (r.json ?? {}) as { instanceId?: string; build?: string; schema?: string[]; code?: string };
    return { ok: r.status === 200, instanceId: body.instanceId ?? '', build: body.build ?? '', schema: body.schema ?? [], status: r.status, code: body.code };
  } catch (e) {
    return { ok: false, instanceId: '', build: '', schema: [], status: 0, code: (e as Error).message };
  } finally {
    revoke();
  }
}

export async function doctorInstance(name: string, deadline: Deadline): Promise<LocalReport> {
  const root = instanceRoot(name);
  const checks: Record<string, Check> = {};
  const rec = await readRecord(root);
  if (rec === null || rec === 'unreadable') {
    checks.record = { ok: false, detail: rec === null ? 'aucun enregistrement de possession' : 'enregistrement illisible' };
    return { kind: 'refused', reason: 'unhealthy', detail: 'instance absente', checks };
  }
  checks.record = { ok: rec.state === 'ready', detail: `état ${rec.state}, génération ${rec.generation.slice(0, 8)}, pid ${rec.pid}` };
  const bundlePath = guardedPath(join(root, 'worker.mjs'));
  const claim = claimRoot(root);
  if (claim === 'busy') checks.owner = { ok: true, detail: 'verrou tenu par le propriétaire' };
  else {
    claim.release();
    checks.owner = { ok: false, detail: 'verrou libre : aucun propriétaire vivant' };
  }
  const h = await instanceHealth(rec, deadline);
  checks.service = { ok: h.ok && h.instanceId === rec.instanceId, detail: h.ok ? (h.instanceId === rec.instanceId ? 'même instance' : `AUTRE INSTANCE ${h.instanceId}`) : `injoignable ou refusé (HTTP ${h.status} ${h.code ?? ''})` };
  const expected = (await listMigrations()).map((m) => m.id);
  checks.schema = { ok: h.ok && JSON.stringify(h.schema) === JSON.stringify(expected), detail: h.ok ? h.schema.join('+') : `inconnu (${h.code ?? h.status})` };
  const bundle = existsSync(bundlePath) ? bundleDigest(bundlePath) : null;
  checks.build = { ok: h.ok && h.build === rec.build && rec.build === bundle, detail: bundle === null ? 'bundle de l’instance absent' : h.build === rec.build && rec.build === bundle ? 'identique à l’enregistrement et au bundle de l’instance' : `divergent (worker ${h.build.slice(0, 12)}, enregistrement ${rec.build?.slice(0, 12)}, bundle ${bundle.slice(0, 12)})` };
  const demoPort = rec.resources.host?.port ?? rec.ports.demo;
  const revoke = allowPort(demoPort);
  try {
    const r = await localFetch(`http://127.0.0.1:${demoPort}/api/preview-context`, deadline);
    const ctx = (r.json ?? {}) as { instanceId?: string; serviceUrl?: string; deploymentId?: string };
    checks.demo = { ok: r.status === 200 && ctx.instanceId === rec.instanceId, detail: r.status === 200 ? (ctx.instanceId === rec.instanceId ? `même instance, déploiement ${ctx.deploymentId}` : `AUTRE INSTANCE ${ctx.instanceId}`) : `HTTP ${r.status}` };
    checks.loopback = { ok: ctx.serviceUrl?.startsWith('http://127.0.0.1:') === true, detail: ctx.serviceUrl ?? 'inconnu' };
  } catch (e) {
    checks.demo = { ok: false, detail: `injoignable (${(e as Error).message})` };
    checks.loopback = { ok: false, detail: 'inconnu' };
  } finally {
    revoke();
  }
  if (!rec.persist) checks.persist = { ok: false, detail: 'aucun stockage enregistré' };
  else {
    let st: Stats | undefined;
    try {
      st = lstatSync(rec.persist.path);
    } catch {}
    if (!st) checks.persist = { ok: false, detail: `stockage ABSENT (${rec.persist.path})` };
    else {
      const same = st.isDirectory() && st.dev === rec.persist.dev && st.ino === rec.persist.ino;
      const files = same ? guardedTree(rec.persist.path).files : 0;
      checks.persist = { ok: same && files > 0, detail: !st.isDirectory() ? 'pas un dossier' : !same ? 'dossier REMPLACÉ depuis le lancement' : files > 0 ? `présent, ${files} fichier(s)` : 'présent mais vide' };
    }
  }
  const healthy = Object.values(checks).every((c) => c.ok);
  return healthy ? { kind: 'healthy', checks } : { kind: 'refused', reason: 'unhealthy', detail: Object.entries(checks).filter(([, c]) => !c.ok).map(([k, c]) => `${k}: ${c.detail}`).join(' ; '), checks };
}

async function requestStop(rec: OwnerRecord, deadline: Deadline): Promise<string | null> {
  if (!rec.control) return 'aucun contrôle privé enregistré';
  const revoke = allowPort(rec.control.port);
  try {
    const r = await localFetch(`http://127.0.0.1:${rec.control.port}/stop`, deadline, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nonce: rec.control.nonce, instanceId: rec.instanceId }) });
    return r.status === 202 ? null : `contrôle privé a répondu ${r.status}`;
  } catch (e) {
    return `contrôle privé injoignable (${(e as Error).message})`;
  } finally {
    revoke();
  }
}

export async function cleanupInstance(name: string, deadline: Deadline): Promise<LocalReport> {
  const root = instanceRoot(name);
  let claim = claimRoot(root);
  let asked: OwnerRecord | null = null;
  if (claim === 'busy') {
    const rec = await readRecord(root);
    if (rec === null || rec === 'unreadable') return { kind: 'refused', reason: 'occupied', detail: 'verrou tenu sans enregistrement lisible : aucun arrêt demandé, rien n’est supprimé' };
    asked = rec;
    const refusal = await requestStop(rec, deadline);
    if (refusal) return { kind: 'refused', reason: 'occupied', detail: `instance ${rec.instanceId ?? '?'} vivante, arrêt non obtenu : ${refusal} ; rien n’est supprimé` };
    while (claim === 'busy' && remaining(deadline) > 0) {
      await sleep(200);
      claim = claimRoot(root);
    }
    if (claim === 'busy') return { kind: 'refused', reason: 'stop_unconfirmed', detail: 'arrêt demandé mais verrou toujours tenu dans le délai : racine conservée' };
  }
  try {
    const rec = await readRecord(root);
    if (asked && (rec === null || rec === 'unreadable' || rec.generation !== asked.generation)) {
      return { kind: 'refused', reason: 'generation_changed', detail: 'une autre instance est apparue entre l’arrêt demandé et l’acquisition : rien n’est supprimé' };
    }
    const open = openResources(rec);
    if (open.length) {
      const probes = rec !== null && rec !== 'unreadable' ? await Promise.all(Object.values(rec.resources).map(async (r) => `port ${r.port} ${await tcpProbe(r.port)}`)) : [];
      return { kind: 'refused', reason: 'uncertain_resources', detail: `ressources sans preuve de fermeture (${open.join(' ; ')}) ; diagnostic ${probes.join(', ')} ; racine conservée, aucun signal envoyé` };
    }
    await rm(root, { recursive: true, force: true });
    await rm(guardedPath(recordPathOf(root)), { force: true });
    return { kind: 'cleaned', detail: `racine ${root} supprimée sous verrou ; verrou ${lockPathOf(root)} conservé` };
  } finally {
    claim.release();
  }
}
