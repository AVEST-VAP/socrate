// Entrée `mount` servie par le Worker local : montée par un hôte d'une autre origine, refusée à une origine non enregistrée.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import { REPO_ROOT, deadlineIn, localFetch, localPath, portNumber, runtime, browser as browserBoundary } from './local-run.ts';
import type { InstanceHandle } from './runtime.ts';
import type { LocalBrowser } from './browser.ts';

const rt = await runtime();
const { openBrowser } = await browserBoundary();
const ARTIFACTS = localPath('.local/artifacts', 'mount', new Date().toISOString().replace(/[:.]/g, '-'));
const HOST_PORT = portNumber(process.env.SOCRATE_MOUNT_PORT ?? 5417, 'hôte mount');

let stack: InstanceHandle;
let browser: LocalBrowser;
let foreign: Server;
let foreignOrigin: string;
let client: string;
const facts: Record<string, unknown> = {};

/** Même application hôte, relayée depuis une origine que l'import n'a jamais enregistrée. */
function relay(port: number): Server {
  return createServer((req, res) => {
    const upstream = request({ host: '127.0.0.1', port, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${port}` } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    upstream.on('error', () => res.writeHead(502).end());
    req.pipe(upstream);
  });
}

before(async () => {
  await mkdir(ARTIFACTS, { recursive: true });
  const root = await mkdtemp(join(REPO_ROOT, '.tmp', 'mount-'));
  stack = await rt.launchInstance({ root, hostCommand: [localPath('tools/local/fixtures/mount-host.ts')], name: 'mount', ports: { service: 0, demo: HOST_PORT }, reset: false, deadline: deadlineIn(60_000) });
  foreign = relay(HOST_PORT);
  await new Promise<void>((r) => foreign.listen(0, '127.0.0.1', () => r()));
  foreignOrigin = `http://127.0.0.1:${(foreign.address() as { port: number }).port}`;
  // Comme la CI de l'hôte : l'URL de l'entrée est lue une fois côté serveur, puis figée dans la page.
  const r = await localFetch(`${stack.view.serviceUrl}/v1/client`, deadlineIn(5_000));
  assert.equal(r.status, 200);
  client = (r.json as { url: string }).url;
  facts.client = client;
  browser = await openBrowser();
});
after(async () => {
  try {
    await browser?.close();
    await new Promise<void>((r) => (foreign ? foreign.close(() => r()) : r()));
  } finally {
    const stopped = await stack?.stop('fin de la suite mount');
    facts.arret = stopped;
    await writeFile(join(ARTIFACTS, 'faits.json'), JSON.stringify(facts, null, 1));
    assert.ok(stopped.confirmed, stopped.detail);
    console.log(`captures et faits sous ${ARTIFACTS}`);
  }
});

type Seen = { method: string; url: string; status?: number; acao?: string | null; failure?: string };

async function nativeContext(allowed: string[]): Promise<{ context: BrowserContext; seen: Seen[]; blocked: string[] }> {
  const { context, blocked } = await browser.newNativeContext(allowed);
  const seen: Seen[] = [];
  context.on('response', (r) => void seen.push({ method: r.request().method(), url: r.url(), status: r.status(), acao: r.headers()['access-control-allow-origin'] ?? null }));
  context.on('requestfailed', (r) => void seen.push({ method: r.method(), url: r.url(), failure: r.failure()?.errorText }));
  return { context, seen, blocked };
}

async function openHost(page: Page, origin: string) {
  await page.goto(`${origin}/`);
  const login = await page.evaluate(async () => (await fetch('/api/login', { method: 'POST', body: JSON.stringify({ persona: 'claire' }) })).status);
  assert.equal(login, 200);
  await page.goto(`${origin}/?client=${encodeURIComponent(client)}`);
  await page.locator('body[data-mount]').waitFor({ timeout: 15_000 });
}

test('l’entrée mount du Worker monte Socrate dans une page hôte d’une autre origine, sans React ni paquet de l’hôte', async () => {
  const origin = stack.view.demoOrigin;
  assert.notEqual(new URL(client).origin, origin, 'client servi par le Worker, pas par l’hôte');
  const ctx = await nativeContext([origin, stack.view.serviceUrl]);
  const page = await ctx.context.newPage();
  await openHost(page, origin);
  assert.equal(await page.locator('body').getAttribute('data-mount'), 'ok', (await page.locator('body').getAttribute('data-error')) ?? '');
  await page.locator('[data-socrate="toolbar"]').waitFor({ timeout: 15_000 });
  await page.screenshot({ path: join(ARTIFACTS, '01-hote-autorise-monte.png') });
  const toService = ctx.seen.filter((r) => r.url.startsWith(stack.view.serviceUrl));
  facts.autorise = toService.map((r) => ({ ...r, url: new URL(r.url).pathname }));
  const files = toService.filter((r) => /\/client\/.+\.js$/.test(r.url));
  assert.ok(files.some((r) => r.url === client) && files.length > 1, 'entrée et chunks à la demande chargés depuis le Worker');
  for (const f of files) assert.deepEqual([f.status, f.acao], [200, origin], `${f.url} accordé par le CORS natif du Worker`);
  const session = toService.find((r) => new URL(r.url).pathname === '/v1/auth/session' && r.method === 'POST');
  assert.equal(session?.status, 201);
  assert.ok(toService.some((r) => new URL(r.url).pathname === `/v1/projects/demo/reviews/rappels-automatiques/deployments/local-1` && r.status === 200 && r.acao === origin), 'révision du déploiement lue');
  const sessions = (await stack.service.db.prepare('SELECT origin FROM sessions').all<{ origin: string }>()).results.map((r) => r.origin);
  assert.deepEqual(sessions, [origin], 'session ouverte pour l’origine du déploiement');
  const fromHost = ctx.seen.filter((r) => r.url.startsWith(origin)).map((r) => new URL(r.url).pathname);
  assert.ok(fromHost.every((p) => p === '/' || p.startsWith('/api/')), `l’hôte ne sert aucun script : ${fromHost.join(', ')}`);
  await page.evaluate(() => (window as unknown as { socrateUnmount(): void }).socrateUnmount());
  assert.equal(await page.locator('[data-socrate="toolbar"]').count(), 0, 'démontage retire la toolbar');
  assert.equal(ctx.seen.filter((r) => r.failure).length, 0, JSON.stringify(ctx.seen.filter((r) => r.failure)));
  assert.deepEqual(ctx.blocked, []);
  await ctx.context.close();
});

test('la même page servie depuis une origine non enregistrée ne charge pas l’entrée : CORS refusé, aucune session', async () => {
  const ctx = await nativeContext([foreignOrigin, stack.view.serviceUrl]);
  const page = await ctx.context.newPage();
  const console: string[] = [];
  page.on('console', (m) => console.push(m.text()));
  await openHost(page, foreignOrigin);
  await page.screenshot({ path: join(ARTIFACTS, '02-hote-non-autorise-refuse.png') });
  const error = (await page.locator('body').getAttribute('data-error')) ?? '';
  const toService = ctx.seen.filter((r) => r.url.startsWith(stack.view.serviceUrl));
  facts.refuse = { mount: await page.locator('body').getAttribute('data-mount'), error, console, requetesService: toService.map((r) => ({ ...r, url: new URL(r.url).pathname })) };
  assert.equal(await page.locator('body').getAttribute('data-mount'), 'refused');
  assert.match(error, /TypeError/);
  assert.ok(console.some((m) => /CORS policy/.test(m) && m.includes(foreignOrigin)), console.join('\n'));
  assert.equal(await page.locator('[data-socrate="toolbar"]').count(), 0);
  assert.deepEqual(toService.map((r) => r.url), [client], 'seule l’entrée est demandée, aucun chunk ni appel API');
  assert.equal(toService[0]!.acao ?? null, null);
  assert.deepEqual(ctx.blocked, []);
  const direct = await fetch(client, { headers: { Origin: foreignOrigin } });
  await direct.arrayBuffer();
  assert.equal(direct.headers.get('access-control-allow-origin'), null, 'le Worker n’ouvre pas le CORS à cette origine');
  await ctx.context.close();
});
