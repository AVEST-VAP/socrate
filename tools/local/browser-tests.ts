import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { signAssertion } from './assertion.ts';
import { REPO_ROOT, deadlineIn, localPath, portNumber, runtime, browser as browserBoundary } from './local-run.ts';
import type { InstanceHandle } from './runtime.ts';
import type { LocalBrowser, LocalContext, SeenRequest } from './browser.ts';

const rt = await runtime();
const { openBrowser } = await browserBoundary();
const ARTIFACTS = localPath('.local/artifacts', 'suite-navigateur', new Date().toISOString().replace(/[:.]/g, '-'));
const DEMO_PORT = portNumber(process.env.SOCRATE_BROWSER_TEST_PORT ?? 5199, 'démo');
/** Mode affiché de la vue scindée : le DPR du contexte est imposé au lancement pour que la référence `page.screenshot` et l'affichage partagé soient rasterisés à la même échelle. */
const DISPLAY = (() => {
  const headed = process.env.SOCRATE_BROWSER_HEADED === '1';
  const raw = process.env.SOCRATE_BROWSER_DPR;
  const dpr = raw === undefined ? undefined : Number(raw);
  if (dpr !== undefined && !(Number.isFinite(dpr) && dpr > 0)) throw new Error(`SOCRATE_BROWSER_DPR invalide : ${raw}`);
  if (headed && dpr === undefined) throw new Error('SOCRATE_BROWSER_HEADED=1 exige SOCRATE_BROWSER_DPR, l’échelle physique de l’écran (2 sur un écran Retina)');
  return { headed, dpr };
})();

let stack: InstanceHandle;
let browser: LocalBrowser;
const origins = () => [stack.view.demoOrigin, stack.view.serviceUrl];

before(async () => {
  await mkdir(ARTIFACTS, { recursive: true });
  const root = await mkdtemp(join(REPO_ROOT, '.tmp', 'browser-'));
  stack = await rt.launchInstance({ root, name: 'browser-tests', ports: { service: 0, demo: DEMO_PORT }, reset: false, deadline: deadlineIn(60_000) });
  browser = await openBrowser();
});
after(async () => {
  await browser?.close();
  const stopped = await stack?.stop('fin de la suite');
  assert.ok(stopped.confirmed, stopped.detail);
  await writeFile(join(ARTIFACTS, 'puits-proxy-suite.txt'), browser.sinkAttempts.join('\n'));
  console.log(`puits proxy loopback : ${browser.sinkAttempts.length} tentative(s) de sortie du navigateur, toutes refusées en 403 sans relais ; captures et puits sous ${ARTIFACTS}`);
});

async function loginAs(ctx: LocalContext, persona: string): Promise<Page> {
  const page = await ctx.context.newPage();
  await page.goto(`${stack.view.demoOrigin}/`);
  await page.getByRole('button', { name: new RegExp(`Se connecter comme ${persona}`) }).click();
  return page;
}
/**
 * Ces scénarios pilotent le panneau historique, réactivé explicitement par le mode éditorial de la démo ;
 * les parcours de l'interface par défaut sont dans tools/local/commentaires-tests.ts.
 */
async function editorial(pending: Promise<LocalContext>): Promise<LocalContext> {
  const ctx = await pending;
  await ctx.context.addInitScript(() => localStorage.setItem('socrate-editorial', '1'));
  return ctx;
}
const panel = (page: Page) => page.frameLocator('#socrate-frame');
/** Toolbar affichée sans clic à l'arrivée. */
async function activateToolbar(page: Page) {
  await page.locator('[data-socrate="toolbar"]').waitFor({ timeout: 10_000 });
}
/**
 * Bouton « Commenter un élément » de la toolbar, qui remplace l'ancien bouton de capture.
 * `data-capture` porte l'état du partage, comme dans le panneau éditorial ; un clic démarre partage et sélection.
 */
const TARGET = '[data-socrate="toolbar"] [data-socrate-action="target"]';
const captureIs = (page: Page, state: string) => page.locator(`${TARGET}[data-capture^="${state}"]`).waitFor({ timeout: 10_000 });
async function clickTarget(page: Page) {
  await activateToolbar(page);
  await page.locator(TARGET).click();
}
/** Ancien « Activer la capture » : le ciblage obtient le partage, puis la sélection est annulée. */
async function activateCapture(page: Page) {
  await clickTarget(page);
  await captureIs(page, 'selecting');
  await page.locator(TARGET).click();
  await captureIs(page, 'active');
}
/**
 * Pastilles masquées : leur suivi observe le DOM et le défilement des iframes dès qu'un fil ciblé existe dans la revue ;
 * les sondes d'écouteurs et d'observateurs ne comptent ainsi que la sélection ou le guidage.
 */
async function hidePins(page: Page) {
  await page.locator('[data-socrate-action="more"]').click();
  await page.locator('[data-socrate-action="pins"]').click();
}
async function showList(page: Page) {
  await activateToolbar(page);
  const launcher = page.locator('[data-socrate-action="launcher"]');
  await launcher.waitFor({ timeout: 10_000 });
  if ((await launcher.getAttribute('aria-expanded')) !== 'true') await launcher.click();
}
const toggleList = (page: Page) => page.locator('[data-socrate-action="launcher"]').click();
async function openPanel(page: Page) {
  await showList(page);
  try {
    await panel(page).getByRole('heading', { level: 1, name: 'Rappels automatiques des rendez-vous' }).waitFor({ timeout: 10_000 });
  } catch {
    const text = await page.evaluate(() => (document.getElementById('socrate-frame') as HTMLIFrameElement | null)?.contentDocument?.body.innerText ?? '(pas d’iframe)');
    throw new Error(`panneau non chargé : ${text.slice(0, 400)}`);
  }
}
const messagesNamed = async (body: string) => (await stack.service.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE body = ?').bind(body).first<{ n: number }>())!.n;
const authorsOf = async (body: string) => (await stack.service.db.prepare('SELECT author_key, exploring FROM messages WHERE body = ?').bind(body).all<{ author_key: string; exploring: string | null }>()).results;
const path = (r: SeenRequest) => new URL(r.url).pathname;
const isThreadsPost = (r: SeenRequest) => r.method === 'POST' && path(r).endsWith('/threads');
const isReplyPost = (r: SeenRequest) => r.method === 'POST' && /\/threads\/[^/]+\/messages$/.test(path(r));
const isStatePut = (r: SeenRequest) => r.method === 'PUT' && /\/threads\/[^/]+\/state$/.test(path(r));
const isThreadsGet = (r: SeenRequest) => r.method === 'GET' && path(r).endsWith('/threads');
const serviceOnly = (ctx: LocalContext, pred: (r: SeenRequest) => boolean) => ctx.seen.filter((r) => r.url.startsWith(stack.view.serviceUrl) && pred(r));
const keysOf = (rs: SeenRequest[]) => rs.map((r) => r.headers['idempotency-key'] ?? '');
const bodiesOf = (rs: SeenRequest[]) => rs.map((r) => (JSON.parse(r.postData ?? '{}') as { body: string }).body);
function loseOnce(ctx: LocalContext, matches: (r: SeenRequest) => boolean) {
  let lost = false;
  ctx.setFaults((r) => {
    if (!matches(r) || lost) return { kind: 'pass' };
    lost = true;
    return { kind: 'lose-response' };
  });
}
const expireSessions = (actorKey?: string) => (actorKey ? stack.service.db.prepare('UPDATE sessions SET expires_at = 1 WHERE actor_key = ?').bind(actorKey).run() : stack.service.db.prepare('UPDATE sessions SET expires_at = 1').run());
async function switchPersona(ctx: LocalContext, persona: RegExp): Promise<Page> {
  const b = await ctx.context.newPage();
  await b.goto(`${stack.view.demoOrigin}/`);
  await b.getByRole('button', { name: 'Se déconnecter' }).click();
  await b.getByRole('button', { name: persona }).click();
  await b.getByRole('button', { name: 'Se déconnecter' }).waitFor();
  return b;
}
/** Active le partage si besoin, puis cible l'élément de l'hôte et attend l'image du brouillon. */
async function targetElement(page: Page, testId: string) {
  const p = panel(page);
  await activateToolbar(page);
  // « Commenter un élément » active le partage si besoin puis démarre la sélection.
  const button = page.locator('[data-socrate="toolbar"] [data-socrate-action="target"]');
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
  await page.locator('[data-socrate="toolbar"] [data-socrate-action="target"][aria-pressed="true"]').waitFor({ timeout: 10_000 }).catch(async (e: Error) => {
    throw new Error(`${e.message} ; état « ${await p.getByTestId('socrate-capture-status').innerText().catch(() => '?')} »`);
  });
  const box = (await page.getByTestId(testId).boundingBox())!;
  await page.mouse.click(box.x + 8, box.y + box.height / 2);
  await p.getByTestId('socrate-shot').waitFor({ timeout: 10_000 });
}
const bringBack = (a: Page) => a.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

test('relectrice : ouverture sans connexion Socrate, publication, réponse, persistance après rechargement', async () => {
  const ctx = await editorial(browser.newContext(origins()));
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openPanel(page);
  const p = panel(page);
  await assert.rejects(page.getByText(/mot de passe|connexion Socrate/i).waitFor({ timeout: 300 }), 'aucun écran de connexion Socrate');
  await p.getByRole('textbox', { name: 'Votre commentaire global' }).fill('Le délai de 24 heures me paraît trop court.');
  await p.getByRole('button', { name: 'Publier' }).click();
  await p.getByRole('status').filter({ hasText: 'Commentaire publié.' }).waitFor();
  await p.getByRole('textbox', { name: /Répondre au retour de Claire Morel/ }).fill('Je précise : surtout le vendredi.');
  await p.getByRole('button', { name: 'Répondre' }).click();
  await p.getByText('Je précise : surtout le vendredi.').waitFor();
  assert.equal(await p.getByTestId('socrate-thread').count(), 1, 'une réponse ne crée pas de nouveau retour');
  await page.reload();
  await openPanel(page);
  await p.getByText('Je précise : surtout le vendredi.').waitFor();
  assert.equal(await p.getByTestId('socrate-thread').count(), 1);
  await page.screenshot({ path: join(ARTIFACTS, 'relectrice-retour-persistant.png') });
  assert.deepEqual(ctx.blocked, [], 'aucune requête hors des origines de l’instance');
  await ctx.context.close();
});

test('trace réseau : aucun cookie ni token de l’hôte n’atteint le service', async () => {
  const ctx = await editorial(browser.newContext(origins()));
  const page = await ctx.context.newPage();
  await page.goto(`${stack.view.demoOrigin}/`);
  await page.getByRole('button', { name: /Se connecter comme Claire Morel, relectrice produit/ }).click();
  await openPanel(page);
  const p = panel(page);
  await p.getByRole('textbox', { name: 'Votre commentaire global' }).fill('Trace réseau.');
  await p.getByRole('button', { name: 'Publier' }).click();
  await p.getByRole('status').filter({ hasText: 'Commentaire publié.' }).waitFor();
  const seen = serviceOnly(ctx, () => true);
  assert.ok(seen.length >= 4, `requêtes observées : ${seen.length}`);
  assert.ok(seen.some((r) => r.url.endsWith('/v1/auth/session')));
  for (const r of seen) {
    assert.equal(r.headers['cookie'], undefined, `cookie hôte envoyé à ${r.url}`);
    const isSession = r.url.endsWith('/v1/auth/session');
    if (!isSession) assert.ok(!(r.postData ?? '').includes('assertion') && !/eyJhbGciOi/.test(r.headers['authorization'] ?? ''), `assertion hôte hors de l’échange de session : ${r.url}`);
    if (r.headers['authorization']) assert.match(r.headers['authorization'], /^Bearer [A-Za-z0-9_-]{43}$/, 'bearer Socrate opaque');
    assert.ok(!new URL(r.url).search.includes('token'), 'aucun token en URL');
  }
  await ctx.context.close();
});

test('résolution et réouverture par l’autrice et par le développeur ; refus de l’invité', async () => {
  const claire = await editorial(browser.newContext(origins()));
  const cp = await loginAs(claire, 'Claire Morel, relectrice produit');
  await openPanel(cp);
  const p = panel(cp);
  const thread = p.getByTestId('socrate-thread').first();
  await thread.getByRole('button', { name: 'Résoudre' }).click();
  await thread.getByText('Résolu').waitFor();
  await thread.getByRole('button', { name: 'Rouvrir' }).click();
  await thread.getByText('Ouvert').waitFor();

  const karim = await editorial(browser.newContext(origins()));
  const kp = await loginAs(karim, 'Karim Benali, développeur');
  await openPanel(kp);
  const kpanel = panel(kp);
  await kpanel.getByText('· développeur').waitFor();
  const kthread = kpanel.getByTestId('socrate-thread').first();
  await kthread.getByRole('button', { name: 'Résoudre' }).click();
  await kthread.getByText('Résolu').waitFor();
  await kthread.getByRole('button', { name: 'Rouvrir' }).click();
  await kthread.getByText('Ouvert').waitFor();
  await kp.screenshot({ path: join(ARTIFACTS, 'developpeur-resout-rouvre.png') });

  const invite = await editorial(browser.newContext(origins()));
  const ip = await loginAs(invite, 'Invité sans capacité');
  await showList(ip);
  const ipanel = panel(ip);
  await ipanel.getByRole('alert').filter({ hasText: 'Votre accès ne permet pas de participer à cette revue.' }).waitFor();
  assert.equal(await ipanel.getByRole('button', { name: 'Résoudre' }).count(), 0);
  assert.equal(await ipanel.getByRole('button', { name: 'Publier' }).count(), 0);
  await ip.screenshot({ path: join(ARTIFACTS, 'invite-sans-capacite.png') });
  await claire.context.close(); await karim.context.close(); await invite.context.close();
});

test('impersonation : message attribué à l’acteur réel, compte exploré affiché à part', async () => {
  const ctx = await editorial(browser.newContext(origins()));
  const page = await loginAs(ctx, 'Claire Morel explorant le compte du Cabinet Dupont');
  await openPanel(page);
  const p = panel(page);
  await p.getByText('explore le compte cabinet-dupont').waitFor();
  await p.getByRole('textbox', { name: 'Votre commentaire global' }).fill('Vu depuis le compte du cabinet.');
  await p.getByRole('button', { name: 'Publier' }).click();
  await p.getByRole('status').filter({ hasText: 'Commentaire publié.' }).waitFor();
  const t = p.getByTestId('socrate-thread').filter({ hasText: 'Vu depuis le compte du cabinet.' });
  await t.getByText('Claire Morel (compte exploré : cabinet-dupont)').waitFor();
  await ctx.context.close();
});

test('second onglet : réponse et état à jour au retour au premier plan, brouillon conservé', async () => {
  const ctx = await editorial(browser.newContext(origins()));
  const a = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openPanel(a);
  const pa = panel(a);
  await pa.getByRole('textbox', { name: 'Votre commentaire global' }).fill('Brouillon en cours dans le premier onglet');
  const b = await ctx.context.newPage();
  await b.goto(`${stack.view.demoOrigin}/`);
  await openPanel(b);
  const pb = panel(b);
  const first = pb.getByTestId('socrate-thread').first();
  await first.getByRole('textbox', { name: /Répondre/ }).fill('Réponse depuis le second onglet');
  await first.getByRole('button', { name: 'Répondre' }).click();
  await first.getByText('Réponse depuis le second onglet').waitFor();
  await first.getByRole('button', { name: 'Résoudre' }).click();
  await first.getByText('Résolu').waitFor();
  await a.bringToFront();
  await bringBack(a);
  const firstA = pa.getByTestId('socrate-thread').first();
  await firstA.getByText('Réponse depuis le second onglet').waitFor();
  await firstA.getByText('Résolu').waitFor();
  assert.equal(await pa.getByRole('textbox', { name: 'Votre commentaire global' }).inputValue(), 'Brouillon en cours dans le premier onglet');
  await a.screenshot({ path: join(ARTIFACTS, 'second-onglet-brouillon-conserve.png') });
  await ctx.context.close();
});

test('masquer puis rouvrir conserve le brouillon global, le brouillon de réponse et l’envoi en attente', async () => {
  const ctx = await editorial(browser.newContext(origins()));
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openPanel(page);
  const p = panel(page);
  await p.getByRole('textbox', { name: 'Votre commentaire global' }).fill('Brouillon global avant masquage');
  await p.getByTestId('socrate-thread').first().getByRole('textbox', { name: /Répondre/ }).fill('Brouillon de réponse avant masquage');
  await toggleList(page);
  assert.ok(!(await page.locator('#socrate-frame').isVisible()), 'le panneau est masqué');
  await showList(page);
  await p.getByRole('heading', { level: 1, name: 'Rappels automatiques des rendez-vous' }).waitFor();
  assert.equal(await p.getByRole('textbox', { name: 'Votre commentaire global' }).inputValue(), 'Brouillon global avant masquage');
  assert.equal(await p.getByTestId('socrate-thread').first().getByRole('textbox', { name: /Répondre/ }).inputValue(), 'Brouillon de réponse avant masquage');

  await stack.stopService();
  await p.getByRole('button', { name: 'Publier' }).click();
  await p.getByRole('alert').filter({ hasText: 'Votre brouillon est conservé' }).waitFor();
  await p.getByRole('button', { name: 'Fermer la revue' }).click();
  await showList(page);
  await stack.startService();
  await p.getByRole('alert').filter({ hasText: 'Votre brouillon est conservé' }).getByRole('button', { name: 'Réessayer' }).click();
  await p.getByRole('status').filter({ hasText: 'Commentaire publié.' }).waitFor();
  assert.equal(await messagesNamed('Brouillon global avant masquage'), 1, 'l’envoi a survécu au masquage et publie une seule fois');
  const posts = serviceOnly(ctx, isThreadsPost);
  assert.equal(new Set(keysOf(posts)).size, 1, 'une seule clé pour cet envoi');
  await page.screenshot({ path: join(ARTIFACTS, 'masquer-rouvrir-brouillons.png') });
  await ctx.context.close();
});

test('réponse perdue après commit puis Réessayer : même clé, aucun doublon, pour un commentaire et pour une réponse', async () => {
  const ctx = await editorial(browser.newContext(origins()));
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openPanel(page);
  const p = panel(page);
  loseOnce(ctx, (r) => isThreadsPost(r) || isReplyPost(r));
  await p.getByRole('textbox', { name: 'Votre commentaire global' }).fill('Réponse perdue après commit');
  await p.getByRole('button', { name: 'Publier' }).click();
  await p.getByRole('alert').filter({ hasText: 'Votre brouillon est conservé' }).waitFor();
  await p.getByTestId('socrate-pending').filter({ hasText: 'peut-être déjà été publié' }).waitFor();
  assert.equal(await messagesNamed('Réponse perdue après commit'), 1, 'le Worker a bien commité avant la perte');
  await page.screenshot({ path: join(ARTIFACTS, 'reponse-perdue-avant-reessai.png') });
  await p.getByRole('button', { name: 'Réessayer' }).click();
  await p.getByRole('status').filter({ hasText: 'Commentaire publié.' }).waitFor();
  assert.equal(await p.getByRole('textbox', { name: 'Votre commentaire global' }).inputValue(), '');
  const posts = serviceOnly(ctx, isThreadsPost);
  assert.deepEqual(keysOf(posts), [keysOf(posts)[0], keysOf(posts)[0]], 'le réessai garde la même clé');
  assert.equal(await messagesNamed('Réponse perdue après commit'), 1);
  assert.equal(await p.getByTestId('socrate-thread').filter({ hasText: 'Réponse perdue après commit' }).count(), 1);

  loseOnce(ctx, isReplyPost);
  const thread = p.getByTestId('socrate-thread').filter({ hasText: 'Réponse perdue après commit' });
  await thread.getByRole('textbox', { name: /Répondre/ }).fill('Réponse dont l’accusé se perd');
  await thread.getByRole('button', { name: 'Répondre' }).click();
  await p.getByRole('alert').filter({ hasText: 'Votre brouillon est conservé' }).waitFor();
  assert.equal(await messagesNamed('Réponse dont l’accusé se perd'), 1);
  await p.getByRole('button', { name: 'Réessayer' }).click();
  await p.getByRole('status').filter({ hasText: 'Réponse publiée.' }).waitFor();
  const replies = serviceOnly(ctx, isReplyPost);
  assert.deepEqual(keysOf(replies), [keysOf(replies)[0], keysOf(replies)[0]]);
  assert.equal(await messagesNamed('Réponse dont l’accusé se perd'), 1);
  assert.equal(await thread.getByText('Réponse dont l’accusé se perd').count(), 1);
  await page.screenshot({ path: join(ARTIFACTS, 'reponse-perdue-reprise-sans-doublon.png') });
  await ctx.context.close();
});

test('réponse perdue, texte édité, puis Publier : l’envoi en attente est repris tel quel, le texte édité reste en brouillon et se publie par un nouveau clic', async () => {
  const ctx = await editorial(browser.newContext(origins()));
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openPanel(page);
  const p = panel(page);
  loseOnce(ctx, isThreadsPost);
  const box = p.getByRole('textbox', { name: 'Votre commentaire global' });
  await box.fill('Version A');
  await p.getByRole('button', { name: 'Publier' }).click();
  await p.getByRole('alert').filter({ hasText: 'Votre brouillon est conservé' }).waitFor();
  await box.fill('Version A corrigée');
  await p.getByTestId('socrate-pending').filter({ hasText: 'Version A' }).waitFor();
  await p.getByRole('button', { name: 'Publier' }).click();
  await p.getByRole('status').filter({ hasText: 'Votre envoi précédent est publié. Le texte modifié depuis reste en brouillon' }).waitFor();
  const posts = serviceOnly(ctx, isThreadsPost);
  assert.deepEqual(keysOf(posts), [keysOf(posts)[0], keysOf(posts)[0]], 'Publier reprend la même opération');
  assert.deepEqual(bodiesOf(posts), ['Version A', 'Version A'], 'avec la même charge');
  assert.equal(await box.inputValue(), 'Version A corrigée', 'le texte édité n’est pas effacé');
  assert.equal(await messagesNamed('Version A'), 1);
  assert.equal(await messagesNamed('Version A corrigée'), 0, 'rien n’est republié silencieusement');
  assert.equal(await p.getByTestId('socrate-pending').count(), 0);
  await page.screenshot({ path: join(ARTIFACTS, 'reponse-perdue-texte-edite.png') });
  await p.getByRole('button', { name: 'Publier' }).click();
  await p.getByRole('status').filter({ hasText: 'Commentaire publié.' }).waitFor();
  const all = serviceOnly(ctx, isThreadsPost);
  assert.equal(all.length, 3);
  assert.notEqual(keysOf(all)[2], keysOf(all)[0], 'le texte édité part avec une nouvelle clé');
  assert.equal(await messagesNamed('Version A corrigée'), 1);
  assert.equal(await box.inputValue(), '');
  await ctx.context.close();
});

test('texte saisi pendant l’envoi : conservé après la réponse, seul le texte envoyé est durable', async () => {
  const ctx = await editorial(browser.newContext(origins()));
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openPanel(page);
  const p = panel(page);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  ctx.setFaults((r) => (isThreadsPost(r) ? { kind: 'hold', until: gate } : { kind: 'pass' }));
  const box = p.getByRole('textbox', { name: 'Votre commentaire global' });
  await box.fill('Texte envoyé');
  await p.getByRole('button', { name: 'Publier' }).click();
  await p.getByRole('status').filter({ hasText: 'Publication en cours' }).waitFor();
  await box.fill('Texte envoyé, puis complété pendant l’attente');
  release();
  await p.getByRole('status').filter({ hasText: 'Votre envoi précédent est publié' }).waitFor();
  assert.equal(await box.inputValue(), 'Texte envoyé, puis complété pendant l’attente');
  assert.equal(await messagesNamed('Texte envoyé'), 1);
  assert.equal(await messagesNamed('Texte envoyé, puis complété pendant l’attente'), 0);
  await ctx.context.close();
});

test('mutation confirmée puis lecture échouée : Réessayer ne refait que la lecture', async () => {
  const ctx = await editorial(browser.newContext(origins()));
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openPanel(page);
  const p = panel(page);
  let failReads = false;
  ctx.setFaults((r) => {
    if (r.method === 'POST') { failReads = true; return { kind: 'pass' }; }
    if (isThreadsGet(r) && failReads) { failReads = false; return { kind: 'abort' }; }
    return { kind: 'pass' };
  });
  await p.getByRole('textbox', { name: 'Votre commentaire global' }).fill('Publié mais liste non rechargée');
  await p.getByRole('button', { name: 'Publier' }).click();
  await p.getByRole('alert').filter({ hasText: 'Commentaire publié. La liste n’a pas pu être rechargée.' }).waitFor();
  assert.equal(await p.getByRole('textbox', { name: 'Votre commentaire global' }).inputValue(), '', 'la mutation est confirmée, le brouillon est consommé');
  await page.screenshot({ path: join(ARTIFACTS, 'publie-liste-non-rechargee.png') });
  await p.getByRole('button', { name: 'Réessayer' }).click();
  await p.getByTestId('socrate-thread').filter({ hasText: 'Publié mais liste non rechargée' }).waitFor();
  assert.equal(serviceOnly(ctx, (r) => r.method === 'POST' && !r.url.endsWith('/v1/auth/session')).length, 1, 'aucune seconde publication');
  assert.equal(await messagesNamed('Publié mais liste non rechargée'), 1);
  await ctx.context.close();
});

test('identité renouvelée sous un autre compte : publication bloquée, identité et droits affichés mis à jour, texte conservé, remount dans le même onglet', async () => {
  const ctx = await editorial(browser.newContext(origins()));
  const a = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openPanel(a);
  const pa = panel(a);
  await pa.getByTestId('socrate-identity').filter({ hasText: 'Claire Morel' }).waitFor();
  await pa.getByRole('textbox', { name: 'Votre commentaire global' }).fill('Écrit par Claire, jamais publié sous Karim');
  await expireSessions('demo-host:claire');
  await switchPersona(ctx, /Se connecter comme Karim Benali/);
  await pa.getByRole('button', { name: 'Publier' }).click();
  await pa.getByRole('alert').filter({ hasText: 'L’identité de l’hôte a changé (Karim Benali)' }).waitFor();
  await pa.getByTestId('socrate-identity').filter({ hasText: 'Karim Benali' }).waitFor();
  await pa.getByText('· développeur').waitFor();
  assert.equal(await messagesNamed('Écrit par Claire, jamais publié sous Karim'), 0, 'rien n’est publié sous l’autre identité');
  assert.equal(serviceOnly(ctx, isThreadsPost).length, 1, 'une seule émission, refusée en 401 sous la session expirée de Claire');
  assert.equal(await pa.getByRole('textbox', { name: 'Votre commentaire global' }).inputValue(), 'Écrit par Claire, jamais publié sous Karim', 'le texte n’est pas perdu');
  await a.screenshot({ path: join(ARTIFACTS, 'identite-renouvelee-refus.png') });

  await toggleList(a);
  await a.getByRole('button', { name: 'Se déconnecter' }).click();
  await a.getByRole('button', { name: /Se connecter comme Karim Benali/ }).click();
  await openPanel(a);
  await pa.getByTestId('socrate-identity').filter({ hasText: 'Karim Benali' }).waitFor();
  assert.equal(await pa.getByRole('textbox', { name: 'Votre commentaire global' }).inputValue(), '', 'le remount par key repart sans brouillon de l’identité précédente');
  await ctx.context.close();
});

test('réponse perdue sous Claire, GET renouvelé sous Karim au retour d’onglet, Réessayer bloqué ; retour sous Claire puis rejeu une seule fois ; nouveau clic sous Karim avec nouvelle clé', async () => {
  const ctx = await editorial(browser.newContext(origins()));
  const a = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openPanel(a);
  const pa = panel(a);
  loseOnce(ctx, isThreadsPost);
  const box = pa.getByRole('textbox', { name: 'Votre commentaire global' });
  await box.fill('Intention de Claire, réponse perdue');
  await pa.getByRole('button', { name: 'Publier' }).click();
  await pa.getByRole('alert').filter({ hasText: 'Votre brouillon est conservé' }).waitFor();
  assert.equal(await messagesNamed('Intention de Claire, réponse perdue'), 1);
  await box.fill('Brouillon B édité ensuite');
  await expireSessions('demo-host:claire');
  await switchPersona(ctx, /Se connecter comme Karim Benali/);
  await bringBack(a);
  await pa.getByTestId('socrate-identity').filter({ hasText: 'Karim Benali' }).waitFor();
  const claireToken = serviceOnly(ctx, isThreadsPost)[0]!.headers['authorization'];
  await pa.getByRole('button', { name: 'Réessayer' }).click();
  await pa.getByRole('alert').filter({ hasText: 'L’identité de l’hôte a changé (Karim Benali)' }).waitFor();
  await pa.getByRole('alert').filter({ hasText: 'peut-être déjà été publié' }).waitFor();
  await pa.getByTestId('socrate-pending').filter({ hasText: 'Intention de Claire, réponse perdue' }).waitFor();
  assert.equal(await box.inputValue(), 'Brouillon B édité ensuite', 'le brouillon édité reste distinct et intact');
  const posts = serviceOnly(ctx, isThreadsPost);
  assert.equal(posts.length, 1, 'aucune émission de l’intention sous Karim');
  assert.equal(posts[0]!.headers['authorization'], claireToken);
  assert.deepEqual(await authorsOf('Intention de Claire, réponse perdue'), [{ author_key: 'demo-host:claire', exploring: null }]);
  await a.screenshot({ path: join(ARTIFACTS, 'intention-bloquee-identite.png') });

  await switchPersona(ctx, /Se connecter comme Claire Morel, relectrice produit/);
  await expireSessions('demo-host:karim');
  await bringBack(a);
  await pa.getByTestId('socrate-identity').filter({ hasText: 'Claire Morel' }).waitFor();
  await pa.getByRole('button', { name: 'Réessayer' }).click();
  await pa.getByRole('status').filter({ hasText: 'Votre envoi précédent est publié' }).waitFor();
  const replayed = serviceOnly(ctx, isThreadsPost);
  assert.equal(replayed.length, 2);
  assert.equal(keysOf(replayed)[1], keysOf(replayed)[0], 'même clé rejouée sous Claire');
  assert.equal(await messagesNamed('Intention de Claire, réponse perdue'), 1, 'une seule écriture');
  assert.equal(await box.inputValue(), 'Brouillon B édité ensuite');
  assert.equal(await pa.getByTestId('socrate-pending').count(), 0);

  await expireSessions('demo-host:claire');
  await switchPersona(ctx, /Se connecter comme Karim Benali/);
  await bringBack(a);
  await pa.getByTestId('socrate-identity').filter({ hasText: 'Karim Benali' }).waitFor();
  await pa.getByRole('button', { name: 'Publier' }).click();
  await pa.getByRole('status').filter({ hasText: 'Commentaire publié.' }).waitFor();
  const all = serviceOnly(ctx, isThreadsPost);
  assert.equal(all.length, 3);
  assert.notEqual(keysOf(all)[2], keysOf(all)[0], 'le nouveau clic crée une nouvelle intention avec une nouvelle clé');
  assert.deepEqual(await authorsOf('Brouillon B édité ensuite'), [{ author_key: 'demo-host:karim', exploring: null }], 'publié sous l’identité affichée au clic');
  await ctx.context.close();
});

for (const order of ['GET puis mutation', 'mutation puis GET'] as const) {
  test(`deux 401 concurrents livrés dans l’ordre ${order}, assertion partagée renouvelée sous Karim : la mutation reste sous son propriétaire et n’est pas réémise`, async () => {
    const ctx = await editorial(browser.newContext(origins()));
    const a = await loginAs(ctx, 'Claire Morel, relectrice produit');
    await openPanel(a);
    const pa = panel(a);
    await expireSessions('demo-host:claire');
    await switchPersona(ctx, /Se connecter comme Karim Benali/);
    let releaseGet!: () => void;
    let releasePost!: () => void;
    const getGate = new Promise<void>((r) => { releaseGet = r; });
    const postGate = new Promise<void>((r) => { releasePost = r; });
    let heldGet = false;
    let heldPost = false;
    ctx.setFaults((r) => {
      if (isThreadsGet(r) && !heldGet) { heldGet = true; return { kind: 'hold-response', until: getGate }; }
      if (isThreadsPost(r) && !heldPost) { heldPost = true; return { kind: 'hold-response', until: postGate }; }
      return { kind: 'pass' };
    });
    await pa.getByRole('textbox', { name: 'Votre commentaire global' }).fill(`Deux 401, ${order}`);
    await bringBack(a);
    await pa.getByRole('button', { name: 'Publier' }).click();
    await pa.getByRole('status').filter({ hasText: 'Publication en cours' }).waitFor();
    if (order === 'GET puis mutation') { releaseGet(); await new Promise((r) => setTimeout(r, 300)); releasePost(); } else { releasePost(); await new Promise((r) => setTimeout(r, 300)); releaseGet(); }
    await pa.getByRole('alert').filter({ hasText: 'L’identité de l’hôte a changé (Karim Benali)' }).waitFor();
    await pa.getByTestId('socrate-identity').filter({ hasText: 'Karim Benali' }).waitFor();
    assert.equal(await messagesNamed(`Deux 401, ${order}`), 0, 'rien n’est écrit sous Karim');
    const posts = serviceOnly(ctx, isThreadsPost);
    assert.equal(posts.length, 1, 'une seule émission, celle refusée en 401 sous Claire');
    assert.equal(serviceOnly(ctx, (r) => r.url.endsWith('/v1/auth/session')).length, 2, 'une seule session renouvelée pour les deux 401');
    await ctx.context.close();
  });
}

test('assertion échouée pendant le renouvellement : intention conservée sans émission, puis reprise sous la même identité, une écriture', async () => {
  const ctx = await editorial(browser.newContext(origins()));
  const a = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openPanel(a);
  const pa = panel(a);
  await expireSessions('demo-host:claire');
  ctx.setFaults((r) => (r.url.endsWith('/api/socrate/assertion') ? { kind: 'respond', status: 500, body: { error: 'hôte indisponible' } } : { kind: 'pass' }));
  await pa.getByRole('textbox', { name: 'Votre commentaire global' }).fill('Assertion échouée puis reprise');
  await pa.getByRole('button', { name: 'Publier' }).click();
  await pa.getByRole('alert').filter({ hasText: 'renouvellement de session impossible' }).waitFor();
  await pa.getByTestId('socrate-pending').filter({ hasText: 'Assertion échouée puis reprise' }).waitFor();
  assert.equal(await pa.getByTestId('socrate-pending').filter({ hasText: 'peut-être déjà été publié' }).count(), 0, 'aucune écriture possible n’est annoncée');
  ctx.setFaults(null);
  await pa.getByRole('button', { name: 'Réessayer' }).click();
  await pa.getByRole('status').filter({ hasText: 'Commentaire publié.' }).waitFor();
  const posts = serviceOnly(ctx, isThreadsPost);
  assert.equal(new Set(keysOf(posts)).size, 1);
  assert.equal(await messagesNamed('Assertion échouée puis reprise'), 1);
  await ctx.context.close();
});

test('contexte exploré différent : même acteur réel mais compte exploré changé, la reprise est bloquée sans émission', async () => {
  const ctx = await editorial(browser.newContext(origins()));
  const a = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openPanel(a);
  const pa = panel(a);
  loseOnce(ctx, isReplyPost);
  const thread = pa.getByTestId('socrate-thread').first();
  await thread.getByRole('textbox', { name: /Répondre/ }).fill('Réponse de Claire hors impersonation');
  await thread.getByRole('button', { name: 'Répondre' }).click();
  await pa.getByRole('alert').filter({ hasText: 'Votre brouillon est conservé' }).waitFor();
  assert.equal(await messagesNamed('Réponse de Claire hors impersonation'), 1);
  await expireSessions('demo-host:claire');
  await switchPersona(ctx, /Se connecter comme Claire Morel explorant le compte du Cabinet Dupont/);
  await bringBack(a);
  await pa.getByTestId('socrate-identity').filter({ hasText: 'explore le compte cabinet-dupont' }).waitFor();
  await pa.getByRole('button', { name: 'Réessayer' }).click();
  await pa.getByRole('alert').filter({ hasText: 'L’identité de l’hôte a changé (Claire Morel (compte exploré : cabinet-dupont))' }).waitFor();
  assert.equal(serviceOnly(ctx, isReplyPost).length, 1, 'aucune réémission sous le contexte exploré');
  assert.deepEqual(await authorsOf('Réponse de Claire hors impersonation'), [{ author_key: 'demo-host:claire', exploring: null }]);
  await pa.getByTestId('socrate-pending-reply').getByRole('button', { name: 'Abandonner la reprise' }).click();
  await pa.getByRole('status').filter({ hasText: 'Reprise abandonnée. L’envoi précédent a peut-être déjà été publié' }).waitFor();
  assert.equal(await thread.getByRole('textbox', { name: /Répondre/ }).inputValue(), 'Réponse de Claire hors impersonation', 'le brouillon vide reçoit l’ancien texte');
  assert.equal(serviceOnly(ctx, isReplyPost).length, 1, 'l’abandon ne publie rien');
  await a.screenshot({ path: join(ARTIFACTS, 'abandon-reprise-contexte-explore.png') });
  await ctx.context.close();
});

test('B3 : première tentative refusée en 422 (16 001 caractères) libère l’intention ; le texte raccourci part avec une nouvelle clé, pour un commentaire et pour une réponse', async () => {
  const ctx = await editorial(browser.newContext(origins()));
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openPanel(page);
  const p = panel(page);
  const long = 'x'.repeat(16_001);
  const box = p.getByRole('textbox', { name: 'Votre commentaire global' });
  await box.fill(long);
  await p.getByRole('button', { name: 'Publier' }).click();
  await p.getByRole('alert').filter({ hasText: 'Rien n’a été publié : corrigez le texte puis publiez à nouveau.' }).waitFor();
  assert.equal(await p.getByTestId('socrate-pending').count(), 0, 'aucun envoi en attente après un refus certain');
  assert.equal((await box.inputValue()).length, 16_001, 'le texte à corriger est conservé');
  await box.fill('Texte raccourci après 422');
  await p.getByRole('button', { name: 'Publier' }).click();
  await p.getByRole('status').filter({ hasText: 'Commentaire publié.' }).waitFor();
  const posts = serviceOnly(ctx, isThreadsPost);
  assert.equal(posts.length, 2);
  assert.notEqual(keysOf(posts)[0], keysOf(posts)[1], 'nouvelle clé pour le texte corrigé');
  assert.equal(await messagesNamed('Texte raccourci après 422'), 1);
  await page.screenshot({ path: join(ARTIFACTS, 'refus-422-puis-correction.png') });

  const thread = p.getByTestId('socrate-thread').filter({ hasText: 'Texte raccourci après 422' });
  const replyBox = thread.getByRole('textbox', { name: /Répondre/ });
  await replyBox.fill(long);
  await thread.getByRole('button', { name: 'Répondre' }).click();
  await p.getByRole('alert').filter({ hasText: 'Rien n’a été publié : corrigez le texte puis publiez à nouveau.' }).waitFor();
  await replyBox.fill('Réponse raccourcie après 422');
  await thread.getByRole('button', { name: 'Répondre' }).click();
  await p.getByRole('status').filter({ hasText: 'Réponse publiée.' }).waitFor();
  const replies = serviceOnly(ctx, isReplyPost);
  assert.equal(replies.length, 2);
  assert.notEqual(keysOf(replies)[0], keysOf(replies)[1]);
  assert.equal(await messagesNamed('Réponse raccourcie après 422'), 1);
  await ctx.context.close();
});

for (const [slot, status] of [['comment', 422], ['comment', 403], ['reply', 422], ['reply', 403]] as const) {
  test(`B3 : ${slot === 'comment' ? 'commentaire' : 'réponse'} dont la réponse est perdue après commit, puis ${status} injecté à la reprise : incertitude conservée, abandon sans émission ni remplacement de B, nouveau clic avec nouvelle clé`, async () => {
    const ctx = await editorial(browser.newContext(origins()));
    const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
    await openPanel(page);
    const p = panel(page);
    const marker = `B3 ${slot} ${status} ${crypto.randomUUID().slice(0, 8)}`;
    let thread = p.getByTestId('socrate-thread').first();
    if (slot === 'reply') {
      await p.getByRole('textbox', { name: 'Votre commentaire global' }).fill(`${marker} support`);
      await p.getByRole('button', { name: 'Publier' }).click();
      await p.getByRole('status').filter({ hasText: 'Commentaire publié.' }).waitFor();
      thread = p.getByTestId('socrate-thread').filter({ hasText: `${marker} support` });
    }
    const matches = slot === 'comment' ? isThreadsPost : isReplyPost;
    const box = slot === 'comment' ? p.getByRole('textbox', { name: 'Votre commentaire global' }) : thread.getByRole('textbox', { name: /Répondre/ });
    const button = slot === 'comment' ? p.getByRole('button', { name: 'Publier' }) : thread.getByRole('button', { name: 'Répondre' });
    const pending = p.getByTestId(slot === 'comment' ? 'socrate-pending' : 'socrate-pending-reply');
    loseOnce(ctx, matches);
    await box.fill(`${marker} A`);
    await button.click();
    await p.getByRole('alert').filter({ hasText: 'Votre brouillon est conservé' }).waitFor();
    await pending.filter({ hasText: 'peut-être déjà été publié' }).waitFor();
    assert.equal(await messagesNamed(`${marker} A`), 1, 'A est commis avant la perte');
    const body = status === 422 ? { code: 'invalid_request', message: 'retour invalide', requestId: 'x', retryable: false } : { code: 'forbidden', message: 'capacité absente', requestId: 'x', retryable: false };
    ctx.setFaults((r) => (matches(r) ? { kind: 'respond', status, body } : { kind: 'pass' }));
    await p.getByRole('button', { name: 'Réessayer' }).click();
    await p.getByRole('alert').filter({ hasText: 'ne prouve pas que l’envoi précédent n’a pas été publié' }).waitFor();
    await pending.filter({ hasText: 'peut-être déjà été publié' }).waitFor();
    assert.equal(serviceOnly(ctx, matches).length, 2, 'deux émissions de la même intention');
    assert.equal(new Set(keysOf(serviceOnly(ctx, matches))).size, 1, 'même clé');
    await page.screenshot({ path: join(ARTIFACTS, `b3-${slot}-${status}-incertain.png`) });
    await box.fill(`${marker} B`);
    await pending.getByRole('button', { name: 'Abandonner la reprise' }).click();
    await p.getByRole('status').filter({ hasText: 'Reprise abandonnée. L’envoi précédent a peut-être déjà été publié' }).waitFor();
    assert.equal(await pending.count(), 0);
    assert.equal(await box.inputValue(), `${marker} B`, 'B n’est jamais remplacé');
    assert.equal(serviceOnly(ctx, matches).length, 2, 'l’abandon n’émet rien');
    assert.equal(await messagesNamed(`${marker} A`), 1, 'l’abandon n’annule rien');
    ctx.setFaults(null);
    await button.click();
    await p.getByRole('status').filter({ hasText: slot === 'comment' ? 'Commentaire publié.' : 'Réponse publiée.' }).waitFor();
    const all = serviceOnly(ctx, matches);
    assert.equal(all.length, 3);
    assert.notEqual(keysOf(all)[2], keysOf(all)[0], 'le nouveau clic crée une nouvelle intention avec une nouvelle clé');
    assert.equal(await messagesNamed(`${marker} B`), 1);
    assert.equal(await messagesNamed(`${marker} A`), 1);
    await ctx.context.close();
  });
}

test('changement d’état : réponse perdue puis Réessayer rejoue la même clé et la même version attendue, une seule transition', async () => {
  const ctx = await editorial(browser.newContext(origins()));
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openPanel(page);
  const p = panel(page);
  await p.getByRole('textbox', { name: 'Votre commentaire global' }).fill('Retour à résoudre avec réponse perdue');
  await p.getByRole('button', { name: 'Publier' }).click();
  await p.getByRole('status').filter({ hasText: 'Commentaire publié.' }).waitFor();
  const thread = p.getByTestId('socrate-thread').filter({ hasText: 'Retour à résoudre avec réponse perdue' });
  loseOnce(ctx, isStatePut);
  await thread.getByRole('button', { name: 'Résoudre' }).click();
  await p.getByRole('alert').filter({ hasText: 'Votre brouillon est conservé' }).waitFor();
  await p.getByTestId('socrate-pending-state').filter({ hasText: 'passer à l’état résolu' }).waitFor();
  await p.getByRole('button', { name: 'Réessayer' }).click();
  await p.getByRole('status').filter({ hasText: 'État du retour modifié.' }).waitFor();
  await thread.getByText('Résolu').waitFor();
  const puts = serviceOnly(ctx, isStatePut);
  assert.equal(puts.length, 2);
  assert.equal(keysOf(puts)[0], keysOf(puts)[1]);
  assert.deepEqual(puts.map((r) => JSON.parse(r.postData ?? '{}')), [{ state: 'resolved', expectedVersion: 0 }, { state: 'resolved', expectedVersion: 0 }]);
  const threadId = (await stack.service.db.prepare("SELECT thread_id FROM messages WHERE body = 'Retour à résoudre avec réponse perdue'").first<{ thread_id: string }>())!.thread_id;
  const events = await stack.service.db.prepare("SELECT COUNT(*) AS n FROM changes WHERE thread_id = ? AND kind = 'thread.resolved'").bind(threadId).first<{ n: number }>();
  assert.equal(events!.n, 1);
  await ctx.context.close();
});

test('panneau isolé : un seul React, styles propres, événements dans l’iframe, focus et clavier', async () => {
  const ctx = await editorial(browser.newContext(origins()));
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openPanel(page);
  const facts = await page.evaluate(() => {
    const frame = document.getElementById('socrate-frame') as HTMLIFrameElement;
    const doc = frame.contentDocument!;
    const fiberKey = (el: Element) => Object.keys(el).find((k) => k.startsWith('__reactFiber$'))!.slice('__reactFiber$'.length);
    const hostNode = document.querySelector('[data-socrate="launcher"]')!;
    const panelNode = doc.querySelector('[data-testid="socrate-panel"]')!;
    const btn = doc.querySelector('button.socrate-button')!;
    const cs = doc.defaultView!.getComputedStyle(btn);
    const probe = document.body.appendChild(document.createElement('button'));
    const hostBtn = getComputedStyle(probe);
    return {
      sameReact: fiberKey(hostNode) === fiberKey(panelNode),
      iframeScripts: doc.scripts.length,
      iframeHasOwnStyle: doc.head.querySelectorAll('style').length === 1,
      panelFont: cs.fontFamily, hostFont: hostBtn.fontFamily, panelTransform: cs.textTransform, hostTransform: hostBtn.textTransform,
      activeIsFrame: document.activeElement === frame,
      innerActive: doc.activeElement?.tagName,
      viewportWidth: document.documentElement.clientWidth,
      sameOrigin: doc.defaultView!.location.origin === location.origin || doc.defaultView!.location.href === 'about:blank',
    };
  });
  assert.ok(facts.sameReact, 'le panneau est rendu par le React de l’hôte');
  assert.equal(facts.iframeScripts, 0, 'aucun script chargé dans l’iframe');
  assert.ok(facts.iframeHasOwnStyle);
  assert.notEqual(facts.panelFont, facts.hostFont, 'la police agressive de l’hôte ne contamine pas le panneau');
  assert.equal(facts.panelTransform, 'none');
  assert.equal(facts.hostTransform, 'uppercase');
  assert.ok(facts.activeIsFrame && facts.innerActive === 'H1', 'le focus entre dans le panneau à l’ouverture');
  assert.equal(facts.viewportWidth, 1280, 'le panneau ne réduit pas la largeur de la scène');
  await panel(page).getByRole('button', { name: 'Réglages des rappels' }).click();
  await page.waitForURL(/\/reglages\/rappels$/);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const focused = await page.evaluate(() => { const d = (document.getElementById('socrate-frame') as HTMLIFrameElement).contentDocument!; return d.activeElement && d.activeElement !== d.body ? d.activeElement.tagName : null; });
  assert.ok(focused === 'BUTTON' || focused === 'TEXTAREA', `le parcours clavier continue dans le panneau (${focused})`);
  await page.screenshot({ path: join(ARTIFACTS, 'panneau-isole-reglages.png') });
  await ctx.context.close();
});

test('une erreur de rendu du panneau reste dans l’iframe : l’hôte continue de fonctionner', async () => {
  const ctx = await editorial(browser.newContext(origins()));
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openPanel(page);
  const p = panel(page);
  await p.getByTestId('socrate-thread').first().waitFor();
  await page.evaluate(() => { Date.prototype.toLocaleString = () => { throw new Error('rendu cassé (test)'); }; });
  await toggleList(page);
  await showList(page);
  await p.getByTestId('socrate-panel-failed').getByRole('alert').waitFor();
  assert.ok(await page.locator('[data-socrate-action="launcher"]').isVisible(), 'la racine React de l’hôte est intacte');
  await page.getByRole('link', { name: 'Réglages' }).click();
  await page.waitForURL(/\/reglages\/rappels$/);
  await page.getByRole('heading', { name: 'Rappels automatiques' }).waitFor();
  await page.screenshot({ path: join(ARTIFACTS, 'erreur-rendu-contenue.png') });
  await ctx.context.close();
});

test('service indisponible avant l’envoi : brouillon conservé, reprise sans doublon après redémarrage', async () => {
  const ctx = await editorial(browser.newContext(origins()));
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openPanel(page);
  const p = panel(page);
  await stack.stopService();
  await p.getByRole('textbox', { name: 'Votre commentaire global' }).fill('Publié pendant la coupure du service');
  await p.getByRole('button', { name: 'Publier' }).click();
  await p.getByRole('alert').filter({ hasText: 'Votre brouillon est conservé' }).waitFor();
  assert.equal(await p.getByRole('textbox', { name: 'Votre commentaire global' }).inputValue(), 'Publié pendant la coupure du service');
  await stack.startService();
  await p.getByRole('button', { name: 'Réessayer' }).click();
  await p.getByRole('status').filter({ hasText: 'Commentaire publié.' }).waitFor();
  await p.getByTestId('socrate-thread').filter({ hasText: 'Publié pendant la coupure du service' }).waitFor();
  assert.equal(await p.getByTestId('socrate-thread').filter({ hasText: 'Publié pendant la coupure du service' }).count(), 1);
  assert.equal(await messagesNamed('Publié pendant la coupure du service'), 1, 'un seul retour durable après reprise');
  await page.reload();
  await openPanel(page);
  await p.getByText('Publié pendant la coupure du service').waitFor();
  await page.screenshot({ path: join(ARTIFACTS, 'reprise-apres-redemarrage.png') });
  await ctx.context.close();
});

test('R3-4 : conflit 412 après deux transitions d’un autre participant ; relecture sans réémission, puis l’action suivante utilise la version relue', async () => {
  const claire = await editorial(browser.newContext(origins()));
  const cp = await loginAs(claire, 'Claire Morel, relectrice produit');
  await openPanel(cp);
  const p = panel(cp);
  const marker = `Conflit 412 ${crypto.randomUUID().slice(0, 8)}`;
  await p.getByRole('textbox', { name: 'Votre commentaire global' }).fill(marker);
  await p.getByRole('button', { name: 'Publier' }).click();
  await p.getByRole('status').filter({ hasText: 'Commentaire publié.' }).waitFor();
  const thread = p.getByTestId('socrate-thread').filter({ hasText: marker });
  await thread.getByText('Ouvert').waitFor();
  const karim = await editorial(browser.newContext(origins()));
  const kp = await loginAs(karim, 'Karim Benali, développeur');
  await openPanel(kp);
  const kthread = panel(kp).getByTestId('socrate-thread').filter({ hasText: marker });
  await kthread.getByRole('button', { name: 'Résoudre' }).click();
  await kthread.getByText('Résolu').waitFor();
  await kthread.getByRole('button', { name: 'Rouvrir' }).click();
  await kthread.getByText('Ouvert').waitFor();
  const threadId = (await stack.service.db.prepare('SELECT thread_id FROM messages WHERE body = ?').bind(marker).first<{ thread_id: string }>())!.thread_id;
  assert.equal((await stack.service.db.prepare('SELECT version FROM threads WHERE thread_id = ?').bind(threadId).first<{ version: number }>())!.version, 2, 'même état visible, version avancée de deux');
  await thread.getByRole('button', { name: 'Résoudre' }).click();
  await p.getByRole('status').filter({ hasText: 'L’état du retour a changé entre-temps ; cette transition n’a pas été appliquée. La liste est relue' }).waitFor();
  assert.equal(await p.getByText(/La liste a été rechargée|corrigez le texte/).count(), 0, 'aucun texte de correction de commentaire ni fausse promesse');
  assert.equal(await p.getByTestId('socrate-pending-state').count(), 0, 'aucune intention en attente après un refus certain');
  await cp.screenshot({ path: join(ARTIFACTS, 'conflit-412-relecture.png') });
  await thread.getByRole('button', { name: 'Résoudre' }).click();
  await p.getByRole('status').filter({ hasText: 'État du retour modifié.' }).waitFor();
  await thread.getByText('Résolu').waitFor();
  const puts = serviceOnly(claire, isStatePut);
  assert.deepEqual(puts.map((r) => JSON.parse(r.postData ?? '{}')), [{ state: 'resolved', expectedVersion: 0 }, { state: 'resolved', expectedVersion: 2 }], 'la première transition est refusée, la seconde porte la version relue');
  assert.notEqual(keysOf(puts)[0], keysOf(puts)[1], 'aucune réémission de l’intention périmée');
  const resolved = await stack.service.db.prepare("SELECT COUNT(*) AS n FROM changes WHERE thread_id = ? AND kind = 'thread.resolved'").bind(threadId).first<{ n: number }>();
  assert.equal(resolved!.n, 2, 'une résolution de Karim puis une de Claire');
  await claire.context.close();
  await karim.context.close();
});

test('R3-4 et R4-6 : conflit 412 puis deux relectures échouées ; chaque Réessayer ne refait que la lecture, le refus reste annoncé, aucune transition appliquée n’est annoncée, la troisième lecture réussit et l’action suivante porte la version relue', async () => {
  const claire = await editorial(browser.newContext(origins()));
  const cp = await loginAs(claire, 'Claire Morel, relectrice produit');
  await openPanel(cp);
  const p = panel(cp);
  const marker = `Conflit 412 relecture ${crypto.randomUUID().slice(0, 8)}`;
  await p.getByRole('textbox', { name: 'Votre commentaire global' }).fill(marker);
  await p.getByRole('button', { name: 'Publier' }).click();
  await p.getByRole('status').filter({ hasText: 'Commentaire publié.' }).waitFor();
  const thread = p.getByTestId('socrate-thread').filter({ hasText: marker });
  const karim = await editorial(browser.newContext(origins()));
  const kp = await loginAs(karim, 'Karim Benali, développeur');
  await openPanel(kp);
  const kthread = panel(kp).getByTestId('socrate-thread').filter({ hasText: marker });
  await kthread.getByRole('button', { name: 'Résoudre' }).click();
  await kthread.getByText('Résolu').waitFor();
  await kthread.getByRole('button', { name: 'Rouvrir' }).click();
  await kthread.getByText('Ouvert').waitFor();
  let failReads = 0;
  claire.setFaults((r) => {
    if (isStatePut(r)) { failReads = 2; return { kind: 'pass' }; }
    if (isThreadsGet(r) && failReads > 0) { failReads -= 1; return { kind: 'abort' }; }
    return { kind: 'pass' };
  });
  const getsBefore = serviceOnly(claire, isThreadsGet).length;
  await thread.getByRole('button', { name: 'Résoudre' }).click();
  const conflictAlert = p.getByRole('alert').filter({ hasText: 'L’état du retour a changé entre-temps ; cette transition n’a pas été appliquée. La liste n’a pas pu être relue.' });
  await conflictAlert.waitFor();
  const nothingApplied = async (step: string) => {
    const announced = [...await p.getByRole('status').filter({ hasText: /La liste est relue|État du retour modifié/ }).allInnerTexts(), ...await p.getByRole('alert').filter({ hasText: /État du retour modifié|rechargée|publié/ }).allInnerTexts()];
    assert.deepEqual(announced, [], `${step} : ni transition appliquée ni rechargement annoncés dans les messages du panneau`);
    assert.equal(serviceOnly(claire, isStatePut).length, 1, `${step} : aucune réémission de la mutation`);
  };
  await nothingApplied('première lecture échouée');
  assert.equal(serviceOnly(claire, isThreadsGet).length, getsBefore + 1);
  await conflictAlert.getByRole('button', { name: 'Réessayer' }).click();
  await p.getByRole('status').filter({ hasText: 'Relecture de la liste…' }).waitFor({ state: 'detached' });
  await conflictAlert.waitFor();
  assert.equal(serviceOnly(claire, isThreadsGet).length, getsBefore + 2, 'le second Réessayer a refait une lecture seule');
  await nothingApplied('seconde lecture échouée');
  await cp.screenshot({ path: join(ARTIFACTS, 'r4-6-conflit-412-deux-relectures-echouees.png') });
  await conflictAlert.getByRole('button', { name: 'Réessayer' }).click();
  await p.getByRole('status').filter({ hasText: 'L’état du retour a changé entre-temps ; cette transition n’a pas été appliquée. La liste est relue' }).waitFor();
  assert.equal(serviceOnly(claire, isThreadsGet).length, getsBefore + 3, 'la troisième lecture a réussi');
  assert.equal(serviceOnly(claire, isStatePut).length, 1, 'toujours une seule mutation émise');
  assert.equal(await p.getByText('État du retour modifié').count(), 0);
  claire.setFaults(null);
  await thread.getByRole('button', { name: 'Résoudre' }).click();
  await thread.getByText('Résolu').waitFor();
  const puts = serviceOnly(claire, isStatePut);
  assert.deepEqual(puts.map((r) => JSON.parse(r.postData ?? '{}').expectedVersion), [0, 2]);
  await claire.context.close();
  await karim.context.close();
});

test('V3-F1 : réponse A figée, B saisi en vol, 401 puis pont d’assertion en échec ; avis, charge, brouillon B et reprise restent visibles sans session, puis reprise avec la même clé', async () => {
  const ctx = await editorial(browser.newContext(origins()));
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openPanel(page);
  const p = panel(page);
  const marker = `V3-F1 ${crypto.randomUUID().slice(0, 8)}`;
  await p.getByRole('textbox', { name: 'Votre commentaire global' }).fill(`${marker} support`);
  await p.getByRole('button', { name: 'Publier' }).click();
  await p.getByRole('status').filter({ hasText: 'Commentaire publié.' }).waitFor();
  const thread = p.getByTestId('socrate-thread').filter({ hasText: `${marker} support` });
  const box = thread.getByRole('textbox', { name: /Répondre/ });
  await expireSessions('demo-host:claire');
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let held = false;
  ctx.setFaults((r) => {
    if (r.url.endsWith('/api/socrate/assertion')) return { kind: 'respond', status: 500, body: { error: 'pont indisponible' } };
    if (isReplyPost(r) && !held) { held = true; return { kind: 'hold-response', until: gate }; }
    return { kind: 'pass' };
  });
  await box.fill(`${marker} A`);
  await thread.getByRole('button', { name: 'Répondre' }).click();
  await p.getByRole('status').filter({ hasText: 'Envoi de la réponse…' }).waitFor();
  await box.fill(`${marker} B`);
  release();
  await p.getByRole('alert').filter({ hasText: 'renouvellement de session impossible' }).waitFor();
  const pending = p.getByTestId('socrate-pending-reply');
  await pending.filter({ hasText: `${marker} A` }).waitFor();
  assert.equal(await pending.filter({ hasText: 'peut-être déjà été publié' }).count(), 0, 'le 401 est un refus certain : aucune écriture annoncée');
  assert.equal(await p.getByTestId('socrate-identity').count(), 0, 'aucune session affichée pendant l’échec du pont');
  assert.equal(await box.inputValue(), `${marker} B`, 'le brouillon B reste visible sans session');
  assert.ok(await pending.getByRole('button', { name: 'Abandonner la reprise' }).isVisible());
  assert.ok(await p.getByRole('button', { name: 'Réessayer' }).isVisible());
  assert.equal(await messagesNamed(`${marker} A`), 0);
  await page.screenshot({ path: join(ARTIFACTS, 'v3-f1-reponse-visible-sans-session.png') });
  ctx.setFaults(null);
  await p.getByRole('button', { name: 'Réessayer' }).click();
  await p.getByRole('status').filter({ hasText: 'Votre réponse précédente est publiée. Le texte modifié depuis reste en brouillon' }).waitFor();
  await p.getByTestId('socrate-identity').filter({ hasText: 'Claire Morel' }).waitFor();
  const replies = serviceOnly(ctx, isReplyPost);
  assert.equal(replies.length, 2);
  assert.equal(keysOf(replies)[0], keysOf(replies)[1], 'même clé');
  assert.deepEqual(bodiesOf(replies), [`${marker} A`, `${marker} A`], 'même charge A');
  assert.equal(await messagesNamed(`${marker} A`), 1);
  assert.equal(await box.inputValue(), `${marker} B`);
  await ctx.context.close();
});

test('R3-5 : réponse A commise puis réponse perdue, GET au retour d’onglet avec pont d’assertion en échec ; l’intention incertaine reste visible, puis reprise rejouée une fois', async () => {
  const ctx = await editorial(browser.newContext(origins()));
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openPanel(page);
  const p = panel(page);
  const marker = `R3-5 GET ${crypto.randomUUID().slice(0, 8)}`;
  await p.getByRole('textbox', { name: 'Votre commentaire global' }).fill(`${marker} support`);
  await p.getByRole('button', { name: 'Publier' }).click();
  await p.getByRole('status').filter({ hasText: 'Commentaire publié.' }).waitFor();
  const thread = p.getByTestId('socrate-thread').filter({ hasText: `${marker} support` });
  loseOnce(ctx, isReplyPost);
  await thread.getByRole('textbox', { name: /Répondre/ }).fill(`${marker} A`);
  await thread.getByRole('button', { name: 'Répondre' }).click();
  await p.getByRole('alert').filter({ hasText: 'Votre brouillon est conservé' }).waitFor();
  assert.equal(await messagesNamed(`${marker} A`), 1);
  await expireSessions('demo-host:claire');
  ctx.setFaults((r) => (r.url.endsWith('/api/socrate/assertion') ? { kind: 'respond', status: 500, body: { error: 'pont indisponible' } } : { kind: 'pass' }));
  await bringBack(page);
  await p.getByTestId('socrate-identity').waitFor({ state: 'detached' });
  const pending = p.getByTestId('socrate-pending-reply');
  await pending.filter({ hasText: 'peut-être déjà été publié' }).waitFor();
  assert.ok(await pending.getByRole('button', { name: 'Abandonner la reprise' }).isVisible());
  await page.screenshot({ path: join(ARTIFACTS, 'r3-5-reprise-visible-apres-get-echoue.png') });
  ctx.setFaults(null);
  await thread.getByRole('alert').getByRole('button', { name: 'Réessayer' }).click();
  await p.getByRole('status').filter({ hasText: 'Réponse publiée.' }).waitFor();
  const replies = serviceOnly(ctx, isReplyPost);
  assert.equal(replies.length, 2);
  assert.equal(new Set(keysOf(replies)).size, 1);
  assert.equal(await messagesNamed(`${marker} A`), 1, 'une seule écriture');
  await ctx.context.close();
});

test('R3-5 : passage effectif à l’invité sans thread.participate dans un autre onglet ; l’intention de réponse incertaine, son avis et son abandon restent visibles, aucune émission sous l’invité', async () => {
  const ctx = await editorial(browser.newContext(origins()));
  const a = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openPanel(a);
  const pa = panel(a);
  const marker = `R3-5 invité ${crypto.randomUUID().slice(0, 8)}`;
  await pa.getByRole('textbox', { name: 'Votre commentaire global' }).fill(`${marker} support`);
  await pa.getByRole('button', { name: 'Publier' }).click();
  await pa.getByRole('status').filter({ hasText: 'Commentaire publié.' }).waitFor();
  const thread = pa.getByTestId('socrate-thread').filter({ hasText: `${marker} support` });
  const box = thread.getByRole('textbox', { name: /Répondre/ });
  loseOnce(ctx, isReplyPost);
  await box.fill(`${marker} A`);
  await thread.getByRole('button', { name: 'Répondre' }).click();
  await pa.getByRole('alert').filter({ hasText: 'Votre brouillon est conservé' }).waitFor();
  assert.equal(await messagesNamed(`${marker} A`), 1);
  const claireToken = serviceOnly(ctx, isReplyPost)[0]!.headers['authorization'];
  await expireSessions('demo-host:claire');
  await switchPersona(ctx, /Se connecter comme Invité sans capacité/);
  await bringBack(a);
  await pa.getByTestId('socrate-identity').filter({ hasText: 'Invité Sans Droit' }).waitFor();
  await pa.getByText('Votre accès ne permet pas de publier.').waitFor();
  const pending = pa.getByTestId('socrate-pending-reply');
  await pending.filter({ hasText: `${marker} A` }).waitFor();
  await pending.filter({ hasText: 'peut-être déjà été publié' }).waitFor();
  assert.ok(await pending.getByRole('button', { name: 'Abandonner la reprise' }).isVisible(), 'abandon disponible sans capacité');
  assert.ok(await thread.getByRole('button', { name: 'Répondre' }).isDisabled(), 'aucune nouvelle publication sous l’invité');
  await a.screenshot({ path: join(ARTIFACTS, 'r3-5-reprise-visible-sans-capacite.png') });
  await thread.getByRole('alert').getByRole('button', { name: 'Réessayer' }).click();
  await pa.getByRole('alert').filter({ hasText: 'L’identité de l’hôte a changé (Invité Sans Droit)' }).waitFor();
  const replies = serviceOnly(ctx, isReplyPost);
  assert.equal(replies.length, 1, 'aucune réémission sous l’invité');
  assert.equal(replies[0]!.headers['authorization'], claireToken);
  await pending.getByRole('button', { name: 'Abandonner la reprise' }).click();
  await pa.getByRole('status').filter({ hasText: 'Reprise abandonnée. L’envoi précédent a peut-être déjà été publié' }).waitFor();
  assert.equal(await pending.count(), 0);
  assert.equal(await box.inputValue(), `${marker} A`, 'le brouillon vide reçoit l’ancien texte');
  assert.equal(serviceOnly(ctx, isReplyPost).length, 1, 'l’abandon n’émet rien');
  assert.deepEqual(await authorsOf(`${marker} A`), [{ author_key: 'demo-host:claire', exploring: null }]);
  await ctx.context.close();
});

test('session encore valide : changement d’hôte dans un autre onglet sans expiration ; la reprise part sous l’acteur figé et affiché avec la même clé ; au renouvellement sous Karim, émission bloquée et incertitude conservée', async () => {
  const ctx = await editorial(browser.newContext(origins()));
  const a = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openPanel(a);
  const pa = panel(a);
  const marker = `Session valide ${crypto.randomUUID().slice(0, 8)}`;
  const box = pa.getByRole('textbox', { name: 'Votre commentaire global' });
  loseOnce(ctx, isThreadsPost);
  await box.fill(`${marker} première`);
  await pa.getByRole('button', { name: 'Publier' }).click();
  await pa.getByRole('alert').filter({ hasText: 'Votre brouillon est conservé' }).waitFor();
  assert.equal(await messagesNamed(`${marker} première`), 1);
  await switchPersona(ctx, /Se connecter comme Karim Benali/);
  await bringBack(a);
  await pa.getByTestId('socrate-thread').filter({ hasText: `${marker} première` }).waitFor();
  await pa.getByTestId('socrate-identity').filter({ hasText: 'Claire Morel' }).waitFor();
  assert.equal(await pa.getByRole('alert').filter({ hasText: 'identité de l’hôte a changé' }).count(), 0, 'aucun blocage instantané annoncé pendant la validité de la session');
  const sessions = serviceOnly(ctx, (r) => r.url.endsWith('/v1/auth/session')).length;
  await pa.getByRole('button', { name: 'Réessayer' }).click();
  await pa.getByRole('status').filter({ hasText: 'Commentaire publié.' }).waitFor();
  const posts = serviceOnly(ctx, isThreadsPost);
  assert.equal(posts.length, 2);
  assert.equal(keysOf(posts)[0], keysOf(posts)[1], 'même clé');
  assert.equal(posts[0]!.headers['authorization'], posts[1]!.headers['authorization'], 'même bearer encore valide');
  assert.equal(serviceOnly(ctx, (r) => r.url.endsWith('/v1/auth/session')).length, sessions, 'aucune nouvelle session');
  assert.deepEqual(await authorsOf(`${marker} première`), [{ author_key: 'demo-host:claire', exploring: null }], 'auteur inchangé');
  assert.equal(await messagesNamed(`${marker} première`), 1);
  await a.screenshot({ path: join(ARTIFACTS, 'session-valide-reprise-acteur-fige.png') });

  loseOnce(ctx, isThreadsPost);
  await box.fill(`${marker} seconde`);
  await pa.getByRole('button', { name: 'Publier' }).click();
  await pa.getByRole('alert').filter({ hasText: 'Votre brouillon est conservé' }).waitFor();
  assert.equal(await messagesNamed(`${marker} seconde`), 1);
  await expireSessions('demo-host:claire');
  await bringBack(a);
  await pa.getByTestId('socrate-identity').filter({ hasText: 'Karim Benali' }).waitFor();
  await pa.getByRole('button', { name: 'Réessayer' }).click();
  await pa.getByRole('alert').filter({ hasText: 'L’identité de l’hôte a changé (Karim Benali)' }).waitFor();
  await pa.getByTestId('socrate-pending').filter({ hasText: `${marker} seconde` }).waitFor();
  await pa.getByTestId('socrate-pending').filter({ hasText: 'peut-être déjà été publié' }).waitFor();
  assert.equal(serviceOnly(ctx, isThreadsPost).length, 3, 'aucune émission sous Karim');
  assert.deepEqual(await authorsOf(`${marker} seconde`), [{ author_key: 'demo-host:claire', exploring: null }]);
  await a.screenshot({ path: join(ARTIFACTS, 'session-renouvelee-emission-bloquee.png') });
  await ctx.context.close();
});

test('garde navigateur : destinations hors loopback refusées avant transport, Service Workers bloqués, vraie redirection 302 vers un second témoin loopback non autorisé refusée sans requête, cookies et WebSocket conservés', async () => {
  const requests: string[] = [];
  const forbidden = createServer((req, res) => { requests.push(`${req.method} ${req.url}`); res.writeHead(200).end('cible interdite atteinte'); });
  await new Promise<void>((r) => forbidden.listen(0, '127.0.0.1', () => r()));
  const forbiddenOrigin = `http://127.0.0.1:${(forbidden.address() as { port: number }).port}`;
  const witnessHits: string[] = [];
  const witness = createServer((req, res) => {
    witnessHits.push(`${req.method} ${req.url}`);
    if (req.url === '/vers-interdit') res.writeHead(302, { Location: `${forbiddenOrigin}/cible` }).end();
    else if (req.url === '/vers-soi') res.writeHead(302, { Location: '/ok' }).end();
    else if (req.url === '/retenu') res.writeHead(302, { Location: `${forbiddenOrigin}/retenu` }).end();
    else res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
  });
  await new Promise<void>((r) => witness.listen(0, '127.0.0.1', () => r()));
  const witnessOrigin = `http://127.0.0.1:${(witness.address() as { port: number }).port}`;
  try {
    const ctx = await editorial(browser.newContext([...origins(), witnessOrigin]));
    const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
    const outcome = await page.evaluate(async () => {
      const tryFetch = async (url: string) => { try { const r = await fetch(url); return `ok ${r.status}`; } catch (e) { return `refus ${(e as Error).name}`; } };
      const sw = 'serviceWorker' in navigator
        ? await navigator.serviceWorker.register('/sw.js').then(async (reg) => (reg === undefined && (await navigator.serviceWorker.getRegistrations()).length === 0 ? 'bloqué' : 'enregistré'), (e: Error) => `refus ${e.name}`)
        : 'absent';
      return { external: await tryFetch('http://192.0.2.1/externe'), invalid: await tryFetch('http://example.invalid/'), sw };
    });
    assert.match(outcome.external, /^refus/);
    assert.match(outcome.invalid, /^refus/);
    assert.match(outcome.sw, /^bloqué|^refus|absent/, outcome.sw);
    assert.ok(ctx.blocked.some((b) => b.includes('http://192.0.2.1/externe')), `bloquées : ${ctx.blocked.join(' | ')}`);
    assert.ok(ctx.blocked.some((b) => b.includes('http://example.invalid/')));
    const redirects = await page.evaluate(async (origin) => {
      const tryFetch = async (url: string) => { try { const r = await fetch(url, { mode: 'cors' }); return `ok ${r.status}`; } catch (e) { return `refus ${(e as Error).name}`; } };
      return { plain: await tryFetch(`${origin}/ok`), toForbidden: await tryFetch(`${origin}/vers-interdit`), toSelf: await tryFetch(`${origin}/vers-soi`) };
    }, witnessOrigin);
    assert.equal(redirects.plain, 'ok 200', 'le témoin autorisé répond par la voie nominale route.fetch');
    assert.match(redirects.toForbidden, /^refus/, 'la redirection vers le port non autorisé est refusée');
    assert.match(redirects.toSelf, /^refus/, 'toute redirection est refusée avant suivi, même vers l’origine autorisée');
    let held!: () => void;
    const gate = new Promise<void>((r) => { held = r; });
    ctx.setFaults((r) => (r.url.endsWith('/retenu') ? { kind: 'hold', until: gate } : { kind: 'pass' }));
    const heldFetch = page.evaluate(async (origin) => { try { const r = await fetch(`${origin}/retenu`); return `ok ${r.status}`; } catch (e) { return `refus ${(e as Error).name}`; } }, witnessOrigin);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!witnessHits.includes('GET /retenu'), 'la voie hold retient la requête avant toute émission');
    held();
    assert.match(await heldFetch, /^refus/, 'la voie hold refuse aussi la redirection');
    ctx.setFaults(null);
    assert.deepEqual(requests, [], 'le second témoin loopback non autorisé ne reçoit aucune requête');
    assert.deepEqual(witnessHits.filter((h) => h === 'GET /ok').length, 1, 'la cible /ok de la redirection vers soi n’est pas visitée');
    assert.ok(ctx.blocked.some((b) => b === `redirection refusée 302 depuis ${witnessOrigin}/vers-interdit vers ${forbiddenOrigin}/cible`), ctx.blocked.join(' | '));
    assert.ok(ctx.blocked.some((b) => b.startsWith(`redirection refusée 302 depuis ${witnessOrigin}/retenu`)));
    assert.ok(!browser.sinkAttempts.some((a) => a.includes('192.0.2.1') || a.includes('example.invalid') || a.includes(forbiddenOrigin.slice(7))), 'rien n’a atteint le puits pour ces destinations');
    const p = panel(page);
    await openPanel(page);
    await p.getByTestId('socrate-identity').filter({ hasText: 'Claire Morel' }).waitFor();
    assert.ok(ctx.seen.some((r) => r.url.startsWith(stack.view.demoOrigin) && r.url.includes('/api/') && (r.headers['cookie'] ?? '').includes('demo_session=claire')), 'le cookie hôte traverse la voie route.fetch vers l’hôte');
    const ws = await page.evaluate(async ({ demo, other }) => {
      const client = await (await fetch('/@vite/client')).text();
      const token = /wsToken = "([^"]+)"/.exec(client)?.[1] ?? '';
      const open = (origin: string) => new Promise<string>((r) => { const w = new WebSocket(`${origin.replace('http', 'ws')}/?token=${token}`, 'vite-hmr'); let opened = false; w.onopen = () => { opened = true; w.close(); r('ouvert'); }; w.onerror = () => r('erreur'); w.onclose = () => r(opened ? 'ouvert' : 'fermé sans ouverture'); setTimeout(() => r('délai'), 3000); });
      return { token: token.length > 0, allowed: await open(demo), forbidden: await open(other) };
    }, { demo: stack.view.demoOrigin, other: forbiddenOrigin });
    assert.ok(ws.token, 'jeton HMR lu dans le client Vite');
    assert.equal(ws.allowed, 'ouvert', 'le WebSocket Vite vers l’origine de l’instance reste autorisé');
    assert.match(ws.forbidden, /^erreur|^fermé sans ouverture/, 'un WebSocket vers le témoin non autorisé est fermé par la fabrique');
    assert.ok(ctx.blocked.some((b) => b.startsWith(`websocket ${forbiddenOrigin.replace('http', 'ws')}/`)), ctx.blocked.filter((b) => b.startsWith('websocket')).join(' | '));
    await ctx.context.close();
  } finally {
    forbidden.closeAllConnections();
    witness.closeAllConnections();
    await Promise.all([new Promise<void>((r) => forbidden.close(() => r())), new Promise<void>((r) => witness.close(() => r()))]);
  }
});

const frameDoc = (page: Page) => page.evaluate(() => (document.getElementById('socrate-frame') as HTMLIFrameElement | null)?.contentDocument?.body.innerText ?? '');
const captureState = (page: Page) => panel(page).getByTestId('socrate-capture-status').getAttribute('data-capture');
const HIDE_SOCRATE = '[data-socrate]{visibility:hidden!important}';
const shotDataOf = async (page: Page) => {
  const src = (await panel(page).getByTestId('socrate-shot').locator('img').getAttribute('src'))!;
  return page.evaluate(async (u) => { const b = await (await fetch(u)).blob(); return await new Promise<string>((ok) => { const r = new FileReader(); r.onload = () => ok(String(r.result)); r.readAsDataURL(b); }); }, src);
};
const dataUrl = (png: Buffer) => `data:image/png;base64,${png.toString('base64')}`;
const boxOf = async (page: Page, selector: string) => (await page.locator(selector).boundingBox())!;
/** Chaque contrôle Socrate doit être absent de l'image : sa région égale la page photographiée sans contrôles, pas la page qui les montre. */
/** Les rectangles sont relevés avec la référence : la toolbar se décale quand le panneau s'ouvre après l'image. */
async function assertControlsAbsent(page: Page, shot: string, withControls: string, without: string, boxes: Array<[string, Awaited<ReturnType<typeof boxOf>>]>) {
  for (const [sel, box] of boxes) {
    const absent = await regionDiff(page, shot, without, box);
    const shown = await regionDiff(page, without, withControls, box);
    assert.ok(absent.mean < 6, `${sel} absent de l’image (écart ${absent.mean.toFixed(2)} avec la page sans contrôles)`);
    assert.ok(shown.mean > 4, `${sel} visible sur la référence, la comparaison est donc discriminante (écart ${shown.mean.toFixed(2)})`);
  }
}
async function sceneFacts(page: Page) {
  return page.evaluate(() => {
    const a = document.activeElement;
    const dialog = document.querySelector('[data-testid="scene-dialog"]');
    return {
      dialog: dialog?.getAttribute('data-variant') ?? null,
      menuOpen: document.querySelector('[data-testid="scene-menu"]') !== null,
      active: a ? `${a.tagName}:${a.textContent?.trim().slice(0, 30)}` : null,
      libelle: (document.querySelector('[data-testid="scene-libelle"]') as HTMLInputElement | null)?.value ?? null,
      scrollTop: document.querySelector('[data-testid="scene-scroll"]')?.scrollTop ?? null,
      selection: String(window.getSelection() ?? ''),
      saved: document.querySelector('[data-testid="scene-saved"]')?.textContent ?? null,
      width: document.documentElement.clientWidth,
    };
  });
}
/**
 * Différence moyenne par canal dans une région en pixels CSS. Chaque image doit avoir la même échelle en largeur et en hauteur
 * par rapport au viewport, sinon elle est refusée. Si les deux échelles diffèrent, la région de l'image la plus fine est
 * ramenée une seule fois sur la grille de l'autre ; les deux échelles sont rendues pour être consignées.
 */
async function regionDiff(page: Page, a: string, b: string, r: { x: number; y: number; width: number; height: number }) {
  return page.evaluate(async ({ a, b, r }) => {
    const load = async (src: string) => { const i = new Image(); i.src = src; await i.decode(); return i; };
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const scaleOf = (img: HTMLImageElement, what: string) => {
      const sx = img.naturalWidth / window.innerWidth;
      const sy = img.naturalHeight / window.innerHeight;
      if (Math.abs(sx - sy) > 0.01) throw new Error(`image ${what} incompatible avec le viewport ${window.innerWidth} × ${window.innerHeight} : ${img.naturalWidth} × ${img.naturalHeight}`);
      return sx;
    };
    const sa = scaleOf(ia, 'a');
    const sb = scaleOf(ib, 'b');
    const grid = Math.min(sa, sb);
    const read = (img: HTMLImageElement, s: number) => {
      const c = document.createElement('canvas');
      c.width = Math.round(r.width * grid); c.height = Math.round(r.height * grid);
      const ctx = c.getContext('2d')!;
      ctx.drawImage(img, r.x * s, r.y * s, r.width * s, r.height * s, 0, 0, c.width, c.height);
      return ctx.getImageData(0, 0, c.width, c.height).data;
    };
    const pa = read(ia, sa);
    const pb = read(ib, sb);
    let sum = 0;
    for (let i = 0; i < pa.length; i += 4) for (let k = 0; k < 3; k++) sum += Math.abs(pa[i + k]! - pb[i + k]!);
    return { mean: sum / (pa.length / 4 * 3), width: ia.naturalWidth, height: ia.naturalHeight, scale: sa, other: { width: ib.naturalWidth, height: ib.naturalHeight, scale: sb }, grid, normalized: sa !== sb };
  }, { a, b, r });
}

test('capture ciblée (permission automatique Chromium, pas la preuve native) : modal détaillée, champ, défilement, menu ouvert, sélection de texte ; image fidèle sans contrôles Socrate ; publication durable', async () => {
  const auto = await openBrowser({ autoAcceptTabCapture: true });
  try {
    const ctx = await editorial(auto.newContext(origins()));
    const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
    await page.getByRole('link', { name: 'Réglages' }).click();
    await page.getByTestId('open-detaillee').click();
    await page.getByTestId('scene-libelle').fill('Rappel J-1 fictif');
    await page.getByTestId('scene-scroll').evaluate((el) => { el.scrollTop = 60; });
    await page.getByTestId('scene-intro').evaluate((el) => { const r = document.createRange(); r.selectNodeContents(el); const s = window.getSelection()!; s.removeAllRanges(); s.addRange(r); });
    await page.getByTestId('scene-menu-trigger').click();
    await page.getByTestId('scene-menu').waitFor();
    await page.waitForFunction(() => document.activeElement?.closest('[data-testid="scene-menu"]') !== null, undefined, { timeout: 5_000 });
    const initial = await sceneFacts(page);
    assert.equal(initial.dialog, 'detaillee');
    assert.ok(initial.menuOpen && initial.selection.includes('e-mail'), JSON.stringify(initial));

    await activateCapture(page);
    assert.deepEqual(await sceneFacts(page), initial, 'activer la capture ne ferme ni la modal ni le menu et ne déplace pas le focus');

    await clickTarget(page);
    await captureIs(page, 'selecting');
    await page.keyboard.press('Escape');
    await captureIs(page, 'active');
    assert.deepEqual(await sceneFacts(page), initial, 'Escape annule la sélection sans fermer le menu ni la modal');
    const reference = dataUrl(await page.screenshot());
    const withoutControls = dataUrl(await page.screenshot({ style: HIDE_SOCRATE }));
    const targetBox = await boxOf(page, TARGET);
    const launcherBox = await boxOf(page, '[data-socrate="launcher"]');

    await clickTarget(page);
    const save = await page.getByTestId('scene-save').boundingBox();
    const dialogBox = (await page.getByTestId('scene-dialog').boundingBox())!;
    await page.mouse.click(save!.x + save!.width / 2, save!.y + save!.height / 2);
    await panel(page).getByTestId('socrate-shot').waitFor({ timeout: 10_000 });
    const after = await sceneFacts(page);
    assert.equal(after.saved, '0', 'le geste de sélection n’active pas le bouton métier');
    assert.equal(after.dialog, 'detaillee', 'la modal reste ouverte après la capture et pendant la saisie');
    assert.equal(after.libelle, initial.libelle);
    assert.equal(after.scrollTop, initial.scrollTop);
    assert.equal(after.width, 1280, 'le viewport garde sa largeur');
    const editorFocused = await page.evaluate(() => { const f = document.getElementById('socrate-frame') as HTMLIFrameElement; return document.activeElement === f && f.contentDocument!.activeElement?.id === 'socrate-targeted-draft'; });
    assert.ok(editorFocused, 'l’éditeur reçoit intentionnellement le focus après l’image');

    const shot = panel(page).getByTestId('socrate-shot').locator('img');
    const shotData = await shotDataOf(page);
    await assertControlsAbsent(page, shotData, reference, withoutControls, [['[data-socrate="launcher"]', launcherBox]]);
    const targetAbsent = await regionDiff(page, shotData, withoutControls, targetBox);
    assert.ok(targetAbsent.mean < 6, `bouton Cibler absent de l’image, panneau fermé (écart ${targetAbsent.mean.toFixed(2)})`);
    const dialogDiff = await regionDiff(page, shotData, reference, dialogBox);
    assert.ok(dialogDiff.mean < 6, `la modal, sa variante, la valeur saisie, le défilement et le menu correspondent (écart moyen ${dialogDiff.mean.toFixed(2)})`);
    const launcherDiff = await regionDiff(page, shotData, reference, launcherBox);
    assert.ok(launcherDiff.mean > 30, `le lanceur Socrate est absent de l’image (écart ${launcherDiff.mean.toFixed(2)} avec la page qui l’affiche)`);
    assert.equal(dialogDiff.width, 1280, 'échelle : une image à la largeur du viewport (dpr 1)');
    await writeFile(join(ARTIFACTS, 'capture-modal-detaillee.png'), Buffer.from(shotData.split(',')[1]!, 'base64'));
    await writeFile(join(ARTIFACTS, 'reference-avant-ciblage.png'), Buffer.from(reference.split(',')[1]!, 'base64'));
    assert.ok(save, 'bouton ciblé visible');

    const shotSha = await shot.getAttribute('data-sha256');
    const body = 'Le bouton Enregistrer de la variante détaillée prête à confusion.';
    await panel(page).locator('#socrate-targeted-draft').fill(body);
    await panel(page).getByRole('button', { name: 'Publier le retour ciblé' }).click();
    await panel(page).getByText('Retour ciblé publié avec son image.').waitFor();
    const row = await stack.service.db.prepare("SELECT t.kind, c.state, c.sha256, c.object_key, g.context FROM threads t JOIN captures c ON c.thread_id = t.thread_id JOIN targets g ON g.thread_id = t.thread_id JOIN messages m ON m.thread_id = t.thread_id WHERE m.body = ?").bind(body).first<{ kind: string; state: string; sha256: string; object_key: string; context: string }>();
    assert.equal(row?.kind, 'targeted');
    assert.equal(row?.state, 'committed');
    assert.equal(row?.sha256, shotSha, 'l’image durable est celle prise au ciblage');
    const context = JSON.parse(row!.context);
    assert.equal(context.route, '/reglages/rappels');
    assert.equal(context.role, 'button');
    assert.match(context.html, /data-socrate-id="modal-enregistrer"/);
    assert.doesNotMatch(context.html, /onclick|value=|data-testid|style=/i, 'extrait nettoyé');
    const uploads = serviceOnly(ctx, (r) => r.method === 'PUT' && /\/captures\//.test(path(r)));
    assert.equal(uploads.length, 1, 'une seule image envoyée, aucun flux ni historique');
    assert.equal(serviceOnly(ctx, (r) => /video|stream|frames/i.test(path(r))).length, 0);
    const back = await sceneFacts(page);
    assert.notEqual(back.active?.startsWith('IFRAME'), true, `le contrôle revient à l’application après la publication (${back.active})`);
    assert.equal(back.dialog, 'detaillee');

    await expireSessions();
    const imageReads = () => serviceOnly(ctx, (r) => r.method === 'GET' && /\/captures\/[^/]+$/.test(path(r))).length;
    const before = imageReads();
    await panel(page).getByRole('button', { name: 'Afficher l’image' }).click();
    await panel(page).getByTestId('socrate-target-image').waitFor();
    assert.equal(imageReads() - before, 2, 'session expirée : une lecture refusée, une seule reprise après renouvellement, pas de boucle 401');
    assert.match(await panel(page).getByTestId('socrate-target-html').innerText(), /&lt;|<button/, 'contexte affiché comme texte');
    await page.screenshot({ path: join(ARTIFACTS, 'capture-publiee-panneau.png') });
    await ctx.context.close();
  } finally {
    await auto.close();
  }
});

test('capture interrompue, refusée, mauvais onglet, navigation SPA, rechargement et annulation (permission automatique Chromium, refus et mauvais onglet synthétiques)', async () => {
  const auto = await openBrowser({ autoAcceptTabCapture: true });
  try {
    const ctx = await editorial(auto.newContext(origins()));
    const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
    await activateCapture(page);
    await page.getByRole('link', { name: 'Réglages' }).click();
    await page.getByRole('link', { name: 'Agenda' }).click();
    await page.getByRole('link', { name: 'Réglages' }).click();
    await captureIs(page, 'active');
    await page.getByTestId('open-courte').click();
    await clickTarget(page);
    await page.getByTestId('scene-save').click();
    await panel(page).getByTestId('socrate-shot').waitFor();
    assert.equal(await captureState(page), 'active', 'le partage survit à la navigation SPA');
    const text = 'Texte à conserver après interruption.';
    await panel(page).locator('#socrate-targeted-draft').fill(text);
    await panel(page).getByRole('button', { name: 'Arrêter le partage' }).click();
    await panel(page).getByTestId('socrate-capture-invalidated').waitFor();
    assert.equal(await panel(page).getByTestId('socrate-shot').count(), 0, 'l’image du brouillon est invalidée');
    assert.equal(await panel(page).locator('#socrate-targeted-draft').inputValue(), text, 'le texte survit tant que la page vit');
    assert.ok(await panel(page).getByRole('button', { name: 'Publier le retour ciblé' }).isDisabled(), 'publication ciblée bloquée');
    await activateCapture(page);
    assert.ok(await panel(page).getByRole('button', { name: 'Publier le retour ciblé' }).isDisabled(), 'réactiver ne restaure aucune image : nouveau ciblage explicite requis');
    await clickTarget(page);
    await page.getByTestId('scene-intro').click();
    await panel(page).getByTestId('socrate-shot').waitFor();
    await panel(page).getByRole('button', { name: 'Annuler le brouillon' }).click();
    assert.equal(await panel(page).getByTestId('socrate-shot').count(), 0);
    assert.equal(serviceOnly(ctx, (r) => /\/targeted$|\/captures\//.test(path(r))).length, 0, 'annuler ne stocke rien');
    await page.reload();
    await activateToolbar(page);
    assert.equal(await page.locator(TARGET).getAttribute('data-capture'), 'inactive:', 'un rechargement perd le partage et le brouillon en mémoire');
    await ctx.context.close();

    const plain = await editorial(auto.newContext(origins()));
    await plain.context.addInitScript(() => { navigator.mediaDevices.getDisplayMedia = () => Promise.reject(new DOMException('refus fictif du banc', 'NotAllowedError')); });
    const refused = await loginAs(plain, 'Claire Morel, relectrice produit');
    await clickTarget(refused);
    await captureIs(refused, 'inactive:refused');
    await showList(refused);
    assert.equal(await captureState(refused), 'inactive:refused', 'refus synthétique (getDisplayMedia rejeté par le banc) : partage refusé signalé');
    await plain.context.close();

    const wctx = await editorial(auto.newContext(origins()));
    await wctx.context.addInitScript(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const c = document.createElement('canvas');
        c.width = 1280; c.height = 800;
        c.getContext('2d')!.fillRect(0, 0, 1280, 800);
        return c.captureStream(5);
      };
    });
    const victim = await loginAs(wctx, 'Claire Morel, relectrice produit');
    await clickTarget(victim);
    await captureIs(victim, 'inactive:wrong-tab');
    await showList(victim);
    const state = await captureState(victim);
    assert.equal(state, 'inactive:wrong-tab', `flux synthétique sans Capture Handle de cet onglet : mauvais onglet détecté avant toute publication (${state} ; ${(await frameDoc(victim)).slice(0, 200)})`);
    assert.equal(serviceOnly(wctx, (r) => /\/targeted$|\/captures\//.test(path(r))).length, 0);
    await wctx.context.close();
  } finally {
    await auto.close();
  }
});

test('capture ciblée à l’échelle 2, variante courte, panneau ouvert (permission automatique Chromium, pas la preuve native) : contrôles absents, image et coordonnées fidèles', async () => {
  const auto = await openBrowser({ autoAcceptTabCapture: true });
  try {
    const ctx = await editorial(auto.newContext(origins(), { deviceScaleFactor: 2 }));
    const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
    await page.getByRole('link', { name: 'Réglages' }).click();
    await openPanel(page);
    await page.getByTestId('open-courte').click();
    await page.getByTestId('scene-dialog').waitFor();
    await activateCapture(page);
    const reference = dataUrl(await page.screenshot());
    const withoutControls = dataUrl(await page.screenshot({ style: HIDE_SOCRATE }));
    const boxes = { launcher: await boxOf(page, '[data-socrate="launcher"]'), target: await boxOf(page, TARGET), panel: await boxOf(page, '#socrate-frame') };
    const dialogBox = await boxOf(page, '[data-testid="scene-dialog"]');
    await clickTarget(page);
    const save = await boxOf(page, '[data-testid="scene-save"]');
    await page.mouse.click(save.x + save.width / 2, save.y + save.height / 2);
    await panel(page).getByTestId('socrate-shot').waitFor({ timeout: 10_000 });
    assert.equal((await sceneFacts(page)).dialog, 'courte');
    const shot = await shotDataOf(page);
    for (const [name, box] of Object.entries(boxes)) {
      const absent = await regionDiff(page, shot, withoutControls, box);
      const shown = await regionDiff(page, withoutControls, reference, box);
      assert.ok(absent.mean < 6 && shown.mean > 4, `${name} absent de l’image panneau ouvert (écart ${absent.mean.toFixed(2)} sans contrôles, ${shown.mean.toFixed(2)} entre références)`);
    }
    const dialog = await regionDiff(page, shot, withoutControls, dialogBox);
    assert.ok(dialog.mean < 6, `variante courte fidèle (écart ${dialog.mean.toFixed(2)})`);
    assert.equal(dialog.scale, 2, `image à l’échelle du viewport ×2 (${dialog.width} × ${dialog.height})`);
    await writeFile(join(ARTIFACTS, 'capture-modal-courte-echelle-2.png'), Buffer.from(shot.split(',')[1]!, 'base64'));
    const body = 'Variante courte à l’échelle 2, panneau ouvert.';
    await panel(page).locator('#socrate-targeted-draft').fill(body);
    await panel(page).getByRole('button', { name: 'Publier le retour ciblé' }).click();
    await panel(page).getByText('Retour ciblé publié avec son image.').waitFor();
    const row = await stack.service.db.prepare('SELECT g.context, c.width FROM targets g JOIN captures c ON c.thread_id = g.thread_id JOIN messages m ON m.thread_id = g.thread_id WHERE m.body = ?').bind(body).first<{ context: string; width: number }>();
    const context = JSON.parse(row!.context) as { rect: { x: number; y: number; width: number; height: number }; viewport: { width: number; devicePixelRatio: number } };
    assert.equal(context.viewport.devicePixelRatio, 2);
    assert.equal(row!.width, context.viewport.width * 2, 'largeur stockée à l’échelle 2');
    for (const k of ['x', 'y', 'width', 'height'] as const) assert.ok(Math.abs(context.rect[k] - save[k]) < 1, `rectangle en pixels CSS (${k} ${context.rect[k]} contre ${save[k]})`);
    const atRect = await regionDiff(page, shot, withoutControls, context.rect);
    assert.ok(atRect.mean < 6, `la région du rectangle stocké montre la cible à l’échelle 2 (écart ${atRect.mean.toFixed(2)})`);
    await ctx.context.close();
  } finally {
    await auto.close();
  }
});

test('publication ciblée coupée depuis l’interface (PUT coupé par le banc, permission automatique Chromium) : reprise permise tant que le partage vit, aucun ancien envoi après arrêt, confirmation tardive sans effet sur le nouveau brouillon', async () => {
  const auto = await openBrowser({ autoAcceptTabCapture: true });
  try {
    const ctx = await editorial(auto.newContext(origins()));
    const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
    const section = panel(page).locator('section[aria-labelledby="socrate-cible"]');
    const isPut = (r: SeenRequest) => r.method === 'PUT' && /\/captures\/[^/]+$/.test(path(r));
    const isCommit = (r: SeenRequest) => r.method === 'POST' && /\/captures\/[^/]+\/commit$/.test(path(r));
    const isReserve = (r: SeenRequest) => r.method === 'POST' && path(r).endsWith('/targeted');
    const isRecognize = (r: SeenRequest) => r.method === 'GET' && path(r).endsWith('/targeted');
    const until = async (cond: () => boolean, what: string) => {
      for (let i = 0; i < 100 && !cond(); i++) await page.waitForTimeout(100);
      assert.ok(cond(), what);
    };
    const cutPutOnce = () => {
      let cut = false;
      ctx.setFaults((r) => {
        if (!isPut(r) || cut) return { kind: 'pass' };
        cut = true;
        return { kind: 'abort' };
      });
    };
    const shotSha = () => panel(page).getByTestId('socrate-shot').locator('img').getAttribute('data-sha256');
    const target = async () => {
      await captureIs(page, 'active');
    await clickTarget(page);
      await captureIs(page, 'selecting');
      await page.getByTestId('scene-save').click();
      await panel(page).getByTestId('socrate-shot').waitFor();
    };
    await page.getByRole('link', { name: 'Réglages' }).click();
    await page.getByTestId('open-courte').click();
    await activateCapture(page);

    await target();
    const first = 'Reprise permise après un téléversement coupé.';
    await panel(page).locator('#socrate-targeted-draft').fill(first);
    cutPutOnce();
    await section.getByRole('button', { name: 'Publier le retour ciblé' }).click();
    await section.getByRole('button', { name: 'Réessayer' }).waitFor();
    ctx.setFaults(null);
    await section.getByRole('button', { name: 'Réessayer' }).click();
    await section.getByText('Retour ciblé publié avec son image.').waitFor();
    assert.equal(await messagesNamed(first), 1, 'une seule publication après la reprise');
    assert.equal(new Set(keysOf(serviceOnly(ctx, isReserve))).size, 1, 'la reprise réutilise la clé de l’intention');

    await target();
    const second = 'Ancien envoi à ne pas réémettre après arrêt.';
    await panel(page).locator('#socrate-targeted-draft').fill(second);
    cutPutOnce();
    await section.getByRole('button', { name: 'Publier le retour ciblé' }).click();
    await section.getByRole('button', { name: 'Réessayer' }).waitFor();
    ctx.setFaults(null);
    await section.getByRole('button', { name: 'Arrêter le partage' }).click();
    await section.getByRole('button', { name: 'Vérifier la publication' }).waitFor();
    assert.ok(await section.getByRole('button', { name: 'Publier le retour ciblé' }).isDisabled(), 'aucune nouvelle émission possible sans nouveau ciblage');
    const emitted = () => serviceOnly(ctx, (r) => isPut(r) || isCommit(r) || isReserve(r)).length;
    const before = emitted();
    const reads = serviceOnly(ctx, isRecognize).length;
    await section.getByRole('button', { name: 'Vérifier la publication' }).click();
    await until(() => serviceOnly(ctx, isRecognize).length > reads, 'une lecture sans mutation a été faite');
    await section.getByText(/Aucune publication validée n’est constatée/).waitFor();
    assert.equal(emitted(), before, 'aucune réservation, aucun PUT ni commit de l’ancienne image après l’arrêt');
    assert.equal(await messagesNamed(second), 0);
    assert.match(await section.getByTestId('socrate-pending-targeted').innerText(), /Ancien envoi à ne pas réémettre/, 'l’intention garde sa charge et son auteur');
    await section.getByRole('button', { name: 'Abandonner la reprise' }).click();
    assert.equal(await panel(page).locator('#socrate-targeted-draft').inputValue(), second, 'le texte reste en brouillon');

    await activateCapture(page);
    await target();
    const third = 'Confirmation tardive sans effet sur le nouveau brouillon.';
    await panel(page).locator('#socrate-targeted-draft').fill(third);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    ctx.setFaults((r) => (isCommit(r) ? { kind: 'hold-response', until: held } : { kind: 'pass' }));
    const commits = serviceOnly(ctx, isCommit).length;
    await section.getByRole('button', { name: 'Publier le retour ciblé' }).click();
    await until(() => serviceOnly(ctx, isCommit).length > commits, 'validation envoyée, réponse retenue par le banc');
    const oldSha = await shotSha();
    await page.getByTestId('scene-libelle').fill('Rappel modifié pendant l’envoi');
    await captureIs(page, 'active');
    await clickTarget(page);
    await page.getByTestId('scene-save').click();
    for (let i = 0; i < 50 && (await shotSha()) === oldSha; i++) await page.waitForTimeout(100);
    const newSha = await shotSha();
    assert.notEqual(newSha, oldSha, 'nouvelle image prise pendant l’envoi');
    release();
    ctx.setFaults(null);
    await section.getByText('Votre retour ciblé précédent est publié. Le brouillon en cours est conservé.').waitFor();
    assert.equal(await shotSha(), newSha, 'l’ancienne confirmation n’efface pas la nouvelle image');
    assert.equal(await panel(page).locator('#socrate-targeted-draft').inputValue(), third, 'ni le texte du brouillon en cours');
    assert.equal(await messagesNamed(third), 1);
    await ctx.context.close();
  } finally {
    await auto.close();
  }
});

test('continuations tardives (flux synthétique avec Capture Handle simulé, sélecteur et encodage retenus par le banc) : aucun brouillon après interruption, piste accordée après démontage fermée', async () => {
  const ctx = await editorial(browser.newContext(origins()));
  await ctx.context.addInitScript(() => {
    const w = window as unknown as { __grants: (() => void)[]; __encodes: (() => void)[]; __tracks: MediaStreamTrack[] };
    w.__grants = []; w.__encodes = []; w.__tracks = [];
    let handle: string | null = null;
    const md = navigator.mediaDevices as MediaDevices & { setCaptureHandleConfig: (c: { handle: string }) => void };
    md.setCaptureHandleConfig = (c) => { handle = c.handle; };
    const synthetic = () => {
      const c = document.createElement('canvas');
      c.width = window.innerWidth; c.height = window.innerHeight;
      const g = c.getContext('2d')!;
      setInterval(() => { g.fillStyle = '#7f7f7f'; g.fillRect(0, 0, c.width, c.height); }, 30);
      const s = c.captureStream(30);
      const t = s.getVideoTracks()[0]! as MediaStreamTrack & { getCaptureHandle: () => unknown };
      t.getCaptureHandle = () => ({ handle, origin: location.origin });
      w.__tracks.push(t);
      return s;
    };
    md.getDisplayMedia = () => new Promise((ok) => { w.__grants.push(() => ok(synthetic())); });
    const toBlob = HTMLCanvasElement.prototype.toBlob;
    HTMLCanvasElement.prototype.toBlob = function (this: HTMLCanvasElement, ...args: Parameters<typeof toBlob>) { w.__encodes.push(() => toBlob.apply(this, args)); };
  });
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  const pending = (k: '__grants' | '__encodes') => page.evaluate((key) => (window as unknown as Record<string, unknown[]>)[key]!.length, k);
  const release = (k: '__grants' | '__encodes') => page.evaluate((key) => (window as unknown as Record<string, (() => void)[]>)[key]!.shift()!(), k);
  const waitPending = async (k: '__grants' | '__encodes') => { for (let i = 0; i < 50 && (await pending(k)) === 0; i++) await page.waitForTimeout(100); assert.equal(await pending(k), 1, k); };

  await clickTarget(page);
  await waitPending('__grants');
  await release('__grants');
  await captureIs(page, 'selecting');
  await page.locator('header.topbar').click();
  await waitPending('__encodes');
  await page.evaluate(() => (window as unknown as { __tracks: MediaStreamTrack[] }).__tracks[0]!.dispatchEvent(new Event('ended')));
  await captureIs(page, 'inactive:stopped');
  await release('__encodes');
  await page.waitForTimeout(500);
  assert.deepEqual([await page.locator('#socrate-frame').isVisible(), await page.locator('#socrate-bubble').isVisible()], [false, false], 'l’encodage tardif n’ouvre ni panneau ni éditeur');
  const label = await page.locator(TARGET).getAttribute('data-capture');
  assert.equal(label, 'inactive:stopped', `le partage interrompu ne redevient pas actif (${label} ; ${await page.evaluate(() => document.querySelectorAll('style[data-socrate]').length)} style(s) de masquage)`);
  await openPanel(page);
  assert.equal(await panel(page).getByTestId('socrate-shot').count(), 0, 'aucun brouillon installé après l’interruption');
  assert.equal(await captureState(page), 'inactive:stopped');
  assert.equal(await page.evaluate(() => document.querySelectorAll('style[data-socrate="hide"]').length), 0, 'les contrôles Socrate ne restent pas masqués');
  await toggleList(page);

  await clickTarget(page);
  await waitPending('__grants');
  await page.getByRole('button', { name: 'Se déconnecter' }).click();
  await page.getByRole('button', { name: 'Se connecter comme Claire Morel, relectrice produit' }).waitFor();
  await release('__grants');
  const late = await page.evaluate(async () => { await new Promise((r) => setTimeout(r, 200)); const t = (window as unknown as { __tracks: MediaStreamTrack[] }).__tracks; return t.map((x) => x.readyState); });
  assert.deepEqual(late, ['ended', 'ended'], 'la piste accordée après le démontage est fermée, jamais laissée sans propriétaire');
  await ctx.context.close();
});

test('arrêt du partage pendant un envoi en vol (réponse de réservation retenue par le banc, permission automatique Chromium) : aucun PUT ni commit ensuite, rien de publié, texte conservé', async () => {
  const auto = await openBrowser({ autoAcceptTabCapture: true });
  try {
    const ctx = await editorial(auto.newContext(origins()));
    const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
    const section = panel(page).locator('section[aria-labelledby="socrate-cible"]');
    const isReserve = (r: SeenRequest) => r.method === 'POST' && path(r).endsWith('/targeted');
    const later = (r: SeenRequest) => /\/captures\//.test(path(r)) && r.method !== 'GET';
    await page.getByRole('link', { name: 'Réglages' }).click();
    await page.getByTestId('open-courte').click();
    await clickTarget(page);
    await captureIs(page, 'selecting');
    await page.getByTestId('scene-save').click();
    await panel(page).getByTestId('socrate-shot').waitFor();
    const body = 'Envoi en vol interrompu par l’arrêt du partage.';
    await panel(page).locator('#socrate-targeted-draft').fill(body);
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    ctx.setFaults((r) => (isReserve(r) ? { kind: 'hold-response', until: held } : { kind: 'pass' }));
    await section.getByRole('button', { name: 'Publier le retour ciblé' }).click();
    for (let i = 0; i < 50 && serviceOnly(ctx, isReserve).length === 0; i++) await page.waitForTimeout(100);
    assert.equal(serviceOnly(ctx, isReserve).length, 1, 'réservation émise, réponse retenue');
    await section.getByRole('button', { name: 'Arrêter le partage' }).click();
    await section.getByTestId('socrate-capture-invalidated').waitFor();
    release();
    ctx.setFaults(null);
    await section.getByText(/Le partage a été interrompu avant la validation : rien n’a été publié/).waitFor();
    assert.equal(serviceOnly(ctx, later).length, 0, 'ni PUT ni commit après l’arrêt, même pour la réservation déjà acceptée');
    assert.equal(await messagesNamed(body), 0);
    assert.equal(await panel(page).locator('#socrate-targeted-draft').inputValue(), body, 'le texte reste en brouillon');
    assert.ok(await section.getByRole('button', { name: 'Publier le retour ciblé' }).isDisabled(), 'nouveau ciblage exigé');
    await ctx.context.close();
  } finally {
    await auto.close();
  }
});

type ApiThread = { target: { route: string; frame?: string[]; rect: { x: number; y: number; width: number; height: number } } | null; capture: { captureId: string } | null; messages: Array<{ body: string }> };

/** Sonde de banc injectée dans chaque document : écouteurs de capture posés sur sa fenêtre et appels getDisplayMedia, sans effet sur le produit. */
const LISTENER_PROBE = () => {
  const live: Array<[string, unknown]> = [];
  Object.assign(window, { __probe: live, __gdm: 0 });
  const add = EventTarget.prototype.addEventListener;
  const rem = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (this: EventTarget, t: string, l: unknown, o?: unknown) { if (this === window && o === true) live.push([t, l]); return add.call(this, t, l as EventListener, o as boolean); };
  EventTarget.prototype.removeEventListener = function (this: EventTarget, t: string, l: unknown, o?: unknown) { if (this === window && o === true) { const i = live.findIndex(([a, b]) => a === t && b === l); if (i >= 0) live.splice(i, 1); } return rem.call(this, t, l as EventListener, o as boolean); };
  const gdm = MediaDevices.prototype.getDisplayMedia;
  MediaDevices.prototype.getDisplayMedia = function (this: MediaDevices, ...a: Parameters<typeof gdm>) { (window as unknown as { __gdm: number }).__gdm++; return gdm.apply(this, a); };
};

test('vue scindée (permission automatique Chromium, pas la preuve native) : cibles du document principal et de l’iframe de même origine, une seule revue, interception et Escape dans les deux documents, navigation, rechargement, fermeture et réouverture, écouteurs libérés, origine opaque non observée', async () => {
  const auto = await openBrowser({ headed: DISPLAY.headed, autoAcceptTabCapture: true });
  try {
    const ctx = await editorial(auto.newContext(origins(), { deviceScaleFactor: DISPLAY.dpr }));
    await ctx.context.addInitScript(LISTENER_PROBE);
    const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.getByRole('link', { name: 'Vue scindée' }).click();
    const frameEl = page.getByTestId('split-frame');
    const app = page.frameLocator('[data-testid="split-frame"]');
    const appReady = () => app.getByRole('heading', { name: 'Rappels automatiques' }).waitFor({ timeout: 10_000 }).catch(async (e) => {
      const child = await page.evaluate(() => { const f = document.querySelector('[data-testid="split-frame"]') as HTMLIFrameElement | null; return f ? `${f.contentWindow?.location.href} :: ${f.contentDocument?.body?.innerText.slice(0, 300)}` : '(pas d’iframe)'; });
      throw new Error(`iframe de la vue scindée non chargée : ${child} ; erreurs ${errors.join(' | ')} ; bloquées ${ctx.blocked.slice(-4).join(' | ')}`, { cause: e });
    });
    await appReady();
    await openPanel(page);
    await hidePins(page);
    const target = page.locator(TARGET);
    await activateCapture(page);
    const facts: Record<string, unknown> = {};
    const appFrame = async () => (await frameEl.elementHandle())!.contentFrame().then((f) => f!);
    const probe = async () => (await appFrame()).evaluate(() => (window as unknown as { __probe: unknown[] }).__probe.length);
    const opaque = () => page.frames().find((f) => f.url() === 'about:srcdoc')!;
    const opaqueProbe = () => opaque().evaluate(() => (window as unknown as { __probe: unknown[] }).__probe.length);

    // Critère 2 : un seul panneau, une seule barre Socrate, un seul partage d'onglet.
    const single = await page.evaluate(() => {
      const child = (document.querySelector('[data-testid="split-frame"]') as HTMLIFrameElement).contentWindow as Window & { __gdm: number };
      return { panels: document.querySelectorAll('#socrate-frame').length, launchers: document.querySelectorAll('[data-socrate="launcher"]').length, childSocrate: child.document.querySelectorAll('[data-socrate], #socrate-frame').length, topGdm: (window as unknown as { __gdm: number }).__gdm, childGdm: child.__gdm };
    });
    facts.single = single;
    assert.deepEqual(single, { panels: 1, launchers: 1, childSocrate: 0, topGdm: 1, childGdm: 0 });

    const withoutControls = dataUrl(await page.screenshot({ style: HIDE_SOCRATE }));
    await writeFile(join(ARTIFACTS, 'vue-scindee-reference.png'), Buffer.from(withoutControls.split(',')[1]!, 'base64'));
    facts.display = { ...DISPLAY, ...await page.evaluate(() => ({ devicePixelRatio, viewport: { width: innerWidth, height: innerHeight } })) };
    // Le menu de correction accroche l'iframe au premier survol, pour toute la durée du mode actif : base relevée après lui.
    const frameBox = (await frameEl.boundingBox())!;
    await page.mouse.move(frameBox.x + 4, frameBox.y + 4);
    const base = { child: await probe(), opaque: await opaqueProbe() };
    facts.base = base;
    const published: Record<string, string> = {};
    // Un nouveau brouillon se reconnaît à sa nouvelle URL blob, pas au hash : deux images fidèles peuvent avoir les mêmes pixels.
    const shotSrc = async () => { const img = panel(page).getByTestId('socrate-shot').locator('img'); return (await img.count()) ? img.getAttribute('src') : null; };
    const oldSuccess = () => panel(page).getByText('Retour ciblé publié avec son image.').count();
    const noticeText = async () => { const n = panel(page).getByTestId('socrate-capture-invalidated'); return (await n.count()) ? n.textContent() : null; };
    const awaitShot = async (before: string | null, route: string, what: string) => {
      await panel(page).locator('[data-testid="socrate-capture-status"][data-capture="active"]').waitFor({ timeout: 10_000 });
      const [src, notice] = [await shotSrc(), await noticeText()];
      if (notice || !src || src === before) {
        await page.screenshot({ path: join(ARTIFACTS, `vue-scindee-echec-${what.replace(/\W+/g, '-')}.png`) });
        throw new Error(`${what} : aucun nouveau brouillon (avis « ${notice ?? '(aucun)'} », image ${!src ? 'absente' : src === before ? 'inchangée' : 'nouvelle'})`);
      }
      const fig = panel(page).getByTestId('socrate-shot');
      assert.equal(await fig.getAttribute('data-superseded'), null, `${what} : brouillon courant`);
      assert.ok((await fig.innerText()).includes(`sur ${route}`), `${what} : contexte ${route} du nouveau brouillon`);
      assert.equal(await oldSuccess(), 0, `${what} : le succès d’une publication précédente n’est plus affiché à côté du nouveau brouillon`);
      return src;
    };
    const shootAt = async (box: { x: number; y: number; width: number; height: number }, route: string, what: string) => {
      const before = await shotSrc();
      await target.click();
      await captureIs(page, 'selecting');
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      return awaitShot(before, route, what);
    };
    // Après un rechargement, l'ancien document reste lisible un moment : on attend son remplacement effectif.
    const reloadChild = async () => {
      await page.evaluate(() => Object.assign(window, { __oldChildDoc: (document.querySelector('[data-testid="split-frame"]') as HTMLIFrameElement).contentDocument }));
      await (await appFrame()).evaluate(() => location.reload());
      await page.waitForFunction(() => { const f = document.querySelector('[data-testid="split-frame"]') as HTMLIFrameElement; return f.contentDocument !== (window as unknown as { __oldChildDoc: Document }).__oldChildDoc && f.contentDocument?.readyState === 'complete'; });
    };
    const publish = async (body: string) => {
      await panel(page).locator('#socrate-targeted-draft').fill(body);
      await panel(page).getByRole('button', { name: 'Publier le retour ciblé' }).click();
      await panel(page).getByText('Retour ciblé publié avec son image.').waitFor();
      const row = await stack.service.db.prepare('SELECT g.context, g.capture_id FROM targets g JOIN messages m ON m.thread_id = g.thread_id WHERE m.body = ?').bind(body).first<{ context: string; capture_id: string }>();
      return { ...JSON.parse(row!.context) as { route: string; frame?: string[]; rect: { x: number; y: number; width: number; height: number } }, captureId: row!.capture_id };
    };
    const near = (rect: { x: number; y: number; width: number; height: number }, box: typeof rect, what: string) => {
      for (const k of ['x', 'y', 'width', 'height'] as const) assert.ok(Math.abs(rect[k] - box[k]) < 1, `${what} : ${k} ${rect[k]} contre ${box[k]} dans le viewport de l’onglet`);
    };

    // Critères 1 et 3, iframe : sélection active dans l'enfant, action métier (ouvrir la modal) non déclenchée.
    await target.click();
    await captureIs(page, 'selecting');
    facts.selectingChild = await probe();
    assert.ok(facts.selectingChild as number >= base.child + 20, `écouteurs posés dans l’iframe pendant la sélection (${facts.selectingChild} contre ${base.child})`);
    assert.equal(await opaqueProbe(), base.opaque, 'critère 6 : aucun écouteur dans l’iframe d’origine opaque');
    const courte = (await app.getByTestId('open-courte').boundingBox())!;
    await page.mouse.click(courte.x + courte.width / 2, courte.y + courte.height / 2);
    await awaitShot(null, '/reglages/rappels', 'cible de l’iframe');
    assert.equal(await app.getByTestId('scene-dialog').count(), 0, 'la modal de l’iframe ne s’est pas ouverte');
    assert.equal(await probe(), base.child, 'écouteurs de l’iframe libérés à la sortie de sélection');
    const shotChild = await shotDataOf(page);
    await writeFile(join(ARTIFACTS, 'vue-scindee-cible-iframe.png'), Buffer.from(shotChild.split(',')[1]!, 'base64'));
    published.child = 'Retour dans l’iframe de la vue scindée.';
    const child = await publish(published.child);
    facts.child = child;
    assert.equal(child.route, '/reglages/rappels');
    const resolves = (frame: string[] | undefined) => page.evaluate((f) => f?.length === 1 && document.querySelector(f[0]!) === document.querySelector('[data-testid="split-frame"]'), frame);
    assert.ok(await resolves(child.frame), `chemin de frame ${JSON.stringify(child.frame)} résolu vers l’iframe de la vue scindée`);
    near(child.rect, courte, 'cible de l’iframe');
    const atChild = await regionDiff(page, shotChild, withoutControls, child.rect);
    facts.diffChild = atChild;
    assert.ok(atChild.mean < 6, `le rectangle de l’iframe montre la cible dans l’image (écart ${atChild.mean.toFixed(2)})`);

    // Critères 1 et 3, document principal : l'export n'est pas déclenché.
    const exportBox = await boxOf(page, '[data-testid="split-export"]');
    await shootAt(exportBox, '/vue-scindee', 'cible principale');
    assert.equal(await page.getByTestId('split-exports').textContent(), '0', 'export non déclenché');
    const shotTop = await shotDataOf(page);
    await writeFile(join(ARTIFACTS, 'vue-scindee-cible-principale.png'), Buffer.from(shotTop.split(',')[1]!, 'base64'));
    published.top = 'Retour dans le document principal de la vue scindée.';
    const top = await publish(published.top);
    facts.top = top;
    assert.equal(top.route, '/vue-scindee');
    assert.deepEqual(top.frame, []);
    near(top.rect, exportBox, 'cible principale');
    const atTop = await regionDiff(page, shotTop, withoutControls, top.rect);
    facts.diffTop = atTop;
    assert.ok(atTop.mean < 6, `le rectangle principal montre la cible (écart ${atTop.mean.toFixed(2)})`);

    // Critère 3 : Escape dans chaque document (le focus quitte d'abord le panneau Socrate, qui n'est pas observé).
    await page.getByTestId('split-export').focus();
    await target.click();
    await captureIs(page, 'selecting');
    await page.keyboard.press('Escape');
    await captureIs(page, 'active');
    await target.click();
    await captureIs(page, 'selecting');
    await app.locator('input').first().focus();
    facts.escapeFocus = await (await appFrame()).evaluate(() => ({ focused: document.hasFocus(), active: document.activeElement?.tagName }));
    await page.keyboard.press('Escape');
    await captureIs(page, 'active');
    assert.equal(await probe(), base.child, 'Escape tapé dans l’iframe : sélection annulée, écouteurs libérés');

    // Critère 6 : pendant la sélection, le clic dans l'origine opaque n'est ni observé ni intercepté.
    await target.click();
    await captureIs(page, 'selecting');
    await page.frameLocator('iframe[title="Widget tiers"]').getByRole('button').click();
    await page.frameLocator('iframe[title="Widget tiers"]').getByText('Widget cliqué').waitFor();
    assert.equal(await captureState(page), 'selecting');
    assert.equal(await opaqueProbe(), base.opaque);
    // L'origine opaque garde le focus et ne relaie pas Escape : il est tapé depuis le document principal.
    await page.getByTestId('split-export').focus();
    await page.keyboard.press('Escape');
    await captureIs(page, 'active');

    // Critère 4 : navigation SPA dans l'iframe, puis rechargement pendant la sélection.
    await app.getByRole('link', { name: 'Général' }).click();
    await app.getByRole('heading', { name: 'Général' }).waitFor();
    const generalSrc = await shootAt((await app.getByRole('heading', { name: 'Général' }).boundingBox())!, '/reglages/general', 'après navigation SPA');
    facts.afterSpa = await panel(page).getByTestId('socrate-shot').innerText();

    // Reciblage refusé avec un brouillon présent : le vrai encodage est retenu, le document de l'iframe réellement remplacé, puis l'encodage rendu.
    const kept = 'Texte rédigé pour Général, conservé après le refus.';
    await panel(page).locator('#socrate-targeted-draft').fill(kept);
    await page.evaluate(() => {
      const native = HTMLCanvasElement.prototype.toBlob;
      Object.assign(window, { __nativeToBlob: native });
      HTMLCanvasElement.prototype.toBlob = function (this: HTMLCanvasElement, cb: BlobCallback, ...a: [string?, number?]) { native.call(this, (b) => Object.assign(window, { __releaseEncode: () => cb(b) }), ...a); };
    });
    await target.click();
    await captureIs(page, 'selecting');
    const heading = (await app.getByRole('heading', { name: 'Général' }).boundingBox())!;
    await page.mouse.click(heading.x + heading.width / 2, heading.y + heading.height / 2);
    await page.waitForFunction(() => typeof (window as unknown as { __releaseEncode?: unknown }).__releaseEncode === 'function', undefined, { timeout: 10_000 });
    assert.equal(await captureState(page), 'capturing', 'encodage retenu');
    await reloadChild();
    await page.evaluate(() => { const w = window as unknown as { __nativeToBlob: HTMLCanvasElement['toBlob']; __releaseEncode: () => void }; HTMLCanvasElement.prototype.toBlob = w.__nativeToBlob; w.__releaseEncode(); });
    await panel(page).locator('[data-testid="socrate-capture-status"][data-capture="active"]').waitFor();
    const publishTargeted = panel(page).getByRole('button', { name: 'Publier le retour ciblé' });
    facts.superseded = {
      notice: await noticeText(), sameImage: (await shotSrc()) === generalSrc, flag: await panel(page).getByTestId('socrate-shot').getAttribute('data-superseded'),
      caption: await panel(page).getByTestId('socrate-shot').innerText(), publishDisabled: await publishTargeted.isDisabled(),
      blocked: await panel(page).getByTestId('socrate-targeted-blocked').count(), text: await panel(page).locator('#socrate-targeted-draft').inputValue(),
      oldSuccess: await oldSuccess(),
    };
    await page.screenshot({ path: join(ARTIFACTS, 'vue-scindee-reciblage-refuse.png') });
    const sup = facts.superseded as Record<string, unknown>;
    assert.match(String(sup.notice), /iframe de la cible a été fermée ou rechargée.*brouillon précédent, texte et image, est conservé mais ne peut plus être publié/, 'le refus est annoncé malgré l’ancien aperçu');
    assert.deepEqual({ sameImage: sup.sameImage, flag: sup.flag, publishDisabled: sup.publishDisabled, blocked: sup.blocked, text: sup.text, oldSuccess: sup.oldSuccess }, { sameImage: true, flag: 'true', publishDisabled: true, blocked: 1, text: kept, oldSuccess: 0 }, 'ancien aperçu et texte conservés, désignés comme antérieurs, publication ciblée bloquée, aucun ancien succès affiché');
    assert.match(String(sup.caption), /Ciblage précédent, non publiable.*sur \/reglages\/general/);

    // Reprise par un nouveau ciblage, l'injection retirée : rechargement pendant la sélection, puis tir.
    await app.getByRole('link', { name: 'Rappels' }).click();
    await app.getByRole('heading', { name: 'Rappels automatiques' }).waitFor();
    await target.click();
    await captureIs(page, 'selecting');
    await reloadChild();
    await app.getByRole('heading', { name: 'Rappels automatiques' }).waitFor();
    await page.waitForFunction(() => ((document.querySelector('[data-testid="split-frame"]') as HTMLIFrameElement).contentWindow as unknown as { __probe: unknown[] }).__probe.length >= 20);
    const courte2 = (await app.getByTestId('open-courte').boundingBox())!;
    await page.mouse.click(courte2.x + courte2.width / 2, courte2.y + courte2.height / 2);
    await awaitShot(generalSrc, '/reglages/rappels', 'après rechargement');
    assert.equal(await publishTargeted.isDisabled(), false, 'le ciblage réussi rend la publication ciblée possible');
    assert.equal(await panel(page).locator('#socrate-targeted-draft').inputValue(), kept, 'texte conservé à travers le refus et la reprise');
    assert.equal(await app.getByTestId('scene-dialog').count(), 0, 'après rechargement pendant la sélection, la modal ne s’ouvre pas');
    assert.equal(await app.getByText('Rappels automatiques').count() > 0, true, 'session hôte conservée après rechargement');

    // Critère 4 : fermeture puis réouverture de la vue scindée.
    await page.getByTestId('split-toggle').click();
    await frameEl.waitFor({ state: 'detached' });
    await page.getByTestId('split-toggle').click();
    await appReady();
    const courte3 = (await app.getByTestId('open-courte').boundingBox())!;
    await shootAt(courte3, '/reglages/rappels', 'après réouverture');
    assert.equal(await app.getByTestId('scene-dialog').count(), 0);
    published.reopened = 'Retour après réouverture de la vue scindée.';
    const reopened = await publish(published.reopened);
    facts.reopened = reopened;
    assert.equal(reopened.route, '/reglages/rappels');
    assert.ok(await resolves(reopened.frame), 'chemin de frame résolu vers l’iframe rouverte');
    near(reopened.rect, courte3, 'cible après réouverture');

    // Critère 5 : l'hôte ferme la vue scindée pendant la sélection (navigation SPA de l'onglet) : les écouteurs de l'iframe sont retirés.
    await target.click();
    await captureIs(page, 'selecting');
    await page.evaluate(() => Object.assign(window, { __closed: (document.querySelector('[data-testid="split-frame"]') as HTMLIFrameElement).contentWindow }));
    facts.beforeClose = await page.evaluate(() => (window as unknown as { __closed: { __probe: unknown[] } }).__closed.__probe.length);
    await page.evaluate(() => { history.pushState(null, '', '/'); dispatchEvent(new PopStateEvent('popstate')); });
    await frameEl.waitFor({ state: 'detached' });
    await page.waitForFunction(() => (window as unknown as { __closed: { __probe: unknown[] } }).__closed.__probe.length < 20);
    facts.afterClose = await page.evaluate(() => (window as unknown as { __closed: { __probe: unknown[] } }).__closed.__probe.length);
    assert.equal(facts.afterClose, base.child, `écouteurs retirés de l’iframe fermée (${facts.beforeClose} → ${facts.afterClose})`);
    await page.keyboard.press('Escape');
    await captureIs(page, 'active');

    // Lecture par l'API du service des retours parent et enfant.
    await page.reload();
    const read = page.waitForResponse((r) => r.request().method() === 'GET' && new URL(r.url()).pathname.endsWith('/threads'));
    await openPanel(page);
    const list = ((await (await read).json()) as { items: ApiThread[] }).items;
    const stored = { child, top, reopened } as Record<string, Awaited<ReturnType<typeof publish>>>;
    facts.apiRead = Object.fromEntries(Object.entries(published).map(([k, text]) => {
      const t = list.find((x) => x.messages.some((m) => m.body === text));
      return [k, { captureId: t?.capture?.captureId, route: t?.target?.route, frame: t?.target?.frame, rect: t?.target?.rect }];
    }));
    for (const k of Object.keys(published)) {
      const { captureId, route, frame, rect } = stored[k]!;
      assert.deepEqual((facts.apiRead as Record<string, unknown>)[k], { captureId, route, frame, rect }, `GET /threads relit le retour ${k} avec sa capture et son contexte`);
    }
    await writeFile(join(ARTIFACTS, 'vue-scindee-faits.json'), JSON.stringify(facts, null, 2));
    await ctx.context.close();
  } finally {
    await auto.close();
  }
});

/** Sonde de banc : observateurs DOM vivants (observe sans disconnect), hors script injecté de Playwright, et clics vus par le document de l'hôte. */
const OBSERVER_PROBE = () => {
  const live = new Map<MutationObserver, string>();
  Object.assign(window, { __observers: live, __hostClicks: 0 });
  const observe = MutationObserver.prototype.observe;
  const disconnect = MutationObserver.prototype.disconnect;
  MutationObserver.prototype.observe = function (this: MutationObserver, ...a: Parameters<typeof observe>) {
    const from = String(new Error().stack).split('\n').slice(2, 4).join(' | ');
    if (!from.includes('InjectedScript')) live.set(this, from);
    return observe.apply(this, a);
  };
  MutationObserver.prototype.disconnect = function (this: MutationObserver) { live.delete(this); return disconnect.call(this); };
  document.addEventListener('click', () => { (window as unknown as { __hostClicks: number }).__hostClicks++; });
};
const probeOf = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __observers: Map<unknown, string>; __hostClicks: number; __sentinel?: number };
  return { observers: w.__observers.size, from: [...w.__observers.values()], hostClicks: w.__hostClicks, sentinel: w.__sentinel ?? null, route: location.pathname, markers: document.querySelectorAll('[data-socrate="marker"]').length, notes: document.querySelectorAll('[data-socrate="marker-note"]').length, highlights: document.querySelectorAll('[data-socrate="highlight"]').length };
});
const inside = (outer: { x: number; y: number; width: number; height: number }, inner: { x: number; y: number; width: number; height: number }, slack = 6) =>
  inner.x >= outer.x - slack && inner.y >= outer.y - slack && inner.x + inner.width <= outer.x + outer.width + slack && inner.y + inner.height <= outer.y + outer.height + slack;

test('zones et repères : navigation sans rechargement, mise en évidence ou indication, aucune modal ni action métier, repères rattachés à leur instance, observation libérée', async () => {
  const ctx = await editorial(browser.newContext(origins()));
  await ctx.context.addInitScript(OBSERVER_PROBE);
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await page.getByRole('heading', { level: 1, name: 'Agenda' }).waitFor();
  await page.evaluate(() => { (window as unknown as { __sentinel: number }).__sentinel = 1; });
  await openPanel(page);
  await hidePins(page);
  const guideLoads = () => ctx.seen.filter((r) => /\/guide\.tsx/.test(path(r))).length;
  assert.equal(guideLoads(), 0, 'le guidage n’est pas chargé à l’ouverture');
  assert.equal((await probeOf(page)).observers, 0, 'panneau ouvert hors mode repères : aucune observation du DOM');
  await panel(page).getByText('Source indicative : apps/demo/src/main.tsx, composant Application').waitFor();

  await panel(page).getByRole('button', { name: 'Modification d’un rendez-vous' }).click();
  await panel(page).getByRole('status').filter({ hasText: 'Élément mis en évidence dans l’application.' }).waitFor();
  await page.getByRole('heading', { level: 1, name: /Rendez-vous du 21 octobre/ }).waitFor();
  let p = await probeOf(page);
  assert.deepEqual([p.route, p.sentinel, p.highlights], ['/rendez-vous/rdv-1042', 1, 1], 'navigation par l’adaptateur, sans rechargement complet, un seul contour');
  assert.ok(inside(await boxOf(page, '[data-socrate="highlight"]'), await boxOf(page, '[data-socrate-id="fiche-rendez-vous"]')), 'le contour entoure la fiche');
  assert.equal(guideLoads(), 1, 'guidage chargé au premier geste');
  await page.screenshot({ path: join(ARTIFACTS, 'zones-mise-en-evidence.png') });

  await panel(page).getByRole('button', { name: 'Réglages des rappels' }).click();
  await panel(page).getByRole('status').filter({ hasText: 'Élément absent de l’écran. Ouvrir les réglages, la section Rappels, puis « Modèle détaillé »' }).waitFor();
  await page.getByRole('heading', { level: 1, name: 'Rappels automatiques' }).waitFor();
  p = await probeOf(page);
  assert.deepEqual([p.route, p.sentinel, p.highlights], ['/reglages/rappels', 1, 0], 'cible absente : aucun contour, indication de la manipulation restante');
  assert.equal(await page.getByTestId('scene-dialog').count(), 0, 'Socrate n’ouvre pas la modal');
  assert.equal(await page.getByTestId('scene-saved').innerText(), '0');
  assert.equal(await page.getByRole('textbox', { name: /Délai de rappel/ }).inputValue(), '24', 'aucun champ rempli');
  await page.screenshot({ path: join(ARTIFACTS, 'zones-indication-restante.png') });

  await panel(page).getByRole('button', { name: 'Voir les changements' }).click();
  await panel(page).getByRole('status').filter({ hasText: '2 repère(s) affiché(s), 2 absent(s) de cette page.' }).waitFor();
  assert.equal(await panel(page).getByRole('button', { name: 'Voir les changements' }).getAttribute('aria-pressed'), 'true');
  p = await probeOf(page);
  assert.deepEqual([p.markers, p.observers], [2, 1], `deux repères et une seule observation active : ${JSON.stringify(p.from)}`);
  assert.deepEqual(await page.locator('[data-socrate="marker"]').evaluateAll((els) => els.map((e) => `${(e as HTMLElement).dataset.marker}:${e.textContent}`)), ['rappel-delai:Nouveau', 'rappel-libelle:Avis demandé']);

  await page.getByRole('banner').getByRole('link', { name: 'Agenda' }).click();
  await page.getByRole('heading', { level: 1, name: 'Agenda' }).waitFor();
  await panel(page).getByRole('status').filter({ hasText: '1 repère(s) affiché(s), 3 absent(s) de cette page.' }).waitFor();
  const badge = page.locator('[data-socrate="marker"]');
  assert.equal(await badge.getAttribute('data-marker'), 'ligne-rendez-vous#rdv-1042', 'repère rattaché à son instance');
  const rows = page.locator('[data-socrate-id="ligne-rendez-vous"]');
  assert.equal(await rows.count(), 2, 'identifiant répété dans la liste');
  const badgeBox = (await badge.boundingBox())!;
  const own = (await page.locator('[data-socrate-instance="rdv-1042"]').boundingBox())!;
  const other = (await page.locator('[data-socrate-instance="rdv-1043"]').boundingBox())!;
  const bottom = badgeBox.y + badgeBox.height;
  assert.ok(Math.abs(bottom - own.y) < 2 && Math.abs(bottom - other.y) > 8 && Math.abs(badgeBox.x - own.x) < 2, `repère posé sur la ligne rdv-1042 (${bottom}, ${own.y}, ${other.y})`);
  const panelLeft = (await boxOf(page, '#socrate-frame')).x;
  assert.ok(badgeBox.x + badgeBox.width < panelLeft, `repère visible hors du panneau (${badgeBox.x + badgeBox.width} < ${panelLeft})`);

  await page.evaluate(() => { (window as unknown as { __hostClicks: number }).__hostClicks = 0; });
  await badge.click();
  await page.locator('[data-socrate="marker-note"]').filter({ hasText: 'Ce rendez-vous porte désormais un rappel automatique.' }).waitFor();
  p = await probeOf(page);
  assert.deepEqual([p.route, p.hostClicks, p.notes], ['/', 0, 1], 'le clic affiche l’explication sans navigation ni clic vu par l’hôte');
  await page.screenshot({ path: join(ARTIFACTS, 'reperes-explication.png') });

  await panel(page).getByRole('button', { name: 'Voir les changements' }).click();
  await panel(page).getByRole('status').filter({ hasText: 'repère(s) affiché(s)' }).waitFor({ state: 'detached' });
  p = await probeOf(page);
  assert.deepEqual([p.markers, p.notes, p.observers], [0, 0, 0], 'mode désactivé : repères retirés et observation libérée');
  await page.getByRole('banner').getByRole('link', { name: 'Réglages' }).click();
  await page.getByRole('heading', { level: 1, name: 'Rappels automatiques' }).waitFor();
  await page.waitForTimeout(500);
  p = await probeOf(page);
  assert.deepEqual([p.markers, p.observers], [0, 0], 'aucune observation reprise après navigation');
  // Masquage avec repères actifs, explication ouverte et contour posé : tout est libéré, le mode repart désactivé.
  await panel(page).getByRole('button', { name: 'Modification d’un rendez-vous' }).click();
  await panel(page).getByRole('status').filter({ hasText: 'Élément mis en évidence dans l’application.' }).waitFor();
  await page.getByRole('banner').getByRole('link', { name: 'Agenda' }).click();
  await page.getByRole('heading', { level: 1, name: 'Agenda' }).waitFor();
  await panel(page).getByRole('button', { name: 'Voir les changements' }).click();
  await panel(page).getByRole('status').filter({ hasText: '1 repère(s) affiché(s)' }).waitFor();
  await page.locator('[data-socrate="marker"]').click();
  await page.locator('[data-socrate="marker-note"]').waitFor();
  const activeBeforeHide = await probeOf(page);
  assert.deepEqual([activeBeforeHide.markers, activeBeforeHide.notes, activeBeforeHide.highlights, activeBeforeHide.observers], [1, 1, 1, 1], 'repères, explication, contour et observation actifs avant le masquage');
  await toggleList(page);
  p = await probeOf(page);
  assert.deepEqual([p.markers, p.notes, p.highlights, p.observers], [0, 0, 0, 0], 'masquage : repères, explication, contour et observation libérés');
  await page.screenshot({ path: join(ARTIFACTS, 'reperes-apres-masquage.png') });
  await showList(page);
  const toggle = panel(page).getByRole('button', { name: 'Voir les changements' });
  assert.equal(await toggle.getAttribute('aria-pressed'), 'false', 'le mode repart désactivé à la réouverture');
  await toggle.click();
  await panel(page).getByRole('status').filter({ hasText: '1 repère(s) affiché(s)' }).waitFor();
  const reactivated = await probeOf(page);
  assert.deepEqual([reactivated.markers, reactivated.observers], [1, 1], 'activation légitime après réouverture');
  await toggle.click();
  await panel(page).getByRole('status').filter({ hasText: 'repère(s) affiché(s)' }).waitFor({ state: 'detached' });
  p = await probeOf(page);
  assert.deepEqual([p.markers, p.observers], [0, 0]);
  // Zone suivie puis masquage ; à la réouverture, aucun message n'affirme le contour retiré, puis un nouveau geste localise.
  const zone = panel(page).getByRole('button', { name: 'Modification d’un rendez-vous' });
  const zoneFound = panel(page).getByRole('status').filter({ hasText: 'Élément mis en évidence dans l’application.' });
  await zone.click();
  await zoneFound.waitFor();
  await toggleList(page);
  await showList(page);
  await zone.waitFor();
  const zoneReopened = { messages: await zoneFound.count(), highlights: (await probeOf(page)).highlights };
  assert.deepEqual([zoneReopened.messages, zoneReopened.highlights], [0, 0], 'réouverture : ni contour ni message de mise en évidence');
  await page.screenshot({ path: join(ARTIFACTS, 'zone-apres-reouverture.png') });
  await zone.click();
  await zoneFound.waitFor();
  const zoneAgain = (await probeOf(page)).highlights;
  assert.equal(zoneAgain, 1, 'nouveau geste du nouveau cycle : contour reposé');
  await writeFile(join(ARTIFACTS, 'zones-reperes-faits.json'), JSON.stringify({ activeBeforeHide, reactivated, final: p, zoneReopened, zoneAgain, guideLoads: guideLoads() }, null, 1));
  await ctx.context.close();
});

test('guidage retenu puis fermeture et remount d’identité : aucune continuation hors de son cycle, rien sous Karim avant ouverture, puis activation légitime', async () => {
  const ctx = await editorial(browser.newContext(origins()));
  await ctx.context.addInitScript(OBSERVER_PROBE);
  let release = () => {};
  const facts: Record<string, unknown> = {};
  try {
    const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
    await page.getByRole('heading', { level: 1, name: 'Agenda' }).waitFor();
    await openPanel(page);
    let requested = false;
    const gate = new Promise<void>((done) => { release = done; });
    ctx.setFaults((r) => {
      if (new URL(r.url).pathname.endsWith('/guide.tsx')) { requested = true; return { kind: 'hold', until: gate }; }
      return { kind: 'pass' };
    });
    await panel(page).getByRole('button', { name: 'Voir les changements' }).click();
    for (const until = Date.now() + 5_000; !requested && Date.now() < until;) await page.waitForTimeout(20);
    assert.ok(requested, 'import du guidage réellement retenu par la fabrique');
    await panel(page).getByRole('button', { name: 'Fermer la revue' }).click();
    await page.getByRole('button', { name: 'Se déconnecter' }).click();
    await page.getByRole('button', { name: /Se connecter comme Claire Morel, relectrice produit/ }).waitFor();
    assert.equal(await page.locator('#socrate-frame').count(), 0, 'panneau réellement démonté');
    facts.beforeRelease = await probeOf(page);
    release();
    await page.waitForFunction(() => performance.getEntriesByType('resource').some((e) => e.name.includes('/guide.tsx')), undefined, { timeout: 5_000 });
    await page.waitForTimeout(500);
    facts.afterUnmount = await probeOf(page);
    assert.deepEqual([(facts.afterUnmount as { markers: number }).markers, (facts.afterUnmount as { observers: number }).observers], [0, 0], 'chunk livré après démontage : aucun repère ni observation');
    await page.getByRole('button', { name: /Se connecter comme Karim/ }).click();
    await page.getByRole('heading', { level: 1, name: 'Agenda' }).waitFor();
    await page.waitForTimeout(500);
    const karim = await probeOf(page);
    facts.nextIdentityBeforePanel = karim;
    assert.deepEqual([karim.markers, karim.observers, karim.highlights], [0, 0, 0], 'sous Karim avant ouverture : aucun repère, contour ni observateur résiduel');
    await page.screenshot({ path: join(ARTIFACTS, 'guidage-remount-karim.png') });
    ctx.setFaults(null);
    await openPanel(page);
    const toggle = panel(page).getByRole('button', { name: 'Voir les changements' });
    assert.equal(await toggle.getAttribute('aria-pressed'), 'false');
    await hidePins(page);
    await toggle.click();
    await panel(page).getByRole('status').filter({ hasText: '1 repère(s) affiché(s)' }).waitFor();
    const legit = await probeOf(page);
    facts.newPanelActivated = legit;
    assert.deepEqual([legit.markers, legit.observers], [1, 1], 'activation légitime du nouveau panneau');
    await toggle.click();
    await panel(page).getByRole('status').filter({ hasText: 'repère(s) affiché(s)' }).waitFor({ state: 'detached' });
    facts.final = await probeOf(page);
    assert.deepEqual([(facts.final as { markers: number }).markers, (facts.final as { observers: number }).observers], [0, 0]);
  } finally {
    release();
    await writeFile(join(ARTIFACTS, 'guidage-cycle-faits.json'), JSON.stringify(facts, null, 1));
    await ctx.context.close();
  }
});

const CONTINUITY_A = portNumber(process.env.SOCRATE_CONTINUITY_PORT_A ?? 5196, 'continuité A');
const CONTINUITY_B = portNumber(process.env.SOCRATE_CONTINUITY_PORT_B ?? 5197, 'continuité B');

test('continuité A puis B sur une autre origine : A révoqué refusé, fils de A ouverts et lisibles depuis B avec image, révision et explications d’origine, cible disparue ou ambiguë jamais rattachée, import B rejoué sans seconde revue', async () => {
  const { assembleManifest } = await import('@socrate/contract/assemble');
  const root = await mkdtemp(join(REPO_ROOT, '.tmp', 'continuite-'));
  const own = await rt.launchInstance({ root, name: 'continuite', ports: { service: 0, demo: CONTINUITY_A }, reset: false, deadline: deadlineIn(60_000) });
  const auto = await openBrowser({ autoAcceptTabCapture: true });
  const facts: Record<string, unknown> = {};
  try {
    const originA = own.view.demoOrigin;
    const originB = `http://127.0.0.1:${CONTINUITY_B}`;
    const ctx = await editorial(auto.newContext([originA, own.view.serviceUrl, originB]));
    const a = await ctx.context.newPage();
    await a.goto(`${originA}/`);
    await a.getByRole('button', { name: /Se connecter comme Claire Morel, relectrice produit/ }).click();
    const targetAndPublish = async (at: string | (() => Promise<{ x: number; y: number; width: number; height: number }>), body: string) => {
      const control = a.locator(TARGET);
      if (!(await control.count()) || (await control.getAttribute('data-capture'))!.startsWith('inactive')) await activateCapture(a);
      await captureIs(a, 'active');
      await control.click();
      await captureIs(a, 'selecting');
      const box = typeof at === 'string' ? await boxOf(a, at) : await at();
      // Au-delà du texte mais à gauche du panneau : le clic vise l'élément lui-même, pas un enfant.
      await a.mouse.click(box.x + Math.min(box.width - 4, 500), box.y + box.height / 2);
      await panel(a).getByTestId('socrate-shot').waitFor({ timeout: 10_000 });
      const sha = await panel(a).getByTestId('socrate-shot').locator('img').getAttribute('data-sha256');
      await panel(a).locator('#socrate-targeted-draft').fill(body);
      await panel(a).getByRole('button', { name: 'Publier le retour ciblé' }).click();
      await panel(a).getByText('Retour ciblé publié avec son image.').waitFor();
      return sha!;
    };
    await a.getByRole('link', { name: 'Ouvrir le rendez-vous de 14 h 30' }).click();
    await a.getByRole('heading', { level: 1, name: /Rendez-vous du 21 octobre/ }).waitFor();
    const mentionBody = 'La mention de rappel recalculé arrive trop tard.';
    const shaMention = await targetAndPublish('[data-socrate-id="rappel-mention"]', mentionBody);
    // Cible libre : paragraphe sans identifiant propre, sous la fiche éditoriale.
    const freeBody = 'Le nom du client devrait précéder le type de consultation.';
    const freeSelector = '[data-socrate-id="fiche-rendez-vous"] > p:nth-of-type(1)';
    await targetAndPublish(freeSelector, freeBody);
    await a.getByRole('banner').getByRole('link', { name: 'Agenda' }).click();
    await a.getByRole('heading', { level: 1, name: 'Agenda' }).waitFor();
    const rowBody = 'La ligne du rendez-vous de 14 h 30 ne montre pas le rappel.';
    const shaRow = await targetAndPublish('[data-socrate-instance="rdv-1042"]', rowBody);
    // Panneau masqué pour que le clic atteigne l'iframe ; le brouillon le rouvre.
    await toggleList(a);
    await a.getByRole('banner').getByRole('link', { name: 'Vue scindée' }).click();
    const splitA = a.frameLocator('[data-testid="split-frame"]');
    await splitA.getByRole('heading', { level: 1, name: 'Rappels automatiques' }).waitFor();
    const childBody = 'Dans la vue scindée, le libellé du rappel est trop technique.';
    await targetAndPublish(async () => ({ ...(await splitA.locator('[data-socrate-id="rappel-libelle"]').boundingBox())!, width: 40 }), childBody);
    const targets = (await own.service.db.prepare('SELECT m.body, g.context FROM messages m JOIN targets g ON g.thread_id = m.thread_id').all<{ body: string; context: string }>()).results;
    const selectorOf = (body: string) => JSON.parse(targets.find((t) => t.body === body)!.context).selector as string;
    assert.equal(selectorOf(rowBody), '[data-socrate-id="ligne-rendez-vous"][data-socrate-instance="rdv-1042"]', 'la cible répétée garde son contexte d’instance');
    assert.equal(selectorOf(mentionBody), '[data-socrate-id="rappel-mention"]');
    assert.equal(selectorOf(freeBody), freeSelector, 'cible libre : sélecteur positionnel sous l’ancêtre éditorial');
    const childContext = JSON.parse(targets.find((t) => t.body === childBody)!.context) as { route: string; hostRoute?: string; frame?: string[]; selector: string };
    assert.deepEqual([childContext.route, childContext.hostRoute, childContext.frame?.length, childContext.selector], ['/reglages/rappels', '/vue-scindee', 1, '[data-socrate-id="rappel-libelle"]'], 'route de l’hôte conservée à part de celle de l’enfant');
    facts.cibles = { libre: selectorOf(freeBody), enfant: childContext };

    // Sur A : enfant éditorial localisé dans l'iframe sans quitter la vue scindée, principale éditoriale entourée, libre jamais confirmée.
    const threadA = (body: string) => panel(a).getByTestId('socrate-thread').filter({ hasText: body });
    await threadA(childBody).getByRole('button', { name: 'Localiser la cible' }).click();
    const childFound = threadA(childBody).getByTestId('socrate-locate');
    await childFound.waitFor();
    assert.equal(await childFound.getAttribute('data-resolution'), 'found');
    assert.equal(new URL(a.url()).pathname, '/vue-scindee', 'l’hôte reste sur sa route, jamais celle de l’enfant');
    assert.deepEqual([await splitA.locator('[data-socrate="highlight"]').count(), await a.locator('[data-socrate="highlight"]').count()], [1, 0], 'contour posé dans le document enfant');
    await a.screenshot({ path: join(ARTIFACTS, 'continuite-a-enfant-localise.png') });
    await threadA(mentionBody).getByRole('button', { name: 'Localiser la cible' }).click();
    const mentionFound = threadA(mentionBody).getByTestId('socrate-locate');
    await mentionFound.waitFor();
    assert.equal(await mentionFound.getAttribute('data-resolution'), 'found');
    assert.ok(inside(await boxOf(a, '[data-socrate="highlight"]'), await boxOf(a, '[data-socrate-id="rappel-mention"]')), 'contour autour de la cible éditoriale principale');
    assert.equal(await splitA.locator('[data-socrate="highlight"]').count(), 0);
    // Cible localisée puis masquage ; à la réouverture, résultat et contour remis à zéro, puis nouvelle localisation.
    await toggleList(a);
    await showList(a);
    await threadA(mentionBody).getByRole('button', { name: 'Localiser la cible' }).waitFor();
    const targetReopened = { results: await threadA(mentionBody).getByTestId('socrate-locate').count(), highlights: await a.locator('[data-socrate="highlight"]').count() };
    assert.deepEqual([targetReopened.results, targetReopened.highlights], [0, 0], 'réouverture : aucun résultat « mise en évidence » sans contour');
    await a.screenshot({ path: join(ARTIFACTS, 'continuite-a-cible-apres-reouverture.png') });
    await threadA(mentionBody).getByRole('button', { name: 'Localiser la cible' }).click();
    await mentionFound.waitFor();
    assert.equal(await mentionFound.getAttribute('data-resolution'), 'found');
    assert.equal(await a.locator('[data-socrate="highlight"]').count(), 1, 'nouvelle localisation dans le nouveau cycle');
    facts.reouvertureCible = { ...targetReopened, highlightsApres: 1 };
    await threadA(freeBody).getByRole('button', { name: 'Localiser la cible' }).click();
    const freeA = threadA(freeBody).getByTestId('socrate-locate');
    await freeA.waitFor();
    assert.equal(await freeA.getAttribute('data-resolution'), 'indicative');
    assert.equal(await a.locator('[data-socrate="highlight"]').count(), 0, 'cible libre : aucun contour, même sur A');
    await a.screenshot({ path: join(ARTIFACTS, 'continuite-a-publie.png') });

    const assembled = await assembleManifest(localPath('apps/demo/.socrate'));
    assert.ok(assembled.ok);
    const manifestA = assembled.manifest;
    const manifestB = {
      ...manifestA,
      now: 'Le rappel est envoyé la veille sans mention dans la fiche ; l’agenda liste aussi le rappel du rendez-vous.',
      zones: manifestA.zones.map((z) => (z.id === 'fiche-rendez-vous' ? { ...z, markers: [{ kind: 'changed' as const, target: { id: 'ligne-rendez-vous' }, explanation: 'Repère volontairement sans instance : ambigu sur B.' }] } : z)),
    };
    const hostB = await own.addHost({ deploymentId: 'local-2', port: CONTINUITY_B, scene: 'b', manifest: manifestB, deadline: deadlineIn(60_000) });
    const replay = await own.importDeployment('local-2', `${originB}/`, manifestB);
    assert.equal(replay.status, 200, 'import CI de B rejoué sans effet');
    const counts = await own.service.db.prepare('SELECT (SELECT COUNT(*) FROM reviews) AS reviews, (SELECT COUNT(*) FROM deployments) AS deployments, (SELECT COUNT(*) FROM revisions) AS revisions').first<Record<string, number>>();
    assert.deepEqual(counts, { reviews: 1, deployments: 2, revisions: 2 }, 'aucune seconde revue');
    const revisionA = (await own.service.db.prepare("SELECT revision_id FROM deployments WHERE deployment_id = 'local-1'").first<{ revision_id: string }>())!.revision_id;
    assert.notEqual(hostB.revisionId, revisionA);

    const revoke = await fetch(`${own.view.serviceUrl}/v1/projects/demo/reviews/${manifestA.reviewKey}/deployments/local-1/revoke`, { method: 'POST', headers: { Authorization: `Bearer ${own.credentials.import}` } });
    assert.equal(revoke.status, 200, 'révocation par l’accès technique de la CI');
    const before = ctx.seen.length;
    await a.reload();
    await showList(a);
    await panel(a).getByRole('alert').waitFor({ timeout: 10_000 });
    const refusal = await frameDoc(a);
    assert.doesNotMatch(refusal, /La mention de rappel|La ligne du rendez-vous/, 'A révoqué : aucun fil servi');
    const afterRevoke = ctx.seen.slice(before).filter((r) => r.url.startsWith(own.view.serviceUrl));
    assert.ok(afterRevoke.length > 0, 'A a réellement tenté d’accéder au service');
    facts.refusA = { panneau: refusal.slice(0, 300), requetes: afterRevoke.map((r) => `${r.method} ${path(r)}`) };
    await a.screenshot({ path: join(ARTIFACTS, 'continuite-a-revoque.png') });
    const kept = await own.service.db.prepare("SELECT (SELECT revoked_at FROM deployments WHERE deployment_id = 'local-1') AS revoked, (SELECT COUNT(*) FROM threads WHERE state = 'open') AS open, (SELECT COUNT(*) FROM captures WHERE state = 'committed') AS captures").first<{ revoked: string | null; open: number; captures: number }>();
    assert.ok(kept?.revoked, 'A marqué révoqué, pas supprimé');
    assert.deepEqual([kept!.open, kept!.captures], [4, 4], 'aucun retour résolu ni capture supprimée par le redéploiement');

    const b = await ctx.context.newPage();
    await b.goto(`${originB}/`);
    // Le cookie de session fictif de l'hôte ne distingue pas les ports : Claire peut déjà être connectée sur B.
    const loginB = b.getByRole('button', { name: /Se connecter comme Claire Morel, relectrice produit/ });
    const agendaB = b.getByRole('heading', { level: 1, name: 'Agenda' });
    await loginB.or(agendaB).waitFor();
    if (await loginB.isVisible()) await loginB.click();
    await agendaB.waitFor();
    assert.equal(await b.locator('[data-socrate-instance="rdv-1042"]').count(), 2, 'B liste deux fois le rendez-vous de 14 h 30');
    await openPanel(b);
    const thread = (body: string) => panel(b).getByTestId('socrate-thread').filter({ hasText: body });
    for (const [body, sha] of [[mentionBody, shaMention], [rowBody, shaRow]] as const) {
      const t = thread(body);
      assert.equal(await t.locator('.socrate-badge').innerText(), 'Ouvert · ciblé');
      await t.getByText(`Publié sur le déploiement local-1, révision d’origine ${revisionA.slice(0, 12)}.`).waitFor();
      await t.getByRole('button', { name: 'Explications d’origine' }).click();
      const origin = await t.getByTestId('socrate-origin').innerText();
      assert.ok(origin.includes(manifestA.now) && !origin.includes(manifestB.now), 'explications de la révision A, pas de B');
      await t.getByRole('button', { name: 'Afficher l’image' }).click();
      const img = t.getByTestId('socrate-target-image');
      await img.waitFor();
      const seenSha = await img.evaluate(async (el) => { const buf = await (await fetch((el as HTMLImageElement).src)).arrayBuffer(); return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((x) => x.toString(16).padStart(2, '0')).join(''); });
      assert.equal(seenSha, sha, 'image d’origine lue depuis B, octets inchangés');
    }
    await b.screenshot({ path: join(ARTIFACTS, 'continuite-b-fils-a.png') });

    await thread(mentionBody).getByRole('button', { name: 'Localiser la cible' }).click();
    const missing = thread(mentionBody).getByTestId('socrate-locate');
    await missing.waitFor();
    assert.equal(await missing.getAttribute('data-resolution'), 'missing');
    assert.match(await missing.innerText(), /Cible non localisable sur ce déploiement/);
    assert.equal(await b.locator('[data-socrate="highlight"]').count(), 0);
    assert.equal(new URL(b.url()).pathname, '/rendez-vous/rdv-1042');
    await thread(rowBody).getByRole('button', { name: 'Localiser la cible' }).click();
    const ambiguous = thread(rowBody).getByTestId('socrate-locate');
    await ambiguous.waitFor();
    assert.equal(await ambiguous.getAttribute('data-resolution'), 'ambiguous');
    assert.equal(await b.locator('[data-socrate="highlight"]').count(), 0, 'cible ambiguë jamais rattachée au premier élément');
    await thread(freeBody).getByRole('button', { name: 'Localiser la cible' }).click();
    const freeB = thread(freeBody).getByTestId('socrate-locate');
    await freeB.waitFor();
    assert.equal(await b.locator(freeSelector).innerText(), 'Statut : confirmé par le client.', 'sur B, le sélecteur positionnel désigne le paragraphe inséré');
    assert.equal(await freeB.getAttribute('data-resolution'), 'indicative');
    assert.match(await freeB.innerText(), /Position indicative non confirmée/);
    assert.equal(await b.locator('[data-socrate="highlight"]').count(), 0, 'insertion devant une cible libre : aucun contour sur l’élément inséré');
    await b.screenshot({ path: join(ARTIFACTS, 'continuite-b-libre-indicative.png') });
    // Charge antérieure simulée dans le stockage de test : la route de l'hôte est retirée du contexte enregistré.
    await own.service.db.prepare("UPDATE targets SET context = json_remove(context, '$.hostRoute') WHERE thread_id = (SELECT thread_id FROM messages WHERE body = ?)").bind(childBody).run();
    await b.reload();
    await b.getByRole('banner').getByRole('link', { name: 'Vue scindée' }).click();
    await b.getByTitle('Seconde application en vue scindée').waitFor();
    await openPanel(b);
    await thread(childBody).getByRole('button', { name: 'Localiser la cible' }).click();
    const frames = thread(childBody).getByTestId('socrate-locate');
    await frames.waitFor();
    assert.equal(await frames.getAttribute('data-resolution'), 'ambiguous');
    assert.match(await frames.innerText(), /Plusieurs cadres correspondent.*Retour antérieur sans route de l’hôte/);
    assert.equal(new URL(b.url()).pathname, '/vue-scindee', 'charge antérieure : aucune navigation devinée');
    const frameHighlights = await b.evaluate(() => [...document.querySelectorAll('iframe')].map((f) => { try { return f.contentDocument?.querySelectorAll('[data-socrate="highlight"]').length ?? -1; } catch { return -1; } }));
    assert.equal(await b.locator('[data-socrate="highlight"]').count(), 0);
    assert.ok(frameHighlights.every((n) => n <= 0), `aucun contour dans un cadre arbitraire (${frameHighlights})`);
    facts.cadres = { resolution: 'ambiguous', frameHighlights };
    await b.screenshot({ path: join(ARTIFACTS, 'continuite-b-cadres-ambigus.png') });
    await panel(b).getByRole('button', { name: 'Voir les changements' }).click();
    await b.getByRole('banner').getByRole('link', { name: 'Agenda' }).click();
    await panel(b).getByRole('status').filter({ hasText: '1 ambigu(s) non rattaché(s)' }).waitFor();
    assert.equal(await b.locator('[data-socrate="marker"]').count(), 0, 'repère sans instance non rattaché sur B');
    await b.screenshot({ path: join(ARTIFACTS, 'continuite-b-cibles.png') });
    const states = (await own.service.db.prepare('SELECT state FROM threads').all<{ state: string }>()).results.map((r) => r.state);
    assert.deepEqual(states, ['open', 'open', 'open', 'open'], 'B ne résout aucun fil');
    Object.assign(facts, { revisionA, revisionB: hostB.revisionId, counts, kept, shaMention, shaRow });
    await ctx.context.close();
  } finally {
    await auto.close();
    const stopped = await own.stop('fin de la continuité');
    facts.arret = stopped;
    await writeFile(join(ARTIFACTS, 'continuite-faits.json'), JSON.stringify(facts, null, 1));
    assert.ok(stopped.confirmed, stopped.detail);
  }
});

test('provenance : A et B partagent le même manifeste, le fil de A affiche son déploiement d’origine sans proposer d’explications différentes', async () => {
  const { assembleManifest } = await import('@socrate/contract/assemble');
  const root = await mkdtemp(join(REPO_ROOT, '.tmp', 'provenance-'));
  const own = await rt.launchInstance({ root, name: 'provenance', ports: { service: 0, demo: CONTINUITY_A }, reset: false, deadline: deadlineIn(60_000) });
  const auto = await openBrowser();
  const facts: Record<string, unknown> = {};
  try {
    const originB = `http://127.0.0.1:${CONTINUITY_B}`;
    const ctx = await editorial(auto.newContext([own.view.demoOrigin, own.view.serviceUrl, originB]));
    const a = await ctx.context.newPage();
    await a.goto(`${own.view.demoOrigin}/`);
    await a.getByRole('button', { name: /Se connecter comme Claire Morel, relectrice produit/ }).click();
    await openPanel(a);
    const body = 'Commentaire publié sur A avant un déploiement B identique.';
    await panel(a).getByRole('textbox', { name: 'Votre commentaire global' }).fill(body);
    await panel(a).getByRole('button', { name: 'Publier' }).click();
    await panel(a).getByRole('status').filter({ hasText: 'Commentaire publié.' }).waitFor();
    const assembled = await assembleManifest(localPath('apps/demo/.socrate'));
    assert.ok(assembled.ok);
    const hostB = await own.addHost({ deploymentId: 'local-2', port: CONTINUITY_B, scene: 'b', manifest: assembled.manifest, deadline: deadlineIn(60_000) });
    const revisionA = (await own.service.db.prepare("SELECT revision_id FROM deployments WHERE deployment_id = 'local-1'").first<{ revision_id: string }>())!.revision_id;
    assert.equal(hostB.revisionId, revisionA, 'manifeste identique : A et B partagent la révision');
    const b = await ctx.context.newPage();
    await b.goto(`${originB}/`);
    const loginB = b.getByRole('button', { name: /Se connecter comme Claire Morel, relectrice produit/ });
    const agendaB = b.getByRole('heading', { level: 1, name: 'Agenda' });
    await loginB.or(agendaB).waitFor();
    if (await loginB.isVisible()) await loginB.click();
    await agendaB.waitFor();
    await openPanel(b);
    const t = panel(b).getByTestId('socrate-thread').filter({ hasText: body });
    const provenance = await t.getByTestId('socrate-provenance').innerText();
    facts.provenance = provenance;
    assert.equal(provenance.trim(), `Publié sur le déploiement local-1, révision d’origine ${revisionA.slice(0, 12)}.`, 'déploiement d’origine visible malgré la révision partagée');
    assert.equal(await t.getByRole('button', { name: 'Explications d’origine' }).count(), 0, 'même révision : pas d’explications « différentes » proposées');
    await b.screenshot({ path: join(ARTIFACTS, 'provenance-meme-revision.png') });
    Object.assign(facts, { revisionA, revisionB: hostB.revisionId });
    await ctx.context.close();
  } finally {
    await auto.close();
    const stopped = await own.stop('fin de la provenance');
    facts.arret = stopped;
    await writeFile(join(ARTIFACTS, 'provenance-faits.json'), JSON.stringify(facts, null, 1));
    assert.ok(stopped.confirmed, stopped.detail);
  }
});

test('wording depuis la liste et depuis la page (permission automatique Chromium, pas la preuve native) : mêmes propositions avec rattachement, doublons libres séparés, liste sans capture', async () => {
  const auto = await openBrowser({ autoAcceptTabCapture: true });
  try {
    const ctx = await editorial(auto.newContext(origins()));
    const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
    await page.getByRole('link', { name: 'Ouvrir le rendez-vous de 14 h 30' }).click();
    assert.match(await page.getByTestId('variante-sms').innerText(), /par SMS 24 heures avant/, 'rendu interpolé côté hôte');
    await openPanel(page);
    const p = panel(page);
    await p.getByRole('heading', { name: 'Textes à relire (2)' }).waitFor();
    await p.getByRole('button', { name: 'Ouvrir la revue des textes' }).click();
    const cards = p.getByTestId('socrate-wording');
    await cards.first().waitFor();
    assert.equal(await cards.count(), 2, 'seule la sélection éditoriale est listée, pas les autres textes de la page');
    const email = p.locator('[data-testid="socrate-wording"][data-wording="rappel-email"]');
    assert.equal(await email.getByTestId('socrate-wording-source').innerText(), 'Un rappel vous sera envoyé par e-mail {delai} avant le rendez-vous.');
    await email.getByText('Canal e-mail').waitFor();

    const listReplacement = 'Rappel par e-mail {delai} avant votre rendez-vous.';
    const capturesBefore = serviceOnly(ctx, (r) => /\/captures\/|\/targeted$/.test(path(r))).length;
    await email.getByRole('textbox', { name: /Remplacement proposé pour « Un rappel vous sera envoyé par e-mail/ }).fill(listReplacement);
    await email.getByRole('button', { name: 'Proposer' }).click();
    await email.getByText('Proposition publiée, sans capture.').waitFor();
    assert.equal(serviceOnly(ctx, (r) => /\/captures\/|\/targeted$/.test(path(r))).length, capturesBefore, 'aucune capture ni réservation depuis la liste');
    await email.getByTestId('socrate-wording-proposals').getByText(listReplacement).waitFor();

    const target = (testId: string) => targetElement(page, testId);

    await target('variante-email');
    const editor = p.getByTestId('socrate-page-proposal');
    assert.equal(await editor.getAttribute('data-wording'), 'rappel-email', 'rattachement explicite déclaré par l’hôte');
    await editor.getByText(listReplacement).waitFor();
    await page.screenshot({ path: join(ARTIFACTS, 'wording-page-retrouve-liste.png') });
    await editor.getByRole('button', { name: 'Proposer un remplacement' }).click();
    const pageReplacement = 'Vous recevrez un e-mail de rappel {delai} avant.';
    await editor.getByRole('textbox', { name: 'Remplacement proposé' }).fill(pageReplacement);
    await p.getByRole('button', { name: 'Publier le retour ciblé' }).click();
    await p.getByText('Retour ciblé publié avec son image.').waitFor();
    await email.getByTestId('socrate-wording-proposals').getByText(pageReplacement).waitFor();
    assert.equal(await email.getByTestId('socrate-wording-proposals').locator('li').count(), 2, 'la liste retrouve la proposition faite dans la page');
    const attached = await stack.service.db.prepare("SELECT p.original, p.wording_id, t.kind, c.state FROM proposals p JOIN threads t ON t.thread_id = p.thread_id LEFT JOIN captures c ON c.thread_id = p.thread_id WHERE p.replacement = ?").bind(pageReplacement).first<{ original: string; wording_id: string; kind: string; state: string | null }>();
    assert.deepEqual(attached, { original: 'Un rappel vous sera envoyé par e-mail {delai} avant le rendez-vous.', wording_id: 'rappel-email', kind: 'targeted', state: 'committed' });
    const fromList = await stack.service.db.prepare("SELECT t.kind, (SELECT COUNT(*) FROM captures c WHERE c.thread_id = p.thread_id) AS captures FROM proposals p JOIN threads t ON t.thread_id = p.thread_id WHERE p.replacement = ?").bind(listReplacement).first<{ kind: string; captures: number }>();
    assert.deepEqual(fromList, { kind: 'global', captures: 0 });

    for (const [testId, replacement] of [['occurrence-1', 'Rappel mis à jour'], ['occurrence-2', 'Rappel déplacé']] as const) {
      await target(testId);
      await p.getByTestId('socrate-free-text').getByText('« Rappel recalculé »').waitFor();
      assert.equal(await p.getByTestId('socrate-page-proposal').getAttribute('data-wording'), '', 'texte libre sans rattachement');
      assert.equal(await p.getByTestId('socrate-page-proposal').getByTestId('socrate-wording-proposals').count(), 0, 'aucune proposition fusionnée par égalité de texte');
      await p.getByTestId('socrate-page-proposal').getByRole('button', { name: 'Proposer un remplacement' }).click();
      await p.getByTestId('socrate-page-proposal').getByRole('textbox', { name: 'Remplacement proposé' }).fill(replacement);
      await p.locator('#socrate-targeted-draft').fill(`Occurrence ${testId}.`);
      await p.getByRole('button', { name: 'Publier le retour ciblé' }).click();
      await p.getByText('Retour ciblé publié avec son image.').waitFor();
    }
    const free = (await stack.service.db.prepare("SELECT p.thread_id, p.wording_id, p.original, c.state FROM proposals p JOIN captures c ON c.thread_id = p.thread_id WHERE p.original = 'Rappel recalculé'").all<{ thread_id: string; wording_id: string | null; original: string; state: string }>()).results;
    assert.equal(free.length, 2, 'deux occurrences, deux propositions');
    assert.ok(free.every((r) => r.wording_id === null && r.state === 'committed'), 'aucune clé inventée, capture conservée');
    const thread = p.getByTestId('socrate-thread').filter({ hasText: 'Occurrence occurrence-2.' });
    await thread.getByTestId('socrate-proposal').getByText('Texte libre, sans clé de traduction', { exact: false }).waitFor();
    await page.screenshot({ path: join(ARTIFACTS, 'wording-texte-libre-publie.png') });
    assert.deepEqual(ctx.blocked, [], 'aucune requête hors des origines de l’instance');
    await ctx.context.close();
  } finally {
    await auto.close();
  }
});

test('wording : décalage après une révision suivante et sélection vide (lectures réelles de l’API servies au panneau par le banc)', async () => {
  const api = `${stack.view.serviceUrl}/v1/projects/demo/reviews/rappels-automatiques`;
  const read = async (p: string) => {
    const r = await fetch(`${api}${p}`, { headers: { Authorization: `Bearer ${stack.credentials.agent}` } });
    assert.equal(r.status, 200, `${p} : HTTP ${r.status}`);
    return r.json() as Promise<any>;
  };
  const local1 = await read('/deployments/local-1');
  assert.ok(local1.revision.manifest.wordings?.length, 'le test précédent a publié sur une révision avec sélection');
  const next = structuredClone(local1.revision.manifest);
  const changedSource = 'Vous recevrez un e-mail de rappel {delai} avant le rendez-vous.';
  next.wordings.find((w: any) => w.id === 'rappel-email').source = changedSource;
  const imported = await fetch(`${api}/deployments/local-2`, {
    method: 'PUT', headers: { Authorization: `Bearer ${stack.credentials.import}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ commit: 'b2c3d4e5f6a7', buildId: '2', url: `${stack.view.demoOrigin}/`, manifest: next }),
  });
  assert.equal(imported.status, 201, 'révision suivante importée');
  // Toute la suite écrit dans cette revue : le parcours suit le snapshot page à page, et le panneau reçoit la liste entière.
  const first = await read('/threads');
  const items = [...first.items];
  for (let cursor = first.nextCursor; cursor; ) {
    const more = await read(`/threads?cursor=${cursor}`);
    items.push(...more.items);
    cursor = more.nextCursor;
  }
  assert.equal(items.length, first.total, 'snapshot parcouru jusqu’à la dernière page');
  const agentView = { ...first, items, nextCursor: null };
  const drifted = items.filter((t: any) => t.proposal?.wording?.id === 'rappel-email');
  assert.deepEqual(drifted.map((t: any) => t.proposal.replacement).sort(), ['Rappel par e-mail {delai} avant votre rendez-vous.', 'Vous recevrez un e-mail de rappel {delai} avant.'], 'les deux propositions du scénario précédent');
  assert.ok(drifted.every((t: any) => t.proposal.drift.status === 'changed' && t.proposal.original !== changedSource), 'API agent : décalage signalé, original intact');

  const ctx = await editorial(browser.newContext(origins()));
  ctx.setFaults((r) => (r.method === 'GET' && path(r).endsWith('/threads') ? { kind: 'respond', status: 200, body: agentView } : { kind: 'pass' }));
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await page.getByRole('link', { name: 'Ouvrir le rendez-vous de 14 h 30' }).click();
  await openPanel(page);
  const p = panel(page);
  await p.getByRole('button', { name: 'Ouvrir la revue des textes' }).click();
  const email = p.locator('[data-testid="socrate-wording"][data-wording="rappel-email"]');
  await email.getByTestId('socrate-drift').first().waitFor();
  assert.match(await email.getByTestId('socrate-drift').first().innerText(), /Vous recevrez un e-mail de rappel \{delai\} avant le rendez-vous\..*L’original de la proposition est conservé/s);
  assert.match(await email.getByTestId('socrate-proposal').first().innerText(), /Original « Un rappel vous sera envoyé par e-mail \{delai\} avant le rendez-vous\. »/);
  await email.getByTestId('socrate-drift').first().scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(ARTIFACTS, 'wording-decalage-relectrice.png') });
  await ctx.context.close();

  const empty = structuredClone(local1);
  delete empty.revision.manifest.wordings;
  const ctx2 = await editorial(browser.newContext(origins()));
  ctx2.setFaults((r) => (r.method === 'GET' && path(r).endsWith('/deployments/local-1') ? { kind: 'respond', status: 200, body: empty } : { kind: 'pass' }));
  const page2 = await loginAs(ctx2, 'Claire Morel, relectrice produit');
  await openPanel(page2);
  const p2 = panel(page2);
  await p2.getByRole('heading', { name: 'Textes à relire (0)' }).waitFor();
  await p2.getByTestId('socrate-wordings-empty').waitFor();
  assert.equal(await p2.getByRole('button', { name: 'Ouvrir la revue des textes' }).count(), 0);
  assert.equal(await p2.getByRole('alert').count(), 0, 'aucune erreur');
  await p2.getByRole('textbox', { name: 'Votre commentaire global' }).fill('Sélection vide : le commentaire libre reste possible.');
  await p2.getByRole('button', { name: 'Publier' }).click();
  await p2.getByRole('status').filter({ hasText: 'Commentaire publié.' }).waitFor();
  assert.equal(await messagesNamed('Sélection vide : le commentaire libre reste possible.'), 1);
  await page2.screenshot({ path: join(ARTIFACTS, 'wording-selection-vide.png') });
  assert.deepEqual([...ctx.blocked, ...ctx2.blocked], [], 'aucune requête hors des origines de l’instance');
  await ctx2.context.close();
});

test('wording : remplacement possédé par le brouillon, révision observée figée (permission automatique Chromium, assertion hôte signée sur une révision suivante par le banc)', async () => {
  const api = `${stack.view.serviceUrl}/v1/projects/demo/reviews/rappels-automatiques`;
  const local1 = await (await fetch(`${api}/deployments/local-1`, { headers: { Authorization: `Bearer ${stack.credentials.agent}` } })).json() as any;
  const sourceA = local1.revision.manifest.wordings.find((w: any) => w.id === 'rappel-email').source as string;
  const next = structuredClone(local1.revision.manifest);
  next.wordings.find((w: any) => w.id === 'rappel-email').source = 'Formulation B {delai} avant le rendez-vous.';
  const importedB = await fetch(`${api}/deployments/local-3`, {
    method: 'PUT', headers: { Authorization: `Bearer ${stack.credentials.import}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ commit: 'c3d4e5f6a7b8', buildId: '3', url: `${stack.view.demoOrigin}/`, manifest: next }),
  });
  assert.equal(importedB.status, 201, 'révision B importée');
  const privateJwk = JSON.parse(await readFile(join(stack.view.root, 'keys/issuer-private.jwk.json'), 'utf8'));
  const preview = JSON.parse(await readFile(join(stack.view.root, 'preview-context.json'), 'utf8'));
  const assertionB = () => signAssertion(privateJwk, {
    issuer: preview.issuer, audience: preview.audience, sub: 'claire', name: 'Claire Morel', projectId: 'demo', reviewKey: 'rappels-automatiques',
    deploymentId: 'local-3', origin: stack.view.demoOrigin, capabilities: ['thread.participate'],
  });
  const proposalsOf = async (replacement: string) => (await stack.service.db.prepare('SELECT p.original, p.source_revision_id, t.deployment_id FROM proposals p JOIN threads t ON t.thread_id = p.thread_id WHERE p.replacement = ?')
    .bind(replacement).all<{ original: string; source_revision_id: string; deployment_id: string }>()).results;
  const isCommit = (r: SeenRequest) => r.method === 'POST' && path(r).endsWith('/commit');

  const auto = await openBrowser({ autoAcceptTabCapture: true });
  let release = () => {};
  try {
    const ctx = await editorial(auto.newContext(origins()));
    const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
    await page.getByRole('link', { name: 'Ouvrir le rendez-vous de 14 h 30' }).click();
    await openPanel(page);
    const p = panel(page);
    const editor = p.getByTestId('socrate-page-proposal');
    const replacementBox = editor.getByRole('textbox', { name: 'Remplacement proposé', exact: true });
    const comment = p.locator('#socrate-targeted-draft');
    const publishTargeted = p.getByRole('button', { name: 'Publier le retour ciblé' });

    await targetElement(page, 'variante-email');
    await editor.getByRole('button', { name: 'Proposer un remplacement' }).click();
    await replacementBox.fill('Brouillon à conserver après arrêt');
    await comment.fill('Le commentaire témoin reste présent');
    await p.getByRole('button', { name: 'Arrêter le partage', exact: true }).click();
    await p.getByTestId('socrate-capture-status').filter({ hasText: 'Partage arrêté' }).waitFor();
    await p.getByTestId('socrate-kept-replacement').getByText('ciblez à nouveau puis rattachez-le pour le publier', { exact: false }).waitFor();
    assert.equal(await replacementBox.inputValue(), 'Brouillon à conserver après arrêt', 'remplacement conservé à l’arrêt du partage');
    assert.equal(await comment.inputValue(), 'Le commentaire témoin reste présent');
    await page.screenshot({ path: join(ARTIFACTS, 'wording-remplacement-apres-arret.png') });

    await targetElement(page, 'occurrence-1');
    await p.getByTestId('socrate-kept-replacement').getByText('pas pour ce ciblage', { exact: false }).waitFor();
    assert.ok(await publishTargeted.isDisabled(), 'un remplacement non rattaché au ciblage courant bloque la publication');
    await page.screenshot({ path: join(ARTIFACTS, 'wording-remplacement-autre-element.png') });
    await targetElement(page, 'variante-email');
    await p.getByTestId('socrate-kept-replacement').getByText('pas pour ce ciblage', { exact: false }).waitFor();
    assert.ok(await publishTargeted.isDisabled(), 'même au retour sur l’élément d’origine, le rattachement reste explicite');
    await p.getByTestId('socrate-kept-replacement').getByRole('button', { name: 'Rattacher à l’élément ciblé' }).click();
    assert.equal(await p.getByTestId('socrate-kept-replacement').count(), 0);
    assert.equal(await replacementBox.inputValue(), 'Brouillon à conserver après arrêt');
    await p.getByRole('button', { name: 'Publier le retour ciblé', disabled: false }).waitFor({ timeout: 5_000 });

    loseOnce(ctx, isCommit);
    await publishTargeted.click();
    await p.getByTestId('socrate-pending-targeted').waitFor();
    await replacementBox.fill('Nouvelle version après réponse perdue');
    await p.getByRole('alert').getByRole('button', { name: 'Réessayer', exact: true }).click();
    await p.getByText('Votre retour ciblé précédent est publié. Le brouillon en cours est conservé.').waitFor();
    assert.deepEqual(await proposalsOf('Brouillon à conserver après arrêt'), [{ original: sourceA, source_revision_id: local1.revision.revisionId, deployment_id: 'local-1' }], 'charge initiale publiée une fois');
    assert.deepEqual(await proposalsOf('Nouvelle version après réponse perdue'), [], 'la version éditée n’est pas publiée');
    assert.equal(await replacementBox.inputValue(), 'Nouvelle version après réponse perdue', 'la version éditée reste en brouillon');
    await page.screenshot({ path: join(ARTIFACTS, 'wording-remplacement-apres-reprise.png') });

    await p.getByRole('button', { name: 'Annuler le brouillon' }).click();
    assert.equal(await p.getByTestId('socrate-page-proposal').count(), 0);
    await targetElement(page, 'variante-email');
    await editor.getByRole('button', { name: 'Proposer un remplacement' }).click();
    await replacementBox.fill('Remplacement seul');
    loseOnce(ctx, isCommit);
    await publishTargeted.click();
    await p.getByTestId('socrate-pending-targeted').waitFor();
    await editor.getByRole('button', { name: 'Retirer la proposition' }).click();
    await p.getByTestId('socrate-pending-targeted').getByRole('button', { name: 'Abandonner la reprise' }).click();
    assert.equal(await replacementBox.inputValue(), 'Remplacement seul', 'l’abandon rend le remplacement à son champ');
    assert.equal(await comment.inputValue(), '', 'le remplacement ne devient pas un commentaire');
    await p.getByRole('button', { name: 'Annuler le brouillon' }).click();

    await targetElement(page, 'variante-email');
    await editor.getByRole('button', { name: 'Proposer un remplacement' }).click();
    await replacementBox.fill('Ma proposition rédigée sur A');
    let rotated = false;
    let signalHeld = () => {};
    const held = new Promise<void>((r) => (signalHeld = r));
    const until = new Promise<void>((r) => (release = r));
    let holding = true;
    ctx.setFaults((r) => {
      if (holding && isCommit(r)) {
        holding = false;
        signalHeld();
        return { kind: 'hold', until };
      }
      if (rotated && path(r) === '/api/socrate/assertion') return { kind: 'respond', status: 200, body: { assertion: assertionB() } };
      return { kind: 'pass' };
    });
    await publishTargeted.click();
    await held;
    await expireSessions();
    rotated = true;
    release();
    await p.getByRole('alert').filter({ hasText: 'rien n’est publié, rechargez la page' }).waitFor();
    assert.equal(await p.getByRole('alert').filter({ hasText: 'corrigez le texte' }).count(), 0, 'le refus de révision demande de recharger, pas de corriger le texte');
    assert.deepEqual(await proposalsOf('Ma proposition rédigée sur A'), [], 'aucun original de B pour une proposition rédigée sur A');
    assert.equal(await replacementBox.inputValue(), 'Ma proposition rédigée sur A', 'brouillon conservé après le refus');
    const session = await stack.service.db.prepare('SELECT deployment_id FROM sessions ORDER BY issued_at DESC, rowid DESC LIMIT 1').first<{ deployment_id: string }>();
    assert.equal(session?.deployment_id, 'local-3', 'la session renouvelée est bien sur la révision B');
    await page.screenshot({ path: join(ARTIFACTS, 'wording-revision-changee-refus.png') });

    await p.getByRole('button', { name: 'Ouvrir la revue des textes' }).click();
    const card = p.locator('[data-testid="socrate-wording"][data-wording="rappel-email"]');
    const listBox = card.getByRole('textbox', { name: /Remplacement proposé pour/ });
    await listBox.fill('Proposition de liste après renouvellement');
    await card.getByRole('button', { name: 'Proposer' }).click();
    await card.getByRole('alert').filter({ hasText: 'rien n’est publié' }).waitFor();
    assert.equal(await card.getByRole('alert').filter({ hasText: 'corrigez le texte' }).count(), 0, 'même invitation à recharger depuis la liste');
    assert.deepEqual(await proposalsOf('Proposition de liste après renouvellement'), [], 'première émission de la liste après renouvellement refusée');
    assert.equal(await listBox.inputValue(), 'Proposition de liste après renouvellement');
    assert.deepEqual(ctx.blocked, [], 'aucune requête hors des origines de l’instance');
    await ctx.context.close();

    const ctx2 = await editorial(auto.newContext(origins()));
    const page2 = await loginAs(ctx2, 'Claire Morel, relectrice produit');
    await page2.getByRole('link', { name: 'Ouvrir le rendez-vous de 14 h 30' }).click();
    await openPanel(page2);
    const p2 = panel(page2);
    await targetElement(page2, 'variante-email');
    await p2.getByTestId('socrate-page-proposal').getByRole('button', { name: 'Proposer un remplacement' }).click();
    await p2.getByTestId('socrate-page-proposal').getByRole('textbox', { name: 'Remplacement proposé', exact: true }).fill('Déjà écrit sur A');
    let rotated2 = false;
    let lost = false;
    ctx2.setFaults((r) => {
      if (!lost && isCommit(r)) {
        lost = true;
        return { kind: 'lose-response' };
      }
      if (rotated2 && path(r) === '/api/socrate/assertion') return { kind: 'respond', status: 200, body: { assertion: assertionB() } };
      return { kind: 'pass' };
    });
    await p2.getByRole('button', { name: 'Publier le retour ciblé' }).click();
    await p2.getByTestId('socrate-pending-targeted').waitFor();
    await expireSessions();
    rotated2 = true;
    await p2.getByRole('alert').getByRole('button', { name: 'Réessayer', exact: true }).click();
    await p2.getByText('Retour ciblé publié avec son image.').waitFor();
    assert.deepEqual(await proposalsOf('Déjà écrit sur A'), [{ original: sourceA, source_revision_id: local1.revision.revisionId, deployment_id: 'local-1' }], 'succès déjà écrit sur A reconnu sous la session B, une seule écriture');
    assert.deepEqual(ctx2.blocked, []);
    await ctx2.context.close();
  } finally {
    release();
    await auto.close();
  }
});
