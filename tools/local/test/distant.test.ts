import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serviceConfigSchema } from '@socrate/contract';
import { assembleManifest } from '@socrate/contract/assemble';
import { REPO_ROOT, localPath, runtime } from '../local-run.ts';
import { issueCredential, parseApplied, prepare, remoteMigrations } from '../distant.ts';

const rt = await runtime();
const EXAMPLE = localPath('apps/service/wrangler.jsonc.example');
const tmp = (prefix: string) => mkdtemp(join(REPO_ROOT, '.tmp', prefix));

async function filledExample(dir: string, publicJwk: JsonWebKey, edit: (text: string) => string = (t) => t): Promise<string> {
  const text = (await readFile(EXAMPLE, 'utf8'))
    .replace('"<D1 database name>"', '"socrate-previews"').replace('"<D1 database id>"', '"00000000-0000-0000-0000-000000000000"')
    .replace('"<R2 bucket name>"', '"socrate-previews-captures"')
    .replace('"<ES256 public key as a JWK object { kty, crv, x, y }>"', JSON.stringify({ kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y }));
  const path = join(dir, 'wrangler.jsonc');
  await writeFile(path, edit(text));
  return path;
}

test('l’exemple ne contient aucun identifiant réel : preparer le refuse en listant chaque valeur à remplacer', async () => {
  const out = await tmp('distant-');
  await assert.rejects(prepare(EXAMPLE, out), (e: Error) => ['D1 database name', 'D1 database id', 'R2 bucket name', 'ES256 public key'].every((p) => e.message.includes(p)));
  assert.deepEqual(await readdir(out), [], 'aucun build ni configuration écrits');
});

test('preparer refuse un projet distant sans allowedOrigin', async () => {
  const dir = await tmp('distant-');
  const config = await filledExample(dir, (await rt.generateIssuerKeys()).publicJwk, (t) => t.replace(/,\s*"allowedOrigin": "[^"]*"/, ''));
  await assert.rejects(prepare(config, join(dir, 'dist')), /allowedOrigin requis.*my-app/);
});

test('parcours distant rejoué sur un D1 local : preparer, migrations empreintées, accès d’import, d’archivage et de lecture uniques, import limité au motif', async () => {
  const dir = await tmp('distant-');
  const out = join(dir, 'dist');
  const keys = await rt.generateIssuerKeys();
  const deployPath = await prepare(await filledExample(dir, keys.publicJwk), out);
  const deploy = JSON.parse(await readFile(deployPath, 'utf8'));
  assert.equal(deploy.name, 'my-socrate', 'nom du Worker fixé par la conception');
  assert.deepEqual([deploy.main, deploy.no_bundle, deploy.assets], ['worker.mjs', true, { directory: 'assets', binding: 'ASSETS', run_worker_first: true }]);
  assert.deepEqual(Object.values(deploy.vars).map((v) => typeof v), ['string', 'string', 'string'], 'variables passées en chaînes JSON, comme les lit le Worker');
  const config = serviceConfigSchema.parse(JSON.parse(deploy.vars.SOCRATE_CONFIG));
  assert.equal(config.projects['my-app']!.allowedOrigin, 'https://*.my-app-previews.pages.dev');
  assert.equal(config.projects['my-app']!.issuer, 'my-backend', 'émetteur du backend écrit dans l’exemple');
  const expected = (await rt.listMigrations()).map(({ id, checksum }) => ({ id, checksum }));
  assert.deepEqual(JSON.parse(deploy.vars.SOCRATE_SCHEMA), expected);
  assert.equal(JSON.parse(deploy.vars.SOCRATE_INSTANCE).build, rt.bundleDigest(join(out, 'worker.mjs')));
  assert.ok((await readdir(join(out, 'assets/client'))).some((f) => /^[A-Z0-9]{8}\.js$/.test(f)), 'client par empreinte à côté du Worker');

  const files = await remoteMigrations(parseApplied('[{"results":[],"success":true,"meta":{}}]'), out);
  assert.deepEqual(files.map((f) => f.slice(f.lastIndexOf('/') + 1)), expected.map((m) => m.id));
  const project = { projectId: 'my-app', issuer: 'my-backend', publicJwk: keys.publicJwk, attestableCapabilities: config.projects['my-app']!.attestableCapabilities, allowedOrigin: config.projects['my-app']!.allowedOrigin };
  const service = await rt.startService({ root: dir, bundlePath: join(out, 'worker.mjs'), projects: [project], migrate: false });
  try {
    for (const f of files) await service.db.batch((await readFile(f, 'utf8')).split(/;\s*\n/).map((s) => s.trim()).filter(Boolean).map((s) => service.db.prepare(s)));
    const health = await fetch(`${service.url}/v1/health`);
    assert.equal(health.status, 200, 'le Worker accepte le schéma écrit par les fichiers distants');
    const applied = (await service.db.prepare('SELECT id, checksum FROM schema_migrations ORDER BY id').all<{ id: string; checksum: string }>()).results;
    assert.deepEqual(applied, expected);
    assert.deepEqual(await remoteMigrations(parseApplied(JSON.stringify([{ results: applied }])), out), [], 'base à jour : aucun fichier');
    await assert.rejects(remoteMigrations([{ ...applied[0]!, checksum: '0'.repeat(64) }], out), rt.SchemaIncompatible, 'empreinte divergente refusée');

    const issued = await issueCredential('my-app', 365, out);
    const sql = await readFile(issued.file, 'utf8');
    assert.equal(sql.includes(issued.token), false, 'le jeton n’est jamais écrit');
    await assert.rejects(issueCredential('my-app', 365, out), /existe déjà/, 'émission unique');
    await assert.rejects(issueCredential('autre', 365, join(dir, 'dist')), /absent de SOCRATE_CONFIG/);
    await service.db.prepare(sql.trim()).run();
    const manifest = await assembleManifest(localPath('apps/demo/.socrate'));
    assert.ok(manifest.ok);
    const put = (id: string, url: string) => fetch(`${service.url}/v1/projects/my-app/reviews/my-app-pr-1/deployments/${id}`, {
      method: 'PUT', headers: { Authorization: `Bearer ${issued.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ commit: 'a1b2c3d4e5f6', buildId: '1', url, manifest: { ...manifest.manifest, reviewKey: 'my-app-pr-1' } }),
    });
    assert.equal((await put('pr-1-a', 'https://my-branch.my-app-previews.pages.dev/')).status, 201);
    assert.equal((await put('pr-1-b', 'https://app.example.com/')).status, 403);

    const archive = await issueCredential('my-app', 365, out, 'review.archive');
    const archiveSql = await readFile(archive.file, 'utf8');
    assert.equal(archiveSql.includes(archive.token), false, 'le jeton d’archivage n’est jamais écrit');
    assert.match(archiveSql, /'archivage-manuel', '\["review\.archive"\]'/);
    await assert.rejects(issueCredential('my-app', 365, out, 'review.archive'), /existe déjà/, 'émission unique');
    await service.db.prepare(archiveSql.trim()).run();
    const archiveWith = (token: string) => fetch(`${service.url}/v1/projects/my-app/reviews/my-app-pr-1/archive`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
    assert.equal((await archiveWith(issued.token)).status, 403, 'l’accès d’import n’archive pas');
    const archived = await archiveWith(archive.token);
    assert.equal(archived.status, 200);
    assert.equal(((await archived.json()) as { state: string }).state, 'archived');
    assert.equal((await put('pr-1-c', 'https://my-branch.my-app-previews.pages.dev/')).status, 409, 'revue archivée : plus d’import');

    const read = await issueCredential('my-app', 365, out, 'review.read');
    const readSql = await readFile(read.file, 'utf8');
    assert.equal(readSql.includes(read.token), false, 'le jeton de lecture n’est jamais écrit');
    assert.match(readSql, /'agent-lecture', '\["review\.read"\]'/);
    await assert.rejects(issueCredential('my-app', 365, out, 'review.read'), /existe déjà/, 'émission unique');
    await service.db.prepare(readSql.trim()).run();
    const asAgent = (path: string, init: RequestInit = {}) => fetch(`${service.url}/v1/projects/my-app${path}`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${read.token}` } });
    const reviews = await asAgent('/reviews');
    assert.equal(reviews.status, 200);
    assert.deepEqual(((await reviews.json()) as { items: { reviewKey: string }[] }).items.map((r) => r.reviewKey), ['my-app-pr-1'], 'la revue archivée reste lisible par l’agent');
    assert.equal((await asAgent('/reviews/my-app-pr-1/threads')).status, 200);
    assert.equal((await asAgent('/reviews/my-app-pr-1/archive', { method: 'POST' })).status, 403, 'l’accès de lecture n’archive pas');
    assert.equal((await asAgent('/reviews/my-app-pr-1/deployments/pr-1-d', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 403, 'l’accès de lecture n’importe pas');
  } finally {
    await service.stop();
  }
});
