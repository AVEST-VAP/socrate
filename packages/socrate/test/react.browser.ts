// Composant du paquet construit par Vite et rendu dans Chromium : fonction d'assertion stable d'un rendu à l'autre, marqueurs gardés par la minification.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { build } from 'vite';
import { REPO_ROOT, localPath, browser as browserBoundary } from '../../../tools/local/local-run.ts';
import type { LocalBrowser } from '../../../tools/local/browser.ts';
import { CLIENT_MARK, RENDER_MARK } from '../src/mark.ts';

const { openBrowser } = await browserBoundary();
let browser: LocalBrowser;
let bundle: string;

// `@socrate/react` remplacé par un composant qui garde chaque `getIdentityAssertion` reçue.
before(async () => {
  const root = mkdtempSync(join(REPO_ROOT, '.tmp', 'react-'));
  writeFileSync(join(root, 'stub.js'), 'export function SocrateReview(props) { (window.received ??= []).push(props.getIdentityAssertion); return null; }\n');
  writeFileSync(join(root, 'index.html'), '<!doctype html><div id="root"></div><script type="module" src="/main.tsx"></script>');
  writeFileSync(join(root, 'main.tsx'), `import { createElement } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { SocrateReview } from ${JSON.stringify(localPath('packages/socrate/src/react.tsx'))};
const root = createRoot(document.getElementById('root')!);
const preview = { serviceUrl: 'https://my-socrate.example.workers.dev', projectId: 'my-app', reviewKey: 'pr-42', deploymentId: 'pr-42-0123456789ab-991-1' };
const navigation = { current: () => '/', go: () => {} };
(window as any).renderWith = (answer: string) => flushSync(() => root.render(createElement(SocrateReview, { preview: { ...preview }, navigation, getIdentityAssertion: async () => answer })));
`);
  await build({
    root, configFile: false, logLevel: 'silent', cacheDir: join(root, '.vite'),
    resolve: { alias: { '@socrate/react': join(root, 'stub.js') } }, build: { modulePreload: false },
  });
  const assets = readdirSync(join(root, 'dist/assets')).filter((f) => f.endsWith('.js'));
  assert.equal(assets.length, 1, assets.join(', '));
  bundle = readFileSync(join(root, 'dist/assets', assets[0]!), 'utf8');
  browser = await openBrowser();
});
after(() => browser?.close());

test('getIdentityAssertion écrite en ligne : une seule fonction transmise au client, qui appelle toujours la dernière', async () => {
  const { context } = await browser.newContext([]);
  try {
    const page = await context.newPage();
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: bundle, type: 'module' });
    await page.waitForFunction(() => 'renderWith' in window);
    const answers = await page.evaluate(async () => {
      const w = window as unknown as { renderWith(answer: string): void; received: ((signal: AbortSignal) => Promise<string>)[] };
      w.renderWith('first');
      const before = await w.received[0]!(new AbortController().signal);
      w.renderWith('second');
      return { renders: w.received.length, same: w.received[0] === w.received[1], before, after: await w.received[0]!(new AbortController().signal) };
    });
    assert.deepEqual(answers, { renders: 2, same: true, before: 'first', after: 'second' });
  } finally {
    await context.close();
  }
});

test('marqueurs de check-absent présents dans le bundle minifié, dont celui porté par le rendu', () => {
  assert.ok(bundle.includes(RENDER_MARK), RENDER_MARK);
  assert.ok(bundle.includes(CLIENT_MARK), CLIENT_MARK);
});
