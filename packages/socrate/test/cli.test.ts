import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';
import { REPO_ROOT, localPath } from '../../../tools/local/local-run.ts';

const CLI = localPath('packages/socrate/src/cli.ts');
const SHA = '0123456789abcdef0123456789abcdef01234567';
const ORIGIN = 'https://feature-x.my-app.pages.dev';
const GITHUB_TOKEN = 'ghs_fictional-token-for-tests-0001';

type Run = { code: number | null; stdout: string; stderr: string };
function cli(args: string[], cwd: string, env: Record<string, string>): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH!, TMPDIR: process.env.TMPDIR!, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/** API GitHub simulée : une pull request dont les labels changent entre deux appels, comme après un ajout de label. */
async function fakeGitHub(pr: { title: string; labels: string[] }): Promise<{ url: string; calls: { path: string; auth: string | undefined }[]; server: Server }> {
  const calls: { path: string; auth: string | undefined }[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    calls.push({ path: req.url ?? '', auth: req.headers.authorization });
    if (req.headers.authorization !== `Bearer ${GITHUB_TOKEN}`) return void res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"message":"Bad credentials"}');
    if (req.url !== '/repos/my-org/my-app/pulls/42') return void res.writeHead(404, { 'Content-Type': 'application/json' }).end('{"message":"Not Found"}');
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ number: 42, title: pr.title, labels: pr.labels.map((name) => ({ name })) }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, calls, server };
}

function workspace(yaml: string, event: unknown): { dir: string; files: { env: string; output: string; event: string } } {
  const root = mkdtempSync(join(REPO_ROOT, '.tmp', 'cli-'));
  mkdirSync(join(root, '.git'));
  mkdirSync(join(root, 'web'));
  writeFileSync(join(root, 'socrate.yml'), yaml);
  const files = { env: join(root, 'github.env'), output: join(root, 'github.output'), event: join(root, 'event.json') };
  writeFileSync(files.env, '');
  writeFileSync(files.output, '');
  writeFileSync(files.event, JSON.stringify(event));
  return { dir: root, files };
}

const EVENT = { action: 'synchronize', pull_request: { number: 42, head: { sha: SHA }, labels: [] } };
const actionsEnv = (files: { env: string; output: string; event: string }, api: string, name = 'pull_request') => ({
  GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: files.event, GITHUB_ENV: files.env, GITHUB_OUTPUT: files.output,
  GITHUB_TOKEN, GITHUB_API_URL: api, GITHUB_REPOSITORY: 'my-org/my-app', GITHUB_RUN_ID: '991', GITHUB_RUN_ATTEMPT: '2',
});

test('preview prepare : label lu en direct, contexte écrit dans GITHUB_ENV, sorties enabled, review et deployment', async () => {
  const yaml = 'service: https://my-socrate.example.workers.dev\nproject: my-app\npreviews: https://*.my-app.pages.dev\nlabel: socrate\n';
  const pr = { title: 'Automatic reminders', labels: ['bug'] };
  const github = await fakeGitHub(pr);
  try {
    const { dir, files } = workspace(yaml, EVENT);
    const env = actionsEnv(files, github.url);

    const off = await cli(['preview', 'prepare', '--origin', ORIGIN], join(dir, 'web'), env);
    assert.equal(off.code, 0, off.stderr);
    assert.equal(readFileSync(files.output, 'utf8'), 'enabled=false\n');
    assert.equal(readFileSync(files.env, 'utf8'), '', 'sans label, rien d’autre n’est écrit');
    assert.match(off.stdout, /pull request #42 has no "socrate" label/);
    assert.deepEqual(github.calls, [{ path: '/repos/my-org/my-app/pulls/42', auth: `Bearer ${GITHUB_TOKEN}` }]);

    pr.labels.push('socrate');
    writeFileSync(files.output, '');
    const on = await cli(['preview', 'prepare', '--origin', ORIGIN], join(dir, 'web'), env);
    assert.equal(on.code, 0, on.stderr);
    const deployment = 'pr-42-0123456789ab-991-2';
    assert.equal(readFileSync(files.output, 'utf8'), `enabled=true\nreview=pr-42\ndeployment=${deployment}\n`);
    const lines = readFileSync(files.env, 'utf8').split('\n');
    assert.equal(lines.length, 2, 'une seule ligne, close par un saut de ligne');
    assert.ok(lines[0]!.startsWith('SOCRATE_PREVIEW='));
    assert.deepEqual(JSON.parse(lines[0]!.slice('SOCRATE_PREVIEW='.length)), {
      serviceUrl: 'https://my-socrate.example.workers.dev', projectId: 'my-app', reviewKey: 'pr-42', deploymentId: deployment, origin: ORIGIN,
      pullRequest: 42, commit: SHA, buildId: '991-2', title: 'Automatic reminders', repository: 'my-org/my-app',
    });
    assert.ok(!on.stdout.includes(GITHUB_TOKEN) && !on.stderr.includes(GITHUB_TOKEN));

    const push = await cli(['preview', 'prepare', '--origin', ORIGIN], dir, actionsEnv(files, github.url, 'push'));
    assert.equal(push.code, 0, push.stderr);
    assert.match(push.stdout, /event push is not pull_request/);
    assert.equal(github.calls.length, 2, 'hors pull_request, aucun appel à l’API');
    const broken = workspace('service: http://not-https.example\n', EVENT);
    const pushBroken = await cli(['preview', 'prepare', '--origin', ORIGIN], broken.dir, actionsEnv(broken.files, github.url, 'push'));
    assert.equal(pushBroken.code, 0, `hors pull_request, socrate.yml n’est pas lu : ${pushBroken.stderr}`);
    assert.equal(readFileSync(broken.files.output, 'utf8'), 'enabled=false\n');
    assert.match((await cli(['preview', 'prepare', '--origin', ORIGIN], broken.dir, actionsEnv(broken.files, github.url))).stderr, /socrate\.yml is invalid/, 'en pull request, il l’est');

    const outside = await cli(['preview', 'prepare', '--origin', 'https://feature-x.other.pages.dev'], dir, env);
    assert.equal(outside.code, 1);
    assert.match(outside.stderr, /--origin https:\/\/feature-x\.other\.pages\.dev does not match previews \(https:\/\/\*\.my-app\.pages\.dev\)/);
    const path = await cli(['preview', 'prepare', '--origin', `${ORIGIN}/app`], dir, env);
    assert.match(path.stderr, /is not an origin/);

    const denied = await cli(['preview', 'prepare', '--origin', ORIGIN], dir, { ...env, GITHUB_TOKEN: 'ghs_wrong-token-value-0002' });
    assert.equal(denied.code, 1);
    assert.match(denied.stderr, /GitHub API answered 401 to GET .*pulls\/42: Bad credentials/);
    assert.ok(!denied.stderr.includes('ghs_wrong-token-value-0002'), 'le jeton n’apparaît jamais');

    const { GITHUB_ENV: _, ...noEnv } = env;
    const outsideActions = await cli(['preview', 'prepare', '--origin', ORIGIN], dir, noEnv);
    assert.equal(outsideActions.code, 1);
    assert.match(outsideActions.stderr, /GITHUB_ENV is not set: `socrate preview prepare` runs in GitHub Actions/);
    const usage = await cli(['preview', 'prepare'], dir, env);
    assert.equal(usage.code, 2);
  } finally {
    github.server.close();
  }
});

test('preview register : PUT du déploiement sur un service local réel, manifeste générique puis dossier assemblé, refus avec code et message', async () => {
  const rt = await import('../../../tools/local/runtime.ts');
  const root = mkdtempSync(join(REPO_ROOT, '.tmp', 'register-'));
  const keys = await rt.generateIssuerKeys();
  const service = await rt.startService({
    root, port: 0, projects: [{ projectId: 'my-app', issuer: 'my-backend', publicJwk: keys.publicJwk, attestableCapabilities: ['thread.participate'], allowedOrigin: 'https://*.my-app.pages.dev' }],
  });
  try {
    const token = await rt.provisionCredential(service.db, { projectId: 'my-app', label: 'ci', capabilities: ['deployment.import'] });
    const yaml = `service: ${service.url}\nproject: my-app\npreviews: https://*.my-app.pages.dev\nzones:\n  - { id: settings, title: Settings, route: /settings }\n`;
    const { dir } = workspace(yaml, EVENT);
    const preview = (deploymentId: string) => JSON.stringify({
      serviceUrl: service.url, projectId: 'my-app', reviewKey: 'pr-42', deploymentId, origin: ORIGIN, pullRequest: 42, commit: SHA, buildId: '991-1', title: 'Automatic reminders', repository: 'my-org/my-app',
    });
    const env = (deploymentId: string, over: Record<string, string> = {}) => ({ SOCRATE_PREVIEW: preview(deploymentId), SOCRATE_IMPORT_TOKEN: token, ...over });
    const row = (id: string) => service.db.prepare('SELECT review_key, url, origin, commit_sha, build_id FROM deployments WHERE project_id = ? AND deployment_id = ?').bind('my-app', id).first();

    const first = await cli(['preview', 'register', '--url', `${ORIGIN}/`], dir, env('pr-42-0123456789ab-991-1'));
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /registered deployment pr-42-0123456789ab-991-1 of review pr-42 \(20[01]\)/);
    assert.deepEqual(await row('pr-42-0123456789ab-991-1'), { review_key: 'pr-42', url: `${ORIGIN}/`, origin: ORIGIN, commit_sha: SHA, build_id: '991-1' });
    const revision = await service.db.prepare('SELECT manifest FROM revisions WHERE project_id = ? AND review_key = ?').bind('my-app', 'pr-42').first<{ manifest: string }>();
    const generic = JSON.parse(revision!.manifest);
    assert.deepEqual([generic.title, generic.pullRequest, generic.repository, generic.zones.map((z: { id: string }) => z.id)], ['Automatic reminders', 42, 'my-org/my-app', ['settings']]);
    const replay = await cli(['preview', 'register', '--url', `${ORIGIN}/`], dir, env('pr-42-0123456789ab-991-1'));
    assert.equal(replay.code, 0, `import idempotent : ${replay.stderr}`);

    // Dossier `.socrate/` écrit avant le numéro de la PR : sa clé de revue est remplacée par celle de la preview.
    writeFileSync(join(dir, 'socrate.yml'), `${yaml}manifest: .socrate\n`);
    mkdirSync(join(dir, '.socrate/zones'), { recursive: true });
    writeFileSync(join(dir, '.socrate/index.json'), JSON.stringify({ schemaVersion: 1, reviewKey: 'reminders', title: 'Reminder delay per office', before: 'Reminders were sent by hand.', now: 'Each office sets its delay.', zones: ['zones/settings.json'] }));
    writeFileSync(join(dir, '.socrate/zones/settings.json'), JSON.stringify({ id: 'reminder-settings', title: 'Reminder settings', route: '/settings/reminders' }));
    const changed = await cli(['preview', 'register', '--url', `${ORIGIN}/`], dir, env('pr-42-0123456789ab-991-1'));
    assert.equal(changed.code, 1, 'même déploiement, autre manifeste');
    assert.match(changed.stderr, /the Socrate service refused the deployment: 409 immutable_deployment/);
    const assembled = await cli(['preview', 'register', '--url', `${ORIGIN}/`], dir, env('pr-42-0123456789ab-992-1'));
    assert.equal(assembled.code, 0, assembled.stderr);
    assert.equal((await row('pr-42-0123456789ab-992-1') as { review_key: string }).review_key, 'pr-42');

    const denied = await cli(['preview', 'register', '--url', `${ORIGIN}/`], dir, env('pr-42-0123456789ab-993-1', { SOCRATE_IMPORT_TOKEN: 'A'.repeat(43) }));
    assert.equal(denied.code, 1);
    assert.match(denied.stderr, /refused the deployment: 401 /);
    for (const out of [first, replay, changed, assembled, denied]) assert.ok(!`${out.stdout}${out.stderr}`.includes(token) && !`${out.stdout}${out.stderr}`.includes('A'.repeat(43)), 'le jeton n’est jamais affiché');

    const otherOrigin = await cli(['preview', 'register', '--url', 'https://abc123.my-app.pages.dev/'], dir, env('pr-42-0123456789ab-993-1'));
    assert.equal(otherOrigin.code, 1);
    assert.match(otherOrigin.stderr, /is not on the origin of the build \(https:\/\/feature-x\.my-app\.pages\.dev\)/);
    const noPreview = await cli(['preview', 'register', '--url', `${ORIGIN}/`], dir, { SOCRATE_IMPORT_TOKEN: token });
    assert.match(noPreview.stderr, /SOCRATE_PREVIEW is not set: run `socrate preview prepare`/);
    const noToken = await cli(['preview', 'register', '--url', `${ORIGIN}/`], dir, { SOCRATE_PREVIEW: preview('pr-42-0123456789ab-993-1') });
    assert.match(noToken.stderr, /SOCRATE_IMPORT_TOKEN is not set/);
    writeFileSync(join(dir, '.socrate/zones/extra.json'), '{}');
    const invalid = await cli(['preview', 'register', '--url', `${ORIGIN}/`], dir, env('pr-42-0123456789ab-994-1'));
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /zones\/extra\.json \(file\): data file not referenced by index\.json/);
    writeFileSync(join(dir, '.socrate/index.json'), JSON.stringify({ schemaVersion: 1, reviewKey: 'Reminders', title: '', before: 'b', now: 'n', zones: ['zones/settings.json', '/etc/x.json'], extra: 1 }));
    const french = await cli(['preview', 'register', '--url', `${ORIGIN}/`], dir, env('pr-42-0123456789ab-994-1'));
    assert.equal(french.code, 1);
    assert.match(french.stderr, /index\.json reviewKey: lowercase letters, digits and dashes\n  index\.json title: required text\n  index\.json extra: unknown key/);
    assert.doesNotMatch(french.stderr, /[àâçéèêëîïôûùü’]|fichier|racine/, 'aucun message du contrat laissé en français');
  } finally {
    await service.stop();
  }
});

test('check-absent : passe sur un build sans Socrate, échoue sur le marqueur du client ou l’adresse du service', async () => {
  const { dir } = workspace('service: https://my-socrate.example.workers.dev\nproject: my-app\npreviews: https://*.my-app.pages.dev\n', EVENT);
  mkdirSync(join(dir, 'dist/assets'), { recursive: true });
  writeFileSync(join(dir, 'dist/index.html'), '<title>socrate-branch</title>');
  writeFileSync(join(dir, 'dist/assets/app.js'), 'console.log(1)');
  const clean = await cli(['check-absent', 'dist'], dir, {});
  assert.equal(clean.code, 0, clean.stderr);
  assert.match(clean.stdout, /no Socrate client nor service address in .*dist \(2 files checked\)/);
  writeFileSync(join(dir, 'dist/assets/app.js'), 'fetch("https://my-socrate.example.workers.dev/v1/client")');
  const leaked = await cli(['check-absent', 'dist'], dir, {});
  assert.equal(leaked.code, 1);
  assert.match(leaked.stderr, /Socrate found in .*dist:\n {2}assets\/app\.js: contains "my-socrate\.example\.workers\.dev"/);
  writeFileSync(join(dir, 'dist/assets/app.js'), 'jsx(Review, props, "@meyer0x/socrate/review")');
  const rendered = await cli(['check-absent', 'dist'], dir, {});
  assert.equal(rendered.code, 1, 'le marqueur porté par le rendu suffit');
  assert.match(rendered.stderr, /assets\/app\.js: contains "@meyer0x\/socrate\/review"/);
  const missing = await cli(['check-absent', 'build'], dir, {});
  assert.match(missing.stderr, /build is not a directory/);
  assert.equal((await cli(['check-absent'], dir, {})).code, 2);
  assert.equal((await cli(['unknown'], dir, {})).code, 2);
});
