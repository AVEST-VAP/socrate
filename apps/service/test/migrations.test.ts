import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, mkdir, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { rt, claimOrThrow, startHeld, closeHeld, hold } from './helpers.ts';

afterEach(closeHeld);
import { REPO_ROOT, tcpProbe } from '../../../tools/local/local-run.ts';

const projectsFor = async () => [{ projectId: 'demo', issuer: 'demo-host', publicJwk: (await rt.generateIssuerKeys()).publicJwk, attestableCapabilities: [] }];
const tmp = (prefix: string) => mkdtemp(join(REPO_ROOT, '.tmp', prefix));

test('les migrations s’appliquent sur une base vierge et se rejouent sans effet', async () => {
  const root = await tmp('mig-');
  const claim = claimOrThrow(root);
  const projects = await projectsFor();
  let s = await startHeld({ root, projects });
  const tables = await s.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all<{ name: string }>();
  assert.ok(tables.results.map((t) => t.name).includes('threads'));
  const second = await rt.applyMigrations(s.db);
  assert.deepEqual(second, { applied: [], skipped: ['0001_pilot.sql', '0002_capture.sql', '0003_revocation.sql', '0004_wording.sql', '0005_agent_api.sql', '0006_operations.sql', '0007_attachments.sql', '0008_agent_tokens.sql'] });
  await s.stop();
  s = await startHeld({ root, port: 0, projects });
  const rows = await s.db.prepare('SELECT id FROM schema_migrations').all<{ id: string }>();
  assert.deepEqual(rows.results.map((r) => r.id), ['0001_pilot.sql', '0002_capture.sql', '0003_revocation.sql', '0004_wording.sql', '0005_agent_api.sql', '0006_operations.sql', '0007_attachments.sql', '0008_agent_tokens.sql']);
  await s.stop();
  claim.release();
});

test('une migration partiellement invalide est annulée en bloc et une migration modifiée est refusée sans reset', async () => {
  const root = await tmp('mig-');
  const dir = join(root, 'migrations');
  await mkdir(dir, { recursive: true });
  await cp(join(rt.MIGRATIONS_DIR, '0001_pilot.sql'), join(dir, '0001_pilot.sql'));
  await writeFile(join(dir, '0002_broken.sql'), 'CREATE TABLE essai (id TEXT PRIMARY KEY);\nINSERT INTO table_inexistante VALUES (1);\n');
  const claim = claimOrThrow(root);
  const s = await startHeld({ root, projects: await projectsFor(), migrationsDir: dir, migrate: false });
  await assert.rejects(rt.applyMigrations(s.db, dir), /table_inexistante|no such table/);
  const essai = await s.db.prepare("SELECT name FROM sqlite_master WHERE name = 'essai'").first();
  assert.equal(essai, null, 'le batch annulé ne laisse pas la table partielle');
  const applied = await s.db.prepare('SELECT id FROM schema_migrations ORDER BY id').all<{ id: string }>();
  assert.deepEqual(applied.results.map((r) => r.id), ['0001_pilot.sql']);
  await writeFile(join(dir, '0002_broken.sql'), 'CREATE TABLE essai (id TEXT PRIMARY KEY);\n');
  assert.deepEqual((await rt.applyMigrations(s.db, dir)).applied, ['0002_broken.sql']);
  const original = await readFile(join(dir, '0001_pilot.sql'), 'utf8');
  await writeFile(join(dir, '0001_pilot.sql'), original + '\n-- modifiée\n');
  await assert.rejects(rt.applyMigrations(s.db, dir), (e: Error) => e instanceof rt.SchemaIncompatible && /modifiée après application/.test(e.message));
  const still = await s.db.prepare('SELECT id FROM schema_migrations ORDER BY id').all<{ id: string }>();
  assert.deepEqual(still.results.map((r) => r.id), ['0001_pilot.sql', '0002_broken.sql'], 'aucune réinitialisation');
  await s.stop();
  claim.release();
});

test('barrière de migration : aucune route ne répond avant la fin des migrations, sur base vide comme pour une migration supplémentaire', async () => {
  const root = await tmp('barrier-');
  const claim = claimOrThrow(root);
  const projects = await projectsFor();
  const notReady = async (url: string, path: string, init?: RequestInit) => {
    const r = await fetch(`${url}${path}`, init);
    const body = (await r.json()) as { code: string; retryable: boolean };
    assert.equal(r.status, 503, `${path} doit être refusé pendant la migration`);
    assert.equal(body.code, 'not_ready');
    assert.equal(body.retryable, true);
  };
  const empty = await startHeld({ root, projects, migrate: false });
  await notReady(empty.url, '/v1/health');
  await notReady(empty.url, '/v1/projects/demo/reviews/x/threads', { method: 'POST', headers: { Authorization: 'Bearer abc', Origin: 'http://127.0.0.1:5173', 'Content-Type': 'application/json' }, body: '{}' });
  await rt.applyMigrations(empty.db);
  const h = await fetch(`${empty.url}/v1/health`);
  assert.equal(h.status, 200);
  assert.deepEqual(((await h.json()) as { schema: string[] }).schema, ['0001_pilot.sql', '0002_capture.sql', '0003_revocation.sql', '0004_wording.sql', '0005_agent_api.sql', '0006_operations.sql', '0007_attachments.sql', '0008_agent_tokens.sql']);
  await empty.stop();

  const dir = join(root, 'migrations');
  await mkdir(dir, { recursive: true });
  await cp(join(rt.MIGRATIONS_DIR, '0001_pilot.sql'), join(dir, '0001_pilot.sql'));
  await cp(join(rt.MIGRATIONS_DIR, '0002_capture.sql'), join(dir, '0002_capture.sql'));
  await cp(join(rt.MIGRATIONS_DIR, '0003_revocation.sql'), join(dir, '0003_revocation.sql'));
  await cp(join(rt.MIGRATIONS_DIR, '0004_wording.sql'), join(dir, '0004_wording.sql'));
  await cp(join(rt.MIGRATIONS_DIR, '0005_agent_api.sql'), join(dir, '0005_agent_api.sql'));
  await cp(join(rt.MIGRATIONS_DIR, '0006_operations.sql'), join(dir, '0006_operations.sql'));
  await cp(join(rt.MIGRATIONS_DIR, '0007_attachments.sql'), join(dir, '0007_attachments.sql'));
  await cp(join(rt.MIGRATIONS_DIR, '0008_agent_tokens.sql'), join(dir, '0008_agent_tokens.sql'));
  await writeFile(join(dir, '0009_suivante.sql'), 'CREATE TABLE suivante (id TEXT PRIMARY KEY);\n');
  const next = await startHeld({ root, projects, migrationsDir: dir, migrate: false });
  await notReady(next.url, '/v1/health');
  assert.deepEqual((await rt.applyMigrations(next.db, dir)).applied, ['0009_suivante.sql']);
  const h2 = await fetch(`${next.url}/v1/health`);
  assert.equal(h2.status, 200);
  assert.deepEqual(((await h2.json()) as { schema: string[] }).schema, ['0001_pilot.sql', '0002_capture.sql', '0003_revocation.sql', '0004_wording.sql', '0005_agent_api.sql', '0006_operations.sql', '0007_attachments.sql', '0008_agent_tokens.sql', '0009_suivante.sql']);
  await next.stop();
  claim.release();
});

test('schéma futur, trou ou checksum divergent : refus explicite schema_incompatible, jamais un reset ni un 503 réessayable', async () => {
  const root = await tmp('incompat-');
  const claim = claimOrThrow(root);
  const projects = await projectsFor();
  const future = join(root, 'migrations-future');
  await mkdir(future, { recursive: true });
  await cp(join(rt.MIGRATIONS_DIR, '0001_pilot.sql'), join(future, '0001_pilot.sql'));
  await cp(join(rt.MIGRATIONS_DIR, '0002_capture.sql'), join(future, '0002_capture.sql'));
  await cp(join(rt.MIGRATIONS_DIR, '0003_revocation.sql'), join(future, '0003_revocation.sql'));
  await cp(join(rt.MIGRATIONS_DIR, '0004_wording.sql'), join(future, '0004_wording.sql'));
  await cp(join(rt.MIGRATIONS_DIR, '0005_agent_api.sql'), join(future, '0005_agent_api.sql'));
  await cp(join(rt.MIGRATIONS_DIR, '0006_operations.sql'), join(future, '0006_operations.sql'));
  await cp(join(rt.MIGRATIONS_DIR, '0007_attachments.sql'), join(future, '0007_attachments.sql'));
  await cp(join(rt.MIGRATIONS_DIR, '0008_agent_tokens.sql'), join(future, '0008_agent_tokens.sql'));
  await writeFile(join(future, '0009_future.sql'), 'CREATE TABLE future (id TEXT PRIMARY KEY);\n');
  const ahead = await startHeld({ root, projects, migrationsDir: future });
  await ahead.db.prepare("INSERT INTO reviews (project_id, review_key, state, created_at) VALUES ('demo', 'temoin', 'active', '2026-10-16T00:00:00Z')").run();
  await ahead.stop();

  await assert.rejects(startHeld({ root, projects }), (e: Error) => e instanceof rt.SchemaIncompatible && /plus récente que le build/.test(e.message));
  const stale = await startHeld({ root, projects, migrate: false });
  const h = await fetch(`${stale.url}/v1/health`);
  const body = (await h.json()) as { code: string; retryable: boolean };
  assert.equal(h.status, 500);
  assert.equal(body.code, 'schema_incompatible');
  assert.equal(body.retryable, false);
  const witness = await stale.db.prepare("SELECT COUNT(*) AS n FROM reviews WHERE review_key = 'temoin'").first<{ n: number }>();
  assert.equal(witness!.n, 1, 'données conservées, aucun reset');
  const applied = await stale.db.prepare('SELECT id FROM schema_migrations ORDER BY id').all<{ id: string }>();
  assert.deepEqual(applied.results.map((r) => r.id), ['0001_pilot.sql', '0002_capture.sql', '0003_revocation.sql', '0004_wording.sql', '0005_agent_api.sql', '0006_operations.sql', '0007_attachments.sql', '0008_agent_tokens.sql', '0009_future.sql']);
  await stale.db.prepare("DELETE FROM schema_migrations WHERE id = '0009_future.sql'").run();
  await stale.db.prepare("INSERT INTO schema_migrations (id, checksum, applied_at) VALUES ('0010_trou.sql', 'abc', '2026-10-16T00:00:00Z')").run();
  await stale.stop();
  await assert.rejects(startHeld({ root, projects, migrationsDir: future }), (e: Error) => e instanceof rt.SchemaIncompatible && /incompatible/.test(e.message));
  const gap = await startHeld({ root, projects, migrationsDir: future, migrate: false });
  assert.equal((await fetch(`${gap.url}/v1/health`)).status, 500);
  await gap.stop();
  claim.release();
});

test('fermeture ordinaire par closeHeld : un service laissé ouvert à la fin du corps du cas est fermé, son port révoqué puis refusé et sa racine libérée', async () => {
  const root = await tmp('held-');
  claimOrThrow(root);
  const s = await startHeld({ root, projects: await projectsFor() });
  assert.equal((await fetch(`${s.url}/v1/health`)).status, 200);
  await closeHeld();
  await assert.rejects(fetch(`${s.url}/v1/health`), /port loopback non possédé/, 'le garde réseau a révoqué le port');
  assert.equal(await tcpProbe(s.port), 'refused', 'plus aucun écouteur sur le port du service');
  const again = rt.claimRoot(root);
  assert.notEqual(again, 'busy', 'la racine est libérée après closeHeld');
  (again as Exclude<typeof again, 'busy'>).release();
});

test('fermeture contrôlée en mémoire : un arrêt qui ne se règle pas rend la main à son échéance, closeHeld conserve l’entrée et le verrou de sa racine et libère seulement la racine confirmée', async () => {
  const stuck = await tmp('held-stuck-');
  const done = await tmp('held-done-');
  claimOrThrow(stuck);
  claimOrThrow(done);
  let settle!: () => void;
  const stop = hold(stuck, () => new Promise<void>((r) => { settle = r; }), 50);
  hold(done, async () => {}, 50);
  await assert.rejects(stop(), /fermeture non confirmée après 50 ms/, 'l’appelant reprend la main avant afterEach');
  await assert.rejects(closeHeld(), (e: Error) => e.message.includes(stuck) && !e.message.includes(done));
  assert.equal(rt.claimRoot(stuck), 'busy', 'verrou conservé tant que la fermeture reste inconnue');
  const freed = rt.claimRoot(done);
  assert.notEqual(freed, 'busy', 'la racine confirmée est libérée');
  (freed as Exclude<typeof freed, 'busy'>).release();
  settle();
  await closeHeld();
  const again = rt.claimRoot(stuck);
  assert.notEqual(again, 'busy', 'verrou rendu une fois la même fermeture confirmée');
  (again as Exclude<typeof again, 'busy'>).release();
});

test('0002 reconstruit threads sur une base au schéma 0001 déjà peuplée : retours, messages et clés étrangères intacts', async () => {
  const root = await tmp('mig-pilote-');
  const claim = claimOrThrow(root);
  const projects = await projectsFor();
  const pilot = join(root, 'migrations-pilote');
  await mkdir(pilot, { recursive: true });
  await cp(join(rt.MIGRATIONS_DIR, '0001_pilot.sql'), join(pilot, '0001_pilot.sql'));
  const before = await startHeld({ root, projects, migrationsDir: pilot });
  const at = '2026-10-16T00:00:00Z';
  await before.db.batch([
    before.db.prepare("INSERT INTO reviews (project_id, review_key, state, created_at) VALUES ('demo', 'r', 'active', ?)").bind(at),
    before.db.prepare("INSERT INTO revisions (project_id, review_key, revision_id, manifest, created_at) VALUES ('demo', 'r', 'rev', '{}', ?)").bind(at),
    before.db.prepare("INSERT INTO deployments (project_id, review_key, deployment_id, revision_id, commit_sha, build_id, url, origin, payload_digest, created_at) VALUES ('demo', 'r', 'd', 'rev', 'abc1234', 'b', 'http://127.0.0.1:5173/', 'http://127.0.0.1:5173', 'x', ?)").bind(at),
    before.db.prepare("INSERT INTO threads (project_id, review_key, thread_id, kind, state, version, revision_id, deployment_id, author_key, author_name, created_at, updated_at) VALUES ('demo', 'r', 't1', 'global', 'resolved', 1, 'rev', 'd', 'a', 'Claire', ?, ?)").bind(at, at),
    before.db.prepare("INSERT INTO messages (project_id, review_key, thread_id, message_id, seq, author_key, author_name, exploring, body, created_at) VALUES ('demo', 'r', 't1', 'm1', 1, 'a', 'Claire', NULL, 'Avis initial', ?)").bind(at),
  ]);
  await before.stop();
  const after = await startHeld({ root, projects });
  const thread = await after.db.prepare("SELECT kind, state, version FROM threads WHERE thread_id = 't1'").first<{ kind: string; state: string; version: number }>();
  assert.deepEqual(thread, { kind: 'global', state: 'resolved', version: 1 });
  assert.equal((await after.db.prepare("SELECT body FROM messages WHERE thread_id = 't1'").first<{ body: string }>())!.body, 'Avis initial');
  assert.equal((await after.db.prepare('PRAGMA foreign_key_check').all()).results.length, 0, 'aucune référence orpheline après reconstruction');
  await assert.rejects(after.db.prepare("INSERT INTO messages (project_id, review_key, thread_id, message_id, seq, author_key, author_name, exploring, body, created_at) VALUES ('demo', 'r', 'absent', 'm2', 1, 'a', 'Claire', NULL, 'x', ?)").bind(at).run(), /FOREIGN KEY/i, 'les messages référencent toujours threads');
  await after.stop();
  claim.release();
});

test('0004 ajoute les propositions sur une base au schéma 0003 déjà peuplée : fils, messages et révocation intacts', async () => {
  const root = await tmp('mig-0003-');
  const claim = claimOrThrow(root);
  const projects = await projectsFor();
  const schema0003 = join(root, 'migrations-0003');
  await mkdir(schema0003, { recursive: true });
  for (const f of ['0001_pilot.sql', '0002_capture.sql', '0003_revocation.sql']) await cp(join(rt.MIGRATIONS_DIR, f), join(schema0003, f));
  const before = await startHeld({ root, projects, migrationsDir: schema0003 });
  const at = '2026-10-18T00:00:00Z';
  await before.db.batch([
    before.db.prepare("INSERT INTO reviews (project_id, review_key, state, created_at) VALUES ('demo', 'r', 'active', ?)").bind(at),
    before.db.prepare("INSERT INTO revisions (project_id, review_key, revision_id, manifest, created_at) VALUES ('demo', 'r', 'rev', '{}', ?)").bind(at),
    before.db.prepare("INSERT INTO deployments (project_id, review_key, deployment_id, revision_id, commit_sha, build_id, url, origin, payload_digest, created_at, revoked_at) VALUES ('demo', 'r', 'd', 'rev', 'abc1234', 'b', 'http://127.0.0.1:5173/', 'http://127.0.0.1:5173', 'x', ?, ?)").bind(at, at),
    before.db.prepare("INSERT INTO threads (project_id, review_key, thread_id, kind, state, version, revision_id, deployment_id, author_key, author_name, created_at, updated_at) VALUES ('demo', 'r', 't1', 'global', 'open', 1, 'rev', 'd', 'a', 'Claire', ?, ?)").bind(at, at),
    before.db.prepare("INSERT INTO messages (project_id, review_key, thread_id, message_id, seq, author_key, author_name, exploring, body, created_at) VALUES ('demo', 'r', 't1', 'm1', 1, 'a', 'Claire', NULL, 'Avis antérieur', ?)").bind(at),
  ]);
  await before.stop();
  const after = await startHeld({ root, projects });
  const applied = await after.db.prepare('SELECT id FROM schema_migrations ORDER BY id').all<{ id: string }>();
  assert.deepEqual(applied.results.map((r) => r.id), ['0001_pilot.sql', '0002_capture.sql', '0003_revocation.sql', '0004_wording.sql', '0005_agent_api.sql', '0006_operations.sql', '0007_attachments.sql', '0008_agent_tokens.sql']);
  assert.deepEqual(await after.db.prepare("SELECT revoked_at FROM deployments WHERE deployment_id = 'd'").first(), { revoked_at: at }, 'révocation conservée');
  assert.deepEqual(await after.db.prepare("SELECT kind, state, version FROM threads WHERE thread_id = 't1'").first(), { kind: 'global', state: 'open', version: 1 });
  assert.equal((await after.db.prepare("SELECT body FROM messages WHERE thread_id = 't1'").first<{ body: string }>())!.body, 'Avis antérieur');
  await after.db.prepare("INSERT INTO proposals (project_id, review_key, thread_id, original, replacement, source_revision_id, wording_id, wording) VALUES ('demo', 'r', 't1', 'avant', 'après', 'rev', NULL, NULL)").run();
  await assert.rejects(after.db.prepare("INSERT INTO proposals (project_id, review_key, thread_id, original, replacement, source_revision_id) VALUES ('demo', 'r', 'absent', 'a', 'b', 'rev')").run(), /FOREIGN KEY/i, 'une proposition référence un fil existant');
  assert.equal((await after.db.prepare('PRAGMA foreign_key_check').all()).results.length, 0);
  await after.stop();
  claim.release();
});

test('0005 ajoute l’accès agent sur une base au schéma 0004 déjà peuplée : révocation, proposition, fil, réponse et capture intacts', async () => {
  const root = await tmp('mig-0004-');
  const claim = claimOrThrow(root);
  const projects = await projectsFor();
  const schema0004 = join(root, 'migrations-0004');
  await mkdir(schema0004, { recursive: true });
  for (const f of ['0001_pilot.sql', '0002_capture.sql', '0003_revocation.sql', '0004_wording.sql']) await cp(join(rt.MIGRATIONS_DIR, f), join(schema0004, f));
  const tables = ['reviews', 'revisions', 'deployments', 'threads', 'messages', 'changes', 'operations', 'captures', 'targets', 'proposals'];
  const before = await startHeld({ root, projects, migrationsDir: schema0004 });
  const dump = async (db: typeof before.db) => JSON.stringify(await Promise.all(tables.map(async (t) => (await db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2, 3`).all()).results)));
  const at = '2026-10-18T00:00:00Z';
  const thread = "INSERT INTO threads (project_id, review_key, thread_id, kind, state, version, revision_id, deployment_id, author_key, author_name, created_at, updated_at) VALUES ('demo', 'r', ?, ?, 'open', 1, 'rev', 'd', 'a', 'Claire', ?, ?)";
  const message = "INSERT INTO messages (project_id, review_key, thread_id, message_id, seq, author_key, author_name, exploring, body, created_at) VALUES ('demo', 'r', ?, ?, ?, 'a', 'Claire', NULL, ?, ?)";
  await before.db.batch([
    before.db.prepare("INSERT INTO reviews (project_id, review_key, state, created_at) VALUES ('demo', 'r', 'active', ?)").bind(at),
    before.db.prepare("INSERT INTO revisions (project_id, review_key, revision_id, manifest, created_at) VALUES ('demo', 'r', 'rev', '{}', ?)").bind(at),
    before.db.prepare("INSERT INTO deployments (project_id, review_key, deployment_id, revision_id, commit_sha, build_id, url, origin, payload_digest, created_at, revoked_at) VALUES ('demo', 'r', 'd', 'rev', 'abc1234', 'b', 'http://127.0.0.1:5173/', 'http://127.0.0.1:5173', 'x', ?, ?)").bind(at, at),
    before.db.prepare(thread).bind('t1', 'global', at, at),
    before.db.prepare(message).bind('t1', 'm1', 1, 'Proposition antérieure', at),
    before.db.prepare(message).bind('t1', 'm2', 2, 'Réponse', at),
    before.db.prepare("INSERT INTO proposals (project_id, review_key, thread_id, original, replacement, source_revision_id, wording_id, wording) VALUES ('demo', 'r', 't1', 'avant', 'après', 'rev', 'rappel-email', '{}')"),
    before.db.prepare(thread).bind('t2', 'targeted', at, at),
    before.db.prepare(message).bind('t2', 'm3', 1, 'Ciblé avec image', at),
    before.db.prepare("INSERT INTO captures (project_id, review_key, capture_id, actor_key, idempotency_key, payload_digest, payload, attempt, state, uploaded, object_key, content_type, size, sha256, width, height, thread_id, expires_at, created_at) VALUES ('demo', 'r', 'c1', 'a', 'k', 'p', '{}', 'x', 'committed', 1, 'demo/r/c1', 'image/png', 68, 'h', 1, 1, 't2', 0, ?)").bind(at),
    before.db.prepare("INSERT INTO targets (project_id, review_key, thread_id, capture_id, context) VALUES ('demo', 'r', 't2', 'c1', '{}')"),
    before.db.prepare("INSERT INTO changes (project_id, review_key, thread_id, kind, created_at) VALUES ('demo', 'r', 't1', 'thread.created', ?)").bind(at),
  ]);
  const kept = await dump(before.db);
  await before.stop();
  const schema0005 = join(root, 'migrations-0005');
  await cp(schema0004, schema0005, { recursive: true });
  await cp(join(rt.MIGRATIONS_DIR, '0005_agent_api.sql'), join(schema0005, '0005_agent_api.sql'));
  const after = await startHeld({ root, projects, migrationsDir: schema0005 });
  const applied = await after.db.prepare('SELECT id FROM schema_migrations ORDER BY id').all<{ id: string }>();
  assert.deepEqual(applied.results.map((r) => r.id), ['0001_pilot.sql', '0002_capture.sql', '0003_revocation.sql', '0004_wording.sql', '0005_agent_api.sql']);
  assert.equal(await dump(after.db), kept, 'lignes antérieures identiques après 0005');
  assert.deepEqual(await after.db.prepare("SELECT revoked_at FROM deployments WHERE deployment_id = 'd'").first(), { revoked_at: at }, 'révocation conservée');
  const epoch = (await after.db.prepare('SELECT epoch FROM sync_epoch').first<{ epoch: string }>())!.epoch;
  assert.match(epoch, /^[0-9a-f]{32}$/);
  assert.equal((await after.db.prepare('PRAGMA foreign_key_check').all()).results.length, 0);
  await after.stop();

  // 0006 sur cette base au schéma 0005 peuplée : reconstruction de reviews sans perte, gel inactif, déclencheurs posés.
  const ops = await startHeld({ root, projects });
  assert.deepEqual((await ops.db.prepare('SELECT id FROM schema_migrations ORDER BY id').all<{ id: string }>()).results.map((r) => r.id).at(-1), '0008_agent_tokens.sql');
  const old = JSON.parse(kept) as Record<string, unknown>[][];
  const now = JSON.parse(await dump(ops.db)) as Record<string, unknown>[][];
  const messages = tables.indexOf('messages');
  old[messages] = old[messages]!.map((r) => ({ ...r, via: null, transition: null, commit_sha: null, deployment_id: null }));
  assert.deepEqual(now.slice(1), old.slice(1), 'neuf tables métier identiques après 0006 à 0008, messages sans agent ni transition');
  assert.deepEqual(now[0], old[0]!.map((r) => ({ ...r, archived_at: null, purge_after: null, purge_run: null, purged_at: null })), 'revue intacte, colonnes d’archivage vides');
  assert.equal((await ops.db.prepare('SELECT epoch FROM sync_epoch').first<{ epoch: string }>())!.epoch, epoch);
  assert.deepEqual(await ops.db.prepare('SELECT frozen FROM maintenance').first(), { frozen: 0 });
  assert.equal((await ops.db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'frozen_%'").first<{ n: number }>())!.n, 69);
  assert.equal((await ops.db.prepare('PRAGMA foreign_key_check').all()).results.length, 0);
  await assert.rejects(ops.db.prepare("INSERT INTO revisions (project_id, review_key, revision_id, manifest, created_at) VALUES ('demo', 'absente', 'x', '{}', ?)").bind(at).run(), /FOREIGN KEY/i, 'les révisions référencent toujours reviews');
  await ops.stop();
  claim.release();
});
