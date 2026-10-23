import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../../tools/local/local-run.ts';
import { ConfigError, findConfig, parseConfig, type LoadedConfig } from '../src/config.ts';
import { completeHeaders, completePolicy } from '../src/csp.ts';
import { parsePreview, type PreviewEnv } from '../src/preview.ts';
import { envLine } from '../src/prepare.ts';
import { genericManifest, truncate } from '../src/register.ts';
import { findLeaks } from '../src/absent.ts';
import { PACKAGE_DIR, publishedManifest } from '../../../tools/local/build-package.ts';

const YAML = 'service: https://my-socrate.example.workers.dev\nproject: my-app\npreviews: https://*.my-app.pages.dev\n';
const config = (extra = '') => parseConfig(YAML + extra, '/app/socrate.yml');
const refusal = (text: string) => {
  try {
    parseConfig(text, '/app/socrate.yml');
  } catch (e) {
    assert.ok(e instanceof ConfigError, String(e));
    return e.message;
  }
  assert.fail('configuration acceptée');
};
const preview = (over: Partial<PreviewEnv> = {}): PreviewEnv => ({
  serviceUrl: 'https://my-socrate.example.workers.dev', projectId: 'my-app', reviewKey: 'pr-42', deploymentId: 'pr-42-0123456789ab-991-1',
  origin: 'https://feature-x.my-app.pages.dev', pullRequest: 42, commit: '0123456789abcdef0123456789abcdef01234567', buildId: '991-1', title: 'Automatic reminders', ...over,
});

test('socrate.yml minimal : trois valeurs, défauts du label, de la revue et de la zone', () => {
  const c = config();
  assert.deepEqual({ label: c.label, review: c.review, before: c.before, now: c.now, zones: c.zones, csp: c.csp, manifest: c.manifest, dir: c.dir }, {
    label: 'socrate', review: 'pr-{pr}', before: 'The app before pull request #{pr}.', now: 'Pull request #{pr}: {title}',
    zones: [{ id: 'home', title: 'Home', route: '/', questions: [] }], csp: undefined, manifest: undefined, dir: '/app',
  });
  const full = config('label: needs-review\nreview: app-pr-{pr}\nbefore: L’application avant la PR {pr}.\nnow: "PR {pr} : {title}"\ncsp: _headers\nmanifest: .socrate\nzones:\n  - { id: settings, title: Settings, route: /settings }\n');
  assert.deepEqual([full.label, full.review, full.before, full.now, full.csp, full.manifest, full.zones[0]!.route],
    ['needs-review', 'app-pr-{pr}', 'L’application avant la PR {pr}.', 'PR {pr} : {title}', '_headers', '.socrate', '/settings']);
});

test('socrate.yml refusé : un message lisible par champ fautif', () => {
  assert.match(refusal('project: my-app\n'), /service: required: the https origin of your Socrate service[\s\S]*previews: required/);
  assert.match(refusal(YAML.replace('https://my-socrate', 'http://my-socrate')), /service: must be an https origin/);
  assert.match(refusal(YAML.replace('workers.dev', 'workers.dev/')), /service: must be an https origin/);
  assert.match(refusal(YAML.replace('my-app\n', 'My_App\n')), /project: lowercase letters, digits and dashes/);
  assert.match(refusal(YAML.replace('https://*.my-app', 'https://*.*.my-app')), /previews: an exact origin .* or a single-label wildcard/);
  assert.match(refusal(`${YAML}review: preview\n`), /review: must contain \{pr\}/);
  assert.match(refusal(`${YAML}review: pr-{pr}-{sha}\n`), /review: only the \{pr\} placeholder/);
  assert.match(refusal(`${YAML}review: PR-{pr}\n`), /review: must render a review key/);
  assert.match(refusal(`${YAML}csp: /etc/_headers\n`), /csp: must be a relative path/);
  assert.match(refusal(`${YAML}manifest: ../.socrate\n`), /manifest: must be a relative path/);
  assert.match(refusal(`${YAML}zones: []\n`), /zones: at least one zone/);
  assert.match(refusal(`${YAML}zones:\n  - { id: home, title: Home }\n`), /zones\.0\.route/);
  assert.match(refusal(`${YAML}zones:\n  - { id: Home, title: '', route: home }\n`), /zones\.0\.id: lowercase letters, digits and dashes\n  zones\.0\.title: required text\n  zones\.0\.route: relative route starting with \//, 'règles du contrat rendues en anglais');
  assert.match(refusal(`${YAML}before: ''\n`), /before: must not be empty/);
  assert.match(refusal(`${YAML}now: 'Commit {sha}'\n`), /now: only the \{pr\} and \{title\} placeholders are supported/);
  assert.match(refusal(`${YAML}now: ${'x'.repeat(401)}\n`), /now: at most 400 characters/);
  assert.match(refusal(`${YAML}servce: x\n`), /servce: unknown key/);
  assert.match(refusal('- a\n- b\n'), /must be a mapping/);
  assert.match(refusal(`${YAML}project: other\n`), /not valid YAML/);
  assert.equal(config().service, 'https://my-socrate.example.workers.dev');
  assert.equal(parseConfig(YAML.replace('https://my-socrate.example.workers.dev', 'http://127.0.0.1:8857'), '/x/socrate.yml').service, 'http://127.0.0.1:8857', 'http admis en boucle locale seulement');
});

test('recherche de socrate.yml : chemin explicite, sinon remontée jusqu’à la racine Git', () => {
  const root = mkdtempSync(join(REPO_ROOT, '.tmp', 'config-'));
  const repo = join(root, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'apps/web/src'), { recursive: true });
  writeFileSync(join(root, 'socrate.yml'), YAML);
  assert.throws(() => findConfig(join(repo, 'apps/web/src')), /socrate\.yml not found in .* or its parents up to .*repo$/, 'arrêt à la racine Git, le fichier au-dessus est ignoré');
  writeFileSync(join(repo, 'socrate.yml'), YAML);
  assert.equal(findConfig(join(repo, 'apps/web/src')), join(repo, 'socrate.yml'));
  writeFileSync(join(repo, 'apps/web/socrate.yml'), YAML);
  assert.equal(findConfig(join(repo, 'apps/web/src')), join(repo, 'apps/web/socrate.yml'), 'le plus proche gagne');
  assert.equal(findConfig(join(repo, 'apps'), 'web/socrate.yml'), join(repo, 'apps/web/socrate.yml'));
  assert.throws(() => findConfig(repo, 'absent.yml'), /config file not found/);
});

test('SOCRATE_PREVIEW : toute incohérence avec socrate.yml est refusée', () => {
  const c = config();
  assert.deepEqual(parsePreview(JSON.stringify(preview()), c), preview());
  const refused = (over: Partial<PreviewEnv> | string, pattern: RegExp) => assert.throws(() => parsePreview(typeof over === 'string' ? over : JSON.stringify(preview(over)), c), pattern);
  refused('{', /SOCRATE_PREVIEW is not JSON/);
  refused({ serviceUrl: 'https://other.example.workers.dev' }, /serviceUrl .* is not the service of/);
  refused({ projectId: 'other' }, /projectId "other" is not the project/);
  refused({ origin: 'https://feature-x.other.pages.dev' }, /does not match previews/);
  refused({ origin: 'https://feature-x.my-app.pages.dev/' }, /is not an origin/);
  refused({ reviewKey: 'pr-43' }, /does not follow the review template \(pr-42 expected\)/);
  refused({ deploymentId: 'PR_42' }, /deploymentId: lowercase letters, digits and dashes/);
  refused(JSON.stringify({ ...preview(), extra: 1 }), /extra: unknown key/);
});

test('CSP : origine du service sur connect-src seul, blob: sur img-src et media-src, directive absente créée depuis default-src', () => {
  const o = 'https://my-socrate.example.workers.dev';
  assert.equal(completePolicy("default-src 'self'; connect-src 'self' https://api.example.com; img-src 'self' data:", o),
    `default-src 'self'; connect-src 'self' https://api.example.com ${o}; img-src 'self' data: blob:; media-src 'self' blob:`);
  assert.equal(completePolicy("default-src 'none'; script-src 'self'", o), `default-src 'none'; script-src 'self'; connect-src ${o}; img-src blob:; media-src blob:`, "'none' remplacé, jamais combiné");
  assert.equal(completePolicy("default-src 'self'; img-src * blob:; media-src https:", o), `default-src 'self'; img-src * blob:; media-src https: blob:; connect-src 'self' ${o}`, 'blob: jamais doublé, ni couvert par * ou https:');
  assert.equal(completePolicy("script-src 'self'", o), "script-src 'self'", 'sans default-src, les directives absentes restent libres');
  const once = completePolicy("default-src 'self'", o);
  assert.equal(completePolicy(once, o), once, 'idempotent');
  assert.ok(!/(img|media)-src[^;]*workers\.dev/.test(once), 'le service ne sert aucune image ni vidéo');
  const headers = "/*\r\n  X-Frame-Options: DENY\r\n  Content-Security-Policy: default-src 'self'\r\n";
  assert.equal(completeHeaders(headers, o), `/*\r\n  X-Frame-Options: DENY\r\n  Content-Security-Policy: default-src 'self'; connect-src 'self' ${o}; img-src 'self' blob:; media-src 'self' blob:\r\n`);
  assert.throws(() => completeHeaders('/*\n  X-Frame-Options: DENY\n', o, '_headers'), /_headers must contain exactly one Content-Security-Policy line, found 0/);
  assert.throws(() => completeHeaders("/*\n  Content-Security-Policy: default-src 'self'\n/a\n  Content-Security-Policy: default-src 'none'\n", o), /found 2/);
  assert.throws(() => completeHeaders('/*\n  Content-Security-Policy:\n', o), /line is empty/);
  assert.match(completeHeaders("/*\n  Content-Security-Policy-Report-Only: default-src 'self'\n  Content-Security-Policy: default-src 'self'\n", o), /Report-Only: default-src 'self'\n/, 'Report-Only non compté ni modifié');
});

test('manifeste générique : titre de la PR tronqué à 80, before et now du yaml, zones du yaml ; ligne GITHUB_ENV sans saut de ligne', () => {
  const long = `${'Very long pull request title '.repeat(4)}😀`;
  const m = genericManifest(config() as LoadedConfig, preview({ title: long, repository: 'my-org/my-app' }));
  assert.equal(m.title.length <= 80, true);
  assert.ok(m.title.endsWith('…'));
  assert.deepEqual([m.reviewKey, m.pullRequest, m.repository, m.zones.map((z) => z.id)], ['pr-42', 42, 'my-org/my-app', ['home']]);
  assert.deepEqual([m.before, m.now], ['The app before pull request #42.', `Pull request #42: ${long}`]);
  const custom = genericManifest(config('before: L’application avant la PR {pr}.\nnow: "PR {pr} : {title}"\n'), preview({ title: 'Relances {pr} {title}' }));
  assert.deepEqual([custom.before, custom.now], ['L’application avant la PR 42.', 'PR 42 : Relances {pr} {title}'], 'un titre n’est jamais réinterprété comme gabarit');
  assert.equal(genericManifest(config('now: "{title} {title}"\n'), preview({ title: 'x'.repeat(300) })).now.length, 400, 'texte rendu coupé à 400');
  assert.equal(truncate('a😀b', 3), 'a…', 'une paire de substitution n’est jamais coupée');
  const line = envLine(preview({ title: 'one\ntwo\r\u2028three' }));
  assert.ok(!/[\r\n\u2028\u2029]/.test(line));
  assert.equal(JSON.parse(line.slice('SOCRATE_PREVIEW='.length)).title, 'one\ntwo\r\u2028three');
});

test('check-absent : marqueur du client ou adresse du service hors .map, jamais le mot socrate seul', () => {
  const dist = mkdtempSync(join(REPO_ROOT, '.tmp', 'dist-'));
  mkdirSync(join(dist, 'assets'));
  writeFileSync(join(dist, 'index.html'), '<script src="/assets/socrate-branch.js"></script>');
  writeFileSync(join(dist, 'assets/index.js'), 'console.log("socrate")');
  writeFileSync(join(dist, 'assets/index.js.map'), '"@meyer0x/socrate/client" https://my-socrate.example.workers.dev');
  const markers = ['@meyer0x/socrate/client', 'my-socrate.example.workers.dev'];
  assert.deepEqual(findLeaks(dist, markers), { leaks: [], checked: 2 });
  writeFileSync(join(dist, 'assets/chunk.js'), 'fetch("https://my-socrate.example.workers.dev/v1/health");useDebugValue("@meyer0x/socrate/client")');
  assert.deepEqual(findLeaks(dist, markers).leaks, [{ file: 'assets/chunk.js', marker: markers[0] }, { file: 'assets/chunk.js', marker: markers[1] }]);
});

test('package.json publié : ni private, ni scripts vers le workspace, ni dépendances de développement privées', () => {
  const source = JSON.parse(readFileSync(`${PACKAGE_DIR}/package.json`, 'utf8'));
  assert.equal(source.private, true, 'aucun npm publish ne part des sources');
  const published = publishedManifest(source);
  assert.deepEqual(['private', 'scripts', 'devDependencies'].filter((k) => k in published), []);
  assert.doesNotMatch(JSON.stringify(published), /\.\.\/|@socrate\//);
  assert.deepEqual([published.name, published.version, published.files, published.publishConfig], ['@meyer0x/socrate', '0.1.0', ['dist', 'README.md'], { access: 'public' }]);
});
