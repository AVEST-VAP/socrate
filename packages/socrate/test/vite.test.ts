import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../../tools/local/local-run.ts';
import { build, createServer } from 'vite';
import { socrate } from '../src/vite.ts';

const SERVICE = 'https://my-socrate.example.workers.dev';
const PREVIEW = {
  serviceUrl: SERVICE, projectId: 'my-app', reviewKey: 'pr-42', deploymentId: 'pr-42-0123456789ab-991-1', origin: 'https://feature-x.my-app.pages.dev',
  pullRequest: 42, commit: '0123456789abcdef0123456789abcdef01234567', buildId: '991-1', title: 'Automatic reminders',
};

function app(yaml = `service: ${SERVICE}\nproject: my-app\npreviews: https://*.my-app.pages.dev\ncsp: _headers\n`, headers: string | null = "/*\n  Content-Security-Policy: default-src 'self'; img-src 'self' data:\n"): string {
  const root = mkdtempSync(join(REPO_ROOT, '.tmp', 'vite-'));
  writeFileSync(join(root, 'socrate.yml'), yaml);
  writeFileSync(join(root, 'index.html'), '<!doctype html><script type="module" src="/main.js"></script>');
  writeFileSync(join(root, 'main.js'), 'const s = import.meta.env.SOCRATE;\nif (s) console.log("review on", s.serviceUrl, s.deploymentId, s.origin);\nelse console.log("review off");\n');
  if (headers !== null) {
    mkdirSync(join(root, 'public'));
    writeFileSync(join(root, 'public/_headers'), headers);
  }
  return root;
}

async function withPreview<T>(value: string | undefined, work: () => Promise<T>): Promise<T> {
  const before = process.env.SOCRATE_PREVIEW;
  if (value === undefined) delete process.env.SOCRATE_PREVIEW;
  else process.env.SOCRATE_PREVIEW = value;
  try {
    return await work();
  } finally {
    if (before === undefined) delete process.env.SOCRATE_PREVIEW;
    else process.env.SOCRATE_PREVIEW = before;
  }
}

const viteBuild = (root: string) => build({ root, configFile: false, logLevel: 'silent', cacheDir: join(root, '.vite'), plugins: [socrate()] });
const bundle = (root: string) => readdirSync(join(root, 'dist/assets')).map((f) => readFileSync(join(root, 'dist/assets', f), 'utf8')).join('\n');

test('sans SOCRATE_PREVIEW : import.meta.env.SOCRATE vaut false, la branche Socrate et la CSP restent intactes', async () => {
  const root = app();
  await withPreview(undefined, () => viteBuild(root));
  const js = bundle(root);
  assert.match(js, /review off/);
  assert.doesNotMatch(js, /review on|my-socrate/);
  assert.equal(readFileSync(join(root, 'dist/_headers'), 'utf8'), "/*\n  Content-Security-Policy: default-src 'self'; img-src 'self' data:\n");
});

test('avec SOCRATE_PREVIEW : contexte défini au build et CSP complétée (service sur connect-src, blob: pour les médias)', async () => {
  const root = app();
  await withPreview(JSON.stringify(PREVIEW), () => viteBuild(root));
  const js = bundle(root);
  assert.match(js, /review on/);
  for (const value of [SERVICE, PREVIEW.deploymentId, PREVIEW.origin]) assert.ok(js.includes(value), value);
  assert.doesNotMatch(js, /Automatic reminders|0123456789abcdef0123|"pullRequest"|buildId/, 'seuls les cinq champs du client entrent dans le bundle');
  assert.equal(readFileSync(join(root, 'dist/_headers'), 'utf8'),
    `/*\n  Content-Security-Policy: default-src 'self'; img-src 'self' data: blob:; connect-src 'self' ${SERVICE}; media-src 'self' blob:\n`);
});

test('refus : vite serve, contexte incohérent, fichier de headers absent ou à plusieurs CSP', async () => {
  await withPreview(JSON.stringify(PREVIEW), async () => {
    await assert.rejects(createServer({ root: app(), configFile: false, logLevel: 'silent', plugins: [socrate()] }), /\[socrate\] SOCRATE_PREVIEW is set: preview builds only, `vite serve` is refused/);
    await assert.rejects(viteBuild(app(`service: https://other.example.workers.dev\nproject: my-app\npreviews: https://*.my-app.pages.dev\n`)), /\[socrate\] SOCRATE_PREVIEW does not match .*socrate\.yml:\n  serviceUrl/);
    await assert.rejects(viteBuild(app(`service: ${SERVICE}\nproject: my-app\npreviews: https://*.other.pages.dev\n`)), /origin https:\/\/feature-x\.my-app\.pages\.dev does not match previews/);
    await assert.rejects(viteBuild(app(`service: ${SERVICE}\nproject: my-app\n`)), /\[socrate\] .*socrate\.yml is invalid:\n  previews: required/);
    await assert.rejects(viteBuild(app(undefined, null)), /\[socrate\] csp: .*_headers not found in the build output/);
    await assert.rejects(viteBuild(app(undefined, "/*\n  Content-Security-Policy: default-src 'self'\n/admin\n  Content-Security-Policy: default-src 'none'\n")), /must contain exactly one Content-Security-Policy line, found 2/);
  });
  await withPreview(JSON.stringify(PREVIEW), async () => {
    const hook = socrate().config as (user: object, env: { command: 'serve'; mode: string; isPreview: boolean }) => unknown;
    assert.equal(hook({}, { command: 'serve', mode: 'production', isPreview: true }), undefined, 'vite preview d’un build déjà fait reste permis');
  });
  await withPreview('{"serviceUrl":', () => assert.rejects(viteBuild(app()), /\[socrate\] SOCRATE_PREVIEW is not JSON/));
  await withPreview(JSON.stringify({ ...PREVIEW, deploymentId: 'Pr_42' }), () => assert.rejects(viteBuild(app()), /deploymentId: lowercase letters, digits and dashes/));
  const served = await withPreview(undefined, () => createServer({ root: app(), configFile: false, logLevel: 'silent', plugins: [socrate()] }));
  try {
    assert.equal(served.config.define?.['import.meta.env.SOCRATE'], 'false', 'sans contexte, le serveur de dev démarre avec SOCRATE à false');
  } finally {
    await served.close();
  }
});
