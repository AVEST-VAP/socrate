import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, relative } from 'node:path';
import { assembleManifest } from '@socrate/contract/assemble';
import { signAssertion } from '../assertion.ts';
import { REPO_ROOT, allowPort, deadlineIn, localFetch, localPath } from '../local-run.ts';

const SCRIPT = localPath('tools/local/serve.ts');
const DEMO_MANIFEST = localPath('apps/demo/.socrate');
const ORIGIN = 'http://127.0.0.1:5357';
const tmp = (prefix: string) => mkdtemp(join(REPO_ROOT, '.tmp', prefix));
type HostConfig = { serviceUrl: string; instanceId: string; projectId: string; reviewKey: string; deploymentId: string; issuer: string; audience: string; origin: string; privateKeyPath: string };
type ReadyLine = { event: string; hostConfig: string; serviceUrl: string };
type Served = { child: ChildProcess; stderr: () => string; ready: Promise<ReadyLine>; exit: Promise<number | null> };

// Port 0 : le service prend un port libre, annoncé par host.json.
function serve(args: string[]): Served {
  const child = spawn(process.execPath, [SCRIPT, '--port', '0', ...args], { cwd: REPO_ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, INIT_CWD: REPO_ROOT } });
  let out = '';
  let err = '';
  child.stderr!.on('data', (d) => (err += d));
  const exit = new Promise<number | null>((r) => child.once('exit', (code) => r(code)));
  const ready = new Promise<ReadyLine>((resolve, reject) => {
    child.stdout!.on('data', (d) => {
      out += d;
      const line = out.split('\n').find((l) => l.startsWith('{'));
      if (line) resolve(JSON.parse(line));
    });
    void exit.then((code) => reject(new Error(`serve sorti (${code}) avant la ligne prête :\n${err}`)));
  });
  ready.catch(() => undefined);
  return { child, stderr: () => err, ready, exit };
}

const gone = (pgid: number) => {
  try {
    process.kill(-pgid, 0);
    return false;
  } catch {
    return true;
  }
};

// Fermeture bornée sur chaque sortie : SIGTERM au service, puis SIGKILL au groupe (workerd compris).
async function halt(served: Served): Promise<void> {
  const pgid = served.child.pid!;
  for (const [signal, ms] of [['SIGTERM', 20_000], ['SIGKILL', 5_000]] as const) {
    if (gone(pgid)) return;
    try {
      if (signal === 'SIGTERM') served.child.kill(signal);
      else process.kill(-pgid, signal);
    } catch {}
    const until = Date.now() + ms;
    while (!gone(pgid) && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  }
  if (!gone(pgid)) throw new Error(`groupe ${pgid} encore présent après SIGKILL`);
}

async function withServe<T>(args: string[], work: (served: Served) => Promise<T>): Promise<T> {
  const served = serve(args);
  try {
    return await work(served);
  } finally {
    await halt(served);
  }
}

const mode = async (path: string) => (await stat(path)).mode & 0o777;

test('serve annonce host.json quand le service est prêt ; la clé de l’émetteur ouvre une session pour l’origine, puis SIGTERM confirme la fermeture et une relance garde clé et déploiement', async () => {
  const state = await tmp('serve-');
  const args = ['--origin', ORIGIN, '--manifest', DEMO_MANIFEST, '--state', state, '--project', 'essai', '--issuer', 'backend-essai'];
  const first = await withServe(args, async (served) => {
    const ready = await served.ready;
    assert.equal(ready.event, 'ready');
    assert.equal(ready.hostConfig, join(state, 'host.json'));
    const host = JSON.parse(await readFile(ready.hostConfig, 'utf8')) as HostConfig;
    assert.deepEqual(Object.keys(host).sort(), ['audience', 'deploymentId', 'instanceId', 'issuer', 'origin', 'privateKeyPath', 'projectId', 'reviewKey', 'serviceUrl']);
    assert.equal(host.serviceUrl, ready.serviceUrl);
    assert.deepEqual([host.projectId, host.issuer, host.audience, host.origin, host.reviewKey], ['essai', 'backend-essai', 'socrate', ORIGIN, 'rappels-automatiques']);
    assert.match(host.deploymentId, /^local-[0-9a-f]{12}$/);
    assert.equal(await mode(ready.hostConfig), 0o600);
    assert.equal(await mode(host.privateKeyPath), 0o600);

    const revoke = allowPort(Number(new URL(host.serviceUrl).port));
    try {
      const health = await localFetch(`${host.serviceUrl}/v1/health`, deadlineIn(10_000));
      assert.equal((health.json as { instanceId: string }).instanceId, host.instanceId);
      const privateJwk = JSON.parse(await readFile(host.privateKeyPath, 'utf8')) as JsonWebKey;
      const assertion = signAssertion(privateJwk, { ...host, sub: 'u-fictif', name: 'Relectrice fictive', capabilities: ['thread.participate'] });
      const exchange = (origin: string) => localFetch(`${host.serviceUrl}/v1/auth/session`, deadlineIn(10_000), { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ assertion }) });
      const opened = await exchange(ORIGIN);
      assert.ok(opened.status === 200 || opened.status === 201, `session ouverte : ${opened.status} ${opened.text}`);
      const replayed = await exchange(ORIGIN);
      assert.equal((replayed.json as { code: string }).code, 'assertion_replayed');
    } finally {
      revoke();
    }
    served.child.kill('SIGTERM');
    assert.equal(await served.exit, 0);
    assert.match(served.stderr(), /fermeture confirmée/);
    assert.ok(!existsSync(ready.hostConfig), 'host.json supprimé à la fermeture confirmée');
    return { host, privateJwk: await readFile(host.privateKeyPath, 'utf8') };
  });
  const record = JSON.parse(await readFile(`${state}.owner.json`, 'utf8'));
  assert.equal(record.state, 'closed');
  assert.deepEqual(Object.values(record.resources).map((r) => (r as { phase: string }).phase), ['closed']);

  await withServe(args, async (served) => {
    const host = JSON.parse(await readFile((await served.ready).hostConfig, 'utf8')) as HostConfig;
    assert.equal(host.deploymentId, first.host.deploymentId, 'même manifeste et même origine : même déploiement, import rejoué');
    assert.notEqual(host.instanceId, first.host.instanceId);
    assert.equal(await readFile(host.privateKeyPath, 'utf8'), first.privateJwk, 'paire de l’émetteur générée une seule fois');
    const concurrent = serve(args);
    try {
      assert.equal(await concurrent.exit, 1);
      assert.match(concurrent.stderr(), /refusé \(occupied\)/);
    } finally {
      await halt(concurrent);
    }
    served.child.kill('SIGTERM');
    assert.equal(await served.exit, 0);
  });
});

test('serve accepte un manifeste assemblé en fichier JSON, et la même racine relancée pour une autre origine ouvre un autre déploiement', async () => {
  const state = await tmp('serve-origines-');
  const assembled = await assembleManifest(DEMO_MANIFEST);
  assert.ok(assembled.ok);
  const manifestFile = join(await tmp('serve-json-'), 'manifest.json');
  await writeFile(manifestFile, JSON.stringify(assembled.manifest));
  const deployments: string[] = [];
  for (const origin of [ORIGIN, 'http://127.0.0.1:5358']) {
    await withServe(['--origin', origin, '--manifest', manifestFile, '--state', state], async (served) => {
      const host = JSON.parse(await readFile((await served.ready).hostConfig, 'utf8')) as HostConfig;
      assert.equal(host.origin, origin);
      assert.equal(host.reviewKey, 'rappels-automatiques');
      deployments.push(host.deploymentId);
      served.child.kill('SIGTERM');
      assert.equal(await served.exit, 0, served.stderr());
    });
  }
  assert.notEqual(deployments[0], deployments[1], 'l’identifiant dépend de l’origine : pas de 409 immutable_deployment');
});

test('serve refuse sans rien lancer : origine avec chemin, état hors du clone, manifeste invalide, port occupé, fermeture précédente non confirmée', async () => {
  const state = await tmp('serve-refus-');
  const refused = async (args: string[], reason: RegExp) => withServe(args, async (served) => {
    assert.equal(await served.exit, 1);
    assert.match(served.stderr(), reason);
  });
  await refused(['--origin', `${ORIGIN}/app`, '--manifest', DEMO_MANIFEST, '--state', state], /refusé \(origin_invalid\)/);
  await refused(['--origin', ORIGIN, '--manifest', DEMO_MANIFEST, '--state', join(REPO_ROOT, '..', 'hors-du-clone')], /refusé \(path_outside\)/);
  const invalid = await tmp('serve-manifeste-');
  await mkdir(join(invalid, 'zones'));
  await writeFile(join(invalid, 'index.json'), JSON.stringify({ schemaVersion: 1, reviewKey: 'essai', before: 'a', now: 'b', zones: [] }));
  await refused(['--origin', ORIGIN, '--manifest', relative(REPO_ROOT, invalid), '--state', state], /refusé \(manifest_invalid\)[\s\S]*title/);
  assert.ok(!existsSync(join(state, 'host.json')) && !existsSync(`${state}.owner.json`), 'aucune racine possédée après un refus d’arguments');

  const taken = createServer();
  await new Promise<void>((done) => taken.listen(0, '127.0.0.1', done));
  try {
    const { port } = taken.address() as { port: number };
    await refused(['--origin', ORIGIN, '--manifest', DEMO_MANIFEST, '--state', state, '--port', String(port)], new RegExp(`refusé \\(occupied\\) : port ${port} non libre`));
  } finally {
    await new Promise((done) => taken.close(done));
  }
  assert.ok(!existsSync(join(state, 'host.json')) && !existsSync(`${state}.owner.json`), 'aucun service lancé sur un port occupé');

  await writeFile(`${state}.owner.json`, JSON.stringify({ generation: 'ancienne', pid: 1, startedAt: '2026-10-22T00:00:00Z', state: 'ready', ports: { service: 1, demo: 2 }, resources: { service: { phase: 'running', port: 1 } } }));
  await refused(['--origin', ORIGIN, '--manifest', DEMO_MANIFEST, '--state', state], /refusé \(uncertain_resources\)[\s\S]*service en phase running/);
  assert.ok(!existsSync(join(state, 'host.json')));
});
