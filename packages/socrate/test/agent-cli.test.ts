import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REPO_ROOT, localPath } from '../../../tools/local/local-run.ts';
import { startBench, importDemo, demoManifest, sessionClient, call, key, threadsPath, ORIGIN, PROJECT, REVIEW, type Bench, type Client } from '../../../apps/service/test/helpers.ts';

const CLI = localPath('packages/socrate/src/cli.ts');
const base = `/v1/projects/${PROJECT}/reviews/${REVIEW}`;

let bench: Bench;
let karim: Client;
let claire: Client;
let repo: string;
let config: string;
let head: string;
const outputs: string[] = [];
const tokens: string[] = [];

type Run = { code: number | null; stdout: string; stderr: string };

/** CLI dans un processus neuf : PATH réduit à un faux `gh`, Node et Git ; `onOut` reçoit la sortie au fil de l'eau ; `input` passe sur l'entrée standard. */
function cli(args: string[], env: Record<string, string> = {}, opts: { input?: string; onOut?: (text: string) => void } = {}): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: repo, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: `${join(repo, '..', 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`, TMPDIR: process.env.TMPDIR!, XDG_CONFIG_HOME: config, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; opts.onOut?.(stdout + stderr); });
    child.stderr.on('data', (d) => { stderr += d; opts.onOut?.(stdout + stderr); });
    child.stdin.end(opts.input ?? '');
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      outputs.push(stdout, stderr);
      resolve({ code, stdout, stderr });
    });
  });
}

/** `socrate login` dont le code affiché est approuvé dans le panneau par `who`, comme le ferait la personne. */
async function login(who: Client, args: string[], env: Record<string, string> = {}): Promise<Run> {
  let approved: Promise<unknown> | null = null;
  const r = await cli(['login', ...args], env, {
    onOut: (text) => {
      const code = /enter the code ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(text)?.[1];
      if (code && !approved) approved = call(who, 'POST', `/v1/projects/${PROJECT}/devices/${code}/approve`).then((a) => assert.equal(a.status, 200, JSON.stringify(a.json)));
    },
  });
  assert.ok(approved, `code affiché : ${r.stdout}${r.stderr}`);
  await approved;
  return r;
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, env: { PATH: '/usr/bin:/bin', GIT_AUTHOR_NAME: 'Dev', GIT_AUTHOR_EMAIL: 'dev@example.test', GIT_COMMITTER_NAME: 'Dev', GIT_COMMITTER_EMAIL: 'dev@example.test', HOME: repo } }).toString().trim();

async function thread(c: Client, body: string): Promise<string> {
  const r = await call(c, 'POST', threadsPath, { kind: 'global', body }, { 'Idempotency-Key': key() });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return r.json.threadId;
}

before(async () => {
  bench = await startBench();
  assert.equal((await importDemo(bench, 'local-1')).status, 201);
  karim = await sessionClient(bench, { deploymentId: 'local-1', sub: 'karim', name: 'Karim Benali', capabilities: ['thread.participate', 'thread.moderate'] });
  claire = await sessionClient(bench, { deploymentId: 'local-1' });
  const root = mkdtempSync(join(REPO_ROOT, '.tmp', 'agent-cli-'));
  repo = join(root, 'app');
  config = join(root, 'config');
  mkdirSync(join(repo, 'web'), { recursive: true });
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(repo, 'socrate.yml'), `service: ${bench.service.url}\nproject: ${PROJECT}\npreviews: ${ORIGIN}\n`);
  // Revue de la pull request 42, au gabarit par défaut pr-{pr} : celle que le faux gh désigne pour la branche courante.
  const imported = await call({ url: bench.service.url, token: bench.importToken }, 'PUT', `/v1/projects/${PROJECT}/reviews/pr-42/deployments/pr-42-1`, {
    commit: 'a1b2c3d4e5f6', buildId: '0042', url: `${ORIGIN}/`, manifest: { ...(await demoManifest()), reviewKey: 'pr-42' },
  });
  assert.equal(imported.status, 201, JSON.stringify(imported.json));
  // Faux gh : la pull request de la branche courante, ou un échec quand GH_FAIL est posé.
  writeFileSync(join(root, 'bin', 'gh'), '#!/bin/sh\nif [ -n "$GH_FAIL" ]; then echo "no pull requests found for branch" >&2; exit 1; fi\necho 42\n');
  chmodSync(join(root, 'bin', 'gh'), 0o755);
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  head = git('rev-parse', 'HEAD');
});
after(async () => { await bench.stop(); });

test('login par code approuvé dans le panneau : jeton rangé en 0600 sous un dossier 0700, jamais affiché', async () => {
  const r = await login(karim, ['--agent', 'Claude'], { HOME: join(config, '..') });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /enter the code [A-Z0-9]{4}-[A-Z0-9]{4} and approve/);
  assert.match(r.stdout, /Only approve if you just ran this command/);
  assert.match(r.stdout, /logged in: Claude acts as Karim Benali on project demo until \d{4}-\d{2}-\d{2} \(review\.read, thread\.participate, thread\.moderate\)/);
  const file = join(config, 'socrate', 'credentials.json');
  assert.equal(statSync(join(config, 'socrate')).mode & 0o777, 0o700);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(stored.tokens.length, 1);
  assert.deepEqual([stored.tokens[0].service, stored.tokens[0].projectId, stored.tokens[0].agent], [bench.service.url, PROJECT, 'Claude']);
  const token = stored.tokens[0].token as string;
  tokens.push(token);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!r.stdout.includes(token) && !r.stderr.includes(token), 'jeton absent des sorties');

  const json = await login(claire, ['--json'], { CODEX_THREAD_ID: 'fil-codex' });
  assert.equal(json.code, 0, json.stderr);
  const out = JSON.parse(json.stdout);
  assert.deepEqual([out.agent, out.actor.displayName, 'token' in out], ['Codex', 'Claire Morel', false], 'agent détecté par l’environnement de Codex, code sur la sortie d’erreur');
  assert.match(json.stderr, /enter the code/);
  const both = JSON.parse(readFileSync(file, 'utf8')).tokens;
  assert.equal(both.length, 2, 'un jeton par agent pour le même projet');
  tokens.push(both[1].token);
  const none = await cli(['login']);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /which agent\? pass --agent/);
});

test('threads, thread, reply, resolve et reopen au nom du dev, avec via, commit et déploiement', async () => {
  const open = await thread(claire, 'Le libellé du rappel est trop long.');
  const several = await cli(['threads', '--review', REVIEW]);
  assert.equal(several.code, 2, 'deux agents connectés : --agent requis');
  assert.match(several.stderr, /several agents are logged in for project demo \(Claude, Codex\): pass --agent/);

  const list = await cli(['threads', '--json'], { CLAUDECODE: '1' });
  assert.equal(list.code, 0, list.stderr);
  assert.deepEqual(JSON.parse(list.stdout), { projectId: PROJECT, reviewKey: 'pr-42', state: 'open', threads: [] }, 'revue de la PR de la branche, lue par gh et le gabarit review');
  const page = JSON.parse((await cli(['threads', '--review', REVIEW, '--state', 'all', '--json'], { CLAUDECODE: '1' })).stdout);
  assert.ok(page.threads.some((t: { threadId: string }) => t.threadId === open));
  const human = await cli(['threads', '--pr', 'abc'], { CLAUDECODE: '1' });
  assert.equal(human.code, 2, '--pr exige un numéro');
  const noPr = await cli(['threads'], { CLAUDECODE: '1', GH_FAIL: '1' });
  assert.equal(noPr.code, 2);
  assert.match(noPr.stderr, /could not be read with gh \(no pull requests found for branch\): pass --pr <number> or --review <key>/);
  const readable = await cli(['threads', '--review', REVIEW, '--agent', 'claude']);
  assert.equal(readable.code, 0, readable.stderr);
  assert.match(readable.stdout, new RegExp(`${open}  open  Claire Morel · .* · general\\n  Le libellé du rappel est trop long\\.`));

  const r = await cli(['reply', open, '-', '--review', REVIEW, '--agent', 'Claude', '--json'], {}, { input: 'Raccourci dans le commit suivant.\n' });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual([JSON.parse(r.stdout).body, JSON.parse(r.stdout).via, JSON.parse(r.stdout).author.displayName], ['Raccourci dans le commit suivant.', 'Claude', 'Karim Benali']);
  const res = await cli(['resolve', open, '--message', 'Corrigé.', '--review', REVIEW, '--agent', 'Claude']);
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.stdout.trim(), `resolved ${open} as Karim Benali via Claude in ${head.slice(0, 7)} (deployment local-1)`, 'commit HEAD par défaut dans un dépôt Git');
  const read = await call(karim, 'GET', `${threadsPath}/${open}`);
  assert.deepEqual(read.json.messages.at(-1).transition, { state: 'resolved', commit: head, deploymentId: 'local-1' });
  const again = await cli(['resolve', open, '--message', 'Encore.', '--review', REVIEW, '--agent', 'Claude']);
  assert.equal(again.code, 1, 'refus du service');
  assert.match(again.stderr, /the Socrate service refused the resolution: 409 state_conflict: retour déjà résolu/);
  const back = await cli(['reopen', open, '--message', 'Régression en recette.', '--review', REVIEW, '--agent', 'Claude']);
  assert.equal(back.code, 0, back.stderr);
  assert.equal(back.stdout.trim(), `reopened ${open} as Karim Benali via Claude`);
  const bare = await cli(['resolve', open, '--message', 'Sans commit.', '--no-commit', '--review', REVIEW, '--agent', 'Claude', '--json']);
  assert.deepEqual(JSON.parse(bare.stdout).transition, { state: 'resolved', commit: null, deploymentId: 'local-1' });

  const detail = await cli(['thread', open, '--review', REVIEW, '--agent', 'Claude']);
  assert.equal(detail.code, 0, detail.stderr);
  assert.match(detail.stdout, /\[2\] Karim Benali · via Claude · .*\n {4}Raccourci dans le commit suivant\./);
  assert.match(detail.stdout, new RegExp(`\\[3\\] Karim Benali · via Claude · resolved in ${head.slice(0, 7)} \\(deployment local-1\\)`));
  assert.match(detail.stdout, /\[4\] Karim Benali · via Claude · reopened/);

  for (const [args, pattern] of [
    [['resolve', open, '--review', REVIEW, '--agent', 'Claude'], /--message is required/],
    [['resolve', open, '--message', ' ', '--review', REVIEW, '--agent', 'Claude'], /--message is empty/],
    [['resolve', open, '--message', 'x', '--commit', 'nope', '--review', REVIEW, '--agent', 'Claude'], /--commit "nope": neither/],
    [['reply', open, '--review', REVIEW, '--agent', 'Claude'], /the message is required/],
    [['thread', '--review', REVIEW], /socrate thread <id>/],
    [['threads', '--review', REVIEW, '--state', 'closed', '--agent', 'Claude'], /--state "closed"/],
    [['threads', '--bogus'], /Unknown option/],
  ] as const) {
    const u = await cli([...args]);
    assert.equal(u.code, 2, `${args.join(' ')} : ${u.stderr}`);
    assert.match(u.stderr, pattern);
  }
  const missing = await cli(['thread', '00000000-0000-0000-0000-000000000000', '--review', REVIEW, '--agent', 'Claude']);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /404 not_found: retour inconnu/);
});

test('thread --captures télécharge la capture vérifiée par son empreinte', async () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new TextEncoder().encode('image fictive '.repeat(40))]);
  const reserved = await call(claire, 'POST', `${base}/targeted`, {
    kind: 'targeted', body: 'Bouton ambigu.',
    target: {
      url: `${ORIGIN}/reglages/rappels`, route: '/reglages/rappels', rect: { x: 10, y: 20, width: 120, height: 36 },
      viewport: { width: 1280, height: 800, devicePixelRatio: 1, scrollX: 0, scrollY: 0 },
      role: 'button', text: 'Enregistrer le rappel', selector: 'button[data-socrate-id="enregistrer"]', html: '<button type="button">Enregistrer le rappel</button>',
    },
    image: { contentType: 'image/png', size: bytes.byteLength, sha256: sha(bytes), width: 1280, height: 800 },
  }, { 'Idempotency-Key': key() });
  assert.equal(reserved.status, 201, JSON.stringify(reserved.json));
  const put = await fetch(`${claire.url}${base}/captures/${reserved.json.captureId}?attempt=${reserved.json.attempt}`, { method: 'PUT', headers: { Authorization: `Bearer ${claire.token}`, Origin: ORIGIN, 'Content-Type': 'image/png' }, body: bytes as BodyInit });
  assert.equal(put.status, 200);
  const done = await call(claire, 'POST', `${base}/captures/${reserved.json.captureId}/commit`, { attempt: reserved.json.attempt });
  assert.equal(done.status, 201, JSON.stringify(done.json));
  const id = done.json.threadId as string;
  const r = await cli(['thread', id, '--review', REVIEW, '--agent', 'Claude', '--captures', 'shots', '--json']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual([out.target.route, out.target.selector, out.target.html], ['/reglages/rappels', 'button[data-socrate-id="enregistrer"]', '<button type="button">Enregistrer le rappel</button>']);
  assert.equal(out.files.capture, join(repo, 'shots', `${id}-capture.png`));
  assert.equal(sha(readFileSync(out.files.capture)), sha(bytes));
});

test('sortie lisible : les caractères de contrôle venus du service sont neutralisés, le JSON reste intact', async () => {
  const hostile = 'Titre\u001b[2J\u001b]0;pris\u0007 et \u009b31m fin\rcaché';
  const id = await thread(claire, hostile);
  for (const args of [['threads', '--review', REVIEW, '--agent', 'Claude'], ['thread', id, '--review', REVIEW, '--agent', 'Claude']]) {
    const r = await cli(args);
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/, args[0]);
    assert.match(r.stdout, /Titre\ufffd\[2J\ufffd\]0;pris\ufffd et \ufffd31m fin[\ufffd ]caché/, args[0]);
  }
  const json = await cli(['thread', id, '--review', REVIEW, '--agent', 'Claude', '--json']);
  assert.equal(JSON.parse(json.stdout).messages[0].body, hostile);
});

/** Relais vers le service qui transmet les écritures puis perd leur réponse tant que `drop` est positif. */
async function lossyProxy(): Promise<{ url: string; drop: (n: number) => void; server: Server }> {
  let drop = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length'].includes(k)) as [string, string][]);
    const upstream = await fetch(`${bench.service.url}${req.url}`, { method: req.method, headers, body: chunks.length ? Buffer.concat(chunks) : undefined });
    const bytes = Buffer.from(await upstream.arrayBuffer());
    if (req.method === 'POST' && drop > 0) {
      drop--;
      res.socket?.destroy();
      return;
    }
    res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('Content-Type') ?? 'application/octet-stream' });
    res.end(bytes);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, drop: (n) => { drop = n; }, server };
}

test('écriture incertaine : la clé est rendue, la relance avec --key ne duplique pas ; mêmes messages, écritures distinctes', async () => {
  const proxy = await lossyProxy();
  try {
    const lossy = join(repo, '..', 'lossy');
    mkdirSync(join(lossy, 'socrate'), { recursive: true });
    const claude = JSON.parse(readFileSync(join(config, 'socrate', 'credentials.json'), 'utf8')).tokens.find((t: { agent: string }) => t.agent === 'Claude');
    writeFileSync(join(lossy, 'socrate', 'credentials.json'), JSON.stringify({ version: 1, tokens: [{ ...claude, service: proxy.url }] }), { mode: 0o600 });
    writeFileSync(join(lossy, 'socrate.yml'), `service: ${proxy.url}\nproject: ${PROJECT}\npreviews: ${ORIGIN}\n`);
    const env = { XDG_CONFIG_HOME: lossy };
    const via = ['--config', join(lossy, 'socrate.yml'), '--review', REVIEW, '--agent', 'Claude'];
    const id = await thread(claire, 'Le bouton déborde sur mobile.');

    proxy.drop(3);
    const lost = await cli(['reply', id, 'Corrigé dans le commit suivant.', ...via, '--json'], env);
    assert.equal(lost.code, 1, lost.stderr);
    const { outcome, idempotencyKey } = JSON.parse(lost.stdout);
    assert.equal(outcome, 'uncertain');
    assert.match(idempotencyKey, /^socrate-cli-[0-9a-f-]{36}$/);
    assert.ok(lost.stderr.includes(`The reply may have been recorded. Run the command again with --key ${idempotencyKey} so as not to duplicate it.`), lost.stderr);
    const retried = await cli(['reply', id, 'Corrigé dans le commit suivant.', ...via, '--key', idempotencyKey, '--json'], env);
    assert.equal(retried.code, 0, retried.stderr);
    const bodies = (await call(karim, 'GET', `${threadsPath}/${id}`)).json.messages.map((m: { body: string }) => m.body);
    assert.deepEqual(bodies, ['Le bouton déborde sur mobile.', 'Corrigé dans le commit suivant.'], 'une seule réponse enregistrée');

    for (const command of ['resolve', 'reopen', 'resolve']) {
      const r = await cli([command, id, '--message', 'Même message.', ...via, ...(command === 'resolve' ? ['--no-commit'] : [])], env);
      assert.equal(r.code, 0, `${command} : ${r.stderr}`);
    }
    const transitions = (await call(karim, 'GET', `${threadsPath}/${id}`)).json.messages.filter((m: { transition: unknown }) => m.transition).map((m: { transition: { state: string } }) => m.transition.state);
    assert.deepEqual(transitions, ['resolved', 'open', 'resolved'], 'trois écritures, aucune clé tirée du contenu');

    for (const [args, pattern] of [
      [['reply', id, 'x', ...via, '--key', 'court'], /--key "court": 8 to 128/],
      [['threads', ...via, '--key', 'socrate-cli-0000'], /threads takes no --key/],
    ] as const) {
      const u = await cli([...args], env);
      assert.equal(u.code, 2, u.stderr);
      assert.match(u.stderr, pattern);
    }
  } finally {
    proxy.server.close();
  }
});

test('révocation dans le panneau puis logout : la commande suivante échoue et le jeton quitte le fichier', async () => {
  const file = join(config, 'socrate', 'credentials.json');
  const stored = () => JSON.parse(readFileSync(file, 'utf8')).tokens as { agent: string; tokenId: string; token: string }[];
  const claude = stored().find((t) => t.agent === 'Claude')!;
  assert.equal((await call(karim, 'POST', `/v1/projects/${PROJECT}/agents/${claude.tokenId}/revoke`)).status, 200);
  const stale = await cli(['logout', '--agent', 'Claude']);
  assert.equal(stale.code, 0, 'un jeton déjà révoqué est retiré localement');
  assert.match(stale.stdout, /was already revoked or expired/);

  const codex = stored().find((t) => t.agent === 'Codex')!;
  assert.equal((await call(claire, 'POST', `/v1/projects/${PROJECT}/agents/${codex.tokenId}/revoke`)).status, 200);
  const after = await cli(['threads', '--review', REVIEW, '--agent', 'Codex']);
  assert.equal(after.code, 1);
  assert.match(after.stderr, /401 unauthenticated: jeton délégué révoqué; the token was removed from the credentials file: run npx @meyer0x\/socrate login again/);
  assert.deepEqual(stored(), [], 'le jeton refusé a quitté le fichier');
  assert.equal(statSync(file).mode & 0o777, 0o600, 'fichier réécrit en 0600');
  const gone = await cli(['threads', '--review', REVIEW, '--agent', 'Codex']);
  assert.equal(gone.code, 2);
  assert.match(gone.stderr, /no Codex login for project demo on .*: run npx @meyer0x\/socrate login --agent Codex/);

  const again = await login(claire, ['--agent', 'Codex']);
  assert.equal(again.code, 0, again.stderr);
  tokens.push(stored()[0]!.token);
  const out = await cli(['logout', '--agent', 'Codex']);
  assert.equal(out.code, 0, out.stderr);
  assert.match(out.stdout, /logged out: Codex token for project demo revoked/);
  assert.deepEqual(stored(), []);

  const all = outputs.join('\n');
  assert.equal(tokens.length, 3);
  for (const t of tokens) assert.ok(!all.includes(t), 'aucun jeton dans aucune sortie, erreurs comprises');
});
