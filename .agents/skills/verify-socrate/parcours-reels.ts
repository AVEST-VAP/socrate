#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { browser, deadlineIn, localFetch, localPath, portNumber, runtime, tcpProbe } from '../../../tools/local/local-run.ts';
import { sourceState } from './verify.ts';

const NAME = 'parcours-reels';
const PORTS = { service: portNumber(process.env.SOCRATE_VERIFY_SERVICE_PORT ?? 8788, 'service'), demo: portNumber(process.env.SOCRATE_VERIFY_DEMO_PORT ?? 5174, 'démo') };
const OUT = process.argv[2] ? localPath(process.argv[2]) : localPath('.local/artifacts', NAME, new Date().toISOString().replace(/[:.]/g, '-'));
const THREADS = '/v1/projects/demo/reviews/rappels-automatiques/threads';

await mkdir(join(OUT, '..'), { recursive: true });
await mkdir(OUT);

const rt = await runtime();
const { openBrowser } = await browser();
type Local = Awaited<ReturnType<typeof openBrowser>>;
type Ctx = Awaited<ReturnType<Local['newContext']>>;
type Page = Awaited<ReturnType<Ctx['context']['newPage']>>;

const facts: any = { source: sourceState(), started: new Date().toISOString(), ports: PORTS, checks: {} };
const held = new Map<string, () => Promise<void>>();
let stack: Awaited<ReturnType<typeof rt.launchInstance>> | undefined;
let local: Local | undefined;
let ctx: Ctx | undefined;
let current: Page | undefined;

const panel = (p: Page) => p.frameLocator('#socrate-frame');

async function bounded<T>(p: Promise<T>, ms = 20_000): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([p, new Promise<never>((_, ko) => { t = setTimeout(() => ko(new Error(`fermeture non confirmée après ${ms} ms`)), ms); })]);
  } finally {
    clearTimeout(t);
  }
}

async function openReview(p: Page) {
  // Toolbar affichée à l'arrivée, puis « Conversations », panneau historique du mode éditorial explicite.
  await p.locator('[data-socrate="toolbar"]').waitFor();
  if ((await p.locator('[data-socrate-action="launcher"]').getAttribute('aria-expanded')) !== 'true') await p.locator('[data-socrate-action="launcher"]').click();
  await panel(p).getByRole('heading', { level: 1, name: 'Rappels automatiques des rendez-vous' }).waitFor();
}

async function agentRead(label: string): Promise<any[]> {
  const r = await localFetch(stack!.view.serviceUrl + THREADS, deadlineIn(10_000), { headers: { Authorization: `Bearer ${stack!.credentials.agent}` } });
  assert.equal(r.status, 200);
  await writeFile(join(OUT, `api-${label}.json`), JSON.stringify({ status: r.status, body: r.json }, null, 2));
  return (r.json as { items: any[] }).items;
}

async function claire(headed: boolean): Promise<Page> {
  local = await openBrowser({ headed });
  ctx = await local.newContext([stack!.view.demoOrigin, stack!.view.serviceUrl]);
  await ctx.context.addInitScript(() => localStorage.setItem('socrate-editorial', '1'));
  ctx.context.setDefaultTimeout(10_000);
  const p = await ctx.context.newPage();
  current = p;
  await p.goto(stack!.view.demoOrigin);
  await p.getByRole('button', { name: 'Se connecter comme Claire Morel, relectrice produit', exact: true }).click();
  await openReview(p);
  return p;
}

async function closeBrowser(label: string) {
  if (!local) return;
  facts[`${label}Reseau`] = {
    requests: ctx?.seen.map((r) => ({ method: r.method, url: r.url, cookie: r.headers.cookie ?? null, key: r.headers['idempotency-key'] ?? null })),
    blocked: ctx?.blocked, failed: ctx?.failed, sinkAttempts: local.sinkAttempts,
  };
  const l = local;
  local = undefined;
  ctx = undefined;
  current = undefined;
  await bounded(l.close());
}

async function phase(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    facts.checks[name] = { status: 'pass' };
  } catch (e) {
    facts.checks[name] = { status: 'fail', error: (e as Error).stack };
    if (current) await current.screenshot({ path: join(OUT, `${name}-echec.png`) }).catch(() => {});
    process.exitCode = 1;
  } finally {
    await closeBrowser(name).catch((e) => { facts.checks[name].browserClose = String(e); process.exitCode = 1; });
    await writeFile(join(OUT, 'progression.json'), JSON.stringify(facts, null, 2));
  }
}

const isThreadsPost = (r: { method: string; url: string }) => r.method === 'POST' && new URL(r.url).pathname.endsWith('/threads');

async function reponsePerdueDeuxRedemarrages() {
  const a = await claire(false);
  const p = panel(a);
  const draft = p.getByRole('textbox', { name: 'Votre commentaire global' });
  const text = `parcours-reels reprise ${Date.now()}`;
  let lost = false;
  ctx!.setFaults((r) => (isThreadsPost(r) && !lost ? ((lost = true), { kind: 'lose-response' }) : { kind: 'pass' }));
  await draft.fill(text);
  await p.getByRole('button', { name: 'Publier', exact: true }).click();
  await p.getByRole('alert').filter({ hasText: 'Votre brouillon est conservé' }).waitFor();
  facts.incertain = await p.getByTestId('socrate-pending').innerText();
  assert.match(facts.incertain, /peut-être déjà été publié/, 'envoi en attente marqué incertain');
  assert.equal(await p.getByRole('status').filter({ hasText: 'Commentaire publié.' }).count(), 0, 'aucun succès affiché sur réponse perdue');
  const unique = (items: any[]) => {
    const matches = items.filter((t) => t.messages[0]?.body === text);
    assert.equal(matches.length, 1, 'un seul retour durable');
    assert.equal(matches[0].messages.length, 1, 'un seul message');
    assert.equal(matches[0].messages[0].author.key, 'demo-host:claire');
    return matches[0].threadId as string;
  };
  const id = unique(await agentRead('reponse-perdue-durable'));
  await a.screenshot({ path: join(OUT, 'reprise-1-incertain-durable.png') });
  const before = await stat(stack!.service.persistRoot);

  await stack!.stopService();
  assert.equal(await tcpProbe(PORTS.service), 'refused', 'service arrêté au premier redémarrage');
  await stack!.startService();
  assert.equal(unique(await agentRead('premier-redemarrage')), id);
  assert.equal(await draft.inputValue(), text, 'brouillon conservé pendant l’arrêt');

  await p.getByRole('button', { name: 'Réessayer', exact: true }).click();
  await p.getByRole('status').filter({ hasText: 'Commentaire publié.' }).waitFor();
  assert.equal(unique(await agentRead('apres-reprise')), id);
  const posts = ctx!.seen.filter((r) => isThreadsPost(r) && JSON.parse(r.postData ?? '{}').body === text);
  facts.requetesReprise = posts.map((r) => ({ url: r.url, key: r.headers['idempotency-key'] }));
  assert.equal(posts.length, 2, 'publication initiale puis reprise');
  assert.ok(posts[0]!.headers['idempotency-key']);
  assert.equal(posts[0]!.headers['idempotency-key'], posts[1]!.headers['idempotency-key'], 'même clé à la reprise');

  await stack!.stopService();
  assert.equal(await tcpProbe(PORTS.service), 'refused', 'service arrêté au second redémarrage');
  await stack!.startService();
  assert.equal(unique(await agentRead('second-redemarrage')), id);
  await a.reload();
  await openReview(a);
  await panel(a).getByText(text, { exact: true }).waitFor();
  await a.screenshot({ path: join(OUT, 'reprise-2-second-redemarrage-recharge.png') });
  const after = await stat(stack!.service.persistRoot);
  assert.deepEqual({ dev: after.dev, ino: after.ino }, { dev: before.dev, ino: before.ino }, 'même stockage physique');
}

async function deuxOngletsNatifs() {
  const a = await claire(true);
  assert.equal((globalThis as any).socrateNativeFocus, true, 'native-focus-hook.mjs chargé par --import');
  const p = panel(a);
  const draft = p.getByRole('textbox', { name: 'Votre commentaire global' });
  const marker = `parcours-reels onglets ${Date.now()}`;
  await draft.fill(`${marker} seed`);
  await p.getByRole('button', { name: 'Publier', exact: true }).click();
  await p.getByRole('status').filter({ hasText: 'Commentaire publié.' }).waitFor();
  await draft.fill(`${marker} draft`);
  await a.evaluate(() => {
    (window as any).nativeEvents = [];
    document.addEventListener('visibilitychange', (e) => (window as any).nativeEvents.push({ state: document.visibilityState, trusted: e.isTrusted }));
  });
  const windowA = await (await ctx!.context.newCDPSession(a)).send('Browser.getWindowForTarget');
  const b = await ctx!.context.newPage();
  current = b;
  await b.goto(stack!.view.demoOrigin);
  await b.bringToFront();
  await openReview(b);
  const windowB = await (await ctx!.context.newCDPSession(b)).send('Browser.getWindowForTarget');
  assert.equal(windowA.windowId, windowB.windowId, 'deux onglets de la même fenêtre');
  facts.ongletMasque = await a.evaluate(() => document.visibilityState);
  assert.equal(facts.ongletMasque, 'hidden', 'premier onglet réellement masqué');

  const tb = panel(b).getByTestId('socrate-thread').filter({ hasText: `${marker} seed` });
  await tb.getByRole('textbox', { name: /Répondre/ }).fill(`${marker} reply`);
  await tb.getByRole('button', { name: 'Répondre', exact: true }).click();
  await tb.getByText(`${marker} reply`, { exact: true }).waitFor();
  await tb.getByRole('button', { name: 'Résoudre', exact: true }).click();
  await tb.getByText('Résolu', { exact: true }).waitFor();
  await b.screenshot({ path: join(OUT, 'onglets-1-B-resolu.png') });

  await a.bringToFront();
  current = a;
  const ta = p.getByTestId('socrate-thread').filter({ hasText: `${marker} seed` });
  await ta.getByText(`${marker} reply`, { exact: true }).waitFor();
  await ta.getByText('Résolu', { exact: true }).waitFor();
  facts.retour = await a.evaluate(() => ({ state: document.visibilityState, events: (window as any).nativeEvents }));
  assert.equal(facts.retour.state, 'visible');
  assert.ok(facts.retour.events.some((x: any) => x.state === 'hidden' && x.trusted), 'masquage trusted');
  assert.ok(facts.retour.events.some((x: any) => x.state === 'visible' && x.trusted), 'retour au premier plan trusted');
  assert.equal(await draft.inputValue(), `${marker} draft`, 'brouillon intact');
  await a.screenshot({ path: join(OUT, 'onglets-2-A-retour-brouillon.png') });

  const thread = (await agentRead('onglets-actualise')).find((t) => t.messages[0]?.body === `${marker} seed`);
  assert.ok(thread);
  assert.equal(thread.state, 'resolved');
  assert.deepEqual(thread.messages.map((m: any) => m.body), [`${marker} seed`, `${marker} reply`]);
  assert.ok(!ctx!.seen.some((r) => r.url.startsWith(stack!.view.serviceUrl) && r.headers.cookie), 'aucun cookie hôte vers Socrate');
}

try {
  for (const port of Object.values(PORTS)) assert.equal(await tcpProbe(port), 'refused', `port ${port} libre avant lancement`);
  stack = await rt.launchInstance({
    root: rt.instanceRoot(NAME), name: NAME, ports: PORTS, reset: true, deadline: deadlineIn(60_000),
    own: (name, close) => held.set(name, close), log: (line) => console.log(line),
  });
  facts.instance = stack.view;
  await phase('reponse-perdue-deux-redemarrages', reponsePerdueDeuxRedemarrages);
  await phase('deux-onglets-natifs', deuxOngletsNatifs);
} catch (e) {
  facts.erreur = (e as Error).stack;
  process.exitCode = 1;
} finally {
  if (stack) {
    try {
      facts.arret = await bounded(stack.stop('fin parcours-reels'));
      if (facts.arret.confirmed) facts.cleanup = await rt.cleanupInstance(NAME, deadlineIn(10_000));
      else process.exitCode = 1;
    } catch (e) {
      facts.arretErreur = String(e);
      process.exitCode = 1;
    }
  }
  facts.fermetures = [];
  for (const [name, close] of [...held].reverse()) {
    try {
      await bounded(close());
      facts.fermetures.push({ name, closed: true });
    } catch (e) {
      facts.fermetures.push({ name, error: String(e) });
      process.exitCode = 1;
    }
  }
  facts.portsApres = {};
  for (const port of Object.values(PORTS)) facts.portsApres[port] = await tcpProbe(port);
  if (Object.values(facts.portsApres).some((s) => s !== 'refused')) process.exitCode = 1;
  facts.finished = new Date().toISOString();
  await writeFile(join(OUT, 'parcours.json'), JSON.stringify(facts, null, 2));
  console.log(JSON.stringify({ out: OUT, checks: facts.checks, arret: facts.arret, portsApres: facts.portsApres }, null, 2));
}
