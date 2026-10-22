import { test } from 'node:test';
import assert from 'node:assert/strict';
import { originAllowed, projectPolicySchema } from '../src/index.ts';

const PREVIEWS = 'https://*.my-app-previews.pages.dev';

test('motif à label unique : seul un alias de preview passe', () => {
  for (const ok of ['https://my-branch.my-app-previews.pages.dev', 'https://a.my-app-previews.pages.dev']) assert.ok(originAllowed(PREVIEWS, ok), ok);
  for (const refused of [
    'https://my-app-previews.pages.dev', 'https://a.b.my-app-previews.pages.dev', 'https://x.my-app-previews.pages.dev.evil.com', 'http://x.my-app-previews.pages.dev',
    'https://x.my-app-previews.pages.dev:8443', 'https://app.example.com', 'https://admin.example.com', 'https://example.com', 'https://x.my-other-app.pages.dev', 'https://xmy-app-previews.pages.dev',
  ]) assert.equal(originAllowed(PREVIEWS, refused), false, refused);
});

test('motif exact : égalité stricte de l’origine', () => {
  assert.ok(originAllowed('http://127.0.0.1:5417', 'http://127.0.0.1:5417'));
  assert.equal(originAllowed('http://127.0.0.1:5417', 'http://localhost:5417'), false);
  assert.equal(originAllowed('http://127.0.0.1:5417', 'http://127.0.0.1:54170'), false);
});

test('la politique refuse un motif ambigu et reste valide sans motif', () => {
  const base = { issuer: 'my-backend', publicJwk: { kty: 'EC', crv: 'P-256', x: 'a'.repeat(43), y: 'b'.repeat(43) }, attestableCapabilities: [] };
  assert.ok(projectPolicySchema.safeParse(base).success, 'motif optionnel');
  assert.ok(projectPolicySchema.safeParse({ ...base, allowedOrigin: PREVIEWS }).success);
  for (const bad of ['https://*', '*.my-app-previews.pages.dev', 'https://a.*.pages.dev', 'https://*.Example.com', 'https://x.fr/', 'https://x.fr/*', '^https://.*$']) {
    assert.equal(projectPolicySchema.safeParse({ ...base, allowedOrigin: bad }).success, false, bad);
  }
});
