import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, symlink, cp } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleManifest } from '../src/assemble.ts';
import { canonicalize, digestOf, validateManifest } from '../src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, '../../..');
const DEMO = resolve(REPO, 'apps/demo/.socrate');
const tmp = () => mkdtemp(join(REPO, '.tmp', 'manifest-'));

test('le dossier de démo multi-fichiers s’assemble et se valide', async () => {
  const r = await assembleManifest(DEMO);
  assert.ok(r.ok, JSON.stringify(r));
  assert.equal(r.manifest.zones.length, 2);
  assert.equal(r.manifest.zones[1]!.id, 'fiche-rendez-vous');
  assert.ok(validateManifest(r.manifest).ok);
});

test('canonicalisation RFC 8785 : ordre des clés indifférent, digest stable', async () => {
  assert.equal(canonicalize({ b: 1, a: [true, null, 'é'] }), '{"a":[true,null,"é"],"b":1}');
  const r = await assembleManifest(DEMO);
  assert.ok(r.ok);
  const reordered = Object.fromEntries(Object.entries(r.manifest).reverse());
  assert.equal(await digestOf(reordered), await digestOf(r.manifest as any));
});

test('fichier référencé absent, non référencé, traversée, lien sortant, référence distante et code exécutable refusés', async () => {
  const dir = await tmp();
  await cp(DEMO, dir, { recursive: true });
  await writeFile(join(dir, 'README.md'), 'pas un fragment');
  await writeFile(join(dir, 'zones', 'oubliee.json'), JSON.stringify({ id: 'oubliee', title: 'x', route: '/x' }));
  await writeFile(join(dir, 'helper.js'), 'module.exports = 1');
  const outside = join(dir, '..', `outside-${Date.now()}.json`);
  await writeFile(outside, JSON.stringify({ id: 'ext', title: 'x', route: '/x' }));
  await symlink(outside, join(dir, 'zones', 'lien.json'));
  const index = JSON.parse(await (await import('node:fs/promises')).readFile(join(dir, 'index.json'), 'utf8'));
  index.zones = ['zones/reglages.json', 'zones/absente.json', '../index.json', 'https://ailleurs.test/zone.json', 'zones/lien.json'];
  await writeFile(join(dir, 'index.json'), JSON.stringify(index));
  const r = await assembleManifest(dir);
  assert.ok(!r.ok);
  const messages = r.issues.map((i) => `${i.file ?? ''}|${i.path}|${i.message}`);
  const expect = (file: string, re: RegExp) => assert.ok(r.issues.some((i) => i.file === file && re.test(i.message)), `${file} ${re}: ${messages.join('\n')}`);
  expect('zones/absente.json', /absent/);
  expect('zones/oubliee.json', /non référencé/);
  expect('index.json', /traversée/);
  expect('index.json', /non relative/);
  expect('zones/lien.json', /symbolique/);
  expect('helper.js', /exécutable/);
  assert.ok(!r.issues.some((i) => i.file === 'README.md'), 'un README n’est pas un fragment');
});

test('un index symbolique sortant est refusé avant lecture ; une référence ./zones/x.json est acceptée', async () => {
  const dir = await tmp();
  await cp(DEMO, dir, { recursive: true });
  const outside = join(dir, '..', `index-outside-${Date.now()}.json`);
  await cp(join(dir, 'index.json'), outside);
  await (await import('node:fs/promises')).rm(join(dir, 'index.json'));
  await symlink(outside, join(dir, 'index.json'));
  const linked = await assembleManifest(dir);
  assert.ok(!linked.ok);
  assert.ok(linked.issues.some((i) => i.file === 'index.json' && /symbolique/.test(i.message)), JSON.stringify(linked.issues));

  const dir2 = await tmp();
  await cp(DEMO, dir2, { recursive: true });
  const index = JSON.parse(await (await import('node:fs/promises')).readFile(join(dir2, 'index.json'), 'utf8'));
  index.zones = ['./zones/reglages.json', 'zones/../zones/rendez-vous.json'];
  await writeFile(join(dir2, 'index.json'), JSON.stringify(index));
  const normalized = await assembleManifest(dir2);
  assert.ok(normalized.ok, JSON.stringify(normalized));
  assert.equal(normalized.manifest.zones.length, 2);
});

test('la configuration de confiance du service est validée et bornée', async () => {
  const { serviceConfigSchema } = await import('../src/index.ts');
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const privateJwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const base = { audience: 'socrate', assertionMaxAgeSeconds: 60, clockSkewSeconds: 30, sessionTtlSeconds: 300, projects: { demo: { issuer: 'demo-host', publicJwk, attestableCapabilities: ['thread.participate'] } } };
  assert.ok(serviceConfigSchema.safeParse(base).success);
  const { assertionMaxAgeSeconds: _a, ...withoutMaxAge } = base;
  const rejected: Array<[string, unknown]> = [
    ['validité absente', withoutMaxAge],
    ['validité trop longue', { ...base, assertionMaxAgeSeconds: 3600 }],
    ['tolérance d’horloge non bornée', { ...base, clockSkewSeconds: 86_400 }],
    ['session trop longue', { ...base, sessionTtlSeconds: 86_400 }],
    ['capacité inconnue', { ...base, projects: { demo: { ...base.projects.demo, attestableCapabilities: ['admin'] } } }],
    ['clé privée dans la configuration', { ...base, projects: { demo: { ...base.projects.demo, publicJwk: privateJwk } } }],
    ['courbe inattendue', { ...base, projects: { demo: { ...base.projects.demo, publicJwk: { ...publicJwk, crv: 'P-384' } } } }],
    ['donnée inconnue', { ...base, extra: true }],
  ];
  for (const [label, cfg] of rejected) assert.ok(!serviceConfigSchema.safeParse(cfg).success, label);
});

test('erreurs localisées par fichier et chemin de donnée', async () => {
  const dir = await tmp();
  await cp(DEMO, dir, { recursive: true });
  await writeFile(join(dir, 'zones', 'reglages.json'), JSON.stringify({ id: 'Majuscule', title: '', route: 'reglages', questions: 'non' }));
  const r = await assembleManifest(dir);
  assert.ok(!r.ok);
  const paths = r.issues.filter((i) => i.file === 'zones/reglages.json').map((i) => i.path).sort();
  assert.deepEqual(paths, ['id', 'questions', 'route', 'title']);
});

test('schéma inconnu et manifeste sans zone refusés par le validateur du service', () => {
  const r = validateManifest({ schemaVersion: 2, reviewKey: 'x', title: 't', before: 'b', now: 'n', zones: [] });
  assert.ok(!r.ok);
  assert.ok(r.issues.some((i) => i.path === 'schemaVersion'));
  assert.ok(r.issues.some((i) => i.path === 'zones'));
});

test('rejeu d’un manifeste antérieur aux propositions de texte : forme canonique et identité de révision inchangées', async () => {
  const before = JSON.parse(await (await import('node:fs/promises')).readFile(join(here, 'fixtures/manifeste-avant-textes.json'), 'utf8'));
  const r = validateManifest(before);
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(!('wordings' in r.manifest), 'aucune sélection injectée par défaut');
  assert.equal(await digestOf(r.manifest as any), '8874c089b204cef4a9b67d14c9f14ebe1b79f22cec6fe373a8aa3694546ea85f');
});

test('sélection éditoriale : formes, vide admise, doublon et zone inconnue refusés', async () => {
  const r = await assembleManifest(DEMO);
  assert.ok(r.ok, JSON.stringify(r));
  const sms = r.manifest.wordings!.find((w) => w.id === 'rappel-sms')!;
  assert.match(sms.source, /\{delai\}/, 'template interpolé');
  assert.ok(sms.examples!.every((e) => !e.includes('{')), 'exemples rendus distincts du template');
  assert.ok(validateManifest({ ...r.manifest, wordings: [] }).ok, 'sélection vide');
  const dup = validateManifest({ ...r.manifest, wordings: [sms, sms] });
  assert.ok(!dup.ok && dup.issues.some((i) => i.message.includes('en double')));
  const zone = validateManifest({ ...r.manifest, wordings: [{ ...sms, zone: 'inconnue' }] });
  assert.ok(!zone.ok && zone.issues.some((i) => i.path === 'wordings.0.zone'));
  const noQuestion = validateManifest({ ...r.manifest, wordings: [{ ...sms, question: undefined }] });
  assert.ok(!noQuestion.ok, 'question produit requise');
});
