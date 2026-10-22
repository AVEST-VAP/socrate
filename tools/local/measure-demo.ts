import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { CDPSession, Page } from 'playwright';
import { REPO_ROOT, TMPDIR, deadlineIn, guardedPath, localPath, portNumber, runtime, browser as browserBoundary } from './local-run.ts';
import { staticClosure } from './build-graph.ts';
import { phaseTrace, traceProblems, type Traced } from './network-trace.ts';

type ChunkGraph = { file: string; entry: boolean; dynamic: boolean; imports: string[]; modules: string[] };
type Built = { name: string; dir: string; chunks: ChunkGraph[]; files: Array<{ file: string; bytes: number; gzip: number; sha256: string }> };

const VITE = localPath('node_modules/vite/bin/vite.js');
const SOCRATE_MODULE = /^(packages\/(react|contract)\/|apps\/demo\/src\/socrate\.tsx|apps\/demo\/\.socrate\/)/;
const REACT_MODULE = /node_modules\/(react|react-dom|scheduler)\//;

if (process.argv[2] === '--build') {
  const outDir = guardedPath(process.argv[3]!);
  const { build } = await import('vite');
  const chunks: ChunkGraph[] = [];
  await build({
    root: localPath('apps/demo'),
    logLevel: 'warn',
    mode: process.argv[4],
    build: { outDir, emptyOutDir: true },
    plugins: [{
      name: 'socrate-mesure-graphe',
      generateBundle(_, bundle) {
        for (const o of Object.values(bundle)) if (o.type === 'chunk') chunks.push({ file: o.fileName, entry: o.isEntry, dynamic: o.isDynamicEntry, imports: o.imports, modules: o.moduleIds.map((m) => relative(REPO_ROOT, m.replace(/^\0/, ''))) });
      },
    }],
  });
  await writeFile(`${outDir}.graph.json`, JSON.stringify(chunks, null, 1));
  process.exit(0);
}

const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
const label = dirty ? `${sha.slice(0, 7)}-dirty` : sha.slice(0, 7);
const OUT = localPath('.local/artifacts/mesure-preview', `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}`);
const BUILDS = localPath('.local/demo-builds', label);
const DEMO_PORT = portNumber(process.env.SOCRATE_MEASURE_PORT ?? 6779, 'mesure');
const RUNS = 5;
const REST_MS = 1000;
await mkdir(OUT, { recursive: true });
await mkdir(BUILDS, { recursive: true });

const baseEnv = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', TMPDIR, NODE_COMPILE_CACHE: localPath('.local/node-compile-cache') };

async function filesOf(dir: string, at = dir): Promise<Built['files']> {
  const out: Built['files'] = [];
  for (const e of await readdir(at, { withFileTypes: true })) {
    const p = join(at, e.name);
    if (e.isDirectory()) out.push(...(await filesOf(dir, p)));
    else {
      const bytes = await readFile(p);
      out.push({ file: relative(dir, p), bytes: bytes.length, gzip: gzipSync(bytes, { level: 9 }).length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

async function buildVariant(name: string, env: Record<string, string>, mode?: string): Promise<Built | { name: string; refused: string }> {
  const dir = join(BUILDS, name);
  const r = spawnSync(process.execPath, [import.meta.filename, '--build', dir, ...(mode ? [mode] : [])], { cwd: REPO_ROOT, env: { ...baseEnv, ...env }, encoding: 'utf8' });
  if (r.status !== 0) return { name, refused: (r.stderr || r.stdout).split('\n').find((l) => l.includes('SOCRATE_PREVIEW_BUILD refusé : "')) ?? `code ${r.status}` };
  return { name, dir, chunks: JSON.parse(await readFile(`${dir}.graph.json`, 'utf8')), files: await filesOf(dir) };
}

const socrateModules = (b: Built) => b.chunks.flatMap((c) => c.modules.filter((m) => SOCRATE_MODULE.test(m)));
const digest = (b: Built) => b.files.map((f) => `${f.sha256}  ${f.file}`).join('\n');
const chunkWith = (b: Built, module: string) => b.chunks.find((c) => c.modules.includes(module));

const manifest = JSON.parse(await readFile(localPath('apps/demo/.socrate/index.json'), 'utf8')) as { reviewKey: string; title: string; zones: string[] };
const zoneIds = await Promise.all(manifest.zones.map(async (z) => (JSON.parse(await readFile(localPath('apps/demo/.socrate', z), 'utf8')) as { id?: string; zoneId?: string; title?: string })));
const markers = [/socrate/i, new RegExp(manifest.reviewKey), new RegExp(manifest.title), /fiche-rendez-vous|reglages-rappels|rappel-delai|rappel-libelle|rappel-mention|ligne-rendez-vous/, /preview-context/, ...zoneIds.flatMap((z) => [z.id, z.zoneId, z.title].filter((v): v is string => !!v).map((v) => new RegExp(v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))))];

const variants = [
  ['temoin', {}],
  ['temoin-bis', {}],
  ['preview', { SOCRATE_PREVIEW_BUILD: 'true' }],
  ['preview-bis', { SOCRATE_PREVIEW_BUILD: 'true' }],
  ['leurre-false-explicite', { SOCRATE_PREVIEW_BUILD: 'false' }],
  ['leurre-node-env', { NODE_ENV: 'development' }],
  ['leurre-mode', {}, 'preview'],
  ['leurre-url-api', { VITE_SOCRATE_SERVICE_URL: 'http://127.0.0.1:11078', SOCRATE_SERVICE_URL: 'http://127.0.0.1:11078', VITE_API_URL: 'http://127.0.0.1:11078' }],
  ['leurre-indicateurs', { VITE_SOCRATE_PREVIEW: 'true', SOCRATE_PREVIEW: 'true', PREVIEW: 'true', CI: 'true', VERCEL_ENV: 'preview' }],
  ['refus-valeur-ambigue', { SOCRATE_PREVIEW_BUILD: '1' }],
] as const;
const built = new Map<string, Built | { name: string; refused: string }>();
for (const [name, env, mode] of variants) built.set(name, await buildVariant(name, env, mode));
const get = (name: string) => {
  const b = built.get(name)!;
  assert.ok(!('refused' in b), `build ${name} refusé : ${'refused' in b ? b.refused : ''}`);
  return b;
};
const temoin = get('temoin');
const preview = get('preview');

const checks: Array<{ check: string; ok: boolean; detail: string }> = [];
const check = (name: string, ok: boolean, detail: string) => checks.push({ check: name, ok, detail });

check('reproductible : deux builds témoin identiques octet par octet', digest(temoin) === digest(get('temoin-bis')), `${temoin.files.length} fichiers`);
check('reproductible : deux builds preview identiques octet par octet', digest(preview) === digest(get('preview-bis')), `${preview.files.length} fichiers`);
check('témoin : aucun module Socrate dans le graphe des chunks', socrateModules(temoin).length === 0, `${temoin.chunks.length} chunk(s), modules Socrate : ${JSON.stringify(socrateModules(temoin))}`);
check('témoin : un seul chunk, aucun import dynamique', temoin.chunks.length === 1 && !temoin.chunks.some((c) => c.dynamic), temoin.chunks.map((c) => c.file).join(', '));
const markerHits: string[] = [];
for (const f of temoin.files) {
  const text = await readFile(join(temoin.dir, f.file), 'utf8');
  for (const m of markers) if (m.test(text)) markerHits.push(`${f.file} : ${m}`);
}
check('témoin : aucun style, manifeste, attribut éditorial ni libellé Socrate dans les fichiers (contrôle secondaire)', markerHits.length === 0, markerHits.join(' ; ') || `${markers.length} motifs absents`);
for (const name of ['leurre-false-explicite', 'leurre-node-env', 'leurre-mode', 'leurre-url-api', 'leurre-indicateurs']) {
  const b = get(name);
  check(`activation : ${name} ne charge aucun module Socrate`, socrateModules(b).length === 0 && b.chunks.length === 1, `${b.chunks.length} chunk(s), identique au témoin : ${digest(b) === digest(temoin)}`);
}
const ambiguous = built.get('refus-valeur-ambigue')!;
check('activation : SOCRATE_PREVIEW_BUILD=1 refusé au build par le contrôle du drapeau', 'refused' in ambiguous && ambiguous.refused.includes('SOCRATE_PREVIEW_BUILD refusé : "1"'), 'refused' in ambiguous ? ambiguous.refused : 'build accepté');

const entry = preview.chunks.find((c) => c.entry)!;
const bootstrap = chunkWith(preview, 'apps/demo/src/socrate.tsx');
const panel = chunkWith(preview, 'packages/react/src/frame.tsx');
const guideChunk = chunkWith(preview, 'packages/react/src/guide.tsx');
const captureChunk = chunkWith(preview, 'packages/react/src/capture.ts');
// Panneau historique de l'option `editorial` : chunk distinct, chargé seulement quand la démo l'active explicitement.
const editorialChunk = chunkWith(preview, 'packages/react/src/panel.tsx');
// Conversion vidéo : mediabunny chargé seulement quand une vidéo doit être compressée, jamais avec le panneau ni l'aperçu des pièces.
const conversionChunk = chunkWith(preview, 'packages/react/src/convert.ts');
check('preview : le chunk d’entrée ne contient aucun module Socrate', !entry.modules.some((m) => SOCRATE_MODULE.test(m)), entry.file);
check('preview : bootstrap dynamique (intégration démo et lanceur) sans panneau, client ni styles', !!bootstrap?.dynamic && bootstrap !== panel && !['packages/react/src/panel.tsx', 'packages/react/src/client.ts', 'packages/react/src/styles.ts'].some((m) => bootstrap.modules.includes(m)), `${bootstrap?.file} : ${bootstrap?.modules.join(', ')}`);
for (const [name, c] of [['guidage et repères', guideChunk], ['capture', captureChunk]] as const) check(`preview : ${name} dans un chunk dynamique distinct du panneau et du bootstrap, sans module React`, !!c?.dynamic && c !== panel && c !== bootstrap && !c.modules.some((m) => REACT_MODULE.test(m)), `${c?.file} : ${c?.modules.join(', ')}`);
check('preview : racine, liste, bulle, client et styles dans un chunk dynamique distinct', !!panel?.dynamic && ['packages/react/src/conversation.tsx', 'packages/react/src/client.ts', 'packages/react/src/styles.ts'].every((m) => panel.modules.includes(m)), `${panel?.file}`);
check('preview : panneau éditorial dans un chunk dynamique distinct de la racine et du bootstrap', !!editorialChunk?.dynamic && editorialChunk !== panel && editorialChunk !== bootstrap, `${editorialChunk?.file}`);
const mediabunnyChunks = preview.chunks.filter((c) => c.modules.some((m) => m.includes('node_modules/mediabunny/'))).map((c) => c.file);
check('preview : conversion vidéo et mediabunny dans un chunk dynamique distinct du panneau et des pièces', !!conversionChunk?.dynamic && conversionChunk !== panel && !conversionChunk.modules.includes('packages/react/src/media.tsx') && mediabunnyChunks.every((f) => f === conversionChunk.file), `${conversionChunk?.file} ; chunks mediabunny : ${mediabunnyChunks.join(', ')}`);
const reactModules = preview.chunks.flatMap((c) => c.modules.filter((m) => REACT_MODULE.test(m)).map((m) => ({ m, chunk: c.file })));
check('preview : une seule copie de React et React DOM (chaque module une fois, tous dans le chunk d’entrée)', new Set(reactModules.map((r) => r.m)).size === reactModules.length && reactModules.every((r) => r.chunk === entry.file) && reactModules.some((r) => /react-dom\//.test(r.m)), reactModules.map((r) => r.m).join(', '));

const sizeOf = (b: Built, file: string) => b.files.find((f) => f.file === file)!;
const initial = (b: Built) => b.files.filter((f) => f.file === 'index.html' || f.file.endsWith('.css') || f.file === b.chunks.find((c) => c.entry)!.file);
const sum = (fs: Built['files'], k: 'bytes' | 'gzip') => fs.reduce((n, f) => n + f[k], 0);
const loadedFiles = new Set(staticClosure(preview.chunks, [entry.file, bootstrap!.file]));
const panelFiles = staticClosure(preview.chunks, [panel!.file]).filter((file) => !loadedFiles.has(file)).map((file) => sizeOf(preview, file));
const statique = {
  temoinInitial: { bytes: sum(initial(temoin), 'bytes'), gzip: sum(initial(temoin), 'gzip'), modules: temoin.chunks[0]!.modules.length },
  previewInitial: { bytes: sum(initial(preview), 'bytes'), gzip: sum(initial(preview), 'gzip'), modules: entry.modules.length },
  bootstrap: { file: bootstrap!.file, ...pick(sizeOf(preview, bootstrap!.file)), modules: bootstrap!.modules.length },
  panneau: { file: panel!.file, ...pick(sizeOf(preview, panel!.file)), modules: panel!.modules.length },
  panneauAvecImports: { bytes: sum(panelFiles, 'bytes'), gzip: sum(panelFiles, 'gzip'), files: panelFiles, dejaCharges: [...loadedFiles] },
  guide: { file: guideChunk!.file, ...pick(sizeOf(preview, guideChunk!.file)), modules: guideChunk!.modules.length },
  capture: { file: captureChunk!.file, ...pick(sizeOf(preview, captureChunk!.file)), modules: captureChunk!.modules.length },
  editorial: { file: editorialChunk!.file, ...pick(sizeOf(preview, editorialChunk!.file)), modules: editorialChunk!.modules.length },
  conversion: { file: conversionChunk!.file, ...pick(sizeOf(preview, conversionChunk!.file)), modules: conversionChunk!.modules.length },
};
function pick(f: { bytes: number; gzip: number }) {
  return { bytes: f.bytes, gzip: f.gzip };
}

const rt = await runtime();
const { openBrowser } = await browserBoundary();
const browser = await openBrowser({ autoAcceptTabCapture: true });
type Mode = 'temoin' | 'preview' | 'refus-bootstrap';
type Opening = { fils: number; revueDesTextes: number; requetes: Traced[]; incomplet: string[]; bloquees: string[]; echecs: string[] };
type Populated = Opening & { persistees: Array<Record<string, unknown>>; preparation: { bloquees: string[]; echecs: string[] } };
type Run = { peuplee?: Populated; defautVide?: Opening; lanceurAvantConnexion: number; lanceurConnecte: number; attributsEditoriaux: number; iframe: number; stylesHoteAvant: unknown; stylesHoteApres: unknown; stylesPanneau: unknown; feuillesHote: unknown; navigationHote: string[]; repos: Rest[]; reperes: Record<string, unknown>; capture: { images: Array<{ ms: number; tachesLongues: number[] }>; etats: string[] }; requetes: Traced[]; incomplet: string[]; bloquees: string[]; echecs: string[]; arret: unknown; serviceOrigin: string };
const HOST_PROBES = { body: 'body', titre: 'main h1', article: 'article', bouton: 'article button', topbar: '.topbar' } as const;
const hostStyles = (page: Page) => page.evaluate((probes) => Object.fromEntries(Object.entries(probes).map(([k, sel]) => {
  const el = document.querySelector(sel);
  if (!el) return [k, null];
  const cs = getComputedStyle(el);
  return [k, { fontFamily: cs.fontFamily, fontSize: cs.fontSize, fontStyle: cs.fontStyle, color: cs.color, background: cs.backgroundColor, border: cs.border, textTransform: cs.textTransform, padding: cs.padding, margin: cs.margin }];
})), HOST_PROBES);

/**
 * Sonde de banc posée à l'identique chez le témoin et la preview. Elle relève les observateurs DOM vivants, les minuteries,
 * animations et messages demandés pendant une fenêtre, attribués au premier fichier construit `/assets/*.js` de la pile, et
 * les tâches longues. Un appel sans fichier construit dans sa pile (script injecté de Playwright, sonde) reste `hors-demo`.
 */
const MEASURE_PROBE = () => {
  const live = new Map<MutationObserver, string>();
  const calls: Record<string, number> = {};
  const longTasks: Array<{ start: number; duration: number }> = [];
  let since = -1;
  const count = (api: string) => {
    if (since < 0) return;
    const k = `${api} ${/\/assets\/[^/:)\s]+\.js/.exec(String(new Error().stack).split('\n').slice(3).join('\n'))?.[0] ?? 'hors-demo'}`;
    calls[k] = (calls[k] ?? 0) + 1;
  };
  const w = window as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const api of ['setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback']) {
    const original = w[api];
    if (original) w[api] = function (this: unknown, ...a: unknown[]) { count(api); return original.apply(this, a); };
  }
  const post = MessagePort.prototype.postMessage as (...a: unknown[]) => void;
  MessagePort.prototype.postMessage = function (this: MessagePort, ...a: unknown[]) { count('postMessage'); return post.apply(this, a); } as typeof MessagePort.prototype.postMessage;
  const observe = MutationObserver.prototype.observe;
  const disconnect = MutationObserver.prototype.disconnect;
  MutationObserver.prototype.observe = function (this: MutationObserver, ...a: Parameters<typeof observe>) {
    const from = String(new Error().stack).split('\n').slice(2, 4).join(' | ');
    if (!from.includes('InjectedScript')) live.set(this, from);
    return observe.apply(this, a);
  };
  MutationObserver.prototype.disconnect = function (this: MutationObserver) { live.delete(this); return disconnect.call(this); };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) longTasks.push({ start: e.startTime, duration: Math.round(e.duration) }); }).observe({ type: 'longtask', buffered: true });
  Object.assign(window, { __mesure: {
    open() { for (const k of Object.keys(calls)) delete calls[k]; since = performance.now(); },
    close() { const from = since; since = -1; return { appels: { ...calls }, tachesLongues: longTasks.filter((t) => t.start >= from).map((t) => t.duration), observateurs: [...live.values()] }; },
    now: () => performance.now(),
    longSince: (t: number) => longTasks.filter((x) => x.start >= t).map((x) => x.duration),
    observers: () => [...live.values()],
  } });
};
type Probe = { open(): void; close(): { appels: Record<string, number>; tachesLongues: number[]; observateurs: string[] }; now(): number; longSince(t: number): number[]; observers(): string[] };
/** CPU cumulé des processus Chromium descendants de ce banc, lu par ps sans signal ni action sur aucun processus (résolution 10 ms). */
function chromiumCpuMs(): number {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,time=,comm='], { encoding: 'utf8' }).trim().split('\n').map((l) => l.trim().split(/\s+/));
  const children = new Map<string, string[]>();
  for (const [pid, ppid] of rows) children.set(ppid!, [...(children.get(ppid!) ?? []), pid!]);
  const own = new Set<string>();
  for (const todo = [String(process.pid)]; todo.length;) for (const c of children.get(todo.pop()!) ?? []) if (!own.has(c)) { own.add(c); todo.push(c); }
  return rows.filter(([pid, , , ...comm]) => own.has(pid!) && /chrom/i.test(comm.join(' '))).reduce((n, [, , time]) => n + time!.split(':').reduce((a, x) => a * 60 + Number(x), 0) * 1000, 0);
}
type Rest = { etat: string; requetes: number; tacheMs: number; scriptMs: number; cpuChromiumMs: number; appels: Record<string, number>; tachesLongues: number[]; observateurs: string[] };
/** Fenêtre de repos déclarée : aucun geste du banc pendant REST_MS ; durées de tâche et de script du thread principal relevées par CDP. */
async function rest(page: Page, cdp: CDPSession, seen: () => number, etat: string): Promise<Rest> {
  const metric = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value])) as Record<string, number>;
  const n = seen();
  const cpu = chromiumCpuMs();
  const before = await metric();
  await page.evaluate(() => (window as unknown as { __mesure: Probe }).__mesure.open());
  await page.waitForTimeout(REST_MS);
  const counted = await page.evaluate(() => (window as unknown as { __mesure: Probe }).__mesure.close());
  const after = await metric();
  const cpuChromiumMs = Math.round(chromiumCpuMs() - cpu);
  return { etat, requetes: seen() - n, cpuChromiumMs, tacheMs: Math.round((after.TaskDuration! - before.TaskDuration!) * 1e4) / 10, scriptMs: Math.round((after.ScriptDuration! - before.ScriptDuration!) * 1e4) / 10, ...counted };
}

const PROPOSAL = 'Remplacement mesuré depuis la sélection éditoriale.';
const LOGIN = /Se connecter comme Claire Morel, relectrice produit/;

/** Mode éditorial explicite de la démo pour un contexte : seules les phases qui mesurent ses surfaces l'activent. */
const EDITORIAL = () => localStorage.setItem('socrate-editorial', '1');
const toAppointment = async (page: Page) => {
  await page.getByRole('link', { name: 'Ouvrir le rendez-vous de 14 h 30' }).click();
  await page.getByRole('heading', { level: 1, name: /Rendez-vous du 21 octobre/ }).waitFor();
};

/**
 * Ouverture par défaut dans un contexte neuf : toolbar affichée à l'arrivée connectée, puis liste des conversations.
 * Peuplée, le fil de la proposition est déplié dans la liste pour lire la proposition ; la revue des textes n'existe pas dans ce mode.
 */
async function openDefault(stack: Awaited<ReturnType<typeof rt.launchInstance>>, populated: boolean, shotName: string): Promise<Opening> {
  const ctx = await browser.newContext([stack.view.demoOrigin, stack.view.serviceUrl]);
  try {
    const page = await ctx.context.newPage();
    const trace = phaseTrace(ctx, 'avant-connexion');
    const incomplet: string[] = [];
    const settle = async () => {
      incomplet.push(...(await trace.settle()));
    };
    await page.goto(`${stack.view.demoOrigin}/`);
    await page.getByRole('button', { name: LOGIN }).waitFor();
    await settle();
    trace.begin('connecte');
    await page.getByRole('button', { name: LOGIN }).click();
    await page.getByRole('heading', { level: 1, name: 'Agenda' }).waitFor();
    await page.locator('[data-socrate="toolbar"]').waitFor();
    await toAppointment(page);
    await settle();
    trace.begin('liste-ouverte');
    await page.locator('[data-socrate-action="launcher"]').click();
    const frame = page.frameLocator('#socrate-frame');
    await frame.getByRole('heading', { level: 1, name: 'Conversations' }).waitFor({ timeout: 15_000 });
    if (populated) {
      await frame.getByTestId('socrate-row').filter({ hasText: PROPOSAL }).getByRole('button').first().click();
      await frame.getByTestId('socrate-proposal').getByText(PROPOSAL, { exact: false }).waitFor({ timeout: 15_000 });
    } else await frame.getByTestId('socrate-empty').waitFor({ timeout: 15_000 });
    await settle();
    const fils = await frame.getByTestId('socrate-row').count();
    const revueDesTextes = await frame.getByTestId('socrate-wording').count();
    await page.screenshot({ path: join(OUT, shotName) });
    return { fils, revueDesTextes, requetes: trace.records(), incomplet, bloquees: ctx.blocked, echecs: ctx.failed };
  } finally {
    await ctx.context.close();
  }
}

/**
 * Ouverture peuplée : une proposition de liste publiée par la vraie interface (revue des textes du mode éditorial) dans un premier contexte,
 * relue en base puis ce contexte fermé ; la revue est ensuite ouverte par défaut dans un contexte neuf, avec la même trace.
 */
async function openPopulated(stack: Awaited<ReturnType<typeof rt.launchInstance>>): Promise<Populated> {
  const origins = [stack.view.demoOrigin, stack.view.serviceUrl];
  const seed = await browser.newContext(origins);
  try {
    await seed.context.addInitScript(EDITORIAL);
    const page = await seed.context.newPage();
    await page.goto(`${stack.view.demoOrigin}/`);
    await page.getByRole('button', { name: LOGIN }).click();
    await toAppointment(page);
    await page.locator('[data-socrate="toolbar"]').waitFor();
    await page.locator('[data-socrate-action="launcher"]').click();
    const frame = page.frameLocator('#socrate-frame');
    await frame.getByRole('button', { name: 'Ouvrir la revue des textes' }).click();
    const card = frame.locator('[data-testid="socrate-wording"][data-wording="rappel-email"]');
    await card.getByRole('textbox', { name: /Remplacement proposé pour/ }).fill(PROPOSAL);
    await card.getByRole('button', { name: 'Proposer', exact: true }).click();
    await card.getByText('Proposition publiée, sans capture.', { exact: true }).waitFor();
  } finally {
    await seed.context.close();
  }
  const persistees = (await stack.service.db.prepare('SELECT t.kind, p.wording_id, p.replacement, p.source_revision_id FROM proposals p JOIN threads t ON t.project_id = p.project_id AND t.review_key = p.review_key AND t.thread_id = p.thread_id').all<Record<string, unknown>>()).results;
  return { persistees, preparation: { bloquees: seed.blocked, echecs: seed.failed }, ...(await openDefault(stack, true, 'preview-6-ouverture-peuplee.png')) };
}

async function drive(b: Built, mode: Mode) {
  const opensReview = mode === 'preview';
  const root = await mkdtemp(join(REPO_ROOT, '.tmp', 'mesure-'));
  const stack = await rt.launchInstance({ root, name: `mesure-${mode}`, ports: { service: 0, demo: DEMO_PORT }, reset: false, deadline: deadlineIn(90_000), hostCommand: [VITE, 'preview', '--outDir', b.dir, '--clearScreen', 'false'] });
  const result: Partial<Run> = {};
  try {
    const ctx = await browser.newContext([stack.view.demoOrigin, stack.view.serviceUrl]);
    await ctx.context.addInitScript(MEASURE_PROBE);
    // Phases historiques (repères, panneau éditorial) : mode éditorial explicitement activé ; l'ouverture par défaut est mesurée à part.
    if (opensReview) await ctx.context.addInitScript(EDITORIAL);
    const page = await ctx.context.newPage();
    const cdp = await ctx.context.newCDPSession(page);
    await cdp.send('Performance.enable');
    const seen = () => ctx.seen.length;
    const repos: Rest[] = [];
    result.repos = repos;
    const rests = async (etat: string, n = RUNS) => { for (let i = 0; i < n; i++) repos.push(await rest(page, cdp, seen, etat)); };
    if (mode === 'refus-bootstrap') ctx.setFaults((r) => (new URL(r.url).pathname === `/${bootstrap!.file}` ? { kind: 'abort' } : { kind: 'pass' }));
    const trace = phaseTrace(ctx, 'avant-connexion');
    const incomplete: string[] = [];
    const settle = async () => {
      incomplete.push(...(await trace.settle()));
    };
    await page.goto(`${stack.view.demoOrigin}/`);
    await page.getByRole('button', { name: /Se connecter comme Claire Morel, relectrice produit/ }).waitFor();
    await settle();
    result.lanceurAvantConnexion = await page.locator('[data-socrate="launcher"]').count();
    await page.screenshot({ path: join(OUT, `${mode}-1-avant-connexion.png`) });
    trace.begin('connecte');
    await page.getByRole('button', { name: /Se connecter comme Claire Morel, relectrice produit/ }).click();
    await page.getByRole('heading', { level: 1, name: 'Agenda' }).waitFor();
    if (opensReview) await page.locator('[data-socrate="toolbar"]').waitFor();
    await page.getByRole('link', { name: 'Ouvrir le rendez-vous de 14 h 30' }).click();
    await page.getByRole('heading', { level: 1, name: /Rendez-vous du 21 octobre/ }).waitFor();
    await settle();
    result.lanceurConnecte = await page.locator('[data-socrate="launcher"]').count();
    result.attributsEditoriaux = await page.locator('[data-socrate-id]').count();
    result.iframe = await page.locator('#socrate-frame').count();
    result.stylesHoteAvant = await hostStyles(page);
    await page.screenshot({ path: join(OUT, `${mode}-2-connecte.png`) });
    if (mode !== 'refus-bootstrap') await rests('connecte');
    if (opensReview) {
      trace.begin('liste-ouverte');
      await page.locator('[data-socrate-action="launcher"]').click();
      await page.frameLocator('#socrate-frame').getByRole('heading', { level: 1, name: manifest.title }).waitFor({ timeout: 15_000 });
      await settle();
      result.stylesHoteApres = await hostStyles(page);
      result.stylesPanneau = await page.frameLocator('#socrate-frame').locator('body').evaluate((body) => {
        const doc = body.ownerDocument;
        const cs = (el: Element | null) => el && { fontFamily: getComputedStyle(el).fontFamily, textTransform: getComputedStyle(el).textTransform, border: getComputedStyle(el).border, background: getComputedStyle(el).backgroundColor };
        return { body: cs(doc.body), bouton: cs(doc.querySelector('button.socrate-button')), titre: { ...cs(doc.querySelector('h1')), fontStyle: getComputedStyle(doc.querySelector('h1')!).fontStyle }, feuilles: doc.styleSheets.length, hoteDansPanneau: [...doc.querySelectorAll('link[rel=stylesheet]')].length };
      });
      result.feuillesHote = await page.evaluate(() => [...document.styleSheets].map((s) => s.href ?? `inline:${(s.ownerNode as Element | null)?.tagName}`));
      await page.screenshot({ path: join(OUT, `${mode}-3-liste-ouverte.png`) });
      await rests('liste-ouverte');

      const frame = page.frameLocator('#socrate-frame');
      const toggle = frame.getByRole('button', { name: 'Voir les changements' });
      const shown = frame.getByRole('status').filter({ hasText: 'repère(s) affiché(s)' });
      const dom = () => page.evaluate(() => ({ reperes: document.querySelectorAll('[data-socrate="marker"]').length, notes: document.querySelectorAll('[data-socrate="marker-note"]').length, observateurs: (window as unknown as { __mesure: Probe }).__mesure.observers() }));
      trace.begin('reperes-actifs');
      await toggle.click();
      await shown.waitFor();
      const actifs = await dom();
      await page.locator('[data-socrate="marker"]').first().click();
      await page.locator('[data-socrate="marker-note"]').waitFor();
      await settle();
      result.reperes = { statut: await shown.innerText(), actifs, apresClic: await dom(), routeApresClic: await page.evaluate(() => location.pathname) };
      await page.screenshot({ path: join(OUT, `${mode}-4-reperes-explication.png`) });
      trace.begin('reperes-desactives');
      // Alternance actif puis désactivé dans la même page : même bruit pour les deux états.
      for (let i = 0; i < RUNS; i++) {
        repos.push(await rest(page, cdp, seen, 'reperes-actifs'));
        await toggle.click();
        await shown.waitFor({ state: 'detached' });
        repos.push(await rest(page, cdp, seen, 'reperes-desactives'));
        if (i < RUNS - 1) {
          await toggle.click();
          await shown.waitFor();
        }
      }
      await settle();
      result.reperes = { ...result.reperes, desactives: await dom() };

      trace.begin('capture-active');
      // « Commenter un élément » active le partage puis démarre la sélection ; un second clic l'annule et laisse le partage actif.
      const target = page.locator('[data-socrate="toolbar"] [data-socrate-action="target"]');
      const grant = async () => {
        await target.click();
        await captureIs('selecting');
        await target.click();
        await captureIs('active');
      };
      const captureIs = (state: string) => frame.locator(`[data-testid="socrate-capture-status"][data-capture="${state}"]`).waitFor({ timeout: 15_000 });
      const etats: string[] = [];
      await grant();
      etats.push('active');
      await settle();
      // Alternance flux actif puis arrêté par le bouton du panneau, réactivé par le contrôle de la page. La première fenêtre suit le geste, la seconde l'état établi.
      for (let i = 0; i < RUNS; i++) {
        repos.push(await rest(page, cdp, seen, 'capture-octroi'));
        repos.push(await rest(page, cdp, seen, 'capture-active'));
        await frame.getByRole('button', { name: 'Arrêter le partage' }).click();
        await captureIs('inactive:stopped');
        repos.push(await rest(page, cdp, seen, 'capture-arret'));
        repos.push(await rest(page, cdp, seen, 'capture-arretee'));
        await grant();
        etats.push('inactive:stopped', 'active');
      }
      const fiche = (await page.locator('[data-socrate-id="fiche-rendez-vous"]').boundingBox())!;
      const images: Array<{ ms: number; tachesLongues: number[] }> = [];
      let previous: string | null = null;
      for (let i = 0; i < RUNS; i++) {
        await target.click();
        await captureIs('selecting');
        if (i === 0) repos.push(await rest(page, cdp, seen, 'selection'));
        const t0 = await page.evaluate(() => (window as unknown as { __mesure: Probe }).__mesure.now());
        await page.mouse.click(fiche.x + 40, fiche.y + 20);
        previous = await (await page.waitForFunction((prev) => {
          const img = (document.getElementById('socrate-frame') as HTMLIFrameElement | null)?.contentDocument?.querySelector<HTMLImageElement>('[data-testid="socrate-shot"] img');
          return img && img.src !== prev ? img.src : false;
        }, previous, { timeout: 10_000, polling: 'raf' })).jsonValue() as string;
        const t1 = await page.evaluate(() => (window as unknown as { __mesure: Probe }).__mesure.now());
        await captureIs('active');
        images.push({ ms: Math.round(t1 - t0), tachesLongues: await page.evaluate((t) => (window as unknown as { __mesure: Probe }).__mesure.longSince(t), t0) });
      }
      await settle();
      await page.screenshot({ path: join(OUT, `${mode}-5-capture-image.png`) });
      await rests('capture-apres-image');
      result.capture = { images, etats };
    }
    result.navigationHote = [];
    if (mode === 'refus-bootstrap') {
      await page.getByRole('banner').getByRole('link', { name: 'Réglages' }).click();
      await page.getByRole('heading', { level: 1, name: 'Rappels automatiques' }).waitFor({ timeout: 10_000 });
      result.navigationHote.push('réglages');
      await page.getByRole('banner').getByRole('link', { name: 'Agenda' }).click();
      await page.getByRole('link', { name: 'Ouvrir le rendez-vous de 14 h 30' }).waitFor({ timeout: 10_000 });
      result.navigationHote.push('agenda');
      await settle();
      result.lanceurConnecte = result.lanceurConnecte! + (await page.locator('[data-socrate="launcher"]').count());
      await page.screenshot({ path: join(OUT, `${mode}-3-navigation-hote.png`) });
    }
    result.requetes = trace.records();
    result.incomplet = incomplete;
    result.bloquees = ctx.blocked;
    result.echecs = ctx.failed;
    await ctx.context.close();
    if (opensReview) {
      result.defautVide = await openDefault(stack, false, 'preview-6-ouverture-defaut-vide.png');
      result.peuplee = await openPopulated(stack);
    }
  } finally {
    const stopped = await stack.stop('fin de la mesure');
    result.arret = stopped;
    assert.ok(stopped.confirmed, stopped.detail);
  }
  return { ...result, serviceOrigin: stack.view.serviceUrl } as Run;
}

const chunkModules = (b: Built, path: string) => b.chunks.find((c) => `/${c.file}` === path)?.modules.length ?? 0;
function phases(b: Built, requetes: Traced[], list: string[]) {
  const upTo = (i: number) => requetes.filter((s) => list.slice(0, i + 1).includes(s.phase));
  return Object.fromEntries(list.map((p, i) => {
    const rs = upTo(i);
    return [p, { requetes: rs.length, octets: rs.reduce((n, s) => n + s.bytes!, 0), modules: rs.reduce((n, s) => n + chunkModules(b, s.path), 0), fichiers: [...new Set(rs.filter((s) => /\.(js|css|html)$/.test(s.path) || s.path === '/').map((s) => s.path))] }];
  }));
}

let runs: Record<Mode, Run> | null = null;
try {
  runs = { temoin: await drive(temoin, 'temoin'), preview: await drive(preview, 'preview'), 'refus-bootstrap': await drive(preview, 'refus-bootstrap') };
} finally {
  await browser.close();
}
const t = runs.temoin;
const p = runs.preview;
const r = runs['refus-bootstrap'];
const tSeen = t.requetes;
const pSeen = p.requetes;
const initial401 = (s: Traced) => s.phase === 'avant-connexion' && s.method === 'GET' && s.path === '/api/me' && s.status === 401;
const refusedBootstrap = (s: Traced) => s.path === `/${bootstrap!.file}` && s.error === 'abort injecté';
for (const [name, run] of [['témoin', t], ['preview', p]] as const) {
  const problems = traceProblems(run.requetes, { blocked: run.bloquees, failed: run.echecs }, run.incomplet, initial401);
  check(`trace ${name} : collecte complète, aucune tentative bloquée, échouée ou au statut inattendu, seul le 401 initial de /api/me attendu`, problems.length === 0 && run.requetes.filter(initial401).length === 1, problems.join(' ; ') || `${run.requetes.length} requêtes, 401 initial ${run.requetes.filter(initial401).length}`);
}
const rProblems = traceProblems(r.requetes, { blocked: r.bloquees, failed: r.echecs }, r.incomplet, (s) => initial401(s) || refusedBootstrap(s));
check('refus du bootstrap : chunk refusé une fois après connexion, hôte et navigation utilisables, aucune entrée de revue ni requête Socrate', rProblems.length === 0 && r.requetes.filter((s) => refusedBootstrap(s) && s.phase === 'connecte').length === 1 && r.navigationHote.length === 2 && r.lanceurConnecte === 0 && r.iframe === 0 && !r.requetes.some((s) => s.origin === r.serviceOrigin || s.path.startsWith('/api/preview-context') || s.path.startsWith('/api/socrate/')), rProblems.join(' ; ') || `navigation ${r.navigationHote.join(', ')}, lanceur ${r.lanceurConnecte}, ${r.requetes.length} requêtes`);
const socrateRequest = (s: Traced, service: unknown) => s.origin === service || s.path.startsWith('/api/preview-context') || s.path.startsWith('/api/socrate/');
check('trace témoin : aucune requête vers le service ni vers le contexte ou l’assertion Socrate de l’hôte', !tSeen.some((s) => socrateRequest(s, t.serviceOrigin)), `${tSeen.length} requêtes : ${[...new Set(tSeen.map((s) => s.path))].join(', ')}`);
check('témoin : ni lanceur, ni iframe, ni attribut éditorial dans le DOM connecté', t.lanceurConnecte === 0 && t.iframe === 0 && t.attributsEditoriaux === 0, `lanceur ${t.lanceurConnecte}, iframe ${t.iframe}, data-socrate-id ${t.attributsEditoriaux}`);
check('preview : aucune entrée de revue ni requête Socrate avant identité vérifiée par l’hôte', p.lanceurAvantConnexion === 0 && !pSeen.some((s) => s.phase === 'avant-connexion' && (socrateRequest(s, p.serviceOrigin) || s.path === `/${bootstrap!.file}`)), `lanceur ${p.lanceurAvantConnexion}`);
check('preview : entrée de revue affichée après connexion, attributs éditoriaux de la fiche présents', p.lanceurConnecte === 1 && p.attributsEditoriaux === 2, `lanceur ${p.lanceurConnecte}, data-socrate-id ${p.attributsEditoriaux} (fiche et mention de rappel)`);
check('preview : chunk du panneau et requêtes au service dès l’arrivée connectée, jamais avant', !pSeen.some((s) => s.phase === 'avant-connexion' && (s.path === `/${panel!.file}` || s.origin === p.serviceOrigin)) && pSeen.some((s) => s.phase === 'connecte' && s.path === `/${panel!.file}`) && pSeen.some((s) => s.phase === 'connecte' && s.origin === p.serviceOrigin), `panneau ${[...new Set(pSeen.filter((s) => s.path === `/${panel!.file}`).map((s) => s.phase))].join(', ')}, service ${[...new Set(pSeen.filter((s) => s.origin === p.serviceOrigin).map((s) => s.phase))].join(', ')}`);
check('styles : rendu de l’hôte identique entre témoin, preview fermée et preview ouverte', JSON.stringify(t.stylesHoteAvant) === JSON.stringify(p.stylesHoteAvant) && JSON.stringify(p.stylesHoteAvant) === JSON.stringify(p.stylesHoteApres), JSON.stringify(p.stylesHoteApres));
const ps = p.stylesPanneau as { body: { fontFamily: string }; bouton: { fontFamily: string; textTransform: string; border: string }; titre: { fontStyle: string }; hoteDansPanneau: number };
check('styles : la feuille de l’hôte n’atteint pas le panneau', /system-ui/.test(ps.body.fontFamily) && !/Georgia|Comic/.test(ps.body.fontFamily + ps.bouton.fontFamily) && ps.bouton.textTransform === 'none' && !/dashed/.test(ps.bouton.border) && ps.titre.fontStyle === 'normal' && ps.hoteDansPanneau === 0, JSON.stringify(ps));
const loadedJs = pSeen.filter((s) => s.path.endsWith('.js')).map((s) => s.path);
check('runtime preview : chunks chargés, React DOM présent une seule fois parmi eux', loadedJs.filter((f) => preview.chunks.find((c) => `/${c.file}` === f)?.modules.some((m) => /react-dom\/cjs\/react-dom-client/.test(m))).length === 1, loadedJs.join(', '));

const PREVIEW_PHASES = ['avant-connexion', 'connecte', 'liste-ouverte', 'reperes-actifs', 'reperes-desactives', 'capture-active'];
const firstPhase = (file: string) => pSeen.find((s) => s.path === `/${file}`)?.phase ?? null;
check('repères : chunk du guidage chargé au premier geste des repères, jamais avant', firstPhase(guideChunk!.file) === 'reperes-actifs', `${guideChunk!.file} : ${firstPhase(guideChunk!.file)}`);
check('capture : chunk de capture chargé à l’activation de la capture, jamais avant', firstPhase(captureChunk!.file) === 'capture-active', `${captureChunk!.file} : ${firstPhase(captureChunk!.file)}`);
const lateImports = pSeen.filter((s) => s.path.endsWith('.js')).flatMap((s) => (preview.chunks.find((c) => `/${c.file}` === s.path)?.imports ?? []).filter((dep) => {
  const at = firstPhase(dep);
  return at === null || PREVIEW_PHASES.indexOf(at) > PREVIEW_PHASES.indexOf(s.phase);
}).map((dep) => `${s.path} → ${dep}`));
check('modules : chaque dépendance statique d’un chunk chargé figure dans la trace au plus tard dans sa phase', lateImports.length === 0, lateImports.join(', ') || `${new Set(pSeen.filter((s) => s.path.endsWith('.js')).map((s) => s.path)).size} chunks chargés`);
const rp = p.reperes as { statut: string; actifs: { reperes: number; observateurs: string[] }; apresClic: { notes: number }; routeApresClic: string; desactives: { reperes: number; notes: number; observateurs: string[] } };
check('repères activés : repères posés, une seule observation DOM, explication au clic sans navigation', rp.actifs.reperes >= 1 && rp.actifs.observateurs.length === 1 && rp.apresClic.notes === 1 && rp.routeApresClic === '/rendez-vous/rdv-1042', `${rp.statut} ; observateurs ${JSON.stringify(rp.actifs.observateurs)} ; note ${rp.apresClic.notes} ; route ${rp.routeApresClic}`);
check(`repères désactivés après ${RUNS} alternances : aucun repère, aucune note, aucune observation DOM`, rp.desactives.reperes === 0 && rp.desactives.notes === 0 && rp.desactives.observateurs.length === 0, JSON.stringify(rp.desactives));
check(`capture active : flux local de la permission automatique Chromium accordé ${RUNS + 1} fois, ${RUNS} images ciblées`, p.capture.images.length === RUNS && p.capture.etats.filter((e) => e === 'active').length === RUNS + 1, `états ${p.capture.etats.join(', ')}`);
const socrateFile = (file: string) => preview.chunks.some((c) => `/${c.file}` === file && c !== entry && c.modules.some((m) => SOCRATE_MODULE.test(m)));
const allRests = [...t.repos.map((w) => ({ ...w, cote: 'temoin' })), ...p.repos.map((w) => ({ ...w, cote: 'preview' }))];
const atRest = allRests.filter((w) => w.etat !== 'selection');
const socrateCalls = atRest.flatMap((w) => Object.entries(w.appels).filter(([k]) => socrateFile(k.split(' ')[1]!)).map(([k, n]) => `${w.cote}/${w.etat} ${k} × ${n}`));
check('repos : aucune minuterie, animation ni message demandés par un chunk Socrate hors sélection', socrateCalls.length === 0, socrateCalls.join(' ; ') || `${atRest.length} fenêtres de ${REST_MS} ms`);
const longAtRest = atRest.filter((w) => w.tachesLongues.length > 0).map((w) => `${w.cote}/${w.etat} ${w.tachesLongues.join('+')} ms`);
check('repos : aucune tâche longue dans les fenêtres de repos, témoin et preview hors sélection', longAtRest.length === 0, longAtRest.join(' ; ') || `${atRest.length} fenêtres`);
const busyRests = allRests.filter((w) => w.requetes > 0).map((w) => `${w.cote}/${w.etat} ${w.requetes}`);
check('repos : aucune requête pendant les fenêtres de repos', busyRests.length === 0, busyRests.join(' ; ') || `${allRests.length} fenêtres`);
const observing = allRests.filter((w) => w.observateurs.length !== (w.etat === 'reperes-actifs' ? 1 : 0)).map((w) => `${w.cote}/${w.etat} ${w.observateurs.length}`);
check('repos : une observation DOM en mode repères, aucune ailleurs', observing.length === 0, observing.join(' ; ') || `${allRests.length} fenêtres`);
const pp = p.peuplee!;
const ppProblems = traceProblems(pp.requetes, { blocked: pp.bloquees, failed: pp.echecs }, pp.incomplet, initial401);
check('trace ouverture peuplée : collecte complète, aucune tentative bloquée, échouée ou au statut inattendu, seul le 401 initial de /api/me attendu', ppProblems.length === 0 && pp.requetes.filter(initial401).length === 1, ppProblems.join(' ; ') || `${pp.requetes.length} requêtes`);
const seeded = pp.persistees[0];
check('ouverture peuplée : proposition de liste publiée par l’interface et relue en base avant la fermeture de son contexte, aucun INSERT de préparation', pp.persistees.length === 1 && seeded?.kind === 'global' && seeded.wording_id === 'rappel-email' && seeded.replacement === PROPOSAL && pp.preparation.bloquees.length + pp.preparation.echecs.length === 0, JSON.stringify({ persistees: pp.persistees, preparation: pp.preparation }));
const wordingChunk = chunkWith(preview, 'packages/react/src/wording.tsx');
const proposalChunk = chunkWith(preview, 'packages/react/src/proposal.tsx');
const openedFiles = pp.requetes.filter((s) => s.phase === 'liste-ouverte').map((s) => s.path);
check('ouverture peuplée par défaut : contexte neuf, fil et proposition affichés, sans revue des textes ni panneau éditorial, chunk de lecture chargé sans l’éditeur des textes', pp.fils === 1 && pp.revueDesTextes === 0 && !!proposalChunk && proposalChunk !== wordingChunk && openedFiles.includes(`/${proposalChunk.file}`) && !openedFiles.includes(`/${wordingChunk?.file}`) && !openedFiles.includes(`/${editorialChunk!.file}`), `fils ${pp.fils}, cartes de la revue des textes ${pp.revueDesTextes}, chunks ${openedFiles.filter((f) => f.endsWith('.js')).join(', ')}`);
const dv = p.defautVide!;
const dvProblems = traceProblems(dv.requetes, { blocked: dv.bloquees, failed: dv.echecs }, dv.incomplet, initial401);
const dvFiles = dv.requetes.filter((s) => s.phase === 'liste-ouverte').map((s) => s.path);
check('ouverture vide par défaut : trace complète, liste vide, ni guidage, ni revue des textes, ni panneau éditorial, ni capture', dvProblems.length === 0 && dv.fils === 0 && ![guideChunk, wordingChunk, editorialChunk, captureChunk].some((c) => c && dvFiles.includes(`/${c.file}`)), dvProblems.join(' ; ') || `chunks ${dvFiles.filter((f) => f.endsWith('.js')).join(', ')}`);
check('phase repères désactivés : aucune requête pendant les alternances', !pSeen.some((s) => s.phase === 'reperes-desactives'), `${pSeen.filter((s) => s.phase === 'reperes-desactives').length} requête(s)`);

const mesure = {
  temoin: phases(temoin, t.requetes, ['avant-connexion', 'connecte']),
  preview: phases(preview, p.requetes, PREVIEW_PHASES),
  'preview-peuplee': phases(preview, pp.requetes, ['avant-connexion', 'connecte', 'liste-ouverte']),
  'preview-defaut-vide': phases(preview, dv.requetes, ['avant-connexion', 'connecte', 'liste-ouverte']),
};
const opening = (m: (typeof mesure)['preview']) => m['liste-ouverte']!.octets - m.connecte!.octets;
// Ouvertures par défaut vide et peuplée ; l'ouverture éditoriale explicite, plus lourde de son chunk, reste comparée à la même limite.
const ouvertures = { vide: opening(mesure['preview-defaut-vide']), peuplee: opening(mesure['preview-peuplee']), editoriale: opening(mesure.preview) };
// Le panneau, éditorial compris en mode explicite, se charge à l'arrivée connectée. Octets initiaux (écart au témoin connecté)
// et coût total jusqu'à la liste ouverte ; ce total remplace l'ancien plafond du repos connecté.
const arrivee = (m: (typeof mesure)['preview']) => m.connecte!.octets - mesure.temoin.connecte!.octets;
const couts = Object.fromEntries((['preview-defaut-vide', 'preview-peuplee', 'preview'] as const).map((k) => [k, { initial: arrivee(mesure[k]), total: arrivee(mesure[k]) + opening(mesure[k]) }]));
const totaux = { vide: couts['preview-defaut-vide']!.total, peuplee: couts['preview-peuplee']!.total, editoriale: couts.preview!.total };
const budget = JSON.parse(await readFile(localPath('tools/local/demo-budget.json'), 'utf8')) as { statut: string; limites: Record<string, unknown> };
const observed: Record<string, number> = {
  entreeDeltaGzip: statique.previewInitial.gzip - statique.temoinInitial.gzip,
  bootstrapGzip: statique.bootstrap.gzip,
  panneauGzip: statique.panneauAvecImports.gzip,
  // La plus lourde des trois arrivées suivies de leur ouverture ; chacune est comparée séparément à la même limite.
  arriveeOuvertureOctets: Math.max(totaux.vide, totaux.peuplee, totaux.editoriale),
  // Synthèse : la plus lourde des deux ouvertures ; chacune est comparée séparément à la même limite.
  ouvertureOctetsServis: Math.max(ouvertures.vide, ouvertures.peuplee, ouvertures.editoriale),
  guideGzip: statique.guide.gzip,
  captureGzip: statique.capture.gzip,
  reperesOctetsServis: mesure.preview['reperes-actifs']!.octets - mesure.preview['liste-ouverte']!.octets,
  captureOctetsServis: mesure.preview['capture-active']!.octets - mesure.preview['reperes-desactives']!.octets,
};
for (const [k, value] of Object.entries(observed)) {
  const limit = budget.limites[k];
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) check(`budget ${k} : limite absente, nulle ou invalide`, false, `limite ${JSON.stringify(limit)}, observé ${value}`);
  else if (k === 'ouvertureOctetsServis' || k === 'arriveeOuvertureOctets') for (const [name, v] of Object.entries(k === 'ouvertureOctetsServis' ? ouvertures : totaux)) check(`budget ${k} ≤ ${limit} (ouverture ${name === 'vide' ? 'vide par défaut' : name === 'peuplee' ? 'peuplée par défaut' : 'éditoriale explicite'})`, v <= limit, `observé ${v}`);
  else check(`budget ${k} ≤ ${limit}`, value <= limit, `observé ${value}`);
}
const unknownKeys = Object.keys(budget).filter((k) => k !== 'statut' && k !== 'limites');
const unknownLimits = Object.keys(budget.limites).filter((k) => !Object.hasOwn(observed, k));
check('budget : aucune limite ni section inconnue', unknownLimits.length + unknownKeys.length === 0, [...unknownLimits, ...unknownKeys].join(', ') || `${Object.keys(observed).length} limites attendues`);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const repos = Object.fromEntries([...new Set(allRests.map((w) => `${w.cote}/${w.etat}`))].map((k) => {
  const ws = allRests.filter((w) => `${w.cote}/${w.etat}` === k);
  const ms = ws.map((w) => w.tacheMs);
  const calls: Record<string, number> = {};
  for (const w of ws) for (const [c, n] of Object.entries(w.appels)) calls[c] = (calls[c] ?? 0) + n;
  const cpu = ws.map((w) => w.cpuChromiumMs);
  return [k, { fenetres: ws.length, cpuChromiumMsMediane: median(cpu), cpuChromiumMsPlage: [Math.min(...cpu), Math.max(...cpu)], tacheMsMediane: median(ms), tacheMsPlage: [Math.min(...ms), Math.max(...ms)], scriptMsMediane: median(ws.map((w) => w.scriptMs)), tachesLongues: ws.flatMap((w) => w.tachesLongues), observateurs: Math.max(...ws.map((w) => w.observateurs.length)), appels: calls }];
}));
const imagesMs = p.capture.images.map((i) => i.ms);
const capture = { images: p.capture.images, msMediane: median(imagesMs), msPlage: [Math.min(...imagesMs), Math.max(...imagesMs)] };

const report = { sha, dirty: dirty || null, commande: 'npm run measure:demo', port: DEMO_PORT, charge: execFileSync('uptime', { encoding: 'utf8' }).trim(), statique, mesure, ouvertures, couts, observe: observed, repos, capture, budget, checks, graphes: Object.fromEntries([...built].map(([k, v]) => [k, 'refused' in v ? v : { chunks: v.chunks.map((c) => ({ file: c.file, entry: c.entry, dynamic: c.dynamic, imports: c.imports, modules: c.modules.length })), files: v.files }])), traces: { temoin: tSeen, preview: pSeen, 'preview-peuplee': pp.requetes, 'preview-defaut-vide': dv.requetes, 'refus-bootstrap': r.requetes }, details: { temoin: { ...t, requetes: undefined }, preview: { ...p, requetes: undefined, peuplee: { ...pp, requetes: undefined } }, 'refus-bootstrap': { ...r, requetes: undefined } } };
await writeFile(join(OUT, 'mesure.json'), JSON.stringify(report, null, 1));
await writeFile(join(OUT, 'graphe-preview.json'), JSON.stringify(preview.chunks, null, 1));
await writeFile(join(OUT, 'graphe-temoin.json'), JSON.stringify(temoin.chunks, null, 1));
for (const c of checks) console.log(`${c.ok ? 'PASS' : 'ECHEC'} ${c.check} : ${c.detail}`);
console.log(JSON.stringify({ statique, mesure: Object.fromEntries(Object.entries(mesure).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, { requetes: pv.requetes, octets: pv.octets, modules: pv.modules }]))])), ouvertures, couts, observe: observed, repos: Object.fromEntries(Object.entries(repos).map(([k, v]) => [k, { cpuChromiumMsMediane: v.cpuChromiumMsMediane, cpuChromiumMsPlage: v.cpuChromiumMsPlage, tacheMsMediane: v.tacheMsMediane, tacheMsPlage: v.tacheMsPlage, tachesLongues: v.tachesLongues, observateurs: v.observateurs, appels: v.appels }])), capture: { msMediane: capture.msMediane, msPlage: capture.msPlage, tachesLongues: capture.images.map((i) => i.tachesLongues) } }, null, 1));
console.log(`mesure sous ${relative(REPO_ROOT, OUT)} (sha ${label})`);
process.exit(checks.every((c) => c.ok) ? 0 : 1);
