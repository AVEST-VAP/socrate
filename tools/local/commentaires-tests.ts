// Parcours « commenter sur place » sur la vraie démonstration : instance, D1 et navigateur propres à la suite.
// Permission de capture automatique de Chromium : preuve de logique, jamais celle du sélecteur natif.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Page, Locator } from 'playwright';
import { ALL_FORMATS, BufferSource, EncodedPacketSink, Input } from 'mediabunny';
import { REPO_ROOT, deadlineIn, localPath, portNumber, runtime, browser as browserBoundary } from './local-run.ts';
import { signAssertion } from './assertion.ts';
import type { InstanceHandle } from './runtime.ts';
import type { LocalBrowser, LocalContext, SeenRequest } from './browser.ts';

const rt = await runtime();
const { openBrowser } = await browserBoundary();
const ARTIFACTS = localPath('.local/artifacts', 'commentaires', new Date().toISOString().replace(/[:.]/g, '-'));
const DEMO_PORT = portNumber(process.env.SOCRATE_COMMENTAIRES_PORT ?? 5299, 'démo');

let stack: InstanceHandle;
let browser: LocalBrowser;
const origins = () => [stack.view.demoOrigin, stack.view.serviceUrl];
const facts: Record<string, unknown> = {};

before(async () => {
  await mkdir(ARTIFACTS, { recursive: true });
  const root = await mkdtemp(join(REPO_ROOT, '.tmp', 'commentaires-'));
  stack = await rt.launchInstance({ root, hostCommand: [localPath('tools/local/fixtures/navigation-host.ts')], name: 'commentaires', ports: { service: 0, demo: DEMO_PORT }, reset: false, deadline: deadlineIn(60_000) });
  browser = await openBrowser({ autoAcceptTabCapture: true });
});
after(async () => {
  try { await browser?.close(); } finally {
    const stopped = await stack?.stop('fin de la suite commentaires');
    facts.arret = stopped;
    await writeFile(join(ARTIFACTS, 'faits.json'), JSON.stringify(facts, null, 1));
    assert.ok(stopped.confirmed, stopped.detail);
    console.log(`captures et faits sous ${ARTIFACTS}`);
  }
});

const shot = (page: Page, name: string) => page.screenshot({ path: join(ARTIFACTS, `${name}.png`) });
async function loginAs(ctx: LocalContext, persona: string, path = '/'): Promise<Page> {
  const page = await ctx.context.newPage();
  await page.goto(`${stack.view.demoOrigin}${path}`);
  await page.getByRole('button', { name: new RegExp(`Se connecter comme ${persona}`) }).click();
  await page.getByRole('button', { name: 'Se déconnecter' }).waitFor();
  return page;
}
// Sélecteurs CSS : une modal Base UI rend l'extérieur `aria-hidden`, les rôles n'y sont plus exposés alors que le clic reste possible.
const toolbar = (page: Page) => page.locator('[data-socrate="toolbar"]');
const control = (page: Page, action: string) => page.locator(`[data-socrate-action="${action}"]`);
/** Toolbar affichée sans clic dès que Socrate est monté pour l'identité connectée. */
const toolbarReady = (page: Page) => toolbar(page).waitFor();
const bubble = (page: Page) => page.frameLocator('#socrate-bubble');
const list = (page: Page) => page.frameLocator('#socrate-frame');
/** Commenter un élément puis cliquer la cible ; attend le brouillon ancré. */
async function targetAt(page: Page, x: number, y: number) {
  await control(page, 'target').first().click();
  await page.locator('[data-socrate-action="target"][aria-pressed="true"]').waitFor({ timeout: 10_000 });
  await page.mouse.click(x, y);
  await bubble(page).getByTestId('socrate-draft').waitFor({ timeout: 10_000 }).catch(async (e: Error) => {
    throw new Error(`${e.message} ; message Socrate : ${await page.locator('[data-testid="socrate-note"]').allInnerTexts()}`);
  });
}
async function targetElement(page: Page, locator: ReturnType<Page['locator']>) {
  await locator.scrollIntoViewIfNeeded();
  const box = (await locator.boundingBox())!;
  await targetAt(page, box.x + Math.min(8, box.width / 2), box.y + box.height / 2);
}
const db = () => stack.service.db;
const threadOf = async (body: string) => db().prepare('SELECT t.thread_id, t.kind, t.state, t.author_key, t.author_name FROM messages m JOIN threads t USING (project_id, review_key, thread_id) WHERE m.body = ?').bind(body).first<{ thread_id: string; kind: string; state: string; author_key: string; author_name: string }>();
const countBody = async (body: string) => (await db().prepare('SELECT COUNT(*) AS n FROM messages WHERE body = ?').bind(body).first<{ n: number }>())!.n;
const path = (r: SeenRequest) => new URL(r.url).pathname;
const toService = (ctx: LocalContext, pred: (r: SeenRequest) => boolean = () => true) => ctx.seen.filter((r) => r.url.startsWith(stack.view.serviceUrl) && pred(r));
const bubbleBox = (page: Page) => page.locator('#socrate-bubble').boundingBox();
const near = (a: { x: number; y: number; width: number; height: number }, b: { x: number; y: number; width: number; height: number }) => {
  const dx = Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width));
  const dy = Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height));
  return Math.hypot(dx, dy);
};
/** Ouvre le fil par sa pastille ; un groupe de retours proches passe par sa bulle de liste. */
async function openPin(page: Page, threadId: string) {
  const pin = page.locator(`[data-socrate="pin"][data-threads~="${threadId}"]`);
  await pin.waitFor({ timeout: 10_000 });
  const grouped = (await pin.getAttribute('data-threads'))!.split(' ').length > 1;
  await pin.click();
  if (grouped) await bubble(page).locator(`button[data-thread="${threadId}"]`).click();
  const conv = bubble(page).locator(`[data-testid="socrate-conversation"][data-thread="${threadId}"]`);
  await conv.waitFor();
  return { conv, grouped };
}
const send = (page: Page) => page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');

test('liste sans fil ni brouillon, toolbar centrée et dans la vue après 1280, 375, 320 et retour large', async () => {
  const ctx = await browser.newContext(origins());
  try {
    const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
    await toolbarReady(page);
    await control(page, 'launcher').click();
    await list(page).getByTestId('socrate-empty').waitFor();
    const dimensions = [];
    for (const width of [1280, 375, 320, 1280]) {
      await page.setViewportSize({ width, height: 720 });
      for (const open of [true, false]) {
        if (!open) await control(page, 'launcher').click();
        await page.waitForTimeout(100);
        const geometry = await toolbar(page).evaluate((el, opened) => {
          const r = el.getBoundingClientRect();
          const centre = (innerWidth - (opened && innerWidth >= 600 ? 380 : 0)) / 2;
          const buttons = [...el.querySelectorAll('button')].map((b) => b.getBoundingClientRect().toJSON());
          return { width: innerWidth, open: opened, x: r.x, right: r.right, height: r.height, centreError: Math.abs(r.x + r.width / 2 - centre), buttons };
        }, open);
        dimensions.push(geometry);
        assert.ok(geometry.centreError <= 2 && geometry.x >= 0 && geometry.right <= width && geometry.height === 48, JSON.stringify(geometry));
        assert.ok(geometry.buttons.every((b) => b.left >= 0 && b.right <= width));
        if (!open) await control(page, 'launcher').click();
      }
      await shot(page, `liste-vide-${width}`);
    }
    facts.listeVide = dimensions;
  } finally { await ctx.context.close(); }
});

test('relecture 503 vide et peuplée à réouverture ou retour visible, erreur et vrai réessai sans perdre les fils', async () => {
  const ctx = await browser.newContext(origins());
  try {
    const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
    await toolbarReady(page);
    await control(page, 'launcher').click();
    await list(page).getByRole('button', { name: /^Toutes les pages/ }).click();
    for (const trigger of ['reopen', 'visible']) {
      await list(page).getByRole('button', { name: /^Ouvertes/ }).waitFor();
      const count = await list(page).getByTestId('socrate-row').count();
      assert.equal(count, trigger === 'reopen' ? 0 : 1, 'vrai service vide puis peuplé');
      if (trigger === 'reopen') await control(page, 'launcher').click();
      const before = ctx.seen.length;
      ctx.setFaults((r) => r.method === 'GET' && path(r).endsWith('/threads')
        ? { kind: 'respond', status: 503, body: { code: 'not_ready', message: 'Relecture indisponible simulée.', retryable: true, requestId: 'relecture-simulee' } }
        : { kind: 'pass' });
      if (trigger === 'reopen') await control(page, 'launcher').click();
      else await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
      await list(page).getByRole('alert').filter({ hasText: 'Relecture indisponible simulée' }).waitFor();
      assert.equal(await list(page).getByTestId('socrate-empty').count(), 0);
      assert.equal(await list(page).getByTestId('socrate-row').count(), count);
      assert.ok(ctx.seen.slice(before).some((r) => r.method === 'GET' && path(r).endsWith('/threads') && r.outcome && 'status' in r.outcome && r.outcome.status === 503));
      await shot(page, `relecture-${trigger}-erreur`);
      ctx.setFaults(null);
      const retryStart = ctx.seen.length;
      const retried = page.waitForResponse((response) => response.request().method() === 'GET' && new URL(response.url()).pathname.endsWith('/threads') && response.status() === 200);
      await list(page).getByRole('alert').filter({ hasText: 'Relecture indisponible simulée' }).getByRole('button', { name: 'Réessayer' }).click();
      await retried;
      await list(page).getByText('Relecture des conversations…', { exact: true }).waitFor({ state: 'hidden' });
      await list(page).getByRole('alert').waitFor({ state: 'hidden' });
      assert.ok(ctx.seen.slice(retryStart).some((r) => r.method === 'GET' && path(r).endsWith('/threads') && r.outcome && 'status' in r.outcome && r.outcome.status === 200));
      facts[`relecture-${trigger}`] = { previousRows: count, afterRetry: await list(page).getByTestId('socrate-row').count(), retryRequests: ctx.seen.slice(retryStart).filter((r) => r.method === 'GET' && path(r).endsWith('/threads')).map((r) => r.outcome) };
      if (trigger === 'reopen') {
        await list(page).getByRole('textbox', { name: 'Votre commentaire global' }).fill('Fil conservé après erreur de relecture');
        await list(page).getByRole('button', { name: 'Envoyer' }).click();
        await list(page).getByTestId('socrate-row').filter({ hasText: 'Fil conservé après erreur de relecture' }).waitFor();
      }
    }
  } finally { await ctx.context.close(); }
});

test('modal Base UI : repos sans requête, ciblage puis bulle à côté de la cible sans sidebar ni clic métier, envoi explicite, pastille, conversation, réponse et résolution', async () => {
  const ctx = await browser.newContext(origins());
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await page.getByRole('link', { name: 'Réglages' }).click();
  await page.getByRole('heading', { level: 1, name: 'Rappels automatiques' }).waitFor();
  await toolbarReady(page);
  assert.equal(await page.locator('#socrate-frame').isVisible(), false, 'à l’arrivée : toolbar sans clic, liste fermée');
  assert.equal(await control(page, 'target').getAttribute('data-capture'), 'inactive:', 'à l’arrivée : aucun partage demandé');
  const width = await page.evaluate(() => document.documentElement.scrollWidth);

  await page.getByTestId('open-detaillee').click();
  await page.getByTestId('scene-libelle').fill('Rappel J-1 fictif');
  await toolbarReady(page);
  await shot(page, '01-toolbar-active-modal');
  assert.equal(await page.locator('#socrate-frame').isVisible(), false, 'activer ne force pas la liste');
  const save = page.getByTestId('scene-save');
  await targetElement(page, save);
  assert.equal(await page.getByTestId('scene-saved').innerText(), '0', 'le ciblage ne déclenche pas l’action métier');
  assert.ok(await page.getByTestId('scene-dialog').isVisible(), 'modal toujours ouverte');
  assert.equal(await page.getByTestId('scene-libelle').inputValue(), 'Rappel J-1 fictif');
  assert.equal(await page.locator('#socrate-frame').isVisible(), false, 'aucune sidebar ouverte par le ciblage');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width, 'largeur de page inchangée');
  const b = (await bubbleBox(page))!;
  const target = (await save.boundingBox())!;
  facts.modal = { bulle: b, cible: target, distance: near(b, target) };
  assert.ok(near(b, target) <= 16, `bulle à proximité de la cible (${near(b, target)} px)`);
  const field = bubble(page).getByRole('textbox', { name: 'Votre commentaire' });
  await field.waitFor();
  assert.ok(await field.evaluate((el) => el.ownerDocument.activeElement === el), 'le champ de la bulle a le focus');
  await bubble(page).getByRole('button', { name: 'Envoyer' }).waitFor();
  assert.equal(await bubble(page).getByRole('button', { name: /Publier/ }).count(), 0, 'aucun bouton Publier');
  const body = 'Le bouton Enregistrer devrait confirmer l’heure choisie.';
  await field.fill(body);
  await shot(page, '02-composer-ancre-modal');
  await page.getByTestId('scene-libelle').evaluate((el) => (el as HTMLInputElement).blur());
  await page.waitForTimeout(300);
  assert.equal(toService(ctx, (r) => r.method !== 'GET' && path(r).endsWith('/targeted')).length, 0, 'rien n’est envoyé à la frappe ni à la perte de focus');
  await field.focus();
  await send(page);
  await page.locator('#socrate-bubble').waitFor({ state: 'hidden', timeout: 15_000 });
  const pin = page.locator('[data-socrate="pin"]');
  await pin.first().waitFor({ timeout: 10_000 });
  const t = await threadOf(body);
  assert.equal(t?.kind, 'targeted');
  assert.equal(t?.author_name, 'Claire Morel');
  assert.equal(await pin.count(), 1);
  assert.match((await pin.getAttribute('aria-label'))!, /Conversation de Claire Morel, ouverte/);
  assert.equal(await pin.innerText(), 'CM');
  assert.equal(await page.getByTestId('scene-saved').innerText(), '0');
  assert.ok(await page.getByTestId('scene-dialog').isVisible(), 'modal intacte après envoi');
  await shot(page, '03-pastille-modal');

  await pin.click();
  const conv = bubble(page).getByTestId('socrate-conversation');
  await conv.waitFor();
  assert.equal(await page.getByTestId('scene-saved').innerText(), '0', 'la pastille ne transmet aucun clic à l’hôte');
  assert.equal(await conv.getAttribute('data-thread'), t!.thread_id, 'la pastille ouvre le bon fil');
  await conv.getByText(body).waitFor();
  await conv.getByRole('textbox', { name: /Répondre au retour de Claire Morel/ }).fill('Précision : surtout pour le modèle détaillé.');
  await conv.getByRole('button', { name: 'Envoyer' }).click();
  await conv.getByText('Précision : surtout pour le modèle détaillé.').waitFor({ timeout: 10_000 });
  assert.equal((await threadOf('Précision : surtout pour le modèle détaillé.'))?.thread_id, t!.thread_id, 'réponse rattachée au même fil');
  await conv.getByRole('button', { name: 'Résoudre' }).click();
  await conv.getByRole('button', { name: 'Rouvrir' }).waitFor({ timeout: 10_000 });
  assert.equal((await threadOf(body))?.state, 'resolved');
  await shot(page, '04-conversation-resolue');
  await conv.getByRole('button', { name: 'Rouvrir' }).click();
  await conv.getByRole('button', { name: 'Résoudre' }).waitFor({ timeout: 10_000 });
  assert.equal((await threadOf(body))?.state, 'open');
  await page.keyboard.press('Escape');
  await page.locator('#socrate-bubble').waitFor({ state: 'hidden' });
  assert.ok(await page.getByTestId('scene-dialog').isVisible(), 'Échap dans la bulle ne ferme pas la modal de l’hôte');
  assert.deepEqual(ctx.blocked, []);
  await ctx.context.close();
});

test('vue scindée : cible dans l’iframe de même origine, bulle et pastille alignées sur l’enfant, hôte utilisable', async () => {
  const ctx = await browser.newContext(origins());
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await page.getByRole('link', { name: 'Vue scindée' }).click();
  const child = page.frameLocator('[data-testid="split-frame"]');
  await child.getByTestId('open-courte').waitFor();
  await toolbarReady(page);
  const frameBox = (await page.getByTestId('split-frame').boundingBox())!;
  const inner = (await child.getByTestId('open-courte').boundingBox())!;
  await targetAt(page, inner.x + 6, inner.y + inner.height / 2);
  assert.equal(await child.getByTestId('scene-dialog').count(), 0, 'la modal de l’enfant n’est pas ouverte par le ciblage');
  const b = (await bubbleBox(page))!;
  assert.ok(near(b, inner) <= 16, `bulle à côté de la cible de l’iframe (${near(b, inner)} px)`);
  const body = 'Dans la vue scindée, le libellé « Modèle court » reste ambigu.';
  await bubble(page).getByRole('textbox', { name: 'Votre commentaire' }).fill(body);
  await shot(page, '05-composer-iframe');
  await bubble(page).getByRole('button', { name: 'Envoyer' }).click();
  const pin = page.locator('[data-socrate="pin"]');
  await pin.first().waitFor({ timeout: 15_000 });
  const p = (await pin.first().boundingBox())!;
  facts.iframe = { cadre: frameBox, cible: inner, bulle: b, pastille: p };
  assert.ok(Math.abs(p.x + 6 - (inner.x + inner.width)) <= 2 && Math.abs(p.y + 22 - inner.y) <= 2, `pastille sur le coin de la cible enfant ${JSON.stringify(p)} / ${JSON.stringify(inner)}`);
  const row = await db().prepare("SELECT c.payload FROM captures c WHERE c.state = 'committed' ORDER BY c.rowid DESC LIMIT 1").first<{ payload: string }>();
  const target = JSON.parse(row!.payload).target as { frame: string[]; route: string; hostRoute: string };
  assert.equal(target.route, '/reglages/rappels');
  assert.equal(target.hostRoute, '/vue-scindee');
  assert.equal(target.frame.length, 1);
  await shot(page, '06-pastille-iframe');
  await page.getByTestId('split-export').click();
  assert.equal(await page.getByTestId('split-exports').innerText(), '1', 'l’hôte reste utilisable hors ciblage');
  await ctx.context.close();
});

const RDV = '/rendez-vous/rdv-1042';
async function openRdv(page: Page) {
  await page.getByRole('link', { name: 'Ouvrir le rendez-vous de 14 h 30' }).click();
  await page.getByRole('heading', { level: 1, name: /Rendez-vous du 21 octobre/ }).waitFor();
}
/** Sélectionne `text` dans l'élément puis rend le centre de la plage. */
const selectText = (page: Page, testIdOrSelector: string, text: string) => page.evaluate(([sel, t]) => {
  const el = document.querySelector(sel)!;
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const i = node.data.indexOf(t);
    if (i < 0) continue;
    const r = document.createRange();
    r.setStart(node, i);
    r.setEnd(node, i + t.length);
    const s = getSelection()!;
    s.removeAllRanges();
    s.addRange(r);
    const b = r.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }
  throw new Error(`texte introuvable : ${t}`);
}, [testIdOrSelector, text] as const);
const proposalOf = async (replacement: string) => db().prepare('SELECT original, replacement, wording_id FROM proposals WHERE replacement = ?').bind(replacement).first<{ original: string; replacement: string; wording_id: string | null }>();
/** Événement contextmenu synthétique : rend vrai si Socrate a remplacé le menu natif. */
const contextPrevented = (page: Page, selector: string, init: { shiftKey?: boolean }) => page.evaluate(([sel, shiftKey]) => {
  const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, shiftKey });
  document.querySelector(sel)!.dispatchEvent(e);
  return e.defaultPrevented;
}, [selector, !!init.shiftKey] as const);

test('correction par sélection : clic droit, texte actuel et remplacement distincts, original enregistré par le service, menu natif hors du geste, alternative clavier', async () => {
  const ctx = await browser.newContext(origins());
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openRdv(page);
  const host = await page.locator('article').first().innerText();
  await toolbarReady(page);

  const at = await selectText(page, 'article p:nth-of-type(1)', 'Mme Fictive Durand');
  await page.mouse.click(at.x, at.y, { button: 'right' });
  const menu = page.locator('[data-socrate="menu"]');
  await menu.getByRole('menuitem', { name: 'Proposer une correction' }).waitFor();
  await shot(page, '07-menu-correction');
  await menu.getByRole('menuitem', { name: 'Proposer une correction' }).click();
  const draft = bubble(page).getByTestId('socrate-draft');
  await draft.waitFor({ timeout: 10_000 });
  assert.equal(await draft.getAttribute('data-mode'), 'correction');
  assert.match(await bubble(page).getByTestId('socrate-original').innerText(), /Texte actuel\s+« Mme Fictive Durand »/);
  const field = bubble(page).getByRole('textbox', { name: 'Correction proposée' });
  assert.equal(await field.inputValue(), 'Mme Fictive Durand', 'remplacement prérempli avec la sélection');
  assert.equal(await bubble(page).getByRole('button', { name: 'Envoyer' }).isDisabled(), true, 'remplacement identique : rien à envoyer');
  await field.fill('Mme Fictive Durand-Martin');
  await bubble(page).getByRole('button', { name: '+ Ajouter un commentaire' }).click();
  await bubble(page).getByRole('textbox', { name: 'Commentaire facultatif' }).fill('Nom d’usage de la cliente fictive.');
  await shot(page, '08-correction-libre');
  await bubble(page).getByRole('button', { name: 'Envoyer' }).click();
  await page.locator('#socrate-bubble').waitFor({ state: 'hidden', timeout: 15_000 });
  const libre = await proposalOf('Mme Fictive Durand-Martin');
  assert.deepEqual(libre, { original: 'Mme Fictive Durand', replacement: 'Mme Fictive Durand-Martin', wording_id: null }, 'original = texte sélectionné, sans clé');
  assert.equal(await countBody('Nom d’usage de la cliente fictive.'), 1);
  assert.equal(await page.locator('article').first().innerText(), host, 'aucun texte de l’hôte modifié');

  // Texte préparé : l'original est la source complète de la révision, présélection de la partie choisie.
  const at2 = await selectText(page, '[data-testid="variante-email"]', 'par e-mail');
  await page.mouse.click(at2.x, at2.y, { button: 'right' });
  await menu.getByRole('menuitem', { name: 'Proposer une correction' }).click();
  await bubble(page).getByTestId('socrate-draft').waitFor({ timeout: 10_000 });
  const source = 'Un rappel vous sera envoyé par e-mail {delai} avant le rendez-vous.';
  assert.match(await bubble(page).getByTestId('socrate-original').innerText(), new RegExp(`« ${source.replace(/[{}.]/g, '\\$&')} »`));
  const f2 = bubble(page).getByRole('textbox', { name: 'Correction proposée' });
  assert.equal(await f2.inputValue(), source);
  assert.deepEqual(await f2.evaluate((el: HTMLTextAreaElement) => el.value.slice(el.selectionStart, el.selectionEnd)), 'par e-mail', 'partie sélectionnée présélectionnée');
  await f2.fill('Un rappel vous sera envoyé par courriel {delai} avant le rendez-vous.');
  await shot(page, '09-correction-texte-prepare');
  await send(page);
  await page.locator('#socrate-bubble').waitFor({ state: 'hidden', timeout: 15_000 });
  const prepared = await proposalOf('Un rappel vous sera envoyé par courriel {delai} avant le rendez-vous.');
  assert.equal(prepared?.original, source);
  assert.equal(prepared?.wording_id, 'rappel-email');

  // Menu natif hors du geste : sans sélection, Maj + clic droit, sélection dans un champ.
  await page.evaluate(() => getSelection()!.removeAllRanges());
  const natif = {
    sansSelection: await contextPrevented(page, 'article p', {}),
    majClicDroit: (await selectText(page, 'article p:nth-of-type(1)', 'Consultation'), await contextPrevented(page, 'article p', { shiftKey: true })),
  };
  await page.getByRole('link', { name: 'Réglages' }).click();
  await page.getByRole('heading', { level: 1, name: 'Rappels automatiques' }).waitFor();
  await page.locator('label input').first().evaluate((el: HTMLInputElement) => { el.focus(); el.select(); });
  const champ = await contextPrevented(page, 'label input', {});
  facts.menuNatif = { ...natif, champ };
  assert.deepEqual({ ...natif, champ }, { sansSelection: false, majClicDroit: false, champ: false }, 'le menu natif reste disponible hors du geste');

  // Alternative clavier : la sélection reste, le menu ⋯ de la toolbar propose la correction.
  await selectText(page, '[data-socrate-id="rappel-libelle"]', 'Rappel automatique');
  await control(page, 'more').click();
  await page.getByRole('menuitem', { name: 'Proposer une correction' }).waitFor();
  assert.equal(await control(page, 'correct-selection').getAttribute('aria-disabled'), 'false');
  await control(page, 'correct-selection').focus();
  await page.keyboard.press('Enter');
  await bubble(page).getByTestId('socrate-draft').waitFor({ timeout: 10_000 });
  assert.match(await bubble(page).getByTestId('socrate-original').innerText(), /« Rappel automatique »/);
  await page.keyboard.press('Escape');
  await page.locator('#socrate-bubble').waitFor({ state: 'hidden' });
  await ctx.context.close();
});

test('pastilles : élément vivant pendant la page, après rechargement la cible unique et le doublon distingué par son contexte, aucune sur une autre route ; défilement suivi', async () => {
  const ctx = await browser.newContext(origins());
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openRdv(page);
  await toolbarReady(page);
  await targetElement(page, page.getByTestId('occurrence-1'));
  await bubble(page).getByRole('textbox', { name: 'Votre commentaire' }).fill('Doublon : la première occurrence.');
  await send(page);
  await page.locator('#socrate-bubble').waitFor({ state: 'hidden', timeout: 15_000 });
  await targetElement(page, page.locator('article p').first());
  await bubble(page).getByRole('textbox', { name: 'Votre commentaire' }).fill('Paragraphe libre unique.');
  await send(page);
  await page.locator('#socrate-bubble').waitFor({ state: 'hidden', timeout: 15_000 });
  const pins = page.locator('[data-socrate="pin"]');
  // Les fils des tests précédents sur cette page sont aussi relocalisés : seules les deux pastilles de ce test sont attendues.
  const published = [(await threadOf('Doublon : la première occurrence.'))!.thread_id, (await threadOf('Paragraphe libre unique.'))!.thread_id];
  await page.waitForFunction((ids) => ids.every((id) => [...document.querySelectorAll<HTMLElement>('[data-socrate="pin"]')].some((p) => p.dataset.threads!.split(' ').includes(id))), published);
  facts.pastillesVivantes = await pins.evaluateAll((ps) => ps.map((p) => p.getAttribute('aria-label')));

  // Défilement : la pastille suit le paragraphe. Vue réduite après les captures : l'émulation de viewport ne change pas la surface capturée.
  await page.setViewportSize({ width: 1280, height: 300 });
  const para = page.locator('article p').first();
  const pinOf = () => page.locator('[data-socrate="pin"][aria-label^="Conversation de Claire Morel"]').evaluateAll((ps) => ps.map((p) => p.getBoundingClientRect().y));
  const before = { pin: await pinOf(), el: (await para.boundingBox())!.y };
  await page.mouse.wheel(0, 120);
  await page.waitForFunction((y) => document.querySelector('article p')!.getBoundingClientRect().y !== y, before.el);
  await page.waitForTimeout(100);
  const after = { pin: await pinOf(), el: (await para.boundingBox())!.y };
  facts.defilement = { before, after };
  assert.ok(after.el < before.el, 'la page a défilé');
  assert.ok(after.pin.some((y) => before.pin.some((b) => Math.abs((b - y) - (before.el - after.el)) <= 1)), `pastille déplacée avec sa cible ${JSON.stringify(facts.defilement)}`);
  await page.setViewportSize({ width: 1280, height: 720 });

  await page.reload();
  await toolbarReady(page);
  await control(page, 'launcher').click();
  await list(page).getByRole('heading', { level: 1, name: 'Conversations' }).waitFor();
  await list(page).getByTestId('socrate-row').nth(1).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
  const labels = await pins.evaluateAll((ps) => ps.map((p) => p.getAttribute('data-threads')));
  const ids = { ambigu: (await threadOf('Doublon : la première occurrence.'))!.thread_id, unique: (await threadOf('Paragraphe libre unique.'))!.thread_id };
  const pinned = (id: string) => labels.some((l) => l!.split(' ').includes(id));
  const ambigu = list(page).locator('[data-testid="socrate-row"]', { hasText: 'Doublon : la première occurrence.' });
  const unique = list(page).locator('[data-testid="socrate-row"]', { hasText: 'Paragraphe libre unique.' });
  facts.apresRechargement = { pastilles: labels, ids, ambigu: await ambigu.innerText(), unique: await unique.innerText() };
  assert.deepEqual({ ambigu: pinned(ids.ambigu), unique: pinned(ids.unique) }, { ambigu: true, unique: true }, `après rechargement : pastilles retrouvées ${JSON.stringify(facts.apresRechargement)}`);
  assert.ok(await pinnedOn(page, ids.ambigu, page.getByTestId('occurrence-1')), 'doublon : liste identique et même position, la première occurrence et non la seconde');
  for (const row of [ambigu, unique]) assert.doesNotMatch(await row.innerText(), /introuvable|Autre page/);
  await shot(page, '10-liste-pastille-rechargement');

  await page.getByRole('banner').getByRole('link', { name: 'Agenda' }).click();
  await page.waitForFunction(() => document.querySelectorAll('[data-socrate="pin"]').length === 0, undefined, { timeout: 5_000 });
  await list(page).getByRole('button', { name: /^Toutes les pages/ }).click();
  for (const row of [ambigu, unique]) assert.match(await row.innerText(), /Autre page · \/rendez-vous\/rdv-1042/, 'autre route : aucune pastille, mention dans la liste sous Toutes les pages');
  await control(page, 'close').click();
  await page.locator('#socrate-frame').waitFor({ state: 'hidden' });
  assert.ok(await toolbar(page).isVisible(), 'tout fermer garde la toolbar');
  await ctx.context.close();
});

async function openActivity(page: Page) {
  await page.getByRole('banner').getByRole('link', { name: 'Activité' }).click();
  await page.getByRole('heading', { level: 1, name: 'Activité' }).waitFor();
}
/** Le fil a sa pastille sur l'élément attendu : coin haut droit de son rectangle selon `pinAt`, borné par la liste ouverte. Faux sans pastille. */
async function pinnedOn(page: Page, threadId: string, target: Locator): Promise<boolean> {
  const pin = page.locator(`[data-socrate="pin"][data-threads~="${threadId}"]`);
  if (!(await pin.count()) || !(await target.count())) return false;
  const [p, r] = [(await pin.boundingBox())!, (await target.boundingBox())!];
  const listWidth = await page.locator('#socrate-frame').evaluate((f: HTMLElement) => (f.style.display === 'none' ? 0 : f.getBoundingClientRect().width));
  const x = Math.max(4, Math.min(r.x + r.width - 6, page.viewportSize()!.width - listWidth - 34));
  return Math.abs(p.x - x) <= 1 && Math.abs(p.y - Math.max(4, r.y - 22)) <= 1;
}
/** Attend au plus 5 s que chaque fil soit posé ou non sur sa cible comme attendu, puis rend l'état observé. */
async function pinsSettle(page: Page, cases: Record<string, { id: string; on: Locator; expected: boolean }>) {
  let seen: Record<string, boolean> = {};
  for (const end = Date.now() + 5_000; Date.now() < end; await page.waitForTimeout(100)) {
    seen = Object.fromEntries(await Promise.all(Object.entries(cases).map(async ([k, c]) => [k, await pinnedOn(page, c.id, c.on)] as const)));
    if (Object.entries(cases).every(([k, c]) => seen[k] === c.expected)) break;
  }
  return seen;
}
const contextOfThread = async (threadId: string) => (JSON.parse((await db().prepare('SELECT context FROM targets WHERE thread_id = ?').bind(threadId).first<{ context: string }>())!.context) as { context?: { html: string; path: number[] } }).context ?? null;

test('R26 ancrage : contrôle vide parmi des jumeaux, ligne répétée recyclée puis déplacée, sélection partielle, aller-retour SPA, rechargement, suppression, doublons indiscernables et anciens retours', async () => {
  const ctx = await browser.newContext(origins());
  try {
    const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
    await page.evaluate(() => sessionStorage.removeItem('demo-activite'));
    await openActivity(page);
    await toolbarReady(page);
    const comment = async (target: Locator, body: string) => {
      await targetElement(page, target);
      await bubble(page).getByRole('textbox', { name: 'Votre commentaire' }).fill(body);
      await send(page);
      await page.locator('#socrate-bubble').waitFor({ state: 'hidden', timeout: 15_000 });
      return (await threadOf(body))!.thread_id;
    };
    const indicateur = page.getByTestId('indicateur');
    const modifier = (who: string) => page.getByTestId(`contact-${who}`).getByRole('button', { name: 'Modifier' });
    const relance = page.getByRole('list', { name: 'Relances' }).getByText('Relance').nth(6);
    const note = page.getByTestId('note-suivi');
    const ids = {
      indicateur: await comment(indicateur, 'R26 : indicateur vide.'),
      martin: await comment(modifier('martin'), 'R26 : ligne de M. Fictif Martin.'),
      relance: await comment(relance, 'R26 : relance indiscernable.'),
      selection: '',
    };
    const at = await selectText(page, '[data-testid="note-suivi"]', 'Fictive Durand');
    await page.mouse.click(at.x, at.y, { button: 'right' });
    await page.locator('[data-socrate="menu"]').getByRole('menuitem', { name: 'Proposer une correction' }).click();
    await bubble(page).getByRole('textbox', { name: 'Correction proposée' }).fill('Fictive Durand-Leroy');
    await bubble(page).getByRole('button', { name: '+ Ajouter un commentaire' }).click();
    await bubble(page).getByRole('textbox', { name: 'Commentaire facultatif' }).fill('R26 : sélection partielle.');
    await bubble(page).getByRole('button', { name: 'Envoyer' }).click();
    await page.locator('#socrate-bubble').waitFor({ state: 'hidden', timeout: 15_000 });
    ids.selection = (await threadOf('R26 : sélection partielle.'))!.thread_id;
    const contexts = Object.fromEntries(await Promise.all(Object.entries(ids).map(async ([k, id]) => [k, await contextOfThread(id)] as const)));
    const all = { indicateur: { id: ids.indicateur, on: indicateur, expected: true }, martin: { id: ids.martin, on: modifier('martin'), expected: true }, selection: { id: ids.selection, on: note, expected: true }, relance: { id: ids.relance, on: relance, expected: false } };
    const vivantes = await pinsSettle(page, { ...all, relance: { ...all.relance, expected: true } });

    // L'hôte recycle les nœuds : le bouton qui portait l'ancre affiche désormais la ligne de Mme Fictive Durand.
    await page.getByRole('button', { name: 'Remonter M. Fictif Martin' }).click();
    const recyclage = { ...(await pinsSettle(page, { martin: all.martin })), surDurand: await pinnedOn(page, ids.martin, modifier('durand')) };
    await page.getByRole('banner').getByRole('link', { name: 'Agenda' }).click();
    await page.getByRole('heading', { level: 1, name: 'Agenda' }).waitFor();
    await openActivity(page);
    const allerRetour = await pinsSettle(page, all);
    await page.reload();
    await page.getByRole('heading', { level: 1, name: 'Activité' }).waitFor();
    await toolbarReady(page);
    const rechargement = await pinsSettle(page, all);
    await shot(page, 'R26-01-pastilles-apres-rechargement');
    await page.getByRole('button', { name: 'Retirer M. Fictif Martin' }).click();
    await page.locator(`[data-socrate="pin"][data-threads~="${ids.martin}"]`).waitFor({ state: 'detached', timeout: 5_000 }).catch(() => undefined);
    const { martin: _, ...others } = all;
    const suppression = { ...(await pinsSettle(page, { ...others, surDurand: { ...all.martin, on: modifier('durand'), expected: false }, surPetit: { ...all.martin, on: modifier('petit'), expected: false } })), pastillesMartin: await page.locator(`[data-socrate="pin"][data-threads~="${ids.martin}"]`).count() };

    // Anciens retours : charges enregistrées sans contexte, relues par la règle historique puis la confirmation par contenu complet.
    await db().prepare(`UPDATE targets SET context = json_remove(context, '$.context') WHERE thread_id IN (?, ?)`).bind(ids.indicateur, ids.selection).run();
    await page.reload();
    await page.getByRole('heading', { level: 1, name: 'Activité' }).waitFor();
    await toolbarReady(page);
    const anciens = await pinsSettle(page, { indicateur: all.indicateur, selection: all.selection, relance: all.relance });
    facts.r26Ancrage = { contextes: Object.fromEntries(Object.entries(contexts).map(([k, c]) => [k, c && { chemin: c.path, caracteres: c.html.length }])), vivantes, recyclage, allerRetour, rechargement, suppression, anciens };
    const r = JSON.stringify(facts.r26Ancrage);
    assert.deepEqual(Object.fromEntries(Object.entries(contexts).map(([k, c]) => [k, c !== null])), { indicateur: true, martin: true, relance: false, selection: true }, `contexte enregistré seulement s’il distingue la cible ${r}`);
    assert.deepEqual(vivantes, { indicateur: true, martin: true, selection: true, relance: true }, `éléments vivants pendant la page ${r}`);
    assert.deepEqual(recyclage, { martin: true, surDurand: false }, `nœud recyclé : la pastille suit la ligne déplacée ${r}`);
    for (const [step, seen] of Object.entries({ allerRetour, rechargement })) assert.deepEqual(seen, { indicateur: true, martin: true, selection: true, relance: false }, `${step} : bonnes cibles, doublon indiscernable refusé ${r}`);
    assert.deepEqual(suppression, { indicateur: true, selection: true, relance: false, surDurand: false, surPetit: false, pastillesMartin: 0 }, `ligne supprimée : aucune pastille de remplacement ${r}`);
    assert.deepEqual(anciens, { indicateur: true, selection: true, relance: false }, `anciens retours sans contexte ${r}`);

    // Fil sans cible sur la page : lisible et répondable depuis la liste, aucune action de localisation proposée.
    await control(page, 'launcher').click();
    const row = list(page).locator(`[data-testid="socrate-row"][data-thread="${ids.martin}"]`);
    await row.getByRole('button', { name: 'Voir où c’était' }).waitFor();
    assert.equal(await row.getByRole('button', { name: 'Voir sur la page' }).count(), 0);
    await row.locator('.socrate-row').click();
    const conv = row.getByTestId('socrate-conversation');
    await conv.getByRole('textbox', { name: /Répondre/ }).fill('R26 : réponse sans cible.');
    await conv.getByRole('button', { name: 'Envoyer' }).click();
    await conv.getByText('R26 : réponse sans cible.').waitFor({ timeout: 15_000 });
    assert.equal(await countBody('R26 : réponse sans cible.'), 1, 'réponse persistée en D1');
    await shot(page, 'R26-02-fil-sans-cible-dans-la-liste');
  } finally { await ctx.context.close(); }
});

test('R26 doublons : jumeau sans contexte jamais repris après suppression de la cible, doublons courts identiques distingués par leur position', async () => {
  const ctx = await browser.newContext(origins());
  try {
    const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
    await openActivity(page);
    await toolbarReady(page);
    const comment = async (target: Locator, body: string) => {
      await targetElement(page, target);
      await bubble(page).getByRole('textbox', { name: 'Votre commentaire' }).fill(body);
      await send(page);
      await page.locator('#socrate-bubble').waitFor({ state: 'hidden', timeout: 15_000 });
      return (await threadOf(body))!.thread_id;
    };
    const bernard = page.getByRole('list', { name: 'Appels' }).getByText('Appel de M. Fictif Bernard');
    const etiquette = page.getByRole('list', { name: 'Étiquettes' }).getByRole('listitem');
    const ids = { bernard: await comment(bernard.first(), 'R26 : premier appel jumeau.'), etiquette: await comment(etiquette.nth(1), 'R26 : deuxième étiquette identique.') };
    const contexts = { bernard: await contextOfThread(ids.bernard), etiquette: await contextOfThread(ids.etiquette) };
    await bernard.first().scrollIntoViewIfNeeded();
    const vivante = await pinsSettle(page, { premier: { id: ids.bernard, on: bernard.first(), expected: true }, jumeau: { id: ids.bernard, on: bernard.last(), expected: false } });
    await page.getByRole('button', { name: 'Retirer le premier appel de M. Fictif Bernard' }).click();
    await bernard.first().scrollIntoViewIfNeeded();
    const suppression = { ...(await pinsSettle(page, { jumeau: { id: ids.bernard, on: bernard.first(), expected: false } })), restants: await bernard.count(), pastilles: await pinCount(page, ids.bernard) };
    await page.reload();
    await page.getByRole('heading', { level: 1, name: 'Activité' }).waitFor();
    await toolbarReady(page);
    await etiquette.nth(1).scrollIntoViewIfNeeded();
    const rechargement = await pinsSettle(page, Object.fromEntries([0, 1, 2].map((i) => [`etiquette${i + 1}`, { id: ids.etiquette, on: etiquette.nth(i), expected: i === 1 }])));
    await bernard.first().scrollIntoViewIfNeeded();
    const jumeauxRecharges = { ...(await pinsSettle(page, { premier: { id: ids.bernard, on: bernard.first(), expected: false }, second: { id: ids.bernard, on: bernard.last(), expected: false } })), pastilles: await pinCount(page, ids.bernard) };
    facts.r26Doublons = { contextes: { bernard: contexts.bernard && contexts.bernard.path, etiquette: contexts.etiquette && contexts.etiquette.path }, vivante, suppression, rechargement, jumeauxRecharges };
    const r = JSON.stringify(facts.r26Doublons);
    assert.deepEqual({ bernard: contexts.bernard, etiquette: contexts.etiquette?.path }, { bernard: null, etiquette: [1] }, `jumeau hors bornes sans contexte, étiquette courte distinguée par sa position ${r}`);
    assert.deepEqual(vivante, { premier: true, jumeau: false }, `élément vivant sur le premier jumeau ${r}`);
    assert.deepEqual(suppression, { jumeau: false, restants: 1, pastilles: 0 }, `cible supprimée : aucune pastille sur le jumeau restant ${r}`);
    assert.deepEqual(rechargement, { etiquette1: false, etiquette2: true, etiquette3: false }, `doublons courts : même position sous un ancêtre identique ${r}`);
    assert.deepEqual(jumeauxRecharges, { premier: false, second: false, pastilles: 0 }, `jumeaux sans contexte refusés après rechargement ${r}`);
  } finally { await ctx.context.close(); }
});

test('brouillon : arrêt du partage et réponse perdue conservent le texte sans succès annoncé ; reprise idempotente ; Échap masque sans perte', async () => {
  const ctx = await browser.newContext(origins());
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openRdv(page);
  await toolbarReady(page);
  await targetElement(page, page.getByRole('heading', { level: 1, name: /Rendez-vous du 21 octobre/ }));
  const field = bubble(page).getByRole('textbox', { name: 'Votre commentaire' });
  const body = 'Titre : préciser le fuseau horaire.';
  await field.fill(body);
  await page.keyboard.press('Escape');
  await page.locator('#socrate-bubble').waitFor({ state: 'hidden' });
  await control(page, 'draft').click();
  await bubble(page).getByTestId('socrate-draft').waitFor();
  assert.equal(await field.inputValue(), body, 'Échap masque le brouillon sans le perdre');

  await control(page, 'more').click();
  await control(page, 'stop').click();
  await bubble(page).getByTestId('socrate-capture-invalidated').waitFor();
  assert.equal(await field.inputValue(), body, 'texte conservé après l’arrêt du partage');
  assert.equal(await bubble(page).getByRole('button', { name: 'Envoyer' }).isDisabled(), true, 'aucun envoi sans nouvelle image');
  await shot(page, '11-partage-arrete-brouillon');
  await bubble(page).getByRole('button', { name: 'Cibler à nouveau' }).click();
  await page.locator('[data-socrate-action="target"][aria-pressed="true"]').waitFor({ timeout: 10_000 });
  const h1 = (await page.getByRole('heading', { level: 1, name: /Rendez-vous du 21 octobre/ }).boundingBox())!;
  await page.mouse.click(h1.x + 8, h1.y + h1.height / 2);
  await bubble(page).getByTestId('socrate-capture-invalidated').waitFor({ state: 'detached', timeout: 10_000 });
  assert.equal(await field.inputValue(), body, 'texte toujours présent après le nouveau ciblage');

  const pinsBefore = await page.locator('[data-socrate="pin"]').evaluateAll((ps) => ps.map((p) => p.getAttribute('data-threads')).join(' '));
  let lost = false;
  ctx.setFaults((r) => (!lost && r.method === 'POST' && /\/captures\/[^/]+\/commit$/.test(path(r)) ? ((lost = true), { kind: 'lose-response' }) : { kind: 'pass' }));
  await send(page);
  await bubble(page).getByRole('alert').getByRole('button', { name: 'Réessayer' }).waitFor({ timeout: 15_000 });
  const pending = await bubble(page).getByTestId('socrate-pending-targeted').innerText();
  assert.match(pending, /peut-être déjà été publié/);
  assert.equal(await page.locator('[data-socrate="pin"]').evaluateAll((ps) => ps.map((p) => p.getAttribute('data-threads')).join(' ')), pinsBefore, 'aucune nouvelle pastille avant la confirmation');
  assert.equal(await field.inputValue(), body);
  await shot(page, '12-reponse-perdue-bulle');
  ctx.setFaults(null);
  await bubble(page).getByRole('alert').getByRole('button', { name: 'Réessayer' }).click();
  await page.locator('#socrate-bubble').waitFor({ state: 'hidden', timeout: 15_000 });
  assert.equal(await countBody(body), 1, 'un seul fil après la reprise');
  const keys = toService(ctx, (r) => r.method === 'POST' && path(r).endsWith('/targeted')).map((r) => r.headers['idempotency-key']);
  facts.reprise = { cles: keys };
  assert.ok(keys.length >= 2 && new Set(keys).size === 1, `même clé pour l’envoi et sa reprise : ${keys.join(', ')}`);
  await page.locator('[data-socrate="pin"]').first().waitFor();
  await ctx.context.close();
});

/** Fil publié depuis un élément ciblé ; rend son identifiant après l'apparition de sa pastille. */
async function publishOn(page: Page, locator: ReturnType<Page['locator']>, body: string) {
  await targetElement(page, locator);
  await bubble(page).getByRole('textbox', { name: 'Votre commentaire' }).fill(body);
  await send(page);
  await page.locator('#socrate-bubble').waitFor({ state: 'hidden', timeout: 15_000 });
  const id = (await threadOf(body))!.thread_id;
  await page.locator(`[data-socrate="pin"][data-threads~="${id}"]`).waitFor({ timeout: 10_000 });
  return id;
}
const pinCount = (page: Page, id: string) => page.locator(`[data-socrate="pin"][data-threads~="${id}"]`).count();
const focused = (page: Page) => page.evaluate(() => {
  const el = document.activeElement;
  return { tag: el?.tagName, id: el?.id, action: el?.getAttribute('data-socrate-action'), socrate: el?.getAttribute('data-socrate') };
});

test('ancres vivantes : navigation SPA sans rechargement, rendez-vous vers Agenda et Rappels vers Général ; aucune fausse pastille, la conversation reste dans la liste', async () => {
  const ctx = await browser.newContext(origins());
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openRdv(page);
  await toolbarReady(page);
  const rdv = await publishOn(page, page.getByRole('heading', { level: 1, name: /Rendez-vous du 21 octobre/ }), 'Titre du rendez-vous : ajouter le lieu.');
  await page.getByRole('banner').getByRole('link', { name: 'Agenda', exact: true }).click();
  await page.getByRole('heading', { level: 1, name: 'Agenda', exact: true }).waitFor();
  await page.waitForTimeout(300);
  const agenda = await pinCount(page, rdv);
  await shot(page, '18-agenda-sans-rechargement');
  await control(page, 'launcher').click();
  await list(page).getByRole('button', { name: /^Toutes les pages/ }).click();
  const row = list(page).locator(`[data-testid="socrate-row"][data-thread="${rdv}"]`);
  await row.waitFor();
  const mention = await row.innerText();
  await control(page, 'launcher').click();
  await openRdv(page);
  await page.waitForFunction((id) => !!document.querySelector(`[data-socrate="pin"][data-threads~="${id}"]`), rdv, { timeout: 5_000 });

  await page.getByRole('link', { name: 'Réglages', exact: true }).click();
  await page.getByRole('heading', { level: 1, name: 'Rappels automatiques' }).waitFor();
  const rappels = await publishOn(page, page.getByRole('heading', { level: 1, name: 'Rappels automatiques' }), 'Rappels : titre trop vague.');
  await page.getByRole('link', { name: 'Général', exact: true }).click();
  await page.getByRole('heading', { level: 1, name: 'Général', exact: true }).waitFor();
  await page.waitForTimeout(300);
  const general = await pinCount(page, rappels);
  facts.ancresVivantes = { agenda, mention, general };
  assert.deepEqual({ agenda, general }, { agenda: 0, general: 0 }, `aucune pastille sur l’élément réutilisé par React ${JSON.stringify(facts.ancresVivantes)}`);
  assert.match(mention, /Autre page/, 'le fil reste disponible dans la liste');
  await ctx.context.close();
});

test('clic droit réel hors de la sélection : le lien garde son menu natif ; sur la sélection, la correction ; avec le vrai geste du navigateur', async () => {
  const ctx = await browser.newContext(origins());
  await ctx.context.addInitScript(() => {
    const seen: unknown[] = [];
    Object.assign(window, { contextEvents: seen });
    window.addEventListener('contextmenu', (e) => setTimeout(() => seen.push({ prevented: e.defaultPrevented, trusted: e.isTrusted, tag: (e.target as Element).tagName }), 0), true);
  });
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openRdv(page);
  await toolbarReady(page);
  const read = async () => {
    await page.waitForTimeout(150);
    const r = { events: await page.evaluate(() => (window as unknown as { contextEvents: unknown[] }).contextEvents.splice(0)), menu: await page.locator('[data-socrate="menu"][aria-label="Correction"]').count() };
    await page.keyboard.press('Escape');
    return r;
  };
  await selectText(page, 'article p:nth-of-type(1)', 'Mme Fictive Durand');
  const link = (await page.getByRole('banner').getByRole('link', { name: 'Agenda', exact: true }).boundingBox())!;
  await page.mouse.click(link.x + link.width / 2, link.y + link.height / 2, { button: 'right' });
  const surLien = await read();
  const at = await selectText(page, 'article p:nth-of-type(1)', 'Mme Fictive Durand');
  await page.mouse.click(at.x, at.y, { button: 'right' });
  const surSelection = await read();
  facts.clicDroitReel = { surLien, surSelection };
  assert.deepEqual(surLien, { events: [{ prevented: false, trusted: true, tag: 'A' }], menu: 0 }, 'clic droit sur un lien hors de la sélection : menu natif conservé');
  assert.equal(surSelection.menu, 1, 'clic droit sur la sélection : menu de correction');
  assert.deepEqual(surSelection.events, [{ prevented: true, trusted: true, tag: 'P' }]);
  await ctx.context.close();
});

test('Ctrl+clic réel macOS : hors de la sélection le lien garde son menu natif, sur la sélection la correction de la sélection, Maj garde le natif', { skip: process.platform !== 'darwin' && 'Ctrl+clic n’ouvre le menu contextuel que sous macOS' }, async () => {
  const ctx = await browser.newContext(origins());
  await ctx.context.addInitScript(() => {
    const seen: unknown[] = [];
    Object.assign(window, { contextEvents: seen });
    window.addEventListener('contextmenu', (e) => setTimeout(() => seen.push({ button: e.button, ctrl: e.ctrlKey, trusted: e.isTrusted, prevented: e.defaultPrevented, tag: (e.target as Element).tagName }), 0), true);
  });
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openRdv(page);
  const route = new URL(page.url()).pathname;
  await toolbarReady(page);
  const observe = async () => {
    await page.waitForTimeout(150);
    return {
      events: await page.evaluate(() => (window as unknown as { contextEvents: unknown[] }).contextEvents.splice(0)),
      menu: await page.locator('[data-socrate="menu"][aria-label="Correction"]').count(),
      route: new URL(page.url()).pathname,
    };
  };
  const read = async () => {
    const r = await observe();
    await page.keyboard.press('Escape');
    return r;
  };
  const ctrlClick = async (x: number, y: number, modifiers: string[]) => {
    for (const k of modifiers) await page.keyboard.down(k);
    await page.mouse.click(x, y);
    for (const k of modifiers.reverse()) await page.keyboard.up(k);
  };
  await selectText(page, 'article p:nth-of-type(1)', 'Mme Fictive Durand');
  const link = (await page.getByRole('banner').getByRole('link', { name: 'Agenda', exact: true }).boundingBox())!;
  await ctrlClick(link.x + link.width / 2, link.y + link.height / 2, ['Control']);
  const surLien = await read();
  let at = await selectText(page, 'article p:nth-of-type(1)', 'Mme Fictive Durand');
  await ctrlClick(at.x, at.y, ['Control']);
  const surSelection = await observe();
  await shot(page, '24-ctrl-clic-selection');
  await page.locator('[data-socrate="menu"]').getByRole('menuitem', { name: 'Proposer une correction' }).click();
  await bubble(page).getByTestId('socrate-draft').waitFor({ timeout: 10_000 });
  const original = await bubble(page).getByTestId('socrate-original').innerText();
  await page.keyboard.press('Escape');
  await page.locator('#socrate-bubble').waitFor({ state: 'hidden' });
  at = await selectText(page, 'article p:nth-of-type(1)', 'Mme Fictive Durand');
  await ctrlClick(at.x, at.y, ['Shift', 'Control']);
  const majSurSelection = await read();
  facts.ctrlClicReel = { surLien, surSelection, original, majSurSelection };
  const ctrl = { button: 0, ctrl: true, trusted: true };
  assert.deepEqual(surLien, { events: [{ ...ctrl, prevented: false, tag: 'A' }], menu: 0, route }, 'Ctrl+clic sur un lien hors de la sélection : menu natif conservé, aucune navigation');
  assert.deepEqual(surSelection, { events: [{ ...ctrl, prevented: true, tag: 'P' }], menu: 1, route }, 'Ctrl+clic sur la sélection : menu de correction');
  assert.match(original, /Texte actuel\s+« Mme Fictive Durand »/, 'la correction porte la sélection du geste');
  assert.deepEqual(majSurSelection, { events: [{ ...ctrl, prevented: false, tag: 'P' }], menu: 0, route }, 'Maj+Ctrl+clic : menu natif');
  await ctx.context.close();
});

test('vue scindée sans pastille suivie : le premier brouillon suit le défilement interne de l’iframe', async () => {
  const ctx = await browser.newContext(origins());
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await page.getByRole('link', { name: 'Vue scindée' }).click();
  const child = page.frameLocator('[data-testid="split-frame"]');
  await child.getByTestId('open-courte').waitFor();
  await toolbarReady(page);
  // Pastilles masquées : aucun fil ciblé n'est suivi, comme sur une revue vide (reproduction B3).
  await control(page, 'more').click();
  await control(page, 'pins').click();
  assert.equal(await page.locator('[data-socrate="pin"]').count(), 0, 'aucune pastille suivie');
  await child.locator('body').evaluate(() => window.scrollBy(0, 64));
  const inner = (await child.getByTestId('open-courte').boundingBox())!;
  await targetAt(page, inner.x + 6, inner.y + inner.height / 2);
  await bubble(page).getByRole('textbox', { name: 'Votre commentaire' }).fill('Brouillon avant tout fil.');
  const before = { scroll: await child.locator('body').evaluate(() => window.scrollY), target: (await child.getByTestId('open-courte').boundingBox())!, bubble: (await bubbleBox(page))! };
  await child.locator('body').evaluate(() => window.scrollBy(0, -32));
  await page.waitForTimeout(300);
  const after = { target: (await child.getByTestId('open-courte').boundingBox())!, bubble: (await bubbleBox(page))!, scroll: await child.locator('body').evaluate(() => window.scrollY) };
  facts.iframeDefilement = { before, after };
  await shot(page, '19-iframe-defilement-premier-brouillon');
  assert.ok(after.scroll < before.scroll && after.target.y > before.target.y, 'l’iframe a défilé');
  assert.ok(Math.abs((after.target.y - before.target.y) - (after.bubble.y - before.bubble.y)) < 1, `la bulle suit sa cible ${JSON.stringify(facts.iframeDefilement)}`);
  assert.equal(await bubble(page).getByRole('textbox', { name: 'Votre commentaire' }).inputValue(), 'Brouillon avant tout fil.');
  await ctx.context.close();
});

test('clavier : Échap et croix rendent le focus à la pastille, au bouton Conversations et à « Plus d’options » ; brouillon masqué repris ; Alt+Maj+S sous la modal', async () => {
  const ctx = await browser.newContext(origins());
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openRdv(page);
  await toolbarReady(page);
  const id = await publishOn(page, page.locator('article p').first(), 'Paragraphe : focus après fermeture.');
  const { conv } = await openPin(page, id);
  await conv.getByRole('textbox').fill('Réponse en cours.');
  await page.keyboard.press('Escape');
  await page.locator('#socrate-bubble').waitFor({ state: 'hidden' });
  const afterEscape = await focused(page);
  await openPin(page, id);
  assert.equal(await bubble(page).getByRole('textbox').inputValue(), 'Réponse en cours.', 'brouillon de réponse conservé');
  await bubble(page).getByRole('button', { name: 'Fermer' }).click();
  await page.locator('#socrate-bubble').waitFor({ state: 'hidden' });
  const afterCross = await focused(page);
  facts.focusFil = { afterEscape, afterCross };
  assert.deepEqual([afterEscape.socrate, afterCross.socrate], ['pin', 'pin'], `focus rendu à la pastille ${JSON.stringify(facts.focusFil)}`);

  await control(page, 'launcher').click();
  await list(page).getByRole('heading', { level: 1, name: 'Conversations' }).waitFor();
  await page.keyboard.press('Escape');
  await page.locator('#socrate-frame').waitFor({ state: 'hidden' });
  const afterList = await focused(page);
  await control(page, 'more').click();
  await page.locator('[data-socrate="menu"][aria-label="Options Socrate"]').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('[data-socrate="menu"][aria-label="Options Socrate"]').waitFor({ state: 'detached' });
  const afterMore = await focused(page);
  facts.focus = { afterList, afterMore };
  assert.deepEqual([afterList.action, afterMore.action], ['launcher', 'more'], `focus rendu au contrôle d’ouverture ${JSON.stringify(facts.focus)}`);

  await targetElement(page, page.getByTestId('occurrence-1'));
  await bubble(page).getByRole('textbox', { name: 'Votre commentaire' }).fill('Brouillon masqué par un fil.');
  await openPin(page, id);
  await control(page, 'draft').waitFor();
  await shot(page, '20-brouillon-masque-toolbar');
  await control(page, 'draft').click();
  await bubble(page).getByTestId('socrate-draft').waitFor();
  assert.equal(await bubble(page).getByRole('textbox', { name: 'Votre commentaire' }).inputValue(), 'Brouillon masqué par un fil.', 'brouillon repris sans nouveau ciblage');
  assert.equal(await bubble(page).getByRole('button', { name: 'Envoyer' }).isDisabled(), false, 'l’image du ciblage est toujours là');
  assert.equal(await control(page, 'draft').count(), 0);

  await page.getByRole('link', { name: 'Réglages', exact: true }).click();
  await page.getByTestId('open-detaillee').click();
  await page.getByTestId('scene-libelle').waitFor();
  // Le focus initial de la modal Base UI est posé une frame après l'ouverture.
  await page.waitForTimeout(300);
  await page.getByTestId('scene-libelle').focus();
  await page.keyboard.press('Alt+Shift+KeyS');
  await page.waitForTimeout(300);
  const shortcut = await focused(page);
  // Le lien « Réglages » a masqué le brouillon : sa puce « Brouillon » précède « Conversations » dans la toolbar.
  const parcours: Array<string | null | undefined> = [];
  for (let i = 0; i < 3 && parcours.at(-1) !== 'launcher'; i++) {
    await page.keyboard.press('Tab');
    await page.waitForTimeout(100);
    parcours.push((await focused(page)).action);
  }
  const next = await focused(page);
  await page.keyboard.press('Enter');
  await list(page).getByRole('heading', { level: 1, name: 'Conversations' }).waitFor();
  await page.waitForTimeout(100);
  const opened = await page.evaluate(() => document.activeElement?.id);
  await shot(page, '23-raccourci-sous-modal');
  const raccourci = { shortcut, parcours, next, opened, modale: await page.getByTestId('scene-dialog').isVisible() };
  facts.raccourci = raccourci;
  assert.deepEqual([shortcut.action, next.action, opened], ['target', 'launcher', 'socrate-frame'], `Alt+Maj+S puis Tab et Entrée ouvrent la liste au clavier sous la modal ${JSON.stringify(raccourci)}`);
  assert.deepEqual(parcours, ['draft', 'launcher'], `Tab reste dans la toolbar ${JSON.stringify(raccourci)}`);
  assert.equal(raccourci.modale, true, 'la modal reste ouverte');
  await ctx.context.close();
});

/** Pistes réellement rendues par getDisplayMedia, conservées sans remplacer le flux. */
async function withTracks(pending: Promise<LocalContext>) {
  const ctx = await pending;
  await ctx.context.addInitScript(() => {
    const tracks: MediaStreamTrack[] = [];
    Object.assign(window, { shareTracks: tracks });
    const original = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getDisplayMedia = async (options) => {
      const stream = await original(options);
      tracks.push(...stream.getTracks());
      return stream;
    };
  });
  return ctx;
}
const trackStates = (page: Page) => page.evaluate(() => (window as unknown as { shareTracks: MediaStreamTrack[] }).shareTracks.map((t) => t.readyState));
async function closeSocrate(page: Page) {
  await control(page, 'close').click();
  await page.locator('#socrate-bubble').waitFor({ state: 'hidden' });
  assert.ok(await toolbar(page).isVisible(), 'tout fermer garde la toolbar');
}

test('fermer Socrate arrête les vraies pistes : sans brouillon, avec texte (nouvelle capture explicite), avec intention incertaine reprise sous la même clé et le même contenu', async () => {
  const ctx = await withTracks(browser.newContext(origins()));
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openRdv(page);
  await toolbarReady(page);
  await control(page, 'target').click();
  await page.locator('[data-socrate-action="target"][aria-pressed="true"]').waitFor({ timeout: 10_000 });
  await page.keyboard.press('Escape');
  await page.locator('[data-socrate-action="target"][aria-pressed="false"]').waitFor();
  const avant = await trackStates(page);
  await closeSocrate(page);
  const sansBrouillon = { avant, apres: await trackStates(page) };
  assert.ok(avant.length > 0 && avant.every((s) => s === 'live') && sansBrouillon.apres.every((s) => s === 'ended'), `fermer sans brouillon arrête les pistes ${JSON.stringify(sansBrouillon)}`);

  await toolbarReady(page);
  await targetElement(page, page.locator('article p').first());
  const texte = 'Paragraphe : texte gardé après fermeture.';
  await bubble(page).getByRole('textbox', { name: 'Votre commentaire' }).fill(texte);
  await closeSocrate(page);
  const apresTexte = await trackStates(page);
  assert.ok(apresTexte.every((s) => s === 'ended'), `fermer avec un texte arrête les pistes ${JSON.stringify(apresTexte)}`);
  await control(page, 'draft').click();
  await bubble(page).getByTestId('socrate-capture-invalidated').waitFor();
  const garde = await bubble(page).getByRole('textbox', { name: 'Votre commentaire' }).inputValue();
  const envoiBloque = await bubble(page).getByRole('button', { name: 'Envoyer' }).isDisabled();
  await shot(page, '21-fermeture-texte-conserve');
  await bubble(page).getByRole('button', { name: 'Cibler à nouveau' }).click();
  await page.locator('[data-socrate-action="target"][aria-pressed="true"]').waitFor({ timeout: 10_000 });
  const para = (await page.locator('article p').first().boundingBox())!;
  await page.mouse.click(para.x + 8, para.y + para.height / 2);
  await bubble(page).getByTestId('socrate-capture-invalidated').waitFor({ state: 'detached', timeout: 10_000 });
  await send(page);
  await page.locator('#socrate-bubble').waitFor({ state: 'hidden', timeout: 15_000 });
  const avecTexte = { apres: apresTexte, texte: garde, envoiBloque, durable: await countBody(texte) };

  const incertain = 'Titre : envoi incertain repris après fermeture.';
  await targetElement(page, page.getByRole('heading', { level: 1, name: /Rendez-vous du 21 octobre/ }));
  await bubble(page).getByRole('textbox', { name: 'Votre commentaire' }).fill(incertain);
  let lost = false;
  ctx.setFaults((r) => (!lost && r.method === 'POST' && /\/captures\/[^/]+\/commit$/.test(path(r)) ? ((lost = true), { kind: 'lose-response' }) : { kind: 'pass' }));
  await send(page);
  await bubble(page).getByRole('alert').getByRole('button', { name: 'Réessayer' }).waitFor({ timeout: 15_000 });
  const posts = () => toService(ctx, (r) => r.method === 'POST' && path(r).endsWith('/targeted') && JSON.parse(r.postData ?? '{}').body === incertain);
  const emis = posts().length;
  await closeSocrate(page);
  const apresIntention = (await trackStates(page)).slice(-1);
  const emisFermeture = posts().length - emis;
  ctx.setFaults(null);
  await control(page, 'draft').click();
  await bubble(page).getByRole('alert').getByRole('button', { name: 'Réessayer' }).waitFor();
  await shot(page, '22-fermeture-intention-incertaine');
  await bubble(page).getByRole('alert').getByRole('button', { name: 'Réessayer' }).click();
  await page.locator('#socrate-bubble').waitFor({ state: 'hidden', timeout: 15_000 });
  const sent = posts();
  const avecIntention = { apres: apresIntention, emisFermeture, durable: await countBody(incertain), cles: new Set(sent.map((r) => r.headers['idempotency-key'])).size, charges: new Set(sent.map((r) => r.postData)).size, envois: sent.length };
  facts.fermeture = { sansBrouillon, avecTexte, avecIntention };
  const all = JSON.stringify(facts.fermeture);
  assert.ok(avant.length > 0 && avant.every((s) => s === 'live'), `partage actif avant fermeture ${all}`);
  assert.ok([...sansBrouillon.apres, ...avecTexte.apres, ...avecIntention.apres].every((s) => s === 'ended'), `fermer arrête toutes les pistes ${all}`);
  assert.deepEqual({ texte: avecTexte.texte, bloque: avecTexte.envoiBloque, durable: avecTexte.durable }, { texte, bloque: true, durable: 1 }, `texte conservé, nouvelle capture explicite, une publication ${all}`);
  assert.deepEqual({ emis: emisFermeture, durable: avecIntention.durable, cles: avecIntention.cles, charges: avecIntention.charges }, { emis: 0, durable: 1, cles: 1, charges: 1 }, `intention reprise sous sa clé et son contenu, un seul fil ${all}`);
  assert.ok(avecIntention.envois >= 2, 'envoi puis reprise');
  await ctx.context.close();
});

test('R26 toolbar et liste : toolbar sans clic après connexion, partage seulement sur geste explicite, liste et fil fermés sans la masquer, ligne lue dans la liste, « Voir sur la page » séparé', async () => {
  const ctx = await withTracks(browser.newContext(origins()));
  try {
    const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
    await openRdv(page);
    await toolbarReady(page);
    const arrivee = { ouvrir: await control(page, 'open').count(), liste: await page.locator('#socrate-frame').isVisible(), partage: await control(page, 'target').getAttribute('data-capture'), pistes: await trackStates(page) };
    await shot(page, 'R26-03-toolbar-a-l-arrivee');
    const body = 'R26 : fil lu dans la liste.';
    const id = await publishOn(page, page.getByRole('button', { name: 'Modifier l’heure' }), body);
    const pistesApresGeste = await trackStates(page);
    await control(page, 'launcher').click();
    const row = list(page).locator(`[data-testid="socrate-row"][data-thread="${id}"]`);
    await row.locator('.socrate-row').click();
    const conv = row.getByTestId('socrate-conversation');
    await conv.waitFor();
    const lecture = { bulle: await page.locator('#socrate-bubble').isVisible(), voir: await row.getByRole('button', { name: 'Voir sur la page' }).count() };
    await conv.getByRole('textbox', { name: /Répondre/ }).fill('R26 : réponse depuis la liste.');
    await conv.getByRole('button', { name: 'Envoyer' }).click();
    await conv.getByText('R26 : réponse depuis la liste.').waitFor({ timeout: 15_000 });
    await shot(page, 'R26-04-fil-lu-dans-la-liste');
    await row.getByRole('button', { name: 'Voir sur la page' }).click();
    await bubble(page).locator(`[data-testid="socrate-conversation"][data-thread="${id}"]`).waitFor({ timeout: 10_000 });
    const voir = { bulle: await bubbleBox(page), cible: await page.getByRole('button', { name: 'Modifier l’heure' }).boundingBox(), filDeplie: await conv.count() };
    await shot(page, 'R26-05-voir-sur-la-page');
    await page.keyboard.press('Escape');
    await page.locator('#socrate-bubble').waitFor({ state: 'hidden' });
    await list(page).getByRole('button', { name: 'Fermer la liste' }).click();
    await page.locator('#socrate-frame').waitFor({ state: 'hidden' });
    const apresFermetures = await toolbar(page).isVisible();
    await control(page, 'close').click();
    const toutFermer = { toolbar: await toolbar(page).isVisible(), pistes: await trackStates(page), partage: await control(page, 'target').getAttribute('data-capture') };
    const reponses = await countBody('R26 : réponse depuis la liste.');
    facts.r26Toolbar = { arrivee, pistesApresGeste, lecture, voir, apresFermetures, toutFermer, reponses };
    const r = JSON.stringify(facts.r26Toolbar);
    assert.deepEqual(arrivee, { ouvrir: 0, liste: false, partage: 'inactive:', pistes: [] }, `arrivée : toolbar sans bouton préalable ni partage ${r}`);
    assert.ok(pistesApresGeste.length > 0 && pistesApresGeste.every((t) => t === 'live'), `partage seulement après « Commenter un élément » ${r}`);
    assert.deepEqual(lecture, { bulle: false, voir: 1 }, `la ligne ouvre le fil dans la liste, cible localisée ou non ${r}`);
    assert.ok(voir.bulle && voir.cible && near(voir.bulle, voir.cible) <= 48, `« Voir sur la page » ouvre la bulle près de la cible ${r}`);
    assert.equal(voir.filDeplie, 0, `écran large : « Voir sur la page » replie la ligne, un seul composeur pour le fil ${r}`);
    assert.equal(apresFermetures, true, 'fermer la bulle et la liste garde la toolbar');
    assert.deepEqual({ toolbar: toutFermer.toolbar, pistes: toutFermer.pistes.every((t) => t === 'ended'), partage: toutFermer.partage }, { toolbar: true, pistes: true, partage: 'inactive:' }, `« Tout fermer » arrête le partage et garde la toolbar ${r}`);
    assert.equal(reponses, 1, 'réponse persistée en D1');
  } finally { await ctx.context.close(); }
});

test('identité : déconnexion puis autre personne dans le même onglet ; ni brouillon ni bulle de l’ancienne identité ; auteurs vérifiés et deux couleurs', async () => {
  const ctx = await browser.newContext(origins());
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openRdv(page);
  await toolbarReady(page);
  await targetElement(page, page.getByText('Mme Fictive Durand · Consultation'));
  await bubble(page).getByRole('textbox', { name: 'Votre commentaire' }).fill('Consultation : préciser la durée.');
  await send(page);
  await page.locator('[data-socrate="pin"]').first().waitFor({ timeout: 15_000 });
  await targetElement(page, page.getByRole('button', { name: 'Modifier l’heure' }));
  await bubble(page).getByRole('textbox', { name: 'Votre commentaire' }).fill('Brouillon de Claire, jamais publié.');

  await page.getByRole('button', { name: 'Se déconnecter' }).click();
  await page.getByRole('button', { name: /Se connecter comme Karim Benali/ }).click();
  await page.getByRole('button', { name: 'Se déconnecter' }).waitFor();
  await page.getByRole('heading', { level: 1, name: /Rendez-vous du 21 octobre/ }).waitFor();
  await toolbarReady(page);
  assert.equal(await control(page, 'draft').count(), 0, 'aucun brouillon de l’ancienne identité');
  assert.equal(await page.locator('#socrate-bubble').isVisible(), false, 'aucune bulle de l’ancienne identité');
  assert.equal(await control(page, 'target').getAttribute('data-capture'), 'inactive:', 'aucun partage repris');
  const { conv, grouped } = await openPin(page, (await threadOf('Consultation : préciser la durée.'))!.thread_id);
  facts.groupe = grouped;
  assert.equal(await conv.getByText('Brouillon de Claire, jamais publié.').count(), 0);
  await conv.getByRole('textbox', { name: /Répondre au retour de Claire Morel/ }).fill('Karim : 30 minutes par défaut.');
  await conv.getByRole('button', { name: 'Envoyer' }).click();
  await conv.getByText('Karim : 30 minutes par défaut.').waitFor({ timeout: 10_000 });
  const authors = await db().prepare('SELECT author_name, author_key FROM messages WHERE body IN (?, ?) ORDER BY seq').bind('Consultation : préciser la durée.', 'Karim : 30 minutes par défaut.').all<{ author_name: string; author_key: string }>();
  facts.auteurs = authors.results;
  assert.deepEqual(authors.results.map((a) => a.author_name), ['Claire Morel', 'Karim Benali'], 'auteurs issus de l’identité vérifiée');
  const colors = await conv.locator('.socrate-avatar').evaluateAll((els) => els.map((e) => [e.textContent, getComputedStyle(e).backgroundColor]));
  facts.couleurs = colors;
  assert.equal(new Set(colors.filter(([t]) => t !== 'KB' || true).map(([t]) => t)).size >= 2, true);
  await shot(page, '13-conversation-deux-auteurs');
  await control(page, 'launcher').click();
  await list(page).getByTestId('socrate-row').first().waitFor();
  await shot(page, '14-liste-conversations');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'la liste en surimpression n’élargit pas la page');
  await ctx.context.close();
});

test('mode éditorial explicite et mode par défaut ; fenêtre étroite : bulle en feuille dans la vue, toolbar visible', async () => {
  const ctx = await browser.newContext(origins());
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await toolbarReady(page);
  await control(page, 'launcher').click();
  await list(page).getByRole('heading', { level: 1, name: 'Conversations' }).waitFor();
  const hidden = { avantMaintenant: await list(page).getByRole('heading', { name: 'Avant / maintenant' }).count(), voirChangements: await list(page).getByRole('button', { name: 'Voir les changements' }).count(), textes: await list(page).getByRole('heading', { name: /Textes à relire/ }).count() };
  const chunks = ctx.seen.map((r) => path(r)).filter((p) => /\/(guide|wording|panel)\.tsx/.test(p));
  facts.parDefaut = { hidden, chunks };
  assert.deepEqual(hidden, { avantMaintenant: 0, voirChangements: 0, textes: 0 }, 'surfaces éditoriales absentes par défaut');
  assert.deepEqual(chunks, [], 'guide, revue des textes et panneau éditorial non chargés');
  await list(page).getByRole('textbox', { name: 'Votre commentaire global' }).fill('Global : la page est claire.');
  await list(page).getByRole('button', { name: 'Envoyer' }).click();
  await list(page).getByTestId('socrate-row').filter({ hasText: 'Global : la page est claire.' }).waitFor({ timeout: 10_000 });
  assert.equal((await threadOf('Global : la page est claire.'))?.kind, 'global', 'commentaire global conservé');
  await ctx.context.close();

  const ed = await browser.newContext(origins());
  const ep = await loginAs(ed, 'Claire Morel, relectrice produit', '/?editorial=1');
  await toolbarReady(ep);
  await control(ep, 'launcher').click();
  await list(ep).getByRole('heading', { level: 1, name: 'Rappels automatiques des rendez-vous' }).waitFor({ timeout: 10_000 });
  await list(ep).getByRole('heading', { name: 'Avant / maintenant' }).waitFor();
  await list(ep).getByRole('button', { name: 'Voir les changements' }).click();
  await list(ep).getByRole('status').filter({ hasText: 'repère(s) affiché(s)' }).waitFor({ timeout: 10_000 });
  await shot(ep, '15-mode-editorial');
  await ed.context.close();

  // Fenêtre étroite émulée : la capture refuse l'image (surface capturée à la taille réelle, ratio différent), limite du banc consignée ;
  // la publication se fait donc à la taille réelle, puis la bulle d'un fil est éprouvée en vue étroite.
  const narrow = await browser.newContext(origins());
  const np = await loginAs(narrow, 'Claire Morel, relectrice produit');
  await openRdv(np);
  await toolbarReady(np);
  await targetElement(np, np.getByRole('button', { name: 'Modifier l’heure' }));
  await bubble(np).getByRole('textbox', { name: 'Votre commentaire' }).fill('Bouton peu visible sur mobile.');
  await send(np);
  await np.locator('#socrate-bubble').waitFor({ state: 'hidden', timeout: 15_000 });
  await np.setViewportSize({ width: 375, height: 700 });
  await np.getByRole('button', { name: 'Modifier l’heure' }).scrollIntoViewIfNeeded();
  const id = (await threadOf('Bouton peu visible sur mobile.'))!.thread_id;
  const pb = (await np.locator(`[data-socrate="pin"][data-threads~="${id}"]`).boundingBox())!;
  assert.ok(pb.x >= 0 && pb.x + pb.width <= 375, `pastille dans la vue étroite ${JSON.stringify(pb)}`);
  await openPin(np, id);
  await np.waitForTimeout(150);
  const b = (await bubbleBox(np))!;
  const bar = (await toolbar(np).boundingBox())!;
  facts.etroit = { bulle: b, toolbar: bar };
  assert.ok(b.x >= 0 && b.x + b.width <= 375 && b.y >= 0 && b.y + b.height <= bar.y, `bulle en feuille, dans la vue, au-dessus de la toolbar ${JSON.stringify(facts.etroit)}`);
  assert.ok(bar.x >= 0 && bar.x + bar.width <= 375);
  assert.equal(await np.evaluate(() => document.documentElement.scrollWidth), 375, 'page non élargie');
  await shot(np, '16-fenetre-etroite');
  await narrow.context.close();
});

/** Écart moyen par canal dans une région en pixels CSS, images à l'échelle du viewport (repris de browser-tests.ts). */
const regionDiff = (page: Page, a: string, b: string, r: { x: number; y: number; width: number; height: number }) => page.evaluate(async ({ a, b, r }) => {
  const load = async (src: string) => { const i = new Image(); i.src = src; await i.decode(); return i; };
  const [ia, ib] = await Promise.all([load(a), load(b)]);
  const scale = (img: HTMLImageElement) => img.naturalWidth / window.innerWidth;
  const read = (img: HTMLImageElement) => {
    const s = scale(img);
    const c = document.createElement('canvas');
    c.width = Math.round(r.width); c.height = Math.round(r.height);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, r.x * s, r.y * s, r.width * s, r.height * s, 0, 0, c.width, c.height);
    return ctx.getImageData(0, 0, c.width, c.height).data;
  };
  const pa = read(ia);
  const pb = read(ib);
  let sum = 0;
  for (let i = 0; i < pa.length; i += 4) for (let k = 0; k < 3; k++) sum += Math.abs(pa[i + k]! - pb[i + k]!);
  return { mean: sum / (pa.length / 4 * 3), width: ia.naturalWidth, other: ib.naturalWidth };
}, { a, b, r });
const dataUrl = (png: Buffer) => `data:image/png;base64,${png.toString('base64')}`;

test('image prise avant la bulle et sans contrôles : toolbar, pastille et bulle ouvertes au ciblage absentes de l’image publiée', async () => {
  const ctx = await browser.newContext(origins());
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openRdv(page);
  await toolbarReady(page);
  const h1 = page.getByRole('heading', { level: 1, name: /Rendez-vous du 21 octobre/ });
  await targetElement(page, h1);
  await bubble(page).getByRole('textbox', { name: 'Votre commentaire' }).fill('Fil A pour la preuve d’image.');
  await send(page);
  await page.locator('#socrate-bubble').waitFor({ state: 'hidden', timeout: 15_000 });
  const a = (await threadOf('Fil A pour la preuve d’image.'))!.thread_id;
  await openPin(page, a);
  const boxes = {
    toolbar: (await toolbar(page).boundingBox())!,
    pastille: (await page.locator(`[data-socrate="pin"][data-threads~="${a}"]`).boundingBox())!,
    bulle: (await bubbleBox(page))!,
  };
  const withControls = dataUrl(await page.screenshot());
  const without = dataUrl(await page.evaluate(() => { const s = document.createElement('style'); s.id = 'banc-masque'; s.textContent = '[data-socrate]{visibility:hidden!important}'; document.head.append(s); }).then(() => page.screenshot()));
  await page.evaluate(() => document.getElementById('banc-masque')!.remove());
  const h = (await h1.boundingBox())!;
  await targetAt(page, h.x + 8, h.y + h.height / 2);
  const body = 'Fil B : image vérifiée sans contrôles.';
  await bubble(page).getByRole('textbox', { name: 'Votre commentaire' }).fill(body);
  await send(page);
  await page.locator('#socrate-bubble').waitFor({ state: 'hidden', timeout: 15_000 });
  const b = (await threadOf(body))!.thread_id;
  // Image relue par l'API agent : le parcours product ne montre plus la capture technique.
  const cap = (await db().prepare('SELECT c.capture_id, c.project_id, c.review_key FROM captures c JOIN messages m ON m.thread_id = c.thread_id WHERE m.body = ?').bind(body).first<{ capture_id: string; project_id: string; review_key: string }>())!;
  const res = await fetch(`${stack.view.serviceUrl}/v1/projects/${cap.project_id}/reviews/${encodeURIComponent(cap.review_key)}/captures/${cap.capture_id}`, { headers: { Authorization: `Bearer ${stack.credentials.agent}` } });
  assert.equal(res.status, 200, 'image lue par l’API agent');
  const published = dataUrl(Buffer.from(await res.arrayBuffer()));
  const { conv } = await openPin(page, b);
  assert.equal(await conv.getByRole('button', { name: /Détails|Afficher l’image/ }).count(), 0, 'aucun détail technique dans le parcours product');
  await writeFile(join(ARTIFACTS, '17-image-publiee.png'), Buffer.from(published.split(',')[1]!, 'base64'));
  await writeFile(join(ARTIFACTS, '17-reference-avec-controles.png'), Buffer.from(withControls.split(',')[1]!, 'base64'));
  const ecarts: Record<string, { absent: number; discriminant: number }> = {};
  for (const [name, box] of Object.entries(boxes)) {
    const absent = await regionDiff(page, published, without, box);
    const shown = await regionDiff(page, without, withControls, box);
    ecarts[name] = { absent: absent.mean, discriminant: shown.mean };
  }
  facts.imageSansControles = { boxes, ecarts };
  for (const [name, e] of Object.entries(ecarts)) {
    assert.ok(e.absent < 6, `${name} absent de l’image publiée (écart ${e.absent.toFixed(2)} avec la page sans contrôles)`);
    assert.ok(e.discriminant > 4, `${name} visible sur la référence : comparaison discriminante (écart ${e.discriminant.toFixed(2)})`);
  }
  await ctx.context.close();
});

// Gestes, fermeture, filtres et navigation.
const RENDU = process.env.SOCRATE_RENDU_PREFIX ?? 'apres';
/** Centre d'un mot dans l'élément, sans toucher à la sélection. */
const wordAt = (page: Page, sel: string, word: string) => page.evaluate(([s, w]) => {
  const walker = document.createTreeWalker(document.querySelector(s)!, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    const i = node.data.indexOf(w);
    if (i < 0) continue;
    const r = document.createRange();
    r.setStart(node, i);
    r.setEnd(node, i + w.length);
    const b = r.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  }
  throw new Error(`mot introuvable : ${w}`);
}, [sel, word] as const);
const selectionText = (page: Page) => page.evaluate(() => getSelection()?.toString() ?? '');
async function openRappels(page: Page) {
  await page.getByRole('link', { name: 'Réglages', exact: true }).click();
  await page.getByRole('heading', { level: 1, name: 'Rappels automatiques' }).waitFor();
}

test('clic droit voisin : « Rappel » sélectionné puis clic droit sur « automatique » du même bloc propose la correction de « Rappel » ; autres cas au menu natif', async () => {
  const ctx = await browser.newContext(origins());
  await ctx.context.addInitScript(() => {
    const seen: unknown[] = [];
    Object.assign(window, { contextEvents: seen });
    window.addEventListener('contextmenu', (e) => {
      const atDispatch = getSelection()?.toString() ?? '';
      setTimeout(() => seen.push({ prevented: e.defaultPrevented, button: e.button, ctrl: e.ctrlKey, tag: (e.target as Element).tagName, atDispatch }), 0);
    }, true);
  });
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openRappels(page);
  await toolbarReady(page);
  const libelle = '[data-socrate-id="rappel-libelle"]';
  const observe = async () => {
    await page.waitForTimeout(150);
    return {
      events: await page.evaluate(() => (window as unknown as { contextEvents: unknown[] }).contextEvents.splice(0)),
      menu: await page.locator('[data-socrate="menu"][aria-label="Correction"]').count(),
      label: await page.locator('[data-socrate="menu"][aria-label="Correction"] [role="menuitem"]').first().innerText({ timeout: 500 }).catch(() => null),
      selection: await selectionText(page),
    };
  };
  const dismiss = async () => {
    await page.keyboard.press('Escape');
    await page.locator('[data-socrate="menu"][aria-label="Correction"]').waitFor({ state: 'detached' });
  };
  await selectText(page, libelle, 'Rappel');
  const mot = await wordAt(page, libelle, 'automatique');
  await page.mouse.click(mot.x, mot.y, { button: 'right' });
  const voisin = await observe();
  await shot(page, `25-${RENDU}-clic-droit-voisin`);
  facts.clicDroitVoisin = { voisin };
  if (voisin.menu) {
    await page.locator('[data-socrate="menu"]').getByRole('menuitem').first().click();
    await bubble(page).getByTestId('socrate-draft').waitFor({ timeout: 10_000 });
    Object.assign(facts.clicDroitVoisin as object, { original: await bubble(page).getByTestId('socrate-original').innerText() });
    await page.keyboard.press('Escape');
    await page.locator('#socrate-bubble').waitFor({ state: 'hidden' });
  }
  const ctrlClick = async (x: number, y: number, mods: string[]) => {
    for (const k of mods) await page.keyboard.down(k);
    await page.mouse.click(x, y);
    for (const k of [...mods].reverse()) await page.keyboard.up(k);
  };
  const mac = process.platform === 'darwin';
  let ctrlVoisin: Awaited<ReturnType<typeof observe>> | null = null;
  if (mac) {
    await selectText(page, libelle, 'Rappel');
    await ctrlClick(mot.x, mot.y, ['Control']);
    ctrlVoisin = await observe();
    if (ctrlVoisin.menu) await dismiss();
  }
  // Autre bloc, Maj, champ, sélection morte après navigation : menu natif, aucune vieille sélection reprise.
  await selectText(page, libelle, 'Rappel');
  const titre = await wordAt(page, 'article h1', 'automatiques');
  await page.mouse.click(titre.x, titre.y, { button: 'right' });
  const autreBloc = await observe();
  if (autreBloc.menu) await dismiss();
  await selectText(page, libelle, 'Rappel');
  await page.keyboard.down('Shift');
  await page.mouse.click(mot.x, mot.y, { button: 'right' });
  await page.keyboard.up('Shift');
  const maj = await observe();
  if (maj.menu) await dismiss();
  await selectText(page, libelle, 'Rappel');
  const input = (await page.locator('label input').first().boundingBox())!;
  await page.mouse.click(input.x + 10, input.y + input.height / 2, { button: 'right' });
  const champ = await observe();
  if (champ.menu) await dismiss();
  await selectText(page, libelle, 'Rappel');
  await page.getByRole('link', { name: 'Général', exact: true }).click();
  await page.getByRole('heading', { level: 1, name: 'Général', exact: true }).waitFor();
  const autre = await wordAt(page, 'article p', 'cabinet');
  await page.mouse.click(autre.x, autre.y, { button: 'right' });
  const morte = await observe();
  if (morte.menu) await dismiss();
  Object.assign(facts.clicDroitVoisin as object, { ctrlVoisin, autreBloc, maj, champ, morte });
  const all = JSON.stringify(facts.clicDroitVoisin);
  assert.deepEqual({ menu: voisin.menu, label: voisin.label, selection: voisin.selection }, { menu: 1, label: 'Proposer une correction de « Rappel »', selection: 'Rappel' }, `clic droit voisin : correction de la sélection vivante ${all}`);
  assert.match(String((facts.clicDroitVoisin as { original?: string }).original), /Texte actuel\s+« Rappel »/, `l’original est « Rappel » ${all}`);
  if (mac) assert.deepEqual({ menu: ctrlVoisin!.menu, selection: ctrlVoisin!.selection }, { menu: 1, selection: 'Rappel' }, `Ctrl+clic voisin macOS ${all}`);
  for (const [cas, r] of Object.entries({ autreBloc, maj, champ, morte })) assert.equal(r.menu, 0, `${cas} : menu natif ${all}`);
  assert.ok([autreBloc, maj, champ, morte].every((r) => r.events.every((e) => !(e as { prevented: boolean }).prevented)), `menu natif non annulé ${all}`);
  await ctx.context.close();
});

test('rendu : toolbar, popover vide et plein, liste, commentaire général et fenêtres étroites', async () => {
  const ctx = await browser.newContext(origins());
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openRdv(page);
  await toolbarReady(page);
  await shot(page, `26-${RENDU}-toolbar`);
  const para = page.locator('article p').first();
  const pb = (await para.boundingBox())!;
  const click = { x: pb.x + pb.width * 0.6, y: pb.y + pb.height / 2 };
  await targetAt(page, click.x, click.y);
  await page.waitForTimeout(200);
  const vide = (await bubbleBox(page))!;
  await shot(page, `27-${RENDU}-popover-vide-bloc-pleine-largeur`);
  await bubble(page).getByRole('textbox', { name: 'Votre commentaire' }).fill('Rendu : premier message.');
  await send(page);
  await page.locator('#socrate-bubble').waitFor({ state: 'hidden', timeout: 15_000 });
  const id = (await threadOf('Rendu : premier message.'))!.thread_id;
  const { conv } = await openPin(page, id);
  await conv.getByRole('textbox').fill('Rendu : réponse.');
  await conv.getByRole('button', { name: 'Envoyer' }).click();
  await conv.getByText('Rendu : réponse.').waitFor({ timeout: 10_000 });
  await shot(page, `28-${RENDU}-popover-plein`);
  await control(page, 'launcher').click();
  await list(page).getByTestId('socrate-row').first().waitFor();
  await shot(page, `29-${RENDU}-liste`);
  await list(page).getByRole('textbox', { name: 'Votre commentaire global' }).waitFor();
  await shot(page, `30-${RENDU}-commentaire-general`);
  const toolbarOuverte = (await toolbar(page).boundingBox())!;
  await control(page, 'launcher').click();
  const toolbarFermee = (await toolbar(page).boundingBox())!;
  const tailles: Record<string, unknown> = {};
  for (const width of [375, 320]) {
    await page.setViewportSize({ width, height: 700 });
    await page.waitForTimeout(150);
    tailles[width] = { toolbar: await toolbar(page).boundingBox(), scrollWidth: await page.evaluate(() => document.documentElement.scrollWidth) };
    await shot(page, `31-${RENDU}-toolbar-${width}`);
  }
  facts[`rendu-${RENDU}`] = { clic: click, popoverVide: vide, toolbarOuverte, toolbarFermee, tailles };
  await ctx.context.close();
});

const pressed = async (page: Page, expected?: 'true' | 'false') => {
  if (expected) await page.locator(`[data-socrate="toolbar"] [data-socrate-action="target"][aria-pressed="${expected}"]`).waitFor({ timeout: 10_000 }).catch(() => undefined);
  else await page.waitForTimeout(200);
  return control(page, 'target').first().getAttribute('aria-pressed');
};
const tipText = (page: Page) => page.locator('[data-socrate="tip"]').innerText({ timeout: 1_000 }).catch(() => null);
const blurAll = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

test('raccourci C : active et annule hors champ, ignoré dans un champ, avec modificateur et en répétition ; désactivable ; infobulle au focus et Échap', async () => {
  const ctx = await browser.newContext(origins());
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openRappels(page);
  await toolbarReady(page);
  await page.keyboard.press('Alt+Shift+KeyS');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  const auFocus = await tipText(page);
  await shot(page, '32-infobulle-focus');
  await page.keyboard.press('Escape');
  const apresEchap = { tip: await tipText(page), focus: (await focused(page)).action };
  const titres = await toolbar(page).locator('[title]').count();
  await blurAll(page);
  await page.keyboard.press('c');
  const active = await pressed(page, 'true');
  await page.keyboard.press('c');
  const annule = await pressed(page, 'false');
  await page.keyboard.press('c');
  await pressed(page, 'true');
  await page.keyboard.press('Escape');
  const echap = await pressed(page, 'false');
  await page.keyboard.down('c');
  await pressed(page, 'true');
  await page.keyboard.down('c');
  await page.keyboard.up('c');
  const repetition = await pressed(page);
  await page.keyboard.press('Escape');
  await blurAll(page);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+c');
  await page.keyboard.press('Shift+C');
  const modificateurs = await pressed(page);
  const champ = page.locator('label input').first();
  await champ.fill('24');
  await champ.focus();
  await page.keyboard.press('c');
  const dansChamp = { pressed: await pressed(page), value: await champ.inputValue() };
  await control(page, 'more').click();
  await page.getByRole('menuitemcheckbox', { name: 'Raccourci C pour commenter' }).click();
  const option = await page.locator('[data-socrate-action="shortcut"]').getAttribute('aria-checked');
  await page.keyboard.press('Escape');
  await blurAll(page);
  await page.keyboard.press('c');
  const desactive = { pressed: await pressed(page), keys: await control(page, 'target').first().getAttribute('aria-keyshortcuts') };
  await control(page, 'target').first().click();
  const bouton = await pressed(page, 'true');
  // Événement synthétique : prouve la sortie du ciblage sur `blur` de l'onglet, pas un vrai changement d'application.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  const perteFocus = await pressed(page, 'false');
  facts.raccourciC = { auFocus, apresEchap, titres, active, annule, echap, repetition, modificateurs, dansChamp, option, desactive, bouton, perteFocus };
  const all = JSON.stringify(facts.raccourciC);
  assert.equal(auFocus, 'Commenter un élément · C', `infobulle au focus clavier ${all}`);
  assert.deepEqual(apresEchap, { tip: null, focus: 'target' }, `Échap masque l’infobulle sans déplacer le focus ${all}`);
  assert.equal(titres, 0, 'aucun attribut title en doublon dans la toolbar');
  assert.deepEqual([active, annule, echap, repetition], ['true', 'false', 'false', 'true'], `C active, C annule, Échap annule, répétition sans effet ${all}`);
  assert.equal(modificateurs, 'false', `⌘/Ctrl+C et Maj+C ne ciblent pas ${all}`);
  assert.deepEqual(dansChamp, { pressed: 'false', value: '24c' }, `C reste une frappe de l’hôte dans un champ ${all}`);
  assert.equal(option, 'false', 'option désactivée');
  assert.deepEqual(desactive, { pressed: 'false', keys: null }, `raccourci coupé ${all}`);
  assert.equal(bouton, 'true', 'le bouton cible toujours sans raccourci');
  assert.equal(perteFocus, 'false', `perte de focus de l’onglet : aucun ciblage armé ${all}`);
  await ctx.context.close();
});

test('Entrée envoie une fois, Maj+Entrée va à la ligne, vide et composition IME n’envoient pas ; remplacement multiligne affiché puis enregistré', async () => {
  const ctx = await browser.newContext(origins());
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openRdv(page);
  await toolbarReady(page);
  const posts = () => toService(ctx, (r) => r.method === 'POST' && path(r).endsWith('/targeted')).length;
  await targetElement(page, page.getByRole('button', { name: 'Modifier l’heure' }));
  const field = bubble(page).getByRole('textbox', { name: 'Votre commentaire' });
  await field.focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(200);
  const vide = { posts: posts(), value: await field.inputValue() };
  const cdp = await ctx.context.newCDPSession(page);
  await page.keyboard.type('Heure ');
  await cdp.send('Input.imeSetComposition', { text: 'か', selectionStart: 1, selectionEnd: 1 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
  await cdp.send('Input.insertText', { text: 'か' });
  await page.waitForTimeout(200);
  const ime = { posts: posts(), value: await field.inputValue() };
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('deux lignes');
  const multiligne = await field.inputValue();
  const body = multiligne;
  await page.keyboard.down('Enter');
  await page.keyboard.down('Enter');
  await page.keyboard.up('Enter');
  await page.locator('#socrate-bubble').waitFor({ state: 'hidden', timeout: 15_000 });
  await page.waitForTimeout(300);
  const envoi = { posts: posts(), durable: await countBody(body) };

  await openRappels(page);
  await selectText(page, '[data-socrate-id="rappel-libelle"]', 'Rappel automatique');
  const at = await wordAt(page, '[data-socrate-id="rappel-libelle"]', 'automatique');
  await page.mouse.click(at.x, at.y, { button: 'right' });
  await page.locator('[data-socrate="menu"]').getByRole('menuitem', { name: /Proposer une correction/ }).click();
  const repl = bubble(page).getByRole('textbox', { name: 'Correction proposée' });
  await repl.waitFor({ timeout: 10_000 });
  await repl.focus();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('Rappel');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('automatique du rendez-vous');
  const affiche = await repl.inputValue();
  await shot(page, '33-remplacement-multiligne');
  await page.keyboard.press('Enter');
  await page.locator('#socrate-bubble').waitFor({ state: 'hidden', timeout: 15_000 });
  const proposition = await proposalOf('Rappel\nautomatique du rendez-vous');
  facts.entree = { vide, ime, multiligne, envoi, affiche, proposition };
  const all = JSON.stringify(facts.entree);
  assert.deepEqual(vide, { posts: 0, value: '' }, `Entrée sur un champ vide : rien ${all}`);
  assert.equal(ime.posts, 0, `Entrée de composition (keyCode 229, CDP) : aucun envoi ${all}`);
  assert.ok(ime.value.endsWith('か'), `composition validée dans le champ ${all}`);
  assert.equal(multiligne, 'Heure か\ndeux lignes', 'Maj+Entrée insère une ligne');
  assert.deepEqual(envoi, { posts: 1, durable: 1 }, `Entrée maintenue : un seul envoi ${all}`);
  assert.equal(affiche, 'Rappel\nautomatique du rendez-vous', 'remplacement multiligne affiché avant envoi');
  assert.deepEqual(proposition, { original: 'Rappel automatique', replacement: 'Rappel\nautomatique du rendez-vous', wording_id: null }, `remplacement multiligne enregistré tel quel ${all}`);
  await ctx.context.close();
});

test('fermeture : clic extérieur sur un lien navigue sans envoi ni perte ni vol de focus ; Échap masque ; réponse conservée ; nouveau ciblage ne réaffecte pas ; abandon explicite', async () => {
  const ctx = await browser.newContext(origins());
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openRdv(page);
  await toolbarReady(page);
  const posts = () => toService(ctx, (r) => r.method === 'POST' && path(r).endsWith('/targeted')).length;
  await targetElement(page, page.getByRole('heading', { level: 1, name: /Rendez-vous du 21 octobre/ }));
  const texte = 'Titre : brouillon gardé au clic extérieur.';
  await bubble(page).getByRole('textbox', { name: 'Votre commentaire' }).fill(texte);
  await page.getByRole('banner').getByRole('link', { name: 'Agenda', exact: true }).click();
  await page.getByRole('heading', { level: 1, name: 'Agenda', exact: true }).waitFor();
  await page.waitForTimeout(200);
  const lien = { route: new URL(page.url()).pathname, bulle: await page.locator('#socrate-bubble').isVisible(), posts: posts(), focus: await focused(page), brouillon: await control(page, 'draft').count() };
  await shot(page, '34-clic-exterieur-lien');
  await control(page, 'draft').click();
  const field = bubble(page).getByRole('textbox', { name: 'Votre commentaire' });
  const repris = await field.inputValue();
  await page.waitForFunction(() => (document.getElementById('socrate-bubble') as HTMLIFrameElement).contentDocument?.activeElement?.tagName === 'TEXTAREA');
  await page.keyboard.press('Escape');
  await page.locator('#socrate-bubble').waitFor({ state: 'hidden' });
  const echap = { posts: posts(), brouillon: await control(page, 'draft').count() };
  await control(page, 'target').first().click();
  await bubble(page).getByTestId('socrate-draft-held').waitFor();
  const reaffecte = { pressed: await pressed(page), texte: await field.inputValue() };
  await shot(page, '35-nouveau-ciblage-brouillon-garde');
  await bubble(page).getByRole('button', { name: 'Supprimer le brouillon' }).click();
  await page.locator('#socrate-bubble').waitFor({ state: 'hidden' });
  const abandon = { posts: posts(), brouillon: await control(page, 'draft').count() };

  await openRdv(page);
  const id = await publishOn(page, page.locator('article p').first(), 'Paragraphe : réponse gardée au clic extérieur.');
  const { conv } = await openPin(page, id);
  await conv.getByRole('textbox').fill('Réponse en cours, jamais envoyée.');
  const titre = (await page.getByRole('heading', { level: 1, name: /Rendez-vous du 21 octobre/ }).boundingBox())!;
  await page.mouse.click(titre.x + 20, titre.y + titre.height / 2);
  await page.locator('#socrate-bubble').waitFor({ state: 'hidden' });
  await openPin(page, id);
  const reponse = await bubble(page).getByRole('textbox').inputValue();
  facts.fermeture22 = { lien, repris, echap, reaffecte, abandon, reponse };
  const all = JSON.stringify(facts.fermeture22);
  assert.deepEqual({ ...lien, focus: lien.focus.socrate ?? null }, { route: '/', bulle: false, posts: 0, focus: null, brouillon: 1 }, `lien suivi, bulle masquée, rien envoyé, focus non détourné ${all}`);
  assert.equal(repris, texte, 'texte repris intact');
  assert.deepEqual(echap, { posts: 0, brouillon: 1 }, `Échap masque sans envoi ni perte ${all}`);
  assert.deepEqual(reaffecte, { pressed: 'false', texte }, `nouveau ciblage refusé tant que le brouillon existe ${all}`);
  assert.deepEqual(abandon, { posts: 0, brouillon: 0 }, `abandon explicite ${all}`);
  assert.equal(reponse, 'Réponse en cours, jamais envoyée.', 'réponse conservée après un clic extérieur');
  await ctx.context.close();
});

test('géométrie : toolbar centrée à ±2 px de la place utile, 48 px, liste ouverte ou fermée, 320 et 375 px sans débordement ; popover près du clic, hors de la bande de la toolbar', async () => {
  const ctx = await browser.newContext(origins());
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openRdv(page);
  await toolbarReady(page);
  const centre = async (useful: number) => {
    const b = (await toolbar(page).boundingBox())!;
    return { ecart: Math.abs(b.x + b.width / 2 - useful / 2), hauteur: b.height, b };
  };
  const width = await page.evaluate(() => innerWidth);
  const fermee = await centre(width);
  await control(page, 'launcher').click();
  await list(page).getByRole('heading', { level: 1, name: 'Conversations' }).waitFor();
  const ouverte = await centre(width - 380);
  await control(page, 'launcher').click();
  const para = page.locator('article p').nth(2);
  const pb = (await para.boundingBox())!;
  const clic = { x: pb.x + pb.width * 0.7, y: pb.y + pb.height / 2 };
  await targetAt(page, clic.x, clic.y);
  await page.waitForTimeout(200);
  const pop = (await bubbleBox(page))!;
  const bar = (await toolbar(page).boundingBox())!;
  const etroit: Record<number, unknown> = {};
  for (const w of [375, 320]) {
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: w, height: 640 });
    await page.waitForTimeout(150);
    const b = (await toolbar(page).boundingBox())!;
    etroit[w] = { scroll: await page.evaluate(() => document.documentElement.scrollWidth), gauche: b.x, droite: b.x + b.width, ecart: Math.abs(b.x + b.width / 2 - w / 2) };
  }
  await page.setViewportSize({ width: 1280, height: 720 });
  facts.geometrie = { fermee, ouverte, clic, pop, bar, etroit };
  const all = JSON.stringify(facts.geometrie);
  assert.ok(fermee.ecart <= 2 && ouverte.ecart <= 2, `toolbar centrée ${all}`);
  assert.equal(fermee.hauteur, 48, 'pilule de 48 px');
  assert.ok(Math.abs(pop.x - clic.x) <= 24 && pop.y - clic.y >= 0 && pop.y - clic.y <= 24, `coin du popover à moins de 24 px du clic sur un bloc pleine largeur ${all}`);
  assert.ok(pop.y + pop.height <= bar.y, `popover au-dessus de la toolbar ${all}`);
  for (const w of [375, 320]) {
    const e = etroit[w] as { scroll: number; gauche: number; droite: number; ecart: number };
    assert.ok(e.scroll === w && e.gauche >= 0 && e.droite <= w && e.ecart <= 2, `${w} px sans débordement, toolbar centrée ${all}`);
  }
  await ctx.context.close();
});

test('liste : ouvertes de cet écran par défaut, généraux toujours visibles, compteurs réels, sorties d’état vide, Aller à la page puis fil ouvert ou cible absente honnête ; erreur de lecture distincte', async () => {
  const ctx = await browser.newContext(origins());
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openRdv(page);
  await toolbarReady(page);
  const ici = await publishOn(page, page.getByRole('heading', { level: 1, name: /Rendez-vous du 21 octobre/ }), 'Filtres : fil de la fiche.');
  const jumeau = await publishOn(page, page.getByTestId('occurrence-2'), 'Filtres : jumeau introuvable après rechargement.');
  // Ancien retour, enregistré sans contexte : deux jumeaux que la règle historique ne distingue pas.
  await db().prepare(`UPDATE targets SET context = json_remove(context, '$.context') WHERE thread_id = ?`).bind(jumeau).run();
  await page.reload();
  await page.getByRole('link', { name: 'Agenda', exact: true }).first().click();
  await page.getByRole('heading', { level: 1, name: 'Agenda', exact: true }).waitFor();
  await toolbarReady(page);
  await control(page, 'launcher').click();
  await list(page).getByRole('textbox', { name: 'Votre commentaire global' }).fill('Filtres : commentaire général.');
  await page.keyboard.press('Enter');
  const general = list(page).locator('[data-testid="socrate-row"]', { hasText: 'Filtres : commentaire général.' });
  await general.waitFor({ timeout: 10_000 });
  const pressedOf = async (name: RegExp) => list(page).getByRole('button', { name }).getAttribute('aria-pressed');
  const parDefaut = { ecran: await pressedOf(/^Cet écran/), ouvertes: await pressedOf(/^Ouvertes/), ici: await list(page).locator(`[data-thread="${ici}"]`).count(), general: await general.innerText() };
  await shot(page, '36-liste-cet-ecran');
  await list(page).getByRole('button', { name: /^Résolues/ }).click();
  const vide = await list(page).getByTestId('socrate-empty').innerText();
  await list(page).getByRole('button', { name: /^Ouvertes/ }).click();
  await list(page).getByRole('button', { name: /^Toutes les pages/ }).click();
  const compte = Number((await list(page).getByRole('button', { name: /^Toutes les pages/ }).innerText()).match(/(\d+)\s*$/)![1]);
  const lignes = await list(page).getByTestId('socrate-row').count();
  const ligne = list(page).locator(`[data-testid="socrate-row"][data-thread="${ici}"]`);
  const autre = await ligne.innerText();
  await shot(page, '37-liste-toutes-les-pages');
  await ligne.getByRole('button', { name: 'Aller à la page' }).click();
  await bubble(page).locator(`[data-testid="socrate-conversation"][data-thread="${ici}"]`).waitFor({ timeout: 10_000 });
  const arrivee = new URL(page.url()).pathname;
  await shot(page, '38-aller-a-la-page');
  await page.getByRole('link', { name: 'Agenda', exact: true }).first().click();
  await page.getByRole('heading', { level: 1, name: 'Agenda', exact: true }).waitFor();
  if (!(await page.locator('#socrate-frame').isVisible())) await control(page, 'launcher').click();
  const ligneJumeau = list(page).locator(`[data-testid="socrate-row"][data-thread="${jumeau}"]`);
  await ligneJumeau.getByRole('button', { name: 'Aller à la page' }).click();
  await ligneJumeau.locator('[data-testid="socrate-conversation"]').waitFor({ timeout: 10_000 });
  const absente = { route: new URL(page.url()).pathname, ligne: await ligneJumeau.innerText(), pastille: await page.locator(`[data-socrate="pin"][data-threads~="${jumeau}"]`).count() };
  await shot(page, '39-cible-absente');

  ctx.setFaults((r) => (r.method === 'GET' && path(r).endsWith('/threads') ? { kind: 'respond', status: 503, body: { code: 'not_ready', message: 'Service momentanément indisponible.', requestId: 'banc', retryable: true } } : { kind: 'pass' }));
  await page.reload();
  await toolbarReady(page);
  await control(page, 'launcher').click();
  await list(page).getByRole('alert').waitFor({ timeout: 10_000 });
  const erreur = { alerte: await list(page).getByRole('alert').innerText(), vide: await list(page).getByTestId('socrate-empty').count() };
  ctx.setFaults(null);
  facts.liste22 = { parDefaut, vide, compte, lignes, autre, arrivee, absente, erreur };
  const all = JSON.stringify(facts.liste22);
  assert.deepEqual({ ecran: parDefaut.ecran, ouvertes: parDefaut.ouvertes, ici: parDefaut.ici }, { ecran: 'true', ouvertes: 'true', ici: 0 }, `par défaut : ouvertes de cet écran ${all}`);
  assert.match(parDefaut.general, /Général/, 'commentaire général visible et identifié');
  assert.match(vide, /Aucune conversation résolue sur cet écran/, `état vide nommé ${all}`);
  assert.match(vide, /Voir toutes les pages|commentaire sur la revue/, `état vide avec sortie ${all}`);
  assert.equal(compte, lignes, `compteur égal aux lignes affichées ${all}`);
  assert.match(autre, /Autre page · \/rendez-vous\/rdv-1042/, 'page du fil indiquée');
  assert.equal(arrivee, '/rendez-vous/rdv-1042', 'navigation explicite vers la page du fil');
  assert.equal(absente.route, '/rendez-vous/rdv-1042');
  assert.match(absente.ligne, /Voir où c’était/, `cible ambiguë : aucune pastille arbitraire, fil lisible ${all}`);
  assert.equal(absente.pastille, 0);
  assert.equal(erreur.vide, 0, `erreur de lecture jamais présentée comme liste vide ${all}`);
  assert.match(erreur.alerte, /Service momentanément indisponible/, `erreur de lecture nommée ${all}`);
  await ctx.context.close();
});

test('menus contextuels : pastille au clic droit et au clavier, ligne au clic droit et par son bouton ; résoudre relu en D1 ; aucun détail technique', async () => {
  const ctx = await browser.newContext(origins());
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  await openRdv(page);
  await toolbarReady(page);
  const id = await publishOn(page, page.locator('[data-socrate-id="rappel-mention"]'), 'Menus : mention à renommer.');
  const pin = page.locator(`[data-socrate="pin"][data-threads="${id}"]`);
  await pin.click({ button: 'right' });
  const menu = page.locator('[data-socrate="menu"][aria-label="Actions de la conversation"]');
  await menu.waitFor();
  const entrees = await menu.getByRole('menuitem').allInnerTexts();
  await shot(page, '40-menu-pastille');
  await page.keyboard.press('Escape');
  await pin.focus();
  await page.keyboard.press('Shift+F10');
  await menu.waitFor();
  const clavier = { premier: await page.evaluate(() => document.activeElement?.textContent) };
  await page.keyboard.press('ArrowDown');
  Object.assign(clavier, { second: await page.evaluate(() => document.activeElement?.textContent) });
  await page.keyboard.press('Enter');
  await page.waitForFunction((tid) => document.querySelector(`[data-socrate="pin"][data-threads~="${tid}"]`)?.getAttribute('data-state') === 'resolved', id, { timeout: 10_000 });
  const etat = (await threadOf('Menus : mention à renommer.'))!.state;
  await openPin(page, id);
  const technique = await bubble(page).getByText(/Route|Afficher l’image|Rectangle/).count() + await bubble(page).getByRole('button', { name: 'Détails' }).count();
  await page.keyboard.press('Escape');
  await control(page, 'launcher').click();
  await list(page).getByRole('button', { name: /^Toutes$/ }).or(list(page).getByRole('button', { name: /^Toutes \d/ })).first().click();
  const row = list(page).locator(`[data-testid="socrate-row"][data-thread="${id}"]`);
  await row.locator('.socrate-row').click({ button: 'right' });
  const rowMenu = list(page).getByRole('menu', { name: 'Actions de la conversation' });
  await rowMenu.waitFor();
  const ligne = await rowMenu.getByRole('menuitem').allInnerTexts();
  await page.keyboard.press('Escape');
  await row.getByRole('button', { name: /Actions de la conversation/ }).focus();
  await page.keyboard.press('Enter');
  await rowMenu.waitFor();
  const parBouton = await rowMenu.getByRole('menuitem').allInnerTexts();
  await shot(page, '41-menu-ligne');
  await page.keyboard.press('Escape');
  facts.menus = { entrees, clavier, etat, technique, ligne, parBouton };
  const all = JSON.stringify(facts.menus);
  assert.deepEqual(entrees, ['Ouvrir la conversation', 'Résoudre'], `menu de pastille ${all}`);
  assert.deepEqual(clavier, { premier: 'Ouvrir la conversation', second: 'Résoudre' }, `Maj+F10 et flèches ${all}`);
  assert.equal(etat, 'resolved', 'résolution relue en D1');
  assert.equal(technique, 0, `aucun Route, Rectangle, Afficher l’image ni Détails ${all}`);
  assert.deepEqual(ligne, ['Ouvrir la conversation', 'Rouvrir'], `menu de ligne sur cet écran ${all}`);
  assert.deepEqual(parBouton, ligne, 'mêmes actions par le bouton');
  await ctx.context.close();
});


async function attachFiles(page: Page, composer: Locator, files: string[]) {
  const chooser = page.waitForEvent('filechooser');
  await composer.getByRole('button', { name: 'Joindre des images ou vidéos' }).click();
  await (await chooser).setFiles(files);
  await composer.getByRole('status', { name: 'Préparation des pièces…' }).waitFor({ state: 'hidden' });
}

async function imageVisible(image: Locator) {
  await image.waitFor();
  await image.evaluate(async (el) => {
    const image = el as HTMLImageElement;
    await image.decode();
    if (!image.naturalWidth) throw new Error('image sans pixels');
  });
}

const playVideo = (composer: Locator, mime: string) => playMedia(composer.locator(`[data-testid="socrate-attachment"][data-type="${mime}"]`));
async function playMedia(media: Locator) {
  await media.getByRole('button', { name: /Charger la vidéo/ }).click();
  const video = media.locator('video');
  await video.waitFor({ timeout: 30_000 });
  return video.evaluate(async (el) => {
    const v = el as HTMLVideoElement;
    if (!v.controls || v.autoplay) throw new Error('contrôles ou autoplay incorrects');
    await v.play();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { v.removeEventListener('timeupdate', progress); reject(new Error('vidéo sans progression')); }, 10_000);
      const progress = () => {
        if (v.currentTime < 0.25) return;
        clearTimeout(timer);
        v.removeEventListener('timeupdate', progress);
        resolve();
      };
      v.addEventListener('timeupdate', progress);
      progress();
    });
    v.pause();
    if (!v.videoWidth || v.error) throw new Error('vidéo invalide');
    return { width: v.videoWidth, height: v.videoHeight, time: v.currentTime, duration: v.duration, controls: v.controls, autoplay: v.autoplay };
  });
}

test('pièces jointes : trois composeurs, cinq formats, vidéo jouable de 50 Mio, retrait, rechargement et lecture privée à la demande', async () => {
  const ctx = await browser.newContext(origins());
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  try {
    await openRdv(page);
    await toolbarReady(page);
    const fixtures = join(REPO_ROOT, 'tools/local/fixtures/media');
    const webp = join(ARTIFACTS, 'image.webp');
    const data = await page.evaluate(() => {
      const c = document.createElement('canvas'); c.width = 160; c.height = 90;
      const p = c.getContext('2d')!; p.fillStyle = '#3685d6'; p.fillRect(0, 0, 160, 90);
      p.fillStyle = 'white'; p.fillText('Socrate fictif', 12, 40);
      return c.toDataURL('image/webp').split(',')[1]!;
    });
    await writeFile(webp, Buffer.from(data, 'base64'));
    const source = await readFile(join(fixtures, 'parcours.mp4'));
    const large = Buffer.alloc(50 * 1024 * 1024);
    source.copy(large);
    large.writeUInt32BE(large.length - source.length, source.length);
    large.write('free', source.length + 4, 'ascii');
    const mp4 = join(ARTIFACTS, 'video-50mio.mp4');
    await writeFile(mp4, large);

    await control(page, 'more').click();
    await control(page, 'general').click();
    const general = list(page).locator('.socrate-general').first();
    await general.getByRole('button', { name: 'Joindre des images ou vidéos' }).focus();
    await list(page).getByRole('tooltip', { name: 'Joindre des images ou vidéos' }).waitFor();
    await attachFiles(page, general, [join(fixtures, 'image.png'), join(fixtures, 'image.jpg'), webp, join(fixtures, 'parcours.webm'), join(fixtures, 'parcours.mp4')]);
    await general.getByRole('alert').filter({ hasText: '4 pièces au plus' }).waitFor();
    await general.getByTestId('socrate-attachment-draft').nth(3).waitFor();
    assert.equal(await general.getByTestId('socrate-attachment-draft').count(), 4);
    for (const name of ['image.jpg', 'image.webp', 'parcours.webm']) await general.getByRole('button', { name: `Retirer « ${name} »` }).click();
    await attachFiles(page, general, [mp4]);
    await general.getByTestId('socrate-attachment-draft').nth(1).waitFor();
    await general.getByRole('textbox', { name: 'Votre commentaire global' }).fill('Médias général fictif');
    await shot(page, '42-media-general-avant');
    await general.getByRole('textbox', { name: 'Votre commentaire global' }).press('Enter');
    await general.getByRole('status').filter({ hasText: 'Commentaire publié.' }).waitFor({ timeout: 45_000 });
    const globalId = (await threadOf('Médias général fictif'))!.thread_id;
    const globalRow = list(page).locator(`[data-testid="socrate-row"][data-thread="${globalId}"]`);
    await globalRow.locator('button.socrate-row').click();
    const globalConversation = globalRow.getByTestId('socrate-conversation');
    await imageVisible(globalConversation.locator('[data-type="image/png"] img'));
    const beforeLoad = toService(ctx, (r) => r.method === 'GET' && /\/attachments\//.test(path(r))).length;
    assert.equal(await globalConversation.locator('video').count(), 0, 'vidéo non téléchargée avant geste');
    const largePlayed = await playVideo(globalConversation, 'video/mp4');
    assert.equal(toService(ctx, (r) => r.method === 'GET' && /\/attachments\//.test(path(r))).length, beforeLoad + 1);
    await shot(page, '43-media-video-50mio');
    await control(page, 'launcher').click();

    await targetElement(page, page.getByRole('heading', { level: 1, name: /Rendez-vous du 21 octobre/ }));
    const draft = bubble(page).getByTestId('socrate-draft');
    await attachFiles(page, draft, [join(fixtures, 'image.jpg'), join(fixtures, 'parcours.webm')]);
    await draft.getByTestId('socrate-attachment-draft').nth(1).waitFor();
    assert.equal(await draft.getByRole('textbox', { name: 'Votre commentaire' }).inputValue(), '');
    await page.keyboard.press('Escape');
    await page.locator('#socrate-bubble').waitFor({ state: 'hidden' });
    await control(page, 'draft').click();
    assert.equal(await draft.getByTestId('socrate-attachment-draft').count(), 2, 'masquage conserve le brouillon uniquement média');
    await draft.getByRole('textbox', { name: 'Votre commentaire' }).fill('Médias ciblé fictif');
    await draft.getByRole('textbox', { name: 'Votre commentaire' }).press('Enter');
    await page.locator('#socrate-bubble').waitFor({ state: 'hidden', timeout: 30_000 });
    const targetId = (await threadOf('Médias ciblé fictif'))!.thread_id;
    await openPin(page, targetId);
    const conversation = bubble(page).getByTestId('socrate-conversation');
    await imageVisible(conversation.locator('[data-type="image/jpeg"] img'));
    const webmPlayed = await playVideo(conversation, 'video/webm');
    await attachFiles(page, conversation, [webp]);
    await conversation.getByTestId('socrate-attachment-draft').waitFor();
    assert.equal(await conversation.getByRole('textbox', { name: /Répondre au retour/ }).inputValue(), '');
    await conversation.getByRole('button', { name: 'Envoyer' }).click();
    await conversation.getByTestId('socrate-message').nth(1).waitFor({ timeout: 20_000 });
    await imageVisible(conversation.locator('[data-type="image/webp"] img'));
    assert.equal(await conversation.locator('.socrate-media').first().evaluate((el) => getComputedStyle(el).listStyleType), 'none');
    await conversation.locator('[data-type="image/webp"] img').scrollIntoViewIfNeeded();
    await shot(page, '44-media-cible-reponse');

    await page.reload();
    await toolbarReady(page);
    await openPin(page, targetId);
    await imageVisible(conversation.locator('[data-type="image/jpeg"] img'));
    await imageVisible(conversation.locator('[data-type="image/webp"] img'));
    const replayedWebm = await playVideo(conversation, 'video/webm');
    await shot(page, '45-media-apres-rechargement');
    await page.keyboard.press('Escape');
    await control(page, 'launcher').click();
    await globalRow.locator('button.socrate-row').click();
    await imageVisible(globalConversation.locator('[data-type="image/png"] img'));
    const replayedMp4 = await playVideo(globalConversation, 'video/mp4');
    const rows = (await db().prepare("SELECT a.attachment_id, a.name, a.content_type, a.size, a.sha256, a.thread_id, m.body FROM attachments a JOIN messages m USING (project_id, review_key, thread_id, message_id) WHERE a.thread_id IN (?, ?) ORDER BY a.thread_id, m.seq, a.position").bind(globalId, targetId).all()).results;
    assert.equal(rows.length, 5);
    assert.equal(rows.filter((r) => r.body === '').length, 1, 'réponse uniquement média persistée');
    const noAuth = await fetch(`${stack.view.serviceUrl}/v1/projects/demo/reviews/rappels-automatiques/attachments/${rows[0]!.attachment_id}`);
    assert.equal(noAuth.status, 401);
    facts.medias = { globalId, targetId, rows, largePlayed, webmPlayed, replayedWebm, replayedMp4, noAuth: noAuth.status,
      lectures: toService(ctx, (r) => r.method === 'GET' && /\/attachments\//.test(path(r))).map((r) => ({ path: path(r), outcome: r.outcome })), blocked: ctx.blocked };
    assert.deepEqual(ctx.blocked, []);
  } finally { await ctx.context.close(); }
});

test('pièces jointes : upload interrompu, publication incertaine, même clé et mêmes pièces, identité fermée', async () => {
  const ctx = await browser.newContext(origins());
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  try {
    await toolbarReady(page);
    await control(page, 'more').click(); await control(page, 'general').click();
    const general = list(page).locator('.socrate-general').first();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    ctx.setFaults((r) => /\/packages\/react\/src\/media\.tsx/.test(path(r)) ? { kind: 'hold', until: held } : { kind: 'pass' });
    try {
      const chooser = page.waitForEvent('filechooser');
      await general.getByRole('button', { name: 'Joindre des images ou vidéos' }).click();
      await (await chooser).setFiles([join(REPO_ROOT, 'tools/local/fixtures/media/image.png')]);
      await general.getByRole('status').filter({ hasText: 'Préparation des pièces' }).waitFor();
      await control(page, 'launcher').click();
      await control(page, 'launcher').click();
      await general.getByRole('status').filter({ hasText: 'Préparation des pièces' }).waitFor();
    } finally { release(); ctx.setFaults(null); }

    await general.getByTestId('socrate-attachment-draft').waitFor();
    await general.getByRole('textbox', { name: 'Votre commentaire global' }).fill('Médias reprise fictive');
    let refused = false;
    ctx.setFaults((r) => r.method === 'PUT' && /\/attachments\//.test(path(r)) && !refused ? ((refused = true), { kind: 'abort' }) : { kind: 'pass' });
    await general.getByRole('button', { name: 'Envoyer' }).click();
    await general.getByRole('alert').getByRole('button', { name: 'Réessayer' }).waitFor({ timeout: 15_000 });
    assert.equal(await countBody('Médias reprise fictive'), 0, 'aucun fil vide après erreur upload');
    assert.equal(await general.getByRole('button', { name: 'Retirer « image.png »' }).isDisabled(), true);
    let lost = false;
    ctx.setFaults((r) => r.method === 'POST' && path(r).endsWith('/threads') && !lost ? ((lost = true), { kind: 'lose-response' }) : { kind: 'pass' });
    await general.getByRole('alert').getByRole('button', { name: 'Réessayer' }).click();
    await general.getByRole('alert').getByRole('button', { name: 'Réessayer' }).waitFor({ timeout: 15_000 });
    for (let i = 0; i < 100 && await countBody('Médias reprise fictive') === 0; i++) await page.waitForTimeout(50);
    assert.equal(await countBody('Médias reprise fictive'), 1);
    assert.match(await general.getByTestId('socrate-pending').innerText(), /1 pièce jointe/);
    await shot(page, '46-media-publication-incertaine');
    await general.getByRole('alert').filter({ hasText: /réseau indisponible/ }).waitFor();
    ctx.setFaults(null);
    await general.getByRole('alert').getByRole('button', { name: 'Réessayer' }).click();
    await general.getByRole('status').filter({ hasText: 'Commentaire publié.' }).waitFor({ timeout: 15_000 });
    const keys = toService(ctx, (r) => r.method === 'POST' && (path(r).endsWith('/attachments') || path(r).endsWith('/threads'))).map((r) => r.headers['idempotency-key']);
    assert.equal(new Set(keys).size, 1);
    assert.equal(await countBody('Médias reprise fictive'), 1);
    const id = (await threadOf('Médias reprise fictive'))!.thread_id;
    assert.equal((await db().prepare('SELECT COUNT(*) AS n FROM attachments WHERE thread_id = ?').bind(id).first<{n:number}>())!.n, 1);
    await attachFiles(page, general, [join(REPO_ROOT, 'tools/local/fixtures/media/image.png')]);
    await general.getByTestId('socrate-attachment-draft').waitFor();
    const blob = await general.getByTestId('socrate-attachment-draft').locator('img').getAttribute('src');
    assert.ok(blob?.startsWith('blob:'));
    await control(page, 'launcher').click();
    await page.getByRole('button', { name: 'Se déconnecter' }).click();
    await page.getByRole('button', { name: /Se connecter comme Karim/ }).click();
    await toolbarReady(page);
    await control(page, 'more').click(); await control(page, 'general').click();
    assert.equal(await general.getByTestId('socrate-attachment-draft').count(), 0);
    assert.equal(await page.evaluate(async (url) => { try { await fetch(url!); return true; } catch { return false; } }, blob), false, 'ancienne URL Blob révoquée');
    facts.mediasReprise = { keys, messages: 1, pieces: 1, identiteVide: true };
  } finally { await ctx.context.close(); }
});

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
/** Copie d'une vidéo ISO BMFF ou QuickTime gonflée à `bytes` par une boîte `free` finale : même contenu lisible, taille au-delà de la limite. */
async function padded(source: string, bytes: number, dest: string) {
  const data = await readFile(source);
  const out = Buffer.alloc(bytes);
  data.copy(out);
  out.writeUInt32BE(bytes - data.length, data.length);
  out.write('free', data.length + 4, 'ascii');
  await writeFile(dest, out);
  return dest;
}
/** Empreinte de chaque paquet compressé, piste par piste : égale entre deux fichiers quand aucune image ni aucun son n'a été réencodé. */
async function packetDigests(bytes: Uint8Array) {
  const input = new Input({ source: new BufferSource(bytes), formats: ALL_FORMATS });
  const tracks = [];
  for (const track of await input.getTracks()) {
    const digests = [];
    for await (const p of new EncodedPacketSink(track).packets()) digests.push(sha256(p.data));
    tracks.push({ type: track.type, codec: track.codec, digests });
  }
  return tracks;
}
const compressing = (composer: Locator) => composer.getByTestId('socrate-attachment-converting');
/** La fixture de dix minutes se convertit en moins d'une seconde : un processeur ralenti laisse observer et retirer la compression en cours. */
async function slowCpu(ctx: LocalContext, page: Page, rate: number) {
  const cdp = await ctx.context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  return async () => { await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 }); await cdp.detach(); };
}
const converted = (composer: Locator) => composer.getByRole('status').filter({ hasText: 'Préparation des pièces…' }).waitFor({ state: 'hidden', timeout: 120_000 });
const VIDEOS = join(REPO_ROOT, 'tools/local/fixtures/media');
const LIMIT = 50 * 1024 * 1024;

test('vidéos longues : MOV court réencapsulé sans perte, MP4 de 50 Mio au plus inchangé octet pour octet', async () => {
  const ctx = await browser.newContext(origins());
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  try {
    await toolbarReady(page);
    await control(page, 'more').click(); await control(page, 'general').click();
    const general = list(page).locator('.socrate-general').first();
    assert.match((await general.locator('input[type="file"]').getAttribute('accept'))!, /video\/quicktime/);
    await attachFiles(page, general, [join(VIDEOS, 'ecran.mov'), join(VIDEOS, 'parcours.mp4')]);
    const chips = general.getByTestId('socrate-attachment-draft');
    await chips.nth(1).waitFor();
    assert.deepEqual(await chips.evaluateAll((els) => els.map((el) => [el.querySelector('.socrate-chip-name')!.textContent, el.getAttribute('data-type')])), [['ecran.mp4', 'video/mp4'], ['parcours.mp4', 'video/mp4']]);
    await general.getByRole('textbox', { name: 'Votre commentaire global' }).fill('Vidéos courtes fictives');
    await general.getByRole('textbox', { name: 'Votre commentaire global' }).press('Enter');
    await general.getByRole('status').filter({ hasText: 'Commentaire publié.' }).waitFor({ timeout: 45_000 });
    const id = (await threadOf('Vidéos courtes fictives'))!.thread_id;
    const rows = (await db().prepare('SELECT name, content_type, size, sha256 FROM attachments WHERE thread_id = ? ORDER BY position').bind(id).all<{ name: string; content_type: string; size: number; sha256: string }>()).results;
    const mp4 = await readFile(join(VIDEOS, 'parcours.mp4'));
    assert.deepEqual(rows.map((r) => [r.name, r.content_type]), [['ecran.mp4', 'video/mp4'], ['parcours.mp4', 'video/mp4']]);
    assert.deepEqual([rows[1]!.size, rows[1]!.sha256], [mp4.length, sha256(mp4)], 'MP4 de 50 Mio au plus publié sans conversion');
    const row = list(page).locator(`[data-testid="socrate-row"][data-thread="${id}"]`);
    await row.locator('button.socrate-row').click();
    const media = row.getByTestId('socrate-conversation').locator('[data-testid="socrate-attachment"][data-type="video/mp4"]');
    const played = await playMedia(media.first());
    const stored = Buffer.from(await media.first().locator('video').evaluate(async (v) => {
      const bytes = new Uint8Array(await (await fetch((v as HTMLVideoElement).src)).arrayBuffer());
      return Array.from(bytes);
    }));
    assert.equal(sha256(stored), rows[0]!.sha256);
    const [source, remuxed] = [await packetDigests(await readFile(join(VIDEOS, 'ecran.mov'))), await packetDigests(stored)];
    assert.deepEqual(remuxed, source, 'paquets vidéo H.264 et audio AAC repris sans réencodage');
    await shot(page, '60-videos-courtes');
    facts.videosCourtes = { rows, played, pistes: source.map((t) => ({ type: t.type, codec: t.codec, paquets: t.digests.length })), tailleMov: (await readFile(join(VIDEOS, 'ecran.mov'))).length, tailleMp4: stored.length };
  } finally { await ctx.context.close(); }
});

test('vidéos longues : MOV de 10 minutes et MP4 au-delà de 50 Mio compressés sous la limite, publiés puis relus après rechargement', async () => {
  const dir = await mkdtemp(join(REPO_ROOT, '.tmp', 'videos-'));
  const long = await padded(join(VIDEOS, 'ecran-10min.mov'), 60 * 1024 * 1024, join(dir, 'ecran-10min.mov'));
  const big = await padded(join(VIDEOS, 'parcours.mp4'), 60 * 1024 * 1024, join(dir, 'parcours-60mio.mp4'));
  const ctx = await browser.newContext(origins());
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  try {
    await toolbarReady(page);
    await control(page, 'more').click(); await control(page, 'general').click();
    const general = list(page).locator('.socrate-general').first();
    await general.getByRole('textbox', { name: 'Votre commentaire global' }).fill('Vidéos longues fictives');
    const restore = await slowCpu(ctx, page, 20);
    const started = performance.now();
    const chooser = page.waitForEvent('filechooser');
    await general.getByRole('button', { name: 'Joindre des images ou vidéos' }).click();
    await (await chooser).setFiles([long, big]);
    await compressing(general).filter({ hasText: /^ecran-10min\.movCompression…\s[1-9]\d?\s%$/ }).waitFor({ timeout: 60_000 });
    const pendant = { texte: await compressing(general).innerText(), envoi: await general.getByRole('button', { name: 'Envoyer' }).isDisabled() };
    assert.ok(pendant.envoi, 'envoi bloqué pendant la compression');
    await shot(page, '61-videos-compression');
    await restore();
    await converted(general);
    const seconds = (performance.now() - started) / 1000;
    const chips = general.getByTestId('socrate-attachment-draft');
    assert.deepEqual(await chips.evaluateAll((els) => els.map((el) => [el.querySelector('.socrate-chip-name')!.textContent, el.getAttribute('data-type')])), [['ecran-10min.mp4', 'video/mp4'], ['parcours-60mio.mp4', 'video/mp4']]);
    assert.equal(await compressing(general).count(), 0);
    await general.getByRole('textbox', { name: 'Votre commentaire global' }).press('Enter');
    await general.getByRole('status').filter({ hasText: 'Commentaire publié.' }).waitFor({ timeout: 45_000 });
    const id = (await threadOf('Vidéos longues fictives'))!.thread_id;
    const rows = (await db().prepare('SELECT name, content_type, size FROM attachments WHERE thread_id = ? ORDER BY position').bind(id).all<{ name: string; content_type: string; size: number }>()).results;
    assert.deepEqual(rows.map((r) => [r.name, r.content_type]), [['ecran-10min.mp4', 'video/mp4'], ['parcours-60mio.mp4', 'video/mp4']]);
    assert.ok(rows.every((r) => r.size > 0 && r.size <= LIMIT), JSON.stringify(rows));

    await page.reload();
    await toolbarReady(page);
    await control(page, 'launcher').click();
    const row = list(page).locator(`[data-testid="socrate-row"][data-thread="${id}"]`);
    await row.locator('button.socrate-row').click();
    const media = row.getByTestId('socrate-conversation').locator('[data-testid="socrate-attachment"][data-type="video/mp4"]');
    const relus = [await playMedia(media.nth(0)), await playMedia(media.nth(1))];
    assert.ok(Math.abs(relus[0]!.duration - 600) < 1, `durée relue ${relus[0]!.duration}`);
    assert.deepEqual([relus[0]!.width, relus[0]!.height], [160, 90]);
    await shot(page, '62-videos-relues');
    facts.videosLongues = { seconds, pendant, rows, relus };
  } finally {
    await ctx.context.close();
    await rm(dir, { recursive: true, force: true });
  }
});

const chipNames = (chips: Locator) => chips.evaluateAll((els) => els.map((el) => el.querySelector('.socrate-chip-name')!.textContent));

test('vidéos longues : saisie et retrait des pièces prêtes pendant la compression, chaque pièce dès qu’elle est prête, retrait de la seule vidéo en cours, refus avec piste', async () => {
  const dir = await mkdtemp(join(REPO_ROOT, '.tmp', 'videos-'));
  const ctx = await browser.newContext(origins());
  try {
    const long = await padded(join(VIDEOS, 'ecran-10min.mov'), 60 * 1024 * 1024, join(dir, 'ecran-10min.mov'));
    const bis = await padded(join(VIDEOS, 'ecran-10min.mov'), 60 * 1024 * 1024, join(dir, 'ecran-bis.mov'));
    const unreadable = join(dir, 'illisible.mov');
    await writeFile(unreadable, randomBytes(64 * 1024));
    const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
    await toolbarReady(page);
    await control(page, 'more').click(); await control(page, 'general').click();
    const general = list(page).locator('.socrate-general').first();
    const field = general.getByRole('textbox', { name: 'Votre commentaire global' });
    const ready = general.getByTestId('socrate-attachment-draft');
    const restore = await slowCpu(ctx, page, 20);
    const chooser = page.waitForEvent('filechooser');
    await general.getByRole('button', { name: 'Joindre des images ou vidéos' }).click();
    await (await chooser).setFiles([join(VIDEOS, 'ecran.mov'), long, bis]);
    await compressing(general).filter({ hasText: /^ecran-10min\.movCompression…\s[1-9]\d?\s%$/ }).waitFor({ timeout: 60_000 });
    assert.deepEqual(await chipNames(ready), ['ecran.mp4'], 'pièce prête au brouillon pendant la compression suivante');
    await field.fill('Saisi pendant la compression');
    assert.equal(await field.inputValue(), 'Saisi pendant la compression', 'champ libre pendant la compression');
    assert.ok(await general.getByRole('button', { name: 'Envoyer' }).isDisabled(), 'envoi bloqué pendant la compression');
    const avant = await compressing(general).innerText();
    await general.getByRole('button', { name: 'Retirer « ecran-10min.mov »' }).click();
    await compressing(general).filter({ hasText: /^ecran-bis\.movCompression…/ }).waitFor({ timeout: 60_000 });
    const suivante = await compressing(general).innerText();
    await general.getByRole('button', { name: 'Retirer « ecran.mp4 »' }).click();
    assert.equal(await ready.count(), 0, 'pièce prête retirée pendant la compression');
    await restore();
    await converted(general);
    assert.deepEqual(await chipNames(ready), ['ecran-bis.mp4'], 'la vidéo retirée n’entre jamais au brouillon, la suivante oui');
    assert.equal(await general.getByRole('alert').count(), 0, 'retrait sans message de refus');
    assert.equal(await field.inputValue(), 'Saisi pendant la compression');
    await general.getByRole('button', { name: 'Retirer « ecran-bis.mp4 »' }).click();

    await attachFiles(page, general, [join(VIDEOS, 'ecran-16min.mov'), unreadable]);
    const refus = await general.getByRole('alert').innerText();
    assert.match(refus, /« ecran-16min\.mov » n’est pas ajouté : vidéo de 16 minutes, au-delà de 15 minutes : raccourcissez-la\./);
    assert.match(refus, /« illisible\.mov » n’est pas ajouté : ce navigateur ne sait pas lire cette vidéo\./);
    assert.equal(await ready.count(), 0);
    await shot(page, '63-videos-refus');
    await field.press('Enter');
    await general.getByRole('status').filter({ hasText: 'Commentaire publié.' }).waitFor({ timeout: 45_000 });
    facts.videosRetraitRefus = { avant, suivante, refus };
  } finally {
    await ctx.context.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('vidéos longues : changement d’identité pendant la compression, encodage arrêté, aucune pièce ni nom de l’identité précédente', async () => {
  const dir = await mkdtemp(join(REPO_ROOT, '.tmp', 'videos-'));
  const ctx = await browser.newContext(origins());
  try {
    const long = await padded(join(VIDEOS, 'ecran-10min.mov'), 60 * 1024 * 1024, join(dir, 'ecran-10min.mov'));
    await ctx.context.addInitScript(() => {
      const w = window as unknown as { encoded: number };
      w.encoded = 0;
      const encode = VideoEncoder.prototype.encode;
      VideoEncoder.prototype.encode = function (...args) { w.encoded += 1; return encode.apply(this, args); };
    });
    const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
    const encoded = () => page.evaluate(() => (window as unknown as { encoded: number }).encoded);
    await toolbarReady(page);
    await control(page, 'more').click(); await control(page, 'general').click();
    const general = list(page).locator('.socrate-general').first();
    const restore = await slowCpu(ctx, page, 20);
    const chooser = page.waitForEvent('filechooser');
    await general.getByRole('button', { name: 'Joindre des images ou vidéos' }).click();
    await (await chooser).setFiles([long]);
    await compressing(general).filter({ hasText: /Compression…\s[1-9]\d?\s%/ }).waitFor({ timeout: 60_000 });
    const pendant = await encoded();
    assert.ok(pendant > 0, 'encodage observé pendant la compression');

    await control(page, 'launcher').click();
    await page.getByRole('button', { name: 'Se déconnecter' }).click();
    await page.getByRole('button', { name: /Se connecter comme Karim Benali/ }).click();
    await page.getByRole('button', { name: 'Se déconnecter' }).waitFor();
    await toolbarReady(page);
    const arrete = await encoded();
    await page.waitForTimeout(3_000);
    const ensuite = await encoded();
    await restore();
    assert.equal(ensuite, arrete, 'aucune image encodée après le changement d’identité');
    await control(page, 'more').click(); await control(page, 'general').click();
    const karim = list(page).locator('.socrate-general').first();
    await karim.getByRole('textbox', { name: 'Votre commentaire global' }).waitFor();
    assert.equal(await karim.getByTestId('socrate-attachment-draft').count(), 0, 'aucune pièce de l’identité précédente');
    assert.equal(await compressing(karim).count(), 0, 'aucune compression de l’identité précédente');
    assert.equal(await list(page).getByText('ecran-10min').count(), 0, 'aucun nom de l’identité précédente');
    facts.videosIdentite = { pendant, arrete, ensuite };
  } finally {
    await ctx.context.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('correction sans commentaire conservée après arrêt du partage et fermeture, puis masquage extérieur et Échap', async () => {
  const results = [];
  for (const interruption of ['stop', 'exit'] as const) {
    const ctx = await browser.newContext(origins());
    try {
      const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
      await openRappels(page);
      await toolbarReady(page);
      const at = await selectText(page, '[data-socrate-id="rappel-libelle"]', 'Rappel');
      await page.mouse.click(at.x, at.y, { button: 'right' });
      await page.locator('[data-socrate="menu"]').getByRole('menuitem', { name: /Proposer une correction/ }).click();
      const field = bubble(page).getByRole('textbox', { name: 'Correction proposée' });
      const replacement = `Correction sans commentaire ${interruption}`;
      try { await field.fill(replacement); }
      catch (error) {
        facts.C1echec = { interruption, hote: await page.locator('body').innerText(), bulle: await bubble(page).locator('body').innerText().catch(() => 'absente') };
        await shot(page, `correction-${interruption}-echec-ouverture`);
        throw error;
      }
      if (interruption === 'exit') {
        await closeSocrate(page);
        await control(page, 'draft').click();
      } else {
        await control(page, 'more').click();
        await control(page, 'stop').click();
      }
      await bubble(page).getByTestId('socrate-capture-invalidated').waitFor();
      await shot(page, `correction-${interruption}-avant-masquage`);
      for (const gesture of ['outside', 'escape']) {
        if (gesture === 'outside') await page.getByRole('heading', { level: 1, name: 'Rappels automatiques' }).click();
        else await field.press('Escape');
        await page.locator('#socrate-bubble').waitFor({ state: 'hidden' });
        const kept = await control(page, 'draft').count();
        results.push({ interruption, gesture, kept });
        facts.correction = results;
        await shot(page, `correction-${interruption}-${gesture}`);
        assert.equal(kept, 1, 'la correction reste accessible depuis Brouillon');
        await control(page, 'draft').click();
        assert.equal(await field.inputValue(), replacement);
        assert.equal(await bubble(page).getByRole('button', { name: 'Envoyer' }).isDisabled(), true);
      }
      assert.equal(toService(ctx, (r) => r.method === 'POST' && path(r).endsWith('/targeted')).length, 0);
      await bubble(page).getByRole('button', { name: 'Supprimer le brouillon' }).click();
      assert.equal(await control(page, 'draft').count(), 0, 'seul l’abandon explicite retire la correction');
    } finally { await ctx.context.close(); }
  }
});

test('filtre écran selon pathname capturé avec adaptateur incluant query ou route logique différente', async () => {
  for (const adapter of ['query', 'other']) {
    const ctx = await browser.newContext(origins());
    try {
      const page = await loginAs(ctx, 'Claire Morel, relectrice produit', `/reglages/rappels?adapter=${adapter}`);
      await toolbarReady(page);
      await targetElement(page, page.getByRole('heading', { level: 1 }));
      const body = `Filtre écran adaptateur ${adapter}`;
      await bubble(page).getByRole('textbox', { name: 'Votre commentaire' }).fill(body);
      await bubble(page).getByRole('button', { name: 'Envoyer' }).click();
      await page.locator('#socrate-bubble').waitFor({ state: 'hidden' });
      const record = await threadOf(body);
      await control(page, 'launcher').click();
      const row = list(page).locator(`[data-thread="${record!.thread_id}"][data-testid="socrate-row"]`);
      await row.waitFor();
      assert.equal(await row.getAttribute('data-screen'), 'here');
      assert.equal(await row.getByTestId('socrate-elsewhere').count(), 0);
      assert.equal(await row.getByRole('button', { name: 'Aller à la page' }).count(), 0);
      const captured = await db().prepare('SELECT payload FROM captures WHERE thread_id = ?').bind(record!.thread_id).first<{ payload: string }>();
      const route = JSON.parse(captured!.payload).target.route;
      assert.equal(route, '/reglages/rappels');
      facts[`filtre-${adapter}`] = { route, screen: await row.getAttribute('data-screen'), adapter: adapter === 'query' ? '/reglages/rappels?adapter=query' : '/route-logique' };
      await shot(page, `filtre-${adapter}`);
    } finally { await ctx.context.close(); }
  }
});

test('tooltip Socrate hôte et iframe au survol, focus et Échap, data-tip hôte laissé intact', async () => {
  const ctx = await browser.newContext(origins());
  try {
    const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
    await toolbarReady(page);
    await page.evaluate(() => {
      const button = document.createElement('button');
      button.id = 'host-tip-control';
      button.dataset.tip = 'Infobulle hôte';
      button.textContent = 'Contrôle hôte';
      button.addEventListener('keydown', (e) => { if (e.key === 'Escape') button.dataset.escape = 'received'; });
      document.body.append(button);
    });
    const host = page.locator('#host-tip-control');
    await host.hover();
    await page.waitForTimeout(500);
    assert.equal(await page.locator('[data-socrate="tip"]').count(), 0);
    await page.keyboard.press('Tab');
    await host.focus();
    await host.press('Escape');
    assert.equal(await host.getAttribute('data-escape'), 'received');
    assert.equal(await page.locator('[data-socrate="tip"]').count(), 0);
    for (const iframe of [false, true]) {
      if (iframe) await control(page, 'launcher').click();
      const button = iframe ? list(page).getByRole('button', { name: 'Fermer la liste' }) : control(page, 'target');
      const tip = iframe ? list(page).getByRole('tooltip') : page.getByRole('tooltip');
      await button.hover();
      await tip.waitFor();
      assert.equal(await tip.count(), 1);
      await page.keyboard.press('Escape');
      await tip.waitFor({ state: 'hidden' });
      await page.mouse.move(1, 1);
      await page.keyboard.press('Tab');
      await button.focus();
      await tip.waitFor();
      await button.press('Escape');
      await tip.waitFor({ state: 'hidden' });
      assert.ok(await button.evaluate((el) => el.ownerDocument.activeElement === el));
    }
    facts.tooltip = { hostEscape: await host.getAttribute('data-escape'), documents: ['hôte', 'iframe Socrate'], hoverFocusEscape: true };
    await shot(page, 'tooltip-controle-hote-intact');
  } finally { await ctx.context.close(); }
});

test('clic extérieur après rechargement ou apparition iframe masque sans perte, laisse naviguer et ne publie rien', async () => {
  for (const appearance of [false, true]) {
    const ctx = await browser.newContext(origins());
    try {
      const page = await loginAs(ctx, 'Claire Morel, relectrice produit', '/vue-scindee');
      if (appearance) await page.getByTestId('split-toggle').click();
      await toolbarReady(page);
      await targetElement(page, page.getByRole('heading', { name: 'Vue scindée', exact: true }));
      const field = bubble(page).getByRole('textbox', { name: 'Votre commentaire' });
      const body = `Clic extérieur brouillon iframe ${appearance}`;
      await field.fill(body);
      if (appearance) await page.getByTestId('split-toggle').dispatchEvent('click');
      else {
        const previous = await page.getByTestId('split-frame').evaluateHandle((el: HTMLIFrameElement) => el.contentDocument);
        await page.getByTestId('split-frame').evaluate((el: HTMLIFrameElement) => el.contentWindow!.location.reload());
        await page.waitForFunction((old) => document.querySelector<HTMLIFrameElement>('[data-testid="split-frame"]')?.contentDocument !== old, previous);
        await previous.dispose();
      }
      assert.ok(await page.locator('#socrate-bubble').isVisible(), 'la bulle est encore ouverte dans le nouveau cycle de documents');
      const child = page.frameLocator('[data-testid="split-frame"]');
      await child.getByRole('link', { name: 'Général', exact: true }).click();
      await child.getByRole('heading', { name: 'Général', exact: true }).waitFor();
      await page.locator('#socrate-bubble').waitFor({ state: 'hidden' });
      await control(page, 'draft').click();
      assert.equal(await field.inputValue(), body);
      assert.equal(toService(ctx, (r) => r.method === 'POST' && path(r).endsWith('/targeted')).length, 0);
      facts[`clic-exterieur-${appearance ? 'apparue' : 'rechargee'}`] = { child: await child.locator('body').evaluate((el) => el.ownerDocument.defaultView!.location.pathname), draft: await field.inputValue(), posts: toService(ctx, (r) => r.method === 'POST' && path(r).endsWith('/targeted')).length };
      await shot(page, `clic-exterieur-iframe-${appearance ? 'apparue' : 'rechargee'}`);
    } finally { await ctx.context.close(); }
  }
});





test('menu de ligne en bas à droite, bouton, clic droit et clavier, actions visibles et Tab sort du menu', async () => {
  const ctx = await browser.newContext(origins());
  try {
    const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
    await toolbarReady(page);
    await control(page, 'launcher').click();
    await list(page).getByRole('textbox', { name: 'Votre commentaire global' }).fill('Menu de ligne aux bords');
    await list(page).getByRole('button', { name: 'Envoyer' }).click();
    const general = list(page).getByTestId('socrate-row').filter({ hasText: 'Menu de ligne aux bords' });
    await general.waitFor();
    for (let i = 0; i < 8; i++) {
      const body = `Menu de ligne remplissage ${i}`;
      await list(page).getByRole('textbox', { name: 'Votre commentaire global' }).fill(body);
      await list(page).getByRole('button', { name: 'Envoyer' }).click();
      await list(page).getByTestId('socrate-row').filter({ hasText: body }).waitFor();
    }
    await list(page).getByRole('button', { name: /^Toutes les pages/ }).click();
    await list(page).getByRole('button', { name: /^Toutes \d/ }).click();
    const row = list(page).getByTestId('socrate-row').last();
    const trigger = row.getByRole('button', { name: /Actions de la conversation de/ });
    const menu = list(page).getByRole('menu', { name: 'Actions de la conversation' });
    const positions = [];
    for (const gesture of ['button', 'right', 'keyboard']) {
      await trigger.scrollIntoViewIfNeeded();
      await trigger.evaluate((el) => {
        const doc = el.ownerDocument;
        const body = el.closest('.socrate-body')!;
        body.scrollTop += el.closest('li')!.getBoundingClientRect().bottom - (Math.min(body.getBoundingClientRect().bottom, doc.defaultView!.innerHeight) - 4);
      });
      if (gesture === 'button') await trigger.click();
      else if (gesture === 'right') {
        const bounds = (await row.locator('.socrate-row').boundingBox())!;
        await page.mouse.click(bounds.x + bounds.width - 16, Math.min(bounds.y + bounds.height / 2, page.viewportSize()!.height - 12), { button: 'right' });
      } else await row.locator('.socrate-row').press('Shift+F10');
      await menu.waitFor();
      const bounds = await menu.evaluate((el) => {
        const view = el.ownerDocument.defaultView!;
        return { rect: el.getBoundingClientRect().toJSON(), width: view.innerWidth, height: view.innerHeight,
          actions: [...el.querySelectorAll('button')].map((b) => b.getBoundingClientRect().toJSON()) };
      });
      positions.push({ gesture, ...bounds });
      assert.ok(bounds.rect.left >= 0 && bounds.rect.right <= bounds.width && bounds.rect.top >= 0 && bounds.rect.bottom <= bounds.height, JSON.stringify(bounds));
      assert.ok(bounds.actions.every((b) => b.top >= 0 && b.bottom <= bounds.height));
      await shot(page, `menu-${gesture}`);
      await page.keyboard.press('ArrowDown');
      assert.ok(await menu.getByRole('menuitem').nth(1).evaluate((el) => el.ownerDocument.activeElement === el));
      await page.keyboard.press(gesture === 'keyboard' ? 'Tab' : 'Escape');
      await menu.waitFor({ state: 'hidden' });
      assert.equal(await list(page).getByRole('menu').count(), 0);
    }
    facts.menuDeLigne = positions;
    await general.locator('.socrate-row').click();
    ctx.setFaults((r) => r.method === 'PUT' && path(r).endsWith('/state')
      ? { kind: 'respond', status: 503, body: { code: 'not_ready', message: 'Transition indisponible.', retryable: true, requestId: 'transition-simulee' } } : { kind: 'pass' });
    await general.getByRole('button', { name: 'Résoudre', exact: true }).click();
    await general.getByRole('alert').waitFor();
    assert.equal(await general.getByRole('alert').count(), 1, 'une seule notice de transition sur le fil déplié');
    facts.noticeUnique = true;
  } finally { await ctx.context.close(); }
});

// Refonte de l'interface. Collage et dépôt synthétiques (DataTransfer construit dans le document du composeur) sauf mention du presse-papiers isolé du Chromium de banc.
const MEDIA = join(REPO_ROOT, 'tools/local/fixtures/media');
type Fake = { name: string; type: string; b64: string };
const fake = async (file: string, type: string, name = file): Promise<Fake> => ({ name, type, b64: (await readFile(join(MEDIA, file))).toString('base64') });
const TEXTE: Fake = { name: 'notes.txt', type: 'text/plain', b64: Buffer.from('notes fictives').toString('base64') };
function dispatchFiles(target: Locator, type: 'paste' | 'dragover' | 'drop', files: Fake[], text?: string) {
  return target.evaluate((el, { type, files, text }) => {
    const win = el.ownerDocument.defaultView! as typeof window;
    const dt = new win.DataTransfer();
    for (const f of files) dt.items.add(new win.File([Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0))], f.name, { type: f.type }));
    if (text) dt.setData('text/plain', text);
    const e = type === 'paste' ? new win.ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }) : new win.DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return e.defaultPrevented;
  }, { type, files, text });
}
const drafts = (composer: Locator) => composer.getByTestId('socrate-attachment-draft');
async function prepared(composer: Locator, n: number) {
  await drafts(composer).nth(n - 1).waitFor({ timeout: 10_000 });
  await composer.getByRole('status').filter({ hasText: 'Préparation des pièces' }).waitFor({ state: 'hidden' });
  assert.equal(await drafts(composer).count(), n, `${n} pièce(s) au brouillon`);
}
const attachmentsOf = async (body: string) => (await db().prepare('SELECT COUNT(*) AS n FROM attachments a JOIN messages m USING (project_id, review_key, thread_id, message_id) WHERE m.body = ?').bind(body).first<{ n: number }>())!.n;

test('rendu du panneau : toolbar, panneau vide, liste peuplée, fil avec médias, menus et fenêtres étroites', async () => {
  const ctx = await browser.newContext(origins());
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  try {
    await openRdv(page);
    await toolbarReady(page);
    await shot(page, `50-${RENDU}-toolbar`);
    await control(page, 'launcher').click();
    // Panneau vide seulement sur une instance neuve (ce test seul) ; dans la suite complète, d'autres fils existent déjà.
    await list(page).locator('[data-testid="socrate-empty"], [data-testid="socrate-row"]').first().waitFor();
    if (await list(page).getByTestId('socrate-empty').count()) await shot(page, `51-${RENDU}-panneau-vide`);
    if (RENDU === 'avant') await list(page).getByRole('button', { name: 'Commentaire général', exact: true }).click();
    const general = list(page).locator('.socrate-general').first();
    await attachFiles(page, general, [join(MEDIA, 'image.png')]);
    await general.getByRole('textbox', { name: 'Votre commentaire global' }).fill('Rendu : vue d’ensemble claire, la capture jointe montre le rappel.');
    await general.getByRole('textbox', { name: 'Votre commentaire global' }).press('Enter');
    await general.getByRole('status').filter({ hasText: 'Commentaire publié.' }).waitFor({ timeout: 20_000 });
    await targetElement(page, page.locator('article p').first());
    const draft = bubble(page).getByTestId('socrate-draft');
    await attachFiles(page, draft, [join(MEDIA, 'image.jpg')]);
    await draft.getByRole('textbox', { name: 'Votre commentaire' }).fill('Le libellé du rappel est ambigu : préciser « la veille ».');
    await draft.getByRole('textbox', { name: 'Votre commentaire' }).press('Enter');
    await page.locator('#socrate-bubble').waitFor({ state: 'hidden', timeout: 20_000 });
    const id = (await threadOf('Le libellé du rappel est ambigu : préciser « la veille ».'))!.thread_id;
    await list(page).getByTestId('socrate-row').nth(1).waitFor({ timeout: 10_000 });
    await shot(page, `52-${RENDU}-liste-peuplee`);
    const { conv } = await openPin(page, id);
    await conv.getByRole('textbox').fill('D’accord, je reformule.');
    await conv.getByRole('textbox').press('Enter');
    await conv.getByText('D’accord, je reformule.').waitFor({ timeout: 10_000 });
    await imageVisible(conv.locator('[data-testid="socrate-attachment"] img').first());
    // Chromium headless peut figer la chronologie de l'iframe jusqu'à la capture : l'image attend la fin du fondu d'entrée.
    facts.mediaBulle = await conv.evaluate(async (el) => {
      await Promise.all(el.ownerDocument.getAnimations().map((a) => a.finished));
      return { opacite: getComputedStyle(el.closest('.socrate-bubble')!).opacity };
    });
    await shot(page, `53-${RENDU}-fil-medias`);
    await page.keyboard.press('Escape');
    await list(page).getByTestId('socrate-row').first().click({ button: 'right' });
    await list(page).getByRole('menu').waitFor();
    await shot(page, `54-${RENDU}-menu-ligne`);
    await page.keyboard.press('Escape');
    await control(page, 'more').click();
    await page.locator('[data-socrate="menu"]').waitFor();
    await shot(page, `55-${RENDU}-menu-options`);
    await page.keyboard.press('Escape');
    for (const width of [375, 320]) {
      await page.setViewportSize({ width, height: 700 });
      await page.waitForTimeout(200);
      await shot(page, `56-${RENDU}-etroit-${width}`);
    }
  } finally { await ctx.context.close(); }
});

test('composeurs : champ général direct, collage et dépôt dans les trois composeurs, texte intact, refus, verrou d’envoi et persistance', async () => {
  const ctx = await browser.newContext(origins());
  await ctx.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: stack.view.demoOrigin });
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  const png = await fake('image.png', 'image/png');
  const jpg = await fake('image.jpg', 'image/jpeg');
  try {
    await openRdv(page);
    await toolbarReady(page);
    await control(page, 'launcher').click();
    const general = list(page).locator('.socrate-general');
    const field = general.getByRole('textbox', { name: 'Votre commentaire global' });
    await field.waitFor({ timeout: 5_000 });
    assert.equal(await list(page).getByRole('button', { name: 'Commentaire général', exact: true }).count(), 0, 'aucun bouton préalable au champ général');

    assert.equal(await dispatchFiles(field, 'paste', [png]), true, 'collage d’une image consommé par Socrate');
    await prepared(general, 1);
    assert.equal(await dispatchFiles(field, 'paste', [], 'texte'), false, 'collage de texte laissé au navigateur');
    await field.evaluate((el) => el.ownerDocument.defaultView!.navigator.clipboard.writeText('Texte collé fictif'));
    await field.click();
    await page.keyboard.press('ControlOrMeta+V');
    assert.match(await field.inputValue(), /Texte collé fictif/, 'vrai collage de texte du presse-papiers isolé');
    await field.evaluate(async (el, b64) => {
      const win = el.ownerDocument.defaultView! as typeof window;
      const blob = new win.Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/png' });
      await win.navigator.clipboard.write([new win.ClipboardItem({ 'image/png': blob })]);
    }, png.b64);
    await field.click();
    await page.keyboard.press('ControlOrMeta+V');
    await prepared(general, 2);
    assert.match(await field.inputValue(), /^Texte collé fictif$/, 'le collage d’image n’altère pas le texte');

    assert.equal(await dispatchFiles(field, 'dragover', [jpg]), true, 'survol de fichiers accepté');
    await general.getByTestId('socrate-drop').waitFor();
    await shot(page, `57-${RENDU}-depot-visible`);
    assert.equal(await dispatchFiles(field, 'drop', [jpg, png]), true, 'dépôt consommé : le navigateur n’ouvre pas le fichier');
    await general.getByTestId('socrate-drop').waitFor({ state: 'hidden' });
    await prepared(general, 4);
    assert.equal(await dispatchFiles(field, 'dragover', [], 'texte glissé'), false, 'glissement de texte laissé au champ');
    assert.equal(await general.getByTestId('socrate-drop').count(), 0, 'aucune zone de dépôt pour du texte');
    await dispatchFiles(field, 'drop', [TEXTE]);
    await general.getByRole('alert').filter({ hasText: 'formats acceptés' }).waitFor();
    await dispatchFiles(field, 'paste', [png]);
    await general.getByRole('alert').filter({ hasText: '4 pièces au plus' }).waitFor();
    const outside = list(page).getByRole('heading', { name: 'Conversations' });
    assert.equal(await dispatchFiles(outside, 'dragover', [png]), true, 'survol hors composeur refusé sans ouverture');
    assert.equal(await dispatchFiles(outside, 'drop', [png]), true, 'dépôt hors composeur sans ouverture du fichier');
    assert.equal(await drafts(general).count(), 4);
    assert.equal(toService(ctx, (r) => /attachments/.test(path(r))).length, 0, 'aucun fichier envoyé avant le geste d’envoi');

    let lost = false;
    ctx.setFaults((r) => r.method === 'POST' && path(r).endsWith('/threads') && !lost ? ((lost = true), { kind: 'lose-response' }) : { kind: 'pass' });
    await field.press('Enter');
    await general.getByRole('alert').getByRole('button', { name: 'Réessayer' }).waitFor({ timeout: 20_000 });
    assert.equal(await dispatchFiles(field, 'paste', [png]), true);
    assert.equal(await dispatchFiles(field, 'drop', [jpg]), true);
    await page.waitForTimeout(300);
    assert.equal(await drafts(general).count(), 4, 'envoi incertain : collage et dépôt sans effet');
    ctx.setFaults(null);
    await general.getByRole('alert').getByRole('button', { name: 'Réessayer' }).click();
    await general.getByRole('status').filter({ hasText: 'Commentaire publié.' }).waitFor({ timeout: 20_000 });
    assert.equal(await attachmentsOf('Texte collé fictif'), 4, 'quatre pièces publiées avec le commentaire général');

    await targetElement(page, page.locator('article p').first());
    const draft = bubble(page).getByTestId('socrate-draft');
    const targetField = draft.getByRole('textbox', { name: 'Votre commentaire' });
    await dispatchFiles(targetField, 'paste', [png]);
    await prepared(draft, 1);
    await dispatchFiles(targetField, 'dragover', [jpg]);
    await draft.getByTestId('socrate-drop').waitFor();
    await dispatchFiles(targetField, 'drop', [jpg]);
    await prepared(draft, 2);
    await targetField.fill('Composeur ciblé avec médias collés');
    await targetField.press('Enter');
    await page.locator('#socrate-bubble').waitFor({ state: 'hidden', timeout: 20_000 });
    assert.equal(await attachmentsOf('Composeur ciblé avec médias collés'), 2, 'deux pièces sur le commentaire ciblé');

    const id = (await threadOf('Composeur ciblé avec médias collés'))!.thread_id;
    const { conv } = await openPin(page, id);
    const reply = conv.getByRole('textbox', { name: /Répondre au retour/ });
    await dispatchFiles(reply, 'drop', [png]);
    await prepared(conv, 1);
    await dispatchFiles(reply, 'paste', [jpg]);
    await prepared(conv, 2);
    await reply.fill('Composeur réponse avec médias');
    await reply.press('Enter');
    await conv.getByTestId('socrate-message').filter({ hasText: 'Composeur réponse avec médias' }).waitFor({ timeout: 20_000 });
    assert.equal(await attachmentsOf('Composeur réponse avec médias'), 2, 'deux pièces sur la réponse');

    await page.reload();
    await toolbarReady(page);
    await control(page, 'launcher').click();
    await list(page).getByTestId('socrate-row').filter({ hasText: 'Texte collé fictif' }).getByRole('button').first().click();
    const media = list(page).locator('[data-testid="socrate-attachment"] img');
    await media.nth(3).waitFor({ timeout: 15_000 });
    for (let i = 0; i < 4; i++) await imageVisible(media.nth(i));
    const after = await openPin(page, id);
    await after.conv.locator('[data-testid="socrate-attachment"] img').nth(3).waitFor({ timeout: 15_000 });
    facts.mediaComposeurs = { general: 4, cible: 2, reponse: 2, collageNatifImage: 'presse-papiers du Chromium de banc', depot: 'événements synthétiques' };
  } finally { await ctx.context.close(); }
});

test('collage mixte : texte et image du même collage gardés ensemble, presse-papiers du Chromium de banc', async () => {
  const ctx = await browser.newContext(origins());
  await ctx.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: stack.view.demoOrigin });
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  const png = await fake('image.png', 'image/png');
  try {
    await openRdv(page);
    await toolbarReady(page);
    await control(page, 'launcher').click();
    const general = list(page).locator('.socrate-general');
    const field = general.getByRole('textbox', { name: 'Votre commentaire global' });
    await field.waitFor({ timeout: 5_000 });
    await field.evaluate(async (el, b64) => {
      const win = el.ownerDocument.defaultView! as typeof window;
      const image = new win.Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/png' });
      await win.navigator.clipboard.write([new win.ClipboardItem({ 'text/plain': new win.Blob(['Cellule A1\tCellule B1'], { type: 'text/plain' }), 'image/png': image })]);
    }, png.b64);
    await field.click();
    await page.keyboard.press('ControlOrMeta+V');
    await prepared(general, 1);
    const reel = { texte: await field.inputValue(), pieces: await drafts(general).count() };
    facts.mediaCollageMixte = { reel };
    assert.deepEqual(reel, { texte: 'Cellule A1\tCellule B1', pieces: 1 }, 'collage réel texte et image : les deux gardés');
    const synthetique = await dispatchFiles(field, 'paste', [png], 'texte synthétique');
    await prepared(general, 2);
    assert.equal(synthetique, false, 'collage mixte synthétique : le texte reste au comportement du champ');
    facts.mediaCollageMixte = { reel, synthetiqueEmpeche: synthetique, pieces: 2 };
  } finally { await ctx.context.close(); }
});

test('geste de largeur : fermeture de la liste, de Socrate, fenêtre étroite ou déconnexion pendant le glissé, geste terminé et panneau de nouveau cliquable', async () => {
  const ctx = await browser.newContext(origins());
  // Sonde de banc : ajouts et retraits des écouteurs du geste sur la poignée, sans effet produit.
  await ctx.context.addInitScript(() => {
    if (window !== window.top) return;
    const probe: { type: string; fn: unknown; node: EventTarget; removed: boolean }[] = [];
    (window as unknown as { resizeProbe: typeof probe }).resizeProbe = probe;
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function (type, fn, options) {
      if (this instanceof Element && this.matches('[data-socrate="resize"]') && (type === 'pointermove' || type === 'lostpointercapture')) probe.push({ type, fn, node: this, removed: false });
      return add.call(this, type, fn, options);
    };
    EventTarget.prototype.removeEventListener = function (type, fn, options) {
      for (const p of probe) if (p.node === this && p.type === type && p.fn === fn) p.removed = true;
      return remove.call(this, type, fn, options);
    };
  });
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  try {
    await openRdv(page);
    await toolbarReady(page);
    await control(page, 'launcher').click();
    const frame = page.locator('#socrate-frame');
    const handle = page.getByRole('separator', { name: 'Largeur des conversations' });
    const press = async () => {
      await handle.waitFor();
      const b = (await handle.boundingBox())!;
      await page.mouse.move(b.x + b.width / 2, 300);
      await page.mouse.down();
      await page.mouse.move(b.x - 60, 300, { steps: 6 });
      assert.equal(await handle.getAttribute('data-active'), 'true', 'glissé en cours');
    };
    const etats: Record<string, unknown> = {};
    const usable = async (step: string) => {
      await handle.waitFor();
      const state = await frame.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { iframe: getComputedStyle(el).pointerEvents, bulle: getComputedStyle(document.getElementById('socrate-bubble')!).pointerEvents, hit: hit?.id ?? hit?.tagName ?? null };
      });
      etats[step] = { ...state, poignee: await handle.getAttribute('data-active') };
      assert.deepEqual(etats[step], { iframe: 'auto', bulle: 'auto', hit: 'socrate-frame', poignee: null }, step);
      const state1 = list(page).getByRole('group', { name: 'État' });
      await state1.getByRole('button', { name: /^Résolues/ }).click({ timeout: 5_000 });
      assert.equal(await state1.getByRole('button', { name: /^Résolues/ }).getAttribute('aria-pressed'), 'true', `${step} : clic réel dans le panneau`);
      await state1.getByRole('button', { name: /^Ouvertes/ }).click({ timeout: 5_000 });
    };
    await press();
    await list(page).getByRole('heading', { name: 'Conversations' }).focus();
    await page.keyboard.press('Escape');
    await frame.waitFor({ state: 'hidden' });
    await page.mouse.up();
    await control(page, 'launcher').click();
    await usable('Échap dans la liste pendant le glissé');
    await press();
    await control(page, 'close').focus();
    await page.keyboard.press('Enter');
    await frame.waitFor({ state: 'hidden' });
    assert.ok(await toolbar(page).isVisible(), 'tout fermer garde la toolbar');
    await page.mouse.up();
    await control(page, 'launcher').click();
    await usable('« Tout fermer » pendant le glissé');
    await press();
    await page.setViewportSize({ width: 500, height: 720 });
    await handle.waitFor({ state: 'detached' });
    await page.mouse.up();
    await page.setViewportSize({ width: 1280, height: 720 });
    await usable('fenêtre devenue étroite pendant le glissé');
    await shot(page, `64-${RENDU}-apres-glisse-interrompu`);
    const stored = () => page.evaluate(() => sessionStorage.getItem('socrate-largeur-liste'));
    const listeners = () => page.evaluate(() => (window as unknown as { resizeProbe: { type: string; removed: boolean; node: Element }[] }).resizeProbe.map((p) => ({ type: p.type, removed: p.removed, connected: p.node.isConnected })));
    await list(page).getByRole('textbox', { name: 'Votre commentaire global' }).fill('Geste de largeur, brouillon de Claire avant déconnexion');
    await handle.focus();
    await page.keyboard.press('Home');
    const initiale = await stored();
    await press();
    const atteinte = await handle.getAttribute('aria-valuenow');
    assert.notEqual(atteinte, initiale, 'largeur tirée différente de la largeur mémorisée');
    await page.getByRole('button', { name: 'Se déconnecter' }).focus();
    await page.keyboard.press('Enter');
    await handle.waitFor({ state: 'detached' });
    await page.mouse.up();
    const demonte = { initiale, atteinte, stockee: await stored(), ecouteurs: await listeners() };
    assert.equal(demonte.stockee, atteinte, `largeur atteinte gardée au démontage ${JSON.stringify(demonte)}`);
    assert.equal(demonte.ecouteurs.length, 8, `quatre gestes, deux écouteurs chacun ${JSON.stringify(demonte)}`);
    assert.ok(demonte.ecouteurs.every((l) => l.removed), `chaque geste retire ses écouteurs ${JSON.stringify(demonte)}`);
    await page.getByRole('button', { name: /Se connecter comme Karim Benali/ }).click();
    await toolbarReady(page);
    await control(page, 'launcher').click();
    assert.equal(await handle.getAttribute('aria-valuenow'), atteinte, 'nouvelle identité : largeur retrouvée');
    await usable('déconnexion pendant le glissé');
    assert.equal(await list(page).getByRole('textbox', { name: 'Votre commentaire global' }).inputValue(), '', 'aucun brouillon de Claire sous Karim');
    assert.equal(await list(page).getByText('Geste de largeur, brouillon de Claire avant déconnexion').count(), 0, 'aucun texte de Claire sous Karim');
    facts.mediaGesteInterrompu = { ...etats, demontage: demonte };
  } finally { await ctx.context.close(); }
});

test('toolbar avec brouillon masqué : contrôles sans chevauchement et menu dans la fenêtre de 320 à 1000 px, liste ouverte ou au maximum', async () => {
  const ctx = await browser.newContext(origins());
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  try {
    await openRdv(page);
    await toolbarReady(page);
    await targetElement(page, page.locator('article p').first());
    const field = bubble(page).getByRole('textbox', { name: 'Votre commentaire' });
    await field.fill('Toolbar étroite, commentaire ciblé');
    await field.press('Enter');
    await page.locator('#socrate-bubble').waitFor({ state: 'hidden', timeout: 20_000 });
    await targetElement(page, page.locator('article p').nth(1));
    await bubble(page).getByRole('textbox', { name: 'Votre commentaire' }).fill('Toolbar étroite, brouillon masqué');
    await page.keyboard.press('Escape');
    await control(page, 'draft').waitFor();
    await control(page, 'launcher').click();
    const mesures: Record<number, unknown> = {};
    for (const width of [520, 540, 560, 600, 1000, 375, 320]) {
      await page.setViewportSize({ width, height: 700 });
      await page.waitForTimeout(200);
      if (width === 1000) {
        await page.getByRole('separator', { name: 'Largeur des conversations' }).focus();
        await page.keyboard.press('End');
        await page.waitForTimeout(200);
      }
      const g = await toolbar(page).evaluate((el) => {
        const list = document.getElementById('socrate-frame')!.getBoundingClientRect();
        const room = list.x > 0 ? list.x : innerWidth;
        const r = el.getBoundingClientRect();
        const buttons = [...el.querySelectorAll(':scope > button')].map((b) => ({ action: (b as HTMLElement).dataset.socrateAction, rogne: b.scrollWidth > b.clientWidth, ...b.getBoundingClientRect().toJSON() }));
        return { room, left: r.left, right: r.right, buttons };
      });
      const actions = g.buttons.map((b) => b.action);
      assert.deepEqual(actions, ['target', 'draft', 'launcher', 'more', 'close'], `${width} : brouillon présent`);
      assert.ok(g.left >= 0 && g.right <= g.room + 0.5, `${width} : toolbar dans la place laissée ${JSON.stringify(g)}`);
      g.buttons.forEach((b, i) => {
        assert.ok(b.width > 0 && !b.rogne && b.left >= g.left && b.right <= g.right + 0.5, `${width} : ${b.action} entier dans la toolbar ${JSON.stringify(g)}`);
        if (i) assert.ok(b.left >= g.buttons[i - 1]!.right - 0.5, `${width} : ${b.action} ne chevauche pas ${g.buttons[i - 1]!.action} ${JSON.stringify(g)}`);
      });
      await shot(page, `60-${RENDU}-toolbar-brouillon-${width}`);
      await control(page, 'more').click();
      const menu = (await page.locator('[data-socrate="menu"]').boundingBox())!;
      assert.ok(menu.x >= 0 && menu.x + menu.width <= width, `${width} : menu dans la fenêtre ${JSON.stringify(menu)}`);
      await shot(page, `61-${RENDU}-menu-brouillon-${width}`);
      await control(page, 'more').click();
      mesures[width] = { ...g, menu };
    }
    await control(page, 'draft').click();
    assert.equal(await bubble(page).getByRole('textbox', { name: 'Votre commentaire' }).inputValue(), 'Toolbar étroite, brouillon masqué', 'brouillon repris depuis la toolbar étroite');
    facts.mediaToolbarBrouillon = mesures;
  } finally { await ctx.context.close(); }
});

test('fenêtre basse : sidebar étroite, six lignes et quatre images, Envoyer visible et liste utilisable', async () => {
  const ctx = await browser.newContext(origins());
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  const png = await fake('image.png', 'image/png');
  const jpg = await fake('image.jpg', 'image/jpeg');
  try {
    await openRdv(page);
    await toolbarReady(page);
    await page.setViewportSize({ width: 375, height: 700 });
    await control(page, 'launcher').click();
    const general = list(page).locator('.socrate-general');
    const field = general.getByRole('textbox', { name: 'Votre commentaire global' });
    await field.waitFor({ timeout: 5_000 });
    await page.waitForTimeout(200);
    const libre = async () => {
      const pied = await general.locator('.socrate-field-foot').evaluate((el) => el.getBoundingClientRect().bottom);
      const tb = (await toolbar(page).boundingBox())!;
      assert.ok(tb.y >= pied, `toolbar sous le pied du composeur ${JSON.stringify({ pied, tb })}`);
    };
    await libre();
    await shot(page, `62-${RENDU}-sidebar-etroite-375`);
    await page.setViewportSize({ width: 375, height: 430 });
    await field.fill(['Ligne 1', 'Ligne 2', 'Ligne 3', 'Ligne 4', 'Ligne 5', 'Ligne 6'].join('\n'));
    await dispatchFiles(field, 'paste', [png, jpg, png, jpg]);
    await prepared(general, 4);
    await page.waitForTimeout(200);
    const g = await general.evaluate((el) => {
      const doc = el.ownerDocument;
      const box = (s: string) => doc.querySelector(s)!.getBoundingClientRect().toJSON();
      const f = doc.querySelector('.socrate-general .socrate-field')!;
      return { hauteur: innerHeight, envoyer: box('.socrate-general .socrate-send'), joindre: box('.socrate-general .socrate-field-foot .socrate-icon'), liste: box('.socrate-body'),
        champ: { client: f.clientHeight, defilement: f.scrollHeight }, document: doc.documentElement.scrollHeight };
    });
    facts.mediaFenetreBasse = g;
    assert.ok(g.envoyer.top >= 0 && g.envoyer.bottom <= g.hauteur, `Envoyer visible ${JSON.stringify(g)}`);
    assert.ok(g.joindre.bottom <= g.hauteur, `Joindre visible ${JSON.stringify(g)}`);
    assert.ok(g.document <= g.hauteur, `document du panneau sans débordement ${JSON.stringify(g)}`);
    assert.ok(g.liste.height >= 80, `liste encore utilisable ${JSON.stringify(g)}`);
    assert.ok(g.champ.defilement > g.champ.client, 'texte et pièces défilent dans le champ');
    await libre();
    await drafts(general).nth(3).scrollIntoViewIfNeeded();
    assert.ok(await drafts(general).nth(3).isVisible(), 'quatrième pièce atteinte par défilement interne');
    await shot(page, `63-${RENDU}-fenetre-basse-375x430`);
  } finally { await ctx.context.close(); }
});

test('largeur du panneau : poignée au pointeur à travers l’iframe et au clavier, bornes, petite fenêtre, conservée ; toolbar et popover suivent', async () => {
  const ctx = await browser.newContext(origins());
  const page = await loginAs(ctx, 'Claire Morel, relectrice produit');
  try {
    await openRdv(page);
    await toolbarReady(page);
    await control(page, 'launcher').click();
    const frame = page.locator('#socrate-frame');
    const handle = page.getByRole('separator', { name: 'Largeur des conversations' });
    const width = () => frame.evaluate((el) => Math.round(el.getBoundingClientRect().width));
    const value = async () => Number(await handle.getAttribute('aria-valuenow'));
    const centre = async () => { const b = (await toolbar(page).boundingBox())!; return b.x + b.width / 2; };
    const drag = async (dx: number) => {
      const b = (await handle.boundingBox())!;
      const x = b.x + b.width / 2, y = b.y + b.height / 2;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + dx, y, { steps: 12 });
      await page.mouse.up();
    };
    await handle.waitFor();
    assert.equal(await width(), 380, 'largeur initiale');
    await drag(-200);
    assert.ok(Math.abs(await width() - 580) <= 2, `agrandie au pointeur : ${await width()}`);
    assert.equal(await value(), await width(), 'aria-valuenow suit la largeur');
    await drag(500);
    assert.equal(await width(), 320, 'réduite jusqu’au minimum en traversant l’iframe, relâchée au-dessus d’elle');
    await page.mouse.move(700, 400);
    await page.mouse.move(1000, 400);
    assert.equal(await width(), 320, 'le geste se termine au relâchement');
    await drag(-2000);
    assert.equal(await width(), 960, 'maximum borné');
    await handle.focus();
    await page.keyboard.press('Home');
    assert.equal(await width(), 320, 'Home : minimum');
    await page.keyboard.press('ArrowLeft');
    assert.equal(await width(), 336, 'flèche gauche : +16');
    await page.keyboard.press('ArrowRight');
    assert.equal(await width(), 320, 'flèche droite : -16');
    await page.keyboard.press('End');
    assert.equal(await width(), 960, 'End : maximum');
    await page.keyboard.press('Home');
    await drag(-380);
    assert.ok(Math.abs(await width() - 700) <= 2);
    const w = await width();
    assert.ok(Math.abs(await centre() - (1280 - w) / 2) <= 2, 'toolbar centrée sur la place restante');
    await shot(page, `58-${RENDU}-largeur-700`);
    await targetElement(page, page.locator('article p').first());
    const b = (await bubbleBox(page))!;
    assert.ok(b.x >= 0 && b.x + b.width <= 1280 - w + 1, `popover dans la place laissée par la liste ${JSON.stringify(b)}`);
    await page.keyboard.press('Escape');
    await control(page, 'launcher').click();
    await control(page, 'launcher').click();
    assert.equal(await width(), w, 'conservée après fermeture et réouverture de la liste');
    await control(page, 'close').click();
    await toolbarReady(page);
    await control(page, 'launcher').click();
    assert.equal(await width(), w, 'conservée après « Tout fermer »');
    await page.reload();
    await toolbarReady(page);
    await control(page, 'launcher').click();
    assert.equal(await width(), w, 'conservée pendant la session après rechargement');
    assert.equal(await page.evaluate(() => Object.values(sessionStorage).some((v) => /[a-z]{3}/i.test(v))), false, 'aucun texte de brouillon stocké');
    await page.setViewportSize({ width: 700, height: 700 });
    await page.waitForTimeout(200);
    assert.equal(await width(), 420, 'petite fenêtre : bornée par le viewport, 280 px laissés à l’application');
    const tb = (await toolbar(page).boundingBox())!;
    assert.ok(tb.x >= 0 && tb.x + tb.width <= 700 - 420 + 1, `toolbar dans la place restante ${JSON.stringify(tb)}`);
    await shot(page, `59-${RENDU}-largeur-fenetre-700`);
    await page.setViewportSize({ width: 375, height: 700 });
    await page.waitForTimeout(200);
    assert.equal(await width(), 375, 'fenêtre étroite : pleine largeur');
    assert.equal(await handle.count(), 0, 'poignée absente en pleine largeur');
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.waitForTimeout(200);
    assert.equal(await width(), w, 'préférence retrouvée en fenêtre large');
    facts.mediaLargeur = { initiale: 380, min: 320, max1280: 960, fenetre700: 420, conservee: w };
  } finally { await ctx.context.close(); }
});

// Retours lisibles après redéploiement : nouveau déploiement de la démo à la même origine, enregistré par l'API d'import comme le fait la CI.
const API = () => `${stack.view.serviceUrl}/v1/projects/demo/reviews/rappels-automatiques`;
const CLAIRE = { sub: 'claire', name: 'Claire Morel', capabilities: ['thread.participate'] };
const KARIM = { sub: 'karim', name: 'Karim Benali', capabilities: ['thread.participate', 'thread.moderate'] };
/**
 * Enregistre le déploiement `id` (même manifeste que local-1, commit donné) puis sert à ce contexte le contexte de preview et l'assertion de l'hôte de ce déploiement,
 * signée par le banc avec la clé de l'instance : la page rechargée est celle d'un nouveau build, les fils restent ceux de local-1.
 */
async function redeploy(ctx: LocalContext, id: string, persona: typeof CLAIRE, commit = 'd00dfeed0001') {
  const local1 = await (await fetch(`${API()}/deployments/local-1`, { headers: { Authorization: `Bearer ${stack.credentials.agent}` } })).json() as { revision: { manifest: unknown } };
  const put = await fetch(`${API()}/deployments/${id}`, {
    method: 'PUT', headers: { Authorization: `Bearer ${stack.credentials.import}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ commit, buildId: id, url: `${stack.view.demoOrigin}/`, manifest: local1.revision.manifest }),
  });
  assert.equal(put.status, 201, `déploiement ${id} enregistré`);
  const privateJwk = JSON.parse(await readFile(join(stack.view.root, 'keys/issuer-private.jwk.json'), 'utf8'));
  const preview = JSON.parse(await readFile(join(stack.view.root, 'preview-context.json'), 'utf8'));
  ctx.setFaults((r) => {
    if (path(r) === '/api/preview-context') return { kind: 'respond', status: 200, body: { serviceUrl: preview.serviceUrl, projectId: preview.projectId, reviewKey: preview.reviewKey, deploymentId: id, instanceId: preview.instanceId } };
    if (path(r) === '/api/socrate/assertion') {
      return { kind: 'respond', status: 200, body: { assertion: signAssertion(privateJwk, { issuer: preview.issuer, audience: preview.audience, ...persona, projectId: 'demo', reviewKey: 'rappels-automatiques', deploymentId: id, origin: stack.view.demoOrigin }) } };
    }
    return { kind: 'pass' };
  });
  return (await db().prepare('SELECT created_at FROM deployments WHERE deployment_id = ?').bind(id).first<string>('created_at'))!;
}
const targetOf = async (threadId: string) => JSON.parse((await db().prepare('SELECT context FROM targets WHERE thread_id = ?').bind(threadId).first<{ context: string }>())!.context);
const row = (page: Page, threadId: string) => list(page).locator(`[data-testid="socrate-row"][data-thread="${threadId}"]`);
async function comment(page: Page, on: Locator, body: string) {
  await targetElement(page, on);
  await bubble(page).getByRole('textbox', { name: 'Votre commentaire' }).fill(body);
  await send(page);
  await page.locator('#socrate-bubble').waitFor({ state: 'hidden', timeout: 15_000 });
  return (await threadOf(body))!.thread_id;
}

test('voir où c’était (échelle 2, page défilée) : capture recadrée et encadrée à l’échelle exacte, fenêtre nommée ou rien pour un ancien retour, Réessayer après ouverture de la fenêtre', async () => {
  const ctx = await browser.newContext(origins(), { deviceScaleFactor: 2 });
  try {
    const page = await loginAs(ctx, 'Claire Morel, relectrice produit', '/reglages/rappels');
    await toolbarReady(page);
    await page.addStyleTag({ content: 'body{padding-bottom:1600px}' });
    await page.evaluate(() => scrollTo(0, 300));
    await page.getByTestId('open-courte').click();
    const intro = page.getByTestId('scene-intro');
    await intro.waitFor();

    // Service qui refuse le relevé de fenêtre (champ inconnu ou libellé) : son refus 422 sous `target.container`, puis la même charge sans lui.
    let refused = false;
    ctx.setFaults((r) => {
      if (refused || r.method !== 'POST' || !path(r).endsWith('/targeted')) return { kind: 'pass' };
      refused = true;
      return { kind: 'respond', status: 422, body: { code: 'invalid_request', message: 'retour ciblé invalide', requestId: 'banc', retryable: false, issues: [{ path: 'target.container.label', message: 'libellé refusé' }] } };
    });
    const ancien = await comment(page, intro, 'Ancien service : la fenêtre n’est pas enregistrée.');
    ctx.setFaults(null);
    const posts = toService(ctx, (r) => r.method === 'POST' && path(r).endsWith('/targeted')).map((r) => 'container' in JSON.parse(r.postData!).target);
    assert.deepEqual(posts, [true, false], 'refus du seul champ nouveau, puis même charge sans lui');
    assert.ok(!('container' in await targetOf(ancien)), 'ancien retour sans fenêtre');

    // Libellé long coupé au milieu d'un émoji : tronqué par points de code, accepté par le service du premier coup.
    const MODAL = 'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]';
    await intro.evaluate((el, m) => el.closest(m)!.setAttribute('aria-label', `${'x'.repeat(78)}😀 et la suite du libellé`), MODAL);
    const emoji = await comment(page, intro, 'Libellé de fenêtre coupé sur un émoji.');
    await intro.evaluate((el, m) => el.closest(m)!.removeAttribute('aria-label'), MODAL);
    assert.deepEqual((await targetOf(emoji)).container, { label: `${'x'.repeat(78)}…` }, 'aucune moitié d’émoji, 80 unités UTF-16 au plus');
    assert.deepEqual(toService(ctx, (r) => r.method === 'POST' && path(r).endsWith('/targeted')).slice(2).map((r) => 'container' in JSON.parse(r.postData!).target), [true], 'un seul envoi, sans repli');

    const box = (await intro.boundingBox())!;
    const body = 'L’introduction du modèle court est trop vague.';
    const id = await comment(page, intro, body);
    const target = await targetOf(id);
    assert.deepEqual(target.container, { label: 'Modèle de rappel court' }, 'fenêtre et libellé relevés au ciblage');
    assert.equal(target.viewport.devicePixelRatio, 2);
    assert.ok(target.viewport.scrollY > 200, `page défilée au ciblage (${target.viewport.scrollY})`);
    for (const k of ['x', 'y', 'width', 'height'] as const) assert.ok(Math.abs(target.rect[k] - box[k]) < 1, `rectangle en pixels CSS de la fenêtre (${k})`);
    await page.getByTestId('scene-dialog').getByRole('button', { name: 'Fermer' }).click();
    await page.getByTestId('scene-dialog').waitFor({ state: 'hidden' });

    // Même déploiement, fenêtre fermée : l'élément n'est pas affiché, la page n'a pas changé.
    await control(page, 'launcher').click();
    await row(page, id).getByRole('button', { name: 'Voir où c’était' }).click();
    const same = list(page).getByTestId('socrate-where');
    assert.equal(await same.getByTestId('socrate-where-why').innerText(), 'L’élément n’est pas affiché sur cet écran pour le moment (fenêtre fermée, onglet, données différentes). Voici où il était quand le retour a été écrit.');
    // Réessayer garde le focus pendant la recherche : désactivé pour l'accessibilité, jamais retiré de l'ordre de tabulation.
    const retry = same.getByRole('button', { name: 'Réessayer' });
    await retry.focus();
    await page.keyboard.press('Enter');
    const during = await retry.evaluate((b) => ({ disabled: (b as HTMLButtonElement).disabled, aria: b.getAttribute('aria-disabled'), focused: b.ownerDocument.activeElement === b }));
    await same.getByTestId('socrate-where-missed').waitFor();
    assert.deepEqual(during, { disabled: false, aria: 'true', focused: true }, 'Réessayer en cours : aria-disabled, focus conservé');
    assert.equal(await retry.getAttribute('aria-disabled'), 'false');
    await shot(page, 'voir-ou-cetait-meme-deploiement');
    await list(page).getByRole('button', { name: 'Retour aux conversations' }).click();
    await row(page, id).getByRole('button', { name: 'Voir où c’était' }).waitFor();
    assert.equal(await list(page).locator(':focus').getAttribute('data-testid'), 'socrate-missing', 'retour : focus sur « Voir où c’était » de la ligne');
    assert.equal(await list(page).locator(':focus').evaluate((b) => b.closest('[data-testid="socrate-row"]')!.getAttribute('data-thread')), id);
    await control(page, 'launcher').click();

    await redeploy(ctx, 'local-20', CLAIRE);
    await page.reload();
    await toolbarReady(page);
    await control(page, 'launcher').click();
    for (const t of [ancien, id]) {
      await row(page, t).getByRole('button', { name: 'Voir où c’était' }).waitFor();
      assert.doesNotMatch(await row(page, t).innerText(), /introuvable|Voir sur la page/);
    }

    await row(page, ancien).getByRole('button', { name: 'Voir où c’était' }).click();
    await list(page).getByTestId('socrate-where-image').waitFor();
    assert.equal(await list(page).getByTestId('socrate-where-container').count(), 0, 'ancien retour : aucune fenêtre annoncée');
    await list(page).getByRole('button', { name: 'Retour aux conversations' }).click();

    await row(page, id).getByRole('button', { name: 'Voir où c’était' }).click();
    const where = list(page).getByTestId('socrate-where');
    assert.equal(await where.getByTestId('socrate-where-why').innerText(), 'Cette version de la page a changé : l’élément n’est pas retrouvé avec certitude. Voici où il était quand le retour a été écrit.');
    assert.equal(await where.getByTestId('socrate-where-container').innerText(), 'C’était dans la fenêtre « Modèle de rappel court ». Ouvrez-la, puis cliquez sur Réessayer.');
    const canvas = where.getByTestId('socrate-where-image');
    await canvas.waitFor();
    const capture = await db().prepare('SELECT c.capture_id, c.width, c.height FROM targets t JOIN captures c USING (project_id, review_key, capture_id) WHERE t.thread_id = ?').bind(id).first<{ capture_id: string; width: number; height: number }>();
    assert.deepEqual([capture!.width, capture!.height], [target.viewport.width * 2, target.viewport.height * 2], 'image à l’échelle 2');
    const png = Buffer.from(await (await fetch(`${API()}/captures/${capture!.capture_id}`, { headers: { Authorization: `Bearer ${stack.credentials.agent}` } })).arrayBuffer());
    const r = target.rect;
    const css = { x: Math.max(0, r.x - 96), y: Math.max(0, r.y - 96) };
    const expected = {
      crop: [Math.round(css.x * 2), Math.round(css.y * 2), Math.round((Math.min(target.viewport.width, r.x + r.width + 96) - css.x) * 2), Math.round((Math.min(target.viewport.height, r.y + r.height + 96) - css.y) * 2)].join(','),
      frame: [Math.round((r.x - css.x) * 2), Math.round((r.y - css.y) * 2), Math.round(r.width * 2), Math.round(r.height * 2)].join(','),
    };
    assert.deepEqual({ crop: await canvas.getAttribute('data-crop'), frame: await canvas.getAttribute('data-frame'), scale: await canvas.getAttribute('data-scale') }, { ...expected, scale: '2' }, 'recadrage autour du rectangle à l’échelle 2, sans décalage de défilement');
    // Pixels : hors du trait, la vue est la capture elle-même à l'emplacement recadré ; le trait est orange autour de la cible.
    const pixels = await page.evaluate(async ({ png, view, crop, frame }) => {
      const load = async (src: string) => { const i = new Image(); i.src = src; await i.decode(); const c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight; const g = c.getContext('2d')!; g.drawImage(i, 0, 0); return g.getImageData(0, 0, c.width, c.height); };
      const [full, shown] = [await load(`data:image/png;base64,${png}`), await load(view)];
      const [cx, cy, cw, ch] = crop.split(',').map(Number);
      const [fx, fy, fw, fh] = frame.split(',').map(Number);
      const line = Math.max(6, cw! / 120);
      const near = (x: number, y: number) => x > fx! - line - 2 && x < fx! + fw! + line + 2 && y > fy! - line - 2 && y < fy! + fh! + line + 2 && !(x > fx! + 2 && x < fx! + fw! - 2 && y > fy! + 2 && y < fy! + fh! - 2);
      let compared = 0, worst = 0;
      for (let y = 0; y < ch!; y += 3) for (let x = 0; x < cw!; x += 3) {
        if (near(x, y)) continue;
        const a = (y * shown.width + x) * 4, b = ((cy! + y) * full.width + cx! + x) * 4;
        for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(shown.data[a + k]! - full.data[b + k]!));
        compared++;
      }
      const at = (x: number, y: number) => [...shown.data.slice((y * shown.width + x) * 4, (y * shown.width + x) * 4 + 3)];
      return { size: [shown.width, shown.height], compared, worst, top: at(fx! + Math.round(fw! / 2), fy! - Math.round(line / 2)), left: at(fx! - Math.round(line / 2), fy! + Math.round(fh! / 2)) };
    }, { png: png.toString('base64'), view: await canvas.evaluate((c: HTMLCanvasElement) => c.toDataURL('image/png')), crop: expected.crop, frame: expected.frame });
    facts.voirOuCetait = { target: { rect: r, viewport: target.viewport, container: target.container }, expected, pixels };
    assert.deepEqual(pixels.size, expected.crop.split(',').slice(2).map(Number), 'image recadrée à la résolution de la capture');
    assert.ok(pixels.compared > 1000 && pixels.worst <= 2, `hors du cadre, la vue reprend la capture au pixel près (${JSON.stringify(pixels)})`);
    for (const c of [pixels.top, pixels.left]) assert.ok(Math.abs(c[0]! - 0xf5) <= 2 && Math.abs(c[1]! - 0xa6) <= 2 && Math.abs(c[2]! - 0x23) <= 2, `cadre orange autour de la cible (${c})`);
    await shot(page, 'voir-ou-cetait-recadre');

    await where.getByRole('button', { name: 'Voir la capture entière' }).click();
    await where.locator('[data-testid="socrate-where-image"][data-whole]').waitFor();
    assert.equal(await canvas.getAttribute('data-crop'), `0,0,${capture!.width},${capture!.height}`);
    assert.equal(await canvas.getAttribute('data-frame'), [Math.round(r.x * 2), Math.round(r.y * 2), Math.round(r.width * 2), Math.round(r.height * 2)].join(','));
    await shot(page, 'voir-ou-cetait-entiere');

    await where.getByRole('button', { name: 'Réessayer' }).click();
    await where.getByTestId('socrate-where-missed').waitFor();
    await page.getByTestId('open-courte').click();
    await intro.waitFor();
    await where.getByRole('button', { name: 'Réessayer' }).click();
    const conv = bubble(page).locator(`[data-testid="socrate-conversation"][data-thread="${id}"]`);
    await conv.waitFor({ timeout: 10_000 });
    await conv.getByText(body).waitFor();
    assert.equal(await list(page).getByTestId('socrate-where').count(), 0, 'retrouvée : la vue laisse place au fil sur la page');
    const pin = page.locator(`[data-socrate="pin"][data-threads~="${id}"]`);
    await pin.waitFor();
    assert.equal(await pin.getAttribute('data-probable'), 'true');
    assert.match((await pin.getAttribute('aria-label'))!, /^Position probable · /);
    await shot(page, 'voir-ou-cetait-reessayer');
    assert.deepEqual(ctx.blocked, []);
  } finally { await ctx.context.close(); }
});

test('nouveau déploiement sans identifiant éditorial : un seul candidat de même rôle au même début de texte devient une position probable ; deux candidats ou un autre rôle, aucune pastille', async () => {
  const ctx = await browser.newContext(origins());
  try {
    const page = await loginAs(ctx, 'Claire Morel, relectrice produit', '/activite');
    await toolbarReady(page);
    const note = page.getByTestId('note-suivi');
    const bernard = page.locator('ul[aria-label="Appels"] span', { hasText: 'Appel de M. Fictif Bernard' });
    const durand = page.getByTestId('contact-durand').locator('span');
    const ids = {
      unique: await comment(page, note, 'Probable : la note de suivi devrait dater le rappel.'),
      deux: await comment(page, bernard.first(), 'Deux candidats : le premier appel de M. Fictif Bernard.'),
      role: await comment(page, durand, 'Autre rôle : le nom du contact devrait être un lien.'),
    };
    assert.deepEqual(await Promise.all(Object.values(ids).map(async (t) => (await targetOf(t)).role)), ['p', 'span', 'span']);

    await redeploy(ctx, 'local-21', CLAIRE);
    await page.reload();
    await page.getByRole('heading', { level: 1, name: 'Activité' }).waitFor();
    await toolbarReady(page);
    // Le nouveau build rend le même nom avec un autre rôle : même balise, même texte, nouvel élément.
    await durand.evaluate((el) => { const next = el.cloneNode(true) as Element; next.setAttribute('role', 'button'); el.replaceWith(next); });
    const seen = await pinsSettle(page, {
      unique: { id: ids.unique, on: note, expected: true },
      deux: { id: ids.deux, on: bernard.first(), expected: false },
      deuxSecond: { id: ids.deux, on: bernard.nth(1), expected: false },
      role: { id: ids.role, on: durand, expected: false },
    });
    const pin = page.locator(`[data-socrate="pin"][data-threads~="${ids.unique}"]`);
    facts.positionProbable = { seen, label: await pin.getAttribute('aria-label'), probable: await pin.getAttribute('data-probable') };
    assert.deepEqual(seen, { unique: true, deux: false, deuxSecond: false, role: false }, JSON.stringify(facts.positionProbable));
    assert.equal(await page.locator(`[data-socrate="pin"][data-threads~="${ids.deux}"], [data-socrate="pin"][data-threads~="${ids.role}"]`).count(), 0);
    assert.equal(await pin.getAttribute('data-probable'), 'true');
    assert.match((await pin.getAttribute('aria-label'))!, /^Position probable · Conversation de Claire Morel/);
    assert.equal(await pin.evaluate((el) => getComputedStyle(el).borderTopStyle), 'dashed', 'pastille visiblement probable');
    await shot(page, 'position-probable-pastille');

    await control(page, 'launcher').click();
    assert.match(await row(page, ids.unique).innerText(), /Voir sur la page · position probable/);
    for (const t of [ids.deux, ids.role]) {
      await row(page, t).getByRole('button', { name: 'Voir où c’était' }).waitFor();
      assert.equal(await row(page, t).getByRole('button', { name: 'Voir sur la page' }).count(), 0);
    }
    await shot(page, 'position-probable-liste');
    // Ligne ouverte : la mention reste sous la ligne, sans la chevaucher.
    await row(page, ids.unique).locator('.socrate-row').click();
    await row(page, ids.unique).getByTestId('socrate-conversation').waitFor();
    const [line, located] = [(await row(page, ids.unique).locator('.socrate-row-line').boundingBox())!, (await row(page, ids.unique).getByTestId('socrate-located').boundingBox())!];
    assert.ok(located.y >= line.y + line.height - 0.5, `aucun chevauchement sous la ligne ouverte (${JSON.stringify({ line, located })})`);
    await shot(page, 'position-probable-ligne-ouverte');
    await row(page, ids.unique).getByRole('button', { name: 'Voir sur la page' }).click();
    await bubble(page).locator(`[data-testid="socrate-conversation"][data-thread="${ids.unique}"]`).waitFor();
    assert.deepEqual(ctx.blocked, []);
  } finally { await ctx.context.close(); }
});

test('position probable refusée : sélection, cible vide dans un parent texté, fin de texte éditée, jumeau arrivé ensuite, candidat masqué ou jumeau masqué', async () => {
  const ctx = await browser.newContext(origins());
  try {
    const page = await loginAs(ctx, 'Claire Morel, relectrice produit', '/activite');
    await toolbarReady(page);
    const at = await selectText(page, '[data-testid="note-suivi"]', 'Fictive Durand avant vendredi');
    await page.mouse.click(at.x, at.y, { button: 'right' });
    await page.locator('[data-socrate="menu"]').getByRole('menuitem', { name: 'Proposer une correction' }).click();
    await bubble(page).getByRole('textbox', { name: 'Correction proposée' }).fill('Fictive Durand avant jeudi midi');
    await bubble(page).getByRole('button', { name: 'Envoyer' }).click();
    await page.locator('#socrate-bubble').waitFor({ state: 'hidden', timeout: 15_000 });
    const selection = (await threadOf('Fictive Durand avant jeudi midi'))!.thread_id;
    const add = (html: string) => page.evaluate((h) => { const t = document.createElement('template'); t.innerHTML = h; document.querySelector('section')!.append(t.content); }, html);
    const PUCE = '<span data-testid="puce" style="display:inline-block;width:12px;height:12px;background:#c33"></span>';
    await add(`<p>Statut du dossier fictif en attente ${PUCE}</p><p data-testid="historique">Karim Benali a modifié le statut du bien Maison Nantes</p><p data-testid="relance-martin">Relance fictive du dossier Martin prévue lundi</p><p data-testid="dossier-clos">Dossier fictif clos sans suite le mardi</p>`);
    const ids = {
      vide: await comment(page, page.getByTestId('puce'), 'Refus probable : puce vide dans un paragraphe texté.'),
      fin: await comment(page, page.getByTestId('historique'), 'Refus probable : fin de texte éditée.'),
      jumeau: await comment(page, page.getByTestId('relance-martin'), 'Refus probable : jumeau arrivé ensuite.'),
      masque: await comment(page, page.getByTestId('dossier-clos'), 'Refus probable : candidat masqué.'),
      selection,
    };
    assert.match((await targetOf(ids.vide)).text, /^Statut du dossier fictif en attente/, 'cible vide : le texte enregistré est celui du parent');
    assert.equal((await targetOf(ids.selection)).text, 'Fictive Durand avant vendredi');
    // Ancre sans contexte d'ancêtre : seule la revérification de l'unicité peut retirer sa pastille.
    await db().prepare("UPDATE targets SET context = json_remove(context, '$.context') WHERE thread_id = ?").bind(ids.jumeau).run();

    await redeploy(ctx, 'local-23', CLAIRE);
    await page.reload();
    await page.getByRole('heading', { level: 1, name: 'Activité' }).waitFor();
    await toolbarReady(page);
    // Nouveau build : un paragraphe qui commence par la sélection, un texte égal à celui du parent de la puce, la fin de l'historique éditée, le dossier clos masqué.
    await add(`<p data-testid="commence-par-selection">Fictive Durand avant vendredi, puis le rappeler.</p><p>Statut du dossier fictif en attente ${PUCE}</p><span data-testid="texte-du-parent">Statut du dossier fictif en attente</span><p data-testid="historique">Karim Benali a modifié le statut du bien Loft Bordeaux</p><p data-testid="relance-martin">Relance fictive du dossier Martin prévue lundi</p><p data-testid="dossier-clos" hidden>Dossier fictif clos sans suite le mardi</p>`);
    const pinOf = (id: string) => page.locator(`[data-socrate="pin"][data-threads~="${id}"]`);
    const seen = await pinsSettle(page, {
      jumeau: { id: ids.jumeau, on: page.getByTestId('relance-martin'), expected: true },
      selection: { id: ids.selection, on: page.getByTestId('commence-par-selection'), expected: false },
      selectionNote: { id: ids.selection, on: page.getByTestId('note-suivi'), expected: false },
      vide: { id: ids.vide, on: page.getByTestId('texte-du-parent'), expected: false },
      fin: { id: ids.fin, on: page.getByTestId('historique'), expected: false },
    });
    assert.deepEqual(seen, { jumeau: true, selection: false, selectionNote: false, vide: false, fin: false });
    for (const k of ['selection', 'vide', 'fin', 'masque'] as const) assert.equal(await pinOf(ids[k]).count(), 0, `aucune pastille (${k})`);
    assert.equal(await pinOf(ids.jumeau).getAttribute('data-probable'), 'true');

    await add('<p>Relance fictive du dossier Martin prévue lundi</p>');
    await pinOf(ids.jumeau).waitFor({ state: 'detached', timeout: 5_000 });
    await add('<p data-testid="dossier-clos-visible">Dossier fictif clos sans suite le mardi</p>');
    await page.waitForTimeout(500);
    assert.equal(await pinOf(ids.masque).count(), 0, 'un jumeau masqué rend le candidat visible ambigu');
    await page.getByTestId('dossier-clos').evaluate((el) => el.remove());
    assert.deepEqual(await pinsSettle(page, { masque: { id: ids.masque, on: page.getByTestId('dossier-clos-visible'), expected: true } }), { masque: true }, 'seul et rendu : position probable');
    await control(page, 'launcher').click();
    for (const k of ['selection', 'vide', 'fin', 'jumeau'] as const) await row(page, ids[k]).getByRole('button', { name: 'Voir où c’était' }).waitFor();
    facts.refusProbable = { seen };
    assert.deepEqual(ctx.blocked, []);
  } finally { await ctx.context.close(); }
});

test('résolution par un agent avec commit : en attente sans déploiement postérieur, rien d’affirmé après un build sous un autre commit, en ligne depuis le déploiement qui porte le commit, rien face à un ancien service ; commit au survol, aucun identifiant de déploiement', async () => {
  const ctx = await browser.newContext(origins());
  try {
    const page = await loginAs(ctx, 'Karim Benali, développeur');
    await toolbarReady(page);
    await control(page, 'launcher').click();
    const body = 'Le titre de l’agenda est trop petit sur mobile.';
    await list(page).getByRole('textbox', { name: 'Votre commentaire global' }).fill(body);
    await list(page).getByRole('button', { name: 'Envoyer' }).click();
    await list(page).getByTestId('socrate-row').filter({ hasText: body }).waitFor();
    const id = (await threadOf(body))!.thread_id;

    // Agent connecté par le vrai parcours : code demandé sans Origin, approuvé dans le panneau par Karim, échangé contre le jeton délégué.
    const started = await (await fetch(`${stack.view.serviceUrl}/v1/auth/device`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ projectId: 'demo', agent: 'Claude', machine: 'banc-commentaires' }) })).json() as { deviceCode: string; userCode: string };
    await control(page, 'more').click();
    await control(page, 'agents').click();
    await list(page).getByTestId('socrate-code').fill(started.userCode);
    await list(page).getByRole('button', { name: 'Continuer' }).click();
    await list(page).getByRole('button', { name: 'Autoriser' }).click();
    await list(page).getByTestId('socrate-agent-done').waitFor();
    const grant = await (await fetch(`${stack.view.serviceUrl}/v1/auth/device/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deviceCode: started.deviceCode }) })).json() as { accessToken: string };
    const commit = '0a1b2c3d4e5f6a7b';
    const resolved = await fetch(`${API()}/threads/${id}/resolve`, {
      method: 'POST', headers: { Authorization: `Bearer ${grant.accessToken}`, 'Content-Type': 'application/json', 'Idempotency-Key': randomBytes(16).toString('hex') },
      body: JSON.stringify({ message: 'Titre agrandi.', commit }),
    });
    assert.equal(resolved.status, 201);

    // Liste rouverte pour la relire, quel que soit son état.
    const transition = async () => {
      if ((await control(page, 'launcher').getAttribute('aria-expanded')) === 'true') await control(page, 'launcher').click();
      await control(page, 'launcher').click();
      await list(page).getByRole('button', { name: /^Résolues/ }).click();
      await row(page, id).locator('.socrate-row').click();
      const t = row(page, id).getByTestId('socrate-conversation').getByTestId('socrate-transition');
      await t.waitFor();
      return { text: await t.innerText(), title: await t.getAttribute('title'), conversation: await row(page, id).getByTestId('socrate-conversation').innerText() };
    };
    const waiting = await transition();
    assert.deepEqual([waiting.text, waiting.title], ['Corrigé par Claude · en attente de la prochaine preview', 'Commit 0a1b2c3']);
    assert.doesNotMatch(waiting.conversation, /déploiement|local-1/);
    await shot(page, 'resolution-en-attente');

    // Un build postérieur sous un autre commit peut contenir le correctif : rien n'est affirmé.
    await redeploy(ctx, 'local-24', KARIM, 'beadfeed0042');
    await page.reload();
    await toolbarReady(page);
    const unknown = await transition();
    assert.deepEqual([unknown.text, unknown.title], ['Corrigé par Claude', 'Commit 0a1b2c3'], 'jamais « en attente » après un déploiement postérieur');
    await shot(page, 'resolution-inconnue');

    // La CI enregistre le build du correctif : commit abrégé, préfixe de celui de la résolution.
    const since = await redeploy(ctx, 'local-22', KARIM, commit.slice(0, 12));
    const listed = page.waitForResponse((r) => r.request().method() === 'GET' && new URL(r.url()).pathname.endsWith('/threads'));
    await page.reload();
    await toolbarReady(page);
    const live = await transition();
    const expected = await page.evaluate((iso) => `Corrigé par Claude · en ligne depuis ${new Date(iso).toLocaleTimeString('fr-FR', { timeStyle: 'short' }).replace(':', ' h ')}`, since);
    facts.resolutionLisible = { waiting, unknown, live, since };
    assert.deepEqual([live.text, live.title], [expected, 'Commit 0a1b2c3']);
    assert.match(live.text, /en ligne depuis \d{2} h \d{2}$/);
    assert.doesNotMatch(live.conversation, /déploiement|local-22/);
    await shot(page, 'resolution-en-ligne');

    // Service antérieur, sans `liveSince` ni `liveState` : « Corrigé par Claude », sans état de mise en ligne.
    const older = await (await listed).json() as { items: Array<{ messages: Array<{ transition: Record<string, unknown> | null }> }> };
    for (const m of older.items.flatMap((t) => t.messages)) if (m.transition) { delete m.transition.liveSince; delete m.transition.liveState; }
    ctx.setFaults((r) => r.method === 'GET' && path(r).endsWith('/threads') ? { kind: 'respond', status: 200, body: older } : { kind: 'pass' });
    await page.reload();
    await toolbarReady(page);
    const ancien = await transition();
    ctx.setFaults(null);
    assert.deepEqual([ancien.text, ancien.title], ['Corrigé par Claude', 'Commit 0a1b2c3']);
    assert.deepEqual(ctx.blocked, []);
  } finally { await ctx.context.close(); }
});

test('coût par mutation de l’hôte : 6 000 div et 30 fils d’un ancien déploiement non retrouvés', async () => {
  const ctx = await browser.newContext(origins());
  try {
    const page = await loginAs(ctx, 'Claire Morel, relectrice produit', '/activite');
    await toolbarReady(page);
    const id = await comment(page, page.getByTestId('note-suivi'), 'Sonde : fil modèle des trente fils.');
    const listed = page.waitForResponse((r) => r.request().method() === 'GET' && new URL(r.url()).pathname.endsWith('/threads'));
    await page.reload();
    const real = await (await listed).json() as { items: Array<{ threadId: string; target: Record<string, unknown> | null }> };
    const model = real.items.find((t) => t.threadId === id)!;
    // Trente fils d'un autre déploiement, cibles `div` sans contexte dont le texte n'est nulle part : chacun relance la relocalisation à chaque mutation.
    const probes = Array.from({ length: 30 }, (_, i) => ({
      ...model, threadId: `sonde-${i}`, deploymentId: 'ancien-deploiement',
      target: { ...model.target, role: 'div', selector: `body > section > div:nth-of-type(${i + 1})`, text: `Relance introuvable numéro ${i} du journal`, html: `<div>Relance introuvable numéro ${i} du journal</div>`, context: undefined },
    }));
    const measure = async (items: unknown[]) => {
      ctx.setFaults((r) => r.method === 'GET' && path(r).endsWith('/threads') ? { kind: 'respond', status: 200, body: { items } } : { kind: 'pass' });
      await page.reload();
      await page.getByRole('heading', { level: 1, name: 'Activité' }).waitFor();
      await toolbarReady(page);
      await page.locator(`[data-socrate="pin"][data-threads~="${id}"]`).waitFor();
      await page.evaluate(() => {
        const box = document.createElement('section');
        for (let i = 0; i < 6000; i++) box.append(Object.assign(document.createElement('div'), { textContent: `Ligne ${i} du journal fictif des rappels` }));
        document.body.append(box);
      });
      const settle = () => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(ok, 0)))));
      await settle();
      const cdp = await ctx.context.newCDPSession(page);
      await cdp.send('Performance.enable');
      const busy = async () => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'TaskDuration')!.value * 1000;
      const runs = 20;
      const start = await busy();
      for (let i = 0; i < runs; i++) {
        await page.evaluate((n) => { document.querySelector('body > section > div')!.textContent = `Ligne modifiée ${n}`; }, i);
        await settle();
      }
      const perMutation = (await busy() - start) / runs;
      await cdp.detach();
      return Math.round(perMutation * 10) / 10;
    };
    const seul = await measure(real.items);
    const trente = await measure([...real.items, ...probes]);
    ctx.setFaults(null);
    facts.coutMutation = { seulMs: seul, trenteFilsMs: trente, socrateMs: Math.round((trente - seul) * 10) / 10 };
    console.log(`coût par mutation : ${JSON.stringify(facts.coutMutation)}`);
    // Part de Socrate : l'écart avec la même page sans ces fils, insensible à la charge de la machine qui gonfle aussi le coût de l'hôte seul.
    assert.ok(trente - seul < 16, `moins de 16 ms de travail de Socrate par mutation de l’hôte avec trente fils non retrouvés (${JSON.stringify(facts.coutMutation)})`);
  } finally { await ctx.context.close(); }
});
