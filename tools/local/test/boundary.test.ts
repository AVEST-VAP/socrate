import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { existsSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { BROWSERS_DIR, LocalRefusal, REPO_ROOT, TMPDIR, allowPort, deadlineIn, guardedPath, instanceName, localCommand, localFetch, localPath, runtime, tcpProbe, transportCallCount } from '../local-run.ts';

const run = promisify(execFile);
const symlinkRefusal = (part: RegExp) => (e: Error) => e instanceof LocalRefusal && e.reason === 'symlink' && part.test(e.message);
const sources = (): string[] => {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (['node_modules', 'dist', 'artifacts', '.local', '.tmp', '.git', '.worktrees'].includes(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|mjs)$/.test(entry.name)) out.push(relative(REPO_ROOT, full));
    }
  };
  for (const top of ['apps', 'packages', 'tools', '.agents']) walk(join(REPO_ROOT, top));
  return out;
};

test('contrôle structurel : bibliothèques et routes navigateur seulement derrière la frontière locale', () => {
  const files = sources();
  const offenders: string[] = [];
  const rules: Array<[RegExp, string[]]> = [
    [/^import (?!type )[^;]*from ['"]playwright['"]/m, ['tools/local/browser.ts']],
    [/^import [^;]*from ['"]miniflare['"]/m, ['tools/local/runtime.ts']],
    [/^import [^;]*from ['"]esbuild['"]/m, []],
    [/import\(['"]esbuild['"]\)/, ['tools/local/build-worker.ts', 'tools/local/build-package.ts', 'tools/local/test/boundary.test.ts']],
    [/['"]node:sqlite['"]/, ['tools/local/runtime.ts']],
    [/^import (?!type )[^;]*from ['"][./]*\/(runtime|browser)\.ts['"]/m, ['tools/local/local-run.ts']],
    [/\.route\(|\.routeWebSocket\(|route\.(fetch|continue|fulfill|abort)\(/, ['tools/local/browser.ts']],
    [/applyLocalEnv|unlockStaleRoot|demo-stack|local-env|acquireRootLock/, ['tools/local/test/boundary.test.ts']],
  ];
  for (const file of files) {
    const text = readFileSync(join(REPO_ROOT, file), 'utf8');
    for (const [pattern, allowed] of rules) if (pattern.test(text) && !allowed.includes(file)) offenders.push(`${file} : ${pattern}`);
  }
  assert.deepEqual(offenders, []);
  assert.match(readFileSync(join(REPO_ROOT, '.npmrc'), 'utf8'), /^cache=\.local\/npm-cache$/m, 'le cache npm est imposé dès npm ci par .npmrc');
  const buildEntry = readFileSync(join(REPO_ROOT, 'tools/local/build-worker.ts'), 'utf8');
  assert.ok(buildEntry.indexOf("from './local-run.ts'") < buildEntry.indexOf("import('esbuild')"), 'build-worker.ts traverse la frontière locale avant de charger esbuild');
  const scripts = (JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
  for (const [name, command] of Object.entries(scripts)) {
    if (name === 'typecheck' || name === 'verify') continue;
    assert.match(command, /^(npm run build:worker && )?node (--test --test-concurrency=1 )?(tools\/local\/(build-worker|demo|nettoyer-captures|sauvegarde|parcours-local|browser-tests|measure-demo|distant|assemble|serve)\.ts|apps\/service\/test\/\*\.test\.ts packages\/contract\/test\/\*\.test\.ts tools\/local\/test\/\*\.test\.ts)/, `entrée npm ${name} hors des entrées sous frontière : ${command}`);
  }
});

test('entrée build:worker en processus neuf : bootstrap avant esbuild, sortie validée sous le dépôt, destination héritée jamais visitée', async () => {
  const foreignTmp = `${REPO_ROOT}-bis/tmp-herite`;
  const { stdout } = await run(process.execPath, [join(REPO_ROOT, 'tools/local/build-worker.ts')], { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TMPDIR: foreignTmp, NODE_OPTIONS: '--no-warnings' }, cwd: REPO_ROOT });
  assert.equal(stdout.trim(), `worker bundle: ${join(REPO_ROOT, 'apps/service/dist/worker.mjs')} (TMPDIR ${TMPDIR})`);
  assert.ok(existsSync(join(REPO_ROOT, 'apps/service/dist/worker.mjs')));
  assert.ok(!existsSync(`${REPO_ROOT}-bis`), 'la destination héritée n’est jamais créée ni visitée');
  const rt = await runtime();
  await assert.rejects(rt.buildWorker(`${REPO_ROOT}-bis/worker.mjs`), (e: Error) => e instanceof LocalRefusal && e.reason === 'path_outside', 'chemin de sortie hors dépôt refusé avant esbuild');
});

test('bootstrap : un .tmp préexistant en lien symbolique est refusé avant le mkdir, sans effet sur sa destination ; un vrai dossier est accepté', async () => {
  const bench = await mkdtemp(join(REPO_ROOT, '.tmp', 'bootstrap-'));
  const target = join(bench, 'destination-possedee');
  await mkdir(target);
  const fixture = async (name: string, tmpAsLink: boolean) => {
    const repo = join(bench, name);
    await mkdir(join(repo, 'tools/local'), { recursive: true });
    await copyFile(join(REPO_ROOT, 'tools/local/local-run.ts'), join(repo, 'tools/local/local-run.ts'));
    if (tmpAsLink) await symlink(target, join(repo, '.tmp'));
    const result = await run(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(join(repo, 'tools/local/local-run.ts'))}); console.log(process.env.TMPDIR);`], { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '' }, cwd: REPO_ROOT }).then((r) => ({ ok: true as const, stdout: r.stdout }), (e: Error & { stderr?: string; code?: number }) => ({ ok: false as const, stderr: e.stderr ?? e.message }));
    return { repo, result };
  };
  const linked = await fixture('repo-lien', true);
  assert.equal(linked.result.ok, false, 'l’import du module copié échoue');
  assert.match((linked.result as { stderr: string }).stderr, /lien symbolique refusé sur le chemin : \.tmp/);
  assert.ok(!existsSync(join(target, 'tmp')), 'rien n’est créé derrière le lien');
  assert.deepEqual(readdirSync(target), [], 'destination intacte');
  const plain = await fixture('repo-dossier', false);
  assert.equal(plain.result.ok, true, JSON.stringify(plain.result));
  assert.equal((plain.result as { stdout: string }).stdout.trim(), join(plain.repo, '.tmp/tmp'));
  assert.ok(existsSync(join(plain.repo, '.tmp/tmp')));
});

test('fichiers frères du verrou et de l’enregistrement : un lien préexistant est refusé avant l’ouverture SQLite ou la lecture, sans visiter sa destination', async () => {
  const rt = await runtime();
  const bench = await mkdtemp(join(REPO_ROOT, '.tmp', 'siblings-'));
  const elsewhere = join(bench, 'ailleurs');
  await mkdir(elsewhere);
  const root = join(bench, 'instance');
  await mkdir(root);
  await symlink(join(elsewhere, 'verrou.db'), rt.lockPathOf(root));
  assert.throws(() => rt.claimRoot(root), (e: Error) => e instanceof LocalRefusal && e.reason === 'symlink' && /instance\.lock\.db/.test(e.message));
  await assert.rejects(rt.launchInstance({ root, name: 'siblings', ports: { service: 0, demo: 0 }, reset: true, deadline: deadlineIn(5_000) }), (e: Error) => e instanceof LocalRefusal && e.reason === 'symlink');
  assert.deepEqual(readdirSync(elsewhere), [], 'aucune base SQLite créée derrière le lien');
  assert.ok(!existsSync(rt.recordPathOf(root)) && !existsSync(join(root, 'worker.mjs')), 'aucun effet du lancement refusé');
  const root2 = join(bench, 'instance-2');
  await mkdir(root2);
  await symlink(join(elsewhere, 'owner.json'), rt.recordPathOf(root2));
  await assert.rejects(rt.readRecord(root2), (e: Error) => e instanceof LocalRefusal && e.reason === 'symlink');
  await assert.rejects(rt.writePrivateFile(rt.recordPathOf(root2), '{}'), (e: Error) => e instanceof LocalRefusal && e.reason === 'symlink');
  assert.deepEqual(readdirSync(elsewhere), [], 'rien n’est lu ni écrit derrière le lien de l’enregistrement');
  assert.throws(() => guardedPath(`${REPO_ROOT}-bis/x`), (e: Error) => e instanceof LocalRefusal && e.reason === 'path_outside');
});

test('chemins feuilles sous une racine valide : persist, bundle existant, dossier credentials, fichier token et clé privée en lien symbolique sont refusés avant remise à Miniflare, digest ou lecture, destination jamais visitée ; l’hôte refuse aussi de lire la clé liée', async () => {
  const rt = await runtime();
  const bench = await mkdtemp(join(REPO_ROOT, '.tmp', 'leaves-'));
  const elsewhere = join(bench, 'ailleurs');
  await mkdir(elsewhere);
  await writeFile(join(elsewhere, 'temoin.txt'), 'destination intacte');
  const untouched = () => assert.deepEqual(readdirSync(elsewhere), ['temoin.txt'], 'aucune création derrière un lien');
  const projects = async () => [{ projectId: 'demo', issuer: 'demo-host', publicJwk: (await rt.generateIssuerKeys()).publicJwk, attestableCapabilities: [] as never[] }];

  const persistRoot = join(bench, 'persist');
  await mkdir(persistRoot);
  await symlink(join(elsewhere, 'persist-cible'), join(persistRoot, 'persist'));
  await assert.rejects(rt.startService({ root: persistRoot, projects: await projects(), migrate: false }), symlinkRefusal(/persist$/), 'persist lié refusé avant la construction de Miniflare');
  untouched();

  const bundleRoot = join(bench, 'bundle');
  await mkdir(bundleRoot);
  await symlink(join(elsewhere, 'worker.mjs'), join(bundleRoot, 'worker.mjs'));
  await assert.rejects(rt.startService({ root: bundleRoot, bundlePath: join(bundleRoot, 'worker.mjs'), projects: await projects(), migrate: false }), symlinkRefusal(/worker\.mjs$/), 'bundle existant lié refusé avant existsSync et digest');
  untouched();

  const credRoot = join(bench, 'credentials');
  await mkdir(credRoot);
  const service = await rt.startService({ root: credRoot, projects: await projects() });
  try {
    const spec = { import: { projectId: 'demo', label: 'ci-demo', capabilities: ['deployment.import' as const] } };
    await symlink(join(elsewhere, 'credentials-cible'), join(credRoot, 'credentials'));
    await assert.rejects(rt.reconcileCredentials(service.db, join(credRoot, 'credentials'), spec), symlinkRefusal(/credentials$/), 'dossier credentials lié refusé avant lecture');
    await rm(join(credRoot, 'credentials'));
    await mkdir(join(credRoot, 'credentials'));
    await symlink(join(elsewhere, 'import.token'), join(credRoot, 'credentials/import.token'));
    await assert.rejects(rt.reconcileCredentials(service.db, join(credRoot, 'credentials'), spec), symlinkRefusal(/import\.token$/), 'fichier token lié refusé avant lecture');
    untouched();
    assert.equal((await service.db.prepare('SELECT COUNT(*) AS n FROM technical_credentials').first<{ n: number }>())!.n, 0, 'aucun accès émis après un refus de chemin');
  } finally {
    await service.stop();
  }

  const keyRoot = join(bench, 'key');
  await mkdir(join(keyRoot, 'keys'), { recursive: true });
  const keys = await rt.generateIssuerKeys();
  await writeFile(join(keyRoot, 'keys/issuer-public.jwk.json'), JSON.stringify(keys.publicJwk));
  await symlink(join(elsewhere, 'issuer-private.jwk.json'), join(keyRoot, 'keys/issuer-private.jwk.json'));
  const lines: string[] = [];
  await assert.rejects(rt.launchInstance({ root: keyRoot, name: 'leaf-key', ports: { service: 0, demo: 0 }, reset: false, deadline: deadlineIn(10_000), log: (l) => lines.push(l) }), symlinkRefusal(/issuer-private\.jwk\.json$/), 'clé privée liée refusée avant existsSync, aucune génération par-dessus');
  untouched();
  assert.ok(!existsSync(join(keyRoot, 'worker.mjs')) && !lines.some((l) => l.startsWith('ressource ')), `aucune ressource créée : ${lines.join('\n')}`);
  const record = await rt.readRecord(keyRoot);
  assert.ok(record && record !== 'unreadable' && record.state === 'closed' && Object.keys(record.resources).length === 0, JSON.stringify(record));

  await writeFile(join(keyRoot, 'preview-context.json'), JSON.stringify({ serviceUrl: 'http://127.0.0.1:1', projectId: 'demo', reviewKey: 'r', deploymentId: 'd', origin: 'http://127.0.0.1:1', issuer: 'demo-host', audience: 'socrate', instanceId: 'x' }));
  const hostPort = await new Promise<number>((r) => {
    const probe = createTcpServer();
    probe.listen(0, '127.0.0.1', () => { const port = (probe.address() as { port: number }).port; probe.close(() => r(port)); });
  });
  const host = await run(process.execPath, [localPath('node_modules/vite/bin/vite.js'), '--clearScreen', 'false'], {
    cwd: localPath('apps/demo'), timeout: 30_000, killSignal: 'SIGTERM',
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TMPDIR, SOCRATE_RUNTIME_DIR: keyRoot, SOCRATE_DEMO_PORT: String(hostPort), BROWSER: 'none', VITE_CONFIG_NATIVE_IGNORE_WARNING: 'true' },
  }).then(() => ({ ok: true as const }), (e: Error & { stderr?: string; stdout?: string; code?: number | string }) => ({ ok: false as const, text: `${e.stdout ?? ''}${e.stderr ?? ''}`, code: e.code }));
  assert.equal(host.ok, false, 'l’hôte refuse de démarrer avec une clé privée liée');
  assert.match((host as { text: string }).text, /lien symbolique refusé sur le chemin : .*issuer-private\.jwk\.json/);
  assert.equal(await tcpProbe(hostPort), 'refused', 'aucun hôte en écoute après le refus');
  untouched();
});

test('doctor par la vraie entrée localCommand : un bundle d’instance en lien symbolique est refusé avant existsSync et digest, propriétaire non ready compris, lien conservé et destination jamais lue ; un vrai bundle est lu et digéré', async () => {
  const rt = await runtime();
  const name = `leaf-doctor-${crypto.randomUUID().slice(0, 8)}`;
  const root = rt.instanceRoot(name);
  const bench = await mkdtemp(join(REPO_ROOT, '.tmp', 'doctor-leaf-'));
  const elsewhere = join(bench, 'ailleurs');
  await mkdir(elsewhere);
  await writeFile(join(elsewhere, 'bundle-fictif.mjs'), 'export default {};\n');
  await mkdir(root, { recursive: true });
  await rt.writePrivateFile(rt.recordPathOf(root), JSON.stringify({ generation: crypto.randomUUID(), pid: process.pid, startedAt: new Date().toISOString(), state: 'closed', ports: { service: 0, demo: 0 }, resources: {} }));
  const doctor = () => localCommand({ action: 'doctor', instance: name, deadlineMs: 5_000 }) as Promise<{ kind: string; reason?: string; detail?: string; checks?: Record<string, { ok: boolean; detail: string }> }>;
  const bundle = join(root, 'worker.mjs');
  try {
    await symlink(join(elsewhere, 'bundle-fictif.mjs'), bundle);
    const linked = await doctor();
    assert.deepEqual({ kind: linked.kind, reason: linked.reason }, { kind: 'refused', reason: 'symlink' }, JSON.stringify(linked));
    assert.match(linked.detail!, /worker\.mjs$/);
    assert.equal(linked.checks, undefined, 'aucun contrôle rendu : le refus précède existsSync et le digest');
    assert.equal(readlinkSync(bundle), join(elsewhere, 'bundle-fictif.mjs'), 'le lien est conservé, jamais résolu par suppression');
    await rm(bundle);
    await symlink(join(elsewhere, 'absent.mjs'), bundle);
    const dangling = await doctor();
    assert.equal(dangling.reason, 'symlink', `un lien pendant serait compté « bundle absent » s’il était suivi : il est refusé avant existsSync (${JSON.stringify(dangling)})`);
    await rm(bundle);
    await copyFile(join(elsewhere, 'bundle-fictif.mjs'), bundle);
    const plain = await doctor();
    assert.equal(plain.reason, 'unhealthy', JSON.stringify(plain));
    assert.match(plain.checks!.build!.detail, /bundle [0-9a-f]{12}/, 'un vrai bundle est lu et son digest calculé');
    assert.deepEqual(readdirSync(elsewhere), ['bundle-fictif.mjs'], 'destination intacte');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(rt.recordPathOf(root), { force: true });
  }
});

test('descendants du stockage : un lien préexistant sous persist, dont le dossier d1 et le dossier des bases que Miniflare utilise, est refusé avant toute construction de Miniflare, lien conservé, destination jamais créée ni visitée ; les vrais descendants d’un stockage antérieur restent admis', { skip: 'retenu, fermeture à borner : ressource acquise avant une fermeture complète bornée sur chaque sortie ; ne vaut pas PASS' }, async () => {
  const rt = await runtime();
  const bench = await mkdtemp(join(REPO_ROOT, '.tmp', 'persist-tree-'));
  const elsewhere = join(bench, 'ailleurs');
  await mkdir(elsewhere);
  await writeFile(join(elsewhere, 'temoin.txt'), 'destination intacte');
  const untouched = () => assert.deepEqual(readdirSync(elsewhere), ['temoin.txt'], 'rien n’est créé ni visité derrière un lien');
  const root = join(bench, 'instance');
  await mkdir(root);
  const projects = [{ projectId: 'demo', issuer: 'demo-host', publicJwk: (await rt.generateIssuerKeys()).publicJwk, attestableCapabilities: [] as never[] }];
  const first = await rt.startService({ root, projects });
  try {
    await first.db.prepare("INSERT INTO reviews (project_id, review_key, state, created_at) VALUES ('demo', 'temoin-persist', 'active', '2026-10-16T00:00:00Z')").run();
  } finally {
    await first.stop();
  }
  const d1 = join(root, 'persist', 'd1');
  const databases = readdirSync(d1, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(d1, e.name));
  assert.ok(databases.length > 0, `Miniflare a créé le stockage D1 sous ${d1} : ${readdirSync(d1).join(', ')}`);
  const refused = async (part: RegExp) => {
    const events: string[] = [];
    const closers: Array<() => Promise<void>> = [];
    try {
      await assert.rejects(rt.startService({ root, projects, creating: async () => { events.push('creating'); }, own: (close) => { events.push('own'); closers.push(close); } }), symlinkRefusal(part));
      assert.deepEqual(events, [], 'refus avant l’annonce creating, donc avant toute construction de Miniflare');
      untouched();
    } finally {
      for (const close of closers) await close();
    }
  };
  await rename(d1, `${d1}.reel`);
  await symlink(join(elsewhere, 'd1-cible'), d1);
  await refused(/persist\/d1$/);
  assert.equal(readlinkSync(d1), join(elsewhere, 'd1-cible'), 'le lien d1 est conservé, jamais résolu par suppression');
  await rm(d1);
  await rename(`${d1}.reel`, d1);
  const deep = join(databases[0]!, 'base-fictive.sqlite');
  await symlink(join(elsewhere, 'base-cible.sqlite'), deep);
  await refused(/base-fictive\.sqlite$/);
  await rm(deep);
  const again = await rt.startService({ root, projects });
  try {
    const row = await again.db.prepare("SELECT COUNT(*) AS n FROM reviews WHERE review_key = 'temoin-persist'").first<{ n: number }>();
    assert.equal(row!.n, 1, 'les vrais descendants du stockage antérieur sont réutilisés sans refus');
  } finally {
    await again.stop();
  }
  untouched();
});

test('processus Node frais sans export : environnement fixé à l’import, exécutable Chromium sous .local/pw-browsers avant tout lancement, TMPDIR hérité ignoré sans visite', async () => {
  const foreignTmp = `${REPO_ROOT}-bis/tmp-herite`;
  const script = `const m = await import(${JSON.stringify(join(REPO_ROOT, 'tools/local/local-run.ts'))}); const b = await m.browser(); console.log(JSON.stringify({ exe: b.browserExecutablePath(), tmp: process.env.TMPDIR, tmp2: process.env.TMP, pw: process.env.PLAYWRIGHT_BROWSERS_PATH, npm: process.env.npm_config_cache }));`;
  const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script], { env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TMPDIR: foreignTmp, PLAYWRIGHT_BROWSERS_PATH: '/nulle-part' }, cwd: REPO_ROOT });
  const facts = JSON.parse(stdout.trim()) as { exe: string; tmp: string; tmp2: string; pw: string; npm: string };
  assert.ok(facts.exe.startsWith(`${BROWSERS_DIR}/`), `exécutable ${facts.exe}`);
  assert.ok(existsSync(facts.exe), 'exécutable présent');
  assert.equal(facts.tmp, TMPDIR);
  assert.equal(facts.tmp2, TMPDIR);
  assert.equal(facts.pw, BROWSERS_DIR);
  assert.equal(facts.npm, join(REPO_ROOT, '.local/npm-cache'));
  assert.ok(!existsSync(`${REPO_ROOT}-bis`), 'la destination héritée n’est jamais créée ni visitée');
});

test('nom d’instance, traversées, préfixe voisin et liens symboliques refusés avant tout effet', async () => {
  for (const bad of ['../x', 'Demo', '', 'a'.repeat(49), 'demo/x', 'demo.lock', undefined, 42]) assert.throws(() => instanceName(bad), (e: Error) => e instanceof LocalRefusal && e.reason === 'instance_invalid', String(bad));
  assert.equal(instanceName('demo-2'), 'demo-2');
  for (const bad of [['..'], ['../socrate-bis/x'], ['/etc/passwd'], [`${REPO_ROOT}-bis/x`], ['.tmp', '..', '..', 'x']]) assert.throws(() => localPath(...bad), (e: Error) => e instanceof LocalRefusal && e.reason === 'path_outside', bad.join('/'));
  assert.equal(localPath('.tmp', 'x'), join(REPO_ROOT, '.tmp/x'));
  const bench = await mkdtemp(join(REPO_ROOT, '.tmp', 'symlink-'));
  await mkdir(join(bench, 'cible'));
  await symlink(join(bench, 'cible'), join(bench, 'lien'));
  const rel = relative(REPO_ROOT, bench);
  assert.throws(() => localPath(rel, 'lien', 'enfant'), (e: Error) => e instanceof LocalRefusal && e.reason === 'symlink');
  assert.throws(() => localPath(rel, 'lien'), (e: Error) => e instanceof LocalRefusal && e.reason === 'symlink');
  assert.equal(localPath(rel, 'cible', 'enfant'), join(bench, 'cible/enfant'));
});

test('garde réseau Node : destinations hors loopback et ports non possédés refusés avant transport, redirection refusée avant suivi', { skip: 'retenu, fermeture à borner : ressource acquise avant une fermeture complète bornée sur chaque sortie ; ne vaut pas PASS' }, async () => {
  const before = transportCallCount();
  for (const url of ['http://example.invalid/', 'http://192.0.2.1/', 'https://127.0.0.1:1/', 'http://localhost:1/', 'http://user:pw@127.0.0.1:1/', 'http://127.0.0.1:9/']) {
    await assert.rejects(fetch(url), (e: Error) => e instanceof LocalRefusal && e.reason === 'network_refused', url);
  }
  assert.equal(transportCallCount(), before, 'aucun appel au transport natif');
  const witness = createServer((req, res) => {
    if (req.url === '/redir') res.writeHead(302, { Location: 'http://192.0.2.1/' }).end();
    else res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
  });
  await new Promise<void>((r) => witness.listen(0, '127.0.0.1', () => r()));
  const port = (witness.address() as { port: number }).port;
  const revoke = allowPort(port);
  const ok = await localFetch(`http://127.0.0.1:${port}/ok`, deadlineIn(2_000));
  assert.deepEqual(ok.json, { ok: true });
  await assert.rejects(fetch(`http://127.0.0.1:${port}/redir`), (e: Error) => /redirect/i.test(e.message) || e.name === 'TypeError');
  assert.equal(transportCallCount(), before + 2, 'les deux requêtes loopback admises, aucune vers la destination de redirection');
  revoke();
  await assert.rejects(fetch(`http://127.0.0.1:${port}/ok`), (e: Error) => e instanceof LocalRefusal, 'port révoqué');
  witness.closeAllConnections();
  await new Promise<void>((r) => witness.close(() => r()));
});

test('délais réels : serveur muet et corps incomplet bornés par l’échéance, sans attendre le délai système', { skip: 'retenu, fermeture à borner : ressource acquise avant une fermeture complète bornée sur chaque sortie ; ne vaut pas PASS' }, async () => {
  const sockets = new Set<import('node:net').Socket>();
  const silent = createTcpServer((socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>((r) => silent.listen(0, '127.0.0.1', () => r()));
  const partial = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"instanceId":"abc","ok":tr');
  });
  await new Promise<void>((r) => partial.listen(0, '127.0.0.1', () => r()));
  const pSilent = (silent.address() as { port: number }).port;
  const pPartial = (partial.address() as { port: number }).port;
  const revokes = [allowPort(pSilent), allowPort(pPartial)];
  for (const port of [pSilent, pPartial]) {
    const started = Date.now();
    await assert.rejects(localFetch(`http://127.0.0.1:${port}/api/preview-context`, deadlineIn(600)), (e: Error) => e.name === 'TimeoutError' || /abort|timeout/i.test(e.message));
    assert.ok(Date.now() - started < 3_000, `échec en ${Date.now() - started} ms sur le port ${port}`);
  }
  await assert.rejects(localFetch(`http://127.0.0.1:${pSilent}/x`, { at: performance.now() - 1 }), (e: Error) => e instanceof LocalRefusal && e.reason === 'deadline');
  revokes.forEach((r) => r());
  for (const s of sockets) s.destroy();
  await new Promise<void>((r) => silent.close(() => r()));
  partial.closeAllConnections();
  await new Promise<void>((r) => partial.close(() => r()));
});
