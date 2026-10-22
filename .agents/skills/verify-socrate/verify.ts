#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, allowPort, browser, deadlineIn, localCommand, localFetch, localPath, portNumber, runtime } from '../../../tools/local/local-run.ts';
import type { Page } from 'playwright';

const INSTANCE = 'verify';
const PORTS = { service: portNumber(process.env.SOCRATE_VERIFY_SERVICE_PORT ?? 8788, 'service'), demo: portNumber(process.env.SOCRATE_VERIFY_DEMO_PORT ?? 5174, 'démo') };
const RUNTIME_DIR = localPath('.local/runtime', INSTANCE);
const ARTIFACTS = localPath('.local/artifacts');
const LOG = join(ARTIFACTS, 'verify.log');
const DEMO_ORIGIN = `http://127.0.0.1:${PORTS.demo}`;
const SERVICE_URL = `http://127.0.0.1:${PORTS.service}`;
const FORBIDDEN_SOURCE = /(^|\/)(\.env(\..*)?|\.dev\.vars(\..*)?|[^/]*\.(token|pem|key|p12)|issuer-[^/]*\.jwk\.json)$|(^|\/)(\.local|\.tmp|node_modules|credentials|keys)\//;

const gitRaw = (...args: string[]) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' });
const git = (...args: string[]) => gitRaw(...args).trim();

export type SourceEntry = { status: string; path: string; from?: string };

export function parseStatus(porcelainZ: string): SourceEntry[] {
  const fields = porcelainZ.split('\0');
  const entries: SourceEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (field.length < 4) continue;
    const status = field.slice(0, 2);
    const entry: SourceEntry = { status, path: field.slice(3) };
    if (/[RC]/.test(status)) entry.from = fields[++i];
    entries.push(entry);
  }
  return entries;
}

export function sourceState(): { sha: string; dirty: string[] } {
  const head = git('rev-parse', 'HEAD');
  const artifactsRel = relative(REPO_ROOT, ARTIFACTS);
  const entries = parseStatus(gitRaw('status', '--porcelain=v1', '-z', '--untracked-files=all')).filter((e) => !e.path.startsWith(artifactsRel)).sort((a, b) => a.path.localeCompare(b.path));
  if (entries.length === 0) return { sha: head, dirty: [] };
  const hash = createHash('sha256');
  for (const e of entries) {
    for (const name of [e.path, e.from]) if (name !== undefined && FORBIDDEN_SOURCE.test(name)) throw new Error(`état source refusé sans lecture : ${name} n’est pas une source admissible`);
    hash.update(`${e.status} ${e.path}${e.from ? ` <- ${e.from}` : ''}\n`);
    const abs = localPath(e.path);
    if (!existsSync(abs)) {
      hash.update('supprimé\n');
      continue;
    }
    const st = lstatSync(abs);
    if (!st.isFile()) throw new Error(`état source refusé sans lecture : ${e.path} n’est pas un fichier ordinaire`);
    hash.update(`${(st.mode & 0o777).toString(8)} ${st.size}\n`);
    hash.update(readFileSync(abs));
  }
  return { sha: `${head}-dirty+${hash.digest('hex').slice(0, 12)}`, dirty: entries.map((e) => (e.from ? `${e.path} <- ${e.from}` : e.path)) };
}

async function record(line: string) {
  await mkdir(ARTIFACTS, { recursive: true });
  const src = sourceState();
  const entry = `${new Date().toISOString()} sha=${src.sha}${src.dirty.length ? ` dirty=${src.dirty.join(',')}` : ''} ${line}`;
  console.log(entry);
  await appendFile(LOG, entry + '\n');
}

async function launch() {
  const report = await localCommand({ action: 'launch', instance: INSTANCE, ports: PORTS, reset: true, detached: true, deadlineMs: 90_000 });
  if (report.kind !== 'ready') {
    await record(`launch REFUSE ${report.kind === 'refused' ? `${report.reason} ${report.detail}` : report.kind}`);
    throw new Error(report.kind === 'refused' ? report.detail : report.kind);
  }
  const i = report.instance;
  await record(`launch ok instance=${i.instanceId} build=${i.build.slice(0, 12)} schema=${i.schema.join('+')} demo=${i.demoOrigin} service=${i.serviceUrl} runtime=${relative(REPO_ROOT, i.root)}`);
}

async function doctor() {
  const report = await localCommand({ action: 'doctor', instance: INSTANCE, deadlineMs: 15_000 });
  const checks = report.kind === 'healthy' || report.kind === 'refused' ? report.checks ?? {} : {};
  const summary = Object.fromEntries(Object.entries(checks).map(([k, c]) => [k, `${c.ok ? 'ok' : 'ECHEC'} ${c.detail}`]));
  if (report.kind === 'refused' && !report.checks) summary.refus = `${report.reason} : ${report.detail}`;
  summary.source = sourceState().sha;
  await record(`doctor ${report.kind === 'healthy' ? 'sain' : 'DEFAILLANT'} ${JSON.stringify(summary)}`);
  if (report.kind !== 'healthy') process.exit(1);
}

const marker = (feature: string) => `Vérification ${feature} ${new Date().toISOString().replace(/[:.]/g, '-')}`;

async function agentThreads(): Promise<Array<{ threadId: string; state: string; messages: Array<{ body: string; author: { displayName: string } }> }>> {
  const agentToken = (await readFile(localPath('.local/runtime', INSTANCE, 'credentials/agent.token'), 'utf8')).trim();
  const revoke = allowPort(PORTS.service);
  try {
    const r = await localFetch(`${SERVICE_URL}/v1/projects/demo/reviews/rappels-automatiques/threads`, deadlineIn(10_000), { headers: { Authorization: `Bearer ${agentToken}` } });
    return (r.json as { items: Array<{ threadId: string; state: string; messages: Array<{ body: string; author: { displayName: string } }> }> }).items;
  } finally {
    revoke();
  }
}

async function drive(feature: string, scenario: (ctx: Awaited<ReturnType<Awaited<ReturnType<typeof browser>>['openBrowser']>>, dir: string, text: string) => Promise<void>) {
  const { openBrowser } = await browser();
  const run = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(ARTIFACTS, feature, run);
  await mkdir(dir, { recursive: true });
  const text = marker(feature);
  const local = await openBrowser();
  try {
    await scenario(local, dir, text);
    await writeFile(join(dir, 'puits-proxy.txt'), local.sinkAttempts.join('\n'));
    await record(`drive ${feature} PASS artefacts=${relative(REPO_ROOT, dir)} puits=${local.sinkAttempts.length} tentative(s) refusée(s)`);
  } catch (e) {
    await record(`drive ${feature} FAIL ${(e as Error).message} artefacts=${relative(REPO_ROOT, dir)}`);
    throw e;
  } finally {
    await local.close();
  }
}

/** Ces parcours pilotent le panneau historique, réactivé explicitement par le mode éditorial de la démo. */
const EDITORIAL = () => localStorage.setItem('socrate-editorial', '1');
/** Toolbar affichée à l'arrivée puis « Conversations » : remplace « Ouvrir la revue ». */
async function showList(page: Page) {
  await page.locator('[data-socrate="toolbar"]').waitFor();
  const launcher = page.locator('[data-socrate-action="launcher"]');
  if ((await launcher.getAttribute('aria-expanded')) !== 'true') await launcher.click();
}

const driveGlobalComment = () => drive('commentaire-global', async (local, dir, text) => {
  const ctx = await local.newContext([DEMO_ORIGIN, SERVICE_URL]);
  await ctx.context.addInitScript(EDITORIAL);
  const page = await ctx.context.newPage();
  try {
    await page.goto(`${DEMO_ORIGIN}/`);
    await page.getByRole('button', { name: /Se connecter comme Claire Morel, relectrice produit/ }).click();
    await showList(page);
    const panel = page.frameLocator('#socrate-frame');
    await panel.getByRole('heading', { level: 1, name: 'Rappels automatiques des rendez-vous' }).waitFor();
    await page.screenshot({ path: join(dir, '1-revue-ouverte.png') });
    await panel.getByRole('textbox', { name: 'Votre commentaire global' }).fill(text);
    await panel.getByRole('button', { name: 'Publier' }).click();
    await panel.getByRole('status').filter({ hasText: 'Commentaire publié.' }).waitFor();
    await page.screenshot({ path: join(dir, '2-commentaire-publie.png') });
    await page.reload();
    await showList(page);
    await panel.getByText(text).waitFor();
    await page.screenshot({ path: join(dir, '3-apres-rechargement.png') });
    await writeFile(join(dir, 'panneau.txt'), await page.evaluate(() => (document.getElementById('socrate-frame') as HTMLIFrameElement).contentDocument!.body.innerText));
    const items = await agentThreads();
    await writeFile(join(dir, 'lecture-agent.json'), JSON.stringify({ items }, null, 2));
    await writeFile(join(dir, 'requetes-service.txt'), ctx.seen.filter((r) => r.url.startsWith(SERVICE_URL)).map((r) => `${r.method} ${r.url} cookie=${r.headers['cookie'] ?? 'aucun'}`).join('\n'));
    await writeFile(join(dir, 'bloquees.txt'), ctx.blocked.join('\n'));
    const stored = items.filter((t) => t.messages[0]?.body === text);
    if (stored.length !== 1 || stored[0]!.messages[0]!.author.displayName !== 'Claire Morel') throw new Error(`retour durable attendu une fois, trouvé ${stored.length}`);
    if (ctx.seen.some((r) => r.url.startsWith(SERVICE_URL) && r.headers['cookie'])) throw new Error('un cookie hôte a atteint le service');
  } catch (e) {
    await page.screenshot({ path: join(dir, 'echec.png') }).catch(() => undefined);
    throw e;
  }
});

const driveResume = () => drive('reprise-envoi', async (local, dir, text) => {
  const ctx = await local.newContext([DEMO_ORIGIN, SERVICE_URL]);
  await ctx.context.addInitScript(EDITORIAL);
  const page = await ctx.context.newPage();
  try {
    await page.goto(`${DEMO_ORIGIN}/`);
    await page.getByRole('button', { name: /Se connecter comme Claire Morel, relectrice produit/ }).click();
    await showList(page);
    const panel = page.frameLocator('#socrate-frame');
    await panel.getByRole('heading', { level: 1, name: 'Rappels automatiques des rendez-vous' }).waitFor();
    let lost = false;
    ctx.setFaults((r) => {
      if (r.method === 'POST' && new URL(r.url).pathname.endsWith('/threads') && !lost) {
        lost = true;
        return { kind: 'lose-response' };
      }
      return { kind: 'pass' };
    });
    await panel.getByRole('textbox', { name: 'Votre commentaire global' }).fill(text);
    await panel.getByRole('button', { name: 'Publier' }).click();
    await panel.getByRole('alert').filter({ hasText: 'Votre brouillon est conservé' }).waitFor();
    await panel.getByTestId('socrate-pending').waitFor();
    await page.screenshot({ path: join(dir, '1-reponse-perdue.png') });
    const before = (await agentThreads()).filter((t) => t.messages[0]?.body === text);
    if (before.length !== 1) throw new Error(`le service devait avoir validé l’envoi une fois, trouvé ${before.length}`);
    await panel.getByRole('button', { name: 'Réessayer' }).click();
    await panel.getByRole('status').filter({ hasText: 'Commentaire publié.' }).waitFor();
    await page.screenshot({ path: join(dir, '2-reprise-sans-doublon.png') });
    const posts = ctx.seen.filter((r) => r.method === 'POST' && new URL(r.url).pathname.endsWith('/threads'));
    const keys = new Set(posts.map((r) => r.headers['idempotency-key']));
    await writeFile(join(dir, 'requetes-service.txt'), posts.map((r) => `${r.method} ${r.url} clé=${r.headers['idempotency-key']}`).join('\n'));
    if (posts.length !== 2 || keys.size !== 1) throw new Error(`deux émissions avec une seule clé attendues, vu ${posts.length} émissions et ${keys.size} clé(s)`);
    const after = (await agentThreads()).filter((t) => t.messages[0]?.body === text);
    await writeFile(join(dir, 'lecture-agent.json'), JSON.stringify({ items: after }, null, 2));
    if (after.length !== 1) throw new Error(`un seul retour attendu après reprise, trouvé ${after.length}`);
  } catch (e) {
    await page.screenshot({ path: join(dir, 'echec.png') }).catch(() => undefined);
    throw e;
  }
});

async function cleanup() {
  const report = await localCommand({ action: 'cleanup', instance: INSTANCE, deadlineMs: 30_000 });
  if (report.kind !== 'cleaned') {
    await record(`cleanup REFUSE ${report.kind === 'refused' ? `${report.reason} ${report.detail}` : report.kind}`);
    throw new Error(report.kind === 'refused' ? report.detail : report.kind);
  }
  const rt = await runtime();
  await record(`cleanup ok ${report.detail} ; enregistrement ${existsSync(rt.recordPathOf(RUNTIME_DIR)) ? 'présent' : 'retiré'} ; artefacts conservés sous ${relative(REPO_ROOT, ARTIFACTS)}`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [cmd, feature] = process.argv.slice(2);
  const features: Record<string, () => Promise<void>> = { 'commentaire-global': driveGlobalComment, 'reprise-envoi': driveResume };
  const commands: Record<string, () => Promise<void>> = {
    launch, doctor, cleanup,
    source: async () => {
      console.log(JSON.stringify(sourceState()));
    },
    drive: async () => {
      const fn = features[feature ?? ''];
      if (!fn) throw new Error(`fonctionnalité pilotable inconnue : ${feature ?? '(aucune)'}. Disponible : ${Object.keys(features).join(', ')}`);
      await fn();
    },
  };
  const fn = commands[cmd ?? ''];
  if (!fn) {
    console.error('usage : verify.ts launch | doctor | drive commentaire-global | drive reprise-envoi | cleanup | source');
    process.exit(2);
  }
  fn().catch((e) => { console.error(e.message ?? e); process.exit(1); });
}
